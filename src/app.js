import { fetchSuburbs, fetchListings, fetchApiStatus, fetchVerification, fetchLiveStatus, sources, SOURCES, MODE } from './adapters/index.js';
import { suburbMetrics, expansionPotential, matchesFilters } from './metrics.js';
import { ANCHORS, DEFAULT_ANCHOR, DEFAULT_RADIUS_KM, anchorById, distanceFrom, coverage, round1 } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const money = (n) => (n == null ? 'Undisclosed' : '$' + Math.round(n / 1000).toLocaleString('en-AU') + 'k');

/**
 * Domain's displayableAddress already carries the suburb; the seed addresses do
 * not. Append it only when it is missing, or live rows read "…, Currimundi, Currimundi".
 */
const fullAddress = (l, suburbName) =>
  l.address?.toLowerCase().includes(suburbName.toLowerCase()) ? l.address : `${l.address}, ${suburbName}`;
const pct = (n) => `${n}%`;

/** Address-verification badge for a listing, or null if no report has been run. */
function verificationChip(l) {
  const v = state.verification;
  if (!v) return '<span class="chip warn" title="Run npm run verify:keyless">Address unverified</span>';
  const r = v.byId[l.id];
  if (!r) return '<span class="chip warn">Address unverified</span>';
  if (r.confirmed) return '<span class="chip good">Address confirmed</span>';
  if (r.found) return `<span class="chip warn" title="${r.notes.join('; ')}">Address unconfirmed (${r.precision})</span>`;
  return '<span class="chip warn" title="Geocoder returned no match">Address not found</span>';
}

const STATUS = {
  'on-market': { label: 'On market', tone: '' },
  'coming-soon': { label: 'Coming soon', tone: 'mid' },
  signal: { label: 'Early signal', tone: 'warn' },
};

const state = {
  suburbs: [],
  listings: [],
  metrics: new Map(),
  sort: 'opportunity',
  anchor: DEFAULT_ANCHOR,
  radiusKm: DEFAULT_RADIUS_KM,
  coverage: new Map(),
  verification: null,
  apiStatus: { google: 'unknown', mode: 'seed' },
  liveStatus: { listings: 0, suburbs: 0, any: false },
  filters: {
    suburbId: 'all', status: 'all', minBeds: 4, minLot: 600,
    maxPrice: 0, requireStudy: false, requirePool: false, poolReady: true,
    includeOutside: false,
  },
};

/**
 * Recompute which addresses fall inside the radius. Metrics are then derived
 * from the in-range listings only, so a suburb is scored on the stock a buyer
 * could actually act on rather than on everything inside its boundary.
 */
function recomputeArea() {
  state.coverage.clear();
  for (const s of state.suburbs) {
    const mine = state.listings.filter((l) => l.suburbId === s.id);
    const cov = coverage(state.anchor, state.radiusKm, s, mine);
    state.coverage.set(s.id, cov);
    state.metrics.set(s.id, suburbMetrics(s, cov.inRange.length ? cov.inRange : mine));
  }
}

/** Suburbs with at least one qualifying address. */
const suburbsInArea = () => state.suburbs.filter((s) => state.coverage.get(s.id).anyInRange);

/** Is this listing inside the current search area? */
const inArea = (l) => distanceFrom(state.anchor, l) <= state.radiusKm;

// ---------------------------------------------------------------------------
// Suburb view
// ---------------------------------------------------------------------------

function barRow(label, value, tone) {
  const color = tone === 'warn' ? 'var(--warn)' : tone === 'mid' ? 'var(--mid)' : tone === 'good' ? 'var(--good)' : 'var(--accent)';
  return `<div class="bar-row"><span>${label}</span>
    <span class="bar"><i style="width:${Math.max(2, value)}%;background:${color}"></i></span>
    <b>${value}</b></div>`;
}

