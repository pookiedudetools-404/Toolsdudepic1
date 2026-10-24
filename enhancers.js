/* ============================================================================
   LUMINA · ENHANCERS.JS
   ----------------------------------------------------------------------------
   Three real, working image enhancement engines that run fully client-side.

   Engine 1 · Canvas Classic
       Native bicubic resampling via Canvas API with an unsharp mask
       convolution pass. Zero external dependencies.

   Engine 2 · Pica
       Lanczos resampling via Pica.js (WebAssembly). Excellent color
       fidelity, built-in unsharp masking.

   Engine 3 · UpscalerJS (AI)
       Neural network super-resolution via TensorFlow.js. The default
       ESRGAN model is 2×; we handle 3× (2× AI + 1.5× canvas) and
       4× (two AI passes) transparently.

   Public API (window.Enhancers):
       enhance(dataURL, method, scale, { onProgress, onLog }) → Promise<dataURL>
       preloadPica()  → warm up Pica
       preloadAI()    → warm up TensorFlow + AI model
       loadImage(src) → Promise<HTMLImageElement>
   ============================================================================ */

(function () {
  'use strict';

  // ==========================================================================
  // CONSTANTS & GUARDS
  // ==========================================================================

  /** Hard limit on output pixel count to protect against browser crashes.
   *  80 MP ≈ 8K × 10K — generous but safe on modern hardware. */
  const MAX_OUTPUT_PIXELS = 80_000_000;

  /** Threshold above which main-thread sharpening becomes too slow.
   *  (12 MP ≈ a 4000 × 3000 photo.) Above this we skip sharpening. */
  const SHARPEN_PIXEL_LIMIT = 12_000_000;

  /** Delay helper used to let the browser repaint between sync steps. */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Basic runtime flag so we only log once per session for missing libs. */
  const reported = { pica: false, tf: false, upscaler: false };

  // ==========================================================================
  // IMAGE / CANVAS UTILITIES
  // ==========================================================================

  /**
   * Load an image from any URL or dataURL into an HTMLImageElement.
   * @param {string} src
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(new Error('Could not load the image. It may be corrupted.'));
      img.src = src;
    });
  }

  /** Create an offscreen canvas with explicit dimensions. */
  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /**
   * Serialize a canvas to a dataURL. Defaults to high-quality JPEG for
   * photographs and PNG for graphics. We detect from the source mime.
   */
  function canvasToDataURL(canvas, type = 'image/png', quality = 0.95) {
    try {
      return canvas.toDataURL(type, quality);
    } catch (e) {
      // Some browsers throw on very large PNGs — fall back to JPEG
      return canvas.toDataURL('image/jpeg', 0.92);
    }
  }

  /** Pick the output format that matches the source format as closely as possible. */
  function chooseOutputType(srcMime) {
    if (!srcMime) return 'image/png';
    if (srcMime === 'image/jpeg' || srcMime === 'image/jpg') return 'image/jpeg';
    if (srcMime === 'image/webp') return 'image/webp';
    return 'image/png';
  }

  /** Extract mime from a dataURL ("data:image/png;base64,..."). */
  function mimeFromDataURL(dataURL) {
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) return '';
    const semi = dataURL.indexOf(';');
    return semi > 5 ? dataURL.slice(5, semi) : '';
  }

  /** Throw early if the requested output is too large for the browser. */
  function assertSizeOk(w, h) {
    const px = w * h;
    if (px > MAX_OUTPUT_PIXELS) {
      const mp = (px / 1_000_000).toFixed(1);
      throw new Error(
        `Output would be ${mp} megapixels — too large. ` +
          `Try a smaller upscale factor or a smaller source image.`
      );
    }
  }

  // ==========================================================================
  // SHARPENING (Unsharp mask via 3×3 convolution)
  // ==========================================================================

  /**
   * Apply a mild unsharp mask to a canvas in-place.
   * The kernel is a classic 4-neighbour Laplacian sharpen.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} amount 0..1 — higher = stronger sharpening
   */
  function sharpenCanvas(canvas, amount = 0.35) {
    const { width: w, height: h } = canvas;
    if (w * h > SHARPEN_PIXEL_LIMIT) return; // too slow; skip silently

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, w, h);
    } catch {
      // Canvas may be tainted (unlikely here) — skip
      return;
    }

    const data = imageData.data;
    const out = new Uint8ClampedArray(data.length);

    // 3×3 sharpen kernel, centre = 1 + 4·amount, neighbours = -amount
    const k0 = -amount;
    const k1 = 1 + 4 * amount;

    for (let y = 0; y < h; y++) {
      const rowUp = (y > 0 ? y - 1 : 0) * w;
      const rowMid = y * w;
      const rowDn = (y < h - 1 ? y + 1 : h - 1) * w;

      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < w - 1 ? x + 1 : w - 1;

        const iC = (rowMid + x) * 4;
        const iU = (rowUp + x) * 4;
        const iD = (rowDn + x) * 4;
        const iL = (rowMid + xm) * 4;
        const iR = (rowMid + xp) * 4;

        out[iC] =
          data[iU] * k0 + data[iD] * k0 + data[iL] * k0 + data[iR] * k0 +
          data[iC] * k1;
        out[iC + 1] =
          data[iU + 1] * k0 + data[iD + 1] * k0 + data[iL + 1] * k0 +
          data[iR + 1] * k0 + data[iC + 1] * k1;
        out[iC + 2] =
          data[iU + 2] * k0 + data[iD + 2] * k0 + data[iL + 2] * k0 +
          data[iR + 2] * k0 + data[iC + 2] * k1;
        out[iC + 3] = data[iC + 3];
      }
    }

    ctx.putImageData(new ImageData(out, w, h), 0, 0);
  }

  // ==========================================================================
  // ENGINE 1 · CANVAS CLASSIC
  // ==========================================================================

  async function enhanceCanvas(img, scale, progress) {
    progress(8, 'Reading source image…');
    await sleep(30);

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);

    assertSizeOk(w, h);

    progress(25, 'Bicubic resampling…');
    await sleep(30);

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    // Sharpen amount tapers as scale grows to avoid halos
    const sharpenAmount = scale <= 2 ? 0.35 : scale === 3 ? 0.25 : 0.18;

    progress(55, 'Applying unsharp mask…');
    await sleep(20);
    sharpenCanvas(canvas, sharpenAmount);

    progress(88, 'Encoding output…');
    await sleep(20);

    const mime = mimeFromDataURL(img.src) || 'image/png';
    const type = chooseOutputType(mime);
    const dataURL = canvasToDataURL(canvas, type, 0.95);

    progress(100, 'Done');
    return dataURL;
  }

  // ==========================================================================
  // ENGINE 2 · PICA (Lanczos)
  // ==========================================================================

  async function ensurePica() {
    if (typeof window.pica !== 'function') {
      if (!reported.pica) {
        console.error('[Lumina] Pica library not found on window.');
        reported.pica = true;
      }
      throw new Error(
        'Pica library failed to load. Check your internet connection and reload.'
      );
    }
    if (!window.__luminaPica) {
      window.__luminaPica = window.pica({
        features: ['js', 'wasm', 'ww'],
      });
    }
    return window.__luminaPica;
  }

  async function enhancePica(img, scale, progress) {
    progress(8, 'Loading Pica engine…');
    const picaInstance = await ensurePica();

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);

    assertSizeOk(w, h);

    progress(30, 'Lanczos resampling (WASM)…');
    await sleep(20);

    const canvas = createCanvas(w, h);
    await picaInstance.resize(img, canvas, {
      quality: 3,
      alpha: true,
      unsharpAmount: 80,
      unsharpRadius: 0.6,
      unsharpThreshold: 2,
    });

    progress(85, 'Encoding output…');
    await sleep(20);

    const mime = mimeFromDataURL(img.src) || 'image/png';
    const type = chooseOutputType(mime);
    const dataURL = canvasToDataURL(canvas, type, 0.95);

    progress(100, 'Done');
    return dataURL;
  }

  // ==========================================================================
  // ENGINE 3 · UPSCALERJS (AI / TensorFlow)
  // ==========================================================================

  /** Locate the Upscaler class across UMD build variants. */
  function findUpscalerClass() {
    const ns = window.upscaler;
    if (!ns) return null;
    if (ns.Upscaler) return ns.Upscaler;
    if (typeof ns === 'function') return ns;
    return null;
  }

  /** Locate the default ESRGAN model across UMD build variants. */
  function findDefaultModel() {
    const candidates = [
      window.UpscalerJSDefaultModel,
      window.DefaultModel,
      window.upscalerjsDefaultModel,
      window.upscaler && window.upscaler.model,
      window.upscaler && window.upscaler.defaultModel,
    ];
    for (const c of candidates) {
      if (!c) continue;
      // Sometimes the global wraps the model under `.default`
      if (c.default) return c.default;
      return c;
    }
    return null;
  }

  async function ensureAI(progress) {
    if (typeof window.tf === 'undefined') {
      if (!reported.tf) {
        console.error('[Lumina] TensorFlow.js not found on window.');
        reported.tf = true;
      }
      throw new Error(
        'TensorFlow.js failed to load. Check your internet connection.'
      );
    }

    const UpscalerClass = findUpscalerClass();
    if (!UpscalerClass) {
      if (!reported.upscaler) {
        console.error('[Lumina] UpscalerJS not found on window.');
        reported.upscaler = true;
      }
      throw new Error(
        'UpscalerJS failed to load. Check your internet connection.'
      );
    }

    if (window.__luminaUpscaler) return window.__luminaUpscaler;

    progress(5, 'Downloading AI model (first time only)…');

    const model = findDefaultModel();
    if (!model) {
      throw new Error(
        'AI model not available. Try the Canvas or Pica engine, or reload the page.'
      );
    }

    // Give TF.js a tick to warm up
    try {
      await window.tf.ready();
    } catch {
      /* non-fatal */
    }

    try {
      window.__luminaUpscaler = new UpscalerClass({ model });
    } catch (e) {
      throw new Error(
        'Could not initialise the AI upscaler: ' + (e?.message || 'unknown error')
      );
    }
    return window.__luminaUpscaler;
  }

  /** Normalize whatever the upscaler returns into a dataURL string. */
  async function normalizeAIResult(result) {
    if (!result) throw new Error('AI returned no output.');
    if (typeof result === 'string') return result;
    if (result instanceof HTMLCanvasElement) return result.toDataURL();
    if (typeof result.toDataURL === 'function') return result.toDataURL();

    // Tensor fallback: expected shape [h, w, 3] with values in 0..255.
    if (typeof result.data === 'function' && Array.isArray(result.shape)) {
      const data = await result.data();
      const [h, w] = result.shape;
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      const id = ctx.createImageData(w, h);
      const maxVal = Math.max(...data.slice(0, Math.min(data.length, 1000)));
      const scaleFactor = maxVal <= 1.01 ? 255 : 1;
      for (let i = 0; i < w * h; i++) {
        id.data[i * 4] = data[i * 3] * scaleFactor;
        id.data[i * 4 + 1] = data[i * 3 + 1] * scaleFactor;
        id.data[i * 4 + 2] = data[i * 3 + 2] * scaleFactor;
        id.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      return c.toDataURL();
    }

    throw new Error('Unrecognised AI output format.');
  }

  /**
   * One AI pass. The default ESRGAN model is fixed at 2×. Runs with a fake
   * progress ticker because the model doesn't expose per-patch events.
   */
  async function aiSinglePass(upscaler, inputSrc, progress, base, span, label) {
    progress(base, label + ' — please wait…');
    await sleep(60);

    let fake = 0.02;
    const ticker = setInterval(() => {
      fake = Math.min(0.92, fake + 0.018);
      const pct = base + Math.round(span * fake);
      progress(pct, label);
    }, 700);

    let result;
    try {
      // The upscale method can take a dataURL string directly
      result = await upscaler.upscale(inputSrc);
    } finally {
      clearInterval(ticker);
    }

    progress(base + span, label + ' — done');
    return normalizeAIResult(result);
  }

  async function enhanceAI(img, scale, progress) {
    const upscaler = await ensureAI(progress);
    const sourceSrc = img.src;

    // 1× — no AI needed, just re-encode (rare but handled)
    if (scale === 1) {
      progress(70, 'Re-encoding source…');
      await sleep(20);
      const c = createCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, 0, 0);
      progress(100, 'Done');
      return c.toDataURL();
    }

    // First AI pass → 2×
    let current = await aiSinglePass(
      upscaler,
      sourceSrc,
      progress,
      10,
      45,
      'AI super-resolution pass 1/2'
    );

    if (scale === 2) {
      progress(100, 'Done');
      return current;
    }

    if (scale === 4) {
      // Second AI pass → 4×
      current = await aiSinglePass(
        upscaler,
        current,
        progress,
        55,
        40,
        'AI super-resolution pass 2/2'
      );
      progress(100, 'Done');
      return current;
    }

    if (scale === 3) {
      // 2× AI + 1.5× canvas finish
      progress(60, 'Finishing with canvas 1.5×…');
      await sleep(20);
      const img2 = await loadImage(current);
      const w = Math.round(img2.naturalWidth * 1.5);
      const h = Math.round(img2.naturalHeight * 1.5);
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img2, 0, 0, w, h);
      sharpenCanvas(c, 0.15);
      progress(100, 'Done');
      return c.toDataURL();
    }

    // Unknown scale — return the 2× result
    progress(100, 'Done');
    return current;
  }

  // ==========================================================================
  // PUBLIC DISPATCHER
  // ==========================================================================

  /**
   * Enhance an image with the chosen engine.
   *
   * @param {string} imageSrc   dataURL or blob URL of the source image
   * @param {'canvas'|'pica'|'ai'} method
   * @param {number} scale      1, 2, 3, or 4
   * @param {object} callbacks
   * @param {(pct:number, msg:string)=>void} [callbacks.onProgress]
   * @param {(msg:string)=>void}             [callbacks.onLog]
   * @returns {Promise<string>} enhanced dataURL
   */
  async function enhance(imageSrc, method, scale, callbacks = {}) {
    const onProgress =
      typeof callbacks.onProgress === 'function'
        ? callbacks.onProgress
        : () => {};
    const onLog =
      typeof callbacks.onLog === 'function' ? callbacks.onLog : () => {};

    if (!imageSrc) throw new Error('No image provided.');

    scale = Math.max(1, Math.min(4, Number(scale) || 1));

    onLog(`Enhance start · method=${method} scale=${scale}×`);
    onProgress(0, 'Preparing…');

    let img;
    try {
      img = await loadImage(imageSrc);
    } catch (e) {
      throw new Error('Could not read the source image.');
    }

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) throw new Error('Source image has no dimensions.');

    onLog(`Source size: ${srcW} × ${srcH} px`);

    let result;
    try {
      if (method === 'canvas') {
        result = await enhanceCanvas(img, scale, onProgress);
      } else if (method === 'pica') {
        result = await enhancePica(img, scale, onProgress);
      } else if (method === 'ai') {
        result = await enhanceAI(img, scale, onProgress);
      } else {
        throw new Error(`Unknown enhancement method: "${method}".`);
      }
    } catch (err) {
      onLog(`Enhancement failed: ${err.message}`);
      throw err;
    }

    if (typeof result !== 'string' || !result.startsWith('data:')) {
      throw new Error('Enhancement produced an invalid output.');
    }

    onLog('Enhance complete.');
    return result;
  }

  // ==========================================================================
  // PUBLIC API SURFACE
  // ==========================================================================

  window.Enhancers = {
    enhance,
    loadImage,
    canvasToDataURL,
    mimeFromDataURL,

    /** Warm up Pica so the first enhancement is instant. */
    preloadPica: () => ensurePica().catch(() => {}),

    /** Warm up TensorFlow + AI model in the background. */
    preloadAI: () => ensureAI(() => {}).catch(() => {}),

    /** Diagnostics for debugging in DevTools. */
    status() {
      return {
        pica: typeof window.pica === 'function',
        tf: typeof window.tf !== 'undefined',
        upscaler: !!findUpscalerClass(),
        model: !!findDefaultModel(),
        picaWarmed: !!window.__luminaPica,
        aiWarmed: !!window.__luminaUpscaler,
      };
    },
  };

  // ==========================================================================
  // BOOT LOG
  // ==========================================================================

  // Defer the check so the CDN script tags have finished executing.
  setTimeout(() => {
    const s = window.Enhancers.status();
    const missing = Object.entries(s)
      .filter(([k, v]) => (k === 'pica' || k === 'tf' || k === 'upscaler' || k === 'model') && !v)
      .map(([k]) => k);

    if (missing.length) {
      console.warn(
        '[Lumina] Enhancers loaded, but some libraries are missing:',
        missing.join(', ')
      );
    } else {
      console.log('[Lumina] Enhancers ready — all engines available.');
    }
  }, 500);
})();
