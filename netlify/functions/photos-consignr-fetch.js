const CONSIGNR_BASE_URL = 'https://api.consignr.app/v1/api';
const MAX_PAGES = 20;

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function mapConsignrProduct(p) {
  const tags = (p.tags || []).map(t => t?.tag?.value || t?.value || t).filter(Boolean);
  return {
    source: 'consignr',
    id: String(p.id),
    title: p.title,
    vendor: p.brand || null,
    product_type: p.category || null,
    tags: tags,
    status: p.status,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    user_updated_at: p.userUpdatedAt || null,
    price: null,
    compare_at_price: null,
    on_sale: false,
    in_stock: p.status === 'ACTIVE',
    instore_only: !!p.instoreOnly,
    sizes: [],
    colorway: p.colorway || null,
    images: (p.images || []).map(src => ({ src: src, alt: null, variant_ids: [] })),
    variants: [],
    variant_image_map: {},
    has_variant_specific_images: false
  };
}

async function fetchAllConsignrProducts(apiKey) {
  const products = [];
  let page = 1;
  let totalPages = 0;
  let pageSize = 0;
  while (page <= MAX_PAGES) {
    const url = `${CONSIGNR_BASE_URL}/products?instoreOnly=true&page=${page}`;
    const response = await fetchWithTimeout(url, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
    }, 10000);
    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Consignr fetch failed (page ${page}). Status ${response.status}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    const pageProducts = Array.isArray(data) ? data : (data.products || data.data || data.items || []);
    if (page === 1) pageSize = pageProducts.length;
    for (const p of pageProducts) products.push(mapConsignrProduct(p));
    totalPages = page;
    if (pageProducts.length === 0 || (page > 1 && pageProducts.length < pageSize)) break;
    page++;
    await new Promise(r => setTimeout(r, 200));
  }
  return { products, pages_fetched: totalPages, hit_page_limit: totalPages >= MAX_PAGES };
}

exports.handler = async function (event, context) {
  const startTime = Date.now();
  try {
    const apiKey = process.env.CONSIGNR_API_KEY;
    if (!apiKey) throw new Error('Missing CONSIGNR_API_KEY in env');

    // TEMP DEBUG PROBE — remove after inspecting Consignr raw schema (?debug=stores)
    if (((event.queryStringParameters || {}).debug) === 'stores') {
      const storeCounts = {}; let withTags = 0; let withCustom = 0; let total = 0;
      let dbgPage = 1, dbgSize = 0;
      while (dbgPage <= MAX_PAGES) {
        const dbgUrl = `${CONSIGNR_BASE_URL}/products?instoreOnly=true&page=${dbgPage}`;
        const dbgRes = await fetchWithTimeout(dbgUrl, { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } }, 10000);
        if (dbgRes.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
        if (!dbgRes.ok) break;
        const dbgData = await dbgRes.json();
        const arr = Array.isArray(dbgData) ? dbgData : (dbgData.products || dbgData.data || dbgData.items || []);
        if (dbgPage === 1) dbgSize = arr.length;
        for (const p of arr) {
          total++;
          const sid = p.storeId || 'NONE';
          storeCounts[sid] = (storeCounts[sid] || 0) + 1;
          if (Array.isArray(p.tags) && p.tags.length) withTags++;
          if (Array.isArray(p.customFields) && p.customFields.length) withCustom++;
        }
        if (arr.length === 0 || (dbgPage > 1 && arr.length < dbgSize)) break;
        dbgPage++; await new Promise(r => setTimeout(r, 150));
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true, debug: true, total_items: total, distinct_stores: Object.keys(storeCounts).length, store_counts: storeCounts, items_with_tags: withTags, items_with_customFields: withCustom }, null, 2)
      };
    }

    const result = await fetchAllConsignrProducts(apiKey);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        ok: true,
        source: 'consignr',
        product_count: result.products.length,
        pages_fetched: result.pages_fetched,
        hit_page_limit: result.hit_page_limit,
        elapsed_ms: Date.now() - startTime,
        products: result.products
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, source: 'consignr', error: err.message, elapsed_ms: Date.now() - startTime })
    };
  }
};
