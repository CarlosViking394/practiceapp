// Which fields can come from a real source, and which are still fabricated.
//
// The app reads this to label every figure it shows. Keeping it as data rather
// than prose means the UI cannot drift out of step with what is actually wired.

export const FIELD_SOURCES = {
  // 1 · Inventory
  'inventory.medianPrice': { source: 'domain', api: 'Suburb Performance Statistics' },
  'inventory.medianDom': { source: 'domain', api: 'Suburb Performance Statistics' },
  'inventory.medianDomLastYear': { source: 'domain', api: 'Suburb Performance Statistics' },
  'inventory.priceChange90dPct': { source: 'domain', api: 'Suburb Performance Statistics' },
  'inventory.activeListings': { source: 'domain', api: 'Residential Search (count)' },
  'inventory.newListings30d': { source: 'domain', api: 'Residential Search (updatedSince)' },
  'inventory.comingSoon': { source: 'crm', api: 'Agency CRM — no public API' },
  'inventory.withdrawalRatePct': { source: 'none', api: 'Not exposed by Domain or PropTrack' },
  'earlySignals': { source: 'crm', api: 'Agency CRM + inspection bookings' },

  // 2 · Tenure
  'tenure.avgTenureYears': { source: 'domain', api: 'Properties — sale history' },
  'tenure.turnoverRatePct': { source: 'domain', api: 'Derived from sale counts' },
  'tenure.ownerOccupierPct': { source: 'domain', api: 'Demographics (ABS Census)' },
  'tenure.vacancyRatePct': { source: 'none', api: 'SQM Research or REIQ' },
  'tenure.ownersOver60Pct': { source: 'abs', api: 'ABS Census DataPacks' },

  // 3 · Stock & expansion
  'stock.pct4PlusBed': { source: 'domain', api: 'Derived from listing attributes' },
  'stock.medianLotSqm': { source: 'domain', api: 'Listing landArea' },
  'listing.lotSqm': { source: 'domain', api: 'Listing landArea' },
  'listing.beds': { source: 'domain', api: 'Residential Search' },
  'listing.study': { source: 'domain', api: 'Listing features' },
  'listing.pool': { source: 'domain', api: 'Listing features' },
  'listing.zoning': { source: 'council', api: 'Council spatial services' },
  'listing.easement': { source: 'council', api: 'Council spatial services' },
  'listing.slopePct': { source: 'council', api: 'Council DEM / contour data' },
  'listing.heritageOverlay': { source: 'council', api: 'Council planning overlays' },

  // 4 · Lifestyle
  'lifestyle.parks': { source: 'google', api: 'Places API' },
  'lifestyle.playgrounds': { source: 'google', api: 'Places API' },
  'lifestyle.daycaresWithin2km': { source: 'google', api: 'Places API' },
  'lifestyle.primarySchools': { source: 'edmap', api: 'QLD EdMap — catchment boundaries' },
  'lifestyle.secondarySchools': { source: 'edmap', api: 'QLD EdMap — catchment boundaries' },
  'lifestyle.beachAccessKm': { source: 'google', api: 'Places + Routes' },
};

/** Human labels and whether a source is wired up in this codebase. */
export const SOURCES = {
  domain: { label: 'Domain API', wired: true },
  google: { label: 'Google Maps Platform', wired: true },
  abs: { label: 'ABS Census', wired: false },
  council: { label: 'Council spatial data', wired: false },
  edmap: { label: 'QLD EdMap', wired: false },
  crm: { label: 'Agency CRM', wired: false },
  none: { label: 'No known source', wired: false },
};

export function sourceSummary() {
  const counts = {};
  for (const { source } of Object.values(FIELD_SOURCES)) counts[source] = (counts[source] ?? 0) + 1;
  return counts;
}
