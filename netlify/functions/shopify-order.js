// production-v16
'use strict';

const DB       = 'https://sales-rotation-44d0d-default-rtdb.firebaseio.com';
const SITE_URL = 'https://srlasales.netlify.app';

// ================================================================
//  QUALIFYING CRITERIA
//    1. Online store / Shop app / Facebook / Instagram order
//    2. Payment is "paid" or "authorized" only
//    3. First or second order (orders_count 1-2)
//       - If missing: Shopify API lookup, then notified_customers fallback
//    4. No prior paid+fulfilled orders from non-online channels
//    5. $1,000+ in value OR 7+ items
//    6. High-value returning customer: 3+ orders but first order over $1k threshold
//    7. Order number not already notified
//    8. Customer not already notified
// ================================================================
const CRITERIA = {
  minOrderValue:      1000,
  minItems:           7,
  maxOrderCount:      2,
  highValueThreshold: 1000,
};

const ALLOWED_SOURCES  = ['web', 'facebook', 'instagram', 'shop_app', 'shop', '3890849', '580111', 'android', 'ios'];
const ONLINE_CHANNELS  = ['web', 'facebook', 'instagram', 'shop_app', 'shop', '3890849', '580111', 'android', 'ios'];

// ── Helpers ──────────────────────────────────────────
function toArr(val, len) {
  if (!val) return new Array(len).fill(null);
  if (Array.isArray(val)) return val.slice();
  var arr = new Array(len).fill(null);
  Object.keys(val).forEach(function(k) {
    var i = parseInt(k, 10);
    if (!isNaN(i) && i >= 0 && i < len) arr[i] = val[k];
  });
  return arr;
}

function getSubForRep(repName, repIndex, subsData) {
  if (!subsData) return null;
  if (!Array.isArray(subsData) && typeof subsData === 'object') {
    var keys = Object.keys(subsData);
    if (keys.length > 0 && isNaN(parseInt(keys[0]))) return subsData[repName] || null;
  }
  var arr = Array.isArray(subsData) ? subsData : toArr(subsData, repIndex + 1);
  return arr[repIndex] || null;
}

