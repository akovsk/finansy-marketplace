// Extra marketplace data straight from WB and Ozon APIs -> market.json (runs in GitHub Actions, Node 20+).
// Each source is independent: a failing one is logged and skipped, the others still land in the file.
// Keys of per-product maps are "<store name>|<sku>" exactly like data.json (WB sku = nmId, Ozon sku = Ozon SKU).
import { writeFileSync, readFileSync } from 'node:fs';

const env = (k) => (process.env[k] || '').trim();
const STORES = [
  { id: 'wb1', name: 'ВБ Саковский', mp: 'WB', token: env('WB_SAKOVSKY_TOKEN') },
  { id: 'wb2', name: 'Дармил', mp: 'WB', token: env('WB_DARMIL_TOKEN') },
  { id: 'oz1', name: 'Озон Саковский', mp: 'Ozon', cid: env('OZON_SAKOVSKY_CLIENT_ID'), key: env('OZON_SAKOVSKY_API_KEY') },
  { id: 'oz2', name: 'Suaviss Озон', mp: 'Ozon', cid: env('OZON_SUAVISS_CLIENT_ID'), key: env('OZON_SUAVISS_API_KEY') },
];

const DAY = 864e5;
const mskNow = new Date(Date.now() + 3 * 3600e3);
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const TODAY = iso(mskNow);
const ago = (n) => iso(mskNow.getTime() - n * DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (x) => Math.round(+x || 0);
const log = (...a) => console.log(...a);

async function http(url, opt = {}, tries = 4) {
  for (let i = 1; ; i++) {
    const r = await fetch(url, opt);
    if (r.status === 429 && i < tries) { const w = 20000 * i; log('  429, wait', w / 1000, 's'); await sleep(w); continue; }
    if (r.status >= 500 && i < tries) { await sleep(5000 * i); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url.replace(/\?.*/, '') + ' ' + t.slice(0, 200));
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return t; }
  }
}
const wb = (st, url, body) => http(url, { method: body ? 'POST' : 'GET', headers: { Authorization: st.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const oz = (st, path, body) => http('https://api-seller.ozon.ru' + path, { method: 'POST', headers: { 'Client-Id': st.cid, 'Api-Key': st.key, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

const OUT = { generated: new Date().toISOString(), today: TODAY, status: {}, stocks: {}, funnel: {}, orders: {}, fin: {}, ads: [], reviews: {}, revStore: {}, prices: {} };
const status = (st, src, ok, info) => { (OUT.status[st.id] = OUT.status[st.id] || {})[src] = ok ? (info || 'ok') : 'ERR ' + String(info).slice(0, 160); log(st.id, src, ok ? 'ok' : 'ERR', String(info || '').slice(0, 300)); };
async function step(st, src, fn) { try { const info = await fn(); status(st, src, true, info); } catch (e) { status(st, src, false, e.message); } }
const K = (st, sku) => st.name + '|' + sku;
const addOrders = (st, day, n, sum, canc) => { const o = (OUT.orders[st.id] = OUT.orders[st.id] || {}); const d = (o[day] = o[day] || [0, 0, 0]); d[0] += n; d[1] += sum; d[2] += canc || 0; };

/* ------------------------------ Wildberries ------------------------------ */
async function wbStore(st) {
  // Stocks by product (statistics API; falls back to the analytics warehouse report)
  await step(st, 'stocks', async () => {
    let rows;
    try {
      rows = await wb(st, 'https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=2019-06-20');
    } catch (e) {
      log('  stocks fallback:', e.message.slice(0, 120));
      const t = await wb(st, 'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains?groupByNm=true');
      const id = t && t.data && t.data.taskId;
      for (let i = 0; i < 20; i++) {
        await sleep(6000);
        const s = await wb(st, 'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/' + id + '/status');
        if (s && s.data && s.data.status === 'done') break;
      }
      const d = await wb(st, 'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/' + id + '/download');
      rows = (d || []).map((x) => ({ nmId: x.nmId, quantity: (x.warehouses || []).filter((w) => !/В пути/i.test(w.warehouseName)).reduce((a, w) => a + (+w.quantity || 0), 0), inWayToClient: ((x.warehouses || []).find((w) => /до получателей/i.test(w.warehouseName)) || {}).quantity || 0, inWayFromClient: ((x.warehouses || []).find((w) => /возвраты/i.test(w.warehouseName)) || {}).quantity || 0, warehouseName: '' }));
    }
    const m = {};
    (rows || []).forEach((r) => { const k = K(st, r.nmId); const s = (m[k] = m[k] || { q: 0, toCl: 0, fromCl: 0, wh: 0 }); s.q += +r.quantity || 0; s.toCl += +r.inWayToClient || 0; s.fromCl += +r.inWayFromClient || 0; if (+r.quantity > 0) s.wh++; });
    Object.assign(OUT.stocks, m);
    return Object.keys(m).length + ' SKU';
  });
  // Orders for the last 30 days (by order date, cancellations separately)
  await step(st, 'orders', async () => {
    const rows = await wb(st, 'https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=' + ago(31) + '&flag=0');
    (rows || []).forEach((r) => { const d = String(r.date).slice(0, 10); if (d < ago(30)) return; addOrders(st, d, 1, +r.priceWithDisc || 0, r.isCancel ? 1 : 0); });
    return (rows || []).length + ' orders';
  });
  // Card funnel for the last 30 days (WB moved this method in 2026: v3 sales-funnel)
  await step(st, 'funnel', async () => {
    const URL3 = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';
    let n = 0, first = null;
    for (let off = 0; off < 20000; off += 1000) {
      const j = await wb(st, URL3, { selectedPeriod: { start: ago(30), end: ago(1) }, limit: 1000, offset: off });
      const list = (j && j.data && (j.data.products || j.data.cards || j.data.items)) || (j && (j.products || j.cards)) || [];
      if (!first) { first = list[0]; log('  funnel sample', JSON.stringify(first || j).slice(0, 900)); }
      list.forEach((c) => {
        const p = c.product || c;
        const nm = p.nmId || p.nmID || c.nmId || c.nmID;
        const s0 = (c.statistic || c.statistics || {});
        const s = s0.selected || s0.selectedPeriod || s0;
        const g = (...ks) => { for (const k of ks) if (s[k] != null) return +s[k]; return 0; };
        if (!nm) return;
        const f = { v: R(g('openCount', 'openCardCount')), c: R(g('cartCount', 'addToCartCount')), o: R(g('orderCount', 'ordersCount')), os: R(g('orderSum', 'ordersSumRub')), b: R(g('buyoutCount', 'buyoutsCount')), bp: g('buyoutPercent') };
        if (!f.v && !f.o) return;
        OUT.funnel[K(st, nm)] = f; n++;
      });
      if (list.length < 1000) break;
      await sleep(21000);
    }
    return n + ' cards';
  });
  // Weekly financial reports (realization): what WB actually transfers. Find the live path first.
  await step(st, 'fin', async () => {
    const CAND = ['https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod', 'https://finance-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod', 'https://finance-api.wildberries.ru/api/v1/supplier/reportDetailByPeriod', 'https://statistics-api.wildberries.ru/api/v1/supplier/reportDetailByPeriod', 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed'];
    let base = null;
    for (const u of CAND) {
      try { await wb(st, u + '?dateFrom=' + ago(14) + '&dateTo=' + TODAY + '&limit=1&rrdid=0'); base = u; break; } catch (e) { log('  fin probe', e.message.slice(0, 160)); if (!/404/.test(e.message)) { base = u; break; } }
    }
    if (!base) throw new Error('no live realization report path');
    await sleep(61000);
    let rrdid = 0, rows = [];
    for (let i = 0; i < 10; i++) {
      const j = await wb(st, base + '?dateFrom=' + ago(63) + '&dateTo=' + TODAY + '&limit=100000&rrdid=' + rrdid);
      if (!Array.isArray(j) || !j.length) break;
      rows = rows.concat(j);
      rrdid = j[j.length - 1].rrd_id;
      if (j.length < 100000) break;
      await sleep(61000);
    }
    const W = {};
    rows.forEach((r) => {
      const wk = String(r.date_from).slice(0, 10) + '_' + String(r.date_to).slice(0, 10);
      const w = (W[wk] = W[wk] || { from: String(r.date_from).slice(0, 10), to: String(r.date_to).slice(0, 10), sales: 0, forPay: 0, logistics: 0, storage: 0, penalty: 0, deduction: 0, acceptance: 0, add: 0, q: 0, ret: 0 });
      const sign = /Возврат/i.test(r.doc_type_name) ? -1 : 1;
      w.sales += sign * (+r.retail_amount || 0);
      w.forPay += sign * (+r.ppvz_for_pay || 0);
      if (/Продажа/i.test(r.doc_type_name)) w.q += +r.quantity || 0;
      if (/Возврат/i.test(r.doc_type_name)) w.ret += +r.quantity || 0;
      w.logistics += +r.delivery_rub || 0;
      w.storage += +r.storage_fee || 0;
      w.penalty += +r.penalty || 0;
      w.deduction += +r.deduction || 0;
      w.acceptance += +r.acceptance || 0;
      w.add += +r.additional_payment || 0;
    });
    OUT.fin[st.id] = Object.values(W).map((w) => { for (const k in w) if (typeof w[k] === 'number') w[k] = R(w[k]); w.payout = w.forPay - w.logistics - w.storage - w.penalty - w.deduction - w.acceptance + w.add; return w; }).sort((a, b) => (a.from < b.from ? -1 : 1));
    return rows.length + ' rows, ' + OUT.fin[st.id].length + ' weeks';
  });
  // Reviews: rating per product and fresh negatives
  await step(st, 'reviews', async () => {
    let all = [];
    for (const ans of [false, true]) {
      for (let skip = 0; skip < 20000; skip += 5000) {
        const j = await wb(st, 'https://feedbacks-api.wildberries.ru/api/v1/feedbacks?isAnswered=' + ans + '&take=5000&skip=' + skip + '&order=dateDesc');
        const f = (j && j.data && j.data.feedbacks) || [];
        all = all.concat(f.map((x) => ({ nm: x.productDetails && x.productDetails.nmId, r: +x.productValuation || 0, d: String(x.createdDate).slice(0, 10), t: [x.text, x.cons].filter(Boolean).join(' / ').slice(0, 220), a: !!(x.answer && x.answer.text) })));
        if (f.length < 5000 || (f.length && f[f.length - 1].createdDate.slice(0, 10) < ago(90))) break;
        await sleep(700);
      }
    }
    reviewsAgg(st, all);
    return all.length + ' reviews';
  });
  // Prices and seller discount
  await step(st, 'prices', async () => {
    let n = 0;
    for (let off = 0; off < 20000; off += 1000) {
      const j = await wb(st, 'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1000&offset=' + off);
      const g = (j && j.data && j.data.listGoods) || [];
      g.forEach((x) => { const s = (x.sizes || [])[0] || {}; OUT.prices[K(st, x.nmID)] = { p: R(s.price), pd: R(s.discountedPrice), disc: +x.discount || 0 }; n++; });
      if (g.length < 1000) break;
    }
    return n + ' prices';
  });
  // Ad campaigns: spend and results for the last 30 days
  await step(st, 'ads', async () => {
    const cnt = await wb(st, 'https://advert-api.wildberries.ru/adv/v1/promotion/count');
    const ids = [];
    ((cnt && cnt.adverts) || []).forEach((g) => (g.advert_list || []).forEach((a) => { if (String(a.changeTime).slice(0, 10) >= ago(30) || [9, 11].includes(g.status)) ids.push(a.advertId); }));
    if (!ids.length) return '0 campaigns';
    const names = {};
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const info = await wb(st, 'https://advert-api.wildberries.ru/api/advert/v2/adverts?ids=' + ids.slice(i, i + 50).join(','));
        const arr = Array.isArray(info) ? info : (info && (info.adverts || info.data)) || [];
        if (i === 0) log('  advert sample', JSON.stringify(arr[0] || info).slice(0, 400));
        arr.forEach((a) => { const id = a.advertId || a.id; names[id] = { name: a.name || (a.settings && a.settings.name) || '', status: a.status || 0 }; });
      } catch (e) { log('  adverts info:', e.message.slice(0, 160)); }
      await sleep(300);
    }
    let got = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      let stats;
      try {
        stats = await wb(st, 'https://advert-api.wildberries.ru/adv/v3/fullstats?ids=' + part.join(',') + '&beginDate=' + ago(30) + '&endDate=' + ago(0));
      } catch (e) {
        log('  fullstats v3:', e.message.slice(0, 120));
        stats = await wb(st, 'https://advert-api.wildberries.ru/adv/v2/fullstats', part.map((id) => ({ id, interval: { begin: ago(30), end: ago(0) } })));
      }
      (stats || []).forEach((s) => {
        if (!s || !(+s.sum > 0)) return;
        const nm = {};
        (s.days || []).forEach((d) => (d.apps || []).forEach((ap) => (ap.nm || ap.nms || []).forEach((x) => { nm[x.nmId] = (nm[x.nmId] || 0) + (+x.sum || 0); })));
        const top = Object.entries(nm).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => K(st, k));
        OUT.ads.push({ s: st.id, id: s.advertId, name: (names[s.advertId] || {}).name || ('Кампания ' + s.advertId), st: (names[s.advertId] || {}).status || 0, spend: R(s.sum), views: R(s.views), clicks: R(s.clicks), cart: R(s.atbs), orders: R(s.orders), ordSum: R(s.sum_price), nms: top });
        got++;
      });
      if (i + 50 < ids.length) await sleep(21000);
    }
    return got + ' campaigns with spend';
  });
}

/* ---------------------------------- Ozon ---------------------------------- */
async function ozStore(st) {
  // offer_id -> sku map (stocks report carries the sku)
  await step(st, 'stocks', async () => {
    let cursor = '', n = 0;
    for (let i = 0; i < 50; i++) {
      const j = await oz(st, '/v4/product/info/stocks', { filter: { visibility: 'ALL' }, limit: 1000, cursor });
      const items = (j && j.items) || [];
      items.forEach((it) => {
        let sku = null, q = 0, res = 0;
        (it.stocks || []).forEach((s) => { if (s.sku) sku = s.sku; q += +s.present || 0; res += +s.reserved || 0; });
        if (!sku) return;
        OUT.stocks[K(st, sku)] = { q: q - res, toCl: res, fromCl: 0, wh: 0, offer: it.offer_id };
        n++;
      });
      cursor = j && j.cursor;
      if (!cursor || items.length < 1000) break;
    }
    return n + ' SKU';
  });
  // Funnel per SKU (30 days) and orders per day
  await step(st, 'funnel', async () => {
    // Without Ozon Premium only ordered_units and revenue are available; views stay empty
    const j = await oz(st, '/v1/analytics/data', { date_from: ago(30), date_to: ago(1), metrics: ['ordered_units', 'revenue'], dimension: ['sku'], limit: 1000, offset: 0 });
    const rows = (j && j.result && j.result.data) || [];
    rows.forEach((r) => { const m = r.metrics || []; OUT.funnel[K(st, r.dimensions[0].id)] = { v: 0, c: 0, o: R(m[0]), os: R(m[1]), b: null, bp: null }; });
    return rows.length + ' SKU';
  });
  await sleep(2000);
  await step(st, 'orders', async () => {
    const j = await oz(st, '/v1/analytics/data', { date_from: ago(30), date_to: TODAY, metrics: ['ordered_units', 'revenue', 'cancellations'], dimension: ['day'], limit: 1000, offset: 0 });
    const rows = (j && j.result && j.result.data) || [];
    rows.forEach((r) => { const m = r.metrics || []; addOrders(st, String(r.dimensions[0].id).slice(0, 10), +m[0] || 0, +m[1] || 0, +m[2] || 0); });
    return rows.length + ' days';
  });
  // Weekly accruals: what Ozon actually credits, summed from the transaction list (Mon-Sun weeks)
  await step(st, 'fin', async () => {
    const now = new Date(TODAY + 'T00:00:00Z');
    const mon = new Date(now.getTime() - ((now.getUTCDay() + 6) % 7) * DAY);
    const start = new Date(mon.getTime() - 8 * 7 * DAY);
    const W = {};
    const wkOf = (d) => { const t = new Date(String(d).slice(0, 10) + 'T00:00:00Z'); const m = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * DAY); return iso(m); };
    let ops = 0, sample = false;
    for (let a = start; a < now; a = new Date(a.getTime() + 28 * DAY)) {
      const b = new Date(Math.min(a.getTime() + 28 * DAY - 1000, now.getTime() + DAY - 1000));
      for (let page = 1; page < 200; page++) {
        const j = await oz(st, '/v3/finance/transaction/list', { filter: { date: { from: a.toISOString(), to: b.toISOString() }, operation_type: [], posting_number: '', transaction_type: 'all' }, page, page_size: 1000 });
        const r = (j && j.result) || {};
        const list = r.operations || [];
        if (!sample && list[0]) { sample = true; log('  fin sample', JSON.stringify(list[0]).slice(0, 500)); }
        list.forEach((o) => {
          const k = wkOf(o.operation_date);
          const w = (W[k] = W[k] || { from: k, to: iso(new Date(k + 'T00:00:00Z').getTime() + 6 * DAY), sales: 0, commission: 0, logistics: 0, services: 0, other: 0, payout: 0 });
          const sv = (o.services || []).reduce((s, x) => s + (+x.price || 0), 0);
          w.sales += +o.accruals_for_sale || 0;
          w.commission += +o.sale_commission || 0;
          w.logistics += (+o.delivery_charge || 0) + (+o.return_delivery_charge || 0);
          w.services += sv;
          w.payout += +o.amount || 0;
          ops++;
        });
        if (page >= (r.page_count || 1)) break;
        await sleep(300);
      }
    }
    OUT.fin[st.id] = Object.values(W).map((w) => { w.other = w.payout - w.sales - w.commission - w.logistics - w.services; for (const k in w) if (typeof w[k] === 'number') w[k] = R(w[k]); return w; }).sort((x, y) => (x.from < y.from ? -1 : 1));
    return ops + ' operations, ' + OUT.fin[st.id].length + ' weeks';
  });
  // Prices (by offer_id, mapped to sku through the stocks call)
  await step(st, 'prices', async () => {
    const bySkuOffer = {};
    Object.entries(OUT.stocks).forEach(([k, v]) => { if (k.startsWith(st.name + '|') && v.offer) bySkuOffer[v.offer] = k; });
    let cursor = '', n = 0;
    for (let i = 0; i < 50; i++) {
      const j = await oz(st, '/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 1000, cursor });
      const items = (j && j.items) || [];
      items.forEach((it) => { const k = bySkuOffer[it.offer_id]; if (!k) return; const p = it.price || {}; OUT.prices[k] = { p: R(p.old_price || p.price), pd: R(p.price), mp: R(p.marketing_price || p.marketing_seller_price), disc: 0 }; n++; });
      cursor = j && j.cursor;
      if (!cursor || items.length < 1000) break;
    }
    return n + ' prices';
  });
  // Reviews (needs Premium Plus on Ozon; skipped quietly if not available)
  if (st.id !== 'oz1' && /403/.test(String((OUT.status.oz1 || {}).reviews))) return;
  await step(st, 'reviews', async () => {
    let all = [], last_id = '';
    for (let i = 0; i < 20; i++) {
      const j = await oz(st, '/v1/review/list', { limit: 100, sort_dir: 'DESC', status: 'ALL', last_id });
      const r = (j && j.reviews) || [];
      all = all.concat(r.map((x) => ({ nm: x.sku, r: +x.rating || 0, d: String(x.published_at).slice(0, 10), t: String(x.text || '').slice(0, 220), a: x.status === 'PROCESSED' })));
      if (!j || !j.has_next || (r.length && String(r[r.length - 1].published_at).slice(0, 10) < ago(90))) break;
      last_id = j.last_id;
    }
    reviewsAgg(st, all);
    return all.length + ' reviews';
  });
}

function reviewsAgg(st, all) {
  const recent = all.filter((x) => x.d >= ago(90) && x.r > 0);
  const per = {};
  recent.forEach((x) => { const k = K(st, x.nm); const p = (per[k] = per[k] || { n: 0, sum: 0, neg: 0, last: [] }); p.n++; p.sum += x.r; if (x.r <= 3) { p.neg++; if (p.last.length < 3 && x.t) p.last.push({ r: x.r, d: x.d, t: x.t }); } });
  Object.entries(per).forEach(([k, p]) => { OUT.reviews[k] = { n: p.n, avg: Math.round((p.sum / p.n) * 100) / 100, neg: p.neg, last: p.last }; });
  const n30 = all.filter((x) => x.d >= ago(30) && x.r > 0);
  OUT.revStore[st.id] = { n30: n30.length, avg30: n30.length ? Math.round((n30.reduce((a, x) => a + x.r, 0) / n30.length) * 100) / 100 : null, neg30: n30.filter((x) => x.r <= 3).length, unanswered: all.filter((x) => !x.a && x.t && x.d >= ago(30)).length };
}

for (const st of STORES) {
  if (st.mp === 'WB' && !st.token) { status(st, 'all', false, 'no token'); continue; }
  if (st.mp === 'Ozon' && !(st.cid && st.key)) { status(st, 'all', false, 'no key'); continue; }
  log('==', st.id, st.name);
  if (st.mp === 'WB') await wbStore(st); else await ozStore(st);
}
// Round order sums
Object.values(OUT.orders).forEach((o) => Object.values(o).forEach((d) => { d[1] = R(d[1]); }));

// Keep the previous file's parts for sources that failed this time
let prev = null;
try { prev = JSON.parse(readFileSync(new URL('./market.json', import.meta.url), 'utf8')); } catch (e) { /* first run */ }
if (prev) {
  for (const st of STORES) {
    const s = OUT.status[st.id] || {};
    const failed = (src) => !s[src] || String(s[src]).startsWith('ERR');
    if (failed('fin') && prev.fin && prev.fin[st.id]) OUT.fin[st.id] = prev.fin[st.id];
    if (failed('orders') && prev.orders && prev.orders[st.id]) OUT.orders[st.id] = prev.orders[st.id];
    const keepMap = (src, map) => { if (failed(src) && prev[map]) Object.entries(prev[map]).forEach(([k, v]) => { if (k.startsWith(st.name + '|') && !OUT[map][k]) OUT[map][k] = v; }); };
    keepMap('stocks', 'stocks'); keepMap('funnel', 'funnel'); keepMap('prices', 'prices'); keepMap('reviews', 'reviews');
    if (failed('reviews') && prev.revStore && prev.revStore[st.id]) OUT.revStore[st.id] = prev.revStore[st.id];
    if (failed('ads') && prev.ads) OUT.ads = OUT.ads.concat(prev.ads.filter((a) => a.s === st.id));
  }
}
writeFileSync(new URL('./market.json', import.meta.url), JSON.stringify(OUT));
log('\nSTATUS', JSON.stringify(OUT.status, null, 1));
log('stocks', Object.keys(OUT.stocks).length, 'funnel', Object.keys(OUT.funnel).length, 'ads', OUT.ads.length, 'reviews', Object.keys(OUT.reviews).length, 'prices', Object.keys(OUT.prices).length);
