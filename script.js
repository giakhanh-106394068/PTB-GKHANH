(function(){
  const state = {
    shotCount: 3,
    filter: 'none',
    flipCapture: false,  // some webcam drivers (e.g. Canon EOS Webcam Utility) mirror their own output — see captureFrame()
    capturePhase: 'idle',
    captureSession: 0, // invalidates pending camera requests and countdowns on exit/restart
    shots: [],           // all 6 raw captures from this session
    pickedIndices: [],   // indices into state.shots, in the order picked
    selectedShots: [],   // the chosen photos (length === state.shotCount), in final order
    stream: null,
    selectedFrame: 0,
    screenStack: ['screen-start'],
    cameraAspect: 4 / 3, // updated live once the real camera stream connects

    // You declare which shot count(s) each frame is meant for. The app then
    // auto-detects exactly WHERE the photo windows sit inside that specific
    // image the moment you apply it (see AUTO SLOT DETECTION below) — no
    // manual coordinates needed for that part. If a frame's photo count
    // ever changes, just update shotCounts here to match the real artwork.
    //
    // overlay (optional): a transparent PNG, same canvas size as "image",
    // containing ONLY the stickers/logos/text that should sit ON TOP of the
    // photos (crowns, mascots, "SAOV" text overlapping a photo edge, etc).
    // Leave it out for frames that don't need anything drawn over photos.
    frames: [
      { id: 0, name: 'SAOV Welcome', image: 'frame-1-saov-welcome.png', shotCounts: [3] },
      { id: 1, name: 'SAOV Welcome 2', image: 'frame-2-saov-welcome.png', shotCounts: [3] },
      // Kept registered but inactive — only shows up if shotCount ever
      // includes 4 again (currently hardcoded to 3, see state.shotCount).
      { id: 2, name: 'Hello Summer', image: 'frame-3-hello-summer.png', shotCounts: [3] },
      { id: 3, name: 'Swinburne Mix', image: 'frame-4-swinburne-mix.png', overlay: 'frame-4-swinburne-mix-overlay.png', shotCounts: [3] }
    ]
  };

  // Total photos captured per session — always more than any frame needs, so
  // the person can pick their favorites afterward (see SCREEN 2.5).
  const CAPTURE_COUNT = 6;

  // Real print target: 5 x 15cm — the standard commercial photo-strip
  // size — at 300 DPI photo-print quality. Everything for download/print
  // gets composited directly onto a canvas at this exact resolution (see
  // renderFinalStrip), so the output is always sharp and always exactly
  // this size, no CSS scaling/cropping involved.
  const PRINT_DPI = 300;
  const PRINT_PX_W = Math.round(5 / 2.54 * PRINT_DPI);
  const PRINT_PX_H = Math.round(15 / 2.54 * PRINT_DPI);

  const FILTERS = {
    none: 'none',
    mono: 'grayscale(1)',
    warm: 'sepia(0.35) saturate(1.2)',
    cool: 'saturate(1.1) hue-rotate(-15deg)',
    bright: 'brightness(1.2)',
    vivid: 'contrast(1.3) saturate(1.4)'
  };

  const TITLES = {
    'screen-start': 'Photobooth <strong class="brand">SAOV</strong>',
    'screen-capture': 'Xem trước camera',
    'screen-select': 'Chọn ảnh ưng ý',
    'screen-frames': 'Chọn khung hình',
    'screen-review': 'Dải ảnh của bạn'
  };

  // ==========================================================================
  // AUTO SLOT DETECTION
  // Scans a frame image for solid-color rectangular windows (the placeholder
  // areas painted in the design) and returns their position/size as
  // percentages of the image, in reading order. Runs once per frame the
  // first time it's applied and is cached afterward.
  // ==========================================================================

  const CANDIDATE_PLACEHOLDER_COLORS = [
    [245, 241, 232],  // cream / off-white
    [255, 255, 255],  // pure white
    [235, 235, 235],  // very light gray
    [200, 200, 200],  // light-mid gray
    [153, 153, 153]   // mid gray
  ];

  function findColorRegions(imgEl, targetColor, tolerance, minAreaRatio){
    const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
    if (!nw || !nh) return null;

    const scale = Math.min(1, 420 / Math.max(nw, nh));
    const cw = Math.max(1, Math.round(nw * scale));
    const ch = Math.max(1, Math.round(nh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, cw, ch);

    let data;
    try {
      data = ctx.getImageData(0, 0, cw, ch).data;
    } catch (e){
      return null; // tainted canvas (cross-origin) — can't read pixels
    }

    const matches = (x, y) => {
      const i = (y * cw + x) * 4;
      const a = data[i + 3];
      if (a < 200) return false;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      return Math.abs(r - targetColor[0]) <= tolerance &&
             Math.abs(g - targetColor[1]) <= tolerance &&
             Math.abs(b - targetColor[2]) <= tolerance;
    };

    const visited = new Uint8Array(cw * ch);
    const regions = [];

    for (let y = 0; y < ch; y++){
      for (let x = 0; x < cw; x++){
        const vIdx = y * cw + x;
        if (visited[vIdx] || !matches(x, y)) continue;

        let minX = x, maxX = x, minY = y, maxY = y, count = 0;
        const stack = [[x, y]];
        visited[vIdx] = 1;

        while (stack.length){
          const [cx, cy] = stack.pop();
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
          for (const [nx, ny] of neighbors){
            if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
            const nvIdx = ny * cw + nx;
            if (!visited[nvIdx] && matches(nx, ny)){
              visited[nvIdx] = 1;
              stack.push([nx, ny]);
            }
          }
        }

        const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;
        const fillRatio = count / (bboxW * bboxH);
        const areaRatio = count / (cw * ch);

        if (areaRatio >= minAreaRatio && fillRatio > 0.55){
          regions.push({ minX, maxX, minY, maxY, count, cw, ch });
        }
      }
    }

    return regions;
  }

  function regionsToSlots(regions, expectedCount){
    const sorted = regions.slice().sort((a, b) => b.count - a.count).slice(0, Math.max(expectedCount * 2, 12));
    const { cw, ch } = sorted[0] || { cw: 1, ch: 1 };
    const rowTolerance = ch * 0.06;
    sorted.sort((a, b) => {
      if (Math.abs(a.minY - b.minY) > rowTolerance) return a.minY - b.minY;
      return a.minX - b.minX;
    });
    return sorted.map(r => ({
      top: (r.minY / r.ch) * 100,
      left: (r.minX / r.cw) * 100,
      width: ((r.maxX - r.minX + 1) / r.cw) * 100,
      height: ((r.maxY - r.minY + 1) / r.ch) * 100
    }));
  }

  function detectSlotsForFrame(imgEl, expectedCount){
    let closest = null;
    let closestDiff = Infinity;

    for (const color of CANDIDATE_PLACEHOLDER_COLORS){
      const regions = findColorRegions(imgEl, color, 26, 0.012);
      if (!regions) continue;
      if (regions.length === 0) continue;

      const slots = regionsToSlots(regions, expectedCount);
      const diff = Math.abs(slots.length - expectedCount);

      if (diff === 0) return slots;
      if (diff < closestDiff){
        closestDiff = diff;
        closest = slots;
      }
    }

    return closest;
  }

  function loadImage(src){
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // Generic fallback layout used only when detection is unavailable (frame
  // image missing, or canvas pixel access blocked). Mirrors a real
  // commercial photo-strip: 1–4 photos in a single tall column at exactly
  // the real 5x15cm (1:3) strip ratio — matching the print output exactly,
  // zero cropping — with a reserved blank footer band at the bottom for a
  // logo/QR/branding, just like a real photobooth strip. 5+ falls back to a
  // 2-column grid sized from the real camera aspect ratio.
  function computeGenericLayout(n){
    const photoAspect = state.cameraAspect || 4 / 3; // width / height of one photo
    const canvasWidth = 900;

    if (n >= 5){
      const marginXpx = 72, marginYpx = 60, gapPx = 22;
      const cols = 2;
      const rows = Math.ceil(n / cols);
      const cellWidthPx = (canvasWidth - 2*marginXpx - gapPx) / cols;
      const cellHeightPx = cellWidthPx / photoAspect;
      const canvasHeight = rows*cellHeightPx + (rows-1)*gapPx + 2*marginYpx;
      const slots = Array.from({ length: n }, (_, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        return {
          top: ((marginYpx + row*(cellHeightPx+gapPx)) / canvasHeight) * 100,
          left: ((marginXpx + col*(cellWidthPx+gapPx)) / canvasWidth) * 100,
          width: (cellWidthPx / canvasWidth) * 100,
          height: (cellHeightPx / canvasHeight) * 100
        };
      });
      return { width: canvasWidth, height: Math.round(canvasHeight), slots, footerTop: null };
    }

    // n = 1..4: locked to the real strip ratio (5 x 15cm = 1:3), a small top
    // margin, a reserved blank footer band (~15% of height) at the bottom,
    // and photos stacked in between.
    const canvasHeight = canvasWidth * 3;
    const marginXpx = 72;
    const topMarginPx = canvasHeight * 0.035;
    const footerHeightPx = canvasHeight * 0.15;
    const gapPx = canvasHeight * 0.012;

    const availableHeight = canvasHeight - topMarginPx - footerHeightPx - (n-1)*gapPx;
    const slotHeightPx = availableHeight / n;
    const slotWidthPx = canvasWidth - 2*marginXpx;

    const slots = Array.from({ length: n }, (_, i) => ({
      top: ((topMarginPx + i*(slotHeightPx+gapPx)) / canvasHeight) * 100,
      left: (marginXpx / canvasWidth) * 100,
      width: (slotWidthPx / canvasWidth) * 100,
      height: (slotHeightPx / canvasHeight) * 100
    }));

    return {
      width: canvasWidth,
      height: Math.round(canvasHeight),
      slots,
      footerTop: ((canvasHeight - footerHeightPx) / canvasHeight) * 100
    };
  }

  function autoSlots(n){
    return computeGenericLayout(n).slots;
  }

  function placeholderFrame(name, n){
    const { width, height, footerTop } = computeGenericLayout(n || 1);
    const footerY = footerTop ? (footerTop / 100) * height : height - 40;
    const footerMidY = footerY + (height - footerY) / 2 + 7;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#FF9A1F"/>
          <stop offset="100%" stop-color="#C93E05"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#g)"/>
      <text x="${width/2}" y="34" font-family="Arial" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${name}</text>
      <text x="${width/2}" y="${footerMidY}" font-family="Arial" font-size="19" font-weight="700" fill="rgba(255,255,255,0.92)" text-anchor="middle">SAOV Photobooth</text>
    </svg>`;
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  function showScreen(id, push){
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    document.querySelector('.appbar-title').innerHTML = TITLES[id];
    document.getElementById('btnHeaderBack').disabled = (id === 'screen-start');
    if (push !== false) state.screenStack.push(id);
  }

  // === START SCREEN: live strip preview ===
  function renderStripMock(){
    const wrap = document.getElementById('stripMock');
    wrap.innerHTML = '';
    wrap.style.gridTemplateColumns = state.shotCount === 1 ? '1fr' : 'repeat(2, 1fr)';
    for (let i = 0; i < state.shotCount; i++){
      const d = document.createElement('div');
      d.className = 'strip-slot';
      d.textContent = '📷';
      wrap.appendChild(d);
    }
  }

  // === HEADER NAV ===
  document.getElementById('btnHeaderMenu').addEventListener('click', () => {
    document.getElementById('menuPanel').classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    const panel = document.getElementById('menuPanel');
    if (!panel.contains(e.target) && e.target.id !== 'btnHeaderMenu'){
      panel.classList.remove('show');
    }
  });

  document.getElementById('btnHeaderBack').addEventListener('click', () => {
    const current = state.screenStack[state.screenStack.length - 1];
    if (current === 'screen-capture'){ document.getElementById('btnCancel').click(); }
    else if (current === 'screen-select'){ document.getElementById('btnRetakeAll').click(); }
    else if (current === 'screen-frames'){ document.getElementById('btnBackCapture').click(); }
    else if (current === 'screen-review'){ document.getElementById('btnChangeFrame').click(); }
  });

  // === FILTER SELECTION ===
  document.querySelectorAll('#filterList button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filterList button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      state.filter = btn.dataset.filter;
      document.getElementById('video').style.filter = FILTERS[state.filter];
    });
  });

  // === CAMERA ===
  const video = document.getElementById('video');

  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth && video.videoHeight){
      state.cameraAspect = video.videoWidth / video.videoHeight;
      document.getElementById('stage').style.aspectRatio = video.videoWidth + ' / ' + video.videoHeight;
    }
  });

  // === CAMERA SOURCE LIST ===
  // Populates #cameraSelect with every video input device Windows/macOS
  // currently sees — this is exactly where a Canon EOS Webcam Utility
  // virtual cam, a DroidCam virtual cam, or a laptop's built-in webcam all
  // show up side by side once each is set up on the OS level. Device
  // *labels* are only filled in by the browser after camera permission has
  // been granted at least once, so this gets called again right after a
  // successful getUserMedia() to refresh them with real names.
  async function populateCameraList(){
    const select = document.getElementById('cameraSelect');
    if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      const previousValue = select.value;
      select.innerHTML = '<option value="">Camera mặc định của trình duyệt</option>';
      cams.forEach((cam, i) => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Camera ${i + 1}`;
        select.appendChild(opt);
      });
      if (previousValue && cams.some(c => c.deviceId === previousValue)){
        select.value = previousValue;
      }
    } catch (e){ /* enumerateDevices unavailable — leave the default option only */ }
  }

  populateCameraList();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener){
    navigator.mediaDevices.addEventListener('devicechange', populateCameraList);
  }

  const flipCaptureToggle = document.getElementById('flipCaptureToggle');
  if (flipCaptureToggle){
    flipCaptureToggle.checked = state.flipCapture;
    flipCaptureToggle.addEventListener('change', () => {
      state.flipCapture = flipCaptureToggle.checked;
    });
  }

  async function openCamera(session){
    try {
      const select = document.getElementById('cameraSelect');
      const deviceId = select ? select.value : '';
      const videoConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } }
        : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } };
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });
      if (session !== state.captureSession){
        stream.getTracks().forEach(t => t.stop());
        return false;
      }
      state.stream = stream;
      video.srcObject = stream;
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', updateCaptureControls));
      populateCameraList(); // refresh with real device labels now that permission is granted
      return true;
    } catch (err){
      if (session === state.captureSession) alert('Không thể mở camera: ' + err.message);
      return false;
    }
  }

  function stopCamera(){
    if (state.stream){
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }
    video.srcObject = null;
  }

  function cameraHasImage(){
    return video.srcObject === state.stream && state.stream &&
      state.stream.getVideoTracks().some(track => track.readyState === 'live') &&
      video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }

  function updateCaptureControls(){
    const shooting = state.capturePhase === 'shooting';
    const ready = cameraHasImage();
    const btn = document.getElementById('btnBeginCapture');
    btn.disabled = state.capturePhase !== 'preview' || !ready;
    btn.textContent = shooting ? 'Đang chụp...' : '📷 Bắt đầu chụp 6 ảnh';
    const title = shooting ? 'Đang chụp ảnh' : 'Xem trước camera';
    document.getElementById('captureTitle').textContent = title;
    document.getElementById('captureSubtitle').textContent = shooting
      ? 'Tạo dáng sẵn sàng — máy đang đếm ngược và chụp liên tiếp.'
      : 'Chỉnh vị trí và chọn bộ lọc, rồi bấm bắt đầu khi bạn sẵn sàng.';
    document.getElementById('cameraStatus').textContent = shooting
      ? 'Máy sẽ tự chụp đủ 6 ảnh. Bạn có thể bấm Thoát để hủy.'
      : ready ? 'Camera đã sẵn sàng. Bạn có thể xem trước thoải mái trước khi chụp.'
      : 'Đang chờ hình từ camera. Nếu camera không lên hình, hãy thoát và mở lại.';
    document.getElementById('shotInfo').classList.toggle('hidden', !shooting);
    if (document.getElementById('screen-capture').classList.contains('active')){
      document.querySelector('.appbar-title').textContent = title;
    }
  }

  ['loadeddata', 'canplay', 'playing', 'emptied'].forEach(event => {
    video.addEventListener(event, updateCaptureControls);
  });

  async function enterCameraPreview(){
    const session = ++state.captureSession;
    state.capturePhase = 'preview';
    stopCamera();
    state.shots = [];
    state.pickedIndices = [];
    state.selectedShots = [];
    updateThumbnails();
    countdown.classList.remove('show');
    flash.classList.remove('active');
    document.getElementById('shotTotal').textContent = CAPTURE_COUNT;
    document.getElementById('shotNum').textContent = '1';
    state.screenStack = ['screen-start', 'screen-capture'];
    showScreen('screen-capture', false);
    updateCaptureControls();
    const ok = await openCamera(session);
    if (session !== state.captureSession) return;
    if (!ok){
      state.capturePhase = 'idle';
      state.screenStack = ['screen-start'];
      showScreen('screen-start', false);
    }
    updateCaptureControls();
  }

  document.getElementById('btnStart').addEventListener('click', enterCameraPreview);
  document.getElementById('btnBeginCapture').addEventListener('click', () => {
    if (state.capturePhase !== 'preview' || !cameraHasImage()) return;
    state.capturePhase = 'shooting';
    document.getElementById('shotNum').textContent = '1';
    updateCaptureControls();
    runAutoCaptureSequence(state.captureSession);
  });

  document.getElementById('btnCancel').addEventListener('click', () => {
    state.captureSession++;
    state.capturePhase = 'idle';
    countdown.classList.remove('show');
    flash.classList.remove('active');
    stopCamera();
    state.screenStack = ['screen-start'];
    showScreen('screen-start', false);
  });

  // === CAPTURE ===
  const countdown = document.getElementById('countdown');
  const flash = document.getElementById('flash');
  const workCanvas = document.getElementById('workCanvas');

  function captureIsCurrent(session){
    return session === state.captureSession && state.capturePhase === 'shooting';
  }

  async function runCountdown(session){
    for (let i = 5; i >= 1; i--){
      if (!captureIsCurrent(session)) return;
      countdown.textContent = i;
      countdown.classList.remove('show');
      void countdown.offsetWidth;
      countdown.classList.add('show');
      playCountdownBeep();
      await sleep(900);
    }
  }

  function captureFrame(){
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 960;
    workCanvas.width = w;
    workCanvas.height = h;
    const ctx = workCanvas.getContext('2d');
    ctx.filter = FILTERS[state.filter];
    // Preview is mirrored via CSS (transform: scaleX(-1)) purely so posing
    // feels natural, like looking in a mirror. Whether the SAVED photo also
    // needs a flip to end up matching true reality depends on the camera
    // source: some virtual-webcam drivers (e.g. Canon's EOS Webcam Utility)
    // already mirror their own output before it reaches the browser, in
    // which case flipping again here is what makes the saved photo come
    // out correct — see the "Lật ảnh khi chụp" checkbox on the start
    // screen. Off by default (correct for DroidCam and most webcams).
    if (state.flipCapture){
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    return workCanvas.toDataURL('image/jpeg', 0.9);
  }

  function updateThumbnails(){
    const wrap = document.getElementById('thumbs');
    wrap.innerHTML = '';
    for (let i = 0; i < CAPTURE_COUNT; i++){
      const cell = document.createElement('div');
      cell.className = 'thumb';
      if (state.shots[i]){
        const img = document.createElement('img');
        img.src = state.shots[i];
        cell.appendChild(img);
      }
      wrap.appendChild(cell);
    }
  }

  // Fully automatic: counts down, captures, briefly pauses to let the
  // person reset their pose, then repeats — CAPTURE_COUNT times in a row —
  // with no button press needed in between. Cancels cleanly if the person
  // hits "Thoát" partway through (checked between every step).
  async function runAutoCaptureSequence(session){
    try {
      while (state.shots.length < CAPTURE_COUNT){
        if (!captureIsCurrent(session)) return;

        await runCountdown(session);
        if (!captureIsCurrent(session)) return;
        if (!cameraHasImage()) throw new Error('Camera bị ngắt. Hãy thoát và mở lại camera.');

        flash.classList.remove('active');
        void flash.offsetWidth;
        flash.classList.add('active');
        playShutterClick();

        const dataUrl = captureFrame();
        state.shots.push(dataUrl);
        updateThumbnails();

        if (state.shots.length >= CAPTURE_COUNT) break;

        document.getElementById('shotNum').textContent = state.shots.length + 1;
        await sleep(1200); // brief "get ready for the next one" pause
      }

      if (!captureIsCurrent(session)) return;
      await sleep(300);
      if (!captureIsCurrent(session)) return;
      state.capturePhase = 'idle';
      stopCamera();
      buildSelectGrid();
      showScreen('screen-select');
    } catch (err){
      if (!captureIsCurrent(session)) return;
      state.shots = [];
      updateThumbnails();
      state.capturePhase = 'preview';
      countdown.classList.remove('show');
      flash.classList.remove('active');
      alert('Không thể hoàn tất lượt chụp: ' + err.message);
    } finally {
      if (session === state.captureSession) updateCaptureControls();
    }
  }

  // === SELECT FAVORITES (pick state.shotCount out of the 6 captures) ===
  function renderSelectGrid(){
    document.querySelectorAll('#selectGrid .select-thumb').forEach((cell, idx) => {
      const pos = state.pickedIndices.indexOf(idx);
      const badge = cell.querySelector('.select-badge');
      if (pos >= 0){
        cell.classList.add('picked');
        badge.textContent = pos + 1;
      } else {
        cell.classList.remove('picked');
        badge.textContent = '';
      }
    });
    const btn = document.getElementById('btnConfirmSelect');
    btn.disabled = state.pickedIndices.length !== state.shotCount;
    btn.textContent = state.pickedIndices.length === state.shotCount
      ? 'Tiếp tục →'
      : `Đã chọn ${state.pickedIndices.length}/${state.shotCount} →`;
  }

  function buildSelectGrid(){
    state.pickedIndices = [];
    document.getElementById('selectSub').textContent =
      `Chọn đúng ${state.shotCount} ảnh đẹp nhất trong ${state.shots.length} tấm vừa chụp`;

    const grid = document.getElementById('selectGrid');
    grid.innerHTML = '';
    state.shots.forEach((shot, idx) => {
      const cell = document.createElement('div');
      cell.className = 'select-thumb';
      const img = document.createElement('img');
      img.src = shot;
      const badge = document.createElement('div');
      badge.className = 'select-badge';
      cell.appendChild(img);
      cell.appendChild(badge);
      cell.addEventListener('click', () => {
        const pos = state.pickedIndices.indexOf(idx);
        if (pos >= 0){
          state.pickedIndices.splice(pos, 1);
        } else if (state.pickedIndices.length < state.shotCount){
          state.pickedIndices.push(idx);
        }
        renderSelectGrid();
      });
      grid.appendChild(cell);
    });

    renderSelectGrid();
  }

  document.getElementById('btnConfirmSelect').addEventListener('click', () => {
    if (state.pickedIndices.length !== state.shotCount) return;
    state.selectedShots = state.pickedIndices.map(i => state.shots[i]);
    state.screenStack = ['screen-start', 'screen-capture', 'screen-select'];
    buildFrameSelector();
    showScreen('screen-frames');
  });

  document.getElementById('btnRetakeAll').addEventListener('click', enterCameraPreview);

  // === FRAME SELECTOR ===
  function buildFrameSelector(){
    const grid = document.getElementById('frameGrid');
    grid.innerHTML = '';

    const compatibleFrames = state.frames.filter(f => f.shotCounts.includes(state.shotCount));

    compatibleFrames.forEach((frame, idx) => {
      const card = document.createElement('div');
      card.className = 'frame-card';
      if (idx === 0){
        card.classList.add('selected');
        state.selectedFrame = state.frames.indexOf(frame);
      }
      const img = document.createElement('img');
      img.className = 'frame-img';
      img.alt = frame.name;
      img.src = frame.image;
      img.onerror = function(){ this.onerror = null; this.src = placeholderFrame(frame.name, state.shotCount); };

      const nameDiv = document.createElement('div');
      nameDiv.className = 'frame-name';
      nameDiv.textContent = frame.name;

      card.appendChild(img);
      card.appendChild(nameDiv);
      card.addEventListener('click', () => selectFrame(state.frames.indexOf(frame)));
      attachCardTilt(card);
      grid.appendChild(card);
    });

    // The independent PNG-frame extension appends its validated cards to
    // this same grid. Legacy cards and their detector above stay untouched.
    if (window.DynamicFrameSystem){
      window.DynamicFrameSystem.mount({
        grid,
        statusElement: document.getElementById('frameScanStatus')
      });
    }
  }

  function selectFrame(frameIdx){
    if (window.DynamicFrameSystem) window.DynamicFrameSystem.clearSelection();
    state.selectedFrame = frameIdx;
    document.querySelectorAll('.frame-card').forEach((card, idx) => {
      const compatibleFrames = state.frames.filter(f => f.shotCounts.includes(state.shotCount));
      if (state.frames.indexOf(compatibleFrames[idx]) === frameIdx){
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });
  }

  document.getElementById('btnApplyFrame').addEventListener('click', async () => {
    const btn = document.getElementById('btnApplyFrame');
    btn.disabled = true;
    btn.textContent = '🔍 Đang khớp khung...';
    try {
      await applyFrame();
      showScreen('screen-review');
      burstConfetti();
      playCelebrationChime();
    } catch (error){
      console.error('Không thể áp dụng khung:', error);
      alert(error && error.message ? error.message : 'Không thể áp dụng khung ảnh này.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Tiếp tục →';
    }
  });

  document.getElementById('btnBackCapture').addEventListener('click', () => {
    state.screenStack = ['screen-start', 'screen-capture', 'screen-select'];
    renderSelectGrid();
    showScreen('screen-select', false);
  });

  // === APPLY FRAME — auto-detect windows, fall back gracefully ===
  async function applyFrame(){
    const dynamicSystem = window.DynamicFrameSystem;
    if (dynamicSystem && dynamicSystem.getSelectedFrame()){
      state.currentSlots = null;
      await dynamicSystem.applyPreview({
        shots: state.selectedShots,
        frameImgElement: document.getElementById('frameImg'),
        photosGridElement: document.getElementById('photosGrid'),
        overlayElement: document.getElementById('frameOverlay')
      });
      return;
    }

    const frame = state.frames[state.selectedFrame];
    const frameImgEl = document.getElementById('frameImg');
    const photosGrid = document.getElementById('photosGrid');

    photosGrid.innerHTML = '<div class="detect-loading">🔍 Đang nhận diện khung ảnh...</div>';

    frameImgEl.onerror = null;
    frameImgEl.src = '';
    const loaded = await loadImage(frame.image);

    if (!loaded){
      frameImgEl.src = placeholderFrame(frame.name, state.selectedShots.length);
    } else {
      frameImgEl.src = frame.image;
    }

    let slots = (frame.slots && frame.slots.length === state.selectedShots.length) ? frame.slots : null;

    if (!slots && loaded){
      if (!frame._detectedSlots || frame._detectedSlotsFor !== state.selectedShots.length){
        frame._detectedSlots = detectSlotsForFrame(loaded, state.selectedShots.length);
        frame._detectedSlotsFor = state.selectedShots.length;
      }
      if (frame._detectedSlots && frame._detectedSlots.length === state.selectedShots.length){
        slots = frame._detectedSlots;
      }
    }

    if (!slots){
      slots = autoSlots(state.selectedShots.length);
    }

    // Kept for renderFinalStrip() — the exact slot rectangles used for the
    // on-screen preview are reused (unscaled, in %) when compositing the
    // real download/print image, so photos land in the same spot in both.
    state.currentSlots = slots;

    photosGrid.innerHTML = '';
    state.selectedShots.forEach((shot, i) => {
      const s = slots[i] || slots[slots.length - 1];
      const slot = document.createElement('div');
      slot.className = 'photo-slot';
      slot.style.top = s.top + '%';
      slot.style.left = s.left + '%';
      slot.style.width = s.width + '%';
      slot.style.height = s.height + '%';
      const img = document.createElement('img');
      img.src = shot;
      slot.appendChild(img);
      photosGrid.appendChild(slot);
    });

    // Decoration layer on top of the photos, if this frame has one.
    const overlayEl = document.getElementById('frameOverlay');
    if (frame.overlay){
      overlayEl.onerror = () => { overlayEl.removeAttribute('src'); };
      overlayEl.src = frame.overlay;
    } else {
      overlayEl.removeAttribute('src');
    }
  }

  // === REVIEW ACTIONS ===
  document.getElementById('btnChangeFrame').addEventListener('click', () => {
    state.screenStack = ['screen-start', 'screen-capture', 'screen-frames'];
    buildFrameSelector();
    showScreen('screen-frames', false);
  });

  document.getElementById('btnRetake').addEventListener('click', enterCameraPreview);

  // === RENDER FINAL STRIP ===
  // Composites the frame + selected photos onto a canvas at real print
  // resolution (PRINT_PX_W x PRINT_PX_H, exactly 5x15cm @ 300 DPI). The
  // frame art is drawn with "contain" logic — scaled to fit entirely inside
  // the canvas, never cropped — and each photo is drawn straight from its
  // own full-resolution source (not a downscaled on-screen render), so both
  // the download and the print always show the complete frame at full
  // sharpness. Used by both btnDownload and btnPrint below. Reuses
  // loadImage() (defined earlier, under AUTO SLOT DETECTION).
  async function renderFinalStrip(){
    const dynamicSystem = window.DynamicFrameSystem;
    if (dynamicSystem && dynamicSystem.getSelectedFrame()){
      return dynamicSystem.renderSelected(state.selectedShots);
    }

    const frame = state.frames[state.selectedFrame];

    // Load the frame art fresh here rather than reusing the on-page
    // #frameImg element — setting .src on that element starts its own load
    // that applyFrame() never explicitly waits for, so relying on it here
    // risked drawing before it was ready (silently producing a blank
    // canvas). loadImage() below guarantees a fully-loaded image or null.
    let frameImg = await loadImage(frame.image);
    if (!frameImg){
      frameImg = await loadImage(placeholderFrame(frame.name, state.selectedShots.length));
    }

    const nw = (frameImg && frameImg.naturalWidth) || 900;
    const nh = (frameImg && frameImg.naturalHeight) || 2700;

    // DECISION: never crop the frame artwork, even if that means the
    // height isn't pixel-perfect 15cm for a frame that isn't authored at
    // exactly a 1:3 ratio. Width is locked to the real physical print width
    // (5cm @ 300 DPI, the dimension that matters for cutting/feeding
    // paper); height follows the frame's own aspect ratio so every sticker,
    // logo and line of text always survives completely. The only way to
    // ALSO get an exact 15cm height with zero cropping is to author the
    // source frame PNG at precisely a 1:3 canvas ratio (e.g. 1000x3000px)
    // — short of that, a slightly-off physical height is a much smaller
    // problem than a print missing part of its own design.
    const canvasW = PRINT_PX_W;
    const canvasH = Math.round(canvasW * (nh / nw));

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    if (frameImg){
      ctx.drawImage(frameImg, 0, 0, canvasW, canvasH);
    }

    const slots = state.currentSlots || [];
    await Promise.all(state.selectedShots.map((shot, i) => new Promise((resolve) => {
      const s = slots[i] || slots[slots.length - 1];
      if (!s) return resolve();
      const img = new Image();
      img.onload = () => {
        const sx = (s.left / 100) * canvasW;
        const sy = (s.top / 100) * canvasH;
        const sw = (s.width / 100) * canvasW;
        const sh = (s.height / 100) * canvasH;
        // Crop the source photo to the slot's aspect ratio (cover-fit),
        // then draw it at full resolution into that rect.
        const imgAspect = img.naturalWidth / img.naturalHeight;
        const slotAspect = sw / sh;
        let cropW, cropH, cropX, cropY;
        if (imgAspect > slotAspect){
          cropH = img.naturalHeight;
          cropW = cropH * slotAspect;
          cropX = (img.naturalWidth - cropW) / 2;
          cropY = 0;
        } else {
          cropW = img.naturalWidth;
          cropH = cropW / slotAspect;
          cropX = 0;
          cropY = (img.naturalHeight - cropH) / 2;
        }
        ctx.drawImage(img, cropX, cropY, cropW, cropH, sx, sy, sw, sh);
        resolve();
      };
      img.onerror = resolve;
      img.src = shot;
    })));

    if (frame.overlay){
      const overlayImg = await loadImage(frame.overlay);
      if (overlayImg){
        ctx.drawImage(overlayImg, 0, 0, canvasW, canvasH);
      }
    }

    try {
      return canvas.toDataURL('image/png');
    } catch (err){
      console.error('renderFinalStrip: canvas export failed', err);
      return null;
    }
  }

  document.getElementById('btnDownload').addEventListener('click', async () => {
    const btn = document.getElementById('btnDownload');
    btn.disabled = true;
    btn.textContent = '⏳ Đang xử lý...';
    try {
      const dataUrl = await renderFinalStrip();
      if (!dataUrl) throw new Error('renderFinalStrip returned null');
      const link = document.createElement('a');
      link.download = `saov-photobooth-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err){
      console.error('Tải xuống thất bại:', err);
      alert('Có lỗi khi tạo file ảnh, vui lòng thử lại.');
    } finally {
      btn.disabled = false;
      btn.textContent = '📥 Tải xuống';
    }
  });

  document.getElementById('btnPrint').addEventListener('click', async () => {
    const btn = document.getElementById('btnPrint');

    // Open the print window IMMEDIATELY (before any await) so it counts as
    // a direct result of the click — otherwise pop-up blockers can silently
    // block a window.open() that happens after an async gap.
    // window.open('') gives a blank document that already has the standard
    // page structure in place, so everything below is built purely with DOM
    // calls (createElement/appendChild) — no HTML written as a text string.
    // This is deliberate: a local dev server's live-reload feature (e.g.
    // VS Code's Live Server) can scan a served page's raw text for the
    // closing body tag, spelled out, to know where to inject its own
    // reload script — and it can't tell a real tag apart from that same
    // text sitting inside a JS string. An earlier version of this code
    // built the print window from one big HTML template string containing
    // a full page structure end to end, and that same tag spelled out
    // inside the string got mistaken for the page's real one, splitting
    // the string apart and breaking the whole script. Building the DOM
    // without ever writing tag-like text avoids that failure mode
    // entirely.
    const printWin = window.open('', '_blank', 'width=420,height=760');
    if (!printWin){
      alert('Trình duyệt đã chặn cửa sổ in. Vui lòng cho phép pop-up cho trang này rồi bấm "In ảnh" lại.');
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Đang chuẩn bị...';

    try {
      const dataUrl = await renderFinalStrip();
      if (!dataUrl) throw new Error('renderFinalStrip returned null');

      const pdoc = printWin.document;
      pdoc.title = 'In ảnh SAOV';

      const style = pdoc.createElement('style');
      style.textContent =
        '@page{ size: A5 portrait; margin: 0; } ' +
        'html, body{ margin: 0; padding: 0; background: #fff; } ' +
        '.sheet{ width: 148mm; display: flex; justify-content: center; gap: 4mm; margin: 15mm auto 0; } ' +
        '.sheet img{ width: 50mm; height: auto; display: block; }';
      pdoc.head.appendChild(style);

      const sheet = pdoc.createElement('div');
      sheet.className = 'sheet';
      const img1 = pdoc.createElement('img');
      img1.src = dataUrl;
      const img2 = pdoc.createElement('img');
      img2.src = dataUrl;
      sheet.appendChild(img1);
      sheet.appendChild(img2);
      pdoc.body.appendChild(sheet);

      await Promise.all([img1, img2].map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      }));

      printWin.focus();
      printWin.print();
    } catch (err){
      console.error('Chuẩn bị bản in thất bại:', err);
      alert('Có lỗi khi chuẩn bị bản in, vui lòng thử lại.');
      printWin.close();
    } finally {
      btn.disabled = false;
      btn.textContent = '🖨️ In ảnh';
    }
  });

  // ==========================================================================
  // VISUAL/SENSORY POLISH — ambient particles, confetti, sound, ripples, tilt
  // ==========================================================================

  // --- Ambient drifting sparkles behind everything, all the time ---
  (function initBgParticles(){
    const canvas = document.getElementById('bgParticles');
    const pctx = canvas.getContext('2d');
    let particles = [];

    function resize(){
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    function spawn(){
      const count = Math.max(16, Math.min(46, Math.floor((canvas.width * canvas.height) / 26000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 1 + Math.random() * 2.4,
        speedY: 0.12 + Math.random() * 0.28,
        driftX: (Math.random() - 0.5) * 0.25,
        phase: Math.random() * Math.PI * 2,
        opacity: 0.12 + Math.random() * 0.3
      }));
    }

    resize();
    spawn();
    window.addEventListener('resize', () => { resize(); spawn(); });

    function tick(){
      pctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.phase += 0.012;
        p.y -= p.speedY;
        p.x += p.driftX + Math.sin(p.phase) * 0.15;
        if (p.y < -8){ p.y = canvas.height + 8; p.x = Math.random() * canvas.width; }
        if (p.x < -8) p.x = canvas.width + 8;
        if (p.x > canvas.width + 8) p.x = -8;
        pctx.beginPath();
        pctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        pctx.fillStyle = `rgba(255, 245, 220, ${p.opacity})`;
        pctx.fill();
      });
      requestAnimationFrame(tick);
    }
    tick();
  })();

  // --- Confetti burst — called once you reach the review screen ---
  function burstConfetti(){
    const canvas = document.getElementById('confettiCanvas');
    const cctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.display = 'block';

    const colors = ['#FF8C1A', '#FFD166', '#FF6A00', '#ffffff', '#E8540A'];
    const originX = canvas.width / 2;
    const originY = canvas.height * 0.22;
    const particles = Array.from({ length: 90 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 6;
      return {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        size: 5 + Math.random() * 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 12
      };
    });

    const duration = 2200;
    const startTime = performance.now();

    function frame(now){
      const elapsed = now - startTime;
      cctx.clearRect(0, 0, canvas.width, canvas.height);
      const life = Math.max(0, 1 - elapsed / duration);
      particles.forEach(p => {
        p.vy += 0.15;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        cctx.save();
        cctx.globalAlpha = life;
        cctx.translate(p.x, p.y);
        cctx.rotate(p.rotation * Math.PI / 180);
        cctx.fillStyle = p.color;
        cctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        cctx.restore();
      });
      if (elapsed < duration){
        requestAnimationFrame(frame);
      } else {
        cctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
      }
    }
    requestAnimationFrame(frame);
  }

  // --- Tiny synthesized sound effects (no audio files needed) ---
  let audioCtx = null;
  function getAudioCtx(){
    if (!audioCtx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function playTone(freq, duration, type, gainVal){
    try {
      const ctx2 = getAudioCtx();
      if (!ctx2) return;
      const osc = ctx2.createOscillator();
      const gain = ctx2.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx2.destination);
      const now = ctx2.currentTime;
      gain.gain.setValueAtTime(gainVal || 0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.start(now);
      osc.stop(now + duration);
    } catch (e){ /* Web Audio unavailable — fail silently, nothing depends on sound */ }
  }

  function playCountdownBeep(){ playTone(880, 0.12, 'sine', 0.12); }
  function playShutterClick(){ playTone(1200, 0.05, 'square', 0.2); }
  function playCelebrationChime(){
    playTone(523.25, 0.15, 'sine', 0.12);
    setTimeout(() => playTone(659.25, 0.15, 'sine', 0.12), 120);
    setTimeout(() => playTone(783.99, 0.25, 'sine', 0.14), 240);
  }

  // --- Ripple feedback on every .btn click ---
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });

  // --- Subtle 3D tilt on frame cards (applied when they're built) ---
  function attachCardTilt(card){
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const rx = ((e.clientY - rect.top) / rect.height - 0.5) * -10;
      const ry = ((e.clientX - rect.left) / rect.width - 0.5) * 10;
      card.style.transform = `perspective(600px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-3px)`;
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  }

  // init
  renderStripMock();


})();
