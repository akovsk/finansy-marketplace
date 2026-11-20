// Daily skills of the ads agents and the agents' own measured impact.
//
// Skills: analyses the agents run on every check once they have learned them. One new skill is learned per Moscow day,
// in the order of CURRICULUM; a learned skill stays. Every skill only reads statistics, metrics, bids and search
// queries — none of them starts, pauses or finishes anything (owner's rule). Each one returns findings for the
// dashboard and the report (out.insights). When the list runs out, no new skill appears until new ones are written.
//
// Impact: what the campaigns the agents worked on looked like before the agents' first action on them (the snapshot
// taken at that moment) and now — spend and profit per day, ДРР — plus the money that went to excluded queries
// and the decisions already checked a week later. The achievements board in the dashboard shows only this.
import { snapshot } from './ads-brain.mjs';

const R = (x) => Math.round(+x || 0);
const DAY = 864e5;
const pct = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '%');
const rub = (x) => R(x).toLocaleString('ru-RU') + ' ₽';
const signRub = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + rub(Math.abs(x));
const title = (m) => String(m.name || '').trim().replace(/^(СРС|CPC|АРК|АУК|AI)\s+/i, '').replace(/^\d{5,}\s*/, '').replace(/_/g, ' ').replace(/\s+[A-Z]$/, '').replace(/\s+/g, ' ').slice(0, 40) + ' (РК ' + m.id + ')';
const active = (ctx) => ctx.metrics.filter((m) => m.status === 9);
const views = (ctx) => (ctx.views || []).filter((v) => v.kind === 'active');
const WD = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
// Profit the ads of a campaign left over the period: bought-out order sum × margin before ads − ad spend
const adProfit = (m, w) => (m.margin == null ? null : w.ordSum * m.buyout * m.margin - w.spend);
// Weekly totals of a campaign's search clusters (last 7 days and the 7 before)
function weekOf(v) {
  const z = () => ({ views: 0, clicks: 0, orders: 0, spend: 0 }), s = { w7: z(), p7: z() };
  v.items.forEach((i) => ['w7', 'p7'].forEach((b) => Object.keys(s[b]).forEach((f) => { s[b][f] += ((i.week || {})[b] || {})[f] || 0; })));
  return s;
}

