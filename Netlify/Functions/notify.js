'use strict';
const crypto = require('crypto');
const https  = require('https');

const VAPID_PUB  = 'BG9ayPRzg_qaRlgCZApYNjl3imTR1cwejEGejKSzyZoWhgA8nHvbIr9Wb2gXwicAtm2qEzczJQmjF2zDbQ5Z4qM';
const VAPID_PRIV = 'TqmbDUUgJ2JbJ5kQSFvJBIxaH4Ckwm4K7vSXZVPUDSM';

/* ── base64url helpers ── */
function b64u(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  return Buffer.from((s + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function tb64u(b) {
  return Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/* ── HKDF-SHA256(salt, ikm, info, len) ── */
function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  let t = Buffer.alloc(0), okm = Buffer.alloc(0);
  for (let i = 1; okm.length < len; i++) {
    t = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([t, info, Buffer.from([i])]))
      .digest();
    okm = Buffer.concat([okm, t]);
  }
  return okm.slice(0, len);
}

/* ── 65-byte uncompressed EC point → JWK {x, y} ── */
function pointToXY(raw) {
  return { x: tb64u(raw.slice(1, 33)), y: tb64u(raw.slice(33, 65)) };
}

/* ── DER ECDSA signature → raw r||s (64 bytes) ── */
function derToRaw(der) {
  let i = 2; // skip SEQUENCE header (30 <len>)
  const rLen = der[i + 1];
  let r = der.slice(i + 2, i + 2 + rLen);
  i += 2 + rLen;
  const sLen = der[i + 1];
  let s = der.slice(i + 2, i + 2 + sLen);
  if (r[0] === 0x00) r = r.slice(1); // strip sign-extension byte
  if (s[0] === 0x00) s = s.slice(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

/* ── Build VAPID JWT ── */
function makeJWT(endpoint) {
  const origin = new URL(endpoint).origin;
  const hdr = tb64u(Buffer.from('{"typ":"JWT","alg":"ES256"}'));
  const pay = tb64u(Buffer.from(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: 'mailto:nelson@showroomla.co'
  })));
  const input = `${hdr}.${pay}`;

  const pubRaw = b64u(VAPID_PUB);
  const { x, y } = pointToXY(pubRaw);
  const privKey = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x, y, d: VAPID_PRIV },
    format: 'jwk'
  });

  const signer = crypto.createSign('SHA256');
  signer.update(input);
  const raw = derToRaw(signer.sign(privKey));
  return `${input}.${tb64u(raw)}`;
}

/* ── RFC 8291 message encryption ── */
function encryptBody(plaintext, p256dh, auth) {
  const recvPub = b64u(p256dh);
  const authBuf = b64u(auth);

  // Ephemeral sender key pair
  const senderKP = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki     = senderKP.publicKey.export({ type: 'spki', format: 'der' });
  const senderPub = spki.slice(-65); // 04 || x || y

  // Import recipient public key
  const { x, y } = pointToXY(recvPub);
  const recvKey  = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x, y },
    format: 'jwk'
  });

  // ECDH shared secret
  const dh = crypto.diffieHellman({ privateKey: senderKP.privateKey, publicKey: recvKey });

  // IKM = HKDF(salt=auth, ikm=dh, info="WebPush: info\0" || recvPub || senderPub, len=32)
  const ikm = hkdf(
    authBuf, dh,
    Buffer.concat([Buffer.from('WebPush: info\0'), recvPub, senderPub]),
    32
  );

  // Random 16-byte salt → derive CEK and nonce
  const salt  = crypto.randomBytes(16);
  const cek   = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // Encrypt: plaintext + 0x02 delimiter (single-record message)
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct     = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.update(Buffer.from([0x02])),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag(); // 16-byte GCM auth tag

  // Encrypted content: salt(16) | rs(4) | idLen(1) | senderPub(65) | ciphertext | tag(16)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([65]), senderPub, ct, tag]);
}

/* ── HTTP POST to push service ── */
function sendRequest(endpoint, authHeader, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization':    authHeader,
        'Content-Type':     'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length':   body.length,
        'TTL':              '86400',
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log('Push service response:', res.statusCode, data);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── Netlify Function handler ── */
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Check env vars first — give a clear error if missing
  if (!VAPID_PUB || !VAPID_PRIV) {
    console.error('Missing VAPID env vars');
    return { statusCode: 500, body: 'Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY environment variables. Add them in Netlify Site Configuration > Environment Variables, then redeploy.' };
  }

  try {
    const { subscription, title, body } = JSON.parse(event.body);
    const { endpoint, keys: { p256dh, auth } } = subscription;

    const jwt     = makeJWT(endpoint);
    const authHdr = `vapid t=${jwt},k=${VAPID_PUB}`;
    const payload = JSON.stringify({ title, body });
    const enc     = encryptBody(payload, p256dh, auth);
    const result  = await sendRequest(endpoint, authHdr, enc);
    const status  = result.status;
    const svcBody = result.body;

    if (status === 410 || status === 404) {
      return { statusCode: 410, body: 'Subscription expired' };
    }
    if (status >= 200 && status < 300) {
      return { statusCode: 200, body: 'OK' };
    }
    return { statusCode: 500, body: 'Push service ' + status + ': ' + svcBody };

  } catch (err) {
    console.error('notify error:', err);
    return { statusCode: 500, body: 'Function error: ' + err.message };
  }
};
