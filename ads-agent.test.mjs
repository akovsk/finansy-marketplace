// Checks of the agent's decision logic and hard limits on small made-up data: node ads-agent.test.mjs
import assert from 'node:assert/strict';
import { mergeConfig, run, guard, newBids, stopReason, normCampaign, judgeCluster, launchCandidates, skuEconomics, bidsOnly, CAMPAIGN_CONTROL } from './ads-agent.mjs';
import { parseApprovals, planText, buildVariants, activeSkus } from './ads-plan.mjs';
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

// A WB client that records every call, including the campaign-control ones the agent must never make
function mockApi(calls) {
  const camp = (id, nm) => ({ id, status: 9, bid_type: 'unified', settings: { name: 'РК ' + id, payment_type: 'cpm', placements: { search: true, recommendations: true } }, nm_settings: [{ nm_id: nm, bids_kopecks: { search: 30000, recommendations: 30000 } }] });
  const rec = (name) => async (...a) => { calls.push([name, ...a]); return name === 'create' ? 999 : null; };
  return { list: async () => [camp(101, 1), camp(102, 2), camp(103, 3), camp(104, 4), camp(105, 5), camp(106, 1), camp(107, 5)].map(normCampaign),
    minBids: async (c) => Object.fromEntries(c.nms.map((n) => [n.nm, { combined: 25000 }])),
    setBids: rec('setBids'), start: rec('start'), pause: rec('pause'), stop: rec('stop'), deposit: rec('deposit'), create: rec('create'), drop: rec('drop') };
}
// The made-up campaigns below are treated as created by the agents; the managers' ones are tested in section 30
const OWN = [...[101, 102, 103, 104, 105, 106, 107, 201, 301, 555].map((id) => ({ store: 'wb1', id })), ...[77, 78, 79].map((id) => ({ store: 'oz1', id }))];
const withOwn = (s = {}) => ({ ...s, own: [...OWN, ...(s.own || [])] });
const noLaunch = (o) => mergeConfig({ ...o, launch: { enabled: false } });
// launches are switched off here unless a test turns them on, so the bid checks stay about bids
const go = async (over = {}, extra = {}) => { const calls = []; const out = await run({ cfg: mergeConfig({ ...over, launch: { enabled: false, ...(over.launch || {}) } }), data, market, state: withOwn(extra.state), memory: extra.memory, apis: { wb1: { ...mockApi(calls), ...(extra.api || {}) } }, now: extra.now || NOW, brain: extra.brain }); return { out, calls, by: Object.fromEntries(out.campaigns.map((c) => [c.id, c])) }; };
const control = (calls) => calls.filter((c) => CAMPAIGN_CONTROL.includes(c[0]));

