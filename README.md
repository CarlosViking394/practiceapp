# Family Buyer Intel

A small buyer's-agent tool for a 4-bedroom family brief. It answers four questions
about a suburb: *what's for sale*, *what's about to be*, *how long will this take*,
and *does this house have room to grow*.

## Run it

```bash
npm start                 # → http://localhost:4173, seed data
npm test                  # offline tests for the Domain mappings — no credentials needed
npm run verify:keyless    # check every address really exists (no API key needed)

# with credentials in .env:
npm run sync              # pull real listings, pricing and demographics from Domain
npm run sync:tenure       # ...and per-property sale history for tenure
npm run start:live        # serve with Google endpoints enabled
npm run enrich            # replace lifestyle figures with real Google Places data
```

No dependencies, no build step. Node 20+ (uses ES modules, `node:` imports and
`--env-file`). The app must be served over HTTP — ES module imports are blocked
on `file://`.

## Domain integration

`npm run sync` replaces the fabricated listings with real ones. It writes
`src/data/live/`, and the app prefers live data over seed data **per suburb and
per field** — so a partial sync degrades field by field rather than all at once.
Suburbs that synced show a "N live fields" chip and name them; suburbs that did
not still say plainly that their figures are fabricated.

### What Domain actually covers

| Requirement | Domain endpoint | Status |
|---|---|---|
| Active listings, price, beds, land area | `POST /v1/listings/residential/_search` | wired |
| Median price, days on market, sale counts | `GET /v2/suburbPerformanceStatistics/…` | wired |
| Sale history → tenure | `GET /v1/properties/{id}` | wired (`--tenure`) |
| Owner-occupier ratio | `GET /v2/demographics/…` | wired |
| **Withdrawal rate** | — | **no endpoint** |
| **Coming-soon / early intent signals** | — | **no endpoint**, needs agency CRM |
| **Rental vacancy rate** | — | SQM Research or REIQ |
| **Owner age profile** | — | ABS Census DataPacks |
| **Zoning, easements, slope, heritage** | — | council spatial services |
| **School catchment boundaries** | — | QLD EdMap |

`src/data/provenance.js` holds this mapping as data, so the UI labels each figure
from the same source of truth the README quotes.

### Auth

OAuth2 client credentials. `POST https://auth.domain.com.au/v1/connect/token`
with `Authorization: Basic base64(client_id:client_secret)` and
`grant_type=client_credentials`. The token is cached for its `expires_in` (minus
60s) and sent as `Authorization: Bearer {token}` — both the header name and the
`Bearer` prefix are case sensitive.

Scopes used: `api_listings_read`, `api_properties_read`,
`api_suburbperformance_read`, `api_demographics_read`. A scope outside your plan
returns **400 invalid_scope**, which reads like an auth failure but is a
subscription problem — `src/server/domain.js` names it explicitly.

### Two details that will bite you

**`dateListed` has no timezone and means Sydney time.** Parsing it as UTC shifts
every listing by 10–11 hours and silently rounds days-on-market the wrong way.
`parseSydneyDate()` handles AEST/AEDT including the October and April DST
boundaries, and it is covered by tests.

**Search caps at 1000 results.** `searchResidential()` paginates at 200 and stops
there; past that the query has to narrow rather than page on.

Sale history is one request per property, so `--tenure` is opt-in — it burns
quota fast on a free tier.

### Why Domain and not PropTrack

Domain has a self-serve developer portal: create a project and you get Agents &
Listings plus Properties & Locations immediately. PropTrack (REA Group) is not
self-serve — it requires a commercial agreement before you get any access at
all. There is no PropTrack adapter here for that reason; `.env.example` notes it
rather than pretending otherwise.

## What Google can and cannot supply

This is the constraint that shapes the whole integration.

**Google has no property listings API.** There is no endpoint for prices, days
on market, sale history, tenure, owner-occupier ratios, lot dimensions, zoning
or easements. Requirements 1–3 cannot be sourced from Google at all; they need
Domain or PropTrack, the ABS, and council spatial services.

| Requirement | Google covers it? | Actual source |
|---|---|---|
| 1 · Listings, DOM | **No** | Domain — **now wired** |
| 1 · Withdrawal rate, early signals | **No** | Agency CRM — no public API |
| 2 · Tenure, owner-occupier ratio | **No** | Domain — **now wired** |
| 3 · Lot size, zoning, easements | **No** | Council spatial services |
| 3 · Bedrooms, study, pool | **No** | Listing feed |
| 4 · Parks, playgrounds, childcare | **Yes** | Places API (New) |
| 4 · School *locations* | **Yes** | Places API |
| 4 · School *catchment boundaries* | **No** | QLD EdMap — Places gives location, not enrolment zones |
| Does this address exist? | **Yes** | Geocoding + Address Validation |
| Travel time to school/beach | **Yes** | Routes API |

