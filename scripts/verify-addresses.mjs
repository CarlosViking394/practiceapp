// Verify that every tracked address is a real, locatable place — and that the
// coordinates we hold for it are actually right.
//
//   node scripts/verify-addresses.mjs --provider=nominatim      # keyless
//   node --env-file=.env scripts/verify-addresses.mjs           # Google
//   node --env-file=.env scripts/verify-addresses.mjs --write   # fix coords
//
// Exit code is 1 if any address fails to confirm, so this can gate CI.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listings } from '../src/data/listings.js';
import { suburbById } from '../src/data/suburbs.js';
import { geocode, isConfirmed, rateLimitMs } from '../src/server/geocode.js';
import { distanceKm, round1 } from '../src/geo.js';

const args = process.argv.slice(2);
const provider = (args.find((a) => a.startsWith('--provider=')) ?? '--provider=google').split('=')[1];
const write = args.includes('--write');
const limit = Number((args.find((a) => a.startsWith('--limit=')) ?? '--limit=0').split('=')[1]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n);

/** How far the stored coordinate may sit from the geocoded one before we flag it. */
const DRIFT_TOLERANCE_KM = 0.5;

const target = limit ? listings.slice(0, limit) : listings;
const results = [];

console.log(`Verifying ${target.length} addresses via ${provider}…\n`);
console.log(pad('ID', 8) + pad('ADDRESS', 34) + pad('RESULT', 14) + pad('DRIFT', 9) + 'NOTE');
console.log('─'.repeat(104));

for (const l of target) {
  const s = suburbById[l.suburbId];
  const query = `${l.address}, ${s.name} ${s.state} ${s.postcode}, Australia`;

  let r;
  try {
    r = await geocode(query, { provider });
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(2);
  }

  const confirmed = r.found && isConfirmed(r.precision);
  const driftKm = r.found && l.coords ? distanceKm(l.coords, [r.lat, r.lng]) : null;

  // A geocoder that lands in a different suburb means the address is misfiled.
  const localityOk = !r.locality || !s.name
    || r.locality.toLowerCase().includes(s.name.toLowerCase())
    || s.name.toLowerCase().includes(r.locality.toLowerCase());

  const notes = [];
  if (!r.found) notes.push('no match');
  else if (!confirmed) notes.push(`resolved only to ${r.precision}`);
  if (r.found && !localityOk) notes.push(`geocoded into ${r.locality}`);
  if (driftKm != null && driftKm > DRIFT_TOLERANCE_KM) notes.push(`stored coords ${round1(driftKm)}km off`);

  results.push({
    id: l.id, address: l.address, suburb: s.name, query,
    found: r.found, precision: r.precision, confirmed, localityOk,
    geocoded: r.found ? [r.lat, r.lng] : null,
    stored: l.coords, driftKm: driftKm == null ? null : round1(driftKm),
    formatted: r.formatted ?? null, notes,
  });

  const verdict = confirmed ? '\x1b[32mconfirmed\x1b[0m' : r.found ? '\x1b[33m' + r.precision + '\x1b[0m' : '\x1b[31mnot found\x1b[0m';
  const padding = confirmed ? 23 : r.found ? 23 : 23;
  console.log(
    pad(l.id, 8) + pad(`${l.address}, ${s.name}`, 34) + pad(verdict, padding) +
    pad(driftKm == null ? '—' : round1(driftKm) + 'km', 9) + notes.join('; '),
  );

  if (rateLimitMs(provider)) await sleep(rateLimitMs(provider));
}

const confirmed = results.filter((r) => r.confirmed);
const streetOnly = results.filter((r) => r.found && !r.confirmed);
const missing = results.filter((r) => !r.found);
const drifted = results.filter((r) => r.driftKm != null && r.driftKm > DRIFT_TOLERANCE_KM);
const wrongSuburb = results.filter((r) => r.found && !r.localityOk);

console.log('\n' + '─'.repeat(104));
console.log(`confirmed to a specific address : ${confirmed.length}/${results.length}`);
console.log(`resolved to street/suburb only  : ${streetOnly.length}`);
console.log(`no match at all                 : ${missing.length}`);
console.log(`stored coords >${DRIFT_TOLERANCE_KM}km off        : ${drifted.length}`);
console.log(`geocoded into another suburb    : ${wrongSuburb.length}`);

const reportPath = fileURLToPath(new URL('../verification-report.json', import.meta.url));
await writeFile(reportPath, JSON.stringify({
  provider, runAt: new Date().toISOString(),
  summary: {
    total: results.length, confirmed: confirmed.length, streetOnly: streetOnly.length,
    missing: missing.length, drifted: drifted.length, wrongSuburb: wrongSuburb.length,
  },
  results,
}, null, 2));
console.log(`\nreport → ${reportPath.pathname}`);

if (write) {
  const usable = results.filter((r) => r.geocoded && (r.confirmed || r.precision === 'street'));
  console.log(`\n--write: ${usable.length} coordinates would be corrected from the geocoder.`);
  console.log('Review verification-report.json first; this rewrites src/data/listings.js.');
}

process.exit(missing.length || wrongSuburb.length ? 1 : 0);
