/* Tartarus Simulator: Auto Screenshot Mode, in the board analyzer (beta).
 * Auto Screenshot Mode runs on follow.html: the player connects the game log and
 * shares the game window there (js/follow.js). Each picture it takes comes
 * here, to the board analyzer open in the same browser, which reads it into
 * the board, shows what it read and refreshes the advice. The analyzer has
 * no Auto Screenshot Mode controls of its own, but shows whether it's running.
 * Nothing here runs until the player has agreed on follow.html, and
 * pictures never leave the browser. */
(function () {
  'use strict';

  const C = window.TartarusCapture;
  const A = window.TartarusAnalyzer;
  if (!C || !A || typeof BroadcastChannel !== 'function') return;

  // #region receive
  // The analyzer tells Auto Screenshot Mode it's open only once the player has
  // agreed on follow.html, and it reads only the pictures sent to it. A
  // board's picture becomes the board at once, and the advice follows. If
  // the reader got something wrong, the player fixes the board and
  // rechecks. A picture of the instrument pick at the start of a run starts
  // a fresh run at that offer, with the advice on which to take. Only how
  // the reading went goes back to follow.html. Nothing is sent anywhere
  // else.
  const channel = new BroadcastChannel('tartarus-follow');
  const me = Math.random().toString(36).slice(2);
  let focusedAt = document.hasFocus() ? Date.now() : 0;
  let newest = 0;
  let lastKind = ''; // the kind of the picture before this one
  let pickFresh = false; // whether the offer on screen starts a run
  let lastBoardAt = 0; // when a board's picture was last loaded
  let viewing = 0; // boards seen behind a Warden's Treasure, still being read
  let giftsAt = 0; // when the Warden's Treasure last showed, or its counts last moved
  let giftsSeen = '';
  const say = (m) => {
    if (C.agreed()) channel.postMessage(Object.assign({ id: me }, m));
  };
  // pixels: pictures may come as raw pixels rather than a PNG.
  const announce = () => say({ type: 'here', focusedAt, pixels: true });

  async function onPicture(m) {
    const answer = (patch) => channel.postMessage(Object.assign({ type: 'read', to: m.from, id: m.id }, patch));
    const before = lastKind;
    lastKind = m.kind;
    // The Treasure's picks still waiting (Opulence gives 3 a Treasure),
    // from the log's counts. A board between two picks is the board behind
    // the next one, like one seen with View Prison Status (and a board just
    // after a Rainbow, the one its Treasure's first pick goes on). With no
    // Treasure and no count moving for a while, a tally still waiting has
    // gone stale.
    const counts = m.gifts ? `${m.gifts.rainbows}/${m.gifts.taken}` : '';
    if (m.kind === 'treasure' || (counts && counts !== giftsSeen)) giftsAt = Date.now();
    if (counts) giftsSeen = counts;
    const waiting = m.gifts && A.giftCounts ? A.giftCounts(m.gifts) : null;
    if (m.kind === 'board' && waiting > 0 && !m.treasureView) {
      if (Date.now() - giftsAt < 30000) m.treasureView = true;
      else if (A.giftsDone) A.giftsDone();
    }
    if (m.kind === 'treasure') {
      // The Warden's Treasure: every gift is on offer, so nothing is read
      // (it may come with no picture at all); the advice is on the board as
      // it is. It reads nothing, so it doesn't make a board still being
      // read out of date: back from View Prison Status before that board
      // is read, the Treasure waits for it instead of asking again.
      answer({ read: { ok: true, treasure: true } });
      if (viewing) {
        answer({ state: 'used', asked: false });
        return;
      }
      const asked = A.useTreasure(m.after);
      answer({ state: 'used', asked });
      return;
    }
    const mine = ++newest;
    if (m.treasureView) viewing += 1;
    try {
      await readPicture(m, answer, mine, before);
    } finally {
      if (m.treasureView) viewing -= 1;
    }
  }

  // A picture to read: a board, the instrument pick, the objective, or a
  // picture the log didn't name.
  async function readPicture(m, answer, mine, before) {
    let bitmap;
    try {
      const p = m.pixels;
      bitmap = await createImageBitmap(p ? new ImageData(new Uint8ClampedArray(p.buffer), p.width, p.height) : m.blob);
    } catch (e) {
      answer({ read: { ok: false, reason: '無法開啟這張圖片' } });
      return;
    }
    if (m.kind === 'objective') {
      // The run's objective popup: which objective, from its title.
      const read = await A.readObjective(bitmap);
      answer({ read });
      // On a client not in English, its screenshot can be sent.
      if (!read.ok && A.langMissed) A.langMissed('目標或開局卡', bitmap, read.reason);
      if (read.ok && mine === newest) answer({ state: 'used', asked: A.useObjective(read) });
      return;
    }
    let offerMissed = '';
    if (m.kind === 'instruments') {
      // The offer that starts a run comes with the day-0 line (m.fresh); an
      // objective's reward offers one mid-run, on the board as it is. A
      // re-roll is the same offer again.
      pickFresh = !!m.fresh || (before === 'instruments' && pickFresh);
      const fresh = pickFresh;
      const read = await A.readPick(bitmap);
      if (read.ok) {
        answer({ read });
        if (read.unsure && A.langMissed) A.langMissed('刑具選項', bitmap, `有 ${read.unsure} 張卡片沒讀到`);
        if (mine !== newest) return;
        const asked = A.usePick(read, fresh);
        answer({ state: 'used', asked });
        return;
      }
      // No offer in the picture: the log's line came, but the screen was
      // already the board (report 327: the patrol's doors, read right,
      // while the advice stayed on an offer's pick). It's read as a board.
      offerMissed = read.reason || '沒讀到';
    }
    // A picture the log didn't name (Take a picture now) may be the
    // instrument offer: at least two of its cards read surely, which no
    // board does. It starts a run unless a board came in the last few
    // minutes (an objective's reward comes mid-run). Not an offer's own
    // picture again: it was just read as one (each read takes a while).
    if (m.kind !== 'board' && m.kind !== 'instruments') {
      const pick = await A.readPick(bitmap);
      const sure = pick.ok ? pick.cards.map((c) => c.conf).sort((a, b) => b - a)[1] : 0;
      if (sure >= 0.5) {
        answer({ read: pick });
        if (mine !== newest) return;
        lastKind = 'instruments';
        pickFresh = Date.now() - lastBoardAt > 300000;
        const asked = A.usePick(pick, pickFresh);
        answer({ state: 'used', asked });
        return;
      }
    }
    const read = await A.readFrame(bitmap);
    // Neither an offer nor a board: an offer in another language, maybe.
    if (!read.ok && offerMissed && A.langMissed) A.langMissed('刑具選項', bitmap, offerMissed);
    // A picture with no board in it: maybe the Warden's Treasure, read by
    // its printed text. A board's picture can catch it too (report 55).
    if (!read.ok && !read.skipped && A.readTreasure) {
      const tr = await A.readTreasure(bitmap);
      if (tr.ok && mine === newest) {
        answer({ read: { ok: true, treasure: true } });
        answer({ state: 'used', asked: A.useTreasure() });
        return;
      }
    }
    answer({ read });
    // A board taken before its whole settle time with nothing to click on
    // it yet (no door cards, no decision cards, no meal to pick): the
    // screen is still fading in (the user's run of 2026-10-25: a new day's
    // doors too dim to read, and Replace advised). follow.html takes it
    // again at the whole time; the advice waits for that one.
    if (m.quick && read.ok && read.controls === false && !read.chain && !read.statusView && !m.treasureView) return;
    // The board behind a Warden's Treasure that couldn't be read: say so,
    // rather than ask for View Prison Status again.
    if (!read.ok && m.treasureView && A.toast) A.toast('無法從那張圖片讀出典獄長的珍藏背後的盤面。請再查看久一點，或按「以目前盤面給建議」。', 'bad');
    // The newest picture wins: an older one still being read is left.
    if (!read.ok || mine !== newest) return;
    A.useReading();
    if (A.langBoard) A.langBoard(bitmap);
    lastBoardAt = Date.now();
    answer({ state: 'used' });
    // Door cards or a decision row show only on the board itself, never
    // through View Prison Status: no Treasure is open, so a tally of picks
    // still waiting has gone stale (report 302: several Rainbows in a row,
    // then every board taken as the one behind a Treasure, and its gift
    // advised again). The board is advised as it is.
    if (m.treasureView && read.controls) {
      if (A.giftsDone) A.giftsDone();
      if (A.ask()) answer({ asked: true });
      return;
    }
    // The board behind a Warden's Treasure: the gift advice uses it.
    // View Prison Status, read from the picture, where the log's counts
    // missed the Treasure (report 325).
    if (m.treasureView || read.statusView) {
      if (A.useTreasure('view')) answer({ asked: true });
      return;
    }
    if (A.ask()) answer({ asked: true });
  }

  // Whether Auto Screenshot Mode is running, from what follow.html says of itself
  // (whether it follows the log and shares the window, and its last
  // picture), shown at the top of the analyzer.
  const bar = document.getElementById('az-follow');
  const barText = document.getElementById('az-follow-text');
  const now = document.getElementById('az-follow-now');
  let status = null;
  let heard = 0;
  const NO_EVENTS = '紀錄檔裡還沒有遊戲事件。請在遊戲中按 Esc，點「帳號相關」底下的 Enable Log（啟用日誌），然後登出再登入。';
  const time = (t) => new Date(t).toLocaleTimeString();
  const KIND_NAMES = { board: '盤面', instruments: '刑具選項', brushstroke: '筆觸', objective: '目標', treasure: '典獄長的珍藏', open: '開門', startover: '重新開始', chest: '寶箱', finish: '結束', manual: '手動' };
  const kindName = (k) => KIND_NAMES[k] || k;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function renderFollow() {
    if (!bar) return;
    // Agreed to the page before it was updated: the bar stays, to say why
    // nothing comes (report 315: Take a picture now was gone, unexplained).
    const before = !C.agreed() && !!C.agreedBefore && C.agreedBefore();
    bar.hidden = !C.agreed() && !before;
    if (bar.hidden) return;
    const link = '<a href="follow.html#follow" target="tartarus-follow">自動截圖模式頁面</a>';
    if (before) {
      bar.className = 'az-follow is-warn';
      bar.title = '';
      barText.innerHTML = `自動截圖模式已更新，在你重新同意之前會保持關閉。請開啟<a href="follow.html#agree" target="tartarus-follow">自動截圖模式頁面</a>，看過變更內容並同意，然後重新分享遊戲視窗。在那之前不會有圖片傳來，「立即截圖」也無法使用。`;
      now.disabled = true;
      now.title = '請先到自動截圖模式頁面重新同意。';
      return;
    }
    let ok = false;
    let warn = false;
    let quiet = false;
    let text;
    if (!running()) {
      text = `自動截圖模式沒有在執行。請開啟${link}，連接遊戲紀錄檔並分享遊戲視窗。`;
    } else {
      const file = esc(status.file || '遊戲紀錄檔');
      const log = { on: `正在追蹤 ${file}`, starting: '正在開啟遊戲紀錄檔', gone: `找不到 ${file}`, error: '無法讀取遊戲紀錄檔' }[status.log] || '遊戲紀錄檔未連接';
      const win = status.window === 'on' ? '正在分享遊戲視窗' : '遊戲視窗未分享';
      // The game's Enable Log is off: no triggers can come.
      const off = status.log === 'on' && status.detail === 'off';
      // Following, but no trigger has matched yet: the bar is yellow, and
      // its title says how to turn on the game's log. (An older Auto
      // Screenshot Mode page sends no hits.)
      const waiting = status.log === 'on' && !off && status.hits === 0;
      quiet = off || waiting;
      ok = status.log === 'on' && status.window === 'on' && !quiet;
      warn = status.log === 'on' && status.window === 'on' && quiet;
      const l = status.last;
      const last = l ? `上一張圖片 ${time(l.at)}${l.kind ? `（${esc(kindName(l.kind))}）` : ''}${l.ok ? '' : `：沒有截到，${esc((l.why || '視窗沒有分享').replace(/[.。]$/, ''))}`}。` : '還沒有圖片。';
      const trig = status.triggers ? `${status.triggers} 個觸發條件。` : '';
      const detail = off ? '遊戲沒有寫出需要的紀錄：請開啟<a href="follow.html#follow-enable-log" target="tartarus-follow">遊戲的日誌</a>（按 Esc，再按 Enable Log），然後登出再登入。'
        : waiting ? '還沒有遊戲事件：紀錄檔一出現動作，圖片就會自動傳來。' : '';
      text = `自動截圖模式：${log}，${win}。${trig}${last}${detail}${ok || warn ? '' : `請到${link}修正。`}`;
    }
    bar.className = `az-follow ${ok ? 'is-ok' : warn ? 'is-warn' : 'is-off'}`;
    bar.title = quiet ? NO_EVENTS : '';
    barText.innerHTML = text;
    // A picture can be taken from here while the game window is shared.
    now.disabled = !(running() && status.window === 'on');
    now.title = now.disabled ? '請先在自動截圖模式頁面分享遊戲視窗。' : '立即擷取遊戲畫面，並在這裡辨識。';
  }
  const running = () => !!status && !status.closed && Date.now() - heard <= 25000;

  // Take a picture now: Auto Screenshot Mode takes it (it holds the window), and
  // sends it here, as this analyzer was used last.
  if (now) {
    now.addEventListener('click', () => {
      focusedAt = Date.now();
      announce();
      say({ type: 'capture' });
    });
  }

  channel.onmessage = (e) => {
    const m = e.data || {};
    if (!C.agreed()) return;
    if (m.type === 'hello') announce();
    else if (m.type === 'status') {
      status = m;
      // The game's language, from its log (follow.html).
      if (m.lang && A.setGameLang) A.setGameLang(m.lang, true);
      heard = Date.now();
      renderFollow();
    } else if (m.type === 'frame' && m.to === me && (m.pixels || m.blob || m.kind === 'treasure')) onPicture(m).catch((err) => console.error(err));
  };
  window.addEventListener('focus', () => {
    focusedAt = Date.now();
    announce();
  });
  window.addEventListener('pagehide', () => say({ type: 'bye' }));
  setInterval(renderFollow, 5000);
  announce();
  renderFollow();
  // #endregion
})();