function suburbCard(s) {
  const m = state.metrics.get(s.id);
  const cov = state.coverage.get(s.id);
  const card = el('div', 'card' + (cov.partial ? ' partial' : ''));
  card.innerHTML = `
    <div class="card-head">
      <div>
        <h3>${s.name}</h3>
        <div class="sub"><span class="dist">${cov.centroidKm}km</span> from ${anchorById(state.anchor).label} · ${s.postcode} · median ${money(s.inventory.medianPrice)}</div>
      </div>
      <div class="score"><b>${m.opportunity}</b><span>Opp</span></div>
    </div>
    <div class="bars">
      ${barRow('Buyer choice', m.pressure)}
      ${barRow('Family fit', m.lifestyle, 'good')}
      ${barRow('Tightly held', m.tightlyHeld, m.tightlyHeld > 70 ? 'warn' : 'mid')}
      ${barRow('Turnover ahead', m.turnover.score, 'mid')}
    </div>
    <div class="chips">
      <span class="chip">${s.inventory.activeListings} live</span>
      <span class="chip mid">${m.shadow.hidden} coming</span>
      <span class="chip">${s.inventory.medianDom}d DOM</span>
      <span class="chip ${m.searchMonths > 12 ? 'warn' : m.searchMonths > 8 ? 'mid' : 'good'}">~${m.searchMonths}mo search</span>
      <span class="chip ${m.withdrawal.tone}">${m.withdrawal.label} withdrawal</span>
      ${s.live ? `<span class="chip good" title="${s.liveFields.join(', ')}">${s.liveFields.length} live fields</span>` : ''}
      ${cov.partial
        ? `<span class="chip mid">${cov.inRange.length}/${cov.total} addresses in area</span>`
        : ''}
    </div>`;
  card.onclick = () => openSuburb(s);
  return card;
}

function renderSuburbs() {
  const key = state.sort;
  const value = (s) => {
    const m = state.metrics.get(s.id);
    if (key === 'shadow') return m.shadow.ratioPct;
    if (key === 'searchMonths') return -m.searchMonths; // shorter search ranks first
    if (key === 'distance') return -state.coverage.get(s.id).centroidKm; // nearest first
    return m[key];
  };
  const grid = $('#suburb-grid');
  grid.innerHTML = '';
  const shown = suburbsInArea();
  if (!shown.length) {
    grid.appendChild(el('div', 'empty', 'No suburbs have addresses inside this radius. Widen the search area.'));
    return;
  }
  shown.sort((a, b) => value(b) - value(a)).forEach((s) => grid.appendChild(suburbCard(s)));
}

