(function(){
  'use strict';

  const EXPECTED_PHOTO_COUNT = 3;
  const TRANSPARENT_ALPHA = 24;
  const MAX_OUTPUT_PIXELS = 36000000;
  const slotCache = new Map();
  const bundledFrames = Array.isArray(window.BundledDynamicFrames)
    ? window.BundledDynamicFrames.map(frame => ({ ...frame, source: 'dynamic' }))
    : [];
  let importedObjectUrls = [];

  let frameGrid = null;
  let statusElement = null;
  let refreshButton = null;
  let availableFrames = [];
  let selectedFrameId = null;
  let hasLoadedOnce = false;
  let refreshSequence = 0;

  function frameNameFromFile(file){
    const base = file.name.replace(/\.png$/i, '');
    if (/^\d+$/.test(base)) return 'Khung ' + base;
    const words = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Khung ảnh';
  }

  function chooseFrameFolder(){
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.png,image/png';
      input.multiple = true;
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
      input.style.display = 'none';

      let finished = false;
      const finish = files => {
        if (finished) return;
        finished = true;
        input.remove();
        resolve(files);
      };

      input.addEventListener('change', () => {
        const files = Array.from(input.files || [])
          .filter(file => file.name.toLowerCase().endsWith('.png'))
          .sort((left, right) => left.name.localeCompare(right.name, 'vi', { numeric: true }));
        finish(files);
      }, { once: true });
      input.addEventListener('cancel', () => finish(null), { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }

  function framesFromFiles(files){
    importedObjectUrls.forEach(url => URL.revokeObjectURL(url));
    importedObjectUrls = [];
    return files.map((file, index) => {
      const url = URL.createObjectURL(file);
      importedObjectUrls.push(url);
      return {
        id: 'file-' + (file.webkitRelativePath || file.name) + '-' + file.size + '-' + file.lastModified,
        name: frameNameFromFile(file),
        url,
        source: 'dynamic',
        order: index
      };
    });
  }

  function loadImage(source){
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      if (/^https?:/i.test(source)) image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Không thể mở ảnh khung PNG'));
      image.src = source;
    });
  }

  function sortSlotsInReadingOrder(slots){
    return slots.sort((left, right) => {
      const leftCenter = left.y + left.height / 2;
      const rightCenter = right.y + right.height / 2;
      const sameRowTolerance = Math.min(left.height, right.height) * 0.42;
      if (Math.abs(leftCenter - rightCenter) <= sameRowTolerance){
        return left.x - right.x;
      }
      return left.y - right.y;
    });
  }

  function findTransparentSlots(overlay){
    const scale = Math.min(1, 520 / overlay.naturalWidth, 780 / overlay.naturalHeight);
    const width = Math.max(1, Math.round(overlay.naturalWidth * scale));
    const height = Math.max(1, Math.round(overlay.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Trình duyệt không thể phân tích khung PNG');
    context.drawImage(overlay, 0, 0, width, height);

    const pixels = context.getImageData(0, 0, width, height).data;
    const size = width * height;
    const visited = new Uint8Array(size);
    const queue = new Int32Array(size);
    const minimumArea = Math.max(36, Math.floor(size * 0.006));
    const regions = [];

    for (let start = 0; start < size; start++){
      if (visited[start] || pixels[start * 4 + 3] > TRANSPARENT_ALPHA) continue;

      let head = 0;
      let tail = 0;
      let area = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let touchesEdge = false;
      visited[start] = 1;
      queue[tail++] = start;

      while (head < tail){
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        area++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

        if (x > 0){
          const neighbor = index - 1;
          if (!visited[neighbor] && pixels[neighbor * 4 + 3] <= TRANSPARENT_ALPHA){
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
        if (x < width - 1){
          const neighbor = index + 1;
          if (!visited[neighbor] && pixels[neighbor * 4 + 3] <= TRANSPARENT_ALPHA){
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
        if (y > 0){
          const neighbor = index - width;
          if (!visited[neighbor] && pixels[neighbor * 4 + 3] <= TRANSPARENT_ALPHA){
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
        if (y < height - 1){
          const neighbor = index + width;
          if (!visited[neighbor] && pixels[neighbor * 4 + 3] <= TRANSPARENT_ALPHA){
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
      }

      if (!touchesEdge && area >= minimumArea){
        regions.push({
          area,
          x: minX / scale,
          y: minY / scale,
          width: (maxX - minX + 1) / scale,
          height: (maxY - minY + 1) / scale
        });
      }
    }

    if (regions.length !== EXPECTED_PHOTO_COUNT){
      throw new Error(
        'Khung phải có đúng ' + EXPECTED_PHOTO_COUNT +
        ' ô ảnh trong suốt; hệ thống nhận được ' + regions.length
      );
    }

    return sortSlotsInReadingOrder(regions.map(region => ({
      x: Math.max(0, Math.round(region.x)),
      y: Math.max(0, Math.round(region.y)),
      width: Math.max(1, Math.round(region.width)),
      height: Math.max(1, Math.round(region.height))
    })));
  }

  async function prepareFrame(frame){
    const cacheKey = frame.url + '|' + EXPECTED_PHOTO_COUNT;
    if (slotCache.has(cacheKey)) return slotCache.get(cacheKey);

    const overlay = await loadImage(frame.url);
    if (!overlay.naturalWidth || !overlay.naturalHeight){
      throw new Error('Ảnh khung không có kích thước hợp lệ');
    }
    if (overlay.naturalWidth * overlay.naturalHeight > MAX_OUTPUT_PIXELS){
      throw new Error('Ảnh khung quá lớn; hãy dùng ảnh dưới 36 megapixel');
    }

    const prepared = {
      overlay,
      slots: findTransparentSlots(overlay),
      width: overlay.naturalWidth,
      height: overlay.naturalHeight
    };
    slotCache.set(cacheKey, prepared);
    return prepared;
  }

  function selectedFrame(){
    return availableFrames.find(frame => frame.id === selectedFrameId) || null;
  }

  function clearDynamicCards(){
    if (!frameGrid) return;
    frameGrid.querySelectorAll('.frame-card[data-frame-source="dynamic"]').forEach(card => card.remove());
  }

  function renderCards(){
    if (!frameGrid) return;
    clearDynamicCards();

    availableFrames.forEach(frame => {
      const card = document.createElement('div');
      card.className = 'frame-card';
      card.dataset.frameSource = 'dynamic';
      card.dataset.frameId = frame.id;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'Chọn ' + frame.name);

      const image = document.createElement('img');
      image.className = 'frame-img';
      image.alt = frame.name;
      image.src = frame.url;

      const name = document.createElement('div');
      name.className = 'frame-name';
      name.textContent = frame.name;

      card.appendChild(image);
      card.appendChild(name);
      if (frame.id === selectedFrameId){
        frameGrid.querySelectorAll('.frame-card').forEach(item => item.classList.remove('selected'));
        card.classList.add('selected');
      }
      frameGrid.appendChild(card);
    });
  }

  function setStatus(message, isError){
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.classList.toggle('error', Boolean(isError));
    statusElement.hidden = !message;
  }

  async function validateAndDisplay(frames){
    const sequence = ++refreshSequence;
    if (refreshButton) refreshButton.disabled = true;
    setStatus('Đang quét khung PNG...', false);
    slotCache.clear();

    try {
      const results = await Promise.allSettled(frames.map(async frame => {
        await prepareFrame(frame);
        return frame;
      }));
      if (sequence !== refreshSequence) return;

      availableFrames = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
      const invalidCount = results.length - availableFrames.length;
      if (!availableFrames.some(frame => frame.id === selectedFrameId)) selectedFrameId = null;
      renderCards();

      if (invalidCount > 0){
        setStatus(
          'Đã nhận ' + availableFrames.length + ' khung hợp lệ; bỏ qua ' +
          invalidCount + ' khung không có đúng 3 ô trong suốt.',
          true
        );
      } else if (availableFrames.length > 0){
        setStatus('Đã cập nhật ' + availableFrames.length + ' khung PNG.', false);
      } else {
        setStatus('Không tìm thấy khung PNG hợp lệ.', false);
      }
    } catch (error){
      if (sequence !== refreshSequence) return;
      availableFrames = [];
      selectedFrameId = null;
      renderCards();
      setStatus(error.message || 'Không thể quét thư mục khung PNG.', true);
    } finally {
      if (sequence === refreshSequence && refreshButton) refreshButton.disabled = false;
    }
  }

  async function refresh(){
    const files = await chooseFrameFolder();
    if (files === null) return;
    if (files.length === 0){
      setStatus('Thư mục được chọn không có file PNG.', true);
      return;
    }
    await validateAndDisplay(framesFromFiles(files));
  }

  function bindGrid(){
    if (!frameGrid || frameGrid.dataset.dynamicFrameBound === 'true') return;
    frameGrid.dataset.dynamicFrameBound = 'true';

    frameGrid.addEventListener('click', event => {
      const card = event.target.closest('.frame-card');
      if (!card || !frameGrid.contains(card)) return;

      if (card.dataset.frameSource === 'dynamic'){
        selectedFrameId = card.dataset.frameId;
        frameGrid.querySelectorAll('.frame-card').forEach(item => item.classList.remove('selected'));
        card.classList.add('selected');
      } else {
        selectedFrameId = null;
      }
    });

    frameGrid.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('.frame-card[data-frame-source="dynamic"]');
      if (!card) return;
      event.preventDefault();
      card.click();
    });
  }

  function mount(options){
    frameGrid = options.grid;
    statusElement = options.statusElement || document.getElementById('frameScanStatus');
    refreshButton = document.getElementById('btnRefreshFrames');
    bindGrid();

    if (refreshButton && refreshButton.dataset.dynamicFrameBound !== 'true'){
      refreshButton.dataset.dynamicFrameBound = 'true';
      refreshButton.addEventListener('click', refresh);
    }

    renderCards();
    if (!hasLoadedOnce){
      hasLoadedOnce = true;
      validateAndDisplay(bundledFrames);
    }
  }

  async function applyPreview(options){
    const frame = selectedFrame();
    if (!frame) throw new Error('Chưa chọn khung PNG');
    if (options.shots.length !== EXPECTED_PHOTO_COUNT){
      throw new Error('Cần chọn đúng 3 ảnh trước khi ghép khung');
    }

    const prepared = await prepareFrame(frame);
    const frameImgElement = options.frameImgElement;
    const overlayElement = options.overlayElement;
    const photosGridElement = options.photosGridElement;

    frameImgElement.onerror = null;
    frameImgElement.src = frame.url;
    overlayElement.onerror = () => overlayElement.removeAttribute('src');
    overlayElement.src = frame.url;
    photosGridElement.innerHTML = '';

    prepared.slots.forEach((slot, index) => {
      const slotElement = document.createElement('div');
      slotElement.className = 'photo-slot';
      slotElement.style.left = (slot.x / prepared.width * 100) + '%';
      slotElement.style.top = (slot.y / prepared.height * 100) + '%';
      slotElement.style.width = (slot.width / prepared.width * 100) + '%';
      slotElement.style.height = (slot.height / prepared.height * 100) + '%';

      const image = document.createElement('img');
      image.src = options.shots[index];
      slotElement.appendChild(image);
      photosGridElement.appendChild(slotElement);
    });
  }

  function drawCover(context, image, slot){
    const sourceRatio = image.naturalWidth / image.naturalHeight;
    const targetRatio = slot.width / slot.height;
    let sourceWidth = image.naturalWidth;
    let sourceHeight = image.naturalHeight;
    let sourceX = 0;
    let sourceY = 0;

    if (sourceRatio > targetRatio){
      sourceWidth = image.naturalHeight * targetRatio;
      sourceX = (image.naturalWidth - sourceWidth) / 2;
    } else {
      sourceHeight = image.naturalWidth / targetRatio;
      sourceY = (image.naturalHeight - sourceHeight) / 2;
    }

    context.drawImage(
      image,
      sourceX, sourceY, sourceWidth, sourceHeight,
      slot.x, slot.y, slot.width, slot.height
    );
  }

  async function renderSelected(shots){
    const frame = selectedFrame();
    if (!frame) throw new Error('Chưa chọn khung PNG');
    if (shots.length !== EXPECTED_PHOTO_COUNT){
      throw new Error('Cần chọn đúng 3 ảnh trước khi xuất file');
    }

    const prepared = await prepareFrame(frame);
    const shotImages = await Promise.all(shots.map(loadImage));
    const canvas = document.createElement('canvas');
    canvas.width = prepared.width;
    canvas.height = prepared.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Trình duyệt không thể dựng ảnh cuối');

    shotImages.forEach((image, index) => drawCover(context, image, prepared.slots[index]));
    context.drawImage(prepared.overlay, 0, 0);
    return canvas.toDataURL('image/png');
  }

  window.DynamicFrameSystem = Object.freeze({
    mount,
    refresh,
    getSelectedFrame: selectedFrame,
    clearSelection(){ selectedFrameId = null; },
    applyPreview,
    renderSelected,
    inspectFrame: prepareFrame
  });
})();
