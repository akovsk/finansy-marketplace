// AI agent that manages ad campaigns on Wildberries and Ozon: reads campaign statistics, conversion metrics and unit
// economics, decides per campaign (keep / raise bid / lower bid), removes search queries that burn money and bids up
// the ones that sell, and applies that through the marketplaces' APIs.
//
// Owner's rule since 20.11.2026: the agents never start, pause, stop (finish), create or top up campaigns and never take
// products out of them. They work only with bids, ad statistics, metrics and search queries. bidsOnly() below strips
// those calls from every API client the run gets, so no decision — rules or Claude — can reach them, whatever the config says.
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
import { readQueries, planMinus, planClusterBids, kbBad, kbAddBad, kbPrune } from './ads-queries.mjs';
import { trackTop } from './ads-top.mjs';
import { CURRICULUM, learnSkills, nextSkill, runSkills, impactView } from './ads-skills.mjs';
import { parseApprovals, tg } from './ads-plan.mjs';
export { judgeCluster, relatedQuery, planMinus } from './ads-queries.mjs';

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
  // When a campaign counts as losing money (stopReason). A losing campaign gets the largest bid cut and its bad queries
  // excluded; it is never paused or finished by the agent.
  stop: { noOrdersSpend: 3000, overMarginFactor: 1.4 },
  bid: { maxStepPct: 25, upStepPct: 15, cooldownHours: 24, maxCpmKop: 100000, maxCpcKop: 5000, minOrdersToRaise: 5, minStockDaysToRaise: 14 },
  // Filters for estimating products without ads (launchCandidates — used by the one-off scripts, not by the scheduled agent)
  launch: { maxPerRun: 1, budget: 1000, minStock: 30, minStockDays: 45, minMargin: 0.25, minSales30: 10, minRating: 4.5, minHeadroom: 1.3, paymentType: 'cpm' },
  // Search-query cleanup (WB): exclude clusters that took clicks and money and brought no orders
  // minExpected: exclude a query without orders once the product's usual conversion would have given this many;
  // relatedStrongExpected: the same for the product's own wording; lowCrShare / cpcFactor: conversion and click price
  // against the product's average (excluded only when the order then costs more than it earns)
  queries: { enabled: true, maxCampaigns: 40, minClicks: 20, minSpend: 200, irrelevantMinSpend: 50, minExpected: 2, relatedStrongExpected: 5, costFactor: 2, lowCrShare: 0.4, cpcFactor: 2, goodShare: 0.6, maxPerCampaign: 25, maxTransfer: 300, cooldownDays: 2, boostGood: true,
    // Top queries watch: per product the topN clusters by views, week to week; alerts when a top query slips
    top: { enabled: true, topN: 10, maxProducts: 20, posDrop: 3, viewsDrop: 0.4, minViews: 300, minOrders: 3 } },
  // The daily plan in Telegram: what was done and what comes next
  plan: { enabled: true },
  // Ozon «Оплата за клик». Its own mode: stays "dry-run" until the owner has seen a plan built from real Ozon data.
  ozon: { mode: 'dry-run', maxCpcRub: 60, launch: { weeklyBudget: 3500 } },
  llm: { enabled: true, model: 'claude-opus-5-5', effort: 'medium', leadEffort: 'high', helperEffort: 'medium', maxHelpers: 5 },
};
// Campaign-level control the agents are not allowed to use (owner's rule): starting, pausing, finishing, creating,
// topping up and taking products out of campaigns. The one-off scripts the owner triggers himself (ads-wb-once.mjs,
// ads-launch-once.mjs) keep the full clients.
export const CAMPAIGN_CONTROL = ['start', 'pause', 'stop', 'create', 'deposit', 'drop'];
export const bidsOnly = (api) => api && Object.fromEntries(Object.entries(api).filter(([k]) => !CAMPAIGN_CONTROL.includes(k)));
const NO_CONTROL = 'агенты не включают, не ставят на паузу и не завершают кампании — только ставки и запросы';
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
    const nms = a.nms.map((n) => { const b = Object.fromEntries((n.bids || []).map((x) => [x.type, R(x.value)])); return { nm: n.nmId, search: b.combined || b.search || 0, recom: b.combined ? 0 : (b.recommendations || 0), unified: !!b.combined, subject: (n.subject && n.subject.name) || '' }; }).filter((n) => n.nm);
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
// Average position of a cluster in search, whatever WB calls the field (null when it does not send one)
export const posOf = (s) => { const p = +(s.avgPos ?? s.avg_pos ?? s.avgPosition ?? s.avg_position ?? s.position ?? 0); return p > 0 ? p : null; };
let posLogged = false;
// v1 daily cluster stats → one row per cluster for the whole period (same shape as v0).
// With real dates it also gives wk: the last 7 days (w7) and the 7 before (p7), for the top queries watch.
export function sumClusterDays(it) {
  const by = new Map();
  const dates = (it.dailyStats || []).map((d) => Date.parse(String(d.date || '').slice(0, 10))).filter((x) => !isNaN(x));
  const last = dates.length ? Math.max(...dates) : null;
  if (!posLogged && (it.dailyStats || [])[0]) { posLogged = true; log('  cluster day sample', JSON.stringify(it.dailyStats[0]).slice(0, 300)); }
  (it.dailyStats || []).forEach((d) => {
    const s = d.stat || {}, q = s.normQuery; if (!q) return;
    const a = by.get(q) || { norm_query: q, views: 0, clicks: 0, atbs: 0, orders: 0, spend: 0 };
    a.views += +s.views || 0; a.clicks += +s.clicks || 0; a.atbs += +s.atbs || 0; a.orders += +s.orders || 0; a.spend += +s.spend || 0;
    const t = Date.parse(String(d.date || '').slice(0, 10));
    if (last != null && !isNaN(t)) {
      const ago = Math.round((last - t) / DAY), b = ago < 7 ? 'w7' : ago < 14 ? 'p7' : null;
      if (b) {
        a.wk = a.wk || { w7: { views: 0, clicks: 0, orders: 0, spend: 0, posSum: 0, posW: 0 }, p7: { views: 0, clicks: 0, orders: 0, spend: 0, posSum: 0, posW: 0 } };
        const w = a.wk[b], v = +s.views || 0, p = posOf(s);
        w.views += v; w.clicks += +s.clicks || 0; w.orders += +s.orders || 0; w.spend += +s.spend || 0;
        if (p) { w.posSum += p * Math.max(v, 1); w.posW += Math.max(v, 1); }
      }
    }
    by.set(q, a);
  });
  // position weighted by views over each week
  by.forEach((a) => { if (a.wk) ['w7', 'p7'].forEach((b) => { const w = a.wk[b]; w.pos = w.posW ? Math.round((w.posSum / w.posW) * 10) / 10 : null; delete w.posSum; delete w.posW; }); });
  return { advert_id: it.advertId, nm_id: it.nmId, stats: [...by.values()] };
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
    // Search clusters of [{ advert_id, nm_id }] for a period: [{ advert_id, nm_id, stats: [...] }].
    // v1 (daily, cpm and cpc campaigns) summed over the period; v0 (cpm only) if v1 fails.
    async clusters(items, from, to) {
      try {
        const v1 = (await chunks(items, 100, 6500, (part) => call('POST', '/adv/v1/normquery/stats', { from, to, items: part.map((x) => ({ advertId: x.advert_id, nmId: x.nm_id })) }))).flatMap((j) => (j && j.items) || []);
        return v1.map(sumClusterDays);
      } catch (e) { log('  normquery v1:', e.message.slice(0, 200)); }
      return (await chunks(items, 100, 6500, (part) => call('POST', '/adv/v0/normquery/stats', { from, to, items: part }))).flatMap((j) => (j && j.stats) || []);
    },
    async getMinus(items) { return (await chunks(items, 100, 300, (part) => call('POST', '/adv/v0/normquery/get-minus', { items: part }))).flatMap((j) => (j && j.items) || []); },
    // Replaces the whole minus list of one product in one campaign, so always send existing + new
    setMinus: (id, nm, list) => call('POST', '/adv/v0/normquery/set-minus', { advert_id: id, nm_id: nm, norm_queries: list }),
    // Bids on single search clusters (campaigns with a manual CPM bid only)
    setClusterBids: (bids) => call('POST', '/api/advert/v1/normquery/bids', { bids }),
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
// Only bids: a campaign that loses money gets its bid cut by the largest step (and its bad queries excluded in step 5);
// whether to pause or finish it stays the owner's call.
export function ruleDecision(m, cfg, st) {
  const D = (action, reason, bidPct = 0) => ({ id: m.id, action, bidPct, reason });
  if (m.status === 11) return D('keep', 'На паузе — включать и выключать кампании агент не может, это ваше решение.');
  if (m.status !== 9) return D('keep', 'Не активна.');
  if (m.stock <= 0 && m.skus.length) return D('keep', 'Рекламируемого товара нет на складе — без остатка реклама не показывается, ставку не трогаю.');
  const loss = stopReason(m, cfg);
  if (loss) return D('lower', loss + ' Снижаю ставку на ' + cfg.bid.maxStepPct + '%' + (m.platform === 'ozon' ? '' : ' и убираю запросы без продаж') + '.', -cfg.bid.maxStepPct);
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
    case 'stop': case 'pause': case 'resume': case 'start': case 'launch': case 'topup': case 'drop':
      return keep(NO_CONTROL);
    case 'lower': case 'raise': {
      if (m.status !== 9) return keep('кампания не активна');
      if (cool) return keep('ставка менялась меньше ' + cfg.bid.cooldownHours + ' ч назад — жду статистику');
      if (!enoughData(m, cfg) && !(dec.action === 'lower' && stopReason(m, cfg))) return keep('мало данных для изменения ставки');
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
  losing: !!stopReason(m, cfg), queryExclusionPossible: m.platform !== 'ozon' && m.payType !== 'cpc', rule: { action: rule.action, bidPct: Math.abs(rule.bidPct) },
  lastActions: (st.recent || []).map((a) => a.t.slice(0, 10) + ' ' + a.action + (a.bidPct ? ' ' + a.bidPct + '%' : '')),
  days: m.days.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30).map((d) => [d[0], R(d[1]), R(d[2]), R(d[3])]),
});

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
export async function run({ cfg: cfg0, data, market, state = {}, memory: mem0 = null, apis: apis0, now = Date.now(), brain = null }) {
  const apis = Object.fromEntries(Object.entries(apis0 || {}).map(([k, a]) => [k, bidsOnly(a)]));   // no start / pause / stop / create / deposit / drop
  const memory = loadMemory(mem0);
  const cfg = applyTuning(cfg0, memory);       // the owner's limits with the agent's own tuned thresholds on top
  const today = new Date(now + 3 * 3600e3).toISOString().slice(0, 10);
  const econ = skuEconomics(data);
  const out = { generated: new Date(now).toISOString(), mode: cfg.mode, ozonMode: cfg.ozon.mode, engine: 'rules', dataAsOf: market.generated, summary: '', campaigns: [], actions: [], errors: [], notes: [] };
  const hist = state.history || [], camp = state.camp || {};
  const platOf = (sid) => (apis[sid] && apis[sid].platform) || (String(sid).startsWith('oz') ? 'ozon' : 'wb');
  const live = (sid) => (platOf(sid) === 'ozon' ? cfg.ozon.mode : cfg.mode) === 'live';
  const ck = (m) => (m.platform === 'ozon' ? m.uid : m.id);
  const stOf = (m) => ({ ...(camp[ck(m)] || {}), recent: hist.filter((h) => h.id === m.id && h.store === m.store).slice(-4) });
  const mark = (m, patch) => { camp[ck(m)] = { ...(camp[ck(m)] || {}), ...patch }; };
  const metrics = [], byUid = new Map(), views = [], storeName = {};
  // Campaigns that were closed earlier (by the owner or, before 20.11.2026, by the agent): for 30 days, while WB still
  // has their statistics, their excluded queries are read into the knowledge base and carried into the product's live campaigns
  const closedByAgent = hist.filter((h, i, all) => h.action === 'stop' && h.result === 'ok' && h.platform !== 'ozon' && !String(h.store).startsWith('oz') && h.key && Date.parse(h.t) >= now - 30 * DAY && all.findIndex((x) => x.action === 'stop' && x.result === 'ok' && x.id === h.id) === i);

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
    if (cfg.queries.enabled && api.clusters) {
      const archive = closedByAgent.filter((h) => h.store === sid).map((h) => ({ id: h.id, name: h.name, nms: [h.key.split('|')[1]] }));
      try {
        (await readQueries(api, mine, ctx, camp, now, memory, archive)).forEach((v) => views.push(v));
        archive.forEach((a) => { camp[a.id] = { ...(camp[a.id] || {}), harvested: now }; });
      } catch (e) { out.errors.push(store.name + ': поисковые запросы не получены — ' + e.message.slice(0, 200)); }
    }
  }
  if (noOzonKey.length) out.notes.push('Ozon (' + noOzonKey.join(', ') + '): нет ключа Performance API — реклама Ozon пока не управляется.');
  // Top queries watch: what each advertised product is found by, week to week, and which top query slipped
  try { out.top = trackTop(views, memory, today, cfg); } catch (e) { out.errors.push('Топ-запросы: ' + e.message.slice(0, 200)); }

  // 2. Learn from what past actions did, before deciding anything new
  const fresh = evaluateOutcomes(memory, hist, (a) => byUid.get(a.store + ':' + a.id), now);
  const tuned = autoTune(memory, cfg, now);

  // 3. Decide: rules as the baseline, the Claude team on top when it is available
  metrics.sort((a, b) => b.w30.spend - a.w30.spend);     // biggest spenders first
  const rules = new Map(metrics.map((m) => [m.uid, ruleDecision(m, cfg, stOf(m))]));
  let proposed = rules, plan = null;
  const forLlm = metrics.filter((m) => m.status === 9);
  if (brain && forLlm.length) {
    try {
      plan = await brain({
        rows: forLlm.map((m) => forClaude(m, rules.get(m.uid), stOf(m), cfg)),
        clusters: views.filter((v) => v.kind === 'active').map((v) => ({ uid: v.uid, name: v.name, queryExclusionPossible: v.m.payType !== 'cpc', items: v.items.map(({ existing, key, ...i }) => ({ ...i, alreadyExcluded: existing.length, knownBadElsewhere: kbBad(memory, key).length })) })),
        candidates: [],
        memory, limits: { maxStepPct: cfg.bid.maxStepPct, upStepPct: cfg.bid.upStepPct, cooldownHours: cfg.bid.cooldownHours, minSpend: cfg.minSpend, targetShare: cfg.targetShare, maxDrr: cfg.maxDrr },
      });
      proposed = new Map(rules);
      (plan.decisions || []).forEach((d) => { const m = byUid.get(d.uid); if (m && m.status === 9) proposed.set(d.uid, { id: m.id, action: d.action, bidPct: d.bidPct, reason: d.reason }); });
      out.engine = 'claude'; out.summary = plan.summary || '';
    } catch (e) { plan = null; out.errors.push('Claude недоступен, решения приняты по правилам: ' + e.message.slice(0, 200)); }
  }

  // 4. Apply campaign decisions through the hard limits — bid changes only
  const done = async (act, sid, fn) => { if (!live(sid)) { act.result = 'planned'; return; } try { await fn(); act.result = 'ok'; } catch (e) { act.result = 'error'; act.error = e.message; } };
  const rowOf = new Map();
  out.attention = [];      // losing campaigns whose bid cannot go lower: pausing or finishing them is the owner's call
  for (const m of metrics) {
    const st = stOf(m), api = apis[m.store];
    const dec = guard(proposed.get(m.uid), m, cfg, st, now);
    const loss = m.status === 9 ? stopReason(m, cfg) : null;
    const row = { id: m.id, store: m.store, platform: m.platform, name: m.name, status: m.status, payType: m.payType, spend30: R(m.w30.spend), orders30: m.w30.orders, ordSum30: R(m.w30.ordSum), drr30: fin(m.drr30), drr14: fin(m.drr14), margin: r3(m.margin), target: r3(m.target), stock: m.stock, action: dec.action, bidPct: dec.bidPct || 0, reason: dec.reason, blocked: dec.blocked };
    out.campaigns.push(row); rowOf.set(m.uid, row);
    if (dec.action !== 'lower' && dec.action !== 'raise') continue;

    const act = { t: out.generated, store: m.store, platform: m.platform, id: m.id, name: m.name, key: m.skus[0], action: dec.action, bidPct: dec.bidPct || 0, reason: dec.reason, snap: snapshot(m), ...(loss ? { loss: true } : {}) };
    let todo, blocked = null;
    if (m.platform !== 'ozon') {
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
    } else blocked = 'автостратегия Ozon сама управляет ставкой — агент её не меняет';
    if (blocked) {
      row.action = 'keep'; row.blocked = blocked;
      // Nothing left to lower while the campaign still loses: the agent does not pause it, it tells the owner
      if (dec.action === 'lower' && loss) { row.attention = true; out.attention.push({ store: m.store, platform: m.platform, id: m.id, name: m.name, why: loss, blocked }); }
      continue;
    }
    await done(act, m.store, todo);
    row.result = act.result;
    out.actions.push(act);
    if (act.result === 'ok') mark(m, { lastBidAt: now });
    if (live(m.store)) await sleep(250);
  }
  const stays = (m) => m.status === 9 && rowOf.has(m.uid);

  // 5. Search queries: exclude the ones that cannot pay, carry over exclusions made in other campaigns of the product,
  //    and bid up the clusters that sell where WB allows it
  out.queryAdvice = [];
  for (const v of views) {
    if (v.kind !== 'active' || !stays(v.m)) continue;
    const coolMinus = (camp[v.m.id] || {}).lastMinusAt > now - cfg.queries.cooldownDays * DAY;
    // WB accepts minus phrases only in CPM campaigns (unified or manual bid). For a cost-per-click campaign
    // set-minus answers 404 «advert not found or not belong to the supplier», so there the agent only reports
    // the queries that do not sell; the bid cut in step 4 is what it can do about them.
    const canMinus = v.m.payType !== 'cpc';
    for (const p of planMinus(v, plan && plan.minus, cfg, memory)) {
      const add = coolMinus ? [] : p.add;
      if (!canMinus) {
        if (add.length) out.queryAdvice.push({ store: v.m.store, id: v.m.id, name: v.m.name, nm: p.nm, spend: R(add.reduce((s, c) => s + c.spend, 0)), queries: add.slice(0, 8).map((c) => ({ q: c.q, spend: R(c.spend), why: c.why })) });
        continue;
      }
      if (!add.length && !p.transfer.length) continue;
      const spend = add.reduce((s, c) => s + c.spend, 0);
      const parts = [];
      if (add.length) parts.push('Исключаю ' + add.length + ' ' + plural(add.length, 'запрос', 'запроса', 'запросов') + ' (' + rub(spend) + ' за 30 дней): ' + add.slice(0, 3).map((c) => '«' + c.q + '» — ' + c.why).join('; ') + '.');
      if (p.transfer.length) parts.push('Переношу ' + p.transfer.length + ' ' + plural(p.transfer.length, 'исключённый запрос', 'исключённых запроса', 'исключённых запросов') + ' этого товара из других кампаний.');
      const act = { t: out.generated, store: v.m.store, platform: 'wb', id: v.m.id, name: v.m.name, key: p.key, action: 'minus', nm: p.nm, n: add.length, moved: p.transfer.length, spend: R(spend), queries: add.slice(0, 12).map((c) => c.q), snap: snapshot(v.m), reason: parts.join(' ') };
      await done(act, v.m.store, () => apis[v.m.store].setMinus(v.m.id, +p.nm, [...new Set([...p.existing, ...add.map((c) => c.q), ...p.transfer])].slice(0, 1000)));
      if (act.result === 'ok') { if (add.length) mark(v.m, { lastMinusAt: now }); kbAddBad(memory, p.key, add, 'агент', now); }
      out.actions.push(act);
    }
    const bids = (camp[v.m.id] || {}).lastClusterBidAt > now - 7 * DAY ? [] : planClusterBids(v, cfg);
    if (bids.length) {
      const act = { t: out.generated, store: v.m.store, platform: 'wb', id: v.m.id, name: v.m.name, key: v.items[0].key, action: 'boost', n: bids.length, queries: bids.map((b) => b.normQuery), reason: 'Поднимаю ставку на ' + bids.length + ' ' + plural(bids.length, 'кластер', 'кластера', 'кластеров') + ', которые продают дешевле прибыли: ' + bids.slice(0, 3).map((b) => '«' + b.normQuery + '»').join(', ') + ' — до ' + bids[0].bidMinorUnits / 100 + ' ₽ за 1000 показов.' };
      await done(act, v.m.store, () => apis[v.m.store].setClusterBids(bids));
      if (act.result === 'ok') mark(v.m, { lastClusterBidAt: now });
      out.actions.push(act);
    }
  }

  // 5d. Skills: one new skill a day (ads-skills.mjs), then every learned skill reports what it sees in the numbers
  learnSkills(memory, today);
  out.insights = runSkills(memory, { metrics, views, market, econ, memory, hist, cfg });

  // CPC campaigns: queries that do not sell, shown to the owner (WB does not take minus phrases there through the API)
  if (out.queryAdvice.length) {
    const n = new Set(out.queryAdvice.map((x) => x.id)).size, sp = out.queryAdvice.reduce((t, x) => t + x.spend, 0);
    out.notes.push('Оплата за клик: WB не принимает исключение запросов через API в таких кампаниях, поэтому в ' + n + ' ' + plural(n, 'кампании', 'кампаниях', 'кампаниях') + ' агент только снижает ставку. Запросы без продаж там стоили ' + rub(sp) + ' за 30 дней — например, ' + out.queryAdvice.slice(0, 3).map((x) => '«' + x.queries[0].q + '» (РК ' + x.id + ')').join(', ') + '.');
  }
  if (out.attention.length) out.notes.push('Ставка уже минимальная, а реклама в минусе: ' + out.attention.map((x) => '«' + cleanTitle(x.name).slice(0, 40) + '» (РК ' + x.id + ')').join(', ') + '. Агенты не ставят кампании на паузу и не завершают их — это решаете вы.');

  // 8. Remember: history, lessons, thresholds, the helper team for next time
  out.actions.filter((a) => a.result === 'ok' || a.result === 'error').forEach((a) => hist.push(a));
  memory.runs++;
  // What the agents changed in money (the achievements board shows only this)
  out.impact = impactView({ hist, metrics, memory });
  if (plan) {
    if (Array.isArray(plan.lessons)) memory.lessons = plan.lessons.map((x) => String(x).slice(0, 400)).filter(Boolean).slice(0, 12);
    (plan.tune || []).forEach((x) => { const rec = tune(memory, cfg, x.key, x.value, x.why, 'claude', now); if (rec) tuned.push(rec); });
    if (Array.isArray(plan.helpers) && plan.helpers.length) memory.helpers = plan.helpers.slice(0, 6).map((h) => ({ role: String(h.role).slice(0, 80), task: String(h.task).slice(0, 500) }));
  }
  out.learned = learnedView(memory, fresh, tuned, plan ? plan.helpersUsed : []);
  // The Claude team the lead has formed (kept between runs): the dashboard's agents' room shows exactly these
  out.team = (memory.helpers || []).map((h) => ({ role: h.role, task: h.task }));
  kbPrune(memory);
  // What was learned today (Moscow day), for the evening report per marketplace
  const isToday = (t) => t && new Date(Date.parse(t) + 3 * 3600e3).toISOString().slice(0, 10) === today;
  out.learned.today = { outcomes: (memory.outcomes || []).filter((o) => isToday(o.checked)).slice(-20).map(({ before, after, ...o }) => o), tuned: (memory.tuneLog || []).filter((x) => isToday(x.t)) };
  out.learned.skills = skillsView({ memory, hist, camp, views, metrics, noOzonKey, brain: !!brain, plan, now });
  // No launches, restarts or close requests any more: these stay empty so older dashboard and Telegram code shows nothing
  out.closeAsk = []; out.approved = []; out.autoLaunched = []; out.candidates = [];
  if (cfg.plan.enabled) out.plan = makePlan({ out, hist, metrics, views, plan, cfg, now, live });

  const n = (a) => out.actions.filter((x) => x.action === a && x.result !== 'error').length;
  const failed = out.actions.filter((x) => x.result === 'error');
  const cnt = (p, s) => metrics.filter((m) => m.platform === p && m.status === s).length;
  const hasOz = metrics.some((m) => m.platform === 'ozon');
  const dry = [!live('wb1') && metrics.some((m) => m.platform === 'wb') && 'WB', hasOz && cfg.ozon.mode !== 'live' && 'Ozon'].filter(Boolean);
  const dryNote = dry.length ? ' Режим проверки (' + dry.join(', ') + '): в кабинете ничего не менялось.' : '';
  const qn = out.actions.filter((x) => x.action === 'minus' && x.result !== 'error').reduce((s, x) => s + x.n, 0);
  const auto = 'Кампаний под управлением: WB — ' + cnt('wb', 9) + ' активных, ' + cnt('wb', 11) + ' на паузе' + (hasOz ? '; Ozon — ' + cnt('ozon', 9) + ' активных, ' + cnt('ozon', 11) + ' выключенных' : '') + '. ' +
    (out.actions.length ? 'Решения: ставка снижена — ' + n('lower') + ', повышена — ' + n('raise') + ', убрано запросов — ' + qn + ', поднята ставка на продающие запросы — ' + n('boost') + '.' : 'Изменений не требуется.');
  out.summary = (out.summary || auto) + dryNote +
    (failed.length ? ' Не выполнено из-за ошибок площадки: ' + failed.length + (failed.some((x) => /read-only/i.test(x.error || '')) ? ' — токен WB только на чтение, нужен токен «Продвижение» с правом записи.' : '.') : '');
  out.campaigns.sort((a, b) => (a.action === 'keep') - (b.action === 'keep') || b.spend30 - a.spend30);
  return { ...out, history: hist.slice(-400), camp, memory };
}
const cleanTitle = (s) => String(s || '').replace(/^\d{5,}\s*/, '').replace(/_/g, ' ').trim();

