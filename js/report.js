/* Tartarus Simulator: report something new.
 * A dialog for an event, instrument or gift the simulator doesn't know yet:
 * its name, its text, what happened, and a screenshot. The page crops the
 * screenshot to the box the player draws and shrinks it (WebP, under 150 KB)
 * before sending it to the live collector (worker/), where only the
 * maintainer can read it. Pasting while the dialog is open goes to it.
 *
 * It also reports a wrong reading: the analyzer hands over its screenshot
 * and what it made of it, and the player says what's wrong.
 *
 *   TartarusReport.open(kind, preset)  kind: event, tool, gift, other or reading;
 *     preset: { name, text, outcome, image } (image: a canvas, bitmap or blob)
 *   TartarusReport.isOpen()
 *   TartarusReport.setup({ app, context })  context() returns { page, day, step, chain } */
(function () {
  'use strict';

  const ENDPOINT = 'https://tartarus-live.blahdot3h.workers.dev';
  const KEY = 'tartarus-sim:report:v1';
  const MAX_BYTES = 150000; // the Worker takes up to 160 KB
  const MAX_SIDE = 1000; // pixels on the longer side
  // A wrong reading keeps more of its screenshot: the reader is retrained on
  // the whole picture, at the largest size that fits.
  const READING_SIDE = 1600;
  const KINDS = [['event', '獄中事變'], ['tool', '刑具'], ['gift', '珍藏'], ['other', '其他']];

  let dlg = null;
  let kind = 'event';
  // A wrong reading. The collector files it under "other", with a name of
  // its own: it keeps only a few screenshots per name.
  let wrong = false;
  let shot = null; // the screenshot, as an ImageBitmap
  let crop = null; // { x, y, w, h } in screenshot pixels, or the whole screenshot
  let drag = null;
  let packed = null; // { blob, key } for the crop it was made from
  let sending = false;
  let opts = { app: 'site', context: () => null };

  const $ = (id) => document.getElementById(id);

  function randomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(20);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((b) => chars[b % chars.length]).join('');
  }

  // A random id for this browser, so reports from one player can be told
  // apart. Nothing else about the player is sent.
  function clientId() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && typeof saved.client === 'string') return saved.client;
      const client = randomId();
      localStorage.setItem(KEY, JSON.stringify({ client }));
      return client;
    } catch (e) {
      return randomId();
    }
  }

  // ---------- The dialog ----------

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'sheet rp';
    dlg.id = 'rp-dlg';
    dlg.setAttribute('aria-labelledby', 'rp-title');
    dlg.innerHTML = `
      <form class="sheet-inner" method="dialog">
        <header class="sheet-head">
          <div><p class="eyebrow" id="rp-eyebrow">協助改進模擬器</p><h2 id="rp-title">回報新內容</h2></div>
          <button type="button" class="x" data-rp-close aria-label="關閉">×</button>
        </header>
        <div class="sheet-body">
          <p class="field-note" id="rp-intro"></p>
          <fieldset class="field" id="rp-kind-field">
            <legend class="field-label">這是什麼？</legend>
            <div class="az-seg" id="rp-kind">${KINDS.map(([v, label]) => `<button type="button" data-v="${v}" aria-pressed="false">${label}</button>`).join('')}</div>
          </fieldset>
          <div class="field">
            <span class="field-label">截圖</span>
            <div class="rp-drop" id="rp-drop">按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 貼上截圖、把圖片拖到這裡，或<button type="button" class="link" id="rp-choose">選擇檔案</button>。</div>
            <input type="file" id="rp-file" accept="image/*" hidden>
            <div class="rp-shot" id="rp-shot" hidden>
              <canvas id="rp-canvas" aria-label="你的截圖。拖曳出一個框，就只送出框內的部分。"></canvas>
              <p class="field-note" id="rp-size"></p>
              <div class="rp-shot-actions">
                <button type="button" class="btn" id="rp-whole">使用整張截圖</button>
                <button type="button" class="btn" id="rp-remove">移除截圖</button>
              </div>
            </div>
          </div>
          <div class="field" id="rp-name-field">
            <label class="field-label" for="rp-name">名稱（照遊戲中顯示的寫）</label>
            <input type="text" id="rp-name" maxlength="80" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label class="field-label" for="rp-text" id="rp-text-label">說明文字或效果</label>
            <textarea id="rp-text" rows="3" maxlength="2000" placeholder="它的說明，或事變的選項"></textarea>
          </div>
          <div class="field">
            <label class="field-label" for="rp-outcome" id="rp-outcome-label">發生了什麼（選填）</label>
            <textarea id="rp-outcome" rows="2" maxlength="1000" placeholder="你選了什麼，結果如何"></textarea>
          </div>
          <p class="field-note">請裁掉聊天內容、玩家名稱等個人資訊。回報會送到模擬器的私人資料庫，不會附帶任何帳號或地址。原作者使用英文，能附上截圖最好，文字用中文填寫也可以。</p>
          <p class="rp-status" id="rp-status" aria-live="polite"></p>
        </div>
        <footer class="sheet-foot">
          <button type="button" class="btn" data-rp-close>取消</button>
          <button type="button" class="btn btn-primary" id="rp-send">送出回報</button>
        </footer>
      </form>`;
    document.body.appendChild(dlg);

    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-rp-close]')) dlg.close();
      const k = e.target.closest('#rp-kind [data-v]');
      if (k) setKind(k.dataset.v);
    });
    $('rp-choose').addEventListener('click', () => $('rp-file').click());
    $('rp-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) take(file);
      e.target.value = '';
    });
    $('rp-whole').addEventListener('click', () => {
      crop = whole();
      changedCrop();
    });
    $('rp-remove').addEventListener('click', () => {
      shot = null;
      crop = null;
      packed = null;
      renderShot();
    });
    $('rp-send').addEventListener('click', send);
    const drop = $('rp-drop');
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('is-drop');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-drop'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('is-drop');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) take(file);
    });
    bindCrop($('rp-canvas'));
  }

  function setKind(v) {
    kind = KINDS.some(([k]) => k === v) ? v : 'other';
    dlg.querySelectorAll('#rp-kind [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === kind)));
    const label = { event: '獄中事變', tool: '刑具', gift: '珍藏', other: '東西' }[kind];
    $('rp-name').placeholder = { event: '事變標題', tool: '刑具名稱', gift: '珍品名稱', other: '它叫什麼' }[kind];
    $('rp-text').placeholder = kind === 'event' ? '事變的內容和選項' : `這個${label}的說明效果`;
  }

  // The dialog's words: for something new, or for a wrong reading.
  function setMode() {
    $('rp-eyebrow').textContent = wrong ? '協助改進截圖辨識' : '協助改進模擬器';
    $('rp-title').textContent = wrong ? '回報辨識錯誤' : '回報新內容';
    $('rp-intro').textContent = wrong
      ? '截圖辨識讀錯了你的遊戲畫面，或建議指向不存在的東西？你的截圖和分析器的判讀結果已經自動填好。說明哪裡錯了，原作者會用它重新訓練辨識。'
      : '發現模擬器還沒收錄的獄中事變、刑具或珍藏嗎？貼上截圖並說明它的效果，原作者會把它加進來。';
    $('rp-kind-field').hidden = wrong;
    $('rp-name-field').hidden = wrong;
    $('rp-text-label').textContent = wrong ? '哪裡錯了？' : '說明文字或效果';
    if (wrong) $('rp-text').placeholder = '你的遊戲顯示什麼，而分析器讀成或建議了什麼。例如：我的重刑銘牌被讀成鼠頭串。';
    $('rp-outcome-label').textContent = wrong ? '分析器的判讀與建議（會隨回報一起送出）' : '發生了什麼（選填）';
    $('rp-outcome').placeholder = wrong ? '' : '你選了什麼，結果如何';
    $('rp-outcome').rows = wrong ? 7 : 2;
  }

  function status(text, tone) {
    const el = $('rp-status');
    el.textContent = text;
    el.className = `rp-status${tone ? ` is-${tone}` : ''}`;
  }

  let opened = 0;
  function open(k, preset) {
    if (!dlg) build();
    const p = preset || {};
    opened += 1;
    wrong = k === 'reading';
    setKind(wrong ? 'other' : k || 'event');
    setMode();
    $('rp-name').value = p.name || '';
    $('rp-text').value = p.text || '';
    $('rp-outcome').value = p.outcome || '';
    shot = null;
    crop = null;
    packed = null;
    sending = false;
    $('rp-send').disabled = false;
    status('');
    renderShot();
    dlg.showModal();
    if (p.image) take(p.image);
  }

  const isOpen = () => !!dlg && dlg.open;

  // ---------- The screenshot ----------

  // A pasted, dropped or chosen file, or the picture a page hands over.
  async function take(file) {
    if (!file || (file instanceof Blob && !/^image\//.test(file.type))) {
      status('這不是圖片。請先複製截圖，再貼到這裡。', 'bad');
      return;
    }
    const ticket = opened;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      status('這個瀏覽器無法開啟那張圖片。', 'bad');
      return;
    }
    // The dialog was opened afresh while this one loaded.
    if (ticket !== opened) return;
    shot = bitmap;
    crop = whole();
    packed = null;
    status('');
    renderShot();
    changedCrop();
  }

  const whole = () => ({ x: 0, y: 0, w: shot.width, h: shot.height });

  function renderShot() {
    $('rp-drop').hidden = !!shot;
    $('rp-shot').hidden = !shot;
    if (!shot) return;
    const canvas = $('rp-canvas');
    const width = Math.min(shot.width, 1200);
    canvas.width = width;
    canvas.height = Math.round((shot.height * width) / shot.width);
    draw();
  }

  // The screenshot, dimmed outside the box that will be sent.
  function draw() {
    const canvas = $('rp-canvas');
    const g = canvas.getContext('2d');
    const k = canvas.width / shot.width;
    g.drawImage(shot, 0, 0, canvas.width, canvas.height);
    const box = drag ? drag.box : crop;
    if (!box || (box.w === shot.width && box.h === shot.height)) return;
    g.fillStyle = 'rgba(6, 8, 11, 0.62)';
    g.beginPath();
    g.rect(0, 0, canvas.width, canvas.height);
    g.rect(box.x * k, box.y * k, box.w * k, box.h * k);
    g.fill('evenodd');
    g.strokeStyle = '#eadfc5';
    g.lineWidth = 2;
    g.strokeRect(box.x * k + 1, box.y * k + 1, box.w * k - 2, box.h * k - 2);
  }

  function bindCrop(canvas) {
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * shot.width;
      const y = ((e.clientY - r.top) / r.height) * shot.height;
      return { x: Math.max(0, Math.min(shot.width, x)), y: Math.max(0, Math.min(shot.height, y)) };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!shot) return;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        // Some pointers can't be captured; the box still works inside the picture.
      }
      const p = at(e);
      drag = { from: p, box: { x: p.x, y: p.y, w: 0, h: 0 } };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = at(e);
      drag.box = { x: Math.min(p.x, drag.from.x), y: Math.min(p.y, drag.from.y), w: Math.abs(p.x - drag.from.x), h: Math.abs(p.y - drag.from.y) };
      draw();
    });
    const end = () => {
      if (!drag) return;
      const box = drag.box;
      drag = null;
      // A click or a tiny box keeps the crop as it was.
      if (box.w >= 24 && box.h >= 24) crop = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
      draw();
      changedCrop();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  let sizeTimer = 0;
  function changedCrop() {
    const whole = crop.w === shot.width && crop.h === shot.height;
    $('rp-whole').hidden = whole;
    $('rp-size').textContent = !whole
      ? '只會送出框內的部分。再拖曳一次可以修改。'
      : wrong
        ? '截圖辨識從整張截圖學得最好。只有需要排除個人資訊時才拖曳框選。'
        : '在事變或刑具周圍拖曳出一個框，就只送出那個部分。';
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(async () => {
      const blob = await pack();
      if (blob) $('rp-size').textContent += `約 ${Math.max(1, Math.round(blob.size / 1000))} KB。`;
    }, 120);
  }

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  // The cropped screenshot, shrunk until it fits: WebP where the browser can
  // make it, JPEG where it can't.
  async function pack() {
    if (!shot || !crop) return null;
    const key = `${crop.x},${crop.y},${crop.w},${crop.h}`;
    if (packed && packed.key === key) return packed.blob;
    let scale = Math.min(1, (wrong ? READING_SIDE : MAX_SIDE) / Math.max(crop.w, crop.h));
    for (let tries = 0; tries < 8; tries++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(crop.w * scale));
      canvas.height = Math.max(1, Math.round(crop.h * scale));
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(shot, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      for (const q of [0.82, 0.7, 0.58]) {
        let blob = await toBlob(canvas, 'image/webp', q);
        if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', q);
        if (blob && blob.size <= MAX_BYTES) {
          packed = { key, blob };
          return blob;
        }
      }
      scale *= 0.75;
    }
    return null;
  }

  const base64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  // ---------- Sending ----------

  async function send() {
    if (sending) return;
    // Each wrong reading gets a name of its own, so the collector keeps its
    // screenshot.
    const name = wrong ? `Wrong reading ${randomId().slice(0, 8)}` : $('rp-name').value.trim();
    const text = $('rp-text').value.trim();
    const outcome = $('rp-outcome').value.trim();
    if (wrong && !text) {
      status('請說明哪裡錯了：你的遊戲顯示什麼，而分析器讀成或建議了什麼。', 'bad');
      $('rp-text').focus();
      return;
    }
    if (!shot && !name && !text) {
      status('請貼上截圖，或填寫名稱和效果。', 'bad');
      return;
    }
    sending = true;
    $('rp-send').disabled = true;
    status('送出中…');
    try {
      let image = null;
      if (shot) {
        const blob = await pack();
        if (!blob) throw new Error('那張截圖無法壓縮到可以送出的大小。請只框選重要的部分，框小一點。');
        image = { type: blob.type, data: await base64(blob) };
      }
      let context = null;
      try {
        context = opts.context ? opts.context() : null;
      } catch (e) {
        context = null;
      }
      const body = JSON.stringify({ uid: randomId(), client: clientId(), app: opts.app, kind, name, text, outcome, context, image });
      const res = await fetch(`${ENDPOINT}/v1/reports`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `回報沒有送出（HTTP ${res.status}）。`);
      const more = out.seen > 1 ? `目前已有 ${out.seen} 筆相同回報。` : '';
      status(out.image === 'enough' ? `謝謝！這個項目已經有足夠的截圖，所以只保留了你的文字。${more}` : `謝謝！你的回報已送出。${more}`, 'ok');
      setTimeout(() => {
        if (isOpen()) dlg.close();
      }, 3500);
    } catch (e) {
      status(e && e.message ? e.message : '回報沒有送出，請稍後再試。', 'bad');
      $('rp-send').disabled = false;
    } finally {
      sending = false;
    }
  }

  // ---------- Wiring ----------

  // A paste while the dialog is open is the report's screenshot.
  document.addEventListener('paste', (e) => {
    if (!isOpen()) return;
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const item = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (!item) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    take(item.getAsFile());
  }, true);

  // Any button with data-report="kind" opens the dialog.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-report]');
    if (!b) return;
    e.preventDefault();
    open(b.dataset.report);
  });

  window.TartarusReport = {
    open,
    isOpen,
    setup(o) {
      opts = Object.assign(opts, o || {});
    },
  };
})();
