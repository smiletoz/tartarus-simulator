/* Tartarus Simulator: the Frozen Canvas page.
 * Practice: random canvases, played with the trainer beside you.
 * My canvas: set up the canvas from your game (cells, paints in hand, the
 * objective, a brushstroke on offer), then ask what to play, or play it here
 * with the simulator's dice and fix what came out differently. */
(function () {
  'use strict';

  const C = window.TartarusCanvas;
  const S = window.TartarusCanvasSolver;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const L = (n) => C.cellLabel(n);
  const KEY = 'tartarus-sim:canvas:v1';
  const ROLLOUTS = 300;
  // Bumped when the practice values' defaults change: saved ones from before
  // are dropped, so everyone plays the current rules.
  const PARAMS_REV = 5;

  const store = {
    get() {
      try {
        return JSON.parse(localStorage.getItem(KEY) || 'null');
      } catch (e) {
        return null;
      }
    },
    set(v) {
      try {
        localStorage.setItem(KEY, JSON.stringify(v));
      } catch (e) {
        // Private windows can refuse; the page still works.
      }
    },
  };

  // ---------- State ----------

  const saved = store.get() || {};
  const current = saved.paramsRev === PARAMS_REV;
  let params = C.normalizeParams(current ? saved.params : null);
  let mode = saved.mode === 'mine' ? 'mine' : 'practice';
  const games = {
    practice: current && valid(saved.practice) ? saved.practice : C.newCanvas({ params }),
    mine: valid(saved.mine) ? saved.mine : emptyCanvas(),
  };
  if (!current) games.mine.params = C.normalizeParams(params);
  const stats = Object.assign({ canvases: 0, chests: 0, lv7: 0, levels: 0, rainbows: 0, plain: 0, snow: 0, resets: 0 }, saved.stats || {});
  const undo = { practice: [], mine: [] };
  let setup = saved.setup !== false; // My canvas: setting up (true) or playing (false)
  let editWhat = 'board';
  let picked = -1; // inventory paint picked to place
  let selected = -1; // cell being edited
  let advice = null; // { key, result, job }

  function valid(st) {
    return st && st.v === C.VERSION && Array.isArray(st.cells) && st.cells.length === C.CELLS;
  }

  // A canvas with nothing on it, for setting up your own.
  function emptyCanvas() {
    const st = C.newCanvas({ seed: 'MINE', params });
    st.cells = Array.from({ length: C.CELLS }, () => ({ kind: 'blank', paint: null, anchor: false }));
    st.inventory = [];
    st.active = null;
    st.offer = null;
    st.phase = 'paint';
    st.log = [];
    return st;
  }

  const game = () => games[mode];
  const key = () => JSON.stringify([mode, game().cells, game().inventory, game().active, game().offer, game().phase, game().forced, game().refreshes]);

  function save() {
    store.set({ mode, params, paramsRev: PARAMS_REV, practice: games.practice, mine: games.mine, stats, setup });
  }

  function changed() {
    save();
    render();
  }

  function notice(text) {
    $('cv-notice').textContent = text;
  }

  // Plays a move, keeping an undo step.
  function act(action) {
    const st = game();
    const before = C.clone(st);
    const r = S.apply(st, action);
    if (!r.ok) {
      notice(r.reason);
      return false;
    }
    undo[mode].push(before);
    if (undo[mode].length > 60) undo[mode].shift();
    if (st.phase === 'done' && before.phase !== 'done' && mode === 'practice') record(st);
    if (action.type === 'reset' && mode === 'practice') stats.resets += 1;
    picked = -1;
    notice('');
    changed();
    return true;
  }

  function record(st) {
    stats.canvases += 1;
    stats.snow += st.snow;
    stats.rainbows += C.rainbows(st);
    if (!C.chests(st).length) stats.plain += 1;
    const lv = C.bestChest(st);
    if (lv) {
      stats.chests += 1;
      stats.levels += lv;
      if (lv >= C.MAX_LEVEL) stats.lv7 += 1;
    }
  }

  // ---------- Drawing ----------

  const CHEST_ART = '<svg class="cv-chest" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 14h22v13H5z" fill="#8a5a2b"/><path d="M5 14c0-7 22-7 22 0z" fill="#b5783a"/><path d="M5 14h22v2.5H5zM5 22h22v2H5z" fill="#e0b04a"/><rect x="14" y="16" width="4" height="5" rx="1" fill="#f6dc7a"/><circle cx="16" cy="18.5" r="0.9" fill="#3b2a12"/></svg>';
  const CRACK = '<svg class="cv-crack" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l6 2 2-5 3 6 4-3 3 4M9 11l-2 9M14 12l1 4 5 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  const BRUSH = '<svg class="cv-brush" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3l4 4-9 9-4-4z" fill="currentColor" opacity=".55"/><path d="M8 12l4 4c-1 3-4 5-8 5 0-4 1-7 4-9z" fill="currentColor"/></svg>';
  // Two letters per paint, so different paints read apart at a glance.
  const SHORT = {
    Ratlin: 'Ra', Dwarf: 'Dw', Agito: 'Ag', Pest: 'Pe', Dragonbone: 'Db', Aember: 'Ae', 'Test Subject': 'Ts', Gang: 'Ga', Ichi: 'Ic', 'Sand Monster': 'Sm', Eumbra: 'Eu', Einherjar: 'Ei', Ghost: 'Gh',
    Survival: 'Sv', 'God of Machines': 'Ma', 'God of Might': 'Mi', 'Goddess of Hunting': 'Hu', 'God of War': 'Wa', Season: 'Se',
    'Dark Surge': 'Ds', Blacksail: 'Bs', 'Cube of Rapacity': 'Cu', Aeterna: 'At', Twinightmare: 'Tn', 'Whispering Mist': 'Wm', 'Clockwork Ballet': 'Cb',
  };
  const short = (type) => SHORT[type] || type.slice(0, 2);

  function token(p, extra) {
    if (!p) return '';
    const chest = C.isChest(p);
    const shape = p.cls === 'monster' ? 'is-monster' : 'is-gameplay';
    const art = chest ? CHEST_ART : `<span class="cv-glyph">${esc(short(p.type))}</span>`;
    return `<span class="cv-token ${shape} lv${p.level}${chest ? ' is-chest' : ''}${extra || ''}" title="${esc(C.paintName(p))}"><span class="cv-token-face">${art}</span><span class="cv-lv">Lv${p.level}</span></span>`;
  }

  function cellHTML(st, n, marks) {
    const c = st.cells[n];
    let inner = '';
    if (c.kind === 'blocked') inner = '<span class="cv-ice" aria-hidden="true"></span>';
    else if (c.kind === 'void') inner = '<span class="cv-void" aria-hidden="true"></span>';
    else if (c.kind === 'broken') inner = CRACK;
    else if (c.paint) inner = token(c.paint);
    else inner = BRUSH;
    const bang = c.anchor ? `<span class="cv-bang${st.active && st.active.cell === n ? ' is-live' : ''}" aria-hidden="true">!</span>` : '';
    return `${inner}${bang}${marks.tag ? `<span class="cv-tag">${esc(marks.tag)}</span>` : ''}`;
  }

  function cellLabelText(st, n) {
    const c = st.cells[n];
    const where = `Cell ${L(n)}: `;
    if (c.kind === 'blocked') return `${where}ice (blocked)`;
    if (c.kind === 'void') return `${where}void${c.anchor ? ', with the objective’s Coloring Paint' : ''}`;
    if (c.kind === 'broken') return `${where}broken`;
    if (!c.paint) return `${where}blank${c.anchor ? ', the objective’s Coloring Paint' : ''}`;
    return `${where}${C.paintName(c.paint)}${c.anchor ? ', a Coloring Paint' : ''}`;
  }

  function render() {
    const st = game();
    document.querySelectorAll('.cv-modes [data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    renderBoard(st);
    renderPanel(st);
    renderEdit(st);
    renderAdvice();
    renderStats();
  }

  function renderBoard(st) {
    const board = $('cv-board');
    if (board.children.length !== C.CELLS) {
      board.innerHTML = Array.from({ length: C.CELLS }, (_, n) => `<button type="button" class="cv-cell" data-cell="${n}" role="gridcell"></button>`).join('');
    }
    const range = st.phase === 'paint' && st.active ? new Set(C.rangeCells(st.active.cell, st.active.range)) : new Set();
    const targets = st.phase === 'offer' && st.offer && st.offer.stage === 'place' ? new Set(C.placeTargets(st)) : new Set();
    const rec = advice && advice.key === key() && advice.result && advice.result.options[0] ? advice.result.options[0].action : null;
    const best = rec && (rec.type === 'place' || rec.type === 'coloring') ? rec.cell : -1;
    const editing = mode === 'mine' && setup;
    for (let n = 0; n < C.CELLS; n++) {
      const el = board.children[n];
      const c = st.cells[n];
      const cls = ['cv-cell', `is-${c.paint ? 'painted' : c.kind}`];
      if (range.has(n) && c.kind === 'blank' && !c.paint) cls.push('in-range');
      if (range.has(n) && c.paint && C.matches(c.paint, st.active.target)) cls.push('counts');
      if (targets.has(n)) cls.push('can-place');
      if (n === best) cls.push('is-best');
      if (editing && n === selected) cls.push('is-selected');
      el.className = cls.join(' ');
      const html = cellHTML(st, n, { tag: n === best ? 'Here' : '' });
      if (el.__html !== html) {
        el.innerHTML = html;
        el.__html = html;
      }
      el.setAttribute('aria-label', cellLabelText(st, n));
    }
    $('cv-hint').textContent = hintText(st);
    $('cv-count').textContent = `${C.filled(st)}/${C.fillable(st)} filled`;
  }

  function hintText(st) {
    if (mode === 'mine' && setup) return 'Setting up: click a cell to set what’s on it. Switch to Play when the canvas matches your game.';
    if (st.phase === 'done') {
      const lv = C.bestChest(st);
      const r = C.rainbows(st);
      const rb = `${r} rainbow paint${r === 1 ? '' : 's'}`;
      return lv ? `Canvas finished: the Treasure Chest ended at Lv${lv}${lv >= 7 ? ' (a Lv7 chest!)' : ''}, plus ${rb}.` : `Canvas finished with no Treasure Chest: ${rb}.`;
    }
    if (st.phase === 'offer') {
      const f = st.offer;
      return f.stage === 'direction' ? 'Objective met! Choose a brushstroke direction for the next Coloring Paint.' : f.stage === 'effect' ? 'Choose a brushstroke effect.' : 'Click a highlighted cell to place the Coloring Paint.';
    }
    return picked >= 0 ? `Click a blank cell for the ${C.paintName(st.inventory[picked]).toLowerCase()}.` : 'Pick a paint on the right, then a blank cell. Yellow cells are in the objective’s range.';
  }

  // Icons that old Coloring Paints raise when a paint with them is placed.
  function iconLine(st) {
    const icons = st.icons || [];
    return icons.length ? `<p class="cv-obj-room">Placing ${icons.map((i) => esc(i.type)).join(' or ')} paints raises them 1 level (an old Coloring Paint’s effect).</p>` : '';
  }

  // Blank cells left in range, and whether the objective can still be met.
  function roomLine(st, o) {
    const room = C.openInRange(st, o);
    const short = o.need - C.progress(st, o);
    if (C.failed(st)) return '<p class="cv-obj-room is-failed">Failed: its range is full. No new Coloring Paints come unless you force it.</p>';
    const text = `${room} blank cell${room === 1 ? '' : 's'} left in range.`;
    if (room < short) return `<p class="cv-obj-room is-failed">${text} It can’t be met now: it fails when its range fills, but forcing still works.</p>`;
    return `<p class="cv-obj-room">${text}</p>`;
  }

  function renderPanel(st) {
    // The objective, or the brushstroke on offer.
    const o = st.active;
    const offer = st.phase === 'offer' && st.offer;
    $('cv-objective').hidden = !!offer;
    $('cv-offer').hidden = !offer;
    if (!offer) {
      $('cv-objective').innerHTML = o
        ? `<p class="cv-obj-line"><span class="cv-obj-bang">!</span>${esc(C.objectiveText(o, C.progress(st, o)))}</p><p class="cv-obj-effect">${esc(C.effectText(o))}</p>${o.extras.length ? `<p class="cv-obj-stroke">Brushstroke: ${o.extras.map((id) => esc(C.EFFECTS[id].text)).join('; ')}</p>` : ''}${roomLine(st, o)}${iconLine(st)}`
        : `<p class="cv-obj-line">${st.phase === 'done' ? 'The canvas is finished.' : 'No objective right now.'}</p>`;
    } else {
      $('cv-offer').innerHTML = offerHTML(st);
    }
    // Paints in hand.
    const editing = mode === 'mine' && setup;
    $('cv-inventory').innerHTML = st.inventory.map((p, i) => `<button type="button" class="cv-inv${i === picked ? ' is-picked' : ''}" data-inv="${i}" title="${esc(C.paintName(p))}${editing ? ': click to remove' : ''}">${token(p)}</button>`).join('') || '<p class="field-note">No paints in hand.</p>';
    const chestHand = st.inventory.some(C.isChest);
    $('cv-inv-note').textContent = `${st.inventory.length} paint${st.inventory.length === 1 ? '' : 's'}${chestHand ? ' · a Treasure Chest!' : ''}`;
    // Buttons.
    const P = st.params;
    const left = P.forcedMax - st.forced;
    const cost = P.forcedCost[Math.min(st.forced, P.forcedCost.length - 1)];
    $('cv-force').textContent = `Forced Color Mixing (${left}/${P.forcedMax}) · ${cost} Snow`;
    $('cv-force').title = 'Meets the objective now, but 1 random paint on the canvas breaks: it’s gone, and nothing goes on its cell.';
    $('cv-force').disabled = !(st.phase === 'paint' && st.active && left > 0) || editing;
    $('cv-undo').disabled = !undo[mode].length;
    $('cv-new').textContent = mode === 'practice' ? 'New canvas' : setup ? 'Play this canvas' : 'Back to setting up';
    $('cv-reset').textContent = `Start over · ${P.redrawCost} Snow`;
    $('cv-reset').title = 'The same canvas and paints, from the start. The Coloring Paints and brushstrokes to come are rolled again.';
    $('cv-reset').disabled = !st.start || editing;
  }

  function offerHTML(st) {
    const f = st.offer;
    const o = f.coloring;
    let html = `<div class="cv-offer-card">${token(o.paint, ' is-coloring')}<div><p class="cv-offer-name">${esc(C.paintName(o.paint))}</p><p>Objective: ${esc(C.objectiveText(o, null))}, ${o.need} needed</p><p>${esc(C.effectText(o))}</p>${o.extras.length ? `<p>Brushstroke: ${o.extras.map((id) => esc(C.EFFECTS[id].text)).join('; ')}</p>` : ''}</div></div>`;
    if (f.stage === 'direction') {
      html += '<p class="cv-offer-head">Choose a brushstroke direction</p>';
      html += f.directions.map((d) => `<button type="button" class="cv-stroke" data-dir="${d}"><b>${C.DIRECTIONS[d].name}</b> <span>${esc(C.DIRECTIONS[d].text)}</span></button>`).join('');
    } else if (f.stage === 'effect') {
      html += `<p class="cv-offer-head">Choose a ${esc(C.DIRECTIONS[f.direction].name)} effect</p>`;
      html += f.effects.map((id) => `<button type="button" class="cv-stroke" data-effect="${id}"><span>${esc(C.EFFECTS[id].text)}</span></button>`).join('');
    } else {
      html += `<p class="cv-offer-head">Place it: click a highlighted cell${f.placeOn === 'void' ? ' (void cells too)' : f.placeOn === 'blocked' ? ' (ice cells too)' : f.placeOn === 'painted' ? ' (painted cells too: it replaces the paint)' : f.placeOn === 'broken' ? ' (broken cells too)' : ''}.</p>`;
    }
    if (f.stage !== 'place') html += `<button type="button" class="link cv-refresh" data-refresh${st.refreshes > 0 ? '' : ' disabled'}>Refresh (${st.refreshes} left)</button>`;
    return html;
  }

  // ---------- Setting up your own canvas ----------

  function renderEdit(st) {
    const on = mode === 'mine';
    $('cv-edit').hidden = !on;
    if (!on) return;
    const body = $('cv-edit-body');
    $('cv-edit-mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === editWhat)));
    $('cv-edit-mode').hidden = !setup;
    $('cv-clear').hidden = !setup;
    if (!setup) {
      body.innerHTML = '<p class="field-note">Playing with the simulator’s dice: when something comes out differently in your game, switch back to setting up and fix it.</p>';
      return;
    }
    const lv = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    if (editWhat === 'board') {
      if (selected < 0) {
        body.innerHTML = '<p class="field-note">Click a cell on the canvas to set it.</p>';
        return;
      }
      const c = st.cells[selected];
      const isAnchor = st.active && st.active.cell === selected;
      body.innerHTML = `<p class="cv-edit-title">Cell ${L(selected)}</p>
        <div class="cv-pick-row"><span>Cell</span>${['blank', 'blocked', 'void', 'broken'].map((k) => `<button type="button" class="az-flag" data-set-kind="${k}" aria-pressed="${!c.paint && c.kind === k}">${k === 'blocked' ? 'Ice' : k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
        <div class="cv-pick-row"><span>Treasure Chest</span>${lv(1, 7).map((l) => `<button type="button" class="cv-mini" data-set-paint="chest:${l}" aria-pressed="${C.isChest(c.paint) && c.paint.level === l}">${token({ cls: 'gameplay', type: C.CHEST, level: l })}</button>`).join('')}</div>
        <div class="cv-pick-row"><span>Gameplay</span>${lv(1, 7).map((l) => `<button type="button" class="cv-mini" data-set-paint="gameplay:${l}" aria-pressed="${!!c.paint && c.paint.cls === 'gameplay' && !C.isChest(c.paint) && c.paint.level === l}">${token({ cls: 'gameplay', type: 'Survival', level: l })}</button>`).join('')}</div>
        <div class="cv-pick-row"><span>Monster</span>${lv(1, 7).map((l) => `<button type="button" class="cv-mini" data-set-paint="monster:${l}" aria-pressed="${!!c.paint && c.paint.cls === 'monster' && c.paint.level === l}">${token({ cls: 'monster', type: 'Dwarf', level: l })}</button>`).join('')}</div>
        <div class="cv-pick-row"><span>Coloring Paint</span><button type="button" class="az-flag" data-set-anchor aria-pressed="${!!isAnchor}">${isAnchor ? 'The objective’s Coloring Paint is here' : 'Put the objective here'}</button><button type="button" class="az-flag" data-set-bang aria-pressed="${c.anchor && !isAnchor}">An old Coloring Paint (“!”)</button></div>`;
      return;
    }
    if (editWhat === 'paints') {
      body.innerHTML = `<p class="field-note">Add the paints you hold; click one on the right to remove it.</p>
        <div class="cv-pick-row"><span>Treasure Chest</span>${lv(1, 7).map((l) => `<button type="button" class="cv-mini" data-add="chest:${l}">${token({ cls: 'gameplay', type: C.CHEST, level: l })}</button>`).join('')}</div>
        <div class="cv-pick-row"><span>Gameplay</span>${lv(1, 7).map((l) => `<button type="button" class="cv-mini" data-add="gameplay:${l}">${token({ cls: 'gameplay', type: 'Survival', level: l })}</button>`).join('')}</div>
        <div class="cv-pick-row"><span>Monster</span>${lv(1, 7).map((l) => `<button type="button" class="cv-mini" data-add="monster:${l}">${token({ cls: 'monster', type: 'Dwarf', level: l })}</button>`).join('')}</div>`;
      return;
    }
    if (editWhat === 'objective') {
      const o = st.active;
      if (!o) {
        body.innerHTML = '<p class="field-note">No objective yet. Under Cells, click the cell with the active Coloring Paint (the “!” whose objective shows in your game) and press “Put the objective here”.</p>';
        return;
      }
      body.innerHTML = `<p class="cv-edit-title">The objective on ${L(o.cell)}</p>${shapeEditor(o, 'obj')}`;
      return;
    }
    // A brushstroke on offer.
    const f = st.offer;
    body.innerHTML = `<div class="cv-pick-row"><span>Right now</span>
      <button type="button" class="az-flag" data-stage="none" aria-pressed="${!f}">Placing paints</button>
      <button type="button" class="az-flag" data-stage="direction" aria-pressed="${!!f && f.stage === 'direction'}">Choosing a direction</button>
      <button type="button" class="az-flag" data-stage="effect" aria-pressed="${!!f && f.stage === 'effect'}">Choosing an effect</button>
      <button type="button" class="az-flag" data-stage="place" aria-pressed="${!!f && f.stage === 'place'}">Placing the Coloring Paint</button></div>
      <div class="cv-pick-row"><span>Left this canvas</span>
        <label class="cv-num">Refreshes <input type="number" min="0" max="9" data-num="refreshes" value="${st.refreshes}"></label>
        <label class="cv-num">Forced mixes used <input type="number" min="0" max="${st.params.forcedMax}" data-num="forced" value="${st.forced}"></label></div>
      ${f ? `<p class="cv-edit-title">The Coloring Paint on offer</p>${shapeEditor(f.coloring, 'offer')}${offerChoices(f)}` : ''}`;
  }

  // Range, target, need and gain of an objective or an offered Coloring Paint.
  function shapeEditor(o, scope) {
    const seg = (name, list, value) => `<div class="cv-pick-row"><span>${name}</span>${list.map(([v, label]) => `<button type="button" class="az-flag" data-shape="${scope}:${name}:${v}" aria-pressed="${String(v) === String(value)}">${esc(label)}</button>`).join('')}</div>`;
    return seg('range', C.RANGE_IDS.map((r) => [r, C.RANGES[r].name]), o.range)
      + seg('target', Object.keys(C.TARGETS).map((t) => [t, C.TARGETS[t].name]), o.target)
      + seg('need', [1, 2, 3, 4, 5, 6].map((n) => [n, String(n)]), o.need)
      + seg('gain', [1, 2, 3].map((n) => [n, `+${n}`]), o.gain)
      + `<div class="cv-pick-row"><span>Layer effects</span>${['plusOne', 'randomOne', 'sameContent', 'reroll'].map((id) => `<button type="button" class="az-flag" data-extra="${scope}:${id}" aria-pressed="${o.extras.includes(id)}">${esc(C.EFFECTS[id].text)}</button>`).join('')}</div>`;
  }

  function offerChoices(f) {
    const dirs = Object.keys(C.DIRECTIONS);
    if (f.stage === 'direction') {
      return `<div class="cv-pick-row"><span>Directions offered</span>${dirs.map((d) => `<button type="button" class="az-flag" data-offer-dir="${d}" aria-pressed="${f.directions.includes(d)}">${C.DIRECTIONS[d].name}</button>`).join('')}</div>`;
    }
    if (f.stage === 'effect') {
      const pool = C.EFFECT_IDS.filter((id) => C.EFFECTS[id].dir === f.direction);
      return `<div class="cv-pick-row"><span>Direction taken</span>${dirs.map((d) => `<button type="button" class="az-flag" data-offer-took="${d}" aria-pressed="${f.direction === d}">${C.DIRECTIONS[d].name}</button>`).join('')}</div>
        <div class="cv-pick-row cv-wrap"><span>Effects offered</span>${pool.map((id) => `<button type="button" class="az-flag" data-offer-effect="${id}" aria-pressed="${f.effects.includes(id)}">${esc(C.EFFECTS[id].text)}</button>`).join('')}</div>`;
    }
    return `<div class="cv-pick-row"><span>It can go on</span>${[['blank', 'Blank cells'], ['void', 'Blank or void cells'], ['blocked', 'Blank or ice cells'], ['painted', 'Blank or painted cells'], ['broken', 'Blank or broken cells']].map(([v, label]) => `<button type="button" class="az-flag" data-offer-on="${v}" aria-pressed="${f.placeOn === v}">${label}</button>`).join('')}</div>`;
  }

  function paintFrom(spec, st) {
    const [what, lvText] = spec.split(':');
    const level = clamp(Number(lvText), 1, 7);
    const s = st || game();
    if (what === 'chest') return C.makePaint(s, 'gameplay', C.CHEST, level);
    return C.makePaint(s, what, what === 'monster' ? 'Dwarf' : 'Survival', level);
  }

  // A plain objective shape, for a new objective or offer.
  const plainShape = () => ({ paint: { id: 0, cls: 'monster', type: 'Dwarf', level: 3 }, range: 'row', target: 'gameplay', need: 3, gain: 1, extras: [] });

  function editChanged() {
    const st = game();
    undo.mine.length = 0;
    // Keep the phase consistent with what's set up.
    if (st.phase === 'done' && C.blankCells(st).length && st.inventory.length) st.phase = st.offer ? 'offer' : 'paint';
    changed();
  }

  // ---------- The trainer ----------

  function ask() {
    const st = game();
    if (st.phase === 'done') {
      notice('This canvas is finished.');
      return;
    }
    const k = key();
    const job = S.solve(C.clone(st), { rollouts: ROLLOUTS, seed: (Math.random() * 4294967296) >>> 0 });
    advice = { key: k, result: null, job };
    const tick = () => {
      if (!advice || advice.job !== job) return;
      advice.result = job.step(4);
      renderAdvice();
      renderBoard(game());
      if (!advice.result.done) setTimeout(tick, 0);
    };
    tick();
  }

  function renderAdvice() {
    const box = $('cv-advice');
    if (!advice || !advice.result) return;
    const stale = advice.key !== key();
    const r = advice.result;
    const top = r.options[0];
    if (!top) {
      box.innerHTML = '<p class="field-note">Nothing to decide right now.</p>';
      return;
    }
    const st = game();
    const pct = (x) => `${Math.round(100 * x)}%`;
    // With a chest, the Lv7 chest chance leads; without one, rainbows.
    const chestGame = C.chests(st).length > 0 || st.inventory.some(C.isChest);
    const nums = (o) => (chestGame ? `${pct(o.lv7)} Lv7 chest · ${o.rainbows.toFixed(1)} rainbows` : `${o.rainbows.toFixed(2)} rainbows${o.lv7 ? ` · ${pct(o.lv7)} Lv7 chest` : ''}`);
    const rows = r.options.slice(0, 8).map((o, i) => `<li class="${i === 0 ? 'is-best' : ''}"><span class="cv-adv-label">${esc(o.label)}${o.policy ? ' <span class="solver-tag">strategy</span>' : ''}</span><span class="cv-adv-num">${nums(o)}</span>${stale ? '' : `<button type="button" class="btn" data-play="${i}">Play</button>`}</li>`).join('');
    const why = !stale && st.phase !== 'done' ? S.reason(st, top.action) : '';
    box.innerHTML = `${stale ? '<p class="trainer-verdict">The canvas changed since this check. Ask again.</p>' : ''}
      <p class="cv-adv-top"><b>${esc(top.label)}</b> · ${chestGame ? `${pct(top.lv7)} chance of a Lv7 chest` : `no chest, so rainbows: ${top.rainbows.toFixed(2)} on average`}</p>
      ${why ? `<p class="trainer-why">${esc(why)}</p>` : ''}
      <p class="solver-status">${r.done ? `Played out ${r.rounds.toLocaleString()} times per move` : `Playing out… ${r.rounds.toLocaleString()} of ${ROLLOUTS} per move`}. Every playout re-rolls what you can’t see: the next Coloring Paints, brushstrokes and re-rolled paints.</p>
      <ol class="cv-adv-list">${rows}</ol>`;
  }

  function renderStats() {
    const box = $('cv-stats');
    box.hidden = mode !== 'practice';
    if (mode !== 'practice') return;
    const rate = stats.chests ? Math.round((100 * stats.lv7) / stats.chests) : 0;
    box.innerHTML = `<h2 class="az-h2">Your practice</h2><p>${stats.canvases} canvas${stats.canvases === 1 ? '' : 'es'} finished, ${stats.chests} with a chest, <b>${stats.lv7} Lv7 chest${stats.lv7 === 1 ? '' : 's'}</b>${stats.chests ? ` (${rate}% of chest canvases)` : ''}, and <b>${stats.rainbows} rainbow paint${stats.rainbows === 1 ? '' : 's'}</b>. ${stats.resets} start${stats.resets === 1 ? '' : 's'} over; ${stats.snow} Colored Snow spent on finished canvases.</p>`;
  }

  // ---------- Practice values ----------

  const LAB = [
    ['chestChance', 'Canvases with a Treasure Chest (%)'],
    ['inventory', 'Paints in hand on a new canvas'],
    ['blocked', 'Ice cells (min, max)'],
    ['voids', 'Void cells (min, max)'],
    ['gameplayShare', 'Gameplay share of paints (%)'],
    ['chestShare', 'Chests among re-rolled gameplay paints (%)'],
    ['inventoryLevels', 'Paint level weights, Lv1–5'],
    ['chestLevels', 'Chest starting level weights, Lv1–5'],
    ['coloringLevels', 'Coloring Paint level weights, Lv1–5'],
    ['needByLevel', 'Paints an objective needs, by its level 1–5'],
    ['gainTwoChance', 'Chance of +2 instead of +1 (%), by level 1–5'],
    ['refreshes', 'Brushstroke refreshes a canvas'],
    ['forcedMax', 'Forced Color Mixing uses a canvas'],
    ['forcedCost', 'Forced Color Mixing costs (Colored Snow)'],
    ['redrawCost', 'Starting over costs (Colored Snow)'],
    ['snowValue', 'What 1 Colored Snow is worth (a Lv7 chest is 100)'],
    ['chestValue', 'Chest worth by final level 0–7'],
  ];

  function renderLab() {
    $('cv-lab-grid').innerHTML = LAB.map(([k, label]) => {
      const v = params[k];
      const text = Array.isArray(v) ? v.join(', ') : String(v);
      return `<label class="field"><span class="field-label">${esc(label)}</span><input type="text" data-lab="${k}" value="${esc(text)}"></label>`;
    }).join('') + `<label class="field"><span class="field-label">Objective ranges (Horizontal, Vertical, Diagonal, Adjacent, Global)</span><input type="text" data-lab-map="rangeWeights" value="${esc(Object.values(params.rangeWeights).join(', '))}"></label><label class="field"><span class="field-label">Objective targets (monster, gameplay, any)</span><input type="text" data-lab-map="targetWeights" value="${esc(Object.values(params.targetWeights).join(', '))}"></label>`;
  }

  function setParams(next) {
    params = C.normalizeParams(next);
    games.practice.params = C.normalizeParams(params);
    games.mine.params = C.normalizeParams(params);
    save();
    renderLab();
    render();
  }

  // ---------- Wiring ----------

  function bind() {
    document.querySelector('.cv-modes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      mode = b.dataset.mode;
      picked = -1;
      advice = null;
      $('cv-advice').innerHTML = '<p class="field-note">Ask, and every move is played out hundreds of times from this canvas. Moves are ranked by how often the chest ends at Lv7; without a chest, by rainbow (Lv7) paints.</p>';
      changed();
    });

    $('cv-board').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cell]');
      if (!b) return;
      const n = Number(b.dataset.cell);
      const st = game();
      if (mode === 'mine' && setup) {
        selected = n;
        editWhat = 'board';
        render();
        return;
      }
      if (st.phase === 'offer' && st.offer.stage === 'place') {
        act({ type: 'coloring', cell: n });
        return;
      }
      if (st.phase === 'paint') {
        if (picked < 0) {
          // No paint picked: take the first chest, or the lowest paint.
          notice('Pick a paint on the right first.');
          return;
        }
        act({ type: 'place', inv: picked, cell: n });
      }
    });

    $('cv-inventory').addEventListener('click', (e) => {
      const b = e.target.closest('[data-inv]');
      if (!b) return;
      const i = Number(b.dataset.inv);
      if (mode === 'mine' && setup) {
        game().inventory.splice(i, 1);
        editChanged();
        return;
      }
      picked = picked === i ? -1 : i;
      renderPanel(game());
      renderBoard(game());
    });

    $('cv-offer').addEventListener('click', (e) => {
      if (mode === 'mine' && setup) return;
      const d = e.target.closest('[data-dir]');
      if (d) act({ type: 'direction', dir: d.dataset.dir });
      const f = e.target.closest('[data-effect]');
      if (f) act({ type: 'effect', id: f.dataset.effect });
      if (e.target.closest('[data-refresh]')) act({ type: 'refresh' });
    });

    $('cv-force').addEventListener('click', () => act({ type: 'force' }));
    $('cv-reset').addEventListener('click', () => {
      if (act({ type: 'reset' })) notice(`Started over: ${game().snow} Colored Snow spent on this canvas so far.`);
    });
    $('cv-undo').addEventListener('click', () => {
      const last = undo[mode].pop();
      if (!last) return;
      games[mode] = last;
      picked = -1;
      changed();
    });
    $('cv-new').addEventListener('click', () => {
      if (mode === 'practice') {
        games.practice = C.newCanvas({ params });
        undo.practice.length = 0;
        advice = null;
        picked = -1;
        notice(games.practice.inventory.some(C.isChest) ? 'A new canvas, with a Treasure Chest in hand.' : 'A new canvas. No Treasure Chest this time: in the game you might start over.');
      } else {
        setup = !setup;
        selected = -1;
        if (!setup) C.markStart(games.mine); // starting over comes back to this
      }
      changed();
    });
    $('cv-ask').addEventListener('click', ask);
    $('cv-advice').addEventListener('click', (e) => {
      const b = e.target.closest('[data-play]');
      if (!b || !advice || !advice.result) return;
      const opt = advice.result.options[Number(b.dataset.play)];
      if (opt && act(opt.action)) advice = null;
    });

    // Setting up.
    $('cv-edit-mode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      editWhat = b.dataset.v;
      render();
    });
    $('cv-clear').addEventListener('click', () => {
      games.mine = emptyCanvas();
      selected = -1;
      editChanged();
    });
    $('cv-edit-body').addEventListener('click', (e) => {
      const st = game();
      const t = e.target.closest('button');
      if (!t) return;
      const ds = t.dataset;
      if (ds.setKind != null && selected >= 0) {
        const c = st.cells[selected];
        c.kind = ds.setKind;
        c.paint = null;
        if (ds.setKind !== 'blank') {
          c.anchor = false;
          if (st.active && st.active.cell === selected) st.active = null;
        }
      } else if (ds.setPaint && selected >= 0) {
        const c = st.cells[selected];
        c.kind = 'blank';
        c.paint = paintFrom(ds.setPaint, st);
      } else if (ds.setAnchor != null && selected >= 0) {
        const c = st.cells[selected];
        if (st.active && st.active.cell === selected) {
          st.active = null;
          c.anchor = false;
        } else {
          if (c.kind !== 'blank') c.kind = 'blank';
          if (!c.paint) c.paint = C.makePaint(st, 'monster', 'Dwarf', 3);
          c.anchor = true;
          const shape = st.active || plainShape();
          st.active = { cell: selected, paint: c.paint, range: shape.range, target: shape.target, need: shape.need, gain: shape.gain, extras: shape.extras.slice() };
          editWhat = 'objective';
        }
      } else if (ds.setBang != null && selected >= 0) {
        const c = st.cells[selected];
        if (!(st.active && st.active.cell === selected)) c.anchor = !c.anchor;
      } else if (ds.add) {
        st.inventory.push(paintFrom(ds.add, st));
        C.sortInventory(st);
      } else if (ds.shape) {
        const [scope, name, v] = ds.shape.split(':');
        const o = scope === 'obj' ? st.active : st.offer && st.offer.coloring;
        if (o) o[name] = name === 'need' || name === 'gain' ? Number(v) : v;
      } else if (ds.extra) {
        const [scope, id] = ds.extra.split(':');
        const o = scope === 'obj' ? st.active : st.offer && st.offer.coloring;
        if (o) o.extras = o.extras.includes(id) ? o.extras.filter((x) => x !== id) : [...o.extras, id];
      } else if (ds.stage) {
        if (ds.stage === 'none') {
          st.offer = null;
          st.phase = 'paint';
        } else {
          if (!st.offer) st.offer = { coloring: plainShape(), stage: 'direction', directions: ['turn', 'stack'], direction: null, effects: [], effect: null, placeOn: 'blank' };
          st.offer.stage = ds.stage;
          if (ds.stage === 'effect' && !st.offer.direction) st.offer.direction = st.offer.directions[0];
          if (ds.stage === 'effect' && !st.offer.effects.length) st.offer.effects = C.EFFECT_IDS.filter((id) => C.EFFECTS[id].dir === st.offer.direction).slice(0, 2);
          st.phase = 'offer';
          st.active = null;
        }
      } else if (ds.offerDir) {
        const f = st.offer;
        f.directions = f.directions.includes(ds.offerDir) ? f.directions.filter((d) => d !== ds.offerDir) : [...f.directions, ds.offerDir].slice(-2);
      } else if (ds.offerTook) {
        st.offer.direction = ds.offerTook;
        st.offer.effects = C.EFFECT_IDS.filter((id) => C.EFFECTS[id].dir === ds.offerTook).slice(0, 2);
      } else if (ds.offerEffect) {
        const f = st.offer;
        f.effects = f.effects.includes(ds.offerEffect) ? f.effects.filter((x) => x !== ds.offerEffect) : [...f.effects, ds.offerEffect].slice(-2);
      } else if (ds.offerOn) {
        st.offer.placeOn = ds.offerOn;
      } else return;
      editChanged();
    });
    $('cv-edit-body').addEventListener('change', (e) => {
      const t = e.target.closest('[data-num]');
      if (!t) return;
      const st = game();
      st[t.dataset.num] = clamp(Math.round(Number(t.value) || 0), 0, 9);
      editChanged();
    });

    // Practice values.
    $('cv-lab-grid').addEventListener('change', (e) => {
      const t = e.target;
      const next = C.normalizeParams(params);
      const nums = t.value.split(/[,\s]+/).filter(Boolean).map(Number).filter((x) => Number.isFinite(x));
      if (t.dataset.lab) {
        const k = t.dataset.lab;
        if (Array.isArray(next[k])) {
          if (nums.length === next[k].length) next[k] = nums;
        } else if (nums.length) next[k] = nums[0];
      } else if (t.dataset.labMap) {
        const k = t.dataset.labMap;
        const keys = Object.keys(next[k]);
        if (nums.length === keys.length) keys.forEach((kk, i) => (next[k][kk] = nums[i]));
      }
      setParams(next);
    });
    $('cv-lab-reset').addEventListener('click', () => setParams(C.DEFAULT_PARAMS));
  }

  bind();
  renderLab();
  render();
})();
