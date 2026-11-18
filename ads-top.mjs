// Top search queries watch (WB): per product in a running campaign, the queries it is found by most,
// week against week, and what changed — so a slipping top query is noticed the day it slips, not at month end.
//
// Inputs: the views from readQueries (each item has `top`: clusters with 30-day totals, `wk` = last 7 days / the
// 7 before when WB sent daily stats, `pos` = average position if WB sends one). A daily snapshot of every top
// list is kept in memory.top for three weeks; it gives "new in top / left the top" and a fallback week-old
// comparison when daily stats are missing. Snapshots: 8 days per product, products gone for 3 weeks are dropped.
const DAY = 864e5;
const R = (x) => Math.round(+x || 0);
const dayMinus = (d, n) => new Date(Date.parse(d) - n * DAY).toISOString().slice(0, 10);

export function trackTop(views, memory, today, cfg) {
  const T = { topN: 10, maxProducts: 20, posDrop: 3, viewsDrop: 0.4, minViews: 300, minOrders: 3, ...((cfg.queries || {}).top || {}) };
  memory.top = memory.top || {};
  const out = [];
  views.filter((v) => v.kind === 'active').forEach((v) => v.items.forEach((i) => {
    if (!i.top || !i.top.length) return;
    const k = v.m.store + ':' + v.m.id + ':' + i.nm;
    const hist = (memory.top[k] = (memory.top[k] || []).filter((s) => s.d !== today));
    const weekAgo = hist.filter((s) => s.d <= dayMinus(today, 6)).pop() || null;
    const prevTop = new Set(((weekAgo || hist[hist.length - 1] || {}).q || []).map((x) => x[0]));
    const rows = i.top.map((c, rank) => {
      const cur = c.wk ? c.wk.w7 : null, pre = c.wk ? c.wk.p7 : null, old = weekAgo && weekAgo.q.find((x) => x[0] === c.q);
      return {
        q: c.q, rank: rank + 1, views30: c.views, orders30: c.orders, spend30: c.spend,
        v7: cur ? cur.views : null, o7: cur ? cur.orders : null, s7: cur ? R(cur.spend) : null, pos: cur ? cur.pos : c.pos || null,
        vP: pre ? pre.views : old ? old[1] : null, oP: pre ? pre.orders : old ? old[2] : null, posP: pre ? pre.pos : old ? old[3] : null,
        isNew: prevTop.size > 0 && !prevTop.has(c.q),
      };
    });
    const alerts = [];
    rows.forEach((r) => {
      // a position move matters only for a query that sells or is really shown; otherwise it is noise
      const matters = r.orders30 > 0 || (r.oP || 0) > 0 || Math.max(r.v7 || 0, r.vP || 0) >= T.minViews / 3;
      if (matters && r.pos && r.posP && r.pos - r.posP >= Math.max(T.posDrop, r.posP * 0.3)) alerts.push({ kind: 'pos', q: r.q, text: 'позиция ' + r.posP + ' → ' + r.pos });
      else if (r.vP >= T.minViews && r.v7 != null && r.v7 < r.vP * (1 - T.viewsDrop)) alerts.push({ kind: 'views', q: r.q, text: 'показы ' + r.vP.toLocaleString('ru-RU') + ' → ' + r.v7.toLocaleString('ru-RU') + ' за неделю' });
      if (r.oP >= T.minOrders && r.o7 === 0) alerts.push({ kind: 'orders', q: r.q, text: 'заказы пропали: было ' + r.oP + ' за неделю, стало 0' });
      if (r.isNew && r.rank <= 3) alerts.push({ kind: 'new', q: r.q, text: 'новый запрос в топ-3' });
    });
    const gone = [...prevTop].filter((q) => !rows.some((r) => r.q === q)).slice(0, 3);
    hist.push({ d: today, q: rows.map((r) => [r.q, r.v7 ?? r.views30, r.o7 ?? r.orders30, r.pos]) });
    memory.top[k] = hist.slice(-8);   // a week back is all the comparison needs; keeps ads-memory.json small
    out.push({ store: v.m.store, id: v.m.id, name: v.m.name, nm: i.nm, key: i.key, product: i.product, spend30: rows.reduce((s, r) => s + r.spend30, 0), rows, alerts, gone });
  }));
  // forget products that left the running campaigns three weeks ago
  Object.keys(memory.top).forEach((k) => { const h = memory.top[k]; if (!h.length || h[h.length - 1].d < dayMinus(today, 21)) delete memory.top[k]; });
  return out.sort((a, b) => b.alerts.length - a.alerts.length || b.spend30 - a.spend30).slice(0, T.maxProducts);
}
