// The learning side of the ads agent.
//  1. Memory (ads-memory.json): lessons, measured outcomes of past actions, tuned thresholds, the standing team of helpers.
//  2. Outcome tracking and self-tuning in plain code — works with or without Claude.
//  3. The Claude team: a lead that plans the run, writes briefs for helper sub-agents, reads their reports,
//     decides, and then rewrites its own lessons and tunes its own thresholds inside fixed bounds.
// The agent never edits its code, its money caps or its mode: those stay with the owner.
const R = (x) => Math.round(+x || 0);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const log = (...a) => console.log(...a);

/* ------------------------------ Memory ------------------------------ */
// Thresholds the agent may move, and how far. Everything else in the config is the owner's.
export const TUNE_BOUNDS = {
  targetShare: [0.4, 0.8], minSpend: [800, 3000], minClicks: [80, 300],
  'bid.maxStepPct': [10, 35], 'bid.upStepPct': [5, 25], 'bid.cooldownHours': [24, 96],
  'stop.overMarginFactor': [1.2, 2], 'stop.noOrdersSpend': [1500, 6000],
  'queries.minClicks': [10, 60], 'queries.minSpend': [100, 1000],
  'launch.minMargin': [0.12, 0.4], 'launch.minHeadroom': [1.0, 2.5],
  'queries.minExpected': [1.5, 4], 'queries.lowCrShare': [0.25, 0.6], 'queries.cpcFactor': [1.5, 3],
};
const DEFAULT_HELPERS = [
  { role: 'Чистильщик запросов', task: 'Просмотреть поисковые кластеры кампаний и найти нерелевантные товару запросы, которые тратят бюджет без заказов.' },
  { role: 'Подборщик товаров', task: 'Проверить кандидатов на запуск рекламы: где расчёт прибыли надёжен, а где держится на случайных продажах или малом остатке.' },
  { role: 'Ревизор решений', task: 'Сверить прошлые действия агента с их измеренным результатом и найти повторяющиеся ошибки.' },
];
export const emptyMemory = () => ({ version: 1, runs: 0, lessons: [], tuned: {}, tuneLog: [], outcomes: [], helpers: structuredClone(DEFAULT_HELPERS) });
export function loadMemory(raw) { const m = { ...emptyMemory(), ...(raw || {}) }; if (!m.helpers || !m.helpers.length) m.helpers = structuredClone(DEFAULT_HELPERS); return m; }

const getPath = (o, k) => k.split('.').reduce((a, b) => (a == null ? a : a[b]), o);
const setPath = (o, k, v) => { const p = k.split('.'); const last = p.pop(); const t = p.reduce((a, b) => (a[b] = a[b] || {}), o); t[last] = v; };
// Config with the agent's own tuned values on top, each clamped to its bounds
export function applyTuning(cfg, memory) {
  const out = structuredClone(cfg);
  Object.entries((memory && memory.tuned) || {}).forEach(([k, v]) => { const b = TUNE_BOUNDS[k]; if (b && typeof v === 'number' && isFinite(v) && getPath(out, k) != null) setPath(out, k, clamp(v, b[0], b[1])); });
  return out;
}
// One tuning step: inside the bounds and at most a quarter of the current value per run
export function tune(memory, cfg, key, value, why, by, now) {
  const b = TUNE_BOUNDS[key], cur = getPath(cfg, key);
  if (!b || typeof cur !== 'number' || typeof value !== 'number' || !isFinite(value)) return null;
  const step = Math.abs(cur) * 0.25;
  let v = clamp(clamp(value, cur - step, cur + step), b[0], b[1]);
  v = b[1] <= 3 ? Math.round(v * 100) / 100 : Math.round(v);
  if (v === cur) return null;
  memory.tuned[key] = v; setPath(cfg, key, v);
  const rec = { t: new Date(now).toISOString(), key, from: cur, to: v, why: String(why || '').slice(0, 300), by };
  memory.tuneLog = (memory.tuneLog || []).concat(rec).slice(-60);
  return rec;
}