export const CURRICULUM = [
  { id: 'profit', text: 'Считает прибыль от рекламы по каждой кампании: сколько остаётся после расходов на рекламу за 30 дней', run(ctx) {
    const L = active(ctx).map((m) => ({ m, p: adProfit(m, m.w30) })).filter((x) => x.p != null && x.m.w30.spend > 0).sort((a, b) => b.p - a.p);
    if (!L.length) return [];
    const tot = L.reduce((s, x) => s + x.p, 0);
    return ['Реклама в ' + L.length + ' активных кампаниях за 30 дней: ' + signRub(tot) + ' прибыли после расходов на неё.']
      .concat(L.slice(0, 2).filter((x) => x.p > 0).map((x, i) => (i ? 'Следом — ' : 'Больше всех приносит ') + title(x.m) + ': ' + signRub(x.p) + ' за 30 дней.'))
      .concat(L.slice(-3).reverse().filter((x) => x.p < 0).map((x) => 'В минусе ' + title(x.m) + ': ' + signRub(x.p) + ' за 30 дней.'));
  } },
  { id: 'budget', text: 'Прогнозирует, на сколько дней хватит бюджета кампании при нынешнем расходе', run(ctx) {
    return active(ctx).filter((m) => m.budget != null && m.spendPerDay > 50).map((m) => ({ m, d: m.budget / m.spendPerDay })).filter((x) => x.d < 2).sort((a, b) => a.d - b.d).slice(0, 5)
      .map((x) => title(x.m) + ': бюджета ' + rub(x.m.budget) + ' хватит примерно на ' + (x.d < 1 ? 'сутки' : Math.round(x.d) + ' дн.') + ' при расходе ' + rub(x.m.spendPerDay) + ' в день. Пополнить можете только вы.');
  } },
  { id: 'spike', text: 'Ловит всплеск расхода без заказов за последний день', run(ctx) {
    const out = [];
    active(ctx).forEach((m) => {
      const d = m.days.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)), last = d[d.length - 1], prev = d.slice(-8, -1);
      if (!last || prev.length < 4) return;
      const avg = prev.reduce((s, x) => s + (x[1] || 0), 0) / prev.length;
      if (last[1] > 300 && last[1] > avg * 2 && !last[2]) out.push(title(m) + ': ' + last[0].slice(8, 10) + '.' + last[0].slice(5, 7) + ' потрачено ' + rub(last[1]) + ' без заказов — вдвое больше обычного (' + rub(avg) + ' в день).');
    });
    return out.slice(0, 5);
  } },
  { id: 'cpc', text: 'Следит за ценой клика неделя к неделе по поисковым запросам', run(ctx) {
    return views(ctx).map((v) => ({ v, s: weekOf(v) })).filter(({ s }) => s.w7.clicks >= 30 && s.p7.clicks >= 30).map(({ v, s }) => ({ v, a: s.p7.spend / s.p7.clicks, b: s.w7.spend / s.w7.clicks }))
      .filter((x) => Math.abs(x.b / x.a - 1) >= 0.25).sort((x, y) => y.b / y.a - x.b / x.a).slice(0, 5)
      .map((x) => title(x.v.m) + ': клик ' + (x.b > x.a ? 'подорожал' : 'подешевел') + ' с ' + x.a.toFixed(1).replace('.', ',') + ' до ' + x.b.toFixed(1).replace('.', ',') + ' ₽ за неделю.');
  } },
  { id: 'cr', text: 'Следит за конверсией клика в заказ неделя к неделе', run(ctx) {
    return views(ctx).map((v) => ({ v, s: weekOf(v) })).filter(({ s }) => s.w7.clicks >= 50 && s.p7.clicks >= 50 && s.p7.orders >= 3).map(({ v, s }) => ({ v, a: s.p7.orders / s.p7.clicks, b: s.w7.orders / s.w7.clicks }))
      .filter((x) => x.b < x.a * 0.6 || x.b > x.a * 1.5).sort((x, y) => x.b / x.a - y.b / y.a).slice(0, 5)
      .map((x) => title(x.v.m) + ': в заказ переходит ' + (x.a * 100).toFixed(1).replace('.', ',') + '% → ' + (x.b * 100).toFixed(1).replace('.', ',') + '% кликов' + (x.b < x.a ? ' — стоит проверить карточку, цену и отзывы.' : '.'));
  } },
  { id: 'fresh', text: 'Находит новые запросы недели, которые уже приносят заказы', run(ctx) {
    return views(ctx).flatMap((v) => v.items.flatMap((i) => (i.fresh || []).map((q) => ({ v, q })))).sort((a, b) => b.q.orders - a.q.orders).slice(0, 5)
      .map(({ v, q }) => '«' + q.q + '» — ' + q.orders + ' заказ. за неделю, неделей раньше не было (' + title(v.m) + ').');
  } },
  { id: 'climb', text: 'Отмечает запросы, по которым товар поднялся в поиске', run(ctx) {
    return views(ctx).flatMap((v) => v.items.flatMap((i) => (i.top || []).filter((c) => c.wk && c.wk.w7.pos && c.wk.p7.pos && c.wk.p7.pos - c.wk.w7.pos >= 3).map((c) => ({ v, c })))).sort((a, b) => (b.c.wk.p7.pos - b.c.wk.w7.pos) - (a.c.wk.p7.pos - a.c.wk.w7.pos)).slice(0, 5)
      .map(({ v, c }) => '«' + c.q + '»: позиция ' + c.wk.p7.pos + ' → ' + c.wk.w7.pos + ' (' + title(v.m) + ').');
  } },
  { id: 'overlap', text: 'Находит товары, которые рекламируются сразу в нескольких кампаниях и делят показы', run(ctx) {
    const by = new Map();
    active(ctx).forEach((m) => m.nms.forEach((n) => { const k = m.store + '|' + n.nm; by.set(k, (by.get(k) || []).concat(m)); }));
    return [...by.entries()].filter(([, l]) => l.length > 1).slice(0, 5).map(([k, l]) => 'Артикул ' + k.split('|')[1] + ' идёт в ' + l.length + ' кампаниях (' + l.map((m) => m.id).join(', ') + ') — WB делит между ними показы.');
  } },
  { id: 'stockout', text: 'Сверяет рекламу с остатками: предупреждает, когда товар кончится раньше, чем реклама', run(ctx) {
    return active(ctx).filter((m) => m.stock > 0 && isFinite(m.stockDays) && m.stockDays < 7 && m.spendPerDay > 50).sort((a, b) => a.stockDays - b.stockDays).slice(0, 5)
      .map((m) => title(m) + ': товара на ' + Math.max(1, Math.round(m.stockDays)) + ' дн., а реклама тратит ' + rub(m.spendPerDay) + ' в день — нужна поставка, иначе показы уйдут в пустую карточку.');
  } },
  { id: 'weekday', text: 'Ищет дни недели, когда заказ с рекламы обходится дороже всего', run(ctx) {
    const s = Array.from({ length: 7 }, () => ({ spend: 0, orders: 0 }));
    active(ctx).forEach((m) => m.days.forEach((d) => { const w = new Date(d[0] + 'T12:00:00Z').getUTCDay(); if (isNaN(w)) return; s[w].spend += d[1] || 0; s[w].orders += d[2] || 0; }));
    const tot = s.reduce((a, x) => ({ spend: a.spend + x.spend, orders: a.orders + x.orders }), { spend: 0, orders: 0 });
    if (tot.orders < 50) return [];
    const L = s.map((x, w) => ({ w, cpo: x.orders ? x.spend / x.orders : null })).filter((x) => x.cpo != null).sort((a, b) => b.cpo - a.cpo), avg = tot.spend / tot.orders;
    return ['Дороже всего заказ с рекламы в ' + WD[L[0].w] + ': ' + rub(L[0].cpo) + ' против ' + rub(avg) + ' в среднем; дешевле всего в ' + WD[L[L.length - 1].w] + ': ' + rub(L[L.length - 1].cpo) + '.'];
  } },
  { id: 'focus', text: 'Оценивает, насколько товар зависит от одного поискового запроса', run(ctx) {
    return views(ctx).flatMap((v) => v.items.map((i) => { const top = (i.top || []).concat(i.good || []).sort((a, b) => b.orders - a.orders)[0]; return { v, i, top }; }))
      .filter((x) => x.top && x.i.total.orders >= 10 && x.top.orders / x.i.total.orders >= 0.6).slice(0, 5)
      .map((x) => '«' + x.top.q + '» даёт ' + pct(x.top.orders / x.i.total.orders) + ' рекламных заказов товара в ' + title(x.v.m) + ' — если он просядет, просядут продажи.');
  } },
  { id: 'trend', text: 'Прогнозирует ДРР на неделю по тренду последних дней', run(ctx) {
    return active(ctx).filter((m) => m.target != null && isFinite(m.drr7) && isFinite(m.drr14) && isFinite(m.drr30) && m.drr7 > m.drr14 && m.drr14 > m.drr30 && m.drr7 > m.target && m.w7.spend > 300).slice(0, 5)
      .map((m) => title(m) + ': ДРР растёт — 30 дн. ' + pct(m.drr30) + ' → 14 дн. ' + pct(m.drr14) + ' → 7 дн. ' + pct(m.drr7) + ' при цели ' + pct(m.target) + '.');
  } },
  { id: 'buyout', text: 'Учитывает выкуп: где ДРР от заказов скрывает убыток из-за невыкупа', run(ctx) {
    return active(ctx).filter((m) => m.buyout < 0.6 && m.w30.ordSum > 0).slice(0, 5)
      .map((m) => title(m) + ': выкупают ' + pct(m.buyout) + ' заказов — ДРР от заказов ' + pct(m.w30.spend / m.w30.ordSum) + ', а от выкупов ' + pct(m.drr30) + '.');
  } },
  { id: 'rating', text: 'Связывает рейтинг товара с конверсией рекламы', run(ctx) {
    const A = active(ctx).filter((m) => m.cr != null && m.clicks >= 100);
    const crAvg = A.length ? A.reduce((s, m) => s + m.w30.orders, 0) / Math.max(1, A.reduce((s, m) => s + m.clicks, 0)) : null;
    return A.filter((m) => m.rating && m.rating < 4.6 && crAvg && m.cr < crAvg * 0.7).slice(0, 5)
      .map((m) => title(m) + ': рейтинг ' + m.rating.toFixed(2).replace('.', ',') + ', конверсия клика ' + (m.cr * 100).toFixed(1).replace('.', ',') + '% против ' + (crAvg * 100).toFixed(1).replace('.', ',') + '% в среднем — реклама ведёт на карточку, которой меньше доверяют.');
  } },
];

