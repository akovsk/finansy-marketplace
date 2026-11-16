// AI agent that manages Wildberries ad campaigns: reads conversion metrics and unit economics,
// decides per campaign (keep / raise bid / lower bid / pause / stop for good / top up / launch new)
// and applies the decisions through the WB Promotion API.
//
// Inputs:  market.json (ad stats, stocks, funnel, reviews — written by api.mjs), data.json (profit per SKU, Торгстат),
//          ads-agent.config.json (limits), ads-agent.json (own history).
// Output:  ads-agent.json — the plan, what was actually done and the action history (shown in the dashboard).
//
// Decisions: Claude proposes them when ANTHROPIC_API_KEY is set; otherwise the built-in rules do.
// Either way every decision passes the same hard limits in guard() before anything is sent to WB.
// mode "dry-run" (default) only writes the plan; mode "live" changes campaigns for real.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DAY = 864e5;
const R = (x) => Math.round(+x || 0);
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const readJson = (name, fallback) => { try { return JSON.parse(readFileSync(new URL('./' + name, import.meta.url), 'utf8')); } catch (e) { return fallback; } };

export const DEFAULTS = {
  mode: 'dry-run', stores: ['wb1', 'wb2'], protect: [],
  targetShare: 0.6, maxDrr: 0.25, minSpend: 1500, minClicks: 150,
  stop: { noOrdersSpend: 3000, overMarginFactor: 1.4, maxPerRun: 5 },
  bid: { maxStepPct: 25, upStepPct: 15, cooldownHours: 24, maxCpmKop: 100000, maxCpcKop: 5000, minOrdersToRaise: 5, minStockDaysToRaise: 14 },
  stock: { pauseWhenOut: true, resumeDays: 5 },
  budget: { autoTopUp: false, topUpSum: 1000, dailyCap: 5000, source: 1 },
  launch: { enabled: false, maxPerRun: 1, maxTotal: 5, budget: 1000, minStock: 30, minStockDays: 45, minMargin: 0.25, minSales30: 10, minRating: 4.5, paymentType: 'cpm' },
  llm: { enabled: true, model: 'claude-opus-5-5', effort: 'medium' },
};
export function mergeConfig(user) {
  const out = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(user || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') Object.assign(out[k], v); else out[k] = v;
  }
  return out;
}

/* ------------------------------ WB Promotion API ------------------------------ */
// Docs: https://dev.wildberries.ru/openapi/promotion  (token category «Продвижение», with write access for live mode)
const WB = 'https://advert-api.wildberries.ru';
async function http(token, method, path, body, tries = 4) {
  for (let i = 1; ; i++) {
    const r = await fetch(WB + path, { method, headers: { Authorization: token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 429 && i < tries) { await sleep(15000 * i); continue; }
    if (r.status >= 500 && i < tries) { await sleep(4000 * i); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + method + ' ' + path.replace(/\?.*/, '') + ' ' + t.slice(0, 240));
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return t; }
  }
}
// Campaign as the agent sees it, whatever exact shape WB answered with
export function normCampaign(a) {
  const s = a.settings || {};
  const pl = s.placements || a.placements || {};
  return {
    id: a.id || a.advertId || a.advert_id,
    name: s.name || a.name || '',
    status: a.status,
    bidType: a.bid_type || a.bidType || 'manual',
    payType: s.payment_type || a.payment_type || 'cpm',
    search: pl.search !== false,
    recom: !!(pl.recommendations != null ? pl.recommendations : pl.recommendation),
    nms: (a.nm_settings || a.nms || []).map((n) => {
      const b = n.bids_kopecks || n.bids || {};
      return { nm: n.nm_id || n.nmId || n.nm, search: R(b.search), recom: R(b.recommendations != null ? b.recommendations : b.recommendation) };
    }).filter((n) => n.nm),
  };
}
export function wbApi(token) {
  const call = (m, p, b) => http(token, m, p, b);
  return {
    async list() {
      const cnt = await call('GET', '/adv/v1/promotion/count');
      const ids = [];
      ((cnt && cnt.adverts) || []).forEach((g) => { if ([4, 9, 11].includes(g.status)) (g.advert_list || []).forEach((a) => ids.push(a.advertId)); });
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const info = await call('GET', '/api/advert/v2/adverts?ids=' + ids.slice(i, i + 50).join(','));
        const arr = Array.isArray(info) ? info : (info && (info.adverts || info.data)) || [];
        if (i === 0) log('  campaign sample', JSON.stringify(arr[0] || info).slice(0, 700));
        arr.forEach((a) => out.push(normCampaign(a)));
        await sleep(300);
      }
      return out;
    },
    // Lowest bid WB accepts, kopecks: { nm: { search, recom, combined } }
    async minBids(c) {
      const res = {};
      try {
        const types = c.bidType === 'unified' ? ['combined'] : [c.search && 'search', c.recom && 'recommendation'].filter(Boolean);
        const j = await call('POST', '/api/advert/v1/bids/min', { advert_id: c.id, nm_ids: c.nms.map((n) => n.nm), payment_type: c.payType, placement_types: types });
        ((j && j.bids) || []).forEach((x) => { const o = (res[x.nm_id] = {}); (x.bids || []).forEach((b) => { o[String(b.type).startsWith('rec') ? 'recom' : b.type] = R(b.value); }); });
      } catch (e) { log('  min bids', c.id, e.message.slice(0, 160)); }
      return res;
    },
    setBids: (id, items) => call('PATCH', '/api/advert/v1/bids', { bids: [{ advert_id: id, nm_bids: items.map((x) => ({ nm_id: x.nm, bid_kopecks: x.kop, placement: x.placement })) }] }),
    start: (id) => call('GET', '/adv/v0/start?id=' + id),
    pause: (id) => call('GET', '/adv/v0/pause?id=' + id),
    stop: (id) => call('GET', '/adv/v0/stop?id=' + id),
    balance: () => call('GET', '/adv/v1/balance'),
    deposit: (id, sum, source) => call('POST', '/adv/v1/budget/deposit?id=' + id, { sum, type: source, return: true }),
    create: (name, nms, payType) => call('POST', '/adv/v2/seacat/save-ad', { name, nms, bid_type: 'unified', payment_type: payType, placement_types: ['search', 'recommendations'] }),
  };
}

