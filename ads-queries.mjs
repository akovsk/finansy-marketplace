// Search queries (WB): judging every cluster of every campaign, a knowledge base of queries per product,
// and moving that knowledge between campaigns.
//
// Why a knowledge base: a WB campaign carries work that took weeks — the queries a person excluded and the
// clusters that turned out to sell. Closing the campaign throws that away. The agent therefore remembers, per
// product, every excluded query (its own and the ones excluded by hand in the cabinet, including campaigns that
// were already closed) and every query that sells, and copies the exclusions into the other and the new
// campaigns of that product. Positive queries cannot be added through the WB API (WB forms clusters itself);
// what can be moved is the exclusions, plus bids on proven clusters in campaigns with a manual CPM bid.
const DAY = 864e5;
const R = (x) => Math.round(+x || 0);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rub = (x) => R(x).toLocaleString('ru-RU') + ' ₽';
const pct1 = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0).replace('.', ',') + '%';

// Word stems of a product title: "Тушенка говяжья белорусская" → тушен, говяж, белор
export const stems = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w)).map((w) => w.slice(0, 5));
// A query that shares a word with the product is its own traffic: excluding it needs stronger evidence
export const relatedQuery = (q, nameStems) => stems(q).some((w) => nameStems.has(w));

// One cluster against the product's own numbers in this campaign.
//   base.orderProfit — profit from one order before ads (after buyout); base.cr — orders per click of the product;
//   base.cpc — its average click price. Every exclusion rule is tied to money: a query goes only if it cannot pay.
// Returns { flag, why } or null:
//   waste  — no orders where the product's usual conversion would already have given some
//   costly — orders cost more than they earn (expensive orders, low conversion, or an expensive click)
//   check  — the same, but the query is the product's own wording and the evidence is not strong: a helper decides
//   good   — sells at a healthy cost per order
export function judgeCluster(c, base, q, related = false) {
  const P = base.orderProfit || 0, cpc = c.clicks ? c.spend / c.clicks : null, cr = c.clicks ? c.orders / c.clicks : null, cpo = c.orders ? c.spend / c.orders : null;
  const exp = base.cr ? c.clicks * base.cr : null;            // orders the product would usually get from these clicks
  const pick = (strong, why) => ({ flag: related && !strong ? 'check' : c.orders ? 'costly' : 'waste', why });
  if (!c.orders) {
    const enough = exp != null ? exp >= q.minExpected : c.clicks >= q.minClicks;
    if (enough && c.spend >= Math.max(q.minSpend, P)) return pick(exp != null && exp >= q.relatedStrongExpected, c.clicks + ' кликов и ' + rub(c.spend) + ' без заказов' + (exp != null ? ' (при обычной конверсии было бы ' + exp.toFixed(1).replace('.', ',') + ')' : ''));
    if (c.spend >= q.irrelevantMinSpend) return { flag: 'check', why: rub(c.spend) + ' без заказов, данных пока мало' };
    return null;
  }
  if (P > 0 && c.spend >= q.minSpend * 2 && cpo > P * q.costFactor) return pick(c.orders >= 2 && cpo > P * 3, 'заказ обходится в ' + rub(cpo) + ' при прибыли с продажи ' + rub(P));
  if (P > 0 && cpo > P && c.clicks >= q.minClicks) {
    if (base.cr && cr < base.cr * q.lowCrShare) return pick(false, 'конверсия ' + pct1(cr) + ' против ' + pct1(base.cr) + ' у товара, заказ ' + rub(cpo) + ' дороже прибыли ' + rub(P));
    if (base.cpc && cpc > base.cpc * q.cpcFactor) return pick(false, 'клик ' + cpc.toFixed(1).replace('.', ',') + ' ₽ против ' + base.cpc.toFixed(1).replace('.', ',') + ' ₽ в среднем, заказ ' + rub(cpo) + ' дороже прибыли');
  }
  if (c.orders >= 2 && (!P || cpo <= P * q.goodShare)) return { flag: 'good', why: c.orders + ' заказов по ' + rub(cpo) };
  return null;
}

