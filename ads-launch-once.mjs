// One-off launch of an Ozon campaign on the owner's request, outside the agent's usual filters.
// Request: .github/launch-once.json  { "store": "oz1", "sku": "…", "weeklyBudget": 3500, "targetCir": 15 (optional) }
// The campaign is created fully set up (search + category placement, «Целевой расход» strategy with the target ДРР,
// weekly budget cap, the product in it) and switched on; then it is read back from Ozon and the settings are checked.
// The launch goes into ads-agent.json history, so the agent counts it and watches it like its own campaigns.
import { readFileSync, writeFileSync } from 'node:fs';
import { ozonApi } from './ozon-ads.mjs';
import { mergeConfig, skuEconomics } from './ads-agent.mjs';

const J = (f, d) => { try { return JSON.parse(readFileSync(new URL('./' + f, import.meta.url), 'utf8')); } catch (e) { if (d !== undefined) return d; throw e; } };
const env = (k) => (process.env[k] || '').trim();
// Every outcome lands in .github/launch-once.result.json, so it can be read without access to the Actions logs
const report = (o) => writeFileSync(new URL('./.github/launch-once.result.json', import.meta.url), JSON.stringify({ t: new Date().toISOString(), ...o }, null, 1));
const fail = (msg) => { console.error('STOP: ' + msg); report({ result: 'stopped', why: msg }); process.exit(1); };
process.on('uncaughtException', (err) => fail('ошибка: ' + err.message));
process.on('unhandledRejection', (err) => fail('ошибка: ' + (err && err.message || err)));

const req = J('.github/launch-once.json');
const KEYS = { oz1: 'OZON_PERF_SAKOVSKY', oz2: 'OZON_PERF_SUAVISS' };
if (!KEYS[req.store]) fail('магазин ' + req.store + ' не поддерживается (только oz1 / oz2)');
const id = env(KEYS[req.store] + '_CLIENT_ID'), sec = env(KEYS[req.store] + '_CLIENT_SECRET');
if (!id || !sec) fail('нет ключей Ozon Performance API для ' + req.store);

const data = J('data.json'), cfg = mergeConfig(J('ads-agent.config.json'));
const store = data.stores.find((s) => s.id === req.store);
const api = ozonApi(id, sec, store.name);
const before = await api.list();
console.log('Кампаний в кабинете:', before.length);
// "skus": goods in order of preference — the first one with data and not in an active campaign is launched
const econ = skuEconomics(data), skipped = [];
for (const s of (req.skus || [req.sku]).map(String)) {
  const b = before.find((c) => c.status === 9 && c.nms.some((n) => n.nm === s));
  if (b) { skipped.push(s + ' уже в активной кампании ' + b.id + ' «' + b.name + '»'); continue; }
  if (!econ.get(store.name + '|' + s)) { skipped.push(s + ' нет в данных за 30 дней'); continue; }
  req.sku = s; break;
}
skipped.forEach((x) => console.log('Пропускаю:', x));
if (!req.sku || skipped.some((x) => x.startsWith(req.sku + ' '))) fail('нет подходящего товара: ' + skipped.join('; '));
const key = store.name + '|' + req.sku, e = econ.get(key);
const weekly = Math.round(+req.weeklyBudget || cfg.ozon.launch.weeklyBudget || 3500);
// Target ДРР: the agent's own goal for a new campaign — a share of the margin before ads, capped
const goal = e.margin > 0 ? Math.min(cfg.maxDrr, cfg.targetShare * e.margin) : 0.1;
const cir = Math.min(50, Math.max(5, Math.round(+req.targetCir || goal * 100)));
const title = ('AI ' + req.sku + ' ' + String(e.name).replace(/[\/|]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 60);
console.log('Товар:', key, '|', e.name, '| маржа до рекламы', Math.round(e.margin * 100) + '%', '| продаж за 30 дн', e.q);
console.log('План: «' + title + '», целевой ДРР ' + cir + '%, недельный бюджет ' + weekly + ' ₽, поиск + каталог');


const out = J('ads-agent.json', {});
const act = { t: new Date().toISOString(), store: req.store, platform: 'ozon', action: 'launch', owner: true, key, sku: String(req.sku), name: e.name,
  reason: 'По вашей просьбе: новая кампания «Оплата за клик», поиск и каталог, стратегия «целевой ДРР» ' + cir + '% (маржа до рекламы ' + Math.round(e.margin * 100) + '%), недельный бюджет ' + weekly + ' ₽.' };
try {
  act.id = await api.create(title, req.sku, cir, weekly);
  act.result = 'ok';
} catch (err) { act.result = 'error'; act.error = err.message; }

// Read the campaign back and check every setting
if (act.id) {
  await new Promise((r) => setTimeout(r, 5000));
  const c = (await api.list()).find((x) => x.id === act.id);
  const p = c && c.nms.find((n) => n.nm === String(req.sku));
  const checks = c ? [
    ['кампания включена', c.status === 9, c.status],
    ['стратегия «целевой ДРР»', c.strategy === 'TARGET_CIR', c.strategy],
    ['места показа поиск + каталог', /SEARCH_AND_CATEGORY/.test(c.placement), c.placement],
    ['недельный бюджет ' + weekly + ' ₽', Math.round(c.weeklyBudget) === weekly, c.weeklyBudget],
    ['товар в кампании', !!p, c.nms.map((n) => n.nm).join(',')],
    ['целевой ДРР ' + cir + '%', !!p && Math.round(p.cir) === cir, p && p.cir],
  ] : [['кампания найдена в кабинете', false, act.id]];
  act.check = checks.map(([what, ok, got]) => ({ what, ok, got: got == null ? null : String(got) }));
  checks.forEach(([what, ok, got]) => console.log((ok ? '  ✓ ' : '  ✗ ') + what + (ok ? '' : ' — в кабинете: ' + got)));
}
console.log('\nРезультат:', act.result, act.id ? 'кампания ' + act.id : '', act.error || '');

out.history = (out.history || []).concat([act]).slice(-400);
out.actions = (out.actions || []).concat([act]);
writeFileSync(new URL('./ads-agent.json', import.meta.url), JSON.stringify(out));
report({ result: act.result, sku: req.sku, skipped, id: act.id || null, error: act.error || null, check: act.check || null, title, cir, weekly });
if (act.result !== 'ok') process.exit(1);
