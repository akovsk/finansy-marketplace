// Development plan for the ad cabinet: what was done, what comes next, and numbered launch variants
// the owner approves in Telegram ("запуск 1 3"); the next agent run carries them out.
import { kbBad, kbGood } from './ads-queries.mjs';
const R = (x) => Math.round(+x || 0);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rub = (x) => R(x).toLocaleString('ru-RU') + ' ₽';
const pct = (x) => (x == null || !isFinite(x) ? '—' : Math.round(x * 100) + '%');
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const cleanName = (s) => String(s || '').replace(/^(СРС|CPC|АРК|АУК|AI)\s+/i, '').replace(/^\d{5,}\s*/, '').replace(/_/g, ' ').replace(/\s+[A-Z]$/, '').replace(/\s+/g, ' ').trim();

// What a campaign would have earned in the last 30 days without the queries the agent excludes.
// Costly queries take their orders with them (at the campaign's average order value).
export function cleanedEconomics(view, spend, orders, ordSum, buyout, margin) {
  const bad = view.items.flatMap((i) => i.clusters.filter((c) => c.flag === 'waste' || c.flag === 'costly' || c.flag === 'check'));
  const badSpend = bad.reduce((s, c) => s + c.spend, 0), badOrders = bad.reduce((s, c) => s + c.orders, 0);
  const perOrder = orders ? ordSum / orders : 0;
  const s2 = Math.max(0, spend - badSpend), o2 = Math.max(0, orders - badOrders), sum2 = o2 * perOrder;
  const drr = sum2 > 0 ? s2 / (sum2 * buyout) : null;
  return { badSpend: R(badSpend), badN: bad.length, spend: R(s2), orders: o2, drr, profitMonth: margin == null ? null : R(sum2 * buyout * margin - s2) };
}

// Variants worth launching. Only ones the numbers say will be in profit.
//   restart  — a campaign the agent paused for loss: same campaign (its queries are kept), cleaned, cheaper bid
//   recreate — a campaign closed earlier: a new one for the same product with every excluded query carried over
//   new      — a profitable product without ads
export function buildVariants({ views, pool, metrics, memory, cfg, archiveInfo = {}, skipped = [] }) {
  const out = [];
  const byUid = new Map(metrics.map((m) => [m.uid, m]));
  views.filter((v) => v.kind === 'paused' || v.kind === 'archive').forEach((v) => {
    const m = byUid.get(v.uid), a = archiveInfo[v.m.id];
    const base = m ? { spend: m.w30.spend, orders: m.w30.orders, ordSum: m.w30.ordSum, buyout: m.buyout, margin: m.margin, target: m.target } : a;
    // Why a paused or closed campaign is not offered: the seller should see that it was weighed, not forgotten
    const skip = (why) => skipped.push({ kind: v.kind, id: v.m.id, name: v.name, why, kept: v.items.reduce((s, i) => s + kbBad(memory, i.key).length, 0) });
    if (!base || base.margin == null) return skip('нет данных о прибыли товара');
    if (base.margin <= 0.02) return skip('товар убыточен ещё до рекламы (маржа ' + pct(base.margin) + ')');
    if (!base.orders) return skip('за 30 дней не было заказов с рекламы');
    const e = cleanedEconomics(v, base.spend, base.orders, base.ordSum, base.buyout || 0.9, base.margin);
    if (e.drr == null || e.drr >= base.margin * 0.85 || !(e.profitMonth > 0)) return skip('даже без плохих запросов ДРР ' + pct(e.drr) + ' при марже ' + pct(base.margin));
    const target = base.target || Math.min(cfg.maxDrr, cfg.targetShare * base.margin);
    const bidPct = e.drr > target ? -clamp(Math.round((1 - target / e.drr) * 100), 5, cfg.bid.maxStepPct) : 0;
    // a restart keeps the campaign's own minus phrases; only the ones from other campaigns are new to it
    const transfer = v.items.reduce((s, i) => s + kbBad(memory, i.key).filter((q) => v.kind === 'archive' || !i.existing.includes(q)).length, 0);
    out.push({
      kind: v.kind === 'paused' ? 'restart' : 'recreate', store: v.m.store, id: v.m.id, name: v.name, key: v.items[0].key, skus: v.items.map((i) => String(i.nm)),
      bidPct, budget: cfg.plan.budget, minus: e.badN, transfer, drr: e.drr, margin: base.margin, profitMonth: e.profitMonth, savedMonth: e.badSpend,
      good: v.items.flatMap((i) => i.good.slice(0, 3).map((c) => c.q)).slice(0, 4),
      why: (v.kind === 'paused' ? 'Без ' : 'В новой кампании без ') + e.badN + ' ' + plural(e.badN, 'плохого запроса', 'плохих запросов', 'плохих запросов') + ' (' + rub(e.badSpend) + ' за 30 дней) ДРР был бы ' + pct(e.drr) + ' при марже ' + pct(base.margin) + (bidPct ? ', ставка ' + bidPct + '%' : '') + '.',
    });
  });
  pool.forEach((c) => {
    if (c.platform === 'ozon' || c.per1000 == null || c.per1000 <= 0) return;   // Ozon launches stay with ozon.launch for now
    const spendMonth = cfg.plan.budget * 4;
    out.push({ kind: 'new', store: c.store, platform: c.platform, sku: String(c.sku), key: c.key, name: c.name, budget: cfg.plan.budget, transfer: kbBad(memory, c.key).length, good: kbGood(memory, c.key).slice(0, 3).map((x) => x.q),
      margin: c.margin, drr: null, profitMonth: R((c.per1000 * spendMonth) / 1000), savedMonth: 0,
      why: 'Без рекламы, маржа ' + pct(c.margin) + ', запас на ' + c.stockDays + ' дн. Клик ~' + c.cpc + ' ₽, конверсия ' + (c.cr * 100).toFixed(1).replace('.', ',') + '% — на 1000 ₽ рекламы ~' + rub(c.per1000) + ' прибыли сверху.' });
  });
  return out.sort((a, b) => b.profitMonth - a.profitMonth).slice(0, cfg.plan.maxVariants).map((v, i) => ({ n: i + 1, ...v }));
}