/* ------------------------------ Metrics ------------------------------ */
// Per-SKU profit for the last 30 days of data.json; key "<store name>|<sku>" like in market.json
export function skuEconomics(data) {
  const ci = Object.fromEntries(data.cols.map((c, i) => [c, i]));
  const last = Math.round((Date.parse(data.end) - Date.parse(data.start)) / DAY);
  const m = new Map();
  data.products.forEach((p) => {
    let rev = 0, np = 0, adv = 0, q = 0, cogs = 0;
    p.d.forEach((d) => { if (d[0] > last - 30) { rev += d[ci.rev]; np += d[ci.np]; adv += d[ci.adv]; q += d[ci.q]; cogs += d[ci.cogs]; } });
    m.set(data.stores[p.s].name + '|' + p.sku, { store: data.stores[p.s].id, sku: p.sku, name: p.n, rev, np, adv, q, noCogs: q > 0 && !cogs, margin: rev > 0 ? (np - adv) / rev : null });
  });
  return m;
}
function windowStats(days, today, n) {
  const from = new Date(Date.parse(today) - (n - 1) * DAY).toISOString().slice(0, 10);
  let spend = 0, orders = 0, ordSum = 0;
  (days || []).forEach((d) => { if (d[0] >= from) { spend += d[1] || 0; orders += d[2] || 0; ordSum += d[3] || 0; } });
  return { spend, orders, ordSum };
}
// One row per campaign: conversions, ДРР, margin of the advertised goods, stock, current bids.
export function campaignMetrics(c, ad, ctx) {
  const { econ, market, storeName } = ctx;
  const key = (nm) => storeName + '|' + nm;
  // Advertised goods: where the money actually went; for a campaign without stats — everything in it
  const spendBy = {};
  if (ad && ad.nmS) Object.entries(ad.nmS).forEach(([k, v]) => { if (v > 0) spendBy[k] = v; });
  if (!Object.keys(spendBy).length) c.nms.forEach((n) => { spendBy[key(n.nm)] = 1; });
  let wm = 0, sm = 0, wb = 0, sb = 0, stock = 0, perDay = 0, rateN = 0, rateS = 0, noCogs = false;
  Object.entries(spendBy).forEach(([k, w]) => {
    const e = econ.get(k);
    if (e && e.rev > 0) { wm += w * e.margin; sm += w; perDay += e.q / 30; if (e.noCogs) noCogs = true; }
    const f = market.funnel && market.funnel[k];
    if (f && f.bp) { wb += w * (f.bp / 100); sb += w; }
    const s = market.stocks && market.stocks[k];
    if (s) stock += s.q || 0;
    const rv = market.reviews && market.reviews[k];
    if (rv && rv.n) { rateN += rv.n; rateS += rv.avg * rv.n; }
  });
  const margin = sm ? wm / sm : null;                          // profit before ads / revenue
  const buyout = sb ? clamp(wb / sb, 0.3, 1) : 0.9;            // share of orders that are bought out
  const w30 = ad ? { spend: ad.spend, orders: ad.orders, ordSum: ad.ordSum } : { spend: 0, orders: 0, ordSum: 0 };
  const w14 = windowStats(ad && ad.days, ctx.today, 14), w7 = windowStats(ad && ad.days, ctx.today, 7);
  const drr = (w) => (w.ordSum > 0 ? w.spend / (w.ordSum * buyout) : (w.spend > 0 ? Infinity : null)); // ad spend / bought-out revenue
  const target = margin != null && margin > 0 ? Math.min(margin * ctx.cfg.targetShare, ctx.cfg.maxDrr) : null;
  return {
    id: c.id, store: ctx.storeId, name: c.name || (ad && ad.name) || '', status: c.status, payType: c.payType, bidType: c.bidType,
    nms: c.nms, skus: Object.keys(spendBy),
    views: ad ? ad.views : 0, clicks: ad ? ad.clicks : 0, cart: ad ? ad.cart : 0,
    ctr: ad && ad.views ? ad.clicks / ad.views : null, cr: ad && ad.clicks ? ad.orders / ad.clicks : null,
    w30, w14, w7, drr30: drr(w30), drr14: drr(w14), drr7: drr(w7),
    margin, buyout, target, noCogs,
    stock, stockDays: perDay > 0 ? stock / perDay : (stock > 0 ? Infinity : 0),
    rating: rateN ? rateS / rateN : null, budget: ad && ad.bud != null ? ad.bud : null,
    spendPerDay: w7.spend / 7,
  };
}