// 1. Rules on their own: bids only — a loss-maker gets the largest bid cut, never a pause or a close
{
  const { by, calls, out } = await go({ stores: ['wb1'] });
  assert.equal(by[101].action, 'keep', 'ДРР 15% при цели 18% (маржа 30%) — в норме');
  assert.equal(by[102].action, 'lower', 'ДРР 30% при марже 30%: выше цели — снижать');
  assert.equal(by[102].bidPct, -25);
  assert.equal(by[103].action, 'lower', 'товар убыточен до рекламы — снижение ставки, не пауза');
  assert.equal(by[103].bidPct, -25); assert.match(by[103].reason, /убыточен ещё до рекламы.*Снижаю ставку на 25%/);
  assert.equal(by[104].action, 'raise', 'ДРР 3.75% при цели 24% — масштабировать');
  assert.equal(by[105].action, 'keep', 'товара нет на складе — ставку не трогаем и не ставим на паузу'); assert.match(by[105].reason, /нет на складе/);
  assert.equal(by[106].action, 'keep', 'мало данных — ждать');
  assert.equal(by[107].action, 'keep', 'нет остатка — не пауза');
  assert.equal(calls.length, 0, 'dry-run ничего не отправляет в WB');
  assert.equal(out.history.length, 0, 'dry-run не пишет историю');
  assert.ok(out.actions.every((a) => a.result === 'planned'));
  assert.ok(out.actions.every((a) => ['lower', 'raise', 'minus', 'boost'].includes(a.action)), 'только ставки и запросы');
  const low = out.actions.find((a) => a.id === 102);
  assert.deepEqual(low.bids, [{ nm: 2, placement: 'combined', wasRub: 300, rub: 250 }], '−25% от 300 ₽ = 225 ₽, но минимум WB 250 ₽');
}
// 2. Live mode sends only bid changes and remembers them
{
  const { calls, out } = await go({ stores: ['wb1'], mode: 'live' });
  assert.deepEqual(calls.map((c) => c[0] + ':' + c[1]).sort(), ['setBids:102', 'setBids:103', 'setBids:104'], 'в WB уходят только ставки');
  assert.deepEqual(calls.find((c) => c[0] === 'setBids' && c[1] === 104)[2], [{ nm: 4, placement: 'combined', kop: 34500, was: 30000 }]);
  assert.equal(out.history.length, 3);
  assert.ok(out.camp[102].lastBidAt && out.camp[103].lastBidAt);
  // next run 2 hours later: cooldown blocks a second bid change
  const calls2 = []; const again = await run({ cfg: noLaunch({ stores: ['wb1'], mode: 'live' }), data, market, state: out, apis: { wb1: mockApi(calls2) }, now: NOW + 2 * 3600e3 });
  assert.ok(!calls2.some((c) => c[0] === 'setBids'), 'повторно ставку в течение суток не меняет');
  assert.match(again.campaigns.find((c) => c.id === 102).blocked, /жду статистику/);
}
// 3. Claude's proposals cannot get past the hard limits; pause / stop / resume from Claude are refused
{
  const pickAct = (uid) => ({ 'wb1:101': 'stop', 'wb1:102': 'raise', 'wb1:103': 'pause', 'wb1:104': 'raise', 'wb1:106': 'lower' }[uid] || 'keep');
  const brain = async ({ rows }) => ({ summary: 'Тест.', decisions: rows.map((r) => ({ uid: r.uid, action: pickAct(r.uid), bidPct: 80, reason: 'Проверка.' })).concat([{ uid: 'wb1:555', action: 'stop', bidPct: 0, reason: 'чужая' }]),
    lessons: ['Урок 1'], tune: [{ key: 'bid.maxStepPct', value: 5, why: 'тест' }, { key: 'budget.dailyCap', value: 999999, why: 'нельзя' }], helpers: [{ role: 'Новый помощник', task: 'Задача' }], helpersUsed: [{ role: 'Новый помощник', report: 'Отчёт' }] });
  const { by, out, calls } = await go({ stores: ['wb1'], mode: 'live' }, { brain });
  assert.deepEqual(out.memory.lessons, ['Урок 1'], 'уроки сохраняются в память');
  assert.equal(out.memory.tuned['bid.maxStepPct'], 19, 'порог двигается не больше чем на четверть за запуск (25 → 19)');
  assert.ok(!('budget.dailyCap' in out.memory.tuned), 'денежные лимиты агент менять не может');
  assert.equal(out.memory.helpers[0].role, 'Новый помощник'); assert.equal(out.learned.helpers[0].report, 'Отчёт');
  assert.equal(out.engine, 'claude');
  assert.equal(by[101].action, 'keep', 'закрыть кампанию агент не может'); assert.match(by[101].blocked, /не ставят кампании на паузу, не завершают/);
  assert.equal(by[103].action, 'keep', 'поставить на паузу агент не может'); assert.match(by[103].blocked, /не ставят кампании на паузу/);
  assert.equal(by[102].action, 'keep', 'повышать ставку при ДРР выше цели нельзя');
  assert.equal(by[104].bidPct, 15, 'шаг повышения урезан с 80% до 15%');
  assert.equal(by[106].action, 'keep', 'мало данных — ставку не трогаем');
  assert.ok(!by[555] && !calls.some((c) => c[1] === 555), 'неизвестная кампания игнорируется');
  assert.equal(control(calls).length, 0, 'ни паузы, ни закрытия, ни запуска');
}
// 4. If Claude fails, the rules take over
{
  const { out, by } = await go({ stores: ['wb1'] }, { brain: async () => { throw new Error('boom'); } });
  assert.equal(out.engine, 'rules'); assert.equal(by[103].action, 'lower'); assert.match(out.errors[0], /Claude недоступен/);
}
// 5. Owner's rule: no start / pause / stop / create / top-up / drop, whatever an old config asks for
{
  const stripped = bidsOnly(mockApi([]));
  CAMPAIGN_CONTROL.forEach((k) => assert.ok(!(k in stripped), 'у агента нет метода ' + k));
  assert.ok(stripped.setBids && stripped.minBids && stripped.list, 'ставки и чтение остаются');
  // old settings for top-ups, pauses and closing switch nothing on; the only launch is the one new campaign of the day
  const old = { stores: ['wb1'], mode: 'live', launch: { enabled: true, maxPerRun: 5, maxTotal: 5 }, budget: { autoTopUp: true }, stock: { pauseWhenOut: true }, plan: { auto: true }, stop: { hardClose: true, maxPerRun: 5 }, repair: { enabled: true } };
  const c = await go(old);
  assert.ok(!c.calls.some((x) => ['pause', 'stop', 'drop'].includes(x[0])), 'ни паузы, ни закрытия');
  assert.deepEqual(c.calls.filter((x) => ['create', 'deposit', 'start'].includes(x[0])).map((x) => x[0] + ':' + (x[0] === 'create' ? '' : x[1])), ['create:', 'deposit:999', 'start:999'], 'одна новая кампания: создана, пополнена и запущена — только она');
  assert.ok(c.out.actions.every((a) => ['lower', 'raise', 'minus', 'boost', 'launch'].includes(a.action)));
  assert.deepEqual([c.out.closeAsk, c.out.approved, c.out.autoLaunched, c.out.plan.variants], [[], [], [], []]);
  const b = await go({ stores: ['wb1'], protect: [103] });
  assert.equal(b.by[103].action, 'keep');
  const m = { payType: 'cpm', bidType: 'manual', nms: [{ nm: 1, search: 99000, recom: 0 }] };
  assert.deepEqual(newBids(m, 15, mergeConfig({}), {}).map((x) => x.kop), [100000], 'потолок ставки 1000 ₽');
}
// 6. stopReason never fires on thin data; guard refuses any campaign-control action
assert.equal(stopReason({ status: 9, w30: { spend: 1000, orders: 0, ordSum: 0 }, w14: { spend: 500 }, margin: 0.3, drr30: Infinity, drr14: Infinity }, mergeConfig({})), null);
['stop', 'pause', 'resume', 'launch', 'topup', 'drop'].forEach((action) => assert.equal(guard({ action, reason: '' }, { id: 1, status: 9, w30: { spend: 9000, orders: 0, ordSum: 0 }, w14: { spend: 5000 }, margin: 0.3 }, mergeConfig({}), {}, NOW).action, 'keep', action));
console.log('ads-agent: all checks passed');