/* ------------------------------ Knowledge base ------------------------------ */
// memory.queries["<store>|<nm>"] = { bad: { query: { why, src, t } }, good: { query: { orders, cpo, t } } }
export function kb(memory, key) { memory.queries = memory.queries || {}; return (memory.queries[key] = memory.queries[key] || { bad: {}, good: {} }); }
export function kbAddBad(memory, key, list, src, now) {
  const k = kb(memory, key), t = new Date(now).toISOString().slice(0, 10);
  list.forEach((x) => { const q = typeof x === 'string' ? x : x.q; if (q && !k.bad[q]) k.bad[q] = { why: (x && x.why) || '', src, t }; delete k.good[q]; });
}
export function kbAddGood(memory, key, list, now) {
  const k = kb(memory, key), t = new Date(now).toISOString().slice(0, 10);
  list.forEach((c) => { if (!k.bad[c.q]) k.good[c.q] = { orders: c.orders, cpo: R(c.spend / c.orders), t }; });
  const top = Object.entries(k.good).sort((a, b) => b[1].orders - a[1].orders).slice(0, 30);
  k.good = Object.fromEntries(top);
}
export const kbBad = (memory, key) => Object.keys(((memory.queries || {})[key] || {}).bad || {});
export const kbGood = (memory, key) => Object.entries(((memory.queries || {})[key] || {}).good || {}).sort((a, b) => b[1].orders - a[1].orders).map(([q, v]) => ({ q, ...v }));
// Keeps the file small: at most 400 products, 600 excluded queries each (newest kept)
export function kbPrune(memory) {
  const all = Object.entries(memory.queries || {});
  all.forEach(([, v]) => { const b = Object.entries(v.bad); if (b.length > 600) v.bad = Object.fromEntries(b.sort((x, y) => (x[1].t < y[1].t ? 1 : -1)).slice(0, 600)); });
  if (all.length > 400) memory.queries = Object.fromEntries(all.sort((x, y) => Object.keys(y[1].bad).length - Object.keys(x[1].bad).length).slice(0, 400));
}

/* ------------------------------ Reading the clusters ------------------------------ */
// views: one per campaign — active ones (to clean), agent-paused ones (to plan a restart) and campaigns the
// agent closed before this logic existed (to rescue their excluded queries once).
export async function readQueries(api, ms, ctx, camp, now, memory, archive = []) {
  const { cfg, econ, market, storeName, today } = ctx, q = cfg.queries;
  const protect = new Set(cfg.protect.map(String));
  const active = ms.filter((m) => m.status === 9 && m.w30.spend > 0 && !protect.has(String(m.id))).sort((a, b) => b.w30.spend - a.w30.spend).slice(0, q.maxCampaigns);
  const paused = ms.filter((m) => m.status === 11 && (camp[m.id] || {}).pausedFor === 'loss');
  const nmsOf = (m) => { const withSpend = new Set(m.skus.map((k) => k.split('|')[1])); const l = m.nms.filter((n) => withSpend.has(String(n.nm))); return (l.length ? l : m.nms).slice(0, 5); };
  const camps = [...active.map((m) => ({ kind: 'active', m, nms: nmsOf(m) })), ...paused.map((m) => ({ kind: 'paused', m, nms: nmsOf(m) })),
    ...archive.map((a) => ({ kind: 'archive', m: { id: a.id, uid: ctx.storeId + ':' + a.id, name: a.name, store: ctx.storeId, nms: a.nms.map((nm) => ({ nm })) }, nms: a.nms.map((nm) => ({ nm })) }))];
  const items = camps.flatMap((c) => c.nms.map((n) => ({ advert_id: c.m.id, nm_id: +n.nm })));
  if (!items.length) return [];
  const from = new Date(Date.parse(today) - 29 * DAY).toISOString().slice(0, 10);
  const stats = await api.clusters(items, from, today);
  const minus = await api.getMinus(items);
  const key = (a, n) => a + '|' + n, sMap = new Map(stats.map((x) => [key(x.advert_id, x.nm_id), x.stats || []])), mMap = new Map(minus.map((x) => [key(x.advert_id, x.nm_id), x.norm_queries || []]));
  return camps.map(({ kind, m, nms }) => ({
    kind, uid: m.uid, name: m.name, m,
    items: nms.map((n) => {
      const k = storeName + '|' + n.nm, e = econ.get(k), f = (market.funnel || {})[k];
      const orderProfit = e && e.q > 0 ? ((e.np - e.adv) / e.q) * (f && f.bp ? clamp(f.bp / 100, 0.3, 1) : 0.9) : 0;
      const existing = mMap.get(key(m.id, n.nm)) || [], gone = new Set(existing);
      // Exclusions already made in this campaign — by a person in the cabinet or by the agent — are knowledge about the product
      kbAddBad(memory, k, existing, 'РК ' + m.id, now);
      const rows = (sMap.get(key(m.id, n.nm)) || []).filter((c) => c.norm_query).map((c) => ({ q: c.norm_query, views: R(c.views), clicks: R(c.clicks), atbs: R(c.atbs), orders: R(c.orders), spend: R(c.spend != null ? c.spend : c.cpc != null ? c.cpc * c.clicks : (c.cpm || 0) * (c.views || 0) / 1000),
        wk: c.wk || null, pos: c.wk ? c.wk.w7.pos : (+(c.avg_pos ?? c.avgPos ?? c.avg_position ?? 0) || null) }));
      const tot = rows.reduce((a, c) => ({ clicks: a.clicks + c.clicks, orders: a.orders + c.orders, spend: a.spend + c.spend }), { clicks: 0, orders: 0, spend: 0 });
      const base = { orderProfit, cr: tot.clicks >= 50 && tot.orders ? tot.orders / tot.clicks : null, cpc: tot.clicks >= 50 ? tot.spend / tot.clicks : null };
      const own = new Set([...stems(e && e.name), ...stems(m.name), ...stems(n.subject)]);
      const judged = rows.filter((c) => !gone.has(c.q)).map((c) => { const j = judgeCluster(c, base, q, relatedQuery(c.q, own)); return j ? { ...c, ...j } : c; });
      const good = judged.filter((c) => c.flag === 'good').sort((a, b) => b.orders - a.orders);
      kbAddGood(memory, k, good, now);
      // Week to week totals of all clusters (daily stats only) and queries that started selling this week — for the skills
      const zw = () => ({ views: 0, clicks: 0, orders: 0, spend: 0 }), week = { w7: zw(), p7: zw() };
      rows.forEach((c) => { if (c.wk) ['w7', 'p7'].forEach((b) => Object.keys(week[b]).forEach((f) => { week[b][f] += c.wk[b][f] || 0; })); });
      const fresh = rows.filter((c) => c.wk && !c.wk.p7.clicks && !c.wk.p7.views && c.wk.w7.orders > 0).sort((a, b) => b.wk.w7.orders - a.wk.w7.orders).slice(0, 5).map((c) => ({ q: c.q, orders: c.wk.w7.orders, spend: R(c.wk.w7.spend) }));
      return { nm: n.nm, key: k, product: (e && e.name) || '', orderProfit: R(orderProfit), base: { cr: base.cr, cpc: base.cpc && Math.round(base.cpc * 10) / 10 }, total: tot, existing, week, fresh,
        clusters: judged.filter((c) => c.flag && c.flag !== 'good').sort((a, b) => b.spend - a.spend).slice(0, 60), good: good.slice(0, 10),
        // Top queries by views (last week when daily stats are there, else the 30 days): what the product is actually found by
        // (some campaigns get no views per cluster from WB — then clicks, orders and spend decide the order)
        top: kind === 'active' && (q.top || {}).enabled !== false ? rows.filter((c) => !gone.has(c.q)).sort((a, b) => {
          const w = (c, f) => (c.wk ? c.wk.w7[f] : 0);
          return w(b, 'views') - w(a, 'views') || b.views - a.views || b.clicks - a.clicks || b.orders - a.orders || b.spend - a.spend;
        }).slice(0, (q.top || {}).topN || 10) : [] };
    }),
  })).filter((v) => v.items.length);
}