/* ------------------------------ Rules ------------------------------ */
const pct = (x) => (x == null ? '—' : isFinite(x) ? Math.round(x * 100) + '%' : '∞');
const rub = (x) => R(x).toLocaleString('ru-RU') + ' ₽';
const enoughData = (m, cfg) => m.w30.spend >= cfg.minSpend || m.clicks >= cfg.minClicks;

// Is closing this campaign for good justified by the numbers? Returns the reason or null.
// The only gate for the irreversible action: neither the rules nor Claude can stop a campaign that fails it.
export function stopReason(m, cfg) {
  if (m.status !== 9 && m.status !== 11) return null;
  if (!m.w30.orders && m.w30.spend >= cfg.stop.noOrdersSpend) return 'За 30 дней потрачено ' + rub(m.w30.spend) + ' и ни одного заказа.';
  if (m.w30.spend < cfg.minSpend || m.margin == null || m.noCogs) return null;
  if (m.margin <= 0.02) return 'Товар убыточен ещё до рекламы (маржа ' + pct(m.margin) + '): реклама только увеличивает минус.';
  const lim = m.margin * cfg.stop.overMarginFactor;
  const recent = m.w14.spend >= cfg.minSpend / 2 ? m.drr14 : m.drr30;
  if (m.w30.orders > 0 && m.drr30 > lim && recent > lim) return 'ДРР ' + pct(m.drr30) + ' (за 14 дней ' + pct(recent) + ') при марже до рекламы ' + pct(m.margin) + ': каждый рекламный заказ в минус.';
  return null;
}
export function ruleDecision(m, cfg, st) {
  const D = (action, reason, bidPct = 0) => ({ id: m.id, action, bidPct, reason });
  if (m.status === 11) {
    if (st.pausedByAgent && m.stockDays >= cfg.stock.resumeDays) return D('resume', 'Товар снова в наличии (хватит на ' + R(Math.min(m.stockDays, 999)) + ' дн.) — включаю кампанию, которую сам ставил на паузу.');
    return D('keep', 'На паузе — не трогаю.');
  }
  if (m.status !== 9) return D('keep', 'Не активна.');
  const stop = stopReason(m, cfg);
  if (stop) return D('stop', stop);
  if (cfg.stock.pauseWhenOut && m.stock <= 0 && m.skus.length) return D('pause', 'Рекламируемого товара нет на складе — пауза до поставки.');
  if (!enoughData(m, cfg)) return D('keep', 'Мало данных (' + rub(m.w30.spend) + ', ' + m.clicks + ' кликов) — жду статистику.');
  if (m.target == null) return D('keep', m.margin == null ? 'По товарам кампании нет продаж в отчётах — нужна ручная проверка.' : 'Маржа до рекламы около нуля — ставку не поднимаю, наблюдаю.');
  const d = m.w14.spend >= cfg.minSpend / 2 ? m.drr14 : m.drr30;
  if (d == null) return D('keep', 'Нет расходов за период.');
  if (d > m.target * 1.15) {
    const cut = clamp(Math.round((1 - m.target / d) * 100), 5, cfg.bid.maxStepPct);
    return D('lower', 'ДРР ' + pct(d) + ' выше цели ' + pct(m.target) + ' (маржа до рекламы ' + pct(m.margin) + ') — снижаю ставку на ' + cut + '%.', -cut);
  }
  if (d < m.target * 0.7 && m.w14.orders >= cfg.bid.minOrdersToRaise && m.stockDays >= cfg.bid.minStockDaysToRaise) {
    return D('raise', 'ДРР ' + pct(d) + ' заметно ниже цели ' + pct(m.target) + ', остатка хватит на ' + R(Math.min(m.stockDays, 999)) + ' дн. — поднимаю ставку на ' + cfg.bid.upStepPct + '%.', cfg.bid.upStepPct);
  }
  return D('keep', 'ДРР ' + pct(d) + ' в пределах цели ' + pct(m.target) + '.');
}

