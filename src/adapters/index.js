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
import { FIELD_SOURCES, SOURCES } from '../data/provenance.js';

export { FIELD_SOURCES, SOURCES };

/**
 * Live data written by scripts/sync-domain.mjs, if it has been run.
 * Absent until then — the app falls back to seed data per suburb, so a partial
 * sync degrades field by field instead of all at once.
 */
async function loadLive(name) {
  try {
    const res = await fetch(`/src/data/live/${name}.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Merge live suburb figures over the seed record, field by field. */
function mergeSuburb(seed, live) {
  if (!live) return { ...seed, live: false, liveFields: [] };
  const liveFields = [];
  const inventory = { ...seed.inventory };
  for (const [k, v] of Object.entries(live.performance ?? {})) {
    if (v != null && k in inventory) { inventory[k] = v; liveFields.push(`inventory.${k}`); }
  }
  const tenure = { ...seed.tenure };
  for (const [k, v] of Object.entries(live.demographics ?? {})) {
    if (v != null && k in tenure) { tenure[k] = v; liveFields.push(`tenure.${k}`); }
  }
  if (live.performance?.avgTenureYears != null) {
    tenure.avgTenureYears = live.performance.avgTenureYears;
    liveFields.push('tenure.avgTenureYears');
  }
  return { ...seed, inventory, tenure, live: liveFields.length > 0, liveFields, syncedAt: live.syncedAt ?? null };
}

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
  { key: 'listings', label: 'Active listings, price, DOM', vendor: 'Domain — Agents & Listings', wired: true },
  { key: 'performance', label: 'Median price & days on market', vendor: 'Domain — Suburb Performance', wired: true },
  { key: 'sales', label: 'Sale history & tenure', vendor: 'Domain — Properties', wired: true },
  { key: 'demography', label: 'Owner-occupier ratio', vendor: 'Domain — Demographics (ABS)', wired: true },
  { key: 'addresses', label: 'Address verification', vendor: 'Google — Geocoding / Address Validation', wired: true },
  { key: 'amenities', label: 'Parks, playgrounds, childcare', vendor: 'Google — Places', wired: true },
  { key: 'signals', label: 'Coming-soon & early intent', vendor: 'Agency CRM — no public API', wired: false },
  { key: 'spatial', label: 'Zoning, easements, slope', vendor: 'Council spatial services', wired: false },
  { key: 'schools', label: 'School catchment boundaries', vendor: 'QLD EdMap', wired: false },
  { key: 'vacancy', label: 'Rental vacancy rate', vendor: 'SQM Research / REIQ', wired: false },
];

export async function fetchSuburbs() {
  const live = await loadLive('suburbs');
  return suburbs.map((s) => mergeSuburb(s, live?.[s.id]));
}

/**
 * Live listings replace the seeded ones for any suburb that synced, rather than
 * being merged into them — a real listing and an invented one are not two
 * versions of the same property.
 */
export async function fetchListings({ suburbId } = {}) {
  const live = await loadLive('listings');
  let all = listings;

  if (live?.length) {
    const syncedSuburbs = new Set(live.map((l) => l.suburbId));
    all = [...live, ...listings.filter((l) => !syncedSuburbs.has(l.suburbId))];
  }
  return suburbId && suburbId !== 'all' ? all.filter((l) => l.suburbId === suburbId) : all;
}

/** Has a Domain sync produced any live data? */
export async function fetchLiveStatus() {
  const [ls, ss] = await Promise.all([loadLive('listings'), loadLive('suburbs')]);
  const syncedSuburbs = ss ? Object.values(ss).filter((v) => v.performance || v.demographics).length : 0;
  return {
    listings: ls?.length ?? 0,
    suburbs: syncedSuburbs,
    syncedAt: ss ? Object.values(ss)[0]?.syncedAt ?? null : null,
    any: Boolean(ls?.length || syncedSuburbs),
  };
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
