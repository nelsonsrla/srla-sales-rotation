const ALLOWED_HOSTNAMES = [
  'cdn.shopify.com',
  'cdn.shopifycdn.net',
  'storage.googleapis.com',
  'consignr-images.s3.amazonaws.com',
  'consignr.app',
  'images.consignr.app'
];

function isAllowedUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_HOSTNAMES.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
  } catch {
    return false;
  }
}

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

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }
  const params = event.queryStringParameters || {};
  const imageUrl = params.url;
  if (!imageUrl) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Missing url parameter' })
    };
  }
  if (!isAllowedUrl(imageUrl)) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'URL not on allowlist' })
    };
  }
  try {
    const response = await fetchWithTimeout(imageUrl, {}, 15000);
    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: `Upstream returned ${response.status}` })
      };
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (!contentType.startsWith('image/')) {
      return {
        statusCode: 415,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Upstream did not return an image' })
      };
    }
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET'
      },
      body: base64,
      isBase64Encoded: true
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
