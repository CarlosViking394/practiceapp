// Zero-dependency static server. ES modules need a real HTTP origin, so the
// app will not run from file:// — use this instead.
//
//   node server.js [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAddress, nearbyAmenities, travelTimes, hasKey } from './src/server/google.js';
import { searchResidential, getSuburbPerformance, hasCredentials } from './src/server/domain.js';
import { normaliseListing, normaliseSuburbPerformance } from './src/server/domain-normalise.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const json = (res, code, body) =>
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));

/**
 * Google-backed endpoints. These live server-side so GOOGLE_MAPS_API_KEY is
 * never shipped to the browser. Each returns 503 rather than failing obscurely
 * when no key is configured, so the front end can fall back to seed data.
 */
async function handleApi(url, res) {
  const route = url.pathname.replace(/^\/api\//, '');

  if (route === 'status') {
    return json(res, 200, {
      google: hasKey() ? 'configured' : 'no-key',
      domain: hasCredentials() ? 'configured' : 'no-credentials',
      mode: hasKey() || hasCredentials() ? 'live' : 'seed',
    });
  }

  // Domain-backed routes, for querying without a full re-sync.
  if (route === 'listings' || route === 'suburb-performance') {
    if (!hasCredentials()) {
      return json(res, 503, { error: 'DOMAIN_CLIENT_ID and DOMAIN_CLIENT_SECRET are not set. See .env.example' });
    }
    try {
      const state = url.searchParams.get('state');
      const suburb = url.searchParams.get('suburb');
      const postcode = url.searchParams.get('postcode') ?? '';
      if (!state || !suburb) return json(res, 400, { error: 'state and suburb query parameters are required' });

      if (route === 'listings') {
        const raw = await searchResidential({
          state, suburb, postcode,
          minBedrooms: Number(url.searchParams.get('minBedrooms') ?? 4),
          maxResults: Number(url.searchParams.get('limit') ?? 50),
        });
        return json(res, 200, raw.map((r) => normaliseListing(r)).filter(Boolean));
      }
      return json(res, 200, normaliseSuburbPerformance(
        await getSuburbPerformance({ state, suburb, postcode, bedrooms: Number(url.searchParams.get('bedrooms') ?? 4) }),
      ));
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  if (!hasKey()) {
    return json(res, 503, { error: 'GOOGLE_MAPS_API_KEY is not set. Start with: node --env-file=.env server.js' });
  }

  try {
    if (route === 'validate-address') {
      const address = url.searchParams.get('address');
      if (!address) return json(res, 400, { error: 'address query parameter is required' });
      return json(res, 200, await validateAddress(address));
    }
    if (route === 'amenities') {
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const radius = Number(url.searchParams.get('radius') ?? 2000);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return json(res, 400, { error: 'lat and lng query parameters are required' });
      }
      return json(res, 200, await nearbyAmenities([lat, lng], radius));
    }
    if (route === 'travel-time') {
      const from = (url.searchParams.get('from') ?? '').split(',').map(Number);
      const to = (url.searchParams.get('to') ?? '').split(';').map((p) => p.split(',').map(Number));
      const mode = url.searchParams.get('mode') ?? 'DRIVE';
      if (from.length !== 2 || !to.length) return json(res, 400, { error: 'from=lat,lng and to=lat,lng;lat,lng are required' });
      return json(res, 200, await travelTimes(from, to, mode));
    }
  } catch (err) {
    // Surface the upstream reason (quota, billing, invalid key) rather than a bare 500.
    return json(res, 502, { error: err.message });
  }
  return json(res, 404, { error: `Unknown API route: ${route}` });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) return handleApi(url, res);

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);

  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`Family Buyer Intel → http://localhost:${PORT}`));
