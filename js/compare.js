// Pairwise comparisons and the ranking derived from them (spec §3, §5.5).
//
// Modelled on Gwern's resorter. The premise is his: people cannot give
// consistent absolute ratings on a 0–10 scale, but "which of these was worth
// more?" is an easy question, and a ranking can be inferred from noisy answers
// to it. The comparisons are the stored record; the ranking is recomputed from
// them every time it is shown and is never written to the file.
//
// This brings back Bradley-Terry, which §4 retired — but only for texts already
// read. The objection there was to extrapolating a fitted model to texts nobody
// has read. Nothing here predicts anything.

import { todayISO, nextSubItemId } from './model.js';

/**
 * One axis only. Absolute value is the one retrospective judgement gets better
 * at over time; relative value is tied to a project state you no longer occupy
 * by the time you compare, so old answers about it would be stale on arrival.
 */
export const DIMENSION = 'value_abs';

/** Resorter's default budget: noisy sorting needs about n·log n answers. */
export function suggestedTotal(n) {
  return n < 2 ? 0 : Math.round(n * Math.log(n) + 1);
}

export function newComparison(existing, winnerId, loserId, tie = false) {
  const c = {
    id: nextSubItemId(existing || [], 'c'),
    dimension: DIMENSION,
    winner_id: winnerId,
    loser_id: loserId,
    date: todayISO(),
  };
  // A tie keeps the winner/loser shape so every entry reads the same way; the
  // order of the two ids carries no meaning when it is set.
  if (tie) c.tie = true;
  return c;
}

/**
 * Fit Bradley-Terry strengths by minorisation-maximisation (Hunter 2004).
 *
 * Ties count as half a win to each side, as resorter and BradleyTerry2 do.
 *
 * Every text also plays one virtual game against a fixed reference of strength
 * 1 and splits it. Without that a text that has only ever won has no finite
 * estimate, and one never compared has none at all; with it, an unseen text
 * sits at the middle and a lopsided record moves it firmly but not to infinity.
 * The reference also fixes the scale, so no renormalisation is needed.
 *
 * @returns {{ items: Array<{id, ability, se, games, wins}>, used: number }}
 *   items sorted strongest first; `ability` is log-strength, `se` its standard
 *   error from the observed information.
 */
export function fitBT(ids, comparisons, { iterations = 500, tol = 1e-8 } = {}) {
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const wins = new Float64Array(n).fill(0.5);
  const games = new Float64Array(n);
  const pairCounts = new Map();
  let used = 0;

  for (const c of comparisons || []) {
    if (c.dimension !== DIMENSION) continue;
    const a = index.get(c.winner_id);
    const b = index.get(c.loser_id);
    if (a == null || b == null || a === b) continue;
    if (c.tie) { wins[a] += 0.5; wins[b] += 0.5; } else { wins[a] += 1; }
    games[a] += 1; games[b] += 1;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    used += 1;
  }
  const pairs = [...pairCounts].map(([k, count]) => {
    const [i, j] = k.split(',').map(Number);
    return [i, j, count];
  });

  let p = new Float64Array(n).fill(1);
  for (let it = 0; it < iterations; it++) {
    const denom = new Float64Array(n);
    for (let i = 0; i < n; i++) denom[i] = 1 / (p[i] + 1);
    for (const [i, j, count] of pairs) {
      const d = count / (p[i] + p[j]);
      denom[i] += d;
      denom[j] += d;
    }
    let delta = 0;
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      next[i] = wins[i] / denom[i];
      delta = Math.max(delta, Math.abs(Math.log(next[i]) - Math.log(p[i])));
    }
    p = next;
    if (delta < tol) break;
  }

  const info = new Float64Array(n);
  for (let i = 0; i < n; i++) info[i] = p[i] / ((p[i] + 1) ** 2);
  for (const [i, j, count] of pairs) {
    const v = count * p[i] * p[j] / ((p[i] + p[j]) ** 2);
    info[i] += v;
    info[j] += v;
  }

  const items = ids.map((id, i) => ({
    id,
    ability: Math.log(p[i]),
    se: 1 / Math.sqrt(info[i]),
    games: games[i],
    wins: wins[i] - 0.5,
  })).sort((x, y) => y.ability - x.ability);
  return { items, used };
}

/**
 * Where each text sits, as "top X%". Rank-based rather than scaled from the
 * ability, because the reader asked for positions, not a number that pretends
 * to be absolute.
 */
