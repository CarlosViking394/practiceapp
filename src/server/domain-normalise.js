// Domain payloads → the shapes in src/data/.
//
// Kept separate from the HTTP client so every mapping is unit-testable against
// fixtures without a network call or credentials. See scripts/test-normalisers.mjs.

/**
 * Domain returns dateListed/dateAvailable without a timezone, and those values
 * are Sydney local time (AEST/AEDT). Parsing them as UTC shifts every listing by
 * 10–11 hours, which silently rounds days-on-market the wrong way. Australian
 * eastern DST runs from the first Sunday in October to the first Sunday in April.
 */
export function parseSydneyDate(value) {
  if (!value) return null;
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value); // already zoned

  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = m;
  const offsetHours = isSydneyDst(Number(y), Number(mo), Number(d)) ? 11 : 10;
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh - offsetHours, +mi, +ss));
}

function firstSundayOfMonth(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  return 1 + ((7 - first.getUTCDay()) % 7);
}

function isSydneyDst(year, month, day) {
  if (month > 4 && month < 10) return false;          // May–September: AEST
  if (month < 4 || month > 10) return true;           // Nov–March: AEDT
  if (month === 4) return day < firstSundayOfMonth(year, 4);
  return day >= firstSundayOfMonth(year, 10);         // October
}

/** Whole days between a listing date and now. */
export function daysOnMarket(dateListed, now = Date.now()) {
  const d = parseSydneyDate(dateListed);
  if (!d) return null;
  return Math.max(0, Math.floor((now - d.getTime()) / 86400000));
}

const feature = (features, ...names) =>
  Array.isArray(features) && names.some((n) => features.some((f) => String(f).toLowerCase() === n.toLowerCase()));

const slug = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-');

/**
 * One Domain PropertyListing → our listing record.
 *
 * `zoning`, `easement`, `slopePct` and `heritageOverlay` are deliberately null:
 * they are not in any listing feed and must come from the council spatial join.
 * `status` is always 'on-market' — Domain's search returns advertised stock, so
 * coming-soon and early-signal records still originate from agency CRM data.
 */
export function normaliseListing(entry, { now = Date.now() } = {}) {
  const l = entry?.listing ?? entry;
  if (!l) return null;
  const p = l.propertyDetails ?? {};
  const price = l.priceDetails ?? {};

  return {
    id: `D-${l.id}`,
    domainId: l.id,
    suburbId: slug(p.suburb),
    // `??` binds tighter than `?:` — this needs the explicit fallback, or
    // displayableAddress is silently dropped in favour of the rebuilt string.
    address: p.displayableAddress
      ?? (p.streetNumber
        ? `${p.unitNumber ? `${p.unitNumber}/` : ''}${p.streetNumber} ${p.street ?? ''}`.trim()
        : null),
    status: 'on-market',
    // Required by the radius filter; without it the address is treated as out of area.
    coords: Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? [p.latitude, p.longitude] : null,
    // displayPrice is often a range or "Contact agent"; price is the numeric field.
    priceGuide: Number.isFinite(price.price) && price.price > 0 ? price.price : null,
    priceDisplay: price.displayPrice ?? null,
    beds: p.bedrooms ?? 0,
    baths: p.bathrooms ?? 0,
    cars: p.carspaces ?? 0,
    study: feature(p.features, 'Study'),
    pool: feature(p.features, 'SwimmingPool', 'Pool', 'InGroundPool'),
    lotSqm: Number.isFinite(p.landArea) ? p.landArea : null,
    floorSqm: Number.isFinite(p.buildingArea) ? p.buildingArea : null,
    yearBuilt: null,
    zoning: null, easement: null, slopePct: null, heritageOverlay: null,
    dom: daysOnMarket(l.dateListed, now),
    dateListed: l.dateListed ?? null,
    priceChanges: [],
    lastSold: null,
    inCatchment: [],
    signals: [],
    propertyId: p.propertyId ?? null,
    source: 'domain',
  };
}

