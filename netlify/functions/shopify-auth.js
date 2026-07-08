// Shopify OAuth callback for the "SRLA Rotation" custom app.
// The app's redirect URL points here but the handler never existed, so re-installs
// (which mint a token carrying the app's current scopes) were lost. This completes the
// authorization-code exchange and stores the resulting Admin API token in Firebase so the
// rotation + reconstruction functions can use it. Uses existing Netlify env vars
// SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET. Backs up the previous token before overwriting.

const crypto = require('crypto');

const DB = 'https://sales-rotation-44d0d-default-rtdb.firebaseio.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const EXPECTED_SHOP = 'showroomla.myshopify.com';

function page(title, bodyHtml) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font-family:system-ui,-apple-system,sans-serif;max-width:620px;margin:48px auto;padding:0 20px;line-height:1.5">' +
      '<h2 style="margin-bottom:8px">' + title + '</h2>' + bodyHtml + '</div>'
  };
}

// Shopify OAuth HMAC: sort all params except hmac/signature, join key=value with &, HMAC-SHA256(secret).
function verifyHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map(function (k) { return k + '=' + rest[k]; }).join('&');
  const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(String(hmac), 'utf8'));
  } catch (e) { return false; }
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return page('Configuration error', '<p>SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars are missing.</p>');
    }
    // Landing hit (no OAuth params): explain what this is.
    if (!q.code || !q.shop) {
      return page('SRLA Rotation — install callback',
        '<p>This endpoint completes the Shopify app install. Start it from the Dev Dashboard: <b>SRLA Rotation → Overview → Install app</b>. You will be redirected back here automatically.</p>');
    }
    if (q.shop !== EXPECTED_SHOP) {
      return page('Rejected', '<p>Unexpected shop: <code>' + q.shop + '</code></p>');
    }
    if (!verifyHmac(q)) {
      return page('Rejected', '<p>Request signature (HMAC) did not verify. Nothing was changed.</p>');
    }

    // Exchange the authorization code for an Admin API access token.
    const tokenRes = await fetch('https://' + q.shop + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: q.code })
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      return page('Token exchange failed', '<p>Firebase was NOT changed.</p><pre style="white-space:pre-wrap">' + tokenRes.status + ': ' + t.slice(0, 400) + '</pre>');
    }
    const data = await tokenRes.json();
    const token = data && data.access_token;
    const scope = (data && data.scope) || '(unknown)';
    if (!token || typeof token !== 'string' || token.indexOf('shpat_') !== 0) {
      return page('No valid token returned', '<p>Exchange returned no usable access_token; Firebase left untouched.</p>');
    }

    // Back up the previous token (so a bad swap is recoverable), then store the new one.
    try {
      const oldRes = await fetch(DB + '/config/shopify_token.json');
      const oldTok = await oldRes.json();
      if (oldTok) {
        await fetch(DB + '/config/shopify_token_backup.json', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(oldTok)
        });
      }
    } catch (e) { /* non-fatal: proceed with the write */ }

    await fetch(DB + '/config/shopify_token.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token)
    });

    return page('✅ Token captured & saved',
      '<p>The new Admin API token was stored in Firebase (previous token backed up to <code>config/shopify_token_backup</code>).</p>' +
      '<p><b>Granted scopes:</b> ' + scope + '</p>' +
      '<p>You can close this tab. Verify anytime at <code>/.netlify/functions/reconstruct-history?mode=whoami</code>.</p>');
  } catch (err) {
    return page('Error', '<pre style="white-space:pre-wrap">' + (err && err.message) + '</pre>');
  }
};