// One new skill per Moscow day: the next one from the list, if none was learned today yet
export function learnSkills(memory, today) {
  const L = (memory.curriculum = memory.curriculum || []);
  if (!L.some((x) => x.since === today)) {
    const next = CURRICULUM.find((s) => !L.some((x) => x.id === s.id));
    if (next) L.push({ id: next.id, since: today });
  }
  return L;
}
export const nextSkill = (memory) => CURRICULUM.find((s) => !(memory.curriculum || []).some((x) => x.id === s.id)) || null;

// Findings of every learned skill (a failing skill is skipped, the rest still report)
export function runSkills(memory, ctx) {
  const out = [];
  (memory.curriculum || []).forEach((x) => {
    const s = CURRICULUM.find((c) => c.id === x.id); if (!s) return;
    try { const items = s.run(ctx).filter(Boolean).slice(0, 6); if (items.length) out.push({ skill: s.id, text: s.text, since: x.since, items }); }
    catch (e) { out.push({ skill: s.id, text: s.text, since: x.since, items: [], error: String(e.message).slice(0, 160) }); }
  });
  return out;
}

// What the agents changed in money, campaign by campaign: before their first action on a campaign and now
const ACTS = ['lower', 'raise', 'minus', 'boost', 'pause', 'stop', 'drop'];
export function impactView({ hist, metrics, memory }) {
  const ok = hist.filter((a) => a.result === 'ok' && ACTS.includes(a.action)).sort((a, b) => (a.t < b.t ? -1 : 1));
  const first = new Map();
  ok.forEach((a) => { const k = a.store + ':' + a.id; if (a.snap && !first.has(k)) first.set(k, a); });
  const mOf = new Map(metrics.map((m) => [m.store + ':' + m.id, m]));
  const z = () => ({ camps: 0, spendBefore: 0, spendNow: 0, profitBefore: 0, profitNow: 0, profitN: 0, drrB: 0, drrN: 0, drrW: 0, drrWN: 0 });
  const plat = { wb: z(), ozon: z() };
  first.forEach((a, k) => {
    const m = mOf.get(k), p = plat[a.platform === 'ozon' || String(a.store).startsWith('oz') ? 'ozon' : 'wb'];
    const before = a.snap, now = m && m.status === 9 ? snapshot(m) : { spendDay: 0, profitDay: 0, drr: null };
    p.camps++; p.spendBefore += before.spendDay || 0; p.spendNow += now.spendDay || 0;
    if (before.profitDay != null && now.profitDay != null) { p.profitBefore += before.profitDay; p.profitNow += now.profitDay; p.profitN++; }
    if (before.drr != null && before.spendDay) { p.drrB += before.drr * before.spendDay; p.drrW += before.spendDay; }
    if (now.drr != null && now.spendDay) { p.drrN += now.drr * now.spendDay; p.drrWN += now.spendDay; }
  });
  const minus = ok.filter((a) => a.action === 'minus');
  const spendOf = (a) => (a.spend != null ? a.spend : +(((a.reason || '').match(/\(([\d\s  ]+) ₽ за 30 дней\)/) || [])[1] || '0').replace(/\D/g, ''));
  const outc = memory.outcomes || [];
  const sum = (f) => plat.wb[f] + plat.ozon[f];
  const drr = (n, w) => (w ? Math.round((n / w) * 1000) / 1000 : null);
  return {
    since: ok.length ? ok[0].t.slice(0, 10) : null,
    camps: sum('camps'),
    spendBeforeDay: R(sum('spendBefore')), spendNowDay: R(sum('spendNow')), spendSavedDay: R(sum('spendBefore') - sum('spendNow')),
    profitBeforeDay: R(sum('profitBefore')), profitNowDay: R(sum('profitNow')), profitGainDay: R(sum('profitNow') - sum('profitBefore')),
    drrBefore: drr(sum('drrB'), sum('drrW')), drrNow: drr(sum('drrN'), sum('drrWN')),
    wasteMonth: R(minus.reduce((s, a) => s + spendOf(a), 0)), queriesOut: minus.reduce((s, a) => s + (a.n || 0) + (a.moved || 0), 0),
    bids: ok.filter((a) => ['lower', 'raise', 'boost'].includes(a.action)).length,
    launched: hist.filter((a) => a.action === 'launch' && a.result === 'ok').length,
    checked: outc.length, helped: outc.filter((o) => o.verdict === 'helped').length, checkedEffect: R(outc.reduce((s, o) => s + (o.effect || 0), 0)),
    byPlat: Object.fromEntries(Object.entries(plat).filter(([, x]) => x.camps).map(([k, x]) => [k, { camps: x.camps, spendSavedDay: R(x.spendBefore - x.spendNow), profitGainDay: R(x.profitNow - x.profitBefore) }])),
  };
}