// Skills the agents have actually used (with the date of the first time) and what they are going to learn next.
// A skill counts only once it was done for real in a cabinet; until then it sits in the learning plan with what it waits for.
export function skillsView({ memory, hist, camp, views, metrics, noOzonKey = [], brain, plan, now }) {
  const ok = hist.filter((a) => a.result === 'ok');
  const first = (f) => { const a = ok.filter(f).sort((x, y) => (x.t < y.t ? -1 : 1))[0]; return a ? Date.parse(a.t) : null; };
  const kb = Object.values(memory.queries || {}), bad = kb.reduce((s, x) => s + Object.keys(x.bad || {}).length, 0), good = kb.reduce((s, x) => s + Object.keys(x.good || {}).length, 0);
  const pending = ok.filter((a) => !a.evaluated && ['lower', 'raise', 'pause', 'minus', 'launch', 'restart', 'stop', 'drop'].includes(a.action)).length;
  const checked = (memory.outcomes || []).length;
  const check = views.filter((v) => v.kind === 'active').reduce((s, v) => s + v.items.reduce((t, i) => t + i.clusters.filter((c) => c.flag === 'check').length, 0), 0);
  const ozon = metrics.some((m) => m.platform === 'ozon');
  const harvested = Object.values(camp).some((c) => c && c.harvested);
  // id, what the skill is, when it was first used (null = not yet), what it is waiting for
  const S = [
    ['bids', 'Меняет ставки по ДРР и марже товара', first((a) => a.action === 'lower' || a.action === 'raise'), 'первая кампания, где ДРР уйдёт от цели'],
    ['kb', 'Ведёт базу запросов по каждому товару' + (bad || good ? ': ' + bad + ' плохих, ' + good + ' продающих' : ''), bad + good ? (memory.skillsAt || {}).kb || now : null, 'первые прочитанные кластеры'],
    ['top', 'Следит за топ-запросами каждого товара: позиция, показы и заказы неделя к неделе', (views || []).some((v) => v.items.some((i) => i.top && i.top.length)) ? (memory.skillsAt || {}).top || now : null, 'первые кластеры активных кампаний'],
    ['harvest', 'Сохраняет минус-фразы закрытых кампаний и переносит их в живые', harvested ? (memory.skillsAt || {}).harvest || now : null, 'закрытая кампания с минус-фразами'],
    ['minus', 'Исключает плохие поисковые запросы в кампаниях с оплатой за показы (низкая конверсия, дорогой клик, нерелевантные)', first((a) => a.action === 'minus' && a.n > 0), 'запрос, на который набралось достаточно кликов без заказов'],
    ['transfer', 'Переносит исключения между кампаниями одного товара', first((a) => a.action === 'minus' && a.moved > 0), 'у товара должно быть две кампании с оплатой за показы'],
    ['boost', 'Поднимает ставки на кластеры, которые продают', first((a) => a.action === 'boost'), 'кампания с ручной ставкой CPM и продающими кластерами'],
    ['repair', 'Чинит убыточные кампании только ставкой и запросами: шаг за шагом снижает ставку до минимума WB, кампании не останавливает', first((a) => a.action === 'lower' && a.loss), 'первая убыточная кампания в боевом режиме'],
    ['outcomes', 'Проверяет результат своих решений через неделю: прибыль до и после', checked ? (memory.skillsAt || {}).outcomes || now : null, 'неделя после первых изменений' + (pending ? ' (ждут проверки: ' + pending + ')' : '')],
    ['tune', 'Сам подстраивает свои пороги по итогам проверок', (memory.tuneLog || []).length ? (memory.skillsAt || {}).tune || now : null, 'четыре проверенных решения одного типа'],
    ['team', 'Работает командой Claude: ведущий и помощники под задачу', brain ? (memory.skillsAt || {}).team || now : null, 'ключ ANTHROPIC_API_KEY в секретах GitHub'],
    ['ozon', 'Управляет рекламой Ozon: ставки и целевой ДРР', ozon ? (memory.skillsAt || {}).ozon || now : null, noOzonKey.length ? 'ключи Ozon Performance API' : 'кампании Ozon'],
  ];
  memory.skillsAt = memory.skillsAt || {};
  S.forEach(([id, , at]) => { if (at && !memory.skillsAt[id]) memory.skillsAt[id] = at; });
  const has = S.filter((s) => s[2]).map(([id, text]) => ({ id, text, since: new Date(memory.skillsAt[id]).toISOString().slice(0, 10) }))
    .concat((memory.curriculum || []).map((x) => ({ id: x.id, text: (CURRICULUM.find((c) => c.id === x.id) || {}).text || x.id, since: x.since, daily: true })))
    .sort((a, b) => (a.since < b.since ? 1 : -1));
  const next = [];
  const tomorrow = nextSkill(memory);
  next.push(tomorrow ? 'Завтра освою: ' + tomorrow.text.charAt(0).toLowerCase() + tomorrow.text.slice(1) + '.' : 'Ежедневные навыки из плана освоены — для новых нужна следующая партия.');
  if (pending) next.push('Оценить ' + pending + ' ' + (pending === 1 ? 'своё решение' : 'своих решений') + ' через неделю после них и по итогам подстроить шаг ставок и пороги.');
  if (check) next.push('Научиться различать спорные запросы: ' + check + ' похожи на сам товар, но не продают — ' + (brain ? 'разбирает помощник.' : 'жду больше кликов; с ключом Claude их разберёт помощник.'));
  if (!brain) next.push('Подключить команду Claude (ключ ANTHROPIC_API_KEY): тогда агент будет сам писать уроки, звать помощников и разбирать спорные запросы.');
  if (noOzonKey.length) next.push('Освоить рекламу Ozon (' + noOzonKey.join(', ') + '): нужны ключи Performance API.');
  ((plan && plan.learnNext) || []).forEach((x) => next.push(String(x).slice(0, 300)));
  S.filter((s) => !s[2] && !['team', 'ozon'].includes(s[0])).forEach(([, text, , wait]) => next.push(text + ' — жду: ' + wait + '.'));
  return { has, next: next.slice(0, 8) };
}
// The plan the owner gets in Telegram: what was done in 24 h and what comes next (bids and queries only)
function makePlan({ out, hist, metrics, views, plan, cfg, now, live }) {
  const since = now - DAY;
  const real = hist.filter((a) => a.result === 'ok' && Date.parse(a.t) >= since);
  const acts = real.length ? real : out.actions.filter((a) => a.result === 'planned');
  const cnt = (f) => acts.filter(f).length, sum = (f, k) => acts.filter(f).reduce((s, a) => s + (a[k] || 0), 0);
  const d = { planned: !real.length && acts.length > 0, closed: 0, paused: 0, lower: cnt((a) => a.action === 'lower'), raise: cnt((a) => a.action === 'raise'), minus: sum((a) => a.action === 'minus', 'n'), transfer: sum((a) => a.action === 'minus', 'moved'),
    closedApproved: 0, launch: 0, resume: 0, restart: 0, boost: cnt((a) => a.action === 'boost'), savedDay: 0 };
  const next = [];
  const rows = out.campaigns;
  const cool = rows.filter((r) => r.blocked && /жду статистику/.test(r.blocked)).length;
  if (cool) next.push('Проверю ставки ещё в ' + cool + ' ' + plural(cool, 'кампании', 'кампаниях', 'кампаниях') + ', когда накопится статистика после прошлых изменений.');
  const fix = rows.filter((r) => r.action === 'lower' && r.reason && /в минус|убыточен|ни одного заказа/.test(r.reason)).length;
  if (fix) next.push('Чиню ' + fix + ' ' + plural(fix, 'убыточную кампанию', 'убыточные кампании', 'убыточных кампаний') + ' ставкой и запросами: снижаю ставку по шагам, убираю запросы без продаж.');
  if ((out.attention || []).length) next.push('Ставка уже минимальная, а реклама в минусе: ' + out.attention.length + ' ' + plural(out.attention.length, 'кампания', 'кампании', 'кампаний') + ' — остановить или оставить решаете вы.');
  const check = views.filter((v) => v.kind === 'active').reduce((s, v) => s + v.items.reduce((t, i) => t + i.clusters.filter((c) => c.flag === 'check').length, 0), 0);
  if (check) next.push(check + ' ' + plural(check, 'спорный запрос', 'спорных запроса', 'спорных запросов') + ' (похожи на сам товар, но не продают) — ' + (plan ? 'разберёт помощник.' : 'жду больше данных, без ИИ-проверки не трогаю.'));
  const wait = hist.filter((a) => a.result === 'ok' && !a.evaluated && Date.parse(a.t) >= now - 7 * DAY && ['lower', 'raise', 'minus', 'boost'].includes(a.action)).length;
  if (wait) next.push('Через неделю сравню прибыль до и после по ' + wait + ' ' + plural(wait, 'своему действию', 'своим действиям', 'своим действиям') + ' и подстрою правила.');
  return { generated: out.generated, live: live('wb1'), done: d, next: (plan && plan.nextSteps && plan.nextSteps.length ? plan.nextSteps : next).slice(0, 5), variants: [], executed: [] };
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
  const keyNotes = [];
  [['oz1', 'OZON_PERF_SAKOVSKY'], ['oz2', 'OZON_PERF_SUAVISS']].forEach(([sid, k]) => {
    const id = env(k + '_CLIENT_ID'), sec = env(k + '_CLIENT_SECRET');
    if (id && sec) apis[sid] = ozonApi(id, sec, name(sid));
    else if (id || sec) keyNotes.push(name(sid) + ': задан только секрет ' + k + (id ? '_CLIENT_ID' : '_CLIENT_SECRET') + ', не хватает ' + k + (id ? '_CLIENT_SECRET' : '_CLIENT_ID') + '.');
    else keyNotes.push(name(sid) + ': секретов ' + k + '_CLIENT_ID / _CLIENT_SECRET нет в Actions secrets.');
  });
  keyNotes.forEach((n) => log('ozon key:', n));
  if (!Object.keys(apis).length) { console.error('No ad API keys: WB_SAKOVSKY_TOKEN / WB_DARMIL_TOKEN / OZON_PERF_*_CLIENT_ID + _CLIENT_SECRET'); process.exit(1); }
  const useClaude = cfg.llm.enabled && (env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN'));
  log('ads agent: WB', cfg.mode, '| Ozon', cfg.ozon.mode, '| accounts', Object.keys(apis).join(','), '| decisions by', useClaude ? cfg.llm.model + ' team' : 'rules (no ANTHROPIC_API_KEY)');
  const state = readJson('ads-agent.json', {});
  const tgToken = env('TELEGRAM_BOT_TOKEN'), tgChat = env('TELEGRAM_CHAT_ID');
  // The owner may still answer an old plan with «запуск N» / «закрыть N»: say once that agents no longer do that
  let answered = null;
  if (tgToken && tgChat && state.plan) {
    try {
      const ups = await tg(tgToken, 'getUpdates', { offset: String((state.tgOffset || 0) + 1), limit: '100', allowed_updates: '["message"]' });
      answered = parseApprovals(ups, tgChat, (state.plan || state).generated);
      if (answered.last) state.tgOffset = answered.last;
    } catch (e) { log('telegram:', e.message); }
  }
  const { memory, ...out } = await run({ cfg, data, market, state, memory: readJson('ads-memory.json', null), apis, brain: useClaude ? makeBrain(cfg) : null });
  out.tgOffset = state.tgOffset || 0;
  keyNotes.forEach((n) => out.notes.push(n));
  if (tgToken && tgChat && answered && answered.seen) {
    try { await tg(tgToken, 'sendMessage', { chat_id: tgChat, text: 'Агенты рекламы больше не запускают, не ставят на паузу и не завершают кампании — только меняют ставки и работают с запросами. Включить или остановить кампанию можно в кабинете площадки.' }); } catch (e) { log('telegram:', e.message); }
  }
  writeFileSync(new URL('./ads-agent.json', import.meta.url), JSON.stringify(out));
  writeFileSync(new URL('./ads-memory.json', import.meta.url), JSON.stringify(memory, null, 1));
  log('\n' + out.summary);
  out.actions.forEach((a) => log(' ', a.result, a.store, a.id || a.sku, a.action, a.bidPct ? a.bidPct + '%' : '', '|', a.reason, a.error ? '| ' + a.error : ''));
  out.notes.forEach((e) => log('  NOTE', e));
  out.errors.forEach((e) => log('  ERR', e));
  if (out.errors.length && !out.campaigns.length) process.exit(1);
}