// 7. Losing campaign whose bid is already at WB's minimum: no pause — the owner is told
{
  const m2 = { ...market, ads: [ad(301, 3, 9000, 30, 30000)] };
  const camp = { id: 301, status: 9, bid_type: 'unified', settings: { name: 'Убыточная', payment_type: 'cpm', placements: { search: true, recommendations: true } }, nm_settings: [{ nm_id: 3, bids_kopecks: { search: 25000, recommendations: 25000 } }] };
  const calls = [], rec = (name) => async (...a) => { calls.push([name, ...a]); };
  const api = { list: async () => [normCampaign(camp)], minBids: async () => ({ 3: { combined: 25000 } }), setBids: rec('setBids'), start: rec('start'), pause: rec('pause'), stop: rec('stop') };
  const r = await run({ cfg: noLaunch({ stores: ['wb1'], mode: 'live' }), data, market: m2, state: withOwn(), apis: { wb1: api }, now: NOW });
  assert.equal(calls.length, 0, 'ставка уже минимальная — ни ставки, ни паузы');
  assert.equal(r.campaigns[0].action, 'keep'); assert.equal(r.campaigns[0].blocked, 'ставка уже минимальная'); assert.ok(r.campaigns[0].attention);
  assert.deepEqual(r.attention.map((x) => x.id), [301]);
  assert.ok(r.notes.some((n) => /Ставка уже минимальная, а реклама в минусе.*решаете вы/.test(n)));
  assert.match(planText(r), /Нужно ваше решение.*РК 301/);
}
// 8. Launch estimate (used by the one-off launch script): a product whose return per click does not beat the click price
{
  const econ = skuEconomics(data), cfg = mergeConfig({});
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
  const brain = async ({ rows, clusters }) => { assert.ok(clusters.find((c) => c.uid === 'wb1:101').items[0].good.some((c) => c.q === 'хороший')); return { summary: 'ок', decisions: rows.map((r) => ({ uid: r.uid, action: 'keep', bidPct: 0, reason: '' })), minus: [{ uid: 'wb1:101', nm: '1', queries: ['чужой бренд', 'хороший', 'нет такого'], reason: '' }], lessons: [], tune: [], helpers: [] }; };
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

  // Cost-per-click campaigns: WB answers set-minus with 404 there, so the agent does not send it and reports the queries instead
  const cpcSets = [];
  const cpcApi = { ...api, list: async () => (await mockApi([]).list()).map((c) => ({ ...c, payType: 'cpc' })), setMinus: async (...a) => { cpcSets.push(a); } };
  const cpc = await go({ stores: ['wb1'], mode: 'live' }, { api: cpcApi });
  assert.equal(cpcSets.length, 0, 'в CPC-кампании минус-фразы не отправляются');
  assert.ok(!cpc.out.actions.some((a) => a.action === 'minus'));
  assert.deepEqual(cpc.out.queryAdvice.map((x) => [x.id, x.queries.map((y) => y.q)]), [[101, ['мусор']]], 'плохие запросы показаны владельцу');
  assert.ok(cpc.out.notes.some((n) => /Оплата за клик: WB не принимает исключение запросов/.test(n)));
}
// 13. Campaigns closed earlier: their excluded queries are read once and carried to the live campaigns
{
  const reads = [], sets = [];
  const api = { clusters: async (items) => items.map((i) => ({ ...i, stats: [] })), getMinus: async (items) => { reads.push(...items.map((i) => i.advert_id)); return items.map((i) => ({ ...i, norm_queries: i.advert_id === 555 ? ['исключил сотрудник', 'ещё одно'] : [] })); }, setMinus: async (...a) => { sets.push(a); } };
  const state = { history: [{ t: '2026-11-15T10:00:00Z', store: 'wb1', id: 555, name: 'Старая РК', key: 'Магазин|1', action: 'stop', result: 'ok' }] };
  const first = await go({ stores: ['wb1'], mode: 'live' }, { api, state });
  assert.ok(reads.includes(555), 'минус-фразы закрытой кампании прочитаны');
  assert.ok(first.out.camp[555].harvested);
  assert.deepEqual(sets.find((x) => x[0] === 101), [101, 1, ['исключил сотрудник', 'ещё одно']], 'перенесены в живую кампанию того же товара');
  reads.length = 0;
  await go({ stores: ['wb1'] }, { api, state: first.out, memory: first.out.memory, now: NOW + 31 * 864e5 });
  assert.ok(!reads.includes(555), 'через 30 дней статистики нет — закрытую кампанию больше не читает');
}
// 14. A campaign on pause is never switched back on by the agent, even if it had paused it itself before the rule
{
  const m2 = { ...market, ads: [ad(201, 4, 15000, 30, 30000)] };
  const camp = (id) => ({ id, status: 11, bid_type: 'unified', settings: { name: 'РК ' + id, payment_type: 'cpm', placements: { search: true, recommendations: true } }, nm_settings: [{ nm_id: 4, bids_kopecks: { search: 30000, recommendations: 30000 } }] });
  const calls = [], rec = (name) => async (...a) => { calls.push([name, ...a]); };
  const api = { list: async () => [normCampaign(camp(201))], minBids: async () => ({}), clusters: async (items) => items.map((i) => ({ ...i, stats: [] })), getMinus: async (items) => items.map((i) => ({ ...i, norm_queries: [] })),
    setMinus: rec('setMinus'), setBids: rec('setBids'), start: rec('start'), pause: rec('pause'), stop: rec('stop'), deposit: rec('deposit'), create: rec('create') };
  const r1 = await run({ cfg: noLaunch({ stores: ['wb1'], mode: 'live' }), data, market: m2, state: withOwn({ camp: { 201: { pausedByAgent: true, pausedFor: 'stock', pausedAt: NOW - 30 * 864e5 } } }), apis: { wb1: api }, now: NOW });
  assert.equal(r1.campaigns[0].action, 'keep'); assert.match(r1.campaigns[0].reason, /включать и выключать кампании агент не может/);
  assert.equal(calls.length, 0, 'сам не включает и ставку на паузе не меняет');
  assert.deepEqual(r1.plan.variants, []);
  // «запуск 1» / «закрыть 1» from Telegram are still recognised (the CLI answers that agents no longer do this)
  const ap = parseApprovals([{ update_id: 7, message: { chat: { id: 42 }, date: NOW / 1000 + 60, text: 'Закрыть 1' } }, { update_id: 8, message: { chat: { id: 99 }, date: NOW / 1000 + 60, text: 'запуск 2' } }], '42', r1.plan.generated);
  assert.ok(ap.seen); assert.deepEqual(ap.close, [1]); assert.equal(ap.last, 8);
}
// 15. Plan: what was done and what is next; no launch variants and no close questions
{
  const { out } = await go({ stores: ['wb1'], mode: 'live' });
  assert.equal(out.plan.done.paused, 0); assert.equal(out.plan.done.lower, 2); assert.equal(out.plan.done.raise, 1);
  const t = planText(out);
  assert.match(t, /Сделано за сутки/); assert.ok(!/Варианты запуска|запуск \d|закрыть \d/.test(t)); assert.ok(t.length < 4000);
}
// 10. Learning: a week later the agent measures what its action did and adjusts its own step
{
  const first = await go({ stores: ['wb1'], mode: 'live' });
  assert.ok(first.out.history.find((h) => h.id === 102).snap.profitDay != null);
  // campaign 102 after the cut: same orders for a third of the spend
  const shift = (x) => ({ ...x, days: x.days.map((d) => [new Date(Date.parse(d[0]) + 8 * 864e5).toISOString().slice(0, 10), d[1], d[2], d[3]]) });
  const better = { ...market, ads: market.ads.map((a) => shift(a.id === 102 ? ad(102, 2, 3000, 30, 30000) : a)) };
  const calls = [];
  const later = await run({ cfg: noLaunch({ stores: ['wb1'], mode: 'live' }), data, market: better, state: first.out, memory: first.out.memory, apis: { wb1: mockApi(calls) }, now: NOW + 8 * 864e5 });
  const o = later.memory.outcomes.find((x) => x.id === 102);
  assert.equal(o.verdict, 'helped'); assert.equal(o.effect, 1400, 'прибыль выросла на 200 ₽ в день');
  assert.equal(later.learned.stats.lower.helped, 1); assert.equal(later.memory.runs, 2);
  assert.equal(control(calls).length, 0);
  const mem = emptyMemory(); mem.outcomes = [1, 2, 3, 4].map((i) => ({ t: 't' + i, action: 'lower', verdict: i < 4 ? 'hurt' : 'neutral' }));
  const cfg = mergeConfig({});
  assert.equal(autoTune(mem, cfg, NOW)[0].to, 20, 'три из четырёх снижений навредили — шаг меньше');
  assert.equal(autoTune(mem, cfg, NOW).length, 0, 'те же данные второй раз не учитываются');
  assert.equal(applyTuning(mergeConfig({}), { tuned: { targetShare: 5, mode: 'live', 'budget.dailyCap': 1e9 } }).targetShare, TUNE_BOUNDS.targetShare[1], 'значение из памяти зажато в границы');
  assert.equal(tune(mem, cfg, 'stop.maxPerRun', 50, '', 'claude', NOW), null, 'чужой ключ не настраивается');
  const m2 = emptyMemory(); evaluateOutcomes(m2, [{ t: new Date(NOW).toISOString(), action: 'lower', result: 'ok', id: 1, store: 'wb1', snap: { profitDay: 1 } }], () => null, NOW + 864e5);
  assert.equal(m2.outcomes.length, 0, 'раньше недели результат не оценивается');
}
// 11. Ozon: same decisions and limits through the Performance API adapter; its own dry-run switch; products are never taken out
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
  const goOz = (ozon) => run({ cfg: noLaunch({ stores: ['wb1', 'oz1'], mode: 'live', ozon }), data: d2, market: mk, state: withOwn(), apis: { oz1: api }, now: NOW });
  const dry = await goOz({});
  assert.equal(calls.length, 0, 'Ozon в режиме проверки, даже когда WB в боевом');
  assert.match(dry.summary, /Режим проверки \(Ozon\)/); assert.ok(dry.actions.every((a) => a.result === 'planned'));
  const out = await goOz({ mode: 'live' });
  const by = Object.fromEntries(out.campaigns.map((x) => [x.id, x]));
  assert.equal(by[77].action, 'lower'); assert.deepEqual(calls.find((x) => x[0] === 'setBids').slice(1), [77, [{ nm: '900', was: 35, rub: 26, raw: '26000000' }]]);
  assert.equal(by[78].action, 'raise'); assert.deepEqual(calls.find((x) => x[0] === 'setCir').slice(1), [78, ['901'], 12], 'целевой ДРР 10% → 12% (шаг 15%, цель 18%)');
  assert.equal(by[79].action, 'keep'); assert.match(by[79].blocked, /автостратегия Ozon/);
  assert.equal(control(calls).length, 0, 'товары из кампаний Ozon не убираются, кампании не выключаются');
  assert.ok(out.camp['oz1:77'].lastBidAt, 'состояние Ozon хранится отдельно от номеров WB');
  // Ozon bids in dry-run, but the campaign of the day is created for real (ozon.launchLive); never in a manual dry-run
  {
    const d3 = { ...d2, products: d2.products.concat([sku(904, 3000, 1500, 0)]) };
    const mk3 = { ...mk, stocks: { ...mk.stocks, 'Озон|904': { q: 500 } } };
    const oc = [], orec = (n) => async (...a) => { oc.push([n, ...a]); return n === 'create' ? 555 : null; };
    const api3 = { ...api, setBids: orec('setBids'), setCir: orec('setCir'), create: orec('create'), start: orec('start'), pause: orec('pause'), stop: orec('stop'), drop: orec('drop') };
    const r = await run({ cfg: mergeConfig({ stores: ['oz1'], mode: 'live' }), data: d3, market: mk3, state: withOwn(), apis: { oz1: api3 }, now: NOW });
    const la = r.actions.find((a) => a.action === 'launch');
    assert.equal(la.sku, '904'); assert.equal(la.result, 'ok'); assert.equal(la.id, 555);
    assert.deepEqual(oc.map((x) => x[0]), ['create'], 'создана одна кампания Ozon; ставки Ozon не тронуты (режим проверки)');
    const manual = await run({ cfg: mergeConfig({ stores: ['oz1'], mode: 'dry-run' }), data: d3, market: mk3, state: withOwn(), apis: { oz1: api3 }, now: NOW });
    assert.equal(manual.actions.find((a) => a.action === 'launch').result, 'planned', 'ручной режим проверки ничего не создаёт');
  }
  const none = await run({ cfg: noLaunch({ stores: ['oz1'] }), data: d2, market: mk, state: withOwn(), apis: {}, now: NOW });
  assert.match(none.notes[0], /нет ключа Performance API/);
}
// 12. WB campaign info, current v3 shape
{
  const c = normCampaign({ advertId: 5, status: 9, settings: { name: 'N', paymentType: 'cpm', placements: ['combined'] }, nms: [{ nmId: 7, subject: {}, bids: [{ type: 'combined', value: 30000 }] }] });
  assert.equal(c.bidType, 'unified'); assert.deepEqual(newBids(c, -10, mergeConfig({}), {}), [{ nm: 7, placement: 'combined', kop: 27000, was: 30000 }]);
  const m = normCampaign({ advertId: 6, status: 9, settings: { name: 'N', paymentType: 'cpm', placements: ['search', 'recommendations'] }, nms: [{ nmId: 8, bids: [{ type: 'search', value: 20000 }, { type: 'recommendations', value: 15000 }] }] });
  assert.deepEqual(newBids(m, 10, mergeConfig({}), {}).map((x) => [x.placement, x.kop]), [['search', 22000], ['recommendations', 16500]]);
  assert.equal(normCampaign({ advertId: 9, status: 9, settings: { name: 'N', paymentType: 'cpc', placements: ['search'] }, nms: [] }).payType, 'cpc');
}
{
  const { sumClusterDays } = await import('./ads-agent.mjs');
  const r = sumClusterDays({ advertId: 1, nmId: 2, dailyStats: [{ date: 'a', stat: { normQuery: 'q', views: 10, clicks: 3, atbs: 1, orders: 0, spend: 12.5 } }, { date: 'b', stat: { normQuery: 'q', views: 5, clicks: 2, atbs: 0, orders: 1, spend: 7.5 } }, { date: 'b', stat: { normQuery: 'w', clicks: 1, spend: 1 } }] });
  assert.deepEqual(r, { advert_id: 1, nm_id: 2, stats: [{ norm_query: 'q', views: 15, clicks: 5, atbs: 1, orders: 1, spend: 20 }, { norm_query: 'w', views: 0, clicks: 1, atbs: 0, orders: 0, spend: 1 }] }, 'дневная статистика v1 суммируется за период');
}
console.log('ads-agent: ozon, queries and learning checks passed');