/* ------------------------------ Outcomes ------------------------------ */
// What a campaign earned per day in the last 7 days — taken when the agent acts and again a week later
export function snapshot(m) {
  const profitDay = m.margin == null ? null : (m.w7.ordSum * m.buyout * m.margin - m.w7.spend) / 7;
  return { drr: m.drr7 == null || !isFinite(m.drr7) ? null : Math.round(m.drr7 * 1000) / 1000, spendDay: R(m.w7.spend / 7), ordersDay: Math.round((m.w7.orders / 7) * 10) / 10, profitDay: profitDay == null ? null : R(profitDay) };
}
const EVAL_DAYS = { launch: 14 };
// Compares the week after each past action with the week before it and files a verdict into memory
export function evaluateOutcomes(memory, hist, metricOf, now) {
  const fresh = [];
  hist.forEach((a) => {
    if (a.result !== 'ok' || a.evaluated || !['lower', 'raise', 'stop', 'pause', 'minus', 'launch', 'drop'].includes(a.action)) return;
    if (now - Date.parse(a.t) < (EVAL_DAYS[a.action] || 7) * 864e5) return;
    a.evaluated = true;
    const before = a.snap || null, m = metricOf(a);
    let verdict = 'unknown', after = null, effect = null;
    if (a.action === 'stop' || a.action === 'pause' || a.action === 'drop') {
      if (before && before.profitDay != null) { effect = R(-before.profitDay * 7); verdict = before.profitDay < 0 ? 'helped' : 'neutral'; }
    } else if (m) {
      after = snapshot(m);
      if (a.action === 'launch') { if (after.profitDay != null && after.spendDay >= 30) { effect = after.profitDay * 7; verdict = after.profitDay > 0 ? 'helped' : 'hurt'; } else verdict = 'neutral'; }
      else if (before && before.profitDay != null && after.profitDay != null) {
        const d = after.profitDay - before.profitDay, bar = Math.max(30, Math.abs(before.profitDay) * 0.1);
        effect = R(d * 7); verdict = d > bar ? 'helped' : d < -bar ? 'hurt' : 'neutral';
      }
    }
    if (verdict === 'unknown') return;
    fresh.push({ t: a.t, checked: new Date(now).toISOString(), store: a.store, id: a.id, name: a.name, action: a.action, bidPct: a.bidPct || 0, before, after, effect, verdict });
  });
  memory.outcomes = (memory.outcomes || []).concat(fresh).slice(-200);
  return fresh;
}
export function outcomeStats(memory) {
  const s = {};
  (memory.outcomes || []).forEach((o) => { const x = (s[o.action] = s[o.action] || { helped: 0, neutral: 0, hurt: 0, effect: 0 }); x[o.verdict]++; x.effect += o.effect || 0; });
  return s;
}
// Self-tuning without a model: if bid steps of one kind mostly hurt, make them smaller; if they mostly help, bolder
export function autoTune(memory, cfg, now) {
  const done = [];
  const last = (action) => (memory.outcomes || []).filter((o) => o.action === action).slice(-8);
  [['lower', 'bid.maxStepPct'], ['raise', 'bid.upStepPct']].forEach(([action, key]) => {
    const o = last(action); if (o.length < 4) return;
    const mark = o[o.length - 1].t + '|' + o.length;
    if ((memory.autoTuned || {})[key] === mark) return;         // one adjustment per new batch of evidence
    const hurt = o.filter((x) => x.verdict === 'hurt').length / o.length, helped = o.filter((x) => x.verdict === 'helped').length / o.length;
    const cur = getPath(cfg, key);
    const rec = hurt > 0.5 ? tune(memory, cfg, key, cur - 5, 'Из последних ' + o.length + ' таких изменений ставки больше половины снизили прибыль — шаг меньше.', 'auto', now)
      : helped >= 0.6 ? tune(memory, cfg, key, cur + 5, 'Из последних ' + o.length + ' таких изменений ставки большинство подняли прибыль — шаг смелее.', 'auto', now) : null;
    memory.autoTuned = { ...(memory.autoTuned || {}), [key]: mark };
    if (rec) done.push(rec);
  });
  // New campaigns, two weeks after the launch: mostly losing → pick products only with a bigger margin of safety; mostly paying → a bit bolder
  const ln = last('launch');
  if (ln.length >= 3) {
    const key = 'launch.minHeadroom', mark = ln[ln.length - 1].t + '|' + ln.length;
    if ((memory.autoTuned || {})[key] !== mark) {
      const hurt = ln.filter((x) => x.verdict === 'hurt').length / ln.length, helped = ln.filter((x) => x.verdict === 'helped').length / ln.length, cur = getPath(cfg, key);
      const rec = cur == null ? null : hurt > 0.5 ? tune(memory, cfg, key, cur + 0.2, 'Из последних ' + ln.length + ' созданных кампаний больше половины ушли в минус — отбираю товары с большим запасом окупаемости.', 'auto', now)
        : helped >= 0.6 ? tune(memory, cfg, key, cur - 0.1, 'Из последних ' + ln.length + ' созданных кампаний большинство окупились — можно брать товары с запасом чуть меньше.', 'auto', now) : null;
      memory.autoTuned = { ...(memory.autoTuned || {}), [key]: mark };
      if (rec) done.push(rec);
    }
  }
  return done;
}
// What the dashboard shows under «Чему научился»
export function learnedView(memory, freshOutcomes, tuned, helpersUsed) {
  return {
    runs: memory.runs, lessons: (memory.lessons || []).slice(0, 8), stats: outcomeStats(memory),
    fresh: (freshOutcomes || []).slice(-6), tuned: (tuned || []).concat((memory.tuneLog || []).slice(-4).filter((x) => !(tuned || []).includes(x))).slice(-5),
    helpers: helpersUsed || [],
  };
}