function openSuburb(s) {
  const m = state.metrics.get(s.id);
  const cov = state.coverage.get(s.id);
  const mine = cov.inRange;
  const coming = mine.filter((l) => l.status !== 'on-market');
  const t = s.tenure, st = s.stock, lf = s.lifestyle, inv = s.inventory;
  const domArrow = m.domTrend < 0 ? `${Math.abs(m.domTrend)}d faster than last year` : `${m.domTrend}d slower than last year`;

  $('#drawer-body').innerHTML = `
    <h2>${s.name}</h2>
    <div class="sub">${s.region} · ${s.state} ${s.postcode} · ${cov.centroidKm}km from ${anchorById(state.anchor).label}</div>

    <div class="callout">
      <b>${m.tightlyHeld > 70 ? 'Tightly held family pocket.' : m.tightlyHeld > 45 ? 'Moderately held.' : 'Actively trading.'}</b>
      Budget roughly <b>${m.searchMonths} months</b> of searching for a matching 4-bed home.
      ${m.shadow.hidden} properties are in the pre-market pipeline against ${m.shadow.visible} advertised
      (${m.shadow.ratioPct}% shadow inventory).
      ${cov.partial
        ? `<br><span style="color:var(--mid)">${cov.inRange.length} of ${cov.total} tracked addresses here fall inside the
           ${state.radiusKm}km radius — the suburb centre is ${cov.centroidKm}km out, so only part of it qualifies.</span>`
        : ''}
    </div>

    ${s.live
      ? `<p class="note" style="margin-bottom:16px">Live from Domain (${new Date(s.syncedAt).toLocaleDateString()}):
         ${s.liveFields.map((f) => `<code>${f.split('.')[1]}</code>`).join(' ')}. Remaining figures are seed values.</p>`
      : '<p class="note" style="margin-bottom:16px">No Domain sync has run for this suburb — every figure below is fabricated seed data.</p>'}

    <div class="sec">
      <h5>1 · Inventory & momentum</h5>
      <dl class="kv">
        <dt>Active listings</dt><dd>${inv.activeListings}</dd>
        <dt>Coming soon (agent-flagged)</dt><dd>${inv.comingSoon}</dd>
        <dt>New listings, 30 days</dt><dd>${inv.newListings30d}</dd>
        <dt>Median days on market</dt><dd>${inv.medianDom} <span style="color:var(--ink-dim)">(${domArrow})</span></dd>
        <dt>Withdrawal rate</dt><dd>${pct(inv.withdrawalRatePct)}</dd>
        <dt>Price movement, 90 days</dt><dd>${inv.priceChange90dPct > 0 ? '+' : ''}${inv.priceChange90dPct}%</dd>
      </dl>
      <p class="note">${m.withdrawal.note}</p>
    </div>

    <div class="sec">
      <h5>Early intent signals</h5>
      <dl class="kv">
        <dt>Pre-market approvals</dt><dd>${s.earlySignals.preMarketApprovals}</dd>
        <dt>Building &amp; pest bookings (unlisted)</dt><dd>${s.earlySignals.inspectionRequests}</dd>
        <dt>Agent CRM draft listings</dt><dd>${s.earlySignals.draftListings}</dd>
        <dt>Appraisal requests</dt><dd>${s.earlySignals.appraisalRequests}</dd>
      </dl>
      <p class="note">Inspection bookings on unlisted addresses lead a public listing by roughly 3–6 weeks — the earliest reliable tell that stock is coming.</p>
    </div>

    <div class="sec">
      <h5>2 · Tenure & turnover</h5>
      <dl class="kv">
        <dt>Average length of ownership</dt><dd>${t.avgTenureYears} yrs</dd>
        <dt>Annual turnover rate</dt><dd>${pct(t.turnoverRatePct)}</dd>
        <dt>Owner-occupier share</dt><dd>${pct(t.ownerOccupierPct)}</dd>
        <dt>Rental vacancy</dt><dd>${pct(t.vacancyRatePct)}</dd>
        <dt>Owners aged 60+</dt><dd>${pct(t.ownersOver60Pct)}</dd>
        <dt>Turnover outlook</dt><dd>${m.turnover.label}</dd>
      </dl>
      <p class="note">${t.avgTenureYears >= 10 && t.ownersOver60Pct >= 28
        ? 'Long tenure alongside an ageing owner profile — this pocket is due for a turnover wave.'
        : 'Tenure and owner age are not yet signalling a turnover wave.'}</p>
    </div>

    <div class="sec">
      <h5>3 · Stock & expansion potential</h5>
      <dl class="kv">
        <dt>4+ bedroom homes</dt><dd>${pct(st.pct4PlusBed)}</dd>
        <dt>With a study / multipurpose room</dt><dd>${pct(st.pctWithStudy)}</dd>
        <dt>With a pool</dt><dd>${pct(st.pctWithPool)}</dd>
        <dt>Median lot</dt><dd>${st.medianLotSqm}m²</dd>
        <dt>Lots over 600m²</dt><dd>${pct(st.pctLotOver600)}</dd>
        <dt>Dominant zoning</dt><dd>${st.dominantZoning}</dd>
        <dt>Tracked homes that can take a pool</dt><dd>${m.expandable} of ${mine.length}</dd>
      </dl>
      <p class="note">${st.poolApprovalNotes}</p>
    </div>

    <div class="sec">
      <h5>4 · Family lifestyle</h5>
      <dl class="kv">
        <dt>Primary catchment</dt><dd>${lf.primarySchools.filter((x) => x.catchment).map((x) => x.name).join(', ') || '—'}</dd>
        <dt>Secondary catchment</dt><dd>${lf.secondarySchools.filter((x) => x.catchment).map((x) => x.name).join(', ') || '—'}</dd>
        <dt>Daycare / preschool within 2km</dt><dd>${lf.daycaresWithin2km}</dd>
        <dt>Parks / playgrounds</dt><dd>${lf.parks} / ${lf.playgrounds}</dd>
        <dt>Nearest beach access</dt><dd>${lf.beachAccessKm}km</dd>
        <dt>Footpath coverage</dt><dd>${pct(lf.footpathCoveragePct)}</dd>
      </dl>
    </div>

    <div class="sec">
      <h5>Pipeline in this suburb</h5>
      ${coming.length
        ? `<ul class="plain">${coming.map((l) => `<li><b style="color:var(--ink)">${l.address}</b> — ${STATUS[l.status].label}${l.signals.length ? `: ${l.signals.join('; ')}` : ''}</li>`).join('')}</ul>`
        : '<p class="note">No pre-market activity tracked here right now.</p>'}
    </div>`;
  $('#drawer').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Listings view
// ---------------------------------------------------------------------------

function listingRow(l) {
  const s = state.suburbs.find((x) => x.id === l.suburbId);
  const e = expansionPotential(l);
  const st = STATUS[l.status];
  const km = round1(distanceFrom(state.anchor, l));
  const outside = km > state.radiusKm;
  const row = el('div', 'row');
  row.innerHTML = `
    <div>
      <h4>${fullAddress(l, s.name)}</h4>
      <div class="meta"><span class="dist">${km}km</span> from ${anchorById(state.anchor).label} · ${l.beds} bed · ${l.baths} bath · ${l.cars} car · ${l.lotSqm}m² lot · built ${l.yearBuilt}</div>
      <div class="chips row-chips">
        <span class="chip ${st.tone}">${st.label}</span>
        ${outside ? '<span class="chip warn">Outside search area</span>' : ''}
        ${verificationChip(l)}
        ${l.source === 'domain' ? '<span class="chip good">Live · Domain</span>' : ''}
        <span class="chip ${e.poolVerdict.tone}">${e.poolVerdict.label}</span>
        <span class="chip ${e.extensionVerdict.tone}">${e.extensionVerdict.label}</span>
        ${l.inCatchment.length ? `<span class="chip good">${l.inCatchment.length} catchment${l.inCatchment.length > 1 ? 's' : ''}</span>` : ''}
        ${l.dom != null && l.dom > 45 ? `<span class="chip mid">${l.dom} days listed</span>` : ''}
      </div>
    </div>
    <div class="price">${money(l.priceGuide)}${l.priceChanges.length ? '<small>reduced</small>' : l.status === 'signal' ? '<small>not listed</small>' : ''}</div>`;
  row.onclick = () => openListing(l);
  return row;
}

function renderListings() {
  const matched = state.listings.filter(
    (l) => (state.filters.includeOutside || inArea(l)) && matchesFilters(l, state.filters),
  );
  const list = $('#listing-list');
  list.innerHTML = '';
  const pool = state.filters.includeOutside ? state.listings : state.listings.filter(inArea);
  $('#listing-count').textContent =
    `${matched.length} of ${pool.length} properties ` +
    `${state.filters.includeOutside ? 'tracked' : `within ${state.radiusKm}km of ${anchorById(state.anchor).label}`} match — ` +
    `${matched.filter((l) => l.status === 'on-market').length} on market, ` +
    `${matched.filter((l) => l.status !== 'on-market').length} pre-market.`;
  if (!matched.length) {
    list.appendChild(el('div', 'empty',
      'No properties match this brief inside the search area. Widen the radius, or loosen the lot size or price ceiling.'));
    return;
  }
  const order = { 'coming-soon': 0, signal: 1, 'on-market': 2 };
  matched.sort((a, b) =>
    (inArea(b) - inArea(a)) || order[a.status] - order[b.status] || (b.lotSqm - a.lotSqm));
  matched.forEach((l) => list.appendChild(listingRow(l)));
}

function openListing(l) {
  const s = state.suburbs.find((x) => x.id === l.suburbId);
  const e = expansionPotential(l);
  const heldYears = l.lastSold ? ((Date.now() - Date.parse(l.lastSold.date)) / 31557600000).toFixed(1) : null;
  const growth = l.lastSold && l.priceGuide
    ? Math.round(((l.priceGuide - l.lastSold.price) / l.lastSold.price) * 100) : null;

  $('#drawer-body').innerHTML = `
    <h2>${l.address}</h2>
    <div class="sub">${s.name} ${s.state} ${s.postcode} · ${STATUS[l.status].label} ·
      ${round1(distanceFrom(state.anchor, l))}km from ${anchorById(state.anchor).label}</div>

    <div class="callout">
      <b>${e.poolVerdict.label}. ${e.extensionVerdict.label}.</b>
      ${e.notes.join('. ')}.
    </div>

    <div class="sec">
      <h5>Listing</h5>
      <dl class="kv">
        <dt>Price guide</dt><dd>${money(l.priceGuide)}</dd>
        <dt>Bedrooms / bathrooms / cars</dt><dd>${l.beds} / ${l.baths} / ${l.cars}</dd>
        <dt>Study or multipurpose room</dt><dd>${l.study ? 'Yes' : 'No'}</dd>
        <dt>Pool</dt><dd>${l.pool ? 'Yes' : 'No'}</dd>
        <dt>Days on market</dt><dd>${l.dom == null ? 'Not listed' : l.dom}</dd>
        ${l.priceChanges.map((c) => `<dt>Price change ${c.date}</dt><dd>${money(c.from)} → ${money(c.to)}</dd>`).join('')}
      </dl>
    </div>

    <div class="sec">
      <h5>Tenure</h5>
      <dl class="kv">
        ${l.lastSold ? `<dt>Last sold</dt><dd>${l.lastSold.date} for ${money(l.lastSold.price)}</dd>
        <dt>Held for</dt><dd>${heldYears} yrs</dd>` : '<dt>Last sold</dt><dd>No record</dd>'}
        ${growth != null ? `<dt>Growth since purchase</dt><dd>+${growth}%</dd>` : ''}
        <dt>Suburb average tenure</dt><dd>${s.tenure.avgTenureYears} yrs</dd>
      </dl>
      ${heldYears && Number(heldYears) > s.tenure.avgTenureYears
        ? '<p class="note">Held longer than the suburb average — vendors here are typically motivated by a life-stage change rather than price.</p>' : ''}
    </div>

    <div class="sec">
      <h5>Block & expansion potential</h5>
      <dl class="kv">
        <dt>Lot area</dt><dd>${l.lotSqm}m²</dd>
        <dt>Building footprint</dt><dd>${l.floorSqm}m²</dd>
        <dt>Remaining site area</dt><dd>~${e.yardSqm}m²</dd>
        <dt>Zoning</dt><dd>${l.zoning}</dd>
        <dt>Easement</dt><dd>${l.easement ? 'Registered' : 'None recorded'}</dd>
        <dt>Slope</dt><dd>${l.slopePct}%</dd>
        <dt>Heritage overlay</dt><dd>${l.heritageOverlay ? 'Yes' : 'No'}</dd>
        <dt>Potential score</dt><dd>${e.score}/100</dd>
      </dl>
      ${e.blockers.length
        ? `<p class="note"><b style="color:var(--mid)">Constraints:</b></p><ul class="plain">${e.blockers.map((b) => `<li>${b}</li>`).join('')}</ul>`
        : '<p class="note">No recorded constraints on adding a pool or a rear extension.</p>'}
      <p class="note">${s.stock.poolApprovalNotes}</p>
    </div>

    <div class="sec">
      <h5>Family lifestyle</h5>
      <dl class="kv">
        <dt>In catchment for</dt><dd>${l.inCatchment.join('<br>') || '—'}</dd>
        <dt>Daycare within 2km</dt><dd>${s.lifestyle.daycaresWithin2km}</dd>
        <dt>Parks / playgrounds nearby</dt><dd>${s.lifestyle.parks} / ${s.lifestyle.playgrounds}</dd>
        <dt>Beach access</dt><dd>${s.lifestyle.beachAccessKm}km</dd>
        <dt>Footpath coverage</dt><dd>${pct(s.lifestyle.footpathCoveragePct)}</dd>
      </dl>
    </div>

    <div class="sec">
      <h5>Address verification</h5>
      ${(() => {
        const v = state.verification;
        const r = v?.byId[l.id];
        if (!r) {
          return `<p class="note">No verification has been run against this address. Run
            <code>npm run verify:keyless</code>, or <code>npm run verify</code> with a Google key,
            to confirm it exists.</p>`;
        }
        return `<dl class="kv">
          <dt>Checked with</dt><dd>${v.provider}</dd>
          <dt>Result</dt><dd>${r.found ? `matched to ${r.precision}` : 'no match'}</dd>
          <dt>Specific address confirmed</dt><dd>${r.confirmed ? 'Yes' : 'No'}</dd>
          ${r.formatted ? `<dt>Geocoded as</dt><dd>${r.formatted}</dd>` : ''}
          ${r.driftKm != null ? `<dt>Stored vs geocoded</dt><dd>${r.driftKm}km apart</dd>` : ''}
        </dl>
        ${r.notes.length ? `<p class="note"><b style="color:var(--warn)">${r.notes.join('; ')}</b></p>` : ''}
        ${!r.confirmed ? '<p class="note">This address has not been confirmed to exist. Treat its coordinates, and any distance derived from them, as indicative only.</p>' : ''}`;
      })()}
    </div>

    ${l.signals.length ? `<div class="sec"><h5>Why this surfaced</h5>
      <ul class="plain">${l.signals.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : ''}`;
  $('#drawer').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Sources view
// ---------------------------------------------------------------------------

function renderSources() {
  const panel = $('#sources-panel');
  const v = state.verification;
  const g = state.apiStatus.google;

  const verifyLine = v
    ? `<b>${v.summary.confirmed} of ${v.summary.total}</b> addresses confirmed to a specific property via
       <b>${v.provider}</b> (${v.summary.missing} no match, ${v.summary.streetOnly} street-level only,
       ${v.summary.drifted} with coordinates more than 500m off). Run at ${new Date(v.runAt).toLocaleString()}.`
    : 'No address verification has been run yet — <code>npm run verify:keyless</code>.';

  const ls = state.liveStatus;
  panel.innerHTML = `
    <div class="callout" style="border-left-color:${ls.any ? 'var(--good)' : 'var(--warn)'}">
      <b>Domain:</b> ${ls.any
        ? `synced — ${ls.listings} live listings across ${ls.suburbs} suburbs${ls.syncedAt ? `, last run ${new Date(ls.syncedAt).toLocaleString()}` : ''}.`
        : 'not synced. Add credentials to <code>.env</code> and run <code>npm run sync</code> to replace the fabricated listings with real ones.'}
    </div>
    <div class="callout"><b>Google:</b> ${g === 'configured'
      ? 'key configured — Places, Address Validation and Routes are live.'
      : 'no key. Copy <code>.env.example</code> to <code>.env</code>, then <code>npm run start:live</code>.'}
    </div>
    <div class="callout" style="border-left-color:var(--warn)"><b>Address verification:</b> ${verifyLine}</div>`;
  sources.forEach((src) => {
    const state_ = src.wired
      ? (src.key === 'listings' || src.key === 'performance' || src.key === 'sales' || src.key === 'demography'
        ? (state.liveStatus.any ? { label: 'Live', tone: 'good' } : { label: 'Wired · not synced', tone: 'mid' })
        : { label: 'Wired', tone: 'mid' })
      : { label: 'No source wired', tone: 'warn' };
    panel.appendChild(el('div', 'src', `
      <div><b>${src.label}</b><div class="vendor">${src.vendor}</div></div>
      <span class="chip ${state_.tone}">${state_.label}</span>`));
  });

  panel.appendChild(el('p', 'note',
    'Fields with no source wired keep their seed values. Withdrawal rate and coming-soon inventory ' +
    'have no public API at all — they need an agency CRM feed.'));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function readFilters() {
  const f = state.filters;
  f.suburbId = $('#f-suburb').value;
  f.status = $('#f-status').value;
  f.minBeds = Number($('#f-beds').value);
  f.minLot = Number($('#f-lot').value);
  f.maxPrice = Number($('#f-price').value);
  f.requireStudy = $('#f-study').checked;
  f.requirePool = $('#f-pool').checked;
  f.poolReady = $('#f-poolready').checked;
  const outsideChanged = f.includeOutside !== $('#f-outside').checked;
  f.includeOutside = $('#f-outside').checked;
  if (outsideChanged) renderSuburbOptions();
  renderListings();
}

function renderAreaSummary() {
  const label = anchorById(state.anchor).label;
  const shown = suburbsInArea().length;
  const props = state.listings.filter(inArea).length;
  $('#a-radius-out').textContent = `${state.radiusKm}km`;
  $('#a-summary').textContent =
    `${shown} of ${state.suburbs.length} suburbs · ${props} of ${state.listings.length} addresses within ${state.radiusKm}km of ${label}`;
}

function renderSuburbOptions() {
  const sel = $('#f-suburb');
  const previous = state.filters.suburbId;
  const pool = state.filters.includeOutside ? state.suburbs : suburbsInArea();
  sel.innerHTML = '<option value="all">All suburbs</option>' +
    pool.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  // Fall back to "all" if the previously selected suburb left the search area.
  const stillValid = previous === 'all' || pool.some((s) => s.id === previous);
  sel.value = stillValid ? previous : 'all';
  state.filters.suburbId = sel.value;
}

function applyArea() {
  recomputeArea();
  renderAreaSummary();
  renderSuburbOptions();
  renderSuburbs();
  renderListings();
}

function bind() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
      $(`#view-${tab.dataset.view}`).classList.remove('hidden');
    };
  });

  $('#sort-suburbs').onchange = (ev) => { state.sort = ev.target.value; renderSuburbs(); };
  ['#f-suburb', '#f-status', '#f-beds', '#f-lot', '#f-price', '#f-study', '#f-pool', '#f-poolready', '#f-outside']
    .forEach((sel) => { $(sel).onchange = readFilters; });

  $('#a-anchor').onchange = (ev) => { state.anchor = ev.target.value; applyArea(); };
  const onRadius = (ev) => {
    state.radiusKm = Number(ev.target.value);
    $('#a-radius-out').textContent = `${state.radiusKm}km`;
    applyArea();
  };
  $('#a-radius').oninput = onRadius;
  $('#a-radius').onchange = onRadius;

  $('#f-reset').onclick = () => {
    $('#f-suburb').value = 'all'; $('#f-status').value = 'all'; $('#f-beds').value = '4';
    $('#f-lot').value = '600'; $('#f-price').value = '0';
    $('#f-study').checked = false; $('#f-pool').checked = false; $('#f-poolready').checked = true;
    $('#f-outside').checked = false;
    readFilters();
  };

  const close = () => $('#drawer').classList.add('hidden');
  $('#drawer-close').onclick = close;
  $('#drawer').onclick = (ev) => { if (ev.target.id === 'drawer') close(); };
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
}