// One new campaign a day: created, funded and started through launchOnly; the next run the same day creates nothing;
// the next day another one; launchOnly cannot start or fund any campaign it did not create itself
{
  const { launchOnly } = await import('./ads-agent.mjs');
  const calls = [], L = launchOnly(mockApi(calls));
  await assert.rejects(() => L.start(105), /только что созданную/, 'старую кампанию не включить');
  await assert.rejects(() => L.deposit(103, 1000, 1), /только что созданную/, 'чужой бюджет не пополнить');
  assert.ok(!('pause' in L) && !('stop' in L) && !('drop' in L));
  const day1 = await go({ stores: ['wb1'], mode: 'live', launch: { enabled: true } });
  const l1 = day1.out.actions.filter((a) => a.action === 'launch');
  assert.equal(l1.length, 1); assert.equal(l1[0].sku, '6', 'прибыльный товар без рекламы'); assert.equal(l1[0].id, 999); assert.equal(l1[0].result, 'ok');
  assert.match(l1[0].reason, /Через две недели проверю/);
  const again = await go({ stores: ['wb1'], mode: 'live', launch: { enabled: true } }, { state: day1.out, memory: day1.out.memory, now: NOW + 3600e3 });
  assert.equal(again.out.actions.filter((a) => a.action === 'launch').length, 0, 'вторая проверка в тот же день кампанию не создаёт');
  const day2 = await go({ stores: ['wb1'], mode: 'live', launch: { enabled: true } }, { state: day1.out, memory: day1.out.memory, now: NOW + 864e5 });
  assert.equal(day2.out.actions.filter((a) => a.action === 'launch').length, 1, 'на следующий день — снова одна');
  assert.ok(!day2.calls.some((x) => ['pause', 'stop'].includes(x[0])));
  const dry = await go({ stores: ['wb1'], launch: { enabled: true } });
  assert.equal(dry.calls.filter((x) => x[0] === 'create').length, 0, 'в режиме проверки только план');
  assert.equal(dry.out.actions.find((a) => a.action === 'launch').result, 'planned');
  // learning from launches: most new campaigns lost money → a bigger margin of safety for the next picks
  const mem = emptyMemory(); mem.outcomes = [1, 2, 3].map((i) => ({ t: 't' + i, action: 'launch', verdict: i < 3 ? 'hurt' : 'helped' }));
  const cfg = mergeConfig({});
  const tuned = autoTune(mem, cfg, NOW).find((x) => x.key === 'launch.minHeadroom');
  assert.ok(tuned && tuned.to > tuned.from, 'запуски в минусе — порог окупаемости выше');
}