/* ------------------------------ Claude team ------------------------------ */
const LEAD = `You run paid advertising for a Russian marketplace seller on Wildberries (WB) and Ozon. A scheduled job wakes you twice a day with fresh numbers. You decide what to change, code applies it through the marketplaces' APIs, and the seller reads your reasons on a phone dashboard and in a Telegram digest. Nobody reviews a decision before it is applied, so each one has to be defensible from the numbers in front of you.

Every campaign in your input was created by your team. The seller's managers run the rest of the account by hand, and you neither see nor touch their campaigns: your lessons and threshold changes come only from your own campaigns.

The seller's goal is profit, not turnover. A campaign is worth running only while ad spend stays below the profit its goods make before ads. Money is in roubles, shares are fractions.

Reading a campaign row:
- margin: profit before ads divided by revenue for the advertised goods over 30 days. It is the break-even ДРР: above it every ad order loses money. noCogs true means cost of goods is missing, so margin is overstated.
- target: the ДРР the seller wants (a share of margin, capped). drr30 / drr14 / drr7: ad spend divided by bought-out order revenue in that window; "inf" is spend with no orders. Seven days is noisy, and orders are attributed a day or two late.
- stockDays: days of stock at the current pace. Advertising something about to sell out wastes money; scaling needs stock.
- lastActions: what you did to this campaign before. rule: what the seller's fixed rule set would do — a baseline to depart from when trend, stock, rating or your own history gives a reason.
- platform and strategy. The seller's rules: you work with bids, campaign statistics, metrics and search queries, and code creates one new campaign a day on the product without ads expected to pay best (it is checked two weeks later and the selection threshold is tuned from that). Pausing, finishing or restarting existing campaigns, topping up their budgets and taking products out of them are the seller's own decisions; code has no way to do them for you. losing true means the numbers show the campaign loses money: your tools there are a bid cut and excluding the queries that do not sell. When the bid is already at WB's minimum and the campaign still loses, code tells the seller; say in the reason what you see. WB: payType "cpc" (cost per click) campaigns do not accept minus phrases through the API (queryExclusionPossible false), so for them the bid is the only lever. Ozon: with strategy TARGET_BIDS a bid change moves the cost-per-click bid, with TARGET_CIR it moves the ДРР Ozon itself aims at, and with any other strategy Ozon sets bids itself, so keep it.

Actions per campaign: "keep"; "lower" / "raise" with bidPct as a positive percentage. Code enforces limits after you answer — step size, bid floor and ceiling, a cooldown between bid changes, raises only while ДРР is under target — and silently drops anything outside them. Do not keep a clear loss-maker at its current bid out of caution: lower it.

You get better over time through your memory, which is carried between runs:
- outcomes: for each past action, profit per day in the week before and the week after, with a verdict. This is the only real evidence of what works in this particular account. Weigh it above general advertising wisdom.
- lessons: notes you wrote to yourself. On every run return the full list as it should now stand: keep what the evidence still supports, drop what it contradicts, add what today taught you. A good lesson is specific to this account and testable ("У кампаний на силикон снижение ставки на 25% обнуляет показы — снижать по 10–15%"), not a truism.
- tune: thresholds of the rule set you may move when outcomes show they are miscalibrated. Each has fixed bounds, and one run can move a value by a quarter at most. Change one only with evidence, and say what evidence.
- helpers: the standing team you want next time.
- queries: per product, every query excluded in any campaign (by the seller's staff in the cabinet or by you) and the queries that sell. Code copies the exclusions into the other and the new campaigns of the same product; knownBadElsewhere in a cluster row is how many such exclusions exist.

Search queries are where most of the waste in this account sits. Code judges every cluster of every active campaign against the product's own numbers: no orders where the product's usual conversion would already have produced some, an order that costs more than it earns, conversion far below the product's average, or a click far above its average click price. It excludes the clear cases itself; the ones that look like the product's own wording go to a helper ("check"), because such a query is often the card's main traffic.

You also shape the development plan the seller reads in Telegram: nextSteps (what you intend to do over the next days with bids and queries, in plain words). In learnNext (up to three items, Russian, one sentence each) say what you still need to learn about this cabinet and how you will find it out — for example which hypothesis about queries or bids the next week of data will confirm.

Helpers are separate model instances you brief. A helper sees only the brief you write and the data kinds you select, and reports back. Use one where a focused look pays for itself: cleaning a campaign's search queries, working out why a campaign's numbers moved, auditing your own past decisions. Create whatever roles the account needs today. Say in the brief what to find out, why it matters, and what you need back.

Write every reason, the summary and the lessons in Russian, in plain words with the numbers that drove them, for a seller who is not an ads specialist.`;