// "запуск 1 3", "запусти 2", "да 1,2", "все" → numbers; only the owner's chat, only after the plan was made
export function parseApprovals(updates, chatId, sinceIso) {
  const since = Date.parse(sinceIso || 0) / 1000, nums = new Set();
  let all = false, last = 0, seen = false;
  (updates || []).forEach((u) => {
    last = Math.max(last, u.update_id || 0);
    const m = u.message; if (!m || String(m.chat && m.chat.id) !== String(chatId) || (m.date || 0) < since) return;
    const t = String(m.text || '').toLowerCase().trim();
    if (!/^(\/?запуск|\/?запусти|да|ок|ok|go|\/?go|запускай|все|всё)/.test(t)) return;
    seen = true;
    if (/(^|\s)(все|всё)(\s|$)/.test(t)) all = true;
    (t.match(/\d+/g) || []).forEach((x) => nums.add(+x));
  });
  return { nums: [...nums], all, last, seen };
}

/* ------------------------------ Telegram ------------------------------ */
export async function tg(token, method, params) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', body: params instanceof FormData ? params : new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(method + ': ' + (j.description || r.status));
  return j.result;
}

/* ------------------------------ The plan message ------------------------------ */
const KIND = { restart: '▶️ Перезапуск', recreate: '♻️ Новая РК вместо закрытой', new: '🆕 Новая РК' };
const k = (x) => (Math.abs(x) >= 1000 ? (Math.round(x / 100) / 10).toString().replace('.', ',') + 'к' : String(R(x)));
// Short, plain Telegram text (HTML): done in 24 h → next steps → variants with the answer to send
export function planText(A) {
  const P = A.plan;
  if (!P) return '';
  const L = ['🧭 <b>План по рекламному кабинету</b>', ''];
  const d = P.done || {};
  const done = [d.closed && '✂️ закрыто (до перехода на паузы) — ' + d.closed, d.paused && '⏸ на паузу из-за минуса — ' + d.paused, d.lower && '🎯 ставок снижено — ' + d.lower, d.raise && '📈 ставок поднято — ' + d.raise,
    d.minus && '🧹 плохих запросов исключено — ' + d.minus, d.transfer && '🔁 исключений перенесено из других РК — ' + d.transfer, d.launch && '🚀 запущено — ' + d.launch, d.resume && '▶️ включено — ' + d.resume].filter(Boolean);
  L.push('<b>Сделано за сутки</b>');
  L.push(...(done.length ? done.map((x) => '▫️ ' + x) : ['▫️ изменений не понадобилось']));
  if (d.savedDay > 0) L.push('💸 экономия ~' + k(d.savedDay) + ' ₽/день');
  if ((P.next || []).length) { L.push('', '<b>Что дальше</b>'); P.next.slice(0, 5).forEach((x) => L.push('▫️ ' + esc(x))); }
  const V = P.variants || [];
  if (V.length) {
    L.push('', '<b>Варианты запуска</b>');
    V.forEach((v) => {
      L.push('', '<b>' + v.n + '. ' + KIND[v.kind] + '</b> — ' + esc(cleanName(v.name) || 'арт. ' + v.sku));
      L.push(esc(v.why));
      const extra = [v.transfer ? 'перенесу ' + v.transfer + ' ' + plural(v.transfer, 'исключённый запрос', 'исключённых запроса', 'исключённых запросов') + ' из других РК' : '', v.good && v.good.length ? 'продают: ' + v.good.slice(0, 2).map((q) => '«' + q + '»').join(', ') : ''].filter(Boolean);
      if (extra.length) L.push('<i>' + esc(extra.join(' · ')) + '</i>');
      L.push('Бюджет ' + rub(v.budget) + ' · ждём <b>+' + k(v.profitMonth) + ' ₽/мес</b>' + (v.note ? '\n💬 ' + esc(v.note) : ''));
    });
    L.push('', '👉 Ответьте <b>запуск ' + (V.length > 1 ? '1 ' + V[1].n : '1') + '</b> (номера вариантов)' + (V.length > 1 ? ' или <b>запуск все</b>' : '') + ' — сделаю на следующей проверке.');
  } else L.push('', '💡 Вариантов запуска в плюс сейчас нет — проверю завтра.');
  return L.join('\n').slice(0, 4000);
}
