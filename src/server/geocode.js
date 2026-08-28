// Geocoding providers.
//
// Two backends behind one interface:
//   google    — Google Maps Platform Geocoding API. Needs GOOGLE_MAPS_API_KEY.
//               Rooftop-accurate on Australian residential addresses and the
//               provider to use in production.
//   nominatim — OpenStreetMap. Keyless, so the verification script runs without
//               billing set up, but coverage of individual house numbers in
//               Australian suburbs is patchy and it is rate limited to 1 req/s.
//               Treat a nominatim miss as "unconfirmed", not "does not exist".
//
// Both normalise to the same result shape so callers do not branch on provider.

const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'family-buyer-intel/0.1 (property address verification)';

/**
 * Precision ladder, most to least specific. Anything below `street` means the
 * geocoder fell back to the suburb centre and the address was not confirmed.
 */
export const PRECISION = ['rooftop', 'interpolated', 'street', 'locality', 'none'];

export const isConfirmed = (p) => p === 'rooftop' || p === 'interpolated';

const GOOGLE_PRECISION = {
  ROOFTOP: 'rooftop',
  RANGE_INTERPOLATED: 'interpolated',
  GEOMETRIC_CENTER: 'street',
  APPROXIMATE: 'locality',
};

function googleComponent(result, type) {
  return result.address_components?.find((c) => c.types.includes(type))?.long_name ?? null;
}

async function geocodeGoogle(query, key) {
  const url = `${GOOGLE_GEOCODE}?address=${encodeURIComponent(query)}&region=au&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Geocoding HTTP ${res.status}`);
  const body = await res.json();

  // Google reports failures in the payload, not the status code.
  if (body.status === 'ZERO_RESULTS') return { found: false, precision: 'none' };
  if (body.status !== 'OK') {
    throw new Error(`Google Geocoding: ${body.status}${body.error_message ? ` — ${body.error_message}` : ''}`);
  }

  const r = body.results[0];
  return {
    found: true,
    precision: GOOGLE_PRECISION[r.geometry.location_type] ?? 'locality',
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    formatted: r.formatted_address,
    locality: googleComponent(r, 'locality') ?? googleComponent(r, 'sublocality'),
    postcode: googleComponent(r, 'postal_code'),
    partial: Boolean(r.partial_match),
    placeId: r.place_id,
  };
}

const NOMINATIM_PRECISION = {
  building: 'rooftop', house: 'rooftop', residential: 'rooftop',
  road: 'street', suburb: 'locality', town: 'locality', city: 'locality',
};

async function geocodeNominatim(query) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1&limit=1&countrycodes=au`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const body = await res.json();
  if (!body.length) return { found: false, precision: 'none' };

  const r = body[0];
  // A house_number in the response is the only reliable sign the specific
  // address resolved, rather than just the street it sits on.
  const hasNumber = Boolean(r.address?.house_number);
  const precision = hasNumber ? 'rooftop' : (NOMINATIM_PRECISION[r.addresstype] ?? 'locality');
  return {
    found: true,
    precision,
    lat: Number(r.lat),
    lng: Number(r.lon),
    formatted: r.display_name,
    locality: r.address?.suburb ?? r.address?.city ?? r.address?.town ?? null,
    postcode: r.address?.postcode ?? null,
    partial: !hasNumber,
    placeId: null,
  };
}

/** Geocode one address string. Returns a normalised result. */
export async function geocode(query, { provider = 'google', key = process.env.GOOGLE_MAPS_API_KEY } = {}) {
  if (provider === 'google') {
    if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set — pass --provider=nominatim to run without a key.');
    return geocodeGoogle(query, key);
  }
  if (provider === 'nominatim') return geocodeNominatim(query);
  throw new Error(`Unknown geocoding provider: ${provider}`);
}

/** Nominatim's usage policy caps callers at 1 request/second. Google does not. */
export const rateLimitMs = (provider) => (provider === 'nominatim' ? 1100 : 0);
