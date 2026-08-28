// Pull real listings, suburb performance and demographics from Domain and write
// them to src/data/live/.
//
//   node --env-file=.env scripts/sync-domain.mjs
//   node --env-file=.env scripts/sync-domain.mjs --suburb=currimundi
//   node --env-file=.env scripts/sync-domain.mjs --tenure   # + per-property sale history
//
// The app prefers live data when present and falls back to seed data per
// suburb, so a partial sync degrades field by field rather than all at once.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { suburbs } from '../src/data/suburbs.js';
import {
  searchResidential, getProperty, getSuburbPerformance, getDemographics, hasCredentials,
} from '../src/server/domain.js';
import {
  normaliseListing, deriveTenure, normaliseSuburbPerformance, normaliseDemographics,
} from '../src/server/domain-normalise.js';

if (!hasCredentials()) {
  console.error(
    'DOMAIN_CLIENT_ID and DOMAIN_CLIENT_SECRET are not set.\n' +
    'Create a project at https://developer.domain.com.au, then:\n' +
    '  cp .env.example .env && node --env-file=.env scripts/sync-domain.mjs',
  );
  process.exit(2);
}

const arg = (n, d = null) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split('=')[1];
const only = arg('suburb');
const withTenure = process.argv.includes('--tenure');
const minBedrooms = Number(arg('minBedrooms', 4));

const target = only ? suburbs.filter((s) => s.id === only) : suburbs;
if (!target.length) {
  console.error(`No suburb matched "${only}".`);
  process.exit(2);
}

const outDir = fileURLToPath(new URL('../src/data/live/', import.meta.url));
await mkdir(outDir, { recursive: true });

const pad = (s, n) => String(s).padEnd(n);
console.log(`Syncing ${target.length} suburb(s) from Domain…\n`);
console.log(pad('SUBURB', 18) + pad('LISTINGS', 10) + pad('MEDIAN', 12) + pad('DOM', 6) + pad('OWNER-OCC', 11) + 'NOTES');
console.log('─'.repeat(88));

const allListings = [];
const suburbData = {};
let failures = 0;

for (const s of target) {
  const notes = [];
  let listings = [];
  let performance = null;
  let demographics = null;

  try {
    const raw = await searchResidential({
      state: s.state, suburb: s.name, postcode: s.postcode,
      listingType: 'Sale', propertyTypes: ['House'], minBedrooms,
    });
    listings = raw.map((r) => normaliseListing(r)).filter((l) => l && l.coords);
    if (raw.length !== listings.length) notes.push(`${raw.length - listings.length} without coordinates dropped`);
  } catch (err) {
    notes.push(`listings failed: ${err.message.slice(0, 60)}`);
    failures += 1;
  }

  try {
    performance = normaliseSuburbPerformance(
      await getSuburbPerformance({ state: s.state, suburb: s.name, postcode: s.postcode, bedrooms: minBedrooms }),
    );
  } catch (err) {
    notes.push(`performance unavailable (${err.message.includes('403') ? 'package not on plan' : 'error'})`);
  }

  try {
    demographics = normaliseDemographics(
      await getDemographics({ state: s.state, suburb: s.name, postcode: s.postcode }),
    );
  } catch (err) {
    notes.push('demographics unavailable');
  }

  // Sale history is one request per property — opt in, it burns quota fast.
  if (withTenure && listings.length) {
    const spells = [];
    for (const l of listings) {
      if (!l.propertyId) continue;
      try {
        const t = deriveTenure(await getProperty(l.propertyId));
        l.lastSold = t.lastSold;
        if (t.averageTenureYears) spells.push(t.averageTenureYears);
      } catch { /* individual property lookups may 404; skip quietly */ }
    }
    if (spells.length) {
      performance = { ...(performance ?? {}), avgTenureYears: Math.round((spells.reduce((a, b) => a + b, 0) / spells.length) * 10) / 10 };
      notes.push(`tenure from ${spells.length} properties`);
    }
  }

  allListings.push(...listings);
  suburbData[s.id] = { performance, demographics, syncedAt: new Date().toISOString() };

  console.log(
    pad(s.name, 18) +
    pad(listings.length || '—', 10) +
    pad(performance?.medianPrice ? '$' + Math.round(performance.medianPrice / 1000) + 'k' : '—', 12) +
    pad(performance?.medianDom ?? '—', 6) +
    pad(demographics?.ownerOccupierPct != null ? demographics.ownerOccupierPct + '%' : '—', 11) +
    notes.join('; '),
  );
}

await writeFile(`${outDir}listings.json`, JSON.stringify(allListings, null, 2));
await writeFile(`${outDir}suburbs.json`, JSON.stringify(suburbData, null, 2));

console.log('\n' + '─'.repeat(88));
console.log(`${allListings.length} listings → src/data/live/listings.json`);
console.log(`${Object.keys(suburbData).length} suburbs → src/data/live/suburbs.json`);
console.log('\nStill not covered by Domain, and still seed values:');
console.log('  withdrawal rate, coming-soon / early signals, vacancy rate, owner age,');
console.log('  zoning, easements, slope, heritage overlay, school catchment boundaries.');

process.exit(failures ? 1 : 0);
