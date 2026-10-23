/* Tartarus Simulator: interface.
 * Renders the engine state, turns clicks into engine actions, and keeps the
 * undo history, saves and preferences. All rules live in engine.js. */
(function () {
  'use strict';

  const T = window.Tartarus;
  const Sound = window.TartarusSound;
  // This script's version tag, so the solver worker loads matching files.
  const SCRIPT_QUERY = (() => {
    const src = document.currentScript ? document.currentScript.src : '';
    const q = src.indexOf('?');
    return q >= 0 ? src.slice(q) : '';
  })();
  // The published single-file build sets this; its viewer cannot download files.
  const EMBEDDED = !!window.TARTARUS_EMBEDDED;

  const KEYS = { save: 'tartarus-sim:save:v2', prefs: 'tartarus-sim:prefs:v1', params: 'tartarus-sim:params:v7' };
  const HISTORY_LIMIT = 40;
  const DEFAULT_PREFS = { advisor: false, quick: false, motion: true, sound: true, volume: 60, immersive: false };

  // The ring layout, portraits and cell faces come from js/board.js.
  const { RING, PORTRAITS, LANTERN, FANGS, OFFICE_ART, CELL_HTML, cellParts } = window.TartarusBoard;

  const $ = (id) => document.getElementById(id);
  const L = (n) => T.cellLabel(n);
  // The day's swap is still open: a day has a devour or a swap, not both.
  // (An engine cached from before that rule has no canSwapNow.)
  const canSwapNow = (st) => (T.canSwapNow ? T.canSwapNow(st) : st.used.swap < st.params.swapsPerDay);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
      } catch (e) {
        /* Storage can be full or blocked; the run still works in memory. */
      }
    },
  };

  const ui = {
    state: null,
    history: [],
    selected: null,
    pending: null,
    hover: null,
    screen: 'title',
    prefs: Object.assign({}, DEFAULT_PREFS, store.get(KEYS.prefs) || {}),
    labParams: loadLabParams(),
    labCell: 1,
    actedOn: null,
    trainer: null,
    labTab: 'scene',
    toastTimer: 0,
    endArmed: 0,
  };

  const cellEls = [];

  // Practice values. Older saved values keep everything except what the live
  // game has since shown: three doors every morning (unless an instrument or
  // event takes one away), the six-cell patrol, and a pick of three
  // instruments to start.
  function loadLabParams() {
    const saved = store.get(KEYS.params);
    if (saved) return T.normalizeParams(saved);
    // Second meals at every rarity, as players' games show (2026-10-17):
    // the saved Legendary-and-up gives way; the rest carries over.
    const v6 = store.get('tartarus-sim:params:v6');
    if (v6 && typeof v6 === 'object') {
      delete v6.doubleEatTier;
      return T.normalizeParams(v6);
    }
    // The live door odds replace the old defaults (2026-10-16); the rest of
    // the Lab's settings carry over.
    const v5 = store.get('tartarus-sim:params:v5');
    if (v5 && typeof v5 === 'object') {
      delete v5.tierWeights;
      delete v5.doubleEatTier;
      return T.normalizeParams(v5);
    }
    let old = store.get('tartarus-sim:params:v4') || store.get('tartarus-sim:params:v3');
    const drop = ['destinations', 'fewerDoorsChance', 'eventTwoDoors', 'patrolRange', 'startTools', 'tierWeights', 'doubleEatTier'];
    if (!old) old = store.get('tartarus-sim:params:v2');
    if (old && typeof old === 'object') for (const key of drop) delete old[key];
    return T.normalizeParams(old);
  }

  // ---------- Small helpers ----------

  function setHTML(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  function makeButton(label, onClick, kind, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (kind === 'primary' ? ' btn-primary' : kind === 'danger' ? ' btn-danger' : '');
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function modeName(st) {
    return st.scenario === 'empty' ? '規則練習' : T.SCENARIOS[st.scenario].name;
  }

  const blocked = (st) => !st || st.phase === 'ended' || st.pending.length > 0 || st.phase === 'event' || st.phase === 'office' || !!st.chaining;

  function toast(text, info) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('is-info', !!info);
    if (typeof el.showPopover === 'function') {
      try {
        if (el.matches(':popover-open')) el.hidePopover();
        el.showPopover();
      } catch (e) {
        el.hidden = false;
      }
    } else {
      el.hidden = false;
    }
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      if (typeof el.hidePopover === 'function' && el.matches(':popover-open')) el.hidePopover();
      else el.hidden = true;
    }, 3400);
  }

  function persist() {
    if (ui.state) store.set(KEYS.save, { app: 'tartarus-sim', v: T.VERSION, state: ui.state });
  }

  // ---------- Running moves ----------

  // Applies one engine action with undo, autosave, effects and sound.
  function run(action, opts) {
    const options = opts || {};
    if (!ui.state) return false;
    const snapshot = T.serialize(ui.state);
    let result;
    try {
      result = action(ui.state);
    } catch (err) {
      console.error(err);
      result = { ok: false, reason: '這個動作發生錯誤，沒有套用。' };
    }
    if (!result || !result.ok) {
      ui.state = T.deserialize(snapshot);
      toast(result ? result.reason : '不允許這個動作。');
      Sound.play('error');
      render();
      return false;
    }
    ui.history.push(snapshot);
    if (ui.history.length > HISTORY_LIMIT) ui.history.shift();
    gradeMove(snapshot);
    if (!options.keepPending) ui.pending = null;
    if ('select' in options) ui.selected = options.select;
    tidySelection();
    persist();
    render();
    playEvents(result.events || []);
    followUp(ui.prefs.motion ? 600 : 0);
    return true;
  }

  // Opens whatever the run is now waiting on: a choice or the roster.
  function followUp(delay) {
    setTimeout(() => {
      const st = ui.state;
      if (!st || ui.screen !== 'game') return;
      if (st.phase === 'ended') {
        if (!$('dlg-results').open) openResults();
      } else if (st.pending.length) {
        openChoice();
      }
    }, delay);
  }

  function tidySelection() {
    const st = ui.state;
    if (ui.selected === null || !st) return;
    const cell = st.cells[ui.selected];
    if (!cell || (!cell.sealed && !cell.inmate)) ui.selected = null;
  }

  function undo() {
    if (!ui.history.length) {
      toast('還沒有可以復原的動作。', true);
      return;
    }
    ui.state = T.deserialize(ui.history.pop());
    ui.selected = null;
    ui.pending = null;
    if (ui.trainer) ui.trainer.last = null;
    persist();
    closeRunDialogs();
    if (ui.screen !== 'game') showScreen('game');
    else render();
    toast('已復原上一步。', true);
  }

  function cancel() {
    ui.pending = null;
    ui.selected = null;
    render();
  }

  const SOUND_ORDER = ['end', 'rainbow', 'devour', 'hatch', 'open', 'swap', 'nest', 'promote', 'tool', 'day', 'move'];
  const SOUND_ALIAS = { move: 'select' };

  function playEvents(events) {
    // The bites of a chain flash one after another, so you can follow it.
    let bites = 0;
    for (const ev of events) {
      if (ev.type === 'open') fx(ev.cell, 'fx-open');
      else if (ev.type === 'move') fx(ev.to, 'fx-move');
      else if (ev.type === 'devour') {
        const show = () => {
          fx(ev.to, 'fx-devour');
          fx(ev.from, 'fx-promote');
        };
        if (bites++ && ui.prefs.motion) setTimeout(show, (bites - 1) * 380);
        else show();
      } else if (ev.type === 'promote') fx(ev.cell, 'fx-promote');
      else if (ev.type === 'rainbow') fx(ev.cell, 'fx-rainbow');
      else if (ev.type === 'swap') fx(ev.cell, 'fx-swap');
      else if (ev.type === 'hatch') fx(ev.cell, 'fx-hatch');
      else if (ev.type === 'nest') fx(ev.cell, 'fx-nest');
    }
    const types = new Set(events.map((e) => e.type));
    const name = SOUND_ORDER.find((t) => types.has(t));
    if (name) Sound.play(SOUND_ALIAS[name] || name);
  }

  function fx(n, cls) {
    if (!ui.prefs.motion || n === null || n === undefined || !cellEls[n]) return;
    const el = cellEls[n].fx;
    el.className = 'cell-fx';
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------- Asking before acting ----------

  function askPatrol(n) {
    if (ui.prefs.quick) {
      run((st) => T.patrol(st, n), { select: n });
      return;
    }
    ui.selected = n;
    ui.pending = { kind: 'patrol', cell: n };
    render();
  }

  function askSwap(n) {
    if (n === null || n === undefined) return;
    if (ui.prefs.quick) {
      run((st) => T.swap(st, n));
      return;
    }
    ui.selected = n;
    ui.pending = { kind: 'swap', cell: n };
    render();
  }

  // Targets open to today's devour, which only the warden's cell can start.
  function devoursAvailable(st) {
    return T.startOptions(st).length;
  }

  function askEndDay() {
    const st = ui.state;
    if (!st || blocked(st) || st.phase !== 'manage') return;
    const warnings = [];
    if (devoursAvailable(st)) warnings.push('你今天還沒有使用吞噬。');
    const last = st.day >= st.maxDays;
    if (!ui.prefs.quick && (warnings.length || last)) {
      ui.pending = { kind: 'end', warnings, last };
      render();
      return;
    }
    run((s) => T.endDay(s), { select: null });
  }

  // `clicks` is the click count, so the second click of a double-click acts at
  // once: it goes to a destination or devours a target, and on any other cell
  // it keeps the cell selected instead of toggling it off.
  function onCell(n, clicks) {
    const st = ui.state;
    if (!st) return;
    const double = clicks >= 2;
    // The first click may already have acted (quick decisions); a double-click
    // then has nothing left to do.
    const acted = ui.actedOn === n;
    ui.actedOn = null;
    if (double && acted) return;
    const act = (action, opts) => {
      ui.actedOn = n;
      run(action, opts);
    };
    const inspect = () => {
      ui.pending = null;
      ui.selected = ui.selected === n && !double ? null : n;
      render();
    };
    // A chain waiting for its next meal: a click previews the bite and a
    // second click takes it; a double-click takes it at once.
    if (st.chaining && !st.pending.length && T.chainOptions(st).some((o) => o.cell === n)) {
      const again = ui.pending && ui.pending.kind === 'chain' && ui.pending.to === n;
      if (double || again || ui.prefs.quick) act((s) => T.chainBite(s, n), { select: st.position });
      else {
        ui.pending = { kind: 'chain', to: n };
        render();
      }
      return;
    }
    if (blocked(st)) {
      inspect();
      return;
    }
    if (st.phase === 'patrol') {
      if (T.patrolOptions(st).includes(n)) {
        // Clicking the chosen destination again goes there.
        const again = ui.pending && ui.pending.kind === 'patrol' && ui.pending.cell === n;
        if (double || again || ui.prefs.quick) act((s) => T.patrol(s, n), { select: n });
        else askPatrol(n);
        return;
      }
      inspect();
      return;
    }
    // Only the warden's cell can start today's devour. With it selected, a
    // click previews a target and a second click devours it; a double-click
    // devours whatever is selected.
    const option = T.startOptions(st).find((o) => o.cell === n);
    if (option && (double || ui.selected === st.position)) {
      const from = st.position;
      const again = ui.pending && ui.pending.kind === 'devour' && ui.pending.to === n;
      if (double || again || ui.prefs.quick) act((s) => T.devour(s, from, n), { select: from });
      else {
        ui.selected = from;
        ui.pending = { kind: 'devour', from, to: n };
        render();
      }
      return;
    }
    inspect();
    if (ui.selected !== null && !double) Sound.play('select');
  }

  // ---------- Rendering: cells ----------

  function buildBoard() {
    const board = $('board');
    for (let n = 0; n < T.CELL_COUNT; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.style.gridRow = RING[n][0];
      b.style.gridColumn = RING[n][1];
      b.innerHTML = CELL_HTML;
      b.children[2].textContent = L(n);
      b.addEventListener('click', (e) => onCell(n, e.detail));
      b.addEventListener('mouseenter', () => {
        if (ui.state && ui.state.chain && ui.state.phase === 'patrol') {
          ui.hover = n;
          renderBoard();
        }
      });
      b.addEventListener('mouseleave', () => {
        if (ui.hover === n) {
          ui.hover = null;
          if (ui.state) renderBoard();
        }
      });
      board.appendChild(b);
      cellEls[n] = { btn: b, body: b.children[0], hint: b.children[3], badges: b.children[4], tag: b.children[5], warden: b.children[6], fx: b.children[7] };
    }
  }

  function renderBoard() {
    const st = ui.state;
    const free = !blocked(st);
    const sel = ui.selected !== null ? st.cells[ui.selected] : null;
    // Only the inmate in the warden's cell can start the day's devour. A
    // chain waiting for its next meal shows that meal's choices.
    const chaining = !!st.chaining && !st.pending.length;
    const hunter = chaining ? st.cells[st.position] : free && st.phase === 'manage' && T.canDevourNow(st) && sel && sel.n === st.position && !sel.sealed && sel.inmate ? sel : null;
    const hunting = !!hunter;
    const targets = new Map();
    if (hunter) for (const o of chaining ? T.chainOptions(st) : T.devourOptions(st, hunter.n)) targets.set(o.cell, o);
    const victims = new Set(st.phase === 'event' && st.event && st.event.kind === 'execution' ? T.executionVictims(st, st.event.cell).map((c) => c.n) : []);
    const dests = free && st.phase === 'patrol' ? new Set(T.patrolOptions(st)) : new Set();
    $('board').classList.toggle('is-patrolling', dests.size > 0);
    const aim = ui.pending && ui.pending.kind === 'patrol' ? ui.pending.cell : ui.hover;
    const path = st.chain && st.phase === 'patrol' && dests.has(aim) ? new Set(T.clockwisePath(st, aim)) : new Set();
    const pendingTarget = ui.pending && (ui.pending.kind === 'devour' || ui.pending.kind === 'chain') ? ui.pending.to : null;
    for (const cell of st.cells) {
      const el = cellEls[cell.n];
      const p = cellParts(cell, st);
      let tag = '';
      if (ui.selected === cell.n || pendingTarget === cell.n || (st.phase === 'event' && st.event && st.event.cell === cell.n)) p.cls.push('is-selected');
      if (targets.has(cell.n)) {
        p.cls.push('is-target');
        tag = `吃 +${T.gainFor(st, hunter.n, targets.get(cell.n)).gain}`;
      } else if (hunting && targets.size && hunter.n !== cell.n) {
        p.cls.push('is-dim');
      }
      if (victims.has(cell.n)) p.cls.push('is-victim');
      if (dests.has(cell.n)) {
        p.cls.push('is-dest');
        if (ui.hover === cell.n) p.cls.push('is-aim');
        if (st.chain) {
          const opens = T.clockwisePath(st, cell.n).filter((k) => st.cells[k].sealed).length;
          tag = `前往 +${opens}`;
        } else {
          tag = cell.sealed ? '開門' : '行走';
        }
      }
      if (path.has(cell.n)) p.cls.push('on-path');
      el.btn.className = p.cls.join(' ');
      setHTML(el.body, p.body);
      setHTML(el.hint, p.hint);
      setHTML(el.badges, p.badges);
      setHTML(el.warden, p.warden ? LANTERN : '');
      el.tag.textContent = tag;
      el.btn.setAttribute('aria-label', p.label + (tag ? `。${tag}` : ''));
      el.btn.setAttribute('aria-pressed', String(ui.selected === cell.n));
    }
    $('emblem-text').textContent = st.phase === 'ended' ? '本局結束' : `典獄長${wardenAt(st)} · 順時針`;
  }

  function wardenAt(st) {
    return st.position === T.OFFICE ? '在審訊室' : `在 ${L(st.position)} 號牢房`;
  }

  // The morning's destination doors as cards under the ring.
  function renderDestBar() {
    const st = ui.state;
    const show = st.phase === 'patrol' && !blocked(st);
    $('dest-bar').hidden = !show;
    if (!show) return;
    const options = T.patrolOptions(st);
    const chosen = ui.pending && ui.pending.kind === 'patrol' ? ui.pending.cell : null;
    setHTML($('dest-cards'), st.destinations
      .map((n) => {
        const c = st.cells[n];
        const usable = options.includes(n);
        let meta;
        if (st.chain) meta = `連鎖會開 ${T.plural(T.clockwisePath(st, n).filter((k) => st.cells[k].sealed).length, '扇門')}`;
        else if (!c.sealed && c.inmate) {
          const count = T.devourOptions(st, n).length;
          meta = `${T.describe(c.inmate)} · ${count ? T.plural(count, '個目標') : '沒有目標'}`;
        } else if (n === T.OFFICE) meta = '審訊室 · 煽動或賞賜';
        else if (!c.sealed) meta = '空牢房';
        else if (c.nest) meta = `鼠巢 · 第 ${c.nest.due} 天孵化`;
        else if (c.known === 2) meta = `裡面是${T.describe(c.hidden)}`;
        else if (c.known === 1) meta = `裡面是${T.tierName(c.hidden.tier)}`;
        else meta = '上鎖 · 裡面未知';
        const event = c.sealed && c.event && c.seen && !st.chain ? '<span class="dest-event">事變</span>' : '';
        // A known inmate shows its portrait; a locked cell shows its door.
        const face = !c.sealed && c.inmate
          ? `<span class="dest-face t${c.inmate.tier}" aria-hidden="true">${PORTRAITS[c.inmate.beast]}</span>`
          : `<span class="dest-door${c.sealed ? '' : ' is-open'}" aria-hidden="true"></span>`;
        const here = n === st.position ? '（典獄長在此）' : '';
        return `<button type="button" class="dest-card${chosen === n ? ' is-selected' : ''}" data-dest="${n}"${usable ? '' : ' disabled'}>${face}<span class="dest-label">${n === T.OFFICE ? '前往審訊室' : `前往 ${L(n)} 號牢房`}</span><span class="dest-meta">${esc(meta + here)}</span>${event}</button>`;
      })
      .join(''));
  }

  function renderSample() {
    const make = (id, beast, tier) => ({ id, beast, tier });
    const base = (n) => ({ n, sealed: true, inmate: null, hidden: null, known: 0, scratch: false, nest: null, event: null, ivory: false });
    const spec = [
      { sealed: false },
      { event: 'chain' },
      { sealed: false, inmate: make(3, 'wolf', 1), ivory: true },
      { hidden: make(4, 'rat', 3), known: 1 },
      { sealed: false, inmate: make(5, 'mammoth', 4) },
      {},
      { sealed: false, inmate: make(7, 'rat', 0) },
      { nest: { due: 10 } },
      { sealed: false, inmate: make(9, 'rat', 3) },
      { event: 'execution' },
      { hidden: make(11, 'mammoth', 1), known: 1, scratch: true },
      { sealed: false, inmate: make(12, 'rat', 2) },
      { sealed: false, inmate: make(13, 'mammoth', 1) },
      {},
      { sealed: false, inmate: make(15, 'lion', 0) },
      { sealed: false, inmate: make(2, 'lion', 2) },
    ];
    const cells = spec.map((s, n) => Object.assign(base(n), s));
    const sample = { day: 9, position: 6, cells, prey: [{ lion: 2, prey: 12, rounds: 2 }] };
    // Three of the six cells just ahead of the warden, as on a real morning.
    const dests = new Set([8, 9, 10]);
    const html = cells
      .map((cell) => {
        const p = cellParts(cell, sample);
        const tag = dests.has(cell.n) ? (cell.sealed ? '開門' : '行走') : '';
        if (tag) p.cls.push('is-dest');
        const [row, col] = RING[cell.n];
        return `<div class="${p.cls.join(' ')}" style="grid-row:${row};grid-column:${col}"><span class="cell-body">${p.body}</span><span class="door"></span><span class="cell-no">${L(cell.n)}</span><span class="cell-hint">${p.hint}</span><span class="cell-badges">${p.badges}</span><span class="cell-tag">${tag}</span><span class="cell-warden">${p.warden ? LANTERN : ''}</span></div>`;
      })
      .join('');
    $('sample-board').classList.add('is-patrolling');
    $('sample-board').innerHTML = `${html}<div class="board-center"><div class="decision"><div class="decision-text"><p class="decision-title">巡視：選擇目的地</p><p class="decision-detail">第 9 天。發光的牢房是今天的目的地，都在典獄長順時針六步以內。可以打開一扇上鎖的門，或走到已知的囚犯那裡。</p></div></div></div>`;
  }

  // ---------- Rendering: decision panel ----------

  function setDecision(title, detail, actions, pending) {
    $('decision-title').textContent = title;
    $('decision-detail').textContent = detail || '';
    $('decision-actions').replaceChildren(...actions.map((a) => makeButton(a[0], a[1], a[2], a[3])));
    $('decision').classList.toggle('is-pending', !!pending);
  }

  function renderDecision() {
    const st = ui.state;
    if (st.phase === 'ended') {
      setDecision('本局結束', '交接名冊已經準備好。復原上一步可以繼續玩，或開始新的一局。', [
        ['交接名冊', openResults, 'primary'],
        ['新的一局', () => openNewRun()],
      ]);
      return;
    }
    if (st.pending.length) {
      const kind = st.pending[0].kind;
      const start = !!st.pending[0].start;
      const title = kind === 'gift' ? '典獄長的珍藏' : start ? '開局刑具' : '目標達成';
      const detail = kind === 'gift' ? '有一隻綺彩進了收容區。選一件珍藏，立即生效。' : start ? '本局開始：從三件刑具中選一件，整局都會保留。' : `「${T.OBJECTIVES[st.objective.id].name}」已完成。選一件刑具，用到本局結束。`;
      setDecision(title, detail, [['選擇', openChoice, 'primary']], true);
      return;
    }
    if (st.phase === 'event' && st.event) {
      renderEvent(st);
      return;
    }
    if (st.phase === 'office') {
      setDecision('審訊室', `二選一。煽動：在隨機一間牢房（上鎖的門或囚犯所在處）出現一個新的獄中事變（盤面上沒有事變時出現 2 個）。賞賜：監區中隨機 1 名囚犯升一階。`, [
        ['煽動', () => run((s) => T.officeAct(s, 'instigate')), 'primary'],
        ['賞賜', () => run((s) => T.officeAct(s, 'bestow')), 'primary'],
      ], true);
      return;
    }
    if (st.chaining && !(ui.pending && ui.pending.kind === 'chain')) {
      const eater = st.cells[st.position].inmate;
      const count = T.chainOptions(st).length;
      const stop = !!T.canStopChain && T.canStopChain(st);
      const pick = `在盤面上點${count > 1 ? '其中一個' : '它'}可以預覽這一口，雙擊則直接吃下。`;
      setDecision(
        '吞噬連鎖：選下一個獵物',
        stop
          ? `${L(st.position)} 號牢房的${T.describe(eater)}有 ${T.plural(count, '個獵物')}可以吃。${pick}也可以在這裡停止連鎖（等同遊戲中的「取消」）：吞噬者保留已獲得的階數，獵物留在監區。`
          : `${L(st.position)} 號牢房的${T.describe(eater)}必須繼續吃，有 ${count} 個獵物可以選。${pick}沒東西可吃時連鎖就會結束。`,
        stop ? [['停止連鎖', () => run((s) => T.stopChain(s), { select: st.position })]] : [],
        true,
      );
      return;
    }
    if (ui.pending) {
      renderPending(ui.pending);
      return;
    }
    if (ui.selected !== null) {
      renderSelection(st.cells[ui.selected]);
      return;
    }
    if (st.phase === 'patrol') {
      const options = T.patrolOptions(st);
      const parts = st.ratway
        ? [`暗渠鼠道：典獄長可以移動到審訊室以外的任何牢房。在環上雙擊一間，或從下方選擇。那裡若是上鎖的門，會像巡視一樣打開；典獄長最後所在處的囚犯負責今天的吞噬。`]
        : [`典獄長目前${wardenAt(st)}。從下方 ${T.plural(options.length, '間牢房')}中選一間，或在環上雙擊一間發光的牢房。典獄長最後所在處的囚犯負責今天的吞噬。`];
      if (st.chain) parts.push('連鎖反應已啟動：順時針路徑上每一扇未開啟的門都會打開。');
      setDecision('巡視：選擇目的地', parts.join(''), []);
      return;
    }
    const devours = devoursAvailable(st);
    const warden = st.cells[st.position];
    let lead;
    // A day has a devour or a swap, not both.
    if (st.used.swap > 0) lead = `你今天替換過囚犯，所以不能吞噬：一天只能替換或吞噬其中一種。${canSwapNow(st) ? '再替換一次，或結束' : '結束'}這一天。`;
    else if (!T.canDevourNow(st)) lead = '今天的吞噬已經用掉，替換也一併用掉了：一天只能二選一。結束這一天吧。';
    else if (st.position === T.OFFICE) lead = '典獄長在審訊室，所以今天不能吞噬。替換或結束這一天。';
    else if (!warden.inmate || warden.sealed) lead = `典獄長所在的牢房（${L(st.position)}）是空的，所以今天不能吞噬。替換或結束這一天。`;
    else if (devours) lead = `典獄長牢房（${L(st.position)}）裡的${T.describe(warden.inmate)}可以進行今天的吞噬。選取它可以看到 ${T.plural(devours, '個目標')}，或雙擊目標直接吞噬。${T.canStopChain && T.canStopChain(st) ? '之後它會繼續吃：由你挑選每一個獵物，或停止連鎖（等同遊戲中的「取消」）。' : '之後只要還能吃就必須繼續吃：只有一個獵物時會直接吃掉，有得選時由你挑。'}`;
    else lead = `典獄長牢房（${L(st.position)}）裡的${T.describe(warden.inmate)}今天沒有目標。替換或結束這一天。`;
    setDecision('管理監區', lead, []);
  }

  function renderEvent(st) {
    const { kind, cell: n } = st.event;
    if (kind === 'chain') {
      setDecision('連鎖反應', `接受後啟動。下一次巡視會從典獄長所在處順時針走到目的地，並打開沿途每一扇未開啟的門。這樣打開的門不會觸發其他效果。`, [
        ['接受', () => run((s) => T.resolveEvent(s, true)), 'primary'],
        ['略過', () => run((s) => T.resolveEvent(s, false))],
      ], true);
      return;
    }
    if (kind === 'trickster') {
      const who = st.cells[n].inmate;
      const scarce = T.scarceBeasts(st).map(T.beastName);
      const into = scarce.length === 1 ? `至臻${scarce[0]}（監區中最稀少的野獸）` : `至臻${scarce.join('或')}（監區中最稀少的野獸，隨機一種）`;
      setDecision('暗箱操作', `接受後，${L(n)} 號牢房的${T.describe(who)}會變成${into}。不會觸發其他效果。`, [
        ['接受', () => run((s) => T.resolveEvent(s, true)), 'primary'],
        ['略過', () => run((s) => T.resolveEvent(s, false))],
      ], true);
      return;
    }
    if (kind === 'hunt') {
      // The card has only Confirm.
      setDecision(T.eventName(kind), '每間關著普通或魔法囚犯的上鎖牢房都會顯示稀有度（野獸仍然隱藏），所以沒有亮起的門裡是稀有或更高。', [
        ['確認', () => run((s) => T.resolveEvent(s, true)), 'primary'],
      ], true);
      return;
    }
    if (['appetite', 'convict', 'crow', 'freedom', 'usurp1', 'usurp2', 'usurp3', 'usurp4', 'ratway', 'portion'].includes(kind)) {
      let detail;
      if (kind === 'appetite') {
        const low = T.lowestInmates(st);
        const who = low.length === 1 ? `${L(T.cellOf(st, low[0].id).n)} 號牢房的${T.describe(low[0])}` : `${low.length} 隻${T.tierName(low[0].tier)}囚犯中隨機一隻`;
        detail = `接受後，${who}有 ${T.APPETITE_TRIES} 次升一階的機會，每次機率 ${Math.round(100 * T.APPETITE_ODDS)}%。`;
      } else if (kind === 'crow') detail = `接受後，可以看到典獄長順時針方向接下來 ${T.CROW_CELLS} 間上鎖牢房的稀有度。野獸仍然隱藏。`;
      else if (kind === 'freedom') detail = `接受後，隨機打開 ${T.FREEDOM_CELLS} 間上鎖的牢房。不會觸發其他效果。`;
      else if (kind === 'portion') detail = `接受後，最多 ${T.PORTION_INMATES} 隻隨機囚犯各升一階。`;
      else if (kind === 'usurp1') detail = '接受後，隨機 1 隻囚犯升一階。之後僭越 I 會從獄中事變中移除，僭越 II 加入，並出現在隨機一扇上鎖的門後。';
      else if (kind === 'usurp2') detail = '接受後，隨機 2 隻囚犯各升一階。之後僭越 II 會從獄中事變中移除，僭越 III 加入。';
      else if (kind === 'usurp3') detail = '接受後，隨機 2 隻囚犯各升兩階。之後僭越 III 會從獄中事變中移除，僭越 IV 加入。';
      else if (kind === 'usurp4') detail = '接受後，監區中每隻囚犯都升兩階。之後僭越 IV 會從獄中事變中移除。';
      else if (kind === 'ratway') detail = '接受後，可以把典獄長移到審訊室以外的任何牢房。那裡若是上鎖的門，會像巡視一樣打開，門後的事變也會觸發。這次移動不算行走，不會增加格數。';
      else detail = '接受後，隨機打開一間關著傳奇或更高囚犯的上鎖牢房。不會觸發其他效果。';
      setDecision(T.eventName(kind), detail, [
        ['接受', () => run((s) => T.resolveEvent(s, true)), 'primary'],
        ['略過', () => run((s) => T.resolveEvent(s, false))],
      ], true);
      return;
    }
    const exec = st.cells[n].inmate;
    const victims = T.executionVictims(st, n);
    const rule = st.params.executionSameTier ? '同稀有度' : '較低稀有度';
    const detail = victims.length
      ? `${L(n)} 號牢房的${T.describe(exec)}會除掉${victims.map((c) => `${T.describe(c.inmate)}（${L(c.n)}）`).join('、')}，並升到${T.tierName(Math.min(T.RAINBOW, exec.tier + victims.length))}。`
      : `${L(n)} 號牢房的${T.describe(exec)}在監區中沒有${rule}的獵物，接受也不會有任何效果。`;
    setDecision('處刑效率', detail, [
      ['接受', () => run((s) => T.resolveEvent(s, true)), 'primary'],
      ['略過', () => run((s) => T.resolveEvent(s, false))],
    ], true);
  }

  function renderPending(p) {
    const st = ui.state;
    const back = () => {
      ui.pending = null;
      render();
    };
    if (p.kind === 'patrol') {
      const c = st.cells[p.cell];
      const parts = [];
      if (st.chain) {
        const opens = T.clockwisePath(st, p.cell).filter((k) => st.cells[k].sealed).length;
        parts.push(`連鎖反應：從 ${L(st.position)} 號牢房走過去會打開 ${T.plural(opens, '扇未開啟的門')}，包括這一扇。`);
      } else if (!c.sealed && c.inmate) {
        const count = T.devourOptions(st, p.cell).length;
        parts.push(`典獄長走到 ${L(p.cell)} 號牢房的${T.describe(c.inmate)}那裡，由它進行今天的吞噬${count ? `（從那裡有 ${T.plural(count, '個目標')}）` : '，但從那裡沒有目標'}。`);
      } else if (p.cell === T.OFFICE) parts.push(`審訊室：在那裡選擇煽動（在隨機牢房出現一個新的獄中事變，盤面上沒有事變時出現 2 個）或賞賜（隨機 1 隻囚犯升一階）。`);
      else if (!c.sealed) parts.push('空牢房：典獄長走過去。');
      else if (c.nest) parts.push(`這會摧毀第 ${c.nest.due} 天要孵化的鼠巢。`);
      else if (c.known === 2) parts.push(`裡面是${T.describe(c.hidden)}。`);
      else if (c.known === 1) parts.push(`裡面是一隻${T.tierName(c.hidden.tier)}囚犯，野獸未知。`);
      else parts.push('門打開之前不知道裡面是誰。');
      if (c.sealed && c.event && c.seen && !st.chain) parts.push('這扇門後有獄中事變。');
      if (st.tools.includes('keys') && c.sealed && !st.chain) parts.push('遺落的鑰匙串：80% 機率兩側的牢房也會打開。');
      const steps = T.stepsBetween(st.position, p.cell);
      if (st.tools.includes('shackles') && steps >= 4) parts.push(`長鏈腳鐐：這次走 ${steps} 格，所以有 40% 機率讓隨機一隻囚犯升一階。`);
      if (st.objective.id === 'walk' && !st.milestone) parts.push(`巡獄之路：走完後為 ${Math.min(T.OBJECTIVES.walk.need, st.objective.progress + steps)}/${T.OBJECTIVES.walk.need} 格。`);
      const actions = [[c.sealed || st.chain ? '開門' : '走過去', () => run((s) => T.patrol(s, p.cell), { select: p.cell }), 'primary']];
      actions.push(['取消', cancel]);
      setDecision(`巡視到 ${L(p.cell)} 號牢房？`, parts.join(''), actions, true);
      return;
    }
    if (p.kind === 'devour') {
      const eater = st.cells[p.from].inmate;
      const option = eater ? T.devourOptions(st, p.from).find((o) => o.cell === p.to) : null;
      if (!option) {
        ui.pending = null;
        renderDecision();
        return;
      }
      const target = st.cells[p.to];
      const { gain, notes, saw, revenge } = T.gainFor(st, p.from, option);
      const to = Math.min(T.RAINBOW, eater.tier + gain);
      const meal = target.sealed ? `有劃痕的門後那隻${T.tierName(target.hidden.tier)}囚犯` : `${T.describe(target.inmate)}`;
      const extras = [];
      if (notes.length) extras.push(`加成：${notes.join('、')}。`);
      extras.push(`這是今天的吞噬${canSwapNow(st) ? '，也會用掉今天的替換' : ''}。${T.canStopChain && T.canStopChain(st) ? '之後吞噬者會繼續吃：由你挑選每一個獵物，或停止連鎖（等同遊戲中的「取消」）。' : '之後只要還能吃就必須繼續吃：只有一個獵物時會直接吃掉，有得選時由你挑。'}再點一次目標即可吞噬。`);
      if (saw) extras.push('鏽鋸可能再 +1。');
      if (st.tools.includes('whip')) extras.push('棘刺鐵鞭：35% 機率 +1。');
      if (st.tools.includes('collar')) extras.push('瘋獸的倒刺項圈：這一口之後的每一口有 80% 機率 +1。');
      if (revenge) extras.push('復仇者之匣可能會開出新的獵物。');
      if (T.linkOf(st, eater.id) && to < T.RAINBOW && !(T.cageFight && T.cageFight(st))) extras.push('如果它的野獸改變，獵物標記就會結束。');
      const outcome = to === T.RAINBOW ? '達到綺彩，前往收容區' : T.cageFight && T.cageFight(st) ? `升到${T.tierName(to)}，並維持${T.beastName(eater.beast)}（囚徒困鬥）` : `升到${T.tierName(to)}，然後重新隨機野獸`;
      setDecision(`吞噬，+${gain}？`, `${L(p.from)} 號牢房的${T.describe(eater)}吃掉 ${L(p.to)} 號牢房的${meal}。它會${outcome}。${extras.join('')}`.trim(), [
        ['吞噬', () => run((s) => T.devour(s, p.from, p.to)), 'primary'],
        ['取消', back],
      ], true);
      return;
    }
    if (p.kind === 'chain') {
      const eater = st.cells[st.position].inmate;
      const option = st.chaining ? T.chainOptions(st).find((o) => o.cell === p.to) : null;
      if (!option || !eater) {
        ui.pending = null;
        renderDecision();
        return;
      }
      const target = st.cells[p.to];
      const { gain, notes } = T.gainFor(st, st.position, option);
      const to = Math.min(T.RAINBOW, eater.tier + gain);
      const meal = target.sealed ? `有劃痕的門後那隻${T.tierName(target.hidden.tier)}囚犯` : `${T.describe(target.inmate)}`;
      const extras = [];
      if (notes.length) extras.push(`加成：${notes.join('、')}。`);
      if (st.tools.includes('saw')) extras.push('鏽鋸可能再 +1。');
      if (st.tools.includes('whip')) extras.push('棘刺鐵鞭：35% 機率 +1。');
      if (st.tools.includes('collar')) extras.push('瘋獸的倒刺項圈：80% 機率 +1。');
      const outcome = to === T.RAINBOW ? '達到綺彩，前往收容區' : T.cageFight && T.cageFight(st) ? `升到${T.tierName(to)}，並維持${T.beastName(eater.beast)}（囚徒困鬥）` : `升到${T.tierName(to)}，然後重新隨機野獸`;
      setDecision(`下一口，+${gain}？`, `${T.describe(eater)}吃掉 ${L(p.to)} 號牢房的${meal}。它會${outcome}。${extras.join('')}`.trim(), [
        ['吃掉', () => run((s) => T.chainBite(s, p.to), { select: st.position }), 'primary'],
        ...(T.canStopChain && T.canStopChain(st) ? [['停止連鎖', () => run((s) => T.stopChain(s), { select: st.position })]] : []),
        ['返回', back],
      ], true);
      return;
    }
    if (p.kind === 'swap') {
      const cell = st.cells[p.cell];
      if (!cell.inmate) {
        ui.pending = null;
        renderDecision();
        return;
      }
      const parts = [`一隻全新的隨機囚犯會取代${T.describe(cell.inmate)}，可能變強也可能變弱。`];
      if (st.tools.includes('rope')) parts.push('絞首繩：不會是普通或魔法。');
      if (st.tools.includes('axe')) parts.push(`獄卒的行刑巨斧：如果新囚犯高於${T.tierName(cell.inmate.tier)}，隨機打開 2 間未開啟的牢房。`);
      if (cell.ivory) parts.push(`象牙牢房：之後 ${T.plural(st.params.ivoryCount, '隻囚犯')}各升一階。`);
      if (T.canDevourNow(st)) parts.push('這會用掉今天的吞噬：一天只能替換或吞噬其中一種。');
      setDecision(`替換 ${L(p.cell)} 號牢房的囚犯？`, parts.join(''), [
        ['替換', () => run((s) => T.swap(s, p.cell)), 'primary'],
        ['取消', back],
      ], true);
      return;
    }
    if (p.kind === 'hunt') {
      const targets = T.huntTargets(st);
      if (!targets.length) {
        ui.pending = null;
        renderDecision();
        return;
      }
      setDecision('尋獵：要給哪隻囚犯獵物標記？', `${L(st.position)} 號牢房的狂獅和牠的獵物，在接下來 ${T.plural(st.params.preyRounds, '個早上')}每天早上各升一階（兩者都要留在監區且野獸不變）。這會用掉今天的吞噬或替換。`, [
        ...targets.map((n) => [`${L(n)} 的${T.describe(st.cells[n].inmate)}`, () => run((s) => T.hunt(s, n), { select: st.position }), 'primary']),
        ['取消', back],
      ], true);
      return;
    }
    if (p.kind === 'end') {
      const lead = p.last ? `第 ${st.day} 天是最後一天。結束後本局也會結束。` : '';
      setDecision(p.last ? '結束本局？' : `結束第 ${st.day} 天？`, [lead, ...p.warnings].filter(Boolean).join(''), [
        [p.last ? '結束本局' : '結束這天', () => run((s) => T.endDay(s), { select: null }), 'primary'],
        ['取消', cancel],
      ], true);
    }
  }

  function renderSelection(cell) {
    const st = ui.state;
    const actions = [];
    const free = !blocked(st);
    if (cell.n === T.OFFICE) {
      setDecision(`${L(cell.n)} 號牢房：審訊室`, `每一局都從這裡開始，這裡永遠不會有囚犯、標記或事變。它可能是早上的目的地之一：走到這裡時，選擇煽動（在隨機牢房出現一個新的獄中事變，盤面上沒有事變時出現 2 個）或賞賜（隨機 1 隻囚犯升一階）。`, [['取消選取', cancel]]);
      return;
    }
    if (cell.sealed) {
      const parts = [];
      if (cell.nest) parts.push(`鼠巢。第 ${cell.nest.due} 天早上會孵出一隻${T.tierName(st.params.nestTier)}碩鼠。提早打開會摧毀它。`);
      else if (cell.known === 2) parts.push(`裡面是${T.describe(cell.hidden)}。`);
      else if (cell.known === 1) parts.push(`裡面是一隻${T.tierName(cell.hidden.tier)}囚犯，野獸未知。`);
      else parts.push('不知道裡面是誰。');
      if (cell.scratch) parts.push(`${T.tierName(cell.hidden.tier)}頭狼可以隔著有劃痕的門吞噬它。`);
      if (cell.event && cell.seen) parts.push('這扇門後有獄中事變，只有巡視打開它時才會觸發。');
      if (free && st.phase === 'patrol' && !st.destinations.includes(cell.n)) parts.push('它不是今天的目的地。');
      actions.push(['取消選取', cancel]);
      setDecision(`${L(cell.n)} 號牢房：未開啟`, parts.join(''), actions);
      return;
    }
    if (!cell.inmate) {
      setDecision(`${L(cell.n)} 號牢房：空`, '這間牢房在本局剩下的時間都會是空的。', [['取消選取', cancel]]);
      return;
    }
    const inmate = cell.inmate;
    // Mammoths and Lions also eat their second meal (from the Lab's rarity up).
    const eats = T.eatsOf(st, inmate.beast, inmate.tier).map(T.beastName);
    if (inmate.beast === 'rat' && st.tools.includes('skewer')) eats.push(T.beastName('rat'));
    const parts = [`吃同稀有度的${eats.join('和')}。`];
    if (inmate.beast === 'wolf') parts.push('也能隔著有劃痕的門吞噬。');
    if (st.phase === 'patrol') parts.push('先巡視，之後典獄長牢房裡的囚犯才能吞噬。');
    else if (st.phase === 'manage') {
      const options = T.devourOptions(st, cell.n);
      if (cell.n !== st.position) parts.push(`只有典獄長牢房（${L(st.position)}）裡的囚犯能開始今天的吞噬。`);
      else if (!T.canDevourNow(st)) parts.push(st.used.swap > 0 ? '你今天替換過囚犯，所以不能吞噬：一天只能二選一。' : '今天的吞噬已經用掉了。');
      else parts.push(options.length ? `它在典獄長的牢房裡：已標示 ${T.plural(options.length, '個目標')}。雙擊可直接吞噬，單擊可預覽這一口。` : '它在典獄長的牢房裡，但目前沒有目標。');
    }
    if (cell.ivory) parts.push(`象牙牢房：替換這裡的囚犯會讓 ${T.plural(st.params.ivoryCount, '隻囚犯')}升一階。`);
    const link = T.linkOf(st, inmate.id);
    if (link) {
      const hunter = link.lion === inmate.id;
      const other = T.cellOf(st, hunter ? link.prey : link.lion);
      parts.push(`${hunter ? `正在尋獵 ${other ? L(other.n) : '--'} 號牢房` : `是 ${other ? L(other.n) : '--'} 號牢房狂獅的獵物`}：接下來 ${T.plural(link.rounds, '個早上')}，兩者每天早上各升一階。`);
    }
    if (free && st.phase === 'manage' && cell.n === st.position) {
      const left = canSwapNow(st) ? st.params.swapsPerDay - st.used.swap : 0;
      actions.push([`替換（剩 ${Math.max(0, left)} 次）`, () => askSwap(cell.n), null, left <= 0]);
    } else if (st.phase === 'manage') parts.push('只有典獄長牢房裡的囚犯可以被替換。');
    actions.push(['取消選取', cancel]);
    setDecision(`${L(cell.n)} 號牢房：${T.describe(inmate)}`, parts.join(''), actions);
  }

  // ---------- Rendering: frame and ledger ----------

  function renderTop() {
    const st = ui.state;
    $('mode-chip').textContent = `${modeName(st)} · ${st.seed}`;
    $('day-num').textContent = String(st.day).padStart(2, '0');
    $('day-of').textContent = `/ ${st.maxDays}`;
    const pill = $('phase-pill');
    const phase = st.phase === 'ended' ? '已交接' : st.phase === 'patrol' ? '巡視' : st.phase === 'event' ? '事變' : '管理';
    pill.textContent = phase;
    pill.className = 'phase' + (st.phase === 'ended' ? ' is-ended' : st.phase === 'patrol' ? '' : ' is-manage');
    const left = st.maxDays - st.day;
    $('handoff').textContent = st.phase === 'ended' ? '本局結束' : left === 0 ? '最後一天' : `今天之後還有 ${T.plural(left, '天')}`;
  }

  function renderActions() {
    const st = ui.state;
    const free = !blocked(st);
    const swapBtn = $('btn-swap');
    // A day has a devour or a swap, not both.
    const left = canSwapNow(st) ? Math.max(0, st.params.swapsPerDay - st.used.swap) : 0;
    const here = st.cells[st.position];
    const canSwap = free && st.phase === 'manage' && left > 0 && !here.sealed && !!here.inmate;
    swapBtn.textContent = `替換（${left}）`;
    swapBtn.disabled = !canSwap;
    swapBtn.title = canSwap ? `替換典獄長牢房（${L(st.position)}）裡的囚犯。${T.canDevourNow(st) ? '這會用掉今天的吞噬。' : ''}` : st.used.devour > 0 ? '你今天已經吞噬過：一天只能吞噬或替換其中一種。' : '巡視之後，只有典獄長牢房裡的囚犯可以被替換。';
    // The Blood-Stained Trap's Hunt, the day's third choice on a Lion.
    const huntBtn = $('btn-hunt');
    const canHunt = free && !!T.canHuntNow && T.canHuntNow(st);
    huntBtn.hidden = !st.tools.includes('trap');
    huntBtn.disabled = !canHunt;
    huntBtn.title = canHunt ? '染紅的捕獸夾：典獄長牢房裡的狂獅給一隻牠能吞噬的囚犯加上獵物標記。這會用掉今天的吞噬或替換。' : '有染紅的捕獸夾時，典獄長站在一隻有可吞噬對象的狂獅上，且今天還沒吞噬或替換，才能尋獵。';

    $('btn-undo').disabled = !ui.history.length;
    const endBtn = $('btn-end');
    endBtn.disabled = !free || st.phase !== 'manage';
    endBtn.textContent = st.day >= st.maxDays ? '結束本局' : '結束這天';
  }

  function renderLog() {
    const st = ui.state;
    const list = $('log');
    const last = st.log[st.log.length - 1];
    const key = `${st.log.length}|${last ? last.t : ''}|${st.seed}`;
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    const items = [];
    let day = null;
    for (let i = st.log.length - 1; i >= 0; i--) {
      const e = st.log[i];
      if (e.d !== day) {
        day = e.d;
        items.push(`<li class="log-day">第 ${String(e.d).padStart(2, '0')} 天</li>`);
      }
      // A devour also shows its bites as icons; the text says the same.
      const icons = e.x && e.x.type === 'devour' ? `<span class="log-icons" aria-hidden="true">${chainStrip(e.x)}</span>` : '';
      items.push(`<li class="log-entry k-${esc(e.k)}"><span class="log-text">${esc(e.t)}${icons}</span></li>`);
    }
    list.innerHTML = items.join('') || '<li class="log-empty">還沒有任何紀錄。</li>';
  }

  // ---------- Beast icons and the day recap ----------

  // A small portrait in its rarity color. Meals are struck through, and a
  // Rainbow gets the rainbow ring.
  function tok(who, opts) {
    const o = opts || {};
    const cls = ['tok', `t${who.tier}`];
    if (o.eaten) cls.push('is-eaten');
    if (who.tier >= T.RAINBOW) cls.push('is-rainbow');
    const title = `${T.describe(who)}${o.cell !== undefined ? `，${L(o.cell)} 號牢房` : ''}${o.eaten ? '，被吃掉' : ''}`;
    return `<span class="${cls.join(' ')}" title="${esc(title)}">${PORTRAITS[who.beast]}</span>`;
  }

  // A devour as icons: each bite is the eater, its fangs with the tiers it
  // gained, and the meal. Every bite re-rolls the eater, so the next bite
  // starts from its new form, and the strip ends with how it finished.
  function chainStrip(x) {
    const then = '<span class="then">›</span>';
    const bites = x.bites.map((b) => `<span class="bite">${tok(b.eater, { cell: b.from })}<span class="fang">${FANGS}<b>+${b.gain}</b></span>${tok(b.meal, { cell: b.cell, eaten: true })}</span>`);
    const end = x.bites[x.bites.length - 1].after;
    return `<span class="chain-strip">${bites.join(then)}${then}${tok(end)}${end.tier >= T.RAINBOW ? '<span class="vault-note">收容區</span>' : ''}</span>`;
  }

  // Each morning the recap under the ring looks back at yesterday; after the
  // patrol it follows today. On day 1 the patrol hint has the space.
  function renderRecap() {
    const st = ui.state;
    const day = st.phase === 'patrol' ? st.day - 1 : st.day;
    const items = day >= 1 ? recapItems(st, day) : [];
    const box = $('day-recap');
    box.hidden = !items.length;
    $('dest-hint').hidden = items.length > 0;
    if (!items.length) return;
    $('recap-title').textContent = st.phase === 'patrol' || st.phase === 'ended' ? `第 ${String(day).padStart(2, '0')} 天回顧` : '今天到目前為止';
    setHTML($('recap-items'), items.join(''));
  }

  function recapItems(st, day) {
    const item = (label, body, cls) => `<li class="recap-item${cls ? ` ${cls}` : ''}"><span class="recap-label">${esc(label)}</span>${body}</li>`;
    const records = st.log.filter((e) => e.d === day && e.x).map((e) => e.x);
    const out = [];
    for (let i = 0; i < records.length; i++) {
      const x = records[i];
      if (x.type === 'open' && x.side) {
        // Doors opened together (Ring of Keys, a chain reaction) share one item.
        const group = [x];
        while (records[i + 1] && records[i + 1].type === 'open' && records[i + 1].side) group.push(records[++i]);
        out.push(item(group.length === 1 ? `也打開了 ${L(x.cell)}` : `額外打開 ${group.length} 扇門`, group.map((g) => tok(g.who, { cell: g.cell })).join('')));
      } else if (x.type === 'open') out.push(item(`打開 ${L(x.cell)}`, tok(x.who, { cell: x.cell })));
      else if (x.type === 'walk') out.push(item(`走到 ${L(x.cell)}`, x.who ? tok(x.who, { cell: x.cell }) : ''));
      else if (x.type === 'sweep') out.push(item(`連鎖行走 ${L(x.from)} 到 ${L(x.cell)}`, ''));
      else if (x.type === 'armed') out.push(item('連鎖反應已啟動', ''));
      else if (x.type === 'trickster') out.push(item('暗箱操作', `${tok(x.who, { cell: x.cell })}<span class="then">›</span>${tok(x.after, { cell: x.cell })}`));
      else if (x.type === 'shackles') out.push(item('鐐銬 +1', tok(x.who, { cell: x.cell })));
      else if (x.type === 'appetite') out.push(item(`飢腸轆轆 +${x.gain}`, `${tok(x.who, { cell: x.cell })}<span class="then">›</span>${tok(x.after, { cell: x.cell })}`));
      else if (x.type === 'convict') out.push(item('高危罪犯', x.cell === null ? '<span class="recap-note">沒有剩下的牢房</span>' : `<span class="recap-note">${L(x.cell)} 號牢房</span>`));
      else if (x.type === 'crow') out.push(item('鴉之低語', `<span class="recap-note">${x.cells.length ? `顯示稀有度：${x.cells.map(L).join('、')}` : '沒有可以顯示的了'}</span>`));
      else if (x.type === 'hunt') out.push(item(T.eventName('hunt'), `<span class="recap-note">${[x.cells.length ? `低稀有度：${x.cells.map(L).join('、')}` : '', x.high.length ? `稀有或更高：${x.high.map(L).join('、')}` : ''].filter(Boolean).join('；') || '沒有剩下上鎖的牢房'}</span>`));
      else if (x.type === 'usurp1' || x.type === 'usurp2' || x.type === 'portion') out.push(item(T.eventName(x.type), x.raised.length ? x.raised.map((r) => tok(r.who, { cell: r.cell })).join('') : '<span class="recap-note">沒有對象</span>'));
      else if (x.type === 'freedom') out.push(item('自由的滋味', `<span class="recap-note">${x.cells.length ? `打開 ${x.cells.map(L).join('、')}` : '沒有剩下上鎖的牢房'}</span>`));
      else if (x.type === 'instigate') out.push(item('煽動', `<span class="recap-note">${x.cells.length ? `事變出現在 ${x.cells.map(L).join('、')}` : '沒有空的門'}</span>`));
      else if (x.type === 'bestow') out.push(item('賞賜 +1', x.who ? tok(x.who, { cell: x.cell }) : '<span class="recap-note">沒有對象</span>'));
      else if (x.type === 'objective') out.push(item('目標達成', `<span class="recap-note">${esc(T.OBJECTIVES[x.id].name)}</span>`));
      else if (x.type === 'skipped') out.push(item(`略過${x.name}`, ''));
      else if (x.type === 'execution') {
        const took = x.victims.length ? `<span class="fang">${FANGS}<b>×${x.victims.length}</b></span>${x.victims.map((v) => tok(v, { eaten: true })).join('')}` : '<span class="recap-note">沒有對象</span>';
        out.push(item('處刑效率', `${tok(x.who, { cell: x.cell })}${took}`, 'is-devour'));
      } else if (x.type === 'devour') out.push(item(x.bites.length > 1 ? `連鎖 ×${x.bites.length}` : '吞噬', chainStrip(x), 'is-devour'));
      else if (x.type === 'swap') out.push(item(`替換 ${L(x.cell)}`, `${tok(x.old, { cell: x.cell, eaten: true })}<span class="then">›</span>${tok(x.fresh, { cell: x.cell })}`));
      else if (x.type === 'rainbow') out.push(item('綺彩', tok(x.who), 'is-rainbow'));
      else if (x.type === 'tool') out.push(item('刑具', `<span class="recap-note">${esc(T.toolName(x.id))}</span>`));
      else if (x.type === 'gift') out.push(item('秘藏', `<span class="recap-note">${esc(T.toolName(x.id))}</span>`));
      else if (x.type === 'ivory') out.push(item('象牙', `<span class="recap-note">${T.plural(x.count, '隻囚犯')} +1</span>`));
    }
    return out;
  }

  function facts(pairs) {
    return pairs.map(([k, v, text]) => `<div><dt>${esc(k)}</dt><dd${text ? ' class="is-text"' : ''}>${esc(v)}</dd></div>`).join('');
  }

  function renderGoal() {
    const st = ui.state;
    const board = T.boardInmates(st);
    renderObjective(st);
    $('goal-title').textContent = st.scenario === 'empty' ? '規則練習' : T.SCENARIOS[st.scenario].name;
    $('goal-text').textContent = `在第 ${st.maxDays} 天本局結束前，把越多囚犯升到綺彩越好。種子 ${st.seed}。`;
    const best = Math.max(st.vault.length ? T.RAINBOW : 0, ...board.map((i) => i.tier), 0);
    $('goal-facts').innerHTML = facts([
      ['綺彩', st.vault.length],
      ['目前最高', board.length || st.vault.length ? T.tierName(best) : '—', true],
      ['監區囚犯', board.length],
    ]);
  }

  // The run's objective, as the live game shows it, with its progress.
  function renderObjective(st) {
    const o = st.objective;
    const def = T.OBJECTIVES[o.id];
    const done = st.milestone;
    const status = done ? '完成' : o.id === 'walk' ? `${o.progress}/${def.need}` : '未完成';
    const reward = !st.params.rewards ? '這個練習關閉了獎勵。' : done ? '已獲得刑具。' : '達成後可獲得一件刑具。';
    const bar = o.id === 'walk' ? `<span class="objective-bar${done ? ' is-done' : ''}"><span style="width:${Math.round((100 * o.progress) / def.need)}%"></span></span>` : '';
    // A card shown before the run (Cage Fight, Iron Law), besides its objective.
    const card = st.startEvent && T.START_EVENTS ? T.START_EVENTS[st.startEvent] : null;
    const cardHTML = card ? `<p class="objective-head"><span class="objective-tag">開局卡</span><span class="objective-name">${esc(card.name)}</span></p><p class="objective-text">${esc(card.text)}。</p>` : '';
    setHTML($('goal-objective'), `<p class="objective-head"><span class="objective-tag">目標</span><span class="objective-name">${esc(def.name)}</span><span class="objective-status${done ? ' is-done' : ''}">${esc(status)}</span></p><p class="objective-text">${esc(def.text)}。${esc(reward)}</p>${bar}${cardHTML}`);
  }

  function renderVault() {
    const st = ui.state;
    const slots = Math.max(5, st.vault.length + 1);
    let html = '';
    for (let i = 0; i < slots; i++) {
      const v = st.vault[i];
      html += v
        ? `<span class="vault-slot is-filled" title="綺彩${esc(T.beastName(v.beast))}，第 ${v.day} 天收容"><span>${PORTRAITS[v.beast]}</span></span>`
        : '<span class="vault-slot" aria-hidden="true"></span>';
    }
    $('vault').innerHTML = html;
    const cache = st.params.rewards ? `已獲得珍藏：${st.cache}。` : `典獄長的珍藏領取次數：${st.cache}。`;
    $('vault-note').textContent = st.vault.length
      ? `收容區有 ${T.plural(st.vault.length, '隻綺彩')}。${cache}`
      : st.params.rewards
        ? '升到綺彩的囚犯會離開監區在這裡等候。每一隻都會開啟典獄長的珍藏，讓你挑一件珍品。'
        : '升到綺彩的囚犯會離開監區在這裡等候。每一隻都會增加一次典獄長的珍藏領取。';
  }

  function renderTools() {
    const st = ui.state;
    const list = $('tool-list');
    if (!st.tools.length) {
      const empty = st.params.rewards ? '還沒有刑具。達成目標可以獲得一件。實驗室可以加入更多，或修改開局選項。' : '這個練習關閉了獎勵。可以在實驗室加入刑具來測試。';
      list.innerHTML = `<li class="tool-text">${empty}</li>`;
      return;
    }
    list.innerHTML = st.tools.map((id) => `<li class="tool"><span class="tool-name">${esc(T.toolName(id))}</span><span class="tool-text">${esc(T.toolText(id))}</span></li>`).join('');
  }

  function tipAction(tip) {
    switch (tip.kind) {
      case 'patrol':
        return ['前往', () => run((s) => T.patrol(s, tip.cell), { select: tip.cell })];
      case 'devour':
        return ['吞噬', () => run((s) => T.devour(s, tip.from, tip.to), { select: tip.from })];
      case 'chain':
        return ['吃掉', () => run((s) => T.chainBite(s, tip.to), { select: tip.from })];
      case 'stopchain':
        return ['停止', () => run((s) => T.stopChain(s), { select: tip.from })];
      case 'office':
        return [tip.choice === 'bestow' ? '賞賜' : '煽動', () => run((s) => T.officeAct(s, tip.choice))];
      case 'swap':
        return ['替換', () => run((s) => T.swap(s, tip.cell))];
      case 'event':
        return [ui.state && ui.state.event && ui.state.event.kind === 'hunt' ? '確認' : tip.accept ? '接受' : '略過', () => run((s) => T.resolveEvent(s, tip.accept))];
      case 'choose':
        return ['拿取', () => run((s) => T.choose(s, tip.id))];
      case 'end':
        return ['結束這天', askEndDay];
      default:
        return null;
    }
  }

  // ---------- Trainer ----------

  // The trainer panel: the recommended move right away (the trained strategy's
  // pick), then a live check that plays every option out many times from the
  // current position with js/solver.js, and a grade for each move you make.
  // The playouts run in a Web Worker when the page allows one, and on this
  // thread otherwise. Moves are scored by the Rainbows vaulted by the end of
  // the run.
  const SOLVER_ROLLOUTS = 800;
  const SOLVER_ROLLOUTS_HERE = 300;
  const LIVE_MIN = 150; // playouts per option before the live check leads
  const SWITCH_MIN = 0.05; // Rainbows a live pick must gain over the strategy's to replace it
  const solver = { worker: null, failed: false, id: 0, key: '', stateKey: '', result: null, instantKey: '', instant: null };

  const solverKey = (st) => {
    const last = st.log[st.log.length - 1];
    return [st.seed, st.day, st.phase, st.position, st.log.length, last ? last.t : '', st.pending.length, st.used.swap, st.used.devour, st.vault.length].join('|');
  };

  const solverFits = (st) => st && st.phase !== 'ended';

  // A stable name for an action, for lists that update in place.
  const actionKey = (a) => [a.type, a.cell, a.to, a.id, a.accept, a.choice].join('|');

  // What the training found for each kind of decision. When the run uses the
  // same food chain as the guide's data (js/guide-data.js), lessons quote
  // its numbers; otherwise they give the advice without numbers.
  const LESSONS = {
    patrol: '訓練結果：開門、走遠一點，比走到沒東西可吃的囚犯那裡收容更多綺彩。',
    devour: '訓練結果：能吞噬的每一天都要吞噬，除非會破壞獵物標記。等待更大的連鎖會損失綺彩。',
    swap: '訓練結果：典獄長牢房裡沒有更有價值的吞噬時，就替換掉低階囚犯（一天只能二選一）。從不替換會損失綺彩。',
    end: '訓練結果：這裡沒有任何收益時就結束這天。',
    chain: '訓練結果：接受連鎖反應比略過收容更多綺彩。',
    execution: '訓練結果：只有在處刑效率的收益大於除掉的囚犯時才接受。',
    trickster: '暗箱操作能免費做出一隻至臻：除非該囚犯已經是至臻，否則就接受。',
    appetite: '飢腸轆轆只會增加階數：接受。',
    convict: '高危罪犯能免費打開一間關著傳奇的牢房：接受。',
    crow: '鴉之低語沒有代價：接受，然後把巡視瞄準它顯示的高稀有度。',
    freedom: '自由的滋味能免費打開 3 扇門：接受。',
    portion: '有福同享能免費讓最多 3 隻囚犯升階：接受。',
    usurp1: '僭越 I 能免費讓一隻囚犯升階，還會帶來僭越 II：接受。',
    usurp2: '僭越 II 能免費讓兩隻囚犯升階，還會帶來僭越 III：接受。',
    usurp3: '僭越 III 讓兩隻囚犯各升兩階，還會帶來僭越 IV：接受。',
    usurp4: '僭越 IV 讓每隻囚犯升兩階：接受。',
    ratway: '暗渠鼠道能免費移動到審訊室以外的任何牢房：接受，然後挑整個監區最好的門或囚犯。',
    hunt: '尋「寶」沒有代價：確認，然後把巡視瞄準沒有亮起的門，那些門裡是稀有或更高。',
    office: '在審訊室時，升階馬上有幫助就選賞賜；監區需要新的事變門時就選煽動。',
    chainPick: '連鎖中的每個獵物都由你挑選，也可以用「取消」停止：挑能讓連鎖在下一階繼續有得吃的獵物，只有在每個獵物都得不償失時才停止。',
    gift: '訓練結果：挑選適合盤面的珍品，勝過每次都拿同一件。',
  };

  function guideFor(st) {
    const g = window.TARTARUS_GUIDE;
    return g || null;
  }

  function lessonFor(st, action) {
    const g = guideFor(st);
    const habit = (id) => (g ? g.habits.find((h) => h.id === id) : null);
    const full = habit('full');
    const vs = (id, text) => {
      const h = habit(id);
      return full && h ? `${text}（每局 ${h.value.toFixed(2)} 隻綺彩，對比 ${full.value.toFixed(2)}）` : null;
    };
    if (st.pending.length) {
      if (st.pending[0].kind === 'gift') return LESSONS.gift;
      const names = window.TartarusSolver.paramsFor(st).toolRank.map((id) => T.toolName(id));
      return `訓練結果：拿能讓手上刑具組合增益最多的那一件（以每種組合跑了數百萬局測得）。單看刑具本身，順序是：${names.join('、')}。`;
    }
    if (st.phase === 'event' && st.event) {
      if (st.event.kind === 'chain') return (vs('skipChain', '訓練結果：略過連鎖反應會損失綺彩') || LESSONS.chain) + (g ? '。' : '');
      return LESSONS[st.event.kind] || LESSONS.execution;
    }
    if (st.phase === 'office') return LESSONS.office;
    if (st.chaining) return LESSONS.chainPick;
    if (st.phase === 'patrol') return LESSONS.patrol;
    if (!action) return '';
    if (action.type === 'devour') return (vs('wait2', '訓練結果：能吞噬的每一天都要吞噬，除非會破壞獵物標記。等待更大的連鎖會損失綺彩') || LESSONS.devour) + (g ? '。' : '');
    if (action.type === 'swap') {
      // Without tools, never swapping can come out about even.
      const never = habit('neverSwap');
      if (full && never && full.value - never.value < 0.01) return `訓練結果：典獄長牢房裡沒有更有價值的吞噬時，就替換掉低階囚犯（一天只能二選一）。沒有刑具時，這和從不替換差不多（每局 ${never.value.toFixed(2)} 隻綺彩，對比 ${full.value.toFixed(2)}），但切開的人形棺、替罪人的斷頭台和火刑柱都是靠替換發揮效果。`;
      // "The most" only while the guide's data still has never swapping as
      // the costliest habit.
      const worst = g ? g.habits.filter((h) => h.id !== 'simple' && h.id !== 'random').sort((a, b) => a.value - b.value)[0] : null;
      const text = `訓練結果：典獄長牢房裡沒有更有價值的吞噬時，就替換掉低階囚犯（一天只能二選一）。從不替換${worst && worst.id === 'neverSwap' ? '損失最多' : '會損失綺彩'}`;
      return (vs('neverSwap', text) || LESSONS.swap) + (g ? '。' : '');
    }
    return LESSONS[action.type] || '';
  }

  function startSolver() {
    const st = ui.state;
    const key = solverKey(st);
    if (key === solver.key) return;
    solver.key = key;
    solver.stateKey = key;
    solver.id += 1;
    solver.result = null;
    const id = solver.id;
    const state = Object.assign({}, st, { log: [] });
    if (!solver.worker && !solver.failed) {
      try {
        solver.worker = new Worker(`js/solver-worker.js${SCRIPT_QUERY}`);
        solver.worker.onmessage = (e) => {
          if (e.data.id !== solver.id) return;
          solver.result = e.data.result;
          renderSolver();
          renderHints();
        };
        solver.worker.onerror = () => {
          // Fall back to this thread, and redo the current position.
          solver.failed = true;
          solver.worker = null;
          solver.key = '';
          if (ui.prefs.advisor && solverFits(ui.state)) startSolver();
        };
      } catch (e) {
        solver.failed = true;
        solver.worker = null;
      }
    }
    if (solver.worker) solver.worker.postMessage({ id, state: JSON.parse(JSON.stringify(state)), rollouts: SOLVER_ROLLOUTS });
    else solveHere(id, state);
  }

  function solveHere(id, state) {
    const job = window.TartarusSolver.solve(JSON.parse(JSON.stringify(state)), { rollouts: SOLVER_ROLLOUTS_HERE, seed: (id * 7919 + 1) >>> 0 });
    const tick = () => {
      if (id !== solver.id) return;
      solver.result = job.step(12);
      renderSolver();
      renderHints();
      if (!solver.result.done) setTimeout(tick, 16);
    };
    setTimeout(tick, 0);
  }

  // The live check's result for this position, if it has one.
  const liveResult = (st) => (solver.stateKey === solverKey(st) ? solver.result : null);

  // The trained strategy's pick for this position, worked out once.
  function instantPick(st) {
    const key = solverKey(st);
    if (solver.instantKey !== key) {
      solver.instantKey = key;
      try {
        solver.instant = window.TartarusSolver.instant(st);
      } catch (e) {
        solver.instant = null;
      }
    }
    return solver.instant;
  }

  // The move to recommend: the strategy's instant pick, unless the live check
  // finds a clearly better move (by more than its paired margin of error), so
  // the recommendation doesn't flicker between near-equal options.
  function recommendation(st) {
    if (!ui.prefs.advisor || !solverFits(st)) return null;
    const S = window.TartarusSolver;
    const pick = instantPick(st);
    const r = liveResult(st);
    const ranked = r ? r.options : [];
    const live = r && ranked.length > 1 && (r.done || r.rounds >= LIVE_MIN) ? ranked[0] : null;
    if (!live) return pick ? Object.assign({ live: false }, pick) : null;
    const mine = pick && ranked.find((o) => S.sameAction(o.action, pick.action));
    // A better move must also win by a margin worth playing for: shared dice
    // make the paired margin narrow, and a near tie flips the advice.
    if (mine && (mine === live || live.mean - mine.mean <= Math.max(1.96 * mine.gapSe, SWITCH_MIN))) {
      const why = mine === live ? pick.why : `${pick.why}即時檢驗評估它與最佳選項差不多。`;
      return Object.assign({ live: true, rounds: r.rounds }, pick, { label: mine.label, why, option: mine });
    }
    return { action: live.action, label: live.label, why: `模擬找到了比策略選擇${pick ? `（${pick.label}）` : ''}更好的動作。`, live: true, rounds: r.rounds, option: live };
  }

  function playSolverMove(action) {
    const st = ui.state;
    if (!action || !st) return;
    if (action.type === 'patrol') run((s) => window.TartarusSolver.apply(s, action), { select: action.cell });
    else if (action.type === 'devour' || action.type === 'chain' || action.type === 'stopchain' || action.type === 'swap') run((s) => window.TartarusSolver.apply(s, action), { select: st.position });
    else if (action.type === 'end') run((s) => T.endDay(s), { select: null });
    else run((s) => window.TartarusSolver.apply(s, action));
  }

  // ---------- Grading your moves ----------

  function trainerFor(st) {
    if (!ui.trainer || ui.trainer.seed !== st.seed) ui.trainer = { seed: st.seed, moves: 0, good: 0, lost: 0, last: null };
    return ui.trainer;
  }

  // Grades the move just made against the live check of the position before
  // it. Called by run() after a move succeeds.
  function gradeMove(snapshot) {
    if (!ui.prefs.advisor) return;
    const before = T.deserialize(snapshot);
    if (!solverFits(before)) return;
    const move = window.TartarusSolver.moveBetween(before, ui.state);
    if (!move) return;
    const t = trainerFor(ui.state);
    const r = solver.stateKey === solverKey(before) ? solver.result : null;
    if (!r || r.options.length < 2 || r.rounds < 60) {
      t.last = r && r.options.length < 2 ? null : { verdict: 'pending' };
      return;
    }
    const best = r.options[0];
    const chosen = r.options.find((o) => window.TartarusSolver.sameAction(o.action, move));
    if (!chosen) {
      t.last = null;
      return;
    }
    const loss = Math.max(0, best.mean - chosen.mean);
    const verdict = window.TartarusSolver.sameAction(chosen.action, best.action) ? 'best' : loss <= Math.max(1.96 * chosen.gapSe, SWITCH_MIN) ? 'close' : 'costly';
    t.moves += 1;
    if (verdict === 'costly') t.lost += loss;
    else t.good += 1;
    t.last = { verdict, loss, chosen: chosen.label, best: best.label, chosenOpt: chosen, bestOpt: best };
  }

  // An option's expected Rainbows, with its 95% margin.
  function fmtOption(o) {
    return `${o.mean.toFixed(2)}${o.n > 1 ? ` ±${(1.96 * o.se).toFixed(2)}` : ''}`;
  }

  function renderGrade(st) {
    const box = $('trainer-grade');
    const t = ui.trainer && ui.trainer.seed === st.seed ? ui.trainer : null;
    box.hidden = !t || (!t.last && !t.moves);
    if (box.hidden) return;
    let html = '';
    const last = t.last;
    if (last && last.verdict === 'pending') {
      html += '<p class="trainer-eyebrow">你的上一步</p><p class="trainer-verdict">未評分：教練當時還在檢驗那個局面。</p>';
    } else if (last) {
      const title = last.verdict === 'best' ? '最佳動作 ✓' : last.verdict === 'close' ? '接近最佳 ✓' : `損失約 ${last.loss.toFixed(2)} 隻綺彩`;
      const detail = last.verdict === 'best'
        ? `${esc(last.chosen)}：期望值 ${esc(fmtOption(last.chosenOpt))}。`
        : `你選了${esc(last.chosen)}（${esc(fmtOption(last.chosenOpt))}）。教練建議${esc(last.best)}（${esc(fmtOption(last.bestOpt))}）。${last.verdict === 'close' ? '差距在誤差範圍內。' : ''}`;
      html += `<p class="trainer-eyebrow">你的上一步</p><p class="trainer-verdict is-${last.verdict}">${esc(title)}</p><p class="trainer-detail">${detail}</p>`;
    }
    if (t.moves) {
      const given = t.lost > 0.005 ? `，期望值約損失 ${t.lost.toFixed(2)} 隻綺彩` : '';
      html += `<p class="trainer-session">本局：${T.plural(t.moves, '步已評分的動作')}中有 ${t.good} 步是最佳或接近最佳${given}。</p>`;
    }
    setHTML(box, html);
  }

  // Updates a list in place: rows are kept by key, so a button under the
  // pointer survives the many refreshes of a live check.
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

  function renderSolver() {
    const st = ui.state;
    if (!ui.prefs.advisor || !solverFits(st)) return;
    const S = window.TartarusSolver;
    const r = liveResult(st);
    const options = r ? r.options : [];

    // The recommendation, then the lesson from training for this decision.
    // The box and its button stay put; only their contents change.
    const rec = recommendation(st);
    const pickBox = $('trainer-pick');
    if (rec) {
      pickBox.hidden = false;
      const source = rec.live ? `每個選項已模擬 ${rec.rounds.toLocaleString()} 次` : '訓練得出的即時選擇 · 檢驗中…';
      // The move and its button come first, so the button holds still while
      // the live check's numbers below it change.
      setHTML($('trainer-pick-head'), `<p class="trainer-eyebrow">建議動作</p><p class="trainer-move">${esc(rec.label)}</p>`);
      setHTML($('trainer-pick-body'), `<p class="trainer-source">${esc(source)}</p>${rec.why ? `<p class="trainer-why">${esc(rec.why)}</p>` : ''}<p class="trainer-lesson">${esc(lessonFor(st, rec.action))}</p>`);
    } else {
      pickBox.hidden = true;
    }
    renderGrade(st);

    // The live check: every option with its expected result.
    const status = $('solver-status');
    if (!r) status.textContent = '即時檢驗：啟動中…';
    else if (options.length <= 1) status.textContent = options.length ? '這裡只有一個動作。' : '目前沒有需要決定的事。';
    else status.textContent = r.done ? `即時檢驗：每個選項模擬 ${r.rounds.toLocaleString()} 次` : `即時檢驗：目前每個選項已模擬 ${r.rounds.toLocaleString()} 次…`;
    const top = options[0];
    const second = options[1];
    const max = Math.max(0.01, ...options.map((o) => o.mean));
    const close = top && second && top.mean - second.mean < Math.max(1.96 * second.gapSe, SWITCH_MIN);
    const shown = options.length > 1 ? options : [];
    syncRows(
      $('solver-list'),
      shown,
      (o) => actionKey(o.action),
      () => {
        const li = document.createElement('li');
        li.className = 'solver-row';
        li.innerHTML = '<span class="solver-label"><span class="solver-text"></span><span class="solver-tag" title="訓練出的策略不經模擬就會選這個動作。" hidden>策略</span></span><span class="solver-value" title="本局結束時預期收容的綺彩數，附 95% 誤差範圍"></span><span class="solver-meter"><span></span></span><span class="solver-sub" hidden></span>';
        li.btn = makeButton('走這步', () => playSolverMove(li.option && li.option.action));
        li.appendChild(li.btn);
        return li;
      },
      (li, o) => {
        li.option = o;
        const chosen = rec ? S.sameAction(o.action, rec.action) : o === top;
        li.classList.toggle('is-best', chosen);
        li.querySelector('.solver-text').textContent = o.label;
        li.querySelector('.solver-tag').hidden = !o.policy;
        li.querySelector('.solver-value').textContent = fmtOption(o);
        li.querySelector('.solver-meter span').style.width = `${Math.max(2, (100 * o.mean) / max).toFixed(1)}%`;
        // A devour also shows its exact chain odds.
        const sub = li.querySelector('.solver-sub');
        let subText = '';
        if (o.action.type === 'devour') {
          const odds = S.chainOdds(st, st.position, o.action.to);
          subText = `連鎖：平均 ${odds.bites.toFixed(1)} 口，${(100 * odds.rainbow).toFixed(0)}% 達到綺彩`;
        }
        sub.hidden = !subText;
        sub.textContent = subText;
        li.btn.hidden = chosen || shown.length > 6;
      },
    );
    $('solver-note').textContent = shown.length < 2
      ? ''
      : close
        ? '前幾名的動作差距在誤差範圍內：選哪個都可以。'
        : '每個選項都從這裡開始模擬，看不到的部分全部重新隨機，之後的每個選擇都由訓練出的策略決定。分數是本局結束時收容的綺彩數。';
  }

  // Marks the recommended move on the board and the action bar.
  function renderHints() {
    const st = ui.state;
    if (!st) return;
    const rec = recommendation(st);
    const a = rec ? rec.action : null;
    const cell = a && a.type === 'patrol' ? a.cell : a && (a.type === 'devour' || a.type === 'chain') ? a.to : null;
    cellEls.forEach((el, n) => el.btn.classList.toggle('is-hint', n === cell));
    for (const card of document.querySelectorAll('#dest-cards [data-dest]')) card.classList.toggle('is-hint', Number(card.dataset.dest) === cell);
    $('btn-swap').classList.toggle('is-hint', !!a && a.type === 'swap');
    $('btn-hunt').classList.toggle('is-hint', !!a && a.type === 'hunt');
    $('btn-end').classList.toggle('is-hint', !!a && a.type === 'end');
  }

  function renderAdvisor() {
    const panel = $('panel-advisor');
    panel.hidden = !ui.prefs.advisor;
    $('btn-advisor').setAttribute('aria-pressed', String(ui.prefs.advisor));
    if (!ui.prefs.advisor) {
      renderHints();
      return;
    }
    const st = ui.state;
    const fits = solverFits(st);
    $('solver-box').hidden = !fits;
    $('advisor-list').hidden = fits;
    if (fits) {
      startSolver();
      renderSolver();
      renderHints();
      return;
    }
    renderHints();
    const t = ui.trainer && ui.trainer.seed === st.seed && ui.trainer.moves ? ui.trainer : null;
    $('advisor-list').innerHTML = `<li class="tip"><span>本局已結束。打開交接名冊來檢討。${t ? `你在 ${T.plural(t.moves, '步已評分的動作')}中有 ${t.good} 步是最佳或接近最佳。` : ''}</span></li>`;
  }

  function render() {
    if (!ui.state || ui.screen !== 'game') return;
    renderTop();
    renderBoard();
    renderDestBar();
    renderRecap();
    renderDecision();
    renderActions();
    renderLog();
    renderGoal();
    renderAdvisor();
    renderVault();
    renderTools();
    $('screen-game').classList.toggle('is-immersive', !!ui.prefs.immersive);
    $('btn-sound').setAttribute('aria-pressed', String(ui.prefs.sound));
    $('btn-sound').textContent = ui.prefs.sound ? '音效：開' : '音效：關';
  }

  // ---------- Screens and runs ----------

  function showScreen(name) {
    ui.screen = name === 'game' && ui.state ? 'game' : 'title';
    $('screen-title').hidden = ui.screen !== 'title';
    $('screen-game').hidden = ui.screen !== 'game';
    if (ui.screen === 'title') renderTitle();
    else render();
  }

  function renderTitle() {
    const st = ui.state;
    $('btn-continue').hidden = !st;
    if (st) $('continue-meta').textContent = st.phase === 'ended' ? `${modeName(st)} · 已結束` : `${modeName(st)} · 第 ${st.day}/${st.maxDays} 天`;
    $('btn-title-sound').textContent = `音效：${ui.prefs.sound ? '開' : '關'}`;
  }

  // Dialogs that belong to one run close whenever the run is replaced.
  function closeRunDialogs() {
    for (const id of ['dlg-choice', 'dlg-results']) closeDialog(id);
  }

  function startRun(opts) {
    ui.state = T.newGame(Object.assign({ params: ui.labParams }, opts));
    ui.trainer = null;
    ui.history = [];
    ui.selected = null;
    ui.pending = null;
    closeRunDialogs();
    persist();
    showScreen('game');
    Sound.play('open');
  }

  function routeFromTitle(route) {
    const unfinished = ui.state && ui.state.phase !== 'ended';
    if (route === 'drill' && !unfinished) startRun({ scenario: 'empty' });
    else if (route === 'drill') openNewRun({ scenario: 'empty' });
    else openNewRun({ scenario: 'events' });
  }

  function openNewRun(preset) {
    const p = preset || {};
    const scenario = p.scenario || (ui.state && ui.state.scenario) || 'empty';
    $('scenario-options').innerHTML = Object.entries(T.SCENARIOS)
      .map(([key, s]) => `<label class="option"><input type="radio" name="scenario" value="${key}"${key === scenario ? ' checked' : ''}><strong>${esc(s.name)}</strong><small>${esc(s.text)}</small></label>`)
      .join('');
    $('new-seed').value = T.randomSeed();
    $('new-replace').hidden = !(ui.state && ui.state.phase !== 'ended');
    openDialog('dlg-new');
  }

  // ---------- Dialogs ----------

  const onOpen = {
    'dlg-run': fillRunDialog,
    'dlg-prefs': fillPrefs,
    'dlg-lab': fillLab,
  };

  function openDialog(id) {
    const d = $(id);
    if (onOpen[id]) onOpen[id]();
    if (d.open) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }

  function closeDialog(id) {
    const d = $(id);
    if (!d.open) return;
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
  }

  function fillRunDialog() {
    const st = ui.state;
    const runButtons = ['btn-run-undo', 'btn-run-export', 'btn-run-end'];
    if (!st) {
      $('run-facts').innerHTML = facts([['本局', '還沒有開始', true]]);
      $('run-inmates').innerHTML = '<li>請從標題畫面開始一局。</li>';
      runButtons.forEach((id) => ($(id).disabled = true));
      return;
    }
    $('run-facts').innerHTML = facts([
      ['模式', modeName(st), true],
      ['種子', st.seed, true],
      ['天數', `${st.day} / ${st.maxDays}`],
      ['典獄長位置', L(st.position)],
      ['綺彩', st.vault.length],
      ['可復原步數', ui.history.length],
    ]);
    const cells = st.cells.filter((c) => !c.sealed && c.inmate).sort((a, b) => b.inmate.tier - a.inmate.tier || a.n - b.n);
    $('run-inmates').innerHTML = cells.length
      ? cells.map((c) => `<li class="t${c.inmate.tier}"><b>${T.tierName(c.inmate.tier)}</b> ${T.beastName(c.inmate.beast)} · ${L(c.n)} 號牢房${c.ivory ? ' · 象牙' : ''}</li>`).join('')
      : '<li>監區裡沒有囚犯。</li>';
    $('btn-run-undo').disabled = !ui.history.length;
    $('btn-run-export').disabled = false;
    $('btn-run-end').disabled = st.phase === 'ended';
    $('btn-run-end').textContent = '立即結束本局';
    ui.endArmed = 0;
  }

  function fillPrefs() {
    $('pref-advisor').checked = !!ui.prefs.advisor;
    $('pref-quick').checked = !!ui.prefs.quick;
    $('pref-motion').checked = !!ui.prefs.motion;
    $('pref-immersive').checked = !!ui.prefs.immersive;
    $('pref-sound').checked = !!ui.prefs.sound;
    $('pref-volume').value = ui.prefs.volume;
  }

  function setPref(key, value) {
    ui.prefs[key] = value;
    store.set(KEYS.prefs, ui.prefs);
    applyPrefs();
  }

  function applyPrefs() {
    document.documentElement.classList.toggle('no-motion', !ui.prefs.motion);
    Sound.setEnabled(ui.prefs.sound);
    Sound.setVolume(ui.prefs.volume / 100);
    renderTitle();
    render();
  }

  function openExport() {
    if (!ui.state) {
      toast('還沒有可以匯出的一局。');
      return;
    }
    $('save-title').textContent = '匯出存檔';
    $('save-export').hidden = false;
    $('save-import').hidden = true;
    $('save-out').value = JSON.stringify({ app: 'tartarus-sim', v: T.VERSION, savedAt: new Date().toISOString(), state: ui.state });
    $('btn-save-download').hidden = EMBEDDED;
    $('btn-save-copy').textContent = '複製存檔';
    openDialog('dlg-save');
  }

  function openImport() {
    $('save-title').textContent = '匯入存檔';
    $('save-export').hidden = true;
    $('save-import').hidden = false;
    $('save-in').value = '';
    $('save-file').value = '';
    $('save-error').hidden = true;
    openDialog('dlg-save');
  }

  function copySave() {
    const area = $('save-out');
    const done = () => {
      $('btn-save-copy').textContent = '已複製';
      setTimeout(() => ($('btn-save-copy').textContent = '複製存檔'), 2000);
    };
    const fallback = () => {
      area.focus();
      area.select();
      $('btn-save-copy').textContent = '請按 Ctrl+C 複製';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(area.value).then(done, fallback);
    else fallback();
  }

  function downloadSave() {
    const st = ui.state;
    const blob = new Blob([$('save-out').value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tartarus-${st.seed.replace(/[^A-Z0-9-]/gi, '')}-day${st.day}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function loadSave() {
    const text = $('save-in').value.trim();
    const error = $('save-error');
    if (!text) {
      error.textContent = '請先選擇存檔檔案，或貼上存檔文字。';
      error.hidden = false;
      return;
    }
    try {
      ui.state = T.deserialize(text);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      return;
    }
    ui.history = [];
    ui.selected = null;
    ui.pending = null;
    closeRunDialogs();
    persist();
    closeDialog('dlg-save');
    showScreen('game');
    toast(`已載入${modeName(ui.state)}，第 ${ui.state.day} 天。`, true);
    followUp(0);
  }

  // ---------- Choices and results ----------

  function openChoice() {
    const st = ui.state;
    const choice = st && st.pending[0];
    if (!choice) {
      closeDialog('dlg-choice');
      return;
    }
    const goal = T.OBJECTIVES[st.objective.id].name;
    const copy = {
      tool: choice.start
        ? ['開局刑具', '選擇一件刑具', '本局從這三件刑具中選一件開始，整局都有效。']
        : ['目標達成', '選擇一件刑具', `「${goal}」已完成。選一件刑具，用到本局結束。`],
      gift: ['典獄長的珍藏', '選擇一件珍品', '有一隻綺彩進了收容區。選一件珍藏，立即生效。'],
    }[choice.kind];
    $('choice-eyebrow').textContent = copy[0];
    $('choice-title').textContent = copy[1];
    $('choice-note').textContent = copy[2];
    $('choice-options').innerHTML = choice.options
      .map((id) => `<div class="refit-card"><strong>${esc(T.toolName(id))}</strong><p>${esc(T.toolText(id))}</p><button type="button" class="btn btn-primary" data-take="${id}">拿取</button></div>`)
      .join('');
    openDialog('dlg-choice');
  }

  function openResults() {
    const st = ui.state;
    if (!st || !st.result) return;
    const r = st.result;
    $('results-eyebrow').textContent = `${modeName(st)} · 種子 ${st.seed}`;
    $('results-facts').innerHTML = facts([
      ['綺彩', r.roster.byTier[T.RAINBOW]],
      [st.params.rewards ? '珍藏' : '秘藏領取', r.cache],
      ['最高稀有度', T.tierName(r.best), true],
      ['囚犯', r.roster.rows.length],
      ['巡視', r.stats.patrols],
      ['吞噬', r.stats.devours],
      ['替換', r.stats.swaps],
      ['處刑效率', r.stats.executions],
    ]);
    let roster = '';
    for (let t = T.RAINBOW; t >= 0; t--) {
      const rows = r.roster.rows.filter((x) => x.tier === t);
      if (!rows.length) continue;
      roster += `<div class="roster-row t${t}"><span class="tier-name">${T.tierName(t)} ×${rows.length}</span><span class="names">${rows.map((x) => `${esc(T.beastName(x.beast))} <small>（${esc(x.where)}）</small>`).join('、')}</span></div>`;
    }
    $('results-roster').innerHTML = roster || '<p class="roster-empty">沒有剩下可以交接的囚犯。</p>';
    openDialog('dlg-results');
  }

  function summaryText() {
    const st = ui.state;
    const r = st.result;
    const lines = [`塔羅斯模擬器 · ${modeName(st)} · 種子 ${st.seed}`, `第 ${r.day}/${st.maxDays} 天${r.early ? '（提前結束）' : ''}`];
    lines.push(`綺彩：${st.cache} · 最高：${T.tierName(r.best)}`);
    for (let t = T.RAINBOW; t >= 0; t--) {
      const rows = r.roster.rows.filter((x) => x.tier === t);
      if (rows.length) lines.push(`${T.tierName(t)} ×${rows.length}：${rows.map((x) => T.beastName(x.beast)).join('、')}`);
    }
    lines.push(`動作：巡視 ${r.stats.patrols} 次、吞噬 ${r.stats.devours} 次、替換 ${r.stats.swaps} 次、處刑效率 ${r.stats.executions} 次`);
    return lines.join('\n');
  }

  function copySummary() {
    const button = $('btn-results-copy');
    const done = () => {
      button.textContent = '已複製';
      setTimeout(() => (button.textContent = '複製摘要'), 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(summaryText()).then(done, () => toast('這裡無法複製。請改用「匯出存檔」。'));
    else toast('這裡無法複製。請改用「匯出存檔」。');
  }

  // ---------- Lab ----------

  function fillLab() {
    const st = ui.state;
    const locked = !st || st.phase === 'ended';
    const note = $('lab-locked');
    note.hidden = !locked;
    note.textContent = st ? '本局已結束。開始新的練習才能編輯場景。' : '開始一個練習才能使用場景編輯器。';
    $('lab-editor').hidden = locked;
    if (!locked) {
      renderLabGrid();
      fillLabForm();
      renderLabTools();
    }
    renderParamsForm();
    selectLabTab(ui.labTab);
  }

  function selectLabTab(tab) {
    ui.labTab = tab;
    const scene = tab === 'scene';
    $('tab-scene').setAttribute('aria-selected', String(scene));
    $('tab-params').setAttribute('aria-selected', String(!scene));
    $('lab-scene').hidden = !scene;
    $('lab-params').hidden = scene;
    $('btn-params-reset').hidden = scene;
    $('btn-params-save').hidden = scene;
  }

  function renderLabGrid() {
    const st = ui.state;
    $('lab-grid').replaceChildren(
      ...st.cells.map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        const open = !c.sealed && c.inmate;
        const office = c.n === T.OFFICE;
        b.className = 'mini' + (open ? ` t${c.inmate.tier}` : '') + (office ? ' is-office' : '') + (st.position === c.n ? ' is-warden' : '');
        b.style.gridRow = RING[c.n][0];
        b.style.gridColumn = RING[c.n][1];
        b.setAttribute('aria-pressed', String(c.n === ui.labCell));
        const mark = office ? '·' : c.nest ? 'N' : open ? T.beastName(c.inmate.beast)[0] : c.sealed ? '#' : '·';
        const sub = office ? '審訊室' : c.nest ? '鼠巢' : open ? T.tierName(c.inmate.tier).slice(0, 4) : c.sealed ? (c.event ? '事變' : '未開') : '空';
        b.innerHTML = `<b>${mark}</b>${L(c.n)}<br>${sub}`;
        b.setAttribute('aria-label', office ? '01 號牢房，審訊室' : `編輯 ${L(c.n)} 號牢房`);
        b.addEventListener('click', () => {
          ui.labCell = c.n;
          renderLabGrid();
          fillLabForm();
        });
        return b;
      }),
    );
  }

  function fillLabForm() {
    const st = ui.state;
    const c = st.cells[ui.labCell];
    // The office takes no contents; the warden can still be moved there.
    const office = c.n === T.OFFICE;
    $('lab-cell-label').textContent = `${L(c.n)} 號牢房${office ? ' · 審訊室' : ''}${st.position === c.n ? ' · 典獄長在此' : ''}`;
    $('lab-contents').hidden = office;
    $('lab-office-note').hidden = !office;
    $('btn-lab-apply').hidden = office;
    $('btn-lab-apply').textContent = `套用到 ${L(c.n)} 號牢房`;
    // A sealed occupant stays hidden here too, so the editor never spoils a door.
    let kind = 'open';
    if (c.nest) kind = 'nest';
    else if (c.sealed) kind = 'unknown';
    else if (!c.inmate) kind = 'empty';
    $('lab-kind').value = kind;
    const shown = !c.sealed && c.inmate;
    $('lab-beast').value = shown ? c.inmate.beast : 'mammoth';
    $('lab-tier').value = String(shown ? c.inmate.tier : 0);
    $('lab-ivory').checked = !!c.ivory;
    $('lab-scratch').checked = false;
    $('lab-event').value = c.event || 'none';
    syncLabKind();
    const lion = shown && c.inmate.beast === 'lion' && !T.linkOf(st, c.inmate.id);
    $('lab-prey-wrap').hidden = !lion;
    if (lion) {
      const options = st.cells.filter((o) => !o.sealed && o.inmate && T.canEat(st, c.inmate, o.inmate) && !T.linkOf(st, o.inmate.id));
      $('lab-prey').innerHTML = options.length ? options.map((o) => `<option value="${o.n}">${L(o.n)} 號牢房：${T.describe(o.inmate)}</option>`).join('') : '<option value="">監區中沒有同稀有度的獵物</option>';
      $('btn-lab-prey').disabled = !options.length;
    }
  }

  function syncLabKind() {
    const kind = $('lab-kind').value;
    $('lab-inmate-fields').hidden = !(kind === 'open' || kind === 'hidden');
    $('lab-ivory-wrap').hidden = kind !== 'open';
    $('lab-scratch-wrap').hidden = kind !== 'hidden';
    $('lab-event-wrap').hidden = !(kind === 'hidden' || kind === 'unknown');
  }

  function renderLabTools() {
    const st = ui.state;
    const free = T.TOOL_IDS.filter((id) => !st.tools.includes(id));
    $('lab-tool').innerHTML = free.map((id) => `<option value="${id}">${esc(T.toolName(id))}</option>`).join('') || '<option value="">所有刑具都已加入</option>';
    $('btn-lab-tool').disabled = !free.length;
    $('lab-tools').innerHTML = st.tools.map((id) => `<li>${esc(T.toolName(id))}<button type="button" data-remove-tool="${id}" aria-label="移除${esc(T.toolName(id))}">×</button></li>`).join('');
  }

  function refreshLab() {
    renderLabGrid();
    fillLabForm();
    renderLabTools();
  }

  function applyLabCell() {
    const spec = {
      kind: $('lab-kind').value,
      beast: $('lab-beast').value,
      tier: Number($('lab-tier').value),
      ivory: $('lab-ivory').checked,
      scratch: $('lab-scratch').checked,
      event: $('lab-event').value,
    };
    if (run((s) => T.editCell(s, ui.labCell, spec), { select: null })) refreshLab();
  }

  function paramField(f, value) {
    const id = `param-${f.key}`;
    const label = `<span>${esc(f.label)}</span>`;
    if (f.type === 'int') return `<label class="param" for="${id}">${label}<input type="number" id="${id}" min="${f.min}" max="${f.max}" step="1" value="${value}"></label>`;
    if (f.type === 'bool') return `<label class="param" for="${id}">${label}<input type="checkbox" id="${id}"${value ? ' checked' : ''}></label>`;
    if (f.type === 'tier') {
      return `<label class="param" for="${id}">${label}<select id="${id}">${T.TIERS.slice(0, 5).map((t, i) => `<option value="${i}"${i === value ? ' selected' : ''}>${T.tierName(i)}</option>`).join('')}</select></label>`;
    }
    return `<div class="param">${label}<div class="list">${f.names
      .map((name, i) => `<label for="${id}-${i}">${esc(name)}<input type="number" id="${id}-${i}" min="0" max="1000" step="0.5" value="${value[i]}"></label>`)
      .join('')}</div></div>`;
  }

  function renderParamsForm() {
    const groups = new Map();
    for (const f of T.PARAM_FIELDS) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    $('form-params').innerHTML = [...groups]
      .map(([name, fields]) => `<fieldset class="param-group"><legend>${esc(name)}</legend>${fields.map((f) => paramField(f, ui.labParams[f.key])).join('')}</fieldset>`)
      .join('');
  }

  function readParamsForm() {
    const out = {};
    for (const f of T.PARAM_FIELDS) {
      const id = `param-${f.key}`;
      if (f.type === 'bool') out[f.key] = $(id).checked;
      else if (f.type === 'list') out[f.key] = f.names.map((_, i) => Number($(`${id}-${i}`).value));
      else out[f.key] = Number($(id).value);
    }
    return T.normalizeParams(out);
  }

  // ---------- Fullscreen ----------

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      toast('這裡無法使用全螢幕。');
    }
  }

  // ---------- Wiring ----------

  function bind() {
    document.querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', () => routeFromTitle(b.dataset.route)));
    $('btn-continue').addEventListener('click', () => {
      showScreen('game');
      followUp(0);
    });
    $('btn-title-import').addEventListener('click', openImport);
    $('btn-title-sound').addEventListener('click', () => {
      setPref('sound', !ui.prefs.sound);
      if (ui.prefs.sound) Sound.play('tool');
    });

    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-open]');
      if (opener) {
        const parent = opener.closest('dialog');
        if (parent) parent.close();
        openDialog(opener.dataset.open);
        return;
      }
      const closer = e.target.closest('[data-close]');
      if (closer) {
        const d = closer.closest('dialog');
        if (d) d.close();
      }
    });

    document.querySelectorAll('dialog').forEach((d) => {
      d.addEventListener('click', (e) => {
        if (e.target === d) d.close();
      });
    });

    $('btn-home').addEventListener('click', () => showScreen('title'));
    $('btn-menu').addEventListener('click', () => openDialog('dlg-menu'));
    $('btn-full').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      $('btn-full').textContent = document.fullscreenElement ? '離開全螢幕' : '全螢幕';
    });
    $('btn-advisor').addEventListener('click', () => setPref('advisor', !ui.prefs.advisor));
    $('btn-sound').addEventListener('click', () => {
      setPref('sound', !ui.prefs.sound);
      if (ui.prefs.sound) Sound.play('tool');
    });

    // A card click chooses that door; clicking the chosen card again goes there.
    $('dest-cards').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dest]');
      if (!b || b.disabled) return;
      const n = Number(b.dataset.dest);
      if (ui.pending && ui.pending.kind === 'patrol' && ui.pending.cell === n) run((s) => T.patrol(s, n), { select: n });
      else askPatrol(n);
    });
    $('dest-cards').addEventListener('mouseover', (e) => {
      const b = e.target.closest('[data-dest]');
      const n = b ? Number(b.dataset.dest) : null;
      if (n !== null && ui.hover !== n && ui.state) {
        ui.hover = n;
        renderBoard();
      }
    });
    $('dest-cards').addEventListener('mouseleave', () => {
      if (ui.hover !== null && ui.state) {
        ui.hover = null;
        renderBoard();
      }
    });
    $('btn-swap').addEventListener('click', () => askSwap(ui.state && ui.state.position));
    $('btn-hunt').addEventListener('click', () => {
      if (!ui.state || !T.canHuntNow || !T.canHuntNow(ui.state)) return;
      ui.pending = { kind: 'hunt' };
      render();
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-end').addEventListener('click', askEndDay);

    $('btn-menu-new').addEventListener('click', () => {
      closeDialog('dlg-menu');
      openNewRun();
    });
    $('btn-menu-title').addEventListener('click', () => {
      closeDialog('dlg-menu');
      showScreen('title');
    });

    $('btn-reseed').addEventListener('click', () => ($('new-seed').value = T.randomSeed()));
    $('form-new').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      closeDialog('dlg-new');
      startRun({ scenario: data.get('scenario'), seed: $('new-seed').value });
    });

    $('btn-run-undo').addEventListener('click', () => {
      undo();
      fillRunDialog();
    });
    $('btn-run-export').addEventListener('click', () => {
      closeDialog('dlg-run');
      openExport();
    });
    $('btn-run-import').addEventListener('click', () => {
      closeDialog('dlg-run');
      openImport();
    });
    $('btn-run-end').addEventListener('click', () => {
      const b = $('btn-run-end');
      if (Date.now() - ui.endArmed > 4000) {
        ui.endArmed = Date.now();
        b.textContent = '再點一次結束本局';
        setTimeout(() => {
          if (Date.now() - ui.endArmed >= 4000) b.textContent = '立即結束本局';
        }, 4100);
        return;
      }
      ui.endArmed = 0;
      closeDialog('dlg-run');
      run((s) => T.endRun(s), { select: null });
    });

    $('btn-save-copy').addEventListener('click', copySave);
    $('btn-save-download').addEventListener('click', downloadSave);
    $('btn-save-load').addEventListener('click', loadSave);
    $('save-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('save-in').value = String(reader.result || '');
        $('save-error').hidden = true;
      };
      reader.onerror = () => {
        $('save-error').textContent = '無法讀取那個檔案。';
        $('save-error').hidden = false;
      };
      reader.readAsText(file);
    });

    const prefInputs = { 'pref-advisor': 'advisor', 'pref-quick': 'quick', 'pref-motion': 'motion', 'pref-immersive': 'immersive', 'pref-sound': 'sound' };
    for (const [id, key] of Object.entries(prefInputs)) $(id).addEventListener('change', (e) => setPref(key, e.target.checked));
    $('pref-volume').addEventListener('input', (e) => setPref('volume', Number(e.target.value)));
    $('btn-sound-test').addEventListener('click', () => {
      if (!ui.prefs.sound) setPref('sound', true);
      $('pref-sound').checked = true;
      Sound.play('rainbow');
    });

    $('form-params').addEventListener('submit', (e) => e.preventDefault());
    $('tab-scene').addEventListener('click', () => selectLabTab('scene'));
    $('tab-params').addEventListener('click', () => selectLabTab('params'));
    $('lab-beast').innerHTML = T.BEASTS.map((b) => `<option value="${b}">${T.beastName(b)}</option>`).join('');
    $('lab-tier').innerHTML = T.TIERS.slice(0, 5).map((t, i) => `<option value="${i}">${T.tierName(i)}</option>`).join('');
    $('lab-kind').addEventListener('change', syncLabKind);
    $('btn-lab-apply').addEventListener('click', applyLabCell);
    $('btn-lab-warden').addEventListener('click', () => {
      if (run((s) => T.moveWarden(s, ui.labCell))) refreshLab();
    });
    $('btn-lab-prey').addEventListener('click', () => {
      const target = Number($('lab-prey').value);
      if (Number.isInteger(target) && run((s) => T.markPrey(s, ui.labCell, target))) refreshLab();
    });
    $('btn-lab-tool').addEventListener('click', () => {
      const id = $('lab-tool').value;
      if (id && run((s) => T.addTool(s, id))) renderLabTools();
    });
    $('lab-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove-tool]');
      if (b && run((s) => T.removeTool(s, b.dataset.removeTool))) renderLabTools();
    });
    $('btn-params-reset').addEventListener('click', () => {
      ui.labParams = T.normalizeParams(null);
      renderParamsForm();
    });
    $('btn-params-save').addEventListener('click', () => {
      ui.labParams = readParamsForm();
      store.set(KEYS.params, ui.labParams);
      closeDialog('dlg-lab');
      startRun({ scenario: ui.state ? ui.state.scenario : 'empty' });
      toast('練習數值已儲存，已開始新的練習。', true);
    });

    $('choice-options').addEventListener('click', (e) => {
      const b = e.target.closest('[data-take]');
      if (!b) return;
      run((s) => T.choose(s, b.dataset.take));
      // Shows the next waiting choice, or closes when none is left.
      openChoice();
    });

    $('btn-trainer-play').addEventListener('click', () => {
      const rec = ui.state && recommendation(ui.state);
      if (rec) playSolverMove(rec.action);
    });

    $('btn-results-copy').addEventListener('click', copySummary);
    $('btn-results-new').addEventListener('click', () => {
      closeDialog('dlg-results');
      openNewRun();
    });

    document.addEventListener('keydown', (e) => {
      if (ui.screen !== 'game' || document.querySelector('dialog[open]')) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'Escape') {
        cancel();
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        const primary = $('decision-actions').querySelector('.btn-primary');
        if (primary && $('decision').classList.contains('is-pending')) {
          e.preventDefault();
          primary.click();
        }
      }
    });
  }

  function fillHandbookTools() {
    const tools = T.TOOL_IDS.map((id) => `<dt>${esc(T.toolName(id))}</dt><dd>${esc(T.toolText(id))}</dd>`);
    const gifts = T.GIFT_IDS.map((id) => `<dt class="m-gift">${esc(T.toolName(id))}</dt><dd>珍藏。${esc(T.toolText(id))}</dd>`);
    $('hb-tools').innerHTML = [...tools, ...gifts].join('');
  }

  function boot(hotData) {
    const data = hotData || {};
    const toastEl = $('toast');
    if (typeof toastEl.showPopover !== 'function') toastEl.hidden = true;
    buildBoard();
    renderSample();
    fillHandbookTools();
    bind();
    const saved = data.save || store.get(KEYS.save);
    let lost = '';
    if (saved) {
      try {
        ui.state = T.deserialize(saved);
        ui.history = Array.isArray(data.history) ? data.history.filter((h) => typeof h === 'string').slice(-HISTORY_LIMIT) : [];
      } catch (e) {
        ui.state = null;
        // A contract challenge saved before that mode was removed can't load
        // any more, so the engine's message says why the run is gone.
        const raw = saved.app === 'tartarus-sim' ? saved.state : saved;
        if (raw && raw.mode === 'challenge') lost = e.message;
      }
    }
    applyPrefs();
    showScreen(data.screen === 'game' ? 'game' : 'title');
    if (lost) toast(lost);
    requestAnimationFrame(() => $('board').classList.add('is-live'));
  }

  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.snapshot === 'function') {
    hot.snapshot(() => ({
      save: ui.state ? { app: 'tartarus-sim', v: T.VERSION, state: ui.state } : null,
      history: ui.history,
      screen: ui.screen,
    }));
  }
  if (hot && typeof hot.ready === 'function') hot.ready(boot);
  else boot((hot && hot.data) || {});
})();