So Google answers the question you actually asked — *do these properties exist
where they claim to* — and makes requirement 4 real. It cannot make the market
data real.

## Address verification

`npm run verify:keyless` geocodes every tracked address and reports whether it
resolves to a specific property, how far the stored coordinates sit from the
geocoded ones, and whether it lands in the claimed suburb. Results are written to
`verification-report.json`, and the app reads that file at startup: every row
carries an **Address confirmed / unconfirmed / not found** badge, and each
property's detail panel shows what the geocoder actually returned.

Running it on the current seed data gives the honest verdict:

```
confirmed to a specific address : 0/36
resolved to street/suburb only  : 12
no match at all                 : 24
stored coords >0.5km off        : 12
```

**None of the 36 seeded addresses is real.** Twelve sit on streets that do exist
(Buderim St in Currimundi, Farrell St in Yandina) but the house numbers do not
verify, and the coordinates I assigned are 0.7–2.1km from where those streets
actually run. The suburbs and their centroids are genuine; the individual
addresses are not.

Two providers sit behind one interface in `src/server/geocode.js`:

- `--provider=nominatim` — OpenStreetMap, keyless, rate limited to 1 req/s.
  Coverage of Australian house numbers is patchy, so a miss means *unconfirmed*,
  not *proven non-existent*.
- `--provider=google` (default) — Geocoding API, rooftop-accurate here. Needs a
  key. This is the one to trust for a real verdict.

The script exits non-zero when any address fails, so it can gate CI once the
data is real.

## Connecting Google

```bash
cp .env.example .env      # then paste your key in
npm run start:live
```

Enable **Geocoding**, **Address Validation**, **Places API (New)** and **Routes**
on the Cloud project, and restrict the key by IP. The key is read server-side
only — the browser never sees it. `server.js` exposes three proxy routes:

| Route | Backing API |
|---|---|
| `/api/status` | reports whether a key is configured |
| `/api/validate-address?address=…` | Address Validation |
| `/api/amenities?lat=&lng=&radius=` | Places Nearby Search |
| `/api/travel-time?from=&to=&mode=` | Routes / Route Matrix |

Without a key these return **503** with an explanatory message rather than
failing obscurely, and the app falls back to seed data with the mode pill
reading "addresses unverified".

All four are **billed per request**. Verifying 36 addresses is trivially cheap;
running Address Validation across a real listing feed on every refresh is not —
cache by `placeId` and re-validate only when an address changes.

## How the four requirement areas map to code

## What it does

A **search area** bar sits above every tab: pick an anchor suburb and a radius
(default Currimundi, 10km). Everything below it respects that area.

**Suburbs tab** ranks the suburbs in range on an opportunity score and shows
expected search duration. **Inventory tab** filters tracked properties across
on-market, coming-soon and early-signal states. **Data sources tab** shows which
feed backs each metric. Clicking any card or row opens a detail panel.

## Search area — why it filters on addresses, not suburbs

The radius is applied to **property coordinates, not suburb centroids**, and that
distinction changes the results. Buderim's centroid sits 10.5km from Currimundi,
so a centroid test drops the suburb entirely — yet 3 of its 4 tracked addresses
are inside a 10km radius (7.9km, 8.5km and 9.5km); only the northern one at
11.7km is genuinely out. Buderim is the strongest family market in the dataset,
and a centroid filter would have thrown it away over 0.5km.

So a suburb stays visible when *any* of its addresses qualify. Cards for
partially-covered suburbs are drawn with a dashed border and an
"N/M addresses in area" chip, and their detail panel explains the split. Suburb
metrics are recomputed from the in-range addresses only, so a suburb is scored on
stock a buyer could actually act on.

`src/geo.js` holds the haversine calculation, the anchor list and `coverage()`.
Distances from the current anchor appear on every card and row.

At the default Currimundi 10km setting: 9 of 12 suburbs and 27 of 36 addresses
qualify. Yandina (27km), Peregian Springs (30km) and Palmwoods (18km) fall out —
they were the non-local addresses. **Include outside area** in the Inventory tab
brings them back flagged rather than hidden, for comparison.

## How the four requirement areas map to code

### 1. On-market and "coming soon" indicators

Listings carry three states, not one — `on-market`, `coming-soon` (agent-flagged
but unadvertised), and `signal` (not listed at all, surfaced only by intent data).

`shadowInventory()` in `src/metrics.js` expresses pre-market volume as a
percentage of the advertised pool. That ratio is the practical output: at 55%
shadow inventory a buyer should wait rather than compete on what's visible.

