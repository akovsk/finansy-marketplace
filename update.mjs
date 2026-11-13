// Daily data refresh for the dashboard. Runs in GitHub Actions (Node 20+, no dependencies).
// Needs env TORGSTAT_SESSION = value of the "__Secure-next-auth.session-token" cookie from torgstat.ru.
// Writes data.json next to this file: daily rows per SKU from START to the last day with data.
import { writeFileSync, readFileSync } from 'node:fs';

const BASE = 'https://torgstat.ru';
const TOKEN = (process.env.TORGSTAT_SESSION || '').trim();
if (!TOKEN) { console.error('TORGSTAT_SESSION secret is empty'); process.exit(1); }
// The secret may hold just the cookie value or the whole "name=value" cookie string
const COOKIE = TOKEN.includes('=') ? TOKEN : '__Secure-next-auth.session-token=' + TOKEN;
const UA = 'Mozilla/5.0 (finansy-marketplace data refresh)';

const START = '2026-06-01';
const msk = new Date(Date.now() + 3 * 3600e3); // Moscow date
const END = msk.toISOString().slice(0, 10);
const D0 = Date.parse(START + 'T00:00:00Z');
const di = (s) => Math.round((Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') - D0) / 864e5);
const R = (x) => Math.round(+x || 0);

async function req(path, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie: COOKIE, 'content-type': 'application/json', 'user-agent': UA },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const t = await r.text();
      if (!r.ok) throw new Error(path + ' HTTP ' + r.status + ': ' + t.slice(0, 200));
      return JSON.parse(t);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log('retry', path, e.message);
      await new Promise((res) => setTimeout(res, 5000 * attempt));
    }
  }
}
async function trpc(p, b) {
  const j = await req('/api/trpc/' + p, b);
  const d = j && j.result && j.result.data && j.result.data.data;
  if (!d) throw new Error(p + ': unexpected answer ' + JSON.stringify(j).slice(0, 300));
  return d;
}

// Session check (this call also extends the Torgstat session for another 30 days)
const sess = await req('/api/auth/session');
if (!sess || !sess.user) {
  console.error('Torgstat session is not valid any more. Log in to torgstat.ru and put the new "__Secure-next-auth.session-token" cookie into the TORGSTAT_SESSION secret.');
  process.exit(1);
}
console.log('session ok, expires', sess.expires);

const WBM = ['SalesCount', 'ReturnsCount', 'OrdersTotal', 'GrossRevenueSeller', 'Commission', 'AcquiringFee', 'LogisticsTotalSum', 'StorageTotal', 'AcceptanceTotal', 'AdvTotal', 'PenaltiesSum', 'AdditionalPaymentsSum', 'PurchaseCost', 'Tax', 'NetProfit', 'OpenCardTotal', 'LostRevenue'];
const OM = ['Units', 'Returns', 'GrossRevenue', 'Commission', 'LogisticsTotal', 'StorageTotal', 'AdvTotal', 'PurchaseCost', 'Tax', 'NetProfit', 'LostRevenue'];
const stores = [
  { id: 'wb1', name: 'ВБ Саковский', mp: 'WB', api: 'wb', cid: 2517 },
  { id: 'wb2', name: 'Дармил', mp: 'WB', api: 'wb', cid: 7340 },
  { id: 'oz1', name: 'Озон Саковский', mp: 'Ozon', api: 'ozapi', cid: 1824 },
  { id: 'oz2', name: 'Suaviss Озон', mp: 'Ozon', api: 'ozapi', cid: 4542 },
  { id: 'ym1', name: 'Яндекс Саковский', mp: 'Яндекс', api: 'ymapi', cid: 850 },
];