// The whole crew works every check: each agent says what it did and writes one entry an hour (learned / proposes)
{
  const r1 = await go({ stores: ['wb1'], mode: 'live' });
  const C = r1.out.crew;
  ['wb', 'queries', 'products', 'audit'].forEach((k) => { assert.ok(C[k] && C[k].did.length && C[k].entry, 'работает и пишет: ' + k); });
  assert.equal(C.wb.name, 'Вайлд'); assert.equal(C.audit.name, 'Аудит');
  assert.match(C.audit.did[0], /ждут недели — 3/);
  const again = await go({ stores: ['wb1'], mode: 'live' }, { state: r1.out, memory: r1.out.memory, now: NOW + 3600e3 });
  const j = again.out.memory.crew.wb;
  assert.equal(j.length, 2, 'через час — вторая запись');
  assert.notEqual(j[0].text, j[1].text, 'без повторов');
  assert.notEqual(j[0].kind, j[1].kind, 'час учёбы, час идей');
}

// Daily skills: exactly one new skill per Moscow day, learned skills report every run; impact before → now
{
  const { CURRICULUM, learnSkills } = await import('./ads-skills.mjs');
  const mem = emptyMemory();
  learnSkills(mem, '2026-11-20'); learnSkills(mem, '2026-11-20');
  assert.deepEqual(mem.curriculum, [{ id: CURRICULUM[0].id, since: '2026-11-20' }], 'в один день — один навык');
  learnSkills(mem, '2026-11-21');
  assert.deepEqual(mem.curriculum.map((x) => x.id), [CURRICULUM[0].id, CURRICULUM[1].id], 'на следующий день — следующий');
  for (let d = 22; d < 22 + CURRICULUM.length + 3; d++) learnSkills(mem, '2026-11-' + String(d).padStart(2, '0'));
  assert.equal(mem.curriculum.length, CURRICULUM.length, 'список кончился — новых не выдумывает');
  assert.equal(new Set(mem.curriculum.map((x) => x.since)).size, CURRICULUM.length);

  const first = await go({ stores: ['wb1'], mode: 'live' });
  assert.equal(first.out.memory.curriculum.length, 1);
  const prof = first.out.insights.find((x) => x.skill === 'profit');
  assert.ok(prof && /прибыли после расходов/.test(prof.items[0]), 'первый навык уже работает');
  assert.ok(first.out.learned.skills.has.some((x) => x.daily && x.since === '2026-11-16'), 'навык виден в списке освоенных с датой');
  assert.match(first.out.learned.skills.next[0], /^Завтра освою: /);
  // impact: campaign 102 before the cut spent 300 ₽ a day; a week later it spends 100 ₽ with the same orders
  const shift = (x) => ({ ...x, days: x.days.map((d) => [new Date(Date.parse(d[0]) + 8 * 864e5).toISOString().slice(0, 10), d[1], d[2], d[3]]) });
  const better = { ...market, ads: market.ads.map((a) => shift(a.id === 102 ? ad(102, 2, 3000, 30, 30000) : a)) };
  const later = await run({ cfg: noLaunch({ stores: ['wb1'], mode: 'live' }), data, market: better, state: first.out, memory: first.out.memory, apis: { wb1: mockApi([]) }, now: NOW + 8 * 864e5 });
  assert.equal(later.memory.curriculum.length, 2, 'через неделю — второй навык (запусков в эти дни не было)');
  const I = later.impact;
  assert.equal(I.camps, 3, 'кампании, где агент что-то делал: 102, 103, 104');
  assert.ok(I.spendSavedDay >= 200, 'расход 102 упал с 300 до 100 ₽ в день');
  assert.ok(I.profitGainDay > 0); assert.ok(I.drrBefore > I.drrNow, 'ДРР этих кампаний снизился');
  assert.equal(I.checked, 3); assert.ok(I.helped >= 1);
}

