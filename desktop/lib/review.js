/* Tartarus Overlay: the review window. Steps through a recorded session:
 * each picture the analyzer got, what the reader made of it, the board it
 * loaded, the advice with every move it weighed, and the player's fixes,
 * in order. Everything comes from the record on this PC (main.js). */
(function () {
  'use strict';

  const R = window.Record;
  const $ = (id) => document.getElementById(id);
  const TIERS = ['普通', '魔法', '稀有', '傳奇', '至臻'];
  const BEASTS = { mammoth: '巨象', lion: '狂獅', wolf: '頭狼', rat: '碩鼠' };
  const KINDS = { board: '盤面', manual: '截圖（手動）', instruments: '刑具選擇', objective: '目標', treasure: '典獄長的珍藏', event: '獄中事變' };
  const COMMANDS = { capture: '截了一張圖', fix: '按了「修正」', recheck: '按了「重新檢查」', 'tools-ok': '確認了刑具', report: '回報辨識錯誤', 'report-new': '回報新東西', board: '開啟盤面', collapse: '摺疊或展開疊加視窗', lock: '鎖定或解鎖疊加視窗' };
  const STEPS = { patrol: '選擇要巡視的門', manage: '巡視之後', office: '煽動或賞賜', chain: '選一個獵物，或取消', event: '獄中事變', ratway: '暗渠鼠道：任選牢房', choice: '刑具或珍藏' };
  const stepName = (s) => STEPS[s] || s;
  let data = null; // { name, base, entries }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== '') el.append(kid);
    return el;
  }
  const L = (n) => String(n + 1).padStart(2, '0');
  const time = (at) => new Date(at).toLocaleTimeString();
  const tierName = (t) => TIERS[Math.max(0, Math.min(4, Number(t) || 0))];

  // ---------- The board ----------

  function cellText(c) {
    if (!c) return '?';
    switch (c.kind) {
      case 'office': return '審訊室';
      case 'inmate': return `${tierName(c.tier)}${BEASTS[c.beast] || c.beast}${c.ivory ? '＋象牙' : ''}${c.prey ? `（獵物標記：${L(c.prey.cell)}，剩 ${c.prey.rounds} 個早上）` : ''}`;
      case 'sealed': return c.event ? `上鎖，有事變${c.event !== 'unknown' ? `（${c.event}）` : ''}` : '上鎖';
      case 'empty': return '空牢房';
      case 'scratch': return `劃痕（${tierName(c.tier)}）`;
      case 'revealed': return `顯示稀有度（${tierName(c.tier)}）`;
      case 'scouted': return `已偵察：${tierName(c.tier)}${BEASTS[c.beast] || c.beast}`;
      case 'nest': return `鼠巢（第 ${c.due} 天孵化）`;
      default: return c.kind;
    }
  }

  // Where cell n sits on the 6×4 block: 01–06 along the top, 07–08 down
  // the right, 09–14 back along the bottom, 15–16 up the left.
  function place(n) {
    if (n <= 5) return [1, n + 1];
    if (n <= 7) return [n - 4, 6];
    if (n <= 13) return [4, 6 - (n - 8)];
    return [n === 14 ? 3 : 2, 1];
  }

  function flagsOf(b) {
    return [
      b.swapUsed && '今天已用替換',
      b.devourUsed && '今天已用吞噬',
      b.noSwap && '沒有替換卡',
      b.noDevour && '沒有吞噬卡',
      b.consumeOffered && '替換後提供吞噬',
      b.chainArmed && '連鎖反應已就緒',
      b.toolsToConfirm && '刑具待確認',
    ].filter(Boolean);
  }

  function boardView(b, names, changed) {
    const cells = (b.cells || []).map((c, n) => {
      const [row, col] = place(n);
      const cls = ['cell', b.warden === n && 'is-warden', (b.dest || []).includes(n) && 'is-door', changed && changed.has(n) && 'is-changed'].filter(Boolean).join(' ');
      const tags = [b.warden === n && '典獄長', (b.dest || []).includes(n) && '門', c.ivory && '象牙', c.prey && '獵物', c.event && '事變'].filter(Boolean);
      const tier = c.kind === 'inmate' || c.kind === 'scouted' || c.kind === 'revealed' || c.kind === 'scratch' ? `t${Math.min(4, c.tier || 0)}` : '';
      const what = c.kind === 'inmate' || c.kind === 'scouted' ? `${tierName(c.tier)}${BEASTS[c.beast] || c.beast}` : cellText(c);
      return h('div', { class: cls, style: `grid-row:${row};grid-column:${col}` }, h('span', { class: 'n' }, L(n)), h('span', { class: `what ${tier}` }, what), tags.map((t) => h('span', { class: 'tag' }, t)));
    });
    const tools = names && names.tools && names.tools.length ? names.tools.join('、') : (b.tools || []).join('、') || '無';
    const court = h('div', { class: 'court', style: 'grid-row:2/4;grid-column:2/6' },
      h('p', null, h('b', null, `第 ${b.day} / ${b.maxDays} 天`), ` · 步驟：${stepName(b.step)}`),
      h('p', null, `刑具：${tools}`),
      h('p', null, `綺彩囚犯：${(b.vault || []).length} · 目標：${b.objective}${b.milestone ? '（已完成）' : ''}`),
      b.step === 'choice' && b.choice ? h('p', null, `可選（${b.choice.kind}）：${(names && names.choice && names.choice.length ? names.choice : b.choice.options || []).join('、') || '無'}${b.choice.rerolls ? `，剩 ${b.choice.rerolls} 次重骰` : ''}`) : null,
      flagsOf(b).length ? h('p', { class: 'warn' }, flagsOf(b).join(' · ')) : null,
    );
    return h('div', { class: 'board' }, cells, court);
  }

  // What changed between two boards, in words, and which cells.
  function diff(a, b) {
    const lines = [];
    const cells = new Set();
    if (!a || !b) return { lines, cells };
    (b.cells || []).forEach((c, n) => {
      const was = cellText(a.cells && a.cells[n]);
      const now = cellText(c);
      if (was !== now) {
        lines.push(`牢房 ${L(n)}：${was} → ${now}`);
        cells.add(n);
      }
    });
    if (a.warden !== b.warden) lines.push(`典獄長：牢房 ${L(a.warden)} → ${L(b.warden)}`);
    const doors = (x) => (x.dest || []).map(L).join('、') || '無';
    if (doors(a) !== doors(b)) lines.push(`門：${doors(a)} → ${doors(b)}`);
    if (a.day !== b.day || a.maxDays !== b.maxDays) lines.push(`天數：第 ${a.day} / ${a.maxDays} 天 → 第 ${b.day} / ${b.maxDays} 天`);
    if (a.step !== b.step) lines.push(`步驟：${stepName(a.step)} → ${stepName(b.step)}`);
    if ((a.tools || []).join() !== (b.tools || []).join()) lines.push(`刑具：${(a.tools || []).join('、') || '無'} → ${(b.tools || []).join('、') || '無'}`);
    if ((a.vault || []).length !== (b.vault || []).length) lines.push(`綺彩囚犯：${(a.vault || []).length} → ${(b.vault || []).length}`);
    if (flagsOf(a).join() !== flagsOf(b).join()) lines.push(`今天：${flagsOf(a).join('、') || '都還沒用'} → ${flagsOf(b).join('、') || '都還沒用'}`);
    if (a.objective !== b.objective || a.milestone !== b.milestone) lines.push(`目標：${a.objective}${a.milestone ? '（已完成）' : ''} → ${b.objective}${b.milestone ? '（已完成）' : ''}`);
    return { lines, cells };
  }

  // ---------- Steps ----------

  // A step starts with each picture; what follows it belongs to it.
  function stepsOf(entries) {
    const steps = [];
    let cur = null;
    for (const e of entries) {
      if (e.type === 'session') continue;
      if (e.type === 'picture' || !cur) {
        cur = { picture: e.type === 'picture' ? e : null, items: [] };
        steps.push(cur);
        if (e.type === 'picture') continue;
      }
      cur.items.push(e);
    }
    return steps;
  }

  function render() {
    const main = $('steps');
    main.replaceChildren();
    if (!data || !data.entries.length) {
      main.append(h('p', { class: 'empty' }, '這個場次還沒有任何紀錄。自動截圖模式截圖後，截圖、辨識結果和建議會顯示在這裡。'));
      $('count').textContent = '';
      return;
    }
    const showBoards = $('show-boards').checked;
    const showOther = $('show-other').checked;
    const onlyFixes = $('only-fixes').checked;
    const steps = stepsOf(data.entries);
    let prev = null; // the board before, for what changed
    let shown = 0;
    steps.forEach((s, i) => {
      const fixed = s.items.some((e) => e.type === 'edit' || (e.type === 'command' && ['fix', 'recheck', 'tools-ok', 'report'].includes(e.cmd)));
      const items = [];
      let boardShown = null;
      for (const e of s.items) {
        if (e.type === 'read') {
          items.push(h('div', { class: 'item is-bad' }, h('h3', null, `未讀取 · ${time(e.at)}`), h('p', { class: 'bad' }, e.reason || '這張截圖裡找不到盤面。'), e.summary && e.summary.length ? h('ul', { class: 'summary' }, e.summary.map((t) => h('li', null, t))) : null));
        } else if (e.type === 'loaded') {
          const r = e.read || {};
          const what = r.pick ? `刑具選項：${(r.names || []).join('、')}` : r.objective ? `目標：${r.name}` : r.treasure ? '典獄長的珍藏' : `第 ${r.day} 天`;
          const d = diff(prev, e.board);
          items.push(h('div', { class: 'item' },
            h('h3', null, `已讀取 · ${time(e.at)}`),
            h('p', null, `${what}${r.unsure ? `，${r.unsure} 處標記「檢查」` : ''}`),
            e.summary && e.summary.length ? h('ul', { class: 'summary' }, e.summary.map((t) => h('li', null, t))) : null,
            showBoards && e.board ? boardView(e.board, e.names, d.cells) : null,
          ));
          if (e.board) {
            prev = e.board;
            boardShown = JSON.stringify(e.board);
          }
        } else if (e.type === 'advice') {
          const a = e.advice || {};
          const same = e.board && JSON.stringify(e.board) === boardShown;
          const d = same ? { lines: [], cells: new Set() } : diff(prev, e.board);
          items.push(h('div', { class: `item ${a.problems && a.problems.length ? 'is-bad' : 'is-advice'}` },
            h('h3', null, `${a.problems && a.problems.length ? '盤面問題' : a.treasureWait ? '典獄長的珍藏：等待盤面' : a.toolsConfirm && !a.move ? '刑具待確認' : '建議'} · ${time(e.at)}${a.riot !== null && a.riot !== undefined ? ` · 距離暴動 ${a.riot} 天` : ''}${a.step ? ` · ${a.step}` : ''}`),
            a.move ? h('p', { class: 'move' }, a.move) : null,
            a.why ? h('p', null, a.why) : null,
            a.expect || a.status ? h('p', { class: 'meta' }, [a.expect, a.status].filter(Boolean).join(' · ')) : null,
            a.chain ? h('p', null, a.chain) : null,
            (a.problems || []).map((p) => h('p', { class: 'bad' }, p)),
            a.toolsConfirm ? h('p', { class: 'warn' }, a.toolsConfirm) : null,
            a.treasureWait ? h('p', { class: 'warn' }, '看到珍藏畫面後面的盤面之前（查看監獄狀態），不給珍藏建議。') : null,
            a.flagged ? h('p', { class: 'warn' }, `${a.flagged} 間牢房標記「檢查」。`) : null,
            a.options && a.options.length > 1 ? h('table', { class: 'options' }, a.options.map((o) => h('tr', { class: o.best ? 'is-best' : '' }, h('td', null, `${o.best ? '✓ ' : ''}${o.label}`), h('td', null, o.value)))) : null,
            a.close ? h('p', { class: 'meta' }, '前幾名的動作差距在誤差範圍內。') : null,
            !same && d.lines.length ? h('ul', { class: 'diff' }, d.lines.map((t) => h('li', null, t))) : null,
            showBoards && e.board && !same ? boardView(e.board, e.names, d.cells) : null,
          ));
          if (e.board) {
            prev = e.board;
            boardShown = JSON.stringify(e.board);
          }
        } else if (e.type === 'edit') {
          const d = diff(prev, e.board);
          items.push(h('div', { class: 'item is-edit' },
            h('h3', null, `盤面上的修改 · ${time(e.at)}`),
            d.lines.length ? h('ul', { class: 'diff' }, d.lines.map((t) => h('li', null, t))) : h('p', { class: 'meta' }, '沒有看得出來的變化。'),
            showBoards && e.board ? boardView(e.board, e.names, d.cells) : null,
          ));
          if (e.board) {
            prev = e.board;
            boardShown = JSON.stringify(e.board);
          }
        } else if (showOther) {
          const label = e.type === 'command' ? COMMANDS[e.cmd] || `按了 ${e.cmd}` : e.type === 'game' ? '遊戲啟動' : e.type === 'game-closed' ? '遊戲關閉' : e.type === 'riot' ? '暴動：戰鬥開始（疊加視窗已摺疊）' : e.type === 'riot-over' ? '回到監獄' : e.type === 'run-over' ? '本局結束（在暴動畫面按了「忽略」）' : e.type;
          items.push(h('p', { class: 'other' }, `${time(e.at)} · ${label}`));
        }
      }
      if (onlyFixes && !fixed) return;
      if (!items.length && !s.picture) return;
      shown += 1;
      const p = s.picture;
      const shot = p && p.file ? h('div', { class: 'shot' }, h('img', { src: data.base + p.file, alt: `${time(p.at)} 的截圖`, loading: 'lazy' })) : h('div', { class: 'shot' }, h('div', { class: 'noshot' }, p ? '這一步沒有截圖。' : '第一張截圖之前。'));
      const card = h('section', { class: 'step', id: `step-${i + 1}` },
        h('div', { class: 'step-head' }, h('b', null, `#${i + 1}`), p ? `${time(p.at)} · ${KINDS[p.kind] || p.kind}${p.fresh ? '（新一局開始）' : ''}` : '', fixed ? h('span', { class: 'warn' }, '手動修正過') : null),
        shot,
        h('div', { class: 'items' }, items),
      );
      main.append(card);
    });
    $('count').textContent = `顯示 ${shown} / ${steps.length} 步 · ${data.entries.filter((e) => e.type === 'picture').length} 張截圖`;
  }

  // A picture opens full width, and back.
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.shot img');
    if (img) img.closest('.step').classList.toggle('is-open');
  });

  async function loadSessions(keep) {
    const list = await R.sessions();
    const sel = $('session');
    const was = keep ? sel.value : '';
    sel.replaceChildren(...list.map((s) => h('option', { value: s.name }, `${s.name.replace('T', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')} UTC · ${s.pictures} 張截圖、${s.advice} 則建議、${s.edits} 次修正`)));
    if (!list.length) {
      data = null;
      render();
      return;
    }
    sel.value = list.some((s) => s.name === was) ? was : list[0].name;
    await open(sel.value);
  }

  async function open(name) {
    data = await R.load(name);
    render();
  }

  $('session').addEventListener('change', (e) => open(e.target.value));
  $('reload').addEventListener('click', () => loadSessions(true));
  $('folder').addEventListener('click', () => R.openFolder());
  for (const id of ['show-boards', 'show-other', 'only-fixes']) $(id).addEventListener('change', render);
  loadSessions(false);
})();
