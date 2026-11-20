// Daily Telegram report of the ads agents, one message per marketplace (done today / planned / learned today), with screenshots.
// node ads-report.mjs            — render and send (needs TELEGRAM_BOT_TOKEN, playwright with chromium)
// node ads-report.mjs --html     — only write ads-report.html (to check the layout locally)
// Chat: TELEGRAM_CHAT_ID; without it the chat is taken from the last message sent to the bot (write /start to it).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { planText } from './ads-plan.mjs';

const DASH = 'https://akovsk.github.io/finansy-marketplace/';
export const WB_ADS_URL = (id) => 'https://cmp.wildberries.ru/campaigns/edit/' + id;
const readJson = (name, fb) => { try { return JSON.parse(readFileSync(new URL('./' + name, import.meta.url), 'utf8')); } catch (e) { return fb; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rub = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString('ru-RU') + ' ₽');
const pct = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '%');
const mskDay = (t) => new Date(Date.parse(t) + 3 * 3600e3).toISOString().slice(0, 10);

const ACT = {
  stop: ['Закрыта', 'bad'], pause: ['Пауза', 'warn'], resume: ['Включена', 'good'], lower: ['Ставка ниже', 'warn'],
  raise: ['Ставка выше', 'good'], launch: ['Новая кампания', 'good'], topup: ['Пополнена', 'good'],
  minus: ['Запросы убраны', 'good'], drop: ['Товары убраны', 'good'], restart: ['Перезапущена', 'good'], boost: ['Ставки на запросы', 'good'],
};

export function dayReport(A, now = Date.now()) {
  const today = mskDay(new Date(now).toISOString());
  const hist = A.history || [];
  let acts = hist.filter((a) => a.t && mskDay(a.t) === today);
  const planned = A.mode !== 'live';
  if (planned) acts = (A.actions || []).filter((a) => a.t && mskDay(a.t) === today);
  // An error that a later run fixed (same campaign, same action, done ok) is not an error any more
  const fixed = (e) => acts.some((a) => a.result !== 'error' && a.id === e.id && a.action === e.action && a.t >= e.t);
  acts = acts.filter((a) => a.result !== 'error' || !fixed(a));
  const byId = new Map((A.campaigns || []).map((c) => [c.id, c]));
  const n = (k) => acts.filter((a) => a.action === k && a.result !== 'error').length;
  const errors = acts.filter((a) => a.result === 'error');
  // Money: closed campaigns spent this much per day over the last 30 days
  const saved = acts.filter((a) => (a.action === 'stop' || (a.action === 'pause' && a.loss)) && a.result !== 'error').reduce((s, a) => s + ((byId.get(a.id) || {}).spend30 || 0) / 30, 0);
  const launched = hist.filter((a) => a.action === 'launch' && a.result === 'ok').map((a) => ({ a, c: byId.get(a.id) }));
  return { today, planned, acts, errors, saved, launched, n, A };
}

