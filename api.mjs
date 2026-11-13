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
  { id: 'ym1', name: 'Яндекс Саковский', mp: 'Яндекс', key: env('YM_API_KEY') },
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

const OUT = { generated: new Date().toISOString(), today: TODAY, status: {}, stocks: {}, funnel: {}, orders: {}, sales: {}, fin: {}, ads: [], reviews: {}, revStore: {}, prices: {} };
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
    const rows = await wb(st, 'https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=' + ago(91) + '&flag=0');
    (rows || []).forEach((r) => { const d = String(r.date).slice(0, 10); if (d < ago(90)) return; addOrders(st, d, 1, +r.priceWithDisc || 0, r.isCancel ? 1 : 0); });
    return (rows || []).length + ' orders';
  });
  // Buyouts (sales) per day exactly as in the WB cabinet: sale date, price after seller discount; returns separately
  await step(st, 'sales', async () => {
    const rows = await wb(st, 'https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=' + ago(91) + '&flag=0');
    const o = (OUT.sales[st.id] = OUT.sales[st.id] || {});
    (rows || []).forEach((r) => {
      const d = String(r.date).slice(0, 10); if (d < ago(90)) return;
      const x = (o[d] = o[d] || [0, 0, 0, 0]);
      const isRet = String(r.saleID || '').startsWith('R') || (+r.priceWithDisc || 0) < 0;
      if (isRet) { x[2] += 1; x[3] += Math.abs(+r.priceWithDisc || 0); } else { x[0] += 1; x[1] += +r.priceWithDisc || 0; }
    });
    Object.values(o).forEach((x) => { x[1] = R(x[1]); x[3] = R(x[3]); });
    return (rows || []).length + ' sales';
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
  // Weekly financial reports (realization): what WB actually transfers (finance-api, 2026 method, 1 request/min)
  await step(st, 'fin', async () => {
    const URLF = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
    const fields = ['rrdId', 'dateFrom', 'dateTo', 'docTypeName', 'quantity', 'retailAmount', 'forPay', 'deliveryService', 'penalty', 'additionalPayment', 'paidStorage', 'deduction', 'paidAcceptance', 'sellerOperName'];
    let rrdId = 0, rows = [];
    for (let i = 0; i < 10; i++) {
      const j = await wb(st, URLF, { dateFrom: ago(63), dateTo: TODAY, limit: 100000, rrdId, period: 'weekly', fields });
      if (!Array.isArray(j) || !j.length) break;
      if (!rows.length) log('  fin sample', JSON.stringify(j[0]).slice(0, 400));
      rows = rows.concat(j);
      rrdId = j[j.length - 1].rrdId;
      if (j.length < 100000) break;
      await sleep(61000);
    }
    const W = {};
    rows.forEach((r) => {
      const from = String(r.dateFrom).slice(0, 10), to = String(r.dateTo).slice(0, 10);
      const w = (W[from + '_' + to] = W[from + '_' + to] || { from, to, sales: 0, forPay: 0, logistics: 0, storage: 0, penalty: 0, deduction: 0, acceptance: 0, add: 0, q: 0, ret: 0 });
      const isRet = /Возврат/i.test(r.docTypeName), sign = isRet ? -1 : 1;
      w.sales += sign * (+r.retailAmount || 0);
      w.forPay += sign * (+r.forPay || 0);
      if (/Продажа/i.test(r.docTypeName)) w.q += +r.quantity || 0;
      if (isRet) w.ret += +r.quantity || 0;
      w.logistics += +r.deliveryService || 0;
      w.storage += +r.paidStorage || 0;
      w.penalty += +r.penalty || 0;
      w.deduction += +r.deduction || 0;
      w.acceptance += +r.paidAcceptance || 0;
      w.add += +r.additionalPayment || 0;
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
    // Remaining budget of every campaign (WB: POST /api/advert/v2/budget, up to 50 ids per call)
    const budget = {};
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const b = await wb(st, 'https://advert-api.wildberries.ru/api/advert/v2/budget', { advertIds: ids.slice(i, i + 50) });
        ((b && b.adverts) || []).forEach((x) => { budget[x.advertId] = +x.total || 0; });
      } catch (e) { log('  budget:', e.message.slice(0, 160)); }
      await sleep(3200);
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
        const topE = Object.entries(nm).sort((a, b) => b[1] - a[1]).slice(0, 60);
        const top = topE.map(([k]) => K(st, k));
        const nmS = Object.fromEntries(topE.map(([k, v]) => [K(st, k), R(v)]));
        OUT.ads.push({ s: st.id, id: s.advertId, name: (names[s.advertId] || {}).name || ('Кампания ' + s.advertId), st: (names[s.advertId] || {}).status || 0, spend: R(s.sum), views: R(s.views), clicks: R(s.clicks), cart: R(s.atbs), orders: R(s.orders), ordSum: R(s.sum_price), bud: budget[s.advertId] != null ? budget[s.advertId] : null, nms: top, nmS, days: (s.days || []).map((d) => [String(d.date).slice(0, 10), R(d.sum), R(d.orders), R(d.sum_price)]) });
        got++;
      });
      if (i + 50 < ids.length) await sleep(21000);
    }
    return got + ' campaigns with spend';
  });
}