export function percentiles(fit) {
  const n = fit.items.length;
  const out = new Map();
  fit.items.forEach((it, rank) => {
    out.set(it.id, { rank: rank + 1, of: n, top: n > 1 ? Math.max(1, Math.round(((rank + 1) / n) * 100)) : 100 });
  });
  return out;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Choose the next pair to ask about — resorter's heuristic, adapted.
 *
 * Texts never compared come first, since one answer about them is worth far
 * more than a tenth about anything else. After that, every third question
 * anchors on the least certain text and the rest on a random one, which is
 * resorter's guard against greedy selection settling into a loop. The anchor is
 * paired with whichever neighbour in the current order is less certain, so the
 * question lands where the ranking is actually undecided.
 *
 * @param {Set<string>} avoid pair keys asked recently, not to be repeated
 */
export function nextPair(fit, { round = 0, avoid = new Set(), rng = Math.random } = {}) {
  const order = fit.items;
  const n = order.length;
  if (n < 2) return null;

  const pickNeighbour = (i) => {
    const cands = [i - 1, i + 1].filter(j => j >= 0 && j < n)
      .filter(j => !avoid.has(pairKey(order[i].id, order[j].id)))
      .sort((x, y) => order[y].se - order[x].se);
    return cands.length ? cands[0] : null;
  };

  const unseen = order.map((it, i) => (it.games === 0 ? i : -1)).filter(i => i >= 0);
  let anchors;
  if (unseen.length) {
    anchors = shuffle(unseen, rng);
  } else if (round % 3 === 0) {
    anchors = order.map((_, i) => i).sort((x, y) => order[y].se - order[x].se);
  } else {
    anchors = shuffle(order.map((_, i) => i), rng);
  }

  for (const i of anchors) {
    const j = pickNeighbour(i);
    if (j != null) return rng() < 0.5 ? [order[i].id, order[j].id] : [order[j].id, order[i].id];
  }
  // Every neighbouring pair was asked recently: fall back to any unasked pair.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!avoid.has(pairKey(order[i].id, order[j].id))) return [order[i].id, order[j].id];
    }
  }
  return null;
}

export { pairKey };

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The audit (§4, step 5): how often the evaluator's standing scores agree with
 * the reader's answers. Only pairs where both texts carry a predicted absolute
 * value that differs can agree or disagree; ties are left out.
 */
export function agreement(comparisons, byId) {
  let agree = 0;
  const disagreements = [];
  for (const c of comparisons || []) {
    if (c.dimension !== DIMENSION || c.tie) continue;
    const w = byId.get(c.winner_id);
    const l = byId.get(c.loser_id);
    const pw = w && w.predicted && w.predicted.value_abs;
    const pl = l && l.predicted && l.predicted.value_abs;
    if (pw == null || pl == null || pw === pl) continue;
    if (pw > pl) agree += 1; else disagreements.push({ comparison: c, winner: w, loser: l });
  }
  return { n: agree + disagreements.length, agree, disagreements };
}

/**
 * Spearman correlation between the fitted order and the predicted absolute
 * values, over texts that have both. Order against order, so neither side needs
 * to agree on what a 7 means. Null below five texts, where it says nothing.
 */
export function rankCorrelation(fit, byId) {
  const rows = fit.items
    .map(it => ({ ability: it.ability, pred: (byId.get(it.id)?.predicted || {}).value_abs }))
    .filter(r => r.pred != null);
  if (rows.length < 5) return null;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    for (let k = 0; k < idx.length;) {
      let m = k;
      while (m + 1 < idx.length && idx[m + 1][0] === idx[k][0]) m++;
      const avg = (k + m) / 2 + 1;
      for (let t = k; t <= m; t++) r[idx[t][1]] = avg;
      k = m + 1;
    }
    return r;
  };
  const ra = rank(rows.map(r => r.ability));
  const rp = rank(rows.map(r => r.pred));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const ma = mean(ra), mp = mean(rp);
  let num = 0, da = 0, dp = 0;
  for (let i = 0; i < rows.length; i++) {
    num += (ra[i] - ma) * (rp[i] - mp);
    da += (ra[i] - ma) ** 2;
    dp += (rp[i] - mp) ** 2;
  }
  return { rho: da && dp ? num / Math.sqrt(da * dp) : 0, n: rows.length };
}