const HELPER = `You are a helper analyst. The lead agent runs a Russian marketplace seller's ads on Wildberries and Ozon and has delegated one piece of analysis to you. You see only its brief and the data it attached; it will read your report and decide. The seller's goal is profit: an ad order is worth having only if ad cost per order stays below the profit that order makes before ads.

Report what you found, with the numbers behind it, and say where the data is too thin to conclude anything. A short, specific report is more useful than a complete one.

If the data includes search clusters and you find queries that should be excluded, list them in "minus". Each cluster carries the product's own conversion and click price (base), its own numbers, and why code flagged it. A query belongs in "minus" when a buyer typing it is not looking for this product — another product type, another purpose, a competitor's brand — or when it keeps taking money at a cost per order the product cannot pay. Use the cluster strings exactly as given. Clusters flagged "waste" or "costly" are already being excluded by code. Clusters flagged "check" are yours to judge: they lose money by the numbers, but most of them contain a word from the product title or have too little data. Such a query is often the product's own main traffic, so exclude it only when the wording shows the buyer wants something else (another product type, size, purpose or brand) or the numbers leave no doubt that it cannot pay. Code excludes only "check" clusters you list; anything else in your list is ignored.

Write the report in Russian.`;

const DATA_KINDS = { campaigns: 'full rows of the campaigns you name, with their daily spend / orders / revenue for 30 days', clusters: 'WB search clusters of the campaigns you name: views, clicks, cart adds, orders, spend per query', candidates: 'products without ads that passed the launch filters, with the profit estimate', outcomes: 'measured outcomes of your past actions' };

