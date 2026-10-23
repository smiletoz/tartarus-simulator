/* Tartarus Simulator: the Frozen Canvas solver.
 * Rules-based play with no AI. The goal is a Lv7 Treasure Chest; on a canvas
 * without a chest (or once it's Lv7), as many rainbow (Lv7) paints as
 * possible. Two parts:
 *  - A strategy that makes every choice from what the player can see: where
 *    the chest goes (the cell with the most room on its lines), which paint
 *    goes where, which brushstroke to take, where each Coloring Paint lands,
 *    and when to force an objective.
 *  - A Monte Carlo check: each candidate move is played out many times from
 *    the current canvas, with the strategy making every later choice and
 *    everything random re-rolled (Coloring Paints, brushstrokes, re-rolled
 *    paints). Moves are ranked by the chest's worth at the end.
 * Runs in the page and under Node. */
(function (root) {
  'use strict';

  const C = root.TartarusCanvas || (typeof require === 'function' ? require('./canvas-engine.js') : null);
  const { rangeCells, isChest, matches, MAX_LEVEL } = C;
  const LINES = ['row', 'col', 'diag', 'adj'];

  // ---------- What the strategy looks at ----------

  const blank = (st, n) => st.cells[n].kind === 'blank' && !st.cells[n].paint;
  const open = (st, cells) => cells.filter((n) => blank(st, n)).length;

  // The chest that matters: the highest one on the canvas below Lv7.
  function chestCell(st) {
    let best = -1;
    for (const n of C.chests(st)) if (best < 0 || st.cells[n].paint.level > st.cells[best].paint.level) best = n;
    return best;
  }

  const chestInHand = (st) => st.inventory.findIndex((p) => isChest(p));

  // Room around a cell: blank cells on each of its lines, capped where more
  // stops helping, so a cell with room in every direction wins.
  function room(st, n, skip) {
    let sum = 0;
    for (const line of LINES) {
      const free = rangeCells(n, line).filter((m) => m !== skip && blank(st, m)).length;
      sum += Math.min(free, line === 'adj' ? 3 : 4) + (free > 0 ? 1 : 0);
    }
    return sum;
  }

  // Cells on the chest's lines: placing filler there costs it room.
  function chestLines(st, c) {
    const set = new Set();
    if (c < 0) return set;
    for (const line of LINES) for (const n of rangeCells(c, line)) set.add(n);
    return set;
  }

  // Would an objective with this shape at `at` raise the chest at `c`?
  const reaches = (st, at, o, c) => c >= 0 && at !== c && matches(st.cells[c].paint, o.target) && rangeCells(at, o.range).includes(c);

  // Whether the objective can still be met by placing paints: progress so far
  // plus the blank cells left in range, against what it needs.
  function feasible(st, o, at, extraBlankUsed) {
    const cells = rangeCells(at, o.range);
    const have = cells.filter((n) => matches(st.cells[n].paint, o.target)).length;
    const free = cells.filter((n) => n !== extraBlankUsed && blank(st, n)).length;
    return { have, free, slack: have + free - o.need };
  }

  // The paint to spend: the lowest one of the wanted kind, never the chest.
  function spare(st, target) {
    let best = -1;
    st.inventory.forEach((p, i) => {
      if (isChest(p) || (target && !matches(p, target))) return;
      if (best < 0 || p.level < st.inventory[best].level) best = i;
    });
    return best;
  }

  // Paints in hand that an objective's target takes, never the chest.
  const stock = (st, target) => st.inventory.filter((p) => !isChest(p) && matches(p, target)).length;

  // How close a paint is to a rainbow: raising it is worth the change in this.
  const POT = [0, 0, 0.01, 0.03, 0.08, 0.2, 0.45, 1];

  // What meeting an objective with this shape at `at` adds toward rainbows.
  function rangeGain(st, at, o) {
    const gain = o.gain + (o.extras.includes('plusOne') ? 1 : 0);
    let sum = 0;
    for (const n of rangeCells(at, o.range)) {
      const p = st.cells[n].paint;
      if (p && matches(p, o.target)) sum += POT[Math.min(MAX_LEVEL, p.level + gain)] - POT[p.level];
    }
    return sum;
  }

  // Forcing breaks 1 random paint on the canvas, so it's a gamble: the chest
  // goes with odds 1 in (paints on the canvas).
  const FORCE_MIN = 6; // paints on the canvas before forcing risks the chest (the lab's best: 4 to 10 are close)
  const painted = (st) => st.cells.filter((c) => c.kind === 'blank' && c.paint).length;
  // What a random break costs toward rainbows, on average.
  function breakLoss(st) {
    const list = st.cells.filter((c) => c.kind === 'blank' && c.paint);
    return list.length ? list.reduce((s, c) => s + POT[c.paint.level], 0) / list.length : 0;
  }

  // ---------- The strategy ----------

  function decide(st) {
    if (st.phase === 'done') return null;
    if (st.phase === 'offer') return decideOffer(st);
    return decidePaint(st);
  }

  function decidePaint(st) {
    const blanks = C.blankCells(st);
    if (!blanks.length || !st.inventory.length) return null;
    const c = chestCell(st);
    const o = st.active;
    // A chest in hand goes on the board first: in the objective's range if
    // that raises it, otherwise where it has the most room.
    const hand = chestInHand(st);
    if (hand >= 0) {
      let cell = -1;
      let best = -Infinity;
      for (const n of blanks) {
        let s = room(st, n, -1);
        if (o && rangeCells(o.cell, o.range).includes(n) && matches(st.inventory[hand], o.target)) s += 6;
        if (s > best) {
          best = s;
          cell = n;
        }
      }
      return { type: 'place', inv: hand, cell };
    }
    const lines = chestLines(st, c);
    const chestLive = c >= 0 && st.cells[c].paint.level < MAX_LEVEL;
    if (!chestLive) return rainbowPaint(st, blanks, o);
    if (o) {
      const inRange = rangeCells(o.cell, o.range).filter((n) => blank(st, n));
      const left = o.need - C.progress(st);
      const helps = chestLive && reaches(st, o.cell, o, c);
      if (inRange.length >= left && left > 0) {
        // Meet it: matching paints in range, off the chest's lines when the
        // objective doesn't feed the chest.
        const inv = spare(st, o.target);
        if (inv >= 0) {
          const cells = helps ? inRange : inRange.slice().sort((a, b) => lines.has(a) - lines.has(b));
          return { type: 'place', inv, cell: cells[0] };
        }
      } else if (left > 0 && chestLive && st.forced < st.params.forcedMax) {
        // Stuck: force it when it would feed the chest, or to get a new
        // Coloring Paint while the chest still has room to grow, once enough
        // paints are down that the break is unlikely to hit the chest.
        if ((helps || open(st, [...lines]) >= 3) && painted(st) >= FORCE_MIN) return { type: 'force' };
      }
    }
    // Filler: away from the chest's lines, and off the active range so it
    // doesn't eat cells the objective needs.
    const active = o ? new Set(rangeCells(o.cell, o.range)) : new Set();
    const cells = blanks.slice().sort((a, b) => (lines.has(a) - lines.has(b)) || (active.has(a) - active.has(b)));
    const inv = spare(st, o ? (o.target === 'monster' ? 'gameplay' : o.target === 'gameplay' ? 'monster' : null) : null);
    return { type: 'place', inv: inv >= 0 ? inv : spare(st, null) >= 0 ? spare(st, null) : 0, cell: cells[0] };
  }

  // No chest to raise: meet objectives that lift high paints, and force one
  // that's stuck when it would push paints toward Lv7 by more than the break
  // costs. Never with a Lv7 chest on the canvas: the break could take it.
  function rainbowPaint(st, blanks, o) {
    if (o) {
      const inRange = rangeCells(o.cell, o.range).filter((n) => blank(st, n));
      const left = o.need - C.progress(st);
      if (left > 0 && inRange.length >= left) {
        const inv = spare(st, o.target);
        if (inv >= 0) return { type: 'place', inv, cell: inRange[0] };
      } else if (left > 0 && st.forced < st.params.forcedMax && !C.chests(st).length && rangeGain(st, o.cell, o) - breakLoss(st) >= 0.4) {
        return { type: 'force' };
      }
    }
    const active = o ? new Set(rangeCells(o.cell, o.range)) : new Set();
    const cells = blanks.slice().sort((a, b) => active.has(a) - active.has(b));
    const inv = spare(st, null);
    return { type: 'place', inv: inv >= 0 ? inv : 0, cell: cells[0] };
  }

  // Brushstrokes and where the new Coloring Paint goes. Every choice is
  // judged by where it would let the Coloring Paint land: the score of the
  // best cell it could go on, after the effect.
  function decideOffer(st) {
    const f = st.offer;
    const memo = new Map(); // shapes already scored in this decision
    if (f.stage === 'direction') {
      const values = new Map(f.directions.map((dir) => [dir, directionValue(st, dir, memo)]));
      const rank = (dir) => values.get(dir);
      const best = f.directions.slice().sort((x, y) => rank(y) - rank(x))[0];
      if (rank(best) < 0 && st.refreshes > 0) return { type: 'refresh' }; // every way it goes, its objective can't be met
      return { type: 'direction', dir: best };
    }
    if (f.stage === 'effect') {
      const values = new Map(f.effects.map((id) => [id, effectValue(st, id, memo)]));
      const rank = (id) => values.get(id);
      const best = f.effects.slice().sort((x, y) => rank(y) - rank(x))[0];
      if (rank(best) < 0 && st.refreshes > 0) return { type: 'refresh' };
      return { type: 'effect', id: best };
    }
    const c = chestCell(st);
    const chestLive = c >= 0 && st.cells[c].paint.level < MAX_LEVEL;
    return { type: 'coloring', cell: bestPlacement(st, f.coloring, f.placeOn, c, chestLive).cell };
  }

  // What a blank cell is worth: each objective spends one on its Coloring
  // Paint and more on its paints.
  const CELL = 15;

  // Where a Coloring Paint can go with this placeOn (as the engine allows).
  function targetsFor(st, placeOn) {
    const out = [];
    st.cells.forEach((c, n) => {
      if (c.kind === 'blank' && !c.paint) out.push(n);
      else if (placeOn === 'void' && c.kind === 'void') out.push(n);
      else if (placeOn === 'blocked' && c.kind === 'blocked') out.push(n);
      else if (placeOn === 'broken' && c.kind === 'broken') out.push(n);
      else if (placeOn === 'painted' && c.kind === 'blank' && c.paint && !c.anchor) out.push(n);
    });
    return out;
  }

  // How good a cell is for this Coloring Paint.
  function placementScore(st, o, at, c, chestLive, lines, inHand) {
    const fz = feasible(st, o, at, at);
    // An objective that can't be met ends the chain of Coloring Paints, so
    // that outweighs everything else. Met the moment it lands is best: the
    // next Coloring Paint comes without spending a cell.
    const short = Math.max(0, o.need - fz.have);
    const can = fz.slack >= 0 && inHand >= short;
    let s = (can ? 200 : -200) + Math.min(fz.slack, 3) * 2 + (short === 0 ? 60 : -8 * short);
    const gain = o.gain + (o.extras.includes('plusOne') ? 1 : 0);
    const range = rangeCells(at, o.range);
    const hitsChest = c >= 0 && range.includes(c);
    if (chestLive && can && reaches(st, at, o, c)) s += 70 + 30 * gain;
    if (chestLive && can && hitsChest && o.extras.includes('randomOne')) s += 30 / Math.max(2, range.filter((n) => st.cells[n].paint).length + short);
    if (!chestLive) s += 40 * rangeGain(st, at, o) + (o.extras.includes('randomOne') ? 5 : 0);
    if (o.extras.includes('sameContent')) s += 5;
    if (o.extras.includes('reroll')) {
      if (hitsChest) s -= 1000;
      if (!chestLive && c < 0) s += range.filter((n) => st.cells[n].paint && !st.cells[n].anchor).length;
    }
    const cell = st.cells[at];
    const old = cell.paint;
    if (cell.kind === 'void') {
      s += CELL; // it leaves a blank cell free for a paint
      if (o.paint && isChest(o.paint)) s -= 200; // but a chest placed there is gone
    } else if (cell.kind === 'blocked' || cell.kind === 'broken') {
      s += CELL; // it uses up an ice or broken cell instead of a blank one
    } else if (old) {
      // Painting over: a blank cell stays free, but the old paint is gone.
      s += CELL - (isChest(old) ? 1000 : chestLive ? 3 * old.level : 40 * POT[old.level] + old.level);
    } else if (lines.has(at)) s -= 3; // it takes a cell the chest could use
    return s;
  }

  function bestPlacement(st, o, placeOn, c, chestLive, chestLineSet) {
    const lines = chestLineSet || chestLines(st, c);
    const inHand = stock(st, o.target);
    let best = { cell: -1, score: -Infinity };
    for (const at of targetsFor(st, placeOn)) {
      const score = placementScore(st, o, at, c, chestLive, lines, inHand);
      if (score > best.score) best = { cell: at, score };
    }
    return best;
  }

  // The best cell's score for a Coloring Paint shaped this way.
  function shapeValue(st, o, placeOn, memo) {
    const key = memo && `${o.range}|${o.target}|${o.need}|${o.gain}|${o.extras.join(',')}|${placeOn}`;
    if (memo && memo.has(key)) return memo.get(key);
    const v = shapeScore(st, o, placeOn, memo);
    if (memo) memo.set(key, v);
    return v;
  }

  function shapeScore(st, o, placeOn, memo) {
    // The chest and its lines are the same for every shape in a decision.
    let ctx = memo && memo.get('ctx');
    if (!ctx) {
      const c = chestCell(st);
      ctx = { c, chestLive: c >= 0 && st.cells[c].paint.level < MAX_LEVEL, lines: chestLines(st, c) };
      if (memo) memo.set('ctx', ctx);
    }
    const b = bestPlacement(st, o, placeOn, ctx.c, ctx.chestLive, ctx.lines);
    return b.cell < 0 ? -300 : b.score;
  }

  // An effect's worth: the Coloring Paint's best cell after it. Random
  // effects (a new range, a new Coloring Paint) are averaged over what they
  // could give.
  function effectValue(st, id, memo) {
    const f = st.offer;
    const o = f.coloring;
    const P = st.params;
    const shape = (patch) => Object.assign({}, o, patch);
    const value = (x, placeOn) => shapeValue(st, x, placeOn || f.placeOn, memo);
    const weighted = (weights, fn) => {
      let sum = 0;
      let total = 0;
      for (const [k, w] of Object.entries(weights)) {
        if (w <= 0) continue;
        sum += w * fn(k);
        total += w;
      }
      return total ? sum / total : value(o);
    };
    switch (id) {
      case 'flip': return value(shape({ target: o.target === 'monster' ? 'gameplay' : 'monster' }));
      case 'needDown': return value(shape({ need: Math.max(1, o.need - 1) }));
      case 'reRange': return weighted(Object.fromEntries(Object.entries(P.rangeWeights).filter(([k]) => k !== o.range)), (r) => value(shape({ range: r })));
      case 'renew': return weighted(P.rangeWeights, (r) => weighted(P.targetWeights, (t) => value(shape({ range: r, target: t, need: P.needByLevel[2], extras: [] }))));
      case 'relevel': return value(o) + 1;
      case 'onVoid': return value(o, 'void');
      case 'onBlocked': return value(o, 'blocked');
      case 'onPainted': return value(o, 'painted');
      case 'onBroken': return value(o, 'broken');
      case 'iceRow':
      case 'iceCol':
      case 'iceAdj':
      case 'voidNear':
      case 'repair': return value(o) + 0.7 * CELL; // a cell opens, if one is near where it lands
      case 'plusOne':
      case 'randomOne':
      case 'sameContent':
      case 'reroll': return value(shape({ extras: o.extras.concat([id]) }));
      default: return value(o);
    }
  }

  // A direction's worth: the better of the 2 effects it would offer, on
  // average over the pairs it could deal.
  function directionValue(st, dir, memo) {
    const o = st.offer.coloring;
    const pool = C.EFFECT_IDS.filter((id) => C.EFFECTS[id].dir === dir && C.usable(st, id, o)).map((id) => effectValue(st, id, memo));
    if (!pool.length) return shapeValue(st, o, st.offer.placeOn, memo);
    if (pool.length === 1) return pool[0];
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      sum += Math.max(pool[i], pool[j]);
      pairs += 1;
    }
    return sum / pairs;
  }

  // ---------- Playing ----------

  function apply(st, a) {
    switch (a.type) {
      case 'place': return C.place(st, a.inv, a.cell);
      case 'force': return C.force(st);
      case 'reset': return C.reset(st);
      case 'refresh': return C.refresh(st);
      case 'direction': return C.chooseDirection(st, a.dir);
      case 'effect': return C.chooseEffect(st, a.id);
      case 'coloring': return C.placeColoring(st, a.cell);
      default: return { ok: false, reason: 'Unknown move.' };
    }
  }

  // Plays a canvas to the end with the strategy.
  function playout(st, limit) {
    for (let i = 0; i < (limit || 400) && st.phase !== 'done'; i++) {
      const a = decide(st);
      if (!a) {
        C.finish(st);
        break;
      }
      const r = apply(st, a);
      if (!r.ok) {
        C.finish(st);
        break;
      }
    }
    return st;
  }

  // ---------- The Monte Carlo check ----------

  const sameAction = (a, b) => !!a && !!b && a.type === b.type && a.inv === b.inv && a.cell === b.cell && a.dir === b.dir && a.id === b.id;

  // The moves worth comparing, with labels.
  function candidates(st) {
    const out = [];
    if (st.phase === 'done') return out;
    const label = (n) => C.cellLabel(n);
    if (st.phase === 'offer') {
      const f = st.offer;
      if (f.stage === 'direction') {
        for (const dir of f.directions) out.push({ action: { type: 'direction', dir }, label: `Take ${C.DIRECTIONS[dir].name}` });
        if (st.refreshes > 0) out.push({ action: { type: 'refresh' }, label: 'Refresh the directions' });
      } else if (f.stage === 'effect') {
        for (const id of f.effects) out.push({ action: { type: 'effect', id }, label: C.EFFECTS[id].text });
        if (st.refreshes > 0) out.push({ action: { type: 'refresh' }, label: 'Refresh the effects' });
      } else {
        for (const n of C.placeTargets(st)) out.push({ action: { type: 'coloring', cell: n }, label: `Place the Coloring Paint on ${label(n)}` });
      }
      return out;
    }
    const blanks = C.blankCells(st);
    const hand = chestInHand(st);
    if (hand >= 0) {
      for (const n of blanks) out.push({ action: { type: 'place', inv: hand, cell: n }, label: `Treasure Chest on ${label(n)}` });
      return out;
    }
    // One paint of each class, the lowest: other paints' levels don't matter.
    const kinds = ['gameplay', 'monster'].map((cls) => ({ cls, inv: spare(st, cls) })).filter((k) => k.inv >= 0);
    for (const k of kinds) for (const n of blanks) out.push({ action: { type: 'place', inv: k.inv, cell: n }, label: `${k.cls === 'gameplay' ? 'Gameplay' : 'Monster'} paint on ${label(n)}` });
    if (st.active && st.forced < st.params.forcedMax) out.push({ action: { type: 'force' }, label: `Force the objective (${st.params.forcedCost[Math.min(st.forced, st.params.forcedCost.length - 1)]} Colored Snow)` });
    if (st.start && (C.chests(st).length || hand >= 0)) out.push({ action: { type: 'reset' }, label: `Start over (${st.params.redrawCost} Colored Snow)` });
    return out;
  }

  // A seeded generator for playouts.
  function rng32(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Plays every candidate out `rollouts` times. Returns a job that advances a
  // few rounds per step, so a page can show it as it goes.
  function solve(st, opts) {
    const o = opts || {};
    const rollouts = o.rollouts || 300;
    const random = rng32(o.seed || 1);
    const base = C.clone(st);
    const pick = decide(base);
    const options = candidates(base).map((c) => ({ ...c, policy: sameAction(c.action, pick), n: 0, sum: 0, sum2: 0, lv7: 0, levels: 0, rainbows: 0 }));
    let rounds = 0;
    return {
      step(batch) {
        for (let b = 0; b < (batch || 10) && rounds < rollouts; b++, rounds++) {
          const seed = (random() * 4294967296) >>> 0;
          for (const opt of options) {
            const s = C.clone(base);
            s.rng = seed; // same future for every option: a fair comparison
            const r = apply(s, opt.action);
            if (!r.ok) continue;
            playout(s);
            const v = C.score(s);
            const lv = C.bestChest(s);
            opt.n += 1;
            opt.sum += v;
            opt.sum2 += v * v;
            opt.levels += lv;
            opt.rainbows += C.rainbows(s);
            if (lv >= MAX_LEVEL) opt.lv7 += 1;
          }
        }
        return result();
      },
    };
    function result() {
      const ranked = options.filter((x) => x.n).map((x) => {
        const mean = x.sum / x.n;
        const sd = Math.sqrt(Math.max(0, x.sum2 / x.n - mean * mean));
        return { action: x.action, label: x.label, policy: x.policy, n: x.n, mean, se: sd / Math.sqrt(x.n), lv7: x.lv7 / x.n, level: x.levels / x.n, rainbows: x.rainbows / x.n };
      }).sort((a, b) => b.mean - a.mean || b.lv7 - a.lv7);
      return { options: ranked, rounds, done: rounds >= rollouts, pick };
    }
  }

  // Why the strategy picks a move, in a sentence.
  function reason(st, a) {
    if (!a) return '';
    if (a.type === 'reset') return 'This attempt is unlikely to reach a Lv7 chest. Starting over gets the same canvas and paints back, with new Coloring Paints and brushstrokes to come.';
    const c = chestCell(st);
    const chestLive = c >= 0 && st.cells[c].paint.level < MAX_LEVEL;
    if (!chestLive && chestInHand(st) < 0) {
      // No chest to raise: rainbows.
      switch (a.type) {
        case 'place': return st.active && rangeCells(st.active.cell, st.active.range).includes(a.cell) ? 'No chest here, so rainbows are the goal: finish this objective to lift the paints in its range.' : 'Filler, off the objective’s range so it keeps its cells.';
        case 'force': return 'The objective is stuck, and meeting it pushes high paints toward Lv7: worth the Colored Snow and the paint it breaks.';
        case 'direction': return a.dir === 'stack' ? 'Layer adds to this objective’s lift: best when its range holds high paints.' : a.dir === 'turn' ? 'Reimagine can point this objective at better paints: switch its type or its direction.' : 'Spread opens room for objectives to finish.';
        case 'effect': return `${C.EFFECTS[a.id].text}.`;
        case 'coloring': return 'From here its objective lifts the most high paints toward Lv7, with room to finish.';
        default: return '';
      }
    }
    switch (a.type) {
      case 'place': {
        const p = st.inventory[a.inv];
        if (isChest(p)) return 'Put the Treasure Chest where its row, column, diagonals and neighbors have the most open cells, so later objectives can reach it.';
        if (st.active && rangeCells(st.active.cell, st.active.range).includes(a.cell) && matches(p, st.active.target)) {
          return c >= 0 && reaches(st, st.active.cell, st.active, c) ? 'This objective raises the chest: fill its range with matching paint.' : 'Finish this objective quickly, off the chest’s lines, to get the next Coloring Paint.';
        }
        return 'Filler, away from the chest’s lines so they stay open for objectives that can raise it.';
      }
      case 'force': return 'The objective is stuck: forcing it costs Colored Snow and breaks 1 random paint, but with this many paints down the chest is rarely the one.';
      case 'refresh': return 'Neither option helps the chest: re-roll them.';
      case 'direction':
        return a.dir === 'stack' ? 'Layer adds to the next objective’s effect: worth it when that objective can reach the chest.' : a.dir === 'turn' ? 'Reimagine can fix the objective: switch a monster target to gameplay, or change its range.' : 'Spread opens room: ice or void cells turn blank, or the paint can go on a painted cell.';
      case 'effect': return C.EFFECTS[a.id].text + '.';
      case 'coloring': return c >= 0 && reaches(st, a.cell, st.offer.coloring, c) ? 'From here its objective reaches the chest, with room to finish it.' : 'Here it can be finished fast without crowding the chest.';
      default: return '';
    }
  }

  const api = { decide, apply, playout, candidates, solve, reason, sameAction, chestCell, room };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TartarusCanvasSolver = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
