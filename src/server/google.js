// Google Maps Platform client. Server-side only — the API key must never reach
// the browser, so the app calls our own /api/* routes and this module calls
// Google.
//
// What Google genuinely provides for this app:
//   Geocoding / Address Validation — does this address exist, and where is it
//   Places (Nearby Search)         — real schools, parks, playgrounds, childcare
//   Routes / Distance Matrix       — real drive and walk times, not crow-flies
//
// What it does NOT provide, and cannot be sourced here:
//   listings, prices, days on market, sale history, tenure, owner-occupier
//   ratios, lot dimensions, zoning, easements, school catchment boundaries.

const PLACES_NEARBY = 'https://places.googleapis.com/v1/places:searchNearby';
const ADDRESS_VALIDATION = 'https://addressvalidation.googleapis.com/v1:validateAddress';
const ROUTE_MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

const key = () => {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (!k) throw new Error('GOOGLE_MAPS_API_KEY is not set');
  return k;
};

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), ...headers },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${new URL(url).hostname} HTTP ${res.status}: ${payload.error?.message ?? 'unknown error'}`);
  }
  return payload;
}

/**
 * Confirm an address exists and is deliverable. This is the authoritative
 * check — stricter than geocoding, because it reports whether the premise
 * (house number) was actually matched rather than inferred.
 */
export async function validateAddress(addressLines, regionCode = 'AU') {
  const body = await postJson(ADDRESS_VALIDATION, {
    address: { regionCode, addressLines: [].concat(addressLines) },
  });
  const v = body.result?.verdict ?? {};
  const geo = body.result?.geocode ?? {};
  return {
    complete: Boolean(v.addressComplete),
    // 'PREMISE' or better means the specific property was matched.
    granularity: v.validationGranularity ?? 'OTHER',
    confirmed: ['PREMISE', 'SUB_PREMISE'].includes(v.validationGranularity),
    inferred: Boolean(v.hasInferredComponents),
    unconfirmed: Boolean(v.hasUnconfirmedComponents),
    formatted: body.result?.address?.formattedAddress ?? null,
    coords: geo.location ? [geo.location.latitude, geo.location.longitude] : null,
    placeId: geo.placeId ?? null,
  };
}

/** Place types that map onto the lifestyle metrics in src/metrics.js. */
export const AMENITY_TYPES = {
  primarySchools: ['primary_school'],
  secondarySchools: ['secondary_school'],
  daycares: ['child_care_agency', 'preschool'],
  parks: ['park'],
  playgrounds: ['playground'],
};

/**
 * Real amenity counts around a point. Replaces the hand-entered lifestyle
 * numbers in the seed data with observed places.
 */
export async function nearbyAmenities(coords, radiusM = 2000) {
  const out = {};
  for (const [metric, types] of Object.entries(AMENITY_TYPES)) {
    const body = await postJson(
      PLACES_NEARBY,
      {
        includedTypes: types,
        maxResultCount: 20,
        locationRestriction: {
          circle: { center: { latitude: coords[0], longitude: coords[1] }, radius: radiusM },
        },
      },
      { 'X-Goog-FieldMask': 'places.displayName,places.location,places.primaryType' },
    );
    const places = body.places ?? [];
    out[metric] = {
      count: places.length,
      // maxResultCount caps the page, so a full page means "at least this many".
      capped: places.length === 20,
      items: places.map((p) => ({ name: p.displayName?.text ?? null, type: p.primaryType ?? null })),
    };
  }
  return out;
}

/**
 * Real travel times from one origin to many destinations. The radius filter in
 * src/geo.js is straight-line; for a school run or a beach trip, minutes matter
 * more than kilometres.
 */
export async function travelTimes(origin, destinations, mode = 'DRIVE') {
  const body = await postJson(
    ROUTE_MATRIX,
    {
      origins: [{ waypoint: { location: { latLng: { latitude: origin[0], longitude: origin[1] } } } }],
      destinations: destinations.map((d) => ({
        waypoint: { location: { latLng: { latitude: d[0], longitude: d[1] } } },
      })),
      travelMode: mode,
    },
    { 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition' },
  );
  return (Array.isArray(body) ? body : []).map((r) => ({
    destinationIndex: r.destinationIndex,
    minutes: r.duration ? Math.round(parseInt(r.duration, 10) / 60) : null,
    km: r.distanceMeters != null ? Math.round(r.distanceMeters / 100) / 10 : null,
    reachable: r.condition === 'ROUTE_EXISTS',
  }));
}

export const hasKey = () => Boolean(process.env.GOOGLE_MAPS_API_KEY);
