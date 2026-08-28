// Derived metrics. Everything the UI displays as a score or a verdict is
// computed here so the weightings sit in one auditable place.

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Linear scale of `v` from [lo,hi] onto 0..100, clamped. Inverted if lo > hi. */
export function scale(v, lo, hi) {
  if (v == null || Number.isNaN(v)) return 0;
  return clamp(((v - lo) / (hi - lo)) * 100);
}

// ---------------------------------------------------------------------------
// 1. On-market & coming-soon inventory
// ---------------------------------------------------------------------------

/**
 * How much choice a buyer actually has right now. High = plenty of stock,
 * slow-moving, negotiable. Low = thin, fast market.
 */
export function inventoryPressure(s) {
  const inv = s.inventory;
  const domScore = scale(inv.medianDom, 15, 60); // longer DOM = more buyer room
  const stockScore = scale(inv.activeListings, 10, 90);
  const discountScore = scale(-inv.priceChange90dPct, -4, 4);
  return Math.round(domScore * 0.4 + stockScore * 0.35 + discountScore * 0.25);
}

/**
 * Volume of inventory that is not yet publicly advertised, expressed as a
 * share of the visible on-market pool. This is the number that tells a buyer
 * "wait two weeks" versus "this is all there is".
 */
export function shadowInventory(s) {
  const e = s.earlySignals;
  const hidden = s.inventory.comingSoon + e.preMarketApprovals + e.draftListings;
  return {
    hidden,
    visible: s.inventory.activeListings,
    ratioPct: Math.round((hidden / Math.max(1, s.inventory.activeListings)) * 100),
    inspectionRequests: e.inspectionRequests,
    appraisalRequests: e.appraisalRequests,
  };
}

/** Withdrawal rate read as vendor discipline: high = sellers pulling out. */
export function withdrawalVerdict(s) {
  const r = s.inventory.withdrawalRatePct;
  if (r >= 12) return { label: 'High', tone: 'warn', note: 'Many vendors pulling listings — price expectations are ahead of the market.' };
  if (r >= 8) return { label: 'Moderate', tone: 'mid', note: 'Some vendor withdrawal; expect negotiation on stale stock.' };
  return { label: 'Low', tone: 'good', note: 'Listings are clearing rather than being withdrawn.' };
}

// ---------------------------------------------------------------------------
// 2. Turn-over & tenure
// ---------------------------------------------------------------------------

/**
 * "Tightly held" score. Long tenure + high owner-occupier + low vacancy means
 * a family pocket that rarely trades — the buyer needs a longer search runway.
 */
export function tightlyHeldScore(s) {
  const t = s.tenure;
  const tenureScore = scale(t.avgTenureYears, 6, 15);
  const ooScore = scale(t.ownerOccupierPct, 50, 85);
  const vacancyScore = scale(-t.vacancyRatePct, -2.5, -0.5);
  return Math.round(tenureScore * 0.45 + ooScore * 0.3 + vacancyScore * 0.25);
}

/**
 * Expected search duration in months, derived from turnover rate and how much
 * of the stock actually matches a 4-bed family brief.
 */
export function expectedSearchMonths(s) {
  const matchingStockPct = s.stock.pct4PlusBed / 100;
  const annualTurnover = s.tenure.turnoverRatePct / 100;
  // Rough: how often a matching home changes hands, as a fraction of a year.
  const opportunitiesPerYear = annualTurnover * matchingStockPct * 100;
  const months = clamp(12 / Math.max(0.5, opportunitiesPerYear / 2), 1, 18);
  return Math.round(months * 10) / 10;
}

/**
 * Turnover pressure: long tenure + ageing owners is the classic precursor to
 * a wave of stock coming to market.
 */
export function turnoverOutlook(s) {
  const t = s.tenure;
  const score = Math.round(scale(t.avgTenureYears, 7, 15) * 0.5 + scale(t.ownersOver60Pct, 12, 40) * 0.5);
  let label = 'Stable';
  if (score >= 65) label = 'Turnover likely';
  else if (score >= 40) label = 'Building';
  return { score, label };
}

// ---------------------------------------------------------------------------
// 3. Physical attributes & expansion potential
// ---------------------------------------------------------------------------

const POOL_MIN_LOT = 600; // brief: 600m²+ lots as the expansion threshold
const POOL_MAX_SLOPE = 15; // beyond this, retaining costs dominate

/**
 * Can this specific property take a pool and/or a home-office extension?
 * Returns a verdict plus the constraints that drove it, so the buyer sees the
 * reasoning rather than a bare yes/no.
 */
