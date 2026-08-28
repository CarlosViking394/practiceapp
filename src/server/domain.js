// Domain Developer Portal client.
//
// Auth is OAuth2 client credentials:
//   POST https://auth.domain.com.au/v1/connect/token
//   Authorization: Basic base64(client_id:client_secret)
//   Content-Type: application/x-www-form-urlencoded
//   grant_type=client_credentials&scope=api_listings_read api_properties_read
// The response carries access_token and expires_in (seconds); the token is
// cached for that duration and sent as `Authorization: Bearer {token}`.
// Both the header name and the "Bearer" prefix are case sensitive.
//
// Docs: https://developer.domain.com.au/docs/v2/authentication/oauth/client-credentials-grant/

const TOKEN_URL = 'https://auth.domain.com.au/v1/connect/token';
const API = 'https://api.domain.com.au';

/** Scopes needed by the endpoints this module calls. */
export const SCOPES = [
  'api_listings_read',
  'api_properties_read',
  'api_suburbperformance_read',
  'api_demographics_read',
];

/** Domain caps any single search at 1000 results; beyond that the query must narrow. */
export const MAX_SEARCH_RESULTS = 1000;
const PAGE_SIZE = 200;

let cachedToken = null; // { value, expiresAt }

const credentials = () => {
  const id = process.env.DOMAIN_CLIENT_ID;
  const secret = process.env.DOMAIN_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('DOMAIN_CLIENT_ID and DOMAIN_CLIENT_SECRET must be set — see .env.example');
  }
  return { id, secret };
};

export const hasCredentials = () =>
  Boolean(process.env.DOMAIN_CLIENT_ID && process.env.DOMAIN_CLIENT_SECRET);

/**
 * Fetch and cache an access token. Renewed 60s before expiry so a long-running
 * sync never sends a token that lapses mid-flight.
 */
export async function getToken({ scopes = SCOPES, force = false } = {}) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const { id, secret } = credentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A scope outside your plan comes back as 400 invalid_scope — worth naming,
    // because it looks like an auth failure but is a subscription problem.
    if (body.error === 'invalid_scope') {
      throw new Error(
        `Domain rejected scopes [${scopes.join(', ')}] as outside your plan. ` +
        'Check which packages the project has in the developer portal.',
      );
    }
    throw new Error(`Domain token request failed (${res.status}): ${body.error ?? 'unknown'}`);
  }

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

/** Authenticated request with one retry on 401 and backoff on 429. */
async function call(path, { method = 'GET', body, scopes, attempt = 0 } = {}) {
  const token = await getToken({ scopes, force: attempt === 1 });
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401 && attempt === 0) {
    return call(path, { method, body, scopes, attempt: 1 }); // token rejected — refresh once
  }
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('Retry-After') ?? 2 ** attempt) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return call(path, { method, body, scopes, attempt: attempt + 1 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Domain ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Residential listings for one suburb.
 * `listingType` is 'Sale' | 'Rent' | 'Sold'. Paginates until exhausted or the
 * 1000-result ceiling, whichever comes first.
 */
export async function searchResidential({
  state, suburb, postcode, listingType = 'Sale',
  propertyTypes = ['House'], minBedrooms, updatedSince, maxResults = MAX_SEARCH_RESULTS,
}) {
  const out = [];
  for (let page = 1; out.length < Math.min(maxResults, MAX_SEARCH_RESULTS); page += 1) {
    const batch = await call('/v1/listings/residential/_search', {
      method: 'POST',
      body: {
        listingType,
        propertyTypes,
        ...(minBedrooms ? { minBedrooms } : {}),
        ...(updatedSince ? { updatedSince } : {}),
        locations: [{
          state, suburb, postCode: postcode ?? '',
          region: '', area: '', includeSurroundingSuburbs: false,
        }],
        pageSize: PAGE_SIZE,
        pageNumber: page,
      },
    });

    if (!Array.isArray(batch) || batch.length === 0) break;
    // Results interleave PropertyListing and Project (a grouping of new
    // apartments); only the former is an individual property.
    out.push(...batch.filter((r) => r.type === 'PropertyListing'));
    if (batch.length < PAGE_SIZE) break;
  }
  return out.slice(0, maxResults);
}

export const getListing = (id) => call(`/v1/listings/${id}`);

/** Property record including sale history — the basis for tenure. */
export const getProperty = (id) => call(`/v1/properties/${id}`);

/**
 * Suburb median price, days on market and sale counts.
 * Requires the Properties & Locations package.
 */
export function getSuburbPerformance({ state, suburb, postcode, propertyCategory = 'house', bedrooms = 4, periodSize = 'quarters', numPeriods = 4 }) {
  const path = postcode
    ? `/v2/suburbPerformanceStatistics/${state}/${encodeURIComponent(suburb)}/${postcode}`
    : `/v2/suburbPerformanceStatistics/${state}/${encodeURIComponent(suburb)}`;
  const q = new URLSearchParams({
    propertyCategory, bedrooms: String(bedrooms), periodSize, startingPeriodRelativeToCurrent: '1', totalPeriods: String(numPeriods),
  });
  return call(`${path}?${q}`);
}

/** Census-derived demographics for a suburb. */
export const getDemographics = ({ state, suburb, postcode }) =>
  call(`/v2/demographics/${state}/${encodeURIComponent(suburb)}/${postcode}`);
