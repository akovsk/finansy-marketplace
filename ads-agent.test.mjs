// Checks of the agent's decision logic and hard limits on small made-up data: node ads-agent.test.mjs
import assert from 'node:assert/strict';
import { mergeConfig, run, guard, newBids, stopReason, normCampaign, judgeCluster, launchCandidates, skuEconomics } from './ads-agent.mjs';
import { parseApprovals, planText } from './ads-plan.mjs';
import { normOzonCampaign, ozonStats, ozonBids, num } from './ozon-ads.mjs';
import { emptyMemory, applyTuning, tune, evaluateOutcomes, autoTune, TUNE_BOUNDS } from './ads-brain.mjs';

const NOW = Date.parse('2026-11-16T09:00:00Z');
const day = (n) => new Date(NOW - n * 864e5).toISOString().slice(0, 10);
// data.json: one store, per-SKU daily rows [day, q, ret, rev, comm, log, stor, adv, cogs, tax, np, lost]
const sku = (id, revDay, npDay, advDay) => ({ s: 0, sku: String(id), n: 'Товар ' + id, d: Array.from({ length: 30 }, (_, i) => [138 + i, 2, 0, revDay, 0, 0, 0, -advDay, -100, 0, npDay, 0]) });
const data = { start: '2026-06-01', end: '2026-11-15', stores: [{ id: 'wb1', name: 'Магазин', mp: 'WB' }], cols: ['day', 'q', 'ret', 'rev', 'comm', 'log', 'stor', 'adv', 'cogs', 'tax', 'np', 'lost'],
  products: [sku(1, 1000, 250, 50), sku(2, 1000, 50, 250), sku(3, 1000, -100, 50), sku(4, 1000, 350, 50), sku(5, 1000, 250, 50), sku(6, 1000, 300, 0)] };
// market.json ad row: spend/orders spread evenly over 30 days
const ad = (id, nm, spend, orders, ordSum, clicks = 600) => ({ s: 'wb1', id, name: 'РК ' + id, st: 9, spend, views: 20000, clicks, cart: 80, orders, ordSum, bud: 500, nms: ['Магазин|' + nm], nmS: { ['Магазин|' + nm]: spend }, days: Array.from({ length: 30 }, (_, i) => [day(i), spend / 30, orders / 30, ordSum / 30]) });
const market = { generated: '2026-11-16T08:00:00Z',
  ads: [ad(101, 1, 4500, 30, 30000), ad(102, 2, 9000, 30, 30000), ad(103, 3, 3000, 30, 30000), ad(104, 4, 1500, 40, 40000), ad(105, 5, 4000, 0, 0), ad(106, 1, 200, 1, 1000, 20), ad(107, 5, 3000, 30, 30000)],
  stocks: { 'Магазин|1': { q: 500 }, 'Магазин|2': { q: 500 }, 'Магазин|3': { q: 500 }, 'Магазин|4': { q: 500 }, 'Магазин|5': { q: 0 }, 'Магазин|6': { q: 500 } },
  funnel: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => ['Магазин|' + n, n === 6 ? { bp: 100, v: 1000, o: 100 } : { bp: 100 }])), reviews: {} };

function mockApi(calls) {
  const camp = (id, nm) => ({ id, status: 9, bid_type: 'unified', settings: { name: 'РК ' + id, payment_type: 'cpm', placements: { search: true, recommendations: true } }, nm_settings: [{ nm_id: nm, bids_kopecks: { search: 30000, recommendations: 30000 } }] });
  const rec = (name) => async (...a) => { calls.push([name, ...a]); return name === 'create' ? 999 : null; };
  return { list: async () => [camp(101, 1), camp(102, 2), camp(103, 3), camp(104, 4), camp(105, 5), camp(106, 1), camp(107, 5)].map(normCampaign),
    minBids: async (c) => Object.fromEntries(c.nms.map((n) => [n.nm, { combined: 25000 }])),
    setBids: rec('setBids'), start: rec('start'), pause: rec('pause'), stop: rec('stop'), deposit: rec('deposit'), create: rec('create') };
}
const go = async (over = {}, extra = {}) => { const calls = []; const out = await run({ cfg: mergeConfig(over), data, market, state: extra.state || {}, memory: extra.memory, apis: { wb1: { ...mockApi(calls), ...(extra.api || {}) } }, now: extra.now || NOW, brain: extra.brain }); return { out, calls, by: Object.fromEntries(out.campaigns.map((c) => [c.id, c])) }; };