// "196519290 TANTI_Prokladki_Ultra_SL_8х2 G" → "TANTI Prokladki Ultra SL 8х2"
export const cleanName = (s) => String(s || '').trim().replace(/^(СРС|CPC|АРК|АУК)\s+/i, '').replace(/^\d{5,}\s*/, '').replace(/_/g, ' ').replace(/\s+[A-Z]$/, '').replace(/\s+/g, ' ').trim();
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
// Plain-words reason for one action, from the campaign numbers
function why(a, c) {
  c = Object.assign({}, c);
  // numbers from the agent's own reason when the campaign has no fresh stats
  const r = a.reason || '', m1 = r.match(/маржа (-?\d+)%/) || r.match(/марже до рекламы (-?\d+)%/), d1 = r.match(/ДРР (\d+)%/);
  if (c.margin == null && m1) c.margin = +m1[1] / 100;
  if (c.drr30 == null && d1) c.drr30 = +d1[1] / 100;
  if (a.action === 'stop' || a.action === 'pause') {
    if (c.margin != null && c.margin < 0) return 'товар в минусе ещё до рекламы (маржа ' + pct(c.margin) + ')';
    if (c.margin != null && c.margin < 0.05) return 'маржа всего ' + pct(c.margin) + ', на рекламу денег нет';
    if (c.drr30 != null && c.margin != null) return 'реклама забирала ' + pct(c.drr30) + ' выручки при марже ' + pct(c.margin);
    return 'реклама не окупалась';
  }
  if (a.action === 'lower') return 'реклама дорогая' + (c.drr30 != null ? ' (' + pct(c.drr30) + ' выручки)' : '') + (a.bids && a.bids[0] ? ', ставка ' + a.bids[0].wasRub + ' → ' + a.bids[0].rub + ' ₽' : '');
  if (a.action === 'raise') return 'реклама окупается, можно больше показов' + (a.bids && a.bids[0] ? ', ставка ' + a.bids[0].wasRub + ' → ' + a.bids[0].rub + ' ₽' : '');
  if (a.action === 'launch') return 'товар с хорошей маржой и запасом, бюджет ' + rub(a.budget || 1000);
  if (a.action === 'resume') return 'товар снова в наличии';
  return '';
}

