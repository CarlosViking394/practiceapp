// Distance filtering.
//
// The search area is defined as a radius around an anchor point, and it is
// applied to *property* coordinates rather than suburb centroids. That matters
// for large suburbs: Buderim's centroid sits 10.5km from Currimundi, but its
// southern streets are comfortably inside a 10km radius. Filtering on the
// centroid alone would wrongly drop every Buderim address, or wrongly keep them.

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in km between two [lat, lng] pairs. */
export function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Anchor points a buyer can centre the search on. */
export const ANCHORS = [
  { id: 'currimundi', label: 'Currimundi', coords: [-26.7583, 153.1206] },
  { id: 'wurtulla', label: 'Wurtulla', coords: [-26.7742, 153.1297] },
  { id: 'mountain-creek', label: 'Mountain Creek', coords: [-26.7106, 153.105] },
  { id: 'caloundra', label: 'Caloundra', coords: [-26.8028, 153.1289] },
  { id: 'buderim', label: 'Buderim', coords: [-26.6839, 153.0561] },
];

export const DEFAULT_ANCHOR = 'currimundi';
export const DEFAULT_RADIUS_KM = 10;

export const anchorById = (id) => ANCHORS.find((a) => a.id === id) ?? ANCHORS[0];

export const round1 = (n) => Math.round(n * 10) / 10;

/** Distance from the anchor to a record carrying `coords`. */
export function distanceFrom(anchorId, record) {
  return distanceKm(anchorById(anchorId).coords, record.coords);
}

/**
 * Split a suburb's listings by the radius. A suburb is "partially in range"
 * when some of its addresses qualify and others do not — the case the
 * centroid test cannot represent.
 */
export function coverage(anchorId, radiusKm, suburb, listings) {
  const inRange = listings.filter((l) => distanceFrom(anchorId, l) <= radiusKm);
  const centroidKm = round1(distanceFrom(anchorId, suburb));
  return {
    centroidKm,
    inRange,
    total: listings.length,
    centroidInRange: centroidKm <= radiusKm,
    // Any qualifying address keeps the suburb visible, even if its centre is out.
    anyInRange: inRange.length > 0,
    partial: inRange.length > 0 && inRange.length < listings.length,
  };
}
