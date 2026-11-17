// AI agent that manages ad campaigns on Wildberries and Ozon: reads conversion metrics and unit economics,
// decides per campaign (keep / raise bid / lower bid / pause / stop / top up / launch new), removes search
// queries that burn money, picks products worth advertising, and applies all of it through the marketplaces' APIs.
// It measures what its past actions did to profit and learns from that (ads-brain.mjs, ads-memory.json).
//
// Inputs:  market.json (WB ad stats, stocks, funnel, reviews — written by api.mjs), data.json (profit per SKU, Торгстат),
//          ads-agent.config.json (limits), ads-agent.json (own history), ads-memory.json (lessons, outcomes, tuned thresholds).
// Output:  ads-agent.json — the plan, what was actually done and the action history (shown in the dashboard).
//
// Decisions: a Claude team (lead + helpers it briefs) when ANTHROPIC_API_KEY is set; otherwise the built-in rules.
// Either way every decision passes the same hard limits in guard() before anything is sent to a marketplace.
// mode "dry-run" only writes the plan; mode "live" changes campaigns for real. Ozon has its own switch: ozon.mode.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ozonApi, ozonBids } from './ozon-ads.mjs';
import { loadMemory, applyTuning, tune, snapshot, evaluateOutcomes, autoTune, learnedView, makeBrain } from './ads-brain.mjs';

const DAY = 864e5;
const R = (x) => Math.round(+x || 0);
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const readJson = (name, fallback) => { try { return JSON.parse(readFileSync(new URL('./' + name, import.meta.url), 'utf8')); } catch (e) { return fallback; } };