// One product — one running campaign: no replacement for a closed campaign while another one already shows the product
{
  const metrics = [{ uid: 'wb1:41989944', id: 41989944, store: 'wb1', name: 'AI 196519290', status: 9, nms: [{ nm: 196519290 }] },
    { uid: 'wb1:500', id: 500, store: 'wb1', name: 'Пауза', status: 11, nms: [{ nm: 777 }] }];
  const busy = activeSkus(metrics);
  assert.equal(busy.get('wb1|196519290').id, 41989944); assert.ok(!busy.has('wb1|777'), 'кампания на паузе товар не занимает');
  const skipped = [];
  const views = [{ kind: 'archive', uid: 'wb1:34433534', m: { id: 34433534, store: 'wb1' }, name: 'TANTI', items: [{ key: 'ВБ Саковский|196519290', nm: 196519290, existing: [], good: [], clusters: [] }] }];
  const vs = buildVariants({ views, pool: [], metrics, memory: emptyMemory(), cfg: mergeConfig({ plan: { maxVariants: 5, budget: 1000 } }), archiveInfo: { 34433534: { spend: 20000, orders: 60, ordSum: 100000, buyout: 0.9, margin: 0.15 } }, skipped });
  assert.equal(vs.length, 0, 'замену закрытой кампании не предлагает: товар уже в 41989944');
  assert.match(skipped[0].why, /уже рекламируется в кампании 41989944/);
}
console.log('ads-agent: duplicate-campaign checks passed');

