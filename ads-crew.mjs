// The whole crew works every hourly check, each on its own part, and each writes one journal entry per hour:
// either something it learned from the fresh numbers ("learn") or a new action it proposes for the account ("idea").
//   wb       — Марк, агент WB: ставки и статистика кампаний WB
//   ozon     — Оскар, агент Ozon: ставки и целевой ДРР в Ozon
//   queries  — Вера, чистильщик запросов: поисковые кластеры, слив, продающие запросы
//   products — Пётр, подборщик товаров: товары без рекламы, кампания дня
//   audit    — Соня, ревизор решений: проверка прошлых решений через неделю, подстройка порогов
// Everything is built from the account's real numbers; an idea is a proposal for the owner, never an action the agents
// take outside their rules (they never pause or finish campaigns). Shift: 04:00–00:00 Moscow (ads-agent.yml).
const R = (x) => Math.round(+x || 0);
const pct = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '%');
const rub = (x) => R(x).toLocaleString('ru-RU') + ' ₽';
const nm = (m) => String(m.name || '').trim().replace(/^(СРС|CPC|АРК|АУК|AI)\s+/i, '').replace(/^\d{5,}\s*/, '').replace(/_/g, ' ').replace(/\s+[A-Z]$/, '').replace(/\s+/g, ' ').slice(0, 36);
const ddmm = (t) => new Date(t).toISOString().slice(5, 10).split('-').reverse().join('.');
export const CREW = { wb: 'Марк', ozon: 'Оскар', queries: 'Вера', products: 'Пётр', audit: 'Соня' };

function forWB(ctx, plat) {
  const { metrics, out } = ctx, A = metrics.filter((m) => m.platform === plat && m.status === 9);
  const acts = out.actions.filter((a) => (a.platform || 'wb') === plat);
  const n = (k) => acts.filter((a) => a.action === k).length;
  const did = A.length ? ['Проверил ' + A.length + ' активных кампаний ' + (plat === 'ozon' ? 'Ozon' : 'WB') + ': ставка ниже — ' + n('lower') + ', выше — ' + n('raise') + (plat === 'wb' ? ', запросы — ' + n('minus') : '') + (n('launch') ? ', кампания дня ' + (acts.find((a) => a.action === 'launch').result === 'ok' ? 'создана' : acts.find((a) => a.action === 'launch').result === 'planned' ? 'запланирована' : 'не создалась') : '')] : ['Кампаний ' + (plat === 'ozon' ? 'Ozon' : 'WB') + ' в работе нет'];
  const learn = [], idea = [];
  const sp7 = A.reduce((s, m) => s + m.w7.spend, 0), sp30 = A.reduce((s, m) => s + m.w30.spend, 0), o7 = A.reduce((s, m) => s + m.w7.orders, 0);
  const os7 = A.reduce((s, m) => s + m.w7.ordSum * m.buyout, 0), os30 = A.reduce((s, m) => s + m.w30.ordSum * m.buyout, 0);
  if (sp7 > 0) learn.push('За неделю реклама тратила ' + rub(sp7 / 7) + ' в день и давала ' + (o7 / 7).toFixed(1).replace('.', ',') + ' заказа в день; ДРР за 7 дней ' + pct(os7 ? sp7 / os7 : null) + ' против ' + pct(os30 ? sp30 / os30 : null) + ' за 30.');
  const better = A.filter((m) => isFinite(m.drr7) && isFinite(m.drr30) && m.drr7 < m.drr30 * 0.85).length, worse = A.filter((m) => isFinite(m.drr7) && isFinite(m.drr30) && m.drr7 > m.drr30 * 1.15).length;
  if (better + worse) learn.push('Сравнил неделю с месяцем: ДРР лучше в ' + better + ' кампаниях, хуже в ' + worse + '.');
  const top = A.filter((m) => m.w30.spend > 0 && m.margin != null).map((m) => ({ m, p: m.w30.ordSum * m.buyout * m.margin - m.w30.spend })).sort((a, b) => b.p - a.p);
  if (top.length) learn.push('Лучше всех сейчас «' + nm(top[0].m) + '»: ' + (top[0].p >= 0 ? '+' : '−') + rub(Math.abs(top[0].p)) + ' за 30 дней после рекламы.');
  (ctx.insights || []).forEach((x) => (x.items || []).slice(0, 2).forEach((t) => learn.push('Навык «' + x.text.split(':')[0].toLowerCase() + '» показал: ' + t)));
  const scale = A.filter((m) => m.target != null && isFinite(m.drr14) && m.drr14 < m.target * 0.6 && m.w14.orders >= 5).sort((a, b) => a.drr14 - b.drr14)[0];
  if (scale) idea.push('Предлагаю масштабировать «' + nm(scale) + '»: ДРР за 14 дней ' + pct(scale.drr14) + ' при цели ' + pct(scale.target) + ' — поднимать ставку по 15% в сутки, пока ДРР не подойдёт к цели.');
  const falling = A.find((m) => isFinite(m.drr7) && isFinite(m.drr30) && m.drr7 < m.drr30 * 0.7 && m.w7.orders >= 3);
  if (falling) idea.push('У «' + nm(falling) + '» ДРР за неделю упал до ' + pct(falling.drr7) + ' (за месяц ' + pct(falling.drr30) + '). Если продержится ещё 3 дня — предложу поднять ставку.');
  const short = A.find((m) => m.stock > 0 && isFinite(m.stockDays) && m.stockDays < 10 && m.spendPerDay > 50);
  if (short) idea.push('Товара «' + nm(short) + '» хватит на ' + Math.max(1, R(short.stockDays)) + ' дн. Предлагаю заранее снизить ставку, чтобы растянуть остаток до поставки.');
  (out.attention || []).filter((a) => (a.platform || 'wb') === plat).slice(0, 1).forEach((a) => idea.push('Предлагаю вам решить судьбу «' + nm(a) + '» (РК ' + a.id + '): ставка уже минимальная, а реклама в минусе. Остановить её могу не я — только вы.'));
  if (plat === 'ozon') {
    const kinds = A.reduce((s, m) => { s[m.strategy || 'другая'] = (s[m.strategy || 'другая'] || 0) + 1; return s; }, {});
    learn.push('Стратегии кампаний Ozon: ' + Object.entries(kinds).map(([k, v]) => ({ TARGET_BIDS: 'ставка за клик', TARGET_CIR: 'целевой ДРР' }[k] || 'автостратегия') + ' — ' + v).join(', ') + '. Менять могу ставку за клик и целевой ДРР.');
    const planned = acts.filter((a) => a.result === 'planned' && a.action !== 'launch').length;
    if (ctx.cfg.ozon.mode !== 'live' && planned) idea.push('Предлагаю перевести ставки Ozon в боевой режим: в этой проверке запланировано ' + planned + ' изменений, ошибок нет — сейчас они только на бумаге.');
  }
  return { did, learn, idea };
}

