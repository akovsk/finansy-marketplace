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
import { readQueries, planMinus, planClusterBids, kbBad, kbAddBad, kbPrune } from './ads-queries.mjs';
import { buildVariants, activeSkus, parseApprovals, planText, askText, tg } from './ads-plan.mjs';
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
  // WB: a loss-making campaign is paused, not closed — closing is irreversible and throws away its queries and minus phrases
  // Closing for good happens only after the owner's «закрыть N» in Telegram: the agent asks about campaigns that have been
  // on a loss pause for askAfterDays with no restart that would pay (at most askMax open questions)
  stop: { noOrdersSpend: 3000, overMarginFactor: 1.4, maxPerRun: 5, hardClose: false, askAfterDays: 5, askMax: 6, restartGraceDays: 7 },
  bid: { maxStepPct: 25, upStepPct: 15, cooldownHours: 24, maxCpmKop: 100000, maxCpcKop: 5000, minOrdersToRaise: 5, minStockDaysToRaise: 14 },
  stock: { pauseWhenOut: true, resumeDays: 5 },
  budget: { autoTopUp: false, topUpSum: 1000, dailyCap: 5000, source: 1 },
  launch: { enabled: false, maxPerRun: 1, maxTotal: 5, budget: 1000, minStock: 30, minStockDays: 45, minMargin: 0.25, minSales30: 10, minRating: 4.5, minHeadroom: 1.3, paymentType: 'cpm' },
  // Search-query cleanup (WB): exclude clusters that took clicks and money and brought no orders
  // minExpected: exclude a query without orders once the product's usual conversion would have given this many;
  // relatedStrongExpected: the same for the product's own wording; lowCrShare / cpcFactor: conversion and click price
  // against the product's average (excluded only when the order then costs more than it earns)
  queries: { enabled: true, maxCampaigns: 40, minClicks: 20, minSpend: 200, irrelevantMinSpend: 50, minExpected: 2, relatedStrongExpected: 5, costFactor: 2, lowCrShare: 0.4, cpcFactor: 2, goodShare: 0.6, maxPerCampaign: 25, maxTransfer: 300, cooldownDays: 2, boostGood: true },
  // Development plan with numbered launch variants. auto: restarts of paused campaigns and new campaigns in place of
  // closed ones that the numbers say will pay are carried out without waiting (pausing and starting are the agent's own
  // call); the rest wait for «запуск N» in Telegram
  plan: { enabled: true, maxVariants: 5, budget: 1000, maxPerRun: 3, auto: true },
  // Campaigns should not sit on pause: a loser is first repaired from inside (bid down by bid.maxStepPct per step, bad queries out)
  // for up to maxSteps; a loss pause gets a trial restart (cleaned queries, lower bid) after retestDays, at most maxRetests times;
  // only after that the agent asks the owner whether to close it
  repair: { enabled: true, maxSteps: 3, retestDays: 7, maxRetests: 2 },
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
// v1 daily cluster stats → one row per cluster for the whole period (same shape as v0)
export function sumClusterDays(it) {
  const by = new Map();
  (it.dailyStats || []).forEach((d) => {
    const s = d.stat || {}, q = s.normQuery; if (!q) return;
    const a = by.get(q) || { norm_query: q, views: 0, clicks: 0, atbs: 0, orders: 0, spend: 0 };
    a.views += +s.views || 0; a.clicks += +s.clicks || 0; a.atbs += +s.atbs || 0; a.orders += +s.orders || 0; a.spend += +s.spend || 0;
    by.set(q, a);
  });
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
export function ruleDecision(m, cfg, st) {
  const D = (action, reason, bidPct = 0) => ({ id: m.id, action, bidPct, reason });
  if (m.status === 11) {
    if (st.pausedByAgent && st.pausedFor !== 'loss' && m.stockDays >= cfg.stock.resumeDays) return D('resume', 'Товар снова в наличии (хватит на ' + R(Math.min(m.stockDays, 999)) + ' дн.) — включаю кампанию, которую сам ставил на паузу.');
    return D('keep', st.pausedFor === 'loss' ? 'На паузе из-за убытка: запросы и минус-фразы сохранены, перезапуск — в плане, если он окупится.' : 'На паузе — не трогаю.');
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
    case 'stop':
      if (st.restartedAt && now - st.restartedAt < cfg.stop.restartGraceDays * 864e5) return keep('перезапущена после чистки запросов — жду неделю новой статистики');
      return stopReason(m, cfg) ? { ...dec, bidPct: 0 } : keep('для закрытия не хватает данных или убыток не подтверждён');
    case 'pause': return m.status === 9 ? { ...dec, bidPct: 0 } : keep('кампания не активна');
    case 'resume': return m.status === 11 && st.pausedByAgent && st.pausedFor !== 'loss' && m.stock > 0 ? { ...dec, bidPct: 0 } : keep('сам включаю только кампании, поставленные на паузу из-за остатков');
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
export async function run({ cfg: cfg0, data, market, state = {}, memory: mem0 = null, apis, now = Date.now(), brain = null, approvals = null }) {
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
  const metrics = [], byUid = new Map(), pool = [], views = [], storeName = {}, archiveInfo = {};
  // Campaigns the agent closed before it learned to pause: their excluded queries are kept, and for 30 days
  // (while WB still has their statistics) the agent weighs a new campaign in their place
  const closedByAgent = hist.filter((h, i, all) => h.action === 'stop' && h.result === 'ok' && h.platform !== 'ozon' && !String(h.store).startsWith('oz') && h.key && Date.parse(h.t) >= now - 30 * DAY && all.findIndex((x) => x.action === 'stop' && x.result === 'ok' && x.id === h.id) === i);
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
    if (cfg.queries.enabled && api.clusters) {
      const archive = closedByAgent.filter((h) => h.store === sid).map((h) => ({ id: h.id, name: h.name, nms: [h.key.split('|')[1]] }));
      archive.forEach((a) => { const m = campaignMetrics({ id: a.id, platform: 'wb', status: 7, name: a.name, nms: a.nms.map((nm) => ({ nm: +nm, search: 0, recom: 0 })) }, (market.ads || []).find((x) => x.s === sid && x.id === a.id), ctx); archiveInfo[a.id] = { spend: m.w30.spend, orders: m.w30.orders, ordSum: m.w30.ordSum, buyout: m.buyout, margin: m.margin, target: m.target }; });
      try {
        (await readQueries(api, mine, ctx, camp, now, memory, archive)).forEach((v) => views.push(v));
        archive.forEach((a) => { camp[a.id] = { ...(camp[a.id] || {}), harvested: now }; });
      } catch (e) { out.errors.push(store.name + ': поисковые запросы не получены — ' + e.message.slice(0, 200)); }
    }
  }
  if (noOzonKey.length) out.notes.push('Ozon (' + noOzonKey.join(', ') + '): нет ключа Performance API — реклама Ozon пока не управляется.');

  // 2. Learn from what past actions did, before deciding anything new
  const fresh = evaluateOutcomes(memory, hist, (a) => byUid.get(a.store + ':' + a.id), now);
  const tuned = autoTune(memory, cfg, now);

  const skipped = [];
  const variants = cfg.plan.enabled ? buildVariants({ views, pool, metrics, memory, cfg, archiveInfo, skipped }) : [];

  // 3. Decide: rules as the baseline, the Claude team on top when it is available
  metrics.sort((a, b) => b.w30.spend - a.w30.spend);     // biggest spenders first, so the per-run stop limit goes to the costliest losers
  const rules = new Map(metrics.map((m) => [m.uid, ruleDecision(m, cfg, stOf(m))]));
  let proposed = rules, plan = null;
  const forLlm = metrics.filter((m) => m.status === 9);
  if (brain && (forLlm.length || pool.length)) {
    try {
      plan = await brain({
        rows: forLlm.map((m) => forClaude(m, rules.get(m.uid), stOf(m), cfg)),
        clusters: views.filter((v) => v.kind === 'active').map((v) => ({ uid: v.uid, name: v.name, items: v.items.map(({ existing, key, ...i }) => ({ ...i, alreadyExcluded: existing.length, knownBadElsewhere: kbBad(memory, key).length })) })),
        variants: variants.map(({ n, kind, name, why, profitMonth, transfer, budget }) => ({ n, kind, name, why, profitMonth, transfer, budget })),
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
    // Repair before pause: a losing campaign whose goods earn before ads is first fixed from inside — the bid goes down
    // step by step while bad queries are excluded (step 5). Pause only when the ladder is used up or the bid is already minimal.
    const fixable = cfg.repair.enabled && m.status === 9 && !m.noCogs && m.margin != null && m.margin > 0.02;
    if (dec.action === 'stop' && fixable && (st.repairSteps || 0) < cfg.repair.maxSteps) {
      const k = (st.repairSteps || 0) + 1, why = dec.reason;
      const fix = guard({ id: m.id, action: 'lower', bidPct: cfg.bid.maxStepPct, reason: '' }, m, cfg, st, now);
      dec = fix.action === 'lower'
        ? { ...fix, repair: k, reason: 'Не ставлю на паузу — сначала улучшаю кампанию (шаг ' + k + ' из ' + cfg.repair.maxSteps + '): снижаю ставку на ' + -fix.bidPct + '%' + (m.platform === 'ozon' ? '' : ' и убираю запросы, которые не продают') + '. ' + why }
        : { id: m.id, action: 'keep', bidPct: 0, reason: 'Улучшаю кампанию (сделано шагов: ' + (k - 1) + ' из ' + cfg.repair.maxSteps + '). ' + why, blocked: fix.blocked };
    } else if (dec.action !== 'stop' && st.repairSteps && m.status === 9 && !stopReason(m, cfg)) mark(m, { repairSteps: 0 });   // recovered: a fresh ladder next time
    if (dec.action === 'stop' && ++stops > cfg.stop.maxPerRun) dec = { ...dec, action: 'keep', blocked: 'лимит закрытий за один запуск (' + cfg.stop.maxPerRun + ')' };
    // Pause instead of closing: the campaign keeps its queries and minus phrases; closing for good only with the owner's «закрыть N»
    if (dec.action === 'stop' && !cfg.stop.hardClose) dec = m.status === 9 ? { ...dec, action: 'pause', loss: true, reason: 'Ставлю на паузу, а не закрываю: собранные запросы и минус-фразы сохранятся' + (m.platform === 'ozon' ? '' : ', закрою только с вашего разрешения') + '. ' + dec.reason } : { ...dec, action: 'keep', blocked: 'уже на паузе' };
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

    const act = { t: out.generated, store: m.store, platform: m.platform, id: m.id, name: m.name, key: m.skus[0], action: dec.action, bidPct: dec.bidPct || 0, reason: dec.reason, snap: snapshot(m), ...(dec.loss ? { loss: true } : {}) };
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
    // Nothing left to lower while the campaign still loses: only now a pause (it keeps its queries; a trial restart comes later)
    if (blocked && dec.repair && ++stops <= cfg.stop.maxPerRun) {
      Object.assign(act, { action: 'pause', loss: true, bidPct: 0, reason: 'Снижать ставку уже некуда (' + blocked + '), а кампания всё ещё в минусе — ставлю на паузу. Запросы и минус-фразы сохранятся, через ' + cfg.repair.retestDays + ' дн. попробую перезапустить с чистыми запросами. ' + dec.reason.replace(/^Не ставлю на паузу[^.]*\.\s*/, '') });
      delete act.bids; delete act.note;
      row.action = 'pause'; row.reason = act.reason; blocked = null;
      todo = () => api.pause(m.id);
    }
    if (blocked) { row.action = 'keep'; row.blocked = blocked; continue; }
    await done(act, m.store, todo);
    row.result = act.result;
    out.actions.push(act);
    if (act.result === 'ok') {
      if (act.action === 'lower' || act.action === 'raise') mark(m, { lastBidAt: now, ...(dec.repair ? { repairSteps: dec.repair } : {}) });
      if (act.action === 'pause') mark(m, { pausedByAgent: true, pausedFor: act.loss ? 'loss' : 'stock', pausedAt: now });
      if (act.action === 'resume' || act.action === 'stop') mark(m, { pausedByAgent: false, pausedFor: null, pausedAt: null });
    }
    if (live(m.store)) await sleep(250);
  }
  const stays = (m) => { const r = rowOf.get(m.uid); return m.status === 9 && r && r.action !== 'stop' && r.action !== 'pause'; };

  // 5. Search queries: exclude the ones that cannot pay, carry over exclusions made in other campaigns of the product,
  //    and bid up the clusters that sell where WB allows it
  for (const v of views) {
    if (v.kind !== 'active' || !stays(v.m)) continue;
    const coolMinus = (camp[v.m.id] || {}).lastMinusAt > now - cfg.queries.cooldownDays * DAY;
    for (const p of planMinus(v, plan && plan.minus, cfg, memory)) {
      const add = coolMinus ? [] : p.add;
      if (!add.length && !p.transfer.length) continue;
      const spend = add.reduce((s, c) => s + c.spend, 0);
      const parts = [];
      if (add.length) parts.push('Исключаю ' + add.length + ' ' + plural(add.length, 'запрос', 'запроса', 'запросов') + ' (' + rub(spend) + ' за 30 дней): ' + add.slice(0, 3).map((c) => '«' + c.q + '» — ' + c.why).join('; ') + '.');
      if (p.transfer.length) parts.push('Переношу ' + p.transfer.length + ' ' + plural(p.transfer.length, 'исключённый запрос', 'исключённых запроса', 'исключённых запросов') + ' этого товара из других кампаний.');
      const act = { t: out.generated, store: v.m.store, platform: 'wb', id: v.m.id, name: v.m.name, key: p.key, action: 'minus', nm: p.nm, n: add.length, moved: p.transfer.length, queries: add.slice(0, 12).map((c) => c.q), snap: snapshot(v.m), reason: parts.join(' ') };
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

  // 5b. Launch variants: the ones the owner approved in Telegram (from the plan he saw), and — with plan.auto — restarts
  //     and replacements of closed campaigns that the numbers say will pay (starting and pausing are the agent's own call)
  const prevPlan = state.plan || null, approvedNow = [];
  const vKey = (v) => v.kind + ':' + (v.id || v.sku);
  const chosen = [];
  if (approvals && prevPlan && (approvals.all || approvals.nums.length)) (prevPlan.variants || []).filter((x) => approvals.all || approvals.nums.includes(x.n)).forEach((v) => chosen.push({ ...v, by: 'owner' }));
  if (cfg.plan.auto) {
    let left = launchLeft.wb;
    // never brings back on its own a campaign the owner chose to close
    variants.filter((v) => v.kind === 'restart' || (v.kind === 'recreate' && !hist.some((h) => h.id === v.id && h.approved) && left-- > 0)).forEach((v) => { if (!chosen.some((x) => vKey(x) === vKey(v))) chosen.push({ ...v, by: 'agent' }); });
  }
  // Trial restart: a WB campaign that has sat on a loss pause for repair.retestDays comes back with every bad query
  // excluded and a lower bid; a week of new numbers decides (the repair ladder or a pause again)
  const pausedSince = (m) => { const st = camp[ck(m)] || {}; if (st.pausedAt) return st.pausedAt; const h = hist.filter((x) => x.id === m.id && x.store === m.store && x.action === 'pause' && x.result === 'ok').pop(); return h ? Date.parse(h.t) : null; };
  if (cfg.repair.enabled) metrics.forEach((m) => {
    const st = camp[ck(m)] || {}, since = pausedSince(m), n = (st.retests || 0) + 1;
    if (cfg.protect.map(String).includes(String(m.id)) || m.status !== 11 || st.pausedFor !== 'loss' || n > cfg.repair.maxRetests || m.noCogs || !(m.margin > 0.02)) return;
    if (!since || now - since < cfg.repair.retestDays * DAY || chosen.some((v) => v.kind === 'restart' && v.id === m.id)) return;
    chosen.push({ kind: 'restart', retest: n, by: 'agent', store: m.store, id: m.id, name: m.name, key: m.skus[0], skus: m.nms.map((x) => String(x.nm)), bidPct: -cfg.bid.maxStepPct, budget: cfg.plan.budget,
      why: 'Пробный перезапуск после ' + Math.round((now - since) / DAY) + ' дн. паузы (попытка ' + n + ' из ' + cfg.repair.maxRetests + '): все плохие запросы исключены, ставка −' + cfg.bid.maxStepPct + '%. Неделю смотрю на новые цифры.' });
  });
  // One product — one running campaign: WB splits the impressions of campaigns that share placements («Конфликт кампаний»).
  // Checked right before every start or launch, including campaigns started earlier in this same run.
  const busyNow = activeSkus(metrics);
  const takenBy = (store, skus, self) => skus.map((s) => busyNow.get(store + '|' + s)).find((c) => c && c.id !== self);
  const occupy = (store, skus, id, name) => skus.forEach((s) => busyNow.set(store + '|' + s, { id, name }));
  {
    for (const v of chosen.slice(0, cfg.plan.maxPerRun)) {
      const vSkus = (v.skus || [v.sku]).filter(Boolean).map(String), clash = takenBy(v.store, vSkus, v.kind === 'restart' ? v.id : null);
      if (clash) { out.notes.push('«' + v.name + '»: не ' + (v.kind === 'restart' ? 'включаю' : 'запускаю') + ' — товар уже рекламируется в кампании ' + clash.id + ', вторая кампания только разделит показы.'); continue; }
      if (v.kind !== 'restart') launchLeft.wb--;
      const api = apis[v.store], m = v.kind === 'restart' ? metrics.find((x) => x.store === v.store && x.id === v.id) : null;
      const act = { t: out.generated, store: v.store, platform: m ? m.platform : 'wb', action: v.kind === 'restart' ? 'restart' : 'launch', plan: v.by === 'owner' ? v.n : undefined, auto: v.by === 'agent' || undefined, vkey: vKey(v), id: v.kind === 'restart' ? v.id : undefined, sku: v.sku || (v.skus || [])[0], key: v.key, name: v.name,
        reason: (v.by === 'owner' ? 'По вашему ответу в Telegram (вариант ' + v.n + '). ' : v.retest ? '' : v.kind === 'restart' ? 'Сам перезапускаю: после чистки запросов кампания должна окупаться. ' : 'Сам запускаю новую кампанию вместо закрытой, с её минус-фразами. ') + v.why };
      if (!api) { act.result = 'error'; act.error = 'нет токена магазина'; out.actions.push(act); approvedNow.push(act); continue; }
      if (v.kind === 'restart' && (!m || m.status !== 11)) { act.result = 'error'; act.error = 'кампания уже не на паузе'; out.actions.push(act); approvedNow.push(act); continue; }
      await done(act, v.store, async () => {
        if (v.kind === 'restart' && m.platform === 'ozon') {
          // Ozon: no query exclusions through the API — the restart comes with a lower bid or a lower target ДРР
          if (m.strategy === 'TARGET_BIDS') { const items = ozonBids(m, v.bidPct, cfg, await api.minBid(m.nms.map((n) => n.nm))); if (items.length) await api.setBids(m.id, items); }
          else if (m.strategy === 'TARGET_CIR') { const set = m.nms.map((n) => n.cir).filter((x) => x > 0), cur = set.length ? Math.round(set.reduce((a, b) => a + b, 0) / set.length) : 15; await api.setCir(m.id, m.nms.map((n) => n.nm), Math.max(5, cur - Math.max(1, Math.round((cur * cfg.bid.maxStepPct) / 100)))); }
          await api.start(m.id);
          mark(m, { pausedByAgent: false, pausedFor: null, pausedAt: null, lastBidAt: now, restartedAt: now, ...(v.retest ? { retests: v.retest } : {}) });
          return;
        }
        if (v.kind === 'restart') {
          const view = views.find((x) => x.uid === m.uid);
          for (const i of (view ? view.items : [])) {
            const add = i.clusters.filter((c) => c.flag === 'waste' || c.flag === 'costly' || c.flag === 'check').map((c) => c.q);
            await api.setMinus(m.id, +i.nm, [...new Set([...i.existing, ...add, ...kbBad(memory, i.key)])].slice(0, 1000));
            kbAddBad(memory, i.key, add, 'агент', now);
          }
          if (v.bidPct) { const items = newBids(m, v.bidPct, cfg, await api.minBids(m)); if (items.length) await api.setBids(m.id, items); }
          if (m.budget == null || m.budget < 100) { await api.deposit(m.id, v.budget, cfg.budget.source); await sleep(1500); }
          await api.start(m.id);
          mark(m, { pausedByAgent: false, pausedFor: null, pausedAt: null, lastBidAt: now, restartedAt: now, ...(v.retest ? { retests: v.retest } : {}) });
          return;
        }
        const skus = v.skus || [v.sku];
        const id = await api.create(('AI ' + skus[0] + ' ' + cleanTitle(v.name)).slice(0, 60), skus.map(Number), cfg.launch.paymentType);
        act.id = +id || (id && (id.id || id.advertId)) || null;
        if (!act.id) throw new Error('WB не вернул номер кампании');
        await sleep(3000);
        for (const sku of skus) { const list = kbBad(memory, storeName[v.store] + '|' + sku); if (list.length) await api.setMinus(act.id, +sku, list.slice(0, 1000)); }
        await api.deposit(act.id, v.budget, cfg.budget.source); await sleep(1500); await api.start(act.id);
      });
      if (act.result === 'ok' || act.result === 'planned') occupy(v.store, vSkus, act.id || v.id, v.name);
      out.actions.push(act); approvedNow.push(act);
    }
  }

  // 5c. Closing for good: only the campaigns the owner allowed («закрыть N»); then new questions about campaigns that sit
  //     on a loss pause with no restart that would pay. Their minus phrases are already in the knowledge base.
  const asks0 = state.closeAsk || [], closedNow = [];
  if (approvals && asks0.length) {
    (approvals.keep || []).forEach((n) => { const a = asks0.find((x) => x.n === n); if (a) camp[a.id] = { ...(camp[a.id] || {}), closeDeclinedAt: now }; });
    for (const a of asks0.filter((x) => approvals.closeAll || (approvals.close || []).includes(x.n))) {
      const m = metrics.find((x) => x.store === a.store && x.id === a.id), api = apis[a.store];
      const act = { t: out.generated, store: a.store, platform: 'wb', id: a.id, name: a.name, key: a.key, action: 'stop', approved: a.n, kept: a.kept,
        reason: 'Закрываю по вашему ответу в Telegram («закрыть ' + a.n + '»). ' + a.why + (a.kept ? ' ' + a.kept + ' ' + plural(a.kept, 'минус-фраза сохранена', 'минус-фразы сохранены', 'минус-фраз сохранено') + ' в базе агента и переносятся в другие РК товара.' : '') };
      if (!m || !api) { act.result = 'error'; act.error = !api ? 'нет токена магазина' : 'кампании уже нет среди активных и на паузе'; }
      else { if (m) act.snap = snapshot(m); await done(act, a.store, () => api.stop(a.id)); if (act.result === 'ok') mark(m, { pausedByAgent: false, pausedFor: null, pausedAt: null }); }
      out.actions.push(act); closedNow.push(act);
    }
  }
  {
    const gone = new Set(closedNow.filter((a) => a.result !== 'error').map((a) => a.id).concat((approvals && approvals.keep || []).map((n) => (asks0.find((x) => x.n === n) || {}).id)));
    const restartIds = new Set(variants.filter((v) => v.kind === 'restart').map((v) => v.id).concat(approvedNow.map((a) => a.id)));
    const want = metrics.filter((m) => {
      const st = camp[m.id] || {};
      if (m.platform === 'ozon' || m.status !== 11 || st.pausedFor !== 'loss' || gone.has(m.id) || restartIds.has(m.id)) return false;
      // ask only once the trial restarts are used up (or ads cannot help: the goods lose money before ads)
      if (cfg.repair.enabled && !m.noCogs && m.margin > 0.02 && (st.retests || 0) < cfg.repair.maxRetests) return false;
      if (st.closeDeclinedAt && now - st.closeDeclinedAt < 30 * DAY) return false;
      const since = pausedSince(m);
      return since && now - since >= cfg.stop.askAfterDays * DAY;
    });
    const why = (m) => { const s = skipped.find((x) => x.kind === 'paused' && x.id === m.id); return 'На паузе с ' + new Date(pausedSince(m) + 3 * 3600e3).toISOString().slice(5, 10).split('-').reverse().join('.') + '. ' + (s ? 'Перезапуск не окупится: ' + s.why + '.' : stopReason(m, cfg) || 'Реклама этого товара не окупалась.'); };
    const keptOf = (m) => m.skus.reduce((s, k) => s + kbBad(memory, k).length, 0);
    const keepOld = asks0.filter((a) => want.some((m) => m.id === a.id));
    let next = keepOld.reduce((s, a) => Math.max(s, a.n), 0);
    out.closeAsk = keepOld.map((a) => { const m = want.find((x) => x.id === a.id); return { ...a, why: why(m), kept: keptOf(m) }; });
    want.filter((m) => !keepOld.some((a) => a.id === m.id)).slice(0, Math.max(0, cfg.stop.askMax - keepOld.length)).forEach((m) => {
      out.closeAsk.push({ n: ++next, store: m.store, id: m.id, name: m.name, key: m.skus[0], why: why(m), kept: keptOf(m), asked: out.generated });
    });
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
    if (takenBy(cand.store, [String(cand.sku)], null)) continue;
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
    if (act.result === 'ok' || act.result === 'planned') occupy(cand.store, [String(cand.sku)], act.id || null, cand.name);
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
  kbPrune(memory);
  // What was learned today (Moscow day), for the evening report per marketplace
  const isToday = (t) => t && new Date(Date.parse(t) + 3 * 3600e3).toISOString().slice(0, 10) === today;
  out.learned.today = { outcomes: (memory.outcomes || []).filter((o) => isToday(o.checked)).slice(-20).map(({ before, after, ...o }) => o), tuned: (memory.tuneLog || []).filter((x) => isToday(x.t)) };
  out.learned.skills = skillsView({ memory, hist, camp, views, metrics, noOzonKey, brain: !!brain, plan, now, closeAsk: out.closeAsk });
  out.approved = approvedNow.filter((a) => a.plan).concat(closedNow).map((a) => ({ n: a.plan || a.approved, action: a.action, name: a.name, id: a.id || null, result: a.result, error: a.error || null }));
  out.autoLaunched = approvedNow.filter((a) => a.auto).map((a) => ({ action: a.action, name: a.name, id: a.id || null, result: a.result, error: a.error || null }));
  if (cfg.plan.enabled) out.plan = makePlan({ out, hist, metrics, views, variants, skipped, plan, cfg, now, done: approvedNow, live });
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
const cleanTitle = (s) => String(s || '').replace(/^\d{5,}\s*/, '').replace(/_/g, ' ').trim();

// Skills the agents have actually used (with the date of the first time) and what they are going to learn next.
// A skill counts only once it was done for real in a cabinet; until then it sits in the learning plan with what it waits for.
export function skillsView({ memory, hist, camp, views, metrics, noOzonKey = [], brain, plan, now, closeAsk = [] }) {
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
    ['pause', 'Ставит убыточные кампании на паузу, сохраняя запросы и минус-фразы', first((a) => a.action === 'pause' && a.loss), 'первая подтверждённо убыточная кампания в боевом режиме'],
    ['kb', 'Ведёт базу запросов по каждому товару' + (bad || good ? ': ' + bad + ' плохих, ' + good + ' продающих' : ''), bad + good ? (memory.skillsAt || {}).kb || now : null, 'первые прочитанные кластеры'],
    ['harvest', 'Сохраняет минус-фразы закрытых кампаний', harvested ? (memory.skillsAt || {}).harvest || now : null, 'закрытая кампания с минус-фразами'],
    ['minus', 'Исключает плохие поисковые запросы (низкая конверсия, дорогой клик, нерелевантные)', first((a) => a.action === 'minus' && a.n > 0), 'запрос, на который набралось достаточно кликов без заказов'],
    ['transfer', 'Переносит исключения между кампаниями одного товара', first((a) => a.action === 'minus' && a.moved > 0), 'у товара должно быть две кампании или новая вместо закрытой'],
    ['boost', 'Поднимает ставки на кластеры, которые продают', first((a) => a.action === 'boost'), 'кампания с ручной ставкой CPM и продающими кластерами'],
    ['repair', 'Чинит убыточные кампании изнутри: шаг за шагом снижает ставку и чистит запросы, пауза — только в крайнем случае', first((a) => a.action === 'lower' && /улучшаю кампанию/.test(a.reason || '')), 'первая убыточная кампания в боевом режиме'],
    ['retest', 'Сам пробует перезапустить кампанию после паузы — с чистыми запросами и ставкой ниже', first((a) => a.action === 'restart' && /Пробный перезапуск/.test(a.reason || '')), 'неделя паузы у кампании, поставленной из-за убытка'],
    ['restart', 'Перезапускает кампании после чистки запросов, когда это окупается', first((a) => a.action === 'restart'), 'кампания на паузе, которую чистка запросов выведет в плюс'],
    ['launch', 'Запускает новые кампании на прибыльные товары без рекламы', first((a) => a.action === 'launch'), 'товар с запасом маржи и остатков'],
    ['ask', 'Спрашивает в Telegram разрешение закрыть кампанию', closeAsk.length || first((a) => a.action === 'stop' && a.approved) ? (memory.skillsAt || {}).ask || now : null, 'кампания на паузе из-за убытка дольше 5 дней'],
    ['outcomes', 'Проверяет результат своих решений через неделю: прибыль до и после', checked ? (memory.skillsAt || {}).outcomes || now : null, 'неделя после первых изменений' + (pending ? ' (ждут проверки: ' + pending + ')' : '')],
    ['tune', 'Сам подстраивает свои пороги по итогам проверок', (memory.tuneLog || []).length ? (memory.skillsAt || {}).tune || now : null, 'четыре проверенных решения одного типа'],
    ['team', 'Работает командой Claude: ведущий и помощники под задачу', brain ? (memory.skillsAt || {}).team || now : null, 'ключ ANTHROPIC_API_KEY в секретах GitHub'],
    ['ozon', 'Управляет рекламой Ozon: ставки, целевой ДРР, товары в кампаниях', ozon ? (memory.skillsAt || {}).ozon || now : null, noOzonKey.length ? 'ключи Ozon Performance API' : 'кампании Ozon'],
  ];
  memory.skillsAt = memory.skillsAt || {};
  S.forEach(([id, , at]) => { if (at && !memory.skillsAt[id]) memory.skillsAt[id] = at; });
  const has = S.filter((s) => s[2]).map(([id, text]) => ({ id, text, since: new Date(memory.skillsAt[id]).toISOString().slice(0, 10) })).sort((a, b) => (a.since < b.since ? 1 : -1));
  const next = [];
  if (pending) next.push('Оценить ' + pending + ' ' + (pending === 1 ? 'своё решение' : 'своих решений') + ' через неделю после них и по итогам подстроить шаг ставок и пороги паузы.');
  if (check) next.push('Научиться различать спорные запросы: ' + check + ' похожи на сам товар, но не продают — ' + (brain ? 'разбирает помощник.' : 'жду больше кликов; с ключом Claude их разберёт помощник.'));
  if (!brain) next.push('Подключить команду Claude (ключ ANTHROPIC_API_KEY): тогда агент будет сам писать уроки, звать помощников и разбирать спорные запросы.');
  if (noOzonKey.length) next.push('Освоить рекламу Ozon (' + noOzonKey.join(', ') + '): нужны ключи Performance API.');
  ((plan && plan.learnNext) || []).forEach((x) => next.push(String(x).slice(0, 300)));
  S.filter((s) => !s[2] && !['team', 'ozon'].includes(s[0])).forEach(([, text, , wait]) => next.push(text + ' — жду: ' + wait + '.'));
  return { has, next: next.slice(0, 8) };
}
// The plan the owner gets in Telegram: what was done in 24 h, what comes next, numbered launch variants
function makePlan({ out, hist, metrics, views, variants, skipped = [], plan, cfg, now, done, live }) {
  const since = now - DAY;
  const real = hist.filter((a) => a.result === 'ok' && Date.parse(a.t) >= since);
  const acts = real.length ? real : out.actions.filter((a) => a.result === 'planned');
  const cnt = (f) => acts.filter(f).length, sum = (f, k) => acts.filter(f).reduce((s, a) => s + (a[k] || 0), 0);
  const isLoss = (a) => a.action === 'stop' || (a.action === 'pause' && a.loss);
  const d = { planned: !real.length && acts.length > 0, closed: cnt((a) => a.action === 'stop'), paused: cnt((a) => a.action === 'pause' && a.loss), lower: cnt((a) => a.action === 'lower'), raise: cnt((a) => a.action === 'raise'), minus: sum((a) => a.action === 'minus', 'n'), transfer: sum((a) => a.action === 'minus', 'moved'),
    closedApproved: cnt((a) => a.action === 'stop' && a.approved), launch: cnt((a) => a.action === 'launch'), resume: cnt((a) => a.action === 'resume'), restart: cnt((a) => a.action === 'restart'), savedDay: R(acts.filter(isLoss).reduce((s, a) => s + ((a.snap && a.snap.spendDay) || 0), 0)) };
  const next = [];
  const rows = out.campaigns;
  const cool = rows.filter((r) => r.blocked && /жду статистику/.test(r.blocked)).length;
  if (cool) next.push('Проверю ставки ещё в ' + cool + ' ' + plural(cool, 'кампании', 'кампаниях', 'кампаниях') + ', когда накопится статистика после прошлых изменений.');
  const fix = rows.filter((r) => /улучшаю кампанию|Улучшаю кампанию/.test(r.reason || '')).length;
  if (fix) next.push('Чиню ' + fix + ' ' + plural(fix, 'убыточную кампанию', 'убыточные кампании', 'убыточных кампаний') + ' вместо паузы: снижаю ставку по шагам и убираю запросы без продаж; на паузу — только если не поможет.');
  const lim = rows.filter((r) => r.blocked && /лимит закрытий/.test(r.blocked)).length;
  if (lim) next.push('Поставлю на паузу ещё ' + lim + ' ' + plural(lim, 'убыточную кампанию', 'убыточные кампании', 'убыточных кампаний') + ' (за раз не больше ' + cfg.stop.maxPerRun + ').');
  const check = views.filter((v) => v.kind === 'active').reduce((s, v) => s + v.items.reduce((t, i) => t + i.clusters.filter((c) => c.flag === 'check').length, 0), 0);
  if (check) next.push(check + ' ' + plural(check, 'спорный запрос', 'спорных запроса', 'спорных запросов') + ' (похожи на сам товар, но не продают) — ' + (plan ? 'разберёт помощник.' : 'жду больше данных, без ИИ-проверки не трогаю.'));
  // Paused and closed campaigns that were weighed for a restart and did not pass
  const arch = skipped.filter((x) => x.kind === 'archive'), pz = skipped.filter((x) => x.kind === 'paused');
  const kept = arch.reduce((s, x) => s + x.kept, 0);
  if (arch.length) next.push('Закрытые кампании (' + arch.length + '): ' + (kept ? 'их ' + kept + ' ' + plural(kept, 'минус-фраза сохранена', 'минус-фразы сохранены', 'минус-фраз сохранено') + ' и переносятся в живые и новые РК этих товаров. ' : '') + 'Перезапуск пока не окупится — например, «' + cleanTitle(arch[0].name).slice(0, 40) + '»: ' + arch[0].why + '.');
  if (pz.length) next.push('На паузе из-за минуса ' + pz.length + ' ' + plural(pz.length, 'кампания', 'кампании', 'кампаний') + ': перезапуск пока не окупится (' + pz[0].why + '), считаю заново при каждой проверке.');
  const wait = hist.filter((a) => a.result === 'ok' && !a.evaluated && Date.parse(a.t) >= now - 7 * DAY && ['lower', 'raise', 'pause', 'minus', 'launch', 'restart'].includes(a.action)).length;
  if (wait) next.push('Через неделю сравню прибыль до и после по ' + wait + ' ' + plural(wait, 'своему действию', 'своим действиям', 'своим действиям') + ' и подстрою правила.');
  const notes = new Map(((plan && plan.variantNotes) || []).map((x) => [x.n, x]));
  const doneN = new Set(done.map((a) => a.plan).filter(Boolean)), doneK = new Set(done.filter((a) => a.result !== 'error').map((a) => a.vkey));
  const V = variants.filter((v) => !(notes.get(v.n) && notes.get(v.n).go === false) && !doneK.has(v.kind + ':' + (v.id || v.sku))).map((v, i) => ({ ...v, n: i + 1, note: (notes.get(v.n) || {}).note || '' }));
  return { generated: out.generated, live: live('wb1'), done: d, next: (plan && plan.nextSteps && plan.nextSteps.length ? plan.nextSteps : next).slice(0, 5), variants: V, executed: [...doneN] };
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
  let approvals = null;
  if (tgToken && tgChat && (state.plan || (state.closeAsk || []).length)) {
    try {
      const ups = await tg(tgToken, 'getUpdates', { offset: String((state.tgOffset || 0) + 1), limit: '100', allowed_updates: '["message"]' });
      approvals = parseApprovals(ups, tgChat, (state.plan || state).generated);
      if (approvals.last) state.tgOffset = approvals.last;
      if (approvals.seen) log('telegram approvals:', approvals.all ? 'all' : approvals.nums.join(','));
    } catch (e) { log('telegram:', e.message); }
  }
  const { memory, ...out } = await run({ cfg, data, market, state, memory: readJson('ads-memory.json', null), apis, brain: useClaude ? makeBrain(cfg) : null, approvals });
  out.tgOffset = state.tgOffset || 0;
  keyNotes.forEach((n) => out.notes.push(n));
  if (tgToken && tgChat && approvals && approvals.seen) {
    const kept = (approvals.keep || []).map((n) => (state.closeAsk || []).find((a) => a.n === n)).filter(Boolean).map((a) => '⏸ ' + a.n + '. Оставил на паузе «' + cleanTitle(a.name) + '» — месяц не спрошу.');
    const lines = out.approved.length || kept.length ? kept.concat(out.approved.map((a) => (a.result === 'ok' ? '✅ ' : a.result === 'planned' ? '🧪 ' : '⚠️ ') + a.n + '. ' + (a.action === 'restart' ? 'Перезапустил' : a.action === 'stop' ? 'Закрыл' : 'Запустил') + ' «' + cleanTitle(a.name) + '»' + (a.id ? ' — РК № ' + a.id : '') + (a.result === 'planned' ? ' (режим проверки, в кабинете без изменений)' : '') + (a.error ? ' — не получилось: ' + a.error.slice(0, 120) : '')))
      : ['Не нашёл таких номеров. Пришлите, например: запуск 1 3 (варианты из плана) или закрыть 1 (кампании, о которых я спрашивал).'];
    try { await tg(tgToken, 'sendMessage', { chat_id: tgChat, text: lines.join('\n') }); } catch (e) { log('telegram:', e.message); }
  }
  // Ask for permission right away when there is something new to close (only from scheduled runs, not from «показать сейчас»)
  if (tgToken && tgChat && cfg.mode === 'live' && (out.closeAsk || []).some((a) => !a.notified)) {
    try { await tg(tgToken, 'sendMessage', { chat_id: tgChat, parse_mode: 'HTML', text: askText(out.closeAsk, true) }); out.closeAsk.forEach((a) => { a.notified = true; }); } catch (e) { log('telegram:', e.message); }
  }
  writeFileSync(new URL('./ads-agent.json', import.meta.url), JSON.stringify(out));
  writeFileSync(new URL('./ads-memory.json', import.meta.url), JSON.stringify(memory, null, 1));
  log('\n' + out.summary);
  out.actions.forEach((a) => log(' ', a.result, a.store, a.id || a.sku, a.action, a.bidPct ? a.bidPct + '%' : '', '|', a.reason, a.error ? '| ' + a.error : ''));
  out.notes.forEach((e) => log('  NOTE', e));
  out.errors.forEach((e) => log('  ERR', e));
  if (out.errors.length && !out.campaigns.length) process.exit(1);
}