// Top queries watch: week windows from daily cluster stats, alerts on a slipping top query, snapshots in memory
{
  const { sumClusterDays } = await import('./ads-agent.mjs');
  const { trackTop } = await import('./ads-top.mjs');
  const { messageText, dayReport } = await import('./ads-report.mjs');
  const day = (n) => new Date(Date.parse('2026-11-18') - n * 864e5).toISOString().slice(0, 10);
  const daily = [];
  for (let n = 0; n < 14; n++) {
    const recent = n < 7;
    daily.push({ date: day(n) + 'T00:00:00Z', stat: { normQuery: 'тушенка говяжья', views: recent ? 100 : 300, clicks: recent ? 4 : 10, orders: recent ? 0 : 1, spend: 30, avgPos: recent ? 18 : 6 } });
    daily.push({ date: day(n), stat: { normQuery: 'тушенка', views: 200, clicks: 8, orders: 1, spend: 40, avgPos: 4 } });
  }
  const r = sumClusterDays({ advertId: 7, nmId: 9, dailyStats: daily });
  const a = r.stats.find((x) => x.norm_query === 'тушенка говяжья');
  assert.deepEqual(a.wk.w7, { views: 700, clicks: 28, orders: 0, spend: 210, pos: 18 }, 'последние 7 дней');
  assert.deepEqual(a.wk.p7, { views: 2100, clicks: 70, orders: 7, spend: 210, pos: 6 }, 'предыдущие 7 дней');
  const row = (c) => ({ q: c.norm_query, views: c.views, clicks: c.clicks, orders: c.orders, spend: c.spend, wk: c.wk, pos: c.wk.w7.pos });
  const view = { kind: 'active', m: { store: 'wb1', id: 7, name: 'РК тушёнка' }, items: [{ nm: 9, key: 'ВБ Саковский|9', product: 'Тушёнка', top: r.stats.map(row).sort((x, y) => y.wk.w7.views - x.wk.w7.views) }] };
  const memory = {};
  const top = trackTop([view], memory, '2026-11-18', mergeConfig({}));
  assert.equal(top.length, 1);
  const kinds = top[0].alerts.map((x) => x.kind + ':' + x.q);
  assert.ok(kinds.includes('pos:тушенка говяжья'), 'позиция 6 → 18');
  assert.ok(kinds.includes('orders:тушенка говяжья'), 'заказы пропали');
  assert.ok(!kinds.some((k) => k.endsWith(':тушенка')), 'стабильный запрос без сигналов');
  assert.equal(memory.top['wb1:7:9'].length, 1, 'срез дня сохранён');
  // the same day again replaces the snapshot; a paused campaign is not watched
  trackTop([view, { ...view, kind: 'paused' }], memory, '2026-11-18', mergeConfig({}));
  assert.equal(memory.top['wb1:7:9'].length, 1);
  // a week later a new query enters the top-3 → alert from the snapshot comparison (no daily stats this time)
  const later = { ...view, items: [{ ...view.items[0], top: [{ q: 'тушенка белорусская', views: 900, clicks: 30, orders: 3, spend: 200, wk: null, pos: null }, ...view.items[0].top.map((x) => ({ ...x, wk: null }))] }] };
  const t2 = trackTop([later], memory, '2026-11-25', mergeConfig({}));
  assert.ok(t2[0].alerts.some((x) => x.kind === 'new' && x.q === 'тушенка белорусская'));
  // Telegram: the section with the alert
  const A = { generated: '2026-11-18T09:00:00Z', mode: 'live', campaigns: [{ id: 7, store: 'wb1', status: 9, spend30: 1000 }], history: [], actions: [], top };
  const txt = messageText(dayReport(A, Date.parse('2026-11-18T12:00:00Z')), 'wb');
  assert.match(txt, /🔝 Топ-запросы/); assert.match(txt, /«тушенка говяжья» — позиция 6 → 18/);
}

