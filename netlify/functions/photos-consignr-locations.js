// Consignr Location View for the photos catalog.
// Consignr's /items ignores a server-side location filter, so we fetch all ACTIVE
// items once and group them by physical location (e.g. events like "Summer League
// 2K26"). Each item embeds its product (with images), so we can return catalog-shaped
// product cards the photos UI renders with its existing grid + share sheet. Read-only.
//
// Actions:
//   ?action=locations                 -> [{id, name, storeLocation}]  (fast, no item scan)
//   ?action=products&locationId=XXX   -> catalog-shaped products physically at that location

const CONSIGNR_BASE_URL = 'https://api.consignr.app/v1/api';
const PAGE_LIMIT = 100;   // Consignr max items per page
const MAX_PAGES = 150;    // safety cap (15000 items); full scan of ~7.5k items runs in ~8s

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

// A value that looks like an apparel/footwear size (not a color or misc option).
const SIZE_RE = /^(\d+(\.\d+)?|\d+\s+\d+\/\d+|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|O\/?S)$/i;
// Pull a size-like value out of an item's option arrays, defensively.
function extractSize(item) {
  const names = Array.isArray(item.optionNames) ? item.optionNames : [];
  const values = Array.isArray(item.optionValues) ? item.optionValues : [];
  if (!values.length) return null;
  // Prefer an explicitly size-named option.
  for (let i = 0; i < names.length; i++) {
    if (/size/i.test(String(names[i] || '')) && values[i] != null) return String(values[i]);
  }
  // Otherwise accept the first value that is shaped like a size (skip colors, etc.).
  for (const v of values) {
    if (v != null && SIZE_RE.test(String(v).trim())) return String(v);
  }
  return null;
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  const seen = new Set();
  const out = [];
  for (const img of images) {
    const src = typeof img === 'string' ? img : (img && img.src);
    if (src && !seen.has(src)) { seen.add(src); out.push({ src, alt: null, variant_ids: [] }); }
  }
  return out;
}

// Scan all ACTIVE items; build catalog-shaped products for the requested location.
async function fetchLocationProducts(apiKey, locationId) {
  const byProduct = new Map(); // productId -> aggregated product
  let scanned = 0, matched = 0, skippedNoImages = 0, page = 1, capped = false;

  while (page <= MAX_PAGES) {
    const url = `${CONSIGNR_BASE_URL}/items?status=ACTIVE&limit=${PAGE_LIMIT}&page=${page}`;
    const res = await fetchWithTimeout(url, authHeaders(apiKey), 10000);
    if (res.status === 429) { await sleep(1500); continue; }
    if (!res.ok) throw new Error(`Consignr /items returned ${res.status} (page ${page})`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : (data.items || data.data || []);

    for (const item of arr) {
      scanned++;
      const locId = (item.location && item.location.id) || item.locationId || null;
      if (locId !== locationId) continue;
      const prod = item.product || {};
      const pid = item.productId || prod.id || null;
      if (!pid) continue;
      const images = normalizeImages(prod.images);
      if (images.length === 0) { skippedNoImages++; continue; } // no photo to send -> skip
      matched++;

      const priceNum = parseFloat(item.price);
      const size = extractSize(item);

      let entry = byProduct.get(pid);
      if (!entry) {
        entry = {
          source: 'consignr',
          id: String(pid),
          title: prod.title || null,
          vendor: prod.brand || null,
          product_type: prod.category || null,
          tags: [],
          status: 'ACTIVE',
          created_at: item.createdAt || null,
          updated_at: item.userUpdatedAt || item.acceptedAt || null,
          user_updated_at: item.userUpdatedAt || null,
          price: isNaN(priceNum) ? null : String(priceNum),
          compare_at_price: null,
          on_sale: false,
          in_stock: true,
          instore_only: false,
          location_id: locationId,
          item_count: 0,
          sizes: [],
          _sizeSet: new Set(),
          _priceMin: isNaN(priceNum) ? null : priceNum,
          colorway: prod.colorway || null,
          images,
          variants: [],
          variant_image_map: {},
          has_variant_specific_images: false
        };
        byProduct.set(pid, entry);
      }
      entry.item_count++;
      if (size && !entry._sizeSet.has(size)) { entry._sizeSet.add(size); entry.sizes.push(size); }
      if (!isNaN(priceNum) && (entry._priceMin == null || priceNum < entry._priceMin)) {
        entry._priceMin = priceNum;
        entry.price = String(priceNum);
      }
      // Merge any additional images this item's product carries.
      for (const im of images) {
        if (!entry.images.some((e) => e.src === im.src)) entry.images.push(im);
      }
    }

    if (arr.length < PAGE_LIMIT) break;
    page++;
    if (page > MAX_PAGES) { capped = true; break; }
  }

  const products = [];
  for (const entry of byProduct.values()) {
    delete entry._sizeSet;
    delete entry._priceMin;
    products.push(entry);
  }
  return { products, scanned_items: scanned, matched_items: matched, skipped_no_images: skippedNoImages, pages: page, capped };
}

exports.handler = async function (event) {
  const startTime = Date.now();
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const apiKey = process.env.CONSIGNR_API_KEY;
    if (!apiKey) throw new Error('Missing CONSIGNR_API_KEY in env');

    const params = event.queryStringParameters || {};
    const action = params.action || 'locations';

    if (action === 'locations') {
      const locations = await fetchLocations(apiKey);
      return {
        statusCode: 200,
        headers: { ...cors, 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify({ ok: true, action: 'locations', locations, elapsed_ms: Date.now() - startTime })
      };
    }

    if (action === 'products') {
      const locationId = params.locationId || params.location || '';
      if (!locationId) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'Missing locationId' }) };
      }
      const result = await fetchLocationProducts(apiKey, locationId);
      return {
        statusCode: 200,
        headers: { ...cors, 'Cache-Control': 'public, max-age=120' },
        body: JSON.stringify({
          ok: true,
          action: 'products',
          location_id: locationId,
          product_count: result.products.length,
          matched_items: result.matched_items,
          scanned_items: result.scanned_items,
          skipped_no_images: result.skipped_no_images,
          pages: result.pages,
          capped: result.capped,
          elapsed_ms: Date.now() - startTime,
          products: result.products
        })
      };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'Unknown action: ' + action }) };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, source: 'consignr-locations', error: err.message, elapsed_ms: Date.now() - startTime })
    };
  }
};