// Queries to exclude in one campaign:
//   add      — judged here: waste / costly by numbers, "check" only when a helper confirmed it
//   transfer — excluded for the same product in another campaign (by a person or by the agent), not here yet
export function planMinus(view, proposed, cfg, memory) {
  const asked = new Set((proposed || []).filter((p) => p.uid === view.uid).flatMap((p) => p.queries.map((x) => String(p.nm) + '|' + x)));
  let left = cfg.queries.maxPerCampaign;
  return view.items.map((i) => {
    const add = i.clusters.filter((c) => c.flag === 'waste' || c.flag === 'costly' || (c.flag === 'check' && asked.has(String(i.nm) + '|' + c.q))).slice(0, Math.max(0, left));
    left -= add.length;
    const have = new Set([...i.existing, ...add.map((c) => c.q)]);
    const transfer = memory ? kbBad(memory, i.key).filter((q) => !have.has(q)).slice(0, cfg.queries.maxTransfer) : [];
    return { nm: i.nm, key: i.key, existing: i.existing, add, transfer };
  }).filter((p) => p.add.length || p.transfer.length);
}

// Bids on proven clusters (only campaigns with a manual CPM bid allow it): the product's search bid + upStepPct
export function planClusterBids(view, cfg) {
  const m = view.m;
  if (!cfg.queries.boostGood || m.payType !== 'cpm' || m.bidType !== 'manual') return [];
  return view.items.flatMap((i) => {
    const n = m.nms.find((x) => String(x.nm) === String(i.nm));
    if (!n || !n.search) return [];
    const bid = Math.min(Math.round((n.search * (1 + cfg.bid.upStepPct / 100)) / 100) * 100, cfg.bid.maxCpmKop);
    return i.good.slice(0, 5).map((c) => ({ advertId: m.id, nmId: +i.nm, normQuery: c.q, bidMinorUnits: bid }));
  });
}
