// Consignr location map for the photos catalog.
// Consignr's /items ignores a server-side location filter, so we fetch all ACTIVE
// items once and build { locationId -> [productId, ...] } client-callers can use to
// filter the existing /products-based catalog by physical location (e.g. events like
// "Summer League 2K26"). Read-only. See CLAUDE.md.
//
// Actions:
//   ?action=locations  -> [{id, name, storeLocation}]                (fast, no item scan)
//   ?action=map (default) -> { locations:[{id,name,count}], productIdsByLocation:{...}, scanned_items, pages, capped }

const CONSIGNR_BASE_URL = 'https://api.consignr.app/v1/api';
const PAGE_LIMIT = 100;   // Consignr max items per page
const MAX_PAGES = 60;     // safety cap (6000 items) to stay under Netlify's 26s timeout

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders(apiKey) {
  return { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } };
}

async function fetchLocations(apiKey) {
  const res = await fetchWithTimeout(`${CONSIGNR_BASE_URL}/locations`, authHeaders(apiKey), 10000);
  if (!res.ok) throw new Error(`Consignr /locations returned ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : (data.locations || data.data || []);
  return arr.map((l) => ({
    id: l.id,
    name: l.location || l.name || l.id,
    storeLocation: (l.storeLocation && l.storeLocation.name) || null
  }));
}

// Scan all ACTIVE items once; group productIds by their location id.
async function buildLocationMap(apiKey) {
  const productIdsByLocation = {}; // locationId -> Set(productId)
  let scanned = 0;
  let page = 1;
  let capped = false;

  while (page <= MAX_PAGES) {
    const url = `${CONSIGNR_BASE_URL}/items?status=ACTIVE&limit=${PAGE_LIMIT}&page=${page}`;
    const res = await fetchWithTimeout(url, authHeaders(apiKey), 10000);
    if (res.status === 429) { await sleep(1500); continue; } // rate-limited: back off, retry same page
    if (!res.ok) throw new Error(`Consignr /items returned ${res.status} (page ${page})`);

    const data = await res.json();
    const arr = Array.isArray(data) ? data : (data.items || data.data || []);
    for (const it of arr) {
      scanned++;
      const locId = (it.location && it.location.id) || it.locationId || null;
      const pid = it.productId || (it.product && it.product.id) || null;
      if (!locId || !pid) continue;
      if (!productIdsByLocation[locId]) productIdsByLocation[locId] = new Set();
      productIdsByLocation[locId].add(pid);
    }

    if (arr.length < PAGE_LIMIT) break; // short page => last page
    page++;
    if (page > MAX_PAGES) { capped = true; break; }
    await sleep(120); // gentle pacing to avoid 429s
  }

  // Serialize Sets -> arrays
  const out = {};
  for (const k of Object.keys(productIdsByLocation)) out[k] = [...productIdsByLocation[k]];
  return { productIdsByLocation: out, scanned_items: scanned, pages: page, capped };
}

exports.handler = async function (event) {
  const startTime = Date.now();
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const apiKey = process.env.CONSIGNR_API_KEY;
    if (!apiKey) throw new Error('Missing CONSIGNR_API_KEY in env');

    const action = ((event.queryStringParameters || {}).action) || 'map';
    const locations = await fetchLocations(apiKey);

    if (action === 'locations') {
      return {
        statusCode: 200,
        headers: { ...cors, 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify({ ok: true, action: 'locations', locations, elapsed_ms: Date.now() - startTime })
      };
    }

    // action === 'map'
    const { productIdsByLocation, scanned_items, pages, capped } = await buildLocationMap(apiKey);
    const locationsWithCounts = locations.map((l) => ({
      ...l,
      count: (productIdsByLocation[l.id] || []).length
    }));

    return {
      statusCode: 200,
      headers: { ...cors, 'Cache-Control': 'public, max-age=120' },
      body: JSON.stringify({
        ok: true,
        action: 'map',
        locations: locationsWithCounts,
        productIdsByLocation,
        scanned_items,
        pages,
        capped,
        elapsed_ms: Date.now() - startTime
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, source: 'consignr-locations', error: err.message, elapsed_ms: Date.now() - startTime })
    };
  }
};