function forQueries(ctx) {
  const V = (ctx.views || []).filter((v) => v.kind === 'active'), memory = ctx.memory;
  const items = V.flatMap((v) => v.items.map((i) => ({ v, i })));
  const flagged = items.flatMap(({ v, i }) => i.clusters.map((c) => ({ v, i, c })));
  const waste = flagged.filter((x) => !x.c.orders), wasteSum = waste.reduce((s, x) => s + x.c.spend, 0);
  const check = flagged.filter((x) => x.c.flag === 'check');
  const did = V.length ? ['Разобрала запросы ' + V.length + ' кампаний: проблемных ' + flagged.length + ' (без заказов — ' + waste.length + ' на ' + rub(wasteSum) + '), спорных ' + check.length] : ['Активных кампаний с поисковыми запросами нет'];
  const learn = [], idea = [];
  if (waste.length) { const w = waste.sort((a, b) => b.c.spend - a.c.spend)[0]; learn.push('Самый дорогой запрос без заказов — «' + w.c.q + '»: ' + rub(w.c.spend) + ' и ' + w.c.clicks + ' кликов за 30 дней в «' + nm(w.v.m) + '».'); }
  const good = items.flatMap(({ v, i }) => (i.good || []).map((c) => ({ v, c }))).sort((a, b) => b.c.orders - a.c.orders);
  if (good.length) learn.push('Лучший продающий запрос — «' + good[0].c.q + '»: ' + good[0].c.orders + ' заказов в «' + nm(good[0].v.m) + '». Всего продающих запросов сейчас ' + good.length + '.');
  const kb = Object.values(memory.queries || {}), bad = kb.reduce((s, x) => s + Object.keys(x.bad || {}).length, 0), gd = kb.reduce((s, x) => s + Object.keys(x.good || {}).length, 0);
  const wbA = ctx.metrics.filter((m) => m.platform === 'wb' && m.status === 9), cpc = wbA.filter((m) => m.payType === 'cpc');
  if (wbA.length) learn.push('Из ' + wbA.length + ' активных кампаний WB с оплатой за клик — ' + cpc.length + ': в них WB не даёт исключать запросы через API, там помогаю ставкой; в остальных ' + (wbA.length - cpc.length) + ' исключаю плохие запросы сама.');
  if (bad + gd) learn.push('В моей базе по товарам: ' + bad + ' исключённых запросов и ' + gd + ' продающих — переношу исключения между кампаниями одного товара.');
  (ctx.out.queryAdvice || []).slice(0, 1).forEach((x) => idea.push('Предлагаю для «' + nm(x) + '» завести кампанию с оплатой за показы: там можно исключать запросы, а в кампании за клик «' + x.queries[0].q + '» сливает ' + rub(x.queries[0].spend) + ' за 30 дней.'));
  if (check.length) { const c = check.sort((a, b) => b.c.spend - a.c.spend)[0]; idea.push('Предлагаю разобрать спорный запрос «' + c.c.q + '» (' + rub(c.c.spend) + ', ' + c.c.clicks + ' кликов без заказа): он похож на сам товар. С ключом Claude разберу такие запросы по смыслу.'); }
  const fresh = items.flatMap(({ v, i }) => (i.fresh || []).map((q) => ({ v, q })))[0];
  if (fresh) idea.push('Новый запрос «' + fresh.q.q + '» за неделю принёс ' + fresh.q.orders + ' заказ. — предлагаю держать на нём ставку и следить за позицией.');
  const cpmGood = good.find((x) => x.v.m.payType === 'cpm' && x.v.m.bidType === 'manual');
  if (cpmGood) idea.push('Предлагаю поднять ставку на кластер «' + cpmGood.c.q + '» в «' + nm(cpmGood.v.m) + '»: он продаёт дешевле прибыли.');
  return { did, learn, idea };
}