/**
 * Sale history → tenure. Domain returns the history newest-first; the gaps
 * between consecutive sales are the completed ownership spells, and the span
 * since the latest sale is the current one (still running, so it is reported
 * separately rather than averaged in as if it had ended).
 */
export function deriveTenure(property, { now = Date.now() } = {}) {
  const sales = (property?.saleHistory ?? property?.priceHistory ?? [])
    .map((s) => {
      const raw = s.saleDate ?? s.date;
      return { date: parseSydneyDate(raw), raw: String(raw ?? '').slice(0, 10), price: s.price ?? null };
    })
    .filter((s) => s.date)
    .sort((a, b) => b.date - a.date);

  if (!sales.length) return { lastSold: null, currentTenureYears: null, completedSpells: [], averageTenureYears: null };

  const yearsBetween = (a, b) => Math.round(((a - b) / 31557600000) * 10) / 10;
  const completedSpells = sales.slice(0, -1).map((s, i) => yearsBetween(s.date, sales[i + 1].date));

  return {
    // Reported from the original string: a sale date is a calendar date, and
    // formatting it back through UTC would shift it a day earlier.
    lastSold: { date: sales[0].raw, price: sales[0].price },
    currentTenureYears: yearsBetween(now, sales[0].date),
    completedSpells,
    averageTenureYears: completedSpells.length
      ? Math.round((completedSpells.reduce((a, b) => a + b, 0) / completedSpells.length) * 10) / 10
      : null,
    salesCount: sales.length,
  };
}

/**
 * Suburb performance series → our inventory block.
 * Domain reports median price, days on market and sale counts per period.
 * Withdrawal rate has no endpoint and stays null rather than being invented.
 */
export function normaliseSuburbPerformance(payload) {
  const series = payload?.series?.seriesInfo ?? [];
  if (!series.length) return null;

  const period = (p) => p?.values ?? {};
  const latest = period(series[series.length - 1]);
  const prior = period(series[0]);

  const medianPrice = latest.medianSoldPrice ?? null;
  const priorPrice = prior.medianSoldPrice ?? null;

  return {
    medianPrice,
    medianDom: latest.daysOnMarket ?? null,
    medianDomLastYear: prior.daysOnMarket ?? null,
    soldCount: latest.numberSold ?? null,
    auctionClearancePct: latest.auctionClearanceRate ?? null,
    priceChange90dPct:
      medianPrice && priorPrice ? Math.round(((medianPrice - priorPrice) / priorPrice) * 1000) / 10 : null,
    // Not available from Domain — see docs table in README.
    activeListings: null,
    comingSoon: null,
    newListings30d: null,
    withdrawalRatePct: null,
  };
}

/**
 * Demographics → the parts of our tenure block the ABS actually covers.
 * Domain's demographics are Census-derived; the ownership split is reported as
 * counts of owned / mortgaged / rented dwellings.
 */
export function normaliseDemographics(payload) {
  const items = payload?.demographics ?? [];
  const find = (type) => items.find((d) => String(d.type ?? d.name).toLowerCase() === type.toLowerCase());

  const tenureItem = find('Tenure Type') ?? find('Tenure');
  const items2 = tenureItem?.items ?? [];
  const value = (label) => {
    const hit = items2.find((i) => String(i.label ?? i.name).toLowerCase().includes(label));
    return hit ? Number(hit.value) : null;
  };

  const owned = value('owned outright');
  const mortgaged = value('mortgage');
  const rented = value('rented');
  const total = [owned, mortgaged, rented].filter(Number.isFinite).reduce((a, b) => a + b, 0);

  return {
    ownerOccupierPct: total ? Math.round(((owned ?? 0) + (mortgaged ?? 0)) / total * 100) : null,
    rentedPct: total ? Math.round((rented ?? 0) / total * 100) : null,
    // Not in Domain's payload — vacancy comes from SQM/REIQ, owner age from ABS.
    vacancyRatePct: null,
    ownersOver60Pct: null,
  };
}