/* ------------------------------ Hard limits ------------------------------ */
// New bids for a campaign after a ±pct change: whole roubles, never below WB's minimum, never above the cap.
export function newBids(m, pctChange, cfg, mins = {}) {
  const cap = m.payType === 'cpc' ? cfg.bid.maxCpcKop : cfg.bid.maxCpmKop;
  const items = [];
  const one = (nm, placement, cur, min) => {
    if (!cur) return;
    let kop = Math.round((cur * (1 + pctChange / 100)) / 100) * 100;
    if (kop === cur) kop += pctChange > 0 ? 100 : -100;
    kop = clamp(kop, Math.max(min || 0, 100), Math.max(cap, min || 0));
    if (pctChange > 0 && cur >= cap) return;          // already above the cap: do not push further
    if (kop !== cur) items.push({ nm, placement, kop, was: cur });
  };
  m.nms.forEach((n) => {
    const mn = mins[n.nm] || {};
    if (m.bidType === 'unified') one(n.nm, 'combined', n.search || n.recom, mn.combined || mn.search);
    else { one(n.nm, 'search', n.search, mn.search); one(n.nm, 'recommendations', n.recom, mn.recom); }
  });
  return items;
}
// Turns a proposed decision (from Claude or from the rules) into one that is safe to execute.
export function guard(dec, m, cfg, st, now) {
  const keep = (why) => ({ id: m.id, action: 'keep', bidPct: 0, reason: dec.reason, blocked: why });
  if (cfg.protect.map(String).includes(String(m.id))) return keep('кампания в списке protect');
  const cool = st.lastBidAt && now - st.lastBidAt < cfg.bid.cooldownHours * 3600e3;
  switch (dec.action) {
    case 'stop': return stopReason(m, cfg) ? { ...dec, bidPct: 0 } : keep('для закрытия не хватает данных или убыток не подтверждён');
    case 'pause': return m.status === 9 ? { ...dec, bidPct: 0 } : keep('кампания не активна');
    case 'resume': return m.status === 11 && st.pausedByAgent && m.stock > 0 ? { ...dec, bidPct: 0 } : keep('включаю только кампании, которые сам ставил на паузу');
    case 'lower': case 'raise': {
      if (m.status !== 9) return keep('кампания не активна');
      if (cool) return keep('ставка менялась меньше ' + cfg.bid.cooldownHours + ' ч назад — жду статистику');
      if (!enoughData(m, cfg)) return keep('мало данных для изменения ставки');
      let p = clamp(Math.abs(+dec.bidPct || 0), 5, cfg.bid.maxStepPct);
      if (dec.action === 'raise') {
        const d = m.w14.spend >= cfg.minSpend / 2 ? m.drr14 : m.drr30;
        if (m.target == null || d == null || d >= m.target) return keep('повышать ставку можно только при ДРР ниже цели');
        if (m.stockDays < cfg.bid.minStockDaysToRaise) return keep('мало остатка для масштабирования');
        p = Math.min(p, cfg.bid.upStepPct);
      }
      return { ...dec, bidPct: dec.action === 'raise' ? p : -p };
    }
    default: return { id: m.id, action: 'keep', bidPct: 0, reason: dec.reason };
  }
}