function forProducts(ctx) {
  const { pool, out, econ, metrics, cfg } = ctx;
  const stores = new Set(metrics.map((m) => m.store)), busy = new Set(metrics.filter((m) => [4, 9, 11].includes(m.status)).flatMap((m) => m.nms.map((n) => m.store + '|' + n.nm)));
  const L = cfg.launch, why = {}; let seen = 0; const near = [];
  econ.forEach((e, k) => {
    if (!stores.has(e.store) || busy.has(e.store + '|' + e.sku) || !e.q) return;
    seen++;
    const st = ((ctx.market.stocks || {})[k] || {}).q || 0, sd = st / (e.q / 30), fail = [];
    if (e.margin == null || e.margin < L.minMargin) fail.push('маржа ниже ' + pct(L.minMargin));
    if (st < L.minStock || sd < L.minStockDays) fail.push('мало остатка');
    if (e.q < L.minSales30) fail.push('мало продаж');
    fail.forEach((f) => { why[f] = (why[f] || 0) + 1; });
    if (fail.length === 1 && fail[0] === 'мало остатка' && e.margin >= L.minMargin) near.push(e);
  });
  const launched = out.actions.filter((a) => a.action === 'launch');
  const did = ['Перебрал товары без рекламы: ' + seen + ' шт., подходят ' + pool.length + (launched.length ? '; кампания дня — «' + nm(launched[0]) + '» (' + (launched[0].result === 'ok' ? 'создана' : launched[0].result === 'planned' ? 'запланирована' : 'не вышло') + ')' : '')];
  const learn = [], idea = [];
  const top = Object.entries(why).sort((a, b) => b[1] - a[1])[0];
  if (top) learn.push('Из ' + seen + ' товаров без рекламы чаще всего отсеивает «' + top[0] + '» — у ' + top[1] + ' товаров.');
  if (pool.length) learn.push('Подходят под рекламу ' + pool.length + ' товаров; лучший по расчёту — «' + nm(pool[0]) + '»' + (pool[0].per1000 != null ? ': на 1000 ₽ рекламы около +' + rub(pool[0].per1000) : '') + '.');
  const nextUp = pool.find((c) => !launched.some((a) => String(a.sku) === String(c.sku)));
  if (nextUp) idea.push('Предлагаю следующей кампанией «' + nm(nextUp) + '» (' + (nextUp.platform === 'ozon' ? 'Ozon' : 'WB') + '): маржа ' + pct(nextUp.margin) + ', запас на ' + nextUp.stockDays + ' дн.');
  if (near[0]) idea.push('«' + nm(near[0]) + '» прошёл бы отбор, но мало остатка. Предлагаю пополнить склад — после поставки предложу кампанию.');
  if (!pool.length) idea.push('Сейчас ни один товар без рекламы не окупит её по расчёту. Предлагаю поднять цену или снизить себестоимость у товаров с маржой чуть ниже ' + pct(L.minMargin) + ' — тогда они пройдут отбор.');
  return { did, learn, idea };
}

