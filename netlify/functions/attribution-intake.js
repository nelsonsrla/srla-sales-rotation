// Attribution intake — receives Shopify "staff attribution edit" emails via Power Automate and
// records each per-order attribution in Firebase so the Commission audit can check them.
// Regular (POS/staff) attributions live ONLY in these emails (not on the Shopify order), so this
// is the source of truth for who attributed which order.
//
// Power Automate should POST JSON on each matching email:
//   { "subject": "<email subject>", "body": "<email body text or html>" }
// (structured fields orderNum/rep/source/amount are also accepted if PA extracts them itself.)
//
// Stores: rotation/attributions/<orderNum> = { orderNum, rep, source, amount, editedAt, ts, subject }
// Latest email for an order wins (attribution can be edited multiple times).

const DB = 'https://sales-rotation-44d0d-default-rtdb.firebaseio.com';

function stripHtml(s) {
  return String(s || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function parseEmail(subject, body) {
  const subj = String(subject || '');
  const text = stripHtml(body);
  const hay = subj + ' \n ' + text;

  // order number
  let orderNum = null;
  const mOrder = hay.match(/order\s*#?\s*(\d{3,})/i);
  if (mOrder) orderNum = mOrder[1];

  // rep: "<Rep Name> edited the attributed staff"
  let rep = null;
  const mRep = text.match(/([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,3})\s+edited the attributed staff/);
  if (mRep) rep = mRep[1].trim();
  // fallback: the "Added\n<Rep> (+$..." block
  if (!rep) {
    const mAdd = text.match(/Added\s+([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,3})\s*\(\+\$/);
    if (mAdd) rep = mAdd[1].trim();
  }

  // source: "from <Source> on"
  let source = null;
  const mSrc = text.match(/from\s+(.+?)\s+on\s+/i);
  if (mSrc) source = mSrc[1].trim();

  // amount: "(+$850 to total sales)"
  let amount = null;
  const mAmt = text.match(/\+\s*\$([\d,]+(?:\.\d{1,2})?)\s+to total sales/i);
  if (mAmt) amount = parseFloat(mAmt[1].replace(/,/g, ''));

  return { orderNum, rep, source, amount };
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, info: 'POST attribution emails here: { subject, body }. Stored to rotation/attributions.' }) };
  }
  try {
    const rawBody = event.body || '';
    let payload = {};
    try { const p = JSON.parse(rawBody); if (p && typeof p === 'object') payload = p; } catch (e) { payload = {}; }
    // If it wasn't JSON with our fields, treat the raw POST body as the email text itself
    // (lets Power Automate just send the email Body as text/plain — no JSON escaping needed).
    if (!payload.subject && !payload.body && !payload.bodyPreview && !payload.bodyText && !payload.orderNum && rawBody) {
      payload = { subject: '', body: rawBody };
    }

    // Accept structured fields, else parse from subject/body.
    let orderNum = payload.orderNum ? String(payload.orderNum).replace('#', '').trim() : null;
    let rep = payload.rep || null;
    let source = payload.source || null;
    let amount = (payload.amount != null && payload.amount !== '') ? parseFloat(payload.amount) : null;

    if (!orderNum || !rep) {
      const parsed = parseEmail(payload.subject, payload.body || payload.bodyPreview || payload.bodyText);
      orderNum = orderNum || parsed.orderNum;
      rep = rep || parsed.rep;
      source = source || parsed.source;
      if (amount == null) amount = parsed.amount;
    }

    if (!orderNum) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Could not determine order number', received: { subject: payload.subject } }) };
    }

    const record = {
      orderNum: String(orderNum),
      rep: rep || null,
      source: source || null,
      amount: (amount != null && !isNaN(amount)) ? amount : null,
      editedAt: payload.editedAt || payload.receivedAt || null,
      ts: Date.now(),
      subject: payload.subject || null
    };

    // Latest attribution for an order wins.
    await fetch(DB + '/rotation/attributions/' + encodeURIComponent(String(orderNum)) + '.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record)
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, stored: record }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