async function sendPush(sub, title, body) {
  if (!sub) return { ok: false, reason: 'no_subscription' };
  try {
    var res = await fetch(SITE_URL + '/.netlify/functions/notify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subscription: sub, title: title, body: body }),
    });
    if (res.status === 410 || res.status === 404) return { ok: false, expired: true };
    return { ok: res.ok };
  } catch (err) {
    console.error('Push failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

async function alreadyNotified(orderNum, customerKey) {
  try {
    var orderRes   = await fetch(DB + '/rotation/notified_orders/' + orderNum + '.json');
    var orderFired = await orderRes.json();
    if (orderFired === true) {
      console.log('Skipped -- order #' + orderNum + ' already notified');
      return true;
    }
    var custRes   = await fetch(DB + '/rotation/notified_customers/' + customerKey + '.json');
    var custFired = await custRes.json();
    if (custFired === true) {
      console.log('Skipped -- customer ' + customerKey + ' already notified');
      return true;
    }
    return false;
  } catch (err) {
    console.error('alreadyNotified check error:', err.message);
    return false;
  }
}

async function markAsNotified(orderNum, customerKey) {
  async function attempt() {
    await fetch(DB + '/rotation/notified_orders/'    + orderNum    + '.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'true' });
    await fetch(DB + '/rotation/notified_customers/' + customerKey + '.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'true' });
  }
  try {
    await attempt();
    console.log('Dedup lock written for order=' + orderNum);
    return true;
  } catch (err) {
    console.error('markAsNotified first attempt failed: ' + err.message + ' -- retrying');
    try {
      await new Promise(function(r) { setTimeout(r, 500); });
      await attempt();
      console.log('Dedup lock written on retry for order=' + orderNum);
      return true;
    } catch (err2) {
      console.error('markAsNotified retry failed: ' + err2.message);
      return false;
    }
  }
}

async function writeAttempt(data) {
  try {
    await fetch(DB + '/rotation/last_attempt.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) { console.error('last_attempt write failed:', err.message); }
  try {
    await fetch(DB + '/rotation/attempts/' + data.ts + '.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) { console.error('attempts log write failed:', err.message); }
}

async function getShopifyToken() {
  try {
    var res = await fetch(DB + '/config/shopify_token.json');
    var token = await res.json();
    return (token && typeof token === 'string') ? token : null;
  } catch (err) {
    console.error('getShopifyToken failed:', err.message);
    return null;
  }
}

// ── Main handler ─────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  var order;
  try { order = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON body' }; }

  var attemptTs  = Date.now();
  var orderNum   = String(order.order_number || 'unknown');
  var orderId    = String(order.id || '');
  var finStatus  = order.financial_status || 'unknown';
  var sourceName = order.source_name || 'unknown';

  // Log every attempt immediately
  await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'processing', reason: '' });

  // Filter 1: allowed channels only
  if (ALLOWED_SOURCES.indexOf(sourceName) === -1) {
    await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Not online store' });
    return { statusCode: 200, body: 'Skipped -- source: ' + sourceName };
  }

  // Filter 2: explicit skip statuses — no dedup write
  var skipStatuses = ['voided', 'refunded', 'partially_refunded', 'partially_paid'];
  if (skipStatuses.indexOf(finStatus) !== -1) {
    await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Voided/refunded/partial' });
    return { statusCode: 200, body: 'Skipped -- ' + finStatus };
  }

  // Filter 2b: paid or authorized only
  var isPaid = finStatus === 'paid' || finStatus === 'authorized';
  console.log('filter2: financial_status=' + finStatus + ' isPaid=' + isPaid);
  if (!isPaid) {
    await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Payment not paid/authorized' });
    return { statusCode: 200, body: 'Skipped -- financial: ' + finStatus };
  }

  // Filter 3: order count check
  var ordersCount   = (order.customer && order.customer.orders_count) || null;
  var customerId    = (order.customer && order.customer.id) ? String(order.customer.id) : null;
  var customerEmail = order.email || '';
  var apiLookupDone = false;
  var shopifyToken  = null;

  console.log('filter3: orders_count=' + ordersCount);

  if (ordersCount === null) {
    // orders_count missing — look up via Shopify API
    if (customerEmail || customerId) {
      try {
        shopifyToken = await getShopifyToken();
        if (shopifyToken) {
          var lookupUrl = customerId
            ? 'https://showroomla.myshopify.com/admin/api/2024-04/customers/' + customerId + '.json'
            : 'https://showroomla.myshopify.com/admin/api/2024-04/customers/search.json?query=email:' + encodeURIComponent(customerEmail) + '&limit=1';
          var apiRes = await fetch(lookupUrl, {
            headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
          });
          if (apiRes.ok) {
            var apiData  = await apiRes.json();
            var customer = apiData.customer || (apiData.customers && apiData.customers[0]);
            if (customer && customer.orders_count !== undefined) {
              ordersCount   = customer.orders_count;
              apiLookupDone = true;
              if (!customerId && customer.id) customerId = String(customer.id);
              console.log('filter3: API lookup ordersCount=' + ordersCount);
            }
            // Check prior order channels while we have the customer
            if (customer && customer.id) {
              try {
                var ordersUrl = 'https://showroomla.myshopify.com/admin/api/2024-04/customers/' + customer.id + '/orders.json?status=any&limit=50';
                var ordersRes = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
                if (ordersRes.ok) {
                  var ordersData  = await ordersRes.json();
                  var priorOrders = (ordersData.orders || []).filter(function(o) { return o.order_number !== parseInt(orderNum); });
                  var hasNonOnline = priorOrders.some(function(o) {
                    return o.financial_status === 'paid' && o.fulfillment_status === 'fulfilled' &&
                           ONLINE_CHANNELS.indexOf((o.source_name || '').toLowerCase()) === -1;
                  });
                  if (hasNonOnline) {
                    console.log('filter3: customer has prior non-online paid+fulfilled orders — skipping');
                    await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Customer has non-online prior orders' });
                    return { statusCode: 200, body: 'Skipped -- non-online prior orders' };
                  }
                }
              } catch (err) { console.error('filter3: prior orders check failed:', err.message); }
            }
          } else {
            console.error('filter3: Shopify API returned ' + apiRes.status);
          }
        }
      } catch (err) { console.error('filter3: Shopify API lookup failed:', err.message); }
    }
    if (!apiLookupDone) {
      // API failed — fall back to notified_customers check
      var emailKey = customerEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
      try {
        var custCheckRes = await fetch(DB + '/rotation/notified_customers/' + emailKey + '.json');
        var custCheckVal = await custCheckRes.json();
        if (custCheckVal === true) {
          await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Returning customer (prev notified)' });
          return { statusCode: 200, body: 'Skipped -- returning customer (prev notified)' };
        }
        console.log('filter3: API failed, not in notified_customers — allowing through');
      } catch (err) { console.error('filter3: fallback check failed:', err.message); }
    }
  }

  // Pre-compute values needed for remaining filters
  var lineItems    = order.line_items || [];
  var totalItems   = lineItems.reduce(function(s, i) { return s + (i.quantity || 0); }, 0);
  var totalValue   = parseFloat(order.total_price || '0');
  var firstName    = (order.shipping_address && order.shipping_address.first_name) || '';
  var lastName     = (order.shipping_address && order.shipping_address.last_name)  || '';
  var customerName = [firstName, lastName].filter(Boolean).join(' ') || order.email || 'unknown';
  var customerKey  = (order.email || customerName).toLowerCase().replace(/[^a-z0-9]/g, '_');

  // Filter 3b: prior order channel check for customers where ordersCount was in payload
  if (!apiLookupDone) {
    var priorCustId = customerId;
    var priorEmail  = customerEmail;
    if (priorCustId || priorEmail) {
      try {
        if (!shopifyToken) shopifyToken = await getShopifyToken();
        if (shopifyToken) {
          var lookupId2 = priorCustId;
          if (!lookupId2 && priorEmail) {
            var searchRes2 = await fetch('https://showroomla.myshopify.com/admin/api/2024-04/customers/search.json?query=email:' + encodeURIComponent(priorEmail) + '&limit=1', {
              headers: { 'X-Shopify-Access-Token': shopifyToken },
            });
            if (searchRes2.ok) {
              var searchData2 = await searchRes2.json();
              var found2 = searchData2.customers && searchData2.customers[0];
              if (found2) lookupId2 = String(found2.id);
            }
          }
          if (lookupId2) {
            var ordersRes2 = await fetch('https://showroomla.myshopify.com/admin/api/2024-04/customers/' + lookupId2 + '/orders.json?status=any&limit=50', {
              headers: { 'X-Shopify-Access-Token': shopifyToken },
            });
            if (ordersRes2.ok) {
              var ordersData2   = await ordersRes2.json();
              var priorOrders2  = (ordersData2.orders || []).filter(function(o) { return o.order_number !== parseInt(orderNum); });
              var hasNonOnline2 = priorOrders2.some(function(o) {
                return o.financial_status === 'paid' && o.fulfillment_status === 'fulfilled' &&
                       ONLINE_CHANNELS.indexOf((o.source_name || '').toLowerCase()) === -1;
              });
              if (hasNonOnline2) {
                console.log('filter3b: customer has prior non-online paid+fulfilled orders — skipping');
                await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Customer has non-online prior orders' });
                return { statusCode: 200, body: 'Skipped -- non-online prior orders' };
              }
            }
          }
        }
      } catch (err) { console.error('filter3b: prior orders check failed:', err.message); }
    }
  }

  // High-value returning customer check
  if (ordersCount !== null && ordersCount > CRITERIA.maxOrderCount) {
    var isHighValue = totalValue >= CRITERIA.highValueThreshold;
    if (!isHighValue) {
      await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Returning customer ' + ordersCount + ' orders' });
      return { statusCode: 200, body: 'Skipped -- orders_count: ' + ordersCount };
    }
    var hvKey = customerKey;
    var isFirstHighValue = false;
    try {
      var hvRes    = await fetch(DB + '/rotation/notified_customers_highvalue/' + hvKey + '.json');
      var hvStored = await hvRes.json();
      if (hvStored === null || hvStored === undefined || hvStored === 'null') {
        isFirstHighValue = true;
        console.log('filter3: returning customer first high-value order $' + totalValue);
      } else {
        var storedVal = parseFloat(hvStored) || 0;
        if (totalValue > storedVal) {
          isFirstHighValue = true;
          console.log('filter3: returning customer new high-value record $' + totalValue + ' (prev $' + storedVal + ')');
        } else {
          console.log('filter3: returning customer high-value already notified at $' + storedVal);
        }
      }
    } catch (err) {
      console.error('filter3: high-value check failed:', err.message);
      await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'High value check failed' });
      return { statusCode: 200, body: 'Skipped -- high value check failed' };
    }
    if (!isFirstHighValue) {
      await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Returning customer ' + ordersCount + ' orders' });
      return { statusCode: 200, body: 'Skipped -- returning customer not new high value' };
    }
  }

  // Filter 4: $1,000+ OR 7+ items
  var meetsValue = totalValue >= CRITERIA.minOrderValue;
  var meetsItems = totalItems >= CRITERIA.minItems;
  if (!meetsValue && !meetsItems) {
    await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Under threshold $' + totalValue + ' / ' + totalItems + ' items' });
    return { statusCode: 200, body: 'Skipped -- $' + totalValue + ' / ' + totalItems + ' items' };
  }

  // Filter 5 & 6: dedup
  var skip = await alreadyNotified(orderNum, customerKey);
  console.log('alreadyNotified=' + skip + ' order=' + orderNum);
  if (skip) {
    await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Skipped', reason: 'Already notified' });
    return { statusCode: 200, body: 'Skipped -- already notified' };
  }

  // Build trigger label
  var triggerParts = [];
  if (ordersCount !== null && ordersCount > CRITERIA.maxOrderCount) triggerParts.push('High value returning customer');
  if (ordersCount === 1) triggerParts.push('First-time customer');
  if (ordersCount === 2) triggerParts.push('Second order');
  if (meetsValue) triggerParts.push('$' + totalValue.toLocaleString() + ' order');
  if (meetsItems) triggerParts.push(totalItems + ' items');
  var triggerLabel = triggerParts.join(' | ');
  console.log('Order #' + orderNum + ' qualifies: ' + triggerLabel);

  await writeAttempt({ ts: attemptTs, order: orderNum, orderId: orderId, financial_status: finStatus, source: sourceName, result: 'Qualified', reason: triggerLabel });

  // Read rotation from Firebase
  var raw;
  try {
    var dbRes = await fetch(DB + '/rotation.json');
    raw = await dbRes.json();
  } catch (err) { return { statusCode: 500, body: 'Firebase read error: ' + err.message }; }
  if (!raw || !raw.reps) return { statusCode: 200, body: 'No rotation state in Firebase' };

  var repCount  = Array.isArray(raw.reps) ? raw.reps.length : Object.keys(raw.reps).length;
  if (repCount === 0) return { statusCode: 200, body: 'No reps in rotation' };

  var reps      = toArr(raw.reps, repCount);
  var storeIdx  = typeof raw.store === 'number' ? raw.store % repCount : 0;
  var repName   = reps[storeIdx] || 'Your rep';
  var sub       = getSubForRep(repName, storeIdx, raw.subs);
  console.log('rep=' + repName + ' storeIdx=' + storeIdx + ' subFound=' + !!sub);

  // Build notification body
  var phone        = (order.shipping_address && order.shipping_address.phone) || order.phone || null;
  var email        = order.email || null;
  var formattedVal = totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var top3Items    = lineItems.slice(0, 3).map(function(item) {
    var variant = item.variant_title && item.variant_title !== 'Default Title' ? ' (' + item.variant_title + ')' : '';
    return item.name + variant + ' x' + item.quantity;
  });
  var overflow  = lineItems.length > 3 ? ' +' + (lineItems.length - 3) + ' more' : '';

  var bodyLines = [repName + ' -- new online order #' + orderNum, 'Trigger: ' + triggerLabel, 'Customer: ' + customerName];
  if (phone) bodyLines.push('Phone: ' + phone);
  if (email) bodyLines.push('Email: ' + email);
  bodyLines.push('Total: $' + formattedVal + '  |  ' + totalItems + ' item' + (totalItems !== 1 ? 's' : ''));
  if (top3Items.length) bodyLines.push('Items: ' + top3Items.join(', ') + overflow);

  // Claim order FIRST before sending push
  var claimed = await markAsNotified(orderNum, customerKey);
  if (!claimed) {
    console.error('Failed to write dedup lock -- aborting');
    return { statusCode: 500, body: 'Dedup lock failed' };
  }

  // Send notification
  var pushResult = await sendPush(sub, '🛍New Lead — You\'re Up, ' + repName + '!', bodyLines.join('\n'));
  console.log('pushResult ok=' + pushResult.ok + ' reason=' + (pushResult.reason || 'none'));

  // Write last_run
  try {
    await fetch(DB + '/rotation/last_run.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: Date.now(), rep: repName, subFound: !!sub, pushOk: pushResult.ok, pushReason: pushResult.reason || 'none', order: orderNum, customer: customerName }),
    });
  } catch (err) { console.error('last_run write failed:', err.message); }

  // Handle expired subscription
  if (pushResult.expired) {
    try {
      var patch = {};
      if (raw.subs && !Array.isArray(raw.subs) && typeof raw.subs === 'object') {
        var subKeys = Object.keys(raw.subs);
        if (subKeys.length > 0 && isNaN(parseInt(subKeys[0]))) {
          patch['subs/' + repName] = null;
        } else {
          var arr = toArr(raw.subs, repCount).slice();
          arr[storeIdx] = null;
          patch['subs'] = arr;
        }
      }
      if (Object.keys(patch).length) {
        await fetch(DB + '/rotation.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      }
    } catch (err) { console.error('Expired sub cleanup failed:', err.message); }
  }

  // Fresh re-read of store before advancing
  var freshStore = storeIdx;
  try {
    var freshRes = await fetch(DB + '/rotation/store.json');
    var freshVal = await freshRes.json();
    if (typeof freshVal === 'number') freshStore = freshVal;
  } catch (err) { console.error('Fresh store read failed:', err.message); }
  var freshNextIdx = (freshStore + 1) % repCount;
  console.log('Advancing rotation: ' + freshStore + ' -> ' + freshNextIdx);

  // Write high-value record if applicable
  if (ordersCount !== null && ordersCount > CRITERIA.maxOrderCount) {
    try {
      await fetch(DB + '/rotation/notified_customers_highvalue/' + customerKey + '.json', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(totalValue),
      });
      console.log('High value record written for ' + customerKey + ' at $' + totalValue);
    } catch (err) { console.error('High value write failed:', err.message); }
  }

  // Write history independently
  try {
    var historyEntry = { type: 'shopify', rep: repName, customer: customerName, email: email || '', phone: phone || '', amount: '$' + formattedVal, items: top3Items.slice(0, 2).join(', ') + overflow, orderNum: '#' + orderNum, orderId: orderId, trigger: triggerLabel, ts: Date.now() };
    await fetch(DB + '/rotation/history/' + Date.now() + '.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(historyEntry) });
    console.log('History written for order=' + orderNum);
  } catch (err) { console.error('History write failed:', err.message); }

  // Advance rotation independently
  try {
    await fetch(DB + '/rotation/store.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(freshNextIdx) });
    console.log('Rotation advanced to ' + freshNextIdx);
  } catch (err) { console.error('Rotation advance failed:', err.message); }

  return {
    statusCode: 200,
    body: JSON.stringify({ rep: repName, order: orderNum, trigger: triggerLabel, subFound: !!sub, pushOk: pushResult.ok, pushReason: pushResult.reason || 'none', historyDone: true }),
  };
};
