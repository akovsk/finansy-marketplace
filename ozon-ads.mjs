// Ozon Performance API adapter for the ads agent («Оплата за клик» campaigns).
// Docs: https://docs.ozon.ru/api/performance/  — keys: seller.ozon.ru → Настройки → API-ключи → Performance API.
// Gives the agent the same campaign shape as the WB adapter, so the decision logic and hard limits are shared.
//
// Not verified against a live cabinet yet: the JSON report shapes (/statistics/…/json) are not documented,
// so the parsers below accept several field spellings and the first run logs a sample of every answer.
const HOST = 'https://api-performance.ozon.ru';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
// "1 234,56" / "1234.56" / 1234 → number
export const num = (x) => { if (typeof x === 'number') return x; const n = parseFloat(String(x == null ? '' : x).replace(/\s| /g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };
const isoDay = (x) => { const s = String(x || ''); const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : s.slice(0, 10); };

const STATE = { CAMPAIGN_STATE_RUNNING: 9, CAMPAIGN_STATE_STOPPED: 9, CAMPAIGN_STATE_INACTIVE: 11, CAMPAIGN_STATE_PLANNED: 4 };
// Bids and budgets travel as millionths of a rouble ("35000000" = 35 ₽). Small numbers are treated as plain roubles.
export const bidUnit = (raw) => (num(raw) >= 100000 ? 1e6 : 1);

export function normOzonCampaign(c, products) {
  const strategy = c.productAutopilotStrategy || 'NO_AUTO_STRATEGY';
  return {
    platform: 'ozon', id: Number(c.id), name: c.title || '', status: STATE[c.state] || 0,
    noBudget: c.state === 'CAMPAIGN_STATE_STOPPED',
    payType: 'cpc', bidType: strategy, strategy, placement: c.placement || '',
    dailyBudget: num(c.dailyBudget) / 1e6, weeklyBudget: num(c.weeklyBudget) / 1e6,
    // search = bid in the API's own unit (kept as is so it can be written back), cir = target ДРР in percent
    nms: (products || []).map((p) => ({ nm: String(p.sku), search: num(p.bid), recom: 0, cir: p.targetCir != null ? num(p.targetCir) : null, unit: bidUnit(p.bid) })).filter((p) => p.nm),
  };
}
// Daily report rows → the same per-campaign stats object the WB part of market.json has
export function ozonStats(rows, storeName, skuRows = []) {
  const by = new Map();
  (rows || []).forEach((r) => {
    const id = Number(pick(r, ['id', 'campaignId', 'campaign_id']));
    if (!id) return;
    const a = by.get(id) || { spend: 0, views: 0, clicks: 0, cart: 0, orders: 0, ordSum: 0, bud: null, nmS: {}, sku: {}, days: [] };
    const spend = num(pick(r, ['moneySpent', 'expense', 'spent'])), orders = num(pick(r, ['orders', 'ordersCount'])), ordSum = num(pick(r, ['ordersMoney', 'sales', 'revenue']));
    a.spend += spend; a.views += num(r.views); a.clicks += num(r.clicks); a.orders += orders; a.ordSum += ordSum;
    a.days.push([isoDay(r.date), spend, orders, ordSum]);
    by.set(id, a);
  });
  (skuRows || []).forEach((r) => {
    const a = by.get(Number(pick(r, ['campaignId', 'id']))); const sku = String(r.sku || '');
    if (!a || !sku) return;
    const s = (a.sku[sku] = a.sku[sku] || { spend: 0, clicks: 0, orders: 0, sales: 0 });
    s.spend += num(r.expense); s.clicks += num(r.clicks); s.orders += num(r.orders); s.sales += num(r.sales); a.cart += num(r.toCart);
    a.nmS[storeName + '|' + sku] = (a.nmS[storeName + '|' + sku] || 0) + num(r.expense);
  });
  return by;
}
// New per-SKU bids after a ±pct change: whole roubles, inside [min, cap]
export function ozonBids(m, pctChange, cfg, minRub = 0) {
  const items = [];
  m.nms.forEach((n) => {
    if (!n.search) return;
    const u = n.unit || 1, cur = n.search / u, cap = cfg.ozon.maxCpcRub;
    let rub = Math.round(cur * (1 + pctChange / 100));
    if (rub === Math.round(cur)) rub += pctChange > 0 ? 1 : -1;
    rub = Math.min(Math.max(rub, Math.max(minRub, 1)), Math.max(cap, minRub));
    if (pctChange > 0 && cur >= cap) return;
    if (rub !== Math.round(cur)) items.push({ nm: n.nm, was: cur, rub, raw: String(Math.round(rub * u)) });
  });
  return items;
}

export function ozonApi(clientId, clientSecret, storeName) {
  let token = null, exp = 0, seen = {};
  async function call(method, path, body, tries = 4) {
    if (!token || Date.now() > exp) {
      const r = await fetch(HOST + '/api/client/token', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }) });
      const t = await r.text();
      if (!r.ok) throw new Error('Ozon Performance: ключ не принят (HTTP ' + r.status + ') ' + t.slice(0, 160));
      const j = JSON.parse(t); token = j.access_token; exp = Date.now() + ((+j.expires_in || 1800) - 120) * 1000;
    }
    for (let i = 1; ; i++) {
      const r = await fetch(HOST + path, { method, headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if ((r.status === 429 || r.status >= 500) && i < tries) { await sleep(5000 * i); continue; }
      const t = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + method + ' ' + path.replace(/\?.*/, '') + ' ' + t.slice(0, 240));
      let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
      const k = method + ' ' + path.replace(/\?.*/, '').replace(/\d{4,}/g, '{id}');
      if (!seen[k]) { seen[k] = 1; log('  ozon sample', k, JSON.stringify(j).slice(0, 500)); }
      return j;
    }
  }
  const rowsOf = (j) => (Array.isArray(j) ? j : (j && (j.rows || j.list || j.data || j.items)) || []);
  return {
    platform: 'ozon',
    async list() {
      const j = await call('GET', '/api/client/campaign?advObjectType=SKU');
      const out = [];
      for (const c of rowsOf(j)) {
        if (!STATE[c.state]) continue;
        let products = [];
        try { for (let page = 1; page <= 5; page++) { const p = await call('GET', '/api/client/campaign/' + c.id + '/v2/products?page=' + page + '&pageSize=100'); const arr = (p && p.products) || []; products = products.concat(arr); if (arr.length < 100) break; } } catch (e) { log('  ozon products', c.id, e.message.slice(0, 160)); }
        out.push(normOzonCampaign(c, products));
        await sleep(150);
      }
      return out;
    },
    // Stats for the last 30 days: per campaign per day, plus per SKU where Ozon gives it
    async stats(campaigns, today) {
      const from = new Date(Date.parse(today) - 29 * 864e5).toISOString().slice(0, 10);
      const ids = campaigns.map((c) => c.id);
      if (!ids.length) return new Map();
      const q = '?dateFrom=' + from + '&dateTo=' + today + ids.map((id) => '&campaignIds=' + id).join('');
      const daily = rowsOf(await call('GET', '/api/client/statistics/daily/json' + q));
      let sku = [];
      try { sku = rowsOf(await call('POST', '/api/client/statistics/products/sku', { campaignIds: ids.map(String), dateFrom: from, dateTo: today })); } catch (e) { log('  ozon sku stats:', e.message.slice(0, 160)); }
      return ozonStats(daily, storeName, sku);
    },
    async minBid(skus) {
      try { const j = await call('POST', '/api/client/min/sku', { marketplaceId: 'MARKETPLACE_ID_RU', paymentType: 'CPC', sku: skus.map(String) }); return Math.max(0, ...((j && j.minBids) || []).map((x) => { const b = num(x.bid); return b >= 100000 ? b / 1e6 : b; })); } catch (e) { log('  ozon min bid:', e.message.slice(0, 160)); return 0; }
    },
    // Sends only sku + bid / targetCir. Ozon's note: this call also resets legacy stop-words and phrase bids of the campaign.
    setBids: (id, items) => call('PUT', '/api/client/campaign/' + id + '/products', { bids: items.map((x) => ({ sku: String(x.nm), bid: x.raw })) }),
    setCir: (id, skus, cir) => call('PUT', '/api/client/campaign/' + id + '/products', { bids: skus.map((s) => ({ sku: String(s), targetCir: cir })) }),
    start: (id) => call('POST', '/api/client/campaign/' + id + '/activate', {}),
    pause: (id) => call('POST', '/api/client/campaign/' + id + '/deactivate', {}),
    stop: (id) => call('POST', '/api/client/campaign/' + id + '/deactivate', {}),   // Ozon has no irreversible close: switching off is the strongest action
    drop: (id, skus) => call('POST', '/api/client/campaign/' + id + '/products/delete', { sku: skus.map(String) }),
    // New campaign that holds a target ДРР (strategy «Целевой расход») with a weekly budget cap
    async create(title, sku, cirPct, weeklyRub) {
      const j = await call('POST', '/api/client/campaign/cpc/v2/product', { title, placement: 'PLACEMENT_SEARCH_AND_CATEGORY', productAutopilotStrategy: 'TARGET_CIR', weeklyBudget: String(Math.round(weeklyRub * 1e6)) });
      const id = j && j.campaignId;
      if (!id) throw new Error('Ozon не вернул номер кампании: ' + JSON.stringify(j).slice(0, 160));
      await call('POST', '/api/client/campaign/' + id + '/products', { bids: [{ sku: String(sku), targetCir: cirPct }] });
      await call('POST', '/api/client/campaign/' + id + '/activate', {});
      return Number(id);
    },
  };
}
