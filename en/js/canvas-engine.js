/* Tartarus Simulator: the Frozen Canvas engine.
 * The painting stage of Torchlight: Infinite's Frozen Canvas (画中雪原), as
 * reworked in SS7 and still in the game in SS14. A 6x6 canvas of blank, ice
 * (blocked) and void cells. The player places paints from an inventory; the
 * active Coloring Paint's objective counts matching paints in its range, and
 * once it has enough, every matching paint in range rises a few levels (to 7
 * at most). Then a new Coloring Paint comes, shaped by a brushstroke the
 * player picks, and goes on the canvas. The goal is the chest: the Treasure
 * Chest paint's level when the canvas is full, with Lv7 the prize. Without a
 * chest, the goal is as many rainbow (Lv7) paints as possible.
 * Rules come from the game's texts and gameplay footage; the odds the game
 * hides are practice values, adjustable in DEFAULT_PARAMS. No DOM, so it also
 * runs under Node. */
(function (root) {
  'use strict';

  const VERSION = 2;
  const SIZE = 6;
  const CELLS = SIZE * SIZE;
  const MAX_LEVEL = 7;

  const MONSTERS = ['Ratlin', 'Dwarf', 'Agito', 'Pest', 'Dragonbone', 'Aember', 'Test Subject', 'Gang', 'Ichi', 'Sand Monster', 'Eumbra', 'Einherjar', 'Ghost'];
  const GAMEPLAY = ['Survival', 'God of Machines', 'God of Might', 'Goddess of Hunting', 'God of War', 'Season'];
  // Gameplay paints from past seasons. SS6 data had them at Lv5 and up only,
  // but live a Clockwork Ballet Coloring Paint started at Lv3, so any level.
  const GAMEPLAY_HIGH = ['Dark Surge', 'Blacksail', 'Cube of Rapacity', 'Aeterna', 'Twinightmare', 'Whispering Mist', 'Clockwork Ballet'];
  const CHEST = 'Treasure Chest';

  // Where an objective looks, from its Coloring Paint's cell. `name` is the
  // word the English client uses (Adjacent, Diagonal and Vertical are seen
  // live, and the player confirms Horizontal). Global is from the Chinese
  // guides only and isn't dealt.
  const RANGES = {
    row: { name: 'Horizontal', zh: '横向', text: 'in its row' },
    col: { name: 'Vertical', zh: '纵向', text: 'in its column' },
    diag: { name: 'Diagonal', zh: '对角斜向', text: 'on its diagonals' },
    adj: { name: 'Adjacent', zh: '相邻', text: 'next to it' },
    all: { name: 'Global', zh: '全图', text: 'anywhere on the canvas' },
  };
  const RANGE_IDS = Object.keys(RANGES);
  const TARGETS = {
    monster: { name: 'Monster', zh: '怪物' },
    gameplay: { name: 'Gameplay', zh: '玩法' },
    all: { name: 'Any', zh: '所有' },
  };

  // Brushstrokes: after an objective is met, a new Coloring Paint is offered
  // with 2 of these 3 directions; the chosen one offers 2 of its effects.
  // Reimagine, Spread and Layer are the English client's names.
  const DIRECTIONS = {
    turn: { name: 'Reimagine', zh: '转锋', text: 'Changes the Color Mixing Objective and Effect' },
    spread: { name: 'Spread', zh: '扩散', text: 'Takes effect on Special Cells' },
    stack: { name: 'Layer', zh: '堆砌', text: 'Adds additional Color Mixing Effects' },
  };
  const EFFECTS = {
    // Reimagine: reshape the offered Coloring Paint before it's placed.
    flip: { dir: 'turn', text: 'Switch its target to the other paint type', zh: '转变自身的作用对象为另一类型' },
    needDown: { dir: 'turn', text: 'The objective needs 1 fewer paint', zh: '调色目标的进度要求减少1' },
    reRange: { dir: 'turn', text: 'Change its direction (range) at random', zh: '转变调色目标和效果的范围' }, // confirmed live
    relevel: { dir: 'turn', text: 'Re-roll its own level, same content', zh: '随机转变自身的等级，内容不变' },
    renew: { dir: 'turn', text: 'Get a new random Coloring Paint instead', zh: '重新获得1个随机调色颜料' },
    // Spread: special cells. An ice cell that turns blank takes paints like any
    // blank cell (confirmed by the player).
    iceRow: { dir: 'spread', text: 'Converts the nearest 1 Blocked Cell in a horizontal area to a Blank Cell', zh: '将横向范围中最近1个阻挡地块转变为空白地块' },
    iceCol: { dir: 'spread', text: 'Converts the nearest 1 Blocked Cell in a vertical area to a Blank Cell', zh: '将纵向范围中最近1个阻挡地块转变为空白地块' }, // live wording
    iceAdj: { dir: 'spread', text: 'Converts 1 random adjacent Blocked Cell to a Blank Cell' }, // live wording
    voidNear: { dir: 'spread', text: 'The nearest void cell in its row or column turns blank', zh: '使虚空地块转变为空白地块' },
    onVoid: { dir: 'spread', text: 'It can be placed on a void cell, where its objective works but it isn\'t a paint', zh: '使自身可以放置在虚空地块上' }, // confirmed by the player: the cell stays void    onBlocked: { dir: 'spread', text: 'This can be placed on a Blocked Cell', zh: '可放置于阻挡地块' }, // confirmed live
    onPainted: { dir: 'spread', text: 'It can be placed on a painted cell, replacing that paint', zh: '可放置于已放置颜料的空白地块中，但会失去自身内容' }, // the player: it overwrites the old paint
    // Broken cells (from Forced Color Mixing): the player has seen Spread
    // effects that repair them or let the Coloring Paint go on them. Their
    // exact wording isn't known yet.
    repair: { dir: 'spread', text: 'The nearest broken cell is repaired and turns blank' },
    onBroken: { dir: 'spread', text: 'It can be placed on a broken cell' },
    // Layer: an extra effect when this objective is met.
    plusOne: { dir: 'stack', text: 'Its mixing effect raises 1 more level', zh: '调色效果额外提升1级' },
    randomOne: { dir: 'stack', text: '1 random paint in range rises 1 more level', zh: '对作用范围内的随机1个颜料额外提升1级' },
    // Same icon: when its objective is met, every paint with its icon rises 1
    // more; after that, every paint placed with its icon rises 1 (the player).
    sameContent: { dir: 'stack', text: 'Paints with its icon rise 1 more level, now and whenever one is placed later', zh: '对全图中与自身内容相同的颜料额外提升1级' },
    reroll: { dir: 'stack', text: 'Paints in range turn into random paints of the same level', zh: '将作用范围内的颜料转变为同等级的随机颜料' },
  };
  const EFFECT_IDS = Object.keys(EFFECTS);

  // Practice values: what the game doesn't show. Adjust as live play teaches.
  const DEFAULT_PARAMS = {
    blocked: [4, 6], // ice cells on a new canvas, min and max
    voids: [11, 15], // void cells on a new canvas, min and max (live: 11 and 15 seen)
    inventory: 30, // paints offered on a new canvas
    inventoryLevels: [40, 34, 18, 6, 2], // weights for Lv1-5 in the inventory
    gameplayShare: 50, // % of paints that are gameplay paints
    chestChance: 22, // % of canvases with a Treasure Chest in the inventory (the player: 1 in 4 or 5; never on the grid at the start)
    chestLevels: [20, 75, 5, 0, 0], // weights for the chest's starting level, Lv1-5 (the player: usually Lv2; one seen at Lv1)
    chestShare: 8, // % of random gameplay paints (from "random paint" effects) that are chests
    coloringLevels: [5, 10, 70, 15, 0], // weights for a Coloring Paint's level, Lv1-5 (the player: up to Lv4; every one seen so far came at Lv3)
    rangeWeights: { row: 25, col: 25, diag: 25, adj: 25, all: 0 }, // the player knows Horizontal, Vertical, Diagonal and Adjacent; Global is unseen
    targetWeights: { monster: 40, gameplay: 40, all: 20 },
    needByLevel: [3, 3, 3, 3, 3], // paints an objective needs, by its Coloring Paint's level 1-5 (live: always 3)
    gainTwoChance: [0, 0, 0, 0, 0], // % chance the effect is +2 instead of +1, by level 1-5 (live: always +1; more only from Layer)
    refreshes: 2, // brushstroke refreshes per canvas: 0 to 2, by the level of your pet (pactspirit)
    forcedMax: 3, // Forced Color Mixing uses per canvas
    forcedCost: [5, 10, 15], // Colored Snow for each use
    redrawCost: 5, // Colored Snow to start over: the same canvas and paints, with the Coloring Paints and brushstrokes to come re-rolled
    snowValue: 1, // what 1 Colored Snow is worth, in the score's points: a Lv7 chest (100) costs about 90 Snow with forcing and starting over (lab)
    chestValue: [0, 1, 1, 2, 4, 8, 20, 100], // what a chest is worth by final level 0-7
    rainbowValue: 4, // each other Lv7 (rainbow) paint: the goal when there's no chest
  };

  // ---------- Randomness ----------

  function hashSeed(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h || 1;
  }

  // mulberry32, with its state kept on the game so a run can be replayed.
  function rand(state) {
    let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const pickOne = (state, list) => list[Math.floor(rand(state) * list.length)];

  function pickWeighted(state, weights) {
    const entries = Array.isArray(weights) ? weights.map((w, i) => [i, w]) : Object.entries(weights);
    const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
    if (total <= 0) return entries[0][0];
    let r = rand(state) * total;
    for (const [k, w] of entries) {
      r -= Math.max(0, w);
      if (r < 0) return k;
    }
    return entries[entries.length - 1][0];
  }

  function shuffle(state, list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand(state) * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------- Geometry ----------

  const rowOf = (n) => Math.floor(n / SIZE);
  const colOf = (n) => n % SIZE;
  const cellLabel = (n) => `${String.fromCharCode(65 + colOf(n))}${rowOf(n) + 1}`;

  // The cells an objective at `at` looks at, not counting its own.
  // The cells in a range, worked out once: callers only read the lists.
  const RANGE_CACHE = {};
  function rangeCells(at, range) {
    const byCell = RANGE_CACHE[range] || (RANGE_CACHE[range] = []);
    return byCell[at] || (byCell[at] = rangeList(at, range));
  }

  function rangeList(at, range) {
    const r = rowOf(at);
    const c = colOf(at);
    const out = [];
    for (let n = 0; n < CELLS; n++) {
      if (n === at) continue;
      const dr = rowOf(n) - r;
      const dc = colOf(n) - c;
      if (range === 'row' ? dr === 0
        : range === 'col' ? dc === 0
          : range === 'diag' ? Math.abs(dr) === Math.abs(dc)
            : range === 'adj' ? Math.abs(dr) + Math.abs(dc) === 1
              : true) out.push(n);
    }
    return out;
  }

  // ---------- Paints ----------

  const isChest = (p) => !!p && p.cls === 'gameplay' && p.type === CHEST;
  const matches = (p, target) => !!p && (target === 'all' || p.cls === target);
  const paintName = (p) => (p ? `${p.cls === 'monster' ? 'Monster' : 'Gameplay'} paint: ${p.type} Lv${p.level}` : '');

  function makePaint(state, cls, type, level) {
    return { id: state.nextId++, cls, type, level: clamp(level, 1, MAX_LEVEL) };
  }

  // A random paint of a level. `chest` forces (true) or forbids (false) the
  // Treasure Chest; otherwise it comes at the practice share.
  function randomPaint(state, level, chest) {
    const P = state.params;
    if (chest === true) return makePaint(state, 'gameplay', CHEST, level);
    const gameplay = rand(state) * 100 < P.gameplayShare;
    if (!gameplay) return makePaint(state, 'monster', pickOne(state, MONSTERS), level);
    if (chest !== false && rand(state) * 100 < P.chestShare) return makePaint(state, 'gameplay', CHEST, level);
    const pool = GAMEPLAY.concat(GAMEPLAY_HIGH);
    return makePaint(state, 'gameplay', pickOne(state, pool), level);
  }

  // A Coloring Paint: a paint that brings an objective.
  function randomColoring(state) {
    const P = state.params;
    const level = Number(pickWeighted(state, P.coloringLevels)) + 1;
    const paint = randomPaint(state, level, false);
    const need = P.needByLevel[clamp(level, 1, 5) - 1];
    const gain = rand(state) * 100 < P.gainTwoChance[clamp(level, 1, 5) - 1] ? 2 : 1;
    return {
      paint,
      range: pickWeighted(state, P.rangeWeights),
      target: pickWeighted(state, P.targetWeights),
      need,
      gain,
      extras: [],
    };
  }

  // ---------- A new canvas ----------

  function normalizeParams(input) {
    const p = JSON.parse(JSON.stringify(DEFAULT_PARAMS));
    if (input && typeof input === 'object') for (const k of Object.keys(p)) if (input[k] != null) p[k] = JSON.parse(JSON.stringify(input[k]));
    return p;
  }

  function newCanvas(options) {
    const opts = options || {};
    const seed = String(opts.seed || '').trim().toUpperCase().slice(0, 40) || `CANVAS-${Math.floor(Math.random() * 1e9)}`;
    const state = {
      v: VERSION,
      seed,
      rng: hashSeed(seed),
      params: normalizeParams(opts.params),
      nextId: 1,
      cells: Array.from({ length: CELLS }, () => ({ kind: 'blank', paint: null, anchor: false })),
      inventory: [],
      active: null, // the objective in play: { cell, paint, range, target, need, gain, extras }
      offer: null, // a Coloring Paint on offer: { coloring, stage, directions, direction, effects, effect, placeOn }
      forced: 0,
      snow: 0,
      refreshes: 0,
      phase: 'paint', // paint, offer, done
      log: [],
      icons: [], // icons of old Coloring Paints with the same-icon effect: paints placed with them rise 1
      resets: 0,
      start: null, // the canvas as it began, for starting over
      stats: { objectives: 0, forced: 0, placed: 0 },
    };
    const P = state.params;
    state.refreshes = P.refreshes;
    // Ice and void cells.
    const order = shuffle(state, Array.from({ length: CELLS }, (_, n) => n));
    const ice = Math.round(P.blocked[0] + rand(state) * (P.blocked[1] - P.blocked[0]));
    const voids = Math.round(P.voids[0] + rand(state) * (P.voids[1] - P.voids[0]));
    order.slice(0, ice).forEach((n) => (state.cells[n].kind = 'blocked'));
    order.slice(ice, ice + voids).forEach((n) => (state.cells[n].kind = 'void'));
    // The inventory, maybe with a chest.
    const hasChest = rand(state) * 100 < P.chestChance;
    for (let i = 0; i < P.inventory; i++) state.inventory.push(randomPaint(state, Number(pickWeighted(state, P.inventoryLevels)) + 1, false));
    if (hasChest) {
      const i = Math.floor(rand(state) * state.inventory.length);
      state.inventory[i] = makePaint(state, 'gameplay', CHEST, Number(pickWeighted(state, P.chestLevels)) + 1);
    }
    sortInventory(state);
    // The first Coloring Paint is already on the canvas.
    const blanks = blankCells(state);
    // On a cell where its objective can be met: every live start had room in
    // its range, and the game wouldn't deal a dead canvas.
    let first = randomColoring(state);
    const room = (n, o) => rangeCells(n, o.range).filter((m) => state.cells[m].kind === 'blank').length >= o.need;
    for (let i = 0; i < 20 && !blanks.some((n) => room(n, first)); i++) first = randomColoring(state);
    const fits = blanks.filter((n) => room(n, first));
    const at = pickOne(state, fits.length ? fits : blanks);
    putColoring(state, at, first, false);
    log(state, `A new canvas: ${blanks.length} blank cells, ${ice} ice, ${voids} void.${hasChest ? ' A Treasure Chest is among the paints.' : ' No Treasure Chest among the paints.'}`);
    markStart(state);
    return state;
  }

  // Gameplay first, then by level, highest first; chests lead.
  function sortInventory(state) {
    state.inventory.sort((a, b) => (isChest(b) - isChest(a)) || (a.cls === b.cls ? 0 : a.cls === 'gameplay' ? -1 : 1) || b.level - a.level);
  }

  function log(state, text) {
    state.log.push(text);
    if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
  }

  // ---------- Queries ----------

  const blankCells = (state) => state.cells.map((c, n) => (c.kind === 'blank' && !c.paint ? n : -1)).filter((n) => n >= 0);
  const fillable = (state) => state.cells.filter((c) => c.kind === 'blank').length;
  const filled = (state) => state.cells.filter((c) => c.kind === 'blank' && c.paint).length;

  // The active objective's progress: matching paints already in its range.
  function progress(state, obj) {
    const o = obj || state.active;
    if (!o) return 0;
    return rangeCells(o.cell, o.range).filter((n) => matches(state.cells[n].paint, o.target)).length;
  }

  // Blank cells in the objective's range: where progress can still come from.
  const openInRange = (state, o) => rangeCells(o.cell, o.range).filter((n) => state.cells[n].kind === 'blank' && !state.cells[n].paint).length;

  function chests(state) {
    return state.cells.map((c, n) => (isChest(c.paint) ? n : -1)).filter((n) => n >= 0);
  }

  // What the canvas is worth now: its chests by level.
  // Rainbow (Lv7) paints other than chests: the goal on a canvas without one.
  const rainbows = (state) => state.cells.filter((c) => c.paint && c.paint.level >= MAX_LEVEL && !isChest(c.paint)).length;

  // What the canvas is worth: its chests by level, then its other rainbows,
  // less the Colored Snow spent on it.
  function score(state) {
    const P = state.params;
    return chests(state).reduce((s, n) => s + P.chestValue[state.cells[n].paint.level], 0) + (P.rainbowValue || 0) * rainbows(state) - (P.snowValue || 0) * state.snow;
  }

  const bestChest = (state) => Math.max(0, ...chests(state).map((n) => state.cells[n].paint.level));

  // ---------- Actions ----------

  const ok = () => ({ ok: true });
  const fail = (reason) => ({ ok: false, reason });

  // Places a paint from the inventory on a blank cell.
  function place(state, invIndex, cell) {
    if (state.phase !== 'paint') return fail(state.phase === 'offer' ? 'Place the Coloring Paint on offer first.' : 'This canvas is finished.');
    const paint = state.inventory[invIndex];
    if (!paint) return fail('Pick a paint from the inventory.');
    const c = state.cells[cell];
    if (!c || c.kind !== 'blank' || c.paint) return fail('Paints go on blank cells.');
    state.inventory.splice(invIndex, 1);
    c.paint = paint;
    state.stats.placed += 1;
    log(state, `Placed ${paint.type} Lv${paint.level} on ${cellLabel(cell)}.`);
    iconBonus(state, cell);
    afterChange(state);
    return ok();
  }

  // After any placement: meet the objective if it's met, or finish the canvas.
  // An objective fails once its range has no blank cell left and it's short:
  // no new Coloring Paints come after that, but it can still be forced.
  function afterChange(state) {
    if (state.active && progress(state) >= state.active.need) {
      complete(state, false);
      return;
    }
    if (failed(state) && !state.active.failed) {
      state.active.failed = true;
      log(state, 'Objective failed: its range is full. No new Coloring Paints come unless you force it.');
    }
    checkDone(state);
  }

  // An old Coloring Paint with the same-icon effect raises each paint placed
  // later with its icon by 1.
  function iconBonus(state, cell) {
    const p = state.cells[cell].paint;
    const n = (state.icons || []).filter((i) => i.cls === p.cls && i.type === p.type).length;
    if (!n) return;
    raise(state, cell, n);
    log(state, `Its icon matches an old Coloring Paint: ${p.type} rose to Lv${p.level}.`);
  }

  const failed = (state) => !!state.active && progress(state) < state.active.need && openInRange(state, state.active) === 0;

  function checkDone(state) {
    if (state.phase === 'paint' && (!blankCells(state).length || !state.inventory.length)) finish(state);
  }

  // Remembers the canvas as it is now as the one to start over from.
  function markStart(state) {
    state.start = JSON.parse(JSON.stringify({ cells: state.cells, inventory: state.inventory, active: state.active, icons: state.icons || [] }));
  }

  // Starting over: pay Colored Snow and get the same canvas and paints back,
  // with Forced Color Mixing and refreshes restored. What comes next (the
  // Coloring Paints, brushstrokes and breaks) is rolled again.
  function reset(state) {
    if (!state.start) return fail('There is no start to go back to.');
    const P = state.params;
    const s = JSON.parse(JSON.stringify(state.start));
    state.cells = s.cells;
    state.inventory = s.inventory;
    state.active = s.active;
    state.icons = s.icons || [];
    state.offer = null;
    state.phase = 'paint';
    state.forced = 0;
    state.refreshes = P.refreshes;
    state.snow += P.redrawCost;
    state.resets += 1;
    log(state, `Started over, for ${P.redrawCost} Colored Snow (${state.resets} so far).`);
    return ok();
  }

  function finish(state) {
    state.phase = 'done';
    state.offer = null;
    const lv = bestChest(state);
    const r = rainbows(state);
    log(state, `${lv ? `Canvas finished: the Treasure Chest reached Lv${lv}${lv >= MAX_LEVEL ? '!' : '.'}` : 'Canvas finished, with no Treasure Chest.'} ${r} other rainbow paint${r === 1 ? '' : 's'}.`);
  }

  // Meets the active objective (or forces it): matching paints in range rise.
  function complete(state, forced) {
    const o = state.active;
    const inRange = rangeCells(o.cell, o.range);
    const hits = inRange.filter((n) => matches(state.cells[n].paint, o.target));
    const gain = o.gain + (o.extras.includes('plusOne') ? 1 : 0);
    for (const n of hits) raise(state, n, gain);
    // Extra mixing effects from a Layer brushstroke.
    // Any paint in range, whatever the objective's type, even one at Lv7.
    if (o.extras.includes('randomOne')) {
      const painted = inRange.filter((n) => state.cells[n].paint);
      if (painted.length) raise(state, pickOne(state, painted), 1);
    }
    if (o.extras.includes('sameContent') && o.paint) {
      for (let n = 0; n < CELLS; n++) {
        const p = state.cells[n].paint;
        if (p && n !== o.cell && p.cls === o.paint.cls && p.type === o.paint.type) raise(state, n, 1);
      }
      state.icons = (state.icons || []).concat([{ cls: o.paint.cls, type: o.paint.type }]);
    }
    if (o.extras.includes('reroll')) {
      for (const n of inRange) {
        const p = state.cells[n].paint;
        if (!p || state.cells[n].anchor) continue;
        const fresh = randomPaint(state, p.level);
        fresh.id = p.id;
        state.cells[n].paint = fresh;
      }
    }
    state.stats.objectives += 1;
    if (forced) state.stats.forced += 1;
    log(state, `${forced ? 'Forced' : 'Objective met'}: ${TARGETS[o.target].name.toLowerCase()} paints ${RANGES[o.range].text} rose ${gain} level${gain === 1 ? '' : 's'} (${hits.length} paint${hits.length === 1 ? '' : 's'}).`);
    if (forced) breakOne(state);
    state.active = null;
    if (!blankCells(state).length && !canPlaceAnywhere(state)) {
      finish(state);
      return;
    }
    offerColoring(state);
  }

  // Forcing's price: 1 random paint on the canvas is gone, and its cell breaks.
  // Nothing goes on a broken cell until it's repaired.
  function breakOne(state) {
    const painted = state.cells.map((c, n) => (c.kind === 'blank' && c.paint ? n : -1)).filter((n) => n >= 0);
    if (!painted.length) return;
    const n = pickOne(state, painted);
    const c = state.cells[n];
    log(state, `Cell ${cellLabel(n)} broke, and its ${c.paint.type} Lv${c.paint.level} is gone.`);
    c.kind = 'broken';
    c.paint = null;
    c.anchor = false;
  }

  function raise(state, n, by) {
    const p = state.cells[n].paint;
    if (!p) return;
    p.level = clamp(p.level + by, 1, MAX_LEVEL);
  }

  // Forced Color Mixing: meets the objective now, for Colored Snow.
  function force(state) {
    if (state.phase !== 'paint' || !state.active) return fail('There is no objective to force.');
    const P = state.params;
    if (state.forced >= P.forcedMax) return fail('No Forced Color Mixing left on this canvas.');
    state.snow += P.forcedCost[Math.min(state.forced, P.forcedCost.length - 1)];
    state.forced += 1;
    complete(state, true);
    return ok();
  }

  // ---------- Brushstrokes ----------

  function offerColoring(state, keep) {
    const coloring = keep || randomColoring(state);
    state.offer = { coloring, stage: 'direction', directions: drawDirections(state), direction: null, effects: [], effect: null, placeOn: 'blank' };
    state.phase = 'offer';
  }

  const drawDirections = (state) => shuffle(state, Object.keys(DIRECTIONS)).slice(0, 2);

  function drawEffects(state, dir) {
    const o = state.offer.coloring;
    const pool = EFFECT_IDS.filter((id) => EFFECTS[id].dir === dir && usable(state, id, o));
    return shuffle(state, pool).slice(0, 2);
  }

  // Effects that would do nothing aren't offered.
  function usable(state, id, o) {
    if (id === 'flip') return o.target !== 'all';
    if (id === 'needDown') return o.need > 1;
    if (id === 'iceRow' || id === 'iceCol' || id === 'iceAdj') return state.cells.some((c) => c.kind === 'blocked');
    if (id === 'voidNear' || id === 'onVoid') return state.cells.some((c) => c.kind === 'void');
    if (id === 'onBlocked') return state.cells.some((c) => c.kind === 'blocked');
    if (id === 'repair' || id === 'onBroken') return state.cells.some((c) => c.kind === 'broken');
    return true;
  }

  function chooseDirection(state, dir) {
    const f = state.offer;
    if (state.phase !== 'offer' || !f || f.stage !== 'direction') return fail('There is no brushstroke direction to choose.');
    if (!f.directions.includes(dir)) return fail('That direction is not on offer.');
    f.direction = dir;
    f.effects = drawEffects(state, dir);
    f.stage = 'effect';
    if (!f.effects.length) f.stage = 'place';
    return ok();
  }

  // Applies a chosen effect. Reimagine effects reshape the Coloring Paint now;
  // Spread effects change where it can go or act when it's placed; Layer
  // (Layer) effects ride along until its objective is met.
  function chooseEffect(state, id) {
    const f = state.offer;
    if (state.phase !== 'offer' || !f || f.stage !== 'effect') return fail('There is no brushstroke effect to choose.');
    if (!f.effects.includes(id)) return fail('That effect is not on offer.');
    f.effect = id;
    const o = f.coloring;
    const P = state.params;
    switch (id) {
      case 'flip':
        o.target = o.target === 'monster' ? 'gameplay' : 'monster';
        break;
      case 'needDown':
        o.need = Math.max(1, o.need - 1);
        break;
      case 'reRange':
        o.range = pickWeighted(state, Object.fromEntries(Object.entries(P.rangeWeights).filter(([k]) => k !== o.range)));
        break;
      case 'relevel':
        o.paint.level = Number(pickWeighted(state, P.inventoryLevels)) + 1;
        break;
      case 'renew':
        f.coloring = randomColoring(state);
        break;
      case 'onVoid':
        f.placeOn = 'void';
        break;
      case 'onBlocked':
        f.placeOn = 'blocked';
        break;
      case 'onPainted':
        f.placeOn = 'painted';
        break;
      case 'onBroken':
        f.placeOn = 'broken';
        break;
      default:
        if (EFFECTS[id].dir === 'stack') o.extras.push(id);
    }
    f.stage = 'place';
    return ok();
  }

  // Re-rolls the directions or effects on offer, using a refresh.
  function refresh(state) {
    const f = state.offer;
    if (state.phase !== 'offer' || !f || f.stage === 'place') return fail('Nothing to refresh right now.');
    if (state.refreshes <= 0) return fail('No brushstroke refreshes left.');
    state.refreshes -= 1;
    if (f.stage === 'direction') f.directions = drawDirections(state);
    else f.effects = drawEffects(state, f.direction);
    return ok();
  }

  // Where the Coloring Paint on offer can go.
  function placeTargets(state) {
    const f = state.offer;
    if (!f) return [];
    return state.cells.map((c, n) => {
      if (c.kind === 'blank' && !c.paint) return n;
      if (f.placeOn === 'void' && c.kind === 'void') return n;
      if (f.placeOn === 'blocked' && c.kind === 'blocked') return n;
      if (f.placeOn === 'broken' && c.kind === 'broken') return n;
      if (f.placeOn === 'painted' && c.kind === 'blank' && c.paint && !c.anchor) return n;
      return -1;
    }).filter((n) => n >= 0);
  }

  const canPlaceAnywhere = (state) => blankCells(state).length > 0;

  function placeColoring(state, cell) {
    const f = state.offer;
    if (state.phase !== 'offer' || !f || f.stage !== 'place') return fail('Choose a brushstroke first.');
    if (!placeTargets(state).includes(cell)) return fail(f.placeOn === 'painted' ? 'Place it on a blank or painted cell.' : f.placeOn === 'void' ? 'Place it on a blank or void cell.' : f.placeOn === 'blocked' ? 'Place it on a blank or ice cell.' : f.placeOn === 'broken' ? 'Place it on a blank or broken cell.' : 'Place it on a blank cell.');
    const c = state.cells[cell];
    // On a void cell the Coloring Paint isn't there as a paint: the cell stays
    // void, and only its objective works from it. On an ice or broken cell
    // it's painted, and on a painted cell it replaces the paint there.
    const lost = c.kind === 'void';
    if (c.paint) log(state, `The ${c.paint.type} Lv${c.paint.level} on ${cellLabel(cell)} was painted over.`);
    if (c.kind === 'blocked' || c.kind === 'broken') c.kind = 'blank';
    putColoring(state, cell, f.coloring, lost);
    if (!lost) iconBonus(state, cell);
    // Spread effects that act from where it lands.
    if (f.effect === 'iceAdj') {
      const near = rangeCells(cell, 'adj').filter((n) => state.cells[n].kind === 'blocked');
      if (near.length) {
        const n = pickOne(state, near);
        state.cells[n].kind = 'blank';
        log(state, `Ice cell ${cellLabel(n)} turned blank.`);
      }
    }
    if (f.effect === 'iceRow' || f.effect === 'iceCol' || f.effect === 'voidNear' || f.effect === 'repair') {
      const kind = f.effect === 'voidNear' ? 'void' : f.effect === 'repair' ? 'broken' : 'blocked';
      const line = f.effect === 'iceRow' ? rangeCells(cell, 'row') : f.effect === 'iceCol' ? rangeCells(cell, 'col') : f.effect === 'repair' ? rangeCells(cell, 'all') : rangeCells(cell, 'row').concat(rangeCells(cell, 'col'));
      const near = line.filter((n) => state.cells[n].kind === kind).sort((a, b) => dist(a, cell) - dist(b, cell))[0];
      if (near != null) {
        state.cells[near].kind = 'blank';
        log(state, `${f.effect === 'voidNear' ? 'Void' : f.effect === 'repair' ? 'Broken' : 'Ice'} cell ${cellLabel(near)} ${f.effect === 'repair' ? 'was repaired' : 'turned blank'}.`);
      }
    }
    state.offer = null;
    state.phase = 'paint';
    afterChange(state);
    return ok();
  }

  const dist = (a, b) => Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));

  // Puts a Coloring Paint on the canvas and makes its objective active. On a
  // void cell it isn't a paint (`lost`): the cell stays void.
  function putColoring(state, cell, coloring, lost) {
    const c = state.cells[cell];
    if (!lost) c.paint = coloring.paint;
    c.anchor = true;
    state.active = { cell, paint: lost ? null : coloring.paint, range: coloring.range, target: coloring.target, need: coloring.need, gain: coloring.gain, extras: coloring.extras.slice() };
    log(state, `Coloring Paint on ${cellLabel(cell)}: place ${coloring.need} ${TARGETS[coloring.target].name.toLowerCase()} paints ${RANGES[coloring.range].text}, then they rise ${coloring.gain}.`);
  }

  // ---------- Text ----------

  // The game's English wording: "Fill a Adjacent Cell with a Monster
  // Paint(0/3)", "Color Mixing Effect:Level up the Adjacent Monster Paint by
  // 1 level(s)".
  function objectiveText(o, prog) {
    if (!o) return '';
    const done = prog == null ? '' : ` (${prog}/${o.need})`;
    return `Fill a ${RANGES[o.range].name} Cell with a${o.target === 'all' ? 'ny' : ''} ${o.target === 'all' ? '' : `${TARGETS[o.target].name} `}Paint${done}`;
  }

  function effectText(o) {
    if (!o) return '';
    const gain = o.gain + (o.extras.includes('plusOne') ? 1 : 0);
    return `Color Mixing Effect: Level up the ${RANGES[o.range].name} ${o.target === 'all' ? '' : `${TARGETS[o.target].name} `}Paint by ${gain} level(s)`;
  }

  function clone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  const api = {
    VERSION, SIZE, CELLS, MAX_LEVEL, MONSTERS, GAMEPLAY, GAMEPLAY_HIGH, CHEST, RANGES, RANGE_IDS, TARGETS, DIRECTIONS, EFFECTS, EFFECT_IDS, DEFAULT_PARAMS,
    newCanvas, normalizeParams, place, force, reset, markStart, usable, chooseDirection, chooseEffect, refresh, placeColoring, placeTargets,
    rangeCells, progress, openInRange, failed, blankCells, fillable, filled, chests, bestChest, rainbows, score, isChest, matches, paintName,
    rowOf, colOf, cellLabel, objectiveText, effectText, clone, rand, makePaint, randomPaint, randomColoring, sortInventory, finish,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TartarusCanvas = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
