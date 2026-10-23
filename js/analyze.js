/* Tartarus Simulator: board analyzer.
 * The player sets up their board by hand: every cell, the warden, today's
 * doors, tools and vault. The page turns that into an engine state
 * and asks js/solver.js for the best move: the trained strategy's pick right
 * away, then a live check that plays every option out many times. "Do it here"
 * plays the move with the simulator's dice, so the player only has to fix what
 * came out differently in their game. Each board the player asks about is
 * handed to js/live.js, which shares runs of them to measure live's odds. */
(function () {
  'use strict';

  const T = window.Tartarus;
  const S = window.TartarusSolver;
  const B = window.TartarusBoard;
  const SHARE = window.TartarusLive || null;
  // The event kinds and steps the live collector (worker/) accepts.
  const COLLECTOR_EVENTS = ['unknown', 'chain', 'execution'];
  const COLLECTOR_STEPS = ['patrol', 'manage', 'event', 'choice'];
  // The moves "Do it here" can record that the deployed collector knows.
  const COLLECTOR_ACTIONS = ['patrol', 'devour', 'swap', 'end', 'event', 'choose'];
  const $ = (id) => document.getElementById(id);
  const L = (n) => T.cellLabel(n);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Short notes on playing the run's instruments, the pairs among them the
  // lab found worth more or less together, and its start card (js/tips.js;
  // the user, 2026-10-22).
  function renderPlayNotes() {
    const box = document.getElementById('az-play-notes');
    const tips = window.TartarusTips;
    if (!box || !tips) return;
    const names = {};
    for (const id of T.TOOL_IDS) names[id] = T.toolName(id).split(/[:：]/)[0];
    for (const id of Object.keys(T.START_EVENTS || {})) names[id] = T.START_EVENTS[id].name;
    const notes = tips.notesFor(model.tools || [], model.startEvent, names);
    box.hidden = !notes.length;
    document.getElementById('az-play-notes-list').innerHTML = notes.map((n) => `<li class="az-play-note az-play-${n.kind}"><b>${esc(n.title)}.</b> ${esc(n.text)}</li>`).join('');
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const toInt = (v, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : fallback;
  };
  // This script's version tag, so the solver worker loads matching files.
  const SCRIPT_QUERY = (() => {
    const src = document.currentScript ? document.currentScript.src : '';
    const q = src.indexOf('?');
    return q >= 0 ? src.slice(q) : '';
  })();

  const KEY = 'tartarus-sim:analyzer:v1';
  // Whether a screenshot opens after it's read. Off (the default), it's
  // read into the board and stays hidden until the player opens it.
  const SHOTS_KEY = 'tartarus-sim:analyzer:show-screenshots';
  let showShots = false;
  try {
    showShots = localStorage.getItem(SHOTS_KEY) === '1';
  } catch (e) {
    // Without storage, screenshots stay hidden.
  }
  const SAVE_KEY = 'tartarus-sim:save:v2';
  const PLAYOUT_BUDGET = 9600; // playouts per check, shared across the options
  const LIVE_MIN = 150; // playouts per option before the live check can lead
  const SWITCH_MIN = 0.05; // Rainbows a live pick must gain over the strategy's to replace it
  // The check ends early once the leader is ahead of every other move by
  // CLEAR_SE of its paired margins (after LIVE_MIN playouts each), and in any
  // case after CHECK_MS, with what it has then. The user: a decision within a
  // second of the picture, "faster is way better".
  const CLEAR_SE = 3;
  const CHECK_MS = 700;
  const STEPS = ['patrol', 'manage', 'office', 'chain', 'event', 'ratway', 'choice'];
  const STEP_NAMES = { patrol: '選擇要巡視的門', manage: '巡視之後', office: '煽動或賞賜', chain: '選一個獵物，或取消', event: '獄中事變', ratway: '暗渠鼠道：任選牢房', choice: '刑具或珍藏' };
  // 目標的英文名稱，給 OCR 比對遊戲英文畫面用（engine 的 name 是中文）。
  const OBJECTIVE_EN = { king: 'King of the Caged', walk: 'Prison Walk', consume: 'Survival of the Fittest', incident: 'Undercurrents', doors: 'Behind Cell Doors', other: 'Another objective' };
  const BEAST_KEYS = { m: 'mammoth', l: 'lion', w: 'wolf', r: 'rat' };
  const TOP_TIER = T.SUPREME; // Rainbows leave for the vault, so cells hold Normal to Supreme

  const store = {
    get(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  // ---------- The board model ----------
  // What the player entered, in their terms. buildState() turns it into an
  // engine state, and modelFrom() turns an engine state back into a model.

  const officeCell = () => ({ kind: 'office' });
  const sealedCell = () => ({ kind: 'sealed', event: null });

  // What a cell holds, ignoring leftover fields and their order, so cells
  // from the reader or older edits compare equal when they hold the same.
  function cellSig(c) {
    switch (c.kind) {
      case 'inmate': return ['inmate', c.beast, toInt(c.tier, 0), !!c.ivory, c.prey ? [c.prey.cell, c.prey.rounds] : null, c.event || ''].join('|');
      case 'scratch': return ['scratch', toInt(c.tier, 0), c.event || ''].join('|');
      case 'revealed': return ['revealed', toInt(c.tier, 0), c.event || ''].join('|');
      case 'scouted': return ['scouted', c.beast, toInt(c.tier, 0), c.event || ''].join('|');
      case 'sealed': return ['sealed', c.event || '', toInt(c.atLeast, 0)].join('|');
      case 'nest': return ['nest', toInt(c.due, 0)].join('|');
      default: return c.kind;
    }
  }

  function blankModel() {
    return {
      v: 1,
      mode: 'drill',
      // The game has one food chain. Shared boards still say which.
      chain: 'single',
      rewards: true,
      day: 1,
      maxDays: T.DEFAULT_PARAMS.drillDays,
      step: 'patrol',
      warden: T.OFFICE,
      dest: [],
      devourUsed: false,
      swapUsed: false,
      // The game offers a consume after today's swap (it shows the button,
      // or Follow my game saw it in the log): only then is one advised.
      consumeOffered: false,
      // A Warden's Treasure waiting for the board behind it (treasureWait),
      // and the board seen since it opened (treasureSeen).
      treasureWait: false,
      treasureSeen: false,
      // Set when a screenshot's instrument panel disagrees with the run's
      // instruments: the player is asked to confirm them. Once confirmed
      // (toolsLocked), they stay for the run and aren't asked about again.
      toolsToConfirm: '',
      toolsLocked: false,
      // The panel's count at the last confirmation (toolsSeen) and in the
      // last picture (toolsPanel): only a panel showing more asks again.
      toolsSeen: 0,
      toolsPanel: 0,
      // Days of this run whose morning offered a door short (see scanToModel).
      shortDays: [],
      // The game shows no Replace / Consume card now (read from a screenshot):
      // that move isn't advised, and the other one still can be. noHunt: no
      // Hunt (the Blood-Stained Trap) on offer either.
      noSwap: false,
      noDevour: false,
      noHunt: false,
      // The cells the game framed on the Hunt's pick (only those can be
      // marked), while it's open.
      huntOnly: null,
      // The office shows one card only (read from a screenshot): 'bestow' or
      // 'instigate'.
      officeOnly: null,
      // The meals the game framed on a meal pick (only those can be eaten).
      mealOnly: null,
      eventKind: 'chain',
      // rerolls: a pet's re-rolls left on an instrument offer. picks: the
      // Warden's Treasure picks waiting, this one included (3 a Treasure
      // with Opulence).
      choice: { kind: 'tool', options: [], rerolls: 0, picks: 1 },
      chainArmed: false,
      // Until the player sets it, no objective's tool is assumed.
      objective: 'other',
      // A card shown before the run, besides its objective (T.START_EVENTS).
      startEvent: 'none',
      walkTiles: 0,
      milestone: false,
      tools: [],
      vault: [],
      cells: Array.from({ length: T.CELL_COUNT }, (_, n) => (n === T.OFFICE ? officeCell() : sealedCell())),
    };
  }

  // Fills in anything a saved model lacks, so older saves keep working.
  function normalize(m) {
    const base = blankModel();
    if (!m || typeof m !== 'object' || !Array.isArray(m.cells) || m.cells.length !== T.CELL_COUNT) return base;
    const out = Object.assign(base, m);
    // Every board is a drill: the contract challenge is gone (it isn't in
    // the live game), and a board saved in it goes on as a drill.
    out.mode = 'drill';
    delete out.ch;
    delete out.windowKind;
    out.choice = Object.assign(blankModel().choice, m.choice || {});
    out.choice.rerolls = clamp(toInt(out.choice.rerolls, 0), 0, 9);
    out.choice.picks = clamp(toInt(out.choice.picks, 1), 1, 30);
    out.cells = m.cells.map((c, n) => (n === T.OFFICE ? officeCell() : Object.assign(sealedCell(), c)));
    out.dest = Array.isArray(m.dest) ? m.dest.filter((n) => Number.isInteger(n) && n >= 0 && n < T.CELL_COUNT) : [];
    if (!STEPS.includes(out.step)) out.step = 'patrol';
    if (out.objective === 'cagefight') {
      out.startEvent = 'cagefight';
      out.objective = 'other';
    }
    if (!T.START_EVENTS || !T.START_EVENTS[out.startEvent]) out.startEvent = 'none';
    if (!T.OBJECTIVES[out.objective]) out.objective = 'other';
    // Progress on an objective counted to a number (tiles, consumes, ...).
    out.walkTiles = clamp(toInt(out.walkTiles, 0), 0, T.OBJECTIVES[out.objective].need || 0);
    out.chain = 'single';
    return out;
  }

  // The engine state for a model, and anything that stops it from being
  // analyzed. Events the player can't name get a kind the solver re-rolls.
  function buildState(m) {
    const problems = [];
    const params = { rewards: !!m.rewards, drillDays: clamp(toInt(m.maxDays, 20), 5, 60) };
    const st = T.newGame({ params, seed: 'ANALYZER' });
    st.rng = (Math.random() * 4294967296) >>> 0;
    st.log = [];
    st.day = clamp(toInt(m.day, 1), 1, st.maxDays);
    st.nextId = 1;
    const make = (beast, tier) => ({ id: st.nextId++, beast: T.BEASTS.includes(beast) ? beast : 'mammoth', tier: clamp(toInt(tier, 0), 0, TOP_TIER) });
    st.cells = m.cells.map((c, n) => {
      const cell = { n, sealed: n !== T.OFFICE, inmate: null, hidden: null, known: 0, scratch: false, nest: null, event: null, ivory: false };
      if (n === T.OFFICE) return cell;
      // Doors marked with an event ("!") have been passed; the rest may still
      // hide one the player can't see.
      const setEvent = () => {
        cell.seen = !!c.event;
        if (!c.event) return;
        cell.event = T.EVENTS[c.event] ? c.event : 'chain';
        if (c.event === 'unknown') cell.eventKnown = false;
      };
      if (c.kind === 'empty') cell.sealed = false;
      else if (c.kind === 'inmate') {
        cell.sealed = false;
        cell.inmate = make(c.beast, c.tier);
        if (c.marked) cell.inmate.marked = true;
        cell.ivory = !!c.ivory;
        // An event can wait in an open cell ("Can trigger Prison Incident").
        setEvent();
      } else if (c.kind === 'nest') {
        // A nest due today hatched this morning, so a sealed one is due later.
        cell.nest = { due: Math.max(st.day + 1, toInt(c.due, st.day + 1)) };
      } else if (c.kind === 'scouted') {
        cell.known = 2;
        cell.hidden = make(c.beast, c.tier);
        setEvent();
      } else if (c.kind === 'scratch' || c.kind === 'revealed') {
        // The rarity shows; the beast stays hidden (re-rolled by the solver).
        cell.scratch = c.kind === 'scratch';
        cell.known = 1;
        cell.hidden = make(T.BEASTS[Math.floor(Math.random() * 4)], c.tier);
        setEvent();
      } else {
        // A door the "Treasure" Hunt left dark holds Rare or better.
        cell.atLeast = c.kind === 'sealed' ? clamp(toInt(c.atLeast, 0), 0, TOP_TIER) : 0;
        setEvent();
      }
      return cell;
    });

    // Prey marks: a Lion and the same-rarity meal it marked.
    st.prey = [];
    m.cells.forEach((c, n) => {
      if (c.kind !== 'inmate' || c.beast !== 'lion' || !c.prey) return;
      const lion = st.cells[n].inmate;
      const target = st.cells[c.prey.cell];
      if (!target || !target.inmate || !T.canEat(st, lion, target.inmate)) {
        problems.push(`${L(n)} 號牢房的獵物標記需要指向 ${L(c.prey.cell)} 號牢房中、和這隻狂獅同稀有度的獵物。`);
        return;
      }
      if (st.prey.some((l) => [l.lion, l.prey].includes(target.inmate.id) || [l.lion, l.prey].includes(lion.id))) {
        problems.push(`${L(c.prey.cell)} 號牢房已經有獵物標記了。`);
        return;
      }
      st.prey.push({ lion: lion.id, prey: target.inmate.id, preyBeast: target.inmate.beast, rounds: clamp(toInt(c.prey.rounds, 1), 1, 9), next: st.day + 1 });
    });

    st.vault = m.vault.filter((b) => T.BEASTS.includes(b)).map((beast) => ({ id: st.nextId++, beast, day: 1 }));
    st.cache = st.vault.length;
    st.tools = T.TOOL_IDS.filter((id) => m.tools.includes(id));
    st.position = clamp(toInt(m.warden, 0), 0, T.CELL_COUNT - 1);
    st.chain = !!m.chainArmed;
    const need = (T.OBJECTIVES[m.objective] && T.OBJECTIVES[m.objective].need) || 0;
    st.objective = { id: m.objective, progress: need ? clamp(toInt(m.walkTiles, 0), 0, need) : 0 };
    st.startEvent = m.startEvent !== 'none' ? m.startEvent : null;
    st.milestone = !!m.milestone || (need > 0 && st.objective.progress >= need);
    st.stats.best = Math.max(0, ...st.cells.filter((c) => c.inmate).map((c) => c.inmate.tier), st.vault.length ? T.RAINBOW : 0);
    st.used = { swap: 0, devour: 0 };
    st.destinations = [];
    st.event = null;
    st.pending = [];
    st.phase = 'manage';

    const usedToday = () => {
      st.used = { swap: m.swapUsed ? 1 : 0, devour: m.devourUsed ? 1 : 0, devourAfterSwap: !!m.consumeOffered, noSwap: !!m.noSwap, noDevour: !!m.noDevour, noHunt: !!m.noHunt, huntOnly: Array.isArray(m.huntOnly) ? m.huntOnly.slice() : null, officeOnly: m.officeOnly || null, mealOnly: Array.isArray(m.mealOnly) ? m.mealOnly.slice() : null };
    };
    switch (m.step) {
      case 'patrol': {
        st.phase = 'patrol';
        st.destinations = [...new Set(m.dest)]
          .filter((n) => Number.isInteger(n) && n >= 0 && n < T.CELL_COUNT && n !== st.position)
          .sort((a, b) => T.stepsBetween(st.position, a) - T.stepsBetween(st.position, b));
        if (!st.destinations.length) problems.push('請標出今天的門：在「選擇目的地」下點亮它們，或選一間牢房後按「今天的門」。');
        // Doors are always among the cells just ahead of the warden, clockwise.
        // One outside them means the warden (or the door) is in the wrong
        // cell, and the advice would send the warden most of the way round.
        const range = st.params.patrolRange;
        const reach = (w, n) => T.stepsBetween(w, n) >= 1 && T.stepsBetween(w, n) <= range;
        const doors = [...new Set(m.dest)].filter((n) => Number.isInteger(n) && n >= 0 && n < T.CELL_COUNT);
        const outside = doors.filter((n) => !reach(st.position, n));
        // The game's tutorial run scripts its doors: the warden in 05 with
        // doors 06, 08 and 14, seen on dozens of players' boards (report 34).
        // No other run has shown a door past the six cells ahead.
        const tutorial = st.position === 4 && doors.length === 3 && [5, 7, 13].every((n) => doors.includes(n));
        if (outside.length && !tutorial) {
          const fits = [];
          for (let w = 0; w < T.CELL_COUNT; w++) if (doors.every((n) => reach(w, n))) fits.push(L(w));
          const where = fits.length > 1 ? `${fits.slice(0, -1).join('、')} 或 ${fits[fits.length - 1]}` : fits[0];
          problems.push(`門一定在典獄長順時針前方的 ${range} 間牢房之內，但 ${outside.map(L).join('、')} 號牢房不在範圍內：典獄長目前設在 ${L(st.position)} 號牢房。${fits.length ? `請檢查典獄長的位置：照這些門來看，典獄長應該在 ${where} 號牢房。` : '沒有任何一間牢房能同時搆到這些門，所以也請檢查門。'}`);
        }
        break;
      }
      case 'ratway': {
        // The Sewer Ratway's "Select an Objective": any cell but the office,
        // after the day's patrol.
        st.phase = 'patrol';
        st.ratway = true;
        st.destinations = st.cells.filter((c) => c.n !== T.OFFICE).map((c) => c.n);
        break;
      }
      case 'event': {
        const here = st.cells[st.position];
        if (!here || here.sealed || !here.inmate) problems.push('獄中事變需要從門後出來的囚犯在典獄長所在的牢房：把典獄長放在那裡，並設定那名囚犯。');
        st.phase = 'event';
        st.event = { kind: T.EVENTS[m.eventKind] ? m.eventKind : 'chain', cell: st.position };
        break;
      }
      case 'choice': {
        usedToday();
        const kind = m.choice.kind === 'gift' ? 'gift' : 'tool';
        const options = kind === 'gift' ? T.GIFT_IDS.slice() : [...new Set(m.choice.options)].filter((id) => T.TOOLS[id] && !st.tools.includes(id));
        if (!options.length) problems.push('請選出可選的刑具。');
        st.pending = [{ kind, options, rerolls: kind === 'tool' ? m.choice.rerolls || 0 : 0 }];
        // The Treasure's picks still waiting after this one (Opulence).
        if (kind === 'gift') for (let k = 1; k < clamp(toInt(m.choice.picks, 1), 1, 30); k++) st.pending.push({ kind, options: options.slice(), rerolls: 0 });
        break;
      }
      case 'chain': {
        // The warden's inmate has eaten and has a meal again: the game asks
        // which to eat, even with only one, and its Cancel stops the chain.
        usedToday();
        st.used.devour = 1;
        const here = st.cells[st.position];
        if (!here || here.sealed || !here.inmate) {
          problems.push('連鎖需要吞噬者在典獄長所在的牢房：把典獄長放在那裡，並照現在的樣子設定那名囚犯。');
          break;
        }
        st.chaining = { eater: here.inmate.id, at: 0, bites: [] };
        if (!T.chainOptions(st).length) {
          problems.push('只有在連鎖中的囚犯有東西可吃時，遊戲才會要你選獵物。請檢查盤面：目前找不到牠能吃的獵物。');
        }
        break;
      }
      case 'office': {
        // Only when the game shows the Instigate and Bestow buttons. Standing
        // in the office isn't enough: the run starts there without them, and
        // they're gone once one is taken.
        usedToday();
        if (st.position !== T.OFFICE) problems.push('煽動和賞賜只在典獄長位於審訊室時出現：把典獄長放在 01 號牢房。');
        st.phase = 'office';
        break;
      }
      default:
        usedToday();
    }
    return { st, problems };
  }

  // A model for an engine state: a saved simulator run, or the state after
  // "Do it here". `prev` keeps what the player knew about event kinds.
  function modelFrom(st, prev) {
    const m = blankModel();
    m.rewards = !!st.params.rewards;
    m.day = st.day;
    m.maxDays = st.maxDays;
    m.warden = st.position;
    m.chainArmed = !!st.chain;
    m.objective = st.objective ? st.objective.id : 'other';
    m.startEvent = st.startEvent || 'none';
    m.walkTiles = st.objective ? st.objective.progress : 0;
    m.milestone = !!st.milestone;
    m.tools = st.tools.slice();
    m.vault = st.vault.map((v) => v.beast);
    m.cells = st.cells.map((c) => {
      if (c.n === T.OFFICE) return officeCell();
      const before = prev ? prev.cells[c.n] : null;
      // The simulator only shows that a door hides an event, not which kind.
      let event = null;
      if (c.event && c.seen !== false) event = c.eventKnown === false || !before || !before.event ? 'unknown' : before.event;
      if (c.sealed) {
        if (c.nest) return { kind: 'nest', due: c.nest.due };
        if (c.scratch && c.hidden && c.known) return { kind: 'scratch', tier: Math.min(TOP_TIER, c.hidden.tier), event };
        if (c.hidden && c.known === 1) return { kind: 'revealed', tier: Math.min(TOP_TIER, c.hidden.tier), event };
        if (c.hidden && c.known >= 2) return { kind: 'scouted', beast: c.hidden.beast, tier: Math.min(TOP_TIER, c.hidden.tier), event };
        return c.atLeast ? { kind: 'sealed', event, atLeast: c.atLeast } : { kind: 'sealed', event };
      }
      if (!c.inmate) return { kind: 'empty' };
      const link = T.linkOf(st, c.inmate.id);
      const preyCell = link && link.lion === c.inmate.id ? T.cellOf(st, link.prey) : null;
      return { kind: 'inmate', beast: c.inmate.beast, tier: Math.min(TOP_TIER, c.inmate.tier), ivory: !!c.ivory, prey: preyCell ? { cell: preyCell.n, rounds: link.rounds } : null, marked: !!c.inmate.marked, event };
    });
    if (st.pending.length) {
      m.step = 'choice';
      m.choice = { kind: st.pending[0].kind, options: st.pending[0].options.slice(), rerolls: st.pending[0].rerolls || 0, picks: st.pending[0].kind === 'gift' ? st.pending.filter((p) => p.kind === 'gift').length : 1 };
    } else if (st.phase === 'event' && st.event) {
      m.step = 'event';
      m.eventKind = st.event.kind;
    } else if (st.chaining) m.step = 'chain';
    // The simulator offers Instigate or Bestow on walking into the office, but
    // the analyzer waits for the player (or a screenshot) to say the game does.
    else m.step = st.phase === 'patrol' ? (st.ratway ? 'ratway' : 'patrol') : 'manage';
    m.dest = st.phase === 'patrol' && !st.ratway ? st.destinations.slice() : [];
    // A Hunt (the Blood-Stained Trap) used the day's action, as a consume does.
    m.devourUsed = st.used.devour > 0 || !!st.used.hunt;
    m.swapUsed = st.used.swap > 0;
    m.consumeOffered = !!st.used.devourAfterSwap;
    m.noSwap = !!st.used.noSwap;
    m.noDevour = !!st.used.noDevour;
    m.noHunt = !!st.used.noHunt;
    m.huntOnly = Array.isArray(st.used.huntOnly) ? st.used.huntOnly.slice() : null;
    m.officeOnly = st.phase === 'office' && st.used.officeOnly ? st.used.officeOnly : null;
    m.mealOnly = Array.isArray(st.used.mealOnly) ? st.used.mealOnly.slice() : null;
    m.ended = st.phase === 'ended';
    return m;
  }

  // ---------- Page state ----------

  const saved = store.get(KEY);
  let model = normalize(saved && saved.model);
  let selected = saved && Number.isInteger(saved.selected) ? clamp(saved.selected, 0, T.CELL_COUNT - 1) : 1;
  let flags = new Set(); // cells the simulator's dice decided, for the player to check
  let applied = null; // what "Do it here" just played
  // How the board got here since the last one asked about: a move played
  // here, or a screenshot. `filled` lists what the dice or the reader decided
  // (cells as c<n>, plus dest, event and choice), `touched` what the player
  // has since set or confirmed against their game. It's saved with the board,
  // so a reload can't pass the dice's guesses off as the player's.
  let via = saved && saved.via && Array.isArray(saved.via.filled) ? Object.assign({}, saved.via, { touched: new Set(saved.via.touched || []) }) : null;
  // Cells still to check survive a reload too.
  if (via) flags = new Set(via.filled.filter((k) => /^c\d+$/.test(k) && !via.touched.has(k)).map((k) => Number(k.slice(1))));
  // The board came from a screenshot (or a Follow my game picture) and was
  // checked straight away. The reader can get something wrong, so its Check
  // marks stay after the advice, for the player to fix and recheck.
  let shot = !!(saved && saved.shot);
  // That board is shared only once the player moves on (the next picture, a
  // move played here, another board), so a board they fixed is shared as
  // fixed, not as a misreading followed by a step that never happened.
  let held = null;
  // Instruments on that screenshot the reader wasn't sure of, to check too.
  let shotTools = [];
  // An instrument read below this is shown as one to check. On the labeled
  // boards, correct reads are 1.00 at their own size and drop to about 0.56
  // when the screenshot is resized.
  const TOOL_SURE = 0.9;
  const undo = [];
  const modelKey = () => JSON.stringify(model);

  function save() {
    store.set(KEY, { model, selected, shot, via: via && Object.assign({}, via, { touched: [...via.touched] }) });
  }

  function shareHeld() {
    if (held && SHARE) SHARE.record(held.board, held.via);
    held = null;
  }

  // The player moves on from a screenshot's board.
  function leaveShot() {
    shareHeld();
    shot = false;
    shotTools = [];
  }

  // "the Rusty Saw" or "the Rusty Saw and the Forged Key", for the notes
  // after a screenshot.
  const unsureTools = () => (shotTools.length ? `辨識器對${shotTools.map((n) => `「${n}」`).join('和')}沒有把握：也請檢查你的刑具。` : '');

  function changed() {
    save();
    render();
  }

  function notice(text) {
    $('az-notice').textContent = text;
  }

  // ---------- Analysis ----------

  const solver = { workers: null, failed: false, id: 0, st: null, key: '', instant: null, result: null, shares: null, meta: null, goal: '' };
  // The live check runs on a worker for every core but one, or on fewer when
  // the page is told (setCores: the desktop app's processor setting), each
  // playing its share of the rounds with its own dice. It runs for a few
  // seconds after each board. A minute after the last check the workers are
  // let go, and their memory with them; the next check starts new ones.
  const MOST_WORKERS = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
  const WORKERS_IDLE_MS = 60000;
  let coreCap = 0; // 0: every core but one
  const workerCount = () => (coreCap ? Math.min(MOST_WORKERS, coreCap) : MOST_WORKERS);
  let idleTimer = 0;
  const poolBusy = () => !!(solver.workers && solver.shares && !solver.shares.every((s) => s.done));
  function releaseWorkers() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    if (!solver.workers) return;
    for (const w of solver.workers) w.terminate();
    solver.workers = null;
    solver.shares = null;
  }
  // Let the workers go once they've been idle a minute; a check still
  // playing keeps them.
  function idleLater() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (poolBusy() ? idleLater() : releaseWorkers()), WORKERS_IDLE_MS);
  }
  // How many workers the live check may use (0: every core but one). A
  // check under way starts over on the new number.
  function setCores(n) {
    coreCap = Math.max(0, Math.floor(Number(n) || 0));
    if (solver.workers && solver.workers.length !== workerCount()) {
      const again = poolBusy() && solver.st ? { id: solver.id, st: solver.st, rollouts: solver.target } : null;
      releaseWorkers();
      if (again) startCheck(again.id, again.st, again.rollouts);
    }
    return workerCount();
  }

  // fresh: a new run's instrument offer (usePick). The last run's board is
  // done with, and this one, not seen yet, isn't shared: the next board
  // starts a new run.
  function ask(quiet, fresh) {
    // A Warden's Treasure waiting for the board behind it: no advice yet.
    if (model.treasureWait) {
      solver.st = null;
      render();
      return false;
    }
    const { st, problems } = buildState(model);
    showProblems(problems);
    if (problems.length) return false;
    if (SHARE && (fresh || (model.runStart && model.step === 'choice'))) {
      shareHeld();
      SHARE.reset('manual');
    } else if (SHARE) {
      // The collector rejects what it doesn't know yet: the newer event
      // kinds, the office as a door, a chain's pick, doors that show a
      // rarity without a scratch, and moves it can't record (a re-roll, the
      // office's choice, a chain's pick). Until it learns
      // them, such a board isn't shared, and the next board starts a new
      // run, so no shared step spans it.
      const kinds = [...model.cells.map((c) => c.event).filter(Boolean), ...(model.step === 'event' ? [model.eventKind] : [])];
      const how = via && Object.assign({}, via, { touched: [...via.touched] });
      const known = kinds.every((k) => COLLECTOR_EVENTS.includes(k)) && !model.dest.includes(T.OFFICE) && COLLECTOR_STEPS.includes(model.step) && !model.cells.some((c) => c.kind === 'revealed') && !(how && how.action && !COLLECTOR_ACTIONS.includes(how.action.type));
      if (!known) {
        held = null;
        SHARE.reset('manual');
      } else if (shot) held = { board: JSON.parse(JSON.stringify(model)), via: how };
      else {
        shareHeld();
        SHARE.record(model, how);
      }
    }
    // A screenshot's board keeps its Check marks through a recheck.
    if (!shot) {
      via = null;
      flags = new Set();
    }
    applied = null;
    solver.id += 1;
    solver.st = st;
    solver.key = modelKey();
    solver.result = null;
    try {
      solver.instant = S.instant(st);
    } catch (e) {
      solver.instant = null;
    }
    const options = S.candidates(st).length;
    const rollouts = clamp(Math.round(PLAYOUT_BUDGET / Math.max(1, options)), 400, 1600);
    solver.target = rollouts;
    solver.startedAt = Date.now();
    startCheck(solver.id, st, rollouts);
    render();
    if (quiet !== true) $('az-results').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return true;
  }

  function startCheck(id, st, rollouts) {
    const state = JSON.parse(JSON.stringify(st));
    if (!solver.workers && !solver.failed) {
      try {
        solver.workers = Array.from({ length: workerCount() }, (_, k) => {
          const worker = new Worker(`js/solver-worker.js${SCRIPT_QUERY}`);
          worker.onmessage = (e) => onShare(k, e.data);
          worker.onerror = () => {
            // Fall back to this page's thread, and redo the check.
            if (!solver.workers) return;
            for (const w of solver.workers) w.terminate();
            solver.workers = null;
            solver.shares = null;
            solver.failed = true;
            if (solver.st) startCheck(solver.id, solver.st, Math.min(rollouts, 300));
          };
          return worker;
        });
      } catch (e) {
        solver.failed = true;
        solver.workers = null;
      }
    }
    if (solver.workers) {
      // Each worker's share of the rounds: together they make `rollouts`.
      const n = solver.workers.length;
      solver.meta = null;
      solver.shares = solver.workers.map((w, k) => ({ target: Math.floor(rollouts / n) + (k < rollouts % n ? 1 : 0), rounds: 0, done: false, rows: null }));
      solver.workers.forEach((w, k) => w.postMessage({ id, state, rollouts: solver.shares[k].target, stream: k, raw: true }));
      idleLater();
      return;
    }
    const job = S.solve(state, { rollouts: Math.min(rollouts, 300), seed: (id * 7919 + 1) >>> 0 });
    const tick = () => {
      if (id !== solver.id) return;
      solver.result = job.step(12);
      renderResults();
      renderBoard();
      renderCourt();
      if (!solver.result.done) setTimeout(tick, 16);
    };
    setTimeout(tick, 0);
  }

  // A worker's new rounds for the current check. Its rows grow, and the
  // merged result is redrawn at most every 100 ms, and once all are done.
  let mergeTimer = 0;
  function onShare(k, m) {
    // A check that settled early keeps its answer: late rounds are dropped.
    if (m.id !== solver.id || !solver.shares || (solver.result && solver.result.early)) return;
    const share = solver.shares[k];
    if (m.meta && !solver.meta) solver.meta = m.meta;
    if (!share.rows) share.rows = m.rows.map(() => ({ vals: [], best: 0 }));
    m.rows.forEach((r, i) => {
      const row = share.rows[i];
      for (const v of r.vals) row.vals.push(v);
      row.best = r.best;
    });
    share.rounds = m.rounds;
    share.done = m.done;
    solver.goal = m.goal;
    if (solver.shares.every((s) => s.done)) {
      clearTimeout(mergeTimer);
      merge();
      idleLater();
    } else if (!mergeTimer) mergeTimer = setTimeout(merge, 100);
  }

  // The workers' rows as one: each share's rounds keep their common dice
  // across the moves, so the paired margins hold (TartarusSolver.summarize).
  function merge() {
    mergeTimer = 0;
    if (!solver.shares || !solver.meta) return;
    const rows = solver.meta.map((meta, i) => {
      const row = Object.assign({ vals: [], best: 0 }, meta);
      for (const s of solver.shares) {
        const r = s.rows && s.rows[i];
        if (!r) continue;
        for (const v of r.vals) row.vals.push(v);
        row.best += r.best;
      }
      return row;
    });
    const rounds = solver.shares.reduce((sum, s) => sum + s.rounds, 0);
    solver.result = Object.assign(S.summarize(rows, rounds, solver.target, solver.goal), { done: solver.shares.every((s) => s.done) });
    // Settled early: the workers stop, and their share of the processor with them.
    if (!solver.result.done && settled() && solver.workers) {
      for (const w of solver.workers) w.postMessage({ stop: true });
      for (const share of solver.shares) share.done = true;
      solver.result.done = true;
      solver.result.early = true;
      idleLater();
    }
    renderResults();
    renderBoard();
    renderCourt();
  }

  const fresh = () => !!solver.st && solver.key === modelKey();
  // Whether the advice is final: the live check has finished, or there's
  // nothing to compare. Until then no move is advised, so the advice never
  // changes its mind a moment after it's shown.
  function settled() {
    const r = solver.result;
    if (!r) return false;
    if (r.done || r.options.length <= 1) return true;
    const [top, ...rest] = r.options;
    if (r.rounds >= LIVE_MIN && rest.every((o) => o.gapSe > 0 && top.mean - o.mean > CLEAR_SE * o.gapSe)) return true;
    // Out of time: the advice is the check's leader once it has LIVE_MIN
    // playouts each, else the strategy's own pick (recommendation()).
    return Date.now() - solver.startedAt >= CHECK_MS;
  }
  // A picture being read (the reader shows it on the board's card).
  let reading = 0;
  function setReading(on) {
    reading = Math.max(0, reading + (on ? 1 : -1));
    renderCourt();
  }
  const SPIN = '<span class="az-spin" aria-hidden="true"></span>';
  // The moves being played out, in a steady order while the check runs.
  function checking() {
    const r = solver.result;
    const moves = r ? r.options.slice() : solver.st ? S.candidates(solver.st) : [];
    moves.sort((a, b) => a.label.localeCompare(b.label));
    const each = solver.target || 0;
    const done = r ? Math.min(each, r.rounds) : 0;
    return { moves, each, done, total: each * moves.length, played: done * moves.length };
  }
  // How far the live check has got, 0 to 1.
  const progress = () => (solver.result && solver.target ? Math.min(1, solver.result.rounds / solver.target) : 0);

  // On a meal pick ("Select an Inmate to Consume") the choices are a meal or
  // Cancel. When the best move there is not to consume, the advice says
  // Cancel, which ends a chain or leaves the day's first consume (report
  // 323: "recommended to End day instead of cancel consume").
  function recommendation() {
    const rec = bestMove();
    const rd = reader.reading;
    if (!rec || !rec.action || rec.action.type !== 'end' || !rd || !rd.chain || model.step !== 'manage') return rec;
    return Object.assign({}, rec, { label: '取消吞噬，然後結束這一天', why: `遊戲正在選獵物，能選的只有獵物或取消。${rec.why || ''}`.trim() });
  }

  // The strategy's instant pick, unless the live check finds a clearly better
  // move (by more than its paired margin), so the advice doesn't flicker.
  function bestMove() {
    if (!solver.st) return null;
    const pick = solver.instant;
    const r = solver.result;
    const ranked = r ? r.options : [];
    // A check cut short by the time cap (early) leads only with LIVE_MIN
    // playouts each; with fewer, the strategy's own pick stands (f5's review).
    const live = r && ranked.length > 1 && ((r.done && !r.early) || r.rounds >= LIVE_MIN) ? ranked[0] : null;
    const mine = pick && ranked.find((o) => S.sameAction(o.action, pick.action));
    if (!live) return pick ? Object.assign({ live: false }, pick, { option: mine || null }) : ranked.length === 1 ? { action: ranked[0].action, label: ranked[0].label, why: '這是這裡唯一的動作。', live: true, option: ranked[0] } : null;
    // A better move must also win by a margin worth playing for: shared dice
    // make the paired margin narrow, and a near tie flipped the advice from
    // one screen to the next (report 337: End 2.85 against the strategy's
    // consume at 2.82).
    if (mine && (mine === live || live.mean - mine.mean <= Math.max(1.96 * mine.gapSe, SWITCH_MIN))) {
      const why = mine === live ? pick.why : `${pick.why}即時檢驗認為它和最佳動作差不多。`;
      return Object.assign({ live: true, rounds: r.rounds }, pick, { label: mine.label, why, option: mine });
    }
    return { action: live.action, label: live.label, why: `模擬找到了比策略首選${pick ? `（${pick.label}）` : ''}更好的動作。`, live: true, rounds: r.rounds, option: live };
  }

  function fmtOption(goal, o, st) {
    return `${o.mean.toFixed(2)}${o.n > 1 ? ` ±${(1.96 * o.se).toFixed(2)}` : ''}`;
  }

  function expectText(goal, o, st) {
    if (!o) return '';
    return `預期：到第 ${st.maxDays} 天結束時，收容區約有 ${o.mean.toFixed(2)} 名綺彩囚犯。`;
  }

  // ---------- Playing a move here ----------

  // Plays a move with the simulator's dice. The cells it changes are marked
  // for the player to set to what their game shows. With toNextDay, the
  // strategy then plays the rest of the day the same way, as if the player
  // followed the advice, and stops at the next day's patrol: the player then
  // pastes a screenshot of their new day, or fixes the marked cells.
  function doMove(action, toNextDay) {
    const { st, problems } = buildState(model);
    if (problems.length) {
      showProblems(problems);
      return;
    }
    // An event whose kind wasn't seen is any of them. Doors hide none unseen:
    // events show as they appear, and new ones come from the engine's dice.
    for (const c of st.cells) {
      if (c.event && c.eventKnown === false) c.event = T.EVENT_POOL[Math.floor(Math.random() * T.EVENT_POOL.length)];
    }
    const before = JSON.parse(JSON.stringify(model));
    const label = labelFor(action);
    let result;
    try {
      result = S.apply(st, action);
    } catch (e) {
      result = { ok: false, reason: '這個動作發生錯誤，沒有執行。' };
    }
    if (!result || !result.ok) {
      showProblems([result ? result.reason : '這個動作無法執行。']);
      return;
    }
    let more = 0;
    const startDay = st.day;
    if (toNextDay) {
      const nextPatrol = () => st.day > startDay && st.phase === 'patrol' && !st.pending.length;
      for (let i = 0; i < 80 && st.phase !== 'ended' && !nextPatrol(); i++) {
        let next = null;
        try {
          next = S.decide(st, S.paramsFor(st), Math.random);
          if (next && !(S.apply(st, next) || {}).ok) next = null;
        } catch (e) {
          next = null;
        }
        if (!next) break;
        more += 1;
      }
    }
    undo.push({ model: before, selected, shot });
    if (undo.length > 30) undo.shift();
    leaveShot();
    model = modelFrom(st, before);
    flags = new Set(model.cells.map((c, n) => (cellSig(c) !== cellSig(before.cells[n]) ? n : -1)).filter((n) => n >= 0));
    applied = { label, changed: [...flags], newDay: model.day !== before.day, doors: model.step === 'patrol' ? model.dest.slice() : [], ended: !!model.ended, step: model.step, office: st.phase === 'office', more, toNextDay: !!toNextDay };
    const filled = [...flags].map((n) => `c${n}`);
    if (applied.newDay && model.step === 'patrol') filled.push('dest');
    if (model.step === 'event') filled.push('event');
    if (model.step === 'choice' && model.choice.kind !== 'gift') filled.push('choice');
    via = { action, label: toNextDay ? `${label}，接著依策略玩完第 ${startDay} 天`.slice(0, 120) : label, filled, touched: new Set() };
    solver.st = null;
    solver.id += 1;
    showProblems([]);
    changed();
    $('az-applied').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (toNextDay && !model.ended) toast(`第 ${model.day} 天。貼上新一天的截圖（Ctrl+V）來載入，或修正標記「檢查」的牢房。`, 'ok', [{ id: 'pick', label: '選擇截圖', primary: true }]);
  }

  function labelFor(action) {
    const r = solver.result;
    const option = r && r.options.find((o) => S.sameAction(o.action, action));
    if (option) return option.label;
    const match = solver.st && S.candidates(solver.st).find((c) => S.sameAction(c.action, action));
    return match ? match.label : action.type;
  }

  function undoMove() {
    const last = undo.pop();
    if (!last) return;
    reader.undoable = false;
    model = last.model;
    selected = last.selected;
    // An undone screenshot was never right, so it isn't shared.
    held = null;
    shot = !!last.shot;
    flags = new Set();
    applied = null;
    via = null;
    changed();
  }

  // The player set or confirmed part of the board the dice or the reader
  // filled in, so it's known to match their game.
  function touch(key) {
    if (via) via.touched.add(key);
  }

  // ---------- Rendering ----------

  const cellEls = [];

  function buildBoard() {
    const board = $('az-board');
    for (let n = 0; n < T.CELL_COUNT; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.style.gridRow = B.RING[n][0];
      b.style.gridColumn = B.RING[n][1];
      b.innerHTML = B.CELL_HTML;
      b.children[2].textContent = L(n);
      b.addEventListener('click', () => {
        const open = !$('az-pick').hidden && $('az-pick').dataset.cell === String(n);
        select(n);
        if (open) closePick(true);
        else openPick(n);
      });
      board.appendChild(b);
      cellEls[n] = { btn: b, body: b.children[0], hint: b.children[3], badges: b.children[4], tag: b.children[5], warden: b.children[6] };
    }
    // What's in a cell, picked from icons that open right on the cell.
    const pick = document.createElement('div');
    pick.id = 'az-pick';
    pick.className = 'az-pick';
    pick.hidden = true;
    pick.setAttribute('role', 'dialog');
    pick.setAttribute('aria-label', '這間牢房裡有什麼');
    pick.innerHTML = pickHTML();
    board.appendChild(pick);
  }

  // Every inmate by rarity, then the doors and marks a cell can have.
  function pickHTML() {
    const tiers = T.TIERS.slice(0, TOP_TIER + 1);
    const btn = (value, label, art, cls) => `<button type="button" class="az-ico${cls ? ` ${cls}` : ''}" data-pick="${value}" title="${esc(label)}" aria-label="${esc(label)}">${art}</button>`;
    const row = (label, cls, items) => `<div class="az-pick-row"><span class="az-pick-label${cls ? ` ${cls}` : ''}">${esc(label)}</span>${items.join('')}</div>`;
    return [
      ...tiers.map((name, t) => row(name, `t${t}`, T.BEASTS.map((b) => btn(`inmate:${b}:${t}`, `${name} ${T.beastName(b)}`, B.PORTRAITS[b], `t${t}`)))),
      row('上鎖', '', [
        btn('sealed', '上鎖的門', B.MARKS.sealed),
        btn('sealed:unknown', '門後有獄中事變（種類不明）', B.MARKS.event),
        btn('sealed:chain', '門後有連鎖反應', B.MARKS.chain),
        btn('sealed:execution', '門後有處刑效率', B.MARKS.execution),
        btn('sealed:trickster', '門後有暗箱操作', B.MARKS.trickster),
        btn('sealed:appetite', '門後有飢腸轆轆', B.MARKS.appetite),
        btn('sealed:convict', '門後有高危罪犯', B.MARKS.convict),
        btn('sealed:crow', '門後有鴉之低語', B.MARKS.crow),
        btn('sealed:freedom', '門後有自由的滋味', B.MARKS.freedom),
        btn('sealed:portion', '門後有「有福同享」', B.MARKS.portion),
        btn('sealed:usurp1', '門後有僭越 I', B.MARKS.usurp1),
        btn('sealed:usurp2', '門後有僭越 II', B.MARKS.usurp2),
        btn('sealed:usurp3', '門後有僭越 III', B.MARKS.usurp3),
        btn('sealed:usurp4', '門後有僭越 IV', B.MARKS.usurp4),
        btn('sealed:ratway', '門後有暗渠鼠道', B.MARKS.ratway),
        btn('sealed:hunt', '門後有尋「寶」', B.MARKS.hunt),
        btn('dark', '尋「寶」後仍暗著的門：裡面是稀有或更高', B.MARKS.dark, 't2'),
        btn('scouted', '已偵察的門（典獄官的天平）：在下方面板設定野獸和稀有度', B.MARKS.scouted),
      ]),
      row('其他', '', [btn('nest', '鼠巢', B.MARKS.nest), btn('empty', '空牢房', B.MARKS.empty), btn('ivory', '象牙標記：切換這裡囚犯的標記', B.MARKS.ivory)]),
      row('劃痕', '', tiers.map((name, t) => btn(`scratch:${t}`, `有劃痕的門，顯示${name}`, B.MARKS.scratch, `t${t}`))),
      row('顯示稀有度', '', tiers.map((name, t) => btn(`revealed:${t}`, `上鎖的門，顯示裡面是${name}，野獸不明（「?」頭像）`, B.MARKS.revealed, `t${t}`))),
    ].join('');
  }

  // The picker's choice for what a cell holds.
  function pickValue(c) {
    const tier = clamp(toInt(c.tier, 0), 0, TOP_TIER);
    if (c.kind === 'inmate') return `inmate:${c.beast}:${tier}`;
    if (c.kind === 'scratch') return `scratch:${tier}`;
    if (c.kind === 'revealed') return `revealed:${tier}`;
    if (c.kind === 'scouted') return 'scouted';
    if (c.kind === 'sealed') return c.atLeast && !c.event ? 'dark' : c.event ? `sealed:${c.event}` : 'sealed';
    return c.kind;
  }

  function setHTML(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  function renderBoard() {
    const { st } = buildState(model);
    const rec = fresh() && settled() ? recommendation() : null;
    const a = rec ? rec.action : null;
    const best = new Set();
    if (a && a.type === 'patrol') best.add(a.cell);
    if (a && a.type === 'devour') best.add(a.to);
    if (a && a.type === 'swap') best.add(st.position);
    const doors = model.step === 'patrol' ? new Set(model.dest) : new Set();
    $('az-board').classList.toggle('is-patrolling', doors.size > 0);
    for (const cell of st.cells) {
      const el = cellEls[cell.n];
      const p = B.cellParts(cell, st);
      const mc = model.cells[cell.n];
      // Name the event's kind when the player knows it.
      let badges = p.badges;
      if (mc.event === 'chain') badges = badges.replace('>事變<', '>連鎖<');
      else if (mc.event === 'execution') badges = badges.replace('>事變<', '>處刑<');
      else if (mc.event === 'trickster') badges = badges.replace('>事變<', '>暗箱<');
      else if (mc.event === 'appetite') badges = badges.replace('>事變<', '>飢腸<');
      else if (mc.event === 'convict') badges = badges.replace('>事變<', '>罪犯<');
      else if (mc.event === 'crow') badges = badges.replace('>事變<', '>鴉語<');
      else if (mc.event === 'freedom') badges = badges.replace('>事變<', '>自由<');
      else if (mc.event === 'usurp1') badges = badges.replace('>事變<', '>僭越 I<');
      else if (mc.event === 'portion') badges = badges.replace('>事變<', '>同享<');
      else if (mc.event === 'usurp2') badges = badges.replace('>事變<', '>僭越 II<');
      else if (mc.event === 'hunt') badges = badges.replace('>事變<', '>尋寶<');
      if (cell.n === selected) p.cls.push('is-selected');
      if (doors.has(cell.n)) p.cls.push('is-dest');
      if (flags.has(cell.n)) p.cls.push('is-check');
      if (best.has(cell.n)) p.cls.push('is-hint');
      el.btn.className = p.cls.join(' ');
      setHTML(el.body, p.body);
      setHTML(el.hint, p.hint);
      setHTML(el.badges, badges);
      setHTML(el.warden, p.warden ? B.LANTERN : '');
      const tag = best.has(cell.n) ? (a.type === 'swap' ? '替換' : a.type === 'devour' ? '吃' : '去') : flags.has(cell.n) ? '檢查' : doors.has(cell.n) ? '門' : '';
      el.tag.textContent = tag;
      el.btn.setAttribute('aria-label', `${p.label}${doors.has(cell.n) ? '。今天的門之一' : ''}${tag === '檢查' ? '。模擬器改動過：請和遊戲比對' : ''}`);
      el.btn.setAttribute('aria-pressed', String(cell.n === selected));
    }
  }

  function renderCourt() {
    const working = fresh() && !settled();
    const rec = fresh() && settled() ? recommendation() : null;
    let title;
    let detail;
    if (model.treasureWait && !reading) {
      title = '典獄長的珍藏：請先確認盤面';
      detail = '在遊戲中按「查看監獄狀態」，在盤面停留一秒再回來。自動截圖模式會在你查看時讀取盤面。';
    } else if (reading) {
      title = '正在辨識新畫面…';
      detail = '辨識完成後馬上給出建議。';
    } else if (working) {
      const c = checking();
      title = '計算中…';
      detail = `${T.plural(c.moves.length, '個動作')}，每個 ${c.each.toLocaleString()} 局：已模擬 ${c.played.toLocaleString()} / ${c.total.toLocaleString()}`;
    } else if (rec) {
      title = rec.label;
      detail = rec.option ? expectText(solver.result.goal, rec.option, solver.st) : '正在用模擬檢驗…';
    } else {
      const day = `第 ${model.day} / ${model.maxDays} 天`;
      title = '你的盤面';
      detail = `${day} · ${STEP_NAMES[model.step]} · 典獄長${model.warden === T.OFFICE ? '在審訊室' : `在 ${L(model.warden)} 號牢房`}`;
    }
    const busy = reading || working;
    setHTML($('az-court'), `<div class="decision${rec && !busy ? ' az-court-rec' : ''}${busy ? ' az-court-busy' : ''}"><div class="decision-text"><p class="decision-title">${busy ? SPIN : rec ? '<span class="az-court-eyebrow">這樣做</span>' : ''}${esc(title)}</p><p class="decision-detail">${esc(detail)}</p></div></div>`);
  }

  function pressGroup(id, value) {
    for (const b of $(id).querySelectorAll('button[data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === value));
  }

  function renderEditor() {
    const n = selected;
    const c = model.cells[n];
    const office = n === T.OFFICE;
    $('az-cell-title').textContent = office ? '01 號牢房 · 審訊室' : `${L(n)} 號牢房`;
    $('az-warden').setAttribute('aria-pressed', String(model.warden === n));
    $('az-door').hidden = n === model.warden || model.step !== 'patrol';
    $('az-door').setAttribute('aria-pressed', String(model.dest.includes(n)));
    $('az-match').hidden = office || !flags.has(n);
    $('az-office-note').hidden = !office;
    $('az-cell-fields').hidden = office;
    if (office) return;
    pressGroup('az-kind', c.kind);
    const inmate = c.kind === 'inmate';
    const scouted = c.kind === 'scouted';
    const tiered = inmate || scouted || c.kind === 'scratch' || c.kind === 'revealed';
    $('az-beast-field').hidden = !(inmate || scouted);
    $('az-tier-field').hidden = !tiered;
    $('az-tier-legend').textContent = inmate ? '稀有度' : scouted ? '典獄官的天平顯示的稀有度' : '門上看得到的稀有度';
    const tier = tiered ? clamp(toInt(c.tier, 0), 0, TOP_TIER) : 0;
    for (const b of $('az-beasts').querySelectorAll('button')) {
      b.className = `az-beast t${tier}`;
      b.setAttribute('aria-pressed', String((inmate || scouted) && b.dataset.v === c.beast));
    }
    for (const b of $('az-tiers').querySelectorAll('button')) b.setAttribute('aria-pressed', String(tiered && Number(b.dataset.v) === tier));
    $('az-inmate-extra').hidden = !inmate;
    if (inmate) {
      $('az-ivory').checked = !!c.ivory;
      const { st } = buildState(model);
      const lion = c.beast === 'lion';
      $('az-prey-field').hidden = !lion;
      if (lion) {
        const meals = st.cells.filter((o) => o.n !== n && !o.sealed && o.inmate && T.canEat(st, st.cells[n].inmate, o.inmate));
        const current = c.prey ? c.prey.cell : null;
        $('az-prey').innerHTML = `<option value="">無獵物標記</option>${meals.map((o) => `<option value="${o.n}"${o.n === current ? ' selected' : ''}>${L(o.n)} 號牢房：${esc(T.describe(o.inmate))}</option>`).join('')}`;
        $('az-prey-rounds').value = String(c.prey ? c.prey.rounds : T.DEFAULT_PARAMS.preyRounds);
        $('az-prey-rounds').closest('.field').hidden = !c.prey;
      }
      const hunter = model.cells.findIndex((o) => o.kind === 'inmate' && o.beast === 'lion' && o.prey && o.prey.cell === n);
      $('az-prey-of').hidden = hunter < 0;
      if (hunter >= 0) $('az-prey-of').textContent = `被 ${L(hunter)} 號牢房的狂獅標記為獵物：接下來${T.plural(model.cells[hunter].prey.rounds, '個早上')}，兩者每天早上各升一階。`;
    }
    $('az-event-field').hidden = !(c.kind === 'sealed' || c.kind === 'scratch' || c.kind === 'revealed' || c.kind === 'inmate' || scouted);
    $('az-event-field').querySelector('legend').textContent = c.kind === 'inmate' ? '牢房裡的獄中事變（囚犯旁有「!」）' : '門後的獄中事變';
    pressGroup('az-event', c.event || 'none');
    $('az-nest-field').hidden = c.kind !== 'nest';
    if (c.kind === 'nest') $('az-nest-due').value = String(toInt(c.due, model.day + 2));
  }

  function renderSettings() {
    const maxDays = clamp(toInt(model.maxDays, 20), 5, 60);
    // The game counts down: "N day(s) until Riot" on day maxDays - N.
    const riot = $('az-riot');
    riot.max = String(maxDays - 1);
    if (document.activeElement !== riot) riot.value = String(maxDays - clamp(toInt(model.day, 1), 1, maxDays));
    $('az-dayof').textContent = `第 ${model.day} / ${maxDays} 天`;
    $('az-days').value = String(maxDays);
    pressGroup('az-step', model.step);
    for (const box of document.querySelectorAll('.az-stepbox')) {
      const steps = box.dataset.step.split(' ');
      box.hidden = !steps.includes(model.step);
    }
    // Today's doors: the cells within reach of the warden, plus any ticked.
    const ahead = [];
    for (let i = 1; i < T.CELL_COUNT && ahead.length < T.DEFAULT_PARAMS.patrolRange; i++) {
      ahead.push((model.warden + i) % T.CELL_COUNT);
    }
    const doors = [...new Set([...ahead, ...model.dest])];
    setHTML($('az-doors'), doors
      .map((n) => `<button type="button" class="az-doorcard" data-door="${n}" aria-pressed="${model.dest.includes(n)}"><span class="az-doorcard-arch" aria-hidden="true"></span><span class="az-doorcard-go">${n === T.OFFICE ? '前往審訊室' : `前往 ${n + 1} 號牢房`}</span><small>${esc(cellShort(model.cells[n]))}</small></button>`)
      .join(''));
    $('az-devoured').checked = !!model.devourUsed;
    $('az-swapped').checked = !!model.swapUsed;
    $('az-consume-offered').checked = !!model.consumeOffered;
    $('az-consume-offered-wrap').hidden = !model.swapUsed;
    pressGroup('az-event-kind', model.eventKind);
    pressGroup('az-choice-kind', model.choice.kind);
    renderOffer();
    $('az-armed').checked = !!model.chainArmed;
    for (const b of $('az-tools').querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(model.tools.includes(b.dataset.tool)));
    $('az-tools-confirm').hidden = !model.toolsToConfirm;
    $('az-tools-confirm-text').textContent = model.toolsToConfirm || '';
    if (model.toolsToConfirm && model.toolsToConfirm !== toolsAsked) openTools();
    toolsAsked = model.toolsToConfirm || '';
    // The run's instruments first, in the order they were gained, then the
    // rest; the list scrolls back to the top when its order changes.
    const toolBox = $('az-tools');
    const held = model.tools.filter((id) => T.TOOLS[id]);
    const order = held.concat(T.TOOL_IDS.filter((id) => !held.includes(id)));
    if (toolBox.dataset.order !== order.join(',')) {
      for (const id of order) {
        const el = toolBox.querySelector(`[data-tool="${id}"]`);
        if (el) toolBox.appendChild(el);
        if (id === held[held.length - 1]) toolBox.appendChild($('az-tools-rest'));
      }
      $('az-tools-rest').hidden = !held.length;
      toolBox.dataset.order = order.join(',');
      toolBox.scrollTop = 0;
    }
    $('az-rewards').checked = !!model.rewards;
    const goal = model.objective;
    $('az-objective').value = goal;
    $('az-objective-text').textContent = T.OBJECTIVES[goal].text;
    const card = T.START_EVENTS && T.START_EVENTS[model.startEvent];
    $('az-start-event').value = card ? model.startEvent : 'none';
    $('az-start-text').hidden = !card;
    $('az-start-text').textContent = card ? `${card.text}。` : '';
    renderPlayNotes();
    const goalNeed = T.OBJECTIVES[goal].need || 0;
    $('az-walk-wrap').hidden = !goalNeed;
    $('az-walk-unit').textContent = T.OBJECTIVES[goal].unit || '進度';
    $('az-walk-need').textContent = `/${goalNeed}`;
    $('az-walk').max = String(goalNeed);
    if (document.activeElement !== $('az-walk')) $('az-walk').value = String(model.walkTiles);
    $('az-milestone').checked = !!model.milestone || (goalNeed > 0 && model.walkTiles >= goalNeed);
    // Ten slots like the game's, more if the vault holds more.
    const slots = Math.max(10, model.vault.length + (model.vault.length % 2));
    setHTML($('az-vault'), Array.from({ length: slots }, (_, i) => {
      const beast = model.vault[i];
      return beast
        ? `<button type="button" class="az-hex is-filled t5" data-unvault="${i}" title="綺彩${esc(T.beastName(beast))}：點一下移除">${B.PORTRAITS[beast]}</button>`
        : '<span class="az-hex" aria-hidden="true"></span>';
    }).join(''));
  }

  function cellShort(c) {
    if (!c) return '';
    if (c.kind === 'inmate') return `${T.tierName(c.tier)}${T.beastName(c.beast)}`;
    if (c.kind === 'scratch') return `${T.tierName(c.tier)}的門`;
    if (c.kind === 'revealed') return `裡面是${T.tierName(c.tier)}`;
    if (c.kind === 'scouted') return `已偵察：${T.tierName(c.tier)}${T.beastName(c.beast)}`;
    if (c.kind === 'nest') return '鼠巢';
    if (c.kind === 'empty') return '空';
    if (c.kind === 'office') return '審訊室';
    return c.event ? '事變' : '未開啟';
  }

  function renderOffer() {
    const kind = model.choice.kind;
    if (kind === 'gift') {
      $('az-offer').innerHTML = `<p class="field-note">典獄長的珍藏每次都會提供全部四種珍品：${T.GIFT_IDS.map((id) => esc(T.toolName(id))).join('、')}。</p>` +
        // Opulence gives 3 picks a Treasure: the advice weighs them all.
        `<label class="field"><span class="field-label">剩餘選擇次數（含這一次）</span><input type="number" id="az-gift-picks" min="1" max="30" step="1" value="${model.choice.picks || 1}"></label>`;
      return;
    }
    const free = T.TOOL_IDS.filter((id) => !model.tools.includes(id));
    const picks = [0, 1, 2].map((i) => model.choice.options[i] || '');
    $('az-offer').innerHTML = picks
      .map((value, i) => `<label class="field"><span class="field-label">選項 ${i + 1}</span><select data-offer="${i}"><option value="">無</option>${free.map((id) => `<option value="${id}"${id === value ? ' selected' : ''}>${esc(T.toolName(id))}</option>`).join('')}</select></label>`)
      .join('') +
      // A pet's re-roll: the game shows "Re-roll" with the attempts left.
      (kind === 'tool' ? `<label class="field"><span class="field-label">剩餘重骰次數</span><input type="number" id="az-rerolls" min="0" max="9" step="1" value="${model.choice.rerolls || 0}"></label>` : '');
  }

  // Updates a list in place, keeping rows by key, so a button under the
  // pointer survives the refreshes of a live check.
  function syncRows(list, items, keyOf, make, fill) {
    const old = new Map();
    for (const li of list.children) old.set(li.dataset.key, li);
    const keep = new Set();
    items.forEach((item, i) => {
      const key = keyOf(item);
      let li = old.get(key);
      if (!li) {
        li = make(item);
        li.dataset.key = key;
      }
      fill(li, item);
      keep.add(key);
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    });
    for (const [key, li] of old) if (!keep.has(key)) li.remove();
  }

  // The instruments in a window over the middle of the board, with a search
  // by name (the user: the side column's list was too hard to look
  // through). The list and the confirm prompt move into it while it's open,
  // keeping their ids and handlers, and go back when it closes.
  let toolsAsked = '';
  function openTools() {
    const d = $('az-tools-dialog');
    if (d.open) return;
    $('az-tools-dialog-body').append($('az-tools-confirm'), $('az-tools'));
    $('az-tools-search').value = '';
    filterTools('');
    d.show();
    placeTools();
    $('az-tools-search').focus({ preventScroll: true });
  }
  function closeTools() {
    const d = $('az-tools-dialog');
    if (!d.open) return;
    filterTools('');
    d.close();
    $('az-tools-open').after($('az-tools'));
    $('az-tools-open').before($('az-tools-confirm'));
  }
  // Over the middle of the board, kept on the screen.
  function placeTools() {
    const d = $('az-tools-dialog');
    if (!d.open) return;
    const r = $('az-board').getBoundingClientRect();
    const w = d.offsetWidth;
    const h = d.offsetHeight;
    const keep = (v, size, room) => Math.max(8, Math.min(room - size - 8, v - size / 2));
    // The part of the board that's on the screen.
    const x0 = Math.max(0, r.left);
    const x1 = Math.min(window.innerWidth, r.right);
    const y0 = Math.max(0, r.top);
    const y1 = Math.min(window.innerHeight, r.bottom);
    d.style.left = `${keep(x1 > x0 ? (x0 + x1) / 2 : window.innerWidth / 2, w, window.innerWidth)}px`;
    d.style.top = `${keep(y1 > y0 ? (y0 + y1) / 2 : window.innerHeight / 2, h, window.innerHeight)}px`;
  }
  function filterTools(q) {
    const t = String(q || '').trim().toLowerCase();
    for (const b of $('az-tools').querySelectorAll('[data-tool]')) b.hidden = !!t && !`${T.toolName(b.dataset.tool)} ${T.toolNameEn(b.dataset.tool)}`.toLowerCase().includes(t);
    $('az-tools-rest').hidden = !!t || !model.tools.some((id) => T.TOOLS[id]);
  }

  const actionKey = (a) => [a.type, a.cell, a.to, a.id, a.accept, a.choice].join('|');

  function renderResults() {
    $('az-treasure-wait').hidden = !model.treasureWait;
    const box = $('az-results');
    box.hidden = !solver.st;
    if (!solver.st) return;
    const st = solver.st;
    const stale = !fresh();
    box.classList.toggle('is-stale', stale);
    const working = !settled();
    const rec = working ? null : recommendation();
    const r = solver.result;
    const goal = 'rainbows';
    // The board changed since this check: its advice was for the board
    // before, so it isn't shown (report 304: a player took the dimmed move
    // for the advice on the new board). Recheck gives the new advice.
    $('az-res-eyebrow').textContent = stale ? '盤面已變更' : '建議動作';
    // Always through setHTML, which skips what it wrote last: a headline
    // written past it left a new check showing the old move.
    if (stale) setHTML($('az-res-move'), '按「重新檢查」取得這個盤面的建議');
    else if (working) setHTML($('az-res-move'), `${SPIN}計算中…`);
    else setHTML($('az-res-move'), esc(rec ? rec.label : '這裡沒有需要決定的事。'));
    $('az-do').hidden = !rec || stale;
    $('az-do').textContent = rec && rec.action.type === 'end' ? '在這裡結束這一天' : '在這裡執行';
    $('az-next').hidden = !rec || stale;
    $('az-undo').hidden = !undo.length;
    // After a screenshot, or once the board has changed: fix it and recheck.
    $('az-res-shot').hidden = !shot && !stale;
    $('az-fix').hidden = !shot;
    $('az-report-reading').hidden = !(shot && reader.result && reader.image && window.TartarusReport);
    $('az-recheck').classList.toggle('btn-primary', stale);
    $('az-res-shot-text').textContent = stale
      ? '這次檢驗之後盤面有變動。按「重新檢查」取得目前盤面的建議。'
      : `已從你的截圖讀取${flags.size ? `，有${T.plural(flags.size, '間牢房')}標記「檢查」` : ''}。${unsureTools()}如果盤面有任何地方和遊戲不符，修正後再按「重新檢查」。`;
    let body = '';
    if (working && !stale) body += `<p class="trainer-source">下面每個動作都會從你的盤面模擬，看不到的部分每次重新擲骰。全部完成後才會顯示建議，所以建議不會再變。</p>`;
    if (rec && !stale) {
      body += `<p class="trainer-source">${esc(rec.live ? `每個選項以 ${rec.rounds.toLocaleString()} 次模擬檢驗` : '訓練策略的即時首選')}</p>`;
      if (rec.why) body += `<p class="trainer-why">${esc(rec.why)}</p>`;
      if (rec.option) body += `<p class="trainer-why">${esc(expectText(goal, rec.option, st))}</p>`;
      if (rec.action.type === 'devour') {
        const odds = S.chainOdds(st, st.position, rec.action.to);
        body += `<p class="trainer-lesson">如果之後的連鎖每一口都吃最好的獵物：平均 ${odds.bites.toFixed(1)} 口，有 ${(100 * odds.rainbow).toFixed(0)}% 機率達到綺彩。遊戲裡的「取消」可以在任何一口停下。</p>`;
      }
      body += `<p class="trainer-lesson">${esc(afterText(rec.action))}</p>`;
    }
    setHTML($('az-res-body'), body);
    const c = checking();
    const options = working ? c.moves : r ? r.options : [];
    const status = $('az-res-status');
    if (stale) status.textContent = '';
    else if (working) status.textContent = `正在模擬${T.plural(c.moves.length, '個動作')}，每個 ${c.each.toLocaleString()} 局：已模擬 ${c.played.toLocaleString()} / ${c.total.toLocaleString()} 局`;
    else if (!r) status.textContent = '即時檢驗：開始中…';
    else if (options.length <= 1) status.textContent = options.length ? '這裡只有一個動作。' : '現在沒有需要決定的事。';
    else status.textContent = r.done ? `即時檢驗：每個選項 ${r.rounds.toLocaleString()} 次模擬` : `即時檢驗：目前每個選項 ${r.rounds.toLocaleString()} 次模擬…`;
    const max = Math.max(0.01, ...options.map((o) => o.mean || 0));
    const shown = options.length > 1 && !stale ? options : [];
    syncRows(
      $('az-res-list'),
      shown,
      (o) => actionKey(o.action),
      () => {
        const li = document.createElement('li');
        li.className = 'solver-row';
        li.innerHTML = '<span class="solver-label"><span class="solver-text"></span><span class="solver-tag" hidden>策略</span></span><span class="solver-value"></span><span class="solver-meter"><span></span></span><span class="solver-sub" hidden></span>';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = '在這裡執行';
        btn.addEventListener('click', () => li.option && doMove(li.option.action));
        li.appendChild(btn);
        li.btn = btn;
        return li;
      },
      (li, o) => {
        li.option = o;
        li.classList.toggle('is-working', working);
        if (working) {
          // While the check runs: each move with its progress, no scores.
          li.classList.remove('is-best');
          li.querySelector('.solver-text').textContent = o.label;
          li.querySelector('.solver-tag').hidden = true;
          li.querySelector('.solver-value').textContent = `${c.done.toLocaleString()} / ${c.each.toLocaleString()}`;
          li.querySelector('.solver-value').title = '這個動作目前已模擬的局數';
          li.querySelector('.solver-meter span').style.width = `${Math.max(2, 100 * (c.each ? c.done / c.each : 0)).toFixed(1)}%`;
          li.querySelector('.solver-sub').hidden = true;
          li.btn.hidden = true;
          return;
        }
        const chosen = rec ? S.sameAction(o.action, rec.action) : o === options[0];
        li.classList.toggle('is-best', chosen);
        li.querySelector('.solver-text').textContent = o.label;
        li.querySelector('.solver-tag').hidden = !o.policy;
        const value = li.querySelector('.solver-value');
        value.textContent = fmtOption(goal, o, st);
        value.title = '這一局結束時收容區預期的綺彩囚犯數，附 95% 誤差範圍';
        const width = (100 * o.mean) / max;
        li.querySelector('.solver-meter span').style.width = `${Math.max(2, width).toFixed(1)}%`;
        const sub = li.querySelector('.solver-sub');
        let subText = '';
        if (o.action.type === 'devour') {
          const odds = S.chainOdds(st, st.position, o.action.to);
          subText = `連鎖：平均 ${odds.bites.toFixed(1)} 口，${(100 * odds.rainbow).toFixed(0)}% 達到綺彩`;
        }
        sub.hidden = !subText;
        sub.textContent = subText;
        li.btn.hidden = chosen || stale;
      },
    );
    const top = options[0];
    const second = options[1];
    const close = top && second && top.mean - second.mean < Math.max(1.96 * second.gapSe, SWITCH_MIN);
    $('az-res-note').textContent = working || shown.length < 2
      ? ''
      : close
        ? '前幾名的動作差距在誤差範圍內：選哪個都可以。'
        : '每個選項都從你的盤面模擬，看不到的部分重新擲骰，之後的每個決定都由訓練好的策略做出。分數是這一局結束時收容區的綺彩囚犯數。';
  }

  // What the player does after following the advice in their game.
  function afterText(action) {
    switch (action.type) {
      case 'patrol': return '在遊戲裡走到那裡。然後把那間牢房設成門後出現的內容（或按「在這裡執行」再修正），再問一次。';
      case 'devour': return '在遊戲裡對那個目標發動吞噬。然後更新連鎖改變的牢房，再問一次。';
      case 'chain': return '在遊戲裡選那個獵物。然後貼上下一個畫面，或更新有變化的牢房，再問一次。';
      case 'stopchain': return '在遊戲的選獵物畫面按「取消」。今天的吞噬已經用掉，接下來這一天就結束了。';
      case 'swap': return '在遊戲裡替換典獄長所在牢房的囚犯。然後把那間牢房設成換進來的囚犯，再問一次。';
      case 'end': return '在遊戲裡結束這一天。然後標出新一天的門，再問一次。';
      case 'event': return model.step === 'event' && model.eventKind === 'hunt'
        ? '在遊戲裡按「確認」。然後把每扇顯示「?」的門設成它的稀有度（顯示稀有度）；仍暗著的門裡是稀有或更高（「在這裡執行」會標出它們，其餘用模擬器的骰子決定）。再問一次。'
        : '然後更新有變化的地方，再問一次。';
      case 'office': return '在遊戲裡按下它。然後貼上變化後的截圖（或在這裡的「做出決定」下設定），再問一次。';
      case 'choose': return '在遊戲裡拿它，然後再問一次。';
      default: return '然後更新盤面，再問一次。';
    }
  }

  function renderApplied() {
    const box = $('az-applied');
    box.hidden = !applied;
    if (!applied) return;
    let html = `<p class="trainer-eyebrow">用模擬器的骰子在這裡執行</p><p class="az-applied-move">${esc(applied.label)}</p>`;
    if (applied.toNextDay && !applied.ended) html += `<p class="trainer-why">${applied.more ? `接著策略玩完了這一天剩下的部分（又走了 ${applied.more} 步），就像你照建議做一樣。` : ''}你遊戲裡實際發生的情況會不一樣：貼上新一天的截圖（Ctrl+V）來載入，或修正標記「檢查」的牢房。</p>`;
    if (applied.ended) html += '<p class="trainer-why">這一局結束了。載入另一個盤面，或在模擬器裡玩新的一局。</p>';
    else {
      if (applied.changed.length) html += `<p class="trainer-why">${applied.changed.map(L).join('、')} 號牢房有變化，已標記「檢查」。請設成遊戲裡顯示的樣子。</p>`;
      if (applied.newDay && applied.step === 'patrol') html += `<p class="trainer-why">現在是第 ${model.day} 天。模擬器擲出了今天的門（${applied.doors.map(L).join('、') || '無'}）；請點亮遊戲實際提供的門。</p>`;
      if (applied.step === 'choice') html += '<p class="trainer-why">有刑具或珍藏可選：請設定遊戲顯示的選項。</p>';
      if (applied.step === 'event') html += '<p class="trainer-why">門後有獄中事變：請在遊戲裡確認它的種類。</p>';
      if (applied.office) html += '<p class="trainer-why">典獄長在審訊室。如果遊戲顯示「煽動」和「賞賜」按鈕，請在上方選「煽動或賞賜」，或貼上它們的截圖。否則就繼續「做出決定」。</p>';
      html += '<p class="trainer-lesson">然後按「我該怎麼做？」取得下一步。</p>';
    }
    const unchecked = via && !applied.ended ? via.filled.filter((k) => !via.touched.has(k)).length : 0;
    if (via && via.filled.length && !unchecked && !applied.ended) html += '<p class="trainer-why">已和你的遊戲比對過。</p>';
    html += `<div class="az-res-actions">${unchecked ? '<button type="button" class="btn" data-match>這裡全部和我的遊戲一致</button>' : ''}<button type="button" class="btn" data-undo>復原</button></div>`;
    setHTML(box, html);
  }

  // The line under the ask button: whether boards are shared, and the switch.
  function renderShare() {
    const box = $('az-share');
    if (!SHARE) {
      box.hidden = true;
      return;
    }
    const seen = SHARE.shared ? ' · <button type="button" class="link" data-share="see">查看已分享的內容</button>' : '';
    setHTML(box, SHARE.sharing
      ? `連續詢問的盤面會匿名分享，用來測量實際遊戲的機率。<button type="button" class="link" data-share="off">關閉</button>${seen}`
      : `分享已關閉，沒有任何資料會離開這個瀏覽器。<button type="button" class="link" data-share="on">分享盤面，協助測量實際遊戲的機率</button>${seen}`);
  }

  function showProblems(problems) {
    const list = $('az-problems');
    list.hidden = !problems.length;
    list.innerHTML = problems.map((p) => `<li>${esc(p)}</li>`).join('');
  }

  function render() {
    renderBoard();
    renderCourt();
    renderEditor();
    renderSettings();
    renderResults();
    renderApplied();
    renderShare();
  }

  // ---------- Editing ----------

  function select(n) {
    selected = clamp(n, 0, T.CELL_COUNT - 1);
    save();
    renderBoard();
    renderEditor();
  }

  // Opens the picker by cell n, below it if it fits on the board, else above.
  function openPick(n) {
    const pick = $('az-pick');
    if (n === T.OFFICE) {
      closePick(false);
      return;
    }
    const c = model.cells[n];
    const current = pickValue(c);
    pick.dataset.cell = String(n);
    for (const b of pick.querySelectorAll('[data-pick]')) {
      const ivory = b.dataset.pick === 'ivory';
      b.setAttribute('aria-pressed', String(ivory ? c.kind === 'inmate' && !!c.ivory : b.dataset.pick === current));
      if (ivory) b.disabled = c.kind !== 'inmate';
    }
    pick.hidden = false;
    const cell = cellEls[n].btn;
    const board = $('az-board');
    const w = pick.offsetWidth;
    const h = pick.offsetHeight;
    const below = cell.offsetTop + cell.offsetHeight + 6;
    const above = cell.offsetTop - h - 6;
    pick.style.left = `${clamp(cell.offsetLeft + (cell.offsetWidth - w) / 2, 0, Math.max(0, board.clientWidth - w))}px`;
    pick.style.top = `${below + h <= board.clientHeight || above < 0 ? below : above}px`;
    (pick.querySelector('[aria-pressed="true"]:not([data-pick="ivory"])') || pick.querySelector('[data-pick]')).focus();
  }

  function closePick(refocus) {
    const pick = $('az-pick');
    if (pick.hidden) return;
    pick.hidden = true;
    const n = Number(pick.dataset.cell);
    if (refocus && cellEls[n]) cellEls[n].btn.focus();
  }

  function pickCell(n, value) {
    if (value === 'ivory') {
      if (model.cells[n].kind === 'inmate') setCell(n, { ivory: !model.cells[n].ivory });
      return;
    }
    if (value === 'scouted') {
      const c = model.cells[n];
      setCell(n, { kind: 'scouted', beast: c.beast || 'mammoth', tier: toInt(c.tier, 0) });
      return;
    }
    const [kind, a, b] = value.split(':');
    if (kind === 'inmate') setCell(n, { kind, beast: a, tier: Number(b) });
    else if (kind === 'scratch' || kind === 'revealed') setCell(n, { kind, tier: Number(a) });
    else if (kind === 'sealed') setCell(n, { kind, event: a || null, atLeast: 0 });
    else if (kind === 'dark') setCell(n, { kind: 'sealed', atLeast: 2 });
    else setCell(n, { kind });
  }

  // Ends prey marks that no longer point at a meal the Lion can eat.
  function cleanPrey() {
    const { st } = buildState(Object.assign({}, model, { step: 'manage' }));
    model.cells.forEach((c, n) => {
      if (!c.prey) return;
      const lion = st.cells[n];
      const target = st.cells[c.prey.cell];
      const ok = c.kind === 'inmate' && c.beast === 'lion' && target && target.inmate && T.canEat(st, lion.inmate, target.inmate);
      if (!ok) model.cells[n] = Object.assign({}, c, { prey: null });
    });
  }

  function setCell(n, patch) {
    if (n === T.OFFICE) return;
    const prev = model.cells[n];
    const c = Object.assign({}, prev, patch);
    if (c.kind === 'inmate') {
      c.beast = T.BEASTS.includes(c.beast) ? c.beast : 'mammoth';
      c.tier = clamp(toInt(c.tier, 0), 0, TOP_TIER);
      // An event can wait beside an inmate ("Can trigger Prison Incident"):
      // it stays while the inmate is edited, and a door that opens drops its
      // event (opening it set the event off).
      c.event = 'event' in patch ? patch.event : prev && prev.kind === 'inmate' ? prev.event || null : null;
    } else {
      c.prey = null;
      c.ivory = false;
    }
    if (c.kind === 'scratch' || c.kind === 'revealed') c.tier = clamp(toInt(c.tier, 1), 0, TOP_TIER);
    if (c.kind === 'scouted') {
      c.beast = T.BEASTS.includes(c.beast) ? c.beast : 'mammoth';
      c.tier = clamp(toInt(c.tier, 0), 0, TOP_TIER);
    }
    if (c.kind === 'nest') {
      c.due = toInt(c.due, model.day + 2);
      c.event = null;
    }
    if (c.kind === 'empty') c.event = null;
    if (c.kind !== 'sealed') delete c.atLeast;
    if (c.beast !== 'lion') c.prey = null;
    model.cells[n] = c;
    cleanPrey();
    flags.delete(n);
    touch(`c${n}`);
    changed();
  }

  // The selected cell, marked Check, is already right.
  function confirmCell(n) {
    flags.delete(n);
    touch(`c${n}`);
    save();
    renderBoard();
    renderEditor();
    renderApplied();
    renderResults();
  }

  // Everything the dice filled in after "Do it here" is right.
  function confirmAll() {
    if (via) for (const key of via.filled) via.touched.add(key);
    flags = new Set();
    save();
    renderBoard();
    renderEditor();
    renderApplied();
    renderResults();
  }

  function setKind(kind) {
    const c = model.cells[selected];
    if (kind === c.kind) return;
    setCell(selected, { kind });
  }

  function toggleDoor(n) {
    if (n === model.warden) return;
    const has = model.dest.includes(n);
    model.dest = has ? model.dest.filter((x) => x !== n) : [...model.dest, n];
    if (!has && model.step !== 'patrol') model.step = 'patrol';
    touch('dest');
    changed();
  }

  function setWarden(n) {
    model.warden = n;
    changed();
  }

  // ---------- Examples and loading ----------

  function exampleModel() {
    const m = blankModel();
    const put = (n, beast, tier, extra) => {
      m.cells[n] = Object.assign({ kind: 'inmate', beast, tier, ivory: false, prey: null }, extra || {});
    };
    m.day = 6;
    m.warden = 4;
    m.step = 'patrol';
    m.dest = [5, 6, 8];
    m.milestone = false;
    put(1, 'wolf', 1);
    put(3, 'lion', 2);
    put(4, 'rat', 0);
    put(6, 'mammoth', 2);
    put(9, 'rat', 1);
    m.cells[10] = { kind: 'empty' };
    m.cells[11] = { kind: 'scratch', tier: 2, event: null };
    put(12, 'wolf', 3);
    m.cells[14] = { kind: 'nest', due: 7 };
    put(15, 'wolf', 2);
    m.cells[5] = { kind: 'sealed', event: 'unknown' };
    m.tools = ['rope'];
    return m;
  }

  function loadRun() {
    const data = store.get(SAVE_KEY);
    if (!data) {
      notice('這個瀏覽器還沒有存任何模擬器進度。先玩一局，或在這裡擺好你的盤面。');
      return;
    }
    try {
      const st = T.deserialize(data);
      leaveShot();
      model = modelFrom(st, null);
      flags = new Set();
      applied = null;
      via = null;
      // A simulator run isn't live, so its boards are never shared.
      if (SHARE) SHARE.reset('sim');
      undo.length = 0;
      solver.st = null;
      changed();
      notice(model.ended ? '已載入你的模擬器進度。那一局已經結束，請擺一個新的局面。' : `已載入你的模擬器進度：第 ${model.day} 天。`);
    } catch (e) {
      notice(e.message);
    }
  }

  // Opens the position in the simulator, replacing its saved run.
  let openArmed = 0;
  function openInSimulator() {
    const { st, problems } = buildState(model);
    if (problems.length) {
      showProblems(problems);
      return;
    }
    const existing = store.get(SAVE_KEY);
    if (existing && Date.now() > openArmed) {
      openArmed = Date.now() + 6000;
      $('az-open-sim').textContent = '這會取代你存好的模擬器進度。再按一次確認。';
      setTimeout(() => {
        $('az-open-sim').textContent = '在模擬器裡玩這個局面';
      }, 6000);
      return;
    }
    st.log = [{ d: st.day, k: 'lab', t: '盤面分析器：這個局面是手動擺設的。' }];
    if (!store.set(SAVE_KEY, { app: 'tartarus-sim', v: T.VERSION, state: st })) {
      notice('這個瀏覽器封鎖了儲存，所以無法把局面送到模擬器。');
      return;
    }
    window.location.href = './';
  }

  // ---------- Reading a screenshot ----------

  const reader = { worker: null, failed: false, id: 0, pending: null, image: null, result: null, reading: null, ms: 0, picks: new Map(), pickId: 0 };
  const SHORT_TIER = ['普通', '魔法', '稀有', '傳奇', '至臻'];

  // A notice pinned to the window while a screenshot is read, so a paste
  // shows it's working wherever the page is scrolled. kind: busy, ok or bad.
  // A sticky one stays until it's answered.
  let toastTimer = 0;
  function toast(text, kind, actions, sticky) {
    const box = $('az-toast');
    clearTimeout(toastTimer);
    box.className = `az-toast is-${kind}`;
    $('az-toast-text').textContent = text;
    $('az-toast-actions').innerHTML = (actions || []).map((a) => `<button type="button" class="btn${a.primary ? ' btn-primary' : ''}" data-toast="${a.id}">${esc(a.label)}</button>`).join('');
    box.hidden = false;
    if (kind !== 'busy' && !sticky) toastTimer = setTimeout(() => (box.hidden = true), actions && actions.length ? 15000 : 6000);
  }

  // ---------- The game's language ----------
  // The reader learned on the English client. A board reads in any language
  // (portraits, frames, digits), but printed names are matched as English
  // words: the instrument offer's cards, the objective and start-of-run
  // cards, the Warden's Treasure screen. On another client the player is
  // told so, sets those by hand, and can send a screen the reader didn't
  // recognize in one click, so it can learn that language (the user,
  // 2026-10-17). Set here, or from the game's log (Auto Screenshot Mode).
  const GAME_LANGS = { en: '英文', ru: '俄文', zh: '中文' };
  const LANG_KEY = 'tartarus-sim:game-lang:v1';
  const LANG_NOTES = {
    ru: 'Игра на русском языке. Анализатор обучен на английском клиенте: клетки, звери и редкость на поле, а также двери дня (по номерам клеток), читаются на любом языке. Кнопки замены и поглощения, ваши инструменты, счётчик хроматических заключённых, предложения инструментов, цели и карты начала забега читаются по английскому тексту. Укажите их вручную, а если экран не распознан, отправьте его кнопкой «傳送這張截圖», чтобы анализатор научился читать русский клиент.',
    zh: '遊戲為中文用戶端。辨識器是用英文用戶端訓練的：盤面上的牢房、野獸和稀有度，以及今天的門（依牢房編號），在任何語言下都能辨識；但「替換」和「吞噬」按鈕、你的刑具、綺彩囚犯數量、刑具選擇、目標和開局卡是依英文文字辨識的。請手動設定這些內容；若某個畫面沒被辨識出來，請按「傳送這張截圖」把截圖傳給我們，幫助辨識器學會中文用戶端。',
  };
  let gameLang = 'en';
  try {
    gameLang = localStorage.getItem(LANG_KEY) || 'en';
  } catch (e) {
    // The default, then.
  }
  const langName = (code) => GAME_LANGS[code] || '其他語言';
  // Today's doors are read by their cell numbers in any language (since
  // 20261017s), checked on real Chinese, Korean and Russian boards (c2); in
  // others a letter can pass for a digit, so the player checks them.
  const DOORS_READ = ['zh', 'ko', 'ru'];
  function langNote() {
    if (gameLang === 'en') return '';
    const doors = DOORS_READ.includes(gameLang)
      ? '盤面上的牢房、野獸和稀有度，以及今天的門（依牢房編號），在任何語言下都能辨識'
      : '盤面上的牢房、野獸和稀有度在任何語言下都能辨識；今天的門會依牢房編號辨識，但還沒在你的語言的盤面上驗證過，所以請在「選擇目的地」下檢查';
    return `你的遊戲語言是${langName(gameLang)}。辨識器是用英文用戶端訓練的：${doors}。「替換」和「吞噬」按鈕、你的刑具、綺彩囚犯數量、刑具選擇、目標和開局卡是依英文文字辨識的。請手動設定這些內容；遇到沒被辨識出來的畫面時，請用跳出來的按鈕把它傳給我們，讓辨識器學會你的語言。${LANG_NOTES[gameLang] && gameLang !== 'zh' ? `\n\n${LANG_NOTES[gameLang]}` : ''}`;
  }
  function renderLang() {
    const sel = $('az-game-lang');
    if (sel) sel.value = GAME_LANGS[gameLang] ? gameLang : 'other';
    const note = $('az-lang-note');
    if (note) {
      note.textContent = langNote();
      note.hidden = gameLang === 'en';
    }
  }
  // auto: from the game's log, which wins only when it says something new.
  function setGameLang(code, auto) {
    const c = String(code || 'en').slice(0, 2).toLowerCase() || 'en';
    if (c === gameLang) return gameLang;
    gameLang = c;
    try {
      localStorage.setItem(LANG_KEY, c);
    } catch (e) {
      // Kept for this page only.
    }
    renderLang();
    if (auto && c !== 'en') toast(langNote().split('\n')[0], 'ok');
    return gameLang;
  }
  // A screen the reader didn't recognize on a client not in English: the
  // player is told, and can send it (the report form, with the picture).
  let langMiss = null; // { what, image, detail, at }
  function langMissed(what, image, detail) {
    if (gameLang === 'en' || !image) return false;
    langMiss = { what, image, detail: String(detail || ''), at: Date.now() };
    const WHAT = { screen: '畫面', board: '盤面', 'objective or start-of-run card': '目標或開局卡', 'instrument offer': '刑具選擇', objective: '目標' };
    toast(`沒能辨識這個${WHAT[what] || what}：你的遊戲語言是${langName(gameLang)}。請手動設定，並把這張截圖傳給我們，讓辨識器學會你的語言。`, 'bad', [{ id: 'lang-report', label: '傳送這張截圖', primary: true }]);
    return true;
  }
  // On such a client, a board's screenshot is asked for once a session: its
  // door cards and buttons teach the reader that language's text.
  let langBoardAsked = false;
  function langBoard(image) {
    if (gameLang === 'en' || langBoardAsked || !image) return false;
    langBoardAsked = true;
    langMiss = { what: 'board', image, detail: 'a board, for its door cards and buttons', at: Date.now() };
    toast(`你的遊戲語言是${langName(gameLang)}：${DOORS_READ.includes(gameLang) ? '' : '請檢查今天的門；另外'}「替換」和「吞噬」按鈕可能讀不到，請手動設定。傳一次這個盤面的截圖給我們，能幫助辨識器學會你的語言。`, 'ok', [{ id: 'lang-report', label: '傳送這張截圖', primary: true }]);
    return true;
  }
  function sendLangMiss() {
    if (!langMiss || !window.TartarusReport) return;
    const tag = Math.random().toString(36).slice(2, 8);
    TartarusReport.open('other', { name: `${langName(gameLang)} ${langMiss.what} ${tag}`, image: langMiss.image, outcome: `Game language: ${gameLang}. Not recognized: the ${langMiss.what}${langMiss.detail ? ` (${langMiss.detail})` : ''}.` });
  }

  function scanStatus(text, bad) {
    const el = $('az-scan-status');
    el.textContent = text;
    el.classList.toggle('is-bad', !!bad);
  }

  async function readImageFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      scanStatus('這不是圖片。請貼上、拖曳或選擇一張截圖（PNG 或 JPG）。', true);
      toast('這不是圖片。請複製監獄畫面的截圖，再貼到這裡。', 'bad');
      return;
    }
    scanStatus('正在辨識你的截圖…');
    toast('正在辨識截圖並載入盤面…', 'busy');
    let source;
    try {
      source = await createImageBitmap(file);
    } catch (e) {
      scanStatus('這個瀏覽器無法開啟那張圖片。', true);
      toast('這個瀏覽器無法開啟那張圖片。', 'bad');
      return;
    }
    readBitmap(source);
  }

  // Reads a picture of the game (a pasted screenshot, or a frame from Follow
  // my game). opts.quiet skips the prompts; opts.onRead hears how it went.
  function readBitmap(source, opts) {
    // Very large screenshots are scaled down; the reader works at any size.
    const scale = Math.min(1, 2600 / source.width);
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    reader.image = canvas;
    runScan(ctx.getImageData(0, 0, w, h), opts);
  }

  function runScan(imageData, opts) {
    const o = opts || {};
    // Follow my game's pictures come every step: their screenshot stays
    // folded away, so the board doesn't move down each time.
    reader.folded = !showShots;
    reader.follow = !!o.quiet;
    reader.id += 1;
    const id = reader.id;
    const t0 = performance.now();
    setReading(true);
    const done = (result, error) => {
      if (id === reader.id) setReading(false);
      if (id !== reader.id) {
        if (o.onRead) o.onRead({ ok: false, skipped: true, reason: '有更新的畫面進來了' });
        return;
      }
      reader.ms = Math.round(performance.now() - t0);
      if (error || !result) {
        reader.result = null;
        scanStatus(`辨識器出了問題：${error || '沒有結果'}。`, true);
        if (!o.quiet) toast(`辨識器出了問題：${error || '沒有結果'}。`, 'bad');
        renderScan();
        if (o.onRead) o.onRead({ ok: false, reason: error || 'no result', ms: reader.ms });
        return;
      }
      reader.result = result;
      reader.reading = result.ok ? scanToModel(result, model) : null;
      // The run's objective and its count, from the board's corner.
      if (result.ok && result.objective) cornerObjective(reader.image, result.objective, reader.reading.model.day);
      scanStatus(result.ok ? `辨識耗時 ${(reader.ms / 1000).toFixed(1)} 秒。` : `${result.reason} 請改用監獄畫面的截圖，並讓整個盤面都在畫面內。`, !result.ok);
      // controls: the board's own door cards or decision row showed, which
      // View Prison Status never does: no Warden's Treasure is open.
      if (o.onRead) o.onRead(result.ok ? { ok: true, day: reader.reading.model.day, unsure: reader.reading.checks.size, ms: reader.ms, controls: !!((result.doors && result.doors.cells && result.doors.cells.length) || result.decision), statusView: !!result.statusView } : { ok: false, reason: result.reason, ms: reader.ms });
      if (o.quiet) {
        renderScan();
        return;
      }
      if (!result.ok) {
        // Not a board: maybe the instrument pick or the Warden's Treasure.
        const image = reader.image;
        toast('這裡沒有盤面：正在檢查是不是刑具選擇或典獄長的珍藏…', 'busy');
        otherScreen(image).then((found) => {
          if (!found) toast(`${result.reason} 請改用監獄畫面的截圖，並讓整個盤面都在畫面內。`, 'bad');
        });
      }
      else {
        // The reading becomes the board at once, and the advice follows. If
        // the reader got something wrong, the player fixes it and rechecks.
        const unsure = reader.reading.checks.size;
        // View Prison Status (its "Return to Selection"): the board behind
        // the Treasure, even when the Treasure itself wasn't seen (report 325).
        const behindTreasure = model.treasureWait || !!result.statusView;
        useScan(true);
        if (behindTreasure) {
          useTreasure('view');
          renderScan();
          return;
        }
        if (ask()) toast(`已從截圖載入第 ${model.day} 天${unsure ? `，有${T.plural(unsure, '間牢房')}標記「檢查」` : ''}。${unsureTools()}建議在下方。如果盤面和遊戲不符，修正後按「重新檢查」。`, 'ok');
        else toast(`已從截圖載入第 ${model.day} 天，但盤面需要先修正才能給建議：請看「我該怎麼做？」下方的說明。`, 'bad');
      }
      renderScan();
    };
    // The worker outlives this call, so it answers whichever reading is newest.
    reader.pending = { imageData, id, done };
    readerWorker();
    if (reader.worker) {
      const copy = imageData.data.slice().buffer;
      // lang: the game's language, for its door cards (see TartarusScan.scan).
      reader.worker.postMessage({ id, width: imageData.width, height: imageData.height, buffer: copy, lang: gameLang }, [copy]);
    } else scanHere(imageData, id, done);
  }

  // The reader's worker, started the first time it's needed. Readings of
  // the instrument pick answer through reader.picks, boards through
  // reader.pending.
  function readerWorker() {
    if (!reader.worker && !reader.failed) {
      try {
        reader.worker = new Worker(`js/scan-worker.js${SCRIPT_QUERY}`);
        reader.worker.onmessage = (e) => {
          if (e.data.kind === 'pick' || e.data.kind === 'objective') {
            const answer = reader.picks.get(e.data.id);
            reader.picks.delete(e.data.id);
            if (answer) answer(e.data.result, e.data.error);
            return;
          }
          const p = reader.pending;
          if (p && e.data.id === p.id) p.done(e.data.result, e.data.error);
        };
        reader.worker.onerror = () => {
          reader.failed = true;
          reader.worker = null;
          const p = reader.pending;
          if (p) scanHere(p.imageData, p.id, p.done);
          for (const [, answer] of reader.picks) answer(null, 'the reader stopped');
          reader.picks.clear();
        };
      } catch (e) {
        reader.failed = true;
        reader.worker = null;
      }
    }
    return reader.worker;
  }

  // Loads the reader's scripts onto the page, for when there's no worker.
  function loadReader(withPick) {
    const load = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${src}${SCRIPT_QUERY}`;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return (window.TartarusScan ? Promise.resolve() : load('js/scan.js'))
      .then(() => (window.TARTARUS_SCAN ? null : load('js/scan-data.js')))
      .then(() => (!withPick || window.TARTARUS_PICK ? null : load('js/pick-data.js')));
  }

  // The instrument pick at the start of a run ("Select a Torture
  // Instrument"), from Follow my game: which three instruments are offered,
  // left to right, and whether a re-roll is left. Not a board: nothing here
  // touches the board until usePick.
  // The objective popup at the start of a run: which objective it is, from
  // its title. It becomes the board's objective, and stays for the run
  // whose instrument offer comes next.
  let runObjective = null;
  function readObjective(source) {
    const scale = Math.min(1, 2600 / source.width);
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return new Promise((resolve) => {
      setReading(true);
      // A card the reader knows before the simulator does (a new start card)
      // is one the simulator doesn't know yet.
      const known = (result) => !!result && !!result.id && (T.OBJECTIVES[result.id] || (T.START_EVENTS || {})[result.id]);
      const done = (result, error) => (setReading(false), resolve(error || !known(result) ? { ok: false, objective: true, reason: error || '這個目標模擬器還不認得' } : { ok: true, objective: true, id: result.id, name: known(result).name }));
      reader.pickId += 1;
      const id = `objective${reader.pickId}`;
      if (readerWorker()) {
        reader.picks.set(id, done);
        const copy = imageData.data.slice().buffer;
        reader.worker.postMessage({ id, kind: 'objective', width: w, height: h, buffer: copy }, [copy]);
        return;
      }
      loadReader(false)
        .then(() => done(window.TartarusScan.readObjectiveTitle(imageData)))
        .catch((e) => done(null, (e && e.message) || '截圖辨識器無法載入'));
    });
  }

  // The run's objective, printed in the board's corner ("Objective: Prison
  // Walk", and its goal under it with the count so far, "0/4", or
  // "Completed"), read by the text reader while the run's objective isn't
  // known (the popup at its start was missed or misread: the user's Survival
  // of the Fittest run, 2026-10-17, whose "objective" picture was the
  // lobby), and once a day while its goal isn't met: the analyzer often
  // first sees a run midway, and how many consumes or doors are left weighs
  // an early consume for the instrument. One try at a time, three failures
  // in a row a day.
  const corner = { busy: false, tries: 0, day: 0, done: false };
  async function readCornerObjective(source, box) {
    const worker = await ocrWorker();
    if (!worker) return { ok: false };
    const [x0, y0, x1, y1] = box.map(Math.round);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 8 || h < 8) return { ok: false };
    // Small text reads better enlarged.
    const z = Math.max(1, Math.min(3, 600 / w));
    const c = document.createElement('canvas');
    c.width = Math.round(w * z);
    c.height = Math.round(h * z);
    c.getContext('2d').drawImage(source, x0, y0, w, h, 0, 0, c.width, c.height);
    let text = '';
    try {
      text = (await worker.recognize(c)).data.text || '';
    } catch (e) {
      return { ok: false };
    }
    const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
    // The title follows "Objective:" on its line, and a long one wraps onto
    // the next ("Survival of the / Fittest").
    const titled = text.split('\n').map(letters).filter(Boolean).map((l) => (l.includes('objective') ? l.slice(l.indexOf('objective') + 9) : l));
    const tries = titled.concat(titled.slice(0, -1).map((l, i) => l + titled[i + 1])).filter((l) => l.length >= 4);
    let best = null;
    for (const id of Object.keys(T.OBJECTIVES)) {
      if (id === 'other') continue;
      const n = letters(OBJECTIVE_EN[id] || T.OBJECTIVES[id].name);
      for (const t of tries) {
        const d = editDistance(t, n) / n.length;
        if (!best || d < best.d) best = { id, d };
      }
    }
    if (!best || best.d > 0.3) return { ok: false };
    // The goal's count, "0/4" (letters can stick to it: "times0/2"), or
    // "Completed". It can't pass the goal: a digit of the goal's own text
    // can stick to it ("2 times1/2" with "times" missed reads "21/2"), so
    // then only its last digit is the count, if that fits (d8).
    const count = text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    const need = count ? Number(count[2]) : null;
    let have = count ? Number(count[1]) : null;
    if (have !== null && have > need) have = have % 10 <= need ? have % 10 : null;
    return { ok: true, id: best.id, name: T.OBJECTIVES[best.id].name, completed: /completed/i.test(text), have, need: have === null ? null : need };
  }
  // day: the reading's, as Auto Screenshot Mode applies it only after this.
  function cornerObjective(source, box, day) {
    // Each new day, the count again; a new run (the day goes back), all.
    if (day !== corner.day) Object.assign(corner, { tries: 0, done: false });
    corner.day = day;
    const known = model.objective && model.objective !== 'other';
    const counting = known && T.OBJECTIVES[model.objective] && T.OBJECTIVES[model.objective].need && !model.milestone;
    if (corner.busy || corner.tries >= 3 || (known && (corner.done || !counting))) return;
    corner.busy = true;
    corner.tries += 1;
    readCornerObjective(source, box).then((read) => {
      corner.busy = false;
      if (!read.ok) return;
      corner.done = true;
      corner.tries = 0;
      // Advice already given for this board is given again for the board as
      // updated: else every update left it stale, "the board changed" on
      // every turn of a Prison Walk (report 351).
      const wasFresh = fresh();
      const targets = [model, reader.reading && reader.reading.model].filter(Boolean);
      const wasKnown = model.objective && model.objective !== 'other';
      // Not runObjective: that's the popup's, for the run's opening offer.
      if (!wasKnown) for (const m of targets) m.objective = read.id;
      // The count is this objective's: the higher of it and what's counted
      // already (the run is under way).
      const need = T.OBJECTIVES[read.id].need || 0;
      let counted = false;
      if (model.objective === read.id && need) {
        const have = read.completed ? need : read.need === need ? read.have : null;
        if (have !== null && have > model.walkTiles) {
          for (const m of targets) {
            m.walkTiles = Math.min(have, need);
            if (have >= need) m.milestone = true;
          }
          counted = true;
        }
      }
      if (wasKnown && !counted) return;
      changed();
      if (wasFresh) ask(true);
      const so = counted ? `（${read.completed || read.have >= need ? '已達成' : `目前 ${read.have} / ${need}`}）` : '';
      toast(wasKnown ? `${read.name}：${so.slice(1, -1)}，從盤面角落讀取。` : `這一局的目標：${read.name}${so}，從盤面角落讀取。已設定在「目標」。`, 'ok');
    }, () => {
      corner.busy = false;
    });
  }

  // A card shown before the run (Cage Fight, Iron Law), besides its
  // objective. Iron Law makes the run 30 days long.
  let runStartEvent = null;
  function setStartEvent(id) {
    const card = T.START_EVENTS && T.START_EVENTS[id] ? T.START_EVENTS[id] : null;
    model.startEvent = card ? id : 'none';
    const left = model.maxDays - model.day;
    const days = card && card.days ? card.days : model.maxDays === 30 && id === 'none' ? T.DEFAULT_PARAMS.drillDays : model.maxDays;
    model.maxDays = days;
    model.day = clamp(days - left, 1, days);
    changed();
  }

  function useObjective(read) {
    if (read && read.ok && T.START_EVENTS && T.START_EVENTS[read.id]) {
      runStartEvent = read.id;
      setStartEvent(read.id);
      toast(`這一局的開局卡：${T.START_EVENTS[read.id].name}。已設定在「開局卡」。`, 'ok');
      return true;
    }
    if (!read || !read.ok || !T.OBJECTIVES[read.id]) return false;
    runObjective = read.id;
    model.objective = read.id;
    model.walkTiles = 0;
    model.milestone = false;
    changed();
    toast(`這一局的目標：${read.name}。已設定在「目標」。`, 'ok');
    return true;
  }

  // Reading printed text: Tesseract, loaded the first time it's needed (a
  // pinned version from jsDelivr, cached by the browser). It runs in this
  // browser; the picture isn't sent anywhere. Without it, the cards are
  // read by their art alone.
  // A load that fails is tried again with the next picture (a network
  // hiccup mustn't turn the names off until the page reloads); one that
  // hangs gives up after 20 s for this picture, so the art reading goes
  // ahead, and keeps loading for the next. ocrError: why the last try
  // didn't give a reader, for the reading (report 111).
  let ocr = null;
  let ocrError = '';
  function ocrWorker() {
    if (!ocr) {
      ocr = new Promise((resolve, reject) => {
        if (window.Tesseract) return resolve();
        const sc = document.createElement('script');
        sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
        sc.onload = resolve;
        sc.onerror = () => reject(new Error('程式檔沒有下載成功'));
        document.head.appendChild(sc);
      })
        .then(() => window.Tesseract.createWorker('eng'))
        .then((w) => {
          ocrError = '';
          return w;
        }, (e) => {
          ocrError = String((e && e.message) || e || '沒有載入');
          ocr = null;
          return null;
        });
    }
    const limit = new Promise((resolve) => setTimeout(() => {
      if (!ocrError) ocrError = '載入超過 20 秒';
      resolve(null);
    }, 20000));
    return Promise.race([ocr, limit]);
  }

  function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[b.length];
  }

  // The instrument a card's text names: the known name it's closest to,
  // when that's clearly closer than any other. null when it isn't.
  function nameFromText(text) {
    const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
    // The whole text, each line, and each two lines together: a long name
    // ("Iron Tongs of Lust: Mammoth") can wrap onto a second line.
    const lines = text.split('\n');
    const pairs = lines.slice(1).map((l, i) => `${lines[i]} ${l}`);
    const tries = [text, ...lines, ...pairs].map(letters).filter((t) => t.length >= 3);
    const scores = T.TOOL_IDS.map((id) => {
      // The full name, and the part before a colon ("Iron Tongs of Lust").
      const forms = [...new Set([T.toolNameEn(id), T.toolNameEn(id).split(':')[0]].map(letters))];
      return { id, score: Math.min(...forms.flatMap((n) => tries.map((t) => editDistance(t, n) / n.length)), 9) };
    }).sort((a, b) => a.score - b.score);
    const [best, next] = scores;
    return best && best.score <= 0.3 && (!next || next.score - best.score >= 0.15) ? best : null;
  }

  // The three cards' names, left to right, from the band under each card's
  // art (a raised card's title sits a little higher, inside the band). ui:
  // the cards' size the reader found (see scanPick).
  async function readCardNames(canvas, ui) {
    const worker = await ocrWorker();
    if (!worker) {
      // No names read: why, for the reading.
      const none = [null, null, null];
      none.failed = ocrError || '沒有載入';
      return none;
    }
    const s = ui || canvas.height / 1080;
    const top = canvas.height / 2 - 540 * s;
    const out = [];
    for (let k = -1; k <= 1; k++) {
      const c = canvas.width / 2 + k * 480 * s;
      // Small cards' names enlarged to their size on a 1080-pixel-high
      // screen: the text reader misses the small ones.
      const z = Math.max(1, 1 / s);
      const crop = document.createElement('canvas');
      crop.width = Math.round(430 * s * z);
      crop.height = Math.round(130 * s * z);
      crop.getContext('2d').drawImage(canvas, Math.round(c - 215 * s), Math.round(top + 420 * s), Math.round(430 * s), Math.round(130 * s), 0, 0, crop.width, crop.height);
      try {
        const { data } = await worker.recognize(crop);
        out.push(nameFromText(data.text || ''));
      } catch (e) {
        out.push(null);
      }
    }
    return out;
  }

  // The Warden's Treasure screen, from its printed text: its header
  // ("Warden's Treasure obtained"), or two or more of the four gifts'
  // names. Follow my game knows this screen from the game's log; this is
  // for pasted pictures and Take a picture now.
  async function readTreasure(source) {
    const worker = await ocrWorker();
    if (!worker) return { ok: false, treasure: true, reason: `文字辨識器無法載入（${ocrError || '沒有載入'}）` };
    const scale = Math.min(1, 1600 / source.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    let text = '';
    try {
      text = (await worker.recognize(canvas)).data.text || '';
    } catch (e) {
      return { ok: false, treasure: true, reason: '無法辨識文字' };
    }
    const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
    const lines = text.split('\n').map(letters).filter((l) => l.length >= 4);
    const header = lines.some((l) => l.includes('treasureobtained') || l.includes('wardenstreasure'));
    const gifts = T.GIFT_IDS.filter((id) => {
      const n = letters(T.toolNameEn(id));
      return lines.some((l) => l.includes(n) || editDistance(l, n) / n.length <= 0.3);
    });
    return { ok: header || gifts.length >= 2, treasure: true, header, gifts };
  }

  // A pasted picture with no board in it: the instrument pick, or the
  // Warden's Treasure. A pick is a fresh run's when the board before was
  // a run's last day (or there's none); otherwise an objective's reward.
  async function otherScreen(source) {
    const pick = await readPick(source);
    const second = pick.ok ? pick.cards.map((c) => c.conf).sort((a, b) => b - a)[1] : 0;
    if (pick.ok && (pick.byName >= 2 || second >= 0.5)) {
      const fresh = model.day >= model.maxDays || (!model.tools.length && model.day <= 1);
      usePick(pick, fresh);
      return true;
    }
    const tr = await readTreasure(source);
    if (tr.ok) {
      useTreasure();
      return true;
    }
    langMissed('screen', source, pick.ok ? '刑具卡沒有讀到' : pick.reason);
    return false;
  }

  function readPick(source) {
    const scale = Math.min(1, 2600 / source.width);
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const t0 = performance.now();
    setReading(true);
    return new Promise((resolve) => {
      const done = (result, error) => {
        setReading(false);
        const ms = Math.round(performance.now() - t0);
        if (error || !result) return resolve({ ok: false, pick: true, reason: error || '沒有結果', ms });
        if (!result.ok) return resolve({ ok: false, pick: true, reason: result.reason, ms });
        const cards = result.cards.map((c) => ({ sim: c.sim, name: T.toolName(c.sim), conf: c.conf, alts: c.alts, by: 'art' }));
        // Each card's printed name, read where it can be, outranks its art.
        readCardNames(canvas, result.ui).then((names) => {
          names.forEach((n, i) => {
            if (n && cards[i]) Object.assign(cards[i], { sim: n.id, name: T.toolName(n.id), conf: 1, by: 'name' });
          });
          resolve({ ok: true, pick: true, cards, names: cards.map((c) => c.name), unsure: cards.filter((c) => c.conf < 0.5).length, reroll: !!result.reroll, byName: cards.filter((c) => c.by === 'name').length, ocrFailed: names.failed || '', ms: Math.round(performance.now() - t0) });
        });
      };
      reader.pickId += 1;
      const id = `pick${reader.pickId}`;
      if (readerWorker()) {
        reader.picks.set(id, done);
        const copy = imageData.data.slice().buffer;
        reader.worker.postMessage({ id, kind: 'pick', width: w, height: h, buffer: copy }, [copy]);
        return;
      }
      loadReader(true)
        .then(() => done(window.TartarusScan.scanPick(imageData, window.TARTARUS_SCAN, window.TARTARUS_PICK)))
        .catch((e) => done(null, (e && e.message) || '截圖辨識器無法載入'));
    });
  }

  // An instrument offer. A fresh run's (fresh, the default): the board
  // behind the offer isn't known yet, so it starts blank, with the
  // player's settings kept. One mid-run (an objective's reward): on the
  // board as it is. Either way the offer is set as the step, and the advice
  // says which to take, or to re-roll. Cards the reader wasn't sure of are
  // named for checking.
  function usePick(read, fresh) {
    if (!read || !read.ok) return false;
    const start = fresh !== false;
    reader.undoable = true;
    undo.push({ model: JSON.parse(JSON.stringify(model)), selected, shot });
    if (undo.length > 30) undo.shift();
    if (start) {
      // runStart: this blank board is a run's opening offer, never shared,
      // even on a Recheck after fixing a card.
      // The run's objective: its popup came just before, or this is a
      // re-roll of the run's opening offer, which keeps what was set.
      const again = model.runStart && model.step === 'choice';
      const keep = { mode: model.mode, rewards: model.rewards, maxDays: model.maxDays, runStart: true, objective: runObjective || (again ? model.objective : 'other'), walkTiles: again ? model.walkTiles : 0, startEvent: runStartEvent || (again ? model.startEvent : 'none') };
      runObjective = null;
      runStartEvent = null;
      model = normalize(Object.assign(blankModel(), keep));
      shot = false;
      flags = new Set();
      via = null;
      selected = model.warden;
    }
    if (start) gifts.waiting = 0;
    model.step = 'choice';
    model.choice = { kind: 'tool', options: read.cards.map((c) => c.sim), rerolls: read.reroll ? 1 : 0 };
    applied = null;
    solver.st = null;
    reader.folded = true;
    renderScan();
    scanStatus('');
    changed();
    const unsure = read.cards.filter((c) => c.conf < 0.5);
    const check = unsure.length ? `請檢查${unsure.map((c) => `${['左邊', '中間', '右邊'][read.cards.indexOf(c)]}那張（讀成「${c.name}」）`).join('和')}：如果不對，在「刑具或珍藏」下修改，然後按「重新檢查」。` : '';
    // No card's name could be read (the text reader didn't load): the art
    // alone can name an instrument that wasn't offered (report 111 advised
    // taking Kin's Coin), so the offer is checked before any advice.
    if (read.ocrFailed && !read.byName) {
      toast(`刑具選擇僅依卡片圖案讀成：${read.names.join('、')}，卡片名稱沒能讀到（文字辨識器：${read.ocrFailed}）。請在「刑具或珍藏」下檢查這三張，再按「重新檢查」取得建議。`, 'bad');
      return false;
    }
    const asked = ask(true, start);
    toast(`${start ? '新的一局：刑具選擇是' : '刑具選擇：'}${read.names.join('、')}${read.reroll ? '，還能重骰一次' : ''}。${asked ? '該拿哪個請看下方。' : '需要先修正才能給建議。'}${check}`, unsure.length ? 'bad' : 'ok');
    return asked;
  }

  // The Warden's Treasure's picks: one a Treasure, or 3 with Opulence ("2
  // additional choices"). Auto Screenshot Mode counts, from the game log,
  // each Rainbow (each opens a Treasure) and each pick confirmed
  // (js/follow.js); the picks waiting are each new Rainbow's picks less each
  // one confirmed. The first counts this page hears only start the tally.
  const picksPer = () => ((T.START_EVENTS || {})[model.startEvent] || {}).picks || 1;
  const gifts = { log: null, waiting: 0, board: null };
  function giftCounts(c) {
    if (!c || !Number.isFinite(c.rainbows) || !Number.isFinite(c.taken)) return null;
    const was = gifts.log;
    if (was && c.rainbows >= was.rainbows && c.taken >= was.taken) gifts.waiting = Math.max(0, gifts.waiting + (c.rainbows - was.rainbows) * picksPer() - (c.taken - was.taken));
    gifts.log = { rainbows: c.rainbows, taken: c.taken };
    return gifts.waiting;
  }
  // A pick confirmed, or a Rainbow, since the board behind the Treasure was
  // last seen: the board changed, so it's seen again before the next advice.
  const pickedSinceBoard = () => !!gifts.log && (!gifts.board || gifts.log.taken > gifts.board.taken || gifts.log.rainbows > gifts.board.rainbows);
  // The picks waiting now, this one included: the log's tally, or for
  // screenshots, what was set (a new Treasure starts at the card's picks).
  function picksNow() {
    // A Treasure the tally missed the Rainbow of (this page opened during
    // it): the card's picks, as a guess for this screen only.
    if (gifts.log) return gifts.waiting > 0 ? gifts.waiting : picksPer();
    return model.step === 'choice' && model.choice.kind === 'gift' ? model.choice.picks || 1 : picksPer();
  }

  // The Warden's Treasure, opened by a Chromatic prisoner (Follow my game
  // knows it from the log): the gift to take, on the last board known.
  // Nothing is read from the picture: every gift is on offer. after is
  // what led to it, from the log: right after a swap, the newcomer was a
  // Rainbow, so it's in the vault and its cell locked again; after a
  // consume, today's consume is used.
  function useTreasure(after) {
    const gift = () => {
      const picks = picksNow();
      model.step = 'choice';
      model.choice = { kind: 'gift', options: [], rerolls: 0, picks };
      applied = null;
      solver.st = null;
    };
    // The board behind the Treasure has just been read (View Prison
    // Status): the gift advice uses it.
    if (after === 'view') {
      gift();
      model.treasureWait = false;
      model.treasureSeen = true;
      gifts.board = gifts.log ? Object.assign({}, gifts.log) : null;
      changed();
      renderScan();
      const asked = ask(true);
      toast(`已讀到典獄長的珍藏後面的盤面。${asked ? '該拿哪個珍品請看下方。' : '盤面需要先修正才能給建議。'}`, asked ? 'ok' : 'bad');
      return asked;
    }
    // Back at the Treasure after viewing the board: nothing more to wait for,
    // unless a pick was confirmed since (Opulence's next pick).
    if (model.step === 'choice' && model.choice.kind === 'gift' && model.treasureSeen && !pickedSinceBoard()) {
      const picks = picksNow();
      if (picks === model.choice.picks) return fresh() && settled() ? true : ask(true);
      // A pick's Rainbow brought more picks: the advice weighs them.
      model.choice = Object.assign({}, model.choice, { picks });
      changed();
      return ask(true);
    }
    undo.push({ model: JSON.parse(JSON.stringify(model)), selected, shot });
    if (undo.length > 30) undo.shift();
    reader.undoable = true;
    let how = '';
    const w = model.cells[model.warden];
    if (after === 'swap' && w && w.kind === 'inmate') {
      model.cells[model.warden] = T.DEFAULT_PARAMS.reusableCells ? sealedCell() : { kind: 'empty' };
      model.vault = [...model.vault, w.beast];
      model.swapUsed = true;
      model.consumeOffered = true;
      how = `它來自你在 ${L(model.warden)} 號牢房的替換：換進來的是綺彩囚犯，現在在收容區，那間牢房又鎖上了。`;
    } else if (after === 'consume') {
      model.devourUsed = true;
      how = '它來自你的吞噬：下一張畫面會顯示吞噬後的盤面。';
    }
    // The Treasure covers the board, which may have changed (a chain, a
    // Rainbow): no gift is advised until the board behind it is seen.
    gift();
    model.treasureWait = true;
    model.treasureSeen = false;
    changed();
    renderScan();
    toast(`典獄長的珍藏已開啟。${how}要依目前的盤面建議珍品，請在遊戲中按「查看監獄狀態」，在盤面停留一秒，再回到典獄長的珍藏。`, 'ok');
    return false;
  }

  // Without workers (a page opened from disk), reads on the page itself,
  // loading the reader the first time.
  function scanHere(imageData, id, done) {
    const ready = loadReader(true);
    ready
      .then(() => {
        setTimeout(() => {
          try {
            const result = window.TartarusScan.scan(imageData, window.TartarusScan.withPanelIcons(window.TARTARUS_SCAN, window.TARTARUS_PICK), { lang: gameLang });
            if (result.tools && result.tools.tools) for (const t of result.tools.tools) Object.assign(t, window.TARTARUS_SCAN.toolNames[t.id] || {});
            done(result);
          } catch (e) {
            done(null, e.message);
          }
        }, 30);
      })
      .catch(() => done(null, '截圖辨識器無法載入'));
  }

  // The reader doesn't see Tusk marks yet. A mark stays on its inmate until
  // it's used or the inmate goes, so a mark the board before knew (set by
  // hand, or kept from an earlier picture of the run) stays while the same
  // beast is still in the cell, at the same rarity or higher.
  function keptTusk(base, n, beast, tier) {
    const was = base && base.cells && base.cells[n];
    return !!(was && was.kind === 'inmate' && was.ivory && was.beast === beast && tier >= was.tier);
  }

  // The board the reading describes, built on the current settings (goal,
  // food chain, run length), plus the cells to check.
  // A devour's meal pick ("Select an Inmate to Consume"). The game darkens
  // all but the eater and its meals there, so rarities can't be read: the
  // board is the turn before (the one loaded here), with what this picture
  // does show. The eater in the warden's cell as it is now, the cells eaten
  // so far (they lock again), and the meals on offer, which share the
  // eater's rarity. With nothing eaten yet and the eater unchanged, it's the
  // day's devour being aimed, not a chain.
  function chainToModel(r, base) {
    const m = JSON.parse(JSON.stringify(base));
    const checks = new Set();
    const notes = [];
    const warden = r.warden ? r.warden.cell : base.warden;
    // The turn before: the same warden after the patrol, or the patrol that
    // brought the warden here.
    const after = base.warden === warden && (base.step === 'manage' || base.step === 'chain');
    const walked = base.step === 'patrol' && (base.dest || []).includes(warden);
    if (!after && !walked) {
      // Nothing to build on: the board as read, its darkened rarities marked.
      r.cells.forEach((c, n) => {
        if (n === T.OFFICE || n === warden) return;
        if (c.kind === 'locked') m.cells[n] = { kind: 'sealed', event: null };
        else if (c.kind === 'inmate') m.cells[n] = { kind: 'inmate', beast: c.beast, tier: clamp(c.tier, 0, TOP_TIER), ivory: keptTusk(base, n, c.beast, clamp(c.tier, 0, TOP_TIER)), prey: null };
        else m.cells[n] = { kind: 'empty' };
        if (c.kind !== 'locked') checks.add(n);
      });
      notes.push('吞噬的選獵物畫面會讓盤面變暗，所以稀有度是猜的：請檢查標記的牢房，或先載入吞噬前的盤面。');
    }
    m.warden = warden;
    const was = base.cells[warden];
    const eater = r.cells[warden];
    // Cells the chain has eaten show a padlock again. The meal pick darkens
    // padlocks enough to read as an empty cell (reports 314 and 322), which
    // the live board never has, so a cell that held an inmate and now reads
    // empty was eaten too. Missing it took the chain for the day's first
    // consume, and the advice said Replace.
    let eaten = 0;
    if (after || walked) {
      r.cells.forEach((c, n) => {
        if (n === T.OFFICE || n === warden || (c.kind !== 'locked' && c.kind !== 'empty') || m.cells[n].kind !== 'inmate') return;
        m.cells[n] = { kind: 'sealed', event: null };
        eaten += 1;
      });
    }
    // Nothing eaten yet and the same beast in the warden's cell: the day's
    // first meal pick, where the eater can't have changed. The meal screen's
    // red light makes the reader's rarities unreliable there (report 337: an
    // eater read as Supreme, and the advice turned from its consume to End),
    // so the board before's eater and meals stand. A chain's eater rose and
    // re-rolled its beast, so there the reading stands.
    const sameBeast = !!was && was.kind === 'inmate' && !!eater && eater.kind === 'inmate' && was.beast === eater.beast;
    const first = eaten === 0 && (walked || sameBeast);
    if (first && was && was.kind === 'inmate') m.cells[warden] = JSON.parse(JSON.stringify(was));
    else if (eater && eater.kind === 'inmate') m.cells[warden] = { kind: 'inmate', beast: eater.beast, tier: clamp(eater.tier, 0, TOP_TIER), ivory: !!(was && was.ivory), prey: was && was.kind === 'inmate' ? was.prey : null };
    else {
      checks.add(warden);
      notes.push('沒讀到典獄長所在牢房的吞噬者：請照現在的樣子設定。');
    }
    const tier = m.cells[warden].kind === 'inmate' ? m.cells[warden].tier : 0;
    // The meals on offer: the board before keeps its inmate when it fits;
    // otherwise the beast read here, at the eater's rarity. A scratched door
    // stays a door.
    for (const n of r.chain.targets) {
      const c = m.cells[n];
      if (c.kind === 'scratch') continue;
      if (c.kind === 'inmate' && c.tier <= tier && (!r.cells[n].beast || c.beast === r.cells[n].beast)) continue;
      m.cells[n] = { kind: 'inmate', beast: r.cells[n].beast || (c.kind === 'inmate' ? c.beast : 'mammoth'), tier, ivory: c.kind === 'inmate' ? !!c.ivory : false, prey: null };
      checks.add(n);
    }
    m.step = first ? 'manage' : 'chain';
    m.devourUsed = m.step === 'chain';
    // The meal pick shows the meals and Cancel, never Replace. A chain taken
    // for the day's first consume (report 323: the board before didn't hold
    // the meal already eaten) has no Replace after Cancel either, so the
    // advice weighs the meals against not consuming. No Hunt either (report
    // 128: after a Cancel, the Prey mark advised couldn't be made).
    if (m.step === 'manage') {
      m.swapUsed = false;
      m.noSwap = true;
      m.noHunt = true;
    }
    m.dest = [];
    m.chainArmed = false;
    // Only the meals the game framed can be eaten now (report 385: the
    // board before held a meal the game didn't offer, and it was advised).
    m.mealOnly = r.chain.targets.slice();
    const tools = (m.tools || []).map((id) => ({ id, sim: id, name: T.toolName(id), conf: 1 }));
    return { model: m, checks, notes, chromatic: (m.vault || []).length, tools, unsim: [], chain: r.chain.targets };
  }

  // A run's instruments, from what's known of the run and what a screenshot
  // shows. Instruments are only ever added, from an offer, so once the run
  // is known (instruments held, or an offer seen), only an offer the
  // analyzer saw can add one: the instrument read on it, or failing that,
  // the one the analyzer advised. Icons alone never add one, as two can look
  // alike (a tooltip can cover them, too). Without anything known of the
  // run, only icons the reader is sure of count. A screenshot from an
  // earlier day than the board before starts afresh.
  // sims: the instruments the reader can tell on a panel (any other reads
  // as something else).
  function runTools(read, base, m, notes, sims) {
    const sameRun = !(m.day < base.day);
    const known = sameRun ? (base.tools || []).filter((id) => T.TOOLS[id]) : [];
    const offer = sameRun && base.step === 'choice' && base.choice && base.choice.kind === 'tool' ? base.choice.options.filter((id) => T.TOOLS[id]) : [];
    const out = known.map((id) => ({ id, sim: id, name: T.toolName(id), conf: 1, kept: true }));
    const has = (id) => out.some((t) => t.sim === id);
    const slots = read.length;
    // A set run: once the run's instruments are known (the offers the
    // analyzer saw and advised, or the player's confirmation), they're
    // presumed and locked (m.toolsLocked), and icons never change them. The
    // user: "once the instruments have been recommended and selected, it
    // should presume those are the instruments and not say anything unless
    // it sees more total instruments than it already had". So the only
    // question is a panel showing more than the run has and than the count
    // last confirmed (m.toolsSeen).
    m.toolsToConfirm = '';
    m.toolsPanel = slots;
    if (!sameRun) {
      m.toolsLocked = false;
      m.toolsSeen = 0;
    }
    if (sameRun && (known.length || offer.length || base.runStart || base.toolsLocked)) {
      if (offer.length && slots > known.length && !offer.some(has)) {
        const seen = read.filter((t) => offer.includes(t.sim)).sort((a, b) => b.conf - a.conf)[0];
        // An icon read as an instrument that wasn't offered can still be one
        // that was: the closest offered one among its runner-ups (report 75:
        // the Forged Key read as the Lost Ring of Keys).
        let alike = null;
        if (!seen) {
          for (const t of read) {
            if (has(t.sim)) continue;
            const a = (t.alts || []).find((x) => x.sim && offer.includes(x.sim) && x.score >= 0.7);
            if (a && (!alike || a.score > alike.score)) alike = { sim: a.sim, score: a.score, as: t.sim };
          }
        }
        // The advice given on that offer: the board before is the offer, so
        // the analyzer's current recommendation is for it.
        const rec = base === model && fresh() ? recommendation() : null;
        const advised = rec && rec.action && rec.action.type === 'choose' && offer.includes(rec.action.id) ? rec.action.id : null;
        const take = seen ? seen.sim : alike ? alike.sim : advised;
        if (take) {
          out.push({ id: take, sim: take, name: T.toolName(take), conf: 1, kept: true });
          if (!seen && alike) notes.push(`有個圖示讀成「${alike.as ? T.toolName(alike.as) : '另一件刑具'}」，但它不在選項中：視為選項中最接近的「${T.toolName(take)}」。如果你拿的是別的，請在「刑具」下修改。`);
          else if (!seen) notes.push(`視為你照建議拿了「${T.toolName(take)}」。如果你拿的是別的，請在「刑具」下修改。`);
        } else notes.push(`你的刑具比之前多了一件，來自「${offer.map((id) => T.toolName(id)).join('、')}」的選擇：請在「刑具」下設定你拿了哪個。`);
      }
      if (out.length) m.toolsLocked = true;
      if (slots > Math.max(out.length, base.toolsSeen || 0)) m.toolsToConfirm = `你的面板顯示${T.plural(slots, '件刑具')}，分析器只有 ${out.length} 件：${out.map((t) => t.name).join('、') || '無'}。請設定你持有的刑具，然後按「這些沒錯」。`;
      return out;
    }
    // Nothing known of the run yet: only icons the reader is sure of, and
    // the player is asked to confirm.
    for (const t of read) if (t.sim && !has(t.sim) && t.conf >= TOOL_SURE) out.push(t);
    if (read.length) m.toolsToConfirm = `分析器還不知道這一局的刑具。從你面板上的 ${read.length} 件中讀到：${out.length ? out.map((t) => T.toolName(t.sim)).join('、') : '沒有能確定的'}。請設定你持有的刑具，然後按「這些沒錯」。`;
    return out;
  }

  function scanToModel(r, base) {
    if (r.chain) return chainToModel(r, base);
    const m = JSON.parse(JSON.stringify(base));
    const checks = new Set();
    const notes = [];
    // Days until the riot set how much of the run is left.
    if (r.days) {
      const left = r.days.days;
      if (left < m.maxDays) m.day = Math.max(1, m.maxDays - left);
      else if (left < 30) {
        // More days left than the run has: only Iron Law's 30-day run has
        // that many.
        m.maxDays = 30;
        m.day = 30 - left;
        notes.push(`距離暴動還有${T.plural(left, '天')}，比這一局原本的天數還多，所以現在視為 30 天的一局（鐵律）。請檢查天數。`);
      } else {
        // No run is that long: a misread countdown. It mustn't stretch the
        // run for good (one read as 38 made every later day "of 39").
        notes.push(`距離暴動的天數讀成 ${left}，比任何一局都長：請檢查天數。`);
      }
    } else notes.push('沒讀到距離暴動的天數：請檢查天數。');
    r.cells.forEach((c, n) => {
      if (n === T.OFFICE) return;
      if (c.kind === 'locked') {
        if (c.nest) {
          m.cells[n] = { kind: 'nest', due: m.day + 2 };
          checks.add(n);
        } else {
          // A door whose rarity shows, as read: a "?" portrait, scratched by
          // the Filthy Claws or not (report 243). A scratch stays while the
          // door is locked, even if its slashes weren't read.
          // What the player knew of a door that's still locked stays too: a
          // rarity shown (Crow Whispers, or the "Treasure" Hunt's "?"
          // portrait) and the Hunt's Rare or better.
          const was = base.cells[n];
          const event = c.event ? 'unknown' : null;
          if (c.shown) {
            m.cells[n] = { kind: c.shown.scratch || (was && was.kind === 'scratch') ? 'scratch' : 'revealed', tier: clamp(c.shown.tier, 0, TOP_TIER), event };
            if (c.shown.conf < 0.6) checks.add(n);
          } else if (was && (was.kind === 'revealed' || was.kind === 'scratch')) m.cells[n] = { kind: was.kind, tier: was.tier, event };
          else if (was && was.kind === 'sealed' && was.atLeast) m.cells[n] = { kind: 'sealed', event, atLeast: was.atLeast };
          else m.cells[n] = { kind: 'sealed', event };
        }
        if (c.conf < 0.6) checks.add(n);
      } else if (c.kind === 'inmate') {
        // The gold crosshair under a portrait: someone's Prey mark (report 352).
        m.cells[n] = { kind: 'inmate', beast: c.beast, tier: clamp(c.tier, 0, TOP_TIER), ivory: keptTusk(base, n, c.beast, clamp(c.tier, 0, TOP_TIER)), prey: null, marked: !!c.prey, event: c.event ? 'unknown' : null };
        if (c.conf < 0.6 || c.ghost) checks.add(n);
      } else {
        m.cells[n] = { kind: 'empty' };
        checks.add(n);
      }
    });
    // Most cells read as open and empty, which a board rarely is: it was
    // likely placed wrong (a screen shape the reader handled badly, report
    // 144), so the reading is checked before it's trusted.
    const emptyRead = r.cells.filter((c) => c.n !== T.OFFICE && c.kind !== 'locked' && c.kind !== 'inmate').length;
    if (emptyRead >= 8) notes.push(`有 ${emptyRead} 間牢房讀成已開啟且空著，這很少見：盤面可能讀錯了。請和遊戲比對。`);
    if (r.warden) {
      m.warden = r.warden.cell;
      if (r.warden.conf < 0.6) checks.add(r.warden.cell);
    } else notes.push('沒找到典獄長的箭頭：請設定典獄長的位置。');
    if (r.doors && r.doors.cells.length) {
      m.step = 'patrol';
      m.dest = r.doors.cells.filter((n) => n !== m.warden);
      // The mouse pointer over a card's number hides its digit (report 318),
      // unless the lit cells settled it (report 360). Unsettled, that door is
      // marked Check: a guess, not a reading.
      if (r.doors.hidden && r.doors.hidden.length && r.doors.lit) notes.push(`滑鼠游標蓋住了一張卡片上的編號：從亮起的牢房看，它是 ${L(r.doors.hidden[0])} 號牢房。`);
      else if (r.doors.hidden && r.doors.hidden.length) {
        notes.push(`滑鼠游標蓋住了讀成 ${r.doors.hidden.map((n) => L(n)).join('、')} 號牢房那張卡片的編號：請檢查那扇門。`);
        r.doors.hidden.forEach((n) => checks.add(n));
      }
      else if (r.doors.conf < 0.6) notes.push('今天的門不太好辨識：請檢查。');
    } else if (!r.decision && !r.statusView && base.step === 'patrol' && (base.dest || []).length && m.day === base.day && m.warden === base.warden) {
      // No door cards and no buttons, on the same day with the warden where
      // it was: the cards haven't come back yet (report 334: pictured just
      // after a Warden's Treasure closed), so the doors stay as they were.
      m.step = 'patrol';
      m.dest = base.dest.slice();
      notes.push('畫面上沒有門卡片也沒有按鈕（可能還沒出現）：今天的門沿用上一個盤面。');
    } else {
      m.step = 'manage';
      m.dest = [];
      m.devourUsed = false;
      m.swapUsed = false;
    }
    m.chainArmed = false;
    // The cards under “Make Your Decision” are what the game allows now: a
    // swap only with a Replace card, a consume only with a Consume card. A
    // Consume card with no Replace card is a consume on offer, even after
    // today's swap.
    m.consumeOffered = false;
    m.treasureWait = false;
    m.treasureSeen = false;
    m.noSwap = false;
    m.noDevour = false;
    m.noHunt = false;
    m.huntOnly = null;
    m.officeOnly = null;
    m.mealOnly = null;
    // Without the cards (a picture taken as they come up), a board of the
    // same day with the warden in the same cell keeps what the board
    // before knew. And if the warden's inmate has changed since, today's
    // swap is done: it isn't advised again, while a consume still can be.
    const sameVisit = m.day === base.day && m.warden === base.warden && ['manage', 'choice', 'event'].includes(base.step);
    if (!r.decision && sameVisit && m.step === 'manage') {
      m.swapUsed = !!base.swapUsed;
      m.devourUsed = !!base.devourUsed;
      m.noSwap = !!base.noSwap;
      m.noDevour = !!base.noDevour;
      m.noHunt = !!base.noHunt;
      m.consumeOffered = !!base.consumeOffered;
      const was = base.cells[m.warden];
      const now = m.cells[m.warden];
      if (!m.devourUsed && was && now && was.kind === 'inmate' && now.kind === 'inmate' && (was.beast !== now.beast || was.tier !== now.tier)) {
        m.swapUsed = true;
        m.consumeOffered = true;
        notes.push('典獄長所在牢房的囚犯和上一個盤面不同，所以視為今天已經替換過。');
        m.cells[m.warden].ivory = false; // a Tusk mark is used by the Replace
      }
    }
    // “Select an Objective” with the warden on a Lion and the Blood-Stained
    // Trap held: the Hunt's pick of its prey when only some cells are framed
    // (report 352: the Lion's 3 meals), not the Sewer Ratway's, which frames
    // all 15. Without the frames read, it's the Hunt's when it comes right
    // after this visit's cards (the Ratway's follows its event card).
    const here = m.cells[m.warden];
    const trap = (m.tools || []).includes('trap') || ((r.tools && r.tools.tools) || []).some((t) => t.sim === 'trap');
    const framed = r.decision && r.decision.ratway && Array.isArray(r.decision.framed) && r.decision.framed.length ? r.decision.framed : null;
    const lionHere = !!here && here.kind === 'inmate' && here.beast === 'lion';
    const huntPick = !!(r.decision && r.decision.ratway) && trap && lionHere && (framed ? framed.length < 14 : base.step === 'manage' && m.day === base.day && m.warden === base.warden);
    if (r.decision && r.decision.office) {
      // The office's Instigate and Bestow cards. The game can show just one
      // (report 383: Bestow alone), when the reader tells them apart.
      m.step = 'office';
      m.dest = [];
      const ins = r.decision.instigate;
      const bes = r.decision.bestow;
      if (ins === false && bes) m.officeOnly = 'bestow';
      else if (bes === false && ins) m.officeOnly = 'instigate';
    } else if (huntPick) {
      // Only the Hunt is open now, on the framed cells.
      m.step = 'manage';
      m.dest = [];
      m.swapUsed = false;
      m.devourUsed = false;
      m.noSwap = true;
      m.noDevour = true;
      if (framed) m.huntOnly = framed.slice();
    } else if (r.decision && r.decision.ratway) {
      // The Sewer Ratway's cell pick: a move to any cell but the office.
      m.step = 'ratway';
      m.dest = [];
    } else if (r.decision) {
      // A missing card means that move isn't on offer now, not that it was
      // used: a used consume would rule out today's swap too.
      m.swapUsed = false;
      m.devourUsed = false;
      m.noSwap = !r.decision.replace;
      m.noDevour = !r.decision.consume;
      // A Hunt marks an inmate the Lion could consume, so it's offered only
      // beside a Consume card (reports 353-355: a Hunt advised with only End
      // showing). A reader that tells the Hunt card says so itself. And one
      // gone stays gone for the visit (report 128: none after a meal pick's
      // Cancel).
      m.noHunt = ('hunt' in r.decision ? !r.decision.hunt : !r.decision.consume) || (sameVisit && !!base.noHunt);
      // A Consume card after today's swap is a consume on offer.
      m.consumeOffered = !!r.decision.consume;
    }
    const read = r.tools && r.tools.tools ? r.tools.tools : [];
    const unsim = read.filter((t) => !t.sim);
    if (unsim.length) notes.push(`模擬器還沒有這些，所以先略過：${unsim.map((t) => t.name).join('、')}。`);
    const tools = runTools(read, base, m, notes, r.tools && r.tools.sims);
    m.tools = tools.map((t) => t.sim);
    // A door short two mornings of the run, with none of the instruments
    // that take one known: the Forged Key, Barbed Whip or Burning Stake.
    // The reader can't tell the Forged Key on a panel, and runs that read as
    // holding the Ring of Keys or the Dog Tag see two doors every morning
    // (f5, from the collected boards). Mornings with the office within
    // reach don't count: its card can be missed.
    const takers = ['forged', 'whip', 'stake'];
    if (m.day < base.day) m.shortDays = [];
    const officeNear = [1, 2, 3, 4, 5, 6].some((k) => (m.warden + k) % T.CELL_COUNT === T.OFFICE);
    const doorsDue = T.DEFAULT_PARAMS.destinations - m.tools.filter((id) => takers.includes(id)).length;
    if (m.step === 'patrol' && !officeNear && m.dest.length && m.dest.length < doorsDue) m.shortDays = [...new Set([...(m.shortDays || []), m.day])];
    if ((m.shortDays || []).length >= 2 && !m.tools.some((id) => takers.includes(id))) {
      // Held as the Lost Ring of Keys, which takes no door: the Forged Key's
      // icon, two keys on a ring (report 378), passes for it on the panel.
      const hint = m.tools.includes('keys')
        ? `這一局有${T.plural(m.shortDays.length, '個早上')}少了一扇門，遺落的鑰匙串不會這樣，偽造鑰匙才會，而且它的圖示和鑰匙環很像：如果你持有的是偽造鑰匙，請在「刑具」下用它取代遺落的鑰匙串${m.toolsLocked ? '' : '，然後按「這些沒錯」'}。`
        : `這一局有${T.plural(m.shortDays.length, '個早上')}少了一扇門，偽造鑰匙、棘刺鐵鞭或火刑柱會造成這種情況。如果你持有其中一件，請在「刑具」下設定${m.toolsLocked ? '' : '，然後按「這些沒錯」'}。`;
      if (m.toolsLocked || m.toolsToConfirm) notes.push(hint);
      else m.toolsToConfirm = hint;
    }
    if (tools.some((t) => t.conf < TOOL_SURE)) notes.push('有些刑具不太好分辨：請在「刑具」下檢查。');
    const chromatic = r.chromatic ? r.chromatic.count : 0;
    // Their beasts don't show in the slots, and nothing depends on them.
    m.vault = new Array(chromatic).fill('wolf');
    const highest = Math.max(0, ...m.cells.filter((c) => c.kind === 'inmate').map((c) => c.tier));
    // The start card's badge under the instrument panel: the run has that
    // card, in case its popup was missed. Only while no card is set: one the
    // player or a popup set stands (report 358: a Cage Fight badge read as
    // Tyranny undid the player's choice on every picture).
    if (r.badge && r.badge.id && T.START_EVENTS && T.START_EVENTS[r.badge.id] && (!m.startEvent || m.startEvent === 'none')) {
      m.startEvent = r.badge.id;
      notes.push(`開局卡：${T.START_EVENTS[r.badge.id].name}，從刑具下方的徽章讀取。`);
    }
    // A badge that looks like more than one card (Tyranny and Cage Fight):
    // not guessed; the player sets it.
    if (r.badge && r.badge.alike && T.START_EVENTS && (!m.startEvent || m.startEvent === 'none')) {
      const names = r.badge.alike.filter((id) => T.START_EVENTS[id]).map((id) => T.START_EVENTS[id].name);
      if (names.length) notes.push(`從徽章看，這一局的開局卡可能是${names.join('或')}，它們長得很像：請在「開局卡」下設定。`);
    }
    // King of the Caged is met once a Supreme or Chromatic shows. Prison
    // Walk's tiles aren't read, so they keep what was set.
    if (m.objective === 'king') m.milestone = highest >= T.SUPREME || chromatic > 0;
    // The jaws marker shows on every inmate with something to eat. Cells that
    // disagree were probably misread. A washed-out portrait takes the beast
    // that makes the jaws fit.
    const hasTarget = (state, n) => !state.cells[n].sealed && state.cells[n].inmate && T.devourOptions(state, n).length > 0;
    r.cells.forEach((c, n) => {
      if (!c.ghost || m.cells[n].kind !== 'inmate') return;
      let best = null;
      for (const beast of T.BEASTS) {
        const trial = JSON.parse(JSON.stringify(m));
        trial.cells[n].beast = beast;
        const s2 = buildState(Object.assign({}, trial, { step: 'manage' })).st;
        const fit = r.cells.filter((d, k) => d.kind === 'inmate' && d.jaws !== null && hasTarget(s2, k) === !!d.jaws).length;
        if (!best || fit > best.fit) best = { beast, fit };
      }
      m.cells[n].beast = best.beast;
    });
    const { st: final } = buildState(Object.assign({}, m, { step: 'manage' }));
    const oddCells = [];
    r.cells.forEach((c, n) => {
      if (c.kind !== 'inmate' || m.cells[n].kind !== 'inmate') return;
      // Jaws over a Supreme's red glow aren't known (null): no check.
      if (c.jaws !== null && hasTarget(final, n) !== !!c.jaws) {
        checks.add(n);
        oddCells.push(n);
      }
    });
    // The game shows Consume only when the warden's inmate has a meal. With
    // none on the board as read, the advice can't weigh Consume: say why,
    // and where to look.
    const w = m.warden;
    const noMeal = !!(r.decision && r.decision.consume) && w != null && m.cells[w] && m.cells[w].kind === 'inmate' && !hasTarget(final, w);
    if (noMeal) {
      checks.add(w);
      notes.push(`遊戲提供了「吞噬」，但讀到的盤面上，${L(w)} 號牢房的${T.describe(m.cells[w])}沒有東西可吃，所以建議無法評估吞噬：請檢查牠和牠可能吃的囚犯。`);
    }
    const odd = oddCells.filter((n) => !(noMeal && n === w)).length;
    if (odd) notes.push(`有 ${odd} 名囚犯的利齒標記和讀到的內容對不上：請檢查牠們和周圍的囚犯。`);
    // Cage Fight set for this run while the game's jaws fit better without
    // it (report 311: a Legendary Wolf showed no jaws over a Rare Rat that
    // Cage Fight would let it eat, and the advice had a Legendary Lion eat
    // that Rat). No reader sets the card, so it was likely set by hand.
    if (m.startEvent === 'cagefight' && oddCells.length) {
      const plain = buildState(Object.assign({}, m, { step: 'manage', startEvent: 'none' })).st;
      const known = r.cells.map((c, n) => n).filter((n) => r.cells[n].kind === 'inmate' && m.cells[n].kind === 'inmate' && r.cells[n].jaws !== null);
      const fits = (state) => known.filter((n) => hasTarget(state, n) === !!r.cells[n].jaws).length;
      const against = known.filter((n) => !r.cells[n].jaws && hasTarget(final, n) && !hasTarget(plain, n));
      if (against.length && fits(plain) > fits(final)) {
        const n = against[0];
        const meal = T.devourOptions(final, n)[0].cell;
        notes.push(`這一局設了囚徒困鬥，但遊戲裡 ${L(n)} 號牢房的${T.describe(m.cells[n])}沒有顯示利齒標記，而囚徒困鬥會讓牠能吃 ${L(meal)} 號牢房的${T.describe(m.cells[meal])}。如果這一局沒有囚徒困鬥，請把「開局卡」設成「無」。`);
      }
    }
    return { model: m, checks, notes, chromatic, tools, unsim, huntPick };
  }

  function renderScan() {
    const box = $('az-scan-result');
    const r = reader.result;
    box.hidden = !r || !reader.image || reader.folded;
    $('az-scan-show').hidden = !(r && reader.image && reader.folded);
    // A loaded picture can be taken back, if it was read wrong.
    $('az-scan-back').hidden = !(reader.undoable && undo.length);
    $('az-scan-report').hidden = !(r && reader.image && window.TartarusReport);
    if (box.hidden) return;
    drawScan();
    const rd = reader.reading;
    const list = [];
    if (r.ok && rd) {
      const m = rd.model;
      const inmates = m.cells.filter((c) => c.kind === 'inmate').length;
      const locked = m.cells.filter((c) => c.kind === 'sealed' || c.kind === 'nest').length;
      const events = m.cells.filter((c) => c.event).length;
      const nests = m.cells.filter((c) => c.kind === 'nest').length;
      list.push(`<li><b>盤面</b> ${T.plural(inmates, '名囚犯')}、${T.plural(locked, '間上鎖牢房')}${events ? `、${T.plural(events, '個事變')}` : ''}${nests ? `、${T.plural(nests, '個鼠巢')}` : ''}</li>`);
      list.push(`<li><b>典獄長</b> ${r.warden ? (r.warden.cell === T.OFFICE ? '在審訊室' : `${L(r.warden.cell)} 號牢房`) : '沒找到'}</li>`);
      list.push(`<li><b>今天</b> ${rd.chain ? `${m.step === 'chain' ? '連鎖吞噬正在選下一個獵物，或按取消停止' : '今天的吞噬正在選獵物'}：${rd.chain.map(L).join(' 或 ')} 號牢房` : m.step === 'patrol' ? `選一扇門：${m.dest.map(L).join('、')}` : r.decision && r.decision.ratway ? (rd.huntPick ? `尋獵：選狂獅的獵物${(r.decision.framed || []).length ? `，${r.decision.framed.map(L).join('、')} 號牢房` : ''}` : '暗渠鼠道：除了審訊室任選一間牢房') : r.decision && r.decision.office ? (rd.model.officeOnly ? `審訊室：只有${rd.model.officeOnly === 'bestow' ? '賞賜' : '煽動'}` : '審訊室：煽動或賞賜') : r.decision ? `做出決定：${[r.decision.replace && '替換', r.decision.consume && '吞噬', '結束'].filter(Boolean).join('、')}` : '沒有門卡片，所以是巡視之後'}</li>`);
      list.push(`<li><b>暴動</b> ${r.days ? `還有${T.plural(r.days.days, '天')}，所以是第 ${m.day} / ${m.maxDays} 天` : '沒讀到'}</li>`);
      list.push(`<li><b>刑具</b> ${rd.tools.length ? rd.tools.map((t) => esc(t.name || t.id) + (t.sim ? '' : '（未模擬）')).join('、') : '無'}</li>`);
      list.push(`<li><b>綺彩囚犯</b> ${T.plural(rd.chromatic, '名')}${r.chromatic ? '' : '（沒找到面板）'}</li>`);
      if (rd.checks.size) list.push(`<li class="is-check"><b>檢查</b> ${[...rd.checks].sort((a, b) => a - b).map(L).join('、')}：沒把握，已在盤面上標記「檢查」</li>`);
      for (const note of rd.notes) list.push(`<li class="is-note">${esc(note)}</li>`);
    }
    $('az-scan-summary').innerHTML = list.join('');
    // The objective, cut from the screenshot.
    const obj = r.ok && r.objective ? r.objective : null;
    $('az-scan-objective').hidden = !obj;
    if (obj) {
      const c = $('az-scan-objective-canvas');
      const [x0, y0, x1, y1] = obj;
      const w = x1 - x0;
      const h = y1 - y0;
      const scale = Math.min(1.6, 320 / w);
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(reader.image, x0, y0, w, h, 0, 0, c.width, c.height);
    }
  }

  // A wrong reading, or advice for something that isn't in the game: the
  // report sends the picture with what the reader made of it, what the
  // player has changed since (most likely what was misread) and the advice,
  // to retrain the reader on.
  function reportReading() {
    if (!window.TartarusReport || !reader.image || !reader.result) return;
    TartarusReport.open('reading', { image: reader.image, outcome: readingSummary() });
  }

  // A cell in a report: "lion 3", "locked!" (an event), "nest". Tiers by
  // number, 0 Normal to 4 Supreme.
  function cellText(c) {
    if (!c) return '?';
    if (c.kind === 'inmate' || c.kind === 'scouted') return `${c.beast} ${c.tier}${c.kind === 'inmate' && c.event ? '!' : ''}`;
    if (c.kind === 'scratch' || c.kind === 'revealed') return `${c.kind} ${c.tier}`;
    if (c.kind === 'locked' || c.kind === 'sealed') return c.nest ? 'nest' : c.event ? 'locked!' : 'locked';
    return c.kind;
  }

  // What the reader read, up to the collector's 1000 characters (all of it
  // with full): the most useful first.
  function readingSummary(full) {
    const r = reader.result;
    const rd = reader.reading;
    const lines = [`Reader ${SCRIPT_QUERY.replace(/^\?v=/, '') || 'local'}, ${reader.follow ? 'an Auto Screenshot Mode picture' : 'a screenshot'} of ${reader.image.width}×${reader.image.height}, read in ${(reader.ms / 1000).toFixed(1)} s.`];
    // The Warden's Treasure isn't read from a picture: during it, the picture
    // is a board, from before it or seen behind it (reports 349, 363: taken
    // for a board read wrong).
    if (model.step === 'choice' && model.choice.kind === 'gift') lines.push(`The Warden’s Treasure is open (from the game’s log); this picture is ${model.treasureSeen ? 'the board seen behind it' : 'the last board before it'}. Its gifts aren’t read from a picture.`);
    if (!r.ok || !rd) {
      lines.push(`Not read: ${r.reason || 'no result'}`);
      return lines.join('\n');
    }
    const m = rd.model;
    const sure = (x) => (x && x.conf < 0.6 ? '?' : '');
    const today = rd.chain
      ? `meal pick: ${rd.chain.map(L).join(', ')}`
      : r.doors && r.doors.cells.length
        ? `doors ${r.doors.cells.map(L).join(', ')}${sure(r.doors)}`
        : r.decision
          ? r.decision.ratway
            ? (rd.huntPick ? `the Hunt’s pick of its prey${(r.decision.framed || []).length ? `: ${r.decision.framed.map(L).join(', ')}` : ''}` : 'the Sewer Ratway’s pick of a cell')
            : `buttons: ${r.decision.office ? [r.decision.instigate !== false && 'Instigate', r.decision.bestow !== false && 'Bestow'].filter(Boolean).join(', ') : [r.decision.replace && 'Replace', r.decision.consume && 'Consume', 'End'].filter(Boolean).join(', ')}`
          : 'no doors or buttons';
    lines.push(`Day ${m.day} of ${m.maxDays}${r.days ? `, ${r.days.days} days to the riot${sure(r.days)}` : ', riot not read'}; warden ${r.warden ? L(r.warden.cell) + sure(r.warden) : 'not found'}; ${today}.`);
    lines.push(`Cells (tiers 0 Normal to 4 Supreme, ? unsure): ${r.cells.filter((c) => c.n !== T.OFFICE).map((c) => `${L(c.n)} ${cellText(c)}${c.jaws ? ' jaws' : ''}${c.prey ? ' prey' : ''}${c.ghost ? ' faded' : ''}${sure(c)}`).join(', ')}.`);
    const icons = r.tools && r.tools.tools ? r.tools.tools : [];
    lines.push(`Instruments read: ${icons.length ? icons.map((t) => `${t.name || t.id} ${Math.round(100 * t.conf)}%`).join(', ') : 'none'}; used: ${rd.tools.length ? rd.tools.map((t) => `${t.name || t.id}${t.kept ? ' (kept)' : ''}`).join(', ') : 'none'}.`);
    lines.push(`Chromatic ${rd.chromatic}${r.chromatic ? '' : ' (panel not found)'}; objective ${(T.OBJECTIVES[model.objective] || { name: model.objective || 'none' }).name}${T.START_EVENTS && T.START_EVENTS[model.startEvent] ? `; start card ${T.START_EVENTS[model.startEvent].name}` : ''}.`);
    if (rd.checks.size) lines.push(`Check: ${[...rd.checks].sort((a, b) => a - b).map(L).join(', ')}.`);
    // What the player has changed since this reading became the board.
    if (shot && reader.loaded === rd) {
      const changes = [];
      model.cells.forEach((c, n) => {
        if (n !== T.OFFICE && cellText(c) !== cellText(m.cells[n])) changes.push(`${L(n)} ${cellText(m.cells[n])} → ${cellText(c)}`);
      });
      if (model.warden !== m.warden) changes.push(`warden ${L(m.warden)} → ${L(model.warden)}`);
      const doors = (x) => [...x.dest].sort((a, b) => a - b).map(L).join(' ');
      if (model.step === 'patrol' && m.step === 'patrol' && doors(model) !== doors(m)) changes.push(`doors ${doors(m)} → ${doors(model)}`);
      const names = (ids) => ids.map((id) => T.toolName(id)).join(', ') || 'none';
      const had = (m.tools || []).filter(Boolean).sort();
      const has = model.tools.filter(Boolean).sort();
      if (had.join() !== has.join()) changes.push(`instruments ${names(had)} → ${names(has)}`);
      if (model.day !== m.day) changes.push(`day ${m.day} → ${model.day}`);
      if (changes.length) lines.push(`You changed: ${changes.join('; ')}.`);
    }
    // The advice as the player saw it: none until its check is done.
    const working = solver.st && !settled();
    const rec = solver.st && !working ? recommendation() : null;
    lines.push(rec ? `Advice${fresh() ? '' : ' (before your changes)'}: ${rec.label}. ${(rec.why || '').slice(0, 200)}` : working ? 'Advice: still being worked out.' : 'Advice: none.');
    for (const note of rd.notes) lines.push(note);
    const text = lines.join('\n');
    return !full && text.length > 1000 ? `${text.slice(0, 999)}…` : text;
  }

  // The screenshot with what was read drawn over it.
  function drawScan() {
    const r = reader.result;
    const img = reader.image;
    const canvas = $('az-scan-canvas');
    const dpr = window.devicePixelRatio || 1;
    const maxW = Math.min(900, canvas.parentElement.clientWidth || 640);
    const scale = Math.min(1, maxW / img.width) * dpr;
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.style.width = `${Math.round(canvas.width / dpr)}px`;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (!r.ok || !reader.reading) return;
    const checks = reader.reading.checks;
    const doors = new Set(reader.reading.model.step === 'patrol' ? reader.reading.model.dest : []);
    const font = (px) => `600 ${px}px "IBM Plex Mono", "Noto Sans TC", ui-monospace, monospace`;
    // The warden: a ring on the arrow's cell, under the labels.
    if (r.warden) {
      const c = r.cells[r.warden.cell];
      ctx.strokeStyle = '#f28c36';
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.arc(c.x * scale, (c.y - 40 * c.k) * scale, 30 * c.k * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of r.cells) {
      if (c.n === T.OFFICE) continue;
      const x = c.x * scale;
      const y = (c.y - 40 * c.k) * scale;
      const w = 92 * c.k * scale;
      const h = 82 * c.k * scale;
      const check = checks.has(c.n);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = check ? '#f1cd48' : doors.has(c.n) ? '#5fc4b8' : 'rgba(234, 223, 197, 0.55)';
      ctx.setLineDash(check ? [5, 4] : []);
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      // Beast over rarity, shrunk to fit inside the cell's box.
      const cell = reader.reading.model.cells[c.n];
      const lines = c.kind === 'locked' ? [c.nest ? '鼠巢' : c.event ? '上鎖 !' : '上鎖'] : c.kind === 'inmate' ? [T.beastName(cell.beast), SHORT_TIER[cell.tier]] : ['空？'];
      let px = Math.round(11 * dpr);
      ctx.font = font(px);
      const widest = Math.max(...lines.map((t) => ctx.measureText(t).width));
      if (widest + 6 * dpr > w) {
        px = Math.max(Math.round(8 * dpr), Math.floor((px * (w - 6 * dpr)) / widest));
        ctx.font = font(px);
      }
      const lh = Math.round(px * 1.25);
      const tw = Math.min(w, Math.max(...lines.map((t) => ctx.measureText(t).width)) + 8 * dpr);
      const th = lh * lines.length + 2 * dpr;
      const top = y + h / 2 - th;
      ctx.fillStyle = check ? 'rgba(241, 205, 72, 0.92)' : 'rgba(15, 18, 22, 0.86)';
      ctx.fillRect(x - tw / 2, top, tw, th);
      ctx.fillStyle = check ? '#1c1913' : '#e3e6eb';
      lines.forEach((t, i) => ctx.fillText(t, x, top + dpr + lh * (i + 0.5)));
    }
    ctx.setLineDash([]);
  }

  // Loads the reading as the board. The caller then asks what to do.
  function useScan() {
    const rd = reader.reading;
    if (!rd) return;
    undo.push({ model: JSON.parse(JSON.stringify(model)), selected, shot });
    if (undo.length > 30) undo.shift();
    leaveShot();
    model = normalize(rd.model);
    reader.undoable = true;
    reader.loaded = rd;
    shot = true;
    shotTools = [...new Set(rd.tools.filter((t) => t.sim && t.conf < TOOL_SURE).map((t) => T.toolName(t.sim)))];
    flags = new Set(rd.checks);
    applied = null;
    via = { scan: true, filled: [...rd.checks].map((n) => `c${n}`), touched: new Set() };
    if (SHARE) SHARE.markManual();
    solver.st = null;
    selected = rd.checks.size ? Math.min(...rd.checks) : model.warden;
    // The screenshot stays in view, with what was read drawn on it, to
    // compare with the board.
    changed();
    scanStatus(rd.checks.size ? `已載入為你的盤面，有${T.plural(rd.checks.size, '間牢房')}標記「檢查」。` : '已載入為你的盤面。');
    renderScan();
  }

  // After a screenshot: to the board, at the first cell marked Check (or
  // the warden's), for the player to set what the reader got wrong.
  function fixBoard() {
    select(flags.size ? Math.min(...flags) : model.warden);
    $('az-board').scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (cellEls[selected]) cellEls[selected].btn.focus({ preventScroll: true });
  }

  // ---------- Wiring ----------

  function segment(id, apply) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.disabled) return;
      apply(b.dataset.v, b);
    });
  }

  function bind() {
    renderLang();
    $('az-game-lang').addEventListener('change', (ev) => setGameLang(ev.target.value === 'other' ? 'xx' : ev.target.value));
    // Beast and rarity pickers, built once.
    $('az-beasts').innerHTML = T.BEASTS.map((b) => `<button type="button" class="az-beast" data-v="${b}">${B.PORTRAITS[b]}<span>${esc(T.beastName(b))}</span></button>`).join('');
    $('az-tiers').innerHTML = T.TIERS.slice(0, TOP_TIER + 1).map((name, t) => `<button type="button" class="az-tier t${t}" data-v="${t}">${esc(name)}</button>`).join('');
    // The instruments: every one the simulator knows, clicked on and off.
    $('az-tools').innerHTML = T.TOOL_IDS.map((id) => `<button type="button" class="az-instrument" data-tool="${id}" aria-pressed="false" title="${esc(`${T.toolName(id)}: ${T.toolText(id)}`)}">${B.INSTRUMENTS[id] || ''}<span>${esc(T.toolName(id))}</span></button>`).join('') + '<p class="az-tools-rest" id="az-tools-rest" hidden>其他</p>';
    $('az-vault-add').innerHTML = `<span class="field-label">新增</span>${T.BEASTS.map((b) => `<button type="button" class="az-ico t5" data-vault-add="${b}" title="新增一隻綺彩${esc(T.beastName(b))}" aria-label="新增一隻綺彩${esc(T.beastName(b))}">${B.PORTRAITS[b]}</button>`).join('')}`;

    segment('az-kind', (v) => setKind(v));
    segment('az-beasts', (v) => setCell(selected, { kind: model.cells[selected].kind === 'scouted' ? 'scouted' : 'inmate', beast: v }));
    segment('az-tiers', (v) => {
      const c = model.cells[selected];
      setCell(selected, { kind: ['scratch', 'scouted', 'revealed'].includes(c.kind) ? c.kind : 'inmate', tier: Number(v) });
    });
    segment('az-event', (v) => setCell(selected, { event: v === 'none' ? null : v }));
    $('az-ivory').addEventListener('change', (e) => setCell(selected, { ivory: e.target.checked }));
    $('az-prey').addEventListener('change', (e) => {
      const value = e.target.value;
      setCell(selected, { prey: value === '' ? null : { cell: Number(value), rounds: toInt($('az-prey-rounds').value, T.DEFAULT_PARAMS.preyRounds) } });
    });
    $('az-prey-rounds').addEventListener('change', (e) => {
      const c = model.cells[selected];
      if (c.prey) setCell(selected, { prey: { cell: c.prey.cell, rounds: clamp(toInt(e.target.value, 1), 1, 9) } });
    });
    $('az-nest-due').addEventListener('change', (e) => setCell(selected, { due: clamp(toInt(e.target.value, model.day + 2), 1, 60) }));
    $('az-warden').addEventListener('click', () => setWarden(selected));
    $('az-door').addEventListener('click', () => toggleDoor(selected));

    $('az-riot').addEventListener('change', (e) => {
      const max = clamp(toInt(model.maxDays, 20), 5, 60);
      model.day = clamp(max - toInt(e.target.value, max - model.day), 1, max);
      changed();
    });
    $('az-days').addEventListener('change', (e) => {
      model.maxDays = clamp(toInt(e.target.value, 20), 5, 60);
      model.day = Math.min(model.day, model.maxDays);
      changed();
    });
    segment('az-step', (v) => {
      model.step = v;
      // The buttons only show with the warden in the office.
      if (v === 'office') model.warden = T.OFFICE;
      changed();
    });
    $('az-doors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-door]');
      if (b) toggleDoor(Number(b.dataset.door));
    });
    $('az-devoured').addEventListener('change', (e) => {
      model.devourUsed = e.target.checked;
      changed();
    });
    $('az-swapped').addEventListener('change', (e) => {
      model.swapUsed = e.target.checked;
      changed();
    });
    $('az-consume-offered').addEventListener('change', (e) => {
      model.consumeOffered = e.target.checked;
      changed();
    });
    segment('az-event-kind', (v) => {
      model.eventKind = v;
      touch('event');
      changed();
    });
    segment('az-choice-kind', (v) => {
      model.choice = Object.assign({}, model.choice, { kind: v });
      touch('choice');
      changed();
    });
    $('az-offer').addEventListener('change', (e) => {
      if (e.target.id === 'az-gift-picks') {
        model.choice = Object.assign({}, model.choice, { picks: clamp(toInt(e.target.value, 1), 1, 30) });
        touch('choice');
        changed();
        return;
      }
      if (e.target.id === 'az-rerolls') {
        model.choice = Object.assign({}, model.choice, { rerolls: clamp(toInt(e.target.value, 0), 0, 9) });
        touch('choice');
        changed();
        return;
      }
      const sel = e.target.closest('[data-offer]');
      if (!sel) return;
      const options = [0, 1, 2].map((i) => model.choice.options[i] || '');
      options[Number(sel.dataset.offer)] = sel.value;
      touch('choice');
      model.choice = Object.assign({}, model.choice, { options: options.filter(Boolean) });
      changed();
    });
    $('az-armed').addEventListener('change', (e) => {
      model.chainArmed = e.target.checked;
      changed();
    });
    $('az-tools-open').addEventListener('click', () => openTools());
    $('az-tools-close').addEventListener('click', () => closeTools());
    $('az-tools-dialog').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTools();
      }
    });
    $('az-tools-search').addEventListener('input', (e) => filterTools(e.target.value));
    // Enter picks the one instrument left by the search.
    $('az-tools-search').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const left = [...$('az-tools').querySelectorAll('[data-tool]')].filter((b) => !b.hidden);
      if (left.length === 1) left[0].click();
    });
    window.addEventListener('resize', () => placeTools());
    $('az-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (!b) return;
      const id = b.dataset.tool;
      model.tools = model.tools.includes(id) ? model.tools.filter((t) => t !== id) : [...model.tools, id];
      model.choice = Object.assign({}, model.choice, { options: model.choice.options.filter((t) => !model.tools.includes(t)) });
      changed();
    });
    // The player confirms the run's instruments as set: they're locked in,
    // and the advice is checked again with them.
    $('az-tools-ok').addEventListener('click', () => {
      closeTools();
      model.toolsToConfirm = '';
      model.toolsLocked = true;
      // The panel's count now: only more than this asks again.
      model.toolsSeen = Math.max(model.tools.length, model.toolsPanel || 0);
      changed();
      ask();
    });
    $('az-rewards').addEventListener('change', (e) => {
      model.rewards = e.target.checked;
      changed();
    });
    $('az-milestone').addEventListener('change', (e) => {
      model.milestone = e.target.checked;
      const n = T.OBJECTIVES[model.objective].need || 0;
      if (!model.milestone && n) model.walkTiles = Math.min(model.walkTiles, n - 1);
      changed();
    });
    $('az-start-event').addEventListener('change', (e) => setStartEvent(e.target.value));
    $('az-objective').addEventListener('change', (e) => {
      model.objective = T.OBJECTIVES[e.target.value] ? e.target.value : 'king';
      model.walkTiles = clamp(model.walkTiles, 0, T.OBJECTIVES[model.objective].need || 0);
      changed();
    });
    $('az-walk').addEventListener('change', (e) => {
      const n = T.OBJECTIVES[model.objective].need || 0;
      model.walkTiles = clamp(toInt(e.target.value, 0), 0, n);
      if (n && model.walkTiles >= n) model.milestone = true;
      changed();
    });
    $('az-vault-add').addEventListener('click', (e) => {
      const b = e.target.closest('[data-vault-add]');
      if (!b) return;
      model.vault = [...model.vault, b.dataset.vaultAdd];
      changed();
    });
    $('az-vault').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unvault]');
      if (!b) return;
      model.vault = model.vault.filter((_, i) => i !== Number(b.dataset.unvault));
      changed();
    });
    $('az-go').addEventListener('click', () => ask());
    $('az-do').addEventListener('click', () => {
      const rec = fresh() ? recommendation() : null;
      if (rec) doMove(rec.action);
    });
    $('az-next').addEventListener('click', () => {
      const rec = fresh() ? recommendation() : null;
      if (rec) doMove(rec.action, true);
    });
    $('az-undo').addEventListener('click', undoMove);
    $('az-applied').addEventListener('click', (e) => {
      if (e.target.closest('[data-undo]')) undoMove();
      if (e.target.closest('[data-match]')) confirmAll();
    });
    $('az-match').addEventListener('click', () => confirmCell(selected));
    $('az-pick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b || b.disabled) return;
      const n = Number($('az-pick').dataset.cell);
      closePick(true);
      pickCell(n, b.dataset.pick);
    });
    // Arrows move around the picker's grid; Escape closes it.
    $('az-pick').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePick(true);
        return;
      }
      const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
      if (!d) return;
      e.preventDefault();
      const rows = [...$('az-pick').querySelectorAll('.az-pick-row')].map((r) => [...r.querySelectorAll('[data-pick]:not(:disabled)')]);
      let r = rows.findIndex((row) => row.includes(document.activeElement));
      if (r < 0) return;
      let c = rows[r].indexOf(document.activeElement);
      r = clamp(r + d[0], 0, rows.length - 1);
      c = clamp(c + d[1], 0, rows[r].length - 1);
      rows[r][c].focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!$('az-pick').hidden && !e.target.closest('#az-pick, #az-board .cell')) closePick(false);
    });
    $('az-pick').addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      if (to && !$('az-pick').contains(to) && !to.closest('#az-board .cell')) closePick(false);
    });
    $('az-share').addEventListener('click', (e) => {
      const b = e.target.closest('[data-share]');
      if (!b) return;
      if (b.dataset.share === 'see') SHARE.download();
      else SHARE.setSharing(b.dataset.share === 'on');
    });
    if (SHARE) SHARE.onChange(renderShare);
    $('az-load-run').addEventListener('click', loadRun);
    $('az-example').addEventListener('click', () => {
      leaveShot();
      model = exampleModel();
      selected = 4;
      flags = new Set();
      applied = null;
      via = null;
      if (SHARE) SHARE.reset('example');
      solver.st = null;
      changed();
      notice('已載入範例：第 6 天，典獄長在 05 號牢房，有三扇門可選。');
    });
    let clearArmed = 0;
    $('az-clear').addEventListener('click', () => {
      if (Date.now() > clearArmed) {
        clearArmed = Date.now() + 5000;
        $('az-clear').textContent = '再按一次清空';
        setTimeout(() => {
          $('az-clear').textContent = '清空盤面';
        }, 5000);
        return;
      }
      clearArmed = 0;
      $('az-clear').textContent = '清空盤面';
      leaveShot();
      model = blankModel();
      selected = 1;
      flags = new Set();
      applied = null;
      via = null;
      if (SHARE) SHARE.reset('manual');
      solver.st = null;
      changed();
      notice('已清空：第 1 天，所有牢房未開啟，典獄長在審訊室。');
    });
    $('az-open-sim').addEventListener('click', openInSimulator);

    // Screenshots: choose a file, paste anywhere, or drop anywhere.
    $('az-scan-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) readImageFile(file);
      e.target.value = '';
    });
    // While the report dialog is open, pastes and drops are its screenshot.
    const reporting = () => !!window.TartarusReport && TartarusReport.isOpen();
    document.addEventListener('paste', (e) => {
      if (reporting()) return;
      const items = e.clipboardData ? [...e.clipboardData.items] : [];
      const item = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
      if (!item) return;
      e.preventDefault();
      readImageFile(item.getAsFile());
      $('az-scan').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || reporting()) return;
      e.preventDefault();
      $('az-scan').classList.add('is-drop');
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) $('az-scan').classList.remove('is-drop');
    });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e) || reporting()) return;
      e.preventDefault();
      $('az-scan').classList.remove('is-drop');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) readImageFile(file);
    });
    $('az-fix').addEventListener('click', fixBoard);
    $('az-recheck').addEventListener('click', () => ask());
    // A screenshot's board waits to be shared until the player moves on; a
    // closing tab counts as moving on.
    window.addEventListener('pagehide', shareHeld);
    // Follow my game (js/auto.js, beta): read frames of the game, load
    // them, and ask, without the toasts a pasted screenshot gets.
    window.TartarusAnalyzer = {
      readFrame: (bitmap) => new Promise((resolve) => readBitmap(bitmap, { quiet: true, folded: true, onRead: resolve })),
      readPick: (bitmap) => readPick(bitmap),
      usePick: (read, fresh) => usePick(read, fresh),
      readTreasure: (bitmap) => readTreasure(bitmap),
      readObjective: (bitmap) => readObjective(bitmap),
      // The game's language (from the log: auto), and a screen the reader
      // didn't recognize on a client not in English.
      setGameLang: (code, auto) => setGameLang(code, auto),
      gameLang: () => gameLang,
      langMissed: (what, image, detail) => langMissed(what, image, detail),
      langBoard: (image) => langBoard(image),
      langMiss: () => (langMiss ? { what: langMiss.what, at: langMiss.at, lang: langName(gameLang) } : null),
      useObjective: (read) => useObjective(read),
      useTreasure: (after) => useTreasure(after),
      // Auto Screenshot Mode's Treasure counts ({ rainbows, taken }): the
      // picks waiting, or null without counts. giftsDone ends a tally that
      // went stale (no Treasure for a while).
      giftCounts: (c) => giftCounts(c),
      giftsDone: () => {
        gifts.waiting = 0;
      },
      useReading: () => useScan(),
      ask: () => ask(true),
      recommendation: () => (fresh() && settled() ? recommendation() : null),
      // What the reader made of the last picture, in full (the desktop app's
      // test record keeps it).
      readingSummary: () => (reader.result && reader.image ? readingSummary(true) : ''),
      // The live check's workers: how many it may use (setCores, 0 for every
      // core but one) and how many are running now (0 once let go).
      setCores: (n) => setCores(n),
      cores: () => ({ cap: coreCap, use: workerCount(), most: MOST_WORKERS, running: solver.workers ? solver.workers.length : 0, onPage: !!solver.failed }),
      day: () => model.day,
      toast,
    };
    // In the desktop app, the link to download it has no use.
    if (window.TartarusDesktop && $('az-desktop-app')) $('az-desktop-app').hidden = true;
    // Reports of something new carry where the player was, nothing more.
    // The deployed collector turns away a report whose step it doesn't know
    // (a chain's pick), so that one goes without its step.
    if (window.TartarusReport) {
      TartarusReport.setup({
        app: 'analyze-20261014a',
        context: () => ({ page: 'analyze', day: model.day, step: COLLECTOR_STEPS.includes(model.step) ? model.step : null }),
      });
    }
    $('az-scan-report').addEventListener('click', reportReading);
    $('az-report-reading').addEventListener('click', reportReading);
    $('az-toast-actions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-toast]');
      if (!b) return;
      $('az-toast').hidden = true;
      if (b.dataset.toast === 'pick') $('az-scan-file').click();
      else if (b.dataset.toast === 'lang-report') sendLangMiss();
      else $('az-scan').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    $('az-treasure-now').addEventListener('click', () => {
      // Advise the gift on the board as the analyzer has it.
      model.treasureWait = false;
      model.treasureSeen = true;
      gifts.board = gifts.log ? Object.assign({}, gifts.log) : null;
      changed();
      ask();
    });
    $('az-scan-show').addEventListener('click', () => {
      reader.folded = false;
      renderScan();
    });
    $('az-scan-always').checked = showShots;
    $('az-scan-always').addEventListener('change', (e) => {
      showShots = e.target.checked;
      try {
        localStorage.setItem(SHOTS_KEY, showShots ? '1' : '0');
      } catch (err) {
        // Kept until the page closes.
      }
      reader.folded = !showShots;
      renderScan();
    });
    $('az-scan-back').addEventListener('click', () => {
      undoMove();
      renderScan();
      scanStatus('已回到那張畫面之前的盤面。那張畫面不會被分享。');
    });
    $('az-scan-discard').addEventListener('click', () => {
      reader.result = null;
      reader.reading = null;
      renderScan();
      $('az-report-reading').hidden = true;
      scanStatus('');
    });
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (reader.result && reader.image) drawScan();
      }, 150);
    });

    // Keyboard entry on the board.
    $('az-board').addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('#az-pick')) return;
      const key = e.key.toLowerCase();
      const move = { arrowright: 1, arrowdown: 1, arrowleft: -1, arrowup: -1 }[key];
      if (move) {
        e.preventDefault();
        select((selected + move + T.CELL_COUNT) % T.CELL_COUNT);
        cellEls[selected].btn.focus();
        return;
      }
      if (selected === T.OFFICE && key !== 'h') return;
      const c = model.cells[selected];
      let handled = true;
      if (BEAST_KEYS[key]) setCell(selected, { kind: 'inmate', beast: BEAST_KEYS[key] });
      else if (key >= '1' && key <= '5') setCell(selected, { kind: ['scratch', 'scouted', 'revealed'].includes(c.kind) ? c.kind : 'inmate', tier: Number(key) - 1 });
      else if (key === 's' || key === 'delete' || key === 'backspace') setCell(selected, { kind: 'sealed' });
      else if (key === 'x') setCell(selected, { kind: 'scratch' });
      else if (key === 'n') setCell(selected, { kind: 'nest' });
      else if (key === 'e') setCell(selected, { kind: 'empty' });
      else if (key === 'i' && c.kind === 'inmate') setCell(selected, { ivory: !c.ivory });
      else if (key === 'd') toggleDoor(selected);
      else if (key === 'h') setWarden(selected);
      else handled = false;
      if (handled) {
        e.preventDefault();
        cellEls[selected].btn.focus();
      }
    });
  }

  buildBoard();
  bind();
  render();
})();
