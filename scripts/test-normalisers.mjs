// Offline tests for the Domain mappings. No credentials, no network.
//   node scripts/test-normalisers.mjs

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  normaliseListing, deriveTenure, normaliseSuburbPerformance,
  normaliseDemographics, parseSydneyDate, daysOnMarket,
} from '../src/server/domain-normalise.js';

const load = async (n) => JSON.parse(await readFile(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nSydney timezone handling');
test('AEST (June) parses at UTC+10', () => {
  assert.equal(parseSydneyDate('2026-06-14T09:30:00').toISOString(), '2026-06-13T23:30:00.000Z');
});
test('AEDT (January) parses at UTC+11', () => {
  assert.equal(parseSydneyDate('2026-01-14T09:30:00').toISOString(), '2026-01-13T22:30:00.000Z');
});
test('DST boundary: 4 Oct 2026 is AEDT, 3 Oct is AEST', () => {
  assert.equal(parseSydneyDate('2026-10-04T12:00:00').toISOString(), '2026-10-04T01:00:00.000Z');
  assert.equal(parseSydneyDate('2026-10-03T12:00:00').toISOString(), '2026-10-03T02:00:00.000Z');
});
test('already-zoned values pass through untouched', () => {
  assert.equal(parseSydneyDate('2026-06-14T09:30:00Z').toISOString(), '2026-06-14T09:30:00.000Z');
});
test('date-only values parse', () => {
  assert.equal(parseSydneyDate('2026-06-14').toISOString(), '2026-06-13T14:00:00.000Z');
});
test('naive UTC parsing would have shifted the day — it does not', () => {
  // 09:30 Sydney on the 14th is still the 13th in UTC; DOM must not gain a day.
  const now = Date.parse('2026-06-20T00:00:00Z');
  assert.equal(daysOnMarket('2026-06-14T09:30:00', now), 6);
});
test('null date yields null, not NaN', () => {
  assert.equal(daysOnMarket(null), null);
  assert.equal(parseSydneyDate(''), null);
});

console.log('\nListing normalisation');
const listing = normaliseListing(await load('domain-listing'), { now: Date.parse('2026-08-28T00:00:00Z') });
test('maps identity and address', () => {
  assert.equal(listing.id, 'D-2019283746');
  assert.equal(listing.suburbId, 'currimundi');
  assert.equal(listing.address, '31 Buderim Street, Currimundi');
});
test('carries coordinates for the radius filter', () => {
  assert.deepEqual(listing.coords, [-26.7731, 153.1267]);
});
test('extracts numeric price, keeps display string', () => {
  assert.equal(listing.priceGuide, 1100000);
  assert.equal(listing.priceDisplay, 'Offers over $1,100,000');
});
test('detects study and pool from features', () => {
  assert.equal(listing.study, true);
  assert.equal(listing.pool, true);
});
test('computes days on market from a Sydney-local date', () => {
  // Listed 14 Jul 09:30 Sydney = 13 Jul 23:30Z; to 28 Aug 00:00Z is 45 days.
  assert.equal(listing.dom, 45);
});
test('leaves council-sourced fields null rather than guessing', () => {
  for (const f of ['zoning', 'easement', 'slopePct', 'heritageOverlay']) {
    assert.equal(listing[f], null, `${f} should be null`);
  }
});

console.log('\nTenure derivation');
const tenure = deriveTenure(await load('domain-property'), { now: Date.parse('2026-08-28T00:00:00Z') });
test('reads the most recent sale without shifting the calendar date', () => {
  assert.equal(tenure.lastSold.date, '2012-05-11');
  assert.equal(tenure.lastSold.price, 498000);
});
test('current spell is measured to today and reported separately', () => {
  assert.equal(tenure.currentTenureYears, 14.3);
});
test('averages only completed ownership spells', () => {
  // 2012-2004 = 7.7yrs, 2004-1998 = 6.5yrs → mean 7.1
  assert.deepEqual(tenure.completedSpells, [7.7, 6.5]);
  assert.equal(tenure.averageTenureYears, 7.1);
});
test('property with no history returns nulls, not zeros', () => {
  const empty = deriveTenure({ saleHistory: [] });
  assert.equal(empty.averageTenureYears, null);
  assert.equal(empty.lastSold, null);
});

console.log('\nSuburb performance');
const perf = normaliseSuburbPerformance(await load('domain-suburb-performance'));
test('takes median price and DOM from the latest period', () => {
  assert.equal(perf.medianPrice, 1062000);
  assert.equal(perf.medianDom, 29);
});
test('compares against the earliest period for the trend', () => {
  assert.equal(perf.medianDomLastYear, 38);
  assert.equal(perf.priceChange90dPct, 7.8);
});
test('fields Domain does not supply stay null', () => {
  assert.equal(perf.activeListings, null);
  assert.equal(perf.withdrawalRatePct, null);
});

console.log('\nDemographics');
const demo = normaliseDemographics(await load('domain-demographics'));
test('owner-occupier = owned outright + mortgaged', () => {
  // (1180 + 1425) / 3295 = 79%
  assert.equal(demo.ownerOccupierPct, 79);
  assert.equal(demo.rentedPct, 21);
});
test('vacancy and owner age are not in this payload', () => {
  assert.equal(demo.vacancyRatePct, null);
  assert.equal(demo.ownersOver60Pct, null);
});

console.log('\nSearch result filtering');
const projectFixture = await load('domain-project');
test('Project entries are not listings', () => {
  const project = normaliseListing(projectFixture);
  assert.equal(project.suburbId, '');
  assert.equal(project.coords, null);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}\n`);