/* ------------------------------ Claude ------------------------------ */
const SYSTEM = `You manage Wildberries (Russian marketplace) search/recommendation ad campaigns for a seller. Your job on each run is to decide, per campaign, whether to keep it as is, raise or lower its bid, pause it, or close it for good.

The seller's goal is profit, not turnover. A campaign is worth running only while ad spend stays below the profit the advertised goods make before ads.

How to read the data (money in roubles, shares as fractions):
- margin: profit before ads divided by revenue for the advertised goods over 30 days. It is the break-even ДРР: above it every ad order loses money.
- target: the ДРР the seller wants (a share of margin, capped). drr30 / drr14 / drr7: ad spend divided by bought-out order revenue for that window; "inf" means spend with no orders. Recent windows show the trend, but 7 days is noisy and WB attributes orders with a lag of a day or two.
- noCogs true means cost of goods is missing, so margin is overstated and unreliable.
- stockDays: days of stock left at the current sales pace. Advertising something about to sell out wastes money; scaling needs stock.
- lastActions: what you did to this campaign on previous runs. Give a bid change time to show up in the numbers before changing again, and notice when repeated cuts have not fixed a campaign.
- rule: what the seller's fixed rule set would do. Treat it as a baseline, and depart from it when the trend, stock, rating or history gives you a reason.

Actions: "keep"; "lower" / "raise" with bidPct as a positive percentage of the current bid; "pause" (reversible, use for stock problems); "stop" (closes the campaign permanently, it cannot be restarted).

Code enforces hard limits after you answer: step size, bid floor and ceiling, a cooldown between bid changes, raises only when ДРР is under target, and "stop" only when stopAllowed is true. A decision outside those limits is dropped, so choose within them. stopAllowed means the numbers justify closing; whether to close now or cut the bid first is your call. The seller asked for ineffective campaigns to be closed rather than left running, so do not keep a clearly loss-making campaign alive out of caution.

Return one decision for every campaign in the input. Write each reason in Russian, one or two plain sentences with the numbers that drove it, for a seller who is not an ads specialist. Write summary in Russian: two to four sentences on the state of the ad account and what you changed.`;

async function askClaude(rows, cfg) {
  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([import('@anthropic-ai/sdk'), import('zod'), import('@anthropic-ai/sdk/helpers/zod')]);
  const Plan = z.object({
    summary: z.string(),
    decisions: z.array(z.object({ id: z.number(), action: z.enum(['keep', 'lower', 'raise', 'pause', 'stop']), bidPct: z.number(), reason: z.string() })),
  });
  const client = new Anthropic();
  const res = await client.messages.parse({
    model: cfg.llm.model, max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.llm.effort, format: zodOutputFormat(Plan) },
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Limits: ' + JSON.stringify({ maxStepPct: cfg.bid.maxStepPct, upStepPct: cfg.bid.upStepPct, cooldownHours: cfg.bid.cooldownHours, minSpend: cfg.minSpend }) + '\n\nCampaigns:\n' + JSON.stringify(rows) }],
  });
  if (res.stop_reason !== 'end_turn' || !res.parsed_output) throw new Error('Claude: stop_reason ' + res.stop_reason);
  log('claude tokens in/out', res.usage.input_tokens, res.usage.output_tokens);
  return res.parsed_output;
}
const fin = (x) => (x == null ? null : isFinite(x) ? r3(x) : 'inf');
const forClaude = (m, rule, st, cfg) => ({
  id: m.id, name: m.name, status: m.status === 9 ? 'active' : 'paused', payType: m.payType,
  bidRub: m.nms.length ? R(Math.max(...m.nms.map((n) => Math.max(n.search, n.recom))) / 100) : null,
  views: m.views, clicks: m.clicks, cart: m.cart, ctr: r3(m.ctr), ordersPerClick: r3(m.cr),
  spend30: R(m.w30.spend), orders30: m.w30.orders, spend14: R(m.w14.spend), orders14: m.w14.orders, spend7: R(m.w7.spend), orders7: m.w7.orders,
  drr30: fin(m.drr30), drr14: fin(m.drr14), drr7: fin(m.drr7), margin: r3(m.margin), target: r3(m.target), noCogs: m.noCogs,
  stock: m.stock, stockDays: isFinite(m.stockDays) ? R(m.stockDays) : null, rating: m.rating ? Math.round(m.rating * 100) / 100 : null, budgetLeft: m.budget,
  stopAllowed: !!stopReason(m, cfg), rule: { action: rule.action, bidPct: Math.abs(rule.bidPct) },
  lastActions: (st.recent || []).map((a) => a.t.slice(0, 10) + ' ' + a.action + (a.bidPct ? ' ' + a.bidPct + '%' : '')),
});

