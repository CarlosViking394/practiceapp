// Replace the hand-entered lifestyle figures with real places from Google.
//
//   node --env-file=.env scripts/enrich-amenities.mjs
//   node --env-file=.env scripts/enrich-amenities.mjs --suburb=currimundi
//
// Writes amenity-report.json. Requirement 4 (family lifestyle) is the one area
// Google can source end to end — except school *catchment boundaries*, which
// Places cannot give you: it returns where a school is, not who may enrol.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { suburbs } from '../src/data/suburbs.js';
import { nearbyAmenities, hasKey } from '../src/server/google.js';

if (!hasKey()) {
  console.error('GOOGLE_MAPS_API_KEY is not set.\nRun: node --env-file=.env scripts/enrich-amenities.mjs');
  process.exit(2);
}

const only = (process.argv.find((a) => a.startsWith('--suburb=')) ?? '').split('=')[1];
const radius = Number((process.argv.find((a) => a.startsWith('--radius=')) ?? '--radius=2000').split('=')[1]);
const target = only ? suburbs.filter((s) => s.id === only) : suburbs;

if (!target.length) {
  console.error(`No suburb matched "${only}".`);
  process.exit(2);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`Fetching amenities within ${radius}m for ${target.length} suburb(s)…\n`);
console.log(pad('SUBURB', 18) + pad('PRIMARY', 9) + pad('SECOND.', 9) + pad('DAYCARE', 9) + pad('PARKS', 8) + pad('PLAYGR.', 9) + 'SEED SAID');
console.log('─'.repeat(96));

const report = [];
for (const s of target) {
  let a;
  try {
    a = await nearbyAmenities(s.coords, radius);
  } catch (err) {
    console.error(`\n${s.name}: ${err.message}`);
    process.exit(2);
  }

  const seed = s.lifestyle;
  const seedSummary = `daycare ${seed.daycaresWithin2km}, parks ${seed.parks}, playgr ${seed.playgrounds}`;
  console.log(
    pad(s.name, 18) +
    pad(a.primarySchools.count + (a.primarySchools.capped ? '+' : ''), 9) +
    pad(a.secondarySchools.count + (a.secondarySchools.capped ? '+' : ''), 9) +
    pad(a.daycares.count + (a.daycares.capped ? '+' : ''), 9) +
    pad(a.parks.count + (a.parks.capped ? '+' : ''), 8) +
    pad(a.playgrounds.count + (a.playgrounds.capped ? '+' : ''), 9) +
    seedSummary,
  );

  report.push({
    id: s.id,
    name: s.name,
    coords: s.coords,
    radiusM: radius,
    observed: {
      primarySchools: a.primarySchools.count,
      secondarySchools: a.secondarySchools.count,
      daycaresWithin2km: a.daycares.count,
      parks: a.parks.count,
      playgrounds: a.playgrounds.count,
    },
    seeded: {
      daycaresWithin2km: seed.daycaresWithin2km,
      parks: seed.parks,
      playgrounds: seed.playgrounds,
    },
    places: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.items])),
  });
}

const out = fileURLToPath(new URL('../amenity-report.json', import.meta.url));
await writeFile(out, JSON.stringify({ runAt: new Date().toISOString(), radiusM: radius, suburbs: report }, null, 2));
console.log(`\nreport → ${out}`);
console.log('\nSchool catchment boundaries are NOT in this data — Places returns school');
console.log('locations, not enrolment zones. Those come from QLD EdMap.');