// Telegram message (HTML): warm, plain words, grouped by what was done
const round = (x, step) => Math.round(x / step) * step;
const money = (x) => rub(x >= 1000 ? round(x, 100) : round(x, 10));
function say(a, c) {
  c = Object.assign({}, c);
  const r = a.reason || '', m1 = r.match(/маржа (-?\d+)%/) || r.match(/марже до рекламы (-?\d+)%/), d1 = r.match(/ДРР (\d+)%/);
  if (c.margin == null && m1) c.margin = +m1[1] / 100;
  if (c.drr30 == null && d1) c.drr30 = +d1[1] / 100;
  const b = a.bids && a.bids[0], bid = b ? Math.round(b.wasRub) + ' → ' + Math.round(b.rub) + ' ₽' : '';
  if (a.action === 'stop' || a.action === 'pause') {
    if (c.margin != null && c.margin < 0) return 'товар и без рекламы продаётся в минус (' + pct(c.margin) + '), реклама только добавляла убыток';
    if (c.margin != null && c.margin < 0.05) return 'на товаре остаётся всего ' + pct(c.margin) + ', рекламу он не тянет';
    if (c.drr30 != null && c.margin != null) return 'реклама съедала ' + pct(c.drr30) + ' выручки, а на товаре остаётся только ' + pct(c.margin);
    return 'реклама не окупалась';
  }
  if (a.action === 'lower') return 'ставка ' + bid + (c.drr30 != null ? ': реклама обходилась дороговато (' + pct(c.drr30) + ' выручки)' : '');
  if (a.action === 'raise') return 'ставка ' + bid + ': реклама окупается, пусть товар видят чаще';
  if (a.action === 'launch') return 'хорошая маржа и запас на складе, бюджет ' + rub(a.budget || 1000);
  if (a.action === 'resume') return 'товар снова в наличии';
  return '';
}
// One message per marketplace: what was done today, what is planned, what was learned today
export const platOf = (x) => x.platform || (String(x.store || '').startsWith('oz') ? 'ozon' : 'wb');
const ACT_WORD = { lower: 'снижение ставки', raise: 'повышение ставки', pause: 'пауза', stop: 'закрытие', minus: 'исключение запросов', launch: 'запуск', drop: 'убранные товары', restart: 'перезапуск' };
const SKILL_PLAT = { ozon: 'ozon' };
export function messageText(R, p = 'wb') {
  const { A } = R, d = new Date(R.today + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  const C = (A.campaigns || []).filter((c) => platOf(c) === p);
  const byId = new Map(C.map((c) => [c.id, c]));
  const planned = p === 'ozon' ? A.ozonMode !== 'live' : A.mode !== 'live';
  const acts = R.acts.filter((a) => platOf(a) === p);
  const ok = acts.filter((a) => a.result !== 'error'), errors = acts.filter((a) => a.result === 'error');
  const n = (k) => ok.filter((a) => a.action === k).length;
  const k = (x) => (x >= 1000 ? (Math.round(x / 100) / 10).toString().replace('.', ',') + 'к' : String(Math.round(x)));
  const MP = p === 'ozon' ? 'Ozon' : 'WB';
  const L = [(p === 'ozon' ? '🔵' : '🟣') + ' <b>Реклама ' + MP + ' · ' + d + '</b>' + (planned ? '  🧪 <i>режим проверки</i>' : '')];
  const active = C.filter((c) => c.status === 9).length, paused = C.filter((c) => c.status === 11).length;
  const notes = (A.notes || []).filter((x) => (p === 'ozon' ? /Ozon|Озон|OZON/ : /WB|ВБ|Дармил/).test(x));
  if (!C.length) {
    L.push('', notes.length ? notes.map((x) => '⚠️ ' + esc(x)).join('\n') : 'Кабинет не подключён.');
    return L.join('\n');
  }
  L.push('🟢 Работают: <b>' + active + '</b>  ·  на паузе: ' + paused);
  const saved = ok.filter((a) => a.action === 'stop' || (a.action === 'pause' && a.loss)).reduce((s, a) => s + ((byId.get(a.id) || {}).spend30 || 0) / 30, 0);
  if (saved > 0) L.push('💸 Экономия: <b>+' + k(round(saved, 10)) + ' ₽/день</b>');

  // 1. Done today
  L.push('', planned ? '<b>✅ Что сделаю</b> <i>(пока только план — в кабинете без изменений)</i>' : '<b>✅ Что сделал сегодня</b>');
  const link = (a) => { const nm = esc(cleanName(a.name) || 'арт. ' + a.sku); return p === 'wb' && a.id ? '<a href="' + WB_ADS_URL(a.id) + '">' + nm + '</a>' : nm; };
  const sh = (a) => {
    const b = a.bids && a.bids[0];
    if (/улучшаю кампанию/.test(a.reason || '')) return 'чиню вместо паузы' + (b ? ': ставка ' + Math.round(b.wasRub) + ' → ' + Math.round(b.rub) + ' ₽' : a.note ? ': ' + a.note : '');
    if ((a.action === 'lower' || a.action === 'raise') && b) return Math.round(b.wasRub) + ' → ' + Math.round(b.rub) + ' ₽';
    if ((a.action === 'lower' || a.action === 'raise') && a.note) return a.note;
    if (a.action === 'pause') return a.loss ? 'в минусе, запросы сохранены' : 'нет товара на складе';
    if (a.action === 'minus') return (a.n ? 'исключено ' + a.n : '') + (a.moved ? (a.n ? ', ' : '') + 'перенесено ' + a.moved : '');
    if (a.action === 'drop') return 'убрано товаров: ' + (a.skus || []).length;
    if (a.action === 'restart') return /Пробный/.test(a.reason || '') ? 'пробный перезапуск после паузы' : 'после чистки запросов';
    if (a.action === 'launch') return 'бюджет ' + rub(a.budget || 1000);
    if (a.action === 'stop') return 'по вашему ответу';
    return '';
  };
  const group = (keys, title, max, f = () => true) => {
    const list = ok.filter((a) => keys.includes(a.action) && f(a)).sort((a, b) => ((byId.get(b.id) || {}).spend30 || 0) - ((byId.get(a.id) || {}).spend30 || 0));
    if (!list.length) return;
    L.push(title + ' <b>' + list.length + '</b>');
    list.slice(0, max).forEach((a) => L.push('   ▫️ ' + link(a) + ' — ' + esc(sh(a))));
    if (list.length > max) L.push('   ▫️ и ещё ' + (list.length - max));
  };
  const before = L.length;
  group(['lower'], '🛠 Чиню вместо паузы:', 4, (a) => /улучшаю кампанию/.test(a.reason || ''));
  group(['lower', 'raise'], '🎯 Ставки:', 4, (a) => !/улучшаю кампанию/.test(a.reason || ''));
  group(['minus'], '🧹 Запросы:', 3);
  group(['boost'], '🔎 Ставки на продающие запросы:', 2);
  group(['drop'], '➖ Убрал убыточные товары из РК:', 3);
  group(['pause'], '⏸ Пауза:', 4);
  group(['restart', 'resume'], '▶️ Снова в работе:', 4);
  group(['launch'], '🚀 Запустил:', 4);
  group(['stop'], '✂️ Закрыл:', 4);
  if (L.length === before) L.push('▫️ правки не понадобились — всё в пределах цели');
  if (errors.length) L.push('⚠️ ' + MP + ' не принял ' + errors.length + ' — повторю на следующей проверке');

  // 1b. Top queries: which search queries each product is found by, and which of them slipped this week
  if (p === 'wb' && Array.isArray(A.top) && A.top.length) {
    const T = A.top, hit = T.filter((t) => t.alerts.length);
    L.push('', '<b>🔝 Топ-запросы</b> <i>(' + T.length + ' ' + plural(T.length, 'товар', 'товара', 'товаров') + ' под наблюдением)</i>');
    const tl = (t) => '<a href="' + WB_ADS_URL(t.id) + '">' + esc(cleanName(t.product || t.name).slice(0, 32)) + '</a>';
    hit.slice(0, 4).forEach((t) => {
      L.push('   ▫️ ' + tl(t) + ':');
      t.alerts.slice(0, 2).forEach((x) => L.push('      «' + esc(x.q) + '» — ' + esc(x.text)));
    });
    if (hit.length > 4) L.push('   ▫️ и ещё ' + (hit.length - 4) + ' — в дашборде');
    if (!hit.length) {
      const t = T[0], r = t.rows.slice(0, 3).map((x) => '«' + esc(x.q) + '»' + (x.pos ? ' (поз. ' + x.pos + ')' : '')).join(', ');
      L.push('   ▫️ без просадок за неделю. Главные запросы у «' + esc(cleanName(t.product || t.name).slice(0, 28)) + '»: ' + r);
    }
  }

  // 2. Plan
  const next = [];
  const fix = C.filter((c) => /улучшаю кампанию/i.test(c.reason || '') && c.action === 'keep').length;
  if (fix) next.push('Продолжаю чинить ' + fix + ' ' + plural(fix, 'кампанию', 'кампании', 'кампаний') + ': следующий шаг ставки — когда накопится статистика.');
  const wait = C.filter((c) => c.blocked && /жду статистику|жду неделю/.test(c.blocked)).length;
  if (wait) next.push('Проверю ещё ' + wait + ' ' + plural(wait, 'кампанию', 'кампании', 'кампаний') + ' после прошлых изменений ставки.');
  const now = Date.parse(A.generated);
  // Losing campaigns whose bid is already at the minimum: the agents do not pause or finish them, the owner decides
  const att = (A.attention || []).filter((x) => platOf(x) === p);
  if (att.length) next.push('Ставка уже минимальная, а реклама в минусе: ' + att.slice(0, 3).map((x) => cleanName(x.name).slice(0, 25)).join(', ') + ' — остановить или оставить решаете вы.');
  if (p === 'wb') {
    (A.plan && A.plan.next || []).filter((x) => /спорн/.test(x)).slice(0, 2).forEach((x) => next.push(x));
    const adv = A.queryAdvice || [];
    if (adv.length) next.push('В кампаниях с оплатой за клик WB не даёт исключать запросы через API — там работаю ставкой. Запросы без продаж: ' + adv.slice(0, 2).map((x) => '«' + x.queries[0].q + '»').join(', ') + '.');
    next.push('Кампании не включаю, не ставлю на паузу и не завершаю — только ставки, статистика и запросы.');
  } else next.push('Слежу за ставками и целевым ДРР. Кампании и товары в них не трогаю; запросы в Ozon через API не исключаются.');
  const h = new Date(now + 3 * 3600e3).getUTCHours();
  L.push('', '<b>🗓 Что планирую</b>');
  next.slice(0, 5).forEach((x) => L.push('▫️ ' + esc(x)));
  L.push('⏰ Следующая проверка ' + (h >= 6 && h < 15 ? 'сегодня в 15:17' : 'в 06:17'));

  // 3. Learned today
  const T = (A.learned || {}).today || {}, learned = [];
  const out = (T.outcomes || []).filter((o) => platOf(o) === p);
  if (out.length) {
    const good = out.filter((o) => o.verdict === 'helped').length, bad = out.filter((o) => o.verdict === 'hurt').length, eff = out.reduce((s, o) => s + (o.effect || 0), 0);
    learned.push('Проверил ' + out.length + ' ' + plural(out.length, 'своё решение', 'своих решения', 'своих решений') + ' недельной давности: помогли ' + good + ', навредили ' + bad + ', итог ' + (eff >= 0 ? '+' : '') + k(eff) + ' ₽ в неделю.');
    out.filter((o) => o.effect).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 2).forEach((o) => learned.push((ACT_WORD[o.action] || o.action) + ' в «' + cleanName(o.name).slice(0, 30) + '»: ' + (o.effect >= 0 ? '+' : '') + k(o.effect) + ' ₽/нед'));
  }
  (T.tuned || []).filter((x) => (p === 'ozon') === /^ozon\./.test(x.key)).forEach((x) => learned.push('Подстроил правило «' + x.key + '»: ' + x.from + ' → ' + x.to + '. ' + x.why));
  const skills = (((A.learned || {}).skills || {}).has || []).filter((x) => x.since === R.today && (SKILL_PLAT[x.id] || 'wb') === p);
  skills.forEach((x) => learned.push('Новый навык: ' + x.text.charAt(0).toLowerCase() + x.text.slice(1) + '.'));
  if (p === 'wb' && A.engine === 'claude') ((A.learned || {}).lessons || []).slice(0, 1).forEach((x) => learned.push('💡 ' + x));
  if (!learned.length) {
    const pending = (A.history || []).filter((a) => platOf(a) === p && a.result === 'ok' && !a.evaluated && ['lower', 'raise', 'pause', 'minus', 'launch', 'restart', 'drop'].includes(a.action)).length;
    learned.push(pending ? 'Новых выводов пока нет: ' + pending + ' ' + plural(pending, 'решение ждёт', 'решения ждут', 'решений ждут') + ' недели, чтобы сравнить прибыль до и после.' : 'Новых выводов нет — коплю статистику.');
  }
  L.push('', '<b>🎓 Чему научился сегодня</b>');
  learned.slice(0, 5).forEach((x) => L.push('▫️ ' + esc(x)));
  L.push('', '<a href="' + DASH + '#overview">📲 дашборд</a>');
  return L.join('\n').slice(0, 4000);
}
export const captionText = (R) => messageText(R, 'wb').replace(/<[^>]+>/g, '');