/* ------------------------------ New campaigns ------------------------------ */
// Profitable goods without ads. A launch must stay in profit: margin before ads at least minMargin
// (the bid rules then hold ДРР at targetShare of it), enough stock in days of sales so the ad push
// does not empty the shelf, decent rating, and never a SKU whose agent-launched campaign was closed.
export function launchCandidates(storeName, storeId, campaigns, econ, market, cfg, closedSkus = new Set()) {
  const busy = new Set();
  campaigns.forEach((c) => c.nms.forEach((n) => busy.add(String(n.nm))));
  closedSkus.forEach((s) => busy.add(String(s)));
  const out = [];
  econ.forEach((e, k) => {
    if (e.store !== storeId || busy.has(String(e.sku)) || e.noCogs) return;
    const stock = ((market.stocks || {})[k] || {}).q || 0, rv = (market.reviews || {})[k];
    if (stock < cfg.launch.minStock || e.q < cfg.launch.minSales30 || e.margin == null || e.margin < cfg.launch.minMargin) return;
    const stockDays = stock / (e.q / 30);
    if (stockDays < cfg.launch.minStockDays) return;
    if (rv && rv.n >= 5 && rv.avg < cfg.launch.minRating) return;
    out.push({ key: k, sku: e.sku, name: e.name, margin: e.margin, profit: e.np - e.adv, stock, q: e.q, stockDays: Math.round(stockDays) });
  });
  return out.sort((a, b) => b.profit - a.profit).slice(0, cfg.launch.maxPerRun);
}

