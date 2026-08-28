// Data source adapters.
//
// The app talks to this module only — never to a vendor SDK directly — so
// swapping the seed data for live feeds is a one-file change. Each adapter
// normalises its vendor's payload into the shapes in ../data/.
//
// Live sources this is designed for:
//   listings   → Domain Developer Portal /v1/listings/residential/_search
//                or PropTrack Listings API
//   sales      → Domain /v1/properties/{id}/priceEstimate + sales history
//   demography → ABS Census DataPacks (tenure, owner-occupier ratio)
//   spatial    → council open data (cadastre, zoning, easements, overlays)
//   schools    → state education dept catchment boundary services (EdMap QLD)
//   amenities  → OpenStreetMap Overpass / council GIS (parks, footpaths)

import { suburbs, suburbById } from '../data/suburbs.js';
import { listings } from '../data/listings.js';

/** Set to 'live' once credentials are wired in; 'seed' reads the bundled data. */
export const MODE = 'seed';

/**
 * Ask the server whether a Google key is configured. Used to show honest status
 * in the UI rather than implying the numbers are live when they are not.
 */
export async function fetchApiStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return { google: 'unavailable', mode: 'seed' };
    return await res.json();
  } catch {
    return { google: 'unavailable', mode: 'seed' };
  }
}

/**
 * Address verification results produced by scripts/verify-addresses.mjs.
 * Absent until that script has been run, in which case every address is
 * reported as unverified rather than assumed good.
 */
export async function fetchVerification() {
  try {
    const res = await fetch('/verification-report.json');
    if (!res.ok) return null;
    const body = await res.json();
    return {
      provider: body.provider,
      runAt: body.runAt,
      summary: body.summary,
      byId: Object.fromEntries(body.results.map((r) => [r.id, r])),
    };
  } catch {
    return null;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const sources = [
  { key: 'listings', label: 'Active & coming-soon listings', vendor: 'Domain Developer Portal', live: false },
  { key: 'signals', label: 'Early intent signals', vendor: 'Agency CRM + inspection bookings', live: false },
  { key: 'sales', label: 'Historical sales & tenure', vendor: 'Domain sales history', live: false },
  { key: 'demography', label: 'Owner-occupier vs investor', vendor: 'ABS Census', live: false },
  { key: 'spatial', label: 'Lots, zoning & easements', vendor: 'Council spatial services', live: false },
  { key: 'schools', label: 'School catchments', vendor: 'QLD EdMap', live: false },
  { key: 'amenities', label: 'Parks, footpaths & beach access', vendor: 'OSM / council GIS', live: false },
];

export async function fetchSuburbs() {
  if (MODE === 'live') throw new Error('Live suburb feed not configured — see src/adapters/index.js');
  await delay(120); // keep callers honest about this being async
  return suburbs;
}

export async function fetchListings({ suburbId } = {}) {
  if (MODE === 'live') throw new Error('Live listing feed not configured — see src/adapters/index.js');
  await delay(120);
  return suburbId && suburbId !== 'all' ? listings.filter((l) => l.suburbId === suburbId) : listings;
}

export async function fetchSuburb(id) {
  await delay(40);
  return suburbById[id] ?? null;
}

/**
 * Shape a live Domain residential-listing payload into our listing record.
 * Unused while MODE === 'seed', but it documents the contract the seed data
 * is standing in for.
 */
export function normaliseDomainListing(raw) {
  return {
    id: `L-${raw.id}`,
    suburbId: String(raw.propertyDetails?.suburb ?? '').toLowerCase().replace(/\s+/g, '-'),
    address: raw.propertyDetails?.displayableAddress ?? '',
    // Required by the radius filter — without it the address is treated as out of area.
    coords: raw.geoLocation ? [raw.geoLocation.latitude, raw.geoLocation.longitude] : null,
    status: raw.saleMode === 'preMarket' ? 'coming-soon' : 'on-market',
    priceGuide: raw.priceDetails?.price ?? null,
    beds: raw.propertyDetails?.bedrooms ?? 0,
    baths: raw.propertyDetails?.bathrooms ?? 0,
    cars: raw.propertyDetails?.carspaces ?? 0,
    study: Boolean(raw.propertyDetails?.features?.includes('Study')),
    pool: Boolean(raw.propertyDetails?.features?.includes('SwimmingPool')),
    lotSqm: raw.propertyDetails?.landArea ?? 0,
    floorSqm: raw.propertyDetails?.buildingArea ?? 0,
    yearBuilt: raw.propertyDetails?.yearBuilt ?? null,
    // These four come from the council spatial join, not the listing feed.
    zoning: null, easement: null, slopePct: null, heritageOverlay: null,
    dom: raw.dateListed ? Math.round((Date.now() - Date.parse(raw.dateListed)) / 86400000) : null,
    priceChanges: [], lastSold: null, inCatchment: [], signals: [],
  };
}
