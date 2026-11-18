// One-off fix on WB on the owner's request: finish a campaign that duplicates another one on the same product.
// Request: .github/wb-once.json  { "store": "wb1", "stop": 42013468, "keep": 41989944, "sku": "196519290" }
// Checks first, through the API: both campaigns hold the product and the kept one is running. Otherwise nothing is touched.
// The outcome goes to .github/wb-once.result.json and into the agent's history.
import { readFileSync, writeFileSync } from 'node:fs';
import { wbApi } from './ads-agent.mjs';

const J = (f, d) => { try { return JSON.parse(readFileSync(new URL('./' + f, import.meta.url), 'utf8')); } catch (e) { if (d !== undefined) return d; throw e; } };
const report = (o) => writeFileSync(new URL('./.github/wb-once.result.json', import.meta.url), JSON.stringify({ t: new Date().toISOString(), ...o }, null, 1));
const fail = (msg) => { console.error('STOP: ' + msg); report({ result: 'stopped', why: msg }); process.exit(1); };
process.on('unhandledRejection', (err) => fail('ошибка: ' + (err && err.message || err)));

const req = J('.github/wb-once.json');
const TOKENS = { wb1: 'WB_SAKOVSKY_TOKEN', wb2: 'WB_DARMIL_TOKEN' };
const token = (process.env[TOKENS[req.store]] || '').trim();
if (!token) fail('нет токена WB для ' + req.store);

const api = wbApi(token);
const list = await api.list();
const dup = list.find((c) => c.id === +req.stop), keep = list.find((c) => c.id === +req.keep);
const has = (c) => c && c.nms.some((n) => String(n.nm) === String(req.sku));
if (!dup) fail('кампании ' + req.stop + ' нет среди активных, приостановленных и готовых — возможно, уже завершена');
if (!keep || keep.status !== 9) fail('кампания ' + req.keep + ', которую оставляем, не идёт (статус ' + (keep && keep.status) + ') — дубль не трогаю');
if (!has(dup) || !has(keep)) fail('товар ' + req.sku + ' есть не в обеих кампаниях — это не дубль');
console.log('Дубль:', dup.id, dup.name, 'статус', dup.status, '| оставляем:', keep.id, keep.name);

const act = { t: new Date().toISOString(), store: req.store, platform: 'wb', id: dup.id, name: dup.name, action: 'stop', owner: true, sku: String(req.sku),
  reason: 'Дубль: товар ' + req.sku + ' уже продвигается в кампании ' + keep.id + ' с теми же зонами показов — WB показывал «Конфликт кампаний». Завершаю лишнюю, ' + keep.id + ' работает дальше.' };
try { await api.stop(dup.id); act.result = 'ok'; } catch (e) { act.result = 'error'; act.error = e.message; }
await new Promise((r) => setTimeout(r, 4000));
const after = (await api.list()).find((c) => c.id === dup.id);
act.after = after ? after.status : 'завершена';
console.log('Результат:', act.result, act.error || '', '| статус после:', act.after);

const out = J('ads-agent.json', {});
out.history = (out.history || []).concat([act]).slice(-400);
writeFileSync(new URL('./ads-agent.json', import.meta.url), JSON.stringify(out));
report({ result: act.result, stopped: dup.id, kept: keep.id, statusAfter: act.after, error: act.error || null });
if (act.result !== 'ok') process.exit(1);