/* ------------------------------ Run ------------------------------ */
export async function run({ cfg, data, market, state, apis, now = Date.now(), claude = null }) {
  const live = cfg.mode === 'live';
  const today = new Date(now + 3 * 3600e3).toISOString().slice(0, 10);
  const econ = skuEconomics(data);
  const out = { generated: new Date(now).toISOString(), mode: cfg.mode, engine: 'rules', dataAsOf: market.generated, summary: '', campaigns: [], actions: [], errors: [] };
  const hist = state.history || [], camp = state.camp || {}, deposits = state.deposits || {};
  const metrics = [], byId = new Map();
  const mins = new Map();
  // New campaigns: at most launch.maxTotal ever launched by the agent (counted from its history)
  const launchedOk = hist.filter((a) => a.action === 'launch' && a.result === 'ok');
  const closedSkus = new Set(launchedOk.filter((a) => hist.some((h) => h.action === 'stop' && h.result === 'ok' && h.id === a.id)).map((a) => a.sku));
  let launchLeft = Math.max(0, (cfg.launch.maxTotal ?? Infinity) - launchedOk.length);

  for (const sid of cfg.stores) {
    const api = apis[sid], store = data.stores.find((s) => s.id === sid);
    if (!api || !store) { out.errors.push(sid + ': нет токена WB — магазин пропущен'); continue; }
    let list;
    try { list = await api.list(); } catch (e) { out.errors.push(sid + ': ' + e.message); continue; }
    const ctx = { cfg, econ, market, today, storeId: sid, storeName: store.name };
    list.forEach((c) => {
      const m = campaignMetrics(c, (market.ads || []).find((a) => a.s === sid && a.id === c.id), ctx);
      metrics.push(m); byId.set(m.id, m);
    });
    // New campaigns for profitable goods that are not advertised yet
    if (cfg.launch.enabled) {
      for (const cand of launchCandidates(store.name, sid, list, econ, market, cfg, closedSkus)) {
        if (launchLeft <= 0) break;
        launchLeft--;
        const act = { t: out.generated, store: sid, action: 'launch', key: cand.key, sku: cand.sku, name: cand.name, reason: 'Товар без рекламы: маржа до рекламы ' + pct(cand.margin) + ', ' + cand.q + ' продаж за 30 дней, на складе ' + cand.stock + ' шт. (на ' + cand.stockDays + ' дн.). Запускаю кампанию с бюджетом ' + rub(cfg.launch.budget) + ', целевой ДРР до ' + pct(Math.min(cfg.maxDrr, cfg.targetShare * cand.margin)) + '.' };
        if (live) {
          try {
            const id = await api.create(('AI ' + cand.sku + ' ' + cand.name).slice(0, 60), [+cand.sku], cfg.launch.paymentType);
            act.id = +id || (id && (id.id || id.advertId)) || null;
            await sleep(3000);
            if (act.id) { await api.deposit(act.id, cfg.launch.budget, cfg.budget.source); await sleep(1500); await api.start(act.id); }
            act.result = 'ok';
          } catch (e) { act.result = 'error'; act.error = e.message; }
        } else act.result = 'planned';
        out.actions.push(act);
      }
    }
  }

  // Decisions, biggest spenders first so the per-run stop limit goes to the costliest losers
  metrics.sort((a, b) => b.w30.spend - a.w30.spend);
  const stOf = (id) => { const c = camp[id] || {}; return { ...c, recent: hist.filter((h) => h.id === id).slice(-4) }; };
  const rules = new Map(metrics.map((m) => [m.id, ruleDecision(m, cfg, stOf(m.id))]));
  let proposed = rules;
  const forLlm = metrics.filter((m) => m.status === 9);
  if (claude && forLlm.length) {
    try {
      const plan = await claude(forLlm.map((m) => forClaude(m, rules.get(m.id), stOf(m.id), cfg)), cfg);
      proposed = new Map(rules);
      plan.decisions.forEach((d) => { if (byId.has(d.id) && byId.get(d.id).status === 9) proposed.set(d.id, d); });
      out.engine = 'claude'; out.summary = plan.summary;
    } catch (e) { out.errors.push('Claude недоступен, решения приняты по правилам: ' + e.message.slice(0, 200)); }
  }

  let stops = 0;
  for (const m of metrics) {
    const st = stOf(m.id), api = apis[m.store];
    let dec = guard(proposed.get(m.id), m, cfg, st, now);
    if (dec.action === 'stop' && ++stops > cfg.stop.maxPerRun) dec = { ...dec, action: 'keep', blocked: 'лимит закрытий за один запуск (' + cfg.stop.maxPerRun + ')' };
    const row = { id: m.id, store: m.store, name: m.name, status: m.status, spend30: R(m.w30.spend), orders30: m.w30.orders, drr30: fin(m.drr30), drr14: fin(m.drr14), margin: r3(m.margin), target: r3(m.target), stock: m.stock, action: dec.action, bidPct: dec.bidPct || 0, reason: dec.reason, blocked: dec.blocked };
    out.campaigns.push(row);

    // Top up a campaign that earns and is about to run dry
    if (cfg.budget.autoTopUp && dec.action !== 'stop' && dec.action !== 'pause' && m.status === 9 && m.budget != null && m.target != null && m.drr30 != null && m.drr30 <= m.target && m.budget < Math.max(m.spendPerDay, 100)) {
      const spent = deposits[today] || 0;
      if (spent + cfg.budget.topUpSum <= cfg.budget.dailyCap) {
        const act = { t: out.generated, store: m.store, id: m.id, name: m.name, key: m.skus[0], action: 'topup', sum: cfg.budget.topUpSum, reason: 'Кампания окупается (ДРР ' + pct(m.drr30) + ' при цели ' + pct(m.target) + '), бюджета осталось ' + rub(m.budget) + ' — пополняю на ' + rub(cfg.budget.topUpSum) + '.' };
        if (live) { try { await api.deposit(m.id, cfg.budget.topUpSum, cfg.budget.source); act.result = 'ok'; deposits[today] = spent + cfg.budget.topUpSum; } catch (e) { act.result = 'error'; act.error = e.message; } } else act.result = 'planned';
        out.actions.push(act);
      }
    }
    if (dec.action === 'keep') continue;

    const act = { t: out.generated, store: m.store, id: m.id, name: m.name, key: m.skus[0], action: dec.action, bidPct: dec.bidPct || 0, reason: dec.reason };
    if (dec.action === 'lower' || dec.action === 'raise') {
      if (!mins.has(m.id)) mins.set(m.id, await api.minBids(m));   // read-only, so the dry-run plan shows real bids
      const items = newBids(m, dec.bidPct, cfg, mins.get(m.id));
      if (!items.length) { row.action = 'keep'; row.blocked = dec.action === 'lower' ? 'ставка уже минимальная' : 'ставка уже на верхнем пределе'; continue; }
      act.bids = items.map((x) => ({ nm: x.nm, placement: x.placement, wasRub: x.was / 100, rub: x.kop / 100 }));
      if (live) { try { await api.setBids(m.id, items); act.result = 'ok'; } catch (e) { act.result = 'error'; act.error = e.message; } } else act.result = 'planned';
    } else if (live) {
      try { await api[dec.action === 'resume' ? 'start' : dec.action](m.id); act.result = 'ok'; } catch (e) { act.result = 'error'; act.error = e.message; }
    } else act.result = 'planned';
    row.result = act.result;
    out.actions.push(act);
    if (act.result === 'ok') {
      const c = (camp[m.id] = camp[m.id] || {});
      if (act.bids) c.lastBidAt = now;
      if (dec.action === 'pause') c.pausedByAgent = true;
      if (dec.action === 'resume' || dec.action === 'stop') delete c.pausedByAgent;
    }
    if (live) await sleep(250);
  }

  out.actions.filter((a) => a.result === 'ok' || a.result === 'error').forEach((a) => hist.push(a));
  const n = (a) => out.actions.filter((x) => x.action === a && x.result !== 'error').length;
  const failed = out.actions.filter((x) => x.result === 'error');
  const auto = 'Кампаний под управлением: ' + metrics.filter((m) => m.status === 9).length + ' активных, ' + metrics.filter((m) => m.status === 11).length + ' на паузе. ' +
    (out.actions.length ? 'Решения: ставка снижена — ' + n('lower') + ', повышена — ' + n('raise') + ', закрыто — ' + n('stop') + ', пауза — ' + n('pause') + ', включено — ' + n('resume') + ', пополнено — ' + n('topup') + ', запущено новых — ' + n('launch') + '.' : 'Изменений не требуется.') +
    (live ? '' : ' Режим проверки: в кабинете WB ничего не менялось.') +
    (failed.length ? ' Не выполнено из-за ошибок WB: ' + failed.length + (failed.some((x) => /read-only/i.test(x.error || '')) ? ' — токен WB только на чтение, нужен токен «Продвижение» с правом записи.' : '.') : '');
  out.summary = out.summary ? out.summary + ' ' + (live ? '' : 'Режим проверки: в кабинете WB ничего не менялось.') : auto;
  out.campaigns.sort((a, b) => (a.action === 'keep') - (b.action === 'keep') || b.spend30 - a.spend30);
  return { ...out, history: hist.slice(-400), camp, deposits: Object.fromEntries(Object.entries(deposits).slice(-14)) };
}