export const DEFAULTS = {
  mode: 'dry-run', stores: ['wb1', 'wb2', 'oz1', 'oz2'], protect: [],
  targetShare: 0.6, maxDrr: 0.25, minSpend: 1500, minClicks: 150,
  stop: { noOrdersSpend: 3000, overMarginFactor: 1.4, maxPerRun: 5 },
  bid: { maxStepPct: 25, upStepPct: 15, cooldownHours: 24, maxCpmKop: 100000, maxCpcKop: 5000, minOrdersToRaise: 5, minStockDaysToRaise: 14 },
  stock: { pauseWhenOut: true, resumeDays: 5 },
  budget: { autoTopUp: false, topUpSum: 1000, dailyCap: 5000, source: 1 },
  launch: { enabled: false, maxPerRun: 1, maxTotal: 5, budget: 1000, minStock: 30, minStockDays: 45, minMargin: 0.25, minSales30: 10, minRating: 4.5, minHeadroom: 1.3, paymentType: 'cpm' },
  // Search-query cleanup (WB): exclude clusters that took clicks and money and brought no orders
  queries: { enabled: true, maxCampaigns: 20, minClicks: 20, minSpend: 200, irrelevantMinSpend: 50, costFactor: 2, maxPerCampaign: 15, cooldownDays: 3 },
  // Ozon «Оплата за клик». Its own mode: stays "dry-run" until the owner has seen a plan built from real Ozon data.
  ozon: { mode: 'dry-run', maxCpcRub: 60, maxDropsPerRun: 5, launch: { enabled: false, maxPerRun: 1, maxTotal: 3, weeklyBudget: 3500 } },
  llm: { enabled: true, model: 'claude-opus-5-5', effort: 'medium', leadEffort: 'high', helperEffort: 'medium', maxHelpers: 5 },
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (base, over) => { for (const [k, v] of Object.entries(over || {})) { if (isObj(v) && isObj(base[k])) deepMerge(base[k], v); else base[k] = v; } return base; };
export const mergeConfig = (user) => deepMerge(structuredClone(DEFAULTS), user);

/* ------------------------------ WB Promotion API ------------------------------ */
// Docs: https://dev.wildberries.ru/openapi/promotion  (token category «Продвижение», with write access for live mode)
const WB = 'https://advert-api.wildberries.ru';
async function http(token, method, path, body, tries = 4) {
  for (let i = 1; ; i++) {
    const r = await fetch(WB + path, { method, headers: { Authorization: token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 429 && i < tries) { await sleep(15000 * i); continue; }
    if (r.status >= 500 && i < tries) { await sleep(4000 * i); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + method + ' ' + path.replace(/\?.*/, '') + ' ' + t.slice(0, 400));
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return t; }
  }
}
// Campaign as the agent sees it, whatever exact shape WB answered with
export function normCampaign(a) {
  if (a.advertId && a.settings && a.settings.paymentType && Array.isArray(a.nms)) {      // /api/advert/v3/adverts
    const pl = a.settings.placements || [];
    const nms = a.nms.map((n) => { const b = Object.fromEntries((n.bids || []).map((x) => [x.type, R(x.value)])); return { nm: n.nmId, search: b.combined || b.search || 0, recom: b.combined ? 0 : (b.recommendations || 0), unified: !!b.combined }; }).filter((n) => n.nm);
    const unified = pl.includes('combined') || nms.some((n) => n.unified);
    return { platform: 'wb', id: a.advertId, name: a.settings.name || '', status: a.status, bidType: unified ? 'unified' : 'manual', payType: a.settings.paymentType, search: unified || pl.includes('search'), recom: unified || pl.includes('recommendations'), nms };
  }
  const s = a.settings || {};
  const pl = s.placements || a.placements || {};
  return {
    platform: 'wb', id: a.id || a.advertId || a.advert_id,
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
  // v3 is the current method; v2 (switched off by WB on 10 January) stays as a fallback while both exist
  const info = async (ids, v3) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await call('GET', (v3 ? '/api/advert/v3/adverts?advertIds=' : '/api/advert/v2/adverts?ids=') + ids.slice(i, i + 50).join(','));
      const arr = Array.isArray(j) ? j : (j && (j.adverts || j.data)) || [];
      if (i === 0) log('  campaign sample', v3 ? 'v3' : 'v2', JSON.stringify(arr[0] || j).slice(0, 700));
      arr.forEach((a) => out.push(normCampaign(a)));
      await sleep(300);
    }
    return out;
  };
  const chunks = async (items, size, pause, fn) => { const out = []; for (let i = 0; i < items.length; i += size) { if (i) await sleep(pause); out.push(await fn(items.slice(i, i + size))); } return out; };
  return {
    platform: 'wb',
    async list() {
      const cnt = await call('GET', '/adv/v1/promotion/count');
      const ids = [];
      ((cnt && cnt.adverts) || []).forEach((g) => { if ([4, 9, 11].includes(g.status)) (g.advert_list || []).forEach((a) => ids.push(a.advertId)); });
      if (!ids.length) return [];
      try { const out = await info(ids, true); if (out.length) return out; } catch (e) { log('  adverts v3:', e.message.slice(0, 160)); }
      return info(ids, false);
    },
    // Search clusters of [{ advert_id, nm_id }] for a period (cpm campaigns only): [{ advert_id, nm_id, stats: [...] }]
    async clusters(items, from, to) { return (await chunks(items, 100, 6500, (part) => call('POST', '/adv/v0/normquery/stats', { from, to, items: part }))).flatMap((j) => (j && j.stats) || []); },
    async getMinus(items) { return (await chunks(items, 100, 300, (part) => call('POST', '/adv/v0/normquery/get-minus', { items: part }))).flatMap((j) => (j && j.items) || []); },
    // Replaces the whole minus list of one product in one campaign, so always send existing + new
    setMinus: (id, nm, list) => call('POST', '/adv/v0/normquery/set-minus', { advert_id: id, nm_id: nm, norm_queries: list }),
    // Lowest bid WB accepts, kopecks: { nm: { search, recom, combined } }
    async minBids(c) {
      const res = {};
      try {
        // Placements from the bids the products actually have; the campaign's own placement list can be empty
        let types = c.bidType === 'unified' ? ['combined'] : [(c.search || c.nms.some((n) => n.search)) && 'search', (c.recom || c.nms.some((n) => n.recom)) && 'recommendation'].filter(Boolean);
        if (!types.length) types = c.nms.some((n) => n.search || n.recom) ? ['search'] : ['combined'];
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
    create: (name, nms, payType) => call('POST', '/adv/v2/seacat/save-ad', { name, nms, bid_type: 'unified', payment_type: payType }),   // placement_types is for custom-bid campaigns only
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
    id: c.id, uid: ctx.storeId + ':' + c.id, platform: c.platform || 'wb', strategy: c.strategy || null, noBudget: !!c.noBudget,
    store: ctx.storeId, name: c.name || (ad && ad.name) || '', status: c.status, payType: c.payType, bidType: c.bidType,
    days: (ad && ad.days) || [], skuStats: (ad && ad.sku) || null,
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

/* ------------------------------ Rows for the Claude team ------------------------------ */
const fin = (x) => (x == null ? null : isFinite(x) ? r3(x) : 'inf');
const bidRubOf = (m) => (m.nms.length ? R(Math.max(...m.nms.map((n) => (m.platform === 'ozon' ? n.search / (n.unit || 1) : Math.max(n.search, n.recom) / 100)))) : null);
const forClaude = (m, rule, st, cfg) => ({
  uid: m.uid, name: m.name, platform: m.platform, strategy: m.strategy || m.bidType, status: m.status === 9 ? 'active' : 'paused', payType: m.payType,
  bidRub: bidRubOf(m), targetCirPct: m.platform === 'ozon' ? (m.nms.find((n) => n.cir) || {}).cir || null : undefined,
  views: m.views, clicks: m.clicks, cart: m.cart, ctr: r3(m.ctr), ordersPerClick: r3(m.cr),
  spend30: R(m.w30.spend), orders30: m.w30.orders, spend14: R(m.w14.spend), orders14: m.w14.orders, spend7: R(m.w7.spend), orders7: m.w7.orders,
  drr30: fin(m.drr30), drr14: fin(m.drr14), drr7: fin(m.drr7), margin: r3(m.margin), target: r3(m.target), noCogs: m.noCogs,
  stock: m.stock, stockDays: isFinite(m.stockDays) ? R(m.stockDays) : null, rating: m.rating ? Math.round(m.rating * 100) / 100 : null, budgetLeft: m.budget,
  stopAllowed: !!stopReason(m, cfg), rule: { action: rule.action, bidPct: Math.abs(rule.bidPct) },
  lastActions: (st.recent || []).map((a) => a.t.slice(0, 10) + ' ' + a.action + (a.bidPct ? ' ' + a.bidPct + '%' : '')),
  days: m.days.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30).map((d) => [d[0], R(d[1]), R(d[2]), R(d[3])]),
});

/* ------------------------------ Search queries (WB) ------------------------------ */
// Code can prove waste, not irrelevance: "waste" and "costly" are excluded on numbers alone,
// "check" (spend, no orders, too little data) goes to a helper that reads the query against the product.
export function classifyCluster(c, orderProfit, q) {
  if (!c.orders && c.clicks >= q.minClicks && c.spend >= Math.max(q.minSpend, orderProfit || 0)) return 'waste';
  if (c.orders && orderProfit > 0 && c.spend >= q.minSpend * 3 && c.spend / c.orders > orderProfit * q.costFactor) return 'costly';
  if (!c.orders && c.spend >= q.irrelevantMinSpend) return 'check';
  return null;
}
async function loadClusters(api, ms, ctx, camp, now) {
  const { cfg, econ, market, storeName, today } = ctx, q = cfg.queries;
  const pick = ms.filter((m) => m.status === 9 && m.payType === 'cpm' && m.w30.spend > 0 && !cfg.protect.map(String).includes(String(m.id)) && !((camp[m.id] || {}).lastMinusAt > now - q.cooldownDays * DAY))
    .sort((a, b) => b.w30.spend - a.w30.spend).slice(0, q.maxCampaigns);
  const nmsOf = (m) => { const withSpend = new Set(m.skus.map((k) => k.split('|')[1])); const l = m.nms.filter((n) => withSpend.has(String(n.nm))); return (l.length ? l : m.nms).slice(0, 5); };
  const items = pick.flatMap((m) => nmsOf(m).map((n) => ({ advert_id: m.id, nm_id: n.nm })));
  if (!items.length) return [];
  const stats = await api.clusters(items, new Date(Date.parse(today) - 29 * DAY).toISOString().slice(0, 10), today);
  const minus = await api.getMinus(items);
  const key = (a, n) => a + '|' + n, sMap = new Map(stats.map((x) => [key(x.advert_id, x.nm_id), x.stats || []])), mMap = new Map(minus.map((x) => [key(x.advert_id, x.nm_id), x.norm_queries || []]));
  return pick.map((m) => ({
    uid: m.uid, name: m.name, m,
    items: nmsOf(m).map((n) => {
      const k = storeName + '|' + n.nm, e = econ.get(k), f = (market.funnel || {})[k];
      const orderProfit = e && e.q > 0 ? ((e.np - e.adv) / e.q) * (f && f.bp ? clamp(f.bp / 100, 0.3, 1) : 0.9) : 0;
      const existing = mMap.get(key(m.id, n.nm)) || [], gone = new Set(existing);
      const all = (sMap.get(key(m.id, n.nm)) || []).filter((c) => c.norm_query && !gone.has(c.norm_query)).map((c) => {
        const x = { q: c.norm_query, views: R(c.views), clicks: R(c.clicks), atbs: R(c.atbs), orders: R(c.orders), spend: R(c.spend != null ? c.spend : c.cpc != null ? c.cpc * c.clicks : (c.cpm || 0) * (c.views || 0) / 1000) };
        x.flag = classifyCluster(x, orderProfit, q); return x;
      });
      const best = all.filter((c) => c.orders && !c.flag).sort((a, b) => b.orders - a.orders).slice(0, 5).map((c) => ({ ...c, flag: 'good' }));
      return { nm: n.nm, key: k, product: (e && e.name) || '', orderProfit: R(orderProfit), existing, clusters: all.filter((c) => c.flag).sort((a, b) => b.spend - a.spend).slice(0, 40).concat(best) };
    }).filter((i) => i.clusters.length),
  })).filter((v) => v.items.length);
}
// Queries to exclude in one campaign: proven by code + proposed by a helper and confirmed by the numbers
export function planMinus(view, proposed, cfg) {
  const asked = new Set((proposed || []).filter((p) => p.uid === view.uid).flatMap((p) => p.queries.map((x) => p.nm + '|' + x)));
  let left = cfg.queries.maxPerCampaign;
  return view.items.map((i) => {
    const add = i.clusters.filter((c) => c.flag === 'waste' || c.flag === 'costly' || (c.flag === 'check' && asked.has(i.nm + '|' + c.q))).slice(0, Math.max(0, left));
    left -= add.length;
    return { nm: i.nm, key: i.key, existing: i.existing, add };
  }).filter((p) => p.add.length);
}

/* ------------------------------ New campaigns ------------------------------ */
// What ads in this store cost and convert on average — the base for estimating a product that has no ads yet
export function accountAvg(ads) {
  const s = (ads || []).reduce((a, x) => { a.views += x.views || 0; a.clicks += x.clicks || 0; a.spend += x.spend || 0; a.orders += x.orders || 0; return a; }, { views: 0, clicks: 0, spend: 0, orders: 0 });
  return s.clicks >= 200 && s.spend > 0 ? { ctr: s.views ? s.clicks / s.views : null, cpc: s.spend / s.clicks, cr: s.orders / s.clicks } : null;
}
const AD_TRAFFIC = 0.7;   // an ad click converts worse than a visitor who found the card himself
// Profitable goods without ads, ranked by what 1000 ₽ of ads is expected to bring.
// Filters: margin before ads, stock in days of sales, rating, never a SKU whose agent-launched campaign was closed.
// Estimate: clicks bought for 1000 ₽ (store's average click price) × the card's own conversion to order
// × buyout × profit per sale. Launch needs that return to beat the click price by launch.minHeadroom.
export function launchCandidates(storeName, storeId, campaigns, econ, market, cfg, closedSkus = new Set(), avg = null) {
  const busy = new Set();
  campaigns.forEach((c) => c.nms.forEach((n) => busy.add(String(n.nm))));
  closedSkus.forEach((s) => busy.add(String(s)));
  const out = [];
  econ.forEach((e, k) => {
    if (e.store !== storeId || busy.has(String(e.sku)) || e.noCogs) return;
    const stock = ((market.stocks || {})[k] || {}).q || 0, rv = (market.reviews || {})[k], f = (market.funnel || {})[k];
    if (stock < cfg.launch.minStock || e.q < cfg.launch.minSales30 || e.margin == null || e.margin < cfg.launch.minMargin) return;
    const stockDays = stock / (e.q / 30);
    if (stockDays < cfg.launch.minStockDays) return;
    if (rv && rv.n >= 5 && rv.avg < cfg.launch.minRating) return;
    const unitProfit = (e.np - e.adv) / e.q, buyout = f && f.bp ? clamp(f.bp / 100, 0.3, 1) : 0.9;
    const own = f && f.v >= 200 && f.o ? (f.o / f.v) * AD_TRAFFIC : null, cr = own || (avg && avg.cr) || null, cpc = (avg && avg.cpc) || null;
    let headroom = null, per1000 = null;
    if (cr && cpc) { headroom = (cr * buyout * unitProfit) / cpc; per1000 = R((1000 / cpc) * cr * buyout * unitProfit - 1000); if (headroom < cfg.launch.minHeadroom) return; }
    out.push({ key: k, sku: e.sku, name: e.name, margin: e.margin, profit: e.np - e.adv, stock, q: e.q, stockDays: Math.round(stockDays), unitProfit: R(unitProfit), cr: r3(cr), crFrom: own ? 'card' : cr ? 'store' : null, cpc: cpc ? Math.round(cpc * 10) / 10 : null, headroom: headroom == null ? null : Math.round(headroom * 100) / 100, per1000, rating: rv && rv.n ? rv.avg : null });
  });
  return out.sort((a, b) => (b.per1000 ?? -Infinity) - (a.per1000 ?? -Infinity) || b.profit - a.profit);
}

/* ------------------------------ Run ------------------------------ */
export async function run({ cfg: cfg0, data, market, state = {}, memory: mem0 = null, apis, now = Date.now(), brain = null }) {
  const memory = loadMemory(mem0);
  const cfg = applyTuning(cfg0, memory);       // the owner's limits with the agent's own tuned thresholds on top
  const today = new Date(now + 3 * 3600e3).toISOString().slice(0, 10);
  const econ = skuEconomics(data);
  const out = { generated: new Date(now).toISOString(), mode: cfg.mode, ozonMode: cfg.ozon.mode, engine: 'rules', dataAsOf: market.generated, summary: '', campaigns: [], actions: [], errors: [], notes: [] };
  const hist = state.history || [], camp = state.camp || {}, deposits = state.deposits || {};
  const platOf = (sid) => (apis[sid] && apis[sid].platform) || (String(sid).startsWith('oz') ? 'ozon' : 'wb');
  const live = (sid) => (platOf(sid) === 'ozon' ? cfg.ozon.mode : cfg.mode) === 'live';
  const ck = (m) => (m.platform === 'ozon' ? m.uid : m.id);
  const stOf = (m) => ({ ...(camp[ck(m)] || {}), recent: hist.filter((h) => h.id === m.id && h.store === m.store).slice(-4) });
  const mark = (m, patch) => { camp[ck(m)] = { ...(camp[ck(m)] || {}), ...patch }; };
  const metrics = [], byUid = new Map(), pool = [], views = [], storeName = {};
  // New campaigns: at most launch.maxTotal ever launched by the agent on each marketplace (counted from its history)
  const launchedOk = hist.filter((a) => a.action === 'launch' && a.result === 'ok');
  const closedSkus = new Set(launchedOk.filter((a) => hist.some((h) => h.action === 'stop' && h.result === 'ok' && h.id === a.id)).map((a) => String(a.sku)));
  const launchCfg = (p) => (p === 'ozon' ? { ...cfg.launch, ...cfg.ozon.launch } : cfg.launch);
  const launchLeft = Object.fromEntries(['wb', 'ozon'].map((p) => [p, Math.max(0, (launchCfg(p).maxTotal ?? Infinity) - launchedOk.filter((a) => platOf(a.store) === p).length)]));

  // 1. Read every ad account
  const noOzonKey = [];
  for (const sid of cfg.stores) {
    const api = apis[sid], store = data.stores.find((s) => s.id === sid);
    if (!store) continue;
    storeName[sid] = store.name;
    if (!api) { if (platOf(sid) === 'ozon') noOzonKey.push(store.name); else out.errors.push(sid + ': нет токена WB — магазин пропущен'); continue; }
    let list, stats = null;
    try { list = await api.list(); if (api.stats) stats = await api.stats(list, today); } catch (e) { out.errors.push(store.name + ': ' + e.message); continue; }
    const ctx = { cfg, econ, market, today, storeId: sid, storeName: store.name };
    const adOf = (id) => (stats ? stats.get(id) : (market.ads || []).find((a) => a.s === sid && a.id === id));
    const mine = list.map((c) => campaignMetrics(c, adOf(c.id), ctx));
    mine.forEach((m) => { metrics.push(m); byUid.set(m.uid, m); });
    const L = launchCfg(platOf(sid));
    if (L.enabled) launchCandidates(store.name, sid, list, econ, market, { ...cfg, launch: L }, closedSkus, accountAvg(stats ? [...stats.values()] : (market.ads || []).filter((a) => a.s === sid))).slice(0, L.maxPerRun * 3).forEach((c) => pool.push({ ...c, store: sid, platform: platOf(sid) }));
    if (cfg.queries.enabled && api.clusters) { try { (await loadClusters(api, mine, ctx, camp, now)).forEach((v) => views.push(v)); } catch (e) { out.errors.push(store.name + ': поисковые запросы не получены — ' + e.message.slice(0, 200)); } }
  }
  if (noOzonKey.length) out.notes.push('Ozon (' + noOzonKey.join(', ') + '): нет ключа Performance API — реклама Ozon пока не управляется.');

  // 2. Learn from what past actions did, before deciding anything new
  const fresh = evaluateOutcomes(memory, hist, (a) => byUid.get(a.store + ':' + a.id), now);
  const tuned = autoTune(memory, cfg, now);

  // 3. Decide: rules as the baseline, the Claude team on top when it is available
  metrics.sort((a, b) => b.w30.spend - a.w30.spend);     // biggest spenders first, so the per-run stop limit goes to the costliest losers
  const rules = new Map(metrics.map((m) => [m.uid, ruleDecision(m, cfg, stOf(m))]));
  let proposed = rules, plan = null;
  const forLlm = metrics.filter((m) => m.status === 9);
  if (brain && (forLlm.length || pool.length)) {
    try {
      plan = await brain({
        rows: forLlm.map((m) => forClaude(m, rules.get(m.uid), stOf(m), cfg)),
        clusters: views.map((v) => ({ uid: v.uid, name: v.name, items: v.items.map(({ existing, key, ...i }) => ({ ...i, alreadyExcluded: existing.length })) })),
        candidates: pool.map(({ profit, ...c }) => ({ ...c, margin: r3(c.margin), profit30: R(profit) })),
        memory, limits: { maxStepPct: cfg.bid.maxStepPct, upStepPct: cfg.bid.upStepPct, cooldownHours: cfg.bid.cooldownHours, minSpend: cfg.minSpend, targetShare: cfg.targetShare, maxDrr: cfg.maxDrr },
      });
      proposed = new Map(rules);
      (plan.decisions || []).forEach((d) => { const m = byUid.get(d.uid); if (m && m.status === 9) proposed.set(d.uid, { id: m.id, action: d.action, bidPct: d.bidPct, reason: d.reason }); });
      out.engine = 'claude'; out.summary = plan.summary || '';
    } catch (e) { plan = null; out.errors.push('Claude недоступен, решения приняты по правилам: ' + e.message.slice(0, 200)); }
  }

  // 4. Apply campaign decisions through the hard limits
  const done = async (act, sid, fn) => { if (!live(sid)) { act.result = 'planned'; return; } try { await fn(); act.result = 'ok'; } catch (e) { act.result = 'error'; act.error = e.message; } };
  const rowOf = new Map();
  let stops = 0;
  for (const m of metrics) {
    const st = stOf(m), api = apis[m.store];
    let dec = guard(proposed.get(m.uid), m, cfg, st, now);
    if (dec.action === 'stop' && ++stops > cfg.stop.maxPerRun) dec = { ...dec, action: 'keep', blocked: 'лимит закрытий за один запуск (' + cfg.stop.maxPerRun + ')' };
    const row = { id: m.id, store: m.store, platform: m.platform, name: m.name, status: m.status, spend30: R(m.w30.spend), orders30: m.w30.orders, drr30: fin(m.drr30), drr14: fin(m.drr14), margin: r3(m.margin), target: r3(m.target), stock: m.stock, action: dec.action, bidPct: dec.bidPct || 0, reason: dec.reason, blocked: dec.blocked };
    out.campaigns.push(row); rowOf.set(m.uid, row);

    // Top up a campaign that earns and is about to run dry (WB)
    if (cfg.budget.autoTopUp && api.deposit && dec.action !== 'stop' && dec.action !== 'pause' && m.status === 9 && m.budget != null && m.target != null && m.drr30 != null && m.drr30 <= m.target && m.budget < Math.max(m.spendPerDay, 100)) {
      const spent = deposits[today] || 0;
      if (spent + cfg.budget.topUpSum <= cfg.budget.dailyCap) {
        const act = { t: out.generated, store: m.store, id: m.id, name: m.name, key: m.skus[0], action: 'topup', sum: cfg.budget.topUpSum, reason: 'Кампания окупается (ДРР ' + pct(m.drr30) + ' при цели ' + pct(m.target) + '), бюджета осталось ' + rub(m.budget) + ' — пополняю на ' + rub(cfg.budget.topUpSum) + '.' };
        await done(act, m.store, () => api.deposit(m.id, cfg.budget.topUpSum, cfg.budget.source));
        if (act.result === 'ok') deposits[today] = spent + cfg.budget.topUpSum;
        out.actions.push(act);
      }
    }
    if (dec.action === 'keep') continue;

    const act = { t: out.generated, store: m.store, platform: m.platform, id: m.id, name: m.name, key: m.skus[0], action: dec.action, bidPct: dec.bidPct || 0, reason: dec.reason, snap: snapshot(m) };
    let todo, blocked = null;
    if (dec.action !== 'lower' && dec.action !== 'raise') todo = () => api[dec.action === 'resume' ? 'start' : dec.action](m.id);
    else if (m.platform !== 'ozon') {
      const items = newBids(m, dec.bidPct, cfg, await api.minBids(m));     // minBids is read-only, so the dry-run plan shows real bids
      if (!items.length) blocked = dec.action === 'lower' ? 'ставка уже минимальная' : 'ставка уже на верхнем пределе';
      act.bids = items.map((x) => ({ nm: x.nm, placement: x.placement, wasRub: x.was / 100, rub: x.kop / 100 }));
      todo = () => api.setBids(m.id, items);
    } else if (m.strategy === 'TARGET_BIDS') {
      const items = ozonBids(m, dec.bidPct, cfg, await api.minBid(m.nms.map((n) => n.nm)));
      if (!items.length) blocked = dec.action === 'lower' ? 'ставка уже минимальная' : 'ставка уже на верхнем пределе';
      act.bids = items.map((x) => ({ nm: x.nm, placement: 'cpc', wasRub: R(x.was), rub: x.rub }));
      todo = () => api.setBids(m.id, items);
    } else if (m.strategy === 'TARGET_CIR') {
      // Ozon holds a target ДРР itself: move that target, never above the seller's own goal for these goods
      const set = m.nms.map((n) => n.cir).filter((x) => x > 0), cur = set.length ? Math.round(set.reduce((a, b) => a + b, 0) / set.length) : 15;
      const goal = clamp(Math.round((m.target || 0) * 100), 5, Math.round(cfg.maxDrr * 100)), step = Math.max(1, Math.round(cur * Math.abs(dec.bidPct) / 100));
      const next = dec.bidPct < 0 ? Math.max(5, cur - step) : Math.min(goal, cur + step);
      if ((dec.bidPct < 0 && next >= cur) || (dec.bidPct > 0 && next <= cur)) blocked = 'целевой ДРР в Ozon уже на этом уровне';
      act.note = 'Целевой ДРР в Ozon: ' + cur + '% → ' + next + '%';
      todo = () => api.setCir(m.id, m.nms.map((n) => n.nm), next);
    } else blocked = 'автостратегия Ozon сама управляет ставкой — могу только включать и выключать кампанию';
    if (blocked) { row.action = 'keep'; row.blocked = blocked; continue; }
    await done(act, m.store, todo);
    row.result = act.result;
    out.actions.push(act);
    if (act.result === 'ok') {
      if (dec.action === 'lower' || dec.action === 'raise') mark(m, { lastBidAt: now });
      if (dec.action === 'pause') mark(m, { pausedByAgent: true });
      if (dec.action === 'resume' || dec.action === 'stop') mark(m, { pausedByAgent: false });
    }
    if (live(m.store)) await sleep(250);
  }
  const stays = (m) => { const r = rowOf.get(m.uid); return m.status === 9 && r && r.action !== 'stop' && r.action !== 'pause'; };

  // 5. Search queries: exclude the ones that only burn money
  for (const v of views) {
    if (!stays(v.m)) continue;
    for (const p of planMinus(v, plan && plan.minus, cfg)) {
      const spend = p.add.reduce((s, c) => s + c.spend, 0), noOrders = p.add.every((c) => !c.orders);
      const act = { t: out.generated, store: v.m.store, platform: 'wb', id: v.m.id, name: v.m.name, key: p.key, action: 'minus', nm: p.nm, n: p.add.length, queries: p.add.slice(0, 12).map((c) => c.q), snap: snapshot(v.m),
        reason: 'Убираю ' + p.add.length + ' ' + plural(p.add.length, 'поисковый запрос', 'поисковых запроса', 'поисковых запросов') + ': за 30 дней на них ушло ' + rub(spend) + (noOrders ? ' без единого заказа' : ', а заказы с них обходятся дороже прибыли') + '. Например: ' + p.add.slice(0, 3).map((c) => '«' + c.q + '»').join(', ') + '.' };
      await done(act, v.m.store, () => apis[v.m.store].setMinus(v.m.id, p.nm, [...new Set([...p.existing, ...p.add.map((c) => c.q)])].slice(0, 1000)));
      if (act.result === 'ok') mark(v.m, { lastMinusAt: now });
      out.actions.push(act);
    }
  }

  // 6. Ozon: take loss-making products out of campaigns that otherwise stay
  let drops = 0;
  for (const m of metrics) {
    if (m.platform !== 'ozon' || !m.skuStats || m.nms.length < 2 || !stays(m) || cfg.protect.map(String).includes(String(m.id))) continue;
    const bad = m.nms.map((n) => { const s = m.skuStats[n.nm], e = econ.get(storeName[m.store] + '|' + n.nm); if (!s) return null;
      if (!s.orders && s.spend >= cfg.stop.noOrdersSpend) return { nm: n.nm, why: rub(s.spend) + ' без заказов' };
      if (e && !e.noCogs && e.margin != null && e.margin <= 0.02 && s.spend >= cfg.minSpend) return { nm: n.nm, why: 'убыточен до рекламы (маржа ' + pct(e.margin) + ')' };
      return null; }).filter(Boolean).slice(0, Math.min(m.nms.length - 1, cfg.ozon.maxDropsPerRun - drops));
    if (!bad.length) continue;
    drops += bad.length;
    const act = { t: out.generated, store: m.store, platform: 'ozon', id: m.id, name: m.name, key: storeName[m.store] + '|' + bad[0].nm, action: 'drop', skus: bad.map((b) => b.nm), snap: snapshot(m), reason: 'Убираю из кампании ' + bad.length + ' ' + plural(bad.length, 'товар', 'товара', 'товаров') + ', которые тянут её в минус: ' + bad.map((b) => b.nm + ' — ' + b.why).join('; ') + '.' };
    await done(act, m.store, () => apis[m.store].drop(m.id, bad.map((b) => b.nm)));
    out.actions.push(act);
  }

  // 7. New campaigns for the products where ads are expected to pay
  const veto = new Map(((plan && plan.launches) || []).map((l) => [l.key, l]));
  const order = plan && plan.launches ? pool.slice().sort((a, b) => { const i = (c) => { const k = plan.launches.findIndex((l) => l.key === c.key); return k < 0 ? 999 : k; }; return i(a) - i(b); }) : pool;
  const perStore = {};
  for (const cand of order) {
    const L = launchCfg(cand.platform), v = veto.get(cand.key), api = apis[cand.store];
    if (v && v.go === false) continue;
    if (launchLeft[cand.platform] <= 0 || (perStore[cand.store] || 0) >= L.maxPerRun) continue;
    launchLeft[cand.platform]--; perStore[cand.store] = (perStore[cand.store] || 0) + 1;
    const goal = Math.min(cfg.maxDrr, cfg.targetShare * cand.margin);
    const act = { t: out.generated, store: cand.store, platform: cand.platform, action: 'launch', key: cand.key, sku: cand.sku, name: cand.name,
      reason: 'Товар без рекламы: маржа до рекламы ' + pct(cand.margin) + ', ' + cand.q + ' продаж за 30 дней, на складе ' + cand.stock + ' шт. (на ' + cand.stockDays + ' дн.).' +
        (cand.per1000 != null ? ' Расчёт: клик около ' + cand.cpc + ' ₽, в заказ переходит ' + (cand.cr * 100).toFixed(1) + '% кликов, с продажи ' + rub(cand.unitProfit) + ' — на 1000 ₽ рекламы жду около ' + rub(cand.per1000) + ' прибыли сверху.' : '') +
        ' Запускаю кампанию ' + (cand.platform === 'ozon' ? 'с недельным бюджетом ' + rub(L.weeklyBudget) : 'с бюджетом ' + rub(L.budget)) + ', целевой ДРР до ' + pct(goal) + '.' + (v && v.reason ? ' ' + v.reason : '') };
    await done(act, cand.store, async () => {
      const title = ('AI ' + cand.sku + ' ' + cand.name).slice(0, 60);
      if (cand.platform === 'ozon') { act.id = await api.create(title, cand.sku, clamp(Math.round(goal * 100), 5, 50), L.weeklyBudget); return; }
      const id = await api.create(title, [+cand.sku], L.paymentType);
      act.id = +id || (id && (id.id || id.advertId)) || null;
      await sleep(3000);
      if (act.id) { await api.deposit(act.id, L.budget, cfg.budget.source); await sleep(1500); await api.start(act.id); }
    });
    out.actions.push(act);
  }

  // 8. Remember: history, lessons, thresholds, the helper team for next time
  out.actions.filter((a) => a.result === 'ok' || a.result === 'error').forEach((a) => hist.push(a));
  memory.runs++;
  if (plan) {
    if (Array.isArray(plan.lessons)) memory.lessons = plan.lessons.map((x) => String(x).slice(0, 400)).filter(Boolean).slice(0, 12);
    (plan.tune || []).forEach((x) => { const rec = tune(memory, cfg, x.key, x.value, x.why, 'claude', now); if (rec) tuned.push(rec); });
    if (Array.isArray(plan.helpers) && plan.helpers.length) memory.helpers = plan.helpers.slice(0, 6).map((h) => ({ role: String(h.role).slice(0, 80), task: String(h.task).slice(0, 500) }));
  }
  out.learned = learnedView(memory, fresh, tuned, plan ? plan.helpersUsed : []);
  out.candidates = pool.map((c) => ({ store: c.store, key: c.key, name: c.name, per1000: c.per1000, headroom: c.headroom, go: !(veto.get(c.key) && veto.get(c.key).go === false) }));

  const n = (a) => out.actions.filter((x) => x.action === a && x.result !== 'error').length;
  const failed = out.actions.filter((x) => x.result === 'error');
  const cnt = (p, s) => metrics.filter((m) => m.platform === p && m.status === s).length;
  const hasOz = metrics.some((m) => m.platform === 'ozon');
  const dry = [!live('wb1') && metrics.some((m) => m.platform === 'wb') && 'WB', hasOz && cfg.ozon.mode !== 'live' && 'Ozon'].filter(Boolean);
  const dryNote = dry.length ? ' Режим проверки (' + dry.join(', ') + '): в кабинете ничего не менялось.' : '';
  const qn = out.actions.filter((x) => x.action === 'minus' && x.result !== 'error').reduce((s, x) => s + x.n, 0);
  const auto = 'Кампаний под управлением: WB — ' + cnt('wb', 9) + ' активных, ' + cnt('wb', 11) + ' на паузе' + (hasOz ? '; Ozon — ' + cnt('ozon', 9) + ' активных, ' + cnt('ozon', 11) + ' выключенных' : '') + '. ' +
    (out.actions.length ? 'Решения: ставка снижена — ' + n('lower') + ', повышена — ' + n('raise') + ', закрыто — ' + n('stop') + ', пауза — ' + n('pause') + ', включено — ' + n('resume') + ', пополнено — ' + n('topup') + ', запущено новых — ' + n('launch') + ', убрано запросов — ' + qn + (hasOz ? ', убрано товаров из кампаний Ozon — ' + out.actions.filter((x) => x.action === 'drop').reduce((s, x) => s + x.skus.length, 0) : '') + '.' : 'Изменений не требуется.');
  out.summary = (out.summary || auto) + dryNote +
    (failed.length ? ' Не выполнено из-за ошибок площадки: ' + failed.length + (failed.some((x) => /read-only/i.test(x.error || '')) ? ' — токен WB только на чтение, нужен токен «Продвижение» с правом записи.' : '.') : '');
  out.campaigns.sort((a, b) => (a.action === 'keep') - (b.action === 'keep') || b.spend30 - a.spend30);
  return { ...out, history: hist.slice(-400), camp, deposits: Object.fromEntries(Object.entries(deposits).slice(-14)), memory };
}
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

/* ------------------------------ CLI ------------------------------ */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const env = (k) => (process.env[k] || '').trim();
  const cfg = mergeConfig(readJson('ads-agent.config.json', {}));
  if (env('ADS_AGENT_MODE')) { cfg.mode = env('ADS_AGENT_MODE'); if (cfg.mode !== 'live') cfg.ozon.mode = 'dry-run'; }
  if (cfg.mode !== 'live') cfg.mode = 'dry-run';
  if (cfg.ozon.mode !== 'live') cfg.ozon.mode = 'dry-run';
  const data = readJson('data.json'), market = readJson('market.json');
  if (!data || !market) { console.error('data.json / market.json not found — run update.mjs and api.mjs first'); process.exit(1); }
  const name = (sid) => (data.stores.find((s) => s.id === sid) || {}).name || sid;
  const apis = {};
  [['wb1', 'WB_SAKOVSKY_TOKEN'], ['wb2', 'WB_DARMIL_TOKEN']].forEach(([sid, k]) => { if (env(k)) apis[sid] = wbApi(env(k)); });
  [['oz1', 'OZON_PERF_SAKOVSKY'], ['oz2', 'OZON_PERF_SUAVISS']].forEach(([sid, k]) => { if (env(k + '_CLIENT_ID') && env(k + '_CLIENT_SECRET')) apis[sid] = ozonApi(env(k + '_CLIENT_ID'), env(k + '_CLIENT_SECRET'), name(sid)); });
  if (!Object.keys(apis).length) { console.error('No ad API keys: WB_SAKOVSKY_TOKEN / WB_DARMIL_TOKEN / OZON_PERF_*_CLIENT_ID + _CLIENT_SECRET'); process.exit(1); }
  const useClaude = cfg.llm.enabled && (env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN'));
  log('ads agent: WB', cfg.mode, '| Ozon', cfg.ozon.mode, '| accounts', Object.keys(apis).join(','), '| decisions by', useClaude ? cfg.llm.model + ' team' : 'rules (no ANTHROPIC_API_KEY)');
  const { memory, ...out } = await run({ cfg, data, market, state: readJson('ads-agent.json', {}), memory: readJson('ads-memory.json', null), apis, brain: useClaude ? makeBrain(cfg) : null });
  writeFileSync(new URL('./ads-agent.json', import.meta.url), JSON.stringify(out));
  writeFileSync(new URL('./ads-memory.json', import.meta.url), JSON.stringify(memory, null, 1));
  log('\n' + out.summary);
  out.actions.forEach((a) => log(' ', a.result, a.store, a.id || a.sku, a.action, a.bidPct ? a.bidPct + '%' : '', '|', a.reason, a.error ? '| ' + a.error : ''));
  out.notes.forEach((e) => log('  NOTE', e));
  out.errors.forEach((e) => log('  ERR', e));
  if (out.errors.length && !out.campaigns.length) process.exit(1);
}