Active listings, DOM (with a year-on-year delta), withdrawal rate and 90-day
price movement feed `inventoryPressure()`. Withdrawal rate is read as vendor
discipline — above 12% means asking prices are ahead of the market.

Early intent signals tracked per suburb: pre-market approvals, building & pest
bookings against unlisted addresses, agent CRM drafts, and appraisal requests.
Inspection bookings lead a public listing by roughly 3–6 weeks, which makes them
the earliest reliable tell.

### 2. Turn-over and tenure

`tightlyHeldScore()` combines average tenure, owner-occupier share and vacancy
rate. `expectedSearchMonths()` converts turnover rate and matching-stock
percentage into a search runway — the number that sets buyer expectations
(Wurtulla ~15.6 months versus Peregian Springs ~5.2).

`turnoverOutlook()` pairs long tenure with the share of owners aged 60+, the
classic precursor to a wave of stock. Suburbs flagged "Turnover likely" are where
early signals are worth monitoring even when nothing is listed today.

At property level, tenure is compared against the suburb average — a home held
well past it usually means a life-stage sale rather than a price-driven one.

### 3. Physical attributes and expansion potential

Listings index bedrooms, study/multipurpose rooms, pools and outdoor features.
`expansionPotential()` joins those against council spatial attributes — lot area,
zoning, registered easements, slope and heritage overlays — and returns a verdict
with its reasoning rather than a bare yes/no.

The 600m² threshold from the brief is the working minimum, but it isn't applied
alone: an 800m² lot with an easement and a 19% slope is correctly flagged
constrained, because retaining costs there exceed the pool. The **Pool-capable**
filter (on by default) uses this, so a search for expandable 4-bed homes returns
blocks that will actually take a pool.

### 4. Family lifestyle

`familyLifestyleScore()` weights school catchments (30%), childcare within 2km
(15%), parks and playgrounds (20%), beach proximity (20%) and footpath coverage
(15%). Each property lists the specific catchments it falls inside.

The weighting is deliberately visible in one function — it's the thing a buyer's
agent will want to tune per client.

## Swapping in live data

The app reads only through `src/adapters/index.js`; no view code touches a vendor
payload. Set `MODE = 'live'`, supply credentials, and implement the fetchers:

| Adapter | Live source |
|---|---|
| `listings` | Domain Developer Portal `/v1/listings/residential/_search`, or PropTrack Listings |
| `signals` | Agency CRM exports, inspection-booking systems |
| `sales` | Domain sales history / price estimates |
| `demography` | ABS Census DataPacks (tenure, owner-occupier ratio) |
| `spatial` | Council open data — cadastre, zoning, easements, overlays |
| `schools` | QLD EdMap catchment boundaries |
| `amenities` | OpenStreetMap Overpass, council GIS |

Coordinates are the join key for the radius filter. A live listings feed supplies
them per property; `normaliseDomainListing()` should carry `geoLocation` through
to `coords`, otherwise every address reads as infinitely far away and drops out.

`normaliseDomainListing()` shows the expected mapping for the listings feed.
Note the four fields it leaves null — zoning, easement, slope and heritage come
from the council spatial join, not the listing feed, and that join is what makes
the expansion analysis possible.

## Layout

```
index.html            shell — three tabs and a detail drawer
server.js             zero-dependency static server
src/app.js            rendering and event wiring
src/metrics.js        all scoring; weightings live here and nowhere else
src/adapters/index.js the only module that knows where data comes from
src/geo.js            haversine, anchors, radius coverage
src/server/google.js  Google Maps Platform client (server-side, holds the key)
src/server/geocode.js geocoding providers: google | nominatim
src/server/domain.js  Domain API client — OAuth2, pagination, retry
src/server/domain-normalise.js  Domain payloads → our shapes (unit tested)
src/data/provenance.js which fields have a real source, and which do not
fixtures/             recorded Domain payloads for the offline tests
scripts/              sync-domain, verify-addresses, enrich-amenities, test-normalisers
src/data/             seed datasets: 12 suburbs, 36 properties
```

## Data status

Verified by `npm run verify:keyless` on the current data:

- **Suburb names, postcodes and centroids are real.** Distances between suburbs
  are genuine great-circle figures.
- **No individual property address is real.** 0 of 36 confirm; 24 do not match
  anything. Twelve sit on real streets with invented house numbers.
- **All market data is fabricated** — prices, DOM, tenure, lot sizes, zoning,
  signals. Plausible for the Sunshine Coast corridor, not observed.

Nothing here should be quoted to a client until `npm run sync` has run. The app
is wired for real data and reports honestly whether it has any: the mode pill
reads "Live · N Domain listings" once synced, and "Seed data · not synced"
until then.
