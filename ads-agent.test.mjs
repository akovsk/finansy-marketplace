// Checks of the agent's decision logic and hard limits on small made-up data: node ads-agent.test.mjs
import assert from 'node:assert/strict';
import { mergeConfig, run, guard, newBids, stopReason, normCampaign } from './ads-agent.mjs';

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
  funnel: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => ['Магазин|' + n, { bp: 100 }])), reviews: {} };

function mockApi(calls) {
  const camp = (id, nm) => ({ id, status: 9, bid_type: 'unified', settings: { name: 'РК ' + id, payment_type: 'cpm', placements: { search: true, recommendations: true } }, nm_settings: [{ nm_id: nm, bids_kopecks: { search: 30000, recommendations: 30000 } }] });
  const rec = (name) => async (...a) => { calls.push([name, ...a]); return name === 'create' ? 999 : null; };
  return { list: async () => [camp(101, 1), camp(102, 2), camp(103, 3), camp(104, 4), camp(105, 5), camp(106, 1), camp(107, 5)].map(normCampaign),
    minBids: async (c) => Object.fromEntries(c.nms.map((n) => [n.nm, { combined: 25000 }])),
    setBids: rec('setBids'), start: rec('start'), pause: rec('pause'), stop: rec('stop'), deposit: rec('deposit'), create: rec('create') };
}
const go = async (over = {}, extra = {}) => { const calls = []; const out = await run({ cfg: mergeConfig(over), data, market, state: extra.state || {}, apis: { wb1: mockApi(calls) }, now: NOW, claude: extra.claude }); return { out, calls, by: Object.fromEntries(out.campaigns.map((c) => [c.id, c])) }; };

// 1. Rules on their own
{
  const { by, calls, out } = await go({ stores: ['wb1'] });
  assert.equal(by[101].action, 'keep', 'ДРР 15% при цели 18% (маржа 30%) — в норме');
  assert.equal(by[102].action, 'lower', 'ДРР 30% при марже 30%: выше цели, но не убыток x1.4 — снижать');
  assert.equal(by[102].bidPct, -25);
  assert.equal(by[103].action, 'stop', 'товар убыточен до рекламы — закрыть');
  assert.equal(by[104].action, 'raise', 'ДРР 3.75% при цели 24% — масштабировать');
  assert.equal(by[105].action, 'stop', '4000 ₽ без заказов — закрыть');
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
  assert.deepEqual(names, ['pause:107', 'setBids:102', 'setBids:104', 'stop:103', 'stop:105']);
  assert.deepEqual(calls.find((c) => c[0] === 'setBids' && c[1] === 104)[2], [{ nm: 4, placement: 'combined', kop: 34500, was: 30000 }]);
  assert.equal(out.history.length, 5);
  assert.ok(out.camp[102].lastBidAt && out.camp[107].pausedByAgent);
  // next run 2 hours later: cooldown blocks a second bid change
  const calls2 = []; const again = await run({ cfg: mergeConfig({ stores: ['wb1'], mode: 'live' }), data, market, state: out, apis: { wb1: mockApi(calls2) }, now: NOW + 2 * 3600e3 });
  assert.ok(!calls2.some((c) => c[0] === 'setBids'), 'повторно ставку в течение суток не меняет');
  assert.match(again.campaigns.find((c) => c.id === 102).blocked, /жду статистику/);
}
// 3. Claude's proposals cannot get past the hard limits
{
  const claude = async (rows) => ({ summary: 'Тест.', decisions: rows.map((r) => ({ id: r.id, action: r.id === 101 ? 'stop' : r.id === 102 ? 'raise' : r.id === 104 ? 'raise' : r.id === 106 ? 'lower' : 'keep', bidPct: 80, reason: 'Проверка.' })).concat([{ id: 555, action: 'stop', bidPct: 0, reason: 'чужая' }]) });
  const { by, out, calls } = await go({ stores: ['wb1'], mode: 'live' }, { claude });
  assert.equal(out.engine, 'claude');
  assert.equal(by[101].action, 'keep', 'прибыльную кампанию закрыть нельзя'); assert.ok(by[101].blocked);
  assert.equal(by[102].action, 'keep', 'повышать ставку при ДРР выше цели нельзя');
  assert.equal(by[104].bidPct, 15, 'шаг повышения урезан с 80% до 15%');
  assert.equal(by[106].action, 'keep', 'мало данных — ставку не трогаем');
  assert.ok(!by[555] && !calls.some((c) => c[1] === 555), 'неизвестная кампания игнорируется');
  assert.equal(by[103].action, 'keep', 'Claude решил не закрывать — его право');
}
// 4. If Claude fails, the rules take over
{
  const { out, by } = await go({ stores: ['wb1'] }, { claude: async () => { throw new Error('boom'); } });
  assert.equal(out.engine, 'rules'); assert.equal(by[103].action, 'stop'); assert.match(out.errors[0], /Claude недоступен/);
}
// 5. Limits: stops per run, protect list, bid cap, launch and top-up are off unless enabled
{
  const a = await go({ stores: ['wb1'], stop: { maxPerRun: 1 } });
  assert.equal(a.out.actions.filter((x) => x.action === 'stop').length, 1);
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
