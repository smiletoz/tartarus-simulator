/* Tartarus Overlay: the card over the game. It shows what the board
 * analyzer recommends, read from the analyzer's own results panel
 * (lib/analyzer-adapter.js), and how Auto Screenshot Mode is doing. Everything
 * shown here is text the site wrote; it's set as text, never as markup. */
(function () {
  'use strict';

  const O = window.Overlay;
  const $ = (id) => document.getElementById(id);
  const state = { shell: {}, game: {}, follow: null, advice: null, menu: false, seenOpen: true };

  // A small element maker: h('p', { class: 'x' }, 'text', child).
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'cmd') el.dataset.cmd = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }
  const button = (label, cmd, primary) => h('button', { type: 'button', class: `btn${primary ? ' is-primary' : ''}`, cmd }, label);
  const line = (kind, content, ...buttons) => h('div', { class: `line is-${kind}` }, kind === 'busy' ? h('span', { class: 'spin' }) : null, h('p', null, content), ...buttons);
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分鐘前`;
  };
  // 正在讀取的截圖種類（js/follow.js 的觸發種類）。
  const READ_KINDS = { board: '截圖', manual: '截圖', instruments: '刑具選擇畫面', objective: '目標畫面', treasure: '典獄長的珍藏', event: '獄中事變畫面' };

  // How to turn on the game's own log, which the triggers come from.
  const ENABLE_LOG = '請在遊戲中按 Esc，點「帳號相關」底下的 Enable Log（啟用日誌），然後登出再登入。';

  // What stops Auto Screenshot Mode from working, if anything.
  function followProblem() {
    const f = state.follow;
    const g = state.game;
    if (state.shell.offline) return line('bad', `連不上網站（${state.shell.offline}）。重試中…`);
    if (state.shell.agreed === false) return line('warn', '請先到「自動截圖模式」頁面閱讀並同意。', button('開啟', 'follow', true));
    if (!g.log) return line('bad', '找不到你的遊戲紀錄檔（UE_game.log）。', button('選擇檔案', 'pick-log', true));
    if (!g.running) return line('info', '等待《火炬之光：無限》啟動…');
    if (!f) return line('busy', '正在啟動自動截圖模式…');
    if (f.log === 'gone') return line('warn', '遊戲紀錄檔目前不在。等遊戲寫入後會再繼續追蹤。', button('選擇檔案', 'pick-log'));
    if (f.log === 'error') return line('bad', `無法讀取遊戲紀錄檔：${f.error || '重試中'}。`, button('選擇檔案', 'pick-log'));
    if (f.log !== 'on') return line('busy', '正在連接遊戲紀錄檔…');
    // Windows won't share the game window: a game run as administrator
    // (report 214), or "Could not start video source" (reports 307, 326,
    // 342, 350, even with this app as administrator too). The screen it's
    // on can be shared instead, cut to the game window, once the player says
    // yes here.
    // A window share that starts but gives blank pictures counts too, and
    // with the game as administrator a window share isn't trusted at all
    // (reports 361 and 362).
    const wontShare = !(f.window === 'on' && f.shared === 'screen') && (g.adminBlock || !!(f.diag && f.diag.wontShare));
    if (wontShare && state.shell.screenShare === null) return line('warn', `${g.adminBlock ? '遊戲以系統管理員身分執行，所以 Windows ' : 'Windows '}不讓本程式分享遊戲視窗。可以改為分享遊戲所在的螢幕：每張截圖在讀取或保存前都會先裁切成遊戲視窗的範圍，而且只在遊戲是最前面的視窗時才截圖。之後可以在系統匣選單關閉。`, button('分享螢幕', 'screen-yes', true), button('不要', 'screen-no'));
    if (wontShare && state.shell.screenShare === false && g.adminBlock) return line('warn', '遊戲以系統管理員身分執行，所以 Windows 不讓本程式分享它的視窗。請在系統匣選單允許分享遊戲所在的螢幕，或對本程式按右鍵 →「以系統管理員身分執行」。');
    if (wontShare && state.shell.screenShare === false) return line('warn', 'Windows 不讓本程式分享遊戲視窗。請在系統匣選單允許分享遊戲所在的螢幕（會裁切成遊戲視窗範圍），才能取得截圖。');
    if (f.window !== 'on') return line('busy', '正在分享遊戲視窗…');
    // The game's own Enable Log is off: its log has none of the lines the
    // triggers look for, so no pictures come (js/capture.js tells).
    if (f.detail === 'off') return line('warn', `遊戲沒有記錄你的動作，所以不會有截圖。${ENABLE_LOG}`, button('怎麼做', 'enable-log'));
    // The game writes to its log all the time: one that stopped growing
    // isn't the one it's writing, and no pictures come.
    const grew = f.diag && f.diag.growingAt;
    if (grew && Date.now() - grew > 120000) return line('warn', `遊戲紀錄檔已經 ${Math.round((Date.now() - grew) / 60000)} 分鐘沒有變動。請在遊戲中開啟 Enable Log（按 Esc，在「帳號相關」底下），然後登出再登入。如果已經開啟，請選擇遊戲的 UE_game.log。`, button('選擇檔案', 'pick-log'), button('除錯報告', 'debug-report'));
    return null;
  }

  // The folded bar's one line: the advice, or what's in its way.
  function oneLine() {
    const a = state.advice;
    const f = state.follow;
    const sh = state.shell;
    if (sh.offline) return '連不上網站';
    if (sh.agreed === false) return '請先同意自動截圖模式';
    if (!state.game.log) return '找不到遊戲紀錄檔';
    if (!state.game.running) return '等待遊戲啟動';
    if (sh.riot) return '暴動：戰鬥中';
    if (sh.runOver) return '本局結束：準備下一局';
    if (f && f.window !== 'on' && state.game.adminBlock && sh.screenShare !== true) return sh.screenShare === null ? '要分享遊戲的螢幕嗎？展開來回答' : '請在系統匣允許分享螢幕';
    if (f && (f.log !== 'on' || f.window !== 'on')) return '連接中…';
    if (f && f.detail === 'off') return '請在遊戲中開啟 Enable Log';
    if (a && a.reading) return '正在讀取截圖…';
    if (a && a.treasureWait) return '珍藏：請按「查看監獄狀態」';
    if (a && a.toolsConfirm) return sh.siteUpdate ? '請確認刑具，或重新載入以套用更新' : '請確認你的刑具';
    if (a && a.problems && a.problems.length) return '盤面需要修正';
    if (a && a.working) return `計算中${a.progress !== null && a.progress !== undefined ? `：${a.progress}%` : '…'}`;
    if (a && a.stale) return '盤面已變動：請重新檢查';
    if (a && a.move) return `${a.move}${a.flagged ? `（${a.flagged} 間待檢查）` : ''}`;
    return '等待下一步';
  }

  function render() {
    const a = state.advice;
    const f = state.follow;
    const sh = state.shell;
    document.body.classList.toggle('is-collapsed', !!sh.collapsed);
    $('fold').textContent = sh.collapsed ? '+' : '–';
    $('fold').title = sh.collapsed ? '展開' : '摺疊成細條';
    $('day').textContent = sh.collapsed ? oneLine()
      : a && a.riot !== null && a.riot !== undefined ? `距離暴動 ${a.riot} 天${a.step ? ` · ${a.step}` : ''}${a.contract ? ` · ${a.contract}` : ''}` : sh.local ? '本機網站' : '';

    const out = [];
    if (sh.appUpdate) out.push(line('info', `程式更新 ${sh.appUpdate} 已準備好。`, button('重新啟動', 'restart')));
    // An update waiting while the old pages keep asking: it often fixes that.
    if (sh.siteUpdate) out.push(line(a && a.toolsConfirm ? 'warn' : 'info', a && a.toolsConfirm ? '網站已更新，新版可能就不會再問下面這類問題。這一局結束時會自動載入。' : '網站已更新。這一局結束時會自動載入。', button('立即重新載入', 'reload', !!(a && a.toolsConfirm))));
    const problem = followProblem();
    if (problem) out.push(problem);

    if (a && a.reading) out.push(line('busy', `正在讀取${READ_KINDS[a.reading.kind] || '截圖'}…`));
    const failed = a && a.lastRead && !a.lastRead.ok && !a.reading && Date.now() - a.lastRead.at < 120000;
    if (failed) out.push(line('bad', `無法讀取上一張截圖：${a.lastRead.reason || '裡面沒有盤面'}。`, button('再試一次', 'capture')));
    else if (f && f.lastFrame && !f.lastFrame.ok && Date.now() - f.lastFrame.at < 60000) out.push(line('warn', `沒有截到圖：${f.lastFrame.why || '遊戲視窗沒有分享'}`));

    if (a && a.toolsConfirm) out.push(line('warn', a.toolsConfirm, button('這些沒錯', 'tools-ok'), button('盤面', 'board')));
    // A game client not in English: a screen the reader didn't recognize.
    if (a && a.langMiss && Date.now() - a.langMiss.at < 120000) out.push(line('warn', a.langMiss.what === 'board' ? `你的遊戲是${a.langMiss.lang}版：請檢查今天的門，並在盤面分析器上手動設定「替換」和「吞噬」的決定；也請從分析器傳送一次這個盤面的截圖，幫助它學會你的語言。` : `${a.langMiss.what === 'screen' ? '這個畫面' : a.langMiss.what}沒有讀到（你的遊戲是${a.langMiss.lang}版）。請在盤面分析器上設定，並從那裡傳送截圖。`, button('盤面', 'board')));
    // The Warden's Treasure covers the board: the gift waits for a look at it.
    if (a && a.treasureWait) out.push(line('warn', '「典獄長的珍藏」已開啟。請在遊戲中按「查看監獄狀態」，在盤面停一秒，再回到珍藏畫面：珍藏建議會用那個盤面。', button('直接給建議', 'treasure-now')));
    if (a && a.problems && a.problems.length) {
      out.push(line('warn', `盤面需要修正：${a.problems[0]}`, button('修正', 'fix', true)));
    } else if (a && a.has && a.working) {
      out.push(line('busy', `正在計算最佳動作${a.progress !== null && a.progress !== undefined ? `：${a.progress}%` : '…'}`));
      if (a.flagged) out.push(line('warn', `有 ${a.flagged} 間牢房需要對照遊戲檢查。`, button('修正', 'fix')));
    } else if (a && a.has && a.stale) {
      out.push(line('warn', '上次建議之後盤面有變動。', button('重新檢查', 'recheck', true)));
    } else if (a && a.has && a.move) {
      const advice = h('div', null,
        h('p', { class: 'eyebrow' }, '建議'),
        h('p', { class: 'move' }, a.move),
        a.why ? h('p', { class: 'why' }, a.why) : null,
        h('p', { class: 'meta' }, [
          a.expect.replace(/^Expected: /, '').replace(/ Rainbows in the vault by the end of day (\d+)\.?$/, ' Rainbows expected by day $1').replace(/^預期：到第 (\d+) 天結束時，收容區約有 ([\d.]+) 名綺彩囚犯。?$/, '預期第 $1 天結束時 $2 名綺彩').replace(/[.。]$/, ''),
          a.status.replace(/^Live check: /, '').replace(/ playouts per option$/, ' playouts each').replace(/^即時檢驗：/, ''),
        ].filter(Boolean).join(' · ')),
        a.chain ? h('p', { class: 'alt' }, a.chain) : null,
        a.close && a.options[1] ? h('p', { class: 'alt' }, `差不多一樣好：${a.options.find((o) => !o.best) ? a.options.find((o) => !o.best).label : a.options[1].label}`) : null,
      );
      out.push(advice);
      if (a.flagged) out.push(line('warn', `有 ${a.flagged} 間牢房需要對照遊戲檢查。`, button('修正', 'fix'), button('重新檢查', 'recheck')));
    } else if (a && a.has && a.nothing) {
      out.push(line('info', '這個畫面沒有需要決定的事。', button('截圖', 'capture')));
    } else if (!problem && !(a && a.treasureWait)) {
      out.push(sh.runOver
        ? line('info', '本局結束。紀錄已儲存（系統匣選單：回顧測試紀錄）。準備好下一局了。')
        : line('info', '下一步時就會給建議。也可以現在截圖。', button('截圖', 'capture')));
    }

    $('body').replaceChildren(...out);
    const dot = (el, on, what) => {
      el.className = `dot ${on === true ? 'is-on' : on === false ? 'is-off' : ''}`;
      el.title = what;
    };
    // Green once the log has brought a game event; yellow while it's
    // followed but none has come yet (or the game's Enable Log is off).
    const quiet = !!f && f.log === 'on' && (!(f.hits > 0) || f.detail === 'off');
    dot($('dot-log'), f ? (f.log === 'on' ? (quiet ? null : true) : f.log === 'off' || f.log === 'error' ? false : null) : false,
      quiet ? `正在追蹤紀錄檔，但還沒有遊戲事件。${ENABLE_LOG}`
        : f && f.log === 'on' ? `正在追蹤 ${f.file || '紀錄檔'}：${(f.lines || 0).toLocaleString()} 行新紀錄，${f.hits || 0} 次觸發${f.diag && f.diag.lastTriggerAt ? `，最近一次在 ${ago(f.diag.lastTriggerAt)}` : ''}` : '沒有追蹤遊戲紀錄檔');
    dot($('dot-win'), f ? (f.window === 'on' ? true : state.game.running ? null : false) : false, f && f.window === 'on' ? `正在分享遊戲視窗${f.lastFrame ? `，最近一張截圖在 ${ago(f.lastFrame.at)}` : ''}` : '遊戲視窗沒有分享');
    $('report-menu').hidden = !state.menu;
    $('report-reading').hidden = !(a && a.canReportReading);
    // 快速模式：狀態由分析器回報。
    const fast = $('fast');
    if (fast) {
      fast.hidden = !(a && typeof a.fast === 'boolean');
      fast.setAttribute('aria-pressed', a && a.fast ? 'true' : 'false');
      fast.textContent = a && a.fast ? '快速 ✓' : '快速';
    }
    // 辨識結果：這次截圖讀到的內容。
    const seen = $('seen');
    if (seen) {
      const rows = a && Array.isArray(a.seen) ? a.seen : [];
      seen.hidden = !rows.length;
      $('seen-toggle').textContent = state.seenOpen ? '辨識 ▾' : '辨識 ▸';
      $('seen-toggle').setAttribute('aria-expanded', state.seenOpen ? 'true' : 'false');
      $('seen-list').hidden = !state.seenOpen;
      $('seen-list').replaceChildren(...(state.seenOpen ? rows.flatMap((r) => [h('dt', null, String(r.k || '')), h('dd', null, String(r.v || ''))]) : []));
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'report') {
      state.menu = !state.menu;
      render();
      return;
    }
    if (b.id === 'fold') return O.command('collapse');
    if (b.id === 'seen-toggle') {
      state.seenOpen = !state.seenOpen;
      render();
      return O.command('seen-toggle');
    }
    if (b.dataset.cmd) {
      state.menu = false;
      O.command(b.dataset.cmd);
      render();
    }
  });

  // The window takes the card's height.
  new ResizeObserver(() => O.size($('card').getBoundingClientRect().height)).observe($('card'));

  O.onShell((s) => {
    state.shell = s || {};
    if (typeof state.shell.seenOpen === 'boolean') state.seenOpen = state.shell.seenOpen;
    render();
  });
  O.onGame((g) => {
    state.game = g || {};
    render();
  });
  O.onFollow((f) => {
    state.follow = f;
    render();
  });
  O.onAdvice((a) => {
    state.advice = a;
    render();
  });
  setInterval(render, 5000); // "s ago", and old notes going away
  render();
})();
