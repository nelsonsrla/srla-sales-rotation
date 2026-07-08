// History reconstruction helper (recovers the deleted rotation/history log from Shopify).
// Read the deleted history was NOT stored server-side; we rebuild each entry from the Shopify
// order behind every rotation/notified_orders number. This file starts READ-ONLY (inspect mode)
// so we can see how reps are tagged before writing anything back to Firebase.
//
// Modes:
//   ?mode=inspect&order=<num>   -> READ-ONLY: raw fields (tags/note/note_attributes/customer/...) for one order
//
// (A guarded write/run mode will be added only after the rep-tag format is confirmed and Nelson approves.)

const DB = 'https://sales-rotation-44d0d-default-rtdb.firebaseio.com';
const SHOP = 'https://showroomla.myshopify.com/admin/api/2024-04';

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function getShopifyToken() {
  const res = await fetchWithTimeout(DB + '/config/shopify_token.json', {}, 8000);
  const token = await res.json();
  return (token && typeof token === 'string') ? token : null;
}

async function fetchOrderByNumber(token, num) {
  const url = `${SHOP}/orders.json?name=${encodeURIComponent(num)}&status=any&limit=5`;
  const res = await fetchWithTimeout(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }, 10000);
  if (!res.ok) throw new Error(`Shopify ${res.status} for order ${num}`);
  const data = await res.json();
  const orders = Array.isArray(data.orders) ? data.orders : [];
  // Prefer an exact order_number match (name query can be fuzzy).
  return orders.find(o => String(o.order_number) === String(num) || String(o.name).replace(/^#/, '') === String(num)) || orders[0] || null;
}

exports.handler = async function (event) {
  const startTime = Date.now();
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const params = event.queryStringParameters || {};
    const mode = params.mode || 'inspect';
    const token = await getShopifyToken();
    if (!token) throw new Error('No Shopify token in Firebase config');

    if (mode === 'probe') {
      const endpoints = [
        `${SHOP}/orders.json?limit=1&status=any`,
        `${SHOP}/orders.json?limit=1&status=any&name=16144`,
        `${SHOP}/orders/count.json`,
        `${SHOP}/shop.json`
      ];
      const out = [];
      for (const url of endpoints) {
        try {
          const r = await fetchWithTimeout(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }, 10000);
          const body = await r.text();
          out.push({ url: url.replace(SHOP, ''), status: r.status, ok: r.ok, body_preview: body.slice(0, 160) });
        } catch (e) { out.push({ url: url.replace(SHOP, ''), error: e.message }); }
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, mode: 'probe', endpoints: out }, null, 2) };
    }

    if (mode === 'inspect') {
      const nums = (params.order || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!nums.length) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'Pass ?order=NUM or comma list' }) };
      const results = [];
      for (const num of nums) {
        try {
          const o = await fetchOrderByNumber(token, num);
          results.push(o ? {
            order_number: o.order_number,
            name: o.name,
            id: o.id,
            created_at: o.created_at,
            financial_status: o.financial_status,
            fulfillment_status: o.fulfillment_status,
            source_name: o.source_name,
            total_price: o.total_price,
            customer: o.customer ? ((o.customer.first_name || '') + ' ' + (o.customer.last_name || '')).trim() : null,
            tags: o.tags,
            note: o.note,
            note_attributes: o.note_attributes,
            line_item_count: Array.isArray(o.line_items) ? o.line_items.length : 0,
            line_items_sample: (o.line_items || []).slice(0, 3).map(li => li.title)
          } : { order: num, found: false });
        } catch (e) { results.push({ order: num, error: e.message }); }
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, mode: 'inspect', results, elapsed_ms: Date.now() - startTime }, null, 2) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'Unknown mode: ' + mode }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message, elapsed_ms: Date.now() - startTime }) };
  }
};