/* ------------------------------ CLI ------------------------------ */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const env = (k) => (process.env[k] || '').trim();
  const cfg = mergeConfig(readJson('ads-agent.config.json', {}));
  if (env('ADS_AGENT_MODE')) cfg.mode = env('ADS_AGENT_MODE');
  if (cfg.mode !== 'live') cfg.mode = 'dry-run';
  const data = readJson('data.json'), market = readJson('market.json');
  if (!data || !market) { console.error('data.json / market.json not found — run update.mjs and api.mjs first'); process.exit(1); }
  const tokens = { wb1: env('WB_SAKOVSKY_TOKEN'), wb2: env('WB_DARMIL_TOKEN') };
  const apis = {};
  Object.entries(tokens).forEach(([sid, t]) => { if (t) apis[sid] = wbApi(t); });
  if (!Object.keys(apis).length) { console.error('No WB tokens (WB_SAKOVSKY_TOKEN / WB_DARMIL_TOKEN)'); process.exit(1); }
  const useClaude = cfg.llm.enabled && (env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN'));
  log('ads agent: mode', cfg.mode, '| decisions by', useClaude ? cfg.llm.model : 'rules (no ANTHROPIC_API_KEY)');
  const out = await run({ cfg, data, market, state: readJson('ads-agent.json', {}), apis, claude: useClaude ? askClaude : null });
  writeFileSync(new URL('./ads-agent.json', import.meta.url), JSON.stringify(out));
  log('\n' + out.summary);
  out.actions.forEach((a) => log(' ', a.result, a.store, a.id || a.sku, a.action, a.bidPct ? a.bidPct + '%' : '', '|', a.reason, a.error ? '| ' + a.error : ''));
  out.errors.forEach((e) => log('  ERR', e));
  if (out.errors.length && !out.campaigns.length) process.exit(1);
}