// 1. Rules on their own
{
  const { by, calls, out } = await go({ stores: ['wb1'] });
  assert.equal(by[101].action, 'keep', 'ДРР 15% при цели 18% (маржа 30%) — в норме');
  assert.equal(by[102].action, 'lower', 'ДРР 30% при марже 30%: выше цели, но не убыток x1.4 — снижать');
  assert.equal(by[102].bidPct, -25);
  assert.equal(by[103].action, 'pause', 'товар убыточен до рекламы — пауза, а не закрытие (запросы сохраняются)');
  assert.match(by[103].reason, /а не закрываю/);
  assert.equal(by[104].action, 'raise', 'ДРР 3.75% при цели 24% — масштабировать');
  assert.equal(by[105].action, 'pause', '4000 ₽ без заказов — на паузу');
  assert.equal(by[106].action, 'keep', 'мало данных — ждать');
  assert.equal(by[107].action, 'pause', 'нет остатка — пауза');
  assert.equal(calls.length, 0, 'dry-run ничего не отправляет в WB');
  assert.equal(out.history.length, 0, 'dry-run не пишет историю');
  assert.ok(out.actions.every((a) => a.result === 'planned'));
  const low = out.actions.find((a) => a.id === 102);
  assert.deepEqual(low.bids, [{ nm: 2, placement: 'combined', wasRub: 300, rub: 250 }], '−25% от 300 ₽ = 225 ₽, но минимум WB 250 ₽');
}
// 2. Live mode sends exactly the planned calls and remembers them
{
  const { calls, out } = await go({ stores: ['wb1'], mode: 'live' });
  const names = calls.map((c) => c[0] + ':' + c[1]).sort();
  assert.deepEqual(names, ['pause:103', 'pause:105', 'pause:107', 'setBids:102', 'setBids:104'], 'в WB ничего не закрывается насовсем');
  assert.deepEqual(calls.find((c) => c[0] === 'setBids' && c[1] === 104)[2], [{ nm: 4, placement: 'combined', kop: 34500, was: 30000 }]);
  assert.equal(out.history.length, 5);
  assert.ok(out.camp[102].lastBidAt && out.camp[107].pausedByAgent);
  assert.equal(out.camp[103].pausedFor, 'loss'); assert.equal(out.camp[107].pausedFor, 'stock');
  // next run 2 hours later: cooldown blocks a second bid change
  const calls2 = []; const again = await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live' }), data, market, state: out, apis: { wb1: mockApi(calls2) }, now: NOW + 2 * 3600e3 });
  assert.ok(!calls2.some((c) => c[0] === 'setBids'), 'повторно ставку в течение суток не меняет');
  assert.match(again.campaigns.find((c) => c.id === 102).blocked, /жду статистику/);
}
// 3. Claude's proposals cannot get past the hard limits
{
  const pickAct = (uid) => ({ 'wb1:101': 'stop', 'wb1:102': 'raise', 'wb1:104': 'raise', 'wb1:106': 'lower' }[uid] || 'keep');
  const brain = async ({ rows }) => ({ summary: 'Тест.', decisions: rows.map((r) => ({ uid: r.uid, action: pickAct(r.uid), bidPct: 80, reason: 'Проверка.' })).concat([{ uid: 'wb1:555', action: 'stop', bidPct: 0, reason: 'чужая' }]),
    lessons: ['Урок 1'], tune: [{ key: 'bid.maxStepPct', value: 5, why: 'тест' }, { key: 'budget.dailyCap', value: 999999, why: 'нельзя' }], helpers: [{ role: 'Новый помощник', task: 'Задача' }], helpersUsed: [{ role: 'Новый помощник', report: 'Отчёт' }] });
  const { by, out, calls } = await go({ stores: ['wb1'], mode: 'live' }, { brain });
  assert.deepEqual(out.memory.lessons, ['Урок 1'], 'уроки сохраняются в память');
  assert.equal(out.memory.tuned['bid.maxStepPct'], 19, 'порог двигается не больше чем на четверть за запуск (25 → 19)');
  assert.ok(!('budget.dailyCap' in out.memory.tuned), 'денежные лимиты агент менять не может');
  assert.equal(out.memory.helpers[0].role, 'Новый помощник'); assert.equal(out.learned.helpers[0].report, 'Отчёт');
  assert.equal(out.engine, 'claude');
  assert.equal(by[101].action, 'keep', 'прибыльную кампанию закрыть нельзя'); assert.ok(by[101].blocked);
  assert.equal(by[102].action, 'keep', 'повышать ставку при ДРР выше цели нельзя');
  assert.equal(by[104].bidPct, 15, 'шаг повышения урезан с 80% до 15%');
  assert.equal(by[106].action, 'keep', 'мало данных — ставку не трогаем');
  assert.ok(!by[555] && !calls.some((c) => c[1] === 555), 'неизвестная кампания игнорируется');
  assert.equal(by[103].action, 'keep', 'Claude решил не останавливать — его право');
}
// 4. If Claude fails, the rules take over
{
  const { out, by } = await go({ stores: ['wb1'] }, { brain: async () => { throw new Error('boom'); } });
  assert.equal(out.engine, 'rules'); assert.equal(by[103].action, 'pause'); assert.match(out.errors[0], /Claude недоступен/);
}
// 5. Limits: stops per run, protect list, bid cap, launch and top-up are off unless enabled
{
  const a = await go({ stores: ['wb1'], stop: { maxPerRun: 1 } });
  assert.equal(a.out.actions.filter((x) => x.loss).length, 1, 'лимит пауз из-за убытка за запуск');
  const b = await go({ stores: ['wb1'], protect: [103] });
  assert.equal(b.by[103].action, 'keep');
  const m = { payType: 'cpm', bidType: 'manual', nms: [{ nm: 1, search: 99000, recom: 0 }] };
  assert.deepEqual(newBids(m, 15, mergeConfig({}), {}).map((x) => x.kop), [100000], 'потолок ставки 1000 ₽');
  assert.equal(a.out.actions.filter((x) => x.action === 'launch' || x.action === 'topup').length, 0);
  const c = await go({ stores: ['wb1'], mode: 'live', launch: { enabled: true }, budget: { autoTopUp: true } });
  const l = c.out.actions.find((x) => x.action === 'launch');
  assert.equal(l.sku, '6', 'запуск для прибыльного товара без рекламы'); assert.equal(l.id, 999);
  assert.deepEqual(c.calls.filter((x) => ['create', 'start'].includes(x[0])).map((x) => x[0]), ['create', 'start']);
  assert.ok(c.calls.some((x) => x[0] === 'deposit' && x[1] === 999 && x[2] === 1000));
}
// 6. stopReason never fires on thin data
assert.equal(stopReason({ status: 9, w30: { spend: 1000, orders: 0, ordSum: 0 }, w14: { spend: 500 }, margin: 0.3, drr30: Infinity, drr14: Infinity }, mergeConfig({})), null);
assert.equal(guard({ action: 'stop', reason: '' }, { id: 1, status: 9, w30: { spend: 1000, orders: 0, ordSum: 0 }, w14: { spend: 500 }, margin: 0.3 }, mergeConfig({}), {}, NOW).action, 'keep');
console.log('ads-agent: all checks passed');
// 7. New campaigns: total cap over all runs, enough stock in days, no relaunch of a closed SKU
{
  const launchCfg = { stores: ['wb1'], mode: 'live', launch: { enabled: true, maxPerRun: 5, maxTotal: 1 } };
  const first = await go(launchCfg);
  assert.equal(first.out.actions.filter((x) => x.action === 'launch').length, 1);
  const hist = first.out.history;
  const again = await go(launchCfg, { state: { history: hist } });
  assert.equal(again.out.actions.filter((x) => x.action === 'launch').length, 0, 'лимит maxTotal на все запуски');
  const closed = [...hist, { t: 'x', action: 'stop', result: 'ok', id: 999 }];
  const relaunch = await go({ ...launchCfg, launch: { ...launchCfg.launch, maxTotal: 5 } }, { state: { history: closed } });
  assert.ok(!relaunch.out.actions.some((x) => x.action === 'launch' && x.sku === '6'), 'закрытый товар не перезапускается');
  const thin = await go({ ...launchCfg, launch: { ...launchCfg.launch, minStockDays: 1000 } });
  assert.equal(thin.out.actions.filter((x) => x.action === 'launch').length, 0, 'мало запаса в днях — не запускать');
}
console.log('ads-agent: launch checks passed');

