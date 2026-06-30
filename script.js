/* ===================================================================
   TwoBooth — script.js
   Vanilla JS, no frameworks, no backend.
   Sections:
     1. State & helpers
     2. Screen navigation
     3. Mode selection (apart / together / solo)
     4. Apart mode — manual WebRTC signaling (no server required)
     5. Together / solo setup
     6. Camera booth (preview, countdown, capture)
     7. Editor (filters, adjustments, layout, stickers, export render)
     8. Export (download)
   =================================================================== */

(() => {
  'use strict';

  /* -----------------------------------------------------------------
     1. STATE & HELPERS
     ----------------------------------------------------------------- */

  const state = {
    mode: null,               // 'apart' | 'together' | 'solo'
    shotsNeeded: 3,
    peopleCount: 2,
    photos: [],                // array of dataURLs (raw captures, mirrored to match selfie view)
    currentShotIndex: 0,
    facingMode: 'user',
    stream: null,

    // apart-mode webrtc
    pc: null,
    dataChannel: null,
    isHost: false,
    remotePhoto: null,
    localPhotoReady: false,
    remotePhotoReady: false,

    // editor state
    template: 'strip',
    filter: 'none',
    brightness: 100,
    contrast: 100,
    saturation: 100,
    grain: false,
    dateStamp: true,
    caption: '',
    borderStyle: 'classic',
    borderColor: '#FFFFFF',
    stickers: [],              // {emoji, xRatio, yRatio}
    draggingSticker: null,

    finalDataURL: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function show(screenId) {
    $$('.screen').forEach(s => s.classList.remove('screen--active'));
    const target = document.getElementById(`screen-${screenId}`);
    if (target) target.classList.add('screen--active');
    window.scrollTo({ top: 0 });
  }

  // wired to every [data-go] back button
  $$('[data-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dest = btn.dataset.go;
      if (dest === 'modes') stopCamera();
      show(dest);
    });
  });

  /* -----------------------------------------------------------------
     2. LANDING -> MODE SELECT
     ----------------------------------------------------------------- */

  $('#btn-start').addEventListener('click', () => show('modes'));

  $$('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      state.mode = mode;
      resetSession();
      if (mode === 'apart') {
        show('room');
      } else if (mode === 'together') {
        show('together-setup');
      } else {
        // solo: single person, default 3 shots, straight to booth
        state.shotsNeeded = 3;
        state.peopleCount = 1;
        startBooth();
      }
    });
  });

  function resetSession() {
    state.photos = [];
    state.currentShotIndex = 0;
    state.remotePhoto = null;
    state.localPhotoReady = false;
    state.remotePhotoReady = false;
    state.stickers = [];
    state.caption = '';
    state.finalDataURL = null;
  }

  /* -----------------------------------------------------------------
     3. TOGETHER MODE SETUP
     ----------------------------------------------------------------- */

  $$('#shot-count-row .pill').forEach(p => {
    p.addEventListener('click', () => {
      $$('#shot-count-row .pill').forEach(x => x.classList.remove('pill--active'));
      p.classList.add('pill--active');
      state.shotsNeeded = parseInt(p.dataset.shots, 10);
    });
  });

  $$('#people-count-row .pill').forEach(p => {
    p.addEventListener('click', () => {
      $$('#people-count-row .pill').forEach(x => x.classList.remove('pill--active'));
      p.classList.add('pill--active');
      state.peopleCount = parseInt(p.dataset.people, 10);
    });
  });

  $('#btn-together-start').addEventListener('click', () => startBooth());

  /* -----------------------------------------------------------------
     4. APART MODE — manual WebRTC signaling
     -----------------------------------------------------------------
     No backend is available, so signaling happens by hand: the host
     generates an SDP "offer code" to send to their partner through
     any channel they like (text, DM, etc). The guest pastes it,
     generates a "reply code", and sends that back. Once both sides
     have applied each other's description, ICE connects directly
     peer-to-peer and a data channel carries the finished photos.
     ----------------------------------------------------------------- */

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  $('#btn-create-room').addEventListener('click', () => {
    $('#room-choice').hidden = true;
    $('#flow-host').hidden = false;
    hostCreateOffer();
  });

  $('#btn-join-room').addEventListener('click', () => {
    $('#room-choice').hidden = true;
    $('#flow-guest').hidden = false;
  });

  function waitForIceGathering(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      function check() {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      }
      pc.addEventListener('icegatheringstatechange', check);
      // safety timeout so a flaky network never blocks the UI
      setTimeout(resolve, 4000);
    });
  }

  function encodeSignal(desc) {
    return btoa(encodeURIComponent(JSON.stringify(desc)));
  }
  function decodeSignal(code) {
    return JSON.parse(decodeURIComponent(atob(code.trim())));
  }

  function setupDataChannelHandlers(channel) {
    let incomingBuffer = '';
    let incomingTotal = 0;
    channel.onopen = () => {
      setRoomStatus('Connected! Sending your photo over…');
      maybeSendLocalPhoto();
    };
    channel.onmessage = (e) => {
      const msg = e.data;
      if (msg.startsWith('START:')) {
        incomingTotal = parseInt(msg.split(':')[1], 10);
        incomingBuffer = '';
      } else if (msg === 'END') {
        state.remotePhoto = incomingBuffer;
        state.remotePhotoReady = true;
        setRoomStatus('Got their photo! Building your strip…');
        maybeFinishApart();
      } else {
        incomingBuffer += msg;
      }
    };
  }

  function setRoomStatus(text) {
    const el = state.isHost ? $('#host-status') : $('#guest-status');
    if (el) el.textContent = text;
  }

  async function hostCreateOffer() {
    state.isHost = true;
    state.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.dataChannel = state.pc.createDataChannel('photos');
    setupDataChannelHandlers(state.dataChannel);

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await waitForIceGathering(state.pc);

    $('#host-offer-code').value = encodeSignal(state.pc.localDescription);
  }

  $('#btn-copy-offer').addEventListener('click', () => copyTextarea('#host-offer-code'));
  $('#btn-copy-answer').addEventListener('click', () => copyTextarea('#guest-answer-code'));

  function copyTextarea(sel) {
    const ta = $(sel);
    ta.select();
    navigator.clipboard?.writeText(ta.value).catch(() => document.execCommand('copy'));
  }

  $('#btn-connect-host').addEventListener('click', async () => {
    try {
      const answer = decodeSignal($('#host-answer-input').value);
      await state.pc.setRemoteDescription(answer);
      setRoomStatus('Connecting…');
    } catch (err) {
      setRoomStatus('That code looked off — double check and try again.');
    }
  });

  $('#btn-make-answer').addEventListener('click', async () => {
    try {
      state.isHost = false;
      const offer = decodeSignal($('#guest-offer-input').value);
      state.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      state.pc.ondatachannel = (e) => {
        state.dataChannel = e.channel;
        setupDataChannelHandlers(state.dataChannel);
      };
      await state.pc.setRemoteDescription(offer);
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      await waitForIceGathering(state.pc);
      $('#guest-answer-code').value = encodeSignal(state.pc.localDescription);
      setRoomStatus('Reply ready — send it back to connect.');
    } catch (err) {
      setRoomStatus('Could not read that code — ask for a fresh one.');
    }
  });

  // Once the data channel is open on either side, jump into the booth
  // (each user only captures ONE photo in apart mode).
  function enterApartBooth() {
    state.shotsNeeded = 1;
    state.peopleCount = 1;
    startBooth();
  }

  // Hook: as soon as a peer connection's channel opens we move to the booth.
  const _origSetupHandlers = setupDataChannelHandlers;
  setupDataChannelHandlers = function (channel) {
    _origSetupHandlers(channel);
    const prevOnOpen = channel.onopen;
    channel.onopen = () => {
      prevOnOpen();
      if (document.getElementById('screen-camera').classList.contains('screen--active') === false) {
        enterApartBooth();
      }
    };
  };

  function maybeSendLocalPhoto() {
    if (!state.localPhotoReady || !state.dataChannel || state.dataChannel.readyState !== 'open') return;
    const photo = state.photos[0];
    const CHUNK = 12000;
    state.dataChannel.send(`START:${photo.length}`);
    for (let i = 0; i < photo.length; i += CHUNK) {
      state.dataChannel.send(photo.slice(i, i + CHUNK));
    }
    state.dataChannel.send('END');
  }

  function maybeFinishApart() {
    if (state.localPhotoReady && state.remotePhotoReady) {
      state.photos = [state.photos[0], state.remotePhoto];
      goToEditor();
    }
  }

  /* -----------------------------------------------------------------
     6. CAMERA BOOTH
     ----------------------------------------------------------------- */

  const videoEl = $('#video-preview');
  const remoteVideoEl = $('#video-remote');
  const captureCanvas = $('#capture-canvas');
  const countdownEl = $('#booth-countdown');
  const flashEl = $('#booth-flash');
  const errorEl = $('#camera-error');
  const progressEl = $('#booth-progress');
  const modeTagEl = $('#booth-mode-tag');

  async function startBooth() {
    state.currentShotIndex = 0;
    progressEl.textContent = state.mode === 'apart'
      ? 'Your turn — strike a pose'
      : `Shot 1 of ${state.shotsNeeded}`;
    modeTagEl.textContent = state.mode === 'apart' ? 'Apart' : (state.mode === 'solo' ? 'Solo' : 'Together');
    remoteVideoEl.hidden = state.mode !== 'apart';
    errorEl.hidden = true;
    show('camera');
    await initCamera();
  }

  async function initCamera() {
    stopCamera();
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      videoEl.srcObject = state.stream;
      errorEl.hidden = true;
    } catch (err) {
      errorEl.hidden = false;
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }
  }

  $('#btn-use-placeholder').addEventListener('click', () => {
    errorEl.hidden = true; // user proceeds; capture() will fall back to a drawn placeholder
  });

  $('#btn-flip-camera').addEventListener('click', () => {
    state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
    initCamera();
  });

  $('#btn-toggle-grid').addEventListener('click', (e) => {
    videoEl.style.boxShadow = videoEl.style.boxShadow
      ? ''
      : 'inset 0 0 0 1px rgba(255,255,255,.4)';
    e.currentTarget.classList.toggle('btn-icon--ghost');
  });

  $('#btn-shutter').addEventListener('click', () => runCountdownAndCapture());

  function runCountdownAndCapture() {
    $('#btn-shutter').disabled = true;
    let n = 3;
    countdownEl.hidden = false;
    countdownEl.textContent = n;
    const tick = setInterval(() => {
      n -= 1;
      if (n > 0) {
        countdownEl.textContent = n;
        countdownEl.style.animation = 'none';
        void countdownEl.offsetWidth; // restart animation
        countdownEl.style.animation = '';
      } else {
        clearInterval(tick);
        countdownEl.hidden = true;
        capturePhoto();
      }
    }, 1000);
  }

  function capturePhoto() {
    flashEl.classList.add('booth__flash--active');
    setTimeout(() => flashEl.classList.remove('booth__flash--active'), 350);

    const w = 960, h = 720;
    captureCanvas.width = w;
    captureCanvas.height = h;
    const ctx = captureCanvas.getContext('2d');

    if (state.stream && videoEl.readyState >= 2) {
      // mirror the capture to match the on-screen preview
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      // cover-fit the video frame into the canvas
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      const scale = Math.max(w / vw, h / vh);
      const dw = vw * scale, dh = vh * scale;
      ctx.drawImage(videoEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      // graceful placeholder if camera permission was denied
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#FFD8C9');
      grad.addColorStop(1, '#C9D6FF');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#14110F';
      ctx.font = 'bold 48px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('📷', w / 2, h / 2);
    }

    const dataURL = captureCanvas.toDataURL('image/jpeg', 0.92);
    state.photos.push(dataURL);
    state.currentShotIndex += 1;

    if (state.mode === 'apart') {
      state.localPhotoReady = true;
      setRoomStatus('Photo captured! Waiting on your partner…');
      progressEl.textContent = 'Waiting for your partner…';
      maybeSendLocalPhoto();
      maybeFinishApart();
      $('#btn-shutter').disabled = true; // single shot in apart mode
      return;
    }

    if (state.currentShotIndex < state.shotsNeeded) {
      progressEl.textContent = `Shot ${state.currentShotIndex + 1} of ${state.shotsNeeded}`;
      $('#btn-shutter').disabled = false;
    } else {
      goToEditor();
    }
  }

  /* -----------------------------------------------------------------
     7. EDITOR
     ----------------------------------------------------------------- */

  const editorCanvas = $('#editor-canvas');
  const ectx = editorCanvas.getContext('2d');
  let loadedImages = []; // HTMLImageElement cache matching state.photos

  function goToEditor() {
    stopCamera();
    loadedImages = [];
    Promise.all(state.photos.map(loadImage)).then(imgs => {
      loadedImages = imgs;
      show('editor');
      renderEditor();
    });
  }

  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = src;
    });
  }

  $('#btn-editor-retake').addEventListener('click', () => {
    resetSession();
    if (state.mode === 'apart') { show('room'); }
    else if (state.mode === 'together') { show('together-setup'); }
    else { startBooth(); }
  });

  // Tabs
  $$('#editor-tabs .etab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('#editor-tabs .etab').forEach(t => t.classList.remove('etab--active'));
      tab.classList.add('etab--active');
      $$('.epanel').forEach(p => p.classList.remove('epanel--active'));
      $(`.epanel[data-panel="${tab.dataset.tab}"]`).classList.add('epanel--active');
    });
  });

  // Filters
  $$('#filter-row .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('#filter-row .filter-chip').forEach(c => c.classList.remove('filter-chip--active'));
      chip.classList.add('filter-chip--active');
      state.filter = chip.dataset.filter;
      renderEditor();
    });
  });
  $('#toggle-grain').addEventListener('change', (e) => { state.grain = e.target.checked; renderEditor(); });

  // Adjustments
  $('#slider-brightness').addEventListener('input', (e) => { state.brightness = +e.target.value; renderEditor(); });
  $('#slider-contrast').addEventListener('input', (e) => { state.contrast = +e.target.value; renderEditor(); });
  $('#slider-saturation').addEventListener('input', (e) => { state.saturation = +e.target.value; renderEditor(); });

  // Layout: template / border style / border color
  $$('#template-row .swatch').forEach(s => {
    s.addEventListener('click', () => {
      $$('#template-row .swatch').forEach(x => x.classList.remove('swatch--active'));
      s.classList.add('swatch--active');
      state.template = s.dataset.template;
      renderEditor();
    });
  });
  $$('#border-style-row .swatch').forEach(s => {
    s.addEventListener('click', () => {
      $$('#border-style-row .swatch').forEach(x => x.classList.remove('swatch--active'));
      s.classList.add('swatch--active');
      state.borderStyle = s.dataset.border;
      renderEditor();
    });
  });
  $$('#border-color-row .color-dot').forEach(d => {
    d.addEventListener('click', () => {
      $$('#border-color-row .color-dot').forEach(x => x.classList.remove('color-dot--active'));
      d.classList.add('color-dot--active');
      state.borderColor = d.dataset.color;
      renderEditor();
    });
  });

  // Extras: date stamp / caption / stickers
  $('#toggle-date').addEventListener('change', (e) => { state.dateStamp = e.target.checked; renderEditor(); });
  $('#input-caption').addEventListener('input', (e) => { state.caption = e.target.value; renderEditor(); });
  $$('#sticker-row .sticker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.stickers.push({ emoji: btn.dataset.sticker, xRatio: 0.5, yRatio: 0.5 });
      renderEditor();
    });
  });

  // Sticker dragging directly on the canvas
  editorCanvas.addEventListener('pointerdown', (e) => {
    const rect = editorCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // find nearest sticker within a small radius
    let nearest = null, bestDist = 0.05;
    state.stickers.forEach(s => {
      const d = Math.hypot(s.xRatio - x, s.yRatio - y);
      if (d < bestDist) { bestDist = d; nearest = s; }
    });
    if (nearest) state.draggingSticker = nearest;
  });
  editorCanvas.addEventListener('pointermove', (e) => {
    if (!state.draggingSticker) return;
    const rect = editorCanvas.getBoundingClientRect();
    state.draggingSticker.xRatio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    state.draggingSticker.yRatio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    renderEditor();
  });
  window.addEventListener('pointerup', () => { state.draggingSticker = null; });

  // --- noise tile for film grain, generated once and reused ---
  let grainTile = null;
  function getGrainTile() {
    if (grainTile) return grainTile;
    const size = 120;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const gctx = c.getContext('2d');
    const imgData = gctx.createImageData(size, size);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.random() * 255;
      imgData.data[i] = v; imgData.data[i + 1] = v; imgData.data[i + 2] = v;
      imgData.data[i + 3] = Math.random() * 40;
    }
    gctx.putImageData(imgData, 0, 0);
    grainTile = c;
    return grainTile;
  }

  function filterString() {
    const presets = {
      none: '',
      vintage: 'sepia(0.35) saturate(1.15) hue-rotate(-6deg)',
      bw: 'grayscale(1)',
      warm: 'sepia(0.22) saturate(1.3)',
      cold: 'saturate(0.85) hue-rotate(15deg)',
      film: 'contrast(1.12) saturate(0.85) sepia(0.12)',
      fade: 'contrast(0.82) brightness(1.08) saturate(0.65)',
      dreamy: 'saturate(1.25) brightness(1.08) blur(0.6px)',
    };
    return `brightness(${state.brightness}%) contrast(${state.contrast}%) saturate(${state.saturation}%) ${presets[state.filter]}`;
  }

  function computeLayout(count, template, cellAspect = 4 / 3) {
    const cellW = 480;
    const cellH = Math.round(cellW / cellAspect);
    const gap = 18;
    const pad = 34;

    if (template === 'grid') {
      const cols = count <= 1 ? 1 : (count <= 4 ? 2 : 3);
      const rows = Math.ceil(count / cols);
      const W = pad * 2 + cols * cellW + (cols - 1) * gap;
      const H = pad * 2 + rows * cellH + (rows - 1) * gap + 90; // room for caption
      const cells = [];
      for (let i = 0; i < count; i++) {
        const col = i % cols, row = Math.floor(i / cols);
        cells.push({ x: pad + col * (cellW + gap), y: pad + row * (cellH + gap), w: cellW, h: cellH, rot: 0 });
      }
      return { width: W, height: H, cells };
    }

    if (template === 'polaroid') {
      const frameBottom = 70;
      const W = cellW + pad * 2 + 60;
      const H = pad * 2 + count * (cellH + frameBottom + 16) + 60;
      const cells = [];
      for (let i = 0; i < count; i++) {
        const rot = (i % 2 === 0 ? -3 : 3);
        cells.push({
          x: pad + 30, y: pad + i * (cellH + frameBottom + 16),
          w: cellW, h: cellH, rot, frameBottom,
        });
      }
      return { width: W, height: H, cells, polaroid: true };
    }

    // default: classic vertical strip
    const W = pad * 2 + cellW;
    const H = pad * 2 + count * cellH + (count - 1) * gap + 110;
    const cells = [];
    for (let i = 0; i < count; i++) {
      cells.push({ x: pad, y: pad + i * (cellH + gap), w: cellW, h: cellH, rot: 0 });
    }
    return { width: W, height: H, cells };
  }

  function drawCoverImage(ctx, img, x, y, w, h) {
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }

  function drawBorder(ctx, x, y, w, h) {
    if (state.borderStyle === 'none') return;
    ctx.save();
    ctx.strokeStyle = state.borderColor;
    if (state.borderStyle === 'dashed') {
      ctx.setLineDash([10, 8]);
      ctx.lineWidth = 4;
    } else if (state.borderStyle === 'thick') {
      ctx.lineWidth = 14;
    } else {
      ctx.lineWidth = 6; // classic
    }
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function renderEditor() {
    if (loadedImages.length === 0) return;
    const layout = computeLayout(loadedImages.length, state.template);
    const W = layout.width, H = layout.height;

    editorCanvas.width = W;
    editorCanvas.height = H;

    // background — paper color sets the strip's frame
    ectx.fillStyle = '#FFFFFF';
    ectx.fillRect(0, 0, W, H);

    layout.cells.forEach((cell, i) => {
      const img = loadedImages[i];
      ectx.save();
      if (cell.rot) {
        const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
        ectx.translate(cx, cy);
        ectx.rotate((cell.rot * Math.PI) / 180);
        ectx.translate(-cx, -cy);
      }
      ectx.filter = filterString();
      drawCoverImage(ectx, img, cell.x, cell.y, cell.w, cell.h);
      ectx.filter = 'none';

      if (state.grain) {
        const tile = getGrainTile();
        const pattern = ectx.createPattern(tile, 'repeat');
        ectx.save();
        ectx.beginPath();
        ectx.rect(cell.x, cell.y, cell.w, cell.h);
        ectx.clip();
        ectx.globalAlpha = 0.5;
        ectx.fillStyle = pattern;
        ectx.fillRect(cell.x, cell.y, cell.w, cell.h);
        ectx.restore();
      }

      drawBorder(ectx, cell.x, cell.y, cell.w, cell.h);

      if (layout.polaroid) {
        // extend white card under the photo to mimic an instax frame
        ectx.fillStyle = '#fff';
      }
      ectx.restore();
    });

    // date stamp — bottom-right of the whole composite
    if (state.dateStamp) {
      ectx.save();
      ectx.font = '600 18px Manrope, sans-serif';
      ectx.fillStyle = 'rgba(20,17,15,0.55)';
      ectx.textAlign = 'right';
      const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      ectx.fillText(dateStr, W - 28, H - 22);
      ectx.restore();
    }

    // caption — centered near bottom
    if (state.caption) {
      ectx.save();
      ectx.font = '700 24px "Space Grotesk", sans-serif';
      ectx.fillStyle = '#14110F';
      ectx.textAlign = 'center';
      ectx.fillText(state.caption, W / 2, H - (state.dateStamp ? 50 : 24));
      ectx.restore();
    }

    // stickers
    state.stickers.forEach(s => {
      ectx.save();
      ectx.font = '40px sans-serif';
      ectx.textAlign = 'center';
      ectx.textBaseline = 'middle';
      ectx.fillText(s.emoji, s.xRatio * W, s.yRatio * H);
      ectx.restore();
    });

    state.finalDataURL = editorCanvas.toDataURL('image/png');
  }

  $('#btn-editor-done').addEventListener('click', () => {
    renderEditor();
    $('#export-image').src = state.finalDataURL;
    show('export');
  });

  /* -----------------------------------------------------------------
     8. EXPORT
     ----------------------------------------------------------------- */

  function download(dataURL, filename) {
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  $('#btn-download-png').addEventListener('click', () => {
    renderEditor();
    download(editorCanvas.toDataURL('image/png'), 'twobooth-strip.png');
  });

  $('#btn-download-jpg').addEventListener('click', () => {
    renderEditor();
    // flatten onto white before exporting as JPG (no alpha channel)
    const tmp = document.createElement('canvas');
    tmp.width = editorCanvas.width;
    tmp.height = editorCanvas.height;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, tmp.width, tmp.height);
    tctx.drawImage(editorCanvas, 0, 0);
    download(tmp.toDataURL('image/jpeg', 0.92), 'twobooth-strip.jpg');
  });

  $('#btn-retake-all').addEventListener('click', () => {
    resetSession();
    show('landing');
  });

})();