export function reportHtml(R) {
  const { A } = R;
  const d = new Date(R.today + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const kpi = (l, v, cls) => '<div class="k"><span>' + l + '</span><b class="' + (cls || '') + '">' + v + '</b></div>';
  const row = (a) => {
    const k = ACT[a.action] || [a.action, ''], c = (A.campaigns || []).find((x) => x.id === a.id) || {};
    const res = a.result === 'error' ? '<em class="bad">WB отказал' + (/read-only/i.test(a.error || '') ? ': токен только на чтение' : '') + '</em>' : a.result === 'planned' ? '<em>план</em>' : '';
    const bids = a.bids && a.bids.length ? '<div class="m">Ставка: ' + a.bids.slice(0, 2).map((x) => x.wasRub + ' → ' + x.rub + ' ₽').join(', ') + '</div>' : '';
    const nums = c.spend30 != null ? '<div class="m">30 дней: расход ' + rub(c.spend30) + ', заказов ' + (c.orders30 ?? '—') + ', доля рекламы ' + pct(c.drr30) + ', маржа до рекламы ' + pct(c.margin) + '</div>' : '';
    return '<div class="r"><div class="h"><span class="t ' + k[1] + '">' + k[0] + '</span>' + (a.id ? '<span class="id">№ ' + a.id + '</span>' : '') + res + '</div>'
      + '<div class="n">' + esc(cleanName(a.name) || ('Артикул ' + a.sku)) + '</div><div class="m">' + esc(why(a, c)) + '</div>' + bids + nums + '</div>';
  };
  const order = ['stop', 'launch', 'pause', 'lower', 'raise', 'resume', 'topup'];
  const acts = R.acts.slice().sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  const launched = R.launched.map(({ a, c }) => {
    const ok = c && c.drr30 != null && c.margin != null && c.drr30 < c.margin;
    return '<div class="r"><div class="h"><span class="t ' + (c ? (ok ? 'good' : 'bad') : '') + '">' + (c ? (ok ? 'В плюсе' : 'Пока в минусе') : 'Нет данных') + '</span><span class="id">№ ' + a.id + '</span><span class="m">с ' + mskDay(a.t).split('-').reverse().slice(0, 2).join('.') + '</span></div>'
      + '<div class="n">' + esc(cleanName(a.name) || a.sku) + '</div>' + (c ? '<div class="m">Расход ' + rub(c.spend30) + ', заказов ' + (c.orders30 ?? 0) + ', доля рекламы ' + pct(c.drr30) + ' при марже ' + pct(c.margin) + '</div>' : '') + '</div>';
  }).join('');
  const active = (A.campaigns || []).filter((c) => c.status === 9).length;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отчёт агента рекламы</title>
<style>
:root{--bg:#0f1218;--panel:#171b23;--line:#262c37;--fg:#e8eaee;--mut:#9aa2b1;--ok:#5cc28a;--warn:#e0a640;--bad:#ef6b5e;--wb:#a65cf0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:18px 16px 22px}
h1{font-size:19px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 8px;color:var(--mut);font-weight:600}.sub{color:var(--mut);font-size:12.5px;margin:0 0 14px}
.ks{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.k{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:9px 11px}.k span{display:block;font-size:11.5px;color:var(--mut)}.k b{font-size:18px}
.r{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--wb);border-radius:6px 12px 12px 6px;padding:10px 12px;margin-bottom:8px}
.h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px}.t{font-weight:700}.id{color:var(--mut)}.n{font-weight:600;margin:3px 0 2px}.m{color:var(--mut);font-size:12.5px}
em{font-style:normal;color:var(--mut)}.good{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.lede{font-size:13.5px;margin:12px 0 0}
</style></head><body>
<h1>Агент рекламы WB · ${esc(d)}</h1>
<p class="sub">Последний запуск ${esc(new Date(A.generated).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }))} мск · решения: ${A.engine === 'claude' ? 'Claude' : 'правила'} · ${R.planned ? 'режим проверки — в кабинете ничего не менялось' : 'изменения применены в кабинете'} · активных кампаний ${active}</p>
<div class="ks">${kpi('Закрыто', R.n('stop'), R.n('stop') ? 'bad' : '')}${kpi('Ставки ↓ / ↑', R.n('lower') + ' / ' + R.n('raise'))}${kpi('Новых РК', R.n('launch'), R.n('launch') ? 'good' : '')}${kpi('Пауза / вкл.', R.n('pause') + ' / ' + R.n('resume'))}${kpi('Экономия в день', R.saved > 0 ? rub(R.saved) : '—', R.saved > 0 ? 'good' : '')}${kpi('Работает РК', active)}</div>
<h2>Что сделано сегодня</h2>${acts.length ? acts.map(row).join('') : '<p class="m">Изменений не было: все кампании в пределах цели.</p>'}
${R.launched.length ? '<h2>Новые кампании агента</h2>' + launched : ''}
${R.errors.length ? '<p class="m bad">Не получилось: ' + R.errors.length + ' — агент повторит при следующем запуске.</p>' : ''}
</body></html>`;
}

async function tg(token, method, form) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(method + ': ' + (j.description || r.status));
  return j.result;
}
async function chatId(token) {
  const own = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (own) return { id: own, found: false };
  const ups = await tg(token, 'getUpdates', new URLSearchParams({ limit: '100' }));
  const m = ups.map((u) => u.message || u.my_chat_member || u.channel_post).filter(Boolean).pop();
  if (!m) throw new Error('Бот ещё не получил ни одного сообщения: откройте его в Telegram и нажмите «Старт»');
  return { id: String(m.chat.id), found: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const A = readJson('ads-agent.json', null);
  if (!A || !A.generated) { console.error('ads-agent.json не найден: агент ещё не запускался'); process.exit(1); }
  const R = dayReport(A), html = reportHtml(R);
  writeFileSync(new URL('./ads-report.html', import.meta.url), html);
  if (process.argv.includes('--html')) { console.log(messageText(R, 'wb')); console.log(); console.log(messageText(R, 'ozon')); console.log(); console.log(planText(A)); process.exit(0); }
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) { console.error('Нет секрета TELEGRAM_BOT_TOKEN'); process.exit(1); }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const shots = [];
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    const H = await page.evaluate(() => document.documentElement.scrollHeight), PART = 1100;
    for (let y = 0, i = 1; y < H; y += PART, i++) {
      await page.setViewportSize({ width: 480, height: Math.min(PART, H - y) });
      await page.evaluate((yy) => scrollTo(0, yy), y);
      shots.push(['report' + i + '.png', await page.screenshot()]);
      if (i >= 8) break;
    }
    // The agent block on the live dashboard, as the seller sees it
    try {
      const dash = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
      await dash.goto(DASH + '#rk', { waitUntil: 'networkidle', timeout: 60000 });
      const blk = dash.locator('[data-draw="rk-agent"]');
      await blk.waitFor({ state: 'visible', timeout: 30000 });
      shots.push(['dashboard.png', await blk.screenshot()]);
    } catch (e) { console.log('Скриншот дашборда не получился:', e.message); }
  } finally { await browser.close(); }

  const { id, found } = await chatId(token);
  for (const p of ['wb', 'ozon']) await tg(token, 'sendMessage', new URLSearchParams({ chat_id: id, text: messageText(R, p), parse_mode: 'HTML', disable_web_page_preview: 'true' }));
  const fd = new FormData();
  fd.append('chat_id', id);
  fd.append('media', JSON.stringify(shots.map(([name], i) => ({ type: 'photo', media: 'attach://' + name }))));
  shots.forEach(([name, buf]) => fd.append(name, new Blob([buf], { type: 'image/png' }), name));
  // Sent as photos; the long report is already split into screen-sized pieces, so it stays readable
  try { await tg(token, 'sendMediaGroup', fd); }
  catch (e) {
    console.log('Альбом не отправился (' + e.message + '), шлю по одному');
    for (const [name, buf] of shots) { const f = new FormData(); f.append('chat_id', id); f.append('photo', new Blob([buf], { type: 'image/png' }), name); await tg(token, 'sendPhoto', f); }
  }
  // The development plan with launch variants — a separate message, so the answer «запуск 1 3» goes right under it
  const plan = planText(A);
  if (plan) await tg(token, 'sendMessage', new URLSearchParams({ chat_id: id, text: plan, parse_mode: 'HTML', disable_web_page_preview: 'true' }));
  if (found) await tg(token, 'sendMessage', new URLSearchParams({ chat_id: id, text: 'Отчёт пришёл в этот чат. Чтобы он приходил сюда всегда, добавьте секрет TELEGRAM_CHAT_ID со значением ' + id + ' (GitHub → Settings → Secrets → Actions).' }));
  console.log('Отчёт отправлен:', shots.map(([n]) => n).join(', '));
}