/* ----------------------------- Яндекс Маркет ------------------------------ */
const ym = (st, path, body) => http('https://api.partner.market.yandex.ru' + path, { method: body ? 'POST' : 'GET', headers: { 'Api-Key': st.key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
async function ymStore(st) {
  let camps = [];
  await step(st, 'campaigns', async () => {
    const j = await ym(st, '/campaigns');
    camps = ((j && j.campaigns) || []).filter((c) => !c.placementType || c.placementType !== 'DBS' || true);
    log('  ym campaigns', JSON.stringify(camps.map((c) => ({ id: c.id, domain: c.domain, type: c.placementType }))).slice(0, 300));
    return camps.length + ' campaigns';
  });
  const ymDate = (s) => { s = String(s || ''); const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(s); return m ? m[3] + '-' + m[2] + '-' + m[1] : s.slice(0, 10); };
  await step(st, 'orders', async () => {
    let n = 0, sample = false;
    for (const c of camps) {
      for (const [a, b] of [[ago(90), ago(61)], [ago(60), ago(31)], [ago(30), TODAY]]) {
        let token = '';
        for (let page = 0; page < 200; page++) {
          const j = await ym(st, '/campaigns/' + c.id + '/stats/orders?limit=200' + (token ? '&page_token=' + encodeURIComponent(token) : ''), { dateFrom: a, dateTo: b });
          const r = (j && j.result) || {};
          const list = r.orders || [];
          if (!sample && list[0]) { sample = true; log('  ym order sample', JSON.stringify(list[0]).slice(0, 500)); }
          list.forEach((o) => {
            const d = ymDate(o.creationDate);
            const sum = (o.items || []).reduce((s, it) => { const pr = (it.prices || []).find((x) => x.type === 'BUYER') || (it.prices || [])[0] || {}; return s + (+pr.total || (+pr.costPerItem || 0) * (+it.count || 1)); }, 0);
            const cnt = (o.items || []).reduce((s, it) => s + (+it.count || 1), 0) || 1;
            addOrders(st, d, cnt, sum, /CANCEL/i.test(o.status) ? cnt : 0);
            n++;
          });
          token = r.paging && r.paging.nextPageToken;
          if (!token || !list.length) break;
          await sleep(300);
        }
      }
    }
    return n + ' orders';
  });
  await step(st, 'stocks', async () => {
    let n = 0;
    for (const c of camps) {
      let token = '';
      for (let page = 0; page < 100; page++) {
        const j = await ym(st, '/campaigns/' + c.id + '/offers/stocks?limit=200' + (token ? '&page_token=' + encodeURIComponent(token) : ''), {});
        const r = (j && j.result) || {};
        (r.warehouses || []).forEach((w) => (w.offers || []).forEach((of) => {
          const k = K(st, of.offerId);
          const s = (OUT.stocks[k] = OUT.stocks[k] || { q: 0, toCl: 0, fromCl: 0, wh: 0 });
          (of.stocks || []).forEach((x) => { if (x.type === 'FIT' || x.type === 'AVAILABLE') s.q += +x.count || 0; });
          n++;
        }));
        token = r.paging && r.paging.nextPageToken;
        if (!token) break;
        await sleep(300);
      }
    }
    return n + ' offers';
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
    const j = await oz(st, '/v1/analytics/data', { date_from: ago(90), date_to: TODAY, metrics: ['ordered_units', 'revenue', 'cancellations'], dimension: ['day'], limit: 1000, offset: 0 });
    const rows = (j && j.result && j.result.data) || [];
    rows.forEach((r) => { const m = r.metrics || []; addOrders(st, String(r.dimensions[0].id).slice(0, 10), +m[0] || 0, +m[1] || 0, +m[2] || 0); });
    return rows.length + ' days';
  });
  // Weekly accruals: what Ozon actually credits. Since 2026 Ozon gives accruals one day per call (/v1/finance/accrual/by-day)
  await step(st, 'fin', async () => {
    const W = {};
    const wkOf = (d) => { const t = new Date(d + 'T00:00:00Z'); return iso(t.getTime() - ((t.getUTCDay() + 6) % 7) * DAY); };
    let n = 0, sample = false;
    for (let i = 63; i >= 1; i--) {
      const day = ago(i);
      let last_id = '';
      for (let page = 0; page < 50; page++) {
        const j = await oz(st, '/v1/finance/accrual/by-day', last_id ? { date: day, last_id, limit: 1000 } : { date: day, limit: 1000 });
        const r = (j && j.result) || j || {};
        const list = r.accruals || r.items || r.rows || [];
        if (!sample && list[0]) { sample = true; log('  fin sample', JSON.stringify(list[0]).slice(0, 700), 'keys', Object.keys(r).join(',')); }
        const k = wkOf(day);
        const w = (W[k] = W[k] || { from: k, to: iso(new Date(k + 'T00:00:00Z').getTime() + 6 * DAY), sales: 0, commission: 0, logistics: 0, services: 0, other: 0, payout: 0 });
        list.forEach((a) => {
          const amt = +((a.total_amount && (a.total_amount.amount != null ? a.total_amount.amount : a.total_amount)) ?? a.amount ?? 0) || 0;
          w.payout += amt; n++;
          const cat = String(a.accrual_type || a.type || a.category || a.name || '').toLowerCase();
          if (/sale|продаж|выручк/.test(cat) && amt > 0) w.sales += amt;
          else if (/commiss|комисс|reward|вознагр/.test(cat)) w.commission += amt;
          else if (/deliver|logist|достав|логист|обработ/.test(cat)) w.logistics += amt;
          else w.other += amt;
        });
        last_id = r.last_id || '';
        if (!r.has_next || !last_id || !list.length) break;
        await sleep(250);
      }
      await sleep(250);
    }
    const weeks = Object.values(W).filter((w) => w.from >= wkOf(ago(56))).map((w) => { for (const k in w) if (typeof w[k] === 'number') w[k] = R(w[k]); return w; }).sort((x, y) => (x.from < y.from ? -1 : 1));
    if (!n) throw new Error('no accruals returned');
    OUT.fin[st.id] = weeks;
    return n + ' accruals, ' + weeks.length + ' weeks';
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
  if (st.mp === 'Яндекс' && !st.key) { log('ym1 skipped: no YM_API_KEY'); continue; }
  log('==', st.id, st.name);
  if (st.mp === 'WB') await wbStore(st); else if (st.mp === 'Ozon') await ozStore(st); else await ymStore(st);
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
    if (st.mp === 'WB' && failed('sales') && prev.sales && prev.sales[st.id]) OUT.sales[st.id] = prev.sales[st.id];
    const keepMap = (src, map) => { if (failed(src) && prev[map]) Object.entries(prev[map]).forEach(([k, v]) => { if (k.startsWith(st.name + '|') && !OUT[map][k]) OUT[map][k] = v; }); };
    keepMap('stocks', 'stocks'); keepMap('funnel', 'funnel'); keepMap('prices', 'prices'); keepMap('reviews', 'reviews');
    if (failed('reviews') && prev.revStore && prev.revStore[st.id]) OUT.revStore[st.id] = prev.revStore[st.id];
    if (failed('ads') && prev.ads) OUT.ads = OUT.ads.concat(prev.ads.filter((a) => a.s === st.id));
  }
}
writeFileSync(new URL('./market.json', import.meta.url), JSON.stringify(OUT));
log('\nSTATUS', JSON.stringify(OUT.status, null, 1));
log('stocks', Object.keys(OUT.stocks).length, 'funnel', Object.keys(OUT.funnel).length, 'ads', OUT.ads.length, 'reviews', Object.keys(OUT.reviews).length, 'prices', Object.keys(OUT.prices).length);
