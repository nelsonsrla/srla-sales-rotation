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

    if (mode === 'run') {
      // Rebuild rotation/history from Shopify for every order in notified_orders.
      // Reps are backtracked from the round-robin (reps[store%n], +1 each notify), anchored to the
      // KNOWN pair #16144 -> Lillie (from last_run) rather than the live-moving store position.
      // commit=1 writes to Firebase (history only — NEVER notifies). Batched via start/count.
      const commit = params.commit === '1';
      const start = parseInt(params.start || '0', 10) || 0;
      const count = Math.min(parseInt(params.count || '40', 10) || 40, 60);
      const REPS = ['Leanna', 'Lillie', 'Yoni'];
      const n = REPS.length;

      const noRes = await fetchWithTimeout(DB + '/rotation/notified_orders.json?shallow=true', {}, 10000);
      const noObj = (await noRes.json()) || {};
      const nums = Object.keys(noObj).filter(function (k) { return /^\d+$/.test(k); }).map(Number).sort(function (a, b) { return a - b; });
      const N = nums.length;
      const anchorIdx = N - 1;      // last (highest #) = #16144
      const anchorRep = 1;          // = Lillie (reps[1]), known from last_run
      function repFor(i) { return REPS[(((anchorRep + (i - anchorIdx)) % n) + n) % n]; }

      const batch = nums.slice(start, start + count);
      const entries = [];
      let written = 0, notFound = 0, errors = 0;
      for (let j = 0; j < batch.length; j++) {
        const i = start + j;
        const num = batch[j];
        const rep = repFor(i);
        try {
          const o = await fetchOrderByNumber(token, num);
          if (!o) { notFound++; entries.push({ order: num, rep: rep, found: false }); continue; }
          const ts = new Date(o.created_at).getTime();
          const amtNum = parseFloat(o.total_price) || 0;
          const amount = '$' + amtNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const titles = (o.line_items || []).map(function (li) { return li.title; }).filter(Boolean);
          const items = titles.slice(0, 2).join(', ') + (titles.length > 2 ? ' +' + (titles.length - 2) + ' more' : '');
          const customer = o.customer ? ((o.customer.first_name || '') + ' ' + (o.customer.last_name || '')).trim() : 'Unknown';
          const entry = { type: 'shopify', rep: rep, customer: customer, amount: amount, items: items, orderNum: '#' + num, orderId: String(o.id), trigger: 'reconstructed', ts: ts };
          entries.push(entry);
          if (commit) {
            // Key by created_at ms => deterministic & idempotent (re-runs overwrite, never duplicate).
            await fetchWithTimeout(DB + '/rotation/history/' + ts + '.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }, 10000);
            written++;
          }
        } catch (e) { errors++; entries.push({ order: num, rep: rep, error: e.message }); }
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({
        ok: true, mode: 'run', commit: commit, total_orders: N, start: start, processed: batch.length,
        next_start: (start + count) < N ? (start + count) : null,
        written: written, not_found: notFound, errors: errors, entries: entries
      }, null, 2) };
    }

    if (mode === 'envcheck') {
      // Non-secret: confirm which app the Netlify OAuth env vars point at. Never echoes the secret value.
      const cid = process.env.SHOPIFY_CLIENT_ID || null;
      return { statusCode: 200, headers: cors, body: JSON.stringify({
        ok: true, mode: 'envcheck',
        SHOPIFY_CLIENT_ID: cid,
        matches_SRLA_Rotation: cid === 'a5c1040c8274a0fd62ed06c10af3ce96',
        SHOPIFY_CLIENT_SECRET_present: !!process.env.SHOPIFY_CLIENT_SECRET,
        SHOPIFY_PHOTO_CLIENT_ID: process.env.SHOPIFY_PHOTO_CLIENT_ID || null
      }, null, 2) };
    }

    if (mode === 'whoami') {
      // Identify which Shopify app this token belongs to + its scopes.
      const gql = { query: '{ currentAppInstallation { app { title } accessScopes { handle } } }' };
      const r = await fetchWithTimeout(`${SHOP}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(gql)
      }, 10000);
      const body = await r.text();
      let parsed = null; try { parsed = JSON.parse(body); } catch (e) {}
      const inst = parsed && parsed.data && parsed.data.currentAppInstallation;
      return { statusCode: 200, headers: cors, body: JSON.stringify({
        ok: true, mode: 'whoami', status: r.status,
        app_title: inst && inst.app ? inst.app.title : null,
        scopes: inst && inst.accessScopes ? inst.accessScopes.map(s => s.handle) : null,
        raw: parsed ? undefined : body.slice(0, 300)
      }, null, 2) };
    }

    if (mode === 'probe') {
      const endpoints = [
        `${SHOP}/oauth/access_scopes.json`,
        `${SHOP}/orders.json?limit=1&status=any`,
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