async function init() {
  $('#mode-pill').textContent = 'Seed data';
  const [suburbs, listings, apiStatus, verification, liveStatus] = await Promise.all([
    fetchSuburbs(), fetchListings(), fetchApiStatus(), fetchVerification(), fetchLiveStatus(),
  ]);
  state.suburbs = suburbs;
  state.listings = listings;
  state.apiStatus = apiStatus;
  state.verification = verification;
  state.liveStatus = liveStatus;
  $('#a-anchor').innerHTML = ANCHORS
    .map((a) => `<option value="${a.id}"${a.id === state.anchor ? ' selected' : ''}>${a.label}</option>`)
    .join('');
  $('#a-radius').value = String(state.radiusKm);

  const confirmed = verification?.summary.confirmed ?? 0;
  if (liveStatus.any) {
    $('#mode-pill').textContent = `Live · ${liveStatus.listings} Domain listings`;
    $('#mode-pill').className = 'mode mode-good';
  } else {
    $('#mode-pill').textContent = verification
      ? `Seed data · ${confirmed}/${verification.summary.total} addresses verified`
      : 'Seed data · not synced';
    $('#mode-pill').className = 'mode mode-warn';
  }

  recomputeArea();

  renderSuburbOptions();

  bind();
  renderAreaSummary();
  renderSuburbs();
  renderListings();
  renderSources();
}

init();