function forAudit(ctx) {
  const { memory, hist, now, fresh = [], tuned = [] } = ctx;
  const pend = hist.filter((a) => a.result === 'ok' && !a.evaluated && ['lower', 'raise', 'minus', 'launch'].includes(a.action));
  const first = pend.map((a) => Date.parse(a.t) + (a.action === 'launch' ? 14 : 7) * 864e5).sort((a, b) => a - b)[0];
  const outc = memory.outcomes || [];
  const did = ['Проверила решения: новых итогов — ' + fresh.length + ', ждут недели — ' + pend.length + (first ? ' (первые итоги ' + ddmm(first) + ')' : '')];
  const learn = [], idea = [];
  fresh.slice(0, 2).forEach((o) => learn.push('Итог через неделю: «' + nm(o) + '», ' + ({ lower: 'снижение ставки', raise: 'повышение ставки', minus: 'исключение запросов', launch: 'новая кампания', pause: 'пауза', stop: 'закрытие' }[o.action] || o.action) + ' — ' + ({ helped: 'помогло', hurt: 'навредило', neutral: 'без заметного эффекта' }[o.verdict]) + (o.effect ? ' (' + (o.effect > 0 ? '+' : '−') + rub(Math.abs(o.effect)) + ' за неделю)' : '') + '.'));
  tuned.forEach((t) => learn.push('Подстроила порог «' + t.key + '»: ' + t.from + ' → ' + t.to + '. ' + t.why));
  if (outc.length) { const h = outc.filter((o) => o.verdict === 'helped').length, b = outc.filter((o) => o.verdict === 'hurt').length; learn.push('Всего проверено решений: ' + outc.length + ' — помогли ' + h + ', навредили ' + b + ', итог ' + (outc.reduce((s, o) => s + (o.effect || 0), 0) >= 0 ? '+' : '−') + rub(Math.abs(outc.reduce((s, o) => s + (o.effect || 0), 0))) + ' за неделю.'); }
  if (pend.length) learn.push('Жду недели по ' + pend.length + ' решениям; к ' + ddmm(first) + ' будут первые цифры «до и после».');
  const lows = outc.filter((o) => o.action === 'lower').slice(-6);
  if (lows.length >= 3 && lows.filter((o) => o.verdict === 'hurt').length > lows.length / 2) idea.push('Предлагаю снижать ставку шагом поменьше: из последних ' + lows.length + ' снижений большинство навредили.');
  if (pend.length) idea.push('Предлагаю сравнить кампании, где ставку снижали, с похожими, где её не трогали: так будет видно, что дало именно решение агента, а что — рынок.');
  idea.push('Предлагаю раз в неделю показывать вам три лучших и три худших решения агентов с цифрами — чтобы было видно, чему они научились.');
  return { did, learn, idea };
}

// One run: what each agent did this hour and its journal entry (learn on even hours, an idea on odd ones; the other
// kind when there is nothing new). Repeats of the last 24 entries are skipped, so the journal moves on.
export function crewWork(ctx) {
  const hour = new Date(ctx.now + 3 * 3600e3).getUTCHours(), t = new Date(ctx.now).toISOString();
  const work = { wb: forWB(ctx, 'wb'), ozon: forWB(ctx, 'ozon'), queries: forQueries(ctx), products: forProducts(ctx), audit: forAudit(ctx) };
  const J = (ctx.memory.crew = ctx.memory.crew || {});
  const out = {};
  Object.entries(work).forEach(([k, w]) => {
    if (k === 'ozon' && !ctx.metrics.some((m) => m.platform === 'ozon')) return;
    const log = (J[k] = J[k] || []), recent = new Set(log.slice(-24).map((e) => e.text));
    const order = hour % 2 ? ['idea', 'learn'] : ['learn', 'idea'];
    let entry = null;
    for (const kind of order) { const text = (w[kind] || []).find((x) => x && !recent.has(x)); if (text) { entry = { t, kind, text }; break; } }
    if (entry && !log.some((e) => e.t === t)) { log.push(entry); J[k] = log.slice(-120); }
    out[k] = { name: CREW[k], did: w.did, entry, journal: J[k].slice(-30) };
  });
  return out;
}