export function expansionPotential(l) {
  const blockers = [];
  const notes = [];

  if (l.lotSqm < POOL_MIN_LOT) blockers.push(`Lot ${l.lotSqm}m² is under the ${POOL_MIN_LOT}m² working threshold`);
  if (l.easement) blockers.push('Registered easement restricts the buildable envelope');
  if (l.heritageOverlay) blockers.push('Heritage overlay — external works need referral');
  if (l.slopePct > POOL_MAX_SLOPE) blockers.push(`${l.slopePct}% slope — retaining likely to exceed the pool cost`);

  if (l.pool) notes.push('Pool already in place');
  if (l.study) notes.push('Dedicated study already present');
  const yardSqm = l.lotSqm - l.floorSqm;
  notes.push(`~${yardSqm}m² of site area outside the building footprint`);

  let poolVerdict;
  if (l.pool) poolVerdict = { label: 'Existing pool', tone: 'good' };
  else if (blockers.length === 0) poolVerdict = { label: 'Pool feasible', tone: 'good' };
  else if (blockers.length === 1 && l.lotSqm >= 500) poolVerdict = { label: 'Pool possible with conditions', tone: 'mid' };
  else poolVerdict = { label: 'Pool constrained', tone: 'warn' };

  let extensionVerdict;
  if (l.study) extensionVerdict = { label: 'Study already present', tone: 'good' };
  else if (yardSqm > 380 && !l.heritageOverlay) extensionVerdict = { label: 'Room to extend', tone: 'good' };
  else if (yardSqm > 250) extensionVerdict = { label: 'Tight but workable', tone: 'mid' };
  else extensionVerdict = { label: 'Little room to extend', tone: 'warn' };

  const score = Math.round(
    scale(l.lotSqm, 400, 1200) * 0.5 +
      scale(-l.slopePct, -20, -2) * 0.2 +
      (l.easement ? 0 : 15) +
      (l.heritageOverlay ? 0 : 15),
  );

  return { poolVerdict, extensionVerdict, blockers, notes, yardSqm, score: clamp(score) };
}

// ---------------------------------------------------------------------------
// 4. Family lifestyle
// ---------------------------------------------------------------------------

/** Composite of schools in catchment, childcare, green space and beach access. */
export function familyLifestyleScore(s) {
  const lf = s.lifestyle;
  const schoolScore = scale(
    lf.primarySchools.filter((x) => x.catchment).length * 2 + lf.secondarySchools.filter((x) => x.catchment).length * 2,
    1, 6,
  );
  const careScore = scale(lf.daycaresWithin2km, 2, 10);
  const greenScore = scale(lf.parks + lf.playgrounds, 8, 26);
  const beachScore = scale(-lf.beachAccessKm, -15, -0.5);
  const walkScore = scale(lf.footpathCoveragePct, 50, 95);
  return Math.round(
    schoolScore * 0.3 + careScore * 0.15 + greenScore * 0.2 + beachScore * 0.2 + walkScore * 0.15,
  );
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

/**
 * Everything the suburb cards and the detail panel need, computed once.
 * `opportunity` blends buyer choice, shadow inventory and lifestyle fit; it is
 * deliberately *not* penalised by tightly-held-ness — that is surfaced
 * separately as the expected search duration.
 */
export function suburbMetrics(s, listingsForSuburb = []) {
  const shadow = shadowInventory(s);
  const pressure = inventoryPressure(s);
  const tightlyHeld = tightlyHeldScore(s);
  const lifestyle = familyLifestyleScore(s);
  const turnover = turnoverOutlook(s);

  const expandable = listingsForSuburb.filter((l) => {
    const e = expansionPotential(l);
    return e.poolVerdict.tone !== 'warn';
  }).length;

  const opportunity = Math.round(
    pressure * 0.3 + scale(shadow.ratioPct, 5, 45) * 0.25 + lifestyle * 0.3 + turnover.score * 0.15,
  );

  return {
    pressure,
    shadow,
    tightlyHeld,
    lifestyle,
    turnover,
    opportunity,
    expandable,
    searchMonths: expectedSearchMonths(s),
    withdrawal: withdrawalVerdict(s),
    domTrend: s.inventory.medianDom - s.inventory.medianDomLastYear,
  };
}

/** Does a listing satisfy the active filter set? */
export function matchesFilters(l, f) {
  if (f.status !== 'all' && l.status !== f.status) return false;
  if (l.beds < f.minBeds) return false;
  if (l.lotSqm < f.minLot) return false;
  if (f.requireStudy && !l.study) return false;
  if (f.requirePool && !l.pool) return false;
  if (f.poolReady) {
    const e = expansionPotential(l);
    if (e.poolVerdict.tone === 'warn') return false;
  }
  if (f.maxPrice && l.priceGuide && l.priceGuide > f.maxPrice) return false;
  if (f.suburbId !== 'all' && l.suburbId !== f.suburbId) return false;
  return true;
}