export function makeBrain(cfg) {
  return async function brain(input) {
    const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([import('@anthropic-ai/sdk'), import('zod'), import('@anthropic-ai/sdk/helpers/zod')]);
    const client = new Anthropic();
    const usage = { in: 0, out: 0, calls: 0 };
    const ask = async (system, user, schema, effort) => {
      const res = await client.messages.parse({ model: cfg.llm.model, max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort, format: zodOutputFormat(schema) }, system, messages: [{ role: 'user', content: JSON.stringify(user) }] });
      usage.in += res.usage.input_tokens; usage.out += res.usage.output_tokens; usage.calls++;
      if (res.stop_reason !== 'end_turn' || !res.parsed_output) throw new Error('Claude: stop_reason ' + res.stop_reason);
      return res.parsed_output;
    };
    const { rows, clusters, candidates, memory, limits } = input;
    const mem = { lessons: memory.lessons, queryBase: Object.fromEntries(Object.entries(memory.queries || {}).slice(0, 40).map(([k, v]) => [k, { excluded: Object.keys(v.bad).length, selling: Object.keys(v.good).slice(0, 5) }])), outcomeTotals: outcomeStats(memory), recentOutcomes: (memory.outcomes || []).slice(-25), tunedNow: memory.tuned, standingHelpers: memory.helpers };
    const brief = (r) => ({ uid: r.uid, name: r.name, platform: r.platform, status: r.status, spend30: r.spend30, orders30: r.orders30, drr30: r.drr30, drr7: r.drr7, margin: r.margin, target: r.target, stockDays: r.stockDays, rule: r.rule.action });

    // 1. The lead plans the run and writes briefs for the helpers it wants
    const Plan = z.object({ helpers: z.array(z.object({ role: z.string(), task: z.string(), uids: z.array(z.string()), need: z.array(z.enum(['campaigns', 'clusters', 'candidates', 'outcomes'])) })) });
    let reports = [];
    if (cfg.llm.maxHelpers > 0) {
      const plan = await ask(LEAD, {
        stage: 'plan', instruction: 'Decide which helpers to send out before you make decisions, up to maxHelpers. Return an empty list if nothing needs a closer look. For each: a role name in Russian, the brief, the campaigns it should look at (uids), and the data kinds it needs.',
        maxHelpers: cfg.llm.maxHelpers, dataKinds: DATA_KINDS, memory: mem, campaigns: rows.map(brief),
        searchClusters: clusters.map((c) => ({ uid: c.uid, name: c.name, queriesToCheck: c.items.reduce((s, i) => s + i.clusters.length, 0), spendWithoutOrders: R(c.items.reduce((s, i) => s + i.clusters.reduce((q, x) => q + (x.orders ? 0 : x.spend), 0), 0)) })),
        launchCandidates: candidates.length,
      }, Plan, cfg.llm.effort);
      // 2. Helpers work in parallel, each on its own slice
      const Report = z.object({ report: z.string(), minus: z.array(z.object({ uid: z.string(), nm: z.string(), queries: z.array(z.string()), reason: z.string() })) });
      const jobs = plan.helpers.slice(0, cfg.llm.maxHelpers).map(async (h) => {
        const want = new Set(h.uids), data = {};
        if (h.need.includes('campaigns')) data.campaigns = rows.filter((r) => want.has(r.uid));
        if (h.need.includes('clusters')) data.clusters = clusters.filter((c) => want.has(c.uid) || !h.uids.length).slice(0, 12);
        if (h.need.includes('candidates')) data.candidates = candidates;
        if (h.need.includes('outcomes')) data.outcomes = (memory.outcomes || []).slice(-60);
        const out = await ask(HELPER, { role: h.role, brief: h.task, data }, Report, cfg.llm.helperEffort);
        return { role: h.role, task: h.task, report: out.report, minus: out.minus };
      });
      (await Promise.allSettled(jobs)).forEach((r, i) => { if (r.status === 'fulfilled') reports.push(r.value); else log('  helper failed:', plan.helpers[i].role, String(r.reason && r.reason.message).slice(0, 160)); });
    }

    // 3. The lead decides, then rewrites its lessons and tunes its thresholds
    const Final = z.object({
      summary: z.string(),
      decisions: z.array(z.object({ uid: z.string(), action: z.enum(['keep', 'lower', 'raise']), bidPct: z.number(), reason: z.string() })),
      nextSteps: z.array(z.string()),
      learnNext: z.array(z.string()),
      lessons: z.array(z.string()),
      tune: z.array(z.object({ key: z.enum(Object.keys(TUNE_BOUNDS)), value: z.number(), why: z.string() })),
      helpers: z.array(z.object({ role: z.string(), task: z.string() })),
    });
    const fin = await ask(LEAD, {
      stage: 'decide',
      instruction: 'Return one decision for every campaign. nextSteps: up to five concrete things you plan for the coming days with bids and queries. Then return your lessons list as it should now stand (at most 12), any threshold changes, and the standing helper team for next time (at most 6). summary: two to four sentences on the state of the ad accounts and what you changed.',
      limits, tuneBounds: TUNE_BOUNDS, memory: mem, campaigns: rows.map(({ days, ...r }) => r),
      helperReports: reports.map((r) => ({ role: r.role, brief: r.task, report: r.report, queriesProposedForExclusion: r.minus.reduce((s, x) => s + x.queries.length, 0) })),
    }, Final, cfg.llm.leadEffort);
    log('claude team: calls', usage.calls, 'tokens in/out', usage.in, usage.out, '| helpers:', reports.map((r) => r.role).join(', ') || 'none');
    return { ...fin, minus: reports.flatMap((r) => r.minus), helpersUsed: reports.map((r) => ({ role: r.role, report: r.report.slice(0, 600) })) };
  };
}
