/* ============================================================================
   LUMINA · APP.JS
   ----------------------------------------------------------------------------
   Wires the entire UI to the Enhancers engine. This file owns:

     • File upload, drag & drop, validation, preview thumbnail
     • Engine card selection & radio sync
     • Scale slider ↔ label sync
     • Enhance / download / reset flow
     • Loading overlay with live progress
     • Toast notification system
     • Stepper visual advancement
     • Button hover glow effect
     • Smart preloading of engines

   Depends on: Enhancers (from enhancers.js)
   ============================================================================ */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // CONFIG
  // --------------------------------------------------------------------------
  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB upload limit
  const ALLOWED_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/bmp',
  ];
  const ENGINE_LABEL = {
    canvas: 'Canvas Classic',
    pica: 'Pica Resampler',
    ai: 'UpscalerJS (AI)',
  };

  // --------------------------------------------------------------------------
  // DOM REFS
  // --------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    // Upload
    fileInput: $('#file-input'),
    dropZone: $('#drop-zone'),
    fileInfo: $('#file-info'),
    thumbImg: $('#thumb-img'),
    fileName: $('#file-name'),
    fileSub: $('#file-sub'),
    clearFile: $('#clear-file'),

    // Engine selection
    engineCards: $$('.engine-card'),
    methodRadios: $$('input[name="method"]'),

    // Scale
    scaleInput: $('#scale-input'),
    scaleValue: $('#scale-value'),

    // Action
    enhanceBtn: $('#enhance-btn'),

    // Preview
    previewPanel: $('#preview-panel'),
    originalImg: $('#original-img'),
    enhancedImg: $('#enhanced-img'),
    originalInfo: $('#original-info'),
    enhancedInfo: $('#enhanced-info'),
    downloadBtn: $('#download-btn'),
    resetBtn: $('#reset-btn'),

    // Loader
    loader: $('#loader'),
    loaderTitle: $('#loader-title'),
    loaderText: $('#loader-text'),
    progressFill: $('#progress-fill'),

    // Toast & stepper
    toast: $('#toast'),
    steps: $$('.step'),
  };

  // --------------------------------------------------------------------------
  // STATE
  // --------------------------------------------------------------------------
  const state = {
    /** @type {File|null} */ file: null,
    /** @type {string|null} */ fileDataURL: null,
    /** @type {{name:string,w:number,h:number,size:number}|null} */ meta: null,
    /** @type {string|null} */ enhancedDataURL: null,
    /** @type {'canvas'|'pica'|'ai'} */ method: 'canvas',
    /** @type {number} */ scale: 2,
    /** @type {boolean} */ busy: false,
    /** @type {boolean} */ picaWarmed: false,
    /** @type {boolean} */ aiWarmed: false,
  };

  // --------------------------------------------------------------------------
  // SMALL UTILITIES
  // --------------------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatPixels(w, h) {
    const mp = (w * h) / 1_000_000;
    return `${w} × ${h} · ${mp >= 1 ? mp.toFixed(1) + ' MP' : Math.round(w * h / 1000) + 'K px'}`;
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
  }

  function safeName(name) {
    return (name || 'image')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'image';
  }

  // --------------------------------------------------------------------------
  // TOAST
  // --------------------------------------------------------------------------
  let toastTimer = null;

  /**
   * @param {string} msg
   * @param {'info'|'success'|'error'} [kind]
   * @param {number} [ms]
   */
  function toast(msg, kind = 'info', ms = 3200) {
    if (!els.toast) return;
    if (toastTimer) clearTimeout(toastTimer);

    els.toast.textContent = msg;
    els.toast.className = 'toast ' + kind;
    // Force reflow so animation restarts even on rapid consecutive calls
    void els.toast.offsetWidth;
    els.toast.classList.add('show');

    toastTimer = setTimeout(() => {
      els.toast.classList.remove('show');
    }, ms);
  }

  // --------------------------------------------------------------------------
  // LOADER / PROGRESS
  // --------------------------------------------------------------------------
  function openLoader(title = 'Enhancing your image…') {
    if (!els.loader) return;
    els.loaderTitle.textContent = title;
    els.loaderText.textContent = 'Preparing…';
    els.progressFill.style.width = '0%';
    els.loader.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function updateLoader(pct, msg) {
    if (!els.loader) return;
    const safe = clamp(Math.round(pct), 0, 100);
    els.progressFill.style.width = safe + '%';
    if (typeof msg === 'string') els.loaderText.textContent = msg;
  }

  function closeLoader() {
    if (!els.loader) return;
    els.loader.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // --------------------------------------------------------------------------
  // STEPPER
  // --------------------------------------------------------------------------
  /**
   * @param {1|2|3} current
   */
  function setStep(current) {
    els.steps.forEach((step) => {
      const num = Number(step.dataset.step);
      step.classList.remove('active', 'completed');
      if (num < current) step.classList.add('completed');
      else if (num === current) step.classList.add('active');
    });
  }

  // --------------------------------------------------------------------------
  // BUTTON GLOW (pointer-tracking radial highlight)
  // --------------------------------------------------------------------------
  function attachGlow(btn) {
    if (!btn) return;
    btn.addEventListener('mousemove', (e) => {
      const rect = btn.getBoundingClientRect();
      btn.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      btn.style.setProperty('--my', `${e.clientY - rect.top}px`);
    });
  }
  attachGlow(els.enhanceBtn);
  attachGlow(els.downloadBtn);

  // --------------------------------------------------------------------------
  // ENGINE SELECTION
  // --------------------------------------------------------------------------
  function setMethod(method) {
    if (!['canvas', 'pica', 'ai'].includes(method)) return;
    state.method = method;

    // Sync radios
    els.methodRadios.forEach((r) => {
      r.checked = r.value === method;
    });

    // Sync card visual state
    els.engineCards.forEach((card) => {
      card.classList.toggle('selected', card.dataset.engine === method);
    });

    // Opportunistic preload
    if (method === 'pica' && !state.picaWarmed) {
      state.picaWarmed = true;
      if (window.Enhancers && Enhancers.preloadPica) {
        Enhancers.preloadPica();
      }
    }
    if (method === 'ai' && !state.aiWarmed) {
      state.aiWarmed = true;
      toast('Loading AI model in background…', 'info', 2600);
      if (window.Enhancers && Enhancers.preloadAI) {
        Enhancers.preloadAI();
      }
    }

    refreshEnhanceButton();
  }

  els.engineCards.forEach((card) => {
    card.addEventListener('click', (e) => {
      // Let the native radio click do its thing, then sync state
      e.preventDefault();
      if (state.busy) return;
      setMethod(card.dataset.engine);
    });

    // Keyboard support
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (state.busy) return;
        setMethod(card.dataset.engine);
      }
    });

    // Make it focusable for keyboard navigation
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'radio');
  });

  els.methodRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) setMethod(radio.value);
    });
  });

  // --------------------------------------------------------------------------
  // SCALE SLIDER
  // --------------------------------------------------------------------------
  function setScale(val) {
    state.scale = clamp(Number(val) || 2, 1, 4);
    els.scaleInput.value = String(state.scale);
    els.scaleValue.textContent = state.scale + '×';

    // Fill-track visual (works via background gradient on the range)
    const pct = ((state.scale - 1) / 3) * 100;
    els.scaleInput.style.background =
      `linear-gradient(to right, var(--violet) 0%, var(--cyan) ${pct}%, rgba(255,255,255,0.08) ${pct}%, rgba(255,255,255,0.08) 100%)`;

    refreshEnhanceButton();
  }

  els.scaleInput.addEventListener('input', (e) => setScale(e.target.value));

  // --------------------------------------------------------------------------
  // ENHANCE BUTTON STATE
  // --------------------------------------------------------------------------
  function refreshEnhanceButton() {
    const canEnhance = !!state.fileDataURL && !state.busy;
    els.enhanceBtn.disabled = !canEnhance;
  }

  // --------------------------------------------------------------------------
  // FILE HANDLING
  // --------------------------------------------------------------------------
  function validateFile(file) {
    if (!file) return 'No file selected.';
    if (!file.type) return 'Unknown file type.';
    if (!ALLOWED_TYPES.includes(file.type.toLowerCase())) {
      return `Unsupported format "${file.type}". Use JPG, PNG, WebP, GIF, or BMP.`;
    }
    if (file.size > MAX_FILE_BYTES) {
      return `File is too large (${formatBytes(file.size)}). Max ${formatBytes(MAX_FILE_BYTES)}.`;
    }
    if (file.size === 0) {
      return 'File is empty.';
    }
    return null;
  }

  async function handleFile(file) {
    if (state.busy) {
      toast('Please wait for the current enhancement to finish.', 'info');
      return;
    }

    const error = validateFile(file);
    if (error) {
      toast(error, 'error');
      return;
    }

    try {
      const dataURL = await fileToDataURL(file);
      const img = await window.Enhancers.loadImage(dataURL);

      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) throw new Error('Image has no dimensions.');

      state.file = file;
      state.fileDataURL = dataURL;
      state.meta = { name: file.name, w, h, size: file.size };
      state.enhancedDataURL = null;

      // Populate file-info card
      els.thumbImg.src = dataURL;
      els.fileName.textContent = file.name;
      els.fileSub.textContent = `${formatBytes(file.size)} · ${w} × ${h}`;
      els.fileInfo.classList.remove('hidden');

      // Refresh preview original
      els.originalImg.src = dataURL;
      els.originalInfo.textContent = formatPixels(w, h);

      // Hide any previous preview until enhanced again
      els.previewPanel.classList.add('hidden');
      els.enhancedImg.removeAttribute('src');
      els.enhancedInfo.textContent = '—';
      els.downloadBtn.disabled = true;

      // Update stepper + button
      setStep(2);
      refreshEnhanceButton();

      toast(`Loaded ${file.name}`, 'success', 2000);
    } catch (e) {
      console.error('[Lumina] File handling failed:', e);
      toast(e.message || 'Could not load the image.', 'error');
      clearFile(true);
    }
  }

  function clearFile(silent = false) {
    state.file = null;
    state.fileDataURL = null;
    state.meta = null;
    state.enhancedDataURL = null;

    els.fileInput.value = '';
    els.thumbImg.removeAttribute('src');
    els.fileName.textContent = '—';
    els.fileSub.textContent = '—';
    els.fileInfo.classList.add('hidden');

    els.originalImg.removeAttribute('src');
    els.enhancedImg.removeAttribute('src');
    els.previewPanel.classList.add('hidden');
    els.originalInfo.textContent = '—';
    els.enhancedInfo.textContent = '—';
    els.downloadBtn.disabled = true;

    setStep(1);
    refreshEnhanceButton();

    if (!silent) toast('File removed.', 'info', 1800);
  }

  // Wire the file input
  els.fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleFile(file);
  });

  // Wire the clear button
  els.clearFile.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.busy) return;
    clearFile();
  });

  // --------------------------------------------------------------------------
  // DRAG & DROP
  // --------------------------------------------------------------------------
  let dragCounter = 0;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  els.dropZone.addEventListener('dragenter', (e) => {
    dragCounter++;
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      els.dropZone.classList.add('dragover');
    }
  });

  els.dropZone.addEventListener('dragover', (e) => {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  els.dropZone.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) els.dropZone.classList.remove('dragover');
  });

  els.dropZone.addEventListener('drop', (e) => {
    dragCounter = 0;
    els.dropZone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // Keyboard access: Enter/Space on the drop zone opens the file picker
  els.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  // --------------------------------------------------------------------------
  // ENHANCE FLOW
  // --------------------------------------------------------------------------
  async function runEnhance() {
    if (state.busy) return;
    if (!state.fileDataURL) {
      toast('Please upload an image first.', 'error');
      return;
    }
    if (!window.Enhancers) {
      toast('Enhancement library did not load. Reload the page.', 'error');
      return;
    }

    state.busy = true;
    refreshEnhanceButton();
    openLoader(`Enhancing with ${ENGINE_LABEL[state.method]}…`);
    setStep(3);

    const t0 = performance.now();

    try {
      const result = await window.Enhancers.enhance(
        state.fileDataURL,
        state.method,
        state.scale,
        {
          onProgress: (pct, msg) => updateLoader(pct, msg),
          onLog: (msg) => console.log('[Lumina]', msg),
        }
      );

      state.enhancedDataURL = result;

      // Load enhanced image to read its dimensions
      const enhancedImg = await window.Enhancers.loadImage(result);
      const ew = enhancedImg.naturalWidth;
      const eh = enhancedImg.naturalHeight;

      els.enhancedImg.src = result;
      els.enhancedInfo.textContent = formatPixels(ew, eh);
      els.previewPanel.classList.remove('hidden');
      els.downloadBtn.disabled = false;

      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      updateLoader(100, 'Complete');
      toast(`Enhanced in ${dt}s → ${ew} × ${eh}`, 'success', 3600);

      // Smooth-scroll the preview into view
      setTimeout(() => {
        els.previewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 200);
    } catch (err) {
      console.error('[Lumina] Enhancement error:', err);
      toast(err.message || 'Enhancement failed.', 'error', 5000);
      setStep(2);
    } finally {
      state.busy = false;
      refreshEnhanceButton();
      setTimeout(closeLoader, 350);
    }
  }

  els.enhanceBtn.addEventListener('click', runEnhance);

  // --------------------------------------------------------------------------
  // DOWNLOAD
  // --------------------------------------------------------------------------
  els.downloadBtn.addEventListener('click', () => {
    if (!state.enhancedDataURL || !state.meta) {
      toast('Nothing to download yet.', 'error');
      return;
    }

    try {
      const base = safeName(state.meta.name).replace(/\.[^.]+$/, '');
      const mime = window.Enhancers.mimeFromDataURL(state.enhancedDataURL) || 'image/png';
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
      const filename = `${base}_enhanced_${state.scale}x.${ext}`;

      const a = document.createElement('a');
      a.href = state.enhancedDataURL;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      toast(`Downloaded ${filename}`, 'success', 2600);
    } catch (e) {
      console.error('[Lumina] Download failed:', e);
      toast('Could not start the download.', 'error');
    }
  });

  // --------------------------------------------------------------------------
  // RESET
  // --------------------------------------------------------------------------
  els.resetBtn.addEventListener('click', () => {
    if (state.busy) {
      toast('Please wait for the enhancement to finish.', 'info');
      return;
    }
    clearFile();
    els.dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    els.dropZone.focus({ preventScroll: true });
  });

  // --------------------------------------------------------------------------
  // PAGE-LEVEL DRAG & DROP GUARD
  // Prevents accidental navigation when a file is dropped outside the zone.
  // --------------------------------------------------------------------------
  ['dragover', 'drop'].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      if (e.target === els.dropZone || els.dropZone.contains(e.target)) return;
      e.preventDefault();
      if (evt === 'drop') {
        toast('Drop the image into the upload area.', 'info', 2400);
      }
    });
  });

  // --------------------------------------------------------------------------
  // SMART PRELOAD
  // Warm up the currently selected engine on first user interaction so the
  // first enhancement feels snappy. Uses passive listeners to stay fast.
  // --------------------------------------------------------------------------
  function warmSelectedEngine() {
    if (!window.Enhancers) return;
    if (state.method === 'pica' && !state.picaWarmed) {
      state.picaWarmed = true;
      Enhancers.preloadPica();
    }
    if (state.method === 'ai' && !state.aiWarmed) {
      state.aiWarmed = true;
      Enhancers.preloadAI();
    }
  }

  els.scaleInput.addEventListener('pointerdown', warmSelectedEngine, { once: true });
  els.enhanceBtn.addEventListener('pointerenter', warmSelectedEngine, { once: true });

  // --------------------------------------------------------------------------
  // INIT
  // --------------------------------------------------------------------------
  function init() {
    setMethod('canvas');
    setScale(2);
    setStep(1);
    refreshEnhanceButton();

    // Verify the engine library is present
    if (!window.Enhancers) {
      console.error('[Lumina] Enhancers not loaded.');
      toast('Enhancement library failed to load.', 'error', 6000);
      return;
    }

    // Log engine readiness once things settle
    setTimeout(() => {
      const s = window.Enhancers.status();
      console.log('[Lumina] Engine status:', s);
    }, 800);

    console.log('[Lumina] App initialised — ready to enhance.');
  }

  // Wait for DOMContentLoaded in case this script loads earlier than expected
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
