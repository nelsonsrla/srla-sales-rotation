// photos-shopify-fetch.js (v2 — public products.json, paginated)
const STOREFRONT_URL = 'https://showroomla.co';
const PAGE_SIZE = 250;

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

function mapPublicProduct(p) {
  const firstVariant = p.variants?.[0] || {};
  const allVariants = (p.variants || []).map(v => ({
    id: v.id,
    title: v.title,
    sku: v.sku || null,
    price: v.price,
    compare_at_price: v.compare_at_price,
    available: !!v.available,
    option1: v.option1 || null,
    option2: v.option2 || null,
    option3: v.option3 || null,
    featured_image: v.featured_image?.src || null
  }));

  const variantImageMap = {};
  for (const v of (p.variants || [])) {
    if (v.featured_image?.src) {
      if (!variantImageMap[v.id]) variantImageMap[v.id] = [];
      variantImageMap[v.id].push(v.featured_image.src);
    }
  }

  const sizes = [...new Set(allVariants.filter(v => v.available && v.option1).map(v => v.option1))];

  return {
    source: 'shopify',
    id: String(p.id),
    title: p.title,
    handle: p.handle,
    vendor: p.vendor || null,
    product_type: p.product_type || null,
    tags: Array.isArray(p.tags) ? p.tags : (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()).filter(Boolean) : []),
    published_at: p.published_at || null,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    price: firstVariant.price || null,
    compare_at_price: firstVariant.compare_at_price || null,
    on_sale: !!(firstVariant.compare_at_price && parseFloat(firstVariant.compare_at_price) > parseFloat(firstVariant.price || '0')),
    in_stock: allVariants.some(v => v.available),
    sizes: sizes,
    images: (p.images || []).map(img => ({
      src: img.src,
      alt: img.alt || null,
      position: img.position || null,
      width: img.width || null,
      height: img.height || null
    })),
    variants: allVariants,
    variant_image_map: variantImageMap,
    has_variant_specific_images: Object.keys(variantImageMap).length > 0
  };
}

exports.handler = async function (event, context) {
  const startTime = Date.now();
  const params = event.queryStringParameters || {};
  let page = parseInt(params.page, 10);

  if (!page || page < 1 || isNaN(page)) page = 1;
  if (page > 50) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, error: 'Page exceeds maximum of 50' })
    };
  }

  const url = `${STOREFRONT_URL}/products.json?limit=${PAGE_SIZE}&page=${page}`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SRLA-Photo-Downloader/1.0' }
    }, 10000);

    if (!response.ok) {
      const bodyPreview = await response.text();
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          ok: false, source: 'shopify', page: page,
          error: `Storefront returned ${response.status}`,
          body_preview: bodyPreview.substring(0, 300),
          hint: response.status === 404 ? 'Public products.json may be disabled' :
                response.status === 401 ? 'Store may be password-protected' : null
        })
      };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const bodyPreview = await response.text();
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          ok: false, source: 'shopify', page: page,
          error: 'Storefront returned non-JSON',
          content_type: contentType,
          body_preview: bodyPreview.substring(0, 300)
        })
      };
    }

    const data = await response.json();
    const rawProducts = Array.isArray(data.products) ? data.products : [];

    const products = [];
    for (const p of rawProducts) {
      try {
        if (!p || !p.id) continue;
        if (!Array.isArray(p.images) || p.images.length === 0) continue;
        products.push(mapPublicProduct(p));
      } catch (mapErr) {
        console.error('Map error on product', p?.id, mapErr.message);
      }
    }

    const done = rawProducts.length < PAGE_SIZE;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        ok: true, source: 'shopify', page: page, page_size: PAGE_SIZE,
        raw_count: rawProducts.length,
        product_count: products.length,
        skipped_no_images: rawProducts.length - products.length,
        done: done,
        next_page: done ? null : page + 1,
        elapsed_ms: Date.now() - startTime,
        products: products
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        ok: false, source: 'shopify', page: page,
        error: err.message,
        hint: err.name === 'AbortError' ? 'Request timed out after 10s' : null,
        elapsed_ms: Date.now() - startTime
      })
    };
  }
};