// 30. Owner's rule 22.11.2026: the agents touch only the campaigns they created themselves
{
  const { ownOnly, ownRegistry } = await import('./ads-agent.mjs');
  // 101 was launched by the agents; 102 and 103 are the managers'; 104 is a manager's copy named like an agent one
  const camp = (id, nm, name) => ({ id, status: 9, bid_type: 'unified', settings: { name: name || 'РК ' + id, payment_type: 'cpm', placements: { search: true, recommendations: true } }, nm_settings: [{ nm_id: nm, bids_kopecks: { search: 30000, recommendations: 30000 } }] });
  const calls = [], rec = (name) => async (...a) => { calls.push([name, ...a]); return name === 'create' ? 999 : null; };
  const api = { list: async () => [camp(101, 1), camp(102, 2), camp(103, 6), camp(104, 4, 'AI 4 копия менеджера')].map(normCampaign),
    minBids: async (c) => Object.fromEntries(c.nms.map((n) => [n.nm, { combined: 10000 }])), clusters: async (items) => items.map((i) => ({ ...i, stats: [] })), getMinus: async (items) => items.map((i) => ({ ...i, norm_queries: [] })),
    setBids: rec('setBids'), setMinus: rec('setMinus'), setClusterBids: rec('setClusterBids'), start: rec('start'), pause: rec('pause'), stop: rec('stop'), deposit: rec('deposit'), create: rec('create'), drop: rec('drop') };
  const state = { history: [{ t: '2026-11-10T05:00:00Z', store: 'wb1', id: 101, action: 'launch', result: 'ok', sku: '1' }] };
  const m3 = { ...market, ads: [ad(101, 1, 9000, 30, 30000), ad(102, 2, 9000, 30, 30000), ad(103, 6, 9000, 30, 30000), ad(104, 4, 9000, 30, 30000)] };
  const r = await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live', launch: { enabled: true } }), data, market: m3, state, apis: { wb1: api }, now: NOW });
  assert.deepEqual(r.campaigns.map((c) => c.id), [101], 'в решениях только кампания агентов, копия «AI …» менеджера тоже чужая');
  assert.ok(calls.every((c) => c[0] === 'create' || [101, 999].includes(c[1])), 'в кампании менеджеров ничего не отправлено');
  assert.ok(!calls.some((c) => c[0] === 'setBids' && c[1] !== 101));
  assert.ok(!r.actions.some((a) => a.action === 'launch' && ['2', '6'].includes(a.sku)), 'на товар, который рекламируют менеджеры, новую кампанию не создаёт');
  assert.equal(r.actions.filter((a) => a.action === 'launch').length, 0, 'единственный подходящий товар (6) уже у менеджера');
  assert.deepEqual(r.managed, { own: 1, others: 3 });
  // without the manager's campaign on product 6 the agents launch it, and the new campaign is theirs at once
  const api2 = { ...api, list: async () => [camp(101, 1), camp(102, 2)].map(normCampaign) };
  const r2 = await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live', launch: { enabled: true } }), data, market: { ...m3, ads: [ad(101, 1, 1500, 30, 30000), ad(102, 2, 1500, 30, 30000)] }, state, apis: { wb1: api2 }, now: NOW });
  assert.equal(r2.actions.find((a) => a.action === 'launch').sku, '6');
  assert.ok(r2.own.some((o) => o.id === 999 && o.src === 'agent'), 'созданная кампания сразу становится своей');
  // the list of own campaigns survives the history being cut
  const later = ownRegistry({ own: r2.own, history: [] });
  assert.ok(later.has('wb1', 101) && later.has('wb1', 999) && !later.has('wb1', 102));
  // a direct write to someone else's campaign is refused whatever asks for it
  const guarded = ownOnly(api, 'wb1', later.has);
  await assert.rejects(() => guarded.setBids(102, []), /создана не агентами/);
  await assert.rejects(() => guarded.setMinus(103, 6, ['x']), /создана не агентами/);
  await assert.rejects(() => guarded.setClusterBids([{ advertId: 101, nmId: 1 }, { advertId: 104, nmId: 4 }]), /создана не агентами/);
  await guarded.setBids(101, []);
  // a brain asking to change a manager's campaign gets nothing: it never sees it
  const seen = [];
  await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live', launch: { enabled: false } }), data, market: m3, state, apis: { wb1: api }, now: NOW,
    brain: async ({ rows }) => { seen.push(...rows.map((x) => x.uid)); return { summary: '', decisions: [{ uid: 'wb1:102', action: 'lower', bidPct: 20, reason: 'чужая' }] }; } });
  assert.deepEqual(seen, ['wb1:101'], 'Claude видит только кампании агентов');
  console.log('ads-agent: own-campaigns-only checks passed');
}
