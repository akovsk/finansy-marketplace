// Daily Telegram report of the WB ads agent: what it closed, launched and re-bid today, with screenshots.
// node ads-report.mjs            — render and send (needs TELEGRAM_BOT_TOKEN, playwright with chromium)
// node ads-report.mjs --html     — only write ads-report.html (to check the layout locally)
// Chat: TELEGRAM_CHAT_ID; without it the chat is taken from the last message sent to the bot (write /start to it).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  const saved = acts.filter((a) => a.action === 'stop' && a.result !== 'error').reduce((s, a) => s + ((byId.get(a.id) || {}).spend30 || 0) / 30, 0);
  const launched = hist.filter((a) => a.action === 'launch' && a.result === 'ok').map((a) => ({ a, c: byId.get(a.id) }));
  return { today, planned, acts, errors, saved, launched, n, A };
}

// "196519290 TANTI_Prokladki_Ultra_SL_8х2 G" → "TANTI Prokladki Ultra SL 8х2"
export const cleanName = (s) => String(s || '').replace(/^(СРС|CPC|АРК|АУК)\s+/i, '').replace(/^\d{5,}\s*/, '').replace(/_/g, ' ').replace(/\s+[A-Z]$/, '').replace(/\s+/g, ' ').trim();
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

// Telegram message (HTML), up to ~3500 chars
export function messageText(R) {
  const { n, A } = R, d = new Date(R.today + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const byId = new Map((A.campaigns || []).map((c) => [c.id, c]));
  const active = (A.campaigns || []).filter((c) => c.status === 9).length;
  const L = ['<b>Реклама WB · ' + d + '</b>' + (R.planned ? '\n<i>Режим проверки: в кабинете ничего не менялось</i>' : ''), ''];
  const ok = R.acts.filter((a) => a.result !== 'error');
  if (!ok.length) L.push('Сегодня всё в порядке, менять ничего не пришлось.');
  if (n('stop')) L.push('❌ Закрыто убыточных кампаний: <b>' + n('stop') + '</b>' + (R.saved > 0 ? '\n     экономия ≈ <b>' + rub(R.saved) + ' в день</b> (≈ ' + rub(R.saved * 30) + ' в месяц)' : ''));
  if (n('pause')) L.push('⏸ На паузу (кончается товар): <b>' + n('pause') + '</b>');
  if (n('lower')) L.push('↘️ Снижена ставка: <b>' + n('lower') + '</b>');
  if (n('raise')) L.push('↗️ Повышена ставка: <b>' + n('raise') + '</b>');
  if (n('resume')) L.push('▶️ Включено снова: <b>' + n('resume') + '</b>');
  L.push('🚀 Новых кампаний: <b>' + n('launch') + '</b>' + (n('launch') ? '' : ' — пока нет товара, на котором реклама будет в плюсе'));
  L.push('📈 Сейчас работает кампаний: <b>' + active + '</b>');
  if (R.launched.length) {
    const plus = R.launched.filter(({ c }) => c && c.drr30 != null && c.margin != null && c.drr30 < c.margin).length;
    L.push('🧪 Кампании, запущенные агентом: ' + R.launched.length + ', в плюсе ' + plus);
  }
  if (ok.length) {
    L.push('', '<b>Что и почему</b>');
    const order = ['launch', 'stop', 'pause', 'lower', 'raise', 'resume', 'topup'];
    const list = ok.slice().sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || ((byId.get(b.id) || {}).spend30 || 0) - ((byId.get(a.id) || {}).spend30 || 0));
    const MAX = 12;
    list.slice(0, MAX).forEach((a) => {
      const k = (ACT[a.action] || [a.action])[0];
      L.push('• <a href="' + WB_ADS_URL(a.id) + '">' + esc(cleanName(a.name) || 'арт. ' + a.sku) + '</a> — ' + k.toLowerCase() + ': ' + esc(why(a, byId.get(a.id))));
    });
    if (list.length > MAX) L.push('…и ещё ' + (list.length - MAX) + ' ' + plural(list.length - MAX, 'действие', 'действия', 'действий') + ' — на картинке');
  }
  if (R.errors.length) L.push('', '⚠️ Не получилось: ' + R.errors.length + ' ' + plural(R.errors.length, 'действие', 'действия', 'действий') + ' — WB отказал, агент повторит при следующем запуске.');
  L.push('', '<a href="' + DASH + '#rk">Открыть рекламу на дашборде</a>');
  return L.join('\n');
}
export const captionText = (R) => messageText(R).replace(/<[^>]+>/g, '');

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
  if (process.argv.includes('--html')) { console.log(messageText(R)); process.exit(0); }
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) { console.error('Нет секрета TELEGRAM_BOT_TOKEN'); process.exit(1); }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const shots = [];
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    shots.push(['report.png', await page.screenshot({ fullPage: true })]);
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
  await tg(token, 'sendMessage', new URLSearchParams({ chat_id: id, text: messageText(R), parse_mode: 'HTML', disable_web_page_preview: 'true' }));
  const fd = new FormData();
  fd.append('chat_id', id);
  fd.append('media', JSON.stringify(shots.map(([name], i) => ({ type: 'document', media: 'attach://' + name }))));
  shots.forEach(([name, buf]) => fd.append(name, new Blob([buf], { type: 'image/png' }), name));
  // Sent as files, not photos: Telegram shrinks tall photos until the text is unreadable
  try { await tg(token, 'sendMediaGroup', fd); }
  catch (e) {
    console.log('Альбом не отправился (' + e.message + '), шлю по одному');
    for (const [name, buf] of shots) { const f = new FormData(); f.append('chat_id', id); f.append('document', new Blob([buf], { type: 'image/png' }), name); await tg(token, 'sendDocument', f); }
  }
  if (found) await tg(token, 'sendMessage', new URLSearchParams({ chat_id: id, text: 'Отчёт пришёл в этот чат. Чтобы он приходил сюда всегда, добавьте секрет TELEGRAM_CHAT_ID со значением ' + id + ' (GitHub → Settings → Secrets → Actions).' }));
  console.log('Отчёт отправлен:', shots.map(([n]) => n).join(', '));
}