const P = [];
let maxDay = 0;
const keep = (a) => a.slice(1).some((x) => x);
for (let si = 0; si < stores.length; si++) {
  const st = stores[si];
  const before = P.length;
  if (st.api === 'wb') {
    const d = await trpc('wbapi-goods-dynamics-v2', { connectionId: st.cid, advSource: 'upd-account-balance', brands: [], subjects: [], nms: [], dateFrom: START, dateTo: END, metrics: WBM, groupBy: 'nm', groupByPeriod: 'day', appliedFilters: {} });
    d.rows.filter((r) => r.NmId).forEach((r) => {
      const days = (r.NumLog || []).map(([dt, v]) => [di(dt), R(v.SalesCount), R(v.ReturnsCount), R(v.GrossRevenueSeller), R((+v.Commission || 0) + (+v.AcquiringFee || 0)), R(v.LogisticsTotalSum), R(v.StorageTotal), R(v.AdvTotal), R(v.PurchaseCost), R(v.Tax), R(v.NetProfit), R(v.LostRevenue)]).filter(keep);
      if (!days.length) return;
      days.forEach((a) => { if (a[0] > maxDay) maxDay = a[0]; });
      P.push({ s: si, sku: String(r.NmId), a: r.SaName || '', n: r.Name || '', c: r.SubjectName || '', b: r.BrandName || '', u: 'https://www.wildberries.ru/catalog/' + r.NmId + '/detail.aspx', d: days });
    });
  } else {
    const ym = st.api === 'ymapi';
    const d = await trpc(st.api + '-goods-dynamics', { connectionId: st.cid, brands: [], subjects: [], nms: [], dateFrom: START, dateTo: END, startDateFrom: START, startDateTo: END, metrics: ym ? OM.filter((m) => m !== 'Commission') : OM, groupBy: 'sku', groupByPeriod: 'day', appliedFilters: {} });
    d.rows.filter((r) => r.GroupKey).forEach((r) => {
      const days = (r.NumLog || []).map(([dt, v]) => {
        const rev = +v.GrossRevenue || 0, np = +v.NetProfit || 0;
        let comm = +v.Commission || 0;
        if (ym) comm = np - (rev + (+v.LogisticsTotal || 0) + (+v.StorageTotal || 0) + (+v.AdvTotal || 0) + (+v.PurchaseCost || 0) + (+v.Tax || 0));
        return [di(dt), R(v.Units), R(v.Returns), R(rev), R(comm), R(v.LogisticsTotal), R(v.StorageTotal), R(v.AdvTotal), R(v.PurchaseCost), R(v.Tax), R(np), R(v.LostRevenue)];
      }).filter(keep);
      if (!days.length) return;
      days.forEach((a) => { if (a[0] > maxDay) maxDay = a[0]; });
      P.push({ s: si, sku: String(ym ? r.ShopSKU : r.Sku), a: ym ? (r.ShopSKU || '') : (r.OfferId || ''), n: r.Name || r.ModelName || r.ShopSKU || '', c: r.TypeName || r.CategoryName || '', b: r.Brand || r.Vendor || '', u: ym ? (((r.ShowcaseUrls || [])[0] || {}).showcaseUrl || '') : ('https://www.ozon.ru/product/' + r.Sku), d: days });
    });
  }
  console.log(st.id, P.length - before, 'SKU');
}

// Safety: never replace good data with an obviously broken export
let old = null;
try { old = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8')); } catch (e) { /* first run */ }
if (old && P.length < old.products.length * 0.7) {
  console.error('Only ' + P.length + ' SKU vs ' + old.products.length + ' before, keeping old data.json');
  process.exit(1);
}

const end = new Date(D0 + maxDay * 864e5).toISOString().slice(0, 10);
const DATA = { generated: new Date().toISOString(), start: START, end, stores: stores.map(({ id, name, mp }) => ({ id, name, mp })), cols: ['day', 'q', 'ret', 'rev', 'comm', 'log', 'stor', 'adv', 'cogs', 'tax', 'np', 'lost'], products: P };
writeFileSync(new URL('./data.json', import.meta.url), JSON.stringify(DATA));
console.log(P.length + ' SKU, ' + P.reduce((s, p) => s + p.d.length, 0) + ' rows, data up to ' + end);