// 8. Launch estimate: a product whose expected return per click does not beat the click price is not launched
{
  const econ = skuEconomics(data), cfg = mergeConfig({ launch: { enabled: true } });
  const avg = { cpc: 7, cr: 0.04 };
  const ok = launchCandidates('Магазин', 'wb1', [], econ, market, cfg, new Set(['1', '2', '3', '4', '5']), avg);
  assert.equal(ok.length, 1); assert.equal(ok[0].crFrom, 'card'); assert.equal(ok[0].per1000, 500, '143 клика × 7% × 150 ₽ − 1000 ₽');
  const dear = launchCandidates('Магазин', 'wb1', [], econ, market, cfg, new Set(['1', '2', '3', '4', '5']), { cpc: 20, cr: 0.04 });
  assert.equal(dear.length, 0, 'клик дороже отдачи — не запускать');
}
// 9. Search queries: exclusions by numbers, the helper's proposals re-checked, exclusions carried to the product's other campaigns
{
  const q = mergeConfig({}).queries, base = { orderProfit: 150, cr: 0.05, cpc: 6 };
  const f = (c, rel) => (judgeCluster(c, base, q, rel) || {}).flag || null;
  assert.equal(f({ orders: 0, clicks: 60, spend: 400 }), 'waste', '60 кликов при конверсии 5% — должно было быть 3 заказа');
  assert.equal(f({ orders: 0, clicks: 30, spend: 400 }), 'check', 'ждали 1,5 заказа — мало данных');
  assert.equal(f({ orders: 0, clicks: 60, spend: 400 }, true), 'check', 'свой запрос товара по средним данным не убирается');
  assert.equal(f({ orders: 0, clicks: 120, spend: 800 }, true), 'waste', 'свой запрос, но ждали 6 заказов и ни одного — убрать');
  assert.equal(f({ orders: 3, clicks: 90, spend: 1200 }), 'costly', '400 ₽ за заказ при прибыли 150 ₽');
  assert.equal(f({ orders: 1, clicks: 100, spend: 600 }), 'costly', 'конверсия 1% против 5%, заказ 600 ₽');
  assert.match(judgeCluster({ orders: 1, clicks: 20, spend: 250 }, base, q).why, /клик 12,5 ₽ против 6,0 ₽/, 'дорогой клик, заказ дороже прибыли');
  assert.equal(f({ orders: 6, clicks: 120, spend: 400 }), 'good', 'заказ по 67 ₽ при прибыли 150 ₽');
  assert.equal(f({ orders: 3, clicks: 90, spend: 1200 }, true), 'check', 'свой запрос с дорогими заказами — на проверку помощнику');
  const { relatedQuery } = await import('./ads-agent.mjs');
  const own = new Set(['тушен', 'говяж', 'белор']);
  assert.ok(relatedQuery('тушенка беларусь', own)); assert.ok(!relatedQuery('паштет печеночный', own));

  const stats = [{ norm_query: 'мусор', views: 5000, clicks: 60, atbs: 1, orders: 0, spend: 500 }, { norm_query: 'чужой бренд', views: 300, clicks: 6, atbs: 0, orders: 0, spend: 90 },
    { norm_query: 'сомнительный', views: 300, clicks: 6, atbs: 0, orders: 0, spend: 90 }, { norm_query: 'хороший', views: 9000, clicks: 300, atbs: 60, orders: 20, spend: 900 }, { norm_query: 'уже убран', views: 1, clicks: 50, atbs: 0, orders: 0, spend: 900 }];
  const sets = [];
  const api = { clusters: async (items) => items.map((i) => ({ ...i, stats: i.advert_id === 101 ? stats : [] })), getMinus: async (items) => items.map((i) => ({ ...i, norm_queries: ['уже убран'] })), setMinus: async (...a) => { sets.push(a); } };
  const brain = async ({ rows, clusters }) => { assert.ok(clusters.find((c) => c.uid === 'wb1:101').items[0].good.some((c) => c.q === 'хороший')); return { summary: 'ок', decisions: rows.map((r) => ({ uid: r.uid, action: 'keep', bidPct: 0, reason: '' })), minus: [{ uid: 'wb1:101', nm: '1', queries: ['чужой бренд', 'хороший', 'нет такого'], reason: '' }], launches: [], lessons: [], tune: [], helpers: [] }; };
  const { out } = await go({ stores: ['wb1'], mode: 'live' }, { api, brain });
  assert.deepEqual(sets[0], [101, 1, ['уже убран', 'мусор', 'чужой бренд']], 'старые минус-фразы сохранены, запрос с заказами и выдуманный — отброшены');
  assert.deepEqual(sets[1], [106, 1, ['уже убран', 'мусор', 'чужой бренд']], 'исключения перенесены во вторую кампанию того же товара');
  const act = out.actions.find((a) => a.action === 'minus' && a.id === 101);
  assert.equal(act.n, 2); assert.equal(act.result, 'ok'); assert.ok(out.camp[101].lastMinusAt);
  assert.equal(out.actions.find((a) => a.action === 'minus' && a.id === 106).moved, 2);
  assert.deepEqual(Object.keys(out.memory.queries['Магазин|1'].bad).sort(), ['мусор', 'уже убран', 'чужой бренд'], 'база знаний по товару');
  assert.ok(out.memory.queries['Магазин|1'].good['хороший'], 'продающий запрос запомнен');
  const rulesOnly = await go({ stores: ['wb1'] }, { api });
  assert.deepEqual(rulesOnly.out.actions.find((a) => a.action === 'minus').queries, ['мусор'], 'без Claude убирается только доказанный слив');
  assert.equal(sets.length, 2, 'dry-run минус-фразы не отправляет');
}
// 13. Campaigns the agent closed earlier: their excluded queries are read once and carried to the live campaigns
{
  const reads = [], sets = [];
  const api = { clusters: async (items) => items.map((i) => ({ ...i, stats: [] })), getMinus: async (items) => { reads.push(...items.map((i) => i.advert_id)); return items.map((i) => ({ ...i, norm_queries: i.advert_id === 555 ? ['исключил сотрудник', 'ещё одно'] : [] })); }, setMinus: async (...a) => { sets.push(a); } };
  const state = { history: [{ t: '2026-11-15T10:00:00Z', store: 'wb1', id: 555, name: 'Старая РК', key: 'Магазин|1', action: 'stop', result: 'ok' }] };
  const first = await go({ stores: ['wb1'], mode: 'live' }, { api, state });
  assert.ok(reads.includes(555), 'минус-фразы закрытой кампании прочитаны');
  assert.ok(first.out.camp[555].harvested);
  assert.deepEqual(sets.find((x) => x[0] === 101), [101, 1, ['исключил сотрудник', 'ещё одно']], 'перенесены в живую кампанию того же товара');
  reads.length = 0;
  await go({ stores: ['wb1'] }, { api, state: first.out, memory: first.out.memory });
  assert.ok(!reads.includes(555), 'второй раз закрытую кампанию не читает');
}
// 14. Paused for loss: never switched back on by itself; a restart variant appears when cleaning makes it pay; the owner approves it in Telegram
{
  const m2 = { ...market, ads: [ad(201, 4, 15000, 30, 30000)] };
  const camp = (id) => ({ id, status: 11, bid_type: 'unified', settings: { name: 'РК ' + id, payment_type: 'cpm', placements: { search: true, recommendations: true } }, nm_settings: [{ nm_id: 4, bids_kopecks: { search: 30000, recommendations: 30000 } }] });
  const calls = [], rec = (name) => async (...a) => { calls.push([name, ...a]); };
  const stats = [{ norm_query: 'чужое', clicks: 400, orders: 0, spend: 8000 }, { norm_query: 'товар 4', clicks: 600, orders: 30, spend: 7000 }];
  const api = { list: async () => [normCampaign(camp(201))], minBids: async () => ({}), clusters: async (items) => items.map((i) => ({ ...i, stats })), getMinus: async (items) => items.map((i) => ({ ...i, norm_queries: ['старое'] })),
    setMinus: rec('setMinus'), setBids: rec('setBids'), start: rec('start'), pause: rec('pause'), stop: rec('stop'), deposit: rec('deposit'), create: rec('create') };
  const state = { camp: { 201: { pausedByAgent: true, pausedFor: 'loss' } } };
  const r1 = await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live' }), data, market: m2, state, apis: { wb1: api }, now: NOW });
  assert.equal(r1.campaigns[0].action, 'keep'); assert.match(r1.campaigns[0].reason, /перезапуск — в плане/);
  assert.ok(!calls.some((c) => c[0] === 'start'), 'сам не включает');
  const v = r1.plan.variants[0];
  assert.equal(v.kind, 'restart'); assert.equal(v.n, 1); assert.equal(v.minus, 1); assert.equal(v.profitMonth, 5000, 'без «чужое»: 30 000 × 40% − 7 000');
  assert.match(planText(r1), /Ответьте <b>запуск 1<\/b>/); assert.equal(v.transfer, 0, 'свои минус-фразы кампании не считаются переносом');
  const ap = parseApprovals([{ update_id: 7, message: { chat: { id: 42 }, date: NOW / 1000 + 60, text: 'Запуск 1' } }, { update_id: 8, message: { chat: { id: 99 }, date: NOW / 1000 + 60, text: 'запуск 2' } }], '42', r1.plan.generated);
  assert.deepEqual(ap.nums, [1], 'только из своего чата'); assert.equal(ap.last, 8);
  const r2 = await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live' }), data, market: m2, state: r1, memory: r1.memory, apis: { wb1: api }, now: NOW + 3600e3, approvals: ap });
  assert.deepEqual(calls.filter((c) => c[0] === 'setMinus').map((c) => c.slice(1)), [[201, 4, ['старое', 'чужое']]], 'перед запуском убраны плохие запросы, старые сохранены');
  assert.ok(calls.some((c) => c[0] === 'start' && c[1] === 201)); assert.deepEqual(r2.approved, [{ n: 1, action: 'restart', name: 'РК 201', id: 201, result: 'ok', error: null }]);
  assert.equal(r2.camp[201].pausedFor, null);
}
// 15. Plan: what was done, what is next, variants for new products; nothing in the plan without numbers behind it
{
  const { out } = await go({ stores: ['wb1'], mode: 'live', launch: { enabled: true, maxTotal: 0 } });
  assert.equal(out.plan.done.paused, 2); assert.equal(out.plan.done.lower, 1);
  const nv = out.plan.variants.find((x) => x.kind === 'new');
  assert.equal(nv.sku, '6'); assert.ok(nv.profitMonth > 0);
  const t = planText(out);
  assert.match(t, /Сделано за сутки/); assert.match(t, /Варианты запуска/); assert.ok(t.length < 4000);
}
// 10. Learning: a week later the agent measures what its action did and adjusts its own step
{
  const first = await go({ stores: ['wb1'], mode: 'live' });
  assert.ok(first.out.history.find((h) => h.id === 102).snap.profitDay != null);
  // campaign 102 after the cut: same orders for a third of the spend
  const shift = (x) => ({ ...x, days: x.days.map((d) => [new Date(Date.parse(d[0]) + 8 * 864e5).toISOString().slice(0, 10), d[1], d[2], d[3]]) });
  const better = { ...market, ads: market.ads.map((a) => shift(a.id === 102 ? ad(102, 2, 3000, 30, 30000) : a)) };
  const calls = [];
  const later = await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live' }), data, market: better, state: first.out, memory: first.out.memory, apis: { wb1: mockApi(calls) }, now: NOW + 8 * 864e5 });
  const o = later.memory.outcomes.find((x) => x.id === 102);
  assert.equal(o.verdict, 'helped'); assert.equal(o.effect, 1400, 'прибыль выросла на 200 ₽ в день');
  assert.equal(later.memory.outcomes.find((x) => x.id === 103).verdict, 'helped', 'закрытие убыточной кампании');
  assert.equal(later.learned.stats.lower.helped, 1); assert.equal(later.memory.runs, 2);
  const mem = emptyMemory(); mem.outcomes = [1, 2, 3, 4].map((i) => ({ t: 't' + i, action: 'lower', verdict: i < 4 ? 'hurt' : 'neutral' }));
  const cfg = mergeConfig({});
  assert.equal(autoTune(mem, cfg, NOW)[0].to, 20, 'три из четырёх снижений навредили — шаг меньше');
  assert.equal(autoTune(mem, cfg, NOW).length, 0, 'те же данные второй раз не учитываются');
  assert.equal(applyTuning(mergeConfig({}), { tuned: { targetShare: 5, mode: 'live', 'budget.dailyCap': 1e9 } }).targetShare, TUNE_BOUNDS.targetShare[1], 'значение из памяти зажато в границы');
  assert.equal(tune(mem, cfg, 'stop.maxPerRun', 50, '', 'claude', NOW), null, 'лимит закрытий — не настраиваемый');
  const m2 = emptyMemory(); evaluateOutcomes(m2, [{ t: new Date(NOW).toISOString(), action: 'lower', result: 'ok', id: 1, store: 'wb1', snap: { profitDay: 1 } }], () => null, NOW + 864e5);
  assert.equal(m2.outcomes.length, 0, 'раньше недели результат не оценивается');
}
// 11. Ozon: same decisions and limits through the Performance API adapter; its own dry-run switch
{
  assert.equal(num('1 234,56'), 1234.56);
  const c = normOzonCampaign({ id: '77', title: 'Озон РК', state: 'CAMPAIGN_STATE_RUNNING', productAutopilotStrategy: 'TARGET_BIDS' }, [{ sku: '900', bid: '35000000' }, { sku: '901', bid: '20000000' }]);
  assert.equal(c.status, 9); assert.deepEqual(ozonBids({ nms: c.nms }, -25, mergeConfig({}), 18).map((x) => [x.rub, x.raw]), [[26, '26000000'], [18, '18000000']], '−25% в рублях, не ниже минимума, в единицах API');
  const st = ozonStats([{ id: '77', date: '16.11.2026', views: '1000', clicks: '50', moneySpent: '300,50', orders: '2', ordersMoney: '4 000,00' }], 'Озон', [{ campaignId: '77', sku: '900', expense: '300.5', clicks: '50', orders: '2', sales: '4000' }]);
  assert.deepEqual(st.get(77).days, [['2026-11-16', 300.5, 2, 4000]]); assert.equal(st.get(77).nmS['Озон|900'], 300.5);

  const d2 = { ...data, stores: [{ id: 'oz1', name: 'Озон', mp: 'Ozon' }], products: [sku(900, 1000, 50, 250), sku(901, 1000, 300, 50), sku(902, 1000, 250, 50), sku(903, 1000, 250, 50)] };
  const mk = { generated: 'x', ads: [], stocks: Object.fromEntries([900, 901, 902, 903].map((n) => ['Озон|' + n, { q: 500 }])), funnel: {}, reviews: {} };
  const camps = [normOzonCampaign({ id: '77', title: 'Ручные ставки', state: 'CAMPAIGN_STATE_RUNNING', productAutopilotStrategy: 'TARGET_BIDS' }, [{ sku: '900', bid: '35000000' }]),
    normOzonCampaign({ id: '78', title: 'Целевой расход', state: 'CAMPAIGN_STATE_RUNNING', productAutopilotStrategy: 'TARGET_CIR' }, [{ sku: '901', targetCir: 10 }]),
    normOzonCampaign({ id: '79', title: 'Автостратегия', state: 'CAMPAIGN_STATE_RUNNING', productAutopilotStrategy: 'MAX_CLICKS' }, [{ sku: '902' }, { sku: '903' }])];
  const oad = (spend, orders, ordSum, sku) => ({ spend, views: 20000, clicks: 600, cart: 0, orders, ordSum, bud: null, nmS: {}, sku, days: Array.from({ length: 30 }, (_, i) => [day(i), spend / 30, orders / 30, ordSum / 30]) });
  const stats = new Map([[77, oad(9000, 30, 30000, {})], [78, oad(1500, 40, 40000, {})], [79, oad(9000, 30, 30000, { 902: { spend: 5000, clicks: 300, orders: 0, sales: 0 }, 903: { spend: 4000, clicks: 300, orders: 30, sales: 30000 } })]]);
  const calls = [], rec = (n) => async (...a) => { calls.push([n, ...a]); };
  const api = { platform: 'ozon', list: async () => camps, stats: async () => stats, minBid: async () => 10, setBids: rec('setBids'), setCir: rec('setCir'), start: rec('start'), pause: rec('pause'), stop: rec('stop'), drop: rec('drop') };
  const goOz = (ozon) => run({ cfg: mergeConfig({ stores: ['wb1', 'oz1'], mode: 'live', ozon }), data: d2, market: mk, state: {}, apis: { oz1: api }, now: NOW });
  const dry = await goOz({});
  assert.equal(calls.length, 0, 'Ozon в режиме проверки, даже когда WB в боевом');
  assert.match(dry.summary, /Режим проверки \(Ozon\)/); assert.ok(dry.actions.every((a) => a.result === 'planned'));
  const out = await goOz({ mode: 'live' });
  const by = Object.fromEntries(out.campaigns.map((x) => [x.id, x]));
  assert.equal(by[77].action, 'lower'); assert.deepEqual(calls.find((x) => x[0] === 'setBids').slice(1), [77, [{ nm: '900', was: 35, rub: 26, raw: '26000000' }]]);
  assert.equal(by[78].action, 'raise'); assert.deepEqual(calls.find((x) => x[0] === 'setCir').slice(1), [78, ['901'], 12], 'целевой ДРР 10% → 12% (шаг 15%, цель 18%)');
  assert.equal(by[79].action, 'keep'); assert.match(by[79].blocked, /автостратегия Ozon/);
  assert.deepEqual(calls.find((x) => x[0] === 'drop').slice(1), [79, ['902']], 'товар без заказов убран из кампании');
  assert.ok(out.camp['oz1:77'].lastBidAt, 'состояние Ozon хранится отдельно от номеров WB');
  const none = await run({ cfg: mergeConfig({ stores: ['oz1'] }), data: d2, market: mk, state: {}, apis: {}, now: NOW });
  assert.match(none.notes[0], /нет ключа Performance API/);
}
// 12. WB campaign info, current v3 shape
{
  const c = normCampaign({ advertId: 5, status: 9, settings: { name: 'N', paymentType: 'cpm', placements: ['combined'] }, nms: [{ nmId: 7, subject: {}, bids: [{ type: 'combined', value: 30000 }] }] });
  assert.equal(c.bidType, 'unified'); assert.deepEqual(newBids(c, -10, mergeConfig({}), {}), [{ nm: 7, placement: 'combined', kop: 27000, was: 30000 }]);
  const m = normCampaign({ advertId: 6, status: 9, settings: { name: 'N', paymentType: 'cpm', placements: ['search', 'recommendations'] }, nms: [{ nmId: 8, bids: [{ type: 'search', value: 20000 }, { type: 'recommendations', value: 15000 }] }] });
  assert.deepEqual(newBids(m, 10, mergeConfig({}), {}).map((x) => [x.placement, x.kop]), [['search', 22000], ['recommendations', 16500]]);
}
{
  const { sumClusterDays } = await import('./ads-agent.mjs');
  const r = sumClusterDays({ advertId: 1, nmId: 2, dailyStats: [{ date: 'a', stat: { normQuery: 'q', views: 10, clicks: 3, atbs: 1, orders: 0, spend: 12.5 } }, { date: 'b', stat: { normQuery: 'q', views: 5, clicks: 2, atbs: 0, orders: 1, spend: 7.5 } }, { date: 'b', stat: { normQuery: 'w', clicks: 1, spend: 1 } }] });
  assert.deepEqual(r, { advert_id: 1, nm_id: 2, stats: [{ norm_query: 'q', views: 15, clicks: 5, atbs: 1, orders: 1, spend: 20 }, { norm_query: 'w', views: 0, clicks: 1, atbs: 0, orders: 0, spend: 1 }] }, 'дневная статистика v1 суммируется за период');
}
console.log('ads-agent: ozon, queries and learning checks passed');
