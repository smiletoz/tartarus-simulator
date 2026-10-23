/* Tartarus Simulator: solver.
 * Rules-based play with no AI, in three parts that work on the game state:
 *  - Chain math: the exact expected outcome of a devour, including the random
 *    chain after it.
 *  - A strategy: it scores every legal move from what the player can see and
 *    plays the best one. tools/strategy-sim.js tunes its weights by running
 *    millions of simulated games.
 *  - A Monte Carlo solver: it plays each candidate move out many times from
 *    the current position, with the strategy making every later choice, and
 *    ranks the moves by Rainbows vaulted. Each playout re-rolls everything
 *    the player can't see, so the solver never peeks behind a door.
 * Runs in the page (in a Web Worker when it can) and under Node. */
(function (root) {
  'use strict';

  const T = root.Tartarus || (typeof require === 'function' ? require('./engine.js') : null);
  const { BEASTS, RAINBOW } = T;
  const RAT = BEASTS.indexOf('rat');
  const LION = BEASTS.indexOf('lion');
  const MAMMOTH = BEASTS.indexOf('mammoth');
  // The day's swap is still open: a day has a devour or a swap, not both.
  // (An engine cached from before that rule has no canSwapNow.)
  const canSwapNow = (st) => (T.canSwapNow ? T.canSwapNow(st) : st.used.swap < st.params.swapsPerDay);

  // Strategy weights. Values are in "tier value" units, where an inmate of
  // tier t is worth tierBase^t. tools/strategy-sim.js tuned these by
  // coordinate search over simulated runs (see tools/README.md).
  const DEFAULTS = {
    tierBase: 3, // how much one tier is worth over the tier below
    rainbowMult: 2, // a vaulted Rainbow, as a multiple of tierBase^5
    wOpen: 1, // patrol: value of adding a new inmate by opening a door
    wNow: 1, // patrol: what the new or visited inmate can do today
    wWalk: 1, // patrol: walking to a known inmate
    wStep: 0, // patrol: per step walked (negative keeps the warden slow)
    wNest: -6, // patrol: opening a rat nest before it hatches
    wChain: 4, // patrol: a door that hides a Chain reaction
    wGoal: 1, // patrol: per tile walked toward Prison Walk, while it pays a tool
    wIncident: 0, // patrol: an event set off toward Undercurrents, divided by the incidents still needed
    wPass: 0, // patrol: an event walked past while Undercurrents needs one (it waits a lap), divided the same way
    wOfficeIncident: 0, // office: each event an Instigate brings while Undercurrents needs it, divided the same way
    wConsume: 0, // manage: a consume while Survival of the Fittest needs one, divided by the consumes still needed
    wConsumeWalk: 0, // patrol: walking to an inmate that can consume today, while it needs one, divided the same way
    wUsurp: 0.5, // events: the next Usurpation, which each one puts behind a locked door, as a share of its worth
    wInstigate: 0.5, // office: an event Instigate brings, as a share of an event door's worth
    wCrow: 2, // patrol: a door hiding Crow Whispers (it only shows rarities)
    wShort: 0.1, // Short-Chained Shackles: a short walk's chance of an extra door, as a share of its worth (0.1 measured best: 0.749 against 0.683 at 1)
    wKeys: 0, // Lost Ring of Keys: each locked cell beside a door the patrol opens (80% to open too), as a share of a new inmate's worth
    wForged: 0, // Forged Key: a door the patrol opens may open 1 more random locked cell (50%), as a share of its worth
    wFire: 0, // Searing Branding Iron: a door the patrol opens may copy its inmate into a locked cell (35%), as a share of its worth
    wCage: 1, // Crowded Beastcage: a devour's chance of reopening the meal's cell, as a share of its worth
    rerollMargin: 0.02, // a pet's re-roll: only when a new offer's best averages this much more (Rainbows per run)
    wStair: 0, // keeping a spread of beasts at each tier, so chains can go on
    minDevour: 0, // skip devours worth less than this (-1e9: never skip)
    stopMargin: 0, // stop a consume chain (the game's Cancel) when its best next meal is worth less than this (-1e9: never stop)
    swapMaxTier: 0, // swap the warden's inmate only at or below this tier
    swapMargin: 0, // a day has a swap or a devour: swap only when it beats the best devour by this much
    maidenSwapTier: 3, // holding the Severed Iron Maiden, swap up to this tier (Legendary measured best)
    execMargin: 0, // accept an Execution worth more than this
    acceptChain: true, // accept Chain reactions
    toolRank: ['trap', 'maul', 'crown', 'coin', 'claws', 'rope', 'scapegoat', 'blacklist', 'shackles', 'revenge', 'maiden', 'skewer', 'collar', 'ravenous', 'muzzle', 'saw', 'tongs', 'guillotine', 'hook', 'whip', 'cage', 'dogtag', 'stake', 'keys', 'pestle', 'shortchain', 'scales', 'fire', 'axe', 'ironbox', 'forged'], // measured: each tool held from day 1
    toolSets: true, // pick instruments by the measured sets (js/tool-combos.js) when there are any
    office: null, // always 'bestow' or 'instigate' at the office (only to measure the habit)
    giftRank: null, // null scores the gifts on the spot; or a fixed order
    giftChain: true, // Opulence's chain first: Horn for a Rainbow, then Thumb Ring, then Vintage (pickGift)
  };

  // Tuned weights for each kind of run: drills with tool rewards on or off.
  // The solver picks by the run's settings. From
  // tools/results/ (train-report.json: the drill profiles were retrained on
  // 2026-10-15). The objective weights (wIncident, wPass, wOfficeIncident,
  // wConsume) were tuned on 2026-10-17 by whole runs with that objective set,
  // 10,000 a setting and checked on fresh seeds: Undercurrents +0.18 Rainbows
  // a run (met 99% of runs, by day 7.9 not 9.5), Survival of the Fittest
  // +0.04. Runs with other objectives play out exactly as before.
  // wKeys (Lost Ring of Keys) was tuned the same way with the Keys held from
  // day 1: +0.066 ±0.031 Rainbows a run on fresh seeds. wForged and wFire
  // measured no gain and stay 0.
  const PROFILES = {
    rewards: { tierBase: 3, rainbowMult: 1.5, wOpen: 1.5, wNow: 0.844, wWalk: 0.75, wStep: 0.5, wChain: 6, wStair: 0.25, swapMaxTier: 3, minDevour: 0, execMargin: 0, acceptChain: true, wCrow: 1, wIncident: 40, wPass: 40, wOfficeIncident: 60, wConsume: 20, wKeys: 1, toolRank: ['trap', 'maul', 'crown', 'coin', 'claws', 'rope', 'scapegoat', 'blacklist', 'shackles', 'revenge', 'maiden', 'skewer', 'collar', 'ravenous', 'muzzle', 'saw', 'tongs', 'guillotine', 'hook', 'whip', 'cage', 'dogtag', 'stake', 'keys', 'pestle', 'shortchain', 'scales', 'fire', 'axe', 'ironbox', 'forged'] },
    notools: { tierBase: 2.75, rainbowMult: 12, wOpen: 2.25, wNow: 0.375, wWalk: 1.875, wStep: 0.5, wChain: 24, wStair: 0.125, swapMaxTier: 1, minDevour: 0, execMargin: -5, acceptChain: false, wCrow: 1, toolRank: ['trap', 'maul', 'crown', 'coin', 'claws', 'rope', 'scapegoat', 'blacklist', 'shackles', 'revenge', 'maiden', 'skewer', 'collar', 'ravenous', 'muzzle', 'saw', 'tongs', 'guillotine', 'hook', 'whip', 'cage', 'dogtag', 'stake', 'keys', 'pestle', 'shortchain', 'scales', 'fire', 'axe', 'ironbox', 'forged'] },
  };
  const paramsFor = (st) => PROFILES[st.params.rewards ? 'rewards' : 'notools'];

  const withDefaults = (p) => Object.assign({}, DEFAULTS, p || {});

  // Measured Rainbows per run for sets of up to 4 instruments held from day
  // 1 (js/tool-combos.js, from the lab's combos mode). Without it, the
  // trained ranking alone picks instruments.
  const COMBOS = root.TARTARUS_COMBOS || (typeof require === 'function' ? optional('./tool-combos.js') : null);
  function optional(file) {
    try {
      return require(file);
    } catch (e) {
      return null;
    }
  }

  // ---------- Small helpers ----------

  // mulberry32, for the solver's own dice (never the game's).
  function rng32(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const beastIndex = (b) => BEASTS.indexOf(b);
  const has = (st, id) => st.tools.includes(id);

  // Counts of open inmates by tier and beast (index tier * 4 + beast),
  // leaving out one cell, plus how many are on the block in all.
  function composition(st, exclude) {
    const comp = new Array(24).fill(0);
    let crowd = 0;
    for (const c of st.cells) {
      if (c.sealed || !c.inmate) continue;
      crowd += 1;
      if (c.n === exclude || c.inmate.tier >= RAINBOW) continue;
      comp[c.inmate.tier * 4 + beastIndex(c.inmate.beast)] += 1;
    }
    return { comp, crowd };
  }

  function normalize(weights) {
    const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0) || 1;
    return weights.map((w) => Math.max(0, w) / total);
  }

  // Door odds known to be at or above a tier (a "Treasure" Hunt's dark doors).
  function floorDist(dist, floor) {
    const kept = dist.map((p, t) => (t >= floor ? p : 0));
    return kept.some((p) => p > 0) ? normalize(kept) : dist;
  }

  // ---------- Chain math ----------

  // Everything a decision needs, computed once per position.
  function context(st, params) {
    const P = withDefaults(params);
    const chain = T.FOOD_CHAIN;
    const eats = BEASTS.map((b) => chain[b].map(beastIndex));
    const skewer = has(st, 'skewer');
    if (skewer) eats[RAT] = eats[RAT].concat(RAT);
    // What each beast counters: under Cage Fight it can eat those at a
    // lower rarity too (the Crown's other beasts only at its own).
    const counters = eats.map((list) => list.slice());
    // The Iron Crown of the Prison King: a Lion eats any beast.
    const crown = has(st, 'crown');
    if (crown) eats[LION] = [0, 1, 2, 3];
    // The Elephant-Foot Maul: a Mammoth eats what it counters at a higher
    // rarity too, and rises to 2 tiers above its meal.
    const maul = has(st, 'maul');
    // From params.doubleEatTier up (every rarity since 2026-10-17), Mammoths
    // and Lions also eat their second meal (an engine cached from before has
    // none).
    const second = T.SECOND_MEAL || {};
    const withSecond = (diet) => diet.map((list, b) => [...new Set(list.concat((second[BEASTS[b]] || []).map(beastIndex)))]);
    const eatsHigh = withSecond(eats);
    const countersHigh = withSecond(counters);
    // Under Cage Fight, both meals at every rarity.
    const doubleFrom = T.cageFight && T.cageFight(st) ? 0 : Number.isFinite(st.params.doubleEatTier) ? st.params.doubleEatTier : T.SECOND_MEAL ? T.DEFAULT_PARAMS.doubleEatTier : RAINBOW;
    const v = [0, 1, 2, 3, 4, 5].map((t) => P.tierBase ** t);
    // The rarity odds behind a door: the Sorting Hook keeps out Normals.
    const doorWeights = st.params.tierWeights.slice();
    if (has(st, 'hook') && doorWeights.slice(1).some((x) => x > 0)) doorWeights[0] = 0;
    const openDist = normalize(doorWeights);
    // With the vault full (T.VAULT_SLOTS), a would-be Rainbow stays Supreme.
    const vaultFull = !!T.VAULT_SLOTS && st.vault.length >= T.VAULT_SLOTS;
    const R = vaultFull ? v[T.SUPREME] : v[RAINBOW] * P.rainbowMult;
    const sealed = st.cells.filter((c) => c.sealed).length;
    // Long-Chained Shackles: what +1 tier on a random inmate is worth.
    const board = st.cells.filter((c) => !c.sealed && c.inmate && c.inmate.tier < RAINBOW);
    const lift = board.reduce((sum, c) => sum + (c.inmate.tier + 1 >= RAINBOW ? R : v[c.inmate.tier + 1]) - v[c.inmate.tier], 0) / Math.max(1, board.length);
    // Two tiers for every inmate on the block (Usurpation IV), and for a random one.
    const allLift2 = board.reduce((sum, c) => sum + (c.inmate.tier + 2 >= RAINBOW ? R : v[c.inmate.tier + 2]) - v[c.inmate.tier], 0);
    const goal = st.objective && st.objective.id === 'walk' && !st.milestone && st.params.rewards ? T.OBJECTIVES.walk.need - st.objective.progress : 0;
    // Undercurrents: the Prison Incidents it still needs, while it pays a tool.
    const incidents = st.objective && st.objective.id === 'incident' && !st.milestone && st.params.rewards && T.OBJECTIVES.incident ? T.OBJECTIVES.incident.need - st.objective.progress : 0;
    // Survival of the Fittest: the consumes (each bite) it still needs.
    const consumes = st.objective && st.objective.id === 'consume' && !st.milestone && st.params.rewards && T.OBJECTIVES.consume ? T.OBJECTIVES.consume.need - st.objective.progress : 0;
    return {
      st,
      P,
      eats,
      // What each beast eats at tier t, and what it counters there.
      eatsAt: (t) => (t >= doubleFrom ? eatsHigh : eats),
      countersAt: (t) => (t >= doubleFrom ? countersHigh : counters),
      // Cage Fight: lower-rarity meals, and the eater keeps its beast.
      fight: T.cageFight ? T.cageFight(st) : false,
      v,
      R,
      saw: has(st, 'saw'),
      whip: has(st, 'whip'),
      muzzle: has(st, 'muzzle'),
      skewer,
      crown,
      maul,
      collar: has(st, 'collar'),
      revenge: has(st, 'revenge') && sealed > 0,
      axeDoors: has(st, 'axe') ? Math.min(2, sealed) : 0,
      dogtag: has(st, 'dogtag'),
      cage: has(st, 'cage'),
      blacklist: has(st, 'blacklist'),
      shortchain: has(st, 'shortchain'),
      keys: has(st, 'keys'),
      forged: has(st, 'forged'),
      fire: has(st, 'fire'),
      // Severed Iron Maiden: how many inmates of each tier are on the block.
      maiden: has(st, 'maiden') ? [0, 1, 2, 3, 4].map((t) => board.filter((c) => c.inmate.tier === t).length) : null,
      // Scapegoat's Guillotine, with 2 or more others beside the warden's
      // inmate: a swap comes in above the rarity it replaces, and 2 random
      // others go, what 2 of them are worth on average (the inmate replaced
      // isn't one of them: counting it understated the loss beside a
      // Normal, the user's game of 2026-10-20).
      scapegoat: (() => {
        if (!has(st, 'scapegoat')) return null;
        const others = board.filter((c) => c.n !== st.position);
        return others.length >= 2 && others.length < board.length ? { loss: (2 * others.reduce((sum, c) => sum + v[c.inmate.tier], 0)) / others.length } : null;
      })(),
      // Burning Stake: a swap from below Legendary may come in Legendary.
      stake: has(st, 'stake'),
      // The highest tier worth swapping: higher with the Maiden, up to Rare
      // with the Burning Stake, and up to Supreme with the Guillotine (a
      // Supreme's swap comes in Chromatic). A swapMaxTier below 0 never
      // swaps, not even in a Tusk cell.
      swapCap: P.swapMaxTier < 0 ? -1 : has(st, 'scapegoat') && board.length >= 3 ? T.SUPREME : Math.max(has(st, 'maiden') ? Math.max(P.swapMaxTier, P.maidenSwapTier) : P.swapMaxTier, has(st, 'stake') ? 2 : 0),
      sealed,
      lift: board.length ? lift : 0,
      lift2: board.length ? allLift2 / board.length : 0,
      allLift2,
      shacklesLift: has(st, 'shackles') && board.length ? lift : 0,
      boardCount: board.length,
      goalLeft: goal,
      incidentsLeft: incidents,
      consumesLeft: consumes,
      scratchExtra: 1 + (st.params.scratchStacksBase ? 1 : 0),
      openDist,
      openValue: openDist.reduce((sum, p, t) => sum + p * v[t], 0),
      // The game's Cancel: a chain can stop after any bite.
      chainStop: T.canStopChain ? T.canStopChain(st) : false,
      memo: new Map(),
    };
  }

  // Tier odds for a swapped-in inmate, after Hangman's Noose, and above the
  // old tier with the Scapegoat's Guillotine (a tier above when the weights
  // reach no higher; index 5 is Chromatic). The Burning Stake then makes a
  // swap from below Legendary come in Legendary 40% of the time.
  function swapDist(ctx, oldTier) {
    const w = (ctx.st.params.swapWeights || ctx.st.params.tierWeights).slice();
    if (has(ctx.st, 'rope')) w[0] = w[1] = 0;
    let dist;
    if (ctx.scapegoat) {
      const higher = w.map((x, t) => (t > oldTier ? x : 0));
      dist = higher.some((x) => x > 0) ? normalize(higher) : [0, 1, 2, 3, 4, 5].map((t) => (t === Math.min(RAINBOW, oldTier + 1) ? 1 : 0));
    } else dist = normalize(w);
    if (ctx.stake && oldTier < 3) {
      dist = dist.map((p) => 0.6 * p);
      dist[3] += 0.4;
    }
    return dist;
  }

  // Value from here on for an eater that just reached tier t: its beast
  // re-rolls (under Cage Fight it stays `keep`), then it chains into the
  // best valid meal if it has one.
  function rise(ctx, t, comp, crowd, keep) {
    if (t >= RAINBOW) return ctx.R;
    const beasts = keep >= 0 ? [keep] : [0, 1, 2, 3];
    let sum = 0;
    for (const b of beasts) {
      if (ctx.revenge) {
        // Avenger's Casket: 30% of the time a meal for the new form appears.
        const foods = ctx.eatsAt(t)[b];
        let spawned = 0;
        for (const f of foods) {
          comp[t * 4 + f] += 1;
          spawned += ctx.v[t] + feed(ctx, t, b, comp, crowd + 1);
          comp[t * 4 + f] -= 1;
        }
        sum += (0.3 * spawned) / foods.length + 0.7 * feed(ctx, t, b, comp, crowd);
      } else {
        sum += feed(ctx, t, b, comp, crowd);
      }
    }
    return sum / beasts.length;
  }

  // An eater of beast b at tier t takes the best meal it has. With none, the
  // chain ends and it keeps its tier, and with the game's Cancel it also
  // stops when no meal is worth eating (stopMargin).
  function feed(ctx, t, b, comp, crowd) {
    let key = `${t}${b}${ctx.muzzle ? `m${crowd}` : ''}`;
    for (let i = ctx.fight ? 0 : t * 4; i < 20; i++) key += String.fromCharCode(48 + comp[i]);
    const hit = ctx.memo.get(key);
    if (hit !== undefined) return hit;
    let out = -Infinity;
    // Under Cage Fight, countered meals of a lower rarity too.
    for (let mt = ctx.fight ? 0 : t; mt <= topMeal(ctx, t, b); mt++) {
      for (const f of (mt !== t ? ctx.countersAt(t) : ctx.eatsAt(t))[b]) {
        if (!comp[mt * 4 + f]) continue;
        comp[mt * 4 + f] -= 1;
        out = Math.max(out, bite(ctx, t, b, comp, crowd, 0, true, mt));
        comp[mt * 4 + f] += 1;
      }
    }
    if (out === -Infinity || (ctx.chainStop && out - ctx.v[t] < ctx.P.stopMargin)) out = ctx.v[t];
    ctx.memo.set(key, out);
    return out;
  }

  // One bite at tier t: the meal is gone and the eater rises. A chained bite
  // (after the first) can get the Barbed Collar's +1.
  // `crowd` counts the block before the bite, meal included, as the Muzzle
  // does.
  function bite(ctx, t, b, comp, crowd, extra, chained, mealTier = t) {
    let gain = (ctx.maul && b === MAMMOTH ? Math.max(1, mealTier + 2 - t) : 1) + extra;
    if (ctx.muzzle && crowd <= 4) gain += 2;
    if (ctx.skewer && b === RAT) gain += 1;
    if (ctx.crown && b === LION) gain += 2;
    const after = (g) => rise(ctx, Math.min(RAINBOW, t + g), comp, crowd - 1, ctx.fight ? b : -1);
    // The Rusty Saw (25%) and the Barbed Whip (35%) each may add +1.
    const s = ctx.saw ? 0.25 : 0;
    const w = ctx.whip ? 0.35 : 0;
    const sawed = (g) => (s || w ? (1 - s) * (1 - w) * after(g) + (s + w - 2 * s * w) * after(g + 1) + s * w * after(g + 2) : after(g));
    return -ctx.v[mealTier] + (chained && ctx.collar ? 0.2 * sawed(gain) + 0.8 * sawed(gain + 1) : sawed(gain));
  }

  // The highest meal tier an eater of beast b at tier t can take: its own,
  // or up to Supreme for a Mammoth with the Elephant-Foot Maul.
  function topMeal(ctx, t, b) {
    return ctx.maul && b === MAMMOTH ? RAINBOW - 1 : t;
  }

  // Expected change in value from a bite: the chosen meal, then the rest of
  // the chain. `chained` marks a bite inside a chain, after the first.
  // `comp` leaves out the eater and still holds the meal.
  function devourDelta(ctx, tier, beast, meal, scratch, comp, crowd, chained, mealTier = tier) {
    const i = mealTier * 4 + meal;
    if (!scratch) comp[i] -= 1;
    // A meal behind a scratched door isn't on the block, so the block doesn't
    // shrink when it's eaten.
    const value = bite(ctx, tier, beast, comp, scratch ? crowd + 1 : crowd, scratch ? ctx.scratchExtra : 0, chained, mealTier) - ctx.v[tier];
    if (!scratch) comp[i] += 1;
    return value;
  }

  // The best first meal for an eater of this tier and beast, by expected value.
  function bestMeal(ctx, tier, beast, comp, crowd) {
    let best = { value: -Infinity, meal: -1 };
    for (let mt = ctx.fight ? 0 : tier; mt <= topMeal(ctx, tier, beast); mt++) {
      for (const f of (mt !== tier ? ctx.countersAt(tier) : ctx.eatsAt(tier))[beast]) {
        if (!comp[mt * 4 + f]) continue;
        const value = devourDelta(ctx, tier, beast, f, false, comp, crowd, false, mt);
        if (value > best.value) best = { value, meal: f };
      }
    }
    return best;
  }

  // Exact odds that a devour's chain reaches Rainbow, and its expected bites,
  // for the explanation lines, when each later meal is picked for the best
  // odds. Uses the same rules as `rise`, without tools. It works for a pick
  // inside a chain too: `from` is the eater either way.
  function chainOdds(st, from, to) {
    const ctx = context(st, { tierBase: 1, rainbowMult: 1 });
    const eater = st.cells[from].inmate;
    const target = st.cells[to];
    const meal = target.sealed ? target.hidden : target.inmate;
    if (!eater || !meal) return { rainbow: 0, bites: 0 };
    const { comp } = composition(st, from);
    if (!target.sealed) comp[meal.tier * 4 + beastIndex(meal.beast)] -= 1;
    const memo = new Map();
    // Returns [P(reach Rainbow), expected further bites] from tier t, beast
    // re-rolling (under Cage Fight, staying `keep`).
    const fromTier = (t, keep) => {
      if (t >= RAINBOW) return [1, 0];
      const beasts = keep >= 0 ? [keep] : [0, 1, 2, 3];
      let p = 0;
      let n = 0;
      for (const b of beasts) {
        const [pb, nb] = eat(t, b);
        p += pb / beasts.length;
        n += nb / beasts.length;
      }
      return [p, n];
    };
    const eat = (t, b) => {
      let key = `${t}${b}`;
      for (let i = ctx.fight ? 0 : t * 4; i < 20; i++) key += String.fromCharCode(48 + comp[i]);
      if (memo.has(key)) return memo.get(key);
      // The player picks the meal with the best odds (then more bites).
      let out = null;
      for (let mt = ctx.fight ? 0 : t; mt <= topMeal(ctx, t, b); mt++) {
        for (const f of (mt !== t ? ctx.countersAt(t) : ctx.eatsAt(t))[b]) {
          if (!comp[mt * 4 + f]) continue;
          comp[mt * 4 + f] -= 1;
          const [pf, nf] = fromTier(ctx.maul && b === MAMMOTH ? Math.max(t + 1, mt + 2) : t + 1, ctx.fight ? b : -1);
          comp[mt * 4 + f] += 1;
          if (!out || pf > out[0] + 1e-12 || (Math.abs(pf - out[0]) <= 1e-12 && nf + 1 > out[1])) out = [pf, nf + 1];
        }
      }
      out = out || [0, 0];
      memo.set(key, out);
      return out;
    };
    const gain = target.sealed && target.scratch ? 1 + ctx.scratchExtra : ctx.maul && eater.beast === 'mammoth' ? Math.max(1, meal.tier + 2 - eater.tier) : 1;
    const [p, n] = fromTier(Math.min(RAINBOW, eater.tier + gain), ctx.fight ? beastIndex(eater.beast) : -1);
    return { rainbow: p, bites: 1 + n };
  }

  // ---------- Valuing positions and moves ----------

  // How ready the block is for chains: at each tier, the share of beasts an
  // eater could re-roll into and still find a meal there, weighted by tier.
  function stair(ctx, comp) {
    let value = 0;
    for (let t = 0; t < RAINBOW; t++) {
      let fed = 0;
      for (let b = 0; b < 4; b++) if (ctx.eatsAt(t)[b].some((f) => comp[t * 4 + f] > 0)) fed += 1;
      value += (fed / 4) * ctx.v[t];
    }
    return value;
  }

  // Change in readiness from adding (+1) or removing (-1) one inmate.
  function stairDelta(ctx, comp, tier, beast, sign) {
    if (!ctx.P.wStair || tier >= RAINBOW) return 0;
    const before = stair(ctx, comp);
    comp[tier * 4 + beast] += sign;
    const after = stair(ctx, comp);
    comp[tier * 4 + beast] -= sign;
    return ctx.P.wStair * (after - before);
  }

  // Expected readiness change from a new inmate with tier odds `dist`.
  function stairFresh(ctx, dist, comp) {
    if (!ctx.P.wStair) return 0;
    let sum = 0;
    for (let t = 0; t < dist.length; t++) for (let b = 0; b < 4; b++) if (dist[t]) sum += (dist[t] / 4) * stairDelta(ctx, comp, t, b, 1);
    return sum;
  }

  // What swapping an inmate of this tier is worth, on average. With the
  // Gaoler's Execution Axe, a higher roll also opens 2 doors. With the
  // Severed Iron Maiden, a roll with as many inmates above it as below it
  // gains 3 tiers.
  function swapValue(ctx, tier) {
    const dist = swapDist(ctx, tier);
    let value = dist.reduce((sum, p, t) => sum + p * (t >= RAINBOW ? ctx.R : ctx.v[t]), 0) - ctx.v[tier];
    if (ctx.axeDoors) value += dist.reduce((sum, p, t) => sum + (t > tier ? p : 0), 0) * ctx.axeDoors * ctx.P.wOpen * ctx.openValue;
    if (ctx.scapegoat) value -= ctx.scapegoat.loss;
    return value + maidenBonus(ctx, tier).value;
  }

  // Severed Iron Maiden, as its card reads: a swap of an inmate with as
  // many inmates above its rarity as below it (the block as it is, before
  // the Scapegoat's Guillotine removes any) brings the newcomer in 3 tiers
  // up. chance is 1 or 0; value is what the 3 tiers add on average.
  function maidenBonus(ctx, tier) {
    const out = { chance: 0, value: 0 };
    if (!ctx.maiden) return out;
    const counts = ctx.maiden.slice();
    if (counts[tier] > 0) counts[tier] -= 1;
    const above = counts.reduce((sum, n, u) => sum + (u > tier ? n : 0), 0);
    const below = counts.reduce((sum, n, u) => sum + (u < tier ? n : 0), 0);
    if (above !== below) return out;
    const dist = swapDist(ctx, tier);
    const val = (t) => (t >= RAINBOW ? ctx.R : ctx.v[t]);
    out.chance = 1;
    for (let t = 0; t < dist.length; t++) if (dist[t]) out.value += dist[t] * (val(Math.min(RAINBOW, t + 3)) - val(t));
    return out;
  }

  // Behind Closed Doors: the inmate in the warden's cell becomes a Supreme.
  // For a door not yet opened, its occupant's tier follows `dist`.
  function tricksterValue(ctx, dist) {
    return dist.reduce((sum, p, t) => sum + p * Math.max(0, ctx.v[T.SUPREME] - ctx.v[Math.min(t, T.SUPREME)]), 0);
  }

  // Ravenous Appetite: the lowest-rarity inmate on the block, the new one
  // from the door included, gets several tries at +1 tier. `low` is the
  // lowest tier on the block now; the newcomer's tier follows `dist`.
  function appetiteValue(ctx, low, dist) {
    const n = T.APPETITE_TRIES;
    const q = T.APPETITE_ODDS;
    const val = (t) => (t >= RAINBOW ? ctx.R : ctx.v[t]);
    let sum = 0;
    for (let t = 0; t < dist.length; t++) {
      if (!dist[t]) continue;
      const from = Math.min(t, low);
      let choose = 1;
      for (let k = 0; k <= n; k++) {
        if (k) choose = (choose * (n - k + 1)) / k;
        sum += dist[t] * choose * q ** k * (1 - q) ** (n - k) * (val(Math.min(RAINBOW, from + k)) - val(from));
      }
    }
    return sum;
  }

  // What an inmate can do once the warden stands with it: its best devour or
  // a swap, whichever is worth more, and never below zero (it can just wait).
  function activation(ctx, tier, beast, comp, crowd, swapLeft) {
    let value = 0;
    if (tier < RAINBOW) value = Math.max(value, bestMeal(ctx, tier, beast, comp, crowd).value);
    if (swapLeft && tier <= ctx.swapCap) value = Math.max(value, swapValue(ctx, tier));
    return value;
  }

  // What a brand-new inmate (tier odds `dist`) could do today, on average.
  function freshActivation(ctx, dist, comp, crowd, swapLeft) {
    let sum = 0;
    for (let t = 0; t < dist.length; t++) {
      if (!dist[t]) continue;
      for (let b = 0; b < 4; b++) sum += (dist[t] / 4) * activation(ctx, t, b, comp, crowd, swapLeft);
    }
    return sum;
  }

  // Felon's Dog Tag: the inmate behind a door the patrol opens rises a tier
  // 25% of the time, so its rarity odds shift up a little.
  function tagged(ctx, dist) {
    if (!ctx.dogtag) return dist;
    const out = dist.map((p) => 0.75 * p);
    dist.forEach((p, t) => (out[Math.min(out.length - 1, t + 1)] += 0.25 * p));
    return out;
  }

  // Expected value of a new inmate behind a door: its own worth plus what it
  // could do today from the warden's cell.
  function freshValue(ctx, dist, comp, crowd, swapLeft) {
    const worth = dist.reduce((sum, p, t) => sum + p * ctx.v[t], 0);
    return ctx.P.wOpen * worth + ctx.P.wNow * freshActivation(ctx, dist, comp, crowd, swapLeft) + stairFresh(ctx, dist, comp);
  }

  // Value of an Execution by an inmate of this tier and beast.
  function executionValue(ctx, tier, beast, comp) {
    const same = ctx.st.params.executionSameTier;
    const prey = T.FOOD_CHAIN[BEASTS[beast]].map(beastIndex);
    let count = 0;
    let lost = 0;
    for (let t = 0; t <= (same ? tier : tier - 1); t++) {
      if (same && t !== tier) continue;
      for (const f of prey) {
        count += comp[t * 4 + f];
        lost += comp[t * 4 + f] * ctx.v[t];
      }
    }
    if (!count) return 0;
    const to = Math.min(RAINBOW, tier + count);
    return (to >= RAINBOW ? ctx.R : ctx.v[to]) - ctx.v[tier] - lost;
  }

  // Why a door with a known event is worth opening.
  const EVENT_WHY = {
    execution: '門後有處刑效率在等',
    chain: '門後有連鎖反應在等',
    trickster: '那裡有暗箱操作在等：裡面的囚犯會變成至臻',
    appetite: '那裡有飢腸轆轆在等：稀有度最低的囚犯有 5 次機會各升一階',
    convict: '那裡有高危罪犯在等：另一間牢房會打開，裡面是傳奇',
    crow: '那裡有鴉之低語在等：會顯示接下來 4 扇上鎖牢門裡的稀有度',
    freedom: '那裡有自由的滋味在等：再打開 3 間上鎖的牢房',
    usurp1: '那裡有僭越 I 在等：隨機 1 隻囚犯升一階，並出現僭越 II',
    usurp2: '那裡有僭越 II 在等：隨機 2 隻囚犯升一階，並出現僭越 III',
    usurp3: '那裡有僭越 III 在等：隨機 2 隻囚犯升 2 階，並出現僭越 IV',
    usurp4: '那裡有僭越 IV 在等：每隻囚犯升 2 階',
    portion: '那裡有「有福同享」在等：最多 3 隻隨機囚犯升一階',
    ratway: '那裡有暗渠鼠道在等：免費移動到審訊室以外的任一間牢房',
    hunt: '那裡有尋「寶」在等：每扇關著普通或魔法的上鎖牢門都會顯示稀有度，所以其餘的都是稀有以上',
  };

  // What each event behind a door is worth, given the block's composition.
  // Each is a function, so only the ones needed are worked out.
  function eventWorth(ctx, comp) {
    const P = ctx.P;
    return {
      execution: () => {
        let exec = 0;
        for (let t = 0; t < ctx.openDist.length; t++) {
          for (let b = 0; b < 4; b++) exec += (ctx.openDist[t] / 4) * Math.max(0, executionValue(ctx, t, b, comp) - P.execMargin);
        }
        return exec;
      },
      chain: () => P.wChain,
      trickster: () => tricksterValue(ctx, ctx.openDist),
      appetite: () => {
        let low = Infinity;
        for (let i = 0; i < 20 && low === Infinity; i++) if (comp[i]) low = Math.floor(i / 4);
        return appetiteValue(ctx, low, ctx.openDist);
      },
      // A Legendary joins the block, from a cell that won't need a patrol.
      convict: () => P.wOpen * ctx.v[3],
      // Knowing what's behind 4 doors helps pick later patrols.
      crow: () => P.wCrow,
      // Three more doors open, with nobody to patrol there.
      freedom: () => T.FREEDOM_CELLS * P.wOpen * ctx.openValue,
      // A random inmate rises a tier, and Usurpation II (2 inmates) appears.
      // Each Usurpation raises inmates, then puts the next behind a locked door
      // and into the pool.
      usurp1: () => ctx.lift + 2 * ctx.lift * P.wUsurp,
      usurp2: () => 2 * ctx.lift + 2 * ctx.lift2 * P.wUsurp,
      usurp3: () => 2 * ctx.lift2 + ctx.allLift2 * P.wUsurp,
      usurp4: () => ctx.allLift2,
      // Up to 3 random inmates rise a tier.
      portion: () => Math.min(T.PORTION_INMATES || 3, ctx.boardCount) * ctx.lift,
      // A second move: to the best door anywhere, worth a fresh door at least.
      ratway: () => P.wOpen * ctx.openValue,
      // Like Crow Whispers, but it tells every locked door apart: the low
      // ones show, and the rest are Rare or better.
      hunt: () => P.wCrow * Math.max(1, ctx.sealed / T.CROW_CELLS),
    };
  }

  // The warden's office: Bestow raises 1 random inmate on the block a tier;
  // Instigate puts new events behind locked doors, worth an average event
  // each, discounted by wInstigate since a patrol still has to reach them.
  function officeValues(st, ctx, comp) {
    let bestow = 0;
    let count = 0;
    for (const c of st.cells) {
      if (c.sealed || !c.inmate || c.inmate.tier >= RAINBOW) continue;
      const t = c.inmate.tier;
      bestow += (t + 1 >= RAINBOW ? ctx.R : ctx.v[t + 1]) - ctx.v[t];
      count += 1;
    }
    bestow /= Math.max(1, count);
    // Cells an Instigate can put an event on (T.instigateCells; an engine
    // cached from before only took locked doors).
    const free = T.instigateCells ? T.instigateCells(st).length : st.cells.filter((c) => c.sealed && !c.event && !c.nest).length;
    const worth = eventWorth(ctx, comp);
    const pool = st.eventPool || T.EVENT_POOL;
    const each = pool.reduce((sum, id) => sum + worth[id](), 0) / pool.length;
    // Tyranny (a start card): every stop at the office also triggers 3 more
    // Bestows and 3 more Instigates by themselves.
    const extra = st.startEvent === 'tyranny' && T.START_EVENTS.tyranny ? T.START_EVENTS.tyranny.extra : 0;
    // An Instigate on a board with no event makes 2 (T.instigateCount);
    // after Tyranny's, the board has some.
    const first = T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS;
    const tyranny = extra ? extra * bestow + Math.min(first + (extra - 1) * T.INSTIGATE_EVENTS, free) * each * ctx.P.wInstigate : 0;
    const made = Math.min(extra ? T.INSTIGATE_EVENTS : first, free);
    // Undercurrents: each new event is an incident to walk to.
    const goal = ctx.incidentsLeft ? (ctx.P.wOfficeIncident * Math.min(made, ctx.incidentsLeft)) / ctx.incidentsLeft : 0;
    return { bestow, instigate: made * each * ctx.P.wInstigate + goal, tyranny };
  }

  // Scores today's destinations. Returns [{ cell, score, why }], best first.
  function patrolScores(st, ctx) {
    const P = ctx.P;
    const board = composition(st, -1);
    const swapLeft = canSwapNow(st);
    let fresh = null;
    const freshNow = () => (fresh === null ? (fresh = freshValue(ctx, tagged(ctx, ctx.openDist), board.comp, board.crowd + 1, swapLeft)) : fresh);
    const out = [];
    const range = Math.min(st.params.patrolRange || T.DEFAULT_PARAMS.patrolRange, T.CELL_COUNT - 1);
    for (const n of T.patrolOptions(st)) {
      const c = st.cells[n];
      // A door out of the warden's reach (a typed board with the warden in
      // the wrong cell) has no walk to count: one just behind the warden
      // would otherwise score as a walk most of the way round.
      // The Sewer Ratway's move isn't a walk either.
      const steps = !st.ratway && T.stepsBetween(st.position, n) <= range ? T.stepsBetween(st.position, n) : 0;
      let score = P.wStep * steps;
      let why;
      if (st.chain && !st.ratway) {
        const path = steps ? T.clockwisePath(st, n) : [n];
        const sealed = path.filter((k) => st.cells[k].sealed).length;
        score += P.wOpen * (sealed - (c.sealed ? 1 : 0)) * ctx.openValue + (c.sealed ? freshNow() : c.inmate ? P.wWalk * known(c) : 0);
        why = `連鎖反應會沿路打開 ${T.plural(sealed, '扇門')}`;
      } else if (c.sealed && c.nest) {
        score += P.wNest;
        why = `會摧毀第 ${c.nest.due} 天要孵化的鼠巢`;
      } else if (c.sealed) {
        // A door whose rarity shows (Crow Whispers, a scratch, the Scales)
        // is worth that rarity, and one a "Treasure" Hunt left dark is worth
        // the door odds from Rare up.
        const shown = c.known && c.hidden ? [0, 1, 2, 3, 4].map((t) => (t === Math.min(4, c.hidden.tier) ? 1 : 0)) : null;
        const dist = shown || (c.atLeast ? floorDist(ctx.openDist, c.atLeast) : null);
        score += dist ? freshValue(ctx, tagged(ctx, dist), board.comp, board.crowd + 1, swapLeft) : freshNow();
        // Executioner's Blacklist: opening this door leaves 5 or fewer locked,
        // so 2 random inmates rise a tier.
        if (ctx.blacklist && ctx.sealed - 1 <= 5) score += 2 * ctx.lift;
        // Lost Ring of Keys: the locked cells on both sides may open too.
        if (ctx.keys && P.wKeys) {
          const beside = [n + T.CELL_COUNT - 1, n + 1].map((k) => k % T.CELL_COUNT).filter((k) => st.cells[k].sealed).length;
          score += P.wKeys * 0.8 * beside * P.wOpen * ctx.openValue;
        }
        // Forged Key: 1 more random locked cell may open.
        if (ctx.forged && P.wForged && ctx.sealed > 1) score += P.wForged * 0.5 * P.wOpen * ctx.openValue;
        // Searing Branding Iron: a copy of whoever comes out may fill a locked cell.
        if (ctx.fire && P.wFire && ctx.sealed > 1) score += P.wFire * 0.35 * P.wOpen * ctx.openValue;
        const who = !shown && c.atLeast ? `一隻${T.tierName(c.atLeast)}以上的囚犯（尋「寶」沒點亮這扇門）` : '一隻新囚犯';
        why = `${who}，今天就可能吞噬`;
        const worth = eventWorth(ctx, board.comp);
        const pool = st.eventPool || T.EVENT_POOL;
        const anyEvent = () => pool.reduce((sum, id) => sum + worth[id](), 0) / pool.length;
        // Events show as they appear (no door hides one unseen); one whose
        // kind the player can't see is any of them, evenly.
        if (c.event && c.eventKnown === false) {
          score += anyEvent();
          why = '門後有獄中事變在等';
        } else if (c.event && worth[c.event]) {
          score += worth[c.event]();
          why = EVENT_WHY[c.event];
        }
      } else if (n === T.OFFICE) {
        const office = officeValues(st, ctx, board.comp);
        score += Math.max(office.bestow, office.instigate) + office.tyranny;
        why = office.bestow >= office.instigate ? '審訊室：賞賜讓 1 隻隨機囚犯升一階' : `審訊室：煽動帶來 ${T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS} 個新的獄中事變`;
        if (office.tyranny) why += `，而且暴政讓兩者各多 ${T.START_EVENTS.tyranny.extra} 次`;
      } else if (c.inmate) {
        score += P.wWalk * known(c);
        why = `那裡的${T.describe(c.inmate)}今天就能行動`;
        // Survival of the Fittest: a consume today counts toward its tool.
        if (ctx.consumesLeft && P.wConsumeWalk && T.devourOptions(st, n).length) {
          score += P.wConsumeWalk / ctx.consumesLeft;
          why += '，而且牠的吞噬能計入弱肉強食';
        }
        // An event waiting in an open cell goes off when the warden walks in.
        if (c.event) {
          const worth = eventWorth(ctx, board.comp);
          const pool = st.eventPool || T.EVENT_POOL;
          if (c.eventKnown === false || !worth[c.event]) {
            score += pool.reduce((sum, id) => sum + worth[id](), 0) / pool.length;
            why = `牢房裡有獄中事變，和那裡的${T.describe(c.inmate)}在一起`;
          } else {
            score += worth[c.event]();
            why = EVENT_WHY[c.event].replace('門後', '牢房裡');
          }
        }
      } else {
        why = '空牢房';
      }
      // Long-Chained Shackles: a walk of 4 or more may raise someone a tier.
      if (ctx.shacklesLift && steps >= 4) score += 0.4 * ctx.shacklesLift;
      // Short-Chained Shackles: a walk of 3 or fewer may open another door.
      if (ctx.shortchain && steps >= 1 && steps <= 3 && ctx.sealed > (c.sealed ? 1 : 0)) score += P.wShort * 0.5 * P.wOpen * ctx.openValue;
      // Prison Walk: each tile walked brings its tool closer.
      if (ctx.goalLeft) score += P.wGoal * Math.min(steps, ctx.goalLeft);
      // Undercurrents: an event set off here counts toward its tool (all the
      // way, with one to go), and one walked past waits a lap.
      if (ctx.incidentsLeft) {
        if (incidentAt(c)) {
          score += P.wIncident / ctx.incidentsLeft;
          if (P.wIncident) why = `${why}，而且能計入暗流湧動`;
        }
        if (steps > 1 && P.wPass) score -= (P.wPass * T.clockwisePath(st, n).filter((k) => k !== n && incidentAt(st.cells[k])).length) / ctx.incidentsLeft;
        // An event further ahead, within tomorrow's reach, stays ahead.
        const next = P.wPass ? [...Array(range).keys()].map((i) => (n + 1 + i) % T.CELL_COUNT).find((k) => k !== st.position && T.stepsBetween(st.position, k) > steps && incidentAt(st.cells[k])) : undefined;
        if (next !== undefined) why = `${why}，而且會停在 ${T.cellLabel(next)} 號牢房的事變之前，留給暗流湧動`;
      }
      out.push({ cell: n, score, why });
    }
    return out.sort((a, b) => b.score - a.score);

    // A Prison Incident: an event behind a door, or in an open cell with
    // an inmate (walking in sets it off).
    function incidentAt(cell) {
      return !!cell.event && (cell.sealed || !!cell.inmate);
    }

    function known(cell) {
      const { comp, crowd } = composition(st, cell.n);
      return activation(ctx, cell.inmate.tier, beastIndex(cell.inmate.beast), comp, crowd, swapLeft);
    }
  }

  // What a prey mark still promises: both inmates rise a tier each morning,
  // for the mornings left in the mark and in the run. A mark made on the
  // last day never pays: the riot comes before the next morning.
  function linkValue(st, ctx, link) {
    const rounds = Math.max(0, Math.min(link.rounds, (st.maxDays || T.DEFAULT_PARAMS.drillDays) - st.day));
    if (!rounds) return 0;
    let value = 0;
    for (const id of [link.lion, link.prey]) {
      const cell = T.cellOf(st, id);
      if (!cell || !cell.inmate) continue;
      const t = cell.inmate.tier;
      const to = Math.min(RAINBOW, t + rounds);
      value += (to >= RAINBOW ? ctx.R : ctx.v[to]) - ctx.v[t];
    }
    return value;
  }

  // The Blood-Stained Trap's best Hunt today: what its prey mark would
  // promise, at 80% for the chance it ends early (a side leaves the block or
  // changes beast). Null when there's no Hunt to make.
  function bestHunt(st, ctx) {
    if (!T.canHuntNow || !T.canHuntNow(st)) return null;
    const lion = st.cells[st.position].inmate;
    let best = null;
    for (const n of T.huntTargets(st)) {
      const value = 0.8 * linkValue(st, ctx, { lion: lion.id, prey: st.cells[n].inmate.id, rounds: st.params.preyRounds });
      if (!best || value > best.value) best = { cell: n, value };
    }
    return best;
  }

  // The prey mark an action would end, valued (0 if none).
  function linkLoss(st, ctx, inmate, certain) {
    const link = inmate && T.linkOf(st, inmate.id);
    if (!link) return 0;
    // A Lion that devours re-rolls its beast; 1 in 4 times it stays a Lion.
    return linkValue(st, ctx, link) * (certain || link.prey === inmate.id ? 1 : 0.75);
  }

  // Today's devour options for the warden's inmate, valued. Best first.
  // While a chain waits for a pick, they're the eater's next meals.
  function devourScores(st, ctx) {
    const here = st.cells[st.position];
    if (!here || here.sealed || !here.inmate) return [];
    const { comp, crowd } = composition(st, st.position);
    const tier = here.inmate.tier;
    const beast = beastIndex(here.inmate.beast);
    const own = linkLoss(st, ctx, here.inmate, false);
    const chained = !!st.chaining;
    return (chained ? T.chainOptions(st) : T.startOptions(st))
      .map((o) => {
        const target = st.cells[o.cell];
        const meal = o.scratch ? target.hidden : target.inmate;
        const mealLink = o.scratch ? 0 : linkLoss(st, ctx, meal, true);
        const sameLink = own && mealLink && T.linkOf(st, here.inmate.id) === T.linkOf(st, meal.id);
        const loss = sameLink ? Math.max(own, mealLink) : own + mealLink;
        const stairLoss = o.scratch ? 0 : stairDelta(ctx, comp, meal.tier, beastIndex(meal.beast), -1);
        // Crowded Beastcage: 40% of the time the meal's cell opens again with
        // someone new (the chain after the first bite isn't counted).
        const cage = ctx.cage ? ctx.P.wCage * 0.4 * ctx.P.wOpen * ctx.openValue : 0;
        return { cell: o.cell, score: devourDelta(ctx, tier, beast, beastIndex(meal.beast), !!o.scratch, comp, crowd, chained, o.scratch ? tier : meal.tier) - loss + stairLoss + cage };
      })
      .sort((a, b) => b.score - a.score);
  }

  // A swap in the warden's cell: the new inmate's worth over the old one,
  // less any prey mark it ends, plus the Tusk bonus if the cell has one.
  // None after today's devour: a day has one or the other.
  function swapGainHere(st, ctx) {
    const here = st.cells[st.position];
    if (!here || here.sealed || !here.inmate || !canSwapNow(st) || ctx.swapCap < 0) return -Infinity;
    let gain = swapValue(ctx, here.inmate.tier) - linkLoss(st, ctx, here.inmate, true);
    if (here.ivory) {
      const board = st.cells.filter((c) => !c.sealed && c.inmate && c.inmate.tier < RAINBOW);
      const lift = board.reduce((sum, c) => sum + ctx.v[c.inmate.tier + 1] - ctx.v[c.inmate.tier], 0) / Math.max(1, board.length);
      gain += Math.min(st.params.ivoryCount, board.length) * lift;
      return gain;
    }
    return here.inmate.tier <= ctx.swapCap ? gain : -Infinity;
  }

  // Board value for comparing gifts: tier values plus vaulted Rainbows, with
  // a bonus for inmates that have something to eat.
  function boardValue(st, ctx) {
    let value = st.vault.length * ctx.R;
    for (const c of st.cells) {
      if (c.sealed || !c.inmate) continue;
      value += ctx.v[c.inmate.tier] * (T.devourOptions(st, c.n).length ? 1.25 : 1);
    }
    return value;
  }

  // The run's last move is made: the last day, with today's consume,
  // Replace and Hunt out of reach and no chain going, so nothing a gift sets
  // up can add a Rainbow before the run ends (report 330).
  const lastMoveMade = (st) => st.day >= st.maxDays && !st.chaining && !T.canDevourNow(st) && !canSwapNow(st) && !(T.canHuntNow && T.canHuntNow(st));

  function pickGift(st, ctx, options, random) {
    const P = ctx.P;
    if (P.giftRank) return P.giftRank.find((id) => options.includes(id)) || options[0];
    // After the last move, a gift that makes a Rainbow now still comes
    // first; otherwise the Thumb Ring (the user, 2026-10-17: "thumb ring is
    // more overall chests at the end").
    if (lastMoveMade(st)) {
      let best = null;
      for (const id of options) {
        let gain = 0;
        for (let i = 0; i < 3; i++) {
          const trial = clone(st);
          trial.rng = (random() * 4294967296) >>> 0;
          if (T.choose(trial, id).ok) gain += trial.vault.length - st.vault.length;
        }
        if (gain > 0 && (!best || gain > best.gain)) best = { id, gain };
      }
      if (best) return best.id;
      if (options.includes('ring')) return 'ring';
    }
    // Opulence's chain (the user's find): the Brass Horn when it makes a
    // Rainbow now, as each brings 3 more picks; else the Thumb Ring while 3
    // or more picks wait (more inmates); else Crimson Vintage while 2 or more
    // wait (rarities line up for the Horn). On capped Opulence runs it
    // reached 10 Rainbows in 57% of runs, against 27% for the board-value
    // pick below; without the card it changes nothing (3.530 against 3.532).
    if (P.giftChain) {
      const left = st.pending.filter((p) => p.kind === 'gift').length;
      if (options.includes('horn')) {
        for (let i = 0; i < 3; i++) {
          const trial = clone(st);
          trial.rng = (random() * 4294967296) >>> 0;
          if (T.choose(trial, 'horn').ok && trial.vault.length > st.vault.length) return 'horn';
        }
      }
      if (left >= 3 && options.includes('ring') && st.cells.some((c) => c.sealed && c.n !== T.OFFICE)) return 'ring';
      if (left >= 2 && options.includes('wine') && st.cells.some((c) => !c.sealed && c.inmate && c.inmate.tier < T.SUPREME - 1)) return 'wine';
    }
    let best = null;
    for (const id of options) {
      let value = 0;
      const samples = id === 'ring' || id === 'horn' ? 3 : 1;
      for (let i = 0; i < samples; i++) {
        const trial = clone(st);
        trial.rng = (random() * 4294967296) >>> 0;
        if (!T.choose(trial, id).ok) continue;
        value += boardValue(trial, context(trial, P));
      }
      value /= samples;
      if (!best || value > best.value) best = { id, value };
    }
    return best ? best.id : options[0];
  }

  // What a Warden's Treasure gift does on this board, in a sentence, so the
  // advice says why (report 321: the Horn was advised, and the player saw
  // "nothing consumable", missing the one Lion with a meal).
  function giftEffect(st, id) {
    const board = st.cells.filter((c) => !c.sealed && c.inmate);
    const who = (c) => `${T.cellLabel(c.n)} 號的${T.describe(c.inmate)}`;
    const list = (cs) => (cs.length > 1 ? `${cs.slice(0, -1).map(who).join('、')}和${who(cs[cs.length - 1])}` : who(cs[0]));
    if (id === 'horn') {
      const eaters = board.filter((c) => T.devourOptions(st, c.n).length);
      if (!eaters.length) return '現在沒有囚犯有獵物可吃，所以銅號不會有任何效果。';
      if (eaters.length === 1) {
        const meals = T.devourOptions(st, eaters[0].n).map((o) => st.cells[o.cell]).filter((c) => c.inmate);
        return `每隻有獵物的囚犯各吞噬一隻：這裡是${who(eaters[0])}${meals.length ? `，牠的獵物是${list(meals)}` : ''}。`;
      }
      return `每隻有獵物的囚犯各吞噬一隻：這裡是${eaters.length > 3 ? ` ${eaters.length} 隻囚犯` : list(eaters)}。`;
    }
    if (id === 'wine') {
      const low = board.filter((c) => c.inmate.tier < T.SUPREME - 1);
      return low.length ? `每隻傳奇以下的囚犯升一階：這裡是${low.length > 3 ? ` ${low.length} 隻囚犯` : list(low)}。` : '沒有傳奇以下的囚犯，所以沒有人會升階。';
    }
    if (id === 'ring') {
      const locked = st.cells.filter((c) => c.sealed && c.n !== T.OFFICE).length;
      return locked ? `最多隨機打開 3 間上鎖的牢房（目前有 ${locked} 間上鎖）。` : '沒有上鎖的牢房，所以什麼都不會打開。';
    }
    if (id === 'brand') {
      const hungry = board.filter((c) => !T.devourOptions(st, c.n).length).length;
      return hungry ? `最多 4 隻沒有獵物的囚犯會換成有獵物可吃的野獸（目前有 ${hungry} 隻沒有）。` : '每隻囚犯都已經有獵物，所以沒有人會改變。';
    }
    return '';
  }

  // ---------- Instruments ----------

  // What each offered instrument adds to the ones already held, in Rainbows
  // per run: the measured set with it against the same set without it. With
  // more held than the data covers, the average over the held instruments'
  // measured subsets. Null when there's no data for these instruments.
  function toolGains(st, options) {
    const data = COMBOS && COMBOS.single;
    if (!data || !options.every((id) => data.ids.includes(id))) return null;
    if (!data.largest) data.largest = Math.max(...Object.keys(data.v).map((k) => k.length));
    const key = (ids) => ids.map((id) => String.fromCharCode(97 + data.ids.indexOf(id))).sort().join('');
    const value = (ids) => (ids.length ? data.v[key(ids)] : data.base);
    const held = st.tools.filter((id) => data.ids.includes(id));
    const size = Math.min(held.length, data.largest - 1);
    const subsets = [];
    const pick = (from, chosen) => {
      if (chosen.length === size) return subsets.push(chosen);
      for (let i = from; i < held.length; i++) pick(i + 1, [...chosen, held[i]]);
    };
    pick(0, []);
    const gains = {};
    for (const id of options) {
      let sum = 0;
      let n = 0;
      for (const sub of subsets) {
        const a = value([...sub, id]);
        const b = value(sub);
        if (a === undefined || b === undefined) continue;
        sum += a - b;
        n += 1;
      }
      if (!n) return null;
      gains[id] = sum / n;
    }
    return gains;
  }

  // A pet's re-roll: what the best instrument on offer adds, against what
  // the best of a new offer of 3 adds on average (every 3 the re-roll could
  // show, from the instruments neither held nor on offer, each drawn by its
  // odds: the instruments named for a beast are rare, T.toolWeight). Null
  // without measured sets.
  function rerollOdds(st, options) {
    const others = T.TOOL_IDS.filter((id) => !st.tools.includes(id) && !options.includes(id));
    const pool = others.length >= 3 ? others : T.TOOL_IDS.filter((id) => !st.tools.includes(id));
    const gains = toolGains(st, [...new Set([...options, ...pool])]);
    if (!gains || pool.length < 3) return null;
    // Every ordered draw of 3 cards, without putting one back.
    const w = pool.map((id) => (T.toolWeight ? T.toolWeight(st, id) : 1));
    const total = w.reduce((a, x) => a + x, 0);
    let next = 0;
    let mass = 0;
    for (let i = 0; i < pool.length; i++) {
      for (let j = 0; j < pool.length; j++) {
        if (j === i || total - w[i] <= 0) continue;
        const pij = (w[i] / total) * (w[j] / (total - w[i]));
        const rest = total - w[i] - w[j];
        if (rest <= 0) continue;
        for (let k = 0; k < pool.length; k++) {
          if (k === i || k === j) continue;
          const p = pij * (w[k] / rest);
          next += p * Math.max(gains[pool[i]], gains[pool[j]], gains[pool[k]]);
          mass += p;
        }
      }
    }
    return { now: Math.max(...options.map((id) => gains[id])), next: mass > 0 ? next / mass : 0 };
  }

  const signed = (v) => `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toFixed(2)}`;

  function wantsReroll(st, P, options) {
    if (!T.canReroll || !T.canReroll(st) || P.toolSets === false) return false;
    const odds = rerollOdds(st, options);
    return !!odds && odds.next > odds.now + P.rerollMargin;
  }

  // The instrument to take: the one that adds the most to what's held, or
  // the trained ranking's best when there's no measured data.
  function pickTool(st, P, options) {
    const gains = P.toolSets !== false && toolGains(st, options);
    if (gains) return options.reduce((best, id) => (gains[id] > gains[best] ? id : best));
    return P.toolRank.find((id) => options.includes(id)) || options[0];
  }

  // ---------- The strategy ----------

  // The move the strategy would play now, as an action object.
  function decide(st, params, random) {
    const ctx = context(st, params || paramsFor(st));
    const P = ctx.P;
    const roll = random || Math.random;
    if (st.phase === 'ended') return null;
    if (st.pending.length) {
      const choice = st.pending[0];
      if (choice.kind === 'gift') return { type: 'choose', id: pickGift(st, ctx, choice.options, roll) };
      if (choice.kind === 'tool' && wantsReroll(st, P, choice.options)) return { type: 'reroll' };
      return { type: 'choose', id: pickTool(st, P, choice.options) };
    }
    // A chain waiting for a pick takes the meal worth the most, or stops
    // (the game's Cancel) when none is worth eating.
    if (st.chaining) {
      const options = devourScores(st, ctx);
      if (ctx.chainStop && (!options.length || options[0].score < P.stopMargin)) return { type: 'stopchain' };
      return options.length ? { type: 'chain', to: options[0].cell } : { type: 'end' };
    }
    if (st.phase === 'office') {
      // Only one card on offer (the analyzer read the game's office cards).
      if (st.used && st.used.officeOnly) return { type: 'office', choice: st.used.officeOnly };
      if (P.office) return { type: 'office', choice: P.office };
      const office = officeValues(st, ctx, composition(st, -1).comp);
      return { type: 'office', choice: office.bestow >= office.instigate ? 'bestow' : 'instigate' };
    }
    if (st.phase === 'event' && st.event) {
      if (st.event.kind === 'chain') return { type: 'event', accept: !!P.acceptChain };
      // Ravenous Appetite, High-Risk Convict, Crow Whispers and Taste of
      // Freedom only add.
      // The Sewer Ratway's move can stay put, so it only adds too, and the
      // "Treasure" Hunt's card has only Confirm.
      if (['appetite', 'convict', 'crow', 'freedom', 'usurp1', 'usurp2', 'usurp3', 'usurp4', 'ratway', 'hunt', 'portion'].includes(st.event.kind)) return { type: 'event', accept: true };
      const exec = st.cells[st.event.cell].inmate;
      if (!exec) return { type: 'event', accept: false };
      // Behind Closed Doors: a free Supreme, unless it already is one.
      if (st.event.kind === 'trickster') return { type: 'event', accept: exec.tier < T.SUPREME };
      const { comp } = composition(st, st.event.cell);
      return { type: 'event', accept: executionValue(ctx, exec.tier, beastIndex(exec.beast), comp) > P.execMargin };
    }
    if (st.phase === 'patrol') {
      const scores = patrolScores(st, ctx);
      return scores.length ? { type: 'patrol', cell: scores[0].cell } : { type: 'end' };
    }
    // Manage: devour, swap or end the day. Both act on the warden's cell,
    // and a day has one or the other, not both. With the Blood-Stained Trap,
    // a Hunt on a Lion is the third choice.
    const swapGain = swapGainHere(st, ctx);
    const hunt = bestHunt(st, ctx);
    if (T.canDevourNow(st)) {
      const devours = devourScores(st, ctx);
      // Survival of the Fittest: a consume counts toward its tool.
      if (devours.length && ctx.consumesLeft && P.wConsume) devours[0] = Object.assign({}, devours[0], { score: devours[0].score + P.wConsume / ctx.consumesLeft });
      if (devours.length && devours[0].score >= P.minDevour) {
        if (hunt && hunt.value > devours[0].score && hunt.value > swapGain) return { type: 'hunt', to: hunt.cell };
        // The swap instead, when it's worth more than the best devour.
        if (swapGain > 0 && swapGain > devours[0].score + P.swapMargin) return { type: 'swap' };
        return { type: 'devour', to: devours[0].cell };
      }
    }
    if (hunt && hunt.value > 0 && hunt.value > swapGain) return { type: 'hunt', to: hunt.cell };
    if (swapGain > 0) return { type: 'swap' };
    return { type: 'end' };
  }

  function apply(st, action) {
    switch (action.type) {
      case 'choose': return T.choose(st, action.id);
      case 'reroll': return T.rerollOffer ? T.rerollOffer(st) : { ok: false };
      case 'event': return T.resolveEvent(st, action.accept);
      case 'patrol': return T.patrol(st, action.cell);
      case 'devour': return T.devour(st, st.position, action.to);
      case 'chain': return T.chainBite(st, action.to);
      case 'stopchain': return T.stopChain(st);
      case 'office': return T.officeAct(st, action.choice);
      case 'swap': return T.swap(st, st.position);
      case 'hunt': return T.hunt(st, action.to);
      case 'end': return T.endDay(st);
      default: return { ok: false, reason: '未知的動作。' };
    }
  }

  // Plays a run to the end with the strategy. `onMove` sees each move.
  function playout(st, params, random, onMove) {
    const roll = random || Math.random;
    // Rainbows can't grow past a full vault: the playout is done.
    const full = () => T.VAULT_SLOTS && st.vault.length >= T.VAULT_SLOTS;
    for (let guard = 0; st.phase !== 'ended' && guard < 2000 && !full(); guard++) {
      const action = decide(st, params, roll);
      if (!action) break;
      const result = apply(st, action);
      if (onMove) onMove(action, result, st);
      if (!result.ok && !(action.type !== 'end' && apply(st, { type: 'end' }).ok)) break;
    }
    return st;
  }

  // ---------- Monte Carlo solver ----------

  // A copy without the log, which playouts don't need.
  function clone(st) {
    const log = st.log;
    st.log = [];
    const copy = JSON.parse(JSON.stringify(st));
    st.log = log;
    return copy;
  }

  // Re-rolls everything the player can't see: the game's dice, and any
  // occupant behind a door that hasn't been fully revealed.
  function hideFuture(st, seed) {
    const random = rng32(seed);
    st.rng = (random() * 4294967296) >>> 0;
    for (const c of st.cells) {
      // An event whose kind the player can't see (behind a door, or in an
      // open cell) is any of them, evenly. Events to come turn up in the
      // playouts by the engine's own dice.
      const pool = st.eventPool || T.EVENT_POOL;
      if (c.event && c.eventKnown === false) c.event = pool[Math.floor(random() * pool.length)];
      if (!c.sealed || !c.hidden || c.known >= 2) continue;
      if (c.known === 1) c.hidden.beast = BEASTS[Math.floor(random() * 4)];
      else c.hidden = null;
    }
  }

  // The moves worth comparing at this point of the run, with labels.
  function candidates(st) {
    const out = [];
    if (st.phase === 'ended') return out;
    if (st.pending.length) {
      for (const id of st.pending[0].options) out.push({ action: { type: 'choose', id }, label: `選擇${T.toolName(id)}` });
      if (T.canReroll && T.canReroll(st)) out.push({ action: { type: 'reroll' }, label: '重抽這批選項' });
      return out;
    }
    if (st.chaining) {
      for (const o of T.chainOptions(st)) {
        const target = st.cells[o.cell];
        const meal = o.scratch ? '有劃痕的門' : T.describe(target.inmate);
        out.push({ action: { type: 'chain', to: o.cell }, label: `繼續連鎖：吃掉 ${T.cellLabel(o.cell)} 號的${meal}` });
      }
      if (T.canStopChain && T.canStopChain(st)) out.push({ action: { type: 'stopchain' }, label: '停止連鎖（取消）' });
      return out;
    }
    if (st.phase === 'office') {
      const only = st.used && st.used.officeOnly;
      if (!only || only === 'bestow') out.push({ action: { type: 'office', choice: 'bestow' }, label: '賞賜：1 隻隨機囚犯升一階' });
      if (!only || only === 'instigate') out.push({ action: { type: 'office', choice: 'instigate' }, label: `煽動：${T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS} 個新的獄中事變` });
      return out;
    }
    if (st.phase === 'event' && st.event) {
      // Event names that read as names (Behind Closed Doors) take no "the".
      const name = T.eventName(st.event.kind);
      // The "Treasure" Hunt's card has only Confirm.
      if (st.event.kind === 'hunt') {
        out.push({ action: { type: 'event', accept: true }, label: `確認${name}` });
        return out;
      }
      out.push({ action: { type: 'event', accept: true }, label: `接受${name}` });
      out.push({ action: { type: 'event', accept: false }, label: `略過${name}` });
      return out;
    }
    if (st.phase === 'patrol') {
      for (const n of T.patrolOptions(st)) {
        const c = st.cells[n];
        const opens = st.chain ? T.clockwisePath(st, n).filter((k) => st.cells[k].sealed).length : 0;
        const what = st.chain ? `連鎖反應打開 ${T.plural(opens, '扇門')}` : n === T.OFFICE ? '煽動或賞賜' : c.sealed ? (c.nest ? '鼠巢' : c.event ? '有事變的上鎖牢門' : '上鎖的牢門') : c.inmate ? T.describe(c.inmate) : '空牢房';
        // The office's card in the game reads "Go to Interrogation Room".
        const where = n === T.OFFICE ? '審訊室' : ` ${T.cellLabel(n)} 號牢房`;
        out.push({ action: { type: 'patrol', cell: n }, label: `前往${where}（${what}）` });
      }
      return out;
    }
    const here = st.cells[st.position];
    for (const o of T.startOptions(st)) {
      const target = st.cells[o.cell];
      const meal = o.scratch ? '有劃痕的門' : T.describe(target.inmate);
      out.push({ action: { type: 'devour', to: o.cell }, label: `吞噬 ${T.cellLabel(o.cell)} 號的${meal}` });
    }
    if (canSwapNow(st) && here && !here.sealed && here.inmate) {
      out.push({ action: { type: 'swap' }, label: `替換 ${T.cellLabel(here.n)} 號的${T.describe(here.inmate)}` });
    }
    // The Blood-Stained Trap's Hunt: a Prey mark on an inmate the Lion here can consume.
    if (T.canHuntNow && T.canHuntNow(st)) {
      for (const n of T.huntTargets(st)) out.push({ action: { type: 'hunt', to: n }, label: `尋獵：對 ${T.cellLabel(n)} 號的${T.describe(st.cells[n].inmate)}打上獵物標記` });
    }
    out.push({ action: { type: 'end' }, label: st.day >= st.maxDays ? '結束這一局' : '結束這一天' });
    return out;
  }

  const sameAction = (a, b) => !!a && !!b && a.type === b.type && a.cell === b.cell && a.to === b.to && a.id === b.id && a.accept === b.accept && a.choice === b.choice;

  // The standard error of the mean difference between two options' values on
  // the same dice (rounds an option couldn't play are NaN and skipped).
  function pairedSe(a, b) {
    let n = 0;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
      const d = a[i] - b[i];
      if (Number.isNaN(d)) continue;
      n += 1;
      sum += d;
      sq += d * d;
    }
    if (n < 2) return Infinity;
    const m = sum / n;
    return Math.sqrt(Math.max(0, sq / n - m * m) / n);
  }

  // Ranks played-out rows ({ label, action, vals, best, ... })
  // by value, after `rounds` of `target`. The analyzer also merges the rows
  // several workers played out with it: rows whose vals line up round by
  // round keep their common dice, and so their paired margins.
  function summarize(rows, rounds, target, goal) {
    const ranked = rows
      .map((r) => {
        let n = 0;
        let sum = 0;
        let sq = 0;
        for (const x of r.vals) {
          if (Number.isNaN(x)) continue;
          n += 1;
          sum += x;
          sq += x * x;
        }
        const mean = n ? sum / n : 0;
        const sd = n > 1 ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0;
        return { row: r, mean, se: n > 1 ? sd / Math.sqrt(n) : 0, n };
      })
      .sort((a, b) => b.mean - a.mean || b.row.best - a.row.best);
    const top = ranked[0];
    const options = ranked.map(({ row, mean, se, n }) => ({
      label: row.label,
      action: row.action,
      kind: row.kind,
      mean,
      se,
      gapSe: row === top.row ? 0 : pairedSe(top.row.vals, row.vals),
      n,
      best: n ? row.best / n : 0,
      policy: row.policy,
    }));
    return { done: rounds >= target || rows.length <= 1, rounds, goal, options };
  }

  // Plays every candidate out `rollouts` times and ranks them by value. Each
  // round of playouts shares its dice across candidates (common random
  // numbers), so the differences between moves are measured, not the luck;
  // `gapSe` is each option's paired margin against the leader.
  // Returns a stepper: call step(budgetMs) until it reports done.
  // `stream` splits the work between workers: each plays its own rounds of
  // dice, and the pick and candidates are the same in all (summarize merges
  // them).
  function solve(st, opts) {
    const o = Object.assign({ rollouts: 400, seed: 1, stream: 0, params: null }, opts || {});
    const base = clone(st);
    const list = candidates(base);
    const random = rng32(o.stream ? (o.seed ^ Math.imul(o.stream, 0x9e3779b1)) >>> 0 : o.seed);
    const pick = list.length ? decide(clone(base), o.params, rng32(o.seed ^ 0x5bd1e995)) : null;
    const goal = 'rainbows';
    const rows = list.map((c) => ({ label: c.label, action: c.action, kind: c.kind || null, vals: [], best: 0, policy: sameAction(c.action, pick) }));
    let round = 0;
    const result = () => summarize(rows, round, o.rollouts, goal);
    return {
      rows,
      step(budgetMs) {
        const stop = Date.now() + (budgetMs || 50);
        while (round < o.rollouts && rows.length > 1 && Date.now() < stop) {
          const seed = (random() * 4294967296) >>> 0;
          for (const row of rows) {
            const trial = clone(base);
            hideFuture(trial, seed);
            if (!apply(trial, row.action).ok) {
              row.vals.push(NaN);
              continue;
            }
            const roll = rng32(seed ^ 0x9e3779b9);
            playout(trial, o.params, roll);
            row.vals.push(trial.vault.length);
            // Second measure: the best rarity reached.
            row.best += Math.max(0, ...trial.cells.filter((c) => !c.sealed && c.inmate).map((c) => c.inmate.tier), trial.vault.length ? RAINBOW : 0);
          }
          round += 1;
        }
        return result();
      },
    };
  }

  // ---------- Trainer helpers ----------

  // The strategy's own pick with a short reason. Instant: no playouts.
  function instant(st, params) {
    const P = params || paramsFor(st);
    const action = decide(st, P, rng32(1));
    if (!action) return null;
    const match = candidates(st).find((c) => sameAction(c.action, action));
    return { action, label: match ? match.label : action.type, why: reason(st, action, P) };
  }

  function reason(st, action, params) {
    const ctx = context(st, params);
    const here = st.cells[st.position];
    switch (action.type) {
      case 'patrol': {
        const s = patrolScores(st, ctx).find((x) => x.cell === action.cell);
        return s ? `${s.why[0].toUpperCase()}${s.why.slice(1)}。` : '';
      }
      case 'devour': {
        const odds = chainOdds(st, st.position, action.to);
        // A day has a devour or a swap, not both.
        const over = swapGainHere(st, ctx) > 0 ? '這比在這裡替換更好，而一天只能二選一。' : '';
        return `最佳的第一口：之後每一口都挑得好的話，這條連鎖平均吃 ${odds.bites.toFixed(1)} 口，有 ${(100 * odds.rainbow).toFixed(0)}% 機率抵達綺彩。${over}`;
      }
      case 'chain': {
        const odds = chainOdds(st, st.position, action.to);
        return `最佳的下一口：每次都挑最好的繼續吃，這條連鎖平均還能再吃 ${odds.bites.toFixed(1)} 口，有 ${(100 * odds.rainbow).toFixed(0)}% 機率抵達綺彩。`;
      }
      case 'stopchain':
        return '剩下的獵物都不值得吃：每一口的損失都比收穫大，所以按取消，把牠們留在監區上。';
      case 'office':
        return action.choice === 'bestow' ? '現在就讓一隻隨機囚犯升一階，勝過多幾扇有事變的門。' : '監區上囚犯稀少，所以多幾扇有事變的門比升階更有價值。';
      case 'swap': {
        // A day has a swap or a devour, not both.
        const over = T.startOptions(st).length ? '這比今天最好的吞噬更好，而一天只能二選一。' : '';
        const maiden = maidenBonus(ctx, here.inmate.tier);
        const level = `比這隻${T.tierName(here.inmate.tier)}高和低的囚犯一樣多`;
        if (here.ivory) return `象牙牢房：替換這裡的囚犯會讓其他囚犯升一階${maiden.chance > 0 ? `，而且切開的人形棺讓新囚犯多升 3 階：${level}` : ''}。${over}`;
        if (ctx.scapegoat) return `替罪人的斷頭台讓新囚犯高於${T.tierName(here.inmate.tier)}${here.inmate.tier >= T.SUPREME ? '，也就是綺彩' : ''}，價值超過它隨機移除的 2 隻囚犯。${over}`;
        if (maiden.chance > 0) return `切開的人形棺讓新囚犯多升 3 階：${level}。${over}`;
        if (ctx.axeDoors) return `${T.tierName(here.inmate.tier)}囚犯的平均價值低於重新抽一隻，而且抽到更高稀有度時，獄卒的行刑巨斧會打開 ${T.plural(ctx.axeDoors, '扇門')}。${over}`;
        return `${T.tierName(here.inmate.tier)}囚犯的平均價值低於重新抽一隻。${over}`;
      }
      case 'hunt': {
        const prey = st.cells[action.to].inmate;
        const over = T.startOptions(st).length || swapGainHere(st, ctx) > 0 ? '這比今天的吞噬或替換更好，而一天只能三選一。' : '';
        return `獵物標記：只要兩者都留在監區上、野獸種類不變，這隻狂獅和那隻${T.describe(prey)}每天早上各升一階，持續 ${T.plural(st.params.preyRounds, '個早上')}。${over}`;
      }
      case 'end': {
        if (!T.canDevourNow(st) || !T.startOptions(st).length) return '今天已經沒有值得做的事了。';
        // A devour is skipped only when it costs more than it gains: nearly
        // always because it would end a prey mark.
        const marked = here && here.inmate && T.linkOf(st, here.inmate.id) ? here.inmate : T.startOptions(st).map((o) => st.cells[o.cell].inmate).find((m) => m && T.linkOf(st, m.id));
        if (marked) return '跳過今天的吞噬：它會結束獵物標記，而每天早上免費升的那一階比這一口更有價值。';
        return '今天這裡的每個吞噬都是損失大於收穫。';
      }
      case 'event': {
        if (st.event.kind === 'chain') return action.accept ? '你下一次行走會打開沿路所有上鎖的牢門。' : '今天監區上多了囚犯反而有害。';
        if (st.event.kind === 'trickster') {
          const who = st.cells[st.event.cell].inmate;
          return action.accept ? `這隻${T.describe(who)}會變成至臻，離綺彩只差一步。` : '牠已經是至臻了；接受只會改變牠的野獸種類。';
        }
        if (st.event.kind === 'appetite') return `稀有度最低的囚犯有 ${T.APPETITE_TRIES} 次機會各升一階，平均升 ${(T.APPETITE_TRIES * T.APPETITE_ODDS).toFixed(1)} 階。`;
        if (st.event.kind === 'convict') return '另一間牢房會打開，裡面是傳奇囚犯，不需要巡視。';
        if (st.event.kind === 'crow') return `免費情報：接下來 ${T.CROW_CELLS} 扇上鎖牢門裡的稀有度。`;
        if (st.event.kind === 'portion') return `免費升階：最多 ${T.PORTION_INMATES} 隻隨機囚犯升一階。`;
        if (st.event.kind === 'freedom') return `免費囚犯：再打開 ${T.FREEDOM_CELLS} 間上鎖的牢房。`;
        if (st.event.kind === 'usurp1') return '隨機 1 隻囚犯升一階，並把僭越 II 加入事變。';
        if (st.event.kind === 'usurp2') return '隨機 2 隻囚犯升一階，並把僭越 III 加入事變。';
        if (st.event.kind === 'usurp3') return '隨機 2 隻囚犯各升 2 階，並把僭越 IV 加入事變。';
        if (st.event.kind === 'usurp4') return '監區上每隻囚犯都升 2 階。';
        if (st.event.kind === 'ratway') return '免費移動到審訊室以外的任一間牢房：整個監區最好的門或囚犯，不只是接下來的六間牢房。';
        if (st.event.kind === 'hunt') return '免費情報，而且它的卡片只有確認可按：每扇關著普通或魔法的上鎖牢門都會顯示稀有度，所以沒被點亮的門裡都是稀有以上。';
        const exec = st.cells[st.event.cell].inmate;
        const victims = T.executionVictims(st, st.event.cell).length;
        return action.accept ? `這隻${T.describe(exec)}會移除 ${T.plural(victims, '隻囚犯')}並升同樣多階：得大於失。` : '它移除的比得到的還多。';
      }
      case 'choose': {
        if (st.pending[0].kind === 'gift') {
          // Opulence: more picks wait at this Treasure, and the advice
          // weighs them.
          const picks = st.pending.filter((p) => p.kind === 'gift').length;
          if (lastMoveMade(st) && action.id === 'ring') return '今天的動作已經做完，所以在這局結束前，沒有任何珍藏能再多收容一隻綺彩。三首扳指最多再打開 3 間牢房，結算時能多開幾個寶箱。';
          const worth = picks > 1 ? `考慮到之後的選擇，在這個盤面上最有價值：這次典獄長的珍藏共有 ${picks} 次選擇，包括這一次。` : '在目前的盤面上最有價值。';
          const what = giftEffect(st, action.id);
          return what ? `${what} ${worth}` : worth;
        }
        const gains = ctx.P.toolSets !== false && toolGains(st, st.pending[0].options);
        if (gains && gains[action.id] !== undefined) {
          const add = gains[action.id];
          const held = st.tools.length === 1 ? `搭配${T.toolName(st.tools[0])}，它` : st.tools.length ? '搭配你持有的刑具，它' : '它';
          const odds = T.canReroll && T.canReroll(st) ? rerollOdds(st, st.pending[0].options) : null;
          const vs = odds ? `重抽後最好的一件平均約 ${signed(odds.next)}。` : '';
          return `${held}在模擬中每局約多收容 ${signed(add)} 隻綺彩。${vs}`;
        }
        const rank = ctx.P.toolRank.indexOf(action.id);
        return rank >= 0 ? `訓練排名：${ctx.P.toolRank.length} 件刑具中的第 ${rank + 1} 名。` : '';
      }
      case 'reroll': {
        const odds = rerollOdds(st, st.pending[0].options);
        return odds
          ? `目前選項中最好的刑具每局約多 ${signed(odds.now)} 隻綺彩；重抽一批後，最好的一件平均約多 ${signed(odds.next)}。`
          : '重抽一批很可能會出現更好的刑具。';
      }
      default: return '';
    }
  }

  // The move that turned `before` into `after`, as an action, or null if it
  // wasn't a game move (a Lab edit, say).
  function moveBetween(before, after) {
    if (!before || !after || before.phase === 'ended') return null;
    // The log entries the move added. The log only grows, though it drops its
    // oldest lines, so find where the last few lines it had before now sit.
    const n = before.log.length;
    const tail = Math.min(5, n);
    const same = (a, b) => a && b && a.d === b.d && a.k === b.k && a.t === b.t;
    const fits = (p) => {
      for (let k = 1; k <= tail; k++) if (!same(after.log[p - k], before.log[n - k])) return false;
      return true;
    };
    let from = 0;
    for (let p = Math.min(after.log.length, n); p >= tail; p--) {
      if (fits(p)) {
        from = p;
        break;
      }
    }
    const added = after.log.slice(from);
    const recent = (types) => {
      for (const e of added) if (e.x && types.includes(e.x.type)) return e.x;
      return null;
    };
    // While a choice is pending, nothing but the choice can be made.
    if (before.pending.length) {
      const x = recent(['tool', 'gift']);
      return x ? { type: 'choose', id: x.id } : null;
    }
    if (before.phase === 'event') {
      if (after.phase === 'event') return null;
      const x = recent(['skipped', 'armed', 'execution', 'trickster', 'appetite', 'convict', 'crow', 'freedom', 'usurp1', 'usurp2', 'usurp3', 'usurp4', 'ratway', 'hunt', 'portion']);
      return x ? { type: 'event', accept: x.type !== 'skipped' } : null;
    }
    if (before.phase === 'office') {
      const x = recent(['instigate', 'bestow']);
      return x ? { type: 'office', choice: x.type } : null;
    }
    // A pick inside a chain: the bite after the ones the chain had. A chain
    // that ended logs its record where it began, before the lines compared.
    if (before.chaining) {
      const n = before.chaining.bites.length;
      const done = [...after.log].reverse().find((e) => e.x && e.x.type === 'devour');
      const bites = after.chaining ? after.chaining.bites : done ? done.x.bites : null;
      if (bites && bites[n]) return { type: 'chain', to: bites[n].cell };
      return !after.chaining && after.phase !== 'ended' ? { type: 'stopchain' } : null;
    }
    // The Sewer Ratway's move isn't counted as a patrol.
    if (before.phase === 'patrol') return after.stats.patrols > before.stats.patrols || (before.ratway && !after.ratway) ? { type: 'patrol', cell: after.position } : null;
    if (after.used.devour > before.used.devour) {
      if (after.chaining) return { type: 'devour', to: after.chaining.bites[0].cell };
      const x = recent(['devour']);
      return x ? { type: 'devour', to: x.bites[0].cell } : null;
    }
    if (after.used.swap > before.used.swap) return { type: 'swap' };
    // The Blood-Stained Trap's Hunt, which logs the marked cell.
    if (after.used.hunt && !before.used.hunt) {
      const x = recent(['trap']);
      return x ? { type: 'hunt', to: x.cell } : null;
    }
    if (after.day > before.day || after.phase === 'ended') return { type: 'end' };
    return null;
  }

  const api = { DEFAULTS, PROFILES, paramsFor, instant, moveBetween, sameAction, decide, apply, playout, candidates, solve, summarize, chainOdds, patrolScores, devourScores, context, composition, clone, hideFuture, rng32, executionValue };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TartarusSolver = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
