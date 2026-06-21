// ==UserScript==
// @name         Full UG Bot
// @namespace    ug-bot
// @version      2.7.3
// @description  Auto-runs crimes, GTA, melting, repair, missions, drug running with Swiss Bank management, live log, session stats, action checkboxes, jail handling, runtime tracking, melt pagination, repair cycles, automatic CTC solving, and point-spending features.
// @match        *://www.underworldgangsters.com/*
// @match        *://underworldgangsters.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getTab
// @grant        GM_saveTab
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/ssdddssdfswee/ugbot/main/ug-bot.user.js
// @downloadURL  https://raw.githubusercontent.com/ssdddssdfswee/ugbot/main/ug-bot.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ── Checkbox/radio zoom fix ──────────────────────────────────────────────
    // Chromium browsers apply a pop/zoom animation to checkbox/radio inputs.
    // Injected at document-start (before the load watchdog) so the style is
    // present before any checkboxes/radios are painted.
    try {
        const ugCheckboxFixStyle = document.createElement('style');
        ugCheckboxFixStyle.textContent = `
            input[type="checkbox"],
            input[type="radio"] {
                transition: none !important;
                animation: none !important;
                transform: none !important;
                scale: 1 !important;
                zoom: 1 !important;
            }
        `;
        document.documentElement.appendChild(ugCheckboxFixStyle);
    } catch (e) {
        console.warn('[UG-BOT] Could not inject checkbox/radio zoom fix:', e);
    }

    // ── Page load watchdog ────────────────────────────────────────────────────
    // If the page never fires the load event (stuck mid-load due to lag),
    // navigate to the same URL as a fresh GET after 60 seconds.
    // Uses href assignment rather than reload() to avoid POST resubmission prompts.
    const _ugLoadWatchdog = setTimeout(() => {
        if (document.readyState !== 'complete') {
            window.location.href = window.location.href;
        }
    }, 60000);
    window.addEventListener('load', () => {
        clearTimeout(_ugLoadWatchdog);
        try {
            const _ugErrorTitles = [
                'err_', 'problem loading', 'server not found',
                'site can\'t be reached', 'unable to connect',
                'connection timed out', 'connection refused',
                'this page isn\'t working', 'hmm. we\'re having trouble'
            ];
            const _ugTitle = (document.title || '').toLowerCase();
            const _ugIsErrorPage = _ugErrorTitles.some(e => _ugTitle.includes(e))
                || (!document.querySelector('#nav') && document.body && document.body.childElementCount < 5);
            if (_ugIsErrorPage) {
                setTimeout(() => { window.location.href = window.location.href; }, 15000);
            }
        } catch (e) {
            console.warn('[UG-BOT] Connection error watchdog failed:', e);
        }
    });

    // Suppress native alert() dialogs from the game's own scripts.
    // Tampermonkey sandboxes the userscript window from the page window, so
    // directly overriding window.alert has no effect on the page's scripts.
    // Instead we inject a <script> tag into the page's own DOM context at
    // document-start, before any game scripts load, so our override is in
    // place before the AJAX error handler is ever defined.
    try {
        const s = document.createElement('script');
        s.textContent = 'window.alert = function(msg){ console.warn("[UG-BOT] Suppressed alert:", msg); };';
        document.documentElement.appendChild(s);
        s.remove();
    } catch (e) {
        console.warn('[UG-BOT] Could not inject alert suppression:', e);
    }

    // Bot initialisation — window.onload fires after the page is fully ready
    // including all scripts and resources, making it the most reliable trigger.
    window.addEventListener('load', function () {

    // =========================================================================
    // CTC SOLVER
    // =========================================================================

    const CTC = (function () {
        const SIMILARITY_FLOOR    = 0.70;
        const SCORE_GAP_FLOOR     = 0.03;
        const SOLVE_TIMEOUT_MS    = 10000;
        const NORM_SIZE           = 128;
        const COLOR_THRESHOLD     = 40;
        const SETTLE_DELAY_MS     = 300;
        const BLANK_THRESHOLD     = 0.01;
        const ROTATION_MAX_DEG    = 30;
        const ANGLE_OFFSETS       = [-10, -5, 0, 5, 10];

        // Pre-computed Gaussian weights for gaussianSimilarity.
        // Calculated once at script load — avoids recalculating 16,384 Math.exp()
        // calls on every comparison (20 comparisons per CTC solve).
        const GAUSSIAN_WEIGHTS = (() => {
            const size  = 128; // NORM_SIZE
            const cx    = size / 2, cy = size / 2;
            const sigma = size / 4;
            const twoSigSq = 2 * sigma * sigma;
            const weights = new Float32Array(size * size);
            for (let i = 0; i < size * size; i++) {
                const x = i % size, y = Math.floor(i / size);
                const dx = x - cx, dy = y - cy;
                weights[i] = Math.exp(-(dx*dx + dy*dy) / twoSigSq);
            }
            return weights;
        })();

        // ── Image processing ──────────────────────────────────────────────────

        let isSolving = false;

        function loadImage(src) {
            const busted = src + (src.includes('?') ? '&' : '?') + '_=' + Date.now();
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload  = () => resolve(img);
                img.onerror = () => reject(new Error('Failed to load: ' + src));
                img.src = busted;
            });
        }

        function waitForImageLoad(img, timeoutMs = 5000) {
            if (img.naturalWidth > 0) return Promise.resolve(img);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Image load timed out')), timeoutMs);
                img.onload  = () => { clearTimeout(timer); resolve(img); };
                img.onerror = () => { clearTimeout(timer); reject(new Error('Image error')); };
            });
        }

        async function resolveImage(el) {
            if (el.tagName === 'IMG')   return waitForImageLoad(el);
            if (el.tagName === 'INPUT') return loadImage(el.src);
            throw new Error('Unsupported element: ' + el.tagName);
        }

        function imageToCanvas(img) {
            const c = document.createElement('canvas');
            c.width  = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            return c;
        }

        function toBinaryCanvas(canvas) {
            const ctx  = canvas.getContext('2d');
            const { width, height } = canvas;
            const src  = ctx.getImageData(0, 0, width, height);
            const out  = document.createElement('canvas');
            out.width  = width;
            out.height = height;
            const octx = out.getContext('2d');
            const dst  = octx.createImageData(width, height);
            for (let i = 0; i < src.data.length; i += 4) {
                const lit = Math.max(src.data[i], src.data[i+1], src.data[i+2]) > COLOR_THRESHOLD ? 255 : 0;
                dst.data[i]   = lit;
                dst.data[i+1] = lit;
                dst.data[i+2] = lit;
                dst.data[i+3] = 255;
            }
            octx.putImageData(dst, 0, 0);
            return out;
        }

        function dilate(binaryCanvas, radius = 1) {
            const { width, height } = binaryCanvas;
            const src  = binaryCanvas.getContext('2d').getImageData(0, 0, width, height);
            const out  = document.createElement('canvas');
            out.width  = width;
            out.height = height;
            const ctx  = out.getContext('2d');
            const dst  = ctx.createImageData(width, height);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    let lit = false;
                    outer: for (let dy = -radius; dy <= radius; dy++) {
                        for (let dx = -radius; dx <= radius; dx++) {
                            const nx = x + dx, ny = y + dy;
                            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                            if (src.data[(ny * width + nx) * 4] > 127) { lit = true; break outer; }
                        }
                    }
                    const i = (y * width + x) * 4;
                    const v = lit ? 255 : 0;
                    dst.data[i] = dst.data[i+1] = dst.data[i+2] = v;
                    dst.data[i+3] = 255;
                }
            }
            ctx.putImageData(dst, 0, 0);
            return out;
        }

        function cropToContent(canvas) {
            const ctx = canvas.getContext('2d');
            const { width, height } = canvas;
            const { data } = ctx.getImageData(0, 0, width, height);
            let minX = width, minY = height, maxX = -1, maxY = -1;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = (y * width + x) * 4;
                    if (Math.max(data[i], data[i+1], data[i+2]) > COLOR_THRESHOLD) {
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < minX || maxY < minY) return null;
            const pad  = 3;
            minX = Math.max(0, minX - pad);
            minY = Math.max(0, minY - pad);
            maxX = Math.min(width - 1,  maxX + pad);
            maxY = Math.min(height - 1, maxY + pad);
            const out = document.createElement('canvas');
            out.width  = maxX - minX + 1;
            out.height = maxY - minY + 1;
            out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
            return out;
        }

        function rotateCanvas(canvas, angleDeg) {
            if (angleDeg === 0) return canvas;
            const rad  = angleDeg * Math.PI / 180;
            const { width: w, height: h } = canvas;
            const cos  = Math.abs(Math.cos(rad));
            const sin  = Math.abs(Math.sin(rad));
            const outW = Math.ceil(w * cos + h * sin);
            const outH = Math.ceil(w * sin + h * cos);
            const out  = document.createElement('canvas');
            out.width  = outW;
            out.height = outH;
            const ctx  = out.getContext('2d');
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, outW, outH);
            ctx.translate(outW / 2, outH / 2);
            ctx.rotate(rad);
            ctx.drawImage(canvas, -w / 2, -h / 2);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            return out;
        }

        function estimateRotationAngle(binaryCanvas) {
            const ctx = binaryCanvas.getContext('2d');
            const { width, height } = binaryCanvas;
            const { data } = ctx.getImageData(0, 0, width, height);
            let m00 = 0, m10 = 0, m01 = 0;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (data[(y * width + x) * 4] > 127) { m00++; m10 += x; m01 += y; }
                }
            }
            if (m00 === 0) return 0;
            const cx = m10 / m00, cy = m01 / m00;
            let m11 = 0, m20 = 0, m02 = 0;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (data[(y * width + x) * 4] > 127) {
                        const dx = x - cx, dy = y - cy;
                        m11 += dx * dy; m20 += dx * dx; m02 += dy * dy;
                    }
                }
            }
            const angle = 0.5 * Math.atan2(2 * m11, m20 - m02) * 180 / Math.PI;
            return Math.max(-ROTATION_MAX_DEG, Math.min(ROTATION_MAX_DEG, angle));
        }

        function normaliseToBits(cropped) {
            if (!cropped) return null;
            const out  = document.createElement('canvas');
            out.width  = NORM_SIZE;
            out.height = NORM_SIZE;
            const ctx  = out.getContext('2d');
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, NORM_SIZE, NORM_SIZE);
            const scale = Math.min(NORM_SIZE / cropped.width, NORM_SIZE / cropped.height);
            const drawW = Math.max(1, Math.round(cropped.width  * scale));
            const drawH = Math.max(1, Math.round(cropped.height * scale));
            const offX  = Math.floor((NORM_SIZE - drawW) / 2);
            const offY  = Math.floor((NORM_SIZE - drawH) / 2);
            ctx.drawImage(cropped, offX, offY, drawW, drawH);
            const { data } = ctx.getImageData(0, 0, NORM_SIZE, NORM_SIZE);
            const bits = new Uint8Array(NORM_SIZE * NORM_SIZE);
            for (let i = 0, p = 0; i < data.length; i += 4, p++) {
                bits[p] = data[i] > 127 ? 1 : 0;
            }
            return bits;
        }

        function prepareCanvas(canvas) {
            const binary  = toBinaryCanvas(canvas);
            const dilated = dilate(binary, 1);
            const angle   = estimateRotationAngle(dilated);
            return { dilated, angle };
        }

        function fingerprintAtAngle(dilatedCanvas, angleDeg) {
            const rotated = angleDeg !== 0 ? rotateCanvas(dilatedCanvas, angleDeg) : dilatedCanvas;
            const cropped = cropToContent(rotated);
            return normaliseToBits(cropped);
        }

        function isBlankFingerprint(bits) {
            if (!bits) return true;
            let litPixels = 0;
            for (let i = 0; i < bits.length; i++) { if (bits[i] === 1) litPixels++; }
            return litPixels / bits.length < BLANK_THRESHOLD;
        }

        function gaussianSimilarity(bitsA, bitsB) {
            let weightedMatches = 0, totalWeight = 0;
            for (let i = 0; i < bitsA.length; i++) {
                const w = GAUSSIAN_WEIGHTS[i];
                if (bitsA[i] === bitsB[i]) weightedMatches += w;
                totalWeight += w;
            }
            return weightedMatches / totalWeight;
        }

        function bestSimilarity(refBits, choiceDilated, choiceAngle, refAngle) {
            const relativeCorrection = choiceAngle - refAngle;
            let best = 0;
            for (const offset of ANGLE_OFFSETS) {
                const bits = fingerprintAtAngle(choiceDilated, -(relativeCorrection + offset));
                if (!bits || isBlankFingerprint(bits)) continue;
                const sim = gaussianSimilarity(refBits, bits);
                if (sim > best) best = sim;
            }
            return best;
        }

        // ── CTC detection ─────────────────────────────────────────────────────

        function getCTCContainer() {
            const box = document.getElementById('ctcbox');
            if (box) {
                const style = window.getComputedStyle(box);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const rect = box.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return box;
                }
            }
            const gtaTd = document.querySelector('td.veg.lettuce.centd');
            if (gtaTd) {
                const hasRefImg   = !!gtaTd.querySelector('img[src*="text.php"]');
                const hasChoices  = gtaTd.querySelectorAll('input[type="image"]').length === 4;
                const hasInstruct = /match the 3 letters/i.test(gtaTd.textContent || '');
                if (hasRefImg && hasChoices && hasInstruct) return gtaTd;
            }
            return null;
        }

        function isVisible() {
            return !!getCTCContainer();
        }

        function getWidget() {
            const box = getCTCContainer();
            if (!box) return null;
            const refImg = box.querySelector('img[src*="text.php"]');
            if (!refImg) return null;
            const choiceInputs = [...box.querySelectorAll('input[type="image"]')];
            if (choiceInputs.length !== 4) return null;
            const allHaveSrc = choiceInputs.every(inp => inp.src && inp.src.trim());
            if (!allHaveSrc) return null;
            const hasInstruction = /match the 3 letters/i.test(box.textContent || '');
            if (!hasInstruction) return null;
            return { container: box, refImg, choiceInputs };
        }

        // ── Solver ────────────────────────────────────────────────────────────

        async function doSolve(widget, logFn, solveCtx = { cancelled: false }) {
            const { refImg, choiceInputs } = widget;

            if (solveCtx.cancelled) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC solve cancelled' };
            }

            // Fetch reference and all 4 choices in parallel
            const [refElement, ...choiceImages] = await Promise.all([
                resolveImage(refImg),
                ...choiceInputs.map(inp => resolveImage(inp))
            ]);

            if (solveCtx.cancelled || !isVisible()) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC no longer active — aborted' };
            }

            const refCanvas = imageToCanvas(refElement);
            const refPrep   = prepareCanvas(refCanvas);
            const refBits   = fingerprintAtAngle(refPrep.dilated, -refPrep.angle);

            if (!refBits || isBlankFingerprint(refBits)) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC reference image appears blank — aborting, will retry' };
            }

            const choiceCanvases = choiceImages.map(img => imageToCanvas(img));
            const choicePreps    = choiceCanvases.map(c => prepareCanvas(c));

            if (solveCtx.cancelled || !isVisible()) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC no longer active — aborted' };
            }

            const results = [];
            for (let i = 0; i < choicePreps.length; i++) {
                const { dilated, angle } = choicePreps[i];
                const quickBits = fingerprintAtAngle(dilated, -angle);
                if (!quickBits || isBlankFingerprint(quickBits)) {
                    logFn(`CTC choice ${i + 1}: appears blank — skipping`);
                    results.push({ index: i, similarity: -1, el: choiceInputs[i], canvas: choiceCanvases[i] });
                    continue;
                }
                const similarity = bestSimilarity(refBits, dilated, angle, refPrep.angle);
                results.push({ index: i, similarity, el: choiceInputs[i], canvas: choiceCanvases[i] });
                logFn(`CTC choice ${i + 1}: ${(similarity * 100).toFixed(1)}% match`);
            }

            const validResults = results.filter(r => r.similarity >= 0);
            if (!validResults.length) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC all choices appear blank — aborting, will retry' };
            }

            validResults.sort((a, b) => b.similarity - a.similarity);
            const winner   = validResults[0];
            const runnerUp = validResults[1] || null;
            const gap      = runnerUp ? winner.similarity - runnerUp.similarity : 1;

            if (winner.similarity < SIMILARITY_FLOOR) {
                return {
                    solved: false, choice: winner.index + 1, similarity: winner.similarity,
                    message: `CTC: best match ${(winner.similarity * 100).toFixed(1)}% below floor — skipping`
                };
            }

            if (runnerUp && gap < SCORE_GAP_FLOOR) {
                return {
                    solved: false, choice: winner.index + 1, similarity: winner.similarity,
                    message: `CTC: top two matches too close (${(winner.similarity * 100).toFixed(1)}% vs ${(runnerUp.similarity * 100).toFixed(1)}%) — skipping`
                };
            }

            if (solveCtx.cancelled || !isVisible() || !winner.el.isConnected) {
                return { solved: false, choice: winner.index + 1, similarity: winner.similarity, message: 'CTC no longer active before click — aborted' };
            }

            humanClick(winner.el);

            return {
                solved: true,
                choice: winner.index + 1,
                similarity: winner.similarity,
                gap,
                message: `CTC solved — clicked choice ${winner.index + 1} (${(winner.similarity * 100).toFixed(1)}% match)`
            };
        }

        let consecutiveSkips = 0;
        const MAX_SKIPS_BEFORE_RELOAD = 5;

        async function trySolve(logFn) {
            if (isSolving) {
                return { attempted: false, solved: false, message: 'CTC solver already running' };
            }

            await new Promise(resolve => setTimeout(resolve, SETTLE_DELAY_MS));

            const widget = getWidget();
            if (!widget) {
                logFn('CTC widget rejected by getWidget() after settle delay');
                return { attempted: false, solved: false, message: 'CTC widget not valid after settle delay' };
            }

            isSolving = true;
            logFn('CTC detected — attempting auto-solve');

            const solveCtx = { cancelled: false };

            const timeout = new Promise(resolve =>
                setTimeout(() => {
                    solveCtx.cancelled = true;
                    resolve({
                        solved: false, choice: null, similarity: 0,
                        message: 'CTC solver timed out'
                    });
                }, SOLVE_TIMEOUT_MS)
            );

            try {
                const result = await Promise.race([doSolve(widget, logFn, solveCtx), timeout]);
                logFn(result.message);
                if (result.solved) {
                    consecutiveSkips = 0;
                } else {
                    consecutiveSkips++;
                    if (consecutiveSkips >= MAX_SKIPS_BEFORE_RELOAD) {
                        consecutiveSkips = 0;
                        logFn('CTC: too many failed attempts — reloading page for fresh CTC');
                        location.reload();
                        return { attempted: true, solved: false, message: result.message };
                    }
                }
                return { attempted: true, solved: result.solved, message: result.message };
            } catch (err) {
                const message = 'CTC solver error: ' + err.message;
                logFn(message);
                consecutiveSkips++;
                return { attempted: true, solved: false, message };
            } finally {
                isSolving = false;
            }
        }

        function attachObserver(logFn) {
            let boxObserver  = null;
            let bodyObserver = null;

            function observeBox(box) {
                if (!box || boxObserver) return;

                boxObserver = new MutationObserver(() => {
                    if (isVisible() && !isSolving) {
                        logFn('CTC became visible — triggering solver');
                        trySolve(logFn);
                    }
                });

                boxObserver.observe(box, {
                    attributes: true,
                    attributeFilter: ['style', 'class'],
                    childList: true
                });

                logFn('CTC observer attached');

                if (isVisible()) {
                    logFn('CTC visible on load — solving');
                    trySolve(logFn);
                }
            }

            function attach() {
                const box = document.getElementById('ctcbox');
                if (box) { observeBox(box); return; }

                if (isVisible() && !isSolving) {
                    logFn('GTA-variant CTC visible on load — solving');
                    trySolve(logFn);
                    return;
                }

                if (bodyObserver) return;

                bodyObserver = new MutationObserver(() => {
                    const nextBox = document.getElementById('ctcbox');
                    if (nextBox) {
                        bodyObserver.disconnect();
                        bodyObserver = null;
                        observeBox(nextBox);
                        return;
                    }
                    if (isVisible() && !isSolving) {
                        logFn('GTA-variant CTC appeared — triggering solver');
                        trySolve(logFn);
                    }
                });

                bodyObserver.observe(document.body, { childList: true, subtree: true });
            }

            attach();
        }

        return { trySolve, attachObserver, isVisible };
    })();




    // =========================================================================
    // BOT CONFIG
    // =========================================================================

    const SCRIPT_VERSION = '2.7.3';

    const CRIME_DEFS = [
        { id: 'gang', name: 'Gang Activities' },
        { id: '1',    name: 'Steal from a player' },
        { id: '2',    name: 'Commit blasphemy' },
        { id: 'drug', name: 'Drug Trafficking' },
        { id: '3',    name: 'Rob a bank' },
        { id: '4',    name: 'Sell pornography to neighbours' },
        { id: '5',    name: 'Rob a group of kids' },
        { id: '6',    name: 'Beg for money' },
        { id: '7',    name: 'Pick pennies' }
    ];

    const GTA_DEF  = { id: 'gta',  name: 'Grand Theft Auto' };
    const MELT_DEF = { id: 'melt', name: 'Melting' };

    const CRIME_NAME_BY_ID = Object.fromEntries(CRIME_DEFS.map(c => [c.id, c.name]));
    const DEFAULT_ORDER    = ['gang', 'drug', '1', '3', '4', '5', '6', '7', '2'];
    const ALL_IDS          = [...CRIME_DEFS.map(c => c.id), GTA_DEF.id, MELT_DEF.id];

    // Known crime cooldowns supplied by the game/user.
    // These let background crimes commit exactly when due without repeatedly
    // polling /?p=crimes just to discover timers.
    const BG_CRIME_DEFAULT_COOLDOWNS_MS = {
        '7':    5 * 1000,        // Pick pennies
        '6':   10 * 1000,        // Beg for money
        '5':   20 * 1000,        // Rob a group of kids
        '4':   30 * 1000,        // Sell pornography to neighbours
        '3':   60 * 1000,        // Rob a bank
        drug: 300 * 1000,        // Drug Trafficking
        '2':  900 * 1000,        // Commit blasphemy
        '1': 3600 * 1000,        // Steal from a player
        gang: 1800 * 1000        // Gang Activities
    };

    const GTA_COOLDOWN_MS  = 90 * 1000;
    const MELT_COOLDOWN_MS = 4 * 60 * 1000;

    // Drug running route configuration.
    // Country location select values: 1=England 2=Mexico 3=Russia 4=South Africa 5=USA
    // Drug select values: 1=Cannabis 2=Heroin 3=Cocaine 4=Ecstasy 5=LSD
    // Reserve is based on the USA Heroin buy price as that is the most expensive leg.
    // Prices never change per country so this is hardcoded.
    const DRUG_RUN_ROUTE = {
        countryA:         'USA',
        countryALocation: '5',
        countryB:         'England',
        countryBLocation: '1',
        drugInA:          { name: 'Heroin',   value: '2' },
        drugInB:          { name: 'Cannabis', value: '1' },
    };

    const DRUG_HEROIN_USA_PRICE = 28999; // Fixed USA Heroin buy price — used to calculate the cash reserve

    // Country name → location select value mapping (used by kill travel)
    const COUNTRY_LOCATION_MAP = {
        'england':      '1',
        'mexico':       '2',
        'russia':       '3',
        'south africa': '4',
        'usa':          '5'
    };

    // =========================================================================
    // KILL SCANNER CONSTANTS
    // =========================================================================

    const KILL_SCANNER_SEARCH_HOURS  = 24;   // Always search for 24 hours
    const KILL_SCANNER_RESCAN_MS     = 23 * 60 * 60 * 1000; // Re-search alive players after 23hrs (1hr buffer before 24hr expiry)
    const KILL_SCANNER_PROTECTED_RESCAN_MS = 60 * 60 * 1000; // Re-check original targets every 1hr (failsafe)

    // Player statuses
    const KILL_STATUS = {
        UNKNOWN:    'unknown',    // Scraped from Players Online, not yet searched
        ALIVE:      'alive',      // Search started successfully
        PROTECTED:  'protected',  // Protected from death
        UNKILLABLE: 'unkillable', // Staff/admin — never search again
        DEAD:       'dead'        // Dead — removed from active list
    };

    // Online scan intervals in minutes
    const ONLINE_SCAN_INTERVALS = [5, 10, 15, 20, 30, 60];

    const DEFAULTS = {
        enabled: false,

        actionDelayMin: 100,
        actionDelayMax: 300,

        burstDelayMin: 180,
        burstDelayMax: 420,
        maxBurstActions: 4,

        navDelayMin: 500,
        navDelayMax: 1000,

        heartbeatMs: 600,

        logToConsole: true,

        autoDepositEnabled: true,
        autoDepositThreshold: 15000000,

        autoRepairEnabled: true,
        repairEveryMelts: 10,

        autoMissionsEnabled: true,
        autoGiveCarMissionsEnabled: false,

        autoDrugsEnabled:      false,
        drugDepositMultiplier: 2, // Deposit when cash exceeds this multiple of the full run cost

        // Leave Jail settings
        leaveJailEnabled:   false,
        leaveJailMinPoints: 50,

        resetCrimesEnabled:  false,
        resetCrimesFastMode: false,
        resetGTAEnabled:     false,
        resetMeltEnabled:    false,
        resetTimerMinPoints: 200,
        bgCrimeEnabled: false,
        diceJoinEnabled: true,
        bulletFactoryEnabled: false,
        qtBgEnabled:         false,
        qtBgThreshold:       1320,
        qtBulletsEnabled:    false,
        qtBulletsThreshold:  100000,
        qtBulletsMin:        0,
        qtPerkExtendEnabled: false,
        qtPerkExtendMins:    5,
        qtPerkRedeemEnabled: false,
        qtPerkRedeemMins:    30,
        autoBuyBgEnabled:   false,
        autoBuyBgMinPts:    1300,
        autoBuyBgMins:      60,
        qtPollMin:           2000,
        qtPollMax:           4000,
        qtPointsEnabled:     false,
        qtPointsThreshold:   15000000,
        // QT perk sniper — per-type toggles, max point price, min amount
        qtBustEnabled:       false,
        qtBustMaxPts:        3,    // max pts per min
        qtBustMinMins:       30,
        qtAlwaysSuccEnabled: false,
        qtAlwaysSuccMaxPts:  3,    // max pts per min
        qtAlwaysSuccMinMins: 30,
        qtDoubleMeltsEnabled: false,
        qtDoubleMeltsMaxPts:  3,   // max pts per car
        qtDoubleMeltsMinCars: 50,
        qtDoubleXpEnabled:   false,
        qtDoubleXpMaxPts:    3,    // max pts per min
        qtDoubleXpMinMins:   100,
        qtDoubleCashEnabled: false,
        qtDoubleCashMaxPts:  3,    // max pts per min
        qtDoubleCashMinMins: 30,
        qtRareEnabled:       false,
        qtRareMaxPts:        3,    // max pts per car
        qtRareMinCars:       50,
        qtBulletValueEnabled: false,
        qtBulletValueMaxPts:  3,   // max pts per car
        qtBulletValueMinCars: 20,

        // QT car scanner
        qtCarsEnabled:       false,
        qtCarsScanInterval:  30, // seconds
        qtCarsTypes: [
            { b: 28, name: 'Orange',                    enabled: false, maxPrice: 10000000000 },
            { b: 27, name: 'Black Lamborghini Aventador', enabled: false, maxPrice: 1000000000 },
            { b: 26, name: 'Black Range Rover Evoque',  enabled: false, maxPrice: 1000000000  },
            { b: 25, name: 'Black Audi RS5',            enabled: false, maxPrice: 1000000000  },
            { b: 24, name: 'Black BMW M3',              enabled: false, maxPrice: 1000000000  },
            { b: 23, name: 'Black Audi A3',             enabled: false, maxPrice: 1000000000  },
            { b: 22, name: 'RS Tuner',                  enabled: false, maxPrice: 100000000   },
            { b: 21, name: 'Tuner',                     enabled: false, maxPrice: 10000000    },
            { b: 20, name: 'McLaren P1',                enabled: false, maxPrice: 1000000     },
            { b: 19, name: 'Jaguar F-Type',             enabled: false, maxPrice: 1000000     },
            { b: 18, name: 'Mercedes E63',              enabled: false, maxPrice: 1000000     },
            { b: 17, name: 'Porsche Panamera',          enabled: false, maxPrice: 1000000     },
            { b: 16, name: 'Range Rover Sport',         enabled: false, maxPrice: 1000000     },
            { b: 15, name: 'Mercedes GLC Coupe',        enabled: false, maxPrice: 1000000     },
        ],

        // Kill scanner settings
        killScanOnlineEnabled:  false,
        killScanOnlineInterval: 1,    // minutes between Players Online checks
        killSearchEnabled:      false,
        killProtectedRecheckEnabled:  false,
        killProtectedRecheckMins:     5,

        // Kill BG check / shoot loop settings
        killBgCheckEnabled:      false,  // Global BG check loop toggle
        killShootEnabled:        false,  // Global shoot loop toggle
        killAnonymousShooting:   false,  // Shoot anonymously (no show=y)
        killBgCheckIntervalHrs:  6,      // Hours between BG checks per player
        killPenaltyThreshold:    0,      // Max kill penalty multiplier (0 = disabled)

        maxLiveLogEntries: 1000,

        // Human page visit settings
        humanPageVisitChance: 0.08,  // 8% chance per natural pause point
        humanPageVisitMinMs: 3000,
        humanPageVisitMaxMs: 8000,

        // No reload bust
        bustNoReload: false,
        bustPollMin:  800,
        bustPollMax:  1200,

        // Extend perk thresholds
        extendBulletsThreshold:      7500,
        extendRaresThreshold:        50,
        extendDoubleMeltsThreshold:  50,
        extendBulletValueThreshold:  50,
        extendDoubleXpThreshold:     50,
        extendAlwaysSuccThreshold:   50,
        extendAlwaysBustThreshold:   50,
        extendDoubleCashThreshold:   50,
    };

    const SAFETY = {
        sameCrimeMinGapMs:      3500,
        postClickSettleMs:      1500,
        postClickPollMs:        30,
        maxBurstActionsReal:    4,
        loopBackoffReloadMin:   2500,
        loopBackoffReloadMax:   4500,

        repairAfterLoadMs:      700,
        repairAfterSelectAllMs: 400,
        repairAfterSubmitMs:    1000
    };

    const MELT_PROTECTED_NAME_PARTS = [
        'rs tuner',
        'black',
        'orange'
    ];

    // ── Personality system ────────────────────────────────────────────────────
    // On first run, generates a unique "personality" for this installation and
    // stores it persistently. This makes each bot instance behave slightly
    // differently, avoiding identical fingerprints across multiple accounts.

    // Safe pages to visit — excludes any page the bot might interact with
    const HUMAN_PAGES = [
        'help', 'online', 'find', 'top', 'stats', 'editprofile', 'my-stats',
        'perks', 'notes', 'notifications', 'points', 'mail', 'forum', 'oc',
        'lottery', 'hospital', 'hitlist', 'attempts', 'auction', 'qt',
        'betting', 'blackjack', 'dice', 'racetrack', 'gangs', 'gang-info'
    ];

    let personalityJustGenerated = false;

    function getPersonality() {
        const stored = GM_getValue('ugbot_personality', null);
        if (stored) return stored;

        // First run — generate a personality and store it permanently
        personalityJustGenerated = true;
        return generatePersonality(false);
    }

    function generatePersonality(dupeMode) {
        const shuffle = arr => arr.slice().sort(() => Math.random() - 0.5);
        const pageCount = dupeMode
            ? 3 + Math.floor(Math.random() * 4)   // 3–6 pages in dupe mode
            : 6 + Math.floor(Math.random() * 7);  // 6–12 pages normally
        const personality = {
            dupeMode,
            depositThreshold:    Math.floor(10000000 + Math.random() * 20000000),
            drugDepositMult:     +(2 + Math.random() * 3).toFixed(1),
            scanIntervalMins:    +(0.5 + Math.random() * 2).toFixed(1),
            timingOffsetMs:      Math.floor(-150 + Math.random() * 300),
            humanPages:          shuffle(HUMAN_PAGES).slice(0, pageCount),
            idleVisitChancePct:  dupeMode ? 3  + Math.floor(Math.random() * 12) : 5 + Math.floor(Math.random() * 8),
            idleMinMs:           dupeMode ? 15000 + Math.floor(Math.random() * 75000) : 20000 + Math.floor(Math.random() * 40000),
            navDelayMin:         dupeMode ? 800  + Math.floor(Math.random() * 700)  : DEFAULTS.navDelayMin,
            navDelayMax:         dupeMode ? 1800 + Math.floor(Math.random() * 1200) : DEFAULTS.navDelayMax,
            heartbeatMs:         dupeMode ? 700  + Math.floor(Math.random() * 600)  : DEFAULTS.heartbeatMs,
            gtaDelayChancePct:   dupeMode ? 20   + Math.floor(Math.random() * 40)   : 0,
            gtaDelayExtraMs:     dupeMode ? 5000 + Math.floor(Math.random() * 25000): 0,
            jailNavigateAway:    dupeMode ? Math.random() < 0.5                      : false,
            jailLeaveDelayMs:    dupeMode ? 2000 + Math.floor(Math.random() * 8000) : 0,
            crimePageLingerMs:   dupeMode ? Math.floor(Math.random() * 3000)        : 0,
        };
        GM_setValue('ugbot_personality', personality);
        return personality;
    }

    const PERSONALITY = getPersonality();

    // Apply personality defaults — always force-apply on first generation,
    // otherwise only set values that have never been configured
    function applyPersonalityDefaults() {
        const neverSet = key => GM_getValue(key, null) === null;
        if (personalityJustGenerated || neverSet('autoDepositThreshold')) GM_setValue('autoDepositThreshold', PERSONALITY.depositThreshold);
        if (personalityJustGenerated || neverSet('drugDepositMultiplier')) GM_setValue('drugDepositMultiplier', PERSONALITY.drugDepositMult);
        if (personalityJustGenerated || neverSet('killScanOnlineInterval')) GM_setValue('killScanOnlineInterval', PERSONALITY.scanIntervalMins);
    }

    let lastHumanVisitAt = 0;

    // Call this at natural pause points — occasionally navigates to a human page
    async function maybeVisitHumanPage() {
        if (!state.enabled) return false;
        if (state.bgCrimeEnabled) return false; // bg crimes already randomises behaviour
        const minGapMs = 3 * 60 * 1000; // at least 3 mins between human visits
        if (Date.now() - lastHumanVisitAt < minGapMs) return false;
        if (Math.random() * 100 >= PERSONALITY.idleVisitChancePct) return false;

        const pages = PERSONALITY.humanPages;
        if (!pages || !pages.length) return false;
        const page = pages[Math.floor(Math.random() * pages.length)];

        lastHumanVisitAt = Date.now();
        addLiveLog(`[Human] Visiting ?p=${page}`);
        await wait(navRand());
        gotoPage(page);
        return true;
    }

    function getSetting(key, fallback) {
        try {
            const value = GM_getValue(key, fallback);
            return value === undefined ? fallback : value;
        } catch (e) {
            const raw = localStorage.getItem(`ugbot_${key}`);
            return raw == null ? fallback : JSON.parse(raw);
        }
    }

    function setSetting(key, value) {
        try {
            GM_setValue(key, value);
        } catch (e) {
            localStorage.setItem(`ugbot_${key}`, JSON.stringify(value));
        }
    }

    const state = {
        get enabled()              { return getSetting('enabled', DEFAULTS.enabled); },
        set enabled(v)             { setSetting('enabled', !!v); },

        get enabledActions()       { return [...getSetting('enabledActions', ALL_IDS)]; },
        set enabledActions(v)      { setSetting('enabledActions', [...v]); },

        get autoDepositEnabled()   { return !!getSetting('autoDepositEnabled', DEFAULTS.autoDepositEnabled); },
        set autoDepositEnabled(v)  { setSetting('autoDepositEnabled', !!v); },

        get autoDepositThreshold() { return Number(getSetting('autoDepositThreshold', DEFAULTS.autoDepositThreshold)); },
        set autoDepositThreshold(v){ setSetting('autoDepositThreshold', Math.max(0, Number(v) || 0)); },

        get autoRepairEnabled()    { return !!getSetting('autoRepairEnabled', DEFAULTS.autoRepairEnabled); },
        set autoRepairEnabled(v)   { setSetting('autoRepairEnabled', !!v); },

        get repairEveryMelts()     { return Math.max(1, Number(getSetting('repairEveryMelts', DEFAULTS.repairEveryMelts)) || DEFAULTS.repairEveryMelts); },
        set repairEveryMelts(v)    { setSetting('repairEveryMelts', Math.max(1, Number(v) || DEFAULTS.repairEveryMelts)); },

        get autoMissionsEnabled()  { return !!getSetting('autoMissionsEnabled', DEFAULTS.autoMissionsEnabled); },
        set autoMissionsEnabled(v) { setSetting('autoMissionsEnabled', !!v); },

        get autoGiveCarMissionsEnabled() { return !!getSetting('autoGiveCarMissionsEnabled', DEFAULTS.autoGiveCarMissionsEnabled); },
        set autoGiveCarMissionsEnabled(v){ setSetting('autoGiveCarMissionsEnabled', !!v); },

        get autoDrugsEnabled()     { return !!getSetting('autoDrugsEnabled', DEFAULTS.autoDrugsEnabled); },
        set autoDrugsEnabled(v)    { setSetting('autoDrugsEnabled', !!v); },
        get drugCompEnabled()      { return !!getSetting('drugCompEnabled', false); },
        set drugCompEnabled(v)     { setSetting('drugCompEnabled', !!v); },

        get drugDepositMultiplier() { return Math.max(1, Number(getSetting('drugDepositMultiplier', DEFAULTS.drugDepositMultiplier)) || DEFAULTS.drugDepositMultiplier); },
        set drugDepositMultiplier(v){ setSetting('drugDepositMultiplier', Math.max(1, Number(v) || DEFAULTS.drugDepositMultiplier)); },

        // Leave Jail
        get leaveJailEnabled()     { return !!getSetting('leaveJailEnabled', DEFAULTS.leaveJailEnabled); },
        set leaveJailEnabled(v)    { setSetting('leaveJailEnabled', !!v); },

        get leaveJailMinPoints()   { return Math.max(1, Number(getSetting('leaveJailMinPoints', DEFAULTS.leaveJailMinPoints)) || DEFAULTS.leaveJailMinPoints); },
        set leaveJailMinPoints(v)  { setSetting('leaveJailMinPoints', Math.max(1, Number(v) || DEFAULTS.leaveJailMinPoints)); },

        // Timer resets — mutually exclusive
        get resetCrimesEnabled()   { return !!getSetting('resetCrimesEnabled', DEFAULTS.resetCrimesEnabled); },
        set resetCrimesEnabled(v)  { setSetting('resetCrimesEnabled', !!v); },

        get resetCrimesFastMode()  { return !!getSetting('resetCrimesFastMode', DEFAULTS.resetCrimesFastMode); },
        set resetCrimesFastMode(v) { setSetting('resetCrimesFastMode', !!v); },

        get resetGTAEnabled()      { return !!getSetting('resetGTAEnabled', DEFAULTS.resetGTAEnabled); },
        set resetGTAEnabled(v)     { setSetting('resetGTAEnabled', !!v); },

        get resetMeltEnabled()     { return !!getSetting('resetMeltEnabled', DEFAULTS.resetMeltEnabled); },
        set resetMeltEnabled(v)    { setSetting('resetMeltEnabled', !!v); },

        get resetTimerMinPoints()  { return Math.max(1, Number(getSetting('resetTimerMinPoints', DEFAULTS.resetTimerMinPoints)) || DEFAULTS.resetTimerMinPoints); },
        set resetTimerMinPoints(v) { setSetting('resetTimerMinPoints', Math.max(1, Number(v) || DEFAULTS.resetTimerMinPoints)); },

        // Persisted loop flags — survive page reloads so dedicated loops
        // remain active across the natural page reloads that occur during melting/GTA
        get gtaResetLoopActive()   { return !!getSetting('gtaResetLoopActive', false); },
        set gtaResetLoopActive(v)  { setSetting('gtaResetLoopActive', !!v); },

        get meltResetLoopActive()  { return !!getSetting('meltResetLoopActive', false); },
        set meltResetLoopActive(v) { setSetting('meltResetLoopActive', !!v); },
        get bgCrimeEnabled()       { return !!getSetting('bgCrimeEnabled', DEFAULTS.bgCrimeEnabled); },
        set bgCrimeEnabled(v)      { setSetting('bgCrimeEnabled', !!v); },
        get diceJoinEnabled()      { return !!getSetting('diceJoinEnabled', DEFAULTS.diceJoinEnabled); },
        set diceJoinEnabled(v)     { setSetting('diceJoinEnabled', !!v); },
        get disableCrimesAtGb()    { return !!getSetting('disableCrimesAtGb', false); },
        set disableCrimesAtGb(v)   { setSetting('disableCrimesAtGb', !!v); },
        get disableGtaAtGb()       { return !!getSetting('disableGtaAtGb', false); },
        set disableGtaAtGb(v)      { setSetting('disableGtaAtGb', !!v); },
        get bulletFactoryEnabled() { return !!getSetting('bulletFactoryEnabled', DEFAULTS.bulletFactoryEnabled); },
        set bulletFactoryEnabled(v){ setSetting('bulletFactoryEnabled', !!v); },
        get pendingBulletRun()     { return getSetting('pendingBulletRun', null); },
        set pendingBulletRun(v)    { setSetting('pendingBulletRun', v); },
        get pendingGunBuy()        { return getSetting('pendingGunBuy', null); },
        set pendingGunBuy(v)       { setSetting('pendingGunBuy', v); },
        get lastBulletFactoryCheck(){ return Number(getSetting('lastBulletFactoryCheck', 0)); },
        set lastBulletFactoryCheck(v){ setSetting('lastBulletFactoryCheck', Number(v)); },
        get qtBgEnabled()          { return !!getSetting('qtBgEnabled', DEFAULTS.qtBgEnabled); },
        set qtBgEnabled(v)         { setSetting('qtBgEnabled', !!v); },
        get qtPerksEnabled()       { return !!getSetting('qtPerksEnabled', true); },
        set qtPerksEnabled(v)      { setSetting('qtPerksEnabled', !!v); },
        get qtBgThreshold()        { return Number(getSetting('qtBgThreshold', DEFAULTS.qtBgThreshold)) || DEFAULTS.qtBgThreshold; },
        set qtBgThreshold(v)       { setSetting('qtBgThreshold', Number(v)); },
        get qtBulletsEnabled()     { return !!getSetting('qtBulletsEnabled', DEFAULTS.qtBulletsEnabled); },
        set qtBulletsEnabled(v)    { setSetting('qtBulletsEnabled', !!v); },
        get qtBulletsThreshold()   { return Number(getSetting('qtBulletsThreshold', DEFAULTS.qtBulletsThreshold)) || DEFAULTS.qtBulletsThreshold; },
        set qtBulletsThreshold(v)  { setSetting('qtBulletsThreshold', Number(v)); },
        get qtBulletsMin()         { return Number(getSetting('qtBulletsMin', DEFAULTS.qtBulletsMin)); },
        set qtBulletsMin(v)        { setSetting('qtBulletsMin', Number(v)); },
        get qtPerkExtendEnabled()  { return !!getSetting('qtPerkExtendEnabled', DEFAULTS.qtPerkExtendEnabled); },
        set qtPerkExtendEnabled(v) { setSetting('qtPerkExtendEnabled', !!v); },
        get qtPerkExtendMins()     { return Number(getSetting('qtPerkExtendMins', DEFAULTS.qtPerkExtendMins)) || DEFAULTS.qtPerkExtendMins; },
        set qtPerkExtendMins(v)    { setSetting('qtPerkExtendMins', Number(v)); },

        get qtPerkRedeemEnabled()  { return !!getSetting('qtPerkRedeemEnabled', DEFAULTS.qtPerkRedeemEnabled); },
        set qtPerkRedeemEnabled(v) { setSetting('qtPerkRedeemEnabled', !!v); },
        get qtPerkRedeemMins()     { return Number(getSetting('qtPerkRedeemMins', DEFAULTS.qtPerkRedeemMins)) || DEFAULTS.qtPerkRedeemMins; },
        set qtPerkRedeemMins(v)    { setSetting('qtPerkRedeemMins', Number(v)); },

        // ── Auto Account Creation ─────────────────────────────────────────
        get accEnabled()   { return getSetting('accEnabled', false); },
        set accEnabled(v)  { setSetting('accEnabled', v); },
        get accEmail()     { return getSetting('accEmail', ''); },
        set accEmail(v)    { setSetting('accEmail', String(v || '')); },
        get accPassword()  { return getSetting('accPassword', ''); },
        set accPassword(v) { setSetting('accPassword', String(v || '')); },
        get accRetrieve()  { return getSetting('accRetrieve', true); },
        set accRetrieve(v) { setSetting('accRetrieve', v); },
        get accUsernames() { return getSetting('accUsernames', []); },
        set accUsernames(v){ setSetting('accUsernames', v); },
        get accNameIndex() { return getSetting('accNameIndex', 0); },
        set accNameIndex(v){ setSetting('accNameIndex', Number(v)); },
        get qtPollMin()            { return Number(getSetting('qtPollMin', DEFAULTS.qtPollMin)) || DEFAULTS.qtPollMin; },
        set qtPollMin(v)           { setSetting('qtPollMin', Number(v)); },
        get qtPollMax()            { return Number(getSetting('qtPollMax', DEFAULTS.qtPollMax)) || DEFAULTS.qtPollMax; },
        set qtPollMax(v)           { setSetting('qtPollMax', Number(v)); },
        get qtPointsEnabled()      { return !!getSetting('qtPointsEnabled', DEFAULTS.qtPointsEnabled); },
        set qtPointsEnabled(v)     { setSetting('qtPointsEnabled', !!v); },
        get qtPointsThreshold()    { return Number(getSetting('qtPointsThreshold', DEFAULTS.qtPointsThreshold)) || DEFAULTS.qtPointsThreshold; },
        set qtPointsThreshold(v)   { setSetting('qtPointsThreshold', Number(v)); },

        get qtBustEnabled()        { return !!getSetting('qtBustEnabled', DEFAULTS.qtBustEnabled); },
        set qtBustEnabled(v)       { setSetting('qtBustEnabled', !!v); },
        get qtBustMaxPts()         { return Number(getSetting('qtBustMaxPts', DEFAULTS.qtBustMaxPts)); },
        set qtBustMaxPts(v)        { setSetting('qtBustMaxPts', Number(v)); },
        get qtBustMinMins()        { return Number(getSetting('qtBustMinMins', DEFAULTS.qtBustMinMins)); },
        set qtBustMinMins(v)       { setSetting('qtBustMinMins', Number(v)); },

        get qtAlwaysSuccEnabled()  { return !!getSetting('qtAlwaysSuccEnabled', DEFAULTS.qtAlwaysSuccEnabled); },
        set qtAlwaysSuccEnabled(v) { setSetting('qtAlwaysSuccEnabled', !!v); },
        get qtAlwaysSuccMaxPts()   { return Number(getSetting('qtAlwaysSuccMaxPts', DEFAULTS.qtAlwaysSuccMaxPts)); },
        set qtAlwaysSuccMaxPts(v)  { setSetting('qtAlwaysSuccMaxPts', Number(v)); },
        get qtAlwaysSuccMinMins()  { return Number(getSetting('qtAlwaysSuccMinMins', DEFAULTS.qtAlwaysSuccMinMins)); },
        set qtAlwaysSuccMinMins(v) { setSetting('qtAlwaysSuccMinMins', Number(v)); },

        get qtDoubleMeltsEnabled() { return !!getSetting('qtDoubleMeltsEnabled', DEFAULTS.qtDoubleMeltsEnabled); },
        set qtDoubleMeltsEnabled(v){ setSetting('qtDoubleMeltsEnabled', !!v); },
        get qtDoubleMeltsMaxPts()  { return Number(getSetting('qtDoubleMeltsMaxPts', DEFAULTS.qtDoubleMeltsMaxPts)); },
        set qtDoubleMeltsMaxPts(v) { setSetting('qtDoubleMeltsMaxPts', Number(v)); },
        get qtDoubleMeltsMinCars() { return Number(getSetting('qtDoubleMeltsMinCars', DEFAULTS.qtDoubleMeltsMinCars)); },
        set qtDoubleMeltsMinCars(v){ setSetting('qtDoubleMeltsMinCars', Number(v)); },

        get qtDoubleXpEnabled()    { return !!getSetting('qtDoubleXpEnabled', DEFAULTS.qtDoubleXpEnabled); },
        set qtDoubleXpEnabled(v)   { setSetting('qtDoubleXpEnabled', !!v); },
        get qtDoubleXpMaxPts()     { return Number(getSetting('qtDoubleXpMaxPts', DEFAULTS.qtDoubleXpMaxPts)); },
        set qtDoubleXpMaxPts(v)    { setSetting('qtDoubleXpMaxPts', Number(v)); },
        get qtDoubleXpMinMins()    { return Number(getSetting('qtDoubleXpMinMins', DEFAULTS.qtDoubleXpMinMins)); },
        set qtDoubleXpMinMins(v)   { setSetting('qtDoubleXpMinMins', Number(v)); },

        get qtDoubleCashEnabled()  { return !!getSetting('qtDoubleCashEnabled', DEFAULTS.qtDoubleCashEnabled); },
        set qtDoubleCashEnabled(v) { setSetting('qtDoubleCashEnabled', !!v); },
        get qtDoubleCashMaxPts()   { return Number(getSetting('qtDoubleCashMaxPts', DEFAULTS.qtDoubleCashMaxPts)); },
        set qtDoubleCashMaxPts(v)  { setSetting('qtDoubleCashMaxPts', Number(v)); },
        get qtDoubleCashMinMins()  { return Number(getSetting('qtDoubleCashMinMins', DEFAULTS.qtDoubleCashMinMins)); },
        set qtDoubleCashMinMins(v) { setSetting('qtDoubleCashMinMins', Number(v)); },

        get qtRareEnabled()        { return !!getSetting('qtRareEnabled', DEFAULTS.qtRareEnabled); },
        set qtRareEnabled(v)       { setSetting('qtRareEnabled', !!v); },
        get qtRareMaxPts()         { return Number(getSetting('qtRareMaxPts', DEFAULTS.qtRareMaxPts)); },
        set qtRareMaxPts(v)        { setSetting('qtRareMaxPts', Number(v)); },
        get qtRareMinCars()        { return Number(getSetting('qtRareMinCars', DEFAULTS.qtRareMinCars)); },
        set qtRareMinCars(v)       { setSetting('qtRareMinCars', Number(v)); },

        get qtBulletValueEnabled() { return !!getSetting('qtBulletValueEnabled', DEFAULTS.qtBulletValueEnabled); },
        set qtBulletValueEnabled(v){ setSetting('qtBulletValueEnabled', !!v); },
        get qtBulletValueMaxPts()  { return Number(getSetting('qtBulletValueMaxPts', DEFAULTS.qtBulletValueMaxPts)); },
        set qtBulletValueMaxPts(v) { setSetting('qtBulletValueMaxPts', Number(v)); },
        get qtBulletValueMinCars() { return Number(getSetting('qtBulletValueMinCars', DEFAULTS.qtBulletValueMinCars)); },
        set qtBulletValueMinCars(v){ setSetting('qtBulletValueMinCars', Number(v)); },

        get qtCarsEnabled()        { return !!getSetting('qtCarsEnabled', DEFAULTS.qtCarsEnabled); },
        set qtCarsEnabled(v)       { setSetting('qtCarsEnabled', !!v); },
        get qtCarsScanInterval()   { return Number(getSetting('qtCarsScanInterval', DEFAULTS.qtCarsScanInterval)) || DEFAULTS.qtCarsScanInterval; },
        set qtCarsScanInterval(v)  { setSetting('qtCarsScanInterval', Number(v)); },
        get qtCarsTypes()          { return getSetting('qtCarsTypes', DEFAULTS.qtCarsTypes); },
        set qtCarsTypes(v)         { setSetting('qtCarsTypes', v); },

        // Kill scanner
        get killScanOnlineEnabled()   { return !!getSetting('killScanOnlineEnabled', DEFAULTS.killScanOnlineEnabled); },
        set killScanOnlineEnabled(v)  { setSetting('killScanOnlineEnabled', !!v); },

        get killScanOnlineInterval()  { return Number(getSetting('killScanOnlineInterval', DEFAULTS.killScanOnlineInterval)); },
        set killScanOnlineInterval(v) { setSetting('killScanOnlineInterval', Number(v)); },

        get killSearchEnabled()       { return !!getSetting('killSearchEnabled', DEFAULTS.killSearchEnabled); },
        set killSearchEnabled(v)      { setSetting('killSearchEnabled', !!v); },
        get killProtectedRecheckEnabled() { return !!getSetting('killProtectedRecheckEnabled', DEFAULTS.killProtectedRecheckEnabled); },
        set killProtectedRecheckEnabled(v){ setSetting('killProtectedRecheckEnabled', !!v); },
        get killProtectedRecheckMins()    { return Number(getSetting('killProtectedRecheckMins', DEFAULTS.killProtectedRecheckMins)) || DEFAULTS.killProtectedRecheckMins; },
        set killProtectedRecheckMins(v)   { setSetting('killProtectedRecheckMins', Number(v)); },

        get killSearchLoopActive()    { return !!getSetting('killSearchLoopActive', false); },
        set killSearchLoopActive(v)   { setSetting('killSearchLoopActive', !!v); },

        // The kill player list — stored as array of player objects
        get killPlayers()             { return getSetting('killPlayers', []); },
        set killPlayers(v)            { setSetting('killPlayers', v); },

        // Index of the next player to search in the kill loop
        get killSearchIndex()         { return Number(getSetting('killSearchIndex', 0)); },
        set killSearchIndex(v)        { setSetting('killSearchIndex', Math.max(0, Number(v) || 0)); },

        // Timestamp of the last Players Online scan
        get killLastOnlineScan()      { return Number(getSetting('killLastOnlineScan', 0)); },
        set killLastOnlineScan(v)     { setSetting('killLastOnlineScan', Number(v)); },
        get lastKnownGun()            { return getSetting('lastKnownGun', ''); },
        set lastKnownGun(v)           { setSetting('lastKnownGun', v); },

        // Username currently being searched (persists across page reload)
        get killCurrentSearch()       { return getSetting('killCurrentSearch', ''); },
        set killCurrentSearch(v)      { setSetting('killCurrentSearch', String(v || '')); },

        // Last kill-search submit tracking — used to avoid duplicate submissions during lag/reloads
        get killSearchSubmitAt()      { return Number(getSetting('killSearchSubmitAt', 0)); },
        set killSearchSubmitAt(v)     { setSetting('killSearchSubmitAt', Number(v) || 0); },
        get killSearchSubmitName()    { return getSetting('killSearchSubmitName', ''); },
        set killSearchSubmitName(v)   { setSetting('killSearchSubmitName', String(v || '')); },
        get killSearchWaitLogAt()     { return Number(getSetting('killSearchWaitLogAt', 0)); },
        set killSearchWaitLogAt(v)    { setSetting('killSearchWaitLogAt', Number(v) || 0); },
        get killBgWaitUntil()         { return Number(getSetting('killBgWaitUntil', 0)); },
        set killBgWaitUntil(v)        { setSetting('killBgWaitUntil', Number(v || 0)); },
        get killBgShootPending()      { return getSetting('killBgShootPending', null); },
        set killBgShootPending(v)     { setSetting('killBgShootPending', v); },
        get killLoopCooldownUntil()   { return Number(getSetting('killLoopCooldownUntil', 0)); },
        set killLoopCooldownUntil(v)  { setSetting('killLoopCooldownUntil', Number(v || 0)); if (v) addLiveLog(`Kill loop: cooldown set to ${Math.ceil((v - now()) / 1000)}s`); },
        get killLoopYieldUntil()      { return Number(getSetting('killLoopYieldUntil', 0)); },
        set killLoopYieldUntil(v)     { setSetting('killLoopYieldUntil', Number(v || 0)); },
        get penaltyDropsAt()          { return Number(getSetting('penaltyDropsAt', 0)); },
        set penaltyDropsAt(v)         { setSetting('penaltyDropsAt', Number(v) || 0); },
        get pendingPenaltyPage()      { return !!getSetting('pendingPenaltyPage', false); },
        set pendingPenaltyPage(v)     { setSetting('pendingPenaltyPage', !!v); },
        get killPenaltyPendingAction(){ return getSetting('killPenaltyPendingAction', null); },
        set killPenaltyPendingAction(v){ setSetting('killPenaltyPendingAction', v); },

        // Kill BG check / shoot loop settings
        get killBgCheckEnabled()       { return !!getSetting('killBgCheckEnabled', false); },
        get killDebugEnabled()         { return !!getSetting('killDebugEnabled', true); },
        set killDebugEnabled(v)        { setSetting('killDebugEnabled', !!v); },
        get killSearchFormRetries()    { return getSetting('killSearchFormRetries', 0); },
        set killSearchFormRetries(v)   { setSetting('killSearchFormRetries', Number(v)); },
        get killBgSearchWaits()        { return getSetting('killBgSearchWaits', 0); },
        set killBgSearchWaits(v)       { setSetting('killBgSearchWaits', Number(v)); },
        get bfWithdrawFails()          { return getSetting('bfWithdrawFails', 0); },
        set bfWithdrawFails(v)         { setSetting('bfWithdrawFails', Number(v)); },
        set killBgCheckEnabled(v)      { setSetting('killBgCheckEnabled', !!v); },

        get killBgSpamEnabled()        { return !!getSetting('killBgSpamEnabled', false); },
        set killBgSpamEnabled(v)       { setSetting('killBgSpamEnabled', !!v); },
        get killBgSpamIntervalSecs()   { return Number(getSetting('killBgSpamIntervalSecs', 2)); },
        set killBgSpamIntervalSecs(v)  { setSetting('killBgSpamIntervalSecs', Number(v)); },
        get killBgSpamTarget()         { return getSetting('killBgSpamTarget', ''); },
        set killBgSpamTarget(v)        { setSetting('killBgSpamTarget', String(v || '')); },
        get killBgSpamPaused()         { return !!getSetting('killBgSpamPaused', false); },
        set killBgSpamPaused(v)        { setSetting('killBgSpamPaused', !!v); },
        get bgSpamTravelTarget()       { return getSetting('bgSpamTravelTarget', ''); },
        set bgSpamTravelTarget(v)      { setSetting('bgSpamTravelTarget', String(v || '')); },

        get killShootEnabled()         { return !!getSetting('killShootEnabled', false); },
        set killShootEnabled(v)        { setSetting('killShootEnabled', !!v); },

        get killAnonymousShooting()    { return !!getSetting('killAnonymousShooting', false); },
        set killAnonymousShooting(v)   { setSetting('killAnonymousShooting', !!v); },

        get killBgCheckIntervalHrs()   { return Math.max(0.083, Number(getSetting('killBgCheckIntervalHrs', 6)) || 6); },
        set killBgCheckIntervalHrs(v)  { setSetting('killBgCheckIntervalHrs', Math.max(0.083, Number(v) || 6)); },

        get killPenaltyThreshold()     { return Number(getSetting('killPenaltyThreshold', 0)); },
        set killPenaltyThreshold(v)    { setSetting('killPenaltyThreshold', Number(v) || 0); },

        // Permanently dead players — never re-added from Players Found
        get killDeadPlayers()          { return getSetting('killDeadPlayers', []); },
        set killDeadPlayers(v)         { setSetting('killDeadPlayers', v); },

        // Per-player BG check toggle — stored as a Set of lowercased names
        get killBgCheckPlayers()       { return getSetting('killBgCheckPlayers', []); },
        set killBgCheckPlayers(v)      { setSetting('killBgCheckPlayers', v); },

        // Per-player shoot toggle — stored as array of names
        get killShootPlayers()         { return getSetting('killShootPlayers', []); },
        set killShootPlayers(v)        { setSetting('killShootPlayers', v); },

        // Per-player BG farm toggle — stored as array of names
        get killBgFarmPlayers()        { return getSetting('killBgFarmPlayers', []); },
        set killBgFarmPlayers(v)       { setSetting('killBgFarmPlayers', v); },

        // Pending kill/BG check action — survives page reload
        get pendingKillAction()        { return getSetting('pendingKillAction', null); },
        set pendingKillAction(v)       { setSetting('pendingKillAction', v); },

        // Kill loop active flag
        get killLoopActive()           { return !!getSetting('killLoopActive', false); },
        set killLoopActive(v)          { setSetting('killLoopActive', !!v); },

        // Cached drug capacity — set on each drugs page visit so crimes page can use it
        get drugCapacityCache()    { return Number(getSetting('drugCapacityCache', 0)); },
        set drugCapacityCache(v)   { setSetting('drugCapacityCache', Math.max(0, Number(v) || 0)); },

        // Pending bank action — survives page reload so the bank page handler knows what to do
        get pendingBankAction()    { return getSetting('pendingBankAction', null); },
        set pendingBankAction(v)   { setSetting('pendingBankAction', v); },

        get nextDriveReadyAt()     { return Number(getSetting('nextDriveReadyAt', 0)); },
        set nextDriveReadyAt(v)    { setSetting('nextDriveReadyAt', Number(v)); },

        get jailReleasesAt()       { return Number(getSetting('jailReleasesAt', 0)); },
        set jailReleasesAt(v)      { setSetting('jailReleasesAt', Number(v)); },

        get jailLastTimerMs()      { return Number(getSetting('jailLastTimerMs', 0)); },
        set jailLastTimerMs(v)     { setSetting('jailLastTimerMs', Number(v)); },

        get jailLastTimerSeenAt()  { return Number(getSetting('jailLastTimerSeenAt', 0)); },
        set jailLastTimerSeenAt(v) { setSetting('jailLastTimerSeenAt', Number(v)); },

        get pendingMissionCheck()  { return getSetting('pendingMissionCheck', null); },
        set pendingMissionCheck(v) { setSetting('pendingMissionCheck', v); },

        get missionGaveUp()        { return !!getSetting('missionGaveUp', false); },
        set missionGaveUp(v)       { setSetting('missionGaveUp', !!v); },

        get meltsSinceRepair()     { return Number(getSetting('meltsSinceRepair', 0)); },
        set meltsSinceRepair(v)    { setSetting('meltsSinceRepair', Math.max(0, Number(v) || 0)); },

        get meltRecoveryCount()    { return Number(getSetting('meltRecoveryCount', 0)); },
        set meltRecoveryCount(v)   { setSetting('meltRecoveryCount', Math.max(0, Number(v) || 0)); },

        get pendingMeltBullets()   { return Number(getSetting('pendingMeltBullets', 0)); },
        set pendingMeltBullets(v)  { setSetting('pendingMeltBullets', Math.max(0, Number(v) || 0)); },

        get pendingMeltCarText()   { return getSetting('pendingMeltCarText', ''); },
        set pendingMeltCarText(v)  { setSetting('pendingMeltCarText', String(v || '')); },

        get lastActionAt()         { return Number(getSetting('lastActionAt', 0)); },
        set lastActionAt(v)        { setSetting('lastActionAt', Number(v)); },

        get pausedReason()         { return getSetting('pausedReason', ''); },
        set pausedReason(v)        { setSetting('pausedReason', String(v || '')); },

        get nextGTAReadyAt()       { return Number(getSetting('nextGTAReadyAt', 0)); },
        set nextGTAReadyAt(v)      { setSetting('nextGTAReadyAt', Number(v)); },

        get nextMeltReadyAt()      { return Number(getSetting('nextMeltReadyAt', 0)); },
        set nextMeltReadyAt(v)     { setSetting('nextMeltReadyAt', Number(v)); },

        get panelCollapsed()       { return !!getSetting('panelCollapsed', false); },
        set panelCollapsed(v)      { setSetting('panelCollapsed', !!v); },

        get panelCompact()         { return !!getSetting('panelCompact', false); },
        set panelCompact(v)        { setSetting('panelCompact', !!v); },

        get panelHidden()          { return !!getSetting('panelHidden', false); },
        set panelHidden(v)         { setSetting('panelHidden', !!v); },

        get sessionStartedAt()     { return Number(getSetting('sessionStartedAt', 0)); },
        set sessionStartedAt(v)    { setSetting('sessionStartedAt', Number(v)); },

        get accumulatedRunMs()     { return Number(getSetting('accumulatedRunMs', 0)); },
        set accumulatedRunMs(v)    { setSetting('accumulatedRunMs', Number(v)); },



        get liveLog()  { return getSetting('liveLog', []); },
        set liveLog(v) { setSetting('liveLog', v); },

        get bustNoReload()         { return !!getSetting('bustNoReload', DEFAULTS.bustNoReload); },
        set bustNoReload(v)        { setSetting('bustNoReload', !!v); },
        get bustPollMin()          { return getSetting('bustPollMin', DEFAULTS.bustPollMin); },
        set bustPollMin(v)         { setSetting('bustPollMin', Number(v)); },
        get bustPollMax()          { return getSetting('bustPollMax', DEFAULTS.bustPollMax); },
        set bustPollMax(v)         { setSetting('bustPollMax', Number(v)); },

        // Extend perk thresholds
        get extendBulletsThreshold()      { return Number(getSetting('extendBulletsThreshold',     DEFAULTS.extendBulletsThreshold)); },
        set extendBulletsThreshold(v)     { setSetting('extendBulletsThreshold',     Number(v)); },
        get extendRaresThreshold()        { return Number(getSetting('extendRaresThreshold',       DEFAULTS.extendRaresThreshold)); },
        set extendRaresThreshold(v)       { setSetting('extendRaresThreshold',       Number(v)); },
        get extendDoubleMeltsThreshold()  { return Number(getSetting('extendDoubleMeltsThreshold', DEFAULTS.extendDoubleMeltsThreshold)); },
        set extendDoubleMeltsThreshold(v) { setSetting('extendDoubleMeltsThreshold', Number(v)); },
        get extendBulletValueThreshold()  { return Number(getSetting('extendBulletValueThreshold', DEFAULTS.extendBulletValueThreshold)); },
        set extendBulletValueThreshold(v) { setSetting('extendBulletValueThreshold', Number(v)); },
        get extendDoubleXpThreshold()     { return Number(getSetting('extendDoubleXpThreshold',    DEFAULTS.extendDoubleXpThreshold)); },
        set extendDoubleXpThreshold(v)    { setSetting('extendDoubleXpThreshold',    Number(v)); },
        get extendAlwaysSuccThreshold()   { return Number(getSetting('extendAlwaysSuccThreshold',  DEFAULTS.extendAlwaysSuccThreshold)); },
        set extendAlwaysSuccThreshold(v)  { setSetting('extendAlwaysSuccThreshold',  Number(v)); },
        get extendAlwaysBustThreshold()   { return Number(getSetting('extendAlwaysBustThreshold',  DEFAULTS.extendAlwaysBustThreshold)); },
        set extendAlwaysBustThreshold(v)  { setSetting('extendAlwaysBustThreshold',  Number(v)); },
        get extendDoubleCashThreshold()   { return Number(getSetting('extendDoubleCashThreshold',  DEFAULTS.extendDoubleCashThreshold)); },
        set extendDoubleCashThreshold(v)  { setSetting('extendDoubleCashThreshold',  Number(v)); },

        get bonusPerkOrder()   { return getSetting('bonusPerkOrder', '[]'); },
        set bonusPerkOrder(v)  { setSetting('bonusPerkOrder', v); },

        // Rank dropdowns
        get disableCrimesRank()    { return getSetting('disableCrimesRank', 'Global Boss'); },
        set disableCrimesRank(v)   { setSetting('disableCrimesRank', v); },
        get disableGtaRank()       { return getSetting('disableGtaRank', 'Global Boss'); },
        set disableGtaRank(v)      { setSetting('disableGtaRank', v); },

        // Leave cash on hand
        get leaveCashEnabled()     { return !!getSetting('leaveCashEnabled', false); },
        set leaveCashEnabled(v)    { setSetting('leaveCashEnabled', !!v); },
        get leaveCashOnHand()      { return Number(getSetting('leaveCashOnHand', 0)); },
        set leaveCashOnHand(v)     { setSetting('leaveCashOnHand', Number(v)); },

        // Bonus points
        get bonusPointsEnabled()   { return !!getSetting('bonusPointsEnabled', false); },
        set bonusPointsEnabled(v)  { setSetting('bonusPointsEnabled', !!v); },

        get autoBuyBgEnabled()     { return !!getSetting('autoBuyBgEnabled', DEFAULTS.autoBuyBgEnabled); },
        set autoBuyBgEnabled(v)    { setSetting('autoBuyBgEnabled', !!v); },
        get autoBuyBgMinPts()      { return Number(getSetting('autoBuyBgMinPts', DEFAULTS.autoBuyBgMinPts)); },
        set autoBuyBgMinPts(v)     { setSetting('autoBuyBgMinPts', Number(v)); },
        get autoBuyBgMins()        { return Number(getSetting('autoBuyBgMins', DEFAULTS.autoBuyBgMins)); },
        set autoBuyBgMins(v)       { setSetting('autoBuyBgMins', Number(v)); },

        // Extend per-perk checkboxes
        get extendBgs()            { return !!getSetting('extendBgs', false); },
        set extendBgs(v)           { setSetting('extendBgs', !!v); },
        get extendCars()           { return !!getSetting('extendCars', false); },
        set extendCars(v)          { setSetting('extendCars', !!v); },
        get extendBullets()        { return !!getSetting('extendBullets', false); },
        set extendBullets(v)       { setSetting('extendBullets', !!v); },
        get extendRares()          { return !!getSetting('extendRares', false); },
        set extendRares(v)         { setSetting('extendRares', !!v); },
        get extendDoubleMelts()    { return !!getSetting('extendDoubleMelts', false); },
        set extendDoubleMelts(v)   { setSetting('extendDoubleMelts', !!v); },
        get extendBulletValue()    { return !!getSetting('extendBulletValue', false); },
        set extendBulletValue(v)   { setSetting('extendBulletValue', !!v); },
        get extendDoubleXp()       { return !!getSetting('extendDoubleXp', false); },
        set extendDoubleXp(v)      { setSetting('extendDoubleXp', !!v); },
        get extendAlwaysSucc()     { return !!getSetting('extendAlwaysSucc', false); },
        set extendAlwaysSucc(v)    { setSetting('extendAlwaysSucc', !!v); },
        get extendAlwaysBust()     { return !!getSetting('extendAlwaysBust', false); },
        set extendAlwaysBust(v)    { setSetting('extendAlwaysBust', !!v); },
        get extendDoubleCash()     { return !!getSetting('extendDoubleCash', false); },
        set extendDoubleCash(v)    { setSetting('extendDoubleCash', !!v); },

        // Redeem per-perk checkboxes
        get redeemBulletValue()    { return !!getSetting('redeemBulletValue', false); },
        set redeemBulletValue(v)   { setSetting('redeemBulletValue', !!v); },
        get redeemCash()           { return !!getSetting('redeemCash', false); },
        set redeemCash(v)          { setSetting('redeemCash', !!v); },
        get redeemCars()           { return !!getSetting('redeemCars', false); },
        set redeemCars(v)          { setSetting('redeemCars', !!v); },
        get redeemPairFloor()      { return Number(getSetting('redeemPairFloor', 100)); },
        set redeemPairFloor(v)     { setSetting('redeemPairFloor', Number(v)); },
        get redeemBg()             { return !!getSetting('redeemBg', false); },
        set redeemBg(v)            { setSetting('redeemBg', !!v); },
        get autoBuyGun()           { return !!getSetting('autoBuyGun', false); },
        set autoBuyGun(v)          { setSetting('autoBuyGun', !!v); },
        get autoBuyGunType()       { return getSetting('autoBuyGunType', 'awp'); }, // 'awp' or 'ak47'
        set autoBuyGunType(v)      { setSetting('autoBuyGunType', v); },
        get autoBuyGunPtThreshold(){ return Number(getSetting('autoBuyGunPtThreshold', 100)); },
        set autoBuyGunPtThreshold(v){ setSetting('autoBuyGunPtThreshold', Number(v) || 100); },
        get redeemBullets()        { return !!getSetting('redeemBullets', false); },
        set redeemBullets(v)       { setSetting('redeemBullets', !!v); },
        get redeemBulletsCap()     { return parseFloat(getSetting('redeemBulletsCap', 2.0)) || 2.0; },
        set redeemBulletsCap(v)    { setSetting('redeemBulletsCap', parseFloat(v) || 2.0); },
        get redeemDoubleXp()       { return !!getSetting('redeemDoubleXp', false); },
        set redeemDoubleXp(v)      { setSetting('redeemDoubleXp', !!v); },
        get redeemAlwaysSucc()     { return !!getSetting('redeemAlwaysSucc', false); },
        set redeemAlwaysSucc(v)    { setSetting('redeemAlwaysSucc', !!v); },
        get redeemDoubleCash()     { return !!getSetting('redeemDoubleCash', false); },
        set redeemDoubleCash(v)    { setSetting('redeemDoubleCash', !!v); },
        get redeemRare()           { return !!getSetting('redeemRare', false); },
        set redeemRare(v)          { setSetting('redeemRare', !!v); },
        get redeemDoubleMelt()     { return !!getSetting('redeemDoubleMelt', false); },
        set redeemDoubleMelt(v)    { setSetting('redeemDoubleMelt', !!v); },
        get redeemAlwaysBust()     { return !!getSetting('redeemAlwaysBust', false); },
        set redeemAlwaysBust(v)    { setSetting('redeemAlwaysBust', !!v); }
    };

    // -------------------------------------------------------------------------
    // In-memory flags — not persisted, reset fresh on each page load
    // -------------------------------------------------------------------------

    // Prevents crime timer reset being clicked more than once per crimes page visit.
    // Cleared each time handleCrimesPage() is entered.
    let crimeResetUsedThisVisit = false;

    // every heartbeat tick — only logs once per page load.

    // Prevents the kill search result being logged repeatedly per page load.
    let killSearchResultHandledThisLoad = false;

    let loopBusy         = false;
    let autoBuyGunBusy   = false;
    let reloadPending    = false;
    let heartbeatHandle  = null;
    let nextReloadHandle = null;
    let jailObserver     = null;
    let jailPassiveMode  = false;
    let jailHadOwnRow    = false;

    let runToken       = 0;
    let actionInFlight = false;
    let lastCrimeClick = { id: null, at: 0 };

    let lastRenderedLogLength = 0;
    let lastRenderedLogFirst  = '';

    let toggleBtn                   = null;
    let autoDepositInput            = null;
    let depositThresholdEl          = null;
    let autoRepairInput             = null;
    let repairEveryEl               = null;
    let autoMissionsInput           = null;
    let autoGiveCarsInput           = null;
    let drugCompModeInput           = null;
    let autoDrugsInput              = null;
    let drugDepositMultiplierEl     = null;
    let leaveJailInput              = null;
    let leaveJailMinPointsEl        = null;
    let resetCrimesInput
    let resetCrimesFastModeInput    = null;
    let bgCrimeEnabledInput         = null;
    let diceJoinEnabledInput        = null;
    let bulletFactoryEnabledInput   = null;
    let killProtectedRecheckInput   = null;
    let killProtectedRecheckMinsEl  = null;
    let qtBgEnabledInput            = null;
    let qtBgThresholdEl             = null;
    let qtBulletsEnabledInput       = null;
    let qtBulletsThresholdEl        = null;
    let qtCarsEnabledInput          = null;
    let qtCarsIntervalEl            = null;
    let qtPerkExtendEnabledInput    = null;
    let qtPerkExtendMinsEl          = null;
    let qtPerkRedeemEnabledInput    = null;
    let qtPerkRedeemMinsEl          = null;
    let disableCrimesRankEl         = null;
    let disableGtaRankEl            = null;
    let leaveCashEnabledInput       = null;
    let leaveCashOnHandEl           = null;
    let bonusPointsEnabledInput     = null;
    let autoBuyBgEnabledInput       = null;
    let autoBuyBgMinPtsEl           = null;
    let autoBuyBgMinsEl             = null;
    let extendBgsInput              = null;
    let extendCarsInput             = null;
    let extendBulletsInput          = null;
    let extendRaresInput            = null;
    let extendDoubleMeltsInput      = null;
    let extendBulletValueInput      = null;
    let extendDoubleXpInput         = null;
    let extendAlwaysSuccInput       = null;
    let extendAlwaysBustInput       = null;
    let extendDoubleCashInput       = null;
    let redeemBulletValueInput      = null;
    let redeemCashInput             = null;
    let redeemCarsInput             = null;
    let redeemPairFloorEl           = null;
    let redeemBgInput               = null;
    let redeemBulletsInput          = null;
    let redeemDoubleXpInput         = null;
    let redeemAlwaysSuccInput       = null;
    let redeemDoubleCashInput       = null;
    let redeemRareInput             = null;
    let redeemDoubleMeltInput       = null;
    let redeemAlwaysBustInput       = null;
    let qtBulletsMinEl              = null;
    let qtPollMinEl                 = null;
    let qtBustEnabledInput          = null;
    let qtBustMaxPtsEl              = null;
    let qtBustMinAmtEl              = null;
    let qtAlwaysSuccEnabledInput    = null;
    let qtAlwaysSuccMaxPtsEl        = null;
    let qtAlwaysSuccMinAmtEl        = null;
    let qtDoubleMeltsEnabledInput   = null;
    let qtDoubleMeltsMaxPtsEl       = null;
    let qtDoubleMeltsMinAmtEl       = null;
    let qtDoubleXpEnabledInput      = null;
    let qtDoubleXpMaxPtsEl          = null;
    let qtDoubleXpMinAmtEl          = null;
    let qtDoubleCashEnabledInput    = null;
    let qtDoubleCashMaxPtsEl        = null;
    let qtDoubleCashMinAmtEl        = null;
    let qtRareEnabledInput          = null;
    let qtRareMaxPtsEl              = null;
    let qtRareMinAmtEl              = null;
    let qtBulletValueEnabledInput   = null;
    let qtBulletValueMaxPtsEl       = null;
    let qtBulletValueMinAmtEl       = null;
    let qtPollMaxEl                 = null;
    let qtPointsEnabledInput        = null;
    let qtPointsThresholdEl         = null;
    let killScanOnlineInput         = null;
    let killScanIntervalEl          = null;
    let killSearchInput             = null;
    let killBgCheckInput            = null;
    let killBgSpamInput             = null;
    let killBgSpamIntervalEl        = null;
    let killBgSpamTargetEl          = null;
    let killShootInput              = null;
    let killAnonymousInput          = null;
    let killBgCheckIntervalEl       = null;
    let killPenaltyThresholdEl      = null;
    let resetGTAInput               = null;
    let resetMeltInput              = null;
    let resetTimerMinPointsEl       = null;
    let logEl                       = null;
    let compactBtn                  = null;
    let hideBtn                     = null;
    let closeBtn                    = null;

    // No reload bust
    let bustNoReloadInput           = null;
    let bustPollMinEl               = null;
    let bustPollMaxEl               = null;

    // Extend perk threshold inputs
    let extendBulletsThreshEl       = null;
    let extendRaresThreshEl         = null;
    let extendDoubleMeltsThreshEl   = null;
    let extendBulletValueThreshEl   = null;
    let extendDoubleXpThreshEl      = null;
    let extendAlwaysSuccThreshEl    = null;
    let extendAlwaysBustThreshEl    = null;
    let extendDoubleCashThreshEl    = null;

    function log(...args) {
        if (DEFAULTS.logToConsole) console.log('[UG-BOT]', ...args);
    }

    function timestamp() {
        return new Date().toLocaleTimeString();
    }

    function addLiveLog(message) {
        const arr = state.liveLog;
        arr.unshift(`[${timestamp()}] ${message}`);
        state.liveLog = arr.slice(0, DEFAULTS.maxLiveLogEntries);
        renderLiveLog();
        log(message);
    }

    const debugLogLastAt = Object.create(null);
    function addDebugLog(key, message, intervalMs = 10000) {
        if (!state.killDebugEnabled) return;
        const nowMs = now();
        if (debugLogLastAt[key] && (nowMs - debugLogLastAt[key]) < intervalMs) return;
        debugLogLastAt[key] = nowMs;
        addLiveLog(message);
    }

    function updateStats(mutator) { /* stats removed */ }
    function setLastActionText(text) { /* stats removed */ }

    function getCurrentRuntimeMs() {
        const base = state.accumulatedRunMs;
        if (!state.enabled || !state.sessionStartedAt) return base;
        return base + Math.max(0, now() - state.sessionStartedAt);
    }

    function formatRuntime(ms) {
        const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
        const hours   = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':');
    }

    function startRuntimeIfNeeded() {
        if (!state.sessionStartedAt) state.sessionStartedAt = now();
    }

    function stopRuntimeIfRunning() {
        if (state.sessionStartedAt) {
            state.accumulatedRunMs = getCurrentRuntimeMs();
            state.sessionStartedAt = 0;
        }
    }

    function clearPendingMeltResult() {
        state.pendingMeltBullets = 0;
        state.pendingMeltCarText = '';
    }

    function resetSessionStats() {
        state.liveLog           = [];
        state.accumulatedRunMs  = 0;
        state.sessionStartedAt  = state.enabled ? now() : 0;
        state.meltsSinceRepair  = 0;
        state.meltRecoveryCount = 0;
        state.pendingMissionCheck = null;
        state.missionGaveUp       = false;
        state.pendingBankAction   = null;
        crimeResetUsedThisVisit   = false;
        state.gtaResetLoopActive  = false;
        state.meltResetLoopActive = false;
        state.killSearchLoopActive = false;
        state.killLoopActive       = false;
        state.killSearchIndex      = 0;
        state.killCurrentSearch    = '';
        state.pendingKillAction    = null;
        state.killBgShootPending   = null;
        clearPendingMeltResult();
        renderLiveLog();
        addLiveLog('Session log cleared');
    }

    // Dispatch a click with randomised coordinates within the element's bounds,
    // so the game's click-coordinate bot detection sees realistic values.
    // Box-Muller transform — generates a normally distributed random number
    function randGaussian(mean, stdDev) {
        let u, v;
        do {
            u = Math.random();
            v = Math.random();
        } while (u === 0);
        const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        return mean + z * stdDev;
    }

    // Returns a click coordinate clustered towards the centre of a dimension
    // min/max define the clickable range, result is clamped within it
    function randClickCoord(min, max) {
        const centre = (min + max) / 2;
        const stdDev  = (max - min) / 6; // ~99.7% of clicks within bounds
        const val     = randGaussian(centre, stdDev);
        return Math.round(Math.min(max, Math.max(min, val)));
    }

    function humanClick(el) {
        if (!el) return;
        let rect = el.getBoundingClientRect();
        // OperaGX and some browsers return zero dimensions for elements whose
        // parent wrapper was recently made visible — walk up to find a valid rect
        if (rect.width === 0 || rect.height === 0) {
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
                const parentRect = parent.getBoundingClientRect();
                if (parentRect.width > 0 && parentRect.height > 0) {
                    rect = parentRect;
                    break;
                }
                parent = parent.parentElement;
            }
        }
        const margin = 3;
        const xMin = rect.left + margin;
        const xMax = rect.right  - margin;
        const yMin = rect.top  + margin;
        const yMax = rect.bottom - margin;
        // Fall back to centre click if element is too small for margin
        const x = xMax > xMin ? randClickCoord(xMin, xMax) : (rect.left + rect.right)  / 2;
        const y = yMax > yMin ? randClickCoord(yMin, yMax) : (rect.top  + rect.bottom) / 2;
        const ev = new MouseEvent('click', {
            bubbles: true, cancelable: true,
            clientX: x, clientY: y,
            pageX: x + window.scrollX, pageY: y + window.scrollY,
        });
        el.dispatchEvent(ev);
    }

    function rand(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    // Navigation delay — uses personality values so dupe accounts feel slower/different
    function navRand() {
        return rand(PERSONALITY.navDelayMin, PERSONALITY.navDelayMax);
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function now() { return Date.now(); }

    function recentlyActed(extraBuffer = 0) {
        return now() - state.lastActionAt < extraBuffer;
    }

    function currentPage() {
        return new URL(window.location.href).searchParams.get('p') || '';
    }

    function currentActionParam() {
        return new URL(window.location.href).searchParams.get('a') || '';
    }

    function currentPageNum() {
        const raw = new URL(window.location.href).searchParams.get('page');
        const n   = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    function isCrimesPage() { return currentPage() === 'crimes'; }
    function isGTAPage()    { return currentPage() === 'gta'; }
    function isMeltPage()   { return currentPage() === 'melt'; }
    function isCarsPage()   { return currentPage() === 'cars'; }
    function isDrugsPage()  { return currentPage() === 'drugs'; }
    function isCarPage()    { return currentPage() === 'car'; }
    function isBankPage()   { return currentPage() === 'bank'; }

    function visible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function textOf(el) {
        return (el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(str) {
        return String(str)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
    }

    function clearScheduledReload() {
        if (nextReloadHandle) {
            clearTimeout(nextReloadHandle);
            nextReloadHandle = null;
        }
        reloadPending = false;
    }

    function scheduleReload(ms) {
        if (reloadPending) return;
        reloadPending = true;
        addLiveLog(`Reload scheduled in ${Math.round(ms / 1000)}s`);
        nextReloadHandle = setTimeout(() => window.location.reload(), ms);
    }

    function isRunValid(token) {
        return state.enabled && token === runToken;
    }

    function cancelCurrentRun() {
        runToken += 1;
        actionInFlight = false;
    }

    function setPaused(reason) {
        stopRuntimeIfRunning();
        state.enabled      = false;
        state.pausedReason = reason || '';
        cancelCurrentRun();
        stopHeartbeat();
        stopJailObserver();
        stopBgCrime();
        stopDiceJoiner();
        stopQTSniper();
        stopQTPerkExtender();
        stopQTPerkRedeemer();
        stopQTCarScanner();
        stopNoReloadBust();
        stopAutoBuyBg();
        stopBonusPointsSpender();
        stopBustObserver();
        clearScheduledReload();
        state.gtaResetLoopActive   = false;
        state.meltResetLoopActive  = false;
        state.bustLoopActive       = false;
        state.killSearchLoopActive = false;
        state.killLoopActive       = false;
        state.killCurrentSearch    = '';
        state.pendingKillAction    = null;
        updatePanel();
        addLiveLog(`Paused: ${reason}`);
    }

    function hasCTCChallenge() {
        return CTC.isVisible();
    }

    function saveScrollPositions() {
        const log     = document.querySelector('#ug-bot-log');
        const klist   = document.querySelector('#ug-bot-kill-list');
        const panel   = document.querySelector('#ug-bot-panel');
        if (log)   setSetting('scrollLog',   log.scrollTop);
        if (klist) setSetting('scrollKill',  klist.scrollTop);
        if (panel) setSetting('scrollPanel', panel.scrollTop);
    }
    window.addEventListener('beforeunload', saveScrollPositions);

    function navigateToUrl(rawUrl) {
        // Do not attach bot identity to the URL. The active bot window is tracked
        // with Tampermonkey per-tab storage instead, so normal navigation and
        // copied links stay clean.
        window.location.href = String(rawUrl);
    }

    function gotoPage(pageName, extraParams = {}) {

        saveScrollPositions();
        clearScheduledReload();
        reloadPending = true;
        const url = new URL(window.location.href);
        url.searchParams.set('p', pageName);

        // Whitelist approach — only keep params explicitly passed in extraParams.
        // Delete everything else to prevent URL pollution from other pages
        // (e.g. ?show=bullet&id=2 from weaponry, ?myrank=19&gun=9 from bullet calculator)
        const allowedKeys = new Set(['p', ...Object.keys(extraParams)]);
        for (const key of [...url.searchParams.keys()]) {
            if (!allowedKeys.has(key)) url.searchParams.delete(key);
        }

        for (const [key, value] of Object.entries(extraParams)) {
            if (value == null || value === '') {
                url.searchParams.delete(key);
            } else {
                url.searchParams.set(key, String(value));
            }
        }

        addLiveLog(`Navigating to ${pageName}${extraParams.page ? ' page ' + extraParams.page : ''}`);
        navigateToUrl(url.toString());
    }

    function gotoCleanMeltPage(pageNum = 1) {
        gotoPage('melt', { page: pageNum, a: null });
    }

    function parseDurationTextToMs(text) {
        if (!text) return null;
        const cleaned = text.replace(/\s+/g, ' ').trim().toLowerCase();
        if (cleaned.includes('available')) return 0;

        let totalSeconds = 0;
        let matched      = false;

        const h = cleaned.match(/(\d+)\s*h/);
        const m = cleaned.match(/(\d+)\s*m/);
        const s = cleaned.match(/(\d+)\s*s/);

        if (h) { totalSeconds += parseInt(h[1], 10) * 3600; matched = true; }
        if (m) { totalSeconds += parseInt(m[1], 10) * 60;   matched = true; }
        if (s) { totalSeconds += parseInt(s[1], 10);         matched = true; }

        return matched ? totalSeconds * 1000 : null;
    }

    function parseMoney(text) {
        if (!text) return 0;
        return Number(String(text).replace(/[^0-9.-]/g, '')) || 0;
    }

    function parsePercent(text) {
        if (!text) return 0;
        return Number(String(text).replace(/[^0-9.]/g, '')) || 0;
    }

    function parseBulletValue(text) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (/none/i.test(clean)) return 0;
        // Take only the first number — value may be "276 (-28)" where -28 is the gang cut
        const match = clean.match(/(\d[\d,]*)/);
        return match ? Number(match[1].replace(/,/g, '')) : 0;
    }

    function parseUnits(text) {
        return Number(String(text || '').replace(/[^0-9]/g, '')) || 0;
    }

    // Formats a number with comma separators for display in input fields.
    function formatNumberWithCommas(value) {
        const n = Math.floor(Math.max(0, Number(String(value).replace(/[^0-9]/g, '')) || 0));
        return n.toLocaleString('en-GB');
    }

    // Strips commas from a number input value before reading it as a number.
    function parseFormattedNumber(value) {
        return Math.max(0, Number(String(value || '').replace(/[^0-9]/g, '')) || 0);
    }

    // Attaches comma formatting to a number input — formats on blur, strips on focus.
    function attachNumberFormatting(input) {
        if (!input) return;

        input.addEventListener('focus', () => {
            const raw = parseFormattedNumber(input.value);
            input.value = raw > 0 ? String(raw) : '';
        });

        input.addEventListener('blur', () => {
            const raw = parseFormattedNumber(input.value);
            input.value = raw > 0 ? formatNumberWithCommas(raw) : '';
        });
    }

    // Stat bar readers — available on every page
    function getPlayerMoney()    { return parseMoney(document.querySelector('#player-money')?.textContent    || '0'); }
    function getPlayerBullets()  { return parseUnits((document.querySelector('#player-bullets')?.textContent || '0').replace(/[^0-9,]/g, '')); }
    function getPlayerSwiss()    { return parseMoney(document.querySelector('#player-swiss')?.textContent    || '0'); }

    // Points reader — used for all point-spending decisions
    function getPlayerPoints() {
        return parseUnits(document.querySelector('#player-points')?.textContent || '0');
    }

    function getQuickDepositButton() {
        return document.querySelector('input.quick_bank[data="deposit"]');
    }

    // Quick deposit is only active when drug running is disabled.
    // When drug running is enabled the Swiss Bank deposit replaces it.
    async function maybeQuickDeposit() {
        if (!state.autoDepositEnabled) return false;
        if (state.autoDrugsEnabled)    return false;
        // Don't deposit during an active bullet factory run — but clear stale state if feature disabled
        if (state.pendingBulletRun) {
            if (!state.bulletFactoryEnabled) {
                state.pendingBulletRun = null;
            } else {
                return false;
            }
        }
        if (!isCrimesPage())           return false;

        const money     = getPlayerMoney();
        const btn       = getQuickDepositButton();
        if (!btn) return false;

        // Leave cash on hand overrides threshold
        if (state.leaveCashEnabled && state.leaveCashOnHand > 0) {
            if (money <= state.leaveCashOnHand) return false;
            // Only deposit if surplus exists
        } else {
            const threshold = state.autoDepositThreshold;
            if (money < threshold) return false;
        }

        state.lastActionAt = Date.now();

        await wait(rand(400, 900));
        humanClick(btn);

        updateStats(s => {
            s.deposits += 1;
            s.lastActionText = `Deposited $${money.toLocaleString()}`;
        });
        addLiveLog(`Quick Deposit clicked at $${money.toLocaleString()} (threshold: $${threshold.toLocaleString()})`);

        // Quick deposit is AJAX — no page reload needed, continue normally
        return true;
    }

    function getQuickLinkByPage(pageName) {
        return [...document.querySelectorAll('#q_links a')].find(a => {
            return (a.getAttribute('href') || '').includes(`?p=${pageName}`);
        }) || null;
    }

    function getQuickLinkStatus(pageName) {
        const a = getQuickLinkByPage(pageName);
        if (!a) return { exists: false, available: false, text: '', ms: null };

        const span       = a.querySelector('span');
        const statusText = textOf(span);
        return {
            exists:    true,
            available: /available/i.test(statusText),
            text:      statusText,
            ms:        parseDurationTextToMs(statusText)
        };
    }

    const GUN_VALUES = {
        'none': 0, 'glock': 1, 'fiveseven': 2, 'uzi': 3, 'spas-12': 4,
        'mp5k': 5, 'ak74u': 6, 'm16': 7, 'famas': 8, 'ak47': 9, 'awp': 10
    };

    const RANKS = [
        'Civilian', 'Vandal', 'Hustler', 'Riff-Raff', 'Ruffian',
        'Homeboy', 'Homie', 'Criminal', 'Hitman', 'Trusted Hitman',
        'Assassin', 'Trusted Assassin', 'Gangster', 'Original Gangster',
        'Boss', 'Regional Boss', 'Global Boss', 'Don', 'Regional Don',
        'Global Don', 'Godfather', 'Regional Godfather', 'Global Godfather',
        'Underworld Gangster'
    ];

    const UNLOCK_RANK = {
        'gang': 'Assassin',
        '1':    'Trusted Hitman',
        '2':    'Hitman',
        'drug': 'Criminal',
        '3':    'Homie',
        '4':    'Homeboy',
        '5':    'Ruffian',
        '6':    'Vandal',
        '7':    'Civilian',
        'gta':  'Homeboy',
        'melt': 'Civilian'
    };

    function getPlayerRank() {
        return (document.querySelector('#player-rank')?.textContent || '').trim();
    }

    function getPlayerGunValue() {
        const gunName = (document.querySelector('#player-gun')?.textContent || '').trim().toLowerCase();
        return GUN_VALUES[gunName] ?? 0;
    }

    function getPlayerRankIndex() {
        const rank = getPlayerRank();
        const idx  = RANKS.indexOf(rank);
        return idx === -1 ? 0 : idx;
    }

    function isLockedByRank(actionId) {
        const requiredRank = UNLOCK_RANK[actionId];
        if (!requiredRank) return false;
        const requiredIdx = RANKS.indexOf(requiredRank);
        return getPlayerRankIndex() < requiredIdx;
    }

    function isGTALocked()  { return isLockedByRank(GTA_DEF.id); }
    function isMeltLocked() { return isLockedByRank(MELT_DEF.id); }

    function isGTAEnabled()   { return state.enabledActions.includes(GTA_DEF.id); }
    function isMeltEnabled()  { return state.enabledActions.includes(MELT_DEF.id); }

    // Melt is only usable once GTA is unlocked — no cars available before that rank
    function isMeltUsable() {
        return isMeltEnabled() && !isMeltLocked() && !isGTALocked();
    }
    function isDrugsEnabled() { return state.autoDrugsEnabled; }

    function isInternalGTAReady() { return now() >= state.nextGTAReadyAt; }

    function markGTACooldownStarted() {
        state.nextGTAReadyAt = now() + GTA_COOLDOWN_MS;
    }

    function getInternalGTARemainingMs() {
        return Math.max(0, state.nextGTAReadyAt - now());
    }

    function syncGTAReadyFromQuickLink() {
        const gtaInfo = getQuickLinkStatus('gta');
        if (!gtaInfo.exists) return false;

        if (gtaInfo.available) {
            // Only clear the cooldown if there isn't one already active.
            // If nextGTAReadyAt is in the future, a steal just happened and the
            // quick link hasn't updated yet — don't wipe the cooldown.
            if (isInternalGTAReady()) state.nextGTAReadyAt = now();
            return true;
        }

        if (gtaInfo.ms != null && gtaInfo.ms > 0) {
            const newReadyAt = now() + gtaInfo.ms;
            // Only update if it extends the timer — never reset a ready state backwards
            if (newReadyAt > state.nextGTAReadyAt && !isInternalGTAReady()) {
                state.nextGTAReadyAt = newReadyAt;
            }
            return true;
        }

        return false;
    }

    function isInternalMeltReady() { return now() >= state.nextMeltReadyAt; }

    function markMeltCooldownStarted() {
        state.nextMeltReadyAt = now() + MELT_COOLDOWN_MS;
    }

    function getInternalMeltRemainingMs() {
        return Math.max(0, state.nextMeltReadyAt - now());
    }

    function syncMeltReadyFromQuickLink() {
        const meltInfo = getQuickLinkStatus('melt');
        if (!meltInfo.exists) return false;

        if (meltInfo.available) {
            if (!isInternalMeltReady()) state.nextMeltReadyAt = now();
            return true;
        }

        if (meltInfo.ms != null && meltInfo.ms > 0) {
            const newReadyAt = now() + meltInfo.ms;
            // Only update if it extends the timer — never reset a ready state backwards
            if (newReadyAt > state.nextMeltReadyAt && !isInternalMeltReady()) {
                state.nextMeltReadyAt = newReadyAt;
            }
            return true;
        }

        return false;
    }

    // Drive cooldown has no hardcoded constant — it is car-dependent and varies per player.
    // Always derived from the quick links bar so it works correctly for any car.
    function getDriveQuickLinkStatus() {
        const a = [...document.querySelectorAll('#q_links a')].find(a =>
            /^drive/i.test(a.textContent.trim())
        );
        if (!a) return { exists: false, available: false, text: '', ms: null };
        const span       = a.querySelector('span');
        const statusText = textOf(span);
        return {
            exists:    true,
            available: /available/i.test(statusText),
            text:      statusText,
            ms:        parseDurationTextToMs(statusText)
        };
    }

    function isInternalDriveReady() { return now() >= state.nextDriveReadyAt; }

    function getInternalDriveRemainingMs() {
        return Math.max(0, state.nextDriveReadyAt - now());
    }

    function syncDriveReadyFromQuickLink() {
        const driveInfo = getDriveQuickLinkStatus();
        if (!driveInfo.exists) return false;

        if (driveInfo.available) {
            state.nextDriveReadyAt = now();
            return true;
        }

        if (driveInfo.ms != null && driveInfo.ms > 0) {
            state.nextDriveReadyAt = now() + driveInfo.ms;
            return true;
        }

        return false;
    }

    function shouldRunRepairCycle() {
        return state.autoRepairEnabled && state.meltsSinceRepair >= state.repairEveryMelts;
    }

    // =========================================================================
    // POINT RESET HELPERS
    // =========================================================================

    // -------------------------------------------------------------------------
    // Crime timer reset
    // The reset button is always present on the crimes page regardless of whether
    // any crimes are on cooldown. It is a client-side button that fires an AJAX
    // request — the page does NOT reload. Success is indicated by "Timers reset!"
    // appearing in #showmessi. We only click it after committing all available
    // crimes first, and only once per crimes page visit.
    // -------------------------------------------------------------------------

    // Detects the "You can now continue playing" message that appears after a
    // CTC is solved on the crimes page. When present, the page JS hasn't fully
    // updated crime button visibility yet and we need to wait for it to settle.
    function hasCTCContinueMessage() {
        return [...document.querySelectorAll('.bgm.success')].some(el =>
            /you can now continue playing/i.test(textOf(el))
        );
    }

    function getCrimeResetButton() {
        // Identified by id="reset" and data="reset" — distinct from the commit buttons
        return document.querySelector('input[type="button"][id="reset"][data="reset"]');
    }

    // Returns true if any enabled crime's commit button is currently hidden,
    // meaning it is on cooldown. Uses the #bcrime span visibility which is
    // set by the game's own timeme() JavaScript — always accurate.
    function hasAnyCrimeOnCooldown() {
        const enabled = state.enabledActions;
        return CRIME_DEFS.some(c => {
            if (!enabled.includes(c.id)) return false;
            if (isLockedByRank(c.id)) return false;
            const wrapper = document.querySelector(`#bcrime${c.id}`);
            if (!wrapper) return false;
            // The game hides the wrapper span when the crime is on cooldown
            return !visible(wrapper);
        });
    }

    function hasCrimeResetSuccess() {
        // The AJAX response populates #showmessi with a confirmation message
        return /timers reset/i.test(textOf(document.querySelector('#showmessi')));
    }

    async function tryCrimeReset(fastMode = false) {
        if (!state.resetCrimesEnabled) return false;
        if (crimeResetUsedThisVisit)   return false;

        const points = getPlayerPoints();
        if (points < state.resetTimerMinPoints) {
            addLiveLog(`Crime reset skipped — only ${points} points (minimum: ${state.resetTimerMinPoints})`);
            return false;
        }

        const btn = getCrimeResetButton();
        if (!btn) return false;

        state.lastActionAt = now();

        // In fast mode use minimal delays — just enough for the browser to process
        if (fastMode) {
            await wait(rand(60, 120));
        } else {
            await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
        }

        const freshBtn = getCrimeResetButton();
        if (!freshBtn) return false;

        humanClick(freshBtn);
        crimeResetUsedThisVisit = true;

        updateStats(s => {
            s.crimeResets   += 1;
            s.lastActionText = `Crime timers reset (cost 6pts, had ${points})`;
        });
        addLiveLog(`Crime timers reset — had ${points} points`);

        // Wait briefly for the AJAX response to settle before committing crimes
        // Fast mode uses a shorter settle wait
        if (fastMode) {
            await wait(rand(150, 250));
        } else {
            await wait(rand(800, 1200));
        }
        return true;
    }

    // -------------------------------------------------------------------------
    // GTA timer reset
    // The reset button is a form POST — clicking it reloads the page.
    // It is only present on the GTA page when the cooldown is active.
    // After the reload the page shows a success message and the Steal button
    // is immediately available.
    // -------------------------------------------------------------------------

    function getGTAResetButton() {
        return document.querySelector('form input[type="submit"][value="Reset Timers (3 Points)"]');
    }

    function hasGTAResetSuccess() {
        // Present after a reload following a successful GTA reset
        return [...document.querySelectorAll('.bgm.success')].some(el =>
            /timers reset/i.test(textOf(el))
        );
    }

    async function tryGTAReset() {
        if (!state.resetGTAEnabled) return false;

        const points = getPlayerPoints();
        if (points < state.resetTimerMinPoints) {
            addLiveLog(`GTA reset skipped — only ${points} points (minimum: ${state.resetTimerMinPoints})`);
            return false;
        }

        const btn = getGTAResetButton();
        if (!btn) return false;

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshBtn = getGTAResetButton();
        if (!freshBtn) return false;

        humanClick(freshBtn);

        updateStats(s => {
            s.gtaResets     += 1;
            s.lastActionText = `GTA timer reset (cost 3pts, had ${points})`;
        });
        addLiveLog(`GTA timer reset — had ${points} points`);

        // Page will reload via POST — no further action needed here
        return true;
    }

    // -------------------------------------------------------------------------
    // Melt timer reset
    // Also a form POST — clicking it reloads the page.
    // Only present when the melt is on cooldown.
    // After the reload a CTC may appear before the car list is shown.
    // The existing CTC solver handles this automatically.
    // -------------------------------------------------------------------------

    function getMeltResetButton() {
        return document.querySelector('form input[type="submit"][value="Reset Timer (4 Points)"]');
    }

    function hasMeltResetSuccess() {
        // Present after a reload following a successful melt reset
        return [...document.querySelectorAll('.bgm.success')].some(el =>
            /timers reset/i.test(textOf(el))
        );
    }

    async function tryMeltReset() {
        if (!state.resetMeltEnabled) return false;

        const points = getPlayerPoints();
        if (points < state.resetTimerMinPoints) {
            addLiveLog(`Melt reset skipped — only ${points} points (minimum: ${state.resetTimerMinPoints})`);
            state.meltResetLoopActive = false;
            return false;
        }

        const btn = getMeltResetButton();
        if (!btn) return false;

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshBtn = getMeltResetButton();
        if (!freshBtn) return false;

        humanClick(freshBtn);

        updateStats(s => {
            s.meltResets    += 1;
            s.lastActionText = `Melt timer reset (cost 4pts, had ${points})`;
        });
        addLiveLog(`Melt timer reset — had ${points} points`);

        // Page will reload via POST — no further action needed here
        return true;
    }

    // =========================================================================
    // DRUG RESERVE + BANKING
    // =========================================================================

    // Minimum cash to keep on hand — enough to buy a full capacity of Heroin in USA.
    function calcDrugReserve(capacity) {
        return capacity * DRUG_HEROIN_USA_PRICE;
    }

    // Reads drug capacity from the drugs page info section.
    // Checks for the "Total" line first which includes satchel capacity,
    // then falls back to the rank-only "hold X units" line.
    function getDrugCapacity() {
        // Try to find the Total line first — present when player owns a satchel.
        // HTML: <div class="bgl"><b>Total</b> 7,500</div>
        // Must match ONLY divs where the entire text is "Total X,XXX" to avoid
        // matching laundered drug lines which also contain numbers.
        const bglDivs = [...document.querySelectorAll('.w40.i.bgd .bgl')];
        for (const el of bglDivs) {
            const text = textOf(el);
            // Match "Total X,XXX" where Total is the only word before the number
            const match = text.match(/^total\s+([\d,]+)$/i);
            if (match) {
                const units = parseUnits(match[1]);
                if (units > 0) return units;
            }
        }

        // Fall back to the rank-only capacity line
        // HTML: <div class="bgd">At your rank you can hold 5,000 units of drugs</div>
        const allDivs = [...document.querySelectorAll('.w40.i.bgd .bgd, .w40.i.bgd .bgl, .w40.i.bgd .bgm')];
        for (const el of allDivs) {
            const text  = textOf(el);
            const match = text.match(/hold\s+([\d,]+)\s+units/i);
            if (match) return parseUnits(match[1]);
        }

        return 0;
    }

    // Reads total currently carried drug units by summing the Units column.
    function getDrugCarriedUnits() {
        const rows  = [...document.querySelectorAll('form table.wo tr.chs')];
        let   total = 0;
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) total += parseUnits(cells[1].textContent);
        }
        return total;
    }

    // Returns true if there are drugs that should be sold in the current country.
    function hasDrugsToSellInCurrentCountry(currentCountry) {
        const rows = [...document.querySelectorAll('form table.wo tr.chs')];
        if (!rows.length) return false;

        const drugToBuyHere = getDrugForCurrentCountry(currentCountry);

        for (const row of rows) {
            const cells    = row.querySelectorAll('td');
            if (cells.length < 1) continue;
            const drugName = textOf(cells[0]).toLowerCase();

            if (!drugToBuyHere) return true;
            if (drugName !== drugToBuyHere.name.toLowerCase()) return true;
        }

        return false;
    }

    // Manually selects only drugs that should be sold in the current country.
    async function selectDrugsToSell(currentCountry) {
        const drugToBuyHere = getDrugForCurrentCountry(currentCountry);
        const checkboxRows  = [...document.querySelectorAll('form table.wo tr.chs')];

        const allCheckboxes = [...document.querySelectorAll('form table.wo input[type="checkbox"][name="id[]"]')];
        for (const cb of allCheckboxes) cb.checked = false;

        let selected = 0;

        for (const row of checkboxRows) {
            const cells    = row.querySelectorAll('td');
            if (cells.length < 1) continue;
            const drugName = textOf(cells[0]).toLowerCase();
            const cb       = row.querySelector('input[type="checkbox"][name="id[]"]');
            if (!cb) continue;

            if (!drugToBuyHere || drugName !== drugToBuyHere.name.toLowerCase()) {
                cb.checked = true;
                selected++;
            }
        }

        return selected;
    }

    function hasDrugOverCapacityError() {
        return [...document.querySelectorAll('div.bgm.fail')].some(el =>
            /can only carry/i.test(textOf(el))
        );
    }

    function getSwissBankAmountInput() {
        const forms = [...document.querySelectorAll('form')];
        const swissForm = forms.find(f => f.querySelector('input[name="type"][value="swiss"]'));
        return swissForm ? swissForm.querySelector('input[name="amount"]') : null;
    }

    function getSwissBankDepositButton() {
        const forms     = [...document.querySelectorAll('form')];
        const swissForm = forms.find(f => f.querySelector('input[name="type"][value="swiss"]'));
        return swissForm ? swissForm.querySelector('input[name="deposit"][value="Deposit"]') : null;
    }

    function getSwissBankWithdrawButton() {
        const forms     = [...document.querySelectorAll('form')];
        const swissForm = forms.find(f => f.querySelector('input[name="type"][value="swiss"]'));
        return swissForm ? swissForm.querySelector('input[name="withdraw"][value="Withdraw"]') : null;
    }

    function hasBankWithdrawSuccess() {
        return [...document.querySelectorAll('div.bgm.success')].some(el =>
            /withdrawn/i.test(textOf(el))
        );
    }

    function hasBankActionFail() {
        return [...document.querySelectorAll('div.bgm.fail')].some(el =>
            /don't have that much money/i.test(textOf(el))
        );
    }

    function hasBankDepositSuccess() {
        return [...document.querySelectorAll('div.bgm.success')].some(el =>
            /deposited/i.test(textOf(el))
        );
    }

    async function submitSwissBankAction(amount, isDeposit) {
        const amountInput = getSwissBankAmountInput();
        const actionBtn   = isDeposit ? getSwissBankDepositButton() : getSwissBankWithdrawButton();

        if (!amountInput || !actionBtn) {
            addLiveLog(`Swiss Bank: form elements not found for ${isDeposit ? 'deposit' : 'withdrawal'}`);
            return false;
        }

        amountInput.value  = String(Math.floor(amount));
        state.lastActionAt = now();

        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshInput  = getSwissBankAmountInput();
        const freshAction = isDeposit ? getSwissBankDepositButton() : getSwissBankWithdrawButton();
        if (!freshInput || !freshAction) return false;

        freshInput.value = String(Math.floor(amount));
        humanClick(freshAction);
        return true;
    }

    function shouldDoSwissDeposit() {
        if (!isDrugsEnabled()) return false;

        const capacity = state.drugCapacityCache;
        if (capacity <= 0) return false;

        const cash = getPlayerMoney();

        // Leave cash on hand overrides swiss deposit multiplier
        if (state.leaveCashEnabled && state.leaveCashOnHand > 0) {
            return cash > state.leaveCashOnHand;
        }

        const reserve    = calcDrugReserve(capacity);
        const multiplier = state.drugDepositMultiplier;
        const trigger    = reserve * multiplier;

        return cash > trigger;
    }

    function calcSwissDepositAmount() {
        const capacity = state.drugCapacityCache;
        const cash     = getPlayerMoney();

        // Leave cash on hand overrides calculation
        if (state.leaveCashEnabled && state.leaveCashOnHand > 0) {
            return Math.max(0, cash - state.leaveCashOnHand);
        }

        const reserve  = calcDrugReserve(capacity);
        return Math.max(0, cash - reserve);
    }

    // =========================================================================
    // BANK PAGE HANDLER
    // =========================================================================

    async function handleBankPage() {
        stopJailObserver();

        const pending = state.pendingBankAction;

        if (!pending) {
            addLiveLog('Bank page: no pending action — returning to crimes');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (pending.type === 'withdraw' && hasBankWithdrawSuccess()) {
            addLiveLog(`Swiss Bank: withdrew $${pending.amount.toLocaleString()} successfully`);
            state.bfWithdrawFails = 0; // reset on success
            updateStats(s => {
                s.swissWithdrawals += 1;
                s.lastActionText    = `Swiss withdrew $${pending.amount.toLocaleString()}`;
            });
            state.pendingBankAction = null;
            await wait(navRand());
            if (pending.source === 'bulletFactory' && pending.substage === 'topup') {
                // Mid-run top-up — go back to the weaponry page for the current target
                const run = state.pendingBulletRun;
                const target = run?.targets?.[0];
                if (target) {
                    state.pendingBulletRun = { ...run, stage: 'buy' };
                    navigateToUrl(getBulletFactoryUrl(target.countryId));
                } else {
                    state.pendingBulletRun = null;
                    gotoPage('crimes');
                }
            } else if (pending.source === 'bulletFactory') {
                // Initial withdraw confirmed — now advance stage to travel
                if (state.pendingBulletRun) state.pendingBulletRun = { ...state.pendingBulletRun, stage: 'travel' };
                gotoPage('cars');
            } else {
                gotoPage('drugs');
            }
            return;
        }

        // If the bank returned a failure message, clear and move on immediately
        if (hasBankActionFail()) {
            addLiveLog(`Swiss Bank: withdraw failed — insufficient funds in Swiss Bank`);
            state.pendingBankAction = null;
            if (pending.source === 'bulletFactory' && !pending.substage) {
                // Proceed to travel with whatever cash is on hand
                if (state.pendingBulletRun) state.pendingBulletRun = { ...state.pendingBulletRun, stage: 'travel' };
                gotoPage('cars');
            } else if (pending.source === 'bulletFactory' && pending.substage === 'topup') {
                const run = state.pendingBulletRun;
                const target = run?.targets?.[0];
                if (target) {
                    state.pendingBulletRun = { ...run, stage: 'buy' };
                    navigateToUrl(getBulletFactoryUrl(target.countryId));
                } else {
                    state.pendingBulletRun = null;
                    gotoPage('crimes');
                }
            } else {
                await wait(navRand());
                gotoPage('crimes');
            }
            return;
        }

        // If we've already submitted once and still no success, the bank probably has insufficient funds
        // Clear the pending action rather than looping forever
        if (pending.attempts >= 1) {
            const bfFails = (state.bfWithdrawFails || 0) + 1;
            state.bfWithdrawFails = bfFails;
            state.pendingBankAction = null;
            if (bfFails >= 3) {
                // 3 consecutive failed withdrawals — abort the entire bullet factory run
                addLiveLog(`Swiss Bank: withdraw failed ${bfFails} times — aborting bullet factory run`);
                state.pendingBulletRun = null;
                state.bfWithdrawFails = 0;
            } else {
                addLiveLog(`Swiss Bank: withdraw of $${pending.amount.toLocaleString()} failed (attempt ${bfFails}/3) — retrying`);
            }
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (pending.type === 'deposit' && hasBankDepositSuccess()) {
            addLiveLog(`Swiss Bank: deposited $${pending.amount.toLocaleString()} successfully`);
            updateStats(s => {
                s.swissDeposits  += 1;
                s.lastActionText  = `Swiss deposited $${pending.amount.toLocaleString()}`;
            });
            state.pendingBankAction = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        addLiveLog(`Swiss Bank: submitting ${pending.type} of $${pending.amount.toLocaleString()}`);
        state.pendingBankAction = { ...pending, attempts: (pending.attempts || 0) + 1 };
        const submitted = await submitSwissBankAction(pending.amount, pending.type === 'deposit');

        if (!submitted) {
            addLiveLog('Swiss Bank: submission failed — clearing pending action, returning to crimes');
            state.pendingBankAction = null;
            await wait(navRand());
            gotoPage('crimes');
        }
    }

    // =========================================================================
    // DRUG RUNNING
    // =========================================================================

    function getDriveGoButton() {
        return [...document.querySelectorAll('.i.in.bgd form input[type="submit"][value="Go"]')][0] || null;
    }

    function getDriveLocationSelect() {
        return document.querySelector('select[name="location"]');
    }

    function isDrugCarTooDamaged() {
        return [...document.querySelectorAll('.i.in.bgd .bgl.tac')].some(el =>
            /too much damage/i.test(textOf(el))
        );
    }

    function getDrugCarLink() {
        return document.querySelector('.i.in.bgd a[href*="?p=car&id="]');
    }

    function getDrugBuySelect()      { return document.querySelector('select[name="drug"]'); }
    function getDrugBuyAmountInput() { return document.querySelector('input[name="amount"]'); }
    function getDrugBuyButton()      { return document.querySelector('form input[type="submit"][value="Buy"]'); }

    function getDrugSellButton() {
        return document.querySelector('form table.wo input[type="submit"][value="Sell"]');
    }

    function getCarPageRepairButton() {
        return document.querySelector('form input[type="submit"][name="repair"]');
    }

    function hasCarRepairConfirmation() {
        return !!document.querySelector('div.bgm.cg');
    }

    function isCarPageCarDamaged() {
        return [...document.querySelectorAll('.tac.mb .bgl.i')].some(el =>
            /too much damage/i.test(textOf(el))
        );
    }

    function getDrugForCurrentCountry(country) {
        if (!country) return null;
        const upper = country.toUpperCase();
        if (upper === DRUG_RUN_ROUTE.countryA.toUpperCase()) return DRUG_RUN_ROUTE.drugInA;
        if (upper === DRUG_RUN_ROUTE.countryB.toUpperCase()) return DRUG_RUN_ROUTE.drugInB;
        return null;
    }

    function getDestinationLocationValue(currentCountry) {
        if (!currentCountry) return null;
        const upper = currentCountry.toUpperCase();
        if (upper === DRUG_RUN_ROUTE.countryA.toUpperCase()) return DRUG_RUN_ROUTE.countryBLocation;
        if (upper === DRUG_RUN_ROUTE.countryB.toUpperCase()) return DRUG_RUN_ROUTE.countryALocation;
        return null;
    }

    function getDestinationCountryName(currentCountry) {
        if (!currentCountry) return null;
        const upper = currentCountry.toUpperCase();
        if (upper === DRUG_RUN_ROUTE.countryA.toUpperCase()) return DRUG_RUN_ROUTE.countryB;
        if (upper === DRUG_RUN_ROUTE.countryB.toUpperCase()) return DRUG_RUN_ROUTE.countryA;
        return null;
    }

    async function sellDrugsForCountry(currentCountry) {
        const selected = await selectDrugsToSell(currentCountry);

        if (selected === 0) {
            addLiveLog('Drug run: no drugs to sell in this country — skipping sell');
            return false;
        }

        addLiveLog(`Drug run: selected ${selected} row(s) to sell`);
        await wait(rand(300, 500));

        const sellBtn = getDrugSellButton();
        if (!sellBtn) {
            addLiveLog('Drug run: Sell button not found after selection');
            return false;
        }

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshSell = getDrugSellButton();
        if (!freshSell) return false;

        humanClick(freshSell);
        addLiveLog('Drug run: Sell submitted');
        return true;
    }

    async function buyDrugs(drugOption, amount) {
        const select      = getDrugBuySelect();
        const amountInput = getDrugBuyAmountInput();
        const buyBtn      = getDrugBuyButton();

        if (!select || !amountInput || !buyBtn) {
            addLiveLog('Drug run: buy form elements not found');
            return false;
        }

        select.value      = drugOption.value;
        amountInput.value = String(amount);
        state.lastActionAt = now();

        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshSelect = getDrugBuySelect();
        const freshAmount = getDrugBuyAmountInput();
        const freshBuy    = getDrugBuyButton();

        if (!freshSelect || !freshAmount || !freshBuy) return false;

        freshSelect.value  = drugOption.value;
        freshAmount.value  = String(amount);
        humanClick(freshBuy);

        addLiveLog(`Drug run: buy submitted — ${amount} units of ${drugOption.name}`);
        return true;
    }

    async function driveToDestination(locationValue, destinationName) {
        const select = getDriveLocationSelect();
        const goBtn  = getDriveGoButton();

        if (!select || !goBtn) {
            addLiveLog('Drug run: drive form not found');
            return false;
        }

        const option = [...select.options].find(o => o.value === locationValue);
        if (!option) {
            addLiveLog(`Drug run: destination "${destinationName}" not in dropdown — may already be there`);
            return false;
        }

        select.value       = locationValue;
        state.lastActionAt = now();

        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshSelect = getDriveLocationSelect();
        const freshGo     = getDriveGoButton();
        if (!freshSelect || !freshGo) return false;

        freshSelect.value = locationValue;
        humanClick(freshGo);

        // Set a pessimistic placeholder so the bot doesn't think drive is ready
        // immediately on the next page load. The tick sync will correct this.
        state.nextDriveReadyAt = now() + 60000;

        addLiveLog(`Drug run: driving to ${destinationName}`);
        return true;
    }

    async function handleDrugsPage() {
        stopJailObserver();

        // BG Spam takes priority — suppress drug run travel
        if (state.killBgSpamEnabled && state.killBgSpamTarget && state.killBgCheckEnabled) {
            addLiveLog('Drug run: suppressed — BG Spam active');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (!isDrugsEnabled()) {
            addLiveLog('Drug running disabled — returning to crimes');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (hasCTCChallenge()) {
            await maybeSolveCTC();
            return;
        }

        // ── Drug comp mode — buy 1 unit at a time up to full capacity ─────────
        // Each individual buy counts as a separate batch for competition scoring.
        // Once fully loaded, hands off to the normal drive/sell flow.
        if (state.drugCompEnabled && isDrugsEnabled()) {
            const capacity = getDrugCapacity();
            const carried  = getDrugCarriedUnits();
            const space    = Math.max(0, capacity - carried);

            if (capacity > 0) state.drugCapacityCache = capacity;

            if (space > 0) {
                const country   = getPlayerLocation();
                const drugToBuy = getDrugForCurrentCountry(country) || DRUG_RUN_ROUTE.drugInA;

                addLiveLog(`Drug comp: buying 1 unit of ${drugToBuy.name} (${carried}/${capacity} carried)`);

                const fd = new FormData();
                fd.append('drug', drugToBuy.value);
                fd.append('amount', '1');
                const resp = await fetch(window.location.href, { method: 'POST', body: fd, credentials: 'include' });
                const text = await resp.text();

                if (/match the letters|captcha/i.test(text)) {
                    addLiveLog('Drug comp: CTC in response — reloading page to solve');
                    await wait(rand(500, 900));
                    location.reload();
                    return;
                }

                await wait(rand(150, 300));
                location.reload();
                return;
            }

            // Fully loaded — fall through to normal drive/sell flow
            addLiveLog(`Drug comp: fully loaded (${carried}/${capacity}) — driving to sell`);
        }

        // Check if a favourited car is present on the drugs page.
        // Without a favourited car the section shows a "Favourite a car" link
        // instead of the "Drive using X" car link. Detect by looking for the
        // car-specific link (href contains ?p=car&id=).
        const hasFavouritedCar = !!document.querySelector('.i.in.bgd a[href*="?p=car&id="]');
        if (!hasFavouritedCar) {
            addLiveLog('Drug run: no favourited car found — disabling drug running. Favourite a car via My Cars to enable driving.');
            state.autoDrugsEnabled = false;
            if (autoDrugsInput) autoDrugsInput.checked = false;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (isDrugCarTooDamaged()) {
            const carLink = getDrugCarLink();
            if (!carLink) {
                addLiveLog('Drug run: car too damaged but no car link found — returning to crimes');
                await wait(navRand());
                gotoPage('crimes');
                return;
            }
            addLiveLog('Drug run: car too damaged — navigating to car page to repair');
            await wait(navRand());
            navigateToUrl(new URL(carLink.getAttribute('href'), window.location.href).toString());
            return;
        }

        if (hasDrugOverCapacityError()) {
            addLiveLog('Drug run: over-capacity buy detected — re-reading capacity and continuing');
        }

        const country      = getPlayerLocation();
        const capacity     = getDrugCapacity();
        const carried      = getDrugCarriedUnits();
        const available    = Math.max(0, capacity - carried);
        const destValue    = getDestinationLocationValue(country);
        const destName     = getDestinationCountryName(country);
        const drugToBuy    = getDrugForCurrentCountry(country);
        const reserve      = calcDrugReserve(capacity);
        const cash         = getPlayerMoney();

        if (capacity > 0) state.drugCapacityCache = capacity;

        addLiveLog(`Drug run: in ${country || 'unknown'} | capacity ${capacity} | carrying ${carried} | space ${available} | reserve $${reserve.toLocaleString()} | cash $${cash.toLocaleString()}`);

        if (hasDrugsToSellInCurrentCountry(country)) {
            addLiveLog(`Drug run: selling eligible drugs in ${country}`);
            const didSell = await sellDrugsForCountry(country);
            if (didSell) {
                updateStats(s => {
                    s.drugRuns      += 1;
                    s.lastActionText = `Drug run: sold in ${country}`;
                });
            }
            return;
        }

        if (!isInternalDriveReady()) {
            const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
            addLiveLog(`Drug run: drive not ready (${remaining}s) — returning to crimes`);
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (country.toUpperCase() === DRUG_RUN_ROUTE.countryA.toUpperCase()) {

            if (available <= 0) {
                addLiveLog('Drug run: fully loaded in USA — driving to England');

            } else if (capacity <= 0) {
                addLiveLog('Drug run: capacity unknown — returning to crimes to wait for next visit');
                await wait(navRand());
                gotoPage('crimes');
                return;

            } else if (cash < reserve) {
                const swiss     = getPlayerSwiss();
                const shortfall = reserve - cash;

                if (swiss >= shortfall) {
                    addLiveLog(`Drug run: insufficient cash ($${cash.toLocaleString()}) — withdrawing $${shortfall.toLocaleString()} from Swiss Bank`);
                    state.pendingBankAction = { type: 'withdraw', amount: shortfall };
                    await wait(navRand());
                    gotoPage('bank');
                    return;
                } else {
                    addLiveLog(`Drug run: insufficient funds — cash $${cash.toLocaleString()}, Swiss $${swiss.toLocaleString()}, need $${reserve.toLocaleString()} — skipping this run`);
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }

            } else if (drugToBuy && available > 0) {
                addLiveLog(`Drug run: buying ${available} units of ${drugToBuy.name} in ${country}`);
                const didBuy = await buyDrugs(drugToBuy, available);
                if (!didBuy) {
                    addLiveLog('Drug run: buy failed — returning to crimes');
                    await wait(navRand());
                    gotoPage('crimes');
                }
                return;
            }
        }

        if (country.toUpperCase() === DRUG_RUN_ROUTE.countryB.toUpperCase() && drugToBuy && available > 0) {

            if (cash < reserve) {
                const swiss     = getPlayerSwiss();
                const shortfall = reserve - cash;

                if (swiss >= shortfall) {
                    addLiveLog(`Drug run: withdrawing full Heroin reserve ($${reserve.toLocaleString()}) while in England to cover next USA buy`);
                    state.pendingBankAction = { type: 'withdraw', amount: shortfall };
                    await wait(navRand());
                    gotoPage('bank');
                    return;
                } else {
                    addLiveLog(`Drug run: insufficient funds — cash $${cash.toLocaleString()}, Swiss $${swiss.toLocaleString()}, need $${reserve.toLocaleString()} for Heroin reserve — skipping this run`);
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
            }

            addLiveLog(`Drug run: buying ${available} units of ${drugToBuy.name} in ${country}`);
            const didBuy = await buyDrugs(drugToBuy, available);
            if (!didBuy) {
                addLiveLog('Drug run: buy failed — returning to crimes');
                await wait(navRand());
                gotoPage('crimes');
            }
            return;
        }

        if (destValue && destName) {
            const didDrive = await driveToDestination(destValue, destName);
            if (!didDrive) {
                addLiveLog('Drug run: drive failed — returning to crimes');
                await wait(navRand());
                gotoPage('crimes');
            }
            return;
        }

        addLiveLog(`Drug run: in unrecognised country "${country}" — driving to ${DRUG_RUN_ROUTE.countryA} to start route`);
        const didDriveToStart = await driveToDestination(DRUG_RUN_ROUTE.countryALocation, DRUG_RUN_ROUTE.countryA);
        if (!didDriveToStart) {
            addLiveLog('Drug run: could not drive to route start — returning to crimes');
            await wait(navRand());
            gotoPage('crimes');
        }
    }

    async function handleCarPage() {
        stopJailObserver();

        if (!isDrugsEnabled()) {
            addLiveLog('Car page: drug running off — returning to crimes');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (hasCarRepairConfirmation()) {
            addLiveLog('Drug run: car repaired successfully — returning to drugs');
            await wait(navRand());
            gotoPage('drugs');
            return;
        }

        if (isCarPageCarDamaged()) {
            const repairBtn = getCarPageRepairButton();
            if (!repairBtn) {
                addLiveLog('Drug run: car damaged but no repair button — returning to crimes');
                await wait(navRand());
                gotoPage('crimes');
                return;
            }

            state.lastActionAt = now();
            await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

            const freshRepair = getCarPageRepairButton();
            if (!freshRepair) return;

            humanClick(freshRepair);
            addLiveLog('Drug run: repair button clicked');
            return;
        }

        addLiveLog('Car page: car not damaged — returning to drugs');
        await wait(navRand());
        gotoPage('drugs');
    }


    // =========================================================================
    // KILL SCANNER
    // =========================================================================

    // -------------------------------------------------------------------------
    // Kill penalty helpers
    // -------------------------------------------------------------------------

    // Reads the kill penalty multiplier from the kill page.
    // Returns 1.0 if no penalty is active (element absent).
    function getKillPenaltyMultiplier() {
        const penaltyEl = document.querySelector('a[href*="kill-penalty"] span');
        if (isKillPage()) {
            // On kill page — read directly from DOM, always authoritative
            if (penaltyEl) {
                const text = textOf(penaltyEl);
                const match = text.match(/x([\d.]+)/i);
                const val = match ? parseFloat(match[1]) : 1.0;
                setSetting('cachedKillPenalty', val);
                return val;
            }
            // On kill page with no penalty element — means no penalty, cache 1.0
            setSetting('cachedKillPenalty', 1.0);
            return 1.0;
        }
        // Not on kill page — return cached value if available
        const cached = getSetting('cachedKillPenalty', 1.0);
        return Number(cached) || 1.0;
    }

    // Parses the kill penalty page and calculates when the penalty will drop below threshold.
    // Returns timestamp (ms) when penalty will drop below threshold, or 0 if already below.
    function calcPenaltyDropsAt() {
        const threshold = state.killPenaltyThreshold;
        if (!threshold || threshold <= 0) return 0;

        // Parse all kills from the penalty page
        const rows = [...document.querySelectorAll('.bgl.chs')];
        const kills = [];
        for (const row of rows) {
            const timerSpan = row.querySelector('.chd');
            if (!timerSpan) continue;
            const agoMs = parseLostInMs(textOf(timerSpan));
            if (agoMs == null) continue;
            const expiresAt = now() - agoMs + (24 * 60 * 60 * 1000);
            kills.push(expiresAt);
        }

        if (!kills.length) {
            // No kills found — no penalty exists, update cache to reflect this
            setSetting('cachedKillPenalty', 1.0);
            return 0;
        }

        // Sort by expiry time — soonest expiring first
        kills.sort((a, b) => a - b);

        // Simulate forward: as each kill expires, total count drops
        // Penalty = max(0, totalKills - 5) * 0.1 + 1.0
        // Find the first expiry where penalty drops below threshold
        let remaining = kills.length;
        for (const expiresAt of kills) {
            remaining--;
            const simPenalty = remaining > 5 ? (remaining - 5) * 0.1 + 1.0 : 1.0;
            if (simPenalty < threshold) {
                const minsLeft = Math.round((expiresAt - now()) / 60000);
                const hrsLeft  = Math.floor(minsLeft / 60);
                const minRem   = minsLeft % 60;
                const timeStr  = hrsLeft > 0 ? `${hrsLeft}h ${minRem}m` : `${minRem}m`;
                addLiveLog(`Kill loop: penalty will drop below ${threshold}x in ${timeStr} — waiting`);
                return expiresAt;
            }
        }
        // All kills expired — penalty will be 1.0x
        return kills[kills.length - 1];
    }

    // Returns true if the kill penalty exceeds the configured threshold.
    // If threshold is 0 or not set, never blocks.
    function isKillPenaltyTooHigh() {
        const threshold = state.killPenaltyThreshold;
        if (!threshold || threshold <= 0) return false;
        const penalty = getKillPenaltyMultiplier();
        return penalty >= threshold;
    }

    function formatPenaltyWait(ts) {
        const ms = Math.max(0, Number(ts || 0) - now());
        const mins = Math.ceil(ms / 60000);
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        if (hrs > 0) return `${hrs}h ${rem}m`;
        return `${Math.max(1, mins)}m`;
    }

    function buildPenaltyDeferredAction(action) {
        if (!action) return null;
        const a = { ...action, penaltyDeferred: true, penaltyDeferredAt: now() };

        // If a bodyguard kill is delayed by penalty, do not shoot the BG hours
        // later on stale verification. Re-check the original target first; if
        // they swapped/dropped BG, the normal BG Farm/BG Check result path will
        // adapt safely.
        if (a.stage === 'bg_shoot' && a.bgFor) {
            return {
                stage: 'bgcheck',
                targetName: a.bgFor,
                shootAfterBg: !!a.shootAfterBg || isPlayerShootEnabled(a.bgFor),
                force: true,
                penaltyDeferred: true,
                penaltyDeferredAt: now(),
                waitingBg: a.targetName
            };
        }

        // Clean BG-check targets should also be re-checked after a long penalty
        // wait, because they may have hired/swapped a BG in the meantime.
        if ((a.stage === 'fetch_profile' || a.stage === 'shoot_result') && a.targetName && isBgCheckable(a.targetName)) {
            return {
                stage: 'bgcheck',
                targetName: a.targetName,
                shootAfterBg: true,
                force: true,
                penaltyDeferred: true,
                penaltyDeferredAt: now()
            };
        }

        return a;
    }

    function deferKillForPenalty(action, label) {
        const deferred = buildPenaltyDeferredAction(action);
        if (deferred) state.killPenaltyPendingAction = deferred;

        state.pendingKillAction = null;
        state.killLoopActive = false;
        state.killBgSpamPaused = false;
        state.killBgWaitUntil = 0;

        const dropAt = state.penaltyDropsAt;
        if (dropAt && dropAt > now()) {
            addLiveLog(`Kill loop: penalty too high — waiting ${formatPenaltyWait(dropAt)} before ${label}`);
            return false;
        }

        addLiveLog(`Kill loop: penalty too high — calculating when to resume ${label}`);
        if (!state.pendingPenaltyPage) state.pendingPenaltyPage = true;
        return true;
    }

    // -------------------------------------------------------------------------
    // BG check / shoot helpers
    // -------------------------------------------------------------------------

    function stripBgFarmVerification(action) {
        if (!action || typeof action !== 'object') return action;
        const clean = { ...action };
        // Legacy/old verification fields are deliberately not trusted.
        delete clean.bgVerified;
        delete clean.bgVerifiedAt;
        delete clean.bgVerifiedSource;
        delete clean.bgVerifiedFor;
        delete clean.bgVerifiedBg;
        // v27 uses a simple one-shot approval created only by the most recent
        // original-target BG check. It is stripped whenever a shot is deferred
        // for bullets/penalty/etc., but can be preserved through the direct
        // planned travel path to avoid country ping-pong.
        delete clean.bgPreShotVerified;
        delete clean.bgPreShotFor;
        delete clean.bgPreShotBg;
        if (clean.afterTravel) clean.afterTravel = stripBgFarmVerification(clean.afterTravel);
        if (clean.afterVerify) clean.afterVerify = stripBgFarmVerification(clean.afterVerify);
        return clean;
    }

    function markImmediateBgFarmVerification(action, bgFor, bgName) {
        return {
            ...stripBgFarmVerification(action),
            bgPreShotVerified: true,
            bgPreShotFor:      bgFor || action?.bgFor || null,
            bgPreShotBg:       bgName || action?.targetName || null
        };
    }

    function isImmediateBgFarmVerification(action, bgFor, bgName) {
        if (!action || !action.bgPreShotVerified) return false;
        if (!action.bgPreShotFor || !action.bgPreShotBg) return false;
        if (bgFor && action.bgPreShotFor.toLowerCase() !== bgFor.toLowerCase()) return false;
        if (bgName && action.bgPreShotBg.toLowerCase() !== bgName.toLowerCase()) return false;
        return true;
    }

    function preserveFreshBgFarmApproval(action, source, bgFor, bgName) {
        const clean = stripBgFarmVerification(action);
        return isImmediateBgFarmVerification(source, bgFor, bgName)
            ? markImmediateBgFarmVerification(clean, bgFor, bgName)
            : clean;
    }

    function queueFreshBgVerifyBeforeShot(bgName, bgFor, shootAfterBg, reason = 'fresh verify required') {
        if (!bgName || !bgFor) return false;
        const players = state.killPlayers || [];
        const ownerIdx = players.findIndex(p => p.name && p.name.toLowerCase() === bgFor.toLowerCase());
        if (ownerIdx !== -1) {
            players[ownerIdx].bgVerifyInFlight = true;
            saveKillPlayers(players);
        }
        addLiveLog(`Kill loop: BG Farm — verifying ${bgFor} still has BG ${bgName} before shooting (${reason})`);
        state.pendingKillAction = {
            stage: 'bg_farm_check',
            targetName: bgFor,
            shootAfterBg: !!shootAfterBg || isPlayerShootEnabled(bgFor),
            force: true,
            afterVerify: { stage: 'bg_shoot', targetName: bgName, bgFor, shootAfterBg: !!shootAfterBg || isPlayerShootEnabled(bgFor) }
        };
        state.killLoopActive = true;
        state.killSearchLoopActive = false;
        return true;
    }

    function clearStaleBgRelation(bgName, bgFor, reason = 'stale') {
        if (!bgName || !bgFor) return;
        const players = state.killPlayers || [];
        const bgIdx = players.findIndex(p => p.name && p.name.toLowerCase() === bgName.toLowerCase());
        if (bgIdx !== -1) {
            delete players[bgIdx].isBg;
            delete players[bgIdx].bgFor;
            delete players[bgIdx].bgShootQueued;
        }
        const ownerIdx = players.findIndex(p => p.name && p.name.toLowerCase() === bgFor.toLowerCase());
        if (ownerIdx !== -1 && players[ownerIdx].bodyguard &&
            players[ownerIdx].bodyguard.toLowerCase() === bgName.toLowerCase()) {
            players[ownerIdx].bodyguard = null;
            delete players[ownerIdx].bgVerifyInFlight;
        }
        saveKillPlayers(players);
        addLiveLog(`Kill loop: ${bgName} no longer confirmed as BG for ${bgFor} — ${reason}`);
    }


    function actionTargetsStaleBgForOwner(action, bgFor, keepBgName = null) {
        if (!action || !bgFor) return false;
        const owner = bgFor.toLowerCase();
        const keep  = keepBgName ? keepBgName.toLowerCase() : null;
        const target = action.targetName ? action.targetName.toLowerCase() : '';
        if (action.bgFor && action.bgFor.toLowerCase() === owner && (!keep || target !== keep)) return true;
        return actionTargetsStaleBgForOwner(action.afterTravel, bgFor, keepBgName) ||
               actionTargetsStaleBgForOwner(action.afterVerify, bgFor, keepBgName);
    }

    function clearStaleBgRelationsForOwner(bgFor, keepBgName = null, reason = 'fresh BG Farm check') {
        if (!bgFor) return;
        const players = state.killPlayers || [];
        const owner = bgFor.toLowerCase();
        const keep  = keepBgName ? keepBgName.toLowerCase() : null;
        let changed = false;

        for (const p of players) {
            if (!p.name || !p.bgFor || p.bgFor.toLowerCase() !== owner) continue;
            if (keep && p.name.toLowerCase() === keep) continue;
            if (p.isBg || p.bgShootQueued || p.bgFor) {
                delete p.isBg;
                delete p.bgFor;
                delete p.bgShootQueued;
                changed = true;
                addLiveLog(`Kill loop: ${p.name} detached as stale BG for ${bgFor} — ${reason}`);
            }
        }

        const ownerIdx = players.findIndex(p => p.name && p.name.toLowerCase() === owner);
        if (ownerIdx !== -1) {
            if (keepBgName) {
                if (players[ownerIdx].bodyguard !== keepBgName) {
                    players[ownerIdx].bodyguard = keepBgName;
                    changed = true;
                }
            } else if (players[ownerIdx].bodyguard) {
                delete players[ownerIdx].bodyguard;
                changed = true;
            }
            if (!keepBgName) delete players[ownerIdx].bgVerifyInFlight;
        }

        if (state.killBgShootPending && actionTargetsStaleBgForOwner(state.killBgShootPending, bgFor, keepBgName)) {
            state.killBgShootPending = null;
            changed = true;
        }
        if (state.pendingKillAction && actionTargetsStaleBgForOwner(state.pendingKillAction, bgFor, keepBgName)) {
            state.pendingKillAction = null;
            state.killLoopActive = false;
            changed = true;
        }

        if (changed) saveKillPlayers(players);
    }

    // Returns true if a player has BG check enabled (per-player toggle)
    function isPlayerBgCheckEnabled(name) {
        const list = state.killBgCheckPlayers || [];
        return list.some(n => n.toLowerCase() === name.toLowerCase());
    }

    // Sets per-player BG check toggle
    function setPlayerBgCheckEnabled(name, enabled) {
        let list = state.killBgCheckPlayers || [];
        const lower = name.toLowerCase();
        if (enabled) {
            if (!list.some(n => n.toLowerCase() === lower)) list.push(name);
        } else {
            list = list.filter(n => n.toLowerCase() !== lower);
        }
        state.killBgCheckPlayers = list;
        if (enabled) clearKillWakeBlockersForPlayer(name, { clearBgCheck: true, clearFarmWait: true });
    }

    // Returns true if a player has shoot enabled (per-player toggle)
    function isPlayerShootEnabled(name) {
        const list = state.killShootPlayers || [];
        return list.some(n => n.toLowerCase() === name.toLowerCase());
    }

    // Sets per-player shoot toggle
    function setPlayerShootEnabled(name, enabled) {
        let list = state.killShootPlayers || [];
        const lower = name.toLowerCase();
        if (enabled) {
            if (!list.some(n => n.toLowerCase() === lower)) list.push(name);
        } else {
            list = list.filter(n => n.toLowerCase() !== lower);
        }
        state.killShootPlayers = list;
        if (enabled) clearKillWakeBlockersForPlayer(name, { clearBgCheck: isBgCheckable(name), clearFarmWait: true, clearKillAttempt: true });
    }

    // Returns true if a player has BG farm enabled (per-player toggle)
    function isPlayerBgFarmEnabled(name) {
        const list = state.killBgFarmPlayers || [];
        return list.some(n => n.toLowerCase() === name.toLowerCase());
    }

    function isPlayerBgSpamTarget(name) {
        return state.killBgSpamTarget && state.killBgSpamTarget.toLowerCase() === (name || '').toLowerCase();
    }

    // Returns true if a player should receive periodic BG checks —
    // either via BG Check toggle or BG Farm toggle.
    // Bodyguards themselves are not BG-checkable: in UG a BG cannot have their own BG.
    function isBgCheckable(name) {
        return isPlayerBgCheckEnabled(name) || isPlayerBgFarmEnabled(name);
    }

    // After a fresh 1-bullet check returns no BG, only kill if Kill is ticked.
    // BG Farm auto-ticks Kill on the original player, so BG Farm+Kill still kills clean targets.
    function shouldKillAfterCleanBgCheck(name) {
        return !!name && isPlayerShootEnabled(name);
    }

    function clearKillWakeBlockersForPlayer(name, opts = {}) {
        const players = state.killPlayers || [];
        const lower = String(name || '').toLowerCase();
        const idx = players.findIndex(p => p.name && p.name.toLowerCase() === lower);
        if (idx !== -1) {
            if (opts.clearBgCheck) players[idx].lastBgCheck = 0;
            if (opts.clearFarmWait) delete players[idx].bgFarmWaitUntil;
            if (opts.clearBodyguard) delete players[idx].bodyguard;
            if (opts.clearKillAttempt) delete players[idx].lastKillAttempt;
            delete players[idx].bgVerifyInFlight;
            saveKillPlayers(players);
        }
        state.killBgWaitUntil       = 0;
        state.killLoopCooldownUntil = 0;
        if (state.killBgCheckEnabled) state.killLoopActive = true;
    }

    function queueBgFarmCheck(targetName, shootAfterBg = false, extra = {}) {
        state.pendingKillAction = {
            stage: 'bg_farm_check',
            targetName,
            shootAfterBg: !!shootAfterBg,
            ...extra
        };
        state.killBgWaitUntil       = 0;
        state.killLoopCooldownUntil = 0;
        state.killLoopActive        = true;
        state.killBgSpamPaused      = true;
    }

    // Sets per-player BG farm toggle
    function setPlayerBgFarmEnabled(name, enabled) {
        let list = state.killBgFarmPlayers || [];
        const lower = name.toLowerCase();
        if (enabled) {
            if (!list.some(n => n.toLowerCase() === lower)) list.push(name);
            // Auto-select as spam target if none currently selected
            if (!state.killBgSpamTarget) {
                state.killBgSpamTarget = name;
                if (killBgSpamTargetEl) killBgSpamTargetEl.value = name;
            }
        } else {
            list = list.filter(n => n.toLowerCase() !== lower);
            // If this was the spam target, fall back to next BG Farm player
            if (state.killBgSpamTarget.toLowerCase() === lower) {
                const next = list[0] || '';
                state.killBgSpamTarget = next;
                if (killBgSpamTargetEl) killBgSpamTargetEl.value = next;
                if (!next) stopBgSpam();
            }
        }
        state.killBgFarmPlayers = list;
        if (enabled) {
            // BG Farm is intentionally BG Farm + Kill in practice:
            // keep the per-player Kill toggle enabled so a clean target is killed after BGs are gone.
            if (!isPlayerShootEnabled(name)) setPlayerShootEnabled(name, true);
            clearKillWakeBlockersForPlayer(name, { clearBgCheck: true, clearFarmWait: true, clearKillAttempt: true });
        }
        updateBgSpamDropdown();
        syncBgSpamState();
    }

    // Returns ms until next BG check is due for this player (negative = due now)
    function getBgCheckDueMs(player) {
        const intervalMs = state.killBgCheckIntervalHrs * 60 * 60 * 1000;
        const lastCheck  = player.lastBgCheck || 0;
        return (lastCheck + intervalMs) - now();
    }

    // Reads the player's rank and prestige from their profile page.
    // Returns { rankIndex: 1-24, prestige: 0-5 } or null if not found.
    function parseProfileRankPrestige() {
        // Rank cell is the first <td> after the <th>Rank</th> cell
        const rows = [...document.querySelectorAll('#profile tr')];
        let rankText = '';
        for (const row of rows) {
            const ths = row.querySelectorAll('th');
            const tds = row.querySelectorAll('td');
            if ([...ths].some(th => /^rank$/i.test(textOf(th).trim())) && tds.length >= 1) {
                rankText = textOf(tds[0]).trim();
                break;
            }
        }
        if (!rankText) return null;

        // Parse prestige: "(5th Prestige)", "(1st Prestige)", etc.
        const prestigeMatch = rankText.match(/\((\d+)(?:st|nd|rd|th)\s+prestige\)/i);
        const prestige = prestigeMatch ? parseInt(prestigeMatch[1], 10) : 0;

        // Extract rank name (remove prestige suffix)
        const rankName = rankText.replace(/\s*\([^)]+\)\s*/g, '').trim();

        // Map to index (1-based)
        const idx = RANKS.indexOf(rankName);
        if (idx === -1) return null;

        return { rankIndex: idx + 1, prestige: Math.min(5, Math.max(0, prestige)) };
    }

    // Fetches the bullet calculator result for given parameters.
    // Returns the bullet count as a number, or null on failure.
    // The calculator auto-selects your rank and gun from your session.
    async function fetchBulletCount(victimRankIndex, victimPrestige) {
        try {
            // Pass myrank as 1-based index (game convention) and actual gun value
            // getPlayerRankIndex() is 0-based, so add 1. If rank not found (-1 → 0),
            // fall back to 20 (Regional Don) as a safe middle-ground default
            const rawRankIdx  = getPlayerRankIndex(); // 0-based, -1 if not found → 0
            const myRankIndex = rawRankIdx > 0 ? rawRankIdx + 1 : 20;
            const myGun       = getPlayerGunValue();
            const url = `?p=kill&show=calc&vrank=${victimRankIndex}&armour=7&prestige=${victimPrestige}&myrank=${myRankIndex}&gun=${myGun}`;
            const resp = await fetch(url, { credentials: 'include' });
            const text = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const successEl = doc.querySelector('.bgm.success');
            if (!successEl) return null;
            const match = textOf(successEl).match(/shooting\s*([\d,]+)\s*bullets/i);
            return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
        } catch (e) {
            addLiveLog(`Kill: bullet calc fetch error — ${e.message}`);
            return null;
        }
    }

    // Fetches a player's profile page and returns their rank/prestige.
    // Uses the profile link directly from Players Found on the kill page to avoid
    // URL encoding issues with player names containing spaces or special characters.
    async function fetchPlayerProfile(username) {
        try {
            // Find profile URL from Players Found link — resolve via URL constructor
            // to properly encode spaces and special chars in player names
            let profileUrl = `?p=profile&u=${encodeURIComponent(username)}`; // default
            const foundLinks = [...document.querySelectorAll('.bgl.i.wb .bgm.chs a[href*="?p=profile&u="]')];
            for (const link of foundLinks) {
                try {
                    const resolved = new URL(link.getAttribute('href'), window.location.href);
                    if ((resolved.searchParams.get('u') || '').toLowerCase() === username.toLowerCase()) {
                        profileUrl = resolved.toString(); // fully encoded URL
                        break;
                    }
                } catch (_) {}
            }

            const resp = await fetch(profileUrl, { credentials: 'include' });
            const text = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');

            // Profile table: header row has <th>Rank</th><th>Money</th>
            // The NEXT row has <td>RankName</td><td>Money</td>
            const rows = [...doc.querySelectorAll('#profile tr')];
            let rankText = '';
            for (let i = 0; i < rows.length - 1; i++) {
                const ths = rows[i].querySelectorAll('th');
                if ([...ths].some(th => /^rank$/i.test(th.textContent.trim()))) {
                    // Rank value is in the first td of the NEXT row
                    const nextTds = rows[i + 1].querySelectorAll('td');
                    if (nextTds.length >= 1) {
                        rankText = nextTds[0].textContent.trim();
                        break;
                    }
                }
            }
            if (!rankText) return null;

            const prestigeMatch = rankText.match(/\((\d+)(?:st|nd|rd|th)\s+prestige\)/i);
            const prestige  = prestigeMatch ? parseInt(prestigeMatch[1], 10) : 0;
            const rankName  = rankText
                .replace(/\s*\([^)]+\)\s*/g, '')  // strip (prestige) etc
                .replace(/\s*\d+%\s*/g, '')        // strip percentage like "42%"
                .trim();
            const rankIndex = RANKS.indexOf(rankName) + 1;
            if (rankIndex <= 0) return null;

            // Detect VIP status — shown as a coloured span next to the username
            // VIP players require double the bullets to kill
            const isVip = !!doc.querySelector('a[href*="?p=mail"] span[style*="a05684"]') ||
                          /V\s*I\s*P/i.test(textOf(doc.querySelector('a[href*="?p=mail"]') || doc.createElement('span')));

            return { rankIndex, prestige: Math.min(5, Math.max(0, prestige)), isVip };
        } catch (e) {
            addLiveLog(`Kill: profile fetch error for ${username} — ${e.message}`);
            return null;
        }
    }

    // Finds a suitable travel car (RS Tuner, Black, or Orange) on the cars page.
    // Returns a car link element or null.
    function findTravelCar() {
        // Look for protected-name cars in the cars list — these are RS Tuner/Black/Orange
        // We need to look at ?p=cars page links. On the car page itself, the drive form is present.
        // This function is called when we're already on a car page.
        const driveSelect = getDriveLocationSelect();
        return driveSelect ? driveSelect : null;
    }

    // Returns the location value string for a country name
    function getLocationValueForCountry(countryName) {
        if (!countryName) return null;
        return COUNTRY_LOCATION_MAP[countryName.toLowerCase()] || null;
    }

    // Gets the player's current location from the stats bar
    function getPlayerLocation() {
        const el = document.querySelector('#player-location');
        return el ? textOf(el).trim() : '';
    }

    // Submits a shoot POST to the kill page
    // Returns the response text
    async function submitShoot(username, bullets, anonymous) {
        const params = new URLSearchParams();
        params.set('do', 'kill');
        params.set('username', username);
        params.set('bullets', String(bullets));
        if (!anonymous) params.set('show', 'y');

        const resp = await fetch('?p=kill', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        return resp.text();
    }

    // Parses shoot response to determine outcome
    // Returns: 'bodyguard' | 'failed' | 'success' | 'unknown'
    // Also returns bodyguardName if applicable
    function parseShootResponse(html) {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(html, 'text/html');

        const failEl = doc.querySelector('.bgm.fail');
        if (failEl) {
            const text = failEl.textContent || '';
            // Bodyguard message: "X has a bodyguard called Y!"
            const bgMatch = text.match(/has a bodyguard called\s+(.+?)!/i);
            if (bgMatch) {
                // Extract name from the second link in the fail message
                const links = [...failEl.querySelectorAll('a[href*="?p=profile&u="]')];
                let bgName = '';
                if (links.length >= 2) {
                    try {
                        const url = new URL(links[1].getAttribute('href'), window.location.href);
                        bgName = url.searchParams.get('u') || '';
                    } catch (_) {}
                }
                if (!bgName) {
                    // Fallback: parse from text
                    bgName = bgMatch[1].trim();
                }
                return { outcome: 'bodyguard', bodyguardName: bgName };
            }
            // Failed to kill (no bodyguard)
            if (/failed to kill/i.test(text)) return { outcome: 'failed' };
            // Dead
            if (/that player is dead/i.test(text)) return { outcome: 'dead' };
            // Protected
            if (/is protected from death/i.test(text)) return { outcome: 'protected' };
            // Unkillable
            if (/cannot be killed/i.test(text)) return { outcome: 'unkillable' };
        }

        const successEl = doc.querySelector('.bgm.success, .bgm.cg');
        if (successEl) {
            const text = successEl.textContent || '';
            if (/killed/i.test(text) || (/you shot/i.test(text))) return { outcome: 'success' };
        }

        // Check cred div (failed message style)
        const credEl = doc.querySelector('.bgm.cred');
        if (credEl) {
            const text = credEl.textContent || '';
            if (/failed to kill/i.test(text)) return { outcome: 'failed' };
        }

        return { outcome: 'unknown' };
    }

    // Finds the best travel car link on the cars list page (?p=cars).
    // Priority: Orange → RS Tuner → Black
    // Returns the absolute URL to the car detail page, or null if none found.
    function findBestTravelCarUrl(excludeUrls = []) {
        const allLinks = [...document.querySelectorAll('a[href*="?p=car&id="]')];

        // Build priority groups
        const orange  = [];
        const rstuner = [];
        const black   = [];

        for (const link of allLinks) {
            const text = textOf(link).toLowerCase();
            let url;
            try { url = new URL(link.getAttribute('href'), window.location.href).toString(); } catch(_) { continue; }
            if (excludeUrls.includes(url)) continue;
            if (text.includes('orange'))   { orange.push({ link, url });  continue; }
            if (text.includes('rs tuner')) { rstuner.push({ link, url }); continue; }
            if (text.includes('black'))    { black.push({ link, url });   continue; }
        }

        const best = (orange[0] || rstuner[0] || black[0]) || null;
        return best ? best.url : null;
    }

    // Initiates kill loop travel — called when on the cars LIST page (?p=cars).
    // Finds best travel car and navigates to its detail page.
    async function driveToCountryForKill(targetCountry) {
        const locationValue = getLocationValueForCountry(targetCountry);
        if (!locationValue) {
            addLiveLog(`Kill travel: unknown country "${targetCountry}"`);
            return false;
        }

        const travelCarUrl = findBestTravelCarUrl();
        if (!travelCarUrl) {
            addLiveLog('Kill travel: no suitable travel car found (Orange/RS Tuner/Black)');
            return false;
        }

        addLiveLog(`Kill travel: navigating to car detail page for ${targetCountry}`);
        // Store travelCarUrl and move stage to 'travel_car' — we're now on the car detail page
        state.pendingKillAction = { ...state.pendingKillAction, travelTo: targetCountry, travelCarUrl, stage: 'travel_car' };
        navigateToUrl(travelCarUrl);
        return true;
    }

    // -------------------------------------------------------------------------
    // Player list management
    // -------------------------------------------------------------------------

    // Returns the full player list, filtering out dead players.
    function getKillPlayers() {
        return (state.killPlayers || []).filter(p => p.status !== KILL_STATUS.DEAD);
    }

    // Saves the player list back to GM storage, removing dead players.
    function saveKillPlayers(players) {
        state.killPlayers = players.filter(p => p.status !== KILL_STATUS.DEAD);
    }

    // Adds new players from Players Online to the list.
    // Only adds players not already in the list.
    function mergeOnlinePlayers(usernames) {
        const existing = state.killPlayers || [];
        const existingNames = new Set(existing.map(p => p.name.toLowerCase()));
        let added = 0;

        for (const name of usernames) {
            if (!existingNames.has(name.toLowerCase())) {
                existing.push({
                    name,
                    status:      KILL_STATUS.UNKNOWN,
                    lastChecked: 0,
                    firstSeen:   now(),
                    searchCount: 0
                });
                added++;
            }
        }

        // Remove dead players when saving
        state.killPlayers = existing.filter(p => p.status !== KILL_STATUS.DEAD);
        return added;
    }

    // Returns the next player to search based on priority:
    // 1. Unknown — search immediately
    // 2. Protected — always search whenever the loop runs for any reason
    // 3. Alive with 3hrs or less remaining — re-search to keep active
    // 4. Protected standalone 1hr failsafe — handled by #2 above since
    //    original targets are always priority when the loop activates
    // 5. Unkillable — never search
    // Pending players (searchExpiresAt > now+2.5hrs) are skipped — they're already
    // in the game's search queue and just need time to complete.
    function getNextKillTarget() {
        const players = getKillPlayers();
        if (!players.length) return null;

        const nowMs = now();
        const PENDING_SKIP_MS = 2.5 * 60 * 60 * 1000;

        const RECENTLY_SEARCHED_MS = (state.killProtectedRecheckEnabled && state.killSearchEnabled)
            ? state.killProtectedRecheckMins * 60 * 1000
            : 5 * 60 * 1000;

        // Priority 1: Protected players due for recheck — always before unknowns
        const nextProtected = players.find(p =>
            p.status === KILL_STATUS.PROTECTED &&
            (nowMs - (p.lastChecked || 0)) >= RECENTLY_SEARCHED_MS
        );
        if (nextProtected) return nextProtected;

        // Priority 2: Unknown players — search immediately
        const unknown = players.find(p => {
            if (p.status !== KILL_STATUS.UNKNOWN) return false;
            if (p.searchExpiresAt && (p.searchExpiresAt - nowMs) > PENDING_SKIP_MS) return false;
            return true;
        });
        if (unknown) return unknown;

        // Priority 3: Alive players with 3hrs or less remaining — re-search
        // to keep their location permanently active with no gap.
        // If no searchExpiresAt is stored, the player has dropped out of Players Found
        // (expired or dead) — re-search immediately to discover their status.
        const RESCAN_BUFFER_MS = 3 * 60 * 60 * 1000; // 3hr buffer before expiry
        const expiredAlive = players.find(p => {
            if (p.status !== KILL_STATUS.ALIVE) return false;
            if (!p.searchExpiresAt) return true; // No timer = dropped out, re-search immediately
            return (p.searchExpiresAt - nowMs) < RESCAN_BUFFER_MS;
        });
        if (expiredAlive) return expiredAlive;

        return null;
    }

    // Updates a player's status in the stored list.
    function updateKillPlayerStatus(name, status) {
        const players = state.killPlayers || [];
        const idx = players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        if (idx === -1) return;

        if (status === KILL_STATUS.DEAD) {
            // Remove dead players entirely
            players.splice(idx, 1);
            addLiveLog(`Kill scanner: ${name} is dead — removed from list`);
            // Add to permanent dead list so syncKillExpiryFromPage never re-adds them
            const dead = state.killDeadPlayers || [];
            if (!dead.some(n => n.toLowerCase() === name.toLowerCase())) {
                dead.push(name);
                state.killDeadPlayers = dead;
            }
        } else {
            players[idx].status      = status;
            players[idx].lastChecked = now();
            players[idx].searchCount = (players[idx].searchCount || 0) + 1;

            if (status === KILL_STATUS.ALIVE) {
                // Set searchExpiresAt immediately to now+24hrs so the bot
                // doesn't re-search this player before syncKillExpiryFromPage
                // has a chance to read the accurate timer from the page.
                // syncKillExpiryFromPage will overwrite this with the real value.
                players[idx].searchExpiresAt = now() + (KILL_SCANNER_SEARCH_HOURS * 60 * 60 * 1000);
                // Search was just submitted/confirmed. Until the player appears
                // in Players Found, treat them as pending so BG Farm cannot
                // monopolise the kill page and starve the normal search loop.
                players[idx].pendingSearch = true;
            } else {
                // Clear stored expiry when status changes to non-alive
                delete players[idx].searchExpiresAt;
                delete players[idx].pendingSearch;
            }
        }

        saveKillPlayers(players);
    }

    // -------------------------------------------------------------------------
    // Page detection helpers for kill scanner
    // -------------------------------------------------------------------------

    function isKillPage() {
        return currentPage() === 'kill';
    }

    function isKillPenaltyPage() {
        const url = new URL(window.location.href);
        return url.searchParams.get('p') === 'kill-penalty';
    }

    function isOnlinePage() {
        return currentPage() === 'online';
    }

    // Detects "X is protected from death!" message
    function hasKillProtectedMessage() {
        return [...document.querySelectorAll('.bgm.fail')].some(el =>
            /is protected from death/i.test(textOf(el))
        );
    }

    // Detects "That player is dead" message
    function hasKillDeadMessage() {
        return [...document.querySelectorAll('.bgm.fail')].some(el =>
            /that player is dead/i.test(textOf(el))
        );
    }

    // Detects "X cannot be killed" message
    function hasKillUncillableMessage() {
        return [...document.querySelectorAll('.bgm.fail')].some(el =>
            /cannot be killed/i.test(textOf(el))
        );
    }

    // Detects "You can't search yourself" message
    function hasKillSelfSearchMessage() {
        return [...document.querySelectorAll('.bgm.fail')].some(el =>
            /you can't search yourself/i.test(textOf(el))
        );
    }

    // Detects "Search started on X!" message
    function hasKillSearchStartedMessage() {
        return [...document.querySelectorAll('.bgm.success')].some(el =>
            /search started on/i.test(textOf(el))
        );
    }


    const KILL_SEARCH_SUBMIT_THROTTLE_MS = 5000;
    const KILL_SEARCH_RESPONSE_WAIT_MS   = 20000;

    function sameKillName(a, b) {
        return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    }

    function clearKillSearchSubmitTracking() {
        state.killSearchSubmitAt = 0;
        state.killSearchSubmitName = '';
        state.killSearchWaitLogAt = 0;
    }

    // Scrapes all usernames from the Players Online page
    function scrapeOnlinePlayers() {
        const links = [...document.querySelectorAll('div.bgm a[href*="?p=profile&u="]')];
        const names = [];
        for (const a of links) {
            try {
                const url  = new URL(a.getAttribute('href'), window.location.href);
                const name = url.searchParams.get('u');
                if (name && name.trim()) names.push(name.trim());
            } catch (_) {}
        }
        return [...new Set(names)]; // deduplicate
    }

    // Returns the search form username input
    function getKillSearchUsernameInput() {
        return document.querySelector('form input[name="username"][type="text"]');
    }

    // Returns the search form hours input
    function getKillSearchHoursInput() {
        return document.querySelector('form input[name="hours"]');
    }

    // Returns the search form submit button
    function getKillSearchButton() {
        return document.querySelector('form input[type="hidden"][name="do"][value="search"] ~ * input[type="submit"][value="Search"], form input[name="do"][value="search"] + * input[type="submit"][value="Search"]') ||
               [...document.querySelectorAll('form')].find(f => {
                   const hidden = f.querySelector('input[name="do"][value="search"]');
                   return !!hidden;
               })?.querySelector('input[type="submit"][value="Search"]') || null;
    }

    // -------------------------------------------------------------------------
    // Parse "Players found" section on kill page to get accurate expiry times
    // -------------------------------------------------------------------------

    // Parses "Lost in X d : X h : X m : X s" or "Lost in X h : X m : X s" into ms
    function parseLostInMs(text) {
        if (!text) return null;
        const clean = text.replace(/\s+/g, ' ').trim();

        let totalMs = 0;
        let matched = false;

        const d = clean.match(/(\d+)\s*d/i);
        const h = clean.match(/(\d+)\s*h/i);
        const m = clean.match(/(\d+)\s*m/i);
        const s = clean.match(/(\d+)\s*s/i);

        if (d) { totalMs += parseInt(d[1], 10) * 86400000; matched = true; }
        if (h) { totalMs += parseInt(h[1], 10) * 3600000;  matched = true; }
        if (m) { totalMs += parseInt(m[1], 10) * 60000;    matched = true; }
        if (s) { totalMs += parseInt(s[1], 10) * 1000;     matched = true; }

        return matched ? totalMs : null;
    }


    // Returns the real completion deadline for a player that is still in the
    // game's pending "Your men are out searching for" queue. Do not use
    // searchExpiresAt for this: immediately after submitting a search the bot
    // stores a 24h placeholder there until the player is actually found, so it
    // can look like "found in ~1320m" even when the visible pending timer is
    // only ~45m. expectedFoundAt and the visible pending row are the true source
    // for pending-search completion.
    function getPendingSearchExpectedAt(name, fallbackMs = 3 * 60 * 60 * 1000) {
        const nameLower = String(name || '').toLowerCase();
        const nowMs = now();
        const players = state.killPlayers || [];
        const p = players.find(pl => pl.name && pl.name.toLowerCase() === nameLower);

        if (p && p.expectedFoundAt && p.expectedFoundAt > nowMs) {
            return p.expectedFoundAt;
        }

        const pendingRow = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd')].find(row => {
            const b = row.querySelector('b');
            return b && textOf(b).toLowerCase() === nameLower;
        });

        if (pendingRow) {
            const timerSpan = pendingRow.querySelector('.chd');
            const foundInMs = timerSpan ? parseLostInMs(textOf(timerSpan)) : null;
            if (foundInMs != null) {
                const expectedAt = nowMs + foundInMs;
                const idx = players.findIndex(pl => pl.name && pl.name.toLowerCase() === nameLower);
                if (idx !== -1) {
                    players[idx].pendingSearch = true;
                    players[idx].expectedFoundAt = expectedAt;
                    saveKillPlayers(players);
                }
                return expectedAt;
            }
        }

        if (p && p.pendingSearch) return nowMs + fallbackMs;
        return nowMs + fallbackMs;
    }

    // Reads the "Players found" and "Searching for" sections on the kill page and:
    // 1. Updates each known player's stored expiry time with the accurate "Lost in X" value
    // 2. Adds any unknown players found there to the list as "alive" — cross-device sync
    // 3. Marks pending players (currently being searched, no result yet) so the bot
    //    doesn't try to re-search them — they just need time to be found (3hr window)
    function syncKillExpiryFromPage(fromKillLoop = false) {
        const players = state.killPlayers || [];

        // Clear stale bodyguard references:
        // - Clear if BG is explicitly marked dead in kill list
        // - Clear if BG is not in kill list AND not currently in Players Found on this page
        //   (handles case where BG was removed after being killed)
        // Don't clear if BG was just discovered and may not be in the list yet
        const foundNamesOnPage = new Set(
            [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){ return ''; } })
                .filter(Boolean)
        );
        const pendingNamesOnPage = new Set(
            [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')]
                .map(b => b.textContent.trim().toLowerCase())
                .filter(Boolean)
        );
        let clearedStaleBg = false;
        for (const p of players) {
            if (!p.bodyguard) continue;
            const bgNameLower = p.bodyguard.toLowerCase();
            const bgPlayer = players.find(b => b.name && b.name.toLowerCase() === bgNameLower);
            const isDead = bgPlayer && bgPlayer.status === KILL_STATUS.DEAD;
            const isGoneFromList = !bgPlayer;
            const isOnPage = foundNamesOnPage.has(bgNameLower) || pendingNamesOnPage.has(bgNameLower);
            if (isDead || (isGoneFromList && !isOnPage)) {
                addLiveLog(`Kill scanner: clearing stale BG reference on ${p.name} — ${p.bodyguard} is ${isDead ? 'dead' : 'gone'}`);
                p.bodyguard = null;
                clearedStaleBg = true;
            }
        }
        if (clearedStaleBg) saveKillPlayers(players);

        // "Your men are out searching for" rows — class chs pd — these are pending
        // searches that haven't completed yet. Mark them so getNextKillTarget skips them.
        const pendingRows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd')];
        const pendingNames = new Set();
        for (const row of pendingRows) {
            const b = row.querySelector('b');
            if (!b) continue;
            const name = textOf(b).trim();
            if (!name || name === 'Plub') continue; // Plub is a game NPC, skip
            pendingNames.add(name.toLowerCase());

            // Parse "Found in X h X m X s" timer for any Kill/BG-ticked player
            // so the tick check knows exactly when to navigate to the kill page
            const timerSpan = row.querySelector('.chd');
            if (timerSpan) {
                const foundInMs = parseLostInMs(textOf(timerSpan));
                if (foundInMs != null) {
                    const idx = players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
                    if (idx !== -1) {
                        const p = players[idx];
                        const relevant = isBgCheckable(p.name) || isPlayerShootEnabled(p.name) || p.isBg;
                        if (relevant) {
                            players[idx].expectedFoundAt = now() + foundInMs;
                        }
                        // If this pending player is a bodyguard for a kill-only target,
                        // set killBgWaitUntil so saveSettings doesn't re-enable the kill loop
                        if (p.isBg && p.bgFor) {
                            const targetPlayer = players.find(t =>
                                t.name && p.bgFor && t.name.toLowerCase() === p.bgFor.toLowerCase()
                            );
                            if (targetPlayer && isPlayerShootEnabled(targetPlayer.name) && !isPlayerBgFarmEnabled(targetPlayer.name)) {
                                const waitUntil = now() + foundInMs + (5 * 60 * 1000);
                                if (state.killBgWaitUntil < waitUntil) {
                                    state.killBgWaitUntil = waitUntil;
                                    state.killLoopActive  = false;
                                }
                            }
                        }
                    }
                }
            }
        }

        // For each pending player, set searchExpiresAt to now+3hrs so the bot
        // knows not to re-search them — they're already in the queue.
        for (const name of pendingNames) {
            const idx = players.findIndex(p => p.name.toLowerCase() === name);
            if (idx !== -1) {
                // Only update if the stored expiry is less than 3hrs from now
                // (i.e. the bot was about to re-search them)
                const pending3hr = now() + (3 * 60 * 60 * 1000);
                if (!players[idx].searchExpiresAt || players[idx].searchExpiresAt < pending3hr) {
                    players[idx].searchExpiresAt = pending3hr;
                }
                players[idx].status = KILL_STATUS.ALIVE;
                players[idx].pendingSearch = true;
            }
        }

        // "Players found" rows — each has a player link and a "Lost in" timer span
        const rows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd)')];
        if (!rows.length && !pendingNames.size) return;

        // Check if any kill-only player has a bodyguard currently in the pending search section
        // If so, set killBgWaitUntil to suppress kill loop re-activation while we wait
        // But don't suppress if the BG is already in Players Found — they're ready to shoot
        const alreadyFoundNames = new Set([...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
            .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){ return ''; } })
            .filter(Boolean));
        for (const p of players) {
            if (!p.bodyguard || !isPlayerShootEnabled(p.name)) continue;
            // BG Farm must keep checking the original target on its interval even while
            // the current BG is being searched, so never use the global BG wait to
            // suppress BG Farm interval checks.
            if (isPlayerBgFarmEnabled(p.name)) continue;
            const bgNameLower = p.bodyguard.toLowerCase();
            if (pendingNames.has(bgNameLower) && !alreadyFoundNames.has(bgNameLower)) {
                // Find the pending row to get the timer
                const bgRow = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd')]
                    .find(row => {
                        const b = row.querySelector('b');
                        return b && textOf(b).toLowerCase() === bgNameLower;
                    });
                if (bgRow) {
                    const timerSpan = bgRow.querySelector('.chd');
                    const foundInMs = timerSpan ? parseLostInMs(textOf(timerSpan)) : null;
                    if (foundInMs != null) {
                        const waitUntil = now() + foundInMs + (5 * 60 * 1000);
                        if (state.killBgWaitUntil < waitUntil) {
                            state.killBgWaitUntil = waitUntil;
                        }
                        // Only suppress kill loop if it's not running a BG Farm interval check
                        const isBgCheckStage = state.pendingKillAction?.stage === 'bgcheck';
                        if (!isBgCheckStage) {
                            state.killLoopActive = false;
                            addLiveLog(`Kill loop: ${p.name}'s BG ${p.bodyguard} found in ${Math.ceil(foundInMs/60000)}m — suppressing kill loop`);
                        }
                    }
                }
            }
        }

        let updated    = 0;
        let added      = 0;
        let newlyFound = 0; // Players that just appeared in Players Found (were pending/not there before)

        for (const row of rows) {
            const link = row.querySelector('a[href*="?p=profile&u="]');
            if (!link) continue;

            let name = '';
            try {
                const url = new URL(link.getAttribute('href'), window.location.href);
                name = url.searchParams.get('u') || '';
            } catch (_) { continue; }

            if (!name) continue;

            const timerSpan = row.querySelector('span.chd');
            if (!timerSpan) continue;

            const timerText = textOf(timerSpan);
            const lostInMs  = parseLostInMs(timerText);
            if (lostInMs == null) continue;

            // Calculate when the search actually expires based on the game's timer
            const expiresAt = now() + lostInMs;

            // Parse country from bold tag inside row: "Name in <b>Country</b> Lost in..."
            let rowCountry = '';
            const bTags = [...row.querySelectorAll('b')];
            // Second <b> tag is the country (first is the player name)
            if (bTags.length >= 2) rowCountry = textOf(bTags[1]);

            const idx = players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());

            const deadList = state.killDeadPlayers || [];
            const isKnownDead = deadList.some(n => n.toLowerCase() === name.toLowerCase());
            if (isKnownDead) continue; // Never re-add confirmed dead players

            if (idx === -1) {
                // Player not in list — add as alive (cross-device sync)
                players.push({
                    name,
                    status:          KILL_STATUS.ALIVE,
                    lastChecked:     now(),
                    firstSeen:       now(),
                    searchCount:     1,
                    searchExpiresAt: expiresAt,
                    country:         rowCountry,
                    pendingSearch:   false
                });
                added++;
            } else {
                // Player already in list — update expiry, never resurrect dead
                if (players[idx].status !== KILL_STATUS.DEAD) {
                    players[idx].searchExpiresAt = expiresAt;
                    players[idx].status          = KILL_STATUS.ALIVE;
                    players[idx].pendingSearch   = false;
                    if (rowCountry) players[idx].country = rowCountry;
                    // Clear expectedFoundAt — player is now in Players Found
                    if (players[idx].expectedFoundAt) {
                        delete players[idx].expectedFoundAt;
                        newlyFound++; // Was pending, now found — relevant for kill loop reactivation
                    }
                    updated++;
                }
            }
        }

        if (updated > 0 || added > 0) {
            saveKillPlayers(players);
            if (added > 0) addLiveLog(`Kill scanner: synced ${added} player(s) from Players found section`);
            renderKillList(); // Always refresh — country data may have changed
        }

        // Check if any bodyguard players are now alive (found) — trigger bg_shoot
        // Only if global BG check loop is enabled and penalty not too high
        // Only queue from the kill loop path — not from the search loop path
        if (fromKillLoop && state.killBgCheckEnabled && !isKillPenaltyTooHigh()) for (const p of players) {
            if (!p.isBg || !p.bgFor) continue;
            if (p.status !== KILL_STATUS.ALIVE) continue;
            if (!isPlayerShootEnabled(p.bgFor) && !isPlayerBgFarmEnabled(p.bgFor)) continue;
            // Verify this BG is still the stored bodyguard for their target.
            // If the target has a different BG stored, this player's flags are stale — detach them.
            const bgForPlayer = players.find(pl => pl.name.toLowerCase() === p.bgFor.toLowerCase());
            if (!bgForPlayer || !bgForPlayer.bodyguard || bgForPlayer.bodyguard.toLowerCase() !== p.name.toLowerCase()) {
                const nowBg = bgForPlayer?.bodyguard || 'none';
                addLiveLog(`Kill loop: ${p.name} is no longer confirmed as BG for ${p.bgFor} (now ${nowBg}) — clearing stale flags`);
                delete p.isBg;
                delete p.bgFor;
                delete p.bgShootQueued;
                saveKillPlayers(players);
                continue;
            }
            // Check combined bullet cost — need enough for BG shot AND original target
            // Target cost must account for penalty increasing after killing BG (+0.1x)
            const bgBullets      = p.requiredBullets || 0;
            const currentBullets = getPlayerBullets();
            // Only block if we don't have enough for the BG shot itself
            // Target kill cost is handled separately after BG is dead and target is checked
            if (bgBullets && currentBullets < bgBullets) {
                addLiveLog(`Kill loop: not enough bullets for BG shot of ${p.name} (need ${bgBullets.toLocaleString()}, have ${currentBullets.toLocaleString()}) — waiting`);
                continue;
            }
            const pa = state.pendingKillAction;
            if (pa && (pa.stage === 'bg_shoot' || pa.targetName === p.name)) continue;
            // Don't re-queue if kill loop is already travelling to or handling this BG —
            // check by stage AND by whether bgFor/targetName match inside nested pending states
            // (including afterTravel/afterVerify), not just a fixed stage list.
            const paChainMatches = (obj) => {
                if (!obj) return false;
                if (obj.targetName?.toLowerCase() === p.name.toLowerCase()) return true;
                if (obj.bgFor?.toLowerCase() === p.bgFor?.toLowerCase() && obj.bgFor) return true;
                return paChainMatches(obj.afterTravel) || paChainMatches(obj.afterVerify);
            };
            if (pa && paChainMatches(pa)) continue;
            if (paChainMatches(state.killBgShootPending)) continue;
            // If a verify cycle was explicitly started for this target, don't clobber it —
            // this flag persists across generic pendingKillAction states (e.g. 'bgcheck')
            // and travel/drive cooldowns, and is only cleared when the verify chain
            // actually completes (shoot fires) or genuinely aborts.
            const bgForPlayerFlag = players.find(pl => pl.name.toLowerCase() === p.bgFor?.toLowerCase());
            if (bgForPlayerFlag?.bgVerifyInFlight) continue;
            // Verify bodyguard is actually in Players Found right now before queuing shoot
            const inFoundNow = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .some(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === p.name.toLowerCase(); } catch(_){ return false; } });
            if (!inFoundNow) continue;
            // Skip if already queued for shoot (persistent flag independent of pendingKillAction)
            // But if pendingKillAction is gone, the flag is stale — clear it and re-queue
            if (p.bgShootQueued) {
                const pa = state.pendingKillAction;
                if (pa && (pa.stage === 'bg_shoot' || pa.targetName === p.name)) continue;
                // pendingKillAction was cleared — clear stale flag and re-queue
                const bgQIdx2 = players.findIndex(pl => pl.name.toLowerCase() === p.name.toLowerCase());
                if (bgQIdx2 !== -1) { players[bgQIdx2].bgShootQueued = false; saveKillPlayers(players); }
            }
            // Respect lastKillAttempt cooldown — don't re-queue if recently failed
            if (p.lastKillAttempt && (now() - p.lastKillAttempt) < 30000) continue;
            const isFarmTarget = isPlayerBgFarmEnabled(p.bgFor);
            // Mark as queued so syncKillExpiryFromPage doesn't re-queue on every visit
            const bgQIdx = players.findIndex(pl => pl.name.toLowerCase() === p.name.toLowerCase());
            if (bgQIdx !== -1) { players[bgQIdx].bgShootQueued = true; saveKillPlayers(players); }
            // Clear bgFarmWaitUntil on the original target — search is done, acting now
            const bgForIdx = players.findIndex(pl => pl.name.toLowerCase() === p.bgFor.toLowerCase());
            if (bgForIdx !== -1 && players[bgForIdx].bgFarmWaitUntil) {
                delete players[bgForIdx].bgFarmWaitUntil;
                saveKillPlayers(players);
            }
            if (isFarmTarget) {
                addLiveLog(`Kill loop: bodyguard ${p.name} is now found for ${p.bgFor} (BG Farm) — verifying original before shoot`);
                if (bgForIdx !== -1) { players[bgForIdx].bgVerifyInFlight = true; saveKillPlayers(players); }
                state.pendingKillAction = {
                    stage: 'bg_farm_check',
                    targetName: p.bgFor,
                    shootAfterBg: isPlayerShootEnabled(p.bgFor),
                    force: true,
                    afterVerify: { stage: 'bg_shoot', targetName: p.name, bgFor: p.bgFor, shootAfterBg: isPlayerShootEnabled(p.bgFor) }
                };
            } else {
                addLiveLog(`Kill loop: bodyguard ${p.name} is now found — queuing shoot for ${p.bgFor}`);
                state.pendingKillAction = { stage: 'bg_shoot', targetName: p.name, bgFor: p.bgFor, shootAfterBg: isPlayerShootEnabled(p.bgFor) };
            }
            state.killLoopActive   = true;
            state.killBgWaitUntil  = 0;
            if (isFarmTarget) state.killBgSpamPaused = true;
            break;
        }

        // Clear expectedFoundAt for any player now in Players Found
        let clearedExpected = false;
        for (const p of players) {
            if (!p.expectedFoundAt) continue;
            const inFoundNow = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .some(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === p.name.toLowerCase(); } catch(_){ return false; } });
            if (inFoundNow) {
                delete p.expectedFoundAt;
                clearedExpected = true;
            }
        }
        if (clearedExpected) saveKillPlayers(players);

        // ── Death/wipe detection ──────────────────────────────────────────────
        // If a player is stored as ALIVE but isn't in Players Found or pending
        // searches, their search has expired or been wiped (e.g. after death).
        // Reset them to UNKNOWN so they get re-searched on the next cycle.
        const foundNames = new Set(
            [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){ return ''; } })
                .filter(Boolean)
        );
        let resetCount = 0;
        for (const p of players) {
            if (p.status !== KILL_STATUS.ALIVE) continue;
            const nameLower = p.name.toLowerCase();
            if (!foundNames.has(nameLower) && !pendingNames.has(nameLower)) {
                p.status = KILL_STATUS.UNKNOWN;
                p.lastChecked = 0;
                delete p.searchExpiresAt;
                delete p.expectedFoundAt;
                resetCount++;
            }
        }
        if (resetCount > 0) {
            saveKillPlayers(players);
            addLiveLog(`Kill scanner: reset ${resetCount} player(s) to unknown — not in Players Found or pending searches`);
            renderKillList();
        }

        // Reactivate kill loop only if a player newly appeared in Players Found OR bullets became sufficient
        if (state.killBgCheckEnabled && !state.killLoopActive && (added > 0 || newlyFound > 0)) {
            const nowActive = players.some(p => {
                if (p.status !== KILL_STATUS.ALIVE) return false;
                if (p.status === KILL_STATUS.PROTECTED || p.status === KILL_STATUS.UNKILLABLE) return false;
                // Skip if insufficient bullets known
                if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) return false;
                // Must actually be in Players Found right now
                const inFound = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                    .some(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === p.name.toLowerCase(); } catch(_){ return false; } });
                if (!inFound) return false;
                // BG farm wait not expired — skip this player
                if (isPlayerBgFarmEnabled(p.name) && p.bgFarmWaitUntil && p.bgFarmWaitUntil > Date.now()) return false;
                // Skip if player has a bodyguard currently being searched — wait for BG search to resolve
                if (p.bodyguard) return false;
                // BG check due
                if (isBgCheckable(p.name) && getBgCheckDueMs(p) <= 0) return true;
                // Kill only — only reactivate if penalty not too high
                if (isPlayerShootEnabled(p.name) && !isBgCheckable(p.name) && !isKillPenaltyTooHigh()) return true;
                return false;
            });
            if (nowActive && !(state.killBgWaitUntil > Date.now())) {
                addLiveLog('Kill loop: target now in Players Found — reactivating');
                state.killLoopCooldownUntil = 0;
                state.killLoopActive = true;
            }
        }

        // Always check: players already in Players Found with Kill ticked and now sufficient bullets
        // This handles the case where bullets accumulate over time for a player already found
        // Skip entirely if a bg_shoot is already queued, or if called from search loop (not kill loop)
        const alreadyBgShooting = state.pendingKillAction?.stage === 'bg_shoot';
        if (state.killBgCheckEnabled && !state.killLoopActive && !isKillPenaltyTooHigh() && !alreadyBgShooting) {
            const foundLinks = new Set([...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){ return ''; } })
                .filter(Boolean));
            const currentBullets = getPlayerBullets();
            const bulletsReady = players.some(p => {
                if (p.status !== KILL_STATUS.ALIVE) return false;
                if (!isPlayerShootEnabled(p.name)) return false;
                if (p.bodyguard) {
                    // Player has a pending BG — only check BG bullet cost
                    // Target cost is checked separately when it's actually time to shoot the target
                    if (!foundLinks.has(p.bodyguard.toLowerCase())) return false;
                    const bgPlayer  = players.find(b => b.name && b.name.toLowerCase() === p.bodyguard.toLowerCase());
                    const bgBullets = bgPlayer?.requiredBullets || 0;
                    if (bgBullets > 0 && currentBullets < bgBullets) {
                        addLiveLog(`Kill loop: BG found but need ${bgBullets.toLocaleString()} bullets for BG shot (have ${currentBullets.toLocaleString()}) — waiting`);
                        return false;
                    }
                    return true;
                }
                // Direct kill — no pending BG
                if (!p.requiredBullets) return false;
                const bulletBuffer = isBgCheckable(p.name) ? 1 : 0;
                if (currentBullets < p.requiredBullets + bulletBuffer) return false;
                if (!foundLinks.has(p.name.toLowerCase())) return false;
                return true;
            });
            if (bulletsReady) {
                addLiveLog('Kill loop: bullets now sufficient — reactivating kill loop');
                state.killLoopActive  = true;
                state.killBgWaitUntil = 0;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Players Online scanner — fires periodically during normal script
    // -------------------------------------------------------------------------

    function isKillOnlineScanDue() {
        if (!state.killScanOnlineEnabled) return false;
        if (isOnlinePage()) return false; // already on the page — don't re-trigger
        const intervalMs = state.killScanOnlineInterval * 60 * 1000;
        return (now() - state.killLastOnlineScan) >= intervalMs;
    }

    async function handleOnlinePage() {
        stopJailObserver();

        if (!state.killScanOnlineEnabled) {
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        const names = scrapeOnlinePlayers();
        const added = mergeOnlinePlayers(names);
        state.killLastOnlineScan = now();

        addLiveLog(`Kill scanner: found ${names.length} online players, added ${added} new`);
        renderKillList();

        await wait(navRand());

        // Only go directly to kill page if new unknown players were found.
        // If no new unknowns, return to normal script — the 1hr failsafe and
        // 3hr alive window will activate the loop via init() when due.
        if (state.killSearchEnabled && added > 0) {
            state.killSearchLoopActive = true;
            addLiveLog('Kill scanner: new unknown players found — going directly to kill page');
            gotoPage('kill');
            return;
        }

        gotoPage('crimes');
    }

    // -------------------------------------------------------------------------
    // Kill search loop — dedicated mode, searches players one by one
    // -------------------------------------------------------------------------

    async function handleKillPage() {
        stopJailObserver();

        if (!state.killSearchEnabled) {
            addLiveLog('Kill search disabled — returning to crimes');
            state.killSearchLoopActive = false;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // If kill loop has a pending action, let it take over — don't interfere with search loop
        if (state.pendingKillAction && state.killLoopActive) {
            state.killSearchLoopActive = false;
            await handleKillLoopPage();
            return;
        }

        // Sync accurate expiry times from the "Players found" section on every
        // kill page load — this is more reliable than the 23hr fallback window.
        // If BG check is enabled and a BG Farm player's known BG is in Players Found,
        // pass fromKillLoop=true so the bg_shoot queuing logic can fire.
        const _syncFromLoop = state.killBgCheckEnabled && (() => {
            const _players = getKillPlayers();
            const _foundNames = new Set(
                [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                    .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){ return ''; } })
                    .filter(Boolean)
            );
            return _players.some(p =>
                p.isBg && p.bgFor && p.status === KILL_STATUS.ALIVE && _foundNames.has(p.name.toLowerCase())
            );
        })();
        syncKillExpiryFromPage(_syncFromLoop);

        // Detect manually searched players — read all names from "Your men are
        // out searching for" section and add any not already in the kill list
        // as UNKNOWN so they appear in the UI immediately with BG/Kill checkboxes.
        const pendingSearchEls = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')];
        if (pendingSearchEls.length > 0) {
            const players = getKillPlayers();
            const dead = state.killDeadPlayers || [];
            let added = false;
            for (const el of pendingSearchEls) {
                const name = el.textContent.trim();
                if (!name) continue;
                const already = players.some(p => p.name.toLowerCase() === name.toLowerCase());
                const isDead  = dead.some(n => n.toLowerCase() === name.toLowerCase());
                if (!already && !isDead) {
                    players.push({ name, status: KILL_STATUS.UNKNOWN, lastChecked: 0, searchCount: 0 });
                    addLiveLog(`Kill scanner: added pending search player ${name} to list`);
                    added = true;
                }
            }
            if (added) {
                saveKillPlayers(players);
                renderKillList();
            }
        }

        // If penalty exceeds threshold and penaltyDropsAt not set, navigate to penalty page
        if (state.killPenaltyThreshold > 0 && !state.pendingPenaltyPage) {
            const livePenalty = getKillPenaltyMultiplier(); // authoritative on kill page
            const cached = Number(getSetting('cachedKillPenalty', 1.0));
            const penaltyTooHigh = livePenalty >= state.killPenaltyThreshold;
            const penaltyChanged = Math.abs(livePenalty - cached) >= 0.05;
            const needsCalc = !state.penaltyDropsAt || penaltyChanged;
            // If live penalty is 1.0 (no penalty), ensure penaltyDropsAt is cleared
            if (livePenalty <= 1.0) {
                if (state.penaltyDropsAt) state.penaltyDropsAt = 0;
            } else if (penaltyTooHigh && needsCalc) {
                const reason = penaltyChanged ? `penalty changed (${cached}x → ${livePenalty}x)` : `penalty ${livePenalty}x exceeds threshold`;
                addLiveLog(`Kill loop: ${reason} — navigating to penalty page`);
                state.pendingPenaltyPage = true;
                await wait(navRand());
                gotoPage('kill-penalty');
                return;
            }
        }

        if (hasCTCChallenge()) {
            await maybeSolveCTC();
            // After CTC solve the page reloads — do NOT mark search as complete here.
            // The result will be handled on the next page load via the normal
            // hasKillSearchStartedMessage() / hasKillProtectedMessage() checks.
            // We only need to ensure killCurrentSearch is preserved across the reload,
            // which it is since it's stored in GM storage.
            return;
        }

        // If we have a pending search and a CTC was just solved (no result message
        // because the page reloaded fresh), treat it as a successful search.
        // Detection: killCurrentSearch is set but no fail message and no success
        // message — means the CTC reload cleared the result, so the search went through.
        if (!killSearchResultHandledThisLoad && state.killCurrentSearch) {
            const current = state.killCurrentSearch;
            const hasFail    = hasKillDeadMessage() || hasKillProtectedMessage() ||
                               hasKillUncillableMessage() || hasKillSelfSearchMessage();
            const hasSuccess = hasKillSearchStartedMessage();

            if (!hasFail && !hasSuccess) {
                // No result message — likely a CTC reload. Check if search is now active
                // by looking for the player in "Your men are out searching for" section.
                const searchingRows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')];
                const nowSearching  = searchingRows.some(el =>
                    textOf(el).toLowerCase() === current.toLowerCase()
                );
                if (nowSearching) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.ALIVE);
                    addLiveLog(`Kill scanner: ${current} — search confirmed (post-CTC)`);
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    renderKillList();
                }
            }
        }

        // Handle result of previous search attempt — only once per page load
        if (!killSearchResultHandledThisLoad) {
            const current = state.killCurrentSearch;

            if (current) {
                if (hasKillDeadMessage()) {
                    killSearchResultHandledThisLoad = true;
                    addLiveLog(`Kill scanner: ${current} is dead — removed from list`);
                    // Check if this was a BG for a BG Farm player — trigger BG check on that player
                    const allPlayers = state.killPlayers || [];
                    const deadPlayer = allPlayers.find(p => p.name.toLowerCase() === current.toLowerCase());
                    const bgForName = deadPlayer?.bgFor || null;
                    updateKillPlayerStatus(current, KILL_STATUS.DEAD);
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    renderKillList();
                    // If dead player was a BG for a BG Farm player, do BG check now
                    if (bgForName && isPlayerBgFarmEnabled(bgForName)) {
                        addLiveLog(`Kill scanner: ${current} was BG for ${bgForName} — triggering BG Farm check`);
                        // Clear bgFarmWaitUntil — the BG search is no longer relevant
                        const plFarm = state.killPlayers || [];
                        const farmIdx = plFarm.findIndex(p => p.name.toLowerCase() === bgForName.toLowerCase());
                        if (farmIdx !== -1) {
                            delete plFarm[farmIdx].bgFarmWaitUntil;
                            delete plFarm[farmIdx].bodyguard;
                            saveKillPlayers(plFarm);
                        }
                        state.pendingKillAction = {
                            stage:        'bg_farm_check',
                            targetName:   bgForName,
                            shootAfterBg: isPlayerShootEnabled(bgForName),
                        };
                        state.killLoopActive   = true;
                        state.killBgSpamPaused = true;
                        stopBgSpam();
                        await wait(navRand());
                        gotoPage('kill');
                        return;
                    }
                } else if (hasKillUncillableMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.UNKILLABLE);
                    addLiveLog(`Kill scanner: ${current} cannot be killed — marked unkillable`);
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    renderKillList();
                } else if (hasKillSelfSearchMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.UNKILLABLE);
                    addLiveLog(`Kill scanner: ${current} is you — marked unkillable, will never search again`);
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    renderKillList();
                } else if (hasKillProtectedMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.PROTECTED);
                    addLiveLog(`Kill scanner: ${current} is protected`);
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    renderKillList();
                } else if (hasKillSearchStartedMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.ALIVE);
                    addLiveLog(`Kill scanner: ${current} — search started`);
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    renderKillList();
                }
            }
        }

        // If a search was just submitted and no page response has arrived yet,
        // do not submit the same target again during lag/reloads. The normal
        // result handlers above will clear killCurrentSearch once the page shows
        // Search started / Protected / Cannot be killed / Dead / Self-search.
        if (state.killCurrentSearch) {
            const waitingName = state.killCurrentSearch;
            const submittedAt = state.killSearchSubmitAt || 0;
            const elapsed = submittedAt ? (now() - submittedAt) : 0;
            const responseStillPending = !hasKillDeadMessage() && !hasKillProtectedMessage() &&
                !hasKillUncillableMessage() && !hasKillSelfSearchMessage() && !hasKillSearchStartedMessage();

            if (responseStillPending && submittedAt && elapsed < KILL_SEARCH_RESPONSE_WAIT_MS) {
                if (!state.killSearchWaitLogAt || (now() - state.killSearchWaitLogAt) > 10000) {
                    addLiveLog(`Kill scanner: waiting for search response for ${waitingName}`);
                    state.killSearchWaitLogAt = now();
                }
                return;
            }

            if (responseStillPending && submittedAt && elapsed >= KILL_SEARCH_RESPONSE_WAIT_MS) {
                addLiveLog(`Kill scanner: no response for ${waitingName} after ${Math.round(elapsed / 1000)}s — allowing retry`);
                state.killCurrentSearch = '';
                clearKillSearchSubmitTracking();
            }
        }

        // Find the next player to search
        const target = getNextKillTarget();

        if (!target) {
            // No search targets — check if kill loop should activate for BG checks
            if (state.killBgCheckEnabled) {
                const alivePlayers = getKillPlayers().filter(p =>
                    p.status === KILL_STATUS.ALIVE || p.status === KILL_STATUS.UNKNOWN
                );
                const hasBgDue = alivePlayers.some(p =>
                    isBgCheckable(p.name) && getBgCheckDueMs(p) <= 0
                );
                const hasKillable = alivePlayers.some(p => {
                    if (!isPlayerShootEnabled(p.name)) return false;
                    if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) return false;
                    if (isBgCheckable(p.name) && getBgCheckDueMs(p) <= 0) return false;
                    return true;
                });
                if (hasBgDue || hasKillable) {
                    // syncKillExpiryFromPage already ran above — if kill loop didn't activate,
                    // the players aren't in Players Found yet. Just revert to normal script.
                    // killLoopActive may have been set by syncKillExpiryFromPage — check first.
                    if (!state.killLoopActive) {
                        addLiveLog('Kill scanner: no targets right now — reverting to normal script (toggle stays on)');
                        state.killSearchLoopActive = false;
                        setSetting('killSearchNoTargetUntil', Date.now() + 60000); // 60s cooldown
                        await wait(navRand());
                        gotoPage('crimes');
                        return;
                    }
                    // Kill loop was activated by syncKillExpiryFromPage — let it take over
                    state.killSearchLoopActive = false;
                    return;
                }
            }
            addLiveLog('Kill scanner: no targets right now — reverting to normal script (toggle stays on)');
            state.killSearchLoopActive = false;
            // Set a cooldown so the protected recheck interval can't immediately reactivate the loop
            setSetting('killSearchNoTargetUntil', Date.now() + 60000); // 60s cooldown
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Submit search for next target
        const usernameInput = getKillSearchUsernameInput();
        const hoursInput    = getKillSearchHoursInput();
        const searchBtn     = getKillSearchButton();

        if (!usernameInput || !searchBtn) {
            const retries = (state.killSearchFormRetries || 0) + 1;
            state.killSearchFormRetries = retries;
            if (retries >= 5) {
                addLiveLog('Kill scanner: search form not found after 5 retries — reverting to normal script');
                state.killSearchFormRetries = 0;
                state.killSearchLoopActive = false;
                // Don't kill killLoopActive — let the scanner re-activate it naturally
                // on the next online scan or protected recheck cycle
                gotoPage('crimes');
            } else {
                addLiveLog(`Kill scanner: search form not found — retrying (${retries}/5)`);
            }
            return;
        }
        state.killSearchFormRetries = 0;

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshUsernameInput = getKillSearchUsernameInput();
        const freshHoursInput    = getKillSearchHoursInput();
        const freshSearchBtn     = getKillSearchButton();

        if (!freshUsernameInput || !freshSearchBtn) return;

        const lastSubmitAt   = state.killSearchSubmitAt || 0;
        const lastSubmitName = state.killSearchSubmitName || '';
        if (lastSubmitAt && sameKillName(lastSubmitName, target.name) &&
            (now() - lastSubmitAt) < KILL_SEARCH_SUBMIT_THROTTLE_MS) {
            if (!state.killSearchWaitLogAt || (now() - state.killSearchWaitLogAt) > 10000) {
                addLiveLog(`Kill scanner: search for ${target.name} already submitted — waiting for response`);
                state.killSearchWaitLogAt = now();
            }
            return;
        }

        freshUsernameInput.value = target.name;
        if (freshHoursInput) freshHoursInput.value = String(KILL_SCANNER_SEARCH_HOURS);

        state.killCurrentSearch = target.name;
        state.killSearchSubmitName = target.name;
        state.killSearchSubmitAt = now();
        state.killSearchWaitLogAt = 0;
        addLiveLog(`Kill scanner: searching ${target.name} (status: ${target.status})`);

        humanClick(freshSearchBtn);
        // Page reloads — result handled on next load
    }

    // -------------------------------------------------------------------------
    // Render the kill player list in the UI
    // -------------------------------------------------------------------------

    function renderKillList() {
        const el = document.querySelector('#ug-bot-kill-list');
        if (!el) return;

        updateBgSpamDropdown();
        const players = getKillPlayers();

        if (!players.length) {
            el.innerHTML = '<div class="ug-kill-empty">No players tracked yet. Enable "Scan Players Online" to start building the list.</div>';
            return;
        }

        const groups = {
            [KILL_STATUS.UNKNOWN]:    { label: 'Unknown',    colour: '#aaa',     players: [] },
            [KILL_STATUS.ALIVE]:      { label: 'Alive',      colour: '#9fe79f',  players: [] },
            [KILL_STATUS.PROTECTED]:  { label: 'Protected',  colour: '#f8c84a',  players: [] },
            [KILL_STATUS.UNKILLABLE]: { label: 'Unkillable', colour: '#f88',     players: [] }
        };

        for (const p of players) {
            if (groups[p.status]) groups[p.status].players.push(p);
        }

        let html = '';

        for (const [status, group] of Object.entries(groups)) {
            if (!group.players.length) continue;

            const canBgCheck = (status === KILL_STATUS.UNKNOWN || status === KILL_STATUS.ALIVE || status === KILL_STATUS.PROTECTED);

            html += `<div class="ug-kill-group-title">${escapeHtml(group.label)} (${group.players.length})</div>`;

            // Table approach — immune to flex/CSS interference from the game
            html += `<table class="ug-kill-table" style="width:100%;border-collapse:collapse;table-layout:fixed;">`;
            if (canBgCheck) {
                html += `<colgroup><col style="width:90px;"/><col style="width:62px;"/><col style="width:36px;"/><col style="width:22px;"/><col style="width:46px;"/><col style="width:40px;"/></colgroup>`;
                html += `<tr><td></td><td style="font-size:9px;color:#aaa;padding:0 4px 2px 0 !important;">Country</td><td style="font-size:9px;color:#aaa;text-align:right;padding:0 4px 2px 0 !important;">Time</td><td style="font-size:9px;color:#aaa;text-align:center;padding:0 0 2px 0 !important;">Kill</td><td style="font-size:9px;color:#aaa;text-align:center;padding:0 0 2px 0 !important;">BG Check</td><td style="font-size:9px;color:#aaa;text-align:center;padding:0 0 2px 0 !important;">BG Farm</td></tr>`;
            } else if (status === KILL_STATUS.UNKILLABLE) {
                html += `<colgroup><col style="width:auto;"/><col style="width:80px;"/><col style="width:46px;"/><col style="width:16px;"/></colgroup>`;
            } else {
                html += `<colgroup><col style="width:auto;"/><col style="width:80px;"/><col style="width:46px;"/></colgroup>`;
            }

            for (const p of group.players) {
                // Time meta
                let meta = '';
                if (p.status === KILL_STATUS.ALIVE && p.searchExpiresAt) {
                    const remaining = p.searchExpiresAt - now();
                    if (remaining > 3600000) {
                        const hrs  = Math.floor(remaining / 3600000);
                        const mins = Math.floor((remaining % 3600000) / 60000);
                        meta = `${hrs}h ${mins}m`;
                    } else if (remaining > 0) {
                        meta = `${Math.floor(remaining / 60000)}m`;
                    } else {
                        meta = 'exp.';
                    }
                } else if (p.lastChecked) {
                    meta = formatTimeSince(p.lastChecked);
                } else {
                    meta = 'never';
                }

                // BG due indicator
                let bgDue = '';
                if (p.status === KILL_STATUS.ALIVE && p.lastBgCheck && isBgCheckable(p.name)) {
                    const dueMs = getBgCheckDueMs(p);
                    if (dueMs <= 0) bgDue = ' ●';
                }

                const bgChecked    = canBgCheck && isPlayerBgCheckEnabled(p.name);
                const shootChecked = canBgCheck && isPlayerShootEnabled(p.name);
                const bgFarmChecked = canBgCheck && isPlayerBgFarmEnabled(p.name);

                const country = p.country || '';

                // BG check tooltip — calculated before template literal
                let bgTooltip = 'BG check: never done';
                if (p.lastBgCheck) {
                    const bgDueMs2 = getBgCheckDueMs(p);
                    if (bgDueMs2 <= 0) {
                        bgTooltip = 'BG check: due now';
                    } else {
                        const bgHrs  = Math.floor(bgDueMs2 / 3600000);
                        const bgMins = Math.floor((bgDueMs2 % 3600000) / 60000);
                        bgTooltip = bgHrs > 0 ? 'BG check: due in ' + bgHrs + 'h ' + bgMins + 'm' : 'BG check: due in ' + bgMins + 'm';
                    }
                }

                if (canBgCheck) {
                    html += `<tr>
                        <td style="font-size:11px;color:${group.colour};padding:1px 4px 1px 0 !important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:auto !important;" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
                        <td style="font-size:9px;color:#888;padding:1px 4px 1px 0 !important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:62px !important;min-width:62px !important;max-width:62px !important;">${escapeHtml(country)}</td>
                        <td style="font-size:9px;color:#ccc;text-align:right;padding:1px 4px 1px 0 !important;white-space:nowrap;width:36px !important;min-width:36px !important;max-width:36px !important;">${escapeHtml(meta)}${bgDue}</td>
                        <td style="text-align:center;padding:1px 2px !important;width:22px !important;min-width:22px !important;max-width:22px !important;"><div class="ug-kcb ug-kill-shoot-cb ${shootChecked ? 'checked' : ''}" data-name="${escapeHtml(p.name)}"></div></td>
                        <td style="text-align:center;padding:1px 2px !important;width:46px !important;min-width:46px !important;max-width:46px !important;"><div class="ug-kcb ug-kill-bg-cb ${bgChecked ? 'checked' : ''}" data-name="${escapeHtml(p.name)}" title="${escapeHtml(bgTooltip)}"></div></td>
                        <td style="text-align:center;padding:1px 2px !important;width:40px !important;min-width:40px !important;max-width:40px !important;"><div class="ug-kcb ug-kill-bgfarm-cb ${bgFarmChecked ? 'checked' : ''}" data-name="${escapeHtml(p.name)}"></div></td>
                    </tr>`;
                } else if (status === KILL_STATUS.UNKILLABLE) {
                    html += `<tr>
                        <td style="font-size:11px;color:${group.colour};padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
                        <td style="font-size:9px;color:#888;padding:1px 4px 1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(country)}</td>
                        <td style="font-size:9px;color:#ccc;text-align:right;padding:1px 4px 1px 0;white-space:nowrap;">${escapeHtml(meta)}</td>
                        <td style="text-align:center;padding:1px 0;"><span class="ug-kill-remove" data-name="${escapeHtml(p.name)}" title="Reset to unknown — will be re-searched" style="cursor:pointer;color:#f88;font-size:11px;line-height:1;">✕</span></td>
                    </tr>`;
                } else {
                    html += `<tr>
                        <td style="font-size:11px;color:${group.colour};padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
                        <td style="font-size:9px;color:#888;padding:1px 4px 1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(country)}</td>
                        <td style="font-size:9px;color:#ccc;text-align:right;padding:1px 0;white-space:nowrap;">${escapeHtml(meta)}</td>
                    </tr>`;
                }

                // Bodyguard sub-row
                if (p.bodyguard) {
                    const cols = canBgCheck ? 6 : 3;
                    // Look up the BG player to get expectedFoundAt
                    const bgPlayer = players.find(b => b.name && b.name.toLowerCase() === p.bodyguard.toLowerCase());
                    let bgTimer = '';
                    if (bgPlayer && bgPlayer.expectedFoundAt) {
                        const msLeft = bgPlayer.expectedFoundAt - now();
                        if (msLeft > 0) {
                            const hrs  = Math.floor(msLeft / 3600000);
                            const mins = Math.floor((msLeft % 3600000) / 60000);
                            const secs = Math.floor((msLeft % 60000) / 1000);
                            bgTimer = hrs > 0
                                ? ` <span style="color:#aaa;">(found in ${hrs}h ${mins}m)</span>`
                                : mins > 0
                                    ? ` <span style="color:#aaa;">(found in ${mins}m ${secs}s)</span>`
                                    : ` <span style="color:#9fe79f;">(found in ${secs}s)</span>`;
                        } else {
                            bgTimer = ` <span style="color:#9fe79f;">(found — shooting soon)</span>`;
                        }
                    } else if (bgPlayer) {
                        bgTimer = ` <span style="color:#aaa;">(searching...)</span>`;
                    }
                    html += `<tr><td colspan="${cols}" style="font-size:9px;color:#f8c84a;padding:0 0 1px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">&#8594; ${escapeHtml(p.bodyguard)}${bgTimer}</td></tr>`;
                }
            }
            html += `</table>`;
        }

        const killListScrollTop = el.scrollTop || Number(getSetting('scrollKill', 0));
        el.innerHTML = html;
        el.scrollTop = killListScrollTop;
        setSetting('scrollKill', 0);
        // Listener is attached once in attachKillListListener() — not here
    }

    // Called once after the kill list element is created in the DOM.
    // Attaches the click delegation listener that handles fake checkbox toggles.
    function attachKillListListener() {
        const el = document.querySelector('#ug-bot-kill-list');
        if (!el || el.dataset.listenerAttached) return;
        el.dataset.listenerAttached = '1';
        el.addEventListener('click', (e) => {
            // Handle ✕ remove button for unkillable players
            const removeBtn = e.target.closest('.ug-kill-remove');
            if (removeBtn) {
                const name = removeBtn.dataset.name;
                if (!name) return;
                const pls = state.killPlayers || [];
                const idx = pls.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
                if (idx !== -1) {
                    pls[idx].status = KILL_STATUS.UNKNOWN;
                    delete pls[idx].lastChecked;
                    saveKillPlayers(pls);
                    addLiveLog(`Kill scanner: ${name} reset to unknown — will be re-searched`);
                    renderKillList();
                }
                return;
            }

            const cb = e.target.closest('.ug-kcb');
            if (!cb) return;
            cb.classList.toggle('checked');
            const isChecked = cb.classList.contains('checked');
            const name = cb.dataset.name;
            if (cb.classList.contains('ug-kill-bg-cb')) {
                setPlayerBgCheckEnabled(name, isChecked);
                if (isChecked && state.killBgCheckEnabled && !isKillPenaltyTooHigh()) state.killLoopActive = true;
            } else if (cb.classList.contains('ug-kill-shoot-cb')) {
                setPlayerShootEnabled(name, isChecked);
            } else if (cb.classList.contains('ug-kill-bgfarm-cb')) {
                setPlayerBgFarmEnabled(name, isChecked);
                // Auto-tick Kill visually as well as in storage.
                if (isChecked) {
                    const killCb = cb.closest('tr')?.querySelector('.ug-kill-shoot-cb');
                    if (killCb) killCb.classList.add('checked');
                }
                if (isChecked && !isKillPenaltyTooHigh()) state.killLoopActive = true;
            }
        });
    }

    function formatTimeSince(ts) {
        const diffMs = now() - ts;
        if (diffMs < 60000)   return 'just now';
        if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
        if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
        return `${Math.floor(diffMs / 86400000)}d ago`;
    }

    // =========================================================================
    // BUST
    // =========================================================================







    // ── QT Perk Sniper — background polling for bodyguards and bullets ──────────
    // Safe deposit — retries until success to prevent money being left on hand
    async function qtSafeDeposit() {
        let attempts = 0;
        while (true) {
            attempts++;
            try {
                const resp = await fetch(`/a/quickbank.php?type=deposit&_=${Date.now()}`, { credentials: 'include' });
                await resp.text();
                if (attempts > 1) addLiveLog(`QT Sniper: deposit succeeded after ${attempts} attempts`);
                return; // success
            } catch (e) {
                addLiveLog(`QT Sniper: ⚠ deposit attempt ${attempts} failed — retrying in 2s (money on hand!)`);
                await wait(2000);
            }
        }
    }
    let qtSniperTimer            = null;
    let qtSniperActive           = false;
    let qtSniperConsecutiveErrors = 0;
    let crimePaused              = false;
    let qtSniperAbortController  = null; // Abort in-flight QT fetch when crimes page loads

    // ── Perk Extender — runs independently of QT sniper at a slower interval ──
    let qtPerkExtendTimer  = null;
    let qtPerkExtendActive = false;
    let qtPerkRedeemTimer  = null;
    let qtPerkRedeemActive = false;

    // ── Free Entry Dice Joiner ────────────────────────────────────────────────
    const DICE_JOIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

    let diceJoinTimer  = null;
    let diceJoinActive = false;

    function startDiceJoiner() {
        if (diceJoinActive) return;
        diceJoinActive = true;
        scheduleDiceJoin();
    }

    function stopDiceJoiner() {
        diceJoinActive = false;
        if (diceJoinTimer) { clearTimeout(diceJoinTimer); diceJoinTimer = null; }
    }

    function scheduleDiceJoin() {
        if (!diceJoinActive) return;
        // Fire at 1 minute past each half-hour boundary (00:01, 00:31, 01:01, 01:31 etc.)
        const INTERVAL_MS  = 30 * 60 * 1000; // 30 minutes
        const OFFSET_MS    =  1 * 60 * 1000; //  1 minute past the boundary
        const now          = Date.now();
        const boundary     = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
        const nextFire     = boundary + OFFSET_MS;
        const delay        = nextFire > now ? nextFire - now : nextFire + INTERVAL_MS - now;
        diceJoinTimer = setTimeout(doDiceJoin, delay);
    }

    async function doDiceJoin() {
        if (!diceJoinActive || !state.enabled || !state.diceJoinEnabled) { scheduleDiceJoin(); return; }
        setSetting('diceJoinLastRun', Date.now());
        try {
            const resp = await fetch('/?p=multiplayer-dice&page=1', { credentials: 'include', cache: 'no-store' });
            const text = await resp.text();
            const doc  = new DOMParser().parseFromString(text, 'text/html');

            // Find all game blocks with Free entry and a checkbox (not yet joined)
            const games = [...doc.querySelectorAll('.bgl.jr.i')];
            const toJoin = [];
            for (const game of games) {
                const isFree = !!game.querySelector('.bgd .cg');
                const cb     = game.querySelector('input[name="id[]"]');
                if (isFree && cb) toJoin.push(cb.value);
            }

            if (!toJoin.length) { scheduleDiceJoin(); return; }

            // POST to join all at once
            const body = toJoin.map(id => `id[]=${id}`).join('&');
            await fetch('/?p=multiplayer-dice', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            });
            addLiveLog(`Dice: joined ${toJoin.length} free entry game(s)`);
        } catch (e) {
            addLiveLog(`Dice: join error — ${e.message}`);
        }
        scheduleDiceJoin();
    }

    function startQTPerkExtender() {
        if (qtPerkExtendActive) return;
        qtPerkExtendActive = true;
        doQTPerkExtend();
    }

    function stopQTPerkExtender() {
        qtPerkExtendActive = false;
        if (qtPerkExtendTimer) { clearTimeout(qtPerkExtendTimer); qtPerkExtendTimer = null; }
    }

    function scheduleQTPerkExtend() {
        if (!qtPerkExtendActive) return;
        const intervalMs = state.qtPerkExtendMins * 60 * 1000;
        const lastRun    = Number(getSetting('qtPerkExtendLastRun', 0));
        const elapsed    = Date.now() - lastRun;
        const delay      = Math.max(0, intervalMs - elapsed);
        qtPerkExtendTimer = setTimeout(doQTPerkExtend, delay);
    }

    async function doQTPerkExtend() {
        if (!qtPerkExtendActive || !state.enabled || !state.qtPerkExtendEnabled || crimePaused || (!state.bgCrimeEnabled && (isCrimesPage() || hasCrimePageMarkers()))) {
            scheduleQTPerkExtend();
            return;
        }

        // Check if enough time has elapsed since last run
        const intervalMs = state.qtPerkExtendMins * 60 * 1000;
        const lastRun    = Number(getSetting('qtPerkExtendLastRun', 0));
        if (Date.now() - lastRun < intervalMs) {
            scheduleQTPerkExtend();
            return;
        }

        setSetting('qtPerkExtendLastRun', Date.now());

        try {
            const resp = await fetch('/?p=perks', { credentials: 'include', cache: 'no-store' });
            const text = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const toExtend = [];
            const minBullets = state.qtBulletsMin;

            // Check each perk type based on extend settings
            // Table selectors verified against live page HTML:
            //   pb=Bullets, pc=Cars, pcv=Bullet value, pd=Double cash, pib=Always bust,
            //   pmd=Double melts, pm=Cash/Money, pn=Always successful, ps=Rare cars, px=Double XP, ppbot=BG
            const extendChecks = [
                { enabled: state.extendBgs,          sel: 'table.ppbot', label: 'BG',            threshold: null },
                { enabled: state.extendCars,          sel: 'table.pc',    label: 'Cars',          threshold: null },
                { enabled: state.extendBullets,       sel: 'table.pb',    label: 'Bullets',       threshold: state.extendBulletsThreshold },
                { enabled: state.extendBulletValue,   sel: 'table.pcv',   label: 'Bullet value',  threshold: state.extendBulletValueThreshold },
                { enabled: state.extendRares,         sel: 'table.ps',    label: 'Rare cars',     threshold: state.extendRaresThreshold },
                { enabled: state.extendDoubleMelts,   sel: 'table.pmd',   label: 'Double melts',  threshold: state.extendDoubleMeltsThreshold },
                { enabled: state.extendDoubleXp,      sel: 'table.px',    label: 'Double XP',     threshold: state.extendDoubleXpThreshold },
                { enabled: state.extendAlwaysBust,    sel: 'table.pib',   label: 'Always bust',   threshold: state.extendAlwaysBustThreshold },
                { enabled: state.extendAlwaysSucc,    sel: 'table.pn',    label: 'Always successful', threshold: state.extendAlwaysSuccThreshold },
                { enabled: state.extendDoubleCash,    sel: 'table.pd',    label: 'Double cash',   threshold: state.extendDoubleCashThreshold },
            ];
            const seenExtend = new Set();
            for (const { enabled, sel, label, threshold } of extendChecks) {
                if (!enabled) continue;
                const rows = [...doc.querySelectorAll(`${sel} tr.sortable-row`)];
                for (const row of rows) {
                    const id = row.dataset.id;
                    if (!id || seenExtend.has(id)) continue;
                    const cells = row.querySelectorAll('td');
                    const expiry = parseInt(cells[2]?.textContent.trim(), 10);
                    if (expiry !== 1) continue;
                    // Check threshold if applicable
                    if (threshold !== null) {
                        const nameEl = row.querySelector('.lm');
                        const numMatch = nameEl?.textContent.match(/[\d,]+/);
                        const val = numMatch ? parseInt(numMatch[0].replace(/,/g, ''), 10) : 0;
                        if (val < threshold) continue;
                    }
                    seenExtend.add(id);
                    toExtend.push({ id, name: label });
                }
            }

            if (toExtend.length > 0) {
                const points = getPlayerPoints();
                const needed = toExtend.length * 10;
                if (points >= needed) {
                    const form = new FormData();
                    toExtend.forEach(p => form.append('selected_perks[]', p.id));
                    form.append('extend_selected', 'Increase Expiration');
                    form.append('bulk_amount', '1');
                    await fetch('/?p=perks&v=con', { method: 'POST', body: form, credentials: 'include' });
                    toExtend.forEach(p => addLiveLog(`QT Perks: ✓ Extended ${p.name} (perk #${p.id}) to 2 deaths`));
                } else {
                    addLiveLog(`QT Perks: not enough points to extend ${toExtend.length} perk(s) — need ${needed}, have ${points}`);
                }
            }
        } catch (e) {
            addLiveLog(`QT Perks: extend check error — ${e.message}`);
        }

        scheduleQTPerkExtend();
    }

    function startQTPerkRedeemer() {
        if (qtPerkRedeemActive) return;
        qtPerkRedeemActive = true;
        doQTPerkRedeem();
    }

    function stopQTPerkRedeemer() {
        qtPerkRedeemActive = false;
        if (qtPerkRedeemTimer) { clearTimeout(qtPerkRedeemTimer); qtPerkRedeemTimer = null; }
    }

    function scheduleQTPerkRedeem() {
        if (!qtPerkRedeemActive) return;
        const intervalMs = state.qtPerkRedeemMins * 60 * 1000;
        const lastRun    = Number(getSetting('qtPerkRedeemLastRun', 0));
        const elapsed    = Date.now() - lastRun;
        const delay      = Math.max(0, intervalMs - elapsed);
        qtPerkRedeemTimer = setTimeout(doQTPerkRedeem, delay);
    }

async function doQTPerkRedeem() {
        if (!qtPerkRedeemActive || !state.enabled || !state.qtPerkRedeemEnabled) {
            scheduleQTPerkRedeem();
            return;
        }
        const intervalMs = state.qtPerkRedeemMins * 60 * 1000;
        const lastRun    = Number(getSetting('qtPerkRedeemLastRun', 0));
        if (Date.now() - lastRun < intervalMs) {
            scheduleQTPerkRedeem();
            return;
        }
        setSetting('qtPerkRedeemLastRun', Date.now());

        try {
            const resp = await fetch('/?p=perks&v=con', { credentials: 'include', cache: 'no-store' });
            const text = await resp.text();
            const doc  = new DOMParser().parseFromString(text, 'text/html');

            const getRows = sel => [...doc.querySelectorAll(`${sel} tr.sortable-row`)];
            const parseAmt = row => {
                const txt = row.querySelector('.lm')?.textContent || '';
                const m = txt.match(/[\d,]+/);
                return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
            };
            const redeemIds = async (ids, label) => {
                if (!ids.length) return;
                const form = new FormData();
                ids.forEach(id => form.append('selected_perks[]', id));
                form.append('redeem_selected', 'Redeem Selected');
                await fetch('/?p=perks&v=con', { method: 'POST', credentials: 'include', body: form });
                addLiveLog(`Redeem: ✓ ${ids.length} ${label} perk(s)`);
            };

            const crimesOn = state.autoMissionsEnabled || state.bgCrimeEnabled;
            const gtaOn    = state.resetGTAEnabled;
            const bustOn   = state.bustNoReload;

            // 1. Money — always redeem all
            if (state.redeemCash) {
                await redeemIds(getRows('table.pm').map(r => r.dataset.id).filter(Boolean), 'Cash');
            }

            // 2. Cars — always redeem all
            if (state.redeemCars) {
                await redeemIds(getRows('table.pc').map(r => r.dataset.id).filter(Boolean), 'Cars');
            }

            // 3. BGs — always redeem all
            if (state.redeemBg) {
                await redeemIds(getRows('table.ppbot').map(r => r.dataset.id).filter(Boolean), 'BGs');
            }

            // 4. Double cash — redeem all if crimes enabled
            if (state.redeemDoubleCash && crimesOn) {
                await redeemIds(getRows('table.pd').map(r => r.dataset.id).filter(Boolean), 'Double cash');
            }

            // 4. Double XP — redeem all if crimes enabled
            if (state.redeemDoubleXp && crimesOn) {
                await redeemIds(getRows('table.px').map(r => r.dataset.id).filter(Boolean), 'Double XP');
            }

            // 5. Always successful — redeem all if crimes or GTA enabled
            // Always successful — confirmed table class: table.pn
            if (state.redeemAlwaysSucc && (crimesOn || gtaOn)) {
                await redeemIds(getRows('table.pn').map(r => r.dataset.id).filter(Boolean), 'Always successful');
            }

            // 6. Always bust — redeem all if bust enabled
            if (state.redeemAlwaysBust && bustOn) {
                await redeemIds(getRows('table.pib').map(r => r.dataset.id).filter(Boolean), 'Always bust');
            }

            // 7. Rare cars + Double melts — coordinated when both on, independent when one on
            if (gtaOn && (state.redeemRare || state.redeemDoubleMelt)) {
                const rareRows  = getRows('table.ps').sort((a, b) => parseAmt(a) - parseAmt(b));
                const meltRows  = getRows('table.pmd').sort((a, b) => parseAmt(a) - parseAmt(b));
                const rareTotal = rareRows.reduce((s, r) => s + parseAmt(r), 0);
                const meltTotal = meltRows.reduce((s, r) => s + parseAmt(r), 0);
                const floor     = state.redeemPairFloor;

                if (state.redeemRare && state.redeemDoubleMelt) {
                    // Both on — balanced pairing
                    if (!rareRows.length || !meltRows.length) {
                        addLiveLog('Redeem: skipping rare/melts — need both in inventory');
                    } else if (rareTotal < floor || meltTotal < floor * 0.9) {
                        addLiveLog(`Redeem: skipping rare/melts — below floor (${rareTotal} rares, ${meltTotal} melts, floor ${floor})`);
                    } else {
                        const target = Math.min(rareTotal, meltTotal);
                        const cap    = Math.floor(target * 1.1);
                        let rareSum = 0, meltSum = 0;
                        const rareIds = [], meltIds = [];
                        for (const row of rareRows) {
                            const amt = parseAmt(row);
                            if (rareSum + amt > cap) break;
                            rareIds.push(row.dataset.id);
                            rareSum += amt;
                        }
                        for (const row of meltRows) {
                            const amt = parseAmt(row);
                            if (meltSum + amt > cap) break;
                            meltIds.push(row.dataset.id);
                            meltSum += amt;
                        }
                        if (rareIds.length) await redeemIds(rareIds, `Rare cars (${rareSum} cars)`);
                        if (meltIds.length) await redeemIds(meltIds, `Double melts (${meltSum} cars)`);
                    }
                } else if (state.redeemRare && rareRows.length) {
                    // Rare only
                    await redeemIds(rareRows.map(r => r.dataset.id).filter(Boolean), `Rare cars (${rareTotal} cars)`);
                } else if (state.redeemDoubleMelt && meltRows.length) {
                    // Melts only
                    await redeemIds(meltRows.map(r => r.dataset.id).filter(Boolean), `Double melts (${meltTotal} cars)`);
                }
            }

            // 8. Bullet value — redeem all if GTA enabled
            if (state.redeemBulletValue && gtaOn) {
                await redeemIds(getRows('table.pcv').map(r => r.dataset.id).filter(Boolean), 'Bullet value');
            }

        } catch (e) {
            addLiveLog(`Redeem: error — ${e.message}`);
        }
        scheduleQTPerkRedeem();
    }


    // =========================================================================
    // BG Spam loop — background fetch POST to kill page every N seconds
    // Only fires for the selected BG Farm player (killBgSpamTarget)
    // Suppresses drug run and bullet factory travel while active
    // =========================================================================
    let bgSpamTimer = null;
    let bgSpamActive = false;

    function updateBgSpamDropdown() {
        if (!killBgSpamTargetEl) return;
        const players = state.killPlayers || [];
        const farmPlayers = players.filter(p =>
            isPlayerBgFarmEnabled(p.name) &&
            p.status !== 'dead'
        );
        const current = state.killBgSpamTarget;

        killBgSpamTargetEl.innerHTML = '';
        if (!farmPlayers.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '— No BG Farm players —';
            killBgSpamTargetEl.appendChild(opt);
            if (current) state.killBgSpamTarget = '';
            return;
        }

        farmPlayers.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            if (p.name.toLowerCase() === current.toLowerCase()) opt.selected = true;
            killBgSpamTargetEl.appendChild(opt);
        });

        // Auto-select first if current is empty or no longer valid
        const valid = farmPlayers.some(p => p.name.toLowerCase() === current.toLowerCase());
        if (!current || !valid) {
            state.killBgSpamTarget = farmPlayers[0].name;
            killBgSpamTargetEl.value = farmPlayers[0].name;
        }
    }

    // After a BG check loop that required travel, return to BG Spam target's country if needed
    async function resumeBgSpamAfterCheck() {
        state.killBgSpamPaused = false;
        state.killLoopActive   = false;
        state.pendingKillAction = null;

        const spamTarget = state.killBgSpamTarget;
        if (spamTarget && state.killBgSpamEnabled && state.killBgCheckEnabled) {
            const spamPlayer = (state.killPlayers || []).find(p => p.name.toLowerCase() === spamTarget.toLowerCase());
            const spamCountry = spamPlayer?.country;
            const myCountry   = (document.querySelector('#player-location')?.textContent || '').trim();
            if (spamCountry && myCountry && spamCountry.toLowerCase() !== myCountry.toLowerCase()) {
                addLiveLog(`Kill loop: BG check done — travelling back to ${spamCountry} for BG Spam on ${spamTarget}`);
                state.pendingKillAction = {
                    stage:    'travel',
                    travelTo: spamCountry,
                    targetName: spamTarget,
                    afterTravel: { stage: 'bg_farm_check', targetName: spamTarget, shootAfterBg: isPlayerShootEnabled(spamTarget) }
                };
                state.killLoopActive = true;
                await wait(navRand());
                gotoPage('cars');
                return;
            }
        }
        await wait(navRand());
        gotoPage('crimes');
    }

    function syncBgSpamState() {
        const shouldRun = state.killBgSpamEnabled &&
                          state.killBgCheckEnabled &&
                          state.killBgSpamTarget &&
                          !state.killBgSpamPaused;
        if (shouldRun && !bgSpamActive) {
            // Check if we're in the spam target's country before starting
            const spamTarget = state.killBgSpamTarget;
            const spamPlayer = (state.killPlayers || []).find(p => p.name.toLowerCase() === spamTarget.toLowerCase());
            const spamCountry = spamPlayer?.country;
            const myCountry = (document.querySelector('#player-location')?.textContent || '').trim();
            if (spamCountry && myCountry && spamCountry.toLowerCase() !== myCountry.toLowerCase() &&
                !state.killLoopActive && !state.pendingKillAction) {
                // Wrong country — trigger travel back before starting spam
                addLiveLog(`BG Spam: not in ${spamCountry} — travelling back before starting spam on ${spamTarget}`);
                state.pendingKillAction = {
                    stage:    'travel',
                    travelTo: spamCountry,
                    targetName: spamTarget,
                    afterTravel: { stage: 'bg_farm_check', targetName: spamTarget, shootAfterBg: isPlayerShootEnabled(spamTarget) }
                };
                state.killLoopActive   = true;
                state.killBgSpamPaused = true;
                return;
            }
            startBgSpam();
        }
        if (!shouldRun && bgSpamActive) stopBgSpam();
    }

    async function autoBuyGun() {
        if (!state.autoBuyGun) return;
        if (getPlayerGunValue() > 0) return;
        if (autoBuyGunBusy) return;
        autoBuyGunBusy = true;
        try {
        const gunVal = getPlayerGunValue();
        const type = state.autoBuyGunType;

        if (type === 'awp') {
            addLiveLog('Auto gun: no gun — checking points for AWP...');
            try {
                const ptsResp = await fetch('/?p=points', { credentials: 'include', cache: 'no-store' });
                const ptsDoc  = new DOMParser().parseFromString(await ptsResp.text(), 'text/html');
                const ptsMatch = [...ptsDoc.querySelectorAll('.bgd.chs')].map(el => el.textContent.match(/[\d,]+/)).find(m => m);
                const pts = ptsMatch ? parseInt(ptsMatch[0].replace(/,/g, ''), 10) : 0;
                const threshold = state.autoBuyGunPtThreshold;
                if (pts - 100 >= threshold) {
                    addLiveLog(`Auto gun: ${pts} points, spending 100 leaves ${pts - 100} ≥ threshold (${threshold}) — buying AWP`);
                    const form = new FormData();
                    form.append('itema', 'Weaponry#1');
                    await fetch('/?p=points', { method: 'POST', credentials: 'include', body: form });
                    addLiveLog('Auto gun: ✓ AWP purchased via points');
                    return;
                } else {
                    addLiveLog(`Auto gun: only ${pts} points or threshold (${threshold}) would be breached — falling back to AK47`);
                }
            } catch(e) { addLiveLog(`Auto gun: error checking points — ${e.message}`); }
        }

        // AK47 — buy in current country, purchase factory first if unowned
        const location  = getPlayerLocation().toLowerCase();
        const countryId = COUNTRY_LOCATION_MAP[location];
        if (!countryId) {
            addLiveLog(`Auto gun: unknown current country "${getPlayerLocation()}" — buy a gun manually.`);
            return;
        }

        addLiveLog(`Auto gun: checking Gun Factory in ${getPlayerLocation()}...`);
        try {
            const weapResp = await fetch(`/?p=weaponry&id=${countryId}`, { credentials: 'include', cache: 'no-store' });
            const weapDoc  = new DOMParser().parseFromString(await weapResp.text(), 'text/html');

            // Check if factory is unowned (has a buy property form)
            const needFactory = !!weapDoc.querySelector('input[name="buy"][value="gun"]');
            const totalNeeded = (needFactory ? 25000000 : 0) + 9000000;
            const cashOnHand  = getPlayerMoney();
            const swiss       = getPlayerSwiss();

            if (cashOnHand + swiss < totalNeeded) {
                addLiveLog(`Auto gun: not enough money (need $${totalNeeded.toLocaleString()}, have $${(cashOnHand + swiss).toLocaleString()}) — buy a gun manually.`);
                return;
            }

            // Withdraw if needed
            if (cashOnHand < totalNeeded) {
                const withdrawAmt = totalNeeded - cashOnHand;
                addLiveLog(`Auto gun: withdrawing $${withdrawAmt.toLocaleString()} from Swiss bank...`);
                const bankForm = new FormData();
                bankForm.append('type', 'swiss');
                bankForm.append('amount', String(withdrawAmt));
                bankForm.append('withdraw', 'Withdraw');
                await fetch('/?p=bank', { method: 'POST', credentials: 'include', body: bankForm });
                await wait(1500);
            }

            if (needFactory) {
                addLiveLog(`Auto gun: no Gun Factory in ${getPlayerLocation()} — buying factory ($25m)...`);
                const bf = new FormData();
                bf.append('buy', 'gun');
                await fetch(`/?p=weaponry&id=${countryId}`, { method: 'POST', credentials: 'include', body: bf });
                await wait(1000);
                addLiveLog('Auto gun: ✓ Gun Factory purchased');
            }

            addLiveLog(`Auto gun: buying AK47 ($9m)...`);
            const gf = new FormData();
            gf.append('gun', '9');
            const gunResp = await fetch(`/?p=weaponry&id=${countryId}`, { method: 'POST', credentials: 'include', body: gf });
            const gunRespText = await gunResp.text();
            const gunRespDoc = new DOMParser().parseFromString(gunRespText, 'text/html');
            const newGun = gunRespDoc.querySelector('#player-gun')?.textContent?.trim() || '';
            if (newGun && newGun.toLowerCase() !== 'none') {
                addLiveLog(`Auto gun: ✓ AK47 purchased`);
            } else {
                addLiveLog(`Auto gun: purchase failed — buy a gun manually`);
            }
        } catch(e) { addLiveLog(`Auto gun: error — ${e.message}`); }
        } finally { autoBuyGunBusy = false; }
    }

    function startBgSpam() {
        if (bgSpamActive) return;
        bgSpamActive = true;
        const pausedUntil = getSetting('killBgSpamPausedUntil', 0);
        if (!pausedUntil || Date.now() >= pausedUntil) {
            addLiveLog(`BG Spam: started — target: ${state.killBgSpamTarget}, interval: ${state.killBgSpamIntervalSecs}s`);
        }
        scheduleBgSpam();
    }

    function stopBgSpam() {
        bgSpamActive = false;
        if (bgSpamTimer) { clearTimeout(bgSpamTimer); bgSpamTimer = null; }
    }

    function scheduleBgSpam() {
        if (!bgSpamActive) return;
        const pausedUntil = getSetting('killBgSpamPausedUntil', 0);
        if (pausedUntil && Date.now() < pausedUntil) {
            const remainMs = pausedUntil - Date.now();
            addLiveLog(`BG Spam: paused — ${Math.ceil(remainMs/60000)}m until ${state.killBgSpamTarget} found`);
            bgSpamTimer = setTimeout(doBgSpam, remainMs);
            return;
        }
        const intervalMs = (state.killBgSpamIntervalSecs || 2) * 1000;
        bgSpamTimer = setTimeout(doBgSpam, intervalMs);
    }

    async function doBgSpam() {
        if (!bgSpamActive || !state.enabled || !state.killBgCheckEnabled || !state.killBgSpamEnabled) {
            scheduleBgSpam();
            return;
        }
        // Don't fire while in jail — can't travel or shoot
        if (isLikelyJailPage()) { scheduleBgSpam(); return; }

        // Respect stored pause time from previous "not yet found" detection
        const pausedUntil = getSetting('killBgSpamPausedUntil', 0);
        if (pausedUntil && Date.now() < pausedUntil) {
            const remainingMs = pausedUntil - Date.now();
            bgSpamTimer = setTimeout(doBgSpam, remainingMs);
            return;
        }
        if (pausedUntil) setSetting('killBgSpamPausedUntil', 0); // clear expired pause

        const target = state.killBgSpamTarget;
        if (!target) { scheduleBgSpam(); return; }

        // Check if target is in Players Found (not just being searched)
        // Fetch kill page to get current search status
        try {
            const killResp = await fetch('/?p=kill', { credentials: 'include', cache: 'no-store' });
            const killText = await killResp.text();
            const killDoc  = new DOMParser().parseFromString(killText, 'text/html');

            // Check if target is in found list (.bgm.chs without .pd)
            const foundEls = [...killDoc.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="p=profile"]')];
            const isFound  = foundEls.some(a => {
                try { return new URL(a.href).searchParams.get('u')?.toLowerCase() === target.toLowerCase(); } catch(_) { return false; }
            });

            if (!isFound) {
                // Check if still being searched (.bgm.chs.pd)
                const pendingEls = [...killDoc.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')];
                const pendingEl  = pendingEls.find(b => b.textContent.trim().toLowerCase() === target.toLowerCase());
                if (pendingEl) {
                    const timerSpan = pendingEl.closest('.bgm.chs.pd')?.querySelector('.chd');
                    const foundInMs = timerSpan ? parseLostInMs(textOf(timerSpan)) : null;
                    if (foundInMs && foundInMs > 0) {
                        const resumeAt = Date.now() + foundInMs + 5000;
                        setSetting('killBgSpamPausedUntil', resumeAt);
                        addLiveLog(`BG Spam: ${target} not yet found (${Math.ceil(foundInMs/60000)}m remaining) — pausing until found`);
                        bgSpamTimer = setTimeout(doBgSpam, foundInMs + 5000);
                        return;
                    }
                }
                // Not found and not pending — unknown state, retry in 30s
                bgSpamTimer = setTimeout(doBgSpam, 30000);
                return;
            }
        } catch(e) {
            // If fetch fails just continue — don't block BG Spam
        }

        // Need at least 1 bullet
        if (getPlayerBullets() < 1) {
            scheduleBgSpam();
            return;
        }

        try {
            const form = new FormData();
            form.append('do', 'kill');
            form.append('username', target);
            form.append('bullets', '1');
            form.append('show', state.killAnonymousShooting ? '' : 'y');

            const resp = await fetch('/?p=kill', {
                method: 'POST',
                credentials: 'include',
                body: form
            });
            const text = await resp.text();
            const doc  = new DOMParser().parseFromString(text, 'text/html');

            const failEl = doc.querySelector('.bgm.fail');
            const credEl = [...doc.querySelectorAll('.bgm.cred')].find(el => /failed to kill/i.test(el.textContent));
            const failText = failEl?.textContent.trim() || '';
            if (failEl && /same location/i.test(failText)) {
                // Target moved country — find new country from Players Found in response
                const foundRows = [...doc.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd)')];
                let newCountry = '';
                for (const row of foundRows) {
                    const a = row.querySelector('a[href*="?p=profile&u="]');
                    if (!a) continue;
                    try {
                        const name = new URL(a.getAttribute('href'), window.location.href).searchParams.get('u');
                        if (name?.toLowerCase() === target.toLowerCase()) {
                            const bTags = [...row.querySelectorAll('b')];
                            newCountry = bTags[1]?.textContent.trim() || '';
                            break;
                        }
                    } catch(_) {}
                }

                if (newCountry) {
                    // Don't interrupt if kill loop is already handling this or another BG Farm player
                    const pa = state.pendingKillAction;
                    const killLoopBusy = pa && (
                        // Busy with a different player's BG
                        (pa.bgFor && pa.bgFor.toLowerCase() !== target.toLowerCase()) ||
                        // Busy travelling/shooting this player's BG
                        (['travel','travel_car','bg_shoot','bg_farm_shoot','bg_farm_result'].includes(pa.stage))
                    );
                    if (killLoopBusy) {
                        addLiveLog(`BG Spam: ${target} moved to ${newCountry} — kill loop busy (${pa.stage}), updating country for later`);
                        const players = state.killPlayers || [];
                        const idx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                        if (idx !== -1) { players[idx].country = newCountry; saveKillPlayers(players); }
                    } else {
                        addLiveLog(`BG Spam: ${target} moved to ${newCountry} — travelling`);
                        const players = state.killPlayers || [];
                        const idx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                        if (idx !== -1) { players[idx].country = newCountry; saveKillPlayers(players); }
                        state.pendingKillAction = {
                            stage:      'travel',
                            travelTo:   newCountry,
                            targetName: target,
                            afterTravel: { stage: 'bg_farm_shoot', targetName: target, shootAfterBg: isPlayerShootEnabled(target) }
                        };
                        state.killLoopActive   = true;
                        state.killBgSpamPaused = true;
                        stopBgSpam();
                        if (!isLikelyJailPage()) gotoPage('cars');
                    }
                } else {
                    addLiveLog(`BG Spam: ${target} not in Players Found — waiting for country update`);
                }

            } else if (failEl && /has a bodyguard called/i.test(failText)) {
                // BG detected — check if it's new/different from what we're already handling
                const bgMatch = failText.match(/has a bodyguard called\s+(.+?)!/i);
                const bgName  = bgMatch ? bgMatch[1].trim() : null;
                if (bgName) {
                    const players = state.killPlayers || [];
                    const targetPlayer = players.find(p => p.name.toLowerCase() === target.toLowerCase());
                    const knownBg = targetPlayer?.bodyguard?.toLowerCase();
                    const farmWaitActive = targetPlayer?.bgFarmWaitUntil && targetPlayer.bgFarmWaitUntil > Date.now();
                    const alreadyHandling = (state.pendingKillAction &&
                        ['bg_farm_check','bg_farm_shoot','bg_farm_result','bg_shoot','fetch_profile'].includes(state.pendingKillAction.stage)) ||
                        (state.killBgWaitUntil > Date.now());
                    const killLoopBusyWithOther = state.pendingKillAction?.bgFor &&
                        state.pendingKillAction.bgFor.toLowerCase() !== target.toLowerCase();
                    const sameBgWaiting = bgName.toLowerCase() === knownBg && farmWaitActive;

                    // BG Spam's 1-bullet result is also a fresh source-of-truth for this original.
                    // Clear every other stale BG relation before storing/handling the current BG.
                    clearStaleBgRelationsForOwner(target, bgName, `BG Spam fresh check found ${bgName}`);

                    // Update bodyguard reference immediately so UI reflects current state
                    if (bgName.toLowerCase() !== knownBg) {
                        const tIdx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                        if (tIdx !== -1) {
                            const oldBg = players[tIdx].bodyguard;
                            // Clear any stale pending shoot targeting the old BG
                            if (oldBg && oldBg.toLowerCase() !== bgName.toLowerCase()) {
                                addLiveLog(`BG Spam: ${target} swapped BG from ${oldBg} to ${bgName} — clearing stale shoot`);
                                if (state.killBgShootPending?.bgFor?.toLowerCase() === target.toLowerCase() &&
                                    state.killBgShootPending?.targetName?.toLowerCase() === oldBg.toLowerCase()) {
                                    state.killBgShootPending = null;
                                }
                                if (state.pendingKillAction?.bgFor?.toLowerCase() === target.toLowerCase() &&
                                    state.pendingKillAction?.targetName?.toLowerCase() === oldBg.toLowerCase()) {
                                    state.pendingKillAction = null;
                                    state.killLoopActive    = false;
                                }
                                const oldBgIdx = players.findIndex(p => p.name.toLowerCase() === oldBg.toLowerCase());
                                if (oldBgIdx !== -1) {
                                    delete players[oldBgIdx].bgShootQueued;
                                    delete players[oldBgIdx].isBg;
                                    delete players[oldBgIdx].bgFor;
                                }
                                delete players[tIdx].bgFarmWaitUntil;
                                state.killBgWaitUntil = 0;
                            }
                            players[tIdx].bodyguard = bgName;
                            players[tIdx].lastBgCheck = now();
                            saveKillPlayers(players); renderKillList();
                        }
                    }

                    // If new BG detected, add to kill list as UNKNOWN so kill scanner searches them
                    if (bgName.toLowerCase() !== knownBg) {
                        const pl   = state.killPlayers || [];
                        const bIdx = pl.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());
                        if (bIdx === -1) {
                            pl.push({ name: bgName, status: KILL_STATUS.UNKNOWN, isBg: true, bgFor: target });
                            saveKillPlayers(pl);
                            state.killSearchLoopActive = true;
                            state.killBgWaitUntil = 0;
                            addLiveLog(`BG Spam: added ${bgName} as unknown — kill scanner will search them`);
                        } else if (pl[bIdx].status !== KILL_STATUS.ALIVE) {
                            pl[bIdx].isBg  = true;
                            pl[bIdx].bgFor = target;
                            pl[bIdx].status = KILL_STATUS.UNKNOWN;
                            saveKillPlayers(pl);
                            state.killSearchLoopActive = true;
                            state.killBgWaitUntil = 0;
                            addLiveLog(`BG Spam: reset ${bgName} to unknown — kill scanner will search them`);
                        }
                    }
                    // If the same BG is still being searched, keep waiting. If the BG changed,
                    // ignore the old wait and hand off so the stale BG kill/search is replaced.
                    if (sameBgWaiting) {
                        // silently wait
                    } else if ((bgName.toLowerCase() !== knownBg || !alreadyHandling) && !killLoopBusyWithOther) {
                        // New or different BG — hand off to kill loop
                        addLiveLog(`BG Spam: ${target} has ${knownBg && bgName.toLowerCase() !== knownBg ? 'new ' : ''}BG ${bgName} — triggering kill loop`);
                        // Don't override the kill loop cooldown — it means the loop just determined there's nothing to do
                        if (state.killLoopCooldownUntil > now()) {
                            addLiveLog(`BG Spam: kill loop on cooldown for ${Math.ceil((state.killLoopCooldownUntil - now()) / 1000)}s — waiting`);
                        } else {
                        state.pendingKillAction = {
                            stage:        'bg_farm_check',
                            targetName:   target,
                            shootAfterBg: isPlayerShootEnabled(target),
                        };
                        state.killLoopActive  = true;
                        state.killBgSpamPaused = true;
                        stopBgSpam();
                        if (!isLikelyJailPage()) gotoPage('kill');
                        }
                    }
                    // else already handling this BG or kill loop busy with another player — keep spamming silently
                }

            } else if (credEl) {
                // No BG — target unprotected. BG Spam's 1-bullet result is fresh source-of-truth,
                // so clear every stored/deferred BG relation for this original immediately.
                clearStaleBgRelationsForOwner(target, null, 'BG Spam fresh check found no BG');
                if (isPlayerShootEnabled(target)) {
                    addLiveLog(`BG Spam: ${target} has no BG — Kill enabled, handing off to kill loop`);
                    state.pendingKillAction = { stage: 'fetch_profile', targetName: target };
                    state.killLoopActive = true;
                    stopBgSpam();
                    await wait(navRand());
                    gotoPage('kill');
                    return;
                } else {
                    addLiveLog(`BG Spam: ${target} has no BG — stopping spam to avoid detection`);
                    stopBgSpam();
                    state.killBgSpamEnabled = false;
                    if (killBgSpamInput) killBgSpamInput.checked = false;
                    return;
                }
            }
        } catch(e) {
            addLiveLog(`BG Spam: error — ${e.message}`);
        }

        scheduleBgSpam();
    }

            function startQTSniper() {
        if (qtSniperActive) return;
        qtSniperActive = true;
        scheduleQTSniperPoll();
    }

    function stopQTSniper() {
        qtSniperActive = false;
        if (qtSniperTimer) { clearTimeout(qtSniperTimer); qtSniperTimer = null; }
    }

    function scheduleQTSniperPoll() {
        if (!qtSniperActive) return;
        qtSniperTimer = setTimeout(doQTSniperPoll, rand(state.qtPollMin, state.qtPollMax));
    }

    async function doQTSniperPoll() {
        if (!qtSniperActive || !state.enabled || !state.qtPerksEnabled || crimePaused || (!state.bgCrimeEnabled && (isCrimesPage() || hasCrimePageMarkers()))) { scheduleQTSniperPoll(); return; }
        if (!state.qtBgEnabled && !state.qtBulletsEnabled && !state.qtPointsEnabled &&
            !state.qtBustEnabled && !state.qtAlwaysSuccEnabled && !state.qtDoubleMeltsEnabled && !state.qtDoubleXpEnabled &&
            !state.qtDoubleCashEnabled && !state.qtRareEnabled && !state.qtBulletValueEnabled) { scheduleQTSniperPoll(); return; }
        if (hasCTCChallenge()) { scheduleQTSniperPoll(); return; }
        if (actionInFlight) { scheduleQTSniperPoll(); return; }

        try {
            qtSniperAbortController = new AbortController();
            const resp = await fetch('/?p=qt&a=perks', { credentials: 'include', cache: 'no-store', signal: qtSniperAbortController.signal });
            const text = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');

            let anyBought = false;

            // ── Bodyguards (Personal + Robot) ────────────────────────────────
            if (state.qtBgEnabled) {
                const bgTables = [...doc.querySelectorAll('table.ppbot, table.pbot')];
                for (const table of bgTables) {
                    const rows = [...table.querySelectorAll('tr')].filter(r => r.querySelector('input[type="radio"]'));
                    for (const row of rows) {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 2) continue;
                        const priceText = cells[1] ? cells[1].textContent.trim() : '';
                        const priceMatch = priceText.match(/[\d,]+/);
                        if (!priceMatch) continue;
                        const price = parseInt(priceMatch[0].replace(/,/g, ''), 10);
                        if (price > state.qtBgThreshold) continue;
                        // Check points balance
                        const points = getPlayerPoints();
                        if (points < price) {
                            addLiveLog(`QT Sniper: BG costs ${price} points but only have ${points} — skipping`);
                            continue;
                        }
                        const radio = row.querySelector('input[type="radio"]');
                        if (!radio) continue;
                        const form = new FormData();
                        form.append('perk', radio.value);
                        const buyResp = await fetch('/?p=qt&a=perks', { method: 'POST', body: form, credentials: 'include' });
                        const buyText = await buyResp.text();
                        if (/purchased|success|bought|thank/i.test(buyText) || !buyText.includes('error')) {
                            addLiveLog(`QT Sniper: ✓ Bought BG for ${price} points`);
                            anyBought = true;
                        } else {
                            addLiveLog(`QT Sniper: BG buy failed for ${price} points`);
                        }
                    }
                }
            }

            // ── Bullets ───────────────────────────────────────────────────────
            if (state.qtBulletsEnabled) {
                const bulletTable = doc.querySelector('table.pb');
                if (bulletTable) {
                    const rows = [...bulletTable.querySelectorAll('tr')].filter(r => r.querySelector('input[type="radio"]'));

                    // Collect all eligible listings first
                    const eligible = [];
                    for (const row of rows) {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 2) continue;
                        const bulletMatch = cells[0].textContent.match(/[\d,]+/);
                        if (!bulletMatch) continue;
                        const bulletCount = parseInt(bulletMatch[0].replace(/,/g, ''), 10);
                        const priceMatch = cells[1].textContent.match(/[\d,]+/);
                        if (!priceMatch) continue;
                        const totalPrice = parseInt(priceMatch[0].replace(/,/g, ''), 10);
                        const pricePerBullet = totalPrice / bulletCount;
                        if (pricePerBullet > state.qtBulletsThreshold) {
                            continue;
                        }
                        if (state.qtBulletsMin > 0 && bulletCount < state.qtBulletsMin) {
                            continue;
                        }
                        addLiveLog(`QT Sniper: bullet listing found — ${bulletCount.toLocaleString()} bullets @ $${Math.round(pricePerBullet).toLocaleString()}/bullet (threshold: $${state.qtBulletsThreshold.toLocaleString()})`);
                        const radio = row.querySelector('input[type="radio"]');
                        if (!radio) continue;
                        eligible.push({ bulletCount, totalPrice, pricePerBullet, radio });
                    }

                    if (eligible.length > 0) {
                        // Check total wealth once
                        const totalNeeded = eligible.reduce((sum, e) => sum + e.totalPrice, 0);
                        const cash  = getPlayerMoney();
                        const swiss = getPlayerSwiss();
                        if (cash + swiss < totalNeeded) {
                            addLiveLog(`QT Sniper: insufficient funds for bullet purchases — skipping`);
                        } else {
                            // Single withdraw if needed, then buy all, then single deposit
                            let didWithdraw = false;
                            if (cash < totalNeeded) {
                                try {
                                    const wResp = await fetch(`/a/quickbank.php?type=withdraw&_=${Date.now()}`, { credentials: 'include' });
                                    await wResp.text();
                                    didWithdraw = true;
                                    await wait(150);
                                } catch (e) {
                                    addLiveLog(`QT Sniper: withdraw failed — ${e.message}`);
                                }
                            }
                            try {
                                for (const e of eligible) {
                                    const form = new FormData();
                                    form.append('perk', e.radio.value);
                                    const buyResp = await fetch('/?p=qt&a=perks', { method: 'POST', body: form, credentials: 'include' });
                                    const buyText = await buyResp.text();
                                    if (buyText && e.bulletCount > 0) {
                                        addLiveLog(`QT Sniper: ✓ Bought ${e.bulletCount.toLocaleString()} bullets for $${e.totalPrice.toLocaleString()} ($${e.pricePerBullet.toLocaleString()}/bullet)`);
                                        anyBought = true;
                                    } else {
                                        addLiveLog(`QT Sniper: bullet buy failed`);
                                    }
                                }
                            } finally {
                                // Always deposit after buying — even if withdraw failed, cash may have been used
                                await qtSafeDeposit();
                            }
                        }
                    }
                }
            }

            // ── Points ───────────────────────────────────────────────────────
            if (state.qtPointsEnabled) {
                const qtResp = await fetch('/?p=qt', { credentials: 'include', cache: 'no-store' });
                const qtText = await qtResp.text();
                const qtDoc = parser.parseFromString(qtText, 'text/html');

                // Only target the "Points for sale" form — has buy=points hidden input
                const pointsForm = [...qtDoc.querySelectorAll('form')].find(f =>
                    f.querySelector('input[name="buy"][value="points"]')
                );
                if (pointsForm) {
                    const rows = [...pointsForm.querySelectorAll('tr')].filter(r => r.querySelector('input[name="id"]'));

                    // Collect all eligible listings first
                    const eligible = [];
                    for (const row of rows) {
                        const idInput = row.querySelector('input[name="id"]');
                        if (!idInput) continue;
                        const id = idInput.value;
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 4) continue;
                        const pointsText = cells[1].textContent.trim();
                        if (pointsText.startsWith('$')) continue;
                        const pointsCount = parseInt(pointsText.replace(/,/g, ''), 10);
                        const totalPrice = parseInt(cells[2].textContent.replace(/[^0-9]/g, ''), 10);
                        const perPoint = parseInt(cells[3].textContent.replace(/[^0-9]/g, ''), 10);
                        if (isNaN(pointsCount) || isNaN(totalPrice) || isNaN(perPoint)) continue;
                        if (perPoint > state.qtPointsThreshold) continue;
                        eligible.push({ id, pointsCount, totalPrice, perPoint });
                    }

                    if (eligible.length > 0) {
                        const totalNeeded = eligible.reduce((sum, e) => sum + e.totalPrice, 0);
                        const cash  = getPlayerMoney();
                        const swiss = getPlayerSwiss();
                        if (cash + swiss < totalNeeded) {
                            addLiveLog(`QT Sniper: insufficient funds for points purchases — skipping`);
                        } else {
                            // Always withdraw first and deposit after — ensures money
                            // never sits exposed on hand after points purchases
                            let didWithdraw = false;
                            try {
                                const wResp = await fetch(`/a/quickbank.php?type=withdraw&_=${Date.now()}`, { credentials: 'include' });
                                await wResp.text();
                                didWithdraw = true;
                                await wait(150);
                            } catch (we) {
                                addLiveLog(`QT Sniper: withdraw failed — ${we.message}`);
                            }
                            try {
                                for (const e of eligible) {
                                    const buyForm = new FormData();
                                    buyForm.append('buy', 'points');
                                    buyForm.append('id', e.id);
                                    const buyResp = await fetch('/?p=qt', { method: 'POST', body: buyForm, credentials: 'include' });
                                    await buyResp.text();
                                    addLiveLog(`QT Sniper: ✓ Bought ${e.pointsCount.toLocaleString()} points for $${e.totalPrice.toLocaleString()} ($${e.perPoint.toLocaleString()}/point)`);
                                    anyBought = true;
                                }
                            } finally {
                                if (didWithdraw) {
                                    await qtSafeDeposit();
                                }
                            }
                        }
                    }
                }
            }

            // ── Generic points-priced perk buyer ─────────────────────────────
            // Handles: Bust (pib), Double Melts (pmd), Double XP (px),
            //          Double Cash (pd), Rare Cars (ps)
            const pointsPerkChecks = [
                {
                    enabled: state.qtBustEnabled, sel: 'table.pib', label: 'Bust',
                    maxPts: state.qtBustMaxPts, minAmt: state.qtBustMinMins, unit: 'mins',
                },
                {
                    enabled: state.qtAlwaysSuccEnabled, sel: 'table.pn', label: 'Always Successful',
                    maxPts: state.qtAlwaysSuccMaxPts, minAmt: state.qtAlwaysSuccMinMins, unit: 'mins',
                },
                {
                    enabled: state.qtDoubleMeltsEnabled, sel: 'table.pmd', label: 'Double Melts',
                    maxPts: state.qtDoubleMeltsMaxPts, minAmt: state.qtDoubleMeltsMinCars, unit: 'cars',
                },
                {
                    enabled: state.qtDoubleXpEnabled, sel: 'table.px', label: 'Double XP',
                    maxPts: state.qtDoubleXpMaxPts, minAmt: state.qtDoubleXpMinMins, unit: 'mins',
                },
                {
                    enabled: state.qtDoubleCashEnabled, sel: 'table.pd', label: 'Double Cash',
                    maxPts: state.qtDoubleCashMaxPts, minAmt: state.qtDoubleCashMinMins, unit: 'mins',
                },
                {
                    enabled: state.qtRareEnabled, sel: 'table.ps', label: 'Rare Cars',
                    maxPts: state.qtRareMaxPts, minAmt: state.qtRareMinCars, unit: 'cars',
                },
                {
                    enabled: state.qtBulletValueEnabled, sel: 'table.pcv', label: 'Bullet Value',
                    maxPts: state.qtBulletValueMaxPts, minAmt: state.qtBulletValueMinCars, unit: 'cars',
                },
            ];
            for (const { enabled, sel, label, maxPts, minAmt, unit } of pointsPerkChecks) {
                if (!enabled) continue;
                const table = doc.querySelector(sel);
                if (!table) continue;
                const rows = [...table.querySelectorAll('tr')].filter(r => r.querySelector('input[type="radio"]'));
                for (const row of rows) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 3) continue;
                    // Parse amount (e.g. "56 mins" or "100 cars")
                    const amtMatch = cells[0].textContent.match(/[\d,]+/);
                    if (!amtMatch) continue;
                    const amt = parseInt(amtMatch[0].replace(/,/g, ''), 10);
                    if (minAmt > 0 && amt < minAmt) continue;
                    // Parse price in points (e.g. "62 points")
                    const ptsMatch = cells[1].textContent.match(/[\d,]+/);
                    if (!ptsMatch) continue;
                    const pts = parseInt(ptsMatch[0].replace(/,/g, ''), 10);
                    // Check per-unit price (pts per car/min)
                    const ptsPerUnit = amt > 0 ? pts / amt : pts;
                    if (ptsPerUnit > maxPts) {
                        addLiveLog(`QT Sniper: ${label} ${amt} ${unit} skipped — ${ptsPerUnit.toFixed(2)} pts/${unit.replace('s','')} exceeds max ${maxPts}`);
                        continue;
                    }
                    // Check points balance
                    const playerPts = getPlayerPoints();
                    if (playerPts < pts) {
                        addLiveLog(`QT Sniper: ${label} ${amt} ${unit} costs ${pts} pts but only have ${playerPts} — skipping`);
                        continue;
                    }
                    const radio = row.querySelector('input[type="radio"]');
                    if (!radio) continue;
                    const form = new FormData();
                    form.append('perk', radio.value);
                    const buyResp = await fetch('/?p=qt&a=perks', { method: 'POST', body: form, credentials: 'include' });
                    const buyText = await buyResp.text();
                    if (buyText && !buyText.includes('error')) {
                        addLiveLog(`QT Sniper: ✓ Bought ${label} ${amt} ${unit} for ${pts} pts`);
                        anyBought = true;
                    } else {
                        addLiveLog(`QT Sniper: ${label} buy failed (${pts} pts)`);
                    }
                }
            }

            // ── Perk expiry extension ─────────────────────────────────────────
            // After all purchases, fetch ?p=perks once and extend any BG or
            // bullet perks (5000+ bullets) with expiry of 1 death
            if (anyBought) {
                const perksResp = await fetch('/?p=perks', { credentials: 'include', cache: 'no-store' });
                const perksText = await perksResp.text();
                const perksDoc = parser.parseFromString(perksText, 'text/html');
                const toExtend = [];

                // Check bullet perks — only extend if 5000+ bullets and expiry = 1
                const bulletRows = [...perksDoc.querySelectorAll('table.pb tr.sortable-row')];
                for (const row of bulletRows) {
                    const id = row.dataset.id;
                    const nameEl = row.querySelector('.lm');
                    const cells = row.querySelectorAll('td');
                    const expiryEl = cells[2];
                    if (!id || !nameEl || !expiryEl) continue;
                    const bulletMatch = nameEl.textContent.match(/[\d,]+/);
                    const bulletCount = bulletMatch ? parseInt(bulletMatch[0].replace(/,/g, ''), 10) : 0;
                    const expiry = parseInt(expiryEl.textContent.trim(), 10);
                    if (expiry === 1 && bulletCount >= 5000) toExtend.push({ id, name: `${bulletCount.toLocaleString()} bullets` });
                }

                // Check BG perks (personal + robot) — always extend if expiry = 1
                const bgPerkRows = [...perksDoc.querySelectorAll('table.ppbot tr.sortable-row, table.pbot tr.sortable-row')];
                for (const row of bgPerkRows) {
                    const id = row.dataset.id;
                    const nameEl = row.querySelector('.lm');
                    const cells = row.querySelectorAll('td');
                    const expiryEl = cells[2];
                    if (!id || !nameEl || !expiryEl) continue;
                    const expiry = parseInt(expiryEl.textContent.trim(), 10);
                    if (expiry === 1) toExtend.push({ id, name: nameEl.textContent.trim() });
                }

                if (toExtend.length > 0) {
                    const points = getPlayerPoints();
                    if (points >= toExtend.length * 10) {
                        await Promise.all(toExtend.map(async p => {
                            const form = new FormData();
                            form.append('exin', '1');
                            await fetch(`/?p=perks&id=${p.id}`, { method: 'POST', body: form, credentials: 'include' });
                            addLiveLog(`QT Sniper: ✓ Extended ${p.name} (perk #${p.id}) to 2 deaths`);
                        }));
                    } else {
                        addLiveLog(`QT Sniper: not enough points to extend ${toExtend.length} perk(s) — need ${toExtend.length * 10}, have ${points}`);
                    }
                }
            }

        } catch (e) {
            qtSniperConsecutiveErrors++;
            if (qtSniperConsecutiveErrors === 1 || qtSniperConsecutiveErrors % 10 === 0) {
                addLiveLog(`QT Sniper: error — ${e.message}${qtSniperConsecutiveErrors > 1 ? ` (x${qtSniperConsecutiveErrors})` : ''}`);
            }
        } finally {
            scheduleQTSniperPoll();
        }
    }

    // ── QT Car Scanner ───────────────────────────────────────────────────────
    let qtCarScanTimer  = null;
    let qtCarScanActive = false;

    function startQTCarScanner() {
        if (qtCarScanActive) return;
        qtCarScanActive = true;
        scheduleQTCarScan();
    }

    function stopQTCarScanner() {
        qtCarScanActive = false;
        if (qtCarScanTimer) { clearTimeout(qtCarScanTimer); qtCarScanTimer = null; }
    }

    function scheduleQTCarScan() {
        if (!qtCarScanActive) return;
        const intervalMs = state.qtCarsScanInterval * 1000;
        qtCarScanTimer = setTimeout(doQTCarScan, intervalMs);
    }

    async function doQTCarScan() {
        if (!qtCarScanActive || !state.enabled || !state.qtCarsEnabled || crimePaused || (!state.bgCrimeEnabled && (isCrimesPage() || hasCrimePageMarkers()))) { scheduleQTCarScan(); return; }
        if (hasCTCChallenge()) { scheduleQTCarScan(); return; }
        if (actionInFlight) { scheduleQTCarScan(); return; }

        const carTypes = state.qtCarsTypes || DEFAULTS.qtCarsTypes;
        const enabled  = carTypes.filter(t => t.enabled);
        if (!enabled.length) { scheduleQTCarScan(); return; }

        try {
            const parser = new DOMParser();
            let totalSpent = 0;
            let didWithdraw = false;

            for (const carType of enabled) {
                // Fetch this car type's QT page
                const resp = await fetch(`/?p=qt&a=cars&b=${carType.b}`, { credentials: 'include', cache: 'no-store' });
                const text = await resp.text();
                const doc  = parser.parseFromString(text, 'text/html');

                // Find all cars in the table under the max price
                const rows = [...doc.querySelectorAll('table.rdt tr')].filter(r => r.querySelector('input[type="checkbox"]'));
                const eligible = [];

                for (const row of rows) {
                    const checkbox = row.querySelector('input[type="checkbox"]');
                    if (!checkbox) continue;
                    const carId = Object.keys(Object.fromEntries([...checkbox.name.matchAll(/id\[(\d+)\]/g)].map(m => [m[1], true])))[0]
                        || checkbox.name.match(/id\[(\d+)\]/)?.[1];
                    if (!carId) continue;
                    const price = parseInt(checkbox.value, 10);
                    if (isNaN(price) || price > carType.maxPrice) continue;
                    // Get car name for logging
                    const nameEl = row.querySelector('th a');
                    const carName = nameEl ? nameEl.textContent.trim() : `Car #${carId}`;
                    eligible.push({ carId, price, carName });
                }

                if (!eligible.length) {
                    continue;
                }

                // Check we have enough funds
                const totalNeeded = eligible.reduce((s, e) => s + e.price, 0);
                const cash  = getPlayerMoney();
                const swiss = getPlayerSwiss();

                if (cash + swiss < totalNeeded) {
                    addLiveLog(`QT Cars: insufficient funds for ${carType.name} — need $${totalNeeded.toLocaleString()}, have $${(cash + swiss).toLocaleString()}`);
                    continue;
                }

                // Quick withdraw if needed
                if (!didWithdraw && cash < totalNeeded) {
                    try {
                        const wResp = await fetch(`/a/quickbank.php?type=withdraw&_=${Date.now()}`, { credentials: 'include' });
                        await wResp.text();
                        didWithdraw = true;
                        await wait(200);
                    } catch (e) {
                        addLiveLog(`QT Cars: withdraw failed — ${e.message}`);
                        continue;
                    }
                }

                // Buy all eligible cars in one bulk request
                try {
                    // Step 1: POST all car IDs at once to get confirmation page
                    const buyForm = new FormData();
                    eligible.forEach(car => buyForm.append(`id[${car.carId}]`, String(car.price)));
                    buyForm.append('buy', 'Buy');
                    const buyResp = await fetch(`/?p=qt&a=cars&b=${carType.b}`, {
                        method: 'POST',
                        body: buyForm,
                        credentials: 'include'
                    });
                    const buyText = await buyResp.text();
                    const buyDoc  = parser.parseFromString(buyText, 'text/html');

                    const confirmBtn = buyDoc.querySelector('input[name="confirm"]');
                    if (!confirmBtn) {
                        addLiveLog(`QT Cars: no confirm button for ${carType.name} — cars may have sold already`);
                    } else {
                        // Step 2: POST confirmation with all IDs from the confirmation page
                        const confirmForm = new FormData();
                        [...buyDoc.querySelectorAll('input[name^="id["]')].forEach(f => confirmForm.append(f.name, f.value));
                        confirmForm.append('buy', 'Buy');
                        confirmForm.append('confirm', 'Confirm');
                        const confirmResp = await fetch(`/?p=qt&a=cars&b=${carType.b}`, {
                            method: 'POST',
                            body: confirmForm,
                            credentials: 'include'
                        });
                        const confirmText = await confirmResp.text();

                        if (/successfully|bought/i.test(confirmText)) {
                            const spent = eligible.reduce((s, c) => s + c.price, 0);
                            addLiveLog(`QT Cars: ✓ Bought ${eligible.length}x ${carType.name} for $${spent.toLocaleString()} total`);
                            totalSpent += spent;
                        } else {
                            addLiveLog(`QT Cars: bulk buy failed for ${carType.name} — may have sold`);
                        }
                    }
                } catch (e) {
                    addLiveLog(`QT Cars: error buying ${carType.name} — ${e.message}`);
                }
            }

            // Quick deposit after all purchases if we withdrew
            if (didWithdraw || totalSpent > 0) {
                try {
                    await fetch(`/a/quickbank.php?type=deposit&_=${Date.now()}`, { credentials: 'include' });
                } catch (_) {}
            }
        } catch (e) {
            addLiveLog(`QT Cars: scan error — ${e.message}`);
        }

        scheduleQTCarScan();
    }
    let bgCrimeTimer  = null;
    let bgCrimeActive = false;
    let bgCrimeToken  = null;
    let bgCrimeCooldowns = {};
    let bgCrimeNextPageFetchAt = 0;
    let bgCrimeFetchBackoffMs  = 5000;
    let bgCrimeJailPauseUntil  = 0;
    let bgCrimeJailPauseLogged = false;

    const BG_CRIME_READY_POLL_MS       = 250;
    const BG_CRIME_IDLE_POLL_MS        = 5000;
    const BG_CRIME_FETCH_BACKOFF_MIN   = 5000;
    const BG_CRIME_FETCH_BACKOFF_MAX   = 60000;
    const BG_CRIME_JAIL_FALLBACK_MS    = 30000;

    function getBgCrimeIds() {
        const gangText = (document.querySelector('#player-gang')?.textContent || '').trim().toLowerCase();
        const inGang = !!gangText && gangText !== 'none';
        return inGang ? ['gang', '7', '6', '5', '4', '3', 'drug', '2', '1'] : ['7', '6', '5', '4', '3', 'drug', '2', '1'];
    }

    function getBgCrimeDefaultCooldownMs(id) {
        return BG_CRIME_DEFAULT_COOLDOWNS_MS[id] || BG_CRIME_FETCH_BACKOFF_MIN;
    }

    function setBgCrimeCooldown(id, baseTimeMs = Date.now(), serverSeconds = null) {
        const parsedSecs = serverSeconds == null ? null : parseInt(serverSeconds, 10);
        if (parsedSecs !== null && Number.isFinite(parsedSecs)) {
            bgCrimeCooldowns[id] = parsedSecs <= 0 ? 0 : baseTimeMs + (parsedSecs * 1000);
            return;
        }
        bgCrimeCooldowns[id] = baseTimeMs + getBgCrimeDefaultCooldownMs(id);
    }

    function getActiveBgCrimeIds() {
        const ids = getBgCrimeIds();
        const enabled = ids.filter(id => state.enabledActions.includes(id));
        return enabled.length > 0 ? enabled : ids;
    }

    function getBgCrimeJailDelayMs(doc = document) {
        const jailNode = doc.querySelector?.('#jailn');
        const jailText = jailNode ? textOf(jailNode) : '';
        const parsed = jailText ? parseDurationTextToMs(jailText) : null;
        if (parsed && Number.isFinite(parsed) && parsed > 0) return parsed + 5000;

        if (doc === document) {
            const ownTimer = getOwnJailTimerMs();
            if (ownTimer && Number.isFinite(ownTimer) && ownTimer > 0) return ownTimer + 5000;

            if (state.jailReleasesAt && state.jailReleasesAt > Date.now()) {
                return Math.max(5000, state.jailReleasesAt - Date.now() + 5000);
            }
        }

        return BG_CRIME_JAIL_FALLBACK_MS;
    }

    function noteBgCrimeJailPause(doc = document) {
        bgCrimeToken = null;
        bgCrimeJailPauseUntil = Date.now() + getBgCrimeJailDelayMs(doc);
        if (!bgCrimeJailPauseLogged) {
            addLiveLog('BG Crime: jailed — pausing background crime page fetches');
            bgCrimeJailPauseLogged = true;
        }
    }

    function resetBgCrimeFetchBackoff() {
        bgCrimeFetchBackoffMs = BG_CRIME_FETCH_BACKOFF_MIN;
        bgCrimeNextPageFetchAt = 0;
    }

    function bumpBgCrimeFetchBackoff() {
        bgCrimeNextPageFetchAt = Date.now() + bgCrimeFetchBackoffMs;
        bgCrimeFetchBackoffMs = Math.min(BG_CRIME_FETCH_BACKOFF_MAX, Math.round(bgCrimeFetchBackoffMs * 1.5));
    }

    function getBgCrimeScheduleDelayMs() {
        const nowMs = Date.now();

        if (bgCrimeJailPauseUntil > nowMs) {
            return Math.max(1000, bgCrimeJailPauseUntil - nowMs);
        }

        if (isLikelyJailPage()) {
            noteBgCrimeJailPause(document);
            return Math.max(1000, bgCrimeJailPauseUntil - Date.now());
        }

        bgCrimeJailPauseLogged = false;

        const activeIds = getActiveBgCrimeIds();
        if (!activeIds.length) return BG_CRIME_IDLE_POLL_MS;

        const known = activeIds.filter(id => bgCrimeCooldowns[id] !== undefined);
        const dueKnown = known.filter(id => (bgCrimeCooldowns[id] || 0) <= nowMs);
        const futureTimes = known
            .map(id => bgCrimeCooldowns[id])
            .filter(t => t && t > nowMs)
            .sort((a, b) => a - b);

        if (!bgCrimeToken) {
            // No token + known future timers means there is nothing useful to fetch yet.
            if (known.length > 0 && dueKnown.length === 0) {
                return futureTimes[0] ? Math.max(1000, futureTimes[0] - nowMs) : BG_CRIME_IDLE_POLL_MS;
            }

            // Initial token load or token refresh for a due crime. Respect backoff.
            if (bgCrimeNextPageFetchAt > nowMs) {
                return Math.max(1000, bgCrimeNextPageFetchAt - nowMs);
            }
            return BG_CRIME_READY_POLL_MS;
        }

        // With a token, unknown cooldowns are allowed only for first-time startup;
        // after a crimes-page parse, active ids are given explicit cooldowns.
        const due = activeIds.some(id => (bgCrimeCooldowns[id] ?? 0) <= nowMs);
        if (due) return BG_CRIME_READY_POLL_MS;

        return futureTimes[0] ? Math.max(1000, futureTimes[0] - nowMs) : BG_CRIME_IDLE_POLL_MS;
    }

    function startBgCrime() {
        if (bgCrimeActive) return;
        bgCrimeActive = true;
        scheduleBgCrimePoll();
    }

    function stopBgCrime() {
        bgCrimeActive = false;
        if (bgCrimeTimer) { clearTimeout(bgCrimeTimer); bgCrimeTimer = null; }
        bgCrimeToken = null;
        bgCrimeCooldowns = {};
        bgCrimeNextPageFetchAt = 0;
        bgCrimeFetchBackoffMs = BG_CRIME_FETCH_BACKOFF_MIN;
        bgCrimeJailPauseUntil = 0;
        bgCrimeJailPauseLogged = false;
    }

    function scheduleBgCrimePoll() {
        if (bgCrimeTimer) { clearTimeout(bgCrimeTimer); bgCrimeTimer = null; }
        if (!bgCrimeActive) return;
        bgCrimeTimer = setTimeout(doBgCrimePoll, getBgCrimeScheduleDelayMs());
    }

    async function doBgCrimePoll() {
        if (!bgCrimeActive || !state.bgCrimeEnabled || !state.enabled || crimePaused) { scheduleBgCrimePoll(); return; }
        if (hasCTCChallenge()) { scheduleBgCrimePoll(); return; }

        if (isLikelyJailPage()) {
            noteBgCrimeJailPause(document);
            scheduleBgCrimePoll();
            return;
        }

        if (bgCrimeJailPauseUntil > Date.now()) { scheduleBgCrimePoll(); return; }
        bgCrimeJailPauseLogged = false;

        const activeIds = getActiveBgCrimeIds();
        if (!activeIds.length) { scheduleBgCrimePoll(); return; }

        try {
            const nowMs = Date.now();
            const known = activeIds.filter(id => bgCrimeCooldowns[id] !== undefined);
            const dueKnown = known.filter(id => (bgCrimeCooldowns[id] || 0) <= nowMs);

            // Only refresh /?p=crimes when we actually need a token for a due crime.
            // If all enabled crimes have future cooldowns, do not poll the page just because the token is missing.
            if (!bgCrimeToken) {
                if (known.length > 0 && dueKnown.length === 0) {
                    scheduleBgCrimePoll();
                    return;
                }

                if (bgCrimeNextPageFetchAt > nowMs) {
                    scheduleBgCrimePoll();
                    return;
                }

                const pageResp = await fetch('/?p=crimes', { credentials: 'include', cache: 'no-store' });
                const pageText = await pageResp.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(pageText, 'text/html');

                // Check for jail. Do not repeatedly poll the crimes page while jailed.
                if (doc.querySelector('#jailn') || pageText.includes('jailn')) {
                    noteBgCrimeJailPause(doc);
                    scheduleBgCrimePoll();
                    return;
                }

                // Get token
                const scripts = [...doc.querySelectorAll('script')];
                const crimeScript = scripts.find(s => s.textContent.includes('unluckykidda'));
                const token = crimeScript?.textContent.match(/var unluckykidda\s*=\s*["']([a-f0-9]+)["']/)?.[1];
                if (!token) {
                    bumpBgCrimeFetchBackoff();
                    scheduleBgCrimePoll();
                    return;
                }

                bgCrimeToken = token;
                resetBgCrimeFetchBackoff();

                // Get initial cooldowns — convert relative seconds to absolute timestamps.
                // The page is still useful for the first token/state load, but after that
                // successful crime responses use fixed per-crime cooldown defaults when
                // the response does not include an explicit timing update.
                const pageTimerBase = Date.now();
                const timingMatches = [...(crimeScript?.textContent.matchAll(/timing\["([^"]+)"\]\s*=\s*"?(-?\d+)"?/g) || [])];
                timingMatches.forEach(m => setBgCrimeCooldown(m[1], pageTimerBase, m[2]));

                // If the page omitted an enabled crime timer, make a single normal attempt.
                // Once it succeeds, fixed cooldowns keep it timer-driven without page polling.
                activeIds.forEach(id => {
                    if (bgCrimeCooldowns[id] === undefined) bgCrimeCooldowns[id] = 0;
                });
            }

            // Commit all currently due enabled crimes using cached cooldowns.
            const commitNow = Date.now();
            const available = activeIds.filter(id => (bgCrimeCooldowns[id] ?? 0) <= commitNow);
            for (const id of available) {
                if (!bgCrimeToken) break;
                if (!bgCrimeActive || !state.bgCrimeEnabled) break;

                const resp = await fetch(`/a/crime.php?id=${id}&noob=${bgCrimeToken}&unlucky=${rand(4,196)}&kidda=${rand(4,18)}&_=${Date.now()}`, {
                    credentials: 'include'
                });
                const text = await resp.text();

                // Check for CTC in response
                if (/match the letters|captcha/i.test(text)) {
                    scheduleBgCrimePoll();
                    return;
                }

                if (/#jailn|jail/i.test(text) && !/jailbroken|jail break/i.test(text)) {
                    bgCrimeToken = null;
                    bgCrimeJailPauseUntil = Date.now() + BG_CRIME_JAIL_FALLBACK_MS;
                    if (!bgCrimeJailPauseLogged) {
                        addLiveLog('BG Crime: jailed after crime — pausing background crime page fetches');
                        bgCrimeJailPauseLogged = true;
                    }
                    scheduleBgCrimePoll();
                    return;
                }

                const newToken = text.match(/var unluckykidda\s*=\s*["']([a-f0-9]+)["']/)?.[1];
                const result = text.match(/^([^<\n]+)/)?.[1]?.trim();

                if (newToken) {
                    bgCrimeToken = newToken;
                    resetBgCrimeFetchBackoff();
                    // Update cooldown as absolute timestamp. If the AJAX response does
                    // not include a fresh timer, fall back to the known fixed cooldown for
                    // this exact crime instead of using a short retry/backoff delay.
                    const timingMatch = text.match(new RegExp(`timing\\["${id}"\\]\\s*=\\s*"?(-?\\d+)"?`));
                    setBgCrimeCooldown(id, Date.now(), timingMatch ? timingMatch[1] : null);
                    addLiveLog(`BG Crime: ${result || 'committed crime ' + id}`);
                } else {
                    // Token rejected or response was incomplete. Do not instantly refetch /?p=crimes.
                    bgCrimeToken = null;
                    bgCrimeCooldowns[id] = Date.now() + BG_CRIME_FETCH_BACKOFF_MIN;
                    bumpBgCrimeFetchBackoff();
                    break;
                }
                await wait(150);
            }
        } catch (e) {
            addLiveLog(`BG Crime: error — ${e.message}`);
            bgCrimeToken = null; // clear token, but respect fetch backoff before refreshing the crimes page
            bumpBgCrimeFetchBackoff();
        }
        scheduleBgCrimePoll();
    }

    // ── Bullet Factory System ─────────────────────────────────────────────────
    // Checks the Global Owners page every 30 minutes (on the half-hour).
    // Finds countries with bullet factories that have 300+ bullets, withdraws
    // cash and travels to each to buy all available stock.

    const BULLET_FACTORY_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    const BULLET_FACTORY_MIN_STOCK         = 300;
    const BULLET_FACTORY_COST_PER_BULLET   = 10000; // safe upper bound

    // Returns the timestamp of the most recent half-hour boundary (e.g. 12:30, 13:00)
    // with a 30-second grace period to allow the server to restock
    function lastHalfHourBoundary() {
        const now = Date.now();
        const interval = BULLET_FACTORY_CHECK_INTERVAL_MS; // 30 min in ms
        const boundary = Math.floor(now / interval) * interval;
        const gracePeriod = 5 * 1000; // 5 seconds
        // Only consider this boundary "passed" if we're at least 30s past it
        return (now - boundary >= gracePeriod) ? boundary : boundary - interval;
    }

    function isBgSpamBlockingBulletFactory() {
        // BG Spam should pause Bullet Factory, not permanently consume the half-hour check.
        // If spam is only paused while waiting for a BG search result, allow Bullet Factory to run.
        const bgSpamPausedUntil = getSetting('killBgSpamPausedUntil', 0);
        const bgSpamPausedByTimer = bgSpamPausedUntil > Date.now();
        return state.killBgSpamEnabled && state.killBgSpamTarget && state.killBgCheckEnabled && !bgSpamPausedByTimer;
    }

    function isBulletFactoryCheckDue() {
        if (!state.bulletFactoryEnabled) return false;
        if (state.pendingBulletRun) return false;
        // BG Spam pauses Bullet Factory without marking the current half-hour as checked.
        // This means if BG Spam is unticked, Bullet Factory can immediately catch up.
        if (isBgSpamBlockingBulletFactory()) return false;
        // Fire if we haven't run since the most recent half-hour boundary
        // This means: fire immediately on enable, fire again whenever a new
        // boundary passes (1:00, 1:30, 2:00 etc.), and catch up if missed
        return state.lastBulletFactoryCheck < lastHalfHourBoundary();
    }

    function killLoopHasImmediateWorkForBulletFactory() {
        // A pending kill/BG action means the kill loop is actively doing work
        // rather than merely waiting on a long BG search timer. Pause Bullet
        // Factory routing so it cannot steal the page flow or shared drive.
        if (!state.killLoopActive) return false;
        if (state.pendingKillAction) return true;
        // If we are already on a kill/penalty page while the kill loop is active,
        // let that page finish deciding before Bullet Factory takes over.
        if (isKillPage() || isKillPenaltyPage()) return true;
        return false;
    }

    let lastBulletFactoryPauseLogKey = '';
    let lastBulletFactoryPauseLogAt  = 0;

    function addBulletFactoryPauseLog(key, message) {
        const t = Date.now();
        if (key !== lastBulletFactoryPauseLogKey || t - lastBulletFactoryPauseLogAt > 30000) {
            lastBulletFactoryPauseLogKey = key;
            lastBulletFactoryPauseLogAt  = t;
            addLiveLog(message);
        }
    }

    const BULLET_FACTORY_NAV_RETRY_MS = 8000;

    function isBulletFactoryNavRecentlyIssued(run, navKey) {
        const issuedAt = Number(run?.navIssuedAt || 0);
        return run?.navKey === navKey && issuedAt > 0 && (now() - issuedAt) < BULLET_FACTORY_NAV_RETRY_MS;
    }

    function markBulletFactoryNavIssued(run, navKey) {
        state.pendingBulletRun = {
            ...run,
            navKey,
            navIssuedAt: now()
        };
    }

    function clearBulletFactoryNavMarker(run) {
        if (!run || (!run.navKey && !run.navIssuedAt)) return run;
        const cleaned = { ...run };
        delete cleaned.navKey;
        delete cleaned.navIssuedAt;
        return cleaned;
    }

    function escapeRegExp(str) {
        return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function hasBulletFactoryDriveSuccessMessage(country) {
        if (!country) return false;
        const re = new RegExp(`\\bYou\\s+drove\\s+to\\s+${escapeRegExp(country)}!?`, 'i');
        return [...document.querySelectorAll('.bgm.cg, .bgm.success, .bgm')]
            .some(el => re.test(textOf(el)));
    }

    function isBulletFactoryDriveConfirmed(target) {
        if (!target?.country) return false;
        if (hasBulletFactoryDriveSuccessMessage(target.country)) return true;
        const playerCountry = getPlayerLocation();
        return !!playerCountry && playerCountry.toLowerCase() === target.country.toLowerCase();
    }

    // Fetches the Global Owners page and returns countries with 300+ bullet stock
    // sorted by stock descending (most bullets first)
    async function fetchBulletFactoryStocks() {
        try {
            const resp = await fetch('/?p=property', { credentials: 'include', cache: 'no-store' });
            const text = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');

            // Find the Bullet Factory row in the Criminal Properties table
            const rows = [...doc.querySelectorAll('table.rdt tr')];
            const bfRow = rows.find(r => /bullet factory/i.test(r.querySelector('th')?.textContent || ''));
            if (!bfRow) return [];

            const cells = [...bfRow.querySelectorAll('td')];
            const countries = ['England', 'Mexico', 'Russia', 'South Africa', 'USA'];
            const results = [];

            cells.forEach((cell, i) => {
                const country = countries[i];
                if (!country) return;
                const stockEl = cell.querySelector('.cg');
                if (!stockEl) return;
                const match = stockEl.textContent.match(/([\d,]+)\s*bullet/i);
                if (!match) return;
                const stock = parseInt(match[1].replace(/,/g, ''), 10);
                if (stock >= BULLET_FACTORY_MIN_STOCK) {
                    results.push({ country, stock, countryId: i + 1 });
                }
            });

            // Sort: current country first (no drive needed), then by stock descending
            const playerCountry = getPlayerLocation().toLowerCase();
            results.sort((a, b) => {
                const aHome = a.country.toLowerCase() === playerCountry;
                const bHome = b.country.toLowerCase() === playerCountry;
                if (aHome && !bHome) return -1;
                if (bHome && !aHome) return 1;
                return b.stock - a.stock;
            });
            return results;
        } catch (e) {
            addLiveLog(`Bullet factory: error fetching property page — ${e.message}`);
            return [];
        }
    }

    // Starts a bullet factory run — checks stock and sets up pending run state
    async function startBulletFactoryRun() {
        // Defensive guard: BG Spam pauses Bullet Factory, but does not mark the
        // current half-hour boundary as checked. When spam is unticked, BF catches up.
        if (isBgSpamBlockingBulletFactory()) return;
        addLiveLog('Bullet factory: checking Global Owners page for stock...');
        // Record the current boundary as checked — next trigger will be the NEXT boundary
        state.lastBulletFactoryCheck = lastHalfHourBoundary();

        const stocks = await fetchBulletFactoryStocks();
        if (!stocks.length) {
            addLiveLog('Bullet factory: no countries have 300+ bullets — skipping');
            return;
        }

        const totalBullets = stocks.reduce((sum, s) => sum + s.stock, 0);
        const withdrawAmount = totalBullets * BULLET_FACTORY_COST_PER_BULLET;

        // If we already have enough cash on hand, skip the bank withdraw entirely
        const cashOnHand = getPlayerMoney();
        if (cashOnHand >= withdrawAmount) {
            addLiveLog(`Bullet factory: found ${totalBullets} bullets across ${stocks.length} countries — enough cash on hand, skipping withdraw`);
            state.pendingBulletRun = { targets: stocks, withdrawAmount, stage: 'travel' };
            return;
        }

        addLiveLog(`Bullet factory: found ${totalBullets} bullets across ${stocks.length} countries — withdrawing $${withdrawAmount.toLocaleString()}`);

        // Store the pending run
        state.pendingBulletRun = {
            targets: stocks,
            withdrawAmount,
            stage: 'withdraw'
        };
    }

    // Returns the weaponry page URL for a given country ID
    function getBulletFactoryUrl(countryId) {
        return `/?p=weaponry&show=bullet&id=${countryId}`;
    }




    // =========================================================================
    // CRIMES
    // =========================================================================

    function getCrimeButtonById(id) {
        return document.querySelector(`input.crime[data="${String(id)}"]`);
    }

    function getCrimeName(id) {
        return CRIME_NAME_BY_ID[id] || `Crime ${id}`;
    }

    function isCrimeAvailable(id) {
        const btn     = getCrimeButtonById(id);
        const wrapper = document.querySelector(`#bcrime${String(id)}`);
        return !!btn && !!wrapper && visible(wrapper) && !btn.disabled;
    }

    function isCrimeLocked(id) {
        return isLockedByRank(id);
    }

    function getCrimeState(id) {
        if (isCrimeAvailable(id)) return 'available';
        if (isCrimeLocked(id))    return 'locked';

        const btn     = getCrimeButtonById(id);
        const wrapper = document.querySelector(`#bcrime${String(id)}`);
        if (btn || wrapper) return 'cooldown';

        return 'missing';
    }

    function getAvailableCrimes() {
        const enabled = state.enabledActions;
        return DEFAULT_ORDER.filter(id =>
            enabled.includes(id) &&
            !isCrimeLocked(id) &&
            isCrimeAvailable(id)
        );
    }

    function wasSameCrimeClickedTooRecently(id) {
        return lastCrimeClick.id === id && (now() - lastCrimeClick.at) < SAFETY.sameCrimeMinGapMs;
    }

    async function waitForCrimeStateChange(id, token) {
        const start        = now();
        const initialState = getCrimeState(id);
        // Pause QT sniper during settle window so its fetches don't interfere
        // with the crime AJAX response
        crimePaused = true;
        const showmessi = document.querySelector('#showmessi');
        if (showmessi) showmessi.textContent = '';

        try {
            while (now() - start < SAFETY.postClickSettleMs) {
                if (!isRunValid(token)) return 'cancelled';
                if (isLikelyJailPage()) return 'jail';
                if (hasCTCChallenge())  return 'ctc';

                const currentState = getCrimeState(id);
                if (initialState === 'available' && currentState !== 'available') return 'changed';
                if (!isCrimesPage() && !hasCrimePageMarkers()) return 'changed';
                if (showmessi && showmessi.textContent.trim().length > 0) return 'changed';

                await wait(SAFETY.postClickPollMs);
            }

            return 'timeout';
        } finally {
            crimePaused = false;
            // Reschedule all background loops that were cancelled during the crime window
            if (qtSniperActive)     scheduleQTSniperPoll();
            if (qtPerkExtendActive) scheduleQTPerkExtend();
            if (qtCarScanActive)    scheduleQTCarScan();
            if (bgCrimeActive)      scheduleBgCrimePoll();
            if (noReloadBustActive) scheduleNoReloadBustPoll();
        }
    }

    // Reads the unluckykidda token from the current crimes page script tag
    function getCrimeToken() {
        const scripts = [...document.querySelectorAll('script')];
        const crimeScript = scripts.find(s => s.textContent.includes('unluckykidda'));
        return crimeScript?.textContent.match(/var unluckykidda\s*=\s*["']([a-f0-9]+)["']/)?.[1] || null;
    }

    async function clickCrimeById(id, token, useBurstDelay = false) {
        if (!isRunValid(token)) return false;
        if (actionInFlight)     return false;

        if (wasSameCrimeClickedTooRecently(id)) {
            addLiveLog(`Blocked rapid repeat click: ${getCrimeName(id)}`);
            return false;
        }

        const btn = getCrimeButtonById(id);
        if (!btn || btn.disabled) return false;

        actionInFlight = true;

        try {
            await wait(rand(
                useBurstDelay ? DEFAULTS.burstDelayMin : DEFAULTS.actionDelayMin,
                useBurstDelay ? DEFAULTS.burstDelayMax : DEFAULTS.actionDelayMax
            ));

            if (!isRunValid(token)) return false;

            const freshBtn = getCrimeButtonById(id);
            if (!freshBtn || freshBtn.disabled) return false;

            state.lastActionAt = now();
            lastCrimeClick     = { id, at: now() };
            humanClick(freshBtn);

            return true;
        } finally {
            actionInFlight = false;
        }
    }

    async function commitCrimeBurst() {
        const token = ++runToken;
        let actions       = 0;
        let timeoutsInRow = 0;

        while (actions < Math.min(DEFAULTS.maxBurstActions, SAFETY.maxBurstActionsReal)) {
            if (!isRunValid(token)) break;

            const available = getAvailableCrimes();
            if (!available.length) break;

            const chosen     = available[0];
            const chosenName = getCrimeName(chosen);

            if (wasSameCrimeClickedTooRecently(chosen)) {
                addLiveLog(`Safety hold on ${chosenName}; waiting for page to catch up`);
                break;
            }

            const clicked = await clickCrimeById(chosen, token, actions > 0);
            if (!clicked) break;

            actions++;

            updateStats(s => {
                s.crimes        += 1;
                s.lastActionText = `Crime: ${chosenName}`;
            });
            addLiveLog(`Crime committed: ${chosenName}`);

            const outcome = await waitForCrimeStateChange(chosen, token);

            if (outcome === 'cancelled') break;

            if (outcome === 'ctc') {
                addLiveLog('CTC appeared mid-burst — pausing burst, solver will handle it');
                break;
            }

            if (outcome === 'jail') {
                updateStats(s => {
                    s.jails         += 1;
                    s.lastActionText = `Jailed after ${chosenName}`;
                });
                addLiveLog(`Jailed after crime: ${chosenName}`);
                return actions;
            }

            if (outcome === 'timeout') {
                timeoutsInRow += 1;
                addLiveLog(`No page response after ${chosenName}; backing off`);
                if (timeoutsInRow >= 1) {
                    scheduleReload(rand(SAFETY.loopBackoffReloadMin, SAFETY.loopBackoffReloadMax));
                    break;
                }
            } else {
                timeoutsInRow = 0;
            }

            await wait(rand(250, 500));
        }

        return actions;
    }

    // Fast mode crime burst — commits all available crimes with minimal delay.
    // Used exclusively during crime timer reset mode where all crimes become
    // available simultaneously and human-pace delays are unnecessary.
    // CTC challenges still interrupt and are solved normally.
    async function commitCrimeBurstFast() {
        const token = ++runToken;
        let actions = 0;

        while (true) {
            if (!isRunValid(token)) break;
            if (hasCTCChallenge()) {
                addLiveLog('CTC appeared during fast burst — pausing to solve');
                break;
            }
            if (isLikelyJailPage()) {
                addLiveLog('Jailed during fast burst');
                break;
            }

            const available = getAvailableCrimes();
            if (!available.length) break;

            // Click each available crime with a minimal delay just to let
            // the browser process the previous click before the next one.
            for (const id of available) {
                if (!isRunValid(token)) break;
                if (hasCTCChallenge()) break;
                if (isLikelyJailPage()) break;

                const btn = getCrimeButtonById(id);
                if (!btn || btn.disabled) continue;

                state.lastActionAt = now();
                lastCrimeClick     = { id, at: now() };
                humanClick(btn);
                actions++;

                updateStats(s => {
                    s.crimes        += 1;
                    s.lastActionText = `Fast crime: ${getCrimeName(id)}`;
                });

                // Minimal delay — just enough for the page to register the click
                await wait(rand(60, 120));
            }

            // Brief pause to allow the page to update crime availability
            await wait(rand(150, 250));
        }

        return actions;
    }

    function soonestCrimeTimerMs() {
        const timers = [...document.querySelectorAll('.chd[id^="crimetime-"]')];
        let smallest = Infinity;

        for (const el of timers) {
            const val = Number(el.getAttribute('data-timer'));
            if (!Number.isNaN(val) && val > 0) smallest = Math.min(smallest, val * 1000);
        }

        return Number.isFinite(smallest) ? smallest : null;
    }

    // =========================================================================
    // GTA
    // =========================================================================

    function getGTAStealButton() {
        return document.querySelector('form input[type="submit"][value="Steal"]');
    }

    async function doGTA() {
        const btn = getGTAStealButton();
        if (!btn || btn.disabled) return false;

        state.lastActionAt = now();
        markGTACooldownStarted();
        humanClick(btn);
        addLiveLog('GTA attempted');

        return true;
    }

    // =========================================================================
    // MELT
    // =========================================================================

    function hasMeltPageMarkers() {
        return !!document.querySelector('form input[type="submit"][name="melt"][value="Melt"]') &&
               !!document.querySelector('table.wo');
    }

    function getMeltSubmitButton() {
        return document.querySelector('form input[type="submit"][name="melt"][value="Melt"]');
    }

    function normalizeCarName(name) {
        return String(name || '').replace(/\s+/g, ' ').trim();
    }

    function isProtectedMeltName(name) {
        const lower = normalizeCarName(name).toLowerCase();
        return MELT_PROTECTED_NAME_PARTS.some(part => lower.includes(part));
    }

    function getMeltCandidates() {
        const rows       = [...document.querySelectorAll('table.wo tr')];
        const candidates = [];

        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 4) continue;

            const link  = cells[0].querySelector('a[href*="?p=car&id="]');
            const radio = cells[3].querySelector('input[type="radio"][name="id"]');
            if (!link || !radio) continue;

            const rawCarText      = textOf(link);
            const idMatch         = rawCarText.match(/#(\d+)/);
            const id              = idMatch ? idMatch[1] : String(radio.value || '');
            const name            = normalizeCarName(rawCarText.replace(/^#\d+\s*/, ''));
            const damage          = parsePercent(cells[1].textContent || '');
            const bulletValue     = parseBulletValue(cells[2].textContent || '');
            const protectedByName = isProtectedMeltName(name);

            candidates.push({ id, name, damage, bulletValue, radio, row, protectedByName });
        }

        return candidates;
    }

    function getMeltPaginationInfo() {
        const page     = currentPageNum();
        const nextLink = [...document.querySelectorAll('a[href*="?p=melt&page="]')].find(a => /next page/i.test(textOf(a))) || null;

        let nextPage = null;
        if (nextLink) {
            try {
                const href = new URL(nextLink.getAttribute('href'), window.location.href);
                nextPage = Number(href.searchParams.get('page')) || null;
            } catch (_) {
                const m = (nextLink.getAttribute('href') || '').match(/[?&]page=(\d+)/);
                nextPage = m ? Number(m[1]) : null;
            }
        }

        return { page, hasNext: !!nextPage, nextPage };
    }

    function getMeltSuccessBullets() {
        const td = [...document.querySelectorAll('table.wo tr td[colspan="4"]')]
            .find(td => /car melted,\s*you received\s*\d+\s*bullets/i.test(textOf(td))) || null;
        if (!td) return null;
        const match = textOf(td).match(/car melted,\s*you received\s*(\d+)\s*bullets/i);
        return match ? Number(match[1]) : null;
    }

    function protectMeltRows() {
        const candidates = getMeltCandidates();
        for (const c of candidates) {
            if (!c.protectedByName) continue;

            c.radio.disabled = true;
            c.radio.checked  = false;
            c.row.classList.add('ug-melt-protected-row');

            if (!c.row.querySelector('.ug-melt-protected-tag')) {
                const tag = document.createElement('span');
                tag.className   = 'ug-melt-protected-tag';
                tag.textContent = 'PROTECTED';

                const targetCell = c.row.cells[0];
                if (targetCell) targetCell.appendChild(tag);
            }

            c.row.title = 'Protected car — melting disabled';
        }
    }

    function chooseBestMeltCandidate() {
        const candidates = getMeltCandidates();
        const safe       = candidates.filter(c => !c.protectedByName && !c.radio.disabled);

        if (!safe.length) return null;

        safe.sort((a, b) => {
            if (b.bulletValue !== a.bulletValue) return b.bulletValue - a.bulletValue;
            if (b.damage      !== a.damage)      return b.damage      - a.damage;
            return Number(a.id) - Number(b.id);
        });

        return safe[0];
    }

    function resetMeltSearchState() {
        state.meltRecoveryCount = 0;
    }

    async function doMelt() {
        const candidate = chooseBestMeltCandidate();
        const submitBtn = getMeltSubmitButton();

        if (!candidate || !submitBtn) return false;

        candidate.radio.checked = true;
        state.lastActionAt      = now();

        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshSubmit = getMeltSubmitButton();
        const freshRadio  = document.querySelector(`input[type="radio"][name="id"][value="${candidate.id}"]`);
        if (!freshSubmit || !freshRadio || freshRadio.disabled) return false;

        freshRadio.checked       = true;
        state.pendingMeltBullets = candidate.bulletValue;
        state.pendingMeltCarText = `${candidate.name} #${candidate.id}`;
        humanClick(freshSubmit);
        markMeltCooldownStarted();
        resetMeltSearchState();

        addLiveLog(`Melt submitted: ${candidate.name} #${candidate.id} (${candidate.damage}% dmg, expected ${candidate.bulletValue} bullets)`);

        return true;
    }

    // =========================================================================
    // CARS (BULK REPAIR)
    // =========================================================================

    function hasCarsPageMarkers() {
        return !!document.querySelector('form input[type="submit"][name="repair"][value="Repair"]') &&
               !![...document.querySelectorAll('a')].find(a => /select all/i.test(textOf(a)));
    }

    function getCarsRepairButton() {
        return document.querySelector('form input[type="submit"][name="repair"][value="Repair"]');
    }

    function getCarsSelectAllLink() {
        return [...document.querySelectorAll('a')].find(a => /select all/i.test(textOf(a))) || null;
    }

    function getCarsCheckboxes() {
        return [...document.querySelectorAll('input[type="checkbox"][name="id[]"]')];
    }

    function getDamagedCarsCount() {
        const rows = [...document.querySelectorAll('table.rdt.wo tr, table.wo tr')];
        let count  = 0;

        for (const row of rows) {
            const text = textOf(row).toLowerCase();
            if (!text.includes('repair cost')) continue;
            if (/no damage/i.test(text)) continue;
            if (/\d+% damage/i.test(text) || /\$\d/.test(text)) count++;
        }

        return count;
    }

    async function doRepairCycle() {
        const selectAllLink = getCarsSelectAllLink();
        const repairBtn     = getCarsRepairButton();
        const checkboxes    = getCarsCheckboxes();

        if (!selectAllLink || !repairBtn || !checkboxes.length) return false;

        const damagedCount = getDamagedCarsCount();
        if (damagedCount <= 0) {
            addLiveLog('Repair cycle skipped — no damaged cars found on page');
            state.meltsSinceRepair = 0;
            return true;
        }

        await wait(SAFETY.repairAfterLoadMs);

        const freshSelectAll = getCarsSelectAllLink();
        if (!freshSelectAll) return false;

        humanClick(freshSelectAll);
        addLiveLog('Cars: Select All clicked');

        await wait(SAFETY.repairAfterSelectAllMs);

        const checkedNow  = getCarsCheckboxes().filter(cb => cb.checked);
        const freshRepair = getCarsRepairButton();
        if (!freshRepair || !checkedNow.length) {
            addLiveLog('Repair cycle failed — no cars selected after Select All');
            return false;
        }

        state.lastActionAt = now();
        humanClick(freshRepair);

        updateStats(s => {
            s.repairs       += 1;
            s.lastActionText = `Repair cycle (${checkedNow.length} selected)`;
        });
        addLiveLog(`Repair clicked (${checkedNow.length} selected, ${damagedCount} damaged rows detected)`);

        state.meltsSinceRepair = 0;

        await wait(SAFETY.repairAfterSubmitMs);
        return true;
    }

    // =========================================================================
    // JAIL
    // =========================================================================

    // Returns the Leave Jail (1 Point) button if present on the page.
    function getLeaveJailButton() {
        return [...document.querySelectorAll('input[type="submit"]')]
            .find(btn => /leave jail/i.test(btn.value)) || null;
    }

    // Attempts to click Leave Jail (1 Point). Returns true if clicked.
    async function tryLeaveJail() {
        if (!state.leaveJailEnabled) return false;

        const points = getPlayerPoints();
        const minPts = state.leaveJailMinPoints;

        if (points < minPts) {
            addLiveLog(`Leave Jail skipped — only ${points} points (minimum: ${minPts})`);
            return false;
        }

        const btn = getLeaveJailButton();
        if (!btn) return false;

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshBtn = getLeaveJailButton();
        if (!freshBtn) return false;

        humanClick(freshBtn);

        updateStats(s => {
            s.jailEscapes   += 1;
            s.lastActionText = `Left jail using 1 point (had ${points})`;
        });
        addLiveLog(`Left jail using 1 point — had ${points} points (minimum: ${minPts})`);

        return true;
    }

    function getOwnJailRow() {
        const rows = [...document.querySelectorAll('#jailn tr')];
        return rows.find(row => {
            const leaveBtn = row.querySelector('input[type="submit"]');
            return leaveBtn && /Leave Jail/i.test(leaveBtn.value || '');
        }) || null;
    }

    function getOwnJailTimerMs() {
        const row = getOwnJailRow();
        if (!row) return null;

        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;

        const timerText = textOf(cells[1]);
        if (!timerText) return null;

        const secMatch = timerText.match(/(\d+)\s*seconds?/i);
        if (secMatch) return parseInt(secMatch[1], 10) * 1000;

        return parseDurationTextToMs(timerText);
    }

    function isLikelyJailPage() {
        // The jail page uses ?p=crimes&page=1 as its URL, not ?p=jail
        // So we can't rely on currentPage() === 'jail' alone
        if (currentPage() === 'jail') return true;
        // Detect jail via #jailn element — but exclude plain crimes page
        // (no page param) which doesn't have #jailn
        if (document.querySelector('#jailn')) {
            // Extra check: jail page has a Set Reward form pointing to ?p=jail
            if (document.querySelector('form[action*="p=jail"]')) return true;
            // Or has the page=1 parameter (jail URL pattern)
            const pageParam = new URL(window.location.href).searchParams.get('page');
            if (pageParam === '1') return true;
        }
        return false;
    }

    function hasCrimePageMarkers() {
        return !!document.querySelector('#crimebox') || !!document.querySelector('input.crime');
    }

    function hasGTAPageMarkers() {
        return !!getGTAStealButton() || /last 5 cars stolen/i.test(textOf(document.body));
    }

    function hasDrugsPageMarkers() {
        const th = document.querySelector('table.wo th.myc');
        return !!th && /drugs/i.test(textOf(th));
    }

    function stopJailObserver() {
        if (jailObserver) {
            jailObserver.disconnect();
            jailObserver = null;
        }
        jailPassiveMode = false;
        jailHadOwnRow   = false;
    }

    function startJailObserver() {
        if (jailObserver) return;

        const jailNode = document.querySelector('#jailn');
        if (!jailNode) return;

        jailObserver = new MutationObserver(async () => {
            if (!state.enabled) return;
            if (!isLikelyJailPage()) return;

            const ownRow   = getOwnJailRow();
            const jailMs   = getOwnJailTimerMs();
            const jailText = textOf(jailNode);

            updatePanel();

            if (ownRow) {
                jailHadOwnRow = true;
                if (await maybeLeaveJailAfterReleaseFallback('Jail timer elapsed/frozen while observer was active')) return;
                updateJailReleaseEstimate(jailMs, 'observer');
                return;
            }

            if (jailHadOwnRow || /the jail is empty!/i.test(jailText)) {
                clearJailReleaseTracking();
                stopJailObserver();
                clearScheduledReload();
                await wait(rand(500, 1200));
                // Return to the correct page based on which loop is active
                if (state.gtaResetLoopActive) {
                    addLiveLog('Own jail row gone — returning to GTA (loop active)');
                    gotoPage('gta');
                } else if (state.meltResetLoopActive) {
                    addLiveLog('Own jail row gone — returning to melt (loop active)');
                    gotoCleanMeltPage(1);
                } else {
                    addLiveLog('Own jail row gone, returning to Crimes');
                    gotoPage('crimes');
                }
            }
        });

        jailObserver.observe(jailNode, { childList: true, subtree: true, characterData: true });
        addLiveLog('Jail observer started');
    }

    function clearJailReleaseTracking() {
        state.jailReleasesAt = 0;
        state.jailLastTimerMs = 0;
        state.jailLastTimerSeenAt = 0;
    }

    function updateJailReleaseEstimate(jailMs, reason = 'jail') {
        if (jailMs == null || !Number.isFinite(jailMs) || jailMs <= 0) return;

        const t = now();
        const proposed = t + jailMs + 65000; // 65s buffer covers minute-rounded jail timers
        const prevRelease = state.jailReleasesAt;
        const prevTimerMs = state.jailLastTimerMs;

        const noPreviousDeadline = !prevRelease || prevRelease <= 0;
        const timerMovedEarlier = prevRelease > 0 && proposed < prevRelease - 5000;
        const timerActuallyIncreased = prevTimerMs > 0 && jailMs > prevTimerMs + 15000;

        // Important: never keep pushing the release deadline forward just because
        // a stale/frozen jail timer still says the same value. That was the
        // multi-hour jail stall: now()+staleTimer kept becoming a later deadline.
        if (noPreviousDeadline || timerMovedEarlier || timerActuallyIncreased) {
            state.jailReleasesAt = proposed;
            if (!noPreviousDeadline && timerActuallyIncreased) {
                addLiveLog(`Jail timer extended — updated release fallback (${Math.ceil(jailMs / 60000)}m)`);
            }
        }

        state.jailLastTimerMs = jailMs;
        state.jailLastTimerSeenAt = t;
    }

    async function leaveJailAfterReleaseFallback(reason) {
        addLiveLog(`${reason} — leaving jail page`);
        clearJailReleaseTracking();
        stopJailObserver();
        clearScheduledReload();
        await wait(rand(500, 1200));
        if (state.gtaResetLoopActive) {
            gotoPage('gta');
        } else if (state.meltResetLoopActive) {
            gotoCleanMeltPage(1);
        } else {
            gotoPage('crimes');
        }
    }

    async function maybeLeaveJailAfterReleaseFallback(reason) {
        if (state.jailReleasesAt > 0 && now() >= state.jailReleasesAt) {
            await leaveJailAfterReleaseFallback(reason);
            return true;
        }
        return false;
    }

    async function handleJailState() {
        clearScheduledReload();
        jailPassiveMode = true;

        const jailNode = document.querySelector('#jailn');
        const ownRow   = getOwnJailRow();

        if (jailNode) startJailObserver();

        if (ownRow) {
            if (!jailHadOwnRow) addLiveLog('Confirmed own jail row');
            jailHadOwnRow = true;

            // If the fallback deadline is already past, do this BEFORE reading
            // the current timer text. A Cloudflare/stale DOM can show the same
            // old timer forever; reading it first would move the deadline again.
            if (await maybeLeaveJailAfterReleaseFallback('Jail timer elapsed/frozen during jail check')) return;

            // Store a stable release deadline. Do not extend it unless the timer
            // genuinely increases, otherwise a frozen timer creates a moving goalpost.
            const jailMs = getOwnJailTimerMs();
            updateJailReleaseEstimate(jailMs, 'handle');

            // If Leave Jail toggle is on and we have enough points, use it immediately
            if (state.leaveJailEnabled) {
                const didLeave = await tryLeaveJail();
                if (didLeave) {
                    clearJailReleaseTracking();
                    stopJailObserver();
                    clearScheduledReload();
                    await wait(rand(800, 1500));
                    // Return to the correct page based on which loop is active
                    if (state.gtaResetLoopActive) {
                        addLiveLog('GTA reset loop: returning to GTA after jail');
                        gotoPage('gta');
                    } else if (state.meltResetLoopActive) {
                        addLiveLog('Melt reset loop: returning to melt after jail');
                        gotoCleanMeltPage(1);
                    } else {
                        gotoPage('crimes');
                    }
                    return;
                }
                // Not enough points — fall through to normal wait behaviour
            }

            return;
        }

        clearJailReleaseTracking();
        stopJailObserver();
        clearScheduledReload();
        await wait(rand(500, 1200));
        // Return to the correct page based on which loop is active
        if (state.gtaResetLoopActive) {
            addLiveLog('Not in jail — returning to GTA (loop active)');
            gotoPage('gta');
        } else if (state.meltResetLoopActive) {
            addLiveLog('Not in jail — returning to melt (loop active)');
            gotoCleanMeltPage(1);
        } else {
            addLiveLog('Not in jail, leaving jail page');
            gotoPage('crimes');
        }
    }

    // ── No Reload Bust — background fetch polling ─────────────────────────────
    let noReloadBustTimer  = null;
    let noReloadBustActive = false;

    function scheduleNoReloadBustPoll() {
        if (!noReloadBustActive) return;
        const delay = rand(state.bustPollMin, state.bustPollMax);
        noReloadBustTimer = setTimeout(doNoReloadBustPoll, delay);
    }

    async function doNoReloadBustPoll() {
        if (!noReloadBustActive) return;
        try {
            const cache = Math.random();
            const resp = await fetch(`/a/jailn.php?cache=${cache}`, {
                credentials: 'include',
                cache: 'no-store'
            });
            const js = await resp.text();
            const playerRegex = /name=\\"player\\" value=\\"([^\\]+)\\"/g;
            let match;
            while ((match = playerRegex.exec(js)) !== null) {
                const player = match[1];
                if (!player) continue;
                const bustResp = await fetch(
                    `/?p=jail&player=${encodeURIComponent(player)}`,
                    { credentials: 'include', cache: 'no-store' }
                );
                const bustText = await bustResp.text();
                if (/helped .+ out of jail/i.test(bustText)) {
                    addLiveLog(`No-reload bust: ✓ busted ${player}`);
                }
            }
        } catch(e) {
            // Silent fail — network errors shouldn't stop the loop
        }
        scheduleNoReloadBustPoll();
    }

    function startNoReloadBust() {
        if (noReloadBustActive) return;
        noReloadBustActive = true;
        addLiveLog('No-reload bust started');
        scheduleNoReloadBustPoll();
    }

    function stopBustObserver() { /* no-op in compact mode — bust observer not used */ }

    function stopNoReloadBust() {
        noReloadBustActive = false;
        if (noReloadBustTimer) { clearTimeout(noReloadBustTimer); noReloadBustTimer = null; }
    }

    // ── Bonus Points Auto-spend ───────────────────────────────────────────────
    // Map data-bp values to their point costs
    const BONUS_PERK_COSTS = {
        sucjail2:  2,
        rare2:     4,
        sucother2: 10,
        dblxp2:    10,
    };

    function getBonusPointsFromPage() {
        // Crimes page header: <a href="?p=my-stats&s=bonus">...Bonus...</a> N
        const bonusLink = [...document.querySelectorAll('.bgm.c')].find(el =>
            el.querySelector('a[href*="s=bonus"]')
        );
        if (!bonusLink) return 0;
        const text = bonusLink.textContent.trim();
        const match = text.match(/(\d+)\s*$/);
        return match ? parseInt(match[1], 10) : 0;
    }

    function startBonusPointsSpender() {}  // no-op, runs on crime page visits
    function stopBonusPointsSpender()  {}  // no-op

    async function maybeBuyBonusPerks() {
        if (!state.enabled || !state.bonusPointsEnabled) return;

        // Read balance from crimes page DOM — no unnecessary fetches
        let remaining = getBonusPointsFromPage();
        if (remaining <= 0) return;

        // Get the priority order from saved setting, fall back to default order
        let order;
        try { order = JSON.parse(getSetting('bonusPerkOrder', '[]')); } catch(e) { order = []; }
        if (!order.length) order = ['sucjail2', 'rare2', 'sucother2', 'dblxp2'];

        // Get which perks are enabled — prefer saved setting, fall back to DOM
        let enabledPerks;
        try {
            enabledPerks = JSON.parse(getSetting('bonusEnabledPerks') || '[]');
        } catch(e) { enabledPerks = []; }
        if (!enabledPerks.length) {
            enabledPerks = [...document.querySelectorAll('#ug-bot-bonus-priority-list .ug-bonus-cb')]
                .filter(cb => cb.checked)
                .map(cb => cb.closest('tr')?.dataset.bp)
                .filter(Boolean);
        }

        if (!enabledPerks.length) return;

        // Buy perks in priority order until we can't afford any more
        for (const bp of order) {
            if (!enabledPerks.includes(bp)) continue;
            const cost = BONUS_PERK_COSTS[bp];
            if (!cost || remaining < cost) continue;

            addLiveLog(`Bonus pts: buying ${bp} for ${cost} pts (have ${remaining})`);
            try {
                const body = new URLSearchParams();
                body.append('bp', bp);
                const resp = await fetch('/?p=my-stats&s=bonus', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body.toString()
                });
                if (resp.ok) {
                    // Read updated balance from response
                    const respText = await resp.text();
                    const respDoc  = new DOMParser().parseFromString(respText, 'text/html');
                    const balMatch = respDoc.body?.textContent?.match(/Bonus points:\s*(\d+)/i);
                    if (balMatch) {
                        remaining = parseInt(balMatch[1], 10);
                    } else {
                        remaining -= cost; // fallback
                    }
                    addLiveLog(`Bonus pts: ✓ purchased ${bp} (${remaining} pts remaining)`);
                } else {
                    addLiveLog(`Bonus pts: purchase failed for ${bp}`);
                    break;
                }
            } catch(e) {
                addLiveLog(`Bonus pts: buy error — ${e.message}`);
                break;
            }
        }
    }

    // ── Auto-buy Robot Bodyguard ──────────────────────────────────────────────
    let autoBuyBgTimer  = null;
    let autoBuyBgActive = false;

    function startAutoBuyBg() {
        if (autoBuyBgActive) return;
        autoBuyBgActive = true;
        doAutoBuyBg();
    }

    function stopAutoBuyBg() {
        autoBuyBgActive = false;
        if (autoBuyBgTimer) { clearTimeout(autoBuyBgTimer); autoBuyBgTimer = null; }
    }

    function scheduleAutoBuyBg() {
        if (!autoBuyBgActive) return;
        const intervalMs = state.autoBuyBgMins * 60 * 1000;
        const lastRun    = Number(getSetting('autoBuyBgLastRun', 0));
        const elapsed    = Date.now() - lastRun;
        const delay      = Math.max(0, intervalMs - elapsed);
        autoBuyBgTimer   = setTimeout(doAutoBuyBg, delay);
    }

    async function doAutoBuyBg() {
        if (!autoBuyBgActive || !state.enabled || !state.autoBuyBgEnabled) {
            scheduleAutoBuyBg();
            return;
        }

        const intervalMs = state.autoBuyBgMins * 60 * 1000;
        const lastRun    = Number(getSetting('autoBuyBgLastRun', 0));
        if (Date.now() - lastRun < intervalMs) {
            scheduleAutoBuyBg();
            return;
        }

        const pts = getPlayerPoints();
        if (pts < state.autoBuyBgMinPts) {
            addLiveLog(`Auto-buy BG: only ${pts} pts, need ${state.autoBuyBgMinPts} — skipping`);
            scheduleAutoBuyBg();
            return;
        }

        setSetting('autoBuyBgLastRun', Date.now());
        addLiveLog(`Auto-buy BG: ${pts} pts available, purchasing Robot Bodyguard...`);

        try {
            const body = new URLSearchParams();
            body.append('itema', 'Special#5');  // Robot Bodyguard = Special#5
            const resp = await fetch('/?p=points', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });
            if (resp.ok) {
                addLiveLog('Auto-buy BG: ✓ Robot Bodyguard purchased');
                updateStats(s => { s.lastActionText = 'Bought Robot BG'; });
            } else {
                addLiveLog('Auto-buy BG: purchase failed');
            }
        } catch (e) {
            addLiveLog(`Auto-buy BG: error — ${e.message}`);
        }

        scheduleAutoBuyBg();
    }

    // =========================================================================
    // CTC HANDLER
    // =========================================================================

    function handleCTCMessage(message) {
        addLiveLog(message);

        if (message.startsWith('CTC solved')) {
        } else if (
            message.includes('below floor') ||
            message.includes('timed out') ||
            message.includes('error') ||
            message.includes('too close')
        ) {
        } else if (
            message.includes('attempting auto-solve') ||
            message.includes('visible on load') ||
            message.includes('became visible')
        ) {
        }
    }

    async function maybeSolveCTC() {
        if (!hasCTCChallenge()) return false;
        const result = await CTC.trySolve(handleCTCMessage);
        return result.attempted;
    }

    // =========================================================================
    // MISSIONS
    // =========================================================================

    function getMissionBox() {
        return document.querySelector('#mission_box');
    }

    function hasMissionBox() {
        return !!getMissionBox();
    }

    function getMissionAcceptButton() {
        return document.querySelector('#mission_box input[type="submit"][value="Accept offer"]');
    }

    function getMissionDeclineButton() {
        return document.querySelector('#mission_box input[type="submit"][value="Decline offer"]');
    }

    function getMissionHereLink() {
        return [...document.querySelectorAll('#mission_box a')].find(a => />?here/i.test(textOf(a))) || null;
    }

    // Returns true if the mission has been accepted (progress shown, no Accept/Decline buttons)
    function isMissionAlreadyAccepted() {
        const box = getMissionBox();
        if (!box) return false;
        const hasProgress  = /progress/i.test(textOf(box));
        const hasAcceptBtn = !!getMissionAcceptButton();
        return hasProgress && !hasAcceptBtn;
    }

    function normalizeMissionText(str) {
        return String(str || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeCarNameForCompare(str) {
        return normalizeMissionText(str)
            .replace(/^#\d+\s*/, '')
            .replace(/\s*\(\d+\)\s*$/, '')
            .toLowerCase();
    }

    function parseMissionInfo() {
        const box = getMissionBox();
        if (!box) return null;

        const fullText = normalizeMissionText(box.textContent || '');
        const links    = [...box.querySelectorAll('a[href]')];

        const hasCrimesLink = links.some(a => (a.getAttribute('href') || '').includes('?p=crimes'));
        const hasCarsLink   = links.some(a => (a.getAttribute('href') || '').includes('?p=cars'));

        if (hasCrimesLink) {
            const allBold  = [...box.querySelectorAll('b')];
            const underEl  = box.querySelector('u');

            const moneyBold = allBold.find(b => /^\$[\d,]+$/.test(normalizeMissionText(b.textContent)));
            if (moneyBold) {
                const amount = parseMoney(normalizeMissionText(moneyBold.textContent));
                if (amount > 0) {
                    return { type: 'earnmoney', amount, text: fullText };
                }
            }

            const nameBold = allBold.find(b => !/^\$[\d,]+$/.test(normalizeMissionText(b.textContent)) && normalizeMissionText(b.textContent) !== 'Mission');
            const name     = nameBold ? normalizeMissionText(nameBold.textContent) : null;
            const amount   = underEl  ? Number(normalizeMissionText(underEl.textContent)) || 0 : 0;
            if (name && amount > 0) {
                return { type: 'crime', crimeName: name, amount, text: fullText };
            }
        }

        if (hasCarsLink) {
            const underEl = box.querySelector('u');
            if (underEl) {
                const underText = normalizeMissionText(underEl.textContent);
                const match     = underText.match(/^(\d+)\s+(.+)$/);
                if (match) {
                    const amount  = Number(match[1]);
                    const carName = normalizeMissionText(match[2]);
                    const hereLink = getMissionHereLink();
                    if (amount > 0 && carName) {
                        return {
                            type:      'givecars',
                            carAmount: amount,
                            carName:   carName,
                            hereHref:  hereLink ? (hereLink.getAttribute('href') || '') : '',
                            text:      fullText
                        };
                    }
                }
            }
        }

        return { type: 'unknown', text: fullText };
    }

    function getOwnedCarsMapFromMissionCarsPage() {
        const map     = new Map();
        const entries = [...document.querySelectorAll('.tac.mb .bgl.i.in a[href*="?p=cars&a="]')];

        for (const a of entries) {
            const bgm = a.querySelector('.bgm');
            if (!bgm) continue;

            const txt = normalizeMissionText(bgm.textContent);
            if (!txt || /^all cars\b/i.test(txt)) continue;

            const countMatch = txt.match(/\((\d+)\)\s*$/);
            const count      = countMatch ? Number(countMatch[1]) || 0 : 0;
            const name       = normalizeCarNameForCompare(txt.replace(/\(\d+\)\s*$/, ''));

            if (!name) continue;
            map.set(name, count);
        }

        return map;
    }

    function isMissionCarsCheckPage() {
        return !!document.querySelector('#Cars') &&
               !!document.querySelector('input[type="submit"][name="mish"][value="Use for Mission"]');
    }

    function getMissionCarCheckboxes() {
        return [...document.querySelectorAll('input[type="checkbox"][name="id[]"]')];
    }

    function getUseForMissionButton() {
        return document.querySelector('input[type="submit"][name="mish"][value="Use for Mission"]');
    }

    function getMissionSelectAllLink() {
        return [...document.querySelectorAll('#Cars a')].find(a => /select all/i.test(textOf(a))) || null;
    }

    async function clickMissionAccept() {
        const btn = getMissionAcceptButton();
        if (!btn || btn.disabled) return false;

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshBtn = getMissionAcceptButton();
        if (!freshBtn || freshBtn.disabled) return false;

        humanClick(freshBtn);
        return true;
    }

    async function clickMissionDecline() {
        const btn = getMissionDeclineButton();
        if (!btn || btn.disabled) return false;

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshBtn = getMissionDeclineButton();
        if (!freshBtn || freshBtn.disabled) return false;

        humanClick(freshBtn);
        return true;
    }

    async function submitCarsForMission(requiredAmount) {
        const submitBtn = getUseForMissionButton();
        if (!submitBtn || requiredAmount <= 0) return false;

        const getChecked = () => getMissionCarCheckboxes().filter(cb => cb.checked);

        // Try Select All first
        const selectAllLink = getMissionSelectAllLink();
        if (selectAllLink) {
            await wait(rand(120, 260));
            humanClick(selectAllLink);
            await wait(rand(180, 320));

            const checkedAfterSelectAll = getChecked().length;
            if (checkedAfterSelectAll >= requiredAmount) {
                if (checkedAfterSelectAll > requiredAmount) {
                    const checked = getChecked();
                    for (let i = requiredAmount; i < checked.length; i++) {
                        checked[i].checked = false;
                    }
                    await wait(rand(120, 260));
                }

                const finalChecked = getChecked().length;
                if (finalChecked !== requiredAmount) {
                    addLiveLog(`Mission selection mismatch after Select All: expected ${requiredAmount}, selected ${finalChecked}`);
                    return false;
                }

                state.lastActionAt = now();
                await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

                const freshSubmit = getUseForMissionButton();
                if (!freshSubmit) return false;

                humanClick(freshSubmit);
                addLiveLog(`Submitted ${requiredAmount} cars for mission`);
                return true;
            }

            addLiveLog(`Mission Select All only selected ${checkedAfterSelectAll}, need ${requiredAmount} — falling back to manual selection`);
        }

        // Manual selection fallback
        const checkboxes = getMissionCarCheckboxes();
        if (checkboxes.length < requiredAmount) {
            addLiveLog(`Mission manual selection failed: only ${checkboxes.length} car(s) available, need ${requiredAmount}`);
            return false;
        }

        for (const cb of checkboxes) cb.checked = false;
        for (let i = 0; i < requiredAmount; i++) checkboxes[i].checked = true;

        await wait(rand(120, 260));

        const checkedNow = getChecked().length;
        if (checkedNow !== requiredAmount) {
            addLiveLog(`Mission manual selection mismatch: expected ${requiredAmount}, selected ${checkedNow}`);
            return false;
        }

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshSubmit = getUseForMissionButton();
        if (!freshSubmit) return false;

        humanClick(freshSubmit);
        addLiveLog(`Submitted ${requiredAmount} cars for mission (manual selection)`);
        return true;
    }

    async function maybeHandlePendingMissionSubmission() {
        const pending = state.pendingMissionCheck;
        if (!pending || pending.type !== 'givecars') return false;
        if (hasCTCChallenge()) return false;

        if (pending.stage === 'submit' && isMissionCarsCheckPage()) {
            addLiveLog(`Mission submit stage: submitting ${pending.amount} x ${pending.carNameRaw}`);

            const checkboxes = getMissionCarCheckboxes();
            if (checkboxes.length < pending.amount) {
                addLiveLog(`Mission submit: only ${checkboxes.length} car(s) available, need ${pending.amount} — mission cannot be completed, clearing pending state`);
                updateStats(s => { s.lastActionText = `Car mission stuck: insufficient ${pending.carNameRaw}`; });
                state.pendingMissionCheck = null;
                await wait(navRand());
                gotoPage('crimes');
                return true;
            }

            const didSubmit = await submitCarsForMission(pending.amount);
            if (didSubmit) {
                updateStats(s => {
                    s.missionCarsUsed += pending.amount;
                    s.lastActionText   = `Used ${pending.amount} x ${pending.carNameRaw} for mission`;
                });
                addLiveLog(`Mission complete: submitted ${pending.amount} x ${pending.carNameRaw}`);
                state.pendingMissionCheck = null;
                state.missionGaveUp       = false;
                await wait(navRand());
                gotoPage('crimes');
                return true;
            }
            addLiveLog('Mission submit failed — will retry');
            return true;
        }

        if (pending.stage === 'inventory') {
            const ownedMap = getOwnedCarsMapFromMissionCarsPage();
            const owned    = ownedMap.get(pending.carName) || 0;

            addLiveLog(`Mission inventory check: need ${pending.amount} x ${pending.carNameRaw}, own ${owned}`);

            if (owned < pending.amount) {
                if (pending.alreadyAccepted) {
                    addLiveLog(`Not enough cars (${owned}/${pending.amount}) and mission already accepted — clearing pending state`);
                    updateStats(s => { s.lastActionText = `Car mission stuck: insufficient ${pending.carNameRaw}`; });
                    state.pendingMissionCheck = null;
                    state.missionGaveUp       = true;
                    await wait(navRand());
                    gotoPage('crimes');
                    return true;
                }
                addLiveLog(`Not enough cars — declining mission`);
                const didDecline = await clickMissionDecline();
                if (didDecline) {
                    updateStats(s => {
                        s.missionsDeclined += 1;
                        s.lastActionText    = `Declined car mission: insufficient ${pending.carNameRaw}`;
                    });
                    state.pendingMissionCheck = null;
                    state.missionGaveUp       = false;
                    await wait(navRand());
                    gotoPage('crimes');
                    return true;
                }
                addLiveLog('Decline click failed — will retry');
                return true;
            }

            if (pending.alreadyAccepted) {
                addLiveLog(`Enough cars owned (${owned}/${pending.amount}) — proceeding to submit`);
                state.pendingMissionCheck = { ...pending, stage: 'submit' };
                return true;
            }

            addLiveLog(`Enough cars owned — accepting mission`);
            const didAccept = await clickMissionAccept();
            if (!didAccept) {
                addLiveLog('Accept click failed — will retry');
                return true;
            }

            updateStats(s => {
                s.missionsAccepted += 1;
                s.lastActionText    = `Accepted car mission: ${pending.carNameRaw} x${pending.amount}`;
            });
            addLiveLog(`Accepted car mission: ${pending.carNameRaw} x${pending.amount}`);

            state.pendingMissionCheck = { ...pending, stage: 'submit', acceptedAt: now() };
            return true;
        }

        return false;
    }

    async function maybeHandleMission() {
        if (!state.autoMissionsEnabled) return false;
        if (hasCTCChallenge()) return false;
        if (isLikelyJailPage()) return false;

        if (state.pendingMissionCheck) return false;

        if (!hasMissionBox()) return false;

        const mission = parseMissionInfo();
        if (!mission) return false;

        if (mission.type === 'crime') {
            if (!getMissionAcceptButton()) return false;
        }

        if (mission.type === 'givecars') {
            if (!isGTAPage() && !hasGTAPageMarkers()) return false;
            if (isMissionAlreadyAccepted() && state.missionGaveUp) return false;
        }

        if (mission.type === 'earnmoney') {
            if (isMissionAlreadyAccepted()) return false;
            addLiveLog(`Mission detected: earn $${mission.amount.toLocaleString()} from crimes`);

            const didAccept = await clickMissionAccept();
            if (didAccept) {
                updateStats(s => {
                    s.missionsAccepted += 1;
                    s.lastActionText    = `Accepted mission: earn $${mission.amount.toLocaleString()}`;
                });
                addLiveLog(`Accepted earn money mission: $${mission.amount.toLocaleString()}`);
                return true;
            }

            addLiveLog('Earn money mission detected but could not click Accept');
            return false;
        }

        if (mission.type === 'crime') {
            if (isMissionAlreadyAccepted()) return false;
            addLiveLog(`Mission detected: crime "${mission.crimeName}" x${mission.amount}`);

            const didAccept = await clickMissionAccept();
            if (didAccept) {
                updateStats(s => {
                    s.missionsAccepted += 1;
                    s.lastActionText    = `Accepted mission: ${mission.crimeName} x${mission.amount}`;
                });
                addLiveLog(`Accepted crime mission: ${mission.crimeName} x${mission.amount}`);
                return true;
            }

            addLiveLog('Crime mission detected but could not click Accept');
            return false;
        }

        if (mission.type === 'givecars') {
            addLiveLog(`Mission detected: give cars "${mission.carName}" x${mission.carAmount}`);

            if (!state.autoGiveCarMissionsEnabled) {
                const didDecline = await clickMissionDecline();
                if (didDecline) {
                    updateStats(s => {
                        s.missionsDeclined += 1;
                        s.lastActionText    = `Declined car mission: ${mission.carName} x${mission.carAmount}`;
                    });
                    addLiveLog(`Declined give-car mission (toggle off): ${mission.carName} x${mission.carAmount}`);
                    return true;
                }
                addLiveLog('Give-car mission: could not click Decline');
                return false;
            }

            if (isMissionAlreadyAccepted()) {
                addLiveLog(`Car mission already accepted — checking inventory before submitting`);
                const hereLink = getMissionHereLink();
                if (!hereLink) {
                    addLiveLog('Mission Here link not found — returning to crimes');
                    return false;
                }
                state.pendingMissionCheck = {
                    type:            'givecars',
                    carName:         normalizeCarNameForCompare(mission.carName),
                    carNameRaw:      mission.carName,
                    amount:          mission.carAmount,
                    stage:           'inventory',
                    alreadyAccepted: true,
                    startedAt:       now()
                };
                await wait(navRand());
                navigateToUrl(new URL(hereLink.getAttribute('href'), window.location.href).toString());
                return true;
            }

            const hereLink = getMissionHereLink();
            if (!hereLink) {
                addLiveLog('Mission Here link not found — declining');
                const didDecline = await clickMissionDecline();
                if (didDecline) {
                }
                return true;
            }

            addLiveLog(`Navigating to mission inventory page to check for ${mission.carName} x${mission.carAmount}`);
            state.pendingMissionCheck = {
                type:       'givecars',
                carName:    normalizeCarNameForCompare(mission.carName),
                carNameRaw: mission.carName,
                amount:     mission.carAmount,
                stage:      'inventory',
                startedAt:  now()
            };
            await wait(navRand());
            navigateToUrl(new URL(hereLink.getAttribute('href'), window.location.href).toString());
            return true;
        }

        return false;
    }

    // =========================================================================
    // AUTO ACCOUNT CREATION
    // =========================================================================

    function isLoginPage() {
        return !!document.querySelector('#logincon input[name="login"]');
    }

    function isUsernamePage() {
        return !!document.querySelector('form input[name="username"][type="text"]') &&
               !!document.querySelector('form input[name="create"]');
    }

    function isRulesPage() {
        return !!document.querySelector('input[name="agree"]');
    }

    function isTutorialPage() {
        return !!document.querySelector('input[name="tutorial"]');
    }

    function hasUsernameTakenError() {
        // Inline error next to field
        const newuserEl = document.querySelector('#newuser');
        if (newuserEl && /username taken/i.test(newuserEl.textContent)) return true;
        // Top-level fail message after form submit
        return [...document.querySelectorAll('.bgm.fail')].some(el =>
            /username taken/i.test(el.textContent)
        );
    }

    function sanitiseUsername(raw) {
        // Strip disallowed chars, trim to 20 chars
        return raw.replace(/[^a-z0-9 ]/gi, '').slice(0, 20).trim();
    }

    function generateRandomUsernames(count = 100) {
        const adjectives = ['Dark', 'Fast', 'Bold', 'Sly', 'Wild', 'Cool', 'Grim', 'Iron',
            'Slick', 'Sharp', 'Swift', 'Raw', 'Real', 'True', 'Big', 'Mad',
            'Gold', 'Dead', 'Cold', 'Lone', 'Free', 'Sly', 'Lucky', 'Dirty'];
        const nouns = ['Gang', 'Boss', 'King', 'Ghost', 'Wolf', 'Shark', 'Blade', 'Smoke',
            'Stone', 'Hawk', 'Fox', 'Viper', 'Ace', 'Rider', 'Claw', 'Fang',
            'Storm', 'Blaze', 'Drake', 'Raven', 'Frost', 'Rebel', 'Outlaw', 'Shadow'];
        const pick = arr => arr[Math.floor(Math.random() * arr.length)];
        const names = new Set();
        let attempts = 0;
        while (names.size < count && attempts < count * 10) {
            attempts++;
            const style = Math.floor(Math.random() * 5);
            let name = '';
            if (style === 0) {
                name = pick(adjectives) + pick(nouns);
            } else if (style === 1) {
                name = pick(adjectives) + ' ' + pick(nouns);
            } else if (style === 2) {
                name = pick(nouns) + Math.floor(Math.random() * 999);
            } else if (style === 3) {
                name = pick(adjectives) + pick(nouns) + Math.floor(Math.random() * 99);
            } else {
                name = pick(adjectives) + ' ' + pick(nouns) + ' ' + Math.floor(Math.random() * 9);
            }
            name = sanitiseUsername(name);
            if (name.length >= 3 && name.length <= 20) names.add(name);
        }
        return [...names];
    }

    function applyDeathSettingsReset() {
        if (GM_getValue('accDeathSettingsReset', false)) return;
        GM_setValue('accDeathSettingsReset', true);
        const disabled = [];
        if (state.autoDrugsEnabled) {
            state.autoDrugsEnabled = false;
            if (autoDrugsInput) autoDrugsInput.checked = false;
            disabled.push('autoDrugs');
        }
        if (state.killSearchEnabled) {
            state.killSearchEnabled = false;
            if (killSearchInput) killSearchInput.checked = false;
            disabled.push('killSearch');
        }
        if (state.killProtectedRecheckEnabled) {
            state.killProtectedRecheckEnabled = false;
            if (killProtectedRecheckInput) killProtectedRecheckInput.checked = false;
            disabled.push('killProtectedRecheck');
        }
        if (state.killBgCheckEnabled) {
            state.killBgCheckEnabled = false;
            if (killBgCheckInput) killBgCheckInput.checked = false;
            disabled.push('killBgCheck');
        }
        if (state.killBgSpamEnabled) {
            state.killBgSpamEnabled = false;
            if (killBgSpamInput) killBgSpamInput.checked = false;
            stopBgSpam();
            disabled.push('killBgSpam');
        }
        if (state.autoBuyGun) {
            state.autoBuyGun = false;
            const _autoBuyGunEl = document.querySelector('#ug-bot-auto-buy-gun');
            if (_autoBuyGunEl) _autoBuyGunEl.checked = false;
            disabled.push('autoBuyGun');
        }
        if (disabled.length > 0) {
            GM_setValue('accAutoDisabled', JSON.stringify(disabled));
            const labels = {
                autoDrugs: 'Drug run', killSearch: 'Search players',
                killProtectedRecheck: 'Protected re-search', killBgCheck: 'BG check loop',
                killBgSpam: 'BG Spam', autoBuyGun: 'Auto buy gun'
            };
            addLiveLog('Auto login: disabled on new account — ' + disabled.map(k => labels[k]).join(', '));
        }
        // Clear loop state but keep player list intact — alive players get reset to unknown when Don rank is reached
        GM_setValue('killSearchLoopActive', false);
        GM_setValue('killLoopActive', false);
        GM_setValue('killSearchIndex', 0);
        GM_setValue('killCurrentSearch', '');
        GM_setValue('killLastOnlineScan', 0);
        setSetting('bgSpamTravelTarget', '');
        setSetting('killBgSpamPaused', false);
        setSetting('killBgWaitUntil', 0);
        setSetting('killLoopCooldownUntil', 0);
        stopBgSpam();
        // Clear BG Farm state and reset all alive players to unknown — searches are cleared on death
        const _players = getSetting('killPlayers', []);
        const _cleared = _players.map(p => {
            const np = { ...p };
            delete np.bodyguard;
            delete np.expectedFoundAt;
            delete np.bgFarmWaitUntil;
            delete np.searchExpiresAt;
            delete np.pendingSearch;
            if (np.status === 'alive' || np.status === 'protected') np.status = 'unknown';
            return np;
        });
        setSetting('killPlayers', _cleared);
        // Clear GB disable flag and restore all crimes so new account starts fresh
        setSetting('gbDisableFired', false);
        setSetting('bgCrimeEnabled', true);
        if (bgCrimeEnabledInput) bgCrimeEnabledInput.checked = true;
        const _allCrimeIds = ['gang', '1', '2', 'drug', '3', '4', '5', '6', '7', 'gta', 'melt'];
        const _cur = getSetting('enabledActions', _allCrimeIds);
        const _restored = [...new Set([..._cur, ..._allCrimeIds])];
        setSetting('enabledActions', _restored);
    }

    async function handleLoginPage() {
        if (!state.accEnabled) return;

        const lastAttempt = Number(GM_getValue('loginLastAttempt', 0));
        const nowMs = Date.now();
        if (nowMs - lastAttempt < 10000) return;
        GM_setValue('loginLastAttempt', nowMs);

        // Death detected — disable protection-breaking settings immediately
        applyDeathSettingsReset();

        const emailInput = document.querySelector('#login-email');
        const passInput  = document.querySelector('#login-password');
        const loginBtn   = document.querySelector('#login-button');
        const loginForm  = loginBtn ? loginBtn.closest('form') : null;
        if (!emailInput || !passInput || !loginBtn || !loginForm) return;

        const email    = state.accEmail;
        const password = state.accPassword;

        if (email && password) {
            // Credentials stored — fill fields programmatically and submit
            addLiveLog('Auto login: filling credentials and submitting');
            await wait(rand(500, 800));
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(emailInput, email);
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            nativeInputValueSetter.call(passInput, password);
            passInput.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(300);
            loginBtn.click();
        } else {
            // No credentials — rely on browser autofill (works on Firefox)
            addLiveLog('Auto login: clicking Enter (autofill mode)');
            await wait(rand(500, 800));
            loginBtn.click();
        }
    }

    function removeCurrentAccName() {
        const usernames = state.accUsernames;
        if (usernames.length > 0) {
            const removed = usernames[state.accNameIndex] || usernames[0];
            usernames.splice(state.accNameIndex, 1);
            state.accUsernames = usernames;
            // Keep index pointing at the same position (now the next name)
            // but clamp it so it doesn't go out of bounds
            if (state.accNameIndex >= usernames.length) {
                state.accNameIndex = Math.max(0, usernames.length - 1);
            }
            // Update the textarea in the panel if visible
            const ta = document.querySelector('#ug-bot-acc-names');
            if (ta) ta.value = usernames.join('\n');
            const statusEl = document.querySelector('#ug-bot-acc-status');
            if (statusEl) statusEl.textContent = usernames.length + ' name(s) remaining';
            return removed;
        }
        return null;
    }

    async function handleUsernamePage() {
        if (!state.accEnabled) return;

        // First time we land on username page = confirmed death.
        // Disable settings that would break new account protection.
        applyDeathSettingsReset();

        // Check for taken error from a previous submit attempt
        if (hasUsernameTakenError()) {
            addLiveLog('Auto login: username taken — removing from list');
            removeCurrentAccName();
        }

        const usernames = state.accUsernames;
        let idx = state.accNameIndex;

        if (!usernames.length) {
            addLiveLog('Auto login: no usernames in list — cannot create account');
            return;
        }

        if (idx >= usernames.length) {
            addLiveLog('Auto login: all usernames exhausted — cannot create account');
            return;
        }

        const username = sanitiseUsername(usernames[idx]);
        if (!username) {
            removeCurrentAccName();
            addLiveLog('Auto login: invalid username — removed from list');
            await wait(rand(300, 600));
            location.reload();
            return;
        }

        addLiveLog(`Auto login: trying username "${username}" (${idx + 1}/${usernames.length})`);

        const usernameInput = document.querySelector('form input[name="username"]');
        const confirmBtn = document.querySelector('form input[name="create"]');
        if (!usernameInput || !confirmBtn) {
            addLiveLog('Auto login: username form not found');
            return;
        }

        // Set the full username at once then trigger the live availability check.
        // Character-by-character was unreliable — partial values could be submitted
        // if the handler was re-entered before typing completed.
        usernameInput.value = username;
        usernameInput.dispatchEvent(new Event('keyup', { bubbles: true }));

        // Wait for live availability AJAX to respond
        await wait(2000);

        if (hasUsernameTakenError()) {
            addLiveLog(`Auto login: "${username}" already taken — removing from list`);
            removeCurrentAccName();
            await wait(rand(400, 800));
            location.reload();
            return;
        }

        addLiveLog(`Auto login: submitting username "${username}"`);
        await wait(rand(300, 600));
        // Remove from list immediately on submit — if it fails as taken the page
        // will reload and the next name will be tried. This prevents used names
        // from staying in the list if the taken error isn't caught.
        removeCurrentAccName();
        humanClick(confirmBtn);
    }

    async function handleRulesPage() {
        if (!state.accEnabled) return;
        addLiveLog('Auto login: rules page — accepting');

        // Decline tutorial — find the form with hidden input value="end" and submit it
        const tutorialForm = [...document.querySelectorAll('form')].find(f => {
            const hidden = f.querySelector('input[name="tutorial"]');
            return hidden && hidden.value === 'end';
        });
        if (tutorialForm) {
            await wait(rand(500, 900));
            tutorialForm.submit();
            await wait(rand(800, 1200));
            return; // page will reload, handler will run again for rules
        }

        // Accept rules — must click the submit button, not call form.submit(),
        // so the button value (agree=I agree) is included in the POST body
        const agreeBtn = document.querySelector('input[name="agree"][type="submit"]');
        if (agreeBtn) {
            // Set all flags BEFORE clicking — the form POST navigates away immediately
            // so anything after humanClick() may not execute
            GM_setValue('accDeathSettingsReset', false);
            GM_setValue('killSearchLoopActive', false);
            GM_setValue('killLoopActive', false);
            GM_setValue('killSearchIndex', 0);
            GM_setValue('killCurrentSearch', '');
            // Re-enable bullet factory after death unless BG Spam is active
            // (BG Spam requires staying in one country so bullet factory is incompatible)
            if (!state.killBgSpamEnabled || !state.killBgSpamTarget) {
                GM_setValue('bulletFactoryEnabled', true);
                addLiveLog('Post-death: bullet factory re-enabled');
            }
            if (state.accRetrieve) {
                GM_setValue('accPendingRetrieve', true);
            }
            if (!state.enabled) {
                state.enabled = true;
                state.pausedReason = '';
                state.sessionStartedAt = now();
            }
            await wait(rand(500, 900));
            addLiveLog('Auto login: rules accepted — retrieving assets from previous account');
            humanClick(agreeBtn);
            return;
        }

        addLiveLog('Auto login: rules/tutorial page — no form found, skipping');
    }

    // =========================================================================
    // PAGE HANDLERS
    // =========================================================================

    // =========================================================================
    // MY-STATS EMAIL RETRIEVE — transfers assets from previous account
    // =========================================================================

    function isMyStatsEmailPage() {
        const p = currentPage();
        const s = new URL(window.location.href).searchParams.get('s') || '';
        return p === 'my-stats' && (s === 'email' || s === '');
    }

    async function handleMyStatsRetrieve() {
        if (!GM_getValue('accPendingRetrieve', false)) return false;

        const url  = new URL(window.location.href);
        const uParam = url.searchParams.get('u');

        // Step 1 — on the account list page, click the most recent previous account
        if (!uParam) {
            // Accounts are listed highest number first — index 0 is the current account,
            // index 1 is the most recent previous account
            const rows = [...document.querySelectorAll('td.veg.lettuce a')];
            const prevLink = rows[1];
            if (!prevLink) {
                addLiveLog('Auto retrieve: no previous account found — skipping');
                GM_setValue('accPendingRetrieve', false);
                gotoPage('crimes');
                return true;
            }
            const prevName = prevLink.textContent.trim();
            addLiveLog(`Auto retrieve: found previous account "${prevName}" — retrieving assets`);
            await wait(rand(500, 900));
            navigateToUrl(prevLink.getAttribute('href'));
            return true;
        }

        // Step 2 — on the specific account page, retrieve Swiss bank, points, and cars
        // Use fetch POST rather than form.submit() so page doesn't reload between steps
        addLiveLog(`Auto retrieve: retrieving assets from "${uParam}"`);
        const postUrl = window.location.href;

        // Retrieve Swiss bank (type=1)
        const swissCell = [...document.querySelectorAll('td.veg.sprouts')].find(td => td.textContent.includes('Swiss bank'));
        if (swissCell) {
            const swissMatch = swissCell.textContent.match(/Swiss bank\s*\$([\d,]+)/);
            if (swissMatch) {
                const swissAmount = swissMatch[1].replace(/,/g, '');
                addLiveLog(`Auto retrieve: Swiss bank $${swissMatch[1]}`);
                const fd = new FormData();
                fd.append('type', '1');
                fd.append('amount', swissAmount);
                await fetch(postUrl, { method: 'POST', body: fd, credentials: 'include' });
                await wait(rand(600, 1000));
            }
        }

        // Retrieve points (type=2)
        const pointsCell = [...document.querySelectorAll('td.veg.sprouts')].find(td => td.textContent.includes('Points'));
        if (pointsCell) {
            const pointsMatch = pointsCell.textContent.match(/Points\s*([\d,]+)/);
            if (pointsMatch) {
                const pointsAmount = pointsMatch[1].replace(/,/g, '');
                addLiveLog(`Auto retrieve: ${pointsMatch[1]} points`);
                const fd = new FormData();
                fd.append('type', '2');
                fd.append('amount', pointsAmount);
                await fetch(postUrl, { method: 'POST', body: fd, credentials: 'include' });
                await wait(rand(600, 1000));
            }
        }

        // Retrieve cars
        const carForm = [...document.querySelectorAll('form')].find(f =>
            f.querySelector('input[type="checkbox"][name="id[]"]')
        );
        if (carForm) {
            const carIds = [...carForm.querySelectorAll('input[type="checkbox"][name="id[]"]')].map(cb => cb.value);
            const carNames = [...carForm.querySelectorAll('a')].map(a => a.textContent.trim()).join(', ');
            if (carIds.length > 0) {
                addLiveLog(`Auto retrieve: cars — ${carNames}`);
                const fd = new FormData();
                carIds.forEach(id => fd.append('id[]', id));
                fd.append('retrieve', 'Retrieve');
                await fetch(postUrl, { method: 'POST', body: fd, credentials: 'include' });
                await wait(rand(600, 1000));
            }
        }

        addLiveLog('Auto retrieve: complete — navigating to crimes');
        GM_setValue('accPendingRetrieve', false);
        await wait(rand(500, 900));
        gotoPage('crimes');
        return true;
    }

    async function handleCrimesPage() {
        stopJailObserver();
        resetMeltSearchState();
        clearPendingMeltResult();

        // Abort any in-flight QT sniper fetch — server blocks crime commits
        // when a QT fetch is in progress, even if it started on a previous page.
        // Skip when bg crimes is enabled — no session conflict in that mode.
        if (!state.bgCrimeEnabled && qtSniperAbortController) {
            qtSniperAbortController.abort();
            qtSniperAbortController = null;
        }

        // Detect server-side crimes page block (empty #maincen)
        // This happens when the game detects bot-like behaviour on the crimes page
        // Skip this check in bgCrime mode — we don't need #maincen content
        const _maincenEmpty = !document.querySelector('#maincen')?.textContent.trim();
        if (!state.bgCrimeEnabled && _maincenEmpty) {
            addLiveLog('Crimes page blocked by server — switching to other actions');
            // Try to do something else useful instead
            const gtaUsable   = isGTAEnabled()  && !isGTALocked();
            const meltUsable  = isMeltUsable();
            const drugsUsable = isDrugsEnabled();
            if (drugsUsable && isInternalDriveReady() && !(state.killBgSpamEnabled && state.killBgSpamTarget && state.killBgCheckEnabled)) {
                await wait(navRand());
                gotoPage('drugs');
            } else if (gtaUsable && isInternalGTAReady()) {
                state.killSearchLoopActive = false; // prevent kill scanner intercepting mid-load
                // Dupe mode: occasionally delay GTA to look less automated
                if (PERSONALITY.gtaDelayChancePct > 0 && Math.random() * 100 < PERSONALITY.gtaDelayChancePct) {
                    await wait(rand(1000, PERSONALITY.gtaDelayExtraMs));
                }
                await wait(navRand());
                gotoPage('gta');
            } else if (meltUsable && isInternalMeltReady()) {
                state.killSearchLoopActive = false; // prevent kill scanner intercepting mid-load
                await wait(navRand());
                gotoCleanMeltPage(1);
            } else {
                // Nothing else to do — good opportunity for a human page visit
                if (await maybeVisitHumanPage()) return;
                await wait(rand(15000, 30000));
                gotoPage('crimes');
            }
            return;
        }

        // Reset the crime reset flag each time we arrive at the crimes page fresh.
        // This allows a reset on the next visit if needed, while preventing a
        // double-reset within the same AJAX-based crimes page session.
        crimeResetUsedThisVisit = false;

        // When background crimes is enabled, skip crime committing entirely and
        // immediately route to the next available non-crime action
        if (state.bgCrimeEnabled) {
            // Dupe mode: occasionally linger on crimes page before acting
            if (PERSONALITY.crimePageLingerMs > 0 && Math.random() < 0.3) {
                await wait(rand(0, PERSONALITY.crimePageLingerMs));
            }
            const gtaUsable   = isGTAEnabled()  && !isGTALocked();
            const meltUsable  = isMeltUsable();
            const drugsUsable = isDrugsEnabled();

            if (shouldRunRepairCycle()) {
                addLiveLog(`Repair threshold reached (${state.meltsSinceRepair}/${state.repairEveryMelts})`);
                await wait(navRand());
                gotoPage('cars', { page: 1 });
                return;
            }

            if (isDrugsEnabled() && shouldDoSwissDeposit()) {
                const depositAmount = calcSwissDepositAmount();
                if (depositAmount > 0) {
                    const reserve = calcDrugReserve(state.drugCapacityCache);
                    addLiveLog(`Swiss Bank deposit: depositing $${depositAmount.toLocaleString()} (keeping $${reserve.toLocaleString()} reserve)`);
                    state.pendingBankAction = { type: 'deposit', amount: depositAmount };
                    await wait(navRand());
                    gotoPage('bank');
                    return;
                }
            }

            if (drugsUsable && isInternalDriveReady() && !state.killLoopActive && !(state.killBgSpamEnabled && state.killBgSpamTarget && state.killBgCheckEnabled)) {
                await wait(navRand());
                gotoPage('drugs');
                return;
            }
            if (gtaUsable && isInternalGTAReady()) {
                await wait(navRand());
                gotoPage('gta');
                return;
            }
            if (meltUsable && isInternalMeltReady()) {
                resetMeltSearchState();
                clearPendingMeltResult();
                await wait(navRand());
                gotoCleanMeltPage(1);
                return;
            }
            // Nothing ready — wait for next heartbeat
            const nextGtaMs   = gtaUsable   ? getInternalGTARemainingMs()   : null;
            const nextMeltMs  = meltUsable  ? getInternalMeltRemainingMs()  : null;
            const nextDriveMs = drugsUsable ? getInternalDriveRemainingMs() : null;
            const parts = [];
            if (nextGtaMs   != null && nextGtaMs   > 0) parts.push(`GTA ${Math.ceil(nextGtaMs / 1000)}s`);
            if (nextMeltMs  != null && nextMeltMs  > 0) parts.push(`melt ${Math.ceil(nextMeltMs / 1000)}s`);
            if (nextDriveMs != null && nextDriveMs > 0) parts.push(`drive ${Math.ceil(nextDriveMs / 1000)}s`);
            return;
        }



        if (hasCTCChallenge()) {
            await maybeSolveCTC();
            return;
        }

        if (shouldRunRepairCycle()) {
            addLiveLog(`Repair threshold reached (${state.meltsSinceRepair}/${state.repairEveryMelts})`);
            await wait(navRand());
            gotoPage('cars', { page: 1 });
            return;
        }

        // Swiss Bank deposit check — only when drug running is enabled
        if (isDrugsEnabled() && shouldDoSwissDeposit()) {
            const depositAmount = calcSwissDepositAmount();
            if (depositAmount > 0) {
                const reserve = calcDrugReserve(state.drugCapacityCache);
                addLiveLog(`Swiss Bank deposit: depositing $${depositAmount.toLocaleString()} (keeping $${reserve.toLocaleString()} reserve)`);
                state.pendingBankAction = { type: 'deposit', amount: depositAmount };
                await wait(navRand());
                gotoPage('bank');
                return;
            }
        }

        // When crime reset is active:
        // 1. Commit all currently available crimes
        // 2. If any crimes are still on cooldown (button hidden by game JS) → reset
        // 3. After reset, commit all newly available crimes
        // This runs sequentially — commit first, then reset if needed, never either/or.
        if (state.resetCrimesEnabled) {
            const fastMode = state.resetCrimesFastMode;

            // Step 1: commit all available crimes
            let totalBurst = 0;
            let burstCount = 0;
            do {
                burstCount = fastMode ? await commitCrimeBurstFast() : await commitCrimeBurst();
                totalBurst += burstCount;
            } while (burstCount > 0);

            if (totalBurst > 0) {
                addLiveLog(`Crime burst finished (${totalBurst} actions)${fastMode ? ' [fast mode]' : ''}`);
            }

            // Step 2: if any enabled crimes are still on cooldown, click reset
            if (!crimeResetUsedThisVisit && hasAnyCrimeOnCooldown()) {
                const didReset = await tryCrimeReset(fastMode);
                if (didReset) {
                    // Step 3: after reset, commit all newly available crimes
                    let postResetTotal = 0;
                    let postResetCount = 0;
                    do {
                        postResetCount = fastMode ? await commitCrimeBurstFast() : await commitCrimeBurst();
                        postResetTotal += postResetCount;
                    } while (postResetCount > 0);
                    if (postResetTotal > 0) {
                        addLiveLog(`Post-reset burst (${postResetTotal} actions)${fastMode ? ' [fast mode]' : ''}`);
                    }
                }
            }

            // Stay on crimes page — don't navigate away to GTA/melt/drugs
            return;
        }

        // Normal mode — commit crimes then navigate to other actions as usual
        // Normal mode — commit crimes then navigate to other actions as usual
        let totalBurst = 0;
        let burstCount = 0;
        do {
            burstCount = await commitCrimeBurst();
            totalBurst += burstCount;
        } while (burstCount > 0);

        if (totalBurst > 0) {
            addLiveLog(`Crime burst finished (${totalBurst} actions)`);
        }

        if (totalBurst > 0) return;

        const gtaUsable   = isGTAEnabled()  && !isGTALocked();
        const meltUsable  = isMeltUsable();
        const drugsUsable = isDrugsEnabled();

        const bgSpamSuppressed = state.killBgSpamEnabled && state.killBgSpamTarget && state.killBgCheckEnabled;

        // Comp mode — always go to drugs to buy 1 unit at a time, drive not needed yet
        if (drugsUsable && state.drugCompEnabled && !state.killLoopActive && !bgSpamSuppressed) {
            await wait(navRand());
            gotoPage('drugs');
            return;
        }

        if (drugsUsable && isInternalDriveReady() && !state.killLoopActive && !bgSpamSuppressed) {
            await wait(navRand());
            gotoPage('drugs');
            return;
        }

        if (gtaUsable && isInternalGTAReady()) {
            await wait(navRand());
            gotoPage('gta');
            return;
        }

        if (meltUsable && isInternalMeltReady()) {
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(navRand());
            gotoCleanMeltPage(1);
            return;
        }

        const crimeMs     = soonestCrimeTimerMs();
        const nextGtaMs   = gtaUsable   ? getInternalGTARemainingMs()   : null;
        const nextMeltMs  = meltUsable  ? getInternalMeltRemainingMs()  : null;
        const nextDriveMs = drugsUsable ? getInternalDriveRemainingMs() : null;

        const parts = [];
        if (crimeMs     != null && crimeMs     > 0) parts.push(`crimes ${Math.ceil(crimeMs     / 1000)}s`);
        if (nextGtaMs   != null && nextGtaMs   > 0) parts.push(`GTA ${Math.ceil(nextGtaMs     / 1000)}s`);
        if (nextMeltMs  != null && nextMeltMs  > 0) parts.push(`melt ${Math.ceil(nextMeltMs   / 1000)}s`);
        if (nextDriveMs != null && nextDriveMs > 0) parts.push(`drive ${Math.ceil(nextDriveMs / 1000)}s`);

        if (parts.length) {
            return;
        }
    }

    async function handleGTAPage() {
        stopJailObserver();

        if (isGTALocked()) {
            addLiveLog('GTA is rank-locked — returning to crimes');
            state.gtaResetLoopActive = false;
            state.resetGTAEnabled    = false;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Allow entry if GTA toggle is on OR if GTA reset loop is active
        if (!isGTAEnabled() && !state.gtaResetLoopActive) {
            addLiveLog('GTA disabled by user — returning to crimes');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Check bonus points on GTA page — header shows live balance, visited ~every 90s
        await maybeBuyBonusPerks();

        // CTC can appear on the GTA page after a reset — handle it before anything else.
        // Without this check the bot would see no Steal button and no reset button and
        // incorrectly treat it as a reset failure, exiting the loop.
        if (hasCTCChallenge()) {
            await maybeSolveCTC();
            return;
        }

        // If a GTA reset was performed on a previous load, the success message
        // will be present — log it and proceed straight to stealing
        if (hasGTAResetSuccess()) {
            addLiveLog('GTA reset confirmed — stealing immediately');
        }

        const didGTA = await doGTA();
        if (didGTA) {
            // In GTA reset loop mode, come straight back to GTA after stealing
            if (state.gtaResetLoopActive) {
                await wait(navRand());
                gotoPage('gta');
                return;
            }
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // GTA not ready — handle based on whether loop is active
        if (state.gtaResetLoopActive) {
            // Check points before resetting
            if (getPlayerPoints() < state.resetTimerMinPoints) {
                addLiveLog(`GTA reset loop: points dropped below threshold — exiting GTA reset loop, reverting to normal`);
                state.gtaResetLoopActive = false;
                state.resetGTAEnabled    = false;
                await wait(navRand());
                gotoPage('crimes');
                return;
            }

            const didReset = await tryGTAReset();
            if (didReset) {
                // Page will reload via POST — no further action needed
                return;
            }

            // Reset button not found — may be a timing issue, stay on page and retry
            addLiveLog('GTA reset loop: reset button not found — will retry next tick');
            return;
        }

        const synced = syncGTAReadyFromQuickLink();
        if (!synced) state.nextGTAReadyAt = now() + 15000;

        addLiveLog('GTA not ready yet — returning to crimes');
        if (await maybeVisitHumanPage()) return;
        await wait(navRand());
        gotoPage('crimes');
    }

    async function handleMeltPage() {
        stopJailObserver();
        protectMeltRows();

        if (isMeltLocked()) {
            addLiveLog('Melting is rank-locked — returning to crimes');
            resetMeltSearchState();
            clearPendingMeltResult();
            state.meltResetLoopActive = false;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (!isMeltEnabled() && !state.meltResetLoopActive) {
            addLiveLog('Melting disabled by user — returning to crimes');
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (hasCTCChallenge()) {
            await maybeSolveCTC();
            return;
        }

        // If a melt reset was performed on a previous load, note it
        if (hasMeltResetSuccess()) {
            addLiveLog('Melt reset confirmed');
        }

        const successBullets = getMeltSuccessBullets();
        if (successBullets != null) {
            const expectedBullets  = state.pendingMeltBullets;
            const confirmedBullets = successBullets;
            const meltLabel        = state.pendingMeltCarText || 'Melted car';

            state.meltsSinceRepair += 1;

            updateStats(s => {
                s.melts          += 1;
                s.bulletsReceived += confirmedBullets;
                s.lastActionText  = `Melt complete (+${confirmedBullets} bullets)`;
            });

            addLiveLog(`Melt success confirmed — ${meltLabel}, received ${confirmedBullets} bullets`);

            clearPendingMeltResult();
            resetMeltSearchState();

            // No melt reactivation needed — expectedFoundAt timer and search loop
            // handle kill loop activation when players become available

            // If we are in melt reset loop mode, handle repair then loop back
            if (state.meltResetLoopActive) {
                if (shouldRunRepairCycle()) {
                    addLiveLog(`Melt reset loop: repair threshold reached (${state.meltsSinceRepair}/${state.repairEveryMelts}) — going to cars`);
                    await wait(navRand());
                    gotoPage('cars', { page: 1 });
                    return;
                }

                // Check points before committing to the next loop iteration
                if (getPlayerPoints() < state.resetTimerMinPoints) {
                    addLiveLog(`Melt reset loop: points dropped below threshold — exiting melt reset loop, reverting to normal`);
                    state.meltResetLoopActive = false;
                    state.resetMeltEnabled    = false;
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }

                addLiveLog('Melt reset loop: melt complete — going back to melt page');
                await wait(navRand());
                gotoCleanMeltPage(1);
                return;
            }

            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (currentActionParam()) {
            addLiveLog(`Melt result URL detected (a=${currentActionParam()}) — reopening clean melt page`);
            resetMeltSearchState();
            await wait(rand(450, 900));
            gotoCleanMeltPage(currentPageNum());
            return;
        }

        const pagination = getMeltPaginationInfo();
        const candidates = getMeltCandidates();
        const candidate  = chooseBestMeltCandidate();

        if (candidate) {
            const didMelt = await doMelt();
            if (didMelt) return;
        }

        if (candidates.length === 0) {
            // In melt reset loop mode, if no cars are visible the melt is on
            // cooldown — try the reset button immediately before doing anything else.
            // Only paginate or exit if there genuinely is no reset button either.
            if (state.meltResetLoopActive) {
                const didReset = await tryMeltReset();
                if (didReset) {
                    // Page will reload via POST — no further action needed
                    return;
                }
                // Reset failed (not enough points) — exit loop
                addLiveLog('Melt reset loop: no cars and reset failed — exiting melt reset loop, reverting to normal');
                state.meltResetLoopActive = false;
                state.resetMeltEnabled    = false;
                resetMeltSearchState();
                clearPendingMeltResult();
                await wait(navRand());
                gotoPage('crimes');
                return;
            }

            // Normal mode — paginate and retry as before
            if (state.meltRecoveryCount < 1) {
                state.meltRecoveryCount += 1;
                addLiveLog(`Melt page ${pagination.page} empty/incomplete — retrying once`);
                await wait(rand(600, 1100));
                gotoCleanMeltPage(pagination.page);
                return;
            }

            if (pagination.hasNext) {
                resetMeltSearchState();
                addLiveLog(`Melt page ${pagination.page} still empty — checking page ${pagination.nextPage}`);
                await wait(navRand());
                gotoCleanMeltPage(pagination.nextPage);
                return;
            }

            // No meltable cars across all pages and not in reset loop — return to crimes
            addLiveLog(`No meltable cars found — returning to crimes`);
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        const protectedOnly = candidates.length > 0 && !candidate;

        if (protectedOnly && pagination.hasNext) {
            resetMeltSearchState();
            addLiveLog(`No safe meltable cars on page ${pagination.page} — checking page ${pagination.nextPage}`);
            await wait(navRand());
            gotoCleanMeltPage(pagination.nextPage);
            return;
        }

        if (protectedOnly) {
            // Only protected cars across all pages — exit melt reset loop
            addLiveLog('No safe meltable cars across checked pages — exiting melt reset loop, reverting to normal');
            state.meltResetLoopActive = false;
            state.resetMeltEnabled    = false;
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Melt is on cooldown — try reset if in loop mode
        if (state.meltResetLoopActive) {
            const didReset = await tryMeltReset();
            if (didReset) {
                // Page will reload via POST — no further action needed
                return;
            }

            // Reset failed (not enough points) — exit loop
            addLiveLog('Melt reset loop: points below threshold — exiting melt reset loop, reverting to normal');
            state.meltResetLoopActive = false;
            state.resetMeltEnabled    = false;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Normal cooldown handling — sync timer and return to crimes
        const synced = syncMeltReadyFromQuickLink();
        if (!synced) state.nextMeltReadyAt = now() + 15000;

        addLiveLog('Melt not ready yet — returning to crimes');
        resetMeltSearchState();
        clearPendingMeltResult();
        if (await maybeVisitHumanPage()) return;
        await wait(navRand());
        gotoPage('crimes');
    }

    // =========================================================================
    // KILL LOOP (BG CHECK + SHOOT)
    // =========================================================================

    // Handles the kill loop page — BG checking and shooting players.
    // This loop runs separately from the kill search loop.
    // Flow:
    //   1. Check kill penalty — if too high, pause kill loop
    //   2. For each alive player with BG check enabled and interval due:
    //      a. Travel to their country if needed
    //      b. Shoot 1 bullet (BG check)
    //      c. If bodyguard found: add BG to kill list, search them
    //      d. If no bodyguard AND shoot enabled: fetch profile, calc bullets, shoot
    //   3. If not enough bullets for a kill shot, pause kill loop (not BG check)
    async function handleKillLoopPage() {
        const pending = state.pendingKillAction;
        addDebugLog('kill-loop-page', `[DEBUG] handleKillLoopPage: pending=${JSON.stringify(pending)} | bulletRun=${JSON.stringify(state.pendingBulletRun)} | driveReady=${isInternalDriveReady()} | killLoopActive=${state.killLoopActive}`, 10000);

        // Handle pending travel — we've just arrived on a car page to drive somewhere
        // ── Stage: travel — on cars LIST page, find and navigate to best car ──
        if (pending && pending.stage === 'travel' && pending.travelTo) {
            // Wait for cars page DOM to fully load before searching for car links
            const carLinks = document.querySelectorAll('a[href*="?p=car&id="]');
            if (carLinks.length === 0) {
                // DOM not ready yet — wait and let tick retry
                await wait(rand(800, 1200));
                return;
            }
            // We should be on the cars list page — find best travel car and navigate to it
            const failedUrls = pending.failedCarUrls || [];
            const travelCarUrl = findBestTravelCarUrl(failedUrls);
            if (!travelCarUrl) {
                if (!isInternalDriveReady()) {
                    // Drive on cooldown — wait for it rather than abandoning
                    const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
                    addLiveLog(`Kill loop: no travel car available — drive not ready (${remaining}s), waiting`);
                    state.killSearchLoopActive = false;
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
                // Drive ready but no suitable car found — check if this is a BG Farm check
                // If so, retry after a delay rather than abandoning
                const isBgFarmTravel = pending.afterTravel?.stage === 'bg_farm_shoot' || pending.afterTravel?.stage === 'bgcheck';
                if (isBgFarmTravel) {
                    addLiveLog('Kill loop: no travel car found for BG Farm check — retrying in 30s');
                    state.killSearchLoopActive = false;
                    await wait(30000);
                    gotoPage('cars');
                    return;
                }
                addLiveLog('Kill loop: no suitable travel car found — clearing');
                state.pendingKillAction = null;
                state.killLoopActive    = false;
                await wait(navRand());
                gotoPage('crimes');
                return;
            }
            addLiveLog(`Kill loop: navigating to car detail page for ${pending.travelTo}`);
            state.pendingKillAction = { ...pending, stage: 'travel_car', travelCarUrl };
            navigateToUrl(travelCarUrl);
            return;
        }

        // ── Stage: travel_car — on car DETAIL page, repair if needed then drive ──
        if (pending && pending.stage === 'travel_car' && pending.travelTo) {
            const locationValue = getLocationValueForCountry(pending.travelTo);
            if (!locationValue) {
                addLiveLog(`Kill loop: invalid travel target "${pending.travelTo}" — clearing`);
                state.pendingKillAction = null;
                await wait(navRand());
                gotoPage('kill');
                return;
            }

            // Check if car was just repaired successfully
            const repairSuccess = document.querySelector('.bgm.cg');
            if (repairSuccess && /repaired your car/i.test(textOf(repairSuccess))) {
                addLiveLog('Kill loop: car repaired — now driving');
                // Fall through to drive logic below
            } else {
                // Check if car is too damaged to drive
                const allBglI = [...document.querySelectorAll('.tac.mb .bgl.i')];
                const driveSection = allBglI.find(el => /too much damage to drive/i.test(textOf(el)));
                const isDamaged = !!driveSection;

                if (isDamaged) {
                    // Repair the car first
                    const repairBtn = document.querySelector('form input[type="submit"][name="repair"]');
                    if (!repairBtn) {
                        addLiveLog('Kill loop: car damaged but no repair button — trying next car');
                        state.pendingKillAction = { ...pending, stage: 'travel' };
                        await wait(navRand());
                        gotoPage('cars');
                        return;
                    }
                    addLiveLog('Kill loop: car too damaged — repairing before travel');
                    state.lastActionAt = now();
                    await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
                    const freshRepair = document.querySelector('form input[type="submit"][name="repair"]');
                    if (freshRepair) humanClick(freshRepair);
                    return; // Page reloads — next tick handles post-repair
                }
            }

            // Check if drive is still on cooldown — the form won't be present if so
            if (!isInternalDriveReady()) {
                const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
                addLiveLog(`Kill loop: drive not ready yet (${remaining}s) — returning to crimes to wait`);
                // Keep pendingKillAction so we resume travel when drive is ready
                await wait(navRand());
                gotoPage('crimes');
                return;
            }

            // Drive form should be present — select destination using location radio button
            // Car detail page uses: input[name="location"][value="X"] and input[name="subm"][value="Go"]
            const locationRadio = document.querySelector(`form input[type="radio"][name="location"][value="${locationValue}"]`);
            const goBtn = document.querySelector('form input[type="submit"][name="subm"][value="Go"]');

            if (!locationRadio || !goBtn) {
                const failedAttempts = (pending.driveAttempts || 0) + 1;
                if (failedAttempts > 5) {
                    addLiveLog(`Kill loop: drive form not found after ${failedAttempts} attempts — abandoning travel to ${pending.travelTo}`);
                    state.pendingKillAction = null;
                    state.nextDriveReadyAt  = now() + 15000;
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
                addLiveLog('Kill loop: drive form not found on car detail page — trying a different car');
                // Track this car URL as failed so findBestTravelCarUrl skips it
                const failedUrls = [...(pending.failedCarUrls || []), pending.travelCarUrl].filter(Boolean);
                state.pendingKillAction = { ...pending, travelCarUrl: null, stage: 'travel', driveAttempts: failedAttempts, failedCarUrls: failedUrls };
                state.nextDriveReadyAt = now() + 2000;
                await wait(navRand());
                gotoPage('cars');
                return;
            }

            state.lastActionAt = now();
            await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

            const freshRadio = document.querySelector(`form input[type="radio"][name="location"][value="${locationValue}"]`);
            const freshGo    = document.querySelector('form input[type="submit"][name="subm"][value="Go"]');
            if (!freshRadio || !freshGo) return;

            // Increment drive attempts — if stuck too many times, abandon this travel
            const attempts = (pending.driveAttempts || 0) + 1;
            if (attempts > 5) {
                addLiveLog(`Kill loop: drive to ${pending.travelTo} failed after ${attempts} attempts — abandoning`);
                state.pendingKillAction = null;
                state.nextDriveReadyAt  = now() + 15000;
                await wait(navRand());
                gotoPage('kill');
                return;
            }
            freshRadio.checked = true;
            freshRadio.dispatchEvent(new Event('change', { bubbles: true }));
            state.nextDriveReadyAt = now() + 60000;
            // Set the post-travel action BEFORE clicking — humanClick may trigger an
            // immediate form submit/navigation, and GM_setValue must land first or
            // the continuation (e.g. bg_shoot with bgVerified) gets lost.
            if (pending.afterTravel) {
                state.pendingKillAction = { ...pending.afterTravel };
            } else if (pending.killOnly) {
                // We travelled for a kill-only target; continue with the full kill shot,
                // not a 1-bullet BG check. BG-checkable targets use explicit afterTravel stages.
                state.pendingKillAction = { stage: 'fetch_profile', targetName: pending.targetName, bgFor: pending.bgFor || null };
            } else {
                state.pendingKillAction = { stage: 'bgcheck', targetName: pending.targetName, shootAfterBg: pending.shootAfterBg, deferred: pending.deferred };
            }
            humanClick(freshGo);
            addLiveLog(`Kill loop: driving to ${pending.travelTo} (attempt ${attempts})`);
            return;
        }

        // Must be on kill page for BG check/shoot
        if (!isKillPage()) {
            gotoPage('kill');
            return;
        }

        // Always process any pending search result first — even during kill loop
        // This ensures protected/dead players found via search loop get properly handled
        if (!killSearchResultHandledThisLoad && state.killCurrentSearch) {
            const cur = state.killCurrentSearch;
            addLiveLog(`Kill loop: processing pending search result for ${cur}`);
            if (hasKillProtectedMessage()) {
                killSearchResultHandledThisLoad = true;
                updateKillPlayerStatus(cur, KILL_STATUS.PROTECTED);
                addLiveLog(`Kill scanner: ${cur} is protected`);
                state.killCurrentSearch = '';
                clearKillSearchSubmitTracking();
                renderKillList();
            } else if (hasKillDeadMessage()) {
                killSearchResultHandledThisLoad = true;
                const _deadPlayers = state.killPlayers || [];
                const _deadEntry = _deadPlayers.find(p => p.name.toLowerCase() === cur.toLowerCase());
                const _deadBgFor = _deadEntry?.bgFor || null;
                updateKillPlayerStatus(cur, KILL_STATUS.DEAD);
                state.killCurrentSearch = '';
                clearKillSearchSubmitTracking();
                renderKillList();
                if (_deadBgFor && isPlayerBgFarmEnabled(_deadBgFor)) {
                    addLiveLog(`Kill scanner: ${cur} was BG for ${_deadBgFor} — BG Farm checking ${_deadBgFor}`);
                    queueBgFarmCheck(_deadBgFor, isPlayerShootEnabled(_deadBgFor));
                }
            } else if (hasKillSearchStartedMessage()) {
                killSearchResultHandledThisLoad = true;
                updateKillPlayerStatus(cur, KILL_STATUS.ALIVE);
                addLiveLog(`Kill scanner: ${cur} — search started`);
                state.killCurrentSearch = '';
                clearKillSearchSubmitTracking();
                renderKillList();
            } else {
                // Check pending section for post-CTC confirmation
                const nowSearching = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')]
                    .some(el => textOf(el).toLowerCase() === cur.toLowerCase());
                if (nowSearching) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(cur, KILL_STATUS.ALIVE);
                    addLiveLog(`Kill scanner: ${cur} — search confirmed (post-CTC)`);
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    renderKillList();
                } else {
                    // No result message and not in pending section — stale search, clear it
                    addLiveLog(`Kill scanner: ${cur} — no search result found, clearing`);
                    killSearchResultHandledThisLoad = true;
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                }
            }
            // After processing any search result, return to crimes — don't fall through.
            // Do not cancel an already queued kill/BG state; the next tick will resume it.
            if (killSearchResultHandledThisLoad) {
                const pa = state.pendingKillAction;
                const keepStages = ['bg_shoot','bg_farm_check','bg_farm_shoot','bg_farm_result','bgcheck','bgcheck_deferred','fetch_profile','travel','travel_car','shoot_result'];
                if (pa && keepStages.includes(pa.stage)) {
                    state.killLoopActive = true;
                    state.killBgWaitUntil = 0;
                } else {
                    state.killLoopActive = false;
                }
                await wait(navRand());
                gotoPage('crimes');
                return;
            }
        }

        // If penalty was being tracked and has changed, recalculate penaltyDropsAt
        if (state.penaltyDropsAt === 0 && isKillPenaltyTooHigh() && !state.pendingPenaltyPage) {
            // Penalty still too high after timer fired — recalculate
            state.pendingPenaltyPage = true;
            await wait(navRand());
            gotoPage('kill-penalty');
            return;
        }

        // Startup: on kill page for penalty reading — navigate to penalty page
        if (state.killPenaltyThreshold > 0 &&
            !state.penaltyDropsAt && !state.pendingPenaltyPage && isKillPenaltyTooHigh()) {
            state.pendingPenaltyPage = true;
            await wait(navRand());
            gotoPage('kill-penalty');
            return;
        }

        // Sync expiry data from kill page — skip if already mid bg_shoot sequence
        // to prevent re-queuing the shoot on every visit
        const pendingBgShoot = state.pendingKillAction?.stage === 'bg_shoot';
        if (!pendingBgShoot) syncKillExpiryFromPage(true);

        // Re-read pendingKillAction — syncKillExpiryFromPage may have queued a bg_shoot
        const pendingAfterSync = state.pendingKillAction;

        // If penalty exceeds threshold and penaltyDropsAt not set, trigger penalty page
        const livePenalty = getKillPenaltyMultiplier();
        const cached = Number(getSetting('cachedKillPenalty', 1.0));
        if (state.killPenaltyThreshold > 0 && !state.pendingPenaltyPage) {
            const penaltyTooHigh = livePenalty >= state.killPenaltyThreshold;
            const penaltyChanged = Math.abs(livePenalty - cached) >= 0.05;
            const needsCalc = !state.penaltyDropsAt || penaltyChanged;
            if (penaltyTooHigh && needsCalc) {
                const reason = penaltyChanged ? `penalty changed (${cached}x → ${livePenalty}x)` : `penalty ${livePenalty}x exceeds threshold`;
                addLiveLog(`Kill loop: ${reason} — navigating to penalty page`);
                state.pendingPenaltyPage = true;
                await wait(navRand());
                gotoPage('kill-penalty');
                return;
            }
        }

        // Check for kill penalty threshold
        // If penalty too high, navigate to penalty page if not yet calculated
        // BG checks are still allowed — only actual kills are blocked
        if (isKillPenaltyTooHigh() && !state.penaltyDropsAt && !state.pendingPenaltyPage) {
            const mult = getKillPenaltyMultiplier();
            addLiveLog(`Kill loop: penalty ${mult}x exceeds threshold — navigating to penalty page`);
            state.pendingPenaltyPage = true;
            await wait(navRand());
            gotoPage('kill-penalty');
            return;
        }


        // Resume a profile-fetch kill stage if the page reloaded after it was queued.
        if (pending && pending.stage === 'fetch_profile') {
            await doKillShootFlow(pending.targetName, pending.bgFor || null);
            return;
        }

        // Handle forced 1-bullet BG checks used by BG Farm.
        if (pending && pending.stage === 'bg_farm_check') {
            const target = pending.targetName;

            // BG checks are 1-bullet probes and are allowed even if the kill penalty is too high.
            // Full kill shots are blocked later by doKillShootFlow/bg_shoot.
            addLiveLog(`Kill loop: BG Farm — checking ${target} for next BG`);

            // Check if target is already in Players Found on this page
            const foundEl = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .find(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === target.toLowerCase(); } catch(_){ return false; } });

            if (foundEl) {
                // Target already found — need 1 bullet, travel to their country if needed
                const targetPlayer = (state.killPlayers || []).find(p => p.name.toLowerCase() === target.toLowerCase());
                const targetCountry = targetPlayer?.country;
                const myCountry = document.querySelector('#player-location')?.textContent.trim();
                addDebugLog(`bg-farm-check:${target}`, `[DEBUG] bg_farm_check: target=${target} targetCountry=${targetCountry} myCountry=${myCountry} afterVerify=${JSON.stringify(pending.afterVerify)}`, 10000);

                if (targetCountry && targetCountry !== myCountry) {
                    // Need to travel first
                    addLiveLog(`Kill loop: BG Farm — travelling to ${targetCountry} to 1-bullet check ${target}`);
                    state.pendingKillAction = {
                        stage:       'travel',
                        travelTo:    targetCountry,
                        targetName:  target,
                        shootAfterBg: pending.shootAfterBg,
                        afterTravel: { stage: 'bg_farm_shoot', targetName: target, shootAfterBg: pending.shootAfterBg, afterVerify: pending.afterVerify, bgFor: pending.bgFor || null }
                    };
                } else {
                    state.pendingKillAction = { stage: 'bg_farm_shoot', targetName: target, shootAfterBg: pending.shootAfterBg, afterVerify: pending.afterVerify, bgFor: pending.bgFor || null };
                }
            } else {
                // Check if already being searched
                const searchingEl = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')]
                    .find(b => b.textContent.trim().toLowerCase() === target.toLowerCase());

                if (searchingEl) {
                    // Already being searched — read remaining time, store per-player
                    const timerSpan = searchingEl.closest('.bgm.chs.pd')?.querySelector('.chd');
                    const foundInMs = timerSpan ? parseLostInMs(textOf(timerSpan)) : null;
                    const waitMins  = foundInMs != null ? Math.ceil(foundInMs / 60000) : '?';
                    addLiveLog(`Kill loop: BG Farm — ${target} being searched, found in ~${waitMins}m — waiting`);
                    const pl  = state.killPlayers || [];
                    const idx = pl.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                    if (idx !== -1) {
                        if (foundInMs != null) {
                            pl[idx].pendingSearch = true;
                            pl[idx].expectedFoundAt = now() + foundInMs;
                            pl[idx].bgFarmWaitUntil = now() + foundInMs + (5 * 60 * 1000);
                        }
                        pl[idx].lastBgCheck = now(); // mark as checked so interval resets
                        saveKillPlayers(pl);
                    }
                    // Don't deactivate kill loop — continue to next due player
                    state.pendingKillAction = null;
                } else {
                    // Not being searched — initiate 24-hour search
                    addLiveLog(`Kill loop: BG Farm — searching ${target} for 24 hours`);
                    const searchForm = document.querySelector('form input[name="do"][value="search"]');
                    if (searchForm) {
                        const form    = searchForm.closest('form');
                        const nameInput = form?.querySelector('input[name="username"]');
                        const hoursInput = form?.querySelector('input[name="hours"]');
                        if (nameInput && hoursInput) {
                            nameInput.value  = target;
                            hoursInput.value = '24';
                            state.killCurrentSearch    = target;
                            state.killSearchLoopActive = true;
                            state.killLoopActive       = false;
                            state.lastActionAt         = now();
                            form.querySelector('input[type="submit"]')?.click();
                        }
                    }
                }
            }
            await wait(navRand());
            gotoPage('kill');
            return;
        }

        // Handle the actual 1-bullet shot during BG Farm
        if (pending && pending.stage === 'bg_farm_shoot') {
            const target = pending.targetName;

            // BG checks are 1-bullet probes and are allowed even if the kill penalty is too high.
            addLiveLog(`Kill loop: BG Farm — shooting ${target} with 1 bullet to check for BG`);

            // Need at least 1 bullet
            if (getPlayerBullets() < 1) {
                addLiveLog(`Kill loop: BG Farm — waiting for bullets to check ${target}`);
                await wait(navRand());
                gotoPage('kill');
                return;
            }

            const killForm = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="do"][value="kill"]'));
            if (killForm) {
                const usernameSelect = killForm.querySelector('select[name="username"]');
                const bulletsInput   = killForm.querySelector('input[name="bullets"]');
                const showCheckbox   = killForm.querySelector('input[name="show"]');
                const submitBtn      = killForm.querySelector('input[type="submit"][value="Shoot"]');
                if (usernameSelect && bulletsInput && submitBtn) {
                    const targetOption = [...usernameSelect.options].find(o =>
                        o.value.toLowerCase() === target.toLowerCase() ||
                        o.text.toLowerCase() === target.toLowerCase()
                    );
                    if (!targetOption) {
                        addLiveLog(`Kill loop: BG Farm — ${target} not in kill dropdown — may have moved, retrying`);
                        state.pendingKillAction = null;
                        await wait(navRand());
                        gotoPage('kill');
                        return;
                    }
                    usernameSelect.value = target;
                    bulletsInput.value   = '1';
                    if (showCheckbox) showCheckbox.checked = !state.killAnonymousShooting;
                    state.pendingKillAction = { stage: 'bg_farm_result', targetName: target, shootAfterBg: pending.shootAfterBg, afterVerify: pending.afterVerify, bgFor: pending.bgFor || null };
                    state.lastActionAt = now();
                    humanClick(submitBtn);
                    return;
                }
            }
            addLiveLog(`Kill loop: BG Farm — shoot form not found for ${target}`);
            state.pendingKillAction = null;
            await wait(navRand());
            gotoPage('kill');
            return;
        }

        // Handle result of BG Farm 1-bullet shot
        if (pending && pending.stage === 'bg_farm_result') {
            const target = pending.targetName;
            const failEl = document.querySelector('.bgm.fail');
            const credEl = [...document.querySelectorAll('.bgm.cred')].find(el => /failed to kill/i.test(textOf(el))) || null;

            if (failEl && /has a bodyguard called/i.test(textOf(failEl))) {
                // New BG found — extract name and search them
                const bgMatch = textOf(failEl).match(/has a bodyguard called\s+(.+?)!/i);
                const bgName  = bgMatch ? bgMatch[1].trim() : null;
                if (bgName) {
                    addLiveLog(`Kill loop: BG Farm — ${target} has new BG ${bgName} — searching them`);
                    const players = state.killPlayers || [];
                    const tIdx    = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());

                    // This fresh 1-bullet check is the source of truth. Clear every
                    // other stored BG relation for this original target before moving on.
                    const oldBg = tIdx !== -1 ? players[tIdx].bodyguard : null;
                    if (oldBg && oldBg.toLowerCase() !== bgName.toLowerCase()) {
                        addLiveLog(`Kill loop: BG Farm — ${target} swapped BG from ${oldBg} to ${bgName} — clearing stale BG state`);
                    }
                    clearStaleBgRelationsForOwner(target, bgName, `fresh check found ${bgName}`);

                    const expectedVerifiedBg = pending.afterVerify?.targetName || null;
                    if (expectedVerifiedBg && expectedVerifiedBg.toLowerCase() !== bgName.toLowerCase()) {
                        clearStaleBgRelation(expectedVerifiedBg, target, `fresh verify found ${bgName} instead`);
                    }

                    if (tIdx !== -1) { players[tIdx].bodyguard = bgName; saveKillPlayers(players); }

                    // Add BG to kill list if not already there
                    const bgIdx = players.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());
                    if (bgIdx === -1) {
                        players.push({ name: bgName, status: KILL_STATUS.UNKNOWN, isBg: true, bgFor: target });
                    } else {
                        players[bgIdx].isBg  = true;
                        players[bgIdx].bgFor = target;
                    }
                    saveKillPlayers(players);
                    renderKillList();

                    // Only search if not already found or being searched
                    const alreadyFound = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                        .some(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === bgName.toLowerCase(); } catch(_){ return false; } });
                    const searchingRow = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd')]
                        .find(row => { const b = row.querySelector('b'); return b && textOf(b).toLowerCase() === bgName.toLowerCase(); });

                    if (alreadyFound) {
                        // This 1-bullet BG Farm check just verified that target currently has this BG.
                        // Mark this one BG shot as approved by the fresh original-target check.
                        const verifiedActionBase = pending.afterVerify &&
                            pending.afterVerify.targetName &&
                            pending.afterVerify.targetName.toLowerCase() === bgName.toLowerCase()
                            ? { ...pending.afterVerify, shootAfterBg: isPlayerShootEnabled(target) }
                            : { stage: 'bg_shoot', targetName: bgName, bgFor: target, shootAfterBg: isPlayerShootEnabled(target) };
                        const verifiedAction = markImmediateBgFarmVerification(verifiedActionBase, target, bgName);
                        addLiveLog(`Kill loop: BG Farm — ${bgName} already found and verified as ${target}'s BG — queuing immediate BG kill`);
                        state.pendingKillAction = verifiedAction;
                        state.killLoopActive    = true;
                        state.killSearchLoopActive = false;
                    } else if (searchingRow) {
                        // Already being searched — store wait per-player, not globally
                        const timerSpan = searchingRow.querySelector('.chd');
                        const foundInMs = timerSpan ? parseLostInMs(textOf(timerSpan)) : null;
                        const waitMins  = foundInMs != null ? Math.ceil(foundInMs / 60000) : '?';
                        addLiveLog(`Kill loop: BG Farm — ${bgName} already being searched, found in ~${waitMins}m — waiting`);
                        const pl  = state.killPlayers || [];
                        const idx = pl.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                        const bgIdxWait = pl.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());
                        if (idx !== -1) {
                            // Keep the BG Farm interval alive while this BG is being searched.
                            // The interval should re-check the original target in case they swap BG.
                            pl[idx].lastBgCheck = now();
                            if (foundInMs != null) pl[idx].bgFarmWaitUntil = now() + foundInMs + (5 * 60 * 1000);
                        }
                        if (bgIdxWait !== -1 && foundInMs != null) {
                            pl[bgIdxWait].pendingSearch = true;
                            pl[bgIdxWait].expectedFoundAt = now() + foundInMs;
                        }
                        if (idx !== -1) { delete pl[idx].bgVerifyInFlight; }
                        if (idx !== -1 || bgIdxWait !== -1) saveKillPlayers(pl);
                        state.pendingKillAction    = null;
                        state.killSearchLoopActive = true;
                        state.killLoopActive       = false;
                    } else {
                        // Not found or searching — add as UNKNOWN so kill scanner searches them
                        addLiveLog(`Kill loop: BG Farm — ${bgName} added as unknown — kill scanner will search them`);
                        const pl2  = state.killPlayers || [];
                        const bIdx2 = pl2.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());
                        if (bIdx2 === -1) {
                            pl2.push({ name: bgName, status: KILL_STATUS.UNKNOWN, isBg: true, bgFor: target });
                        } else {
                            pl2[bIdx2].status = KILL_STATUS.UNKNOWN;
                            pl2[bIdx2].isBg   = true;
                            pl2[bIdx2].bgFor  = target;
                        }
                        const tIdx2 = pl2.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                        if (tIdx2 !== -1) {
                            // Reset the normal BG Farm interval from this confirmed check,
                            // but do not suppress future interval checks for the full BG search time.
                            pl2[tIdx2].lastBgCheck = now();
                            delete pl2[tIdx2].bgFarmWaitUntil;
                            delete pl2[tIdx2].bgVerifyInFlight;
                        }
                        saveKillPlayers(pl2);
                        state.pendingKillAction    = null;
                        state.killSearchLoopActive = true;
                        state.killLoopActive       = false;
                        state.killBgWaitUntil      = 0;
                    }
                }
            } else if (credEl) {
                // No BG — target is unprotected. This fresh check clears every stored
                // bodyguard relation for the original target, including old/stale BGs.
                clearStaleBgRelationsForOwner(target, null, 'fresh check found no BG');
                if (pending.afterVerify) {
                    addLiveLog(`Kill loop: BG Farm — ${target} no longer has BG ${pending.afterVerify.targetName} — aborting shot`);
                    const pl  = state.killPlayers || [];
                    const idx = pl.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                    if (idx !== -1) { delete pl[idx].bodyguard; delete pl[idx].bgVerifyInFlight; pl[idx].lastBgCheck = now(); saveKillPlayers(pl); }
                    if (shouldKillAfterCleanBgCheck(target)) {
                        addLiveLog(`Kill loop: BG Farm — clean check, Kill is still enabled — proceeding to kill ${target}`);
                        state.pendingKillAction = { stage: 'fetch_profile', targetName: target, bgFor: pending.bgFor || null };
                        await doKillShootFlow(target, pending.bgFor || null);
                        return;
                    } else {
                        addLiveLog(`Kill loop: BG Farm — waiting for ${target} to get a new BG`);
                        state.pendingKillAction = null;
                    }
                } else if (shouldKillAfterCleanBgCheck(target)) {
                    // Clean target: kill only if Kill is currently ticked for this player.
                    addLiveLog(`Kill loop: BG Farm — ${target} has no BG`);
                    addLiveLog(`Kill loop: BG Farm — Kill is enabled, proceeding to kill clean target ${target}`);
                    state.pendingKillAction = { stage: 'fetch_profile', targetName: target, bgFor: pending.bgFor || null };
                    await doKillShootFlow(target, pending.bgFor || null);
                    return;
                } else {
                    // BG Farm only — log and wait for them to get a new BG
                    addLiveLog(`Kill loop: BG Farm — ${target} has no BG, waiting for next BG check interval`);
                    // Update lastBgCheck so interval applies
                    const pl  = state.killPlayers || [];
                    const idx = pl.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                    if (idx !== -1) { pl[idx].lastBgCheck = now(); saveKillPlayers(pl); }
                    state.pendingKillAction = null;
                }
            } else {
                const retries = (pending.unexpectedRetries || 0) + 1;
                if (retries <= 3) {
                    addLiveLog(`Kill loop: BG Farm — unexpected result for ${target}, retrying (${retries}/3)`);
                    // Re-stay on kill page and re-check the result rather than discarding
                    // the chain — the result message may just not have rendered yet.
                    state.pendingKillAction = { ...pending, unexpectedRetries: retries };
                    await wait(rand(800, 1500));
                    return;
                }
                addLiveLog(`Kill loop: BG Farm — unexpected result for ${target} after ${retries} attempts, giving up`);
                state.pendingKillAction = null;
            }
            // Check if there are more BG Farm players due for a check — if so keep kill loop active
            if (!state.killLoopActive && !state.pendingKillAction) {
                const _allPlayers = state.killPlayers || [];
                const _nowMs = now();
                const _moreDue = _allPlayers.some(p => {
                    if (p.status !== KILL_STATUS.ALIVE) return false;
                    if (!isPlayerBgFarmEnabled(p.name)) return false;
                    if (getBgCheckDueMs(p) > 0) return false;
                    // If the original BG Farm target itself is still in the
                    // game's pending search queue, there is no 1-bullet BG
                    // check to perform yet. Do not immediately re-arm the
                    // generic bgcheck state and starve the normal search loop.
                    if (!p.bodyguard && (p.pendingSearch || (p.expectedFoundAt && p.expectedFoundAt > _nowMs))) return false;
                    return true;
                });
                if (_moreDue) {
                    state.killLoopActive   = true;
                    state.killBgSpamPaused = true;
                    state.pendingKillAction = { stage: 'bgcheck' };
                }
            }
            await wait(navRand());
            gotoPage('kill');
            return;
        }

        // Handle result of a previous shoot action
        if (pending && pending.stage === 'shoot_result') {
            const target = pending.targetName;
            // Check page for shoot result messages
            const failEl    = document.querySelector('.bgm.fail');
            const successEl  = document.querySelector('.bgm.success, .bgm.cg') ||
                               [...document.querySelectorAll('.bgm')].find(el => /you killed/i.test(textOf(el))) || null;
            // Check ALL .bgm.cred elements — active bodyguards produce multiple cred divs
            const credEls    = [...document.querySelectorAll('.bgm.cred')];
            const credEl     = credEls.find(el => /failed to kill/i.test(textOf(el))) || null;

            if (failEl) {
                const text = textOf(failEl);
                const bgMatch = text.match(/has a bodyguard called/i);
                if (bgMatch) {
                    // Extract bodyguard name from links
                    const links = [...failEl.querySelectorAll('a[href*="?p=profile&u="]')];
                    let bgName = '';
                    if (links.length >= 2) {
                        try {
                            const url = new URL(links[1].getAttribute('href'), window.location.href);
                            bgName = url.searchParams.get('u') || '';
                        } catch (_) {}
                    }

                    if (bgName) {
                        addLiveLog(`Kill loop: ${target} has bodyguard ${bgName}`);
                        // This BG-check result is fresh source-of-truth for this original target.
                        // Clear any old/stale BG links for the same owner before storing the current BG.
                        clearStaleBgRelationsForOwner(target, bgName, `fresh check found ${bgName}`);
                        const players = state.killPlayers || [];
                        const existingIdx = players.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());

                        if (existingIdx === -1) {
                            // Not in list — add as unknown, trigger search
                            players.push({
                                name:        bgName,
                                status:      KILL_STATUS.UNKNOWN,
                                lastChecked: 0,
                                firstSeen:   now(),
                                searchCount: 0,
                                isBg:        true,
                                bgFor:       target
                            });
                            addLiveLog(`Kill loop: added ${bgName} to search list as bodyguard for ${target} — searching immediately`);
                            // Set lastBgCheck on target so it won't be re-BG checked immediately
                            const tIdxImm = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                            if (tIdxImm !== -1) { players[tIdxImm].bodyguard = bgName; players[tIdxImm].lastBgCheck = now(); }
                            saveKillPlayers(players);
                            renderKillList();
                            // Search the bodyguard immediately using the kill page search form
                            const searchForm = document.querySelector('form input[name="do"][value="search"]');
                            const searchParent = searchForm ? searchForm.closest('form') : null;
                            if (searchParent) {
                                const usernameInput = searchParent.querySelector('input[name="username"]');
                                const hoursInput    = searchParent.querySelector('input[name="hours"]');
                                const submitBtn     = searchParent.querySelector('input[type="submit"][value="Search"]');
                                if (usernameInput && submitBtn) {
                                    usernameInput.value = bgName;
                                    if (hoursInput) hoursInput.value = '24';
                                    state.killCurrentSearch = bgName;
                                    state.pendingKillAction = null;
                                    state.killLoopActive    = false;
                                    // Non-BG-Farm targets can wait for the BG search to resolve.
                                    // BG Farm targets must keep re-checking on their interval in case the BG changes.
                                    state.killBgWaitUntil   = isPlayerBgFarmEnabled(target) ? 0 : now() + (3 * 60 * 60 * 1000); // max search time ~3hrs
                                    state.lastActionAt = now();
                                    await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
                                    humanClick(submitBtn);
                                    addLiveLog(`Kill loop: search submitted for bodyguard ${bgName}`);
                                    return;
                                }
                            }
                            // Fallback: let search loop handle it
                            state.killSearchLoopActive = true;
                        } else {
                            // Already in list — flag as BG and handle based on status
                            players[existingIdx].isBg  = true;
                            players[existingIdx].bgFor = target;

                            // Check if bodyguard is actually in Players Found (not just pending search)
                            const bgInPlayersFound = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                                .some(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === bgName.toLowerCase(); } catch(_){ return false; } });

                            if (bgInPlayersFound) {
                                // Already found — immediately queue shoot of bodyguard
                                addLiveLog(`Kill loop: ${bgName} already found — queuing immediate shoot`);
                                saveKillPlayers(players);
                                // Store bodyguard on target
                                const tIdx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                                if (tIdx !== -1) { players[tIdx].bodyguard = bgName; players[tIdx].lastBgCheck = now(); }
                                saveKillPlayers(players);
                                renderKillList();
                                // Trigger BG shoot flow directly
                                state.pendingKillAction = markImmediateBgFarmVerification({
                                    stage:       'bg_shoot',
                                    targetName:  bgName,
                                    bgFor:       target,
                                    shootAfterBg: isPlayerShootEnabled(target)
                                }, target, bgName);
                                await wait(navRand());
                                gotoPage('kill');
                                return;
                            } else {
                                // Still searching (pending) — let search loop find them, then shoot.
                                // Use expectedFoundAt / visible pending timer, not searchExpiresAt;
                                // searchExpiresAt may still be the 24h placeholder from search submission.
                                const searchReadyAt = getPendingSearchExpectedAt(bgName);
                                const waitMins = Math.max(0, Math.round((searchReadyAt - now()) / 60000));
                                addLiveLog(`Kill loop: ${bgName} already being searched, found in ~${waitMins}m — waiting`);
                                state.killSearchLoopActive = true;
                                state.killLoopActive       = false;
                                state.killBgWaitUntil      = isPlayerBgFarmEnabled(target) ? 0 : searchReadyAt;
                            }
                        }

                        // Store bodyguard on target player
                        const tIdx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                        if (tIdx !== -1) { players[tIdx].bodyguard = bgName; players[tIdx].lastBgCheck = now(); }
                        saveKillPlayers(players);
                        renderKillList();
                    }
                    state.pendingKillAction = null;
                    state.killBgSpamPaused  = false; // resume spam — kill loop done
                    // Go to crimes — kill loop is paused until BG search resolves
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }

                if (/that player is dead/i.test(text)) {
                    addLiveLog(`Kill loop: ${target} is dead — removing from list`);
                    updateKillPlayerStatus(target, KILL_STATUS.DEAD);
                    // Clear from deferred list so loop doesn't keep trying them
                    const deferred2 = pending.deferred || [];
                    const newDeferred2 = deferred2.filter(n => n !== target.toLowerCase());
                    state.pendingKillAction = newDeferred2.length ? { stage: 'bgcheck_deferred', deferred: newDeferred2 } : null;
                    renderKillList();
                    await wait(navRand());
                    gotoPage('kill');
                    return;
                }

                if (/is protected from death/i.test(text)) {
                    addLiveLog(`Kill loop: ${target} is protected`);
                    updateKillPlayerStatus(target, KILL_STATUS.PROTECTED);
                    state.pendingKillAction = null;
                    renderKillList();
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }

                if (/cannot be killed/i.test(text)) {
                    addLiveLog(`Kill loop: ${target} cannot be killed`);
                    updateKillPlayerStatus(target, KILL_STATUS.UNKILLABLE);
                    state.pendingKillAction = null;
                    renderKillList();
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
            }

            if (credEl && /failed to kill/i.test(textOf(credEl))) {
                // No bodyguard — BG check complete
                const tName = pending.targetName;
                addLiveLog(`Kill loop: ${tName} has no bodyguard`);
                // This no-BG result is fresh source-of-truth for this original target.
                // Clear every stored/deferred BG relation for the target, including old multi-day stale BGs.
                clearStaleBgRelationsForOwner(tName, null, 'fresh check found no BG');
                // Update lastBgCheck
                const players = state.killPlayers || [];
                const idx = players.findIndex(p => p.name.toLowerCase() === tName.toLowerCase());
                if (idx !== -1) {
                    players[idx].lastBgCheck = now();
                    players[idx].bodyguard   = null;
                    delete players[idx].bgVerifyInFlight;
                    saveKillPlayers(players);
                }

                // If shoot toggle is on for this player, proceed to shoot
                if (pendingNow.shootAfterBg && isPlayerShootEnabled(tName)) {
                    addLiveLog(`Kill loop: no BG on ${tName} — Kill is still enabled, fetching profile for bullet calc`);
                    const _cleanEntry = (state.killPlayers || []).find(p => p.name.toLowerCase() === tName.toLowerCase());
                    const _cleanBgFor = _cleanEntry?.isBg ? (_cleanEntry.bgFor || null) : null;
                    state.pendingKillAction = { stage: 'fetch_profile', targetName: tName, bgFor: _cleanBgFor };
                    // Stay on kill page — profile fetch is async
                    await doKillShootFlow(tName, _cleanBgFor);
                    return;
                }

                state.pendingKillAction = null;
                // Check if there are more actionable targets before going to kill page
                // If none, exit loop directly to avoid an unnecessary kill page trip
                const morePlayers = getKillPlayers().filter(p => {
                    if (p.status !== KILL_STATUS.ALIVE && p.status !== KILL_STATUS.UNKNOWN) return false;
                    if (isBgCheckable(p.name) && getBgCheckDueMs(p) <= 0) return true;
                    if (!isPlayerShootEnabled(p.name)) return false;
                    if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) return false;
                    if (isBgCheckable(p.name) && getBgCheckDueMs(p) > 0) return true;
                    if (!isBgCheckable(p.name)) return true;
                    return false;
                });
                if (!morePlayers.length) {
                    addLiveLog('Kill loop: no more targets — reverting to normal script');
                    await resumeBgSpamAfterCheck();
                    return;
                }
                await wait(navRand());
                gotoPage(morePlayers.length ? 'kill' : 'crimes');
                return;
            }

            if (successEl && /you killed/i.test(textOf(successEl))) {
                addLiveLog(`Kill loop: ${target} killed successfully!`);
                updateStats(s => { s.lastActionText = `Killed ${target}`; });
                // Clear stored bullet requirement — no longer needed
                const plsK = state.killPlayers || [];
                const pIdxK = plsK.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                if (pIdxK !== -1) { delete plsK[pIdxK].requiredBullets; saveKillPlayers(plsK); }

                // Check if this was a bodyguard kill — capture BEFORE status update removes the player
                const players = state.killPlayers || [];
                const tIdx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                const wasBg = tIdx !== -1 && players[tIdx].isBg;
                const bgFor = wasBg ? players[tIdx].bgFor : (state.pendingKillAction?.bgFor || null);

                // Clear bgShootQueued flag — player is dead
                const plsDead = state.killPlayers || [];
                const deadIdx = plsDead.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                if (deadIdx !== -1 && plsDead[deadIdx].bgShootQueued) { delete plsDead[deadIdx].bgShootQueued; saveKillPlayers(plsDead); }
                updateKillPlayerStatus(target, KILL_STATUS.DEAD);
                renderKillList();

                if ((wasBg || bgFor) && bgFor) {
                    const bgForPlayer = (state.killPlayers || []).find(p => p.name.toLowerCase() === bgFor.toLowerCase());
                    // Clear bodyguard from original target
                    const bgForIdx = (state.killPlayers || []).findIndex(p => p.name.toLowerCase() === bgFor.toLowerCase());
                    if (bgForIdx !== -1) {
                        const pl = state.killPlayers || [];
                        pl[bgForIdx].bodyguard = null;
                        saveKillPlayers(pl);
                    }

                    if (isPlayerBgFarmEnabled(bgFor)) {
                        // Clear per-player farm wait — we're now acting on the original target again
                        const plFarm = state.killPlayers || [];
                        const farmIdx = plFarm.findIndex(p => p.name.toLowerCase() === bgFor.toLowerCase());
                        if (farmIdx !== -1 && plFarm[farmIdx].bgFarmWaitUntil) {
                            delete plFarm[farmIdx].bgFarmWaitUntil;
                            saveKillPlayers(plFarm);
                        }
                        // BG Farm — after a BG dies, 1-bullet check the original target again.
                        addLiveLog(`Kill loop: ${target} was BG for ${bgFor} — BG Farm: 1-bullet checking ${bgFor} again`);
                        queueBgFarmCheck(bgFor, isPlayerShootEnabled(bgFor), { bgFor: null });
                        await wait(navRand());
                        gotoPage('kill');
                        return;
                    } else if (isPlayerShootEnabled(bgFor)) {
                        // Normal Kill+BG Check mode — re-BG check the original target with 1 bullet.
                        // Never jump straight into shoot_result; that stage only parses an already-fired shot.
                        addLiveLog(`Kill loop: ${target} was BG for ${bgFor} — re-BG checking ${bgFor}`);
                        state.pendingKillAction = {
                            stage:       'bgcheck',
                            targetName:  bgFor,
                            shootAfterBg: true,
                            force:       true
                        };
                        state.killBgWaitUntil = 0;
                        state.killLoopActive  = true;
                        await wait(navRand());
                        gotoPage('kill');
                        return;
                    }
                }

                // Continue kill loop — go back to kill page to process next player
                state.pendingKillAction = null;
                await wait(navRand());
                gotoPage('kill');
                return;
            }

            // Unknown result — check if this is actually a bodyguard search confirmation
            // (page reloaded after submitting search form for bodyguard)
            const pendingRows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')];
            const bgSearchConfirmed = pendingRows.some(b => {
                const name = textOf(b).trim();
                const players2 = state.killPlayers || [];
                const p = players2.find(pl => pl.name.toLowerCase() === name.toLowerCase());
                return p && p.isBg && p.bgFor && p.bgFor.toLowerCase() === target.toLowerCase();
            });

            if (bgSearchConfirmed) {
                addLiveLog(`Kill loop: bodyguard search confirmed for ${target} — continuing`);
                state.pendingKillAction = null;
                state.killLoopActive    = false; // pause until BG is found
                await wait(navRand());
                gotoPage('crimes');
                return;
            }

            // Genuinely unknown result — clear and move on
            // If this was a BG shoot, also clear the bodyguard reference on the original target
            // so the kill loop doesn't get stuck waiting for a BG that may already be dead
            addLiveLog(`Kill loop: unknown shoot result for ${target} — clearing`);
            const unknownPa = state.pendingKillAction;
            if (unknownPa?.bgFor) {
                // If a BG shot produced an unknown result, do not keep trusting the stored BG link.
                // The next BG Farm/BG Check pass will re-check the original before any further kill.
                clearStaleBgRelationsForOwner(unknownPa.bgFor, null, `unknown shoot result for ${target}`);
                addLiveLog(`Kill loop: cleared stored BG relation on ${unknownPa.bgFor} after unknown result for ${target}`);
            }
            state.pendingKillAction = null;
            state.killLoopActive    = false;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // ── Stage: bgcheck_deferred — some players moved, re-evaluate on kill page ──
        if (pending && pending.stage === 'bgcheck_deferred') {
            // Just clear the stage marker — the main BG check logic below will re-evaluate
            // using the deferred list stored in pending
            if (!isKillPage()) {
                gotoPage('kill');
                return;
            }
            // Fall through to main BG check logic — pending is kept with deferred list
        }

        // ── Stage: bg_shoot — shoot a known bodyguard (already found, no BG check needed) ──
        // Re-read pendingKillAction here — syncKillExpiryFromPage may have queued a new bg_shoot
        const pendingNow = state.pendingKillAction;
        if (pendingNow && pendingNow.stage === 'bg_shoot') {
            const bgName = pendingNow.targetName;
            const bgFor  = pendingNow.bgFor;

            // Strict stale-BG guard: old stored bgFor/bodyguard state is never enough to fire a BG shot.
            // If this BG shot is for a BG Farm target and it was not created by the current 1-bullet
            // verification result, re-check the original target BEFORE penalty checks, travel, profile
            // fetches, bullet redemption, or the actual shot. This prevents very old stale BGs from
            // costing bullets just because they later appear in Players Found.
            if (bgFor && isPlayerBgFarmEnabled(bgFor) && !isImmediateBgFarmVerification(pendingNow, bgFor, bgName)) {
                queueFreshBgVerifyBeforeShot(bgName, bgFor, pendingNow.shootAfterBg, 'no current verification token');
                await wait(navRand());
                gotoPage('kill');
                return;
            }

            // Even after a fresh verification token, make sure the stored relation has not already been
            // contradicted by a newer BG Farm check before the shot stage resumes.
            if (bgFor && isPlayerBgFarmEnabled(bgFor)) {
                const relPlayers = state.killPlayers || [];
                const owner = relPlayers.find(p => p.name && p.name.toLowerCase() === bgFor.toLowerCase());
                if (!owner || !owner.bodyguard || owner.bodyguard.toLowerCase() !== bgName.toLowerCase()) {
                    clearStaleBgRelation(bgName, bgFor, `stored BG is ${owner?.bodyguard || 'none'}`);
                    state.pendingKillAction = null;
                    state.killLoopActive = false;
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
            }

            // If penalty is too high, defer the BG kill until the penalty drops.
            // Keep BG Farm/BG Spam checks alive; only the real kill shot is paused.
            if (isKillPenaltyTooHigh()) {
                const needPenaltyPage = deferKillForPenalty(
                    stripBgFarmVerification({ stage: 'bg_shoot', targetName: bgName, bgFor, shootAfterBg: pendingNow.shootAfterBg }),
                    `shooting bodyguard ${bgName}`
                );
                if (needPenaltyPage) {
                    await wait(navRand());
                    gotoPage('kill-penalty');
                    return;
                }
                await resumeBgSpamAfterCheck();
                return;
            }

            // Find bodyguard's country from Players Found
            const foundRows2 = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd)')];
            let bgCountry = null;
            for (const row of foundRows2) {
                const link = row.querySelector('a[href*="?p=profile&u="]');
                if (!link) continue;
                try {
                    const url  = new URL(link.getAttribute('href'), window.location.href);
                    const name = url.searchParams.get('u') || '';
                    if (name.toLowerCase() === bgName.toLowerCase()) {
                        // Only look at text AFTER the player name to avoid matching country names inside it
                        const rowText = textOf(row);
                        const nameIdx = rowText.toLowerCase().indexOf(name.toLowerCase());
                        const afterName = nameIdx !== -1 ? rowText.slice(nameIdx + name.length).toLowerCase() : rowText.toLowerCase();
                        for (const country of Object.keys(COUNTRY_LOCATION_MAP)) {
                            if (afterName.includes(` in ${country}`)) {
                                bgCountry = country === 'south africa' ? 'South Africa' :
                                            country === 'usa' ? 'USA' :
                                            country.charAt(0).toUpperCase() + country.slice(1);
                                break;
                            }
                        }
                        break;
                    }
                } catch (_) {}
            }

            if (!bgCountry) {
                addLiveLog(`Kill loop: bodyguard ${bgName} not in Players Found — waiting for search`);
                state.pendingKillAction = null;
                await wait(navRand());
                gotoPage('crimes');
                return;
            }

            const myLoc = getPlayerLocation();
            const needsBgTravel = myLoc && bgCountry && myLoc.toLowerCase() !== bgCountry.toLowerCase();

            if (needsBgTravel) {
                // Sync drive timer from quick link before checking — cached value may be stale
                syncDriveReadyFromQuickLink();
            }

            if (needsBgTravel && !isInternalDriveReady()) {
                const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
                addLiveLog(`Kill loop: drive not ready (${remaining}s) — waiting to travel to bodyguard ${bgName}`);
                state.nextDriveReadyAt = now() + getInternalDriveRemainingMs();
                // Set travel stage so we're ready when drive is ready
                // Use killBgWaitUntil to suppress bounce — travel stage bypasses it when ready
                state.pendingKillAction = { stage: 'travel', travelTo: bgCountry, targetName: bgName,
                    afterTravel: preserveFreshBgFarmApproval({ stage: 'bg_shoot', targetName: bgName, bgFor, shootAfterBg: pendingNow.shootAfterBg }, pendingNow, bgFor, bgName) };
                state.killBgWaitUntil = now() + getInternalDriveRemainingMs() + 2000;
                await wait(navRand());
                gotoPage('crimes');
                return;
            }

            if (needsBgTravel) {
                addLiveLog(`Kill loop: travelling to ${bgCountry} to shoot bodyguard ${bgName}`);
                state.pendingKillAction = { stage: 'travel', travelTo: bgCountry, targetName: bgName,
                    afterTravel: preserveFreshBgFarmApproval({ stage: 'bg_shoot', targetName: bgName, bgFor, shootAfterBg: pendingNow.shootAfterBg }, pendingNow, bgFor, bgName) };
                await wait(navRand());
                gotoPage('cars');
                return;
            }

            // Only check bullet cost for the BG shot — target kill comes in a later cycle
            {
                const bgProfile = await fetchPlayerProfile(bgName);
                if (!bgProfile) {
                    addLiveLog(`Kill loop: could not fetch profile for ${bgName} — aborting BG shot`);
                    state.pendingKillAction = null;
                    state.killLoopActive = false;
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
                const bgBulletsBase = await fetchBulletCount(bgProfile.rankIndex, bgProfile.prestige);
                if (!bgBulletsBase) {
                    addLiveLog(`Kill loop: could not calculate bullet cost for ${bgName} — aborting BG shot`);
                    state.pendingKillAction = null;
                    state.killLoopActive = false;
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
                const bgBullets = bgProfile.isVip ? bgBulletsBase * 2 : bgBulletsBase;
                const available = getPlayerBullets();
                addLiveLog(`Kill loop: need ${bgBullets.toLocaleString()} bullets for BG ${bgName} — have ${available.toLocaleString()}`);
                const pls3  = state.killPlayers || [];
                const bIdx3 = pls3.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());
                if (bIdx3 !== -1) { pls3[bIdx3].requiredBullets = bgBullets; saveKillPlayers(pls3); }
                if (available < bgBullets) {
                    await redeemBulletPerksForKill(bgBullets);
                }
                if (getPlayerBullets() < bgBullets) {
                    addLiveLog(`Kill loop: not enough bullets for BG shot (need ${bgBullets.toLocaleString()}, have ${getPlayerBullets().toLocaleString()}) — waiting`);
                    // Store shoot target separately so BG Farm interval checks can still run
                    state.killBgShootPending  = stripBgFarmVerification({ stage: 'bg_shoot', targetName: bgName, bgFor: bgFor || null, shootAfterBg: pendingNow.shootAfterBg });
                    state.pendingKillAction   = null;
                    state.killLoopActive      = false;
                    state.killBgSpamPaused    = false;
                    await wait(navRand());
                    gotoPage('crimes');
                    return;
                }
            }
            // For BG Farm players, old stored BG state is never enough. A BG shot
            // must come directly from the latest original-target 1-bullet check.
            if (bgFor && isPlayerBgFarmEnabled(bgFor) &&
                !isImmediateBgFarmVerification(pendingNow, bgFor, bgName)) {
                addDebugLog(`bg-verify-trigger:${bgFor}:${bgName}`, `[DEBUG] verify trigger: bgName=${bgName} bgFor=${bgFor} pendingNow=${JSON.stringify(pendingNow)}`, 10000);
                addLiveLog(`Kill loop: BG Farm — verifying ${bgFor} still has BG ${bgName} before shooting`);
                const _vfPlayers = state.killPlayers || [];
                const _vfIdx = _vfPlayers.findIndex(pl => pl.name.toLowerCase() === bgFor.toLowerCase());
                if (_vfIdx !== -1) { _vfPlayers[_vfIdx].bgVerifyInFlight = true; saveKillPlayers(_vfPlayers); }
                state.pendingKillAction = {
                    stage: 'bg_farm_check',
                    targetName: bgFor,
                    afterVerify: { stage: 'bg_shoot', targetName: bgName, bgFor, shootAfterBg: pendingNow.shootAfterBg }
                };
                await wait(navRand());
                gotoPage('kill');
                return;
            }
            // Sufficient bullets — shoot the bodyguard
            addLiveLog(`Kill loop: shooting bodyguard ${bgName}`);
            if (bgFor) {
                const _clearPlayers = state.killPlayers || [];
                const _clearIdx = _clearPlayers.findIndex(pl => pl.name.toLowerCase() === bgFor.toLowerCase());
                if (_clearIdx !== -1 && _clearPlayers[_clearIdx].bgVerifyInFlight) {
                    delete _clearPlayers[_clearIdx].bgVerifyInFlight;
                    saveKillPlayers(_clearPlayers);
                }
            }
            await doKillShootFlow(bgName, bgFor);
            return;
        }

        // ── Grouped BG check logic ───────────────────────────────────────────────
        // 1. Build map of due players by country from Players Found list
        // 2. Process current country first, then countries by most players
        // 3. If a player moved (not in dropdown), defer them — circle back after all others
        const players      = getKillPlayers();
        const myLocation   = getPlayerLocation();

        // Get deferred players from state (moved country, needs retry)
        const deferred = state.pendingKillAction && state.pendingKillAction.stage === 'bgcheck_deferred'
            ? (state.pendingKillAction.deferred || [])
            : [];
        const forcedBgCheckName = state.pendingKillAction && state.pendingKillAction.stage === 'bgcheck' && state.pendingKillAction.targetName
            ? state.pendingKillAction.targetName.toLowerCase()
            : null;

        // Build country → due players map from Players Found + stored country data
        const foundRows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd)')];
        const foundMap  = new Map(); // name.lower() → country
        for (const row of foundRows) {
            const link = row.querySelector('a[href*="?p=profile&u="]');
            if (!link) continue;
            try {
                const url  = new URL(link.getAttribute('href'), window.location.href);
                const name = url.searchParams.get('u') || '';
                if (!name) continue;
                const rowText = textOf(row);
                const cm = rowText.match(/in\s+([A-Za-z\s]+?)Lost in/i);
                if (cm) foundMap.set(name.toLowerCase(), cm[1].trim());
            } catch (_) {}
        }

        // All due BG check players (including deferred)
        const duePlayers = players.filter(p => {
            if (p.status !== KILL_STATUS.ALIVE) return false;
            if (!isBgCheckable(p.name) && p.name.toLowerCase() !== forcedBgCheckName) return false;
            if (deferred.includes(p.name.toLowerCase())) return true; // deferred always retry
            if (forcedBgCheckName && p.name.toLowerCase() === forcedBgCheckName) return foundMap.has(p.name.toLowerCase());
            if (getBgCheckDueMs(p) > 0) return false;
            // Only include if actually in Players Found — not still being searched
            if (!foundMap.has(p.name.toLowerCase())) return false;
            return true;
        });

        // If no due players are in Players Found yet, check pending searches and wait
        // Also check if due players are found but in a different country — travel there
        if (!duePlayers.length) {
            const pendingRows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd')];
            let earliestFoundMs = null;
            const pendingBgFarmTargets = [];

            for (const p of players) {
                if (!isBgCheckable(p.name) || p.status !== KILL_STATUS.ALIVE) continue;
                if (getBgCheckDueMs(p) > 0) continue;

                // Check if found in a different country
                const foundEl = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd)')].find(row => {
                    const a = row.querySelector('a[href*="p=profile"]');
                    if (!a) return false;
                    try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === p.name.toLowerCase(); } catch(_) { return false; }
                });
                if (foundEl) {
                    // Found but in different country — travel there
                    const rowText = foundEl.textContent;
                    const countryMatch = rowText.match(/in\s+([A-Za-z ]+?)(?:\s+Lost|\s*$)/);
                    const targetCountry = countryMatch ? countryMatch[1].trim() : null;
                    if (targetCountry && targetCountry.toLowerCase() !== getPlayerLocation().toLowerCase()) {
                        addLiveLog(`Kill loop: BG Farm — ${p.name} found in ${targetCountry} — travelling to check`);
                        state.pendingKillAction = {
                            stage: 'travel',
                            travelTo: targetCountry,
                            targetName: p.name,
                            afterTravel: { stage: 'bgcheck', targetName: p.name, shootAfterBg: isPlayerShootEnabled(p.name) }
                        };
                        await wait(navRand());
                        gotoPage('cars');
                        return;
                    }
                }

                // Check if still pending search
                const pendingEl = pendingRows.find(row => {
                    const b = row.querySelector('b');
                    return b?.textContent?.trim().toLowerCase() === p.name.toLowerCase();
                });
                if (pendingEl) {
                    const timerSpan = pendingEl.querySelector('.chd');
                    const foundInMs = timerSpan ? parseLostInMs(textOf(timerSpan)) : null;
                    if (foundInMs && foundInMs > 0) {
                        pendingBgFarmTargets.push({ name: p.name, foundInMs });
                        if (earliestFoundMs === null || foundInMs < earliestFoundMs) {
                            earliestFoundMs = foundInMs;
                        }
                    }
                }
            }
            if (earliestFoundMs !== null && earliestFoundMs > 0) {
                const waitMins = Math.ceil(earliestFoundMs / 60000);
                addLiveLog(`Kill loop: BG Farm targets not yet in Players Found — waiting ${waitMins}m; releasing search loop`);
                const waitUntil = now() + earliestFoundMs + 5000;
                state.killBgWaitUntil = waitUntil;
                // Persist the fact that these original BG Farm targets are in
                // the game's pending search queue. Otherwise the scheduler sees
                // dueMs <= 0 on the next tick and immediately rebuilds the same
                // generic bgcheck action we just released.
                if (pendingBgFarmTargets.length) {
                    let changed = false;
                    for (const item of pendingBgFarmTargets) {
                        const idx = players.findIndex(pl => pl.name.toLowerCase() === item.name.toLowerCase());
                        if (idx === -1) continue;
                        players[idx].pendingSearch = true;
                        players[idx].expectedFoundAt = now() + item.foundInMs;
                        const pending3hr = now() + (3 * 60 * 60 * 1000);
                        if (!players[idx].searchExpiresAt || players[idx].searchExpiresAt < pending3hr) {
                            players[idx].searchExpiresAt = pending3hr;
                        }
                        changed = true;
                    }
                    if (changed) saveKillPlayers(players);
                }
                // The BG Farm target itself is still being searched, so there is
                // no BG check to perform yet. Release this generic bgcheck state
                // so the normal kill scanner can keep searching the rest of the
                // player list instead of looping kill/online/crimes forever.
                state.pendingKillAction = null;
                state.killLoopActive = false;
                await resumeBgSpamAfterCheck();
                return;
            }
        }

        // Kill-only players: shoot directly without BG check. Two cases:
        // 1. Kill ticked, BG not ticked — always shoot directly
        // 2. Kill ticked, BG ticked but interval not yet due — BG already checked recently, shoot directly
        // Skip players whose profile fetch failed recently (30s cooldown)
        // Skip players where we know required bullets and don't have enough yet
        const KILL_ATTEMPT_COOLDOWN_MS = 30 * 1000;
        const currentBullets = getPlayerBullets();
        const killOnlyPlayers = players.filter(p => {
            if (p.status !== KILL_STATUS.ALIVE) return false;
            if (!isPlayerShootEnabled(p.name)) return false;
            if (p.lastKillAttempt && (now() - p.lastKillAttempt) < KILL_ATTEMPT_COOLDOWN_MS) return false;
            // Skip if we know required bullets and don't have enough yet
            if (p.requiredBullets && currentBullets < p.requiredBullets) return false;
            // Skip if player has a known bodyguard currently being searched
            if (p.bodyguard) return false;
            // Any BG Check/BG Farm player may only be killed immediately after a fresh
            // 1-bullet check returns no BG. Never treat them as kill-only just because
            // their interval is not due.
            if (isBgCheckable(p.name)) return false;
            // Must be in Players Found right now — skip if dead, pending, or not found
            if (!foundMap.has(p.name.toLowerCase())) return false;
            // Skip all kill-only players when penalty too high
            if (isKillPenaltyTooHigh()) return false;
            return true;
        });

        // Sync country data from Players Found so foundMap is always fresh
        syncKillExpiryFromPage(true);

        // Helper: get country from live Players Found only — no stale p.country fallback
        // If a player isn't in Players Found right now (dead, not yet found, moved),
        // they return empty string and are skipped entirely
        const getPlayerCountry = (p) => foundMap.get(p.name.toLowerCase()) || '';

        // ── Kill-only: Kill ticked, BG not ticked — shoot directly ──────────
        // Only shoot if killLoopActive — skip if we're only here for a search
        if (state.killLoopActive) {
        // Sort by requiredBullets ascending — unknowns (no stored value) go last
        killOnlyPlayers.sort((a, b) => {
            const aCost = a.requiredBullets || Infinity;
            const bCost = b.requiredBullets || Infinity;
            return aCost - bCost;
        });
        // Check current country first
        for (const p of killOnlyPlayers) {
            const pCountry = getPlayerCountry(p);
            if (!pCountry) continue;
            if (myLocation && pCountry.toLowerCase() === myLocation.toLowerCase()) {
                addLiveLog(`Kill loop: kill-only — shooting ${p.name} in ${pCountry}`);
                await doKillShootFlow(p.name);
                return;
            }
        }
        // Kill-only players in other countries — travel to best country
        if (killOnlyPlayers.length) {
            const killByCountry = new Map();
            for (const p of killOnlyPlayers) {
                const pCountry = getPlayerCountry(p);
                if (!pCountry) continue;
                if (!killByCountry.has(pCountry)) killByCountry.set(pCountry, []);
                killByCountry.get(pCountry).push(p);
            }
            if (killByCountry.size) {
                const bestCountry = [...killByCountry.keys()].sort((a, b) =>
                    killByCountry.get(b).length - killByCountry.get(a).length)[0];
                const tgt = killByCountry.get(bestCountry)[0];
                if (!isInternalDriveReady()) {
                    const rem = Math.ceil(getInternalDriveRemainingMs() / 1000);
                    addLiveLog(`Kill loop: drive not ready (${rem}s) — waiting to travel for ${tgt.name}`);
                    // Update nextDriveReadyAt so the tick doesn't immediately re-enable killLoopActive
                    state.nextDriveReadyAt = now() + getInternalDriveRemainingMs();
                    // Set travel stage so tick intercept knows to wait rather than bounce to kill page
                    state.pendingKillAction = { stage: 'travel', travelTo: bestCountry, targetName: tgt.name, shootAfterBg: false, killOnly: true };
                    await wait(navRand());
                    // Stay on crimes — tick intercept will wait until drive is ready
                    return;
                }
                addLiveLog(`Kill loop: travelling to ${bestCountry} for kill-only player ${tgt.name}`);
                state.pendingKillAction = { stage: 'travel', travelTo: bestCountry, targetName: tgt.name, shootAfterBg: false, killOnly: true };
                await wait(navRand());
                gotoPage('cars');
                return;
            }
            // Kill-only players not in Players Found — exit loop, reactivate when found
            addLiveLog('Kill loop: kill-only players not yet in Players Found — reverting to normal script');
            state.killBgSpamPaused  = false;
            state.killLoopActive    = false;
            state.pendingKillAction = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }
        } // end killLoopActive guard for kill-only

        // ── BG check targets ─────────────────────────────────────────────────
        // Check if all kill-only players are skipped due to pending bodyguards
        const allSkippedForBg = players.some(p =>
            (isPlayerShootEnabled(p.name) || isPlayerBgFarmEnabled(p.name)) && p.status === KILL_STATUS.ALIVE && p.bodyguard
        );
        if (!duePlayers.length) {
            if (allSkippedForBg) {
                // Use the actual search expiry of the pending BG — fall back to 30min if unknown
                // Only consider BGs that are still being searched (not yet found)
                const nowMs = Date.now();
                const foundNamesOnPage = new Set(
                    [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                        .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){ return ''; } })
                        .filter(Boolean)
                );

                // If every actionable target is blocked by a found BG but the penalty
                // is too high, this is a penalty wait — not a 3-hour BG search wait.
                // Release the active bgcheck state so Bullet Factory/crimes can continue,
                // while BG Farm/BG Spam interval checks remain free to run.
                const foundBgBlockedByPenalty = players.find(p => {
                    if (p.status !== KILL_STATUS.ALIVE || !p.bodyguard) return false;
                    if (!isPlayerBgFarmEnabled(p.name) && !isPlayerBgCheckEnabled(p.name) && !isPlayerShootEnabled(p.name)) return false;
                    return foundNamesOnPage.has(p.bodyguard.toLowerCase());
                });
                if (foundBgBlockedByPenalty && isKillPenaltyTooHigh()) {
                    let needPenaltyPage = false;
                    if (!state.killPenaltyPendingAction) {
                        needPenaltyPage = deferKillForPenalty(
                            { stage: 'bgcheck', targetName: foundBgBlockedByPenalty.name, shootAfterBg: isPlayerShootEnabled(foundBgBlockedByPenalty.name), force: true, waitingBg: foundBgBlockedByPenalty.bodyguard },
                            `re-checking ${foundBgBlockedByPenalty.name} before shooting ${foundBgBlockedByPenalty.bodyguard}`
                        );
                    } else {
                        state.pendingKillAction = null;
                        state.killLoopActive = false;
                        state.killBgSpamPaused = false;
                        state.killBgWaitUntil = 0;
                    }
                    if (needPenaltyPage) {
                        await wait(navRand());
                        gotoPage('kill-penalty');
                        return;
                    }
                    await resumeBgSpamAfterCheck();
                    return;
                }

                let earliestExpiry = 0;
                const pendingSearchRows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd')];
                for (const p of players) {
                    if (!isPlayerBgFarmEnabled(p.name) || p.status !== KILL_STATUS.ALIVE || !p.bodyguard) continue;
                    const bgNameLower = p.bodyguard.toLowerCase();
                    // Skip BGs that are already in Players Found — those should be shot, not waited on
                    if (foundNamesOnPage.has(bgNameLower)) continue;
                    // Read the true pending-search completion timer. This prefers expectedFoundAt
                    // and the visible pending row, so it cannot accidentally use the 24h
                    // searchExpiresAt placeholder from when the search was submitted.
                    const expiry = getPendingSearchExpectedAt(bgNameLower);
                    earliestExpiry = earliestExpiry ? Math.min(earliestExpiry, expiry) : expiry;
                }
                // Fall back to 3hr if no pending-search timer was found
                if (!earliestExpiry) earliestExpiry = nowMs + (3 * 60 * 60 * 1000);
                const waitMins = Math.round((earliestExpiry - nowMs) / 60000);
                state.killBgWaitUntil  = earliestExpiry;
                addLiveLog(`Kill loop: bodyguard search pending — waiting ${waitMins}m for result`);
                // Reset lastBgCheck only for BG Farm players whose BG is actually being waited on
                // (not all BG Farm players — that would prevent other players' intervals from firing)
                const _bfPlayers = state.killPlayers || [];
                let _bfChanged = false;
                for (const _bfp of _bfPlayers) {
                    if (!isPlayerBgFarmEnabled(_bfp.name) || _bfp.status !== KILL_STATUS.ALIVE || !_bfp.bodyguard) continue;
                    const _bgLower = _bfp.bodyguard.toLowerCase();
                    // Only reset if this player's BG is still pending (not yet found)
                    const _bgPending = pendingSearchRows.some(row => {
                        const b = row.querySelector('b');
                        return b && textOf(b).toLowerCase() === _bgLower;
                    });
                    const _bgFound = foundNamesOnPage.has(_bgLower);
                    if (_bgPending && !_bgFound) {
                        _bfp.lastBgCheck = now();
                        _bfChanged = true;
                    }
                }
                if (_bfChanged) saveKillPlayers(_bfPlayers);
                await resumeBgSpamAfterCheck();
                return;
            } else {
                addLiveLog('Kill loop: no actionable targets — reverting to normal script');
                state.killBgSpamPaused  = false;
                state.killLoopActive    = false;
                state.pendingKillAction = null;
                // Reset lastBgCheck for all BG Farm players so interval doesn't re-trigger immediately
                const _bfPlayers2 = state.killPlayers || [];
                let _bfChanged2 = false;
                for (const _bfp2 of _bfPlayers2) {
                    if (isPlayerBgFarmEnabled(_bfp2.name) && _bfp2.status === KILL_STATUS.ALIVE && !_bfp2.lastBgCheck) {
                        _bfp2.lastBgCheck = now();
                        _bfChanged2 = true;
                    }
                }
                if (_bfChanged2) saveKillPlayers(_bfPlayers2);

                // Set cooldown based on the exact time Kill-ticked players will be found
                // so we don't keep hitting the kill page unnecessarily
                let longestWaitMs = 60000; // default 60s fallback
                const killPlayers = getKillPlayers();
                for (const kp of killPlayers) {
                    if (!isPlayerShootEnabled(kp.name)) continue;
                    // Find this player in the pending search section
                    const pendingRow = [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd')]
                        .find(row => {
                            const b = row.querySelector('b');
                            return b && textOf(b).toLowerCase() === kp.name.toLowerCase();
                        });
                    if (pendingRow) {
                        const timerSpan = pendingRow.querySelector('.chd');
                        const foundInMs = timerSpan ? parseLostInMs(textOf(timerSpan)) : null;
                        if (foundInMs != null && foundInMs > longestWaitMs) {
                            longestWaitMs = foundInMs;
                        }
                    }
                }
                state.killLoopCooldownUntil = now() + Math.min(longestWaitMs, 60000);
                addLiveLog(`Kill loop: waiting ${Math.ceil(Math.min(longestWaitMs, 60000) / 60000)}m for player to be found`);

                await wait(navRand());
                gotoPage('crimes');
            }
            return;
        }

        // Sort duePlayers by requiredBullets ascending — unknowns last
        duePlayers.sort((a, b) => {
            const aCost = a.requiredBullets || Infinity;
            const bCost = b.requiredBullets || Infinity;
            return aCost - bCost;
        });

        // Group due players by country
        const byCountry = new Map(); // country → [players]
        for (const p of duePlayers) {
            const country = getPlayerCountry(p);
            if (!country) continue; // not found yet — skip
            if (!byCountry.has(country)) byCountry.set(country, []);
            byCountry.get(country).push(p);
        }

        if (!byCountry.size) {
            // Check if any due players are still in pending search (not yet found)
            // If so, defer their BG check until they appear in Players Found
            const pendingNames = new Set(
                [...document.querySelectorAll('.bgl.i.wb .bgm.chs.pd b')]
                    .map(el => el.textContent.trim().toLowerCase())
            );
            const deferredAny = duePlayers.some(p => pendingNames.has(p.name.toLowerCase()));
            if (deferredAny) {
                // Defer BG check for pending players — set lastBgCheck to now
                // so getBgCheckDueMs returns positive, preventing immediate re-trigger
                const allPlayers = getKillPlayers();
                let changed = false;
                for (const p of duePlayers) {
                    if (pendingNames.has(p.name.toLowerCase())) {
                        const idx = allPlayers.findIndex(pl => pl.name.toLowerCase() === p.name.toLowerCase());
                        if (idx !== -1) {
                            allPlayers[idx].lastBgCheck = now();
                            changed = true;
                            addLiveLog(`Kill loop: ${p.name} still being searched — deferring BG check until found`);
                        }
                    }
                }
                if (changed) saveKillPlayers(allPlayers);
            } else {
                addLiveLog('Kill loop: due BG players not yet in Players Found — reverting to normal script');
            }
            state.killLoopActive    = false;
            state.pendingKillAction = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Sort countries: current location first, then by most players
        const sortedCountries = [...byCountry.keys()].sort((a, b) => {
            const aIsCurrent = myLocation && a.toLowerCase() === myLocation.toLowerCase();
            const bIsCurrent = myLocation && b.toLowerCase() === myLocation.toLowerCase();
            if (aIsCurrent && !bIsCurrent) return -1;
            if (bIsCurrent && !aIsCurrent) return 1;
            return byCountry.get(b).length - byCountry.get(a).length;
        });

        // Pick first player in current country, or travel to best country
        let bgTarget     = null;
        let targetCountry = null;

        for (const country of sortedCountries) {
            const inThisCountry = byCountry.get(country);
            if (myLocation && country.toLowerCase() === myLocation.toLowerCase()) {
                // Already here — pick first player
                bgTarget      = inThisCountry[0];
                targetCountry = country;
                break;
            } else if (!bgTarget) {
                // Best country to travel to
                bgTarget      = inThisCountry[0];
                targetCountry = country;
            }
        }

        if (!bgTarget) {
            addLiveLog('Kill loop: could not select BG check target');
            state.pendingKillAction = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Check if we need to travel
        const needsTravel = myLocation && targetCountry &&
            myLocation.toLowerCase() !== targetCountry.toLowerCase();

        if (needsTravel && !isInternalDriveReady()) {
            const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
            addLiveLog(`Kill loop: drive not ready (${remaining}s) — waiting before travelling to ${targetCountry}`);
            // Set travel stage so tick intercept waits rather than bouncing to kill page
            state.pendingKillAction = { stage: 'travel', travelTo: targetCountry, targetName: bgTarget.name,
                shootAfterBg: isPlayerShootEnabled(bgTarget.name), deferred };
            await wait(navRand());
            return;
        }

        if (needsTravel) {
            addLiveLog(`Kill loop: travelling to ${targetCountry} (${byCountry.get(targetCountry).length} player(s) to check)`);
            state.pendingKillAction = { stage: 'travel', travelTo: targetCountry, targetName: bgTarget.name,
                shootAfterBg: isPlayerShootEnabled(bgTarget.name), deferred };
            await wait(navRand());
            gotoPage('cars');
            return;
        }

        // In correct country — check if player is in shoot dropdown
        const shootSelect = document.querySelector('form input[name="do"][value="kill"] ~ * select[name="username"], form select[name="username"]');
        if (shootSelect) {
            const options    = [...shootSelect.options];
            const inDropdown = options.some(o => o.value.toLowerCase() === bgTarget.name.toLowerCase());
            if (!inDropdown) {
                // Player moved — defer them and continue with next player
                addLiveLog(`Kill loop: ${bgTarget.name} moved country — deferring`);
                const newDeferred = [...new Set([...deferred, bgTarget.name.toLowerCase()])];
                // Remove from byCountry and try next player in same country
                const remaining2 = (byCountry.get(targetCountry) || []).filter(p => p.name.toLowerCase() !== bgTarget.name.toLowerCase());
                if (remaining2.length) {
                    // Try next player in same country immediately
                    state.pendingKillAction = { stage: 'bgcheck_deferred', deferred: newDeferred };
                } else {
                    state.pendingKillAction = { stage: 'bgcheck_deferred', deferred: newDeferred };
                }
                await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
                // Stay on kill page, re-evaluate next tick
                return;
            }
        }

        // Check bullet count — need at least 1 for BG check
        const bullets = getPlayerBullets();
        if (bullets < 1) {
            addLiveLog('Kill loop: no bullets available — pausing');
            state.killLoopActive = false;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Shoot 1 bullet for BG check
        addLiveLog(`Kill loop: BG checking ${bgTarget.name} (shooting 1 bullet)`);
        // Clear deferred list once we successfully shoot — fresh start next evaluation
        const remainingDeferred = deferred.filter(n => n !== bgTarget.name.toLowerCase());
        state.pendingKillAction = { stage: 'shoot_result', targetName: bgTarget.name,
            shootAfterBg: isPlayerShootEnabled(bgTarget.name),
            deferred: remainingDeferred };
        state.lastActionAt      = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        // Use the shoot form directly
        const killForm = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="do"][value="kill"]'));
        if (killForm) {
            const usernameSelect = killForm.querySelector('select[name="username"]');
            const bulletsInput   = killForm.querySelector('input[name="bullets"]');
            const showCheckbox   = killForm.querySelector('input[name="show"]');
            const submitBtn      = killForm.querySelector('input[type="submit"][value="Shoot"]');

            if (usernameSelect && bulletsInput && submitBtn) {
                usernameSelect.value = bgTarget.name;
                bulletsInput.value   = '1';
                if (showCheckbox) showCheckbox.checked = !state.killAnonymousShooting;
                humanClick(submitBtn);
                addLiveLog(`Kill loop: BG check shot fired at ${bgTarget.name}`);
                return;
            }
        }

        addLiveLog('Kill loop: shoot form not found — retrying next tick');
        state.pendingKillAction = null;
    }

    // Handles the full shoot flow — shoots targetName, then BG checks bgFor if set
    async function doKillShootFlow(targetName, bgFor = null) {
        // Final safety net: if any legacy/deferred path tries to shoot a BG Farm BG directly,
        // bounce it back through a fresh original-target 1-bullet check first. Stored BG state
        // alone is never permission to spend full kill bullets.
        if (bgFor && targetName && targetName.toLowerCase() !== bgFor.toLowerCase() && isPlayerBgFarmEnabled(bgFor)) {
            const pa = state.pendingKillAction;
            if (!isImmediateBgFarmVerification(pa, bgFor, targetName)) {
                queueFreshBgVerifyBeforeShot(targetName, bgFor, pa?.shootAfterBg || isPlayerShootEnabled(bgFor), 'direct shoot path');
                await wait(navRand());
                gotoPage('kill');
                return;
            }
        }

        // Block all real kills when penalty is too high — 1-bullet BG checks remain allowed.
        // Store a safe resume action instead of clearing the kill entirely. For BG-checkable
        // targets, resume with another 1-bullet check so we do not kill on stale no-BG data.
        if (isKillPenaltyTooHigh()) {
            const resumeAction = bgFor
                ? { stage: 'bgcheck', targetName: bgFor, shootAfterBg: isPlayerShootEnabled(bgFor), force: true, waitingBg: targetName }
                : (isBgCheckable(targetName)
                    ? { stage: 'bgcheck', targetName, shootAfterBg: true, force: true }
                    : { stage: 'fetch_profile', targetName, bgFor });
            const needPenaltyPage = deferKillForPenalty(resumeAction, `killing ${targetName}`);
            if (needPenaltyPage) {
                await wait(navRand());
                gotoPage('kill-penalty');
                return;
            }
            await resumeBgSpamAfterCheck();
            return;
        }

        // Fetch profile for rank/prestige
        const profile = await fetchPlayerProfile(targetName);
        if (!profile) {
            addLiveLog(`Kill loop: could not fetch profile for ${targetName} — retrying in 30s`);
            // Mark player with a temporary cooldown so the loop doesn't retry immediately
            const pls = state.killPlayers || [];
            const pIdx = pls.findIndex(p => p.name.toLowerCase() === targetName.toLowerCase());
            if (pIdx !== -1) {
                pls[pIdx].lastKillAttempt = now();
                saveKillPlayers(pls);
            }
            state.pendingKillAction = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        addLiveLog(`Kill loop: ${targetName} is rank index ${profile.rankIndex}, prestige ${profile.prestige}${profile.isVip ? ' (VIP)' : ''}`);

        // Fetch bullet count from calculator
        const bulletCount = await fetchBulletCount(profile.rankIndex, profile.prestige);
        if (!bulletCount) {
            addLiveLog(`Kill loop: could not calculate bullets for ${targetName} — skipping`);
            state.pendingKillAction = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        // Bullet calculator includes kill penalty — double if VIP
        const requiredBullets = profile.isVip ? bulletCount * 2 : bulletCount;
        addLiveLog(`Kill loop: ${targetName} requires ${requiredBullets} bullets${profile.isVip ? ' (VIP x2)' : ''}`);

        // Store required bullets on player so we can skip them until we have enough
        const pls2 = state.killPlayers || [];
        const pIdx2 = pls2.findIndex(p => p.name.toLowerCase() === targetName.toLowerCase());
        if (pIdx2 !== -1) {
            pls2[pIdx2].requiredBullets = requiredBullets;
            saveKillPlayers(pls2);
        }

        // Check available bullets — attempt perk redemption if short
        const available = getPlayerBullets();
        if (getPlayerBullets() < requiredBullets) {
            await redeemBulletPerksForKill(requiredBullets);
            if (getPlayerBullets() < requiredBullets) {
                addLiveLog(`Kill loop: insufficient bullets (${getPlayerBullets()}/${requiredBullets}) for ${targetName} — waiting for more bullets`);
                // Clear bgShootQueued so it re-queues when bullets are sufficient
                const plsBQ = state.killPlayers || [];
                const bqIdx = plsBQ.findIndex(p => p.name.toLowerCase() === targetName.toLowerCase());
                if (bqIdx !== -1 && plsBQ[bqIdx].bgShootQueued) { delete plsBQ[bqIdx].bgShootQueued; saveKillPlayers(plsBQ); }
                state.pendingKillAction = null;
                await wait(navRand());
                gotoPage('kill');
                return;
            }
        }

        // Shoot with correct bullet count
        addLiveLog(`Kill loop: shooting ${targetName} with ${requiredBullets} bullets`);
        state.pendingKillAction = { stage: 'shoot_result', targetName, isKillShot: true, bgFor };
        state.lastActionAt      = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const killForm = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="do"][value="kill"]'));
        if (killForm) {
            const usernameSelect = killForm.querySelector('select[name="username"]');
            const bulletsInput   = killForm.querySelector('input[name="bullets"]');
            const showCheckbox   = killForm.querySelector('input[name="show"]');
            const submitBtn      = killForm.querySelector('input[type="submit"][value="Shoot"]');

            if (usernameSelect && bulletsInput && submitBtn) {
                // Verify target is actually in the dropdown — if not, they may not be in this country
                const targetOption = [...usernameSelect.options].find(o =>
                    o.value.toLowerCase() === targetName.toLowerCase() ||
                    o.text.toLowerCase() === targetName.toLowerCase()
                );
                if (!targetOption) {
                    addLiveLog(`Kill loop: ${targetName} not in kill dropdown — may have moved, retrying`);
                    state.pendingKillAction = null;
                    await wait(navRand());
                    gotoPage('kill');
                    return;
                }
                usernameSelect.value = targetName;
                bulletsInput.value   = String(requiredBullets);
                if (showCheckbox) showCheckbox.checked = !state.killAnonymousShooting;
                humanClick(submitBtn);
                addLiveLog(`Kill loop: kill shot fired at ${targetName} (${requiredBullets} bullets)`);
                return;
            }
        }

        addLiveLog('Kill loop: shoot form not found for kill shot — retrying');
        state.pendingKillAction = null;
    }


    // Redeem bullet perks to cover a kill shortfall. Returns true if bullets are now sufficient.
    async function redeemBulletPerksForKill(requiredBullets) {
        if (!state.redeemBullets) return false;
        const available = getPlayerBullets();
        const shortfall = requiredBullets - available;
        if (shortfall <= 0) return true;

        try {
            const resp = await fetch('/?p=perks&v=con', { credentials: 'include', cache: 'no-store' });
            const text = await resp.text();
            const doc  = new DOMParser().parseFromString(text, 'text/html');
            const rows = [...doc.querySelectorAll('table.pb tr.sortable-row')]
                .map(row => {
                    const txt = row.querySelector('.lm')?.textContent || '';
                    const m   = txt.match(/[\d,]+/);
                    return { id: row.dataset.id, amt: m ? parseInt(m[0].replace(/,/g, ''), 10) : 0 };
                })
                .filter(r => r.id && r.amt > 0)
                .sort((a, b) => a.amt - b.amt); // smallest first

            // Cap: don't redeem a perk more than X times the shortfall
            // Default 2x — so needing 20k won't use a 200k perk
            const cap = (state.redeemBulletsCap || 2.0) * shortfall;

            // Strategy 1: find smallest single perk that covers shortfall AND is within cap
            const singlePerk = rows.find(r => r.amt >= shortfall && r.amt <= cap);

            // Strategy 2: greedy smallest perks within cap until covered
            let greedyCovered = 0;
            const greedyPerks = [];
            for (const row of rows) {
                if (greedyCovered >= shortfall) break;
                if (row.amt > cap && greedyPerks.length === 0) {
                    // First perk already exceeds cap — nothing we can do within cap
                    break;
                }
                greedyPerks.push(row);
                greedyCovered += row.amt;
            }

            let toRedeem = [];
            let covered = 0;

            if (singlePerk) {
                // Best case: one perk covers it cleanly within cap
                toRedeem = [singlePerk.id];
                covered = singlePerk.amt;
            } else if (greedyCovered >= shortfall) {
                // Greedy combination within cap
                toRedeem = greedyPerks.map(r => r.id);
                covered = greedyCovered;
            } else {
                // Nothing within cap — wait for bullets to accumulate naturally
                const capK = Math.round(cap / 1000);
                addLiveLog(`Kill loop: no bullet perk within ${capK}k cap covers shortfall (${shortfall.toLocaleString()}) — waiting for bullets`);
                return false;
            }

            const form = new FormData();
            toRedeem.forEach(id => form.append('selected_perks[]', id));
            form.append('redeem_selected', 'Redeem Selected');
            await fetch('/?p=perks&v=con', { method: 'POST', credentials: 'include', body: form });
            addLiveLog(`Kill loop: redeemed ${toRedeem.length} bullet perk(s) (+${covered.toLocaleString()} bullets) to cover kill cost`);

            await wait(1500);

            // DOM bullet count is stale after fetch-based redemption — get fresh count from server
            try {
                const freshResp = await fetch('/?p=kill', { credentials: 'include', cache: 'no-store' });
                const freshText = await freshResp.text();
                const freshDoc  = new DOMParser().parseFromString(freshText, 'text/html');
                const freshBullets = parseUnits((freshDoc.querySelector('#player-bullets')?.textContent || '0').replace(/[^0-9,]/g, ''));
                if (freshBullets > 0) {
                    // Update DOM element so getPlayerBullets() returns correct value
                    const domEl = document.querySelector('#player-bullets');
                    if (domEl) domEl.textContent = freshBullets.toLocaleString();
                    addLiveLog(`Kill loop: bullet count after redeem — ${freshBullets.toLocaleString()}`);
                }
            } catch(e) { /* non-fatal — proceed with possibly stale count */ }

            return getPlayerBullets() >= requiredBullets;
        } catch (e) {
            addLiveLog(`Kill loop: bullet perk redeem error — ${e.message}`);
            return false;
        }
    }

    async function handleCarsPage() {
        stopJailObserver();

        // If we're on a mission cars page (?p=cars&a=N), hand off to the mission handler
        if (state.pendingMissionCheck && state.pendingMissionCheck.type === 'givecars') {
            await maybeHandlePendingMissionSubmission();
            return;
        }

        if (!shouldRunRepairCycle()) {
            addLiveLog('Repair not needed right now — returning to crimes');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        if (!state.autoRepairEnabled) {
            addLiveLog('Auto repair disabled — returning to crimes');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        const didRepair = await doRepairCycle();
        if (didRepair) {
            // If we came here from the melt reset loop, go back to melt
            if (state.meltResetLoopActive) {
                addLiveLog('Repair done — resuming melt reset loop');
                await wait(navRand());
                gotoCleanMeltPage(1);
                return;
            }
            // If we came from kill loop travel, return to kill page
            if (state.killLoopActive) {
                addLiveLog('Repair done — resuming kill loop');
                await wait(navRand());
                gotoPage('kill');
                return;
            }
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        addLiveLog('Repair cycle failed — returning to crimes');
        state.meltsSinceRepair    = 0; // reset so we don't immediately trigger again
        state.meltResetLoopActive = false;
        state.resetMeltEnabled    = false;
        await wait(navRand());
        gotoPage('crimes');
    }

    // =========================================================================
    // TICK / HEARTBEAT
    // =========================================================================

    async function tick() {
        if (loopBusy || reloadPending) return;

        // ── Auto account creation — runs even when bot is paused ──────────────
        // Death navigates to the login page regardless of bot state, so this
        // must fire before the state.enabled check.
        // Death takes you to the username creation page — manual logout only goes to login page.
        // So only fire the death reset on the username page to avoid false triggers.
        if (isUsernamePage()) {
            applyDeathSettingsReset();
        } else if (GM_getValue('accDeathSettingsReset', false)) {
            // Back on a normal game page after death — clear the guard so next death is detected
            GM_setValue('accDeathSettingsReset', false);
        }

        if (state.accEnabled && !loopBusy) {
            if (isLoginPage()) {
                loopBusy = true;
                try { await handleLoginPage(); } finally { loopBusy = false; }
                return;
            }
            if (isUsernamePage()) {
                loopBusy = true;
                try { await handleUsernamePage(); } finally { loopBusy = false; }
                return;
            }
            if (isRulesPage() || isTutorialPage()) {
                loopBusy = true;
                try { await handleRulesPage(); } finally { loopBusy = false; }
                return;
            }
            if (isMyStatsEmailPage() && GM_getValue('accPendingRetrieve', false)) {
                loopBusy = true;
                try { await handleMyStatsRetrieve(); } finally { loopBusy = false; }
                return;
            }
            // If retrieve is pending but we're not on the my-stats page yet, navigate there
            if (GM_getValue('accPendingRetrieve', false) && !isMyStatsEmailPage()) {
                gotoPage('my-stats', { s: 'email' });
                return;
            }
        }

        if (!state.enabled) return;

        // ── Jail/Cloudflare fallback watchdog ─────────────────────────────────
        // If the jail page was replaced by Cloudflare or another stale/interstitial
        // page, the normal jail-page handlers below will not run because #jailn is
        // absent. The stable jail deadline is persisted, so once it has elapsed we
        // force the same post-jail route instead of waiting forever for a MutationObserver.
        if (state.jailReleasesAt > 0 && now() >= state.jailReleasesAt && !isLikelyJailPage()) {
            loopBusy = true;
            try {
                updatePanel();
                await leaveJailAfterReleaseFallback('Jail fallback elapsed while away from jail page / after Cloudflare');
            } finally { loopBusy = false; }
            return;
        }

        // ── Kill penalty page — handle immediately, skip all other tick logic ──
        // Prevents any other navigation (search loop, online scanner etc.) from
        // navigating away before the penalty page is parsed.
        if (isKillPenaltyPage() && state.killPenaltyThreshold > 0) {
            loopBusy = true;
            try {
                updatePanel();
                state.pendingPenaltyPage = false;
                state.penaltyDropsAt = calcPenaltyDropsAt();
                await wait(navRand());
                gotoPage('crimes');
            } finally { loopBusy = false; }
            return;
        }

        // Resume any kill/BG kill action that was deferred only because the
        // kill penalty was above the user's threshold. While still above threshold,
        // this deliberately does not activate the kill loop, so crimes/Bullet Factory
        // and 1-bullet BG Farm/BG Spam checks can continue.
        const penaltyPendingAction = state.killPenaltyPendingAction;
        if (penaltyPendingAction && !state.pendingKillAction && !state.killLoopActive) {
            if (state.killPenaltyThreshold <= 0 || !isKillPenaltyTooHigh()) {
                addLiveLog('Kill loop: penalty is below threshold — resuming deferred kill/BG action');
                const restoredPenaltyAction = { ...penaltyPendingAction };
                delete restoredPenaltyAction.penaltyDeferred;
                state.pendingKillAction = restoredPenaltyAction;
                state.killPenaltyPendingAction = null;
                state.killBgWaitUntil = 0;
                state.killLoopActive = true;
            } else if (state.penaltyDropsAt && now() >= state.penaltyDropsAt && !isKillPage() && !isKillPenaltyPage()) {
                addLiveLog('Kill loop: penalty drop timer elapsed — checking kill page');
                state.penaltyDropsAt = 0;
                gotoPage('kill');
                return;
            } else if (!state.penaltyDropsAt && !state.pendingPenaltyPage && !isKillPenaltyPage()) {
                addLiveLog('Kill loop: deferred kill/BG action waiting on penalty — calculating drop time');
                state.pendingPenaltyPage = true;
                await wait(navRand());
                gotoPage('kill-penalty');
                return;
            }
        }

        // v19: a deferred penalty wait must not leave the kill loop marked
        // active with no concrete pending action. That stale state causes the
        // crimes ↔ kill bounce and keeps Bullet Factory paused even though the
        // bot is only waiting for penalty to drop. The scheduler below will
        // re-arm the loop when a real BG check / legal kill is due.
        if (state.killLoopActive && !state.pendingKillAction && !state.killBgShootPending) {
            const penaltyBlockedWait = !!state.killPenaltyPendingAction && isKillPenaltyTooHigh();
            const bgSearchWait       = state.killBgWaitUntil > Date.now();
            if (penaltyBlockedWait || bgSearchWait) {
                state.killLoopActive   = false;
                state.killBgSpamPaused = false;
            }
        }

        // ── Dedicated loop intercepts ─────────────────────────────────────────
        // When a reset loop is active the bot ignores all other page logic and
        // routes exclusively to the relevant page. Jail handling is still active
        // so the bot can leave jail and return to the loop immediately.

        // Kill loop — BG check and shoot mode, runs alongside or instead of kill search
        // Allow travel and active shoot stages to bypass killBgWaitUntil
        const _kpa = state.pendingKillAction;
        const _bypassWait = _kpa && (
            _kpa.stage === 'travel' ||
            _kpa.stage === 'travel_car' ||
            _kpa.stage === 'bg_shoot' ||
            _kpa.stage === 'bg_farm_check' ||
            _kpa.stage === 'bg_farm_shoot' ||
            _kpa.stage === 'bg_farm_result' ||
            _kpa.stage === 'fetch_profile' ||
            _kpa.stage === 'shoot_result' ||
            _kpa.stage === 'bgcheck'
        );
        if (state.killLoopActive && (!(state.killBgWaitUntil > Date.now()) || _bypassWait)) {
            if (isLikelyJailPage()) {
                loopBusy = true;
                try { updatePanel(); await handleJailState(); } finally { loopBusy = false; }
                return;
            }
            if (hasCTCChallenge()) {
                loopBusy = true;
                try { updatePanel(); setLastActionText('CTC solving…'); await maybeSolveCTC(); } finally { loopBusy = false; }
                return;
            }
            // If drive isn't ready and we need to travel, let normal script run until it is
            // Exception: always proceed with travel stage — we need to select the car regardless
            const kpa = state.pendingKillAction;
            const needsDrive = kpa && (kpa.stage === 'travel' || kpa.stage === 'travel_car');
            if (needsDrive && kpa.stage === 'travel_car' && !isInternalDriveReady()) {
                // Car selected but drive timer not ready — stay on crimes, suppress search loop
                state.killSearchLoopActive = false;
                // Fall through to normal script handling below
            } else if (needsDrive && kpa.stage === 'travel' && !isInternalDriveReady()) {
                // Travel stage but drive not ready — suppress search loop to avoid kill page bouncing
                state.killSearchLoopActive = false;
                // Fall through to normal script handling below
            } else {
            // Handle travel stages
            const kpending = state.pendingKillAction;
            if (kpending && kpending.stage === 'travel') {
                // Need cars LIST page to find best car
                if (isCarsPage() || hasCarsPageMarkers()) {
                    loopBusy = true;
                    try { updatePanel(); await handleKillLoopPage(); } finally { loopBusy = false; }
                    return;
                }
                addLiveLog('Kill loop: navigating to cars page to find travel car');
                gotoPage('cars');
                return;
            }
            if (kpending && kpending.stage === 'travel_car') {
                // Need car DETAIL page — check if we're on it
                if (isCarPage()) {
                    loopBusy = true;
                    try { updatePanel(); await handleKillLoopPage(); } finally { loopBusy = false; }
                    return;
                }
                // Navigate to the specific car URL we stored
                if (kpending.travelCarUrl) {
                    addLiveLog('Kill loop: navigating to travel car detail page');
                    navigateToUrl(kpending.travelCarUrl);
                    return;
                }
                // No stored URL — fall back to cars list to re-select
                state.pendingKillAction = { ...kpending, stage: 'travel' };
                gotoPage('cars');
                return;
            }
            // If we're on any car page while kill loop is active (e.g. post-drive reload),
            // navigate to kill page rather than letting handleCarPage intercept
            if (isCarPage() || isCarsPage()) {
                gotoPage('kill');
                return;
            }
            // Don't intercept GTA or melt pages — let them complete
            if (isGTAPage() || hasGTAPageMarkers() || isMeltPage() || hasMeltPageMarkers()) {
                // Fall through to normal page handling
            } else if (!isKillPage() && !isKillPenaltyPage()) {
                addLiveLog('Kill loop: navigating to kill page');
                gotoPage('kill');
                return;
            } else {
                loopBusy = true;
                try { updatePanel(); await handleKillLoopPage(); } finally { loopBusy = false; }
                return;
            }
            } // end drive-ready else block
        }

        // Kill search mode — only runs when kill loop is not mid-chain
        // Kill loop takes priority: if there is a pending kill action in progress,
        // reactivate the kill loop rather than letting the search loop interrupt.
        // Exception: bg_shoot while drive isn't ready — let search loop run in the meantime.
        if (!state.killLoopActive && state.pendingKillAction && state.killBgCheckEnabled) {
            const pa = state.pendingKillAction;
            if (pa.stage && pa.stage !== 'bgcheck') {
                // Don't re-enable if waiting for drive
                const waitingForDrive = (pa.stage === 'bg_shoot' || pa.stage === 'travel') && !isInternalDriveReady();
                // Don't re-enable bg_shoot if insufficient bullets
                let waitingForBullets = false;
                if (pa.stage === 'bg_shoot') {
                    const pls = getKillPlayers();
                    const bgP = pls.find(p => p.name.toLowerCase() === (pa.targetName || '').toLowerCase());
                    const bgB = bgP?.requiredBullets || 0;
                    if (bgB && getPlayerBullets() < bgB) waitingForBullets = true;
                }
                if (!waitingForDrive && !waitingForBullets && (!isKillPenaltyTooHigh() || pa.stage === 'travel')) {
                    state.killLoopActive = true;
                }
            }
        }

        // Auto re-activate kill search loop if due targets exist but loop was deactivated
        // Runs regardless of killLoopActive — search and kill loops are independent
        if (state.killSearchEnabled && !state.killSearchLoopActive) {
            const nowMs = now();
            const players = getKillPlayers();
            const hasUnknowns = players.some(p => p.status === KILL_STATUS.UNKNOWN);
            const RESCAN_BUFFER_MS = 3 * 60 * 60 * 1000;
            const hasExpiringAlives = players.some(p => {
                if (p.status !== KILL_STATUS.ALIVE) return false;
                if (p.searchExpiresAt) return (p.searchExpiresAt - nowMs) < RESCAN_BUFFER_MS;
                return (nowMs - p.lastChecked) >= KILL_SCANNER_RESCAN_MS;
            });
            const protectedIntervalMs = state.killProtectedRecheckEnabled ? state.killProtectedRecheckMins * 60 * 1000 : KILL_SCANNER_PROTECTED_RESCAN_MS;
            const hasProtectedDue = players.some(p =>
                p.status === KILL_STATUS.PROTECTED &&
                (nowMs - p.lastChecked) >= protectedIntervalMs
            );
            if (hasUnknowns || hasExpiringAlives || hasProtectedDue) {
                state.killSearchLoopActive = true;
            }
        }

        // Re-activate kill loop if there are kill-only players already found (in Players Found)
        // Don't re-enable for players still pending search — they'll trigger when found
        // Don't re-enable if we're already mid bg_shoot sequence or on cooldown
        const midBgShoot = state.pendingKillAction?.stage === 'bg_shoot' && !isInternalDriveReady();
        const killLoopOnCooldown = state.killLoopCooldownUntil > now();
        if (state.killBgCheckEnabled && !state.killLoopActive && !state.pendingKillAction && !midBgShoot && !killLoopOnCooldown) {
            const players = getKillPlayers();
            const hasKillReady = players.some(p => {
                if (!isPlayerShootEnabled(p.name)) return false;
                if (p.status !== KILL_STATUS.ALIVE) return false;
                if (isBgCheckable(p.name)) return false; // must pass through a fresh 1-bullet check first
                if (p.bodyguard) return false; // BG being searched — wait
                if (!p.searchExpiresAt || p.searchExpiresAt < now()) return false;
                if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) return false;
                return true;
            });
            if (hasKillReady && !(state.killLoopCooldownUntil > Date.now())) { state.killLoopActive = true; }
        }
        // Clean up stuck state: killLoopActive=true with no pendingKillAction and no deferred shoot
        if (state.killLoopActive && !state.pendingKillAction && !state.killBgShootPending && !isKillPage()) {
            state.killLoopActive = false;
        }

        // Restore deferred bg_shoot when bullets become sufficient
        if (state.killBgShootPending && !state.pendingKillAction && !state.killLoopActive) {
            const _bsp = state.killBgShootPending;
            const _bspPlayers = getKillPlayers();
            const _bspBgP = _bspPlayers.find(p => p.name.toLowerCase() === (_bsp.targetName || '').toLowerCase());
            const _bspBgB = _bspBgP?.requiredBullets || 0;
            if (_bspBgB && getPlayerBullets() >= _bspBgB) {
                if (_bsp.bgFor && isPlayerBgFarmEnabled(_bsp.bgFor)) {
                    addLiveLog(`Kill loop: bullets sufficient for ${_bsp.targetName} — re-verifying ${_bsp.bgFor} before BG shot`);
                    const _ownIdx = _bspPlayers.findIndex(p => p.name.toLowerCase() === _bsp.bgFor.toLowerCase());
                    if (_ownIdx !== -1) { _bspPlayers[_ownIdx].bgVerifyInFlight = true; saveKillPlayers(_bspPlayers); }
                    state.pendingKillAction = {
                        stage: 'bg_farm_check',
                        targetName: _bsp.bgFor,
                        shootAfterBg: _bsp.shootAfterBg || isPlayerShootEnabled(_bsp.bgFor),
                        force: true,
                        afterVerify: stripBgFarmVerification(_bsp)
                    };
                } else {
                    addLiveLog(`Kill loop: bullets sufficient for ${_bsp.targetName} — restoring bg_shoot`);
                    state.pendingKillAction  = _bsp;
                }
                state.killBgShootPending = null;
                state.killLoopActive     = true;
            }
        }

        // Also check BG Farm players — periodically visit kill page so syncKillExpiryFromPage
        // can detect their BGs in Players Found and queue the bg_shoot automatically
        if (state.killBgCheckEnabled && !state.killLoopActive && !state.pendingKillAction && !midBgShoot && !killLoopOnCooldown) {
            const players = getKillPlayers();
            const nowMs = now();
            const globalWaitExpired = !(state.killBgWaitUntil > nowMs);
            const hasBgFarmPending = players.some(p => {
                if (!isPlayerBgFarmEnabled(p.name)) return false;
                if (p.status !== KILL_STATUS.ALIVE) return false;
                const dueMs = getBgCheckDueMs(p);
                // If the original BG Farm target itself is only in the game's
                // pending search queue, it cannot be 1-bullet checked yet. The
                // v12 release path cleared pendingKillAction, but this scheduler
                // immediately rebuilt {stage:'bgcheck'} because dueMs was still
                // <= 0. Guard both markers here so search can continue normally.
                const originalTargetStillPending = !p.bodyguard && (
                    p.pendingSearch ||
                    (p.expectedFoundAt && p.expectedFoundAt > nowMs)
                );
                if (originalTargetStillPending) return false;
                // BG Farm interval checks must run even while a known BG is still being searched,
                // because the original player may swap to a different BG before the old BG is found.
                if (dueMs <= 0) return true;
                // bgFarmWaitUntil only suppresses non-interval readiness checks; the interval above wins.
                if (p.bgFarmWaitUntil && p.bgFarmWaitUntil > nowMs && !globalWaitExpired) return false;
                // BG is found and ready to shoot
                if (p.bodyguard) {
                    const bgPlayer = players.find(b => b.name.toLowerCase() === p.bodyguard.toLowerCase());
                    if (!bgPlayer || bgPlayer.status !== KILL_STATUS.ALIVE) return false;
                    // expectedFoundAt is deleted once the player appears in Players Found,
                    // so readiness is either expectedFoundAt elapsed OR an alive searched player with no expectedFoundAt.
                    const isSearchReady = (bgPlayer.expectedFoundAt !== undefined && bgPlayer.expectedFoundAt <= nowMs) ||
                                          (bgPlayer.expectedFoundAt === undefined && bgPlayer.searchExpiresAt && bgPlayer.searchExpiresAt > nowMs);
                    if (!isSearchReady) return false;
                    // A found BG is only immediate work if we are allowed to kill them.
                    // If penalty is too high, the interval check above may still fire,
                    // but do not keep re-arming the loop just to attempt the blocked BG kill.
                    if (isKillPenaltyTooHigh()) return false;
                    return true;
                }
                return false;
            });
            if (hasBgFarmPending && !(state.killLoopCooldownUntil > Date.now())) {
                state.killLoopActive    = true;
                state.killBgSpamPaused  = true;
                state.pendingKillAction = { stage: 'bgcheck' };
                stopBgSpam();
            }
        }
        // Also runs if kill loop is active but waiting for drive (needsDrive && !driveReady)
        const killLoopWaitingForDrive = state.killLoopActive &&
            state.pendingKillAction &&
            (state.pendingKillAction.stage === 'travel' || state.pendingKillAction.stage === 'travel_car') &&
            !isInternalDriveReady();
        // Kill loop blocks the search loop only when it has an active action to execute right now.
        // If kill loop is active but has no pendingKillAction, the search loop can run freely.
        // Also allow search loop when bg_shoot is pending but drive isn't ready yet.
        const bgShootWaitingForDrive = state.killLoopActive &&
            state.pendingKillAction?.stage === 'bg_shoot' &&
            !isInternalDriveReady();
        const killLoopBlocksSearch = state.killLoopActive &&
            state.pendingKillAction !== null &&
            !killLoopWaitingForDrive &&
            !bgShootWaitingForDrive;
        // While Bullet Factory has an active run, suppress normal Kill Search navigation.
        // Urgent Kill/BG work is handled above by the kill loop and can still pause BF;
        // this guard prevents low-priority search/protected rechecks from fighting the
        // car/factory travel flow during lag.
        const bulletFactoryBlocksNormalKillSearch = !!state.pendingBulletRun;
        if (state.killSearchLoopActive && !killLoopBlocksSearch && !bulletFactoryBlocksNormalKillSearch) {
            // Don't intercept GTA or melt pages — let them complete
            if (isGTAPage() || hasGTAPageMarkers() || isMeltPage() || hasMeltPageMarkers()) {
                // Fall through to normal page handling
            } else if (isCrimesPage() || hasCrimePageMarkers()) {
                // On crimes page — let GTA/melt fire first if ready, then kill scanner can run
                const gtaReady  = isGTAEnabled() && !isGTALocked() && isInternalGTAReady();
                const meltReady = isMeltUsable() && isInternalMeltReady();
                if (!gtaReady && !meltReady) {
            // Don't intercept jail page — kill page is accessible whilst jailed,
            // so continue searching. Jail observer handles release separately.
            if (hasCTCChallenge()) {
                loopBusy = true;
                try { updatePanel(); setLastActionText('CTC solving…'); await maybeSolveCTC(); } finally { loopBusy = false; }
                return;
            }
            // Navigate to kill page if not already there
            if (!isKillPage()) {
                if (isKillPenaltyPage()) {
                    // Let penalty page handle first
                } else {
                    addLiveLog('Kill search: navigating to kill page');
                    gotoPage('kill');
                    return;
                }
            } else {
                loopBusy = true;
                try { updatePanel(); await handleKillPage(); } finally { loopBusy = false; }
                return;
            }
                } // end !gtaReady && !meltReady
            } else {
                // Not on crimes/GTA/melt page — handle kill search normally
                if (hasCTCChallenge()) {
                    loopBusy = true;
                    try { updatePanel(); setLastActionText('CTC solving…'); await maybeSolveCTC(); } finally { loopBusy = false; }
                    return;
                }
                if (!isKillPage()) {
                    if (isKillPenaltyPage()) {
                        // Let penalty page handle first
                    } else {
                        addLiveLog('Kill search: navigating to kill page');
                        gotoPage('kill');
                        return;
                    }
                } else {
                    loopBusy = true;
                    try { updatePanel(); await handleKillPage(); } finally { loopBusy = false; }
                    return;
                }
            } // end isCrimesPage else-if
        }
        // Crime reset mode — always route to crimes page, ignore everything else
        if (state.resetCrimesEnabled) {
            if (isLikelyJailPage()) {
                loopBusy = true;
                try {
                    updatePanel();
                    await handleJailState();
                } finally { loopBusy = false; }
                return;
            }
            if (hasCTCChallenge()) {
                loopBusy = true;
                try { updatePanel(); setLastActionText('CTC solving…'); await maybeSolveCTC(); } finally { loopBusy = false; }
                return;
            }
            if (!isCrimesPage() && !hasCrimePageMarkers()) {
                addLiveLog('Crime reset mode: navigating to crimes');
                gotoPage('crimes');
                return;
            }
            loopBusy = true;
            try { updatePanel(); await handleCrimesPage(); } finally { loopBusy = false; }
            return;
        }

        if (state.gtaResetLoopActive) {
            // If jailed, handle jail first (leave if toggle on, then return to GTA)
            if (isLikelyJailPage()) {
                loopBusy = true;
                try {
                    updatePanel();
                    await handleJailState();
                } finally { loopBusy = false; }
                return;
            }
            // CTC can appear between page loads — solve it before navigating
            if (hasCTCChallenge()) {
                loopBusy = true;
                try { updatePanel(); setLastActionText('CTC solving…'); await maybeSolveCTC(); } finally { loopBusy = false; }
                return;
            }
            // Otherwise go straight to GTA page
            if (!isGTAPage() && !hasGTAPageMarkers()) {
                addLiveLog('GTA reset loop: navigating to GTA');
                gotoPage('gta');
                return;
            }
            loopBusy = true;
            try { updatePanel(); await handleGTAPage(); } finally { loopBusy = false; }
            return;
        }

        if (state.meltResetLoopActive) {
            // If jailed, handle jail first (leave if toggle on, then return to melt)
            if (isLikelyJailPage()) {
                loopBusy = true;
                try {
                    updatePanel();
                    await handleJailState();
                } finally { loopBusy = false; }
                return;
            }
            // CTC can appear between page loads — solve it before navigating
            if (hasCTCChallenge()) {
                loopBusy = true;
                try { updatePanel(); setLastActionText('CTC solving…'); await maybeSolveCTC(); } finally { loopBusy = false; }
                return;
            }
            // Repair cycle takes priority even in melt loop
            if (isCarsPage() || hasCarsPageMarkers()) {
                loopBusy = true;
                try { updatePanel(); await handleCarsPage(); } finally { loopBusy = false; }
                return;
            }
            // Otherwise go straight to melt page
            if (!isMeltPage() && !hasMeltPageMarkers()) {
                addLiveLog('Melt reset loop: navigating to melt');
                gotoCleanMeltPage(1);
                return;
            }
            loopBusy = true;
            try { updatePanel(); await handleMeltPage(); } finally { loopBusy = false; }
            return;
        }
        // ── End dedicated loop intercepts ─────────────────────────────────────

        if (jailPassiveMode && isLikelyJailPage()) {
            updatePanel();

            const ownRow = getOwnJailRow();
            if (ownRow) {
                jailHadOwnRow = true;
                // Fallback: check the existing stable release deadline BEFORE
                // reading/updating the visible timer. This catches frozen jail
                // timers after Cloudflare or stale page updates.
                if (await maybeLeaveJailAfterReleaseFallback('Jail timer elapsed/frozen during passive check')) return;

                // Update stored release estimate only when it moves earlier or
                // the timer genuinely increased. Do not extend on a stale timer.
                const jailMs = getOwnJailTimerMs();
                updateJailReleaseEstimate(jailMs, 'passive');
                return;
            }

            clearJailReleaseTracking();
            stopJailObserver();
            clearScheduledReload();
            // Dupe mode: optionally linger before leaving jail, or navigate away immediately
            if (PERSONALITY.jailLeaveDelayMs > 0) {
                await wait(rand(500, PERSONALITY.jailLeaveDelayMs));
            } else {
                await wait(rand(500, 1200));
            }
            // Return to the correct page based on which loop is active
                if (state.gtaResetLoopActive) {
                addLiveLog('Passive check: no own jail row — returning to GTA (loop active)');
                gotoPage('gta');
            } else if (state.meltResetLoopActive) {
                addLiveLog('Passive check: no own jail row — returning to melt (loop active)');
                gotoCleanMeltPage(1);
            } else {
                addLiveLog('Passive check: no own jail row, returning to Crimes');
                gotoPage('crimes');
            }
            return;
        }

        loopBusy = true;
        try {
            updatePanel();

            if (reloadPending) return;
            if (recentlyActed(600)) { if ((isCrimesPage()||hasCrimePageMarkers()) && getAvailableCrimes().length > 0) addLiveLog(`tick blocked: recentlyActed ${now()-state.lastActionAt}ms ago`); return; }

            if (hasCTCChallenge()) {
                await maybeSolveCTC();
                return;
            }

            if (await maybeHandleMission()) {
                return;
            }

            if (await maybeQuickDeposit()) {
                // Quick deposit is AJAX — no reload needed, continue on same page
                return;
            }

            if (isLikelyJailPage()) {
                await handleJailState();
                return;
            }

            stopJailObserver();

            // Handle the Players Online page when the scanner navigates there.
            // This MUST be checked before the scan-due trigger, otherwise the bot
            // arrives on the online page and immediately navigates away again.
            if (isOnlinePage()) {
                await handleOnlinePage();
                return;
            }


            // Bullet factory check — fires every 30 minutes on the half-hour.
            // Do not let BG Farm/Kill long-wait states starve Bullet Factory;
            // only BG Spam and an immediate kill/BG action pause starting/routing.
            const killImmediateWorkForBulletFactory = killLoopHasImmediateWorkForBulletFactory();
            if (isBulletFactoryCheckDue() && !killImmediateWorkForBulletFactory) {
                await startBulletFactoryRun();
                return;
            }

            if (state.pendingBulletRun && isBgSpamBlockingBulletFactory()) {
                addBulletFactoryPauseLog('bgspam', 'Bullet factory: paused while BG Spam is active — keeping run pending');
            }

            if (state.pendingBulletRun && killImmediateWorkForBulletFactory) {
                // Keep the run pending, but hand control back to the kill loop.
                // If we are on another page because a BF run had started, return
                // to kill so the urgent BG/Kill state can finish first.
                if (!isKillPage() && !isKillPenaltyPage()) {
                    addBulletFactoryPauseLog('kill', 'Bullet factory: paused for active Kill/BG action — keeping run pending');
                    await wait(navRand());
                    gotoPage('kill');
                    return;
                }
            }

            // Bullet factory run in progress — route based on stage.
            // For travel_car only intercept when drive is actually ready; otherwise
            // leave the pending run alone and allow normal low-priority loops.
            if (state.pendingBulletRun && !isBgSpamBlockingBulletFactory() && !killImmediateWorkForBulletFactory &&
                !(state.pendingBulletRun.stage === 'travel_car' && !isInternalDriveReady())) {
                const run = state.pendingBulletRun;
                const page = currentPage();
                const url  = window.location.href;

                // Complete stage — run finished, clear state and return to crimes
                if (run.stage === 'complete') {
                    addLiveLog('Bullet factory: run complete — clearing state');
                    state.pendingBulletRun = null;
                    return;
                }

                if (run.stage === 'withdraw') {
                    // Navigate to bank if not already there
                    if (!isBankPage()) {
                        addLiveLog('Bullet factory: navigating to bank to withdraw');
                        state.pendingBankAction = { type: 'withdraw', amount: run.withdrawAmount, source: 'bulletFactory' };
                        await wait(navRand());
                        gotoPage('bank');
                        return;
                    }
                    // Already on bank page — ensure pendingBankAction is set, then fall through
                    if (!state.pendingBankAction) {
                        state.pendingBankAction = { type: 'withdraw', amount: run.withdrawAmount, source: 'bulletFactory' };
                    }
                }

                if (run.stage === 'topup') {
                    // Mid-run bank topup — navigate to bank if not there, then fall through
                    if (!isBankPage()) {
                        addLiveLog(`Bullet factory: navigating to bank for mid-run top-up`);
                        state.pendingBankAction = { type: 'withdraw', amount: run.withdrawAmount, source: 'bulletFactory', substage: 'topup' };
                        await wait(navRand());
                        gotoPage('bank');
                        return;
                    }
                    // On bank page — ensure pendingBankAction is set, then fall through to handleBankPage
                    if (!state.pendingBankAction) {
                        state.pendingBankAction = { type: 'withdraw', amount: run.withdrawAmount, source: 'bulletFactory', substage: 'topup' };
                    }
                }

                if (run.stage === 'travel') {
                    addDebugLog(`bf-travel:${run.targets[0]?.country}`, `[DEBUG] bulletRun travel stage: target=${run.targets[0]?.country} | killPending=${JSON.stringify(state.pendingKillAction)} | driveReady=${isInternalDriveReady()}`, 10000);
                    // If on bank page, let handleBankPage handle it (mid-run topup or initial withdraw)
                    if (isBankPage()) {
                        // fall through to handleBankPage below
                    } else if (!isInternalDriveReady()) {
                        // Drive not ready yet — fall through to normal script handling
                        // tick will naturally retry bullet factory when drive becomes available
                    } else if (!isCarsPage() && !hasCarsPageMarkers()) {
                        addLiveLog(`Bullet factory: navigating to cars page to travel to ${run.targets[0]?.country}`);
                        await wait(navRand());
                        gotoPage('cars');
                        return;
                    } else {
                        await handleBulletFactoryTravelPage();
                        return;
                    }
                }

                if (run.stage === 'travel_car') {
                    // Drive ready — on car detail page, drive to destination.
                    // v21: if the car-detail navigation lags, do not hammer the
                    // same car URL repeatedly; wait briefly for the first navigation
                    // to settle before retrying.
                    if (!isCarPage()) {
                        if (run.travelCarUrl) {
                            const navKey = `car:${run.travelCarUrl}`;
                            if (isBulletFactoryNavRecentlyIssued(run, navKey)) {
                                return;
                            }
                            markBulletFactoryNavIssued(run, navKey);
                            navigateToUrl(run.travelCarUrl);
                        } else {
                            state.pendingBulletRun = { ...run, stage: 'travel' };
                            gotoPage('cars');
                        }
                        return;
                    }
                    if (run.navKey || run.navIssuedAt) {
                        state.pendingBulletRun = clearBulletFactoryNavMarker(run);
                    }
                    await handleBulletFactoryTravelCarPage();
                    return;
                }

                if (run.stage === 'drive_wait') {
                    const target = run.targets?.[0];
                    if (!target) {
                        state.pendingBulletRun = null;
                        gotoPage('crimes');
                        return;
                    }

                    if (isBulletFactoryDriveConfirmed(target)) {
                        addLiveLog(`Bullet factory: drive to ${target.country} confirmed — going to buy`);
                        const buyRun = clearBulletFactoryNavMarker({ ...run, stage: 'buy' });
                        const buyNavKey = `buy:${target.countryId}:${target.country}`;
                        markBulletFactoryNavIssued(buyRun, buyNavKey);
                        await wait(navRand());
                        navigateToUrl(getBulletFactoryUrl(target.countryId));
                        return;
                    }

                    const navKey = run.navKey || `drive:${target.countryId}:${target.country}:${run.travelCarUrl || ''}`;
                    if (isBulletFactoryNavRecentlyIssued(run, navKey)) {
                        return;
                    }

                    addLiveLog(`Bullet factory: drive to ${target.country} not confirmed — retrying`);
                    state.pendingBulletRun = clearBulletFactoryNavMarker({ ...run, stage: 'travel_car' });
                    return;
                }

                if (run.stage === 'buy') {
                    // On weaponry page — buy bullets.
                    // v20: when the game/browser lags after navigation, do not issue
                    // the same factory navigation multiple times per second. Retry
                    // occasionally, but otherwise wait for the page response to settle.
                    const target = run.targets[0];
                    const onBuyPage = url.includes('p=weaponry') && url.includes('show=bullet');
                    if (target && !onBuyPage) {
                        const navKey = `buy:${target.countryId}:${target.country}`;
                        if (isBulletFactoryNavRecentlyIssued(run, navKey)) {
                            return;
                        }
                        addLiveLog(`Bullet factory: navigating to bullet factory in ${target?.country}`);
                        markBulletFactoryNavIssued(run, navKey);
                        await wait(navRand());
                        navigateToUrl(getBulletFactoryUrl(target.countryId));
                        return;
                    }
                    if (onBuyPage && (run.navKey || run.navIssuedAt)) {
                        state.pendingBulletRun = clearBulletFactoryNavMarker(run);
                    }
                    await handleBulletFactoryPage();
                    return;
                }
            }

            // Players Online scan — fires opportunistically during normal script.
            // Only runs when no dedicated loop is active and scan is due.
            if (isKillOnlineScanDue() && !state.gtaResetLoopActive &&
                !state.meltResetLoopActive && !state.resetCrimesEnabled && !isKillPenaltyPage() &&
                !state.pendingBulletRun) {
                addLiveLog('Kill scanner: online scan due — navigating to Players Online');
                gotoPage('online');
                return;
            }

            // Penalty drop timer — navigate to kill page when penalty should have dropped
            if (state.penaltyDropsAt && now() >= state.penaltyDropsAt &&
                !state.killLoopActive && !isKillPage() && !isKillPenaltyPage()) {
                addLiveLog('Kill loop: penalty drop timer elapsed — checking kill page');
                state.penaltyDropsAt = 0;
                gotoPage('kill');
                return;
            }

            // Bodyguard / BG Farm expected found — navigate to kill page when timer elapses.
            // IMPORTANT: do not clear expectedFoundAt here. The kill page sync needs that marker
            // so it can tell the player just moved from pending search → Players Found and then
            // re-activate the BG Farm / kill loop. If the player is still pending, sync will refresh
            // expectedFoundAt from the game's visible timer instead.
            if (state.killBgCheckEnabled && !state.killLoopActive &&
                !state.pendingBulletRun &&
                !state.gtaResetLoopActive && !state.meltResetLoopActive && !isKillPage()) {
                const playerReady = getKillPlayers().some(p =>
                    p.expectedFoundAt && now() >= p.expectedFoundAt
                );
                if (playerReady) {
                    addLiveLog('Kill loop: player search timer elapsed — navigating to kill page');
                    gotoPage('kill');
                    return;
                }
            }

            // Kill penalty page handled at top of tick — nothing to do here

            // Auto account creation — handle login, username and rules pages
            if (isLoginPage()) {
                await handleLoginPage();
                return;
            }
            if (isUsernamePage()) {
                await handleUsernamePage();
                return;
            }
            if (isRulesPage() || isTutorialPage()) {
                await handleRulesPage();
                return;
            }

            if (isBankPage()) {
                await handleBankPage();
                return;
            }

            if (isDrugsPage() || hasDrugsPageMarkers()) {
                if (state.killLoopActive) {
                    // Kill loop takes priority — drive timer is shared, return to kill page
                    await wait(navRand());
                    gotoPage('kill');
                    return;
                }
                await handleDrugsPage();
                return;
            }

            if (isCarPage()) {
                if (state.killLoopActive) {
                    // Kill loop takes priority — return to kill page
                    await wait(navRand());
                    gotoPage('kill');
                    return;
                }
                await handleCarPage();
                return;
            }

            if (isCrimesPage() || hasCrimePageMarkers()) {
                await handleCrimesPage();
                return;
            }

            if (isGTAPage() || hasGTAPageMarkers()) {
                await handleGTAPage();
                return;
            }

            if (isMeltPage() || hasMeltPageMarkers()) {
                await handleMeltPage();
                return;
            }

            if (isCarsPage() || hasCarsPageMarkers()) {
                await handleCarsPage();
                return;
            }

            await wait(navRand());
            gotoPage('crimes');
        } finally {
            loopBusy = false;
        }
    }

    let protectedRecheckHandle = null;

    // ── Bullet Factory Page Handler ───────────────────────────────────────────
    // Handles the weaponry page (?p=weaponry&show=bullet&id=X) during a bullet run
    async function handleBulletFactoryPage() {
        // BG Spam takes priority only when actively firing — pause BF but keep the run pending.
        if (isBgSpamBlockingBulletFactory()) {
            addBulletFactoryPauseLog('bgspam', 'Bullet factory: paused while BG Spam is active — keeping run pending');
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        const run = state.pendingBulletRun;
        if (!run || !run.targets || !run.targets.length) {
            addLiveLog('Bullet factory: no pending run — returning to crimes');
            state.pendingBulletRun = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        const target = run.targets[0];
        addLiveLog(`Bullet factory: arrived at ${target.country} factory (${run.targets.length} countries remaining)`);

        // Check for successful purchase message — this fires when we've just bought
        const successEl = document.querySelector('.bgm.success, .bgm.cg');
        const successText = successEl ? successEl.textContent.trim() : '';
        if (successEl && /bought/i.test(successText)) {
            addLiveLog(`Bullet factory: purchase confirmed at ${target.country} — "${successText.slice(0, 60)}"`);
            const newTargets = run.targets.slice(1);
            if (!newTargets.length) {
                addLiveLog('Bullet factory: all countries done — run complete');
                // Keep pendingBulletRun alive until after navigation so kill scanner stays suppressed
                state.pendingBulletRun = { ...run, targets: [], stage: 'complete' };
                await wait(navRand());
                state.pendingBulletRun = null;
                gotoPage('crimes');
                return;
            }
            addLiveLog(`Bullet factory: moving to next country (${newTargets[0].country})`);
            state.pendingBulletRun = { ...run, targets: newTargets, stage: 'travel' };
            await wait(navRand());
            if (isInternalDriveReady()) {
                gotoPage('cars');
            } else {
                // Drive not ready yet — return to crimes and let the normal tick handle it
                // when drive becomes available
                gotoPage('crimes');
            }
            return;
        }

        // Find the stock
        const stockLabelEl = [...document.querySelectorAll('.bgd.myc')].find(el => el.textContent.trim() === 'Stock');
        const stockText = stockLabelEl?.nextSibling?.textContent?.trim() || '0';
        const stock = parseInt(stockText.replace(/,/g, ''), 10) || 0;
        addLiveLog(`Bullet factory: stock check at ${target.country} — read "${stockText}" → ${stock} bullets`);

        if (!stock) {
            addLiveLog(`Bullet factory: no stock at ${target.country} — moving to next`);
            const newTargets = run.targets.slice(1);
            if (!newTargets.length) {
                addLiveLog('Bullet factory: all countries done — run complete');
                state.pendingBulletRun = { ...run, targets: [], stage: 'complete' };
                await wait(navRand());
                state.pendingBulletRun = null;
                gotoPage('crimes');
                return;
            }
            state.pendingBulletRun = { ...run, targets: newTargets, stage: 'travel' };
            await wait(navRand());
            if (isInternalDriveReady()) {
                gotoPage('cars');
            } else {
                gotoPage('crimes');
            }
            return;
        }

        // Buy whatever is on the page — don't enforce minimum here since we've already travelled

        // Find the buy form — specifically the form containing the bullets input
        const bulletsInput = document.querySelector('input[name="bullets"]');
        const buyForm      = bulletsInput?.closest('form');
        const buyBtn       = buyForm?.querySelector('input[type="submit"][value="Buy"]');

        if (!bulletsInput || !buyBtn) {
            addLiveLog(`Bullet factory: buy form not found at ${target.country} — moving to next`);
            const newTargets = run.targets.slice(1);
            if (!newTargets.length) {
                state.pendingBulletRun = { ...run, targets: [], stage: 'complete' };
                await wait(navRand());
                state.pendingBulletRun = null;
                gotoPage('crimes');
                return;
            }
            state.pendingBulletRun = { ...run, targets: newTargets, stage: 'travel' };
            await wait(navRand());
            if (isInternalDriveReady()) {
                gotoPage('cars');
            } else {
                gotoPage('crimes');
            }
            return;
        }

        // Buy all available stock
        addLiveLog(`Bullet factory: buying ${stock} bullets at ${target.country} (Global Owners reported ${target.stock})`);

        // Check we have enough cash — QT sniper may have deposited mid-run
        const priceLabelEl = [...document.querySelectorAll('.bgd.myc')].find(el => el.textContent.trim() === 'Price per bullet');
        const priceText = priceLabelEl?.nextSibling?.textContent?.trim().replace(/[^0-9]/g, '') || '';
        const pricePerBullet = priceText ? parseInt(priceText, 10) : BULLET_FACTORY_COST_PER_BULLET;
        const totalCost = stock * pricePerBullet;
        const cashOnHand = getPlayerMoney();

        if (cashOnHand < totalCost) {
            // Calculate how much we need for all remaining countries
            const remainingCost = run.targets.reduce((sum, t) => sum + (t.stock * BULLET_FACTORY_COST_PER_BULLET), 0);
            addLiveLog(`Bullet factory: insufficient cash ($${cashOnHand.toLocaleString()} < $${totalCost.toLocaleString()}) — withdrawing $${remainingCost.toLocaleString()} from bank`);
            // Use 'topup' stage — preserves targets so we return to the right country after withdraw
            state.pendingBulletRun  = { ...run, stage: 'topup' };
            state.pendingBankAction = { type: 'withdraw', amount: remainingCost, source: 'bulletFactory', substage: 'topup' };
            await wait(navRand());
            gotoPage('bank');
            return;
        }

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshInput = document.querySelector('input[name="bullets"]');
        const freshForm  = freshInput?.closest('form');
        const freshBtn   = freshForm?.querySelector('input[type="submit"][value="Buy"]');
        if (!freshInput || !freshBtn) return;

        // Advance state BEFORE clicking — if page reloads we won't re-enter this buy loop
        const newTargets = run.targets.slice(1);
        if (!newTargets.length) {
            // Last country — keep pendingBulletRun alive until page reloads after buy
            // so kill scanner stays suppressed during the click and page navigation
            state.pendingBulletRun = { ...run, targets: [], stage: 'complete' };
        } else {
            state.pendingBulletRun = { ...run, targets: newTargets, stage: 'travel' };
        }

        freshInput.value = String(stock);
        humanClick(freshBtn);
    }

    // Handles the bullet factory travel stage — on the cars list page
    async function handleBulletFactoryTravelPage() {
        const run = state.pendingBulletRun;
        if (!run || !run.targets || !run.targets.length) {
            state.pendingBulletRun = null;
            gotoPage('crimes');
            return;
        }

        const target = run.targets[0];
        const playerCountry = getPlayerLocation();

        // If already in target country, go directly to weaponry page
        if (playerCountry.toLowerCase() === target.country.toLowerCase()) {
            addLiveLog(`Bullet factory: already in ${target.country} — going to buy`);
            state.pendingBulletRun = { ...run, stage: 'buy' };
            await wait(navRand());
            navigateToUrl(getBulletFactoryUrl(target.countryId));
            return;
        }

        // Re-check Global Owners page to see if stock is still available before wasting a drive
        try {
            const freshStocks = await fetchBulletFactoryStocks();
            const freshTarget = freshStocks.find(s => s.country.toLowerCase() === target.country.toLowerCase());
            if (!freshTarget) {
                addLiveLog(`Bullet factory: ${target.country} has no stock — skipping travel`);
                // Remove this target and try the next one
                const newTargets = run.targets.slice(1).filter(t =>
                    freshStocks.some(s => s.country.toLowerCase() === t.country.toLowerCase())
                );
                if (!newTargets.length) {
                    addLiveLog('Bullet factory: no more countries with stock — run complete');
                    state.pendingBulletRun = null;
                    await wait(navRand());
                    gotoPage('crimes');
                } else {
                    state.pendingBulletRun = { ...run, targets: newTargets, stage: 'travel' };
                    await wait(navRand());
                    gotoPage('cars');
                }
                return;
            }
            addLiveLog(`Bullet factory: ${target.country} confirmed ${freshTarget.stock} bullets — travelling`);
        } catch (e) {
            // If fetch fails, proceed anyway — handle 0 stock on the weaponry page
            addLiveLog(`Bullet factory: could not verify ${target.country} stock — proceeding`);
        }

        // Need to travel — find best car
        const travelCarUrl = findBestTravelCarUrl();
        if (!travelCarUrl) {
            addLiveLog('Bullet factory: no travel car found — aborting run');
            state.pendingBulletRun = null;
            await wait(navRand());
            gotoPage('crimes');
            return;
        }

        addLiveLog(`Bullet factory: travelling to ${target.country}`);
        state.pendingBulletRun = { ...run, stage: 'travel_car', travelCarUrl };
        navigateToUrl(travelCarUrl);
    }

    // Handles the bullet factory travel_car stage — on the car detail page
    async function handleBulletFactoryTravelCarPage() {
        const run = state.pendingBulletRun;
        if (!run || !run.targets || !run.targets.length) {
            state.pendingBulletRun = null;
            gotoPage('crimes');
            return;
        }

        const target = run.targets[0];
        const locationValue = getLocationValueForCountry(target.country);

        if (!locationValue) {
            addLiveLog(`Bullet factory: unknown country "${target.country}" — skipping`);
            const newTargets = run.targets.slice(1);
            state.pendingBulletRun = newTargets.length ? { ...run, targets: newTargets, stage: 'travel' } : null;
            gotoPage('crimes');
            return;
        }

        // Check if car is too damaged
        const driveSection = [...document.querySelectorAll('.tac.mb .bgl.i')]
            .find(el => /too much damage to drive/i.test(textOf(el)));
        if (driveSection) {
            const repairBtn = document.querySelector('form input[type="submit"][name="repair"]');
            if (repairBtn) {
                addLiveLog('Bullet factory: car damaged — repairing');
                state.lastActionAt = now();
                await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
                humanClick(document.querySelector('form input[type="submit"][name="repair"]'));
                return;
            }
            // No repair button — try another car
            addLiveLog('Bullet factory: car damaged, no repair button — finding another car');
            state.pendingBulletRun = { ...run, stage: 'travel' };
            await wait(navRand());
            gotoPage('cars');
            return;
        }

        // Check drive cooldown
        if (!isInternalDriveReady()) {
            const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
            return;
        }

        const locationRadio = document.querySelector(`form input[type="radio"][name="location"][value="${locationValue}"]`);
        const goBtn         = document.querySelector('form input[type="submit"][name="subm"][value="Go"]');

        if (!goBtn) {
            addLiveLog('Bullet factory: drive form not found — waiting');
            return;
        }

        if (!locationRadio) {
            // Radio for target country not present — we're probably already in that country
            // Go straight to the buy stage
            addLiveLog(`Bullet factory: already in ${target.country} — going to buy`);
            state.pendingBulletRun = { ...run, stage: 'buy' };
            await wait(navRand());
            navigateToUrl(getBulletFactoryUrl(target.countryId));
            return;
        }

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshRadio = document.querySelector(`form input[type="radio"][name="location"][value="${locationValue}"]`);
        const freshGo    = document.querySelector('form input[type="submit"][name="subm"][value="Go"]');
        if (!freshRadio || !freshGo) return;

        freshRadio.checked     = true;
        state.nextDriveReadyAt = now() + 60000;
        const driveKey = `drive:${target.countryId}:${target.country}:${run.travelCarUrl || window.location.href}`;
        state.pendingBulletRun = {
            ...clearBulletFactoryNavMarker(run),
            stage: 'drive_wait',
            navKey: driveKey,
            navIssuedAt: now()
        };
        humanClick(freshGo);
        addLiveLog(`Bullet factory: driving to ${target.country}`);
    }

    function startHeartbeat() {
        stopHeartbeat();
        startRuntimeIfNeeded();
        heartbeatHandle = setInterval(() => tick(), PERSONALITY.heartbeatMs);
        setTimeout(() => tick(), 400);
        addLiveLog('Heartbeat started');
        // Clear stale kill loop state — only if wait is implausibly long (>1 day = truly stale)
        // Don't clear legitimate 3hr BG search waits
        if (state.killLoopActive && !state.pendingKillAction && state.killBgWaitUntil > Date.now() + (23 * 60 * 60 * 1000)) {
            state.killLoopActive  = false;
            state.killBgWaitUntil = 0;
            addLiveLog('Kill loop: cleared stale 24hr wait — resuming normal operation');
        }
        // Clear spam pause if no pending kill action
        if (state.killBgSpamPaused && !state.pendingKillAction) {
            state.killBgSpamPaused = false;
        }

        // Clear spam pause if kill loop has no active work to do
        if (state.killBgSpamPaused && !state.pendingKillAction && !state.killLoopActive) {
            state.killBgSpamPaused = false;
        }
        syncBgSpamState();
        // Detect gun change — if gun changed since last page load, clear all stored
        // requiredBullets so they get recalculated with the new gun on next kill page visit
        const _currentGun = (document.querySelector('#player-gun')?.textContent || '').trim();
        if (_currentGun && state.lastKnownGun && _currentGun !== state.lastKnownGun) {
            addLiveLog(`Gun changed from ${state.lastKnownGun} to ${_currentGun} — clearing stored bullet costs`);
            const _gPlayers = getKillPlayers();
            let _gChanged = false;
            for (const p of _gPlayers) {
                if (p.requiredBullets) { delete p.requiredBullets; _gChanged = true; }
            }
            if (_gChanged) saveKillPlayers(_gPlayers);
        }
        if (_currentGun) state.lastKnownGun = _currentGun;
        // Auto buy gun if enabled and no gun
        if (state.autoBuyGun && getPlayerGunValue() === 0 && !autoBuyGunBusy) {
            autoBuyGun();
        }
        // Refresh kill list every 10s so BG countdown timers tick live
        if (window._ugKillListRefresh) clearInterval(window._ugKillListRefresh);
        window._ugKillListRefresh = setInterval(() => {
            if (document.querySelector('#ug-bot-kill-list')) renderKillList();
        }, 10000);
        // Start independent protected recheck checker — runs every 10s regardless of loopBusy
        // Just sets the flag — the next heartbeat tick handles navigation naturally
        if (protectedRecheckHandle) clearInterval(protectedRecheckHandle);
        protectedRecheckHandle = setInterval(() => {
            if (!state.enabled || !state.killProtectedRecheckEnabled || !state.killSearchEnabled) return;
            if (state.killSearchLoopActive || state.killLoopActive) return;
            const recheckMs = state.killProtectedRecheckMins * 60 * 1000;
            const nowMs = now();
            const players = getKillPlayers();
            const hasProtectedDue = players.some(p =>
                p.status === KILL_STATUS.PROTECTED &&
                (nowMs - (p.lastChecked || 0)) >= recheckMs
            );
            if (hasProtectedDue) {
                const noTargetUntil = Number(getSetting('killSearchNoTargetUntil', 0));
                if (Date.now() >= noTargetUntil) {
                    // Don't interrupt if GTA or melt is ready to fire
                    const gtaReady  = isGTAEnabled() && !isGTALocked() && isInternalGTAReady();
                    const meltReady = isMeltUsable() && isInternalMeltReady();
                    if (!gtaReady && !meltReady) {
                        addLiveLog('Kill scanner: protected recheck due — activating search');
                        state.killSearchLoopActive = true;
                    }
                }
            }
        }, 10000);
    }

    function stopHeartbeat() {
        if (heartbeatHandle) {
            clearInterval(heartbeatHandle);
            heartbeatHandle = null;
        }
        if (protectedRecheckHandle) {
            clearInterval(protectedRecheckHandle);
            protectedRecheckHandle = null;
        }
    }

    // =========================================================================
    // UI
    // =========================================================================

    function renderDrugDepositCalc() {
        const el = document.querySelector('#ug-bot-drug-deposit-calc');
        if (!el) return;

        if (!state.autoDrugsEnabled) {
            el.textContent = '';
            return;
        }

        const capacity = state.drugCapacityCache;
        if (capacity <= 0) {
            el.textContent = 'Visit the drugs page once to calculate amounts.';
            return;
        }

        const multiplier  = state.drugDepositMultiplier;
        const reserve     = capacity * DRUG_HEROIN_USA_PRICE;
        const trigger     = reserve * multiplier;

        function fmt(n) {
            if (n >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'b';
            if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.?0+$/, '') + 'm';
            return '$' + Math.round(n).toLocaleString();
        }

        el.textContent = `At ${multiplier}× — deposits when cash exceeds ${fmt(trigger)}, keeping ${fmt(reserve)} on hand.`;
    }

    function renderLiveLog() {
        if (!logEl) return;
        const log = state.liveLog;
        if (log.length === lastRenderedLogLength && log[0] === lastRenderedLogFirst) return;
        lastRenderedLogLength = log.length;
        lastRenderedLogFirst  = log[0] || '';
        const savedLogScroll = getSetting('scrollLog', -1);
        const logScroll = logEl.scrollTop > 0 ? logEl.scrollTop : (savedLogScroll >= 0 ? savedLogScroll : -1);
        logEl.innerHTML = log
            .map(entry => `<div class="ug-log-entry">${escapeHtml(entry)}</div>`)
            .join('');
        if (logScroll >= 0) {
            // Restore saved position
            logEl.scrollTop = logScroll;
            setSetting('scrollLog', -1); // Clear after first restore
        }
        // If no saved position, leave at top (default) — don't force-scroll to bottom
    }

    function buildActionCheckboxes() {
        const crimesContainer = document.querySelector('#ug-bot-actions');
        const gtaContainer    = document.querySelector('#ug-bot-gta-checkboxes');
        if (!crimesContainer || !gtaContainer) return;

        const enabled = state.enabledActions;

        const crimeRows = CRIME_DEFS.map(crime => {
            const locked  = isCrimeLocked(crime.id);
            const checked = enabled.includes(crime.id);
            return checkboxRow(crime.id, crime.name, checked, locked);
        });

        const gtaRow  = checkboxRow(GTA_DEF.id,  GTA_DEF.name,  enabled.includes(GTA_DEF.id),  isGTALocked());
        const meltRow = checkboxRow(MELT_DEF.id, MELT_DEF.name, enabled.includes(MELT_DEF.id), isMeltLocked());

        const TABLE = (rows) => `<table style="width:auto;border-collapse:collapse;">${rows.join('')}</table>`;
        crimesContainer.innerHTML = TABLE(crimeRows);
        gtaContainer.innerHTML    = TABLE([gtaRow, meltRow]);
    }

    function refreshActionLockStates() {
        const allDefs = [...CRIME_DEFS, GTA_DEF, MELT_DEF];

        for (const def of allDefs) {
            const cb    = document.querySelector(`.ug-action-cb[data-id="${def.id}"]`);
            const label = cb?.closest('tr');
            if (!cb || !label) continue;

            const locked =
                def.id === GTA_DEF.id  ? isGTALocked()  :
                def.id === MELT_DEF.id ? isMeltLocked() :
                isCrimeLocked(def.id);

            cb.disabled = locked;
            if (label) { label.querySelectorAll('td').forEach((td, i) => { if (i > 0) td.style.color = locked ? '#555' : '#ddd'; }); }

            let tag = label.querySelector('.ug-locked-tag');
            if (locked && !tag) {
                tag = document.createElement('span');
                tag.className   = 'ug-locked-tag';
                tag.textContent = 'locked';
                label.appendChild(tag);
            } else if (!locked && tag) {
                tag.remove();
            }
        }
    }

    function checkboxRow(id, name, checked, locked) {
        return `<tr class="${locked ? 'ug-action-locked' : ''}">
            <td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;">
                <input type="checkbox" class="ug-action-cb" data-id="${id}"
                    style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;"
                    ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''} />
            </td>
            <td style="color:${locked ? '#555' : '#ddd'};font-size:12px;padding:3px 0;vertical-align:middle;white-space:nowrap;text-align:left;">
                ${escapeHtml(name)}
                ${locked ? '<span class="ug-locked-tag" style="color:#555;font-size:10px;margin-left:4px;">[locked]</span>' : ''}
            </td>
        </tr>`;
    }

    // Active tab persisted so it survives page navigation.
    // Map old tab names to new ones for users upgrading from previous versions.
    let activeTab = getSetting('activeTab', 'ranking');
    if (activeTab === 'stats' || activeTab === 'log') activeTab = 'statslog';
    if (activeTab === 'crimes' || activeTab === 'gta' || activeTab === 'points') activeTab = 'ranking';
    // Ensure activeTab is a valid tab that exists in the current version
    const validTabs = ['ranking', 'perks', 'drugs', 'kill', 'statslog', 'qt', 'acc'];
    if (!validTabs.includes(activeTab)) activeTab = 'ranking';


    function saveSettings() {
        const checked            = [...document.querySelectorAll('.ug-action-cb:checked')].map(cb => cb.dataset.id);
        const thresholdValue     = Math.max(0, parseFormattedNumber(depositThresholdEl ? depositThresholdEl.value : '0'));
        const repairEveryValue   = Math.max(1, Number(repairEveryEl ? repairEveryEl.value : DEFAULTS.repairEveryMelts) || DEFAULTS.repairEveryMelts);
        const multiplierValue    = Math.max(1, Number(drugDepositMultiplierEl ? drugDepositMultiplierEl.value : DEFAULTS.drugDepositMultiplier) || DEFAULTS.drugDepositMultiplier);
        const minJailPtsValue    = Math.max(1, Number(leaveJailMinPointsEl ? leaveJailMinPointsEl.value : DEFAULTS.leaveJailMinPoints) || DEFAULTS.leaveJailMinPoints);
        const minResetPtsValue   = Math.max(1, Number(resetTimerMinPointsEl ? resetTimerMinPointsEl.value : DEFAULTS.resetTimerMinPoints) || DEFAULTS.resetTimerMinPoints);

        state.enabledActions             = checked;
        state.autoDepositEnabled         = autoDepositInput   ? autoDepositInput.checked   : state.autoDepositEnabled;
        state.autoDepositThreshold       = thresholdValue;
        if (bustNoReloadInput) state.bustNoReload = bustNoReloadInput.checked;
        if (bustPollMinEl) state.bustPollMin = Math.max(100, parseInt(bustPollMinEl.value) || DEFAULTS.bustPollMin);
        if (bustPollMaxEl) state.bustPollMax = Math.max(100, parseInt(bustPollMaxEl.value) || DEFAULTS.bustPollMax);
        state.extendBulletsThreshold     = extendBulletsThreshEl     ? (parseFormattedNumber(extendBulletsThreshEl.value)     || DEFAULTS.extendBulletsThreshold)     : state.extendBulletsThreshold;
        state.extendRaresThreshold       = extendRaresThreshEl       ? (parseFormattedNumber(extendRaresThreshEl.value)       || DEFAULTS.extendRaresThreshold)       : state.extendRaresThreshold;
        state.extendDoubleMeltsThreshold = extendDoubleMeltsThreshEl ? (parseFormattedNumber(extendDoubleMeltsThreshEl.value) || DEFAULTS.extendDoubleMeltsThreshold) : state.extendDoubleMeltsThreshold;
        state.extendBulletValueThreshold = extendBulletValueThreshEl ? (parseFormattedNumber(extendBulletValueThreshEl.value) || DEFAULTS.extendBulletValueThreshold) : state.extendBulletValueThreshold;
        state.extendDoubleXpThreshold    = extendDoubleXpThreshEl    ? (parseFormattedNumber(extendDoubleXpThreshEl.value)    || DEFAULTS.extendDoubleXpThreshold)    : state.extendDoubleXpThreshold;
        state.extendAlwaysSuccThreshold  = extendAlwaysSuccThreshEl  ? (parseFormattedNumber(extendAlwaysSuccThreshEl.value)  || DEFAULTS.extendAlwaysSuccThreshold)  : state.extendAlwaysSuccThreshold;
        state.extendAlwaysBustThreshold  = extendAlwaysBustThreshEl  ? (parseFormattedNumber(extendAlwaysBustThreshEl.value)  || DEFAULTS.extendAlwaysBustThreshold)  : state.extendAlwaysBustThreshold;
        state.extendDoubleCashThreshold  = extendDoubleCashThreshEl  ? (parseFormattedNumber(extendDoubleCashThreshEl.value)  || DEFAULTS.extendDoubleCashThreshold)  : state.extendDoubleCashThreshold;
        state.autoRepairEnabled          = autoRepairInput    ? autoRepairInput.checked    : state.autoRepairEnabled;
        state.repairEveryMelts           = repairEveryValue;
        state.autoMissionsEnabled        = autoMissionsInput  ? autoMissionsInput.checked  : state.autoMissionsEnabled;
        state.autoGiveCarMissionsEnabled = autoGiveCarsInput  ? autoGiveCarsInput.checked  : state.autoGiveCarMissionsEnabled;
        state.autoDrugsEnabled           = autoDrugsInput     ? autoDrugsInput.checked     : state.autoDrugsEnabled;
        state.drugDepositMultiplier      = multiplierValue;
        state.leaveJailEnabled           = leaveJailInput     ? leaveJailInput.checked     : state.leaveJailEnabled;
        state.leaveJailMinPoints         = minJailPtsValue;
        state.resetTimerMinPoints        = minResetPtsValue;

        // Persist whichever reset checkboxes are currently checked in the UI
        state.resetCrimesEnabled  = resetCrimesInput         ? resetCrimesInput.checked         : state.resetCrimesEnabled;
        state.resetCrimesFastMode = resetCrimesFastModeInput ? resetCrimesFastModeInput.checked : state.resetCrimesFastMode;
        state.resetGTAEnabled     = resetGTAInput            ? resetGTAInput.checked            : state.resetGTAEnabled;
        state.resetMeltEnabled    = resetMeltInput           ? resetMeltInput.checked           : state.resetMeltEnabled;

        if (bgCrimeEnabledInput) {
            state.bgCrimeEnabled = bgCrimeEnabledInput.checked;
            if (state.bgCrimeEnabled) startBgCrime();
            else stopBgCrime();
        }
        if (diceJoinEnabledInput) {
            state.diceJoinEnabled = diceJoinEnabledInput.checked;
            if (state.diceJoinEnabled) startDiceJoiner();
            else stopDiceJoiner();
        }
        if (bulletFactoryEnabledInput) {
            state.bulletFactoryEnabled = bulletFactoryEnabledInput.checked;
        }
        if (drugCompModeInput) state.drugCompEnabled = drugCompModeInput.checked;
        if (killProtectedRecheckInput)  state.killProtectedRecheckEnabled = killProtectedRecheckInput.checked;
        if (killProtectedRecheckMinsEl) state.killProtectedRecheckMins    = Number(killProtectedRecheckMinsEl.value) || DEFAULTS.killProtectedRecheckMins;
        if (qtBgEnabledInput)      state.qtBgEnabled       = qtBgEnabledInput.checked;
        const _qtPerksEnabledEl = document.querySelector('#ug-bot-qt-perks-enabled');
        if (_qtPerksEnabledEl)     state.qtPerksEnabled    = _qtPerksEnabledEl.checked;
        if (qtBgThresholdEl)       state.qtBgThreshold     = parseFormattedNumber(qtBgThresholdEl.value) || DEFAULTS.qtBgThreshold;
        if (qtBulletsEnabledInput) state.qtBulletsEnabled  = qtBulletsEnabledInput.checked;
        if (qtBulletsThresholdEl)  state.qtBulletsThreshold = parseFormattedNumber(qtBulletsThresholdEl.value) || DEFAULTS.qtBulletsThreshold;
        if (qtBulletsMinEl)        state.qtBulletsMin        = parseFormattedNumber(qtBulletsMinEl.value) || 0;
        if (qtPollMinEl)           state.qtPollMin          = Number(qtPollMinEl.value) || DEFAULTS.qtPollMin;
        if (qtPollMaxEl)           state.qtPollMax          = Number(qtPollMaxEl.value) || DEFAULTS.qtPollMax;
        if (qtPointsEnabledInput)  state.qtPointsEnabled    = qtPointsEnabledInput.checked;
        if (qtPointsThresholdEl)   state.qtPointsThreshold  = parseFormattedNumber(qtPointsThresholdEl.value) || DEFAULTS.qtPointsThreshold;
        if (qtBustEnabledInput)       state.qtBustEnabled       = qtBustEnabledInput.checked;
        if (qtBustMaxPtsEl)           state.qtBustMaxPts        = Number(qtBustMaxPtsEl.value) || DEFAULTS.qtBustMaxPts;
        if (qtBustMinAmtEl)           state.qtBustMinMins       = Number(qtBustMinAmtEl.value) || DEFAULTS.qtBustMinMins;
        if (qtAlwaysSuccEnabledInput) state.qtAlwaysSuccEnabled = qtAlwaysSuccEnabledInput.checked;
        if (qtAlwaysSuccMaxPtsEl)     state.qtAlwaysSuccMaxPts  = Number(qtAlwaysSuccMaxPtsEl.value) || DEFAULTS.qtAlwaysSuccMaxPts;
        if (qtAlwaysSuccMinAmtEl)     state.qtAlwaysSuccMinMins = Number(qtAlwaysSuccMinAmtEl.value) || DEFAULTS.qtAlwaysSuccMinMins;
        if (qtDoubleMeltsEnabledInput) state.qtDoubleMeltsEnabled = qtDoubleMeltsEnabledInput.checked;
        if (qtDoubleMeltsMaxPtsEl)    state.qtDoubleMeltsMaxPts  = Number(qtDoubleMeltsMaxPtsEl.value) || DEFAULTS.qtDoubleMeltsMaxPts;
        if (qtDoubleMeltsMinAmtEl)    state.qtDoubleMeltsMinCars = Number(qtDoubleMeltsMinAmtEl.value) || DEFAULTS.qtDoubleMeltsMinCars;
        if (qtDoubleXpEnabledInput)   state.qtDoubleXpEnabled    = qtDoubleXpEnabledInput.checked;
        if (qtDoubleXpMaxPtsEl)       state.qtDoubleXpMaxPts     = Number(qtDoubleXpMaxPtsEl.value) || DEFAULTS.qtDoubleXpMaxPts;
        if (qtDoubleXpMinAmtEl)       state.qtDoubleXpMinMins    = Number(qtDoubleXpMinAmtEl.value) || DEFAULTS.qtDoubleXpMinMins;
        if (qtDoubleCashEnabledInput) state.qtDoubleCashEnabled  = qtDoubleCashEnabledInput.checked;
        if (qtDoubleCashMaxPtsEl)     state.qtDoubleCashMaxPts   = Number(qtDoubleCashMaxPtsEl.value) || DEFAULTS.qtDoubleCashMaxPts;
        if (qtDoubleCashMinAmtEl)     state.qtDoubleCashMinMins  = Number(qtDoubleCashMinAmtEl.value) || DEFAULTS.qtDoubleCashMinMins;
        if (qtRareEnabledInput)       state.qtRareEnabled        = qtRareEnabledInput.checked;
        if (qtRareMaxPtsEl)           state.qtRareMaxPts         = Number(qtRareMaxPtsEl.value) || DEFAULTS.qtRareMaxPts;
        if (qtRareMinAmtEl)           state.qtRareMinCars        = Number(qtRareMinAmtEl.value) || DEFAULTS.qtRareMinCars;
        if (qtBulletValueEnabledInput) state.qtBulletValueEnabled = qtBulletValueEnabledInput.checked;
        if (qtBulletValueMaxPtsEl)    state.qtBulletValueMaxPts  = Number(qtBulletValueMaxPtsEl.value) || DEFAULTS.qtBulletValueMaxPts;
        if (qtBulletValueMinAmtEl)    state.qtBulletValueMinCars = Number(qtBulletValueMinAmtEl.value) || DEFAULTS.qtBulletValueMinCars;
        if (qtCarsEnabledInput)    state.qtCarsEnabled      = qtCarsEnabledInput.checked;
        if (qtCarsIntervalEl)      state.qtCarsScanInterval = Number(qtCarsIntervalEl.value) || DEFAULTS.qtCarsScanInterval;
        if (qtPerkExtendEnabledInput) state.qtPerkExtendEnabled = qtPerkExtendEnabledInput.checked;
        if (qtPerkExtendMinsEl)    state.qtPerkExtendMins   = Number(qtPerkExtendMinsEl.value) || DEFAULTS.qtPerkExtendMins;
        if (qtPerkRedeemEnabledInput) state.qtPerkRedeemEnabled = qtPerkRedeemEnabledInput.checked;
        if (qtPerkRedeemMinsEl)    state.qtPerkRedeemMins   = Number(qtPerkRedeemMinsEl.value) || DEFAULTS.qtPerkRedeemMins;
        if (disableCrimesRankEl)   state.disableCrimesRank  = disableCrimesRankEl.value;
        if (disableGtaRankEl)      state.disableGtaRank     = disableGtaRankEl.value;
        if (leaveCashEnabledInput) state.leaveCashEnabled   = leaveCashEnabledInput.checked;
        if (leaveCashOnHandEl)     state.leaveCashOnHand    = parseFormattedNumber(leaveCashOnHandEl.value) || 0;
        if (bonusPointsEnabledInput) state.bonusPointsEnabled = bonusPointsEnabledInput.checked;
        if (state.bonusPointsEnabled) { startBonusPointsSpender(); } else { stopBonusPointsSpender(); }
        if (autoBuyBgEnabledInput)   state.autoBuyBgEnabled   = autoBuyBgEnabledInput.checked;
        if (state.autoBuyBgEnabled) { startAutoBuyBg(); } else { stopAutoBuyBg(); }
        if (autoBuyBgMinPtsEl)       state.autoBuyBgMinPts    = parseInt(autoBuyBgMinPtsEl.value.replace(/[^\d]/g, ''), 10) || DEFAULTS.autoBuyBgMinPts;
        if (autoBuyBgMinsEl)         state.autoBuyBgMins      = parseInt(autoBuyBgMinsEl.value.replace(/[^\d]/g, ''), 10)   || DEFAULTS.autoBuyBgMins;
        if (extendBgsInput)          state.extendBgs         = extendBgsInput.checked;
        if (extendCarsInput)         state.extendCars        = extendCarsInput.checked;
        if (extendBulletsInput)      state.extendBullets     = extendBulletsInput.checked;
        if (extendRaresInput)        state.extendRares       = extendRaresInput.checked;
        if (extendDoubleMeltsInput)  state.extendDoubleMelts = extendDoubleMeltsInput.checked;
        if (extendBulletValueInput)  state.extendBulletValue = extendBulletValueInput.checked;
        if (extendDoubleXpInput)     state.extendDoubleXp    = extendDoubleXpInput.checked;
        if (extendAlwaysSuccInput)   state.extendAlwaysSucc  = extendAlwaysSuccInput.checked;
        if (extendAlwaysBustInput)   state.extendAlwaysBust  = extendAlwaysBustInput.checked;
        if (extendDoubleCashInput)   state.extendDoubleCash  = extendDoubleCashInput.checked;
        if (redeemBulletValueInput) state.redeemBulletValue = redeemBulletValueInput.checked;
        if (redeemCashInput)        state.redeemCash        = redeemCashInput.checked;
        if (redeemCarsInput)        state.redeemCars        = redeemCarsInput.checked;
        if (redeemPairFloorEl)      state.redeemPairFloor   = Number(redeemPairFloorEl.value) || 100;
        if (redeemBgInput)           state.redeemBg          = redeemBgInput.checked;
        if (redeemBulletsInput)      state.redeemBullets     = redeemBulletsInput.checked;
        if (redeemDoubleXpInput)     state.redeemDoubleXp    = redeemDoubleXpInput.checked;
        if (redeemAlwaysSuccInput)   state.redeemAlwaysSucc  = redeemAlwaysSuccInput.checked;
        if (redeemDoubleCashInput)   state.redeemDoubleCash  = redeemDoubleCashInput.checked;
        if (redeemRareInput)         state.redeemRare        = redeemRareInput.checked;
        if (redeemDoubleMeltInput)   state.redeemDoubleMelt  = redeemDoubleMeltInput.checked;
        if (redeemAlwaysBustInput)   state.redeemAlwaysBust  = redeemAlwaysBustInput.checked;
        // Save per-car-type settings from the rendered list
        const carTypes = (state.qtCarsTypes || DEFAULTS.qtCarsTypes).map(t => ({ ...t }));
        carTypes.forEach(t => {
            const cb = document.querySelector(`#ug-bot-qt-car-enabled-${t.b}`);
            const px = document.querySelector(`#ug-bot-qt-car-price-${t.b}`);
            if (cb) t.enabled  = cb.checked;
            if (px) t.maxPrice = parseInt(px.value.replace(/,/g, ''), 10) || t.maxPrice;
        });
        state.qtCarsTypes = carTypes;
        // Start or stop QT car scanner
        if (state.qtCarsEnabled) { startQTCarScanner(); } else { stopQTCarScanner(); }
        // Start or stop QT sniper
        if (state.qtBgEnabled || state.qtBulletsEnabled) {
            startQTSniper();
        } else {
            stopQTSniper();
        }
        // Start or stop perk extender
        if (state.qtPerkExtendEnabled) {
            startQTPerkExtender();
        }
        if (state.qtPerkRedeemEnabled) {
            startQTPerkRedeemer();
        }
        if (state.autoBuyBgEnabled) {
            startAutoBuyBg();
        }
        syncBgSpamState();
        if (state.bonusPointsEnabled) {
            startBonusPointsSpender();
        } else {
            stopQTPerkExtender();
        }
        state.killScanOnlineEnabled  = killScanOnlineInput   ? killScanOnlineInput.checked   : state.killScanOnlineEnabled;
        state.killScanOnlineInterval = killScanIntervalEl    ? Number(killScanIntervalEl.value) : state.killScanOnlineInterval;
        state.killSearchEnabled      = killSearchInput       ? killSearchInput.checked       : state.killSearchEnabled;
        state.killBgCheckEnabled     = killBgCheckInput      ? killBgCheckInput.checked      : state.killBgCheckEnabled;
        if (killBgSpamInput)       state.killBgSpamEnabled      = killBgSpamInput.checked;
        if (killBgSpamIntervalEl)  state.killBgSpamIntervalSecs = Number(killBgSpamIntervalEl.value) || 2;
        if (killBgSpamTargetEl)    state.killBgSpamTarget       = killBgSpamTargetEl.value || '';
        state.killShootEnabled       = killShootInput        ? killShootInput.checked        : state.killShootEnabled;
        state.killAnonymousShooting  = killAnonymousInput    ? killAnonymousInput.checked    : state.killAnonymousShooting;
        const _autoBuyGunEl    = document.querySelector('#ug-bot-auto-buy-gun');
        const _autoBuyGunAwpEl = document.querySelector('#ug-bot-auto-buy-gun-awp');
        const _autoBuyGunPtsEl = document.querySelector('#ug-bot-auto-buy-gun-pts');
        if (_autoBuyGunEl)    state.autoBuyGun            = _autoBuyGunEl.checked;
        if (_autoBuyGunAwpEl) state.autoBuyGunType        = _autoBuyGunAwpEl.checked ? 'awp' : 'ak47';
        if (_autoBuyGunPtsEl && _autoBuyGunPtsEl.value) state.autoBuyGunPtThreshold = parseInt(_autoBuyGunPtsEl.value, 10) || 100;
        state.killBgCheckIntervalHrs = killBgCheckIntervalEl ? Number(killBgCheckIntervalEl.value) : state.killBgCheckIntervalHrs;
        const penaltyVal = killPenaltyThresholdEl ? parseFloat(killPenaltyThresholdEl.value) : 0;
        const newThreshold = isNaN(penaltyVal) ? 0 : Math.max(0, penaltyVal);
        // If threshold changed and penalty is now below new threshold, clear cached drop time
        if (newThreshold !== state.killPenaltyThreshold) {
            const currentPenalty = Number(getSetting('cachedKillPenalty', 1.0));
            if (newThreshold === 0 || currentPenalty <= newThreshold) {
                state.penaltyDropsAt   = 0;
                state.pendingPenaltyPage = false;
            }
        }
        state.killPenaltyThreshold = newThreshold;

        // Activate kill loop if BG check is enabled and there are ticked players.
        // Also force scan and search on — the kill loop requires both to function.
        if (state.killBgCheckEnabled) {
            const hasBgTargets = ((state.killBgCheckPlayers || []).length > 0 || (state.killBgFarmPlayers || []).length > 0) &&
                getKillPlayers().some(p =>
                    (isPlayerBgCheckEnabled(p.name) || isPlayerBgFarmEnabled(p.name)) &&
                    p.status === KILL_STATUS.ALIVE &&
                    !p.bodyguard // skip if BG currently being searched
                );
            // Clear killBgWaitUntil if a bg_shoot is already queued — BG was found
            if (state.pendingKillAction?.stage === 'bg_shoot') state.killBgWaitUntil = 0;
            // Don't re-enable kill loop if we're explicitly waiting for a BG search to complete
            const waitingForBg = state.killBgWaitUntil > Date.now();
            if (hasBgTargets && !waitingForBg && !state.killBgSpamPaused && !state.killLoopActive) {
                // Only re-activate if there's actually something to do right now
                // (don't set killLoopActive=true without a pendingKillAction — causes stuck state)
            }
            // Force scan online and search players on
            state.killScanOnlineEnabled = true;
            state.killSearchEnabled     = true;
            // Also force the search loop active if not already
            state.killSearchLoopActive  = true;
            // Update UI checkboxes to reflect forced state
            if (killScanOnlineInput)  killScanOnlineInput.checked = true;
            if (killSearchInput)      killSearchInput.checked     = true;
        } else {
            state.killLoopActive = false;
        }

        // Activate or deactivate the persisted loop flags to match the toggles.
        // These survive page reloads so the dedicated loops maintain themselves.
        state.gtaResetLoopActive   = state.resetGTAEnabled;
        state.meltResetLoopActive  = state.resetMeltEnabled;
        if (state.bustNoReload) { startNoReloadBust(); } else { stopNoReloadBust(); }

        // Kill search loop activation logic:
        // - If the toggle is off, always deactivate
        // - If the loop was already active (persisted), keep it active — never
        //   deactivate mid-run. handleKillPage() is the only place that sets
        //   killSearchLoopActive to false when there are genuinely no targets.
        // - If the loop was inactive, check if there are targets to start it:
        //   unknowns, expiring alives (3hr window), or original targets past
        //   their 1hr recheck window.
        if (!state.killSearchEnabled) {
            state.killSearchLoopActive = false;
        } else if (state.killSearchLoopActive) {
            // Loop was already running — keep it active, don't second-guess it
            state.killSearchLoopActive = true;
        } else {
            // Loop was inactive — check if there are targets to start it
            const nowMs = now();
            const players = getKillPlayers();
            const hasUnknowns = players.some(p => p.status === KILL_STATUS.UNKNOWN);
            const RESCAN_BUFFER_MS = 3 * 60 * 60 * 1000;
            const hasExpiringAlives = players.some(p => {
                if (p.status !== KILL_STATUS.ALIVE) return false;
                if (p.searchExpiresAt) return (p.searchExpiresAt - nowMs) < RESCAN_BUFFER_MS;
                return (nowMs - p.lastChecked) >= KILL_SCANNER_RESCAN_MS;
            });
            const hasProtectedDue = players.some(p =>
                p.status === KILL_STATUS.PROTECTED &&
                (nowMs - p.lastChecked) >= (state.killProtectedRecheckEnabled ? state.killProtectedRecheckMins * 60 * 1000 : KILL_SCANNER_PROTECTED_RESCAN_MS)
            );
            state.killSearchLoopActive = hasUnknowns || hasExpiringAlives || hasProtectedDue;
        }

        if (depositThresholdEl)      depositThresholdEl.value      = formatNumberWithCommas(thresholdValue);
        if (repairEveryEl)           repairEveryEl.value           = String(repairEveryValue);
        if (drugDepositMultiplierEl) drugDepositMultiplierEl.value = String(multiplierValue);
        if (leaveJailMinPointsEl)    leaveJailMinPointsEl.value    = String(minJailPtsValue);
        if (resetTimerMinPointsEl)   resetTimerMinPointsEl.value   = String(minResetPtsValue);

        addLiveLog(
            `Settings saved — ${checked.length} action(s) enabled | Leave Jail: ${
                state.leaveJailEnabled ? 'on (min ' + minJailPtsValue + ' pts)' : 'off'
            } | Timer reset: ${
                state.resetCrimesEnabled ? 'crimes (6pts, min ' + minResetPtsValue + ' pts)' :
                state.resetGTAEnabled    ? 'GTA (3pts, min ' + minResetPtsValue + ' pts)' :
                state.resetMeltEnabled   ? 'melt loop (4pts, min ' + minResetPtsValue + ' pts)' :
                'off'
            }`
        );
        updatePanel();
    }

    // Handles mutual exclusivity of the three timer reset checkboxes.
    // When one is checked, the other two are unchecked in both the UI and state.
    // Also handles the fast mode checkbox which is tied to crime reset.
    function handleResetCheckboxChange(changedId) {
        if (!resetCrimesInput || !resetGTAInput || !resetMeltInput || !killSearchInput) return;

        const all = [
            { id: 'crimes',      el: resetCrimesInput },
            { id: 'gta',         el: resetGTAInput },
            { id: 'melt',        el: resetMeltInput },
            { id: 'killsearch',  el: killSearchInput }
        ];

        // If the changed checkbox is now checked, uncheck the others
        const changed = all.find(x => x.id === changedId);
        if (changed && changed.el.checked) {
            for (const item of all) {
                if (item.id !== changedId) item.el.checked = false;
            }
        }

        // Fast mode only applies when crime reset is active
        if (resetCrimesFastModeInput) {
            const crimesNowChecked = resetCrimesInput.checked;
            resetCrimesFastModeInput.disabled = !crimesNowChecked;
            if (!crimesNowChecked) resetCrimesFastModeInput.checked = false;
        }

        saveSettings();
    }

    // Debounce timer for text input auto-save
    let autoSaveTimer = null;

    function scheduleAutoSave() {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => { autoSaveTimer = null; saveSettings(); }, 800);
    }



    function switchTab(tab) {
        const _pane = document.querySelector(`.ug-tab-pane[data-tab="${tab}"]`);
        activeTab = tab;
        setSetting('activeTab', tab);

        const tabBtns  = document.querySelectorAll('.ug-tab-btn');
        const tabPanes = document.querySelectorAll('.ug-tab-pane');

        tabBtns.forEach(btn => {
            btn.classList.toggle('ug-tab-active', btn.dataset.tab === tab);
        });

        tabPanes.forEach(pane => {
            if (pane.dataset.tab === tab) {
                pane.style.setProperty('display', 'block', 'important');
            } else {
                pane.style.setProperty('display', 'none', 'important');
            }
        });

        // Ensure sub-panes in the newly visible tab are correctly initialised,
        // restoring saved sub-tab position if available
        const activePane = document.querySelector(`.ug-tab-pane[data-tab="${tab}"]`);
        if (activePane) {
            const subParents = [...new Set([...activePane.querySelectorAll('.ug-sub-pane')].map(p => p.dataset.parent))];
            subParents.forEach(parent => {
                const panes = [...activePane.querySelectorAll(`.ug-sub-pane[data-parent="${parent}"]`)];
                const btns  = [...activePane.querySelectorAll(`.ug-sub-btn[data-parent="${parent}"]`)];
                // Check for a saved sub-tab
                const saved = getSetting(`activeSubTab_${parent}`, null);
                const savedPane = saved ? activePane.querySelector(`.ug-sub-pane[data-sub="${saved}"][data-parent="${parent}"]`) : null;
                const savedBtn  = saved ? activePane.querySelector(`.ug-sub-btn[data-sub="${saved}"][data-parent="${parent}"]`) : null;
                if (savedPane && savedBtn) {
                    // Restore saved position
                    btns.forEach(b => b.classList.remove('ug-sub-active'));
                    panes.forEach(p => p.style.setProperty('display', 'none', 'important'));
                    savedBtn.classList.add('ug-sub-active');
                    savedPane.style.setProperty('display', 'block', 'important');
                } else {
                    // Default: first pane visible
                    btns.forEach((b, i) => i === 0 ? b.classList.add('ug-sub-active') : b.classList.remove('ug-sub-active'));
                    panes.forEach((p, i) => {
                        if (i === 0) {
                            p.style.setProperty('display', 'block', 'important');
                        } else {
                            p.style.setProperty('display', 'none', 'important');
                        }
                    });
                }
            });
        }

    }

    function createPanel() {
        if (document.querySelector('#ug-bot-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'ug-bot-panel';
        panel.innerHTML = `
            <div id="ug-bot-header-row">
                <div id="ug-bot-header">
                    UG Bot <span id="ug-bot-version">v${SCRIPT_VERSION}</span>
                    <div id="ug-bot-byline">By Keiran</div>
                </div>
                <div id="ug-bot-header-buttons">
                    <button id="ug-bot-toggle" type="button">Start</button>
                    <button id="ug-bot-compact-btn" type="button">Compact</button>
                    <button id="ug-bot-hide-btn" type="button">Hide</button>
                    <button id="ug-bot-close-btn" type="button">Close</button>
                </div>
            </div>

            <div id="ug-bot-collapsed-controls"></div>

            <div id="ug-bot-extra">

                <!-- TOP-LEVEL TABS -->
                <div id="ug-bot-tabs">
                    <button class="ug-tab-btn ug-tab-active" data-tab="ranking">Ranking</button>
                    <button class="ug-tab-btn" data-tab="perks">Perks</button>
                    <button class="ug-tab-btn" data-tab="drugs">Drugs</button>
                    <button class="ug-tab-btn" data-tab="kill">Kill</button>
                    <button class="ug-tab-btn" data-tab="qt">QT</button>
                    <button class="ug-tab-btn" data-tab="acc">Acc</button>
                    <button class="ug-tab-btn" data-tab="statslog">Log</button>
                </div>

                <div id="ug-bot-tab-content">

                <!-- ==================== RANKING TAB ==================== -->
                <div class="ug-tab-pane" data-tab="ranking" style="display:none;">

                    <!-- Ranking sub-tabs -->
                    <div class="ug-sub-tabs">
                        <button class="ug-sub-btn ug-sub-active" data-sub="crimes" data-parent="ranking">Crimes</button>
                        <button class="ug-sub-btn" data-sub="gtaplus" data-parent="ranking">GTA+</button>
                        <button class="ug-sub-btn" data-sub="rankpoints" data-parent="ranking">Points</button>
                    </div>

                    <!-- CRIMES sub-tab -->
                    <div class="ug-sub-pane" data-sub="crimes" data-parent="ranking" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-autodeposit" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Quick deposit</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:120px;"><input id="ug-bot-deposit-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="Threshold" style="width:130px !important;max-width:130px !important;" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-automissions" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Crime missions</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-disable-crimes-at-gb" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Disable crimes at</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><select id="ug-bot-disable-crimes-rank" data-role="none" class="ug-compact-select">
                                <option value="Civilian">Civilian</option>
                                <option value="Vandal">Vandal</option>
                                <option value="Hustler">Hustler</option>
                                <option value="Riff-Raff">Riff-Raff</option>
                                <option value="Ruffian">Ruffian</option>
                                <option value="Homeboy">Homeboy</option>
                                <option value="Homie">Homie</option>
                                <option value="Criminal">Criminal</option>
                                <option value="Hitman">Hitman</option>
                                <option value="Trusted Hitman">Trusted Hitman</option>
                                <option value="Assassin">Assassin</option>
                                <option value="Trusted Assassin">Trusted Assassin</option>
                                <option value="Gangster">Gangster</option>
                                <option value="Original Gangster">Original Gangster</option>
                                <option value="Boss">Boss</option>
                                <option value="Regional Boss">Regional Boss</option>
                                <option value="Global Boss" selected>Global Boss</option>
                            </select></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-bg-crime" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Background crimes</td></tr>
</table></div>

                        <div class="ug-compact-row" style="margin-top:4px;">
                            <button id="ug-bot-crimes-select-all" type="button" class="ug-small-btn">Select All</button>
                        </div>
                        <div id="ug-bot-actions" style="margin-top:4px;"></div>

                    </div>

                    <!-- GTA+ sub-tab -->
                    <div class="ug-sub-pane" data-sub="gtaplus" data-parent="ranking" style="display:none;">

                        <div id="ug-bot-gta-checkboxes" style="margin-bottom:4px;"></div>
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-bullet-factory" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Bullet factory buying</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-autogivecars" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Car missions</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-autorepair" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Repair every X melts</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-repair-every" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="10" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-disable-gta-at-gb" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Disable GTA at</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><select id="ug-bot-disable-gta-rank" data-role="none" class="ug-compact-select">
                                <option value="Civilian">Civilian</option>
                                <option value="Vandal">Vandal</option>
                                <option value="Hustler">Hustler</option>
                                <option value="Riff-Raff">Riff-Raff</option>
                                <option value="Ruffian">Ruffian</option>
                                <option value="Homeboy">Homeboy</option>
                                <option value="Homie">Homie</option>
                                <option value="Criminal">Criminal</option>
                                <option value="Hitman">Hitman</option>
                                <option value="Trusted Hitman">Trusted Hitman</option>
                                <option value="Assassin">Assassin</option>
                                <option value="Trusted Assassin">Trusted Assassin</option>
                                <option value="Gangster">Gangster</option>
                                <option value="Original Gangster">Original Gangster</option>
                                <option value="Boss">Boss</option>
                                <option value="Regional Boss">Regional Boss</option>
                                <option value="Global Boss" selected>Global Boss</option>
                            </select></td></tr>

                        <tr>
  <td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-bust-noreload" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td>
  <td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;white-space:nowrap;">No reload bust</td>
  <td style="vertical-align:middle;padding:3px 2px;white-space:nowrap;">
    <input id="ug-bot-bust-poll-min" type="text" inputmode="numeric" style="width:28px;max-width:28px;box-sizing:border-box;padding:2px 3px;border:1px solid #444;border-radius:4px;background:#111;color:#fff;font-size:11px;text-align:right;" placeholder="800" />
    <input id="ug-bot-bust-poll-max" type="text" inputmode="numeric" style="width:28px;max-width:28px;box-sizing:border-box;padding:2px 3px;border:1px solid #444;border-radius:4px;background:#111;color:#fff;font-size:11px;text-align:right;" placeholder="1200" />
  </td>
</tr>
<tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-dice-join-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Join free MDs</td></tr>
</table></div>

                    </div>

                    <!-- POINTS sub-tab -->
                    <div class="ug-sub-pane" data-sub="rankpoints" data-parent="ranking" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-leavejail" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Leave jail</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-leavejail-minpoints" type="text" inputmode="numeric" class="ug-compact-input" placeholder="Min pts" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min pts</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-reset-crimes" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Reset crimes</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><label style="display:flex;align-items:center;gap:4px;color:#aaa;font-size:11px;cursor:pointer;white-space:nowrap;"><input id="ug-bot-reset-crimes-fast" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;" /> fast mode</label></td>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-reset-gta" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Reset GTA</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-reset-melt" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Reset melt</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;"></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Min pts for resets</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-reset-minpoints" type="text" inputmode="numeric" class="ug-compact-input" placeholder="Min pts" /></td></tr>
<tr><td colspan="3"><div style="border-top:1px solid #333;margin:4px 0;"></div></td></tr>
<tr><td colspan="4" style="color:#888;font-size:11px;padding:4px 0 2px 0;">Auto-buy Robot BG — min points balance / check every X mins</td></tr>
<tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-auto-buy-bg" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Robot BG</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-auto-buy-bg-minpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="1300" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-auto-buy-bg-mins" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="60" /></td></tr>
</table></div>

                    </div><!-- end rankpoints sub-pane -->
                </div><!-- end ranking tab-pane -->

                <!-- ==================== PERKS TAB ==================== -->
                <div class="ug-tab-pane" data-tab="perks" style="display:none;">

                    <!-- Perks sub-tabs -->
                    <div class="ug-sub-tabs">
                        <button class="ug-sub-btn ug-sub-active" data-sub="extend" data-parent="perks">Extend</button>
                        <button class="ug-sub-btn" data-sub="redeem" data-parent="perks">Redeem</button>
                        <button class="ug-sub-btn" data-sub="bonuspoints" data-parent="perks">Bonus</button>
                    </div>

                    <!-- EXTEND sub-tab -->
                    <div class="ug-sub-pane" data-sub="extend" data-parent="perks" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-perk-extend-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Auto-extend perks</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-qt-perk-extend-mins" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="5" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min interval</td></tr>

<tr><td colspan="4"><div style="border-top:1px solid #333;margin:4px 0;"></div></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-bgs" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">BGs</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-cars" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Cars</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-bullets" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Bullets</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-bullets-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="7500" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min bullets</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-rares" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Rares</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-rares-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="50" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min cars</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-double-melts" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Double melts</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-double-melts-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="50" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min cars</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-bullet-value" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Bullet value</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-bullet-value-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="50" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min cars</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-double-xp" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Double XP</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-double-xp-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="50" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min mins</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-always-successful" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Always successful</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-always-successful-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="50" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min mins</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-always-bust" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Always bust</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-always-bust-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="50" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min mins</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-extend-double-cash" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Double cash</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-extend-double-cash-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="50" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min mins</td></tr>
</table></div>


                    </div>

                    <!-- REDEEM sub-tab -->
                    <div class="ug-sub-pane" data-sub="redeem" data-parent="perks" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-perk-redeem-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Auto redeem perks</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-qt-perk-redeem-mins" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="30" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">min</td></tr>
<tr><td colspan="4"><div style="border-top:1px solid #333;margin:4px 0;"></div></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-cash" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Cash</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">always — redeems all</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-cars" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Cars</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">always — redeems all</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-bg" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">BGs</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">always — redeems all</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-double-cash" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Double cash</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">crimes on — redeems all</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-double-xp" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Double XP</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">crimes on — redeems all</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-always-successful" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Always successful</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">crimes/GTA on — redeems all</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-always-bust" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Always bust</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">bust on — redeems all</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-bullets" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Bullets</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">kill loop — <input id="ug-bot-redeem-bullets-cap" type="text" inputmode="decimal" placeholder="2" maxlength="4" /><span style="padding-left:3px;">perk multi</span></td></tr>

                        <tr><td colspan="4"><div style="border-top:1px solid #333;margin:4px 0;"></div></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-rare" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Rare cars</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">GTA on — balanced with melts</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-double-melt" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Double melts</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">GTA on — balanced with rares</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;"></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Min floor</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-redeem-pair-floor" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="100" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">cars</td></tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-redeem-bullet-value" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">Bullet value</td><td colspan="2" style="color:#666;font-size:10px;padding:3px 8px 3px 0;vertical-align:middle;white-space:nowrap;">GTA on — redeems all</td></tr>
</table></div>


                    </div>

                    <!-- BONUS POINTS sub-tab -->
                    <div class="ug-sub-pane" data-sub="bonuspoints" data-parent="perks" style="display:none;">
                        <div class="ug-row">
                            <div class="ug-section-box">
                                <div class="ug-section-title">Bonus Points <span id="ug-bot-bonus-points-count" style="font-weight:normal;color:#9fe79f;font-size:11px;"></span></div>
<table style="width:auto;border-collapse:collapse;">
                                <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-bonus-points-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Auto-spend bonus points</td></tr>

<tr><td colspan="4" style="padding:2px 0;"><div class="ug-helptext" style="margin-top:4px;">Buys perks in priority order whenever you have enough points.<br>Drag to reorder.</div>
                                <div class="ug-action-divider"></div>
                                <table id="ug-bot-bonus-priority-list" style="width:100%;border-collapse:collapse;">
                                    <tbody>
                                    <tr class="ug-bonus-item" data-bp="sucjail2" data-cost="2" draggable="true">
                                        <td style="width:18px;cursor:grab;color:#888;font-size:16px;text-align:center;vertical-align:middle;padding:3px 4px;">≡</td>
                                        <td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input type="checkbox" class="ug-bonus-cb" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td>
                                        <td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Bust 3 hours</td>
                                        <td style="color:#888;font-size:11px;white-space:nowrap;vertical-align:middle;text-align:right;">2pts</td>
                                    </tr>
                                    <tr class="ug-bonus-item" data-bp="rare2" data-cost="4" draggable="true">
                                        <td style="width:18px;cursor:grab;color:#888;font-size:16px;text-align:center;vertical-align:middle;padding:3px 4px;">≡</td>
                                        <td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input type="checkbox" class="ug-bonus-cb" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td>
                                        <td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Next 3 cars rare</td>
                                        <td style="color:#888;font-size:11px;white-space:nowrap;vertical-align:middle;text-align:right;">4pts</td>
                                    </tr>
                                    <tr class="ug-bonus-item" data-bp="sucother2" data-cost="10" draggable="true">
                                        <td style="width:18px;cursor:grab;color:#888;font-size:16px;text-align:center;vertical-align:middle;padding:3px 4px;">≡</td>
                                        <td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input type="checkbox" class="ug-bonus-cb" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td>
                                        <td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Always successful 60 mins</td>
                                        <td style="color:#888;font-size:11px;white-space:nowrap;vertical-align:middle;text-align:right;">10pts</td>
                                    </tr>
                                    <tr class="ug-bonus-item" data-bp="dblxp2" data-cost="10" draggable="true">
                                        <td style="width:18px;cursor:grab;color:#888;font-size:16px;text-align:center;vertical-align:middle;padding:3px 4px;">≡</td>
                                        <td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input type="checkbox" class="ug-bonus-cb" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td>
                                        <td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Double XP 10 mins</td>
                                        <td style="color:#888;font-size:11px;white-space:nowrap;vertical-align:middle;text-align:right;">10pts</td>
                                    </tr>
                                    </tbody>
                                </table>
                                </td></tr>
</table>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>

                <!-- ==================== DRUGS TAB ==================== -->
                <div class="ug-tab-pane" data-tab="drugs" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">
                    <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-autodrugs" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Drug run</td><td style="width:1px;"></td></tr>
                    <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-drug-comp" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Comp mode</td><td style="width:1px;"></td></tr>
                    <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;"></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Swiss deposit multiplier</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-drug-deposit-multiplier" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">x run cost</td></tr>
                    <tr><td colspan="4"><div id="ug-bot-drug-deposit-calc" class="ug-drug-calc-info"></div></td></tr>
                    <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-leave-cash-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Leave cash on hand</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:120px;"><input id="ug-bot-leave-cash-on-hand" type="text" inputmode="numeric" class="ug-compact-input" placeholder="5,000,000,000" style="width:130px !important;max-width:130px !important;" /></td></tr>
                    <tr><td colspan="4" style="padding:4px 0 2px;">
                        <button id="ug-bot-sell-all-drugs" class="ug-action-btn">Sell All Drugs</button>
                        <div id="ug-bot-sell-all-status" class="ug-helptext" style="margin-top:2px;"></div>
                    </td></tr>
                    <tr><td colspan="4"><div style="border-top:1px solid #333;margin:4px 0;"></div></td></tr>
</table></div>

                </div>

                <!-- ==================== KILL TAB ==================== -->
                <div class="ug-tab-pane" data-tab="kill" style="display:none;">

                    <!-- Kill sub-tabs -->
                    <div class="ug-sub-tabs">
                        <button class="ug-sub-btn ug-sub-active" data-sub="killsettings" data-parent="kill">Settings</button>
                        <button class="ug-sub-btn" data-sub="killlist" data-parent="kill">List</button>
                    </div>

                    <!-- SETTINGS sub-tab -->
                    <div class="ug-sub-pane" data-sub="killsettings" data-parent="kill" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-kill-scan-online" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Scan players online</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><select id="ug-bot-kill-scan-interval" data-role="none" class="ug-compact-select">
                                <option value="0.5">30s</option>
                                <option value="1">1 min</option>
                                <option value="1.5">1m 30s</option>
                                <option value="2">2 mins</option>
                                <option value="2.5">2m 30s</option>
                                <option value="3">3 mins</option>
                                <option value="3.5">3m 30s</option>
                                <option value="4">4 mins</option>
                                <option value="4.5">4m 30s</option>
                                <option value="5">5 mins</option>
                            </select></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-kill-search" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Search players</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-kill-protected-recheck" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Search protected</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><select id="ug-bot-kill-protected-recheck-mins" data-role="none" class="ug-compact-select">
                                <option value="1">1 min</option>
                                <option value="2">2 mins</option>
                                <option value="3">3 mins</option>
                                <option value="4">4 mins</option>
                                <option value="5">5 mins</option>
                                <option value="10">10 mins</option>
                                <option value="15">15 mins</option>
                                <option value="20">20 mins</option>
                            </select></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-kill-bgcheck" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">BG/Kill loop</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><select id="ug-bot-kill-bgcheck-interval" data-role="none" class="ug-compact-select">
                                <option value="0.083">5m</option>
                                <option value="0.167">10m</option>
                                <option value="0.25">15m</option>
                                <option value="0.333">20m</option>
                                <option value="0.5">30m</option>
                                <option value="0.75">45m</option>
                                <option value="1">1hr</option>
                                <option value="1.5">1.5hr</option>
                                <option value="2">2hr</option>
                                <option value="3">3hr</option>
                                <option value="4">4hr</option>
                                <option value="6">6hr</option>
                                <option value="8">8hr</option>
                                <option value="12">12hr</option>
                                <option value="24">24hr</option>
                            </select></td></tr>
                        <tr><td></td><td colspan="2" style="font-size:10px;color:#666;padding:0 0 4px 0;">Applies to BG Check &amp; BG Farm players</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-kill-bg-spam" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">BG Spam</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><select id="ug-bot-kill-bg-spam-interval" data-role="none" class="ug-compact-select">
                                <option value="1">1s</option>
                                <option value="2" selected="">2s</option>
                                <option value="3">3s</option>
                                <option value="5">5s</option>
                                <option value="10">10s</option>
                                <option value="15">15s</option>
                                <option value="30">30s</option>
                            </select></td></tr>
                        <tr><td></td><td colspan="2" style="padding:2px 0 4px 0;"><select id="ug-bot-kill-bg-spam-target" data-role="none" class="ug-compact-select" style="width:100%;max-width:220px;"><option value="">— No BG Farm players —</option></select></td></tr>
                        <tr><td></td><td colspan="2" style="font-size:10px;color:#666;padding:0 0 4px 0;">Suppresses drug run &amp; bullet factory travel</td></tr>
                        <tr><td></td><td colspan="2" style="padding:2px 0 6px 0;"><button id="ug-bot-bgfarm-set-wait" type="button" style="font-size:10px;padding:2px 6px;background:#2a2a2a;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer;">Set 3hr wait for all BG Farm players</button></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-kill-anonymous" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Hide name</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-auto-buy-gun" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 4px 3px 0;vertical-align:middle;">Auto buy gun</td><td style="vertical-align:middle;padding:3px 4px 3px 0;white-space:nowrap;font-size:11px;color:#aaa;"><input id="ug-bot-auto-buy-gun-awp" type="checkbox" style="width:11px;height:11px;margin:0 2px 0 4px;padding:0;cursor:pointer;vertical-align:middle;" />AWP <input id="ug-bot-auto-buy-gun-ak47" type="checkbox" style="width:11px;height:11px;margin:0 2px 0 6px;padding:0;cursor:pointer;vertical-align:middle;" />AK47</td><td style="vertical-align:middle;padding:3px 0;white-space:nowrap;"><input id="ug-bot-auto-buy-gun-pts" type="text" inputmode="numeric" placeholder="100" maxlength="6" class="ug-compact-input-sm" /><span style="color:#666;font-size:10px;padding-left:3px;">pt min</span></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;"></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Kill penalty threshold</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-kill-penalty-threshold" data-role="none" type="text" inputmode="decimal" placeholder="e.g. 1.5" class="ug-compact-input" /></td></tr>
</table></div>


                    </div>

                    <!-- LIST sub-tab -->
                    <div class="ug-sub-pane" data-sub="killlist" data-parent="kill" style="display:none;">
                        <div class="ug-row">
                            <div class="ug-subtitle" style="margin-bottom:6px;">Player list <span id="ug-bot-kill-count" style="font-weight:normal;color:#aaa;font-size:11px;"></span></div>
                            <div id="ug-bot-kill-list" class="ug-kill-list"></div>
                            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                                <button id="ug-bot-kill-clear" type="button" class="ug-small-btn">Clear</button>
                                <button id="ug-bot-kill-copy" type="button" class="ug-small-btn">Copy</button>
                                <button id="ug-bot-kill-import" type="button" class="ug-small-btn">Import</button>
                                <button id="ug-bot-kill-select-all-bg" type="button" class="ug-small-btn">All BG</button>
                                <button id="ug-bot-kill-select-all-shoot" type="button" class="ug-small-btn">All Kill</button>
                            </div>
                        </div>
                    </div>

                </div>

                <!-- ==================== QT TAB ==================== -->
                <div class="ug-tab-pane" data-tab="qt" style="display:none;">

                    <!-- QT sub-tabs -->
                    <div class="ug-sub-tabs">
                        <button class="ug-sub-btn ug-sub-active" data-sub="qtperks" data-parent="qt">Perks</button>
                        <button class="ug-sub-btn" data-sub="qtcars" data-parent="qt">Cars</button>
                    </div>

                    <!-- QT PERKS sub-tab -->
                    <div class="ug-sub-pane" data-sub="qtperks" data-parent="qt" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-perks-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;">QT Perks</td><td colspan="2" style="vertical-align:middle;padding:3px 0;"><span style="display:inline-flex;align-items:center;gap:3px;"><input id="ug-bot-qt-poll-min" type="text" inputmode="numeric" min="100" step="100" class="ug-compact-input ug-compact-input-sm" placeholder="300" /><span style="color:#888;font-size:11px;">to</span><input id="ug-bot-qt-poll-max" type="text" inputmode="numeric" min="100" step="100" class="ug-compact-input ug-compact-input-sm" placeholder="500" /><span style="color:#888;font-size:10px;">ms</span></span></td></tr>
</table></div>
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-points-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Points</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-qt-points-threshold" type="text" inputmode="numeric" class="ug-compact-input" placeholder="10000000" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">$/pt</td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-bg-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Bot BGs</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-qt-bg-threshold" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="1000" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">pts</td></tr>

                        <tr>
                            <td colspan="2"></td>
                            <td style="color:#888;font-size:10px;padding:0 2px 3px;text-align:center;white-space:nowrap;">$/bullet</td>
                            <td style="color:#888;font-size:10px;padding:0 0 3px 4px;white-space:nowrap;">Min count</td>
                        </tr>
                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-bullets-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Bullets</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-bullets-threshold" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="75000" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-bullets-min" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="7500" /></td></tr>

                        <tr><td colspan="4"><div style="border-top:1px solid #333;margin:4px 0;"></div></td></tr>
                        <tr>
                            <td colspan="2"></td>
                            <td style="color:#888;font-size:10px;padding:0 2px 3px;text-align:center;white-space:nowrap;">pts/unit</td>
                            <td style="color:#888;font-size:10px;padding:0 0 3px 4px;white-space:nowrap;">Min amt</td>
                        </tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-bust-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Always Bust</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-bust-maxpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-bust-minamt" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="30 mins" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-always-succ-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Always Successful</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-always-succ-maxpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-always-succ-minamt" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="30 mins" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-double-melts-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Double melts</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-double-melts-maxpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-double-melts-minamt" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="50 cars" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-double-xp-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Double XP</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-double-xp-maxpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-double-xp-minamt" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="100 mins" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-double-cash-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Double cash</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-double-cash-maxpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-double-cash-minamt" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="30 mins" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-rare-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Rare cars</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-rare-maxpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-rare-minamt" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="50 cars" /></td></tr>

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-bullet-value-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Bullet value</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 2px;width:1px;"><input id="ug-bot-qt-bullet-value-maxpts" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="3" /></td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0 3px 4px;width:1px;"><input id="ug-bot-qt-bullet-value-minamt" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="20 cars" /></td></tr>
</table></div>


                    </div>

                    <!-- QT CARS sub-tab -->
                    <!-- QT CARS sub-tab -->
                    <div class="ug-sub-pane" data-sub="qtcars" data-parent="qt" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;"><table style="width:auto;border-collapse:collapse;">

                        <tr><td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;"><input id="ug-bot-qt-cars-enabled" type="checkbox" style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" /></td><td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">Cars</td><td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;"><input id="ug-bot-qt-cars-interval" type="text" inputmode="numeric" class="ug-compact-input ug-compact-input-sm" placeholder="300" /></td><td style="color:#888;font-size:10px;padding-left:3px;vertical-align:middle;white-space:nowrap;">secs</td></tr>
</table>
                        <div style="border-top:1px solid #333;margin:6px 0 4px;"></div>
                        <div id="ug-bot-qt-cars-list"></div>
</div>

                    </div>

                </div>

                <!-- ==================== LOG TAB ==================== -->
                <div class="ug-tab-pane" data-tab="statslog" style="display:none;">
                    <div class="ug-row" style="margin-bottom:6px;display:flex;gap:6px;flex-wrap:wrap;">
                        <button id="ug-bot-copy-log" type="button" class="ug-small-btn">Copy log</button>
                        <button id="ug-bot-clear-log" type="button" class="ug-small-btn">Clear log</button>
                    </div>
                    <div id="ug-bot-log" class="ug-log"></div>
                </div>

                <!-- ==================== ACC TAB ==================== -->
                <div class="ug-tab-pane" data-tab="acc" style="display:none;">

                    <!-- Acc sub-tabs -->
                    <div class="ug-sub-tabs">
                        <button class="ug-sub-btn ug-sub-active" data-sub="account" data-parent="acc">Account</button>
                        <button class="ug-sub-btn" data-sub="usernames" data-parent="acc">Usernames</button>
                    </div>

                    <!-- ACCOUNT sub-tab -->
                    <div class="ug-sub-pane" data-sub="account" data-parent="acc" style="display:none;">
<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;">
                        <div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
                            <input id="ug-bot-acc-enabled" type="checkbox" style="width:13px;height:13px;min-width:13px;margin:0;padding:0;cursor:pointer;" />
                            <span style="color:#ddd;font-size:12px;">Auto account creation</span>
                        </div>
                        <div style="margin-top:6px;display:flex;gap:6px;">
                            <input id="ug-bot-acc-email" type="text" placeholder="Login email" class="ug-input" style="flex:1;min-width:0;" />
                            <input id="ug-bot-acc-password" type="password" placeholder="Password" class="ug-input" style="flex:1;min-width:0;" />
                        </div>
                        <div class="ug-helptext" style="margin-top:3px;">Stored locally — never sent anywhere except the game's login form.</div>
                        <div style="border-top:1px solid #333;margin:6px 0;"></div>
                        <div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
                            <input id="ug-bot-acc-retrieve" type="checkbox" style="width:13px;height:13px;min-width:13px;margin:0;padding:0;cursor:pointer;" />
                            <span style="color:#ddd;font-size:12px;">Auto retrieve assets</span>
                        </div>
                        <div style="margin-top:4px;">
                            <button id="ug-bot-acc-retrieve-now" type="button" class="ug-small-btn">Retrieve now</button>
                        </div>
</div>

<div style="width:100%;background:#1b1b1b;border:1px solid #444;border-radius:6px;padding:8px;box-sizing:border-box;margin-bottom:4px;overflow:hidden;">
                        <div style="color:#aaa;font-size:11px;font-weight:bold;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Personality</div>
                        <div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
                            <input id="ug-bot-dupe-mode" type="checkbox" style="width:13px;height:13px;min-width:13px;margin:0;padding:0;cursor:pointer;" />
                            <span style="color:#ddd;font-size:12px;">Dupe mode — generate a random personality</span>
                        </div>
                        <div class="ug-helptext" style="margin-top:3px;">Makes this account behave distinctly from others — unique delays, GTA timing, jail behaviour, and navigation patterns. Ticking this regenerates the personality immediately.</div>
                        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
                            <button id="ug-bot-personality-reset" type="button" class="ug-small-btn">Reset personality</button>
                        </div>
                        <div id="ug-bot-personality-info" style="margin-top:5px;font-size:10px;color:#666;min-height:12px;"></div>
</div>

                    </div>

                    <!-- USERNAMES sub-tab -->
                    <div class="ug-sub-pane" data-sub="usernames" data-parent="acc" style="display:none;">
                        <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
                            <button id="ug-bot-acc-generate" type="button" class="ug-small-btn">Generate random names</button>
                            <button id="ug-bot-acc-clear-names" type="button" class="ug-small-btn">Clear list</button>
                        </div>
                        <textarea id="ug-bot-acc-names" placeholder="One username per line&#10;e.g.&#10;Saka7&#10;Gunners 99&#10;North London" class="ug-textarea"></textarea>
                        <div id="ug-bot-acc-status" style="margin-top:6px;font-size:11px;color:#9fe79f;min-height:14px;"></div>
                    </div>

            </div><!-- end ug-bot-tab-content -->
            </div><!-- end ug-bot-extra -->
        `;

        const style = document.createElement('style');
        style.textContent = `
            #ug-bot-panel label {
                display: inline !important;
                font-weight: normal !important;
                margin: 0 !important;
                padding: 0 !important;
                width: auto !important;
                float: none !important;
            }

            #ug-bot-panel {
                position: fixed;
                right: 16px;
                bottom: 16px;
                z-index: 2147483647;
                width: 390px;
                max-height: 82vh;
                overflow: auto;
                overflow-x: hidden;
                background: rgb(15, 15, 15);
                color: #fff;
                border: 1px solid #777;
                border-radius: 10px;
                padding: 12px;
                font-family: Arial, sans-serif;
                box-shadow: 0 6px 18px rgba(0,0,0,0.4);
            }
            #ug-bot-header-row {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                margin-bottom: 10px;
                gap: 8px;
            }
            #ug-bot-header { font-size: 16px; font-weight: bold; }
            #ug-bot-version { font-size: 11px; font-weight: normal; opacity: 0.7; }
            #ug-bot-byline {
                font-size: 10px;
                font-weight: normal;
                color: #888;
                margin-top: 2px;
                letter-spacing: 0.3px;
            }
            #ug-bot-header-buttons { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
            #ug-bot-compact-btn, #ug-bot-toggle, #ug-bot-hide-btn, #ug-bot-close-btn { padding: 4px 8px; font-size: 11px; margin: 0; }
            #ug-bot-hide-btn { background: #1a2a3a !important; border-color: #448 !important; color: #88f !important; }
            #ug-bot-close-btn { background: #3a1a1a !important; border-color: #a44 !important; color: #f88 !important; }
            #ug-bot-panel.ug-collapsed #ug-bot-close-btn { display: none; }
            #ug-bot-panel.ug-collapsed #ug-bot-hide-btn { }

            #ug-bot-panel .ug-row { margin-bottom: 10px; }
            #ug-bot-panel button {
                margin-right: 6px;
                margin-bottom: 6px;
                padding: 6px 10px;
                border: 1px solid #777;
                border-radius: 6px;
                background: #2f2f2f;
                color: #fff;
                cursor: pointer;
            }
            #ug-bot-tabs {
                display: flex;
                gap: 3px;
                margin-bottom: 10px;
                flex-wrap: wrap;
            }
            .ug-tab-btn {
                flex: 1;
                padding: 5px 4px !important;
                font-size: 11px !important;
                margin: 0 !important;
                border: 1px solid #555 !important;
                border-radius: 5px !important;
                background: #222 !important;
                color: #aaa !important;
                cursor: pointer;
                white-space: nowrap;
            }
            .ug-tab-btn.ug-tab-active {
                background: #444 !important;
                color: #fff !important;
                border-color: #888 !important;
            }
            .ug-tab-pane { }

            #ug-bot-extra {
                height: 460px;
                overflow-y: auto;
                overflow-x: hidden;
            }

            /* Sub-tabs */
            .ug-sub-tabs {
                display: flex;
                gap: 4px;
                margin-bottom: 10px;
                flex-wrap: wrap;
            }
            .ug-sub-btn {
                font-size: 11px !important;
                padding: 4px 10px !important;
                border-radius: 5px !important;
                border: 1px solid #555 !important;
                background: #222 !important;
                color: #aaa !important;
                cursor: pointer;
            }
            .ug-sub-btn.ug-sub-active {
                background: #444 !important;
                color: #fff !important;
                border-color: #888 !important;
            }
            .ug-sub-pane { }

            /* Utility input/select/textarea */
            .ug-input {
                width: 100%;
                box-sizing: border-box;
                padding: 7px 8px;
                border: 1px solid #555;
                border-radius: 6px;
                background: #111;
                color: #fff;
                font-size: 12px;
            }
            .ug-select {
                width: 100%;
                box-sizing: border-box;
                padding: 7px 8px;
                border: 1px solid #555;
                border-radius: 6px;
                background: #111;
                color: #fff;
                font-size: 12px;
            }
            .ug-textarea {
                width: 100%;
                box-sizing: border-box;
                height: 200px;
                padding: 7px 8px;
                border: 1px solid #555;
                border-radius: 6px;
                background: #1b1b1b;
                color: #fff;
                font-size: 11px;
                resize: vertical;
                font-family: monospace;
            }
            .ug-small-btn {
                font-size: 11px !important;
                padding: 4px 8px !important;
            }
            .ug-perk-threshold {
                color: #888;
                font-size: 10px;
                margin-left: 4px;
            }

            /* Bonus points drag list */
            #ug-bot-bonus-priority-list {
                width: 100%;
                border-collapse: collapse;
                margin-top: 6px;
            }
            .ug-bonus-item {
                cursor: default;
            }
            .ug-bonus-item:hover td {
                background: #1e1e1e;
            }
            .ug-bonus-item.ug-drag-over td {
                background: #2a2a2a;
            }
            .ug-bonus-item.ug-dragging {
                opacity: 0.4;
            }
            .ug-drag-handle {
                color: #555;
                cursor: grab;
                font-size: 16px;
                user-select: none;
                text-align: center;
            }

            /* Settings table — force checkbox visibility */
            #ug-bot-panel table td input[type="checkbox"] {
                -webkit-appearance: checkbox !important;
                appearance: checkbox !important;
                display: inline-block !important;
                width: 13px !important;
                height: 13px !important;
                min-width: 13px !important;
                min-height: 13px !important;
                max-width: 13px !important;
                max-height: 13px !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 1px solid #888 !important;
                background: #222 !important;
                flex-shrink: 0 !important;
                cursor: pointer !important;
                vertical-align: middle !important;
                opacity: 1 !important;
                visibility: visible !important;
            }
            /* Hide number input spinners */
            #ug-bot-panel input[type="number"]::-webkit-inner-spin-button,
            #ug-bot-panel input[type="number"]::-webkit-outer-spin-button {
                -webkit-appearance: none !important;
                margin: 0 !important;
            }
            #ug-bot-panel input[type="number"] {
                -moz-appearance: textfield !important;
            }
/* Per-ID overrides for paired inputs */
            #ug-bot-bust-poll-min, #ug-bot-bust-poll-max,
            #ug-bot-qt-poll-min, #ug-bot-qt-poll-max {
                width: 32px !important;
                max-width: 32px !important;
            }
            #ug-bot-deposit-threshold,
            #ug-bot-leave-cash-on-hand {
                width: 130px !important;
                max-width: 130px !important;
            }
            /* Small input for intervals/counts */
            #ug-bot-panel .ug-compact-input-sm {
                width: 52px !important;
                max-width: 52px !important;
                padding: 2px 4px !important;
                border: 1px solid #444 !important;
                border-radius: 4px !important;
                background: #111 !important;
                color: #fff !important;
                font-size: 11px !important;
                text-align: right !important;
            }
            /* Extra small input for 1-2 digit values */
            #ug-bot-panel .ug-compact-input-xs {
                width: 28px !important;
                max-width: 28px !important;
                padding: 2px 3px !important;
                border: 1px solid #444 !important;
                border-radius: 4px !important;
                background: #111 !important;
                color: #fff !important;
                font-size: 11px !important;
                text-align: right !important;
            }
            /* Strip game's jQuery Mobile radio label padding */
            #ug-bot-panel label:has(input[type="radio"]) {
                padding: 0 !important;
                margin: 0 !important;
                display: inline-flex !important;
                align-items: center !important;
                background: none !important;
                border: none !important;
                box-shadow: none !important;
                font-size: 11px !important;
                color: #aaa !important;
            }
            #ug-bot-panel input[type="radio"] {
                width: 11px !important;
                height: 11px !important;
                margin: 0 3px 0 0 !important;
                padding: 0 !important;
            }
            /* Settings input/select style */
            #ug-bot-panel .ug-compact-input {
                width: 110px !important;
                box-sizing: border-box !important;
                padding: 2px 5px !important;
                border: 1px solid #444 !important;
                border-radius: 4px !important;
                background: #111 !important;
                color: #fff !important;
                font-size: 11px !important;
                text-align: right !important;
            }
            #ug-bot-panel .ug-compact-select {
                box-sizing: border-box !important;
                padding: 2px 4px !important;
                border: 1px solid #444 !important;
                border-radius: 4px !important;
                background: #111 !important;
                color: #fff !important;
                font-size: 11px !important;
                max-width: 120px !important;
            }
            /* Settings table rows */
            #ug-bot-panel table {
                border-collapse: collapse;
                table-layout: auto;
            }
            #ug-bot-panel table tr td {
                font-size: 12px;
                color: #ddd;
                vertical-align: middle;
                padding: 3px 4px 3px 0;
                text-align: left !important;
                white-space: nowrap;
            }

            /* Checkbox col — fixed narrow width */
            #ug-bot-panel table:not(.ug-kill-table) tr td:first-child {
                width: 18px !important;
                min-width: 18px !important;
                max-width: 18px !important;
            }
            .ug-kill-table tr td:first-child {
                width: auto !important;
                min-width: 0 !important;
                max-width: none !important;
            }
            /* Input col — shrink to content, never overflow */
            #ug-bot-panel table tr td:last-child:not(:first-child) {
                width: 1px;
                white-space: nowrap;
            }
            #ug-bot-tab-content { min-height: 0; }
            #ug-bot-panel input[type="number"],
            #ug-bot-panel input[type="text"]:not(#ug-bot-bust-poll-min):not(#ug-bot-bust-poll-max):not(#ug-bot-qt-poll-min):not(#ug-bot-qt-poll-max):not(#ug-bot-deposit-threshold):not(#ug-bot-leave-cash-on-hand):not(#ug-bot-redeem-bullets-cap) {
                width: 100%;
                box-sizing: border-box;
                padding: 7px 8px;
                border: 1px solid #555;
                border-radius: 6px;
                background: #1b1b1b;
                color: #fff;
                font-size: 12px;
            }
            /* Compact inputs override the full-width rule above */
            #ug-bot-panel .ug-compact-input {
                width: 110px !important;
                max-width: 80px !important;
                padding: 2px 5px !important;
                border-radius: 4px !important;
                background: #111 !important;
                font-size: 11px !important;
                text-align: right !important;
            }
            #ug-bot-panel .ug-check label { display: flex; align-items: center; gap: 8px; font-size: 12px; }
            .ug-subtitle {
                display: block;
                font-size: 12px;
                font-weight: bold;
                padding: 4px 0 3px 0;
                color: #d8d8d8;
            }
            .ug-helptext {
                display: block;
                font-size: 11px;
                color: #888;
                padding: 3px 0 2px 0;
            }
            .ug-helptext { margin-top: 5px; font-size: 11px; color: #aaa; line-height: 1.35; }
            #ug-bot-log {
                font-size: 11px;
                line-height: 1.35;
                background: #111;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 8px;
                max-height: 460px;
                overflow: auto;
            }
            .ug-log-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
            #ug-bot-actions,
            #ug-bot-gta-checkboxes {
                width: 100%;
                background: #1b1b1b;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 8px;
                box-sizing: border-box;
            }
            #ug-bot-actions table,
            #ug-bot-gta-checkboxes table {
                width: 100%;
                border-collapse: collapse;
                table-layout: fixed;
            }
            .ug-section-box {
                background: #1b1b1b;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .ug-section-title {
                font-size: 12px;
                font-weight: bold;
                color: #d8d8d8;
                margin-bottom: 2px;
            }

            .ug-action-locked { opacity: 0.4; cursor: default; }
            .ug-locked-tag {
                font-size: 10px;
                color: #f88;
                background: rgba(255,80,80,0.15);
                border: 1px solid rgba(255,80,80,0.3);
                border-radius: 4px;
                padding: 1px 5px;
                margin-left: auto;
            }
            .ug-action-divider { border-top: 1px solid #444; margin: 3px 0; }
            .ug-statslog-subtabs_REMOVED {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-bottom: 10px;
            }




            .ug-drug-calc-info {
                margin-top: 6px;
                font-size: 11px;
                color: #9fe79f;
                line-height: 1.4;
                min-height: 14px;
            }
            .ug-kill-list {
                max-height: 280px;
                overflow-y: auto;
                overflow-x: hidden;
                background: #111;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 6px;
                font-size: 11px;
                text-align: left;
            }
            .ug-kill-list table { width: 100% !important; border-collapse: collapse !important; table-layout: fixed !important; }
            .ug-kill-list td { width: auto !important; padding: 0 !important; vertical-align: middle !important; }
            .ug-kill-list .ug-kname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .ug-kill-list .ug-kcountry { width: 52px !important; min-width: 52px !important; max-width: 52px !important; font-size: 9px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 4px !important; }
            .ug-kill-list .ug-ktime { width: 34px !important; min-width: 34px !important; max-width: 34px !important; font-size: 9px; color: #ccc; text-align: right; white-space: nowrap; padding-right: 4px !important; }
            .ug-kill-list .ug-kcol { width: 20px !important; min-width: 20px !important; max-width: 20px !important; text-align: center; }
            /* Fake checkbox divs — avoid jQuery Mobile interference entirely */
            .ug-kcb {
                width: 13px;
                height: 13px;
                border: 1px solid #888;
                background: #222;
                display: inline-block;
                cursor: pointer;
                box-sizing: border-box;
                position: relative;
                flex-shrink: 0;
                vertical-align: middle;
            }
            .ug-kcb.checked {
                background: #2a6;
                border-color: #2a6;
            }
            .ug-kcb.checked::after {
                content: '';
                position: absolute;
                left: 2px;
                top: 0px;
                width: 4px;
                height: 8px;
                border: 2px solid #fff;
                border-top: none;
                border-left: none;
                transform: rotate(45deg);
            }
            .ug-kill-group-title {
                font-weight: bold;
                font-size: 11px;
                color: #d8d8d8;
                margin: 6px 0 3px 0;
                padding-bottom: 2px;
                border-bottom: 1px solid #333;
                text-align: left;
            }
            .ug-kill-group-title:first-child { margin-top: 0; }
            .ug-kill-entry {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 2px 0;
                border-bottom: 1px solid rgba(255,255,255,0.04);
                gap: 8px;
            }
            .ug-kill-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                text-align: left;
            }
            .ug-kill-meta { color: #666; font-size: 10px; flex-shrink: 0; text-align: right; }
            .ug-kill-empty { color: #666; font-size: 11px; font-style: italic; padding: 8px; text-align: left; }
            .ug-fast-mode-label {
                margin-left: 22px;
                opacity: 0.85;
                font-style: italic;
            }
            .ug-fast-mode-label.ug-disabled-sub {
                opacity: 0.35;
                cursor: default;
            }
            #ug-bot-collapsed-controls {
                display: none;
                color: #9fe79f;
            }
            #ug-bot-panel.ug-collapsed { width: 300px; max-height: none; padding: 10px; }
            #ug-bot-panel.ug-collapsed #ug-bot-extra { display: none; }
            #ug-bot-panel.ug-collapsed #ug-bot-collapsed-controls {
                display: block;
                font-size: 12px;
                line-height: 1.6;
            }

            .ug-melt-protected-row { opacity: 0.4 !important; background: rgba(180,180,180,0.12) !important; }
            .ug-melt-protected-tag {
                display: inline-block;
                margin-left: 8px;
                font-size: 10px;
                color: #ddd;
                background: rgba(140,140,140,0.25);
                border: 1px solid rgba(180,180,180,0.25);
                border-radius: 4px;
                padding: 1px 5px;
                vertical-align: middle;
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(panel);

        toggleBtn               = document.querySelector('#ug-bot-toggle');
        autoDepositInput        = document.querySelector('#ug-bot-autodeposit');
        depositThresholdEl           = document.querySelector('#ug-bot-deposit-threshold');
        bustNoReloadInput            = document.querySelector('#ug-bot-bust-noreload');
        bustPollMinEl                = document.querySelector('#ug-bot-bust-poll-min');
        bustPollMaxEl                = document.querySelector('#ug-bot-bust-poll-max');
        extendBulletsThreshEl        = document.querySelector('#ug-bot-extend-bullets-threshold');
        extendRaresThreshEl          = document.querySelector('#ug-bot-extend-rares-threshold');
        extendDoubleMeltsThreshEl    = document.querySelector('#ug-bot-extend-double-melts-threshold');
        extendBulletValueThreshEl    = document.querySelector('#ug-bot-extend-bullet-value-threshold');
        extendDoubleXpThreshEl       = document.querySelector('#ug-bot-extend-double-xp-threshold');
        extendAlwaysSuccThreshEl     = document.querySelector('#ug-bot-extend-always-successful-threshold');
        extendAlwaysBustThreshEl     = document.querySelector('#ug-bot-extend-always-bust-threshold');
        extendDoubleCashThreshEl     = document.querySelector('#ug-bot-extend-double-cash-threshold');
        autoRepairInput         = document.querySelector('#ug-bot-autorepair');
        repairEveryEl           = document.querySelector('#ug-bot-repair-every');
        autoMissionsInput       = document.querySelector('#ug-bot-automissions');
        autoGiveCarsInput       = document.querySelector('#ug-bot-autogivecars');
        autoDrugsInput          = document.querySelector('#ug-bot-autodrugs');
        drugDepositMultiplierEl = document.querySelector('#ug-bot-drug-deposit-multiplier');
        leaveJailInput          = document.querySelector('#ug-bot-leavejail');
        leaveJailMinPointsEl    = document.querySelector('#ug-bot-leavejail-minpoints');
        resetCrimesInput         = document.querySelector('#ug-bot-reset-crimes');
        resetCrimesFastModeInput = document.querySelector('#ug-bot-reset-crimes-fast');
        resetGTAInput            = document.querySelector('#ug-bot-reset-gta');
        resetMeltInput           = document.querySelector('#ug-bot-reset-melt');
        resetTimerMinPointsEl    = document.querySelector('#ug-bot-reset-minpoints');
        bgCrimeEnabledInput         = document.querySelector('#ug-bot-bg-crime');
        diceJoinEnabledInput        = document.querySelector('#ug-bot-dice-join-enabled');
        bulletFactoryEnabledInput   = document.querySelector('#ug-bot-bullet-factory');
        killProtectedRecheckInput   = document.querySelector('#ug-bot-kill-protected-recheck');
        killProtectedRecheckMinsEl  = document.querySelector('#ug-bot-kill-protected-recheck-mins');
        qtBgEnabledInput         = document.querySelector('#ug-bot-qt-bg-enabled');
        const qtPerksEnabledEl = document.querySelector('#ug-bot-qt-perks-enabled');
        if (qtPerksEnabledEl) {
            qtPerksEnabledEl.checked = state.qtPerksEnabled;
            qtPerksEnabledEl.addEventListener('change', () => {
                state.qtPerksEnabled = qtPerksEnabledEl.checked;
                if (qtPerksEnabledEl.checked) {
                    startQTSniper();
                } else {
                    stopQTSniper();
                }
            });
        }
        qtBgThresholdEl          = document.querySelector('#ug-bot-qt-bg-threshold');
        qtBulletsEnabledInput    = document.querySelector('#ug-bot-qt-bullets-enabled');
        qtBulletsThresholdEl     = document.querySelector('#ug-bot-qt-bullets-threshold');
        qtBulletsMinEl           = document.querySelector('#ug-bot-qt-bullets-min');
        qtPollMinEl              = document.querySelector('#ug-bot-qt-poll-min');
        qtPollMaxEl              = document.querySelector('#ug-bot-qt-poll-max');
        qtPointsEnabledInput     = document.querySelector('#ug-bot-qt-points-enabled');
        qtBustEnabledInput       = document.querySelector('#ug-bot-qt-bust-enabled');
        qtBustMaxPtsEl           = document.querySelector('#ug-bot-qt-bust-maxpts');
        qtBustMinAmtEl           = document.querySelector('#ug-bot-qt-bust-minamt');
        qtAlwaysSuccEnabledInput = document.querySelector('#ug-bot-qt-always-succ-enabled');
        qtAlwaysSuccMaxPtsEl     = document.querySelector('#ug-bot-qt-always-succ-maxpts');
        qtAlwaysSuccMinAmtEl     = document.querySelector('#ug-bot-qt-always-succ-minamt');
        qtDoubleMeltsEnabledInput = document.querySelector('#ug-bot-qt-double-melts-enabled');
        qtDoubleMeltsMaxPtsEl    = document.querySelector('#ug-bot-qt-double-melts-maxpts');
        qtDoubleMeltsMinAmtEl    = document.querySelector('#ug-bot-qt-double-melts-minamt');
        qtDoubleXpEnabledInput   = document.querySelector('#ug-bot-qt-double-xp-enabled');
        qtDoubleXpMaxPtsEl       = document.querySelector('#ug-bot-qt-double-xp-maxpts');
        qtDoubleXpMinAmtEl       = document.querySelector('#ug-bot-qt-double-xp-minamt');
        qtDoubleCashEnabledInput = document.querySelector('#ug-bot-qt-double-cash-enabled');
        qtDoubleCashMaxPtsEl     = document.querySelector('#ug-bot-qt-double-cash-maxpts');
        qtDoubleCashMinAmtEl     = document.querySelector('#ug-bot-qt-double-cash-minamt');
        qtRareEnabledInput       = document.querySelector('#ug-bot-qt-rare-enabled');
        qtRareMaxPtsEl           = document.querySelector('#ug-bot-qt-rare-maxpts');
        qtRareMinAmtEl           = document.querySelector('#ug-bot-qt-rare-minamt');
        qtBulletValueEnabledInput = document.querySelector('#ug-bot-qt-bullet-value-enabled');
        qtBulletValueMaxPtsEl    = document.querySelector('#ug-bot-qt-bullet-value-maxpts');
        qtBulletValueMinAmtEl    = document.querySelector('#ug-bot-qt-bullet-value-minamt');
        qtCarsEnabledInput       = document.querySelector('#ug-bot-qt-cars-enabled');
        qtCarsIntervalEl         = document.querySelector('#ug-bot-qt-cars-interval');
        qtPerkExtendEnabledInput = document.querySelector('#ug-bot-qt-perk-extend-enabled');
        qtPerkExtendMinsEl       = document.querySelector('#ug-bot-qt-perk-extend-mins');
        qtPerkRedeemEnabledInput = document.querySelector('#ug-bot-qt-perk-redeem-enabled');
        qtPerkRedeemMinsEl       = document.querySelector('#ug-bot-qt-perk-redeem-mins');
        disableCrimesRankEl      = document.querySelector('#ug-bot-disable-crimes-rank');
        disableGtaRankEl         = document.querySelector('#ug-bot-disable-gta-rank');
        leaveCashEnabledInput    = document.querySelector('#ug-bot-leave-cash-enabled');
        leaveCashOnHandEl        = document.querySelector('#ug-bot-leave-cash-on-hand');
        bonusPointsEnabledInput  = document.querySelector('#ug-bot-bonus-points-enabled');
        autoBuyBgEnabledInput    = document.querySelector('#ug-bot-auto-buy-bg');
        autoBuyBgMinPtsEl        = document.querySelector('#ug-bot-auto-buy-bg-minpts');
        autoBuyBgMinsEl          = document.querySelector('#ug-bot-auto-buy-bg-mins');
        extendBgsInput           = document.querySelector('#ug-bot-extend-bgs');
        extendCarsInput          = document.querySelector('#ug-bot-extend-cars');
        extendBulletsInput       = document.querySelector('#ug-bot-extend-bullets');
        extendRaresInput         = document.querySelector('#ug-bot-extend-rares');
        extendDoubleMeltsInput   = document.querySelector('#ug-bot-extend-double-melts');
        extendBulletValueInput   = document.querySelector('#ug-bot-extend-bullet-value');
        extendDoubleXpInput      = document.querySelector('#ug-bot-extend-double-xp');
        extendAlwaysSuccInput    = document.querySelector('#ug-bot-extend-always-successful');
        extendAlwaysBustInput    = document.querySelector('#ug-bot-extend-always-bust');
        extendDoubleCashInput    = document.querySelector('#ug-bot-extend-double-cash');
        redeemBulletValueInput  = document.querySelector('#ug-bot-redeem-bullet-value');
        redeemCashInput         = document.querySelector('#ug-bot-redeem-cash');
        redeemCarsInput         = document.querySelector('#ug-bot-redeem-cars');
        redeemPairFloorEl       = document.querySelector('#ug-bot-redeem-pair-floor');
        redeemBgInput            = document.querySelector('#ug-bot-redeem-bg');
        redeemBulletsInput       = document.querySelector('#ug-bot-redeem-bullets');
        const redeemBulletsCapInput = document.querySelector('#ug-bot-redeem-bullets-cap');
        if (redeemBulletsCapInput) {
            redeemBulletsCapInput.value = state.redeemBulletsCap;
            // Force size via JS — overrides any CSS specificity issues
            redeemBulletsCapInput.setAttribute('style', 'width:28px!important;max-width:28px!important;min-width:0!important;padding:2px 3px!important;border:1px solid #444!important;border-radius:4px!important;background:#111!important;color:#fff!important;font-size:11px!important;text-align:right!important;box-sizing:border-box!important;');
            redeemBulletsCapInput.addEventListener('change', () => {
                const v = parseFloat(redeemBulletsCapInput.value);
                if (v >= 1.0) state.redeemBulletsCap = v;
            });
        }
        redeemDoubleXpInput      = document.querySelector('#ug-bot-redeem-double-xp');
        redeemAlwaysSuccInput    = document.querySelector('#ug-bot-redeem-always-successful');
        redeemDoubleCashInput    = document.querySelector('#ug-bot-redeem-double-cash');
        redeemRareInput          = document.querySelector('#ug-bot-redeem-rare');
        redeemDoubleMeltInput    = document.querySelector('#ug-bot-redeem-double-melt');
        redeemAlwaysBustInput    = document.querySelector('#ug-bot-redeem-always-bust');

        // Initialise sub-panes — show first pane per group, hide the rest
        const subParents = [...new Set([...document.querySelectorAll('.ug-sub-pane')].map(p => p.dataset.parent))];
        subParents.forEach(parent => {
            const panes = [...document.querySelectorAll(`.ug-sub-pane[data-parent="${parent}"]`)];
            panes.forEach((pane, i) => { pane.style.display = i === 0 ? '' : 'none'; });
        });

        // Universal sub-tab switching
        document.querySelectorAll('.ug-sub-btn').forEach(btn => {
            if (btn.dataset.subListenerAttached) return;
            btn.dataset.subListenerAttached = '1';
            btn.addEventListener('click', () => {
                const target = btn.dataset.sub;
                const parent = btn.dataset.parent;
                document.querySelectorAll(`.ug-sub-btn[data-parent="${parent}"]`).forEach(b => {
                    b.classList.remove('ug-sub-active');
                });
                document.querySelectorAll(`.ug-sub-pane[data-parent="${parent}"]`).forEach(p => p.style.setProperty('display', 'none', 'important'));
                btn.classList.add('ug-sub-active');
                const pane = document.querySelector(`.ug-sub-pane[data-sub="${target}"][data-parent="${parent}"]`);
                if (pane) pane.style.setProperty('display', 'block', 'important');
                // Persist active sub-tab per parent
                setSetting(`activeSubTab_${parent}`, target);
            });
        });

        // Restore saved sub-tabs
        const allParents = [...new Set([...document.querySelectorAll('.ug-sub-btn')].map(b => b.dataset.parent))];
        allParents.forEach(parent => {
            const saved = getSetting(`activeSubTab_${parent}`, null);
            if (!saved) return;
            const btn = document.querySelector(`.ug-sub-btn[data-sub="${saved}"][data-parent="${parent}"]`);
            const pane = document.querySelector(`.ug-sub-pane[data-sub="${saved}"][data-parent="${parent}"]`);
            if (!btn || !pane) return;
            document.querySelectorAll(`.ug-sub-btn[data-parent="${parent}"]`).forEach(b => b.classList.remove('ug-sub-active'));
            document.querySelectorAll(`.ug-sub-pane[data-parent="${parent}"]`).forEach(p => p.style.setProperty('display', 'none', 'important'));
            btn.classList.add('ug-sub-active');
            pane.style.setProperty('display', 'block', 'important');
        });
        qtPointsThresholdEl      = document.querySelector('#ug-bot-qt-points-threshold');
        killScanOnlineInput      = document.querySelector('#ug-bot-kill-scan-online');
        killScanIntervalEl       = document.querySelector('#ug-bot-kill-scan-interval');
        killSearchInput          = document.querySelector('#ug-bot-kill-search');
        killBgCheckInput         = document.querySelector('#ug-bot-kill-bgcheck');
        killBgSpamInput          = document.querySelector('#ug-bot-kill-bg-spam');
        killBgSpamIntervalEl     = document.querySelector('#ug-bot-kill-bg-spam-interval');
        killBgSpamTargetEl       = document.querySelector('#ug-bot-kill-bg-spam-target');
        const bgFarmSetWaitBtn = document.querySelector('#ug-bot-bgfarm-set-wait');
        if (bgFarmSetWaitBtn) {
            bgFarmSetWaitBtn.addEventListener('click', () => {
                const players = getSetting('killPlayers', []);
                const threeHrs = Date.now() + (3 * 60 * 60 * 1000);
                const updated = players.map(p => {
                    if (!p.bgFarmEnabled) return p;
                    const np = { ...p };
                    delete np.bodyguard;
                    delete np.expectedFoundAt;
                    delete np.searchExpiresAt;
                    np.bgFarmWaitUntil = threeHrs;
                    return np;
                });
                setSetting('killPlayers', updated);
                setSetting('killBgWaitUntil', threeHrs);
                setSetting('killLoopCooldownUntil', 0);
                const count = players.filter(p => p.bgFarmEnabled).length;
                addLiveLog(`BG Farm: set 3hr wait for ${count} player(s) — stale BG state cleared`);
                renderKillList();
                bgFarmSetWaitBtn.textContent = '✓ Done';
                bgFarmSetWaitBtn.style.color = '#4a4';
                setTimeout(() => {
                    bgFarmSetWaitBtn.textContent = 'Set 3hr wait for all BG Farm players';
                    bgFarmSetWaitBtn.style.color = '#aaa';
                }, 3000);
            });
        }
        if (killBgCheckInput) {
            killBgCheckInput.addEventListener('change', () => {
                const on = killBgCheckInput.checked;
                if (killScanOnlineInput) {
                    killScanOnlineInput.disabled = on;
                    const lbl = killScanOnlineInput.closest('label');
                    if (lbl) { lbl.style.opacity = on ? '0.4' : ''; lbl.style.cursor = on ? 'default' : ''; }
                }
                if (killSearchInput) {
                    killSearchInput.disabled = on;
                    const lbl = killSearchInput.closest('label');
                    if (lbl) { lbl.style.opacity = on ? '0.4' : ''; lbl.style.cursor = on ? 'default' : ''; }
                }
            });
        }

        if (killBgSpamInput) {
            killBgSpamInput.addEventListener('change', () => {
                saveSettings();
                syncBgSpamState();
            });
        }
        if (killBgSpamIntervalEl) {
            killBgSpamIntervalEl.addEventListener('change', () => { saveSettings(); });
        }
        if (killBgSpamTargetEl) {
            killBgSpamTargetEl.addEventListener('change', () => {
                state.killBgSpamTarget = killBgSpamTargetEl.value;
                saveSettings();
            });
        }

        killShootInput           = document.querySelector('#ug-bot-kill-shoot');
        killAnonymousInput       = document.querySelector('#ug-bot-kill-anonymous');
        const autoBuyGunEl    = document.querySelector('#ug-bot-auto-buy-gun');
        const autoBuyGunAwpEl = document.querySelector('#ug-bot-auto-buy-gun-awp');
        const autoBuyGunAk47El= document.querySelector('#ug-bot-auto-buy-gun-ak47');
        const autoBuyGunPtsEl = document.querySelector('#ug-bot-auto-buy-gun-pts');
        if (autoBuyGunEl) {
            autoBuyGunEl.checked = state.autoBuyGun;
        }
        // Delegated — survives updatePanel() re-renders
        if (!document._ugAutoBuyGunListenerAdded) {
            document._ugAutoBuyGunListenerAdded = true;
            document.addEventListener('change', e => {
                if (e.target.matches('#ug-bot-auto-buy-gun') && e.target.checked) {
                    state.autoBuyGun = true;
                    autoBuyGun();
                }
            });
        }
        if (autoBuyGunAwpEl)  {
            autoBuyGunAwpEl.checked = state.autoBuyGunType === 'awp';
            autoBuyGunAwpEl.addEventListener('change', () => { if (autoBuyGunAwpEl.checked && autoBuyGunAk47El) autoBuyGunAk47El.checked = false; });
        }
        if (autoBuyGunAk47El) {
            autoBuyGunAk47El.checked = state.autoBuyGunType === 'ak47';
            autoBuyGunAk47El.addEventListener('change', () => { if (autoBuyGunAk47El.checked && autoBuyGunAwpEl) autoBuyGunAwpEl.checked = false; });
        }
        if (autoBuyGunPtsEl) {
            autoBuyGunPtsEl.value = state.autoBuyGunPtThreshold;
            autoBuyGunPtsEl.setAttribute('style', 'width:52px!important;max-width:52px!important;min-width:0!important;padding:2px 3px!important;border:1px solid #444!important;border-radius:4px!important;background:#111!important;color:#fff!important;font-size:11px!important;text-align:right!important;box-sizing:border-box!important;');
        }
        killBgCheckIntervalEl    = document.querySelector('#ug-bot-kill-bgcheck-interval');
        killPenaltyThresholdEl   = document.querySelector('#ug-bot-kill-penalty-threshold');
        logEl                   = document.querySelector('#ug-bot-log');
        compactBtn              = document.querySelector('#ug-bot-compact-btn');
        hideBtn                 = document.querySelector('#ug-bot-hide-btn');
        closeBtn                = document.querySelector('#ug-bot-close-btn');

        // Load all settings into UI
        if (autoDepositInput)            autoDepositInput.checked           = state.autoDepositEnabled;
        if (depositThresholdEl)          depositThresholdEl.value           = formatNumberWithCommas(state.autoDepositThreshold);
        if (bulletFactoryEnabledInput)   bulletFactoryEnabledInput.checked  = state.bulletFactoryEnabled;
        if (diceJoinEnabledInput)        diceJoinEnabledInput.checked       = state.diceJoinEnabled;
        if (autoRepairInput)             autoRepairInput.checked            = state.autoRepairEnabled;
        if (repairEveryEl)               repairEveryEl.value                = String(state.repairEveryMelts);
        if (autoMissionsInput)           autoMissionsInput.checked          = state.autoMissionsEnabled;
        if (autoGiveCarsInput)           autoGiveCarsInput.checked          = state.autoGiveCarMissionsEnabled;
        if (autoDrugsInput)              autoDrugsInput.checked             = state.autoDrugsEnabled;
        if (drugDepositMultiplierEl)     drugDepositMultiplierEl.value      = String(state.drugDepositMultiplier);
        if (bustNoReloadInput)           bustNoReloadInput.checked          = state.bustNoReload;
        if (bustPollMinEl)               bustPollMinEl.value                = state.bustPollMin;
        if (bustPollMaxEl)               bustPollMaxEl.value                = state.bustPollMax;
        if (extendBulletsThreshEl)       extendBulletsThreshEl.value        = formatNumberWithCommas(state.extendBulletsThreshold);
        if (extendRaresThreshEl)         extendRaresThreshEl.value          = formatNumberWithCommas(state.extendRaresThreshold);
        if (extendDoubleMeltsThreshEl)   extendDoubleMeltsThreshEl.value    = formatNumberWithCommas(state.extendDoubleMeltsThreshold);
        if (extendBulletValueThreshEl)   extendBulletValueThreshEl.value    = formatNumberWithCommas(state.extendBulletValueThreshold);
        if (extendDoubleXpThreshEl)      extendDoubleXpThreshEl.value       = formatNumberWithCommas(state.extendDoubleXpThreshold);
        if (extendAlwaysSuccThreshEl)    extendAlwaysSuccThreshEl.value     = formatNumberWithCommas(state.extendAlwaysSuccThreshold);
        if (extendAlwaysBustThreshEl)    extendAlwaysBustThreshEl.value     = formatNumberWithCommas(state.extendAlwaysBustThreshold);
        if (extendDoubleCashThreshEl)    extendDoubleCashThreshEl.value     = formatNumberWithCommas(state.extendDoubleCashThreshold);

        // Leave jail
        if (leaveJailInput)              leaveJailInput.checked             = state.leaveJailEnabled;
        if (leaveJailMinPointsEl)        leaveJailMinPointsEl.value         = formatNumberWithCommas(state.leaveJailMinPoints);

        // Resets
        if (resetCrimesInput)            resetCrimesInput.checked           = state.resetCrimesEnabled;
        if (resetCrimesFastModeInput) {
            resetCrimesFastModeInput.checked  = state.resetCrimesFastMode;
            resetCrimesFastModeInput.disabled = !state.resetCrimesEnabled;
            if (!state.resetCrimesEnabled) resetCrimesFastModeInput.closest('.ug-fast-mode-label')?.classList.add('ug-disabled-sub');
        }
        if (resetGTAInput)               resetGTAInput.checked              = state.resetGTAEnabled;
        if (resetMeltInput)              resetMeltInput.checked             = state.resetMeltEnabled;
        if (resetTimerMinPointsEl)       resetTimerMinPointsEl.value        = formatNumberWithCommas(state.resetTimerMinPoints);

        // Disable at rank (checkboxes loaded by their own listener block below; dropdowns here)
        if (disableCrimesRankEl)         disableCrimesRankEl.value          = state.disableCrimesRank;
        if (disableGtaRankEl)            disableGtaRankEl.value             = state.disableGtaRank;

        // Auto-buy BG
        if (autoBuyBgEnabledInput)       autoBuyBgEnabledInput.checked      = state.autoBuyBgEnabled;
        if (autoBuyBgMinPtsEl)           autoBuyBgMinPtsEl.value            = String(state.autoBuyBgMinPts);
        if (autoBuyBgMinsEl)             autoBuyBgMinsEl.value              = String(state.autoBuyBgMins);

        // Extend perks
        if (qtPerkExtendEnabledInput)    qtPerkExtendEnabledInput.checked   = state.qtPerkExtendEnabled;
        if (qtPerkExtendMinsEl)          qtPerkExtendMinsEl.value           = String(state.qtPerkExtendMins);
        if (extendBgsInput)              extendBgsInput.checked             = state.extendBgs;
        if (extendCarsInput)             extendCarsInput.checked            = state.extendCars;
        if (extendBulletsInput)          extendBulletsInput.checked         = state.extendBullets;
        if (extendRaresInput)            extendRaresInput.checked           = state.extendRares;
        if (extendDoubleMeltsInput)      extendDoubleMeltsInput.checked     = state.extendDoubleMelts;
        if (extendBulletValueInput)      extendBulletValueInput.checked     = state.extendBulletValue;
        if (extendDoubleXpInput)         extendDoubleXpInput.checked        = state.extendDoubleXp;
        if (extendAlwaysSuccInput)       extendAlwaysSuccInput.checked      = state.extendAlwaysSucc;
        if (extendAlwaysBustInput)       extendAlwaysBustInput.checked      = state.extendAlwaysBust;
        if (extendDoubleCashInput)       extendDoubleCashInput.checked      = state.extendDoubleCash;

        // Redeem perks
        if (qtPerkRedeemEnabledInput)    qtPerkRedeemEnabledInput.checked   = state.qtPerkRedeemEnabled;
        if (qtPerkRedeemMinsEl)          qtPerkRedeemMinsEl.value           = String(state.qtPerkRedeemMins);
        if (redeemBulletValueInput) redeemBulletValueInput.checked = state.redeemBulletValue;
        if (redeemCashInput)        redeemCashInput.checked        = state.redeemCash;
        if (redeemCarsInput)        redeemCarsInput.checked        = state.redeemCars;
        if (redeemPairFloorEl)      redeemPairFloorEl.value        = String(state.redeemPairFloor);
        if (redeemBgInput)               redeemBgInput.checked              = state.redeemBg;
        if (redeemBulletsInput)          redeemBulletsInput.checked         = state.redeemBullets;
        if (redeemDoubleXpInput)         redeemDoubleXpInput.checked        = state.redeemDoubleXp;
        if (redeemAlwaysSuccInput)       redeemAlwaysSuccInput.checked      = state.redeemAlwaysSucc;
        if (redeemDoubleCashInput)       redeemDoubleCashInput.checked      = state.redeemDoubleCash;
        if (redeemRareInput)             redeemRareInput.checked            = state.redeemRare;
        if (redeemDoubleMeltInput)       redeemDoubleMeltInput.checked      = state.redeemDoubleMelt;
        if (redeemAlwaysBustInput)       redeemAlwaysBustInput.checked      = state.redeemAlwaysBust;

        // Bonus points
        if (bonusPointsEnabledInput)     bonusPointsEnabledInput.checked    = state.bonusPointsEnabled;

        // Leave cash on hand
        if (leaveCashEnabledInput)       leaveCashEnabledInput.checked      = state.leaveCashEnabled;
        if (leaveCashOnHandEl)           leaveCashOnHandEl.value            = state.leaveCashOnHand > 0 ? formatNumberWithCommas(state.leaveCashOnHand) : '';

        // Kill — full load handled below in the BG-loop greying block
        if (bgCrimeEnabledInput)        bgCrimeEnabledInput.checked        = state.bgCrimeEnabled;
        if (killProtectedRecheckInput)  killProtectedRecheckInput.checked  = state.killProtectedRecheckEnabled;
        if (killProtectedRecheckMinsEl) killProtectedRecheckMinsEl.value   = String(state.killProtectedRecheckMins);

        // QT
        if (qtPollMinEl)                 qtPollMinEl.value                  = String(state.qtPollMin);
        if (qtPollMaxEl)                 qtPollMaxEl.value                  = String(state.qtPollMax);
        if (qtPointsEnabledInput)        qtPointsEnabledInput.checked       = state.qtPointsEnabled;
        if (qtPointsThresholdEl)         qtPointsThresholdEl.value          = formatNumberWithCommas(state.qtPointsThreshold);
        if (qtBgEnabledInput)            qtBgEnabledInput.checked           = state.qtBgEnabled;
        if (qtBgThresholdEl)             qtBgThresholdEl.value              = formatNumberWithCommas(state.qtBgThreshold);
        if (qtBulletsEnabledInput)       qtBulletsEnabledInput.checked      = state.qtBulletsEnabled;
        if (qtBulletsThresholdEl)        qtBulletsThresholdEl.value         = formatNumberWithCommas(state.qtBulletsThreshold);
        if (qtBulletsMinEl)              qtBulletsMinEl.value               = formatNumberWithCommas(state.qtBulletsMin);
        if (qtBustEnabledInput)          qtBustEnabledInput.checked         = state.qtBustEnabled;
        if (qtBustMaxPtsEl)              qtBustMaxPtsEl.value               = String(state.qtBustMaxPts);
        if (qtBustMinAmtEl)              qtBustMinAmtEl.value               = String(state.qtBustMinMins);
        if (qtAlwaysSuccEnabledInput)    qtAlwaysSuccEnabledInput.checked   = state.qtAlwaysSuccEnabled;
        if (qtAlwaysSuccMaxPtsEl)        qtAlwaysSuccMaxPtsEl.value         = String(state.qtAlwaysSuccMaxPts);
        if (qtAlwaysSuccMinAmtEl)        qtAlwaysSuccMinAmtEl.value         = String(state.qtAlwaysSuccMinMins);
        if (qtDoubleMeltsEnabledInput)   qtDoubleMeltsEnabledInput.checked  = state.qtDoubleMeltsEnabled;
        if (qtDoubleMeltsMaxPtsEl)       qtDoubleMeltsMaxPtsEl.value        = String(state.qtDoubleMeltsMaxPts);
        if (qtDoubleMeltsMinAmtEl)       qtDoubleMeltsMinAmtEl.value        = String(state.qtDoubleMeltsMinCars);
        if (qtDoubleXpEnabledInput)      qtDoubleXpEnabledInput.checked     = state.qtDoubleXpEnabled;
        if (qtDoubleXpMaxPtsEl)          qtDoubleXpMaxPtsEl.value           = String(state.qtDoubleXpMaxPts);
        if (qtDoubleXpMinAmtEl)          qtDoubleXpMinAmtEl.value           = String(state.qtDoubleXpMinMins);
        if (qtDoubleCashEnabledInput)    qtDoubleCashEnabledInput.checked   = state.qtDoubleCashEnabled;
        if (qtDoubleCashMaxPtsEl)        qtDoubleCashMaxPtsEl.value         = String(state.qtDoubleCashMaxPts);
        if (qtDoubleCashMinAmtEl)        qtDoubleCashMinAmtEl.value         = String(state.qtDoubleCashMinMins);
        if (qtRareEnabledInput)          qtRareEnabledInput.checked         = state.qtRareEnabled;
        if (qtRareMaxPtsEl)              qtRareMaxPtsEl.value               = String(state.qtRareMaxPts);
        if (qtRareMinAmtEl)              qtRareMinAmtEl.value               = String(state.qtRareMinCars);
        if (qtBulletValueEnabledInput)   qtBulletValueEnabledInput.checked  = state.qtBulletValueEnabled;
        if (qtBulletValueMaxPtsEl)       qtBulletValueMaxPtsEl.value        = String(state.qtBulletValueMaxPts);
        if (qtBulletValueMinAmtEl)       qtBulletValueMinAmtEl.value        = String(state.qtBulletValueMinCars);
        if (qtCarsEnabledInput)          qtCarsEnabledInput.checked         = state.qtCarsEnabled;
        if (qtCarsIntervalEl)            qtCarsIntervalEl.value             = String(state.qtCarsScanInterval);

        drugCompModeInput = document.querySelector('#ug-bot-drug-comp');
        if (drugCompModeInput) {
            drugCompModeInput.checked = state.drugCompEnabled;
        }

        // Sell All Drugs button
        const sellAllBtn = document.querySelector('#ug-bot-sell-all-drugs');
        const sellAllStatus = document.querySelector('#ug-bot-sell-all-status');
        if (sellAllBtn && !sellAllBtn.dataset.listenerAttached) {
            sellAllBtn.dataset.listenerAttached = '1';
            sellAllBtn.addEventListener('click', async () => {
                sellAllBtn.disabled = true;
                sellAllStatus.textContent = 'Fetching drug pages...';
                try {
                    let totalSold = 0;
                    while (true) {
                        const r1 = await fetch('/?p=drugs&page=1', { credentials: 'include' });
                        const t1 = await r1.text();
                        const pageMatch = t1.match(/Page <u>1<\/u> of <u>(\d+)<\/u>/);
                        const totalPages = pageMatch ? parseInt(pageMatch[1]) : 0;
                        if (!totalPages) {
                            sellAllStatus.textContent = `Done — sold ${totalSold} batches`;
                            addLiveLog(`Sell All Drugs: complete — sold ${totalSold} batches`);
                            break;
                        }
                        sellAllStatus.textContent = `${totalPages} pages remaining, fetching IDs...`;
                        const d1 = new DOMParser().parseFromString(t1, 'text/html');
                        let allIds = [...d1.querySelectorAll('input[name="id[]"]')].map(cb => cb.value);
                        const rest = await Promise.all(
                            Array.from({length: totalPages - 1}, (_, i) =>
                                fetch(`/?p=drugs&page=${i + 2}`, { credentials: 'include' })
                                    .then(r => r.text())
                                    .then(t => [...new DOMParser().parseFromString(t, 'text/html').querySelectorAll('input[name="id[]"]')].map(cb => cb.value))
                            )
                        );
                        rest.forEach(ids => allIds = allIds.concat(ids));
                        for (let i = 0; i < allIds.length; i += 25) {
                            const chunk = allIds.slice(i, i + 25);
                            const body = chunk.map(id => `id[]=${id}`).join('&') + '&sell=Sell';
                            await fetch('/?p=drugs', {
                                method: 'POST',
                                credentials: 'include',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body
                            });
                            totalSold += chunk.length;
                            sellAllStatus.textContent = `Sold ${totalSold} batches so far...`;
                            await new Promise(r => setTimeout(r, 200));
                        }
                    }
                } catch(e) {
                    sellAllStatus.textContent = `Error: ${e.message}`;
                    addLiveLog(`Sell All Drugs: error — ${e.message}`);
                } finally {
                    sellAllBtn.disabled = false;
                }
            });
        }

        // Render per-car-type rows
        const qtCarsList = document.querySelector('#ug-bot-qt-cars-list');
        if (qtCarsList) {
            const carTypes = state.qtCarsTypes || DEFAULTS.qtCarsTypes;
            const rows = carTypes.map(t => `
                <tr>
                    <td style="width:22px;min-width:22px;padding:3px 4px 3px 0;vertical-align:middle;">
                        <input id="ug-bot-qt-car-enabled-${t.b}" type="checkbox" ${t.enabled ? 'checked' : ''}
                            style="width:13px;height:13px;margin:0;padding:0;cursor:pointer;display:block;" />
                    </td>
                    <td style="color:#ddd;font-size:12px;padding:3px 6px 3px 0;vertical-align:middle;text-align:left;">${t.name}</td>
                    <td style="vertical-align:middle;white-space:nowrap;padding:3px 0;width:1px;">
                        <input id="ug-bot-qt-car-price-${t.b}" type="text" inputmode="numeric" value="${t.maxPrice > 0 ? formatNumberWithCommas(t.maxPrice) : ''}"
                            class="ug-compact-input" style="width:110px;max-width:110px;" />
                    </td>
                </tr>
            `).join('');
            qtCarsList.innerHTML = `<table style="width:100%;border-collapse:collapse;">${rows}</table>`;
            // Auto-save on any change
            qtCarsList.querySelectorAll('input[type="text"]').forEach(el => {
                attachNumberFormatting(el);
                el.addEventListener('change', () => saveSettings());
            });
            qtCarsList.querySelectorAll('input[type="checkbox"]').forEach(el => {
                el.addEventListener('change', () => saveSettings());
            });
        }

        // Grey out scan/search when BG loop is on.
        // Must sync the checkbox first so its .checked reflects persisted state,
        // then read it back — this way unticking immediately re-enables them
        // AND the persisted on state greys them out on page load.
        if (killBgCheckInput) killBgCheckInput.checked = state.killBgCheckEnabled;
        if (killBgSpamInput)      killBgSpamInput.checked         = state.killBgSpamEnabled;
        if (killBgSpamIntervalEl) killBgSpamIntervalEl.value      = String(state.killBgSpamIntervalSecs);
        updateBgSpamDropdown();
        const bgLoopCurrentlyOn = killBgCheckInput ? killBgCheckInput.checked : state.killBgCheckEnabled;

        if (killScanOnlineInput) {
            killScanOnlineInput.checked  = state.killScanOnlineEnabled;
            killScanOnlineInput.disabled = bgLoopCurrentlyOn;
            const scanLabel = killScanOnlineInput.closest('label');
            if (scanLabel) scanLabel.style.opacity = bgLoopCurrentlyOn ? '0.4' : '';
            if (scanLabel) scanLabel.style.cursor  = bgLoopCurrentlyOn ? 'default' : '';
        }
        if (killScanIntervalEl)   killScanIntervalEl.value    = String(state.killScanOnlineInterval);
        if (killSearchInput) {
            killSearchInput.checked  = state.killSearchEnabled;
            killSearchInput.disabled = bgLoopCurrentlyOn;
            const searchLabel = killSearchInput.closest('label');
            if (searchLabel) searchLabel.style.opacity = bgLoopCurrentlyOn ? '0.4' : '';
            if (searchLabel) searchLabel.style.cursor  = bgLoopCurrentlyOn ? 'default' : '';
        }
        if (killBgCheckInput)     killBgCheckInput.checked    = state.killBgCheckEnabled;
        if (killBgSpamInput)      killBgSpamInput.checked         = state.killBgSpamEnabled;
        if (killBgSpamIntervalEl) killBgSpamIntervalEl.value      = String(state.killBgSpamIntervalSecs);
        updateBgSpamDropdown();
        if (killShootInput)       killShootInput.checked      = state.killShootEnabled;
        if (killAnonymousInput)   killAnonymousInput.checked  = state.killAnonymousShooting;
        if (killBgCheckIntervalEl) killBgCheckIntervalEl.value = String(state.killBgCheckIntervalHrs);
        if (killPenaltyThresholdEl) killPenaltyThresholdEl.value = state.killPenaltyThreshold > 0 ? String(state.killPenaltyThreshold) : '';
        attachNumberFormatting(depositThresholdEl);
        attachNumberFormatting(leaveJailMinPointsEl);
        attachNumberFormatting(resetTimerMinPointsEl);
        attachNumberFormatting(autoBuyBgMinPtsEl);
        attachNumberFormatting(qtPointsThresholdEl);
        attachNumberFormatting(qtBgThresholdEl);
        attachNumberFormatting(qtBulletsThresholdEl);
        attachNumberFormatting(qtBulletsMinEl);
        attachNumberFormatting(extendBulletsThreshEl);
        attachNumberFormatting(extendRaresThreshEl);
        attachNumberFormatting(extendDoubleMeltsThreshEl);
        attachNumberFormatting(extendBulletValueThreshEl);
        attachNumberFormatting(extendDoubleXpThreshEl);
        attachNumberFormatting(extendAlwaysSuccThreshEl);
        attachNumberFormatting(extendAlwaysBustThreshEl);
        attachNumberFormatting(extendDoubleCashThreshEl);
        // killPenaltyThresholdEl uses decimal values — no number formatting applied
        attachNumberFormatting(leaveCashOnHandEl);

        buildActionCheckboxes();

        // Tab buttons
        document.querySelectorAll('.ug-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });



        switchTab(activeTab);
        // Initialise sub-tab state if statslog is the active tab
        if (activeTab === 'statslog') {
        }

        // Auto-save on checkbox/number changes
        document.querySelector('#ug-bot-extra').addEventListener('change', e => {
            if (e.target.matches('.ug-reset-cb')) {
                // Handle mutual exclusivity for timer reset checkboxes
                handleResetCheckboxChange(e.target.dataset.reset);
                // Update fast mode label disabled appearance
                if (resetCrimesFastModeInput) {
                    const label = resetCrimesFastModeInput.closest('.ug-fast-mode-label');
                    if (label) label.classList.toggle('ug-disabled-sub', !resetCrimesInput.checked);
                }
            } else if (e.target.matches('input[type="checkbox"], input[type="number"], select')) {
                saveSettings();
            }
        });

        // Auto-save on text input changes (debounced)
        document.querySelector('#ug-bot-extra').addEventListener('input', e => {
            if (e.target.matches('input[type="text"]')) {
                scheduleAutoSave();
            }
        });



        function handleToggleClick() {
            if (state.enabled) {
                setPaused('Stopped manually');
            } else {
                // Designate this window as the bot window
                activateBotWindowIdentity();
                cancelCurrentRun();
                state.enabled      = true;
                state.pausedReason = '';
                clearScheduledReload();
                updatePanel();
                startHeartbeat();
            }
        }

        toggleBtn.addEventListener('click', handleToggleClick);

        compactBtn.addEventListener('click', () => {
            if (state.panelCollapsed) {
                state.panelCollapsed = false;
                state.panelCompact   = false;
            } else {
                state.panelCollapsed = true;
                state.panelCompact   = true;
            }
            updatePanel();
        });

        hideBtn.addEventListener('click', () => {
            // Hide the panel without stopping the bot
            state.panelHidden = true;
            const panel = document.querySelector('#ug-bot-panel');
            if (panel) panel.style.display = 'none';
            injectSidebarButton();
        });

        closeBtn.addEventListener('click', () => {
            if (state.enabled) setPaused('Panel closed');
            state.panelHidden = true;
            const panel = document.querySelector('#ug-bot-panel');
            if (panel) panel.style.display = 'none';
            injectSidebarButton();
        });

        renderLiveLog();
        renderKillList();
        updatePanel();

        // Kill scanner — clear list button
        attachKillListListener();

        const copyLogBtn = document.querySelector('#ug-bot-copy-log');

        if (copyLogBtn && !copyLogBtn.dataset.listenerAttached) {
            copyLogBtn.dataset.listenerAttached = '1';
            copyLogBtn.addEventListener('click', () => {
                const log = state.liveLog || [];
                navigator.clipboard.writeText(log.join('\n')).then(() => {
                    copyLogBtn.textContent = 'Copied!';
                    setTimeout(() => { copyLogBtn.textContent = 'Copy log'; }, 2000);
                }).catch(() => {
                    // Fallback for browsers without clipboard API
                    const ta = document.createElement('textarea');
                    ta.value = log.join('\n');
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    copyLogBtn.textContent = 'Copied!';
                    setTimeout(() => { copyLogBtn.textContent = 'Copy log'; }, 2000);
                });
            });
        }

        const clearLogBtn = document.querySelector('#ug-bot-clear-log');
        if (clearLogBtn && !clearLogBtn.dataset.listenerAttached) {
            clearLogBtn.dataset.listenerAttached = '1';
            clearLogBtn.addEventListener('click', () => {
                if (!confirm('Clear log and reset all session state? This resets loop flags, runtime, and pending actions.')) return;
                resetSessionStats();
            });
        }

        // ── Acc tab ───────────────────────────────────────────────────────────
        // Select All / Select None crime buttons
        const crimesSelectAllBtn = document.querySelector('#ug-bot-crimes-select-all');
        if (crimesSelectAllBtn && !crimesSelectAllBtn.dataset.listenerAttached) {
            crimesSelectAllBtn.dataset.listenerAttached = '1';
            crimesSelectAllBtn.addEventListener('click', () => {
                const boxes = [...document.querySelectorAll('#ug-bot-actions .ug-action-cb:not(:disabled)')];
                const allChecked = boxes.every(cb => cb.checked);
                boxes.forEach(cb => { cb.checked = !allChecked; });
                saveSettings();
            });
        }

        // Disable at Global Boss checkboxes
        const disableCrimesAtGbCb = document.querySelector('#ug-bot-disable-crimes-at-gb');
        if (disableCrimesAtGbCb && !disableCrimesAtGbCb.dataset.listenerAttached) {
            disableCrimesAtGbCb.dataset.listenerAttached = '1';
            disableCrimesAtGbCb.checked = state.disableCrimesAtGb;
            disableCrimesAtGbCb.addEventListener('change', () => {
                state.disableCrimesAtGb = disableCrimesAtGbCb.checked;
                if (!disableCrimesAtGbCb.checked) {
                    // Re-enable crimes and bg crimes when unticked
                    const crimeIds = ['gang', '1', '2', 'drug', '3', '4', '5', '6', '7'];
                    const cur = state.enabledActions;
                    const restored = [...new Set([...cur, ...crimeIds])];
                    state.enabledActions = restored;
                    state.bgCrimeEnabled = true;
                    if (bgCrimeEnabledInput) bgCrimeEnabledInput.checked = true;
                    startBgCrime();
                    setSetting('gbDisableFired', false); // allow disable to fire again if reticked
                    buildActionCheckboxes();
                    saveSettings();
                    addLiveLog('Disable ranking: crimes re-enabled');
                } else {
                    // Ticked on — apply immediately if already at/above selected rank
                    const _targetRank = disableCrimesRankEl ? disableCrimesRankEl.value : state.disableCrimesRank;
                    const _gbIdx  = RANKS.indexOf(_targetRank);
                    const _curIdx = getPlayerRankIndex();
                    const _atGb   = _gbIdx >= 0 && _curIdx >= 0 && _curIdx === _gbIdx;
                    // If already above target rank, mark as fired so tick loop doesn't trigger
                    if (_gbIdx >= 0 && _curIdx > _gbIdx) {
                        setSetting('gbDisableFired', true);
                        addLiveLog(`Disable ranking: already past ${_targetRank} — will apply on next account`);
                    }
                    if (_atGb) {
                        const crimeIds = ['gang', '1', '2', 'drug', '3', '4', '5', '6', '7'];
                        const cur = state.enabledActions;
                        const filtered = cur.filter(id => !crimeIds.includes(id));
                        if (filtered.length !== cur.length) {
                            state.enabledActions = filtered;
                            state.bgCrimeEnabled = false;
                            stopBgCrime();
                            if (bgCrimeEnabledInput) bgCrimeEnabledInput.checked = false;
                            setSetting('gbDisableFired', true);
                            buildActionCheckboxes();
                            saveSettings();
                            addLiveLog(`Disable ranking: crimes disabled (already at ${_targetRank})`);
                        }
                    }
                }
            });
        }
        const disableGtaAtGbCb = document.querySelector('#ug-bot-disable-gta-at-gb');
        if (disableGtaAtGbCb && !disableGtaAtGbCb.dataset.listenerAttached) {
            disableGtaAtGbCb.dataset.listenerAttached = '1';
            disableGtaAtGbCb.checked = state.disableGtaAtGb;
            disableGtaAtGbCb.addEventListener('change', () => {
                state.disableGtaAtGb = disableGtaAtGbCb.checked;
                if (!disableGtaAtGbCb.checked) {
                    // Re-enable GTA when unticked
                    const cur = state.enabledActions;
                    if (!cur.includes('gta')) {
                        state.enabledActions = [...cur, 'gta'];
                        setSetting('gbDisableFired', false); // allow disable to fire again if reticked
                        buildActionCheckboxes();
                        saveSettings();
                        addLiveLog('Disable ranking: GTA re-enabled');
                    }
                } else {
                    // Ticked on — apply immediately if already at/above selected rank
                    const _targetRankGta = disableGtaRankEl ? disableGtaRankEl.value : state.disableGtaRank;
                    const _gbIdx  = RANKS.indexOf(_targetRankGta);
                    const _curIdx = getPlayerRankIndex();
                    const _atGb   = _gbIdx >= 0 && _curIdx >= 0 && _curIdx === _gbIdx;
                    if (_gbIdx >= 0 && _curIdx > _gbIdx) {
                        setSetting('gbDisableFired', true);
                        addLiveLog(`Disable ranking: already past ${_targetRankGta} — will apply on next account`);
                    }
                    if (_atGb) {
                        const cur = state.enabledActions;
                        if (cur.includes('gta')) {
                            state.enabledActions = cur.filter(id => id !== 'gta');
                            setSetting('gbDisableFired', true);
                            buildActionCheckboxes();
                            saveSettings();
                            addLiveLog(`Disable ranking: GTA disabled (already at ${_targetRankGta})`);
                        }
                    }
                }
            });
        }

        const accEnabledCb = document.querySelector('#ug-bot-acc-enabled');
        if (accEnabledCb && !accEnabledCb.dataset.listenerAttached) {
            accEnabledCb.dataset.listenerAttached = '1';
            accEnabledCb.checked = state.accEnabled;
            accEnabledCb.addEventListener('change', () => {
                state.accEnabled = accEnabledCb.checked;
                // Reset name index when toggled on so it starts from the top
                if (accEnabledCb.checked) state.accNameIndex = 0;
            });
        }

        const accEmailEl = document.querySelector('#ug-bot-acc-email');
        if (accEmailEl && !accEmailEl.dataset.listenerAttached) {
            accEmailEl.dataset.listenerAttached = '1';
            accEmailEl.value = state.accEmail;
            accEmailEl.addEventListener('change', () => { state.accEmail = accEmailEl.value.trim(); });
        }

        const accPasswordEl = document.querySelector('#ug-bot-acc-password');
        if (accPasswordEl && !accPasswordEl.dataset.listenerAttached) {
            accPasswordEl.dataset.listenerAttached = '1';
            accPasswordEl.value = state.accPassword;
            accPasswordEl.addEventListener('change', () => { state.accPassword = accPasswordEl.value; });
        }

        const accRetrieveCb = document.querySelector('#ug-bot-acc-retrieve');
        if (accRetrieveCb && !accRetrieveCb.dataset.listenerAttached) {
            accRetrieveCb.dataset.listenerAttached = '1';
            accRetrieveCb.checked = state.accRetrieve;
            accRetrieveCb.addEventListener('change', () => {
                state.accRetrieve = accRetrieveCb.checked;
            });
        }

        const accRetrieveNowBtn = document.querySelector('#ug-bot-acc-retrieve-now');
        if (accRetrieveNowBtn && !accRetrieveNowBtn.dataset.listenerAttached) {
            accRetrieveNowBtn.dataset.listenerAttached = '1';
            accRetrieveNowBtn.addEventListener('click', () => {
                GM_setValue('accPendingRetrieve', true);
                gotoPage('my-stats', { s: 'email' });
            });
        }

        const accNamesEl = document.querySelector('#ug-bot-acc-names');
        if (accNamesEl && !accNamesEl.dataset.listenerAttached) {
            accNamesEl.dataset.listenerAttached = '1';
            // Populate from storage
            accNamesEl.value = state.accUsernames.join('\n');
            accNamesEl.addEventListener('input', () => {
                const lines = accNamesEl.value.split('\n')
                    .map(l => sanitiseUsername(l))
                    .filter(l => l.length >= 1);
                state.accUsernames = lines;
                const statusEl = document.querySelector('#ug-bot-acc-status');
                if (statusEl) statusEl.textContent = lines.length + ' name(s) saved';
            });
        }

        const personalityResetBtn = document.querySelector('#ug-bot-personality-reset');
        if (personalityResetBtn && !personalityResetBtn.dataset.listenerAttached) {
            personalityResetBtn.dataset.listenerAttached = '1';
            personalityResetBtn.addEventListener('click', () => {
                if (!confirm('Reset personality? A new one will be generated and applied on next page load.')) return;
                const dupeMode = document.querySelector('#ug-bot-dupe-mode')?.checked ?? PERSONALITY.dupeMode;
                generatePersonality(dupeMode);
                addLiveLog(`Personality reset (dupe=${dupeMode}) — reload the page to apply`);
                personalityResetBtn.textContent = 'Reset — reload page!';
                personalityResetBtn.style.color = '#f8c84a';
            });
        }

        const dupeModeInput = document.querySelector('#ug-bot-dupe-mode');
        const personalityInfoEl = document.querySelector('#ug-bot-personality-info');
        if (dupeModeInput) {
            dupeModeInput.checked = !!PERSONALITY.dupeMode;
            if (!dupeModeInput.dataset.listenerAttached) {
                dupeModeInput.dataset.listenerAttached = '1';
                dupeModeInput.addEventListener('change', () => {
                    const dupeMode = dupeModeInput.checked;
                    generatePersonality(dupeMode);
                    addLiveLog(`Dupe mode ${dupeMode ? 'enabled' : 'disabled'} — reload the page to apply`);
                    if (personalityResetBtn) {
                        personalityResetBtn.textContent = 'Dupe mode changed — reload!';
                        personalityResetBtn.style.color = '#f8c84a';
                    }
                });
            }
        }
        if (personalityInfoEl) {
            const p = PERSONALITY;
            const mode = p.dupeMode ? 'Dupe' : 'Normal';
            personalityInfoEl.textContent = `${mode} mode · nav ${p.navDelayMin}–${p.navDelayMax}ms · heartbeat ${p.heartbeatMs}ms · idle ${p.idleVisitChancePct}% · human pages: ${p.humanPages.length}`;
        }

        const accGenerateBtn = document.querySelector('#ug-bot-acc-generate');
        if (accGenerateBtn && !accGenerateBtn.dataset.listenerAttached) {
            accGenerateBtn.dataset.listenerAttached = '1';
            accGenerateBtn.addEventListener('click', () => {
                const names = generateRandomUsernames(100);
                if (accNamesEl) accNamesEl.value = names.join('\n');
                state.accUsernames = names;
                state.accNameIndex = 0;
                const statusEl = document.querySelector('#ug-bot-acc-status');
                if (statusEl) statusEl.textContent = names.length + ' names generated';
            });
        }

        const accClearNamesBtn = document.querySelector('#ug-bot-acc-clear-names');
        if (accClearNamesBtn && !accClearNamesBtn.dataset.listenerAttached) {
            accClearNamesBtn.dataset.listenerAttached = '1';
            accClearNamesBtn.addEventListener('click', () => {
                if (!confirm('Clear all usernames from the list?')) return;
                if (accNamesEl) accNamesEl.value = '';
                state.accUsernames = [];
                state.accNameIndex = 0;
                const statusEl = document.querySelector('#ug-bot-acc-status');
                if (statusEl) statusEl.textContent = 'List cleared';
            });
        }

        // Restore panel scroll position from before last page navigation
        const savedPanelScroll = Number(getSetting('scrollPanel', 0));
        if (savedPanelScroll > 0) {
            const panel = document.querySelector('#ug-bot-panel');
            if (panel) {
                panel.scrollTop = savedPanelScroll;
                setSetting('scrollPanel', 0);
            }
        }

        const killClearBtn = document.querySelector('#ug-bot-kill-clear');
        if (killClearBtn) {
            killClearBtn.addEventListener('click', () => {
                if (confirm('Clear the entire player list? This cannot be undone.')) {
                    state.killPlayers       = [];
                    state.killDeadPlayers   = [];
                    state.killCurrentSearch = '';
                    clearKillSearchSubmitTracking();
                    state.killSearchIndex   = 0;
                    renderKillList();
                    addLiveLog('Kill scanner: player list cleared');
                }
            });
        }

        // Kill scanner — copy names button
        const killCopyBtn = document.querySelector('#ug-bot-kill-copy');
        if (killCopyBtn) {
            killCopyBtn.addEventListener('click', () => {
                const players = getKillPlayers().filter(p =>
                    p.status !== KILL_STATUS.UNKILLABLE
                );
                if (!players.length) {
                    killCopyBtn.textContent = 'Nothing to copy';
                    setTimeout(() => { killCopyBtn.textContent = 'Copy'; }, 2000);
                    return;
                }
                const names = players.map(p => p.name).join(String.fromCharCode(10));
                navigator.clipboard.writeText(names).then(() => {
                    killCopyBtn.textContent = `Copied ${players.length}!`;
                    setTimeout(() => { killCopyBtn.textContent = 'Copy'; }, 2000);
                }).catch(() => {
                    // Fallback for browsers that block clipboard API
                    const ta = document.createElement('textarea');
                    ta.value = names;
                    ta.style.position = 'fixed';
                    ta.style.opacity  = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    killCopyBtn.textContent = `Copied ${players.length}!`;
                    setTimeout(() => { killCopyBtn.textContent = 'Copy'; }, 2000);
                });
            });
        }

        // Kill scanner — import names button
        const killImportBtn = document.querySelector('#ug-bot-kill-import');
        if (killImportBtn) {
            killImportBtn.addEventListener('click', () => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';

                const modal = document.createElement('div');
                modal.style.cssText = 'background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:16px;width:320px;max-width:90vw;';
                modal.innerHTML = `
                    <div style="font-weight:bold;font-size:13px;margin-bottom:8px;color:#fff;">Import player names</div>
                    <div style="font-size:11px;color:#aaa;margin-bottom:8px;">Paste one name per line. Players will be added as Unknown and searched automatically. Players already in the list will be skipped.</div>
                    <textarea id="ug-bot-kill-import-ta" style="width:100%;box-sizing:border-box;height:200px;background:#111;color:#fff;border:1px solid #555;border-radius:6px;padding:8px;font-size:12px;resize:vertical;" placeholder="PlayerName1&#10;PlayerName2&#10;PlayerName3"></textarea>
                    <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
                        <button id="ug-bot-kill-import-cancel" type="button" style="font-size:12px;padding:5px 12px;">Cancel</button>
                        <button id="ug-bot-kill-import-confirm" type="button" style="font-size:12px;padding:5px 12px;background:#2a6;color:#fff;border:none;border-radius:4px;">Import</button>
                    </div>
                    <div id="ug-bot-kill-import-result" style="font-size:11px;color:#aaa;margin-top:8px;"></div>
                `;
                overlay.appendChild(modal);
                document.body.appendChild(overlay);

                document.querySelector('#ug-bot-kill-import-cancel').addEventListener('click', () => {
                    document.body.removeChild(overlay);
                });

                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) document.body.removeChild(overlay);
                });

                document.querySelector('#ug-bot-kill-import-confirm').addEventListener('click', () => {
                    const ta = document.querySelector('#ug-bot-kill-import-ta');
                    const lines = ta.value.split('\n').map(l => l.trim()).filter(Boolean);
                    if (!lines.length) return;

                    const players = getKillPlayers();
                    const existingNames = new Set(players.map(p => p.name.toLowerCase()));
                    let added = 0;
                    let skipped = 0;

                    for (const name of lines) {
                        if (existingNames.has(name.toLowerCase())) {
                            skipped++;
                            continue;
                        }
                        players.push({
                            name,
                            status: KILL_STATUS.UNKNOWN,
                            lastChecked: 0,
                            addedAt: now(),
                        });
                        existingNames.add(name.toLowerCase());
                        added++;
                    }

                    if (added > 0) {
                        saveKillPlayers(players);
                        renderKillList();
                        // Activate search loop to pick up the new unknowns
                        if (state.killSearchEnabled) state.killSearchLoopActive = true;
                        addLiveLog(`Kill scanner: imported ${added} player(s) — ${skipped} already in list`);
                    }

                    const result = document.querySelector('#ug-bot-kill-import-result');
                    if (result) result.textContent = `Added ${added} player${added !== 1 ? 's' : ''}${skipped ? `, skipped ${skipped} duplicate${skipped !== 1 ? 's' : ''}` : ''}.`;

                    if (added > 0) {
                        setTimeout(() => {
                            if (document.body.contains(overlay)) document.body.removeChild(overlay);
                        }, 1500);
                    }
                });
            });
        }

        // Kill scanner — Select All BG button
        const killSelectAllBgBtn = document.querySelector('#ug-bot-kill-select-all-bg');
        if (killSelectAllBgBtn) {
            killSelectAllBgBtn.addEventListener('click', () => {
                const players = getKillPlayers().filter(p =>
                    p.status === KILL_STATUS.ALIVE || p.status === KILL_STATUS.UNKNOWN
                );
                const allOn = players.every(p => isPlayerBgCheckEnabled(p.name));
                for (const p of players) setPlayerBgCheckEnabled(p.name, !allOn);
                if (!allOn && state.killBgCheckEnabled) { state.killBgWaitUntil = 0; state.killLoopCooldownUntil = 0; state.killLoopActive = true; }
                renderKillList();
                addLiveLog(`Kill scanner: BG check ${allOn ? 'disabled' : 'enabled'} for all ${players.length} players`);
            });
        }

        // Kill scanner — All Kill button (toggles all on/off)
        const killSelectAllShootBtn = document.querySelector('#ug-bot-kill-select-all-shoot');
        if (killSelectAllShootBtn) {
            killSelectAllShootBtn.addEventListener('click', () => {
                const players = getKillPlayers().filter(p =>
                    p.status === KILL_STATUS.ALIVE || p.status === KILL_STATUS.UNKNOWN
                );
                const allOn = players.every(p => isPlayerShootEnabled(p.name));
                for (const p of players) setPlayerShootEnabled(p.name, !allOn);
                if (!allOn && state.killBgCheckEnabled) { state.killBgWaitUntil = 0; state.killLoopCooldownUntil = 0; state.killLoopActive = true; }
                renderKillList();
                addLiveLog(`Kill scanner: shoot ${allOn ? 'disabled' : 'enabled'} for all ${players.length} players`);
            });
        }
    }

    function updatePanel() {
        if (!toggleBtn || !compactBtn || !hideBtn || !closeBtn) return;

        const panel       = document.querySelector('#ug-bot-panel');
        const runtimeText = formatRuntime(getCurrentRuntimeMs());
        const rankText    = getPlayerRank() || 'unknown';
        const cashText    = `$${getPlayerMoney().toLocaleString()}`;
        const pointsText  = getPlayerPoints().toLocaleString();

        // Re-enable auto-disabled settings when player reaches Don (protection ends at Don)
        const _autoDisabled = JSON.parse(GM_getValue('accAutoDisabled', '[]'));
        if (_autoDisabled.length > 0) {
            const _donIdx = RANKS.indexOf('Don');
            const _curRankIdx = getPlayerRankIndex();

            if (_donIdx >= 0 && _curRankIdx >= 0 && _curRankIdx >= _donIdx) {
                const _labels = {
                    autoDrugs: 'Drug run', killSearch: 'Search players',
                    killProtectedRecheck: 'Protected re-search', killBgCheck: 'BG check loop',
                    killBgSpam: 'BG Spam', autoBuyGun: 'Auto buy gun'
                };
                const _reenabled = [];
                for (const key of _autoDisabled) {
                    if (key === 'autoDrugs' && !state.autoDrugsEnabled) {
                        state.autoDrugsEnabled = true;
                        if (autoDrugsInput) autoDrugsInput.checked = true;
                        _reenabled.push(_labels[key]);
                    } else if (key === 'killSearch' && !state.killSearchEnabled) {
                        state.killSearchEnabled = true;
                        if (killSearchInput) killSearchInput.checked = true;
                        // Death/new-account handling already resets the list. At Don, keep
                        // existing statuses intact and only clear transient search markers so
                        // BG Farm cannot mistake a pending target for an actionable target.
                        const _players = getSetting('killPlayers', []);
                        const _reset = _players.map(p => {
                            if (!p.pendingSearch && !p.expectedFoundAt) return p;
                            const np = { ...p };
                            delete np.pendingSearch;
                            delete np.expectedFoundAt;
                            return np;
                        });
                        setSetting('killPlayers', _reset);
                        addLiveLog('Kill scanner: cleared transient search markers for new account');
                        _reenabled.push(_labels[key]);
                    } else if (key === 'killProtectedRecheck' && !state.killProtectedRecheckEnabled) {
                        state.killProtectedRecheckEnabled = true;
                        if (killProtectedRecheckInput) killProtectedRecheckInput.checked = true;
                        _reenabled.push(_labels[key]);
                    } else if (key === 'killBgCheck' && !state.killBgCheckEnabled) {
                        state.killBgCheckEnabled = true;
                        if (killBgCheckInput) killBgCheckInput.checked = true;
                        _reenabled.push(_labels[key]);
                    } else if (key === 'killBgSpam' && !state.killBgSpamEnabled) {
                        state.killBgSpamEnabled = true;
                        if (killBgSpamInput) killBgSpamInput.checked = true;
                        syncBgSpamState();
                        _reenabled.push('BG Spam');
                    } else if (key === 'autoBuyGun' && !state.autoBuyGun) {
                        state.autoBuyGun = true;
                        const _autoBuyGunEl = document.querySelector('#ug-bot-auto-buy-gun');
                        if (_autoBuyGunEl) _autoBuyGunEl.checked = true;
                        _reenabled.push('Auto buy gun');
                    }
                }
                if (_reenabled.length > 0) {
                    addLiveLog('Reached Don — re-enabled: ' + _reenabled.join(', '));
                    updatePanel();
                }
                GM_setValue('accAutoDisabled', '[]');

                // Buy a gun if we don't have one
                if (getPlayerGunValue() === 0) {
                    autoBuyGun();
                }

                // Clear stale BG Farm state from the previous account, but do not
                // apply a 3hr global wait. The normal search loop must be free
                // to search every player after Don; BG Farm will resume once its
                // targets are actually found in Players Found.
                const _bgFarmPlayers = getSetting('killPlayers', []);
                const _bgFarmReset = _bgFarmPlayers.map(p => {
                    if (!p.bgFarmEnabled) return p;
                    const np = { ...p };
                    delete np.bodyguard;
                    delete np.expectedFoundAt;
                    delete np.searchExpiresAt;
                    delete np.pendingSearch;
                    delete np.bgFarmWaitUntil;
                    np.lastBgCheck = 0;
                    return np;
                });
                setSetting('killPlayers', _bgFarmReset);
                setSetting('killBgWaitUntil', 0);
                setSetting('killLoopCooldownUntil', 0);
                setSetting('pendingKillAction', null);
                setSetting('killLoopActive', false);
                const _bgFarmCount = _bgFarmPlayers.filter(p => p.bgFarmEnabled).length;
                if (_bgFarmCount > 0) {
                    addLiveLog(`BG Farm: cleared stale BG state for ${_bgFarmCount} player(s) — search loop can continue`);
                }
            }
        }

        // Disable crimes/GTA at selected rank if toggles are on
        if (state.disableCrimesAtGb || state.disableGtaAtGb) {
            const _curIdx = getPlayerRankIndex();
            // Use each dropdown's rank separately
            const _crimesRank = state.disableCrimesRank || 'Global Boss';
            const _gtaRank    = state.disableGtaRank    || 'Global Boss';
            const _gbIdx = Math.min(
                state.disableCrimesAtGb ? RANKS.indexOf(_crimesRank) : 999,
                state.disableGtaAtGb    ? RANKS.indexOf(_gtaRank)    : 999
            );
            const _atGb   = _gbIdx >= 0 && _curIdx >= 0 && _curIdx >= _gbIdx;
            // Only fire the disable once per GB stint — tracked by gbDisableFired flag
            // Reset the flag when rank drops below Global Boss (new account after death)
            if (!_atGb) {
                if (getSetting('gbDisableFired', false)) setSetting('gbDisableFired', false);
            } else if (!getSetting('gbDisableFired', false)) {
                const _actions = [...state.enabledActions];
                let _changed = false;
                const _crimeIds = ['gang', '1', '2', 'drug', '3', '4', '5', '6', '7'];
                if (state.disableCrimesAtGb && _curIdx >= RANKS.indexOf(_crimesRank)) {
                    const _filtered = _actions.filter(id => !_crimeIds.includes(id));
                    if (_filtered.length !== _actions.length) { state.enabledActions = _filtered; _changed = true; }
                    if (state.bgCrimeEnabled) { state.bgCrimeEnabled = false; stopBgCrime(); if (bgCrimeEnabledInput) bgCrimeEnabledInput.checked = false; _changed = true; }
                }
                if (state.disableGtaAtGb && _curIdx >= RANKS.indexOf(_gtaRank)) {
                    const _cur = state.enabledActions;
                    if (_cur.includes('gta')) {
                        state.enabledActions = _cur.filter(id => id !== 'gta');
                        const gtaCb = document.querySelector('.ug-action-cb[data-id="gta"]');
                        if (gtaCb) gtaCb.checked = false;
                        _changed = true;
                    }
                }
                if (_changed) {
                    setSetting('gbDisableFired', true);
                    addLiveLog('Reached Global Boss — disabled: ' + [state.disableCrimesAtGb ? 'crimes' : null, state.disableGtaAtGb ? 'GTA' : null].filter(Boolean).join(', '));
                    buildActionCheckboxes();
                    saveSettings();
                }
            }
        }

        let statusMain = state.enabled ? 'Running' : 'Stopped';
        if (!state.enabled && state.pausedReason) statusMain += ` (${state.pausedReason})`;

        if (panel) {
            panel.classList.toggle('ug-collapsed', state.panelCollapsed);
        }

        const gtaStatus = !isGTAEnabled()
            ? 'off'
            : isGTALocked()
                ? 'locked'
                : (getInternalGTARemainingMs() > 0 ? `${Math.ceil(getInternalGTARemainingMs() / 1000)}s` : 'ready');

        const meltStatus = !isMeltEnabled()
            ? 'off'
            : isMeltLocked()
                ? 'locked'
                : (getInternalMeltRemainingMs() > 0 ? `${Math.ceil(getInternalMeltRemainingMs() / 1000)}s` : 'ready');

        const drugRunStatus = !isDrugsEnabled()
            ? 'off'
            : (getInternalDriveRemainingMs() > 0 ? `${Math.ceil(getInternalDriveRemainingMs() / 1000)}s` : 'ready');

        const repairStatus = state.autoRepairEnabled
            ? `${state.meltsSinceRepair}/${state.repairEveryMelts}`
            : 'off';

        const missionStatus = !state.autoMissionsEnabled
            ? 'off'
            : (state.autoGiveCarMissionsEnabled ? 'crime + cars' : 'crime only');

        const jailStatus = state.leaveJailEnabled
            ? `on (min ${state.leaveJailMinPoints}pts)`
            : 'off';

        const resetStatus =
            state.resetCrimesEnabled ? `crimes (6pts, min ${state.resetTimerMinPoints}pts)` :
            state.resetGTAEnabled    ? `GTA (3pts, min ${state.resetTimerMinPoints}pts)` :
            state.resetMeltEnabled   ? `melt loop (4pts, min ${state.resetTimerMinPoints}pts)` :
            'off';

        // Compact view — shown when panel is collapsed, renders into collapsed-controls
        if (state.panelCollapsed && state.panelCompact) {
            const compactEl = document.querySelector('#ug-bot-collapsed-controls');
            if (compactEl) {
                compactEl.innerHTML = `
                    <div class="ug-status-line"><b>Status:</b> ${escapeHtml(statusMain)}</div>
                    <div class="ug-status-line"><b>Runtime:</b> ${escapeHtml(runtimeText)}</div>
                    <div class="ug-status-line"><b>Rank:</b> ${escapeHtml(rankText)}</div>
                    <div class="ug-status-line"><b>GTA:</b> ${escapeHtml(gtaStatus)}</div>
                    <div class="ug-status-line"><b>Melt:</b> ${escapeHtml(meltStatus)}</div>
                    <div class="ug-status-line"><b>Drug run:</b> ${escapeHtml(drugRunStatus)}</div>
                    <div class="ug-status-line"><b>Repair:</b> ${escapeHtml(repairStatus)}</div>
                    <div class="ug-status-line"><b>Missions:</b> ${escapeHtml(missionStatus)}</div>
                    <div class="ug-status-line"><b>Leave Jail:</b> ${escapeHtml(jailStatus)}</div>
                    <div class="ug-status-line"><b>Timer reset:</b> ${escapeHtml(resetStatus)}</div>
                    <div class="ug-status-line"><b>Kill scan:</b> ${(() => {
                        if (!state.killScanOnlineEnabled) return 'off';
                        const msUntil = (state.killScanOnlineInterval * 60 * 1000) - (now() - state.killLastOnlineScan);
                        if (msUntil <= 0) return 'ready';
                        const mins = Math.floor(msUntil / 60000);
                        const secs = Math.floor((msUntil % 60000) / 1000);
                        return mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
                    })()} | Search: ${state.killSearchEnabled ? 'on' : 'off'} | Players: ${getKillPlayers().length}</div>
                    ${state.killPenaltyThreshold > 0 ? `<div class="ug-status-line"><b>Kill penalty:</b> ${(() => {
                        const penalty = Number(getSetting('cachedKillPenalty', 1.0));
                        const penStr = penalty > 1.0 ? `${penalty.toFixed(2)}x` : 'none';
                        if (state.penaltyDropsAt && state.penaltyDropsAt > now()) {
                            const ms = state.penaltyDropsAt - now();
                            const hrs  = Math.floor(ms / 3600000);
                            const mins = Math.floor((ms % 3600000) / 60000);
                            const secs = Math.floor((ms % 60000) / 1000);
                            const timeStr = hrs > 0 ? hrs + 'h ' + mins + 'm' : mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
                            return `${penStr} — resumes in ${timeStr}`;
                        }
                        return penStr;
                    })()}</div>` : ''}
                    <div class="ug-status-line"><b>Deposit:</b> ${state.autoDepositEnabled && !state.autoDrugsEnabled ? '$' + escapeHtml(state.autoDepositThreshold.toLocaleString()) : 'off'}</div>
                `;
            }
        }


        const toggleText = state.enabled ? 'Pause' : 'Start';
        toggleBtn.textContent = toggleText;


        compactBtn.textContent = state.panelCollapsed ? 'Expand' : 'Compact';

        // Update sidebar button indicator if it's visible
        const sidebarBtn = document.querySelector('#ug-bot-sidebar-btn');
        if (sidebarBtn) {
            if (state.enabled) {
                sidebarBtn.innerHTML = '⚙ UG Bot <span style="color:#9fe79f;">●</span>';
                sidebarBtn.classList.remove('ug-bot-stopped');
            } else {
                sidebarBtn.innerHTML = '⚙ UG Bot <span style="color:#f88;">●</span>';
                sidebarBtn.classList.add('ug-bot-stopped');
            }
        }

        refreshActionLockStates();
        renderLiveLog();
        renderDrugDepositCalc();
        renderKillList();

        // Update kill player count badge
        const killCountEl = document.querySelector('#ug-bot-kill-count');
        if (killCountEl) {
            const players = getKillPlayers();
            killCountEl.textContent = `(${players.length} tracked)`;
        }
    }

    function injectSidebarButton() {
        if (document.querySelector('#ug-bot-sidebar-btn')) return;

        const statbar = document.querySelector('#statbar');
        if (!statbar) return;

        const btn = document.createElement('button');
        btn.id          = 'ug-bot-sidebar-btn';
        btn.title = 'Open UG Bot panel';
        if (state.enabled) {
            btn.innerHTML = '⚙ UG Bot <span style="color:#9fe79f;">●</span>';
        } else {
            btn.innerHTML = '⚙ UG Bot <span style="color:#f88;">●</span>';
            btn.classList.add('ug-bot-stopped');
        }

        btn.addEventListener('click', () => {
            state.panelHidden = false;
            const panel = document.querySelector('#ug-bot-panel');
            if (panel) panel.style.display = '';
            btn.remove();
            updatePanel();
        });

        const h1 = statbar.querySelector('h1');
        if (h1) {
            statbar.insertBefore(btn, h1);
        } else {
            statbar.prepend(btn);
        }

        if (!document.querySelector('#ug-bot-sidebar-style')) {
            const style = document.createElement('style');
            style.id = 'ug-bot-sidebar-style';
            style.textContent = `
                #ug-bot-sidebar-btn {
                    display: block;
                    width: 100%;
                    margin-bottom: 6px;
                    padding: 4px 8px;
                    background: #2f2f2f;
                    color: #9fe79f;
                    border: 1px solid #555;
                    border-radius: 5px;
                    font-size: 11px;
                    cursor: pointer;
                    text-align: center;
                    font-family: Arial, sans-serif;
                }
                #ug-bot-sidebar-btn:hover {
                    background: #3f3f3f;
                    border-color: #888;
                }
                #ug-bot-sidebar-btn.ug-bot-stopped {
                    color: #f88;
                }

            `;
            document.head.appendChild(style);
        }
    }

    // ── Per-window bot activation ─────────────────────────────────────────────
    // The bot must run only in the window you explicitly activate. The old
    // window.name/sessionStorage approach was not reliable after Cloudflare, and
    // the URL-hash token approach could confuse navigation. Tampermonkey's
    // GM_getTab/GM_saveTab is the right fit here: it stores a marker against the
    // browser tab itself, so it survives normal redirects without touching URLs
    // and without activating your other game windows.
    const UG_BOT_WINDOW_NAME = 'ug-bot';
    const UG_BOT_SESSION_ACTIVE_KEY = 'ugbot_window_active';
    const UG_BOT_SESSION_TOKEN_KEY  = 'ugbot_window_token';

    let ugBotTabIdentityLoaded = false;
    let ugBotTabIdentityActive = false;
    let ugBotTabIdentityToken  = '';

    function makeBotWindowToken() {
        try {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        } catch (_) {
            return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
        }
    }

    function getSessionBotWindowToken() {
        try { return sessionStorage.getItem(UG_BOT_SESSION_TOKEN_KEY) || ''; } catch (_) { return ''; }
    }

    function getWindowNameBotToken() {
        try {
            const name = String(window.name || '');
            if (name === UG_BOT_WINDOW_NAME) return getSessionBotWindowToken(); // legacy marker
            if (name.startsWith(UG_BOT_WINDOW_NAME + ':')) return name.slice((UG_BOT_WINDOW_NAME + ':').length);
        } catch (_) {}
        return '';
    }

    function hasBotWindowSessionFlag() {
        try { return sessionStorage.getItem(UG_BOT_SESSION_ACTIVE_KEY) === '1'; } catch (_) { return false; }
    }

    function getBotWindowToken() {
        return getSessionBotWindowToken() || getWindowNameBotToken() || ugBotTabIdentityToken || '';
    }

    function setBotWindowSessionFlag(token) {
        try {
            sessionStorage.setItem(UG_BOT_SESSION_ACTIVE_KEY, '1');
            if (token) sessionStorage.setItem(UG_BOT_SESSION_TOKEN_KEY, token);
        } catch (_) {}
    }

    function saveBotTabIdentity(token, active = true) {
        if (typeof GM_getTab !== 'function' || typeof GM_saveTab !== 'function') return;
        try {
            GM_getTab(tab => {
                tab = tab || {};
                tab.ugbotWindowActive = !!active;
                if (token) tab.ugbotWindowToken = token;
                GM_saveTab(tab);
            });
        } catch (_) {}
    }

    function loadBotTabIdentity(done) {
        if (ugBotTabIdentityLoaded) { done(); return; }
        if (typeof GM_getTab !== 'function') {
            ugBotTabIdentityLoaded = true;
            done();
            return;
        }
        try {
            GM_getTab(tab => {
                tab = tab || {};
                ugBotTabIdentityActive = !!tab.ugbotWindowActive;
                ugBotTabIdentityToken  = typeof tab.ugbotWindowToken === 'string' ? tab.ugbotWindowToken : '';
                ugBotTabIdentityLoaded = true;
                if (ugBotTabIdentityActive) {
                    activateBotWindowIdentity(ugBotTabIdentityToken, { saveTab: false });
                }
                done();
            });
        } catch (_) {
            ugBotTabIdentityLoaded = true;
            done();
        }
    }

    function activateBotWindowIdentity(existingToken = '', opts = {}) {
        const saveTab = opts.saveTab !== false;
        const token = existingToken || getBotWindowToken() || makeBotWindowToken();
        window.name = UG_BOT_WINDOW_NAME + ':' + token;
        setBotWindowSessionFlag(token);
        ugBotTabIdentityActive = true;
        ugBotTabIdentityToken = token;
        if (saveTab) saveBotTabIdentity(token, true);
    }

    function isActivatedBotWindow() {
        return ugBotTabIdentityActive || !!getBotWindowToken() || window.name === UG_BOT_WINDOW_NAME || hasBotWindowSessionFlag();
    }

    function repairBotWindowIdentityAfterRedirect() {
        if (ugBotTabIdentityActive) {
            activateBotWindowIdentity(ugBotTabIdentityToken, { saveTab: false });
            return;
        }
        const token = getBotWindowToken();
        if (token) {
            activateBotWindowIdentity(token);
        } else if (window.name === UG_BOT_WINDOW_NAME || hasBotWindowSessionFlag()) {
            activateBotWindowIdentity();
        }
    }

    function init() {
        if (!document.body) {
            setTimeout(init, 300);
            return;
        }

        // ── Window identity check ─────────────────────────────────────────────
        // Load Tampermonkey's per-tab marker first. This survives Cloudflare
        // redirects without putting anything in the URL and without activating
        // other browser windows/tabs.
        if (!ugBotTabIdentityLoaded) {
            loadBotTabIdentity(() => init());
            return;
        }
        repairBotWindowIdentityAfterRedirect();
        if (!isActivatedBotWindow()) {
            // Not designated — show a minimal activate button, stay dormant
            const existing = document.querySelector('#ug-bot-activate');
            if (!existing) {
                const btn = document.createElement('div');
                btn.id = 'ug-bot-activate';
                btn.textContent = '⚙ UG Bot';
                btn.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#222;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;z-index:99999;border:1px solid #555;';
                btn.title = 'Click to activate UG Bot in this window';
                btn.addEventListener('click', () => {
                    activateBotWindowIdentity();
                    btn.remove();
                    init();
                });
                document.body.appendChild(btn);
            }
            return;
        }

        // ── Singleton guard ───────────────────────────────────────────────────
        // Prevent duplicate UG Bot instances from starting timers/loops during
        // rapid reloads or Tampermonkey double-injection. This must run before
        // any heartbeat, sniper, background crime, or observer loops are started.
        if (typeof unsafeWindow !== 'undefined') {
            if (unsafeWindow._ugBotRunning) {
                console.warn('[UG-BOT] Another instance already running — aborting this one');
                return;
            }
            unsafeWindow._ugBotRunning = true;
            window.addEventListener('unload', () => { unsafeWindow._ugBotRunning = false; });
        }

        if (state.enabled && !state.sessionStartedAt) {
            state.sessionStartedAt = now();
        }


        // Sync loop flags from persisted toggle values on every page load.
        // This ensures dedicated loops remain active across page reloads even
        // if saveSettings() hasn't been called in this session (e.g. after a
        // browser restart or script update). The loop flags are kept in exact
        // sync with the toggle state — if the toggle is on, the loop is active;
        // if the toggle is off (including after a natural loop exit), it is not.
        state.gtaResetLoopActive   = state.resetGTAEnabled;
        state.meltResetLoopActive  = state.resetMeltEnabled;
        if (state.bustNoReload) { startNoReloadBust(); } else { stopNoReloadBust(); }

        // Start QT sniper on every page load if any QT option is enabled
        if (state.qtBgEnabled || state.qtBulletsEnabled || state.qtPointsEnabled) {
            startQTSniper();
        }
        // Start perk extender on every page load if enabled
        if (state.qtPerkExtendEnabled) {
            startQTPerkExtender();
        }
        if (state.qtPerkRedeemEnabled) {
            startQTPerkRedeemer();
        }
        if (state.autoBuyBgEnabled) {
            startAutoBuyBg();
        }
        if (state.bonusPointsEnabled) {
            startBonusPointsSpender();
        }
        // Start QT car scanner on every page load if enabled
        if (state.qtCarsEnabled) {
            startQTCarScanner();
        }
        // Start free entry dice joiner on every page load if enabled
        if (state.diceJoinEnabled) startDiceJoiner();
        // Start background crime loop on every page load if enabled
        if (state.bgCrimeEnabled) {
            startBgCrime();
        }
        // Kill search loop — activate on startup if toggle is on and there are due targets.
        // Uses the same logic as getNextKillTarget to avoid unnecessary kill page visits.
        if (!state.killSearchEnabled) {
            state.killSearchLoopActive = false;
        } else if (state.killSearchLoopActive) {
            // Was already running — keep it active
        } else {
            const nowMs = now();
            const players = getKillPlayers();
            const hasUnknowns = players.some(p => p.status === KILL_STATUS.UNKNOWN);
            const RESCAN_BUFFER_MS = 3 * 60 * 60 * 1000;
            const hasExpiringAlives = players.some(p => {
                if (p.status !== KILL_STATUS.ALIVE) return false;
                if (p.searchExpiresAt) return (p.searchExpiresAt - nowMs) < RESCAN_BUFFER_MS;
                return (nowMs - p.lastChecked) >= KILL_SCANNER_RESCAN_MS;
            });
            const protectedIntervalMs = state.killProtectedRecheckEnabled ? state.killProtectedRecheckMins * 60 * 1000 : KILL_SCANNER_PROTECTED_RESCAN_MS;
            const hasProtectedDue = players.some(p =>
                p.status === KILL_STATUS.PROTECTED &&
                (nowMs - p.lastChecked) >= protectedIntervalMs
            );
            state.killSearchLoopActive = hasUnknowns || hasExpiringAlives || hasProtectedDue;
        }

        // Kill loop (BG check/shoot) activation — activates on page load if toggle is on,
        // there are per-player BG ticked players, and at least one has a due interval.
        if (!state.killBgCheckEnabled) {
            state.killLoopActive    = false;
            state.pendingKillAction = null;
        } else if (state.killLoopActive) {
            // Already running — keep active
        } else {
            const alivePlayers = getKillPlayers().filter(p =>
                p.status === KILL_STATUS.ALIVE || p.status === KILL_STATUS.UNKNOWN
            );
            // Only activate if on kill page and can verify player is in Players Found
            // On other pages, syncKillExpiryFromPage handles reactivation when player appears
            const canCheckFound = isKillPage();
            const foundNames = canCheckFound
                ? new Set([...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                    .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){return '';} })
                    .filter(Boolean))
                : null;

            const hasDueBgCheck = alivePlayers.some(p => {
                if (!isBgCheckable(p.name)) return false;
                if (getBgCheckDueMs(p) > 0) return false;
                // On kill page: verify player is actually in Players Found right now
                if (canCheckFound) return foundNames && foundNames.has(p.name.toLowerCase());
                // On other pages: activate if BG check is due — kill loop will navigate to kill page
                return true;
            });
            const hasKillOnly = alivePlayers.some(p => {
                if (!isPlayerShootEnabled(p.name)) return false;
                if (p.lastKillAttempt && (now() - p.lastKillAttempt) < 30000) return false;
                if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) return false;
                if (isBgCheckable(p.name)) return false;
                // Skip if player has a pending bodyguard being searched
                if (p.bodyguard) return false;
                // If on kill page, only activate if player is actually in Players Found
                if (canCheckFound) return foundNames && foundNames.has(p.name.toLowerCase());
                // If not on kill page, only activate if expectedFoundAt has elapsed
                // (player should now be in Players Found) — don't activate based on stale data
                if (!p.expectedFoundAt) return false;
                return now() >= p.expectedFoundAt;
            });
            const hasPendingBg = alivePlayers.some(p => {
                if (!isPlayerShootEnabled(p.name)) return false;
                if (!p.bodyguard) return false;
                // BG is set — check if BG player is in the kill list as alive or unknown
                const bgPlayer = getKillPlayers().find(b => b.name && b.name.toLowerCase() === p.bodyguard.toLowerCase());
                return bgPlayer && (bgPlayer.status === KILL_STATUS.ALIVE || bgPlayer.status === KILL_STATUS.UNKNOWN);
            });
            // Allow 1-bullet BG checks even when penalty is high, but do not
            // activate the kill loop merely because a found BG is waiting to be shot.
            // Actual BG/original kill shots resume only after the penalty is below
            // the user's threshold.
            const penaltyTooHighNow = isKillPenaltyTooHigh();
            state.killLoopActive = hasDueBgCheck || (!penaltyTooHighNow && (hasPendingBg || hasKillOnly));
        }

        // Penalty page navigation is handled within handleKillPage / handleKillLoopPage
        // to avoid race conditions with the search loop tick

        // Cache drug capacity on drugs page visits so crimes page can use it for deposit calc
        if (isDrugsPage() || hasDrugsPageMarkers()) {
            const capacity = getDrugCapacity();
            if (capacity > 0) state.drugCapacityCache = capacity;
        }

        createPanel();
        switchTab(activeTab);

        // ── Bonus points drag-to-reorder ──────────────────────────────────
        (function initBonusDrag() {
            const tbody = document.querySelector('#ug-bot-bonus-priority-list tbody');
            if (!tbody) return;

            let dragSrc = null;

            tbody.addEventListener('dragstart', e => {
                dragSrc = e.target.closest('tr.ug-bonus-item');
                if (!dragSrc) return;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', '');
                setTimeout(() => dragSrc && dragSrc.classList.add('ug-dragging'), 0);
            });

            tbody.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const target = e.target.closest('tr.ug-bonus-item');
                tbody.querySelectorAll('tr.ug-bonus-item').forEach(r => r.classList.remove('ug-drag-over'));
                if (target && target !== dragSrc) target.classList.add('ug-drag-over');
            });

            tbody.addEventListener('dragleave', () => {
                tbody.querySelectorAll('tr.ug-bonus-item').forEach(r => r.classList.remove('ug-drag-over'));
            });

            tbody.addEventListener('drop', e => {
                e.preventDefault();
                const target = e.target.closest('tr.ug-bonus-item');
                tbody.querySelectorAll('tr.ug-bonus-item').forEach(r => r.classList.remove('ug-drag-over'));
                if (!target || target === dragSrc) return;

                // Insert before or after based on mouse Y position
                const rect = target.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                if (after) {
                    target.after(dragSrc);
                } else {
                    target.before(dragSrc);
                }

                // Persist new order
                const order = [...tbody.querySelectorAll('tr.ug-bonus-item')].map(r => r.dataset.bp);
                setSetting('bonusPerkOrder', JSON.stringify(order));
            });

            tbody.addEventListener('dragend', () => {
                tbody.querySelectorAll('tr.ug-bonus-item').forEach(r => {
                    r.classList.remove('ug-drag-over');
                    r.classList.remove('ug-dragging');
                });
                dragSrc = null;
            });

            // Save enabled perk checkboxes whenever one changes
            tbody.addEventListener('change', e => {
                if (!e.target.matches('.ug-bonus-cb')) return;
                const enabled = [...tbody.querySelectorAll('tr.ug-bonus-item')]
                    .filter(r => r.querySelector('.ug-bonus-cb')?.checked)
                    .map(r => r.dataset.bp);
                setSetting('bonusEnabledPerks', JSON.stringify(enabled));
            });

            // Restore saved order
            try {
                const saved = JSON.parse(getSetting('bonusPerkOrder') || '[]');
                if (saved.length) {
                    saved.forEach(bp => {
                        const row = tbody.querySelector(`tr[data-bp="${bp}"]`);
                        if (row) tbody.appendChild(row);
                    });
                }
            } catch(e) {}

            // Restore saved checked state
            try {
                const enabled = JSON.parse(getSetting('bonusEnabledPerks') || '[]');
                tbody.querySelectorAll('tr.ug-bonus-item').forEach(r => {
                    const cb = r.querySelector('.ug-bonus-cb');
                    if (cb) cb.checked = enabled.includes(r.dataset.bp);
                });
            } catch(e) {}
        })();
        // ─────────────────────────────────────────────────────────────────
        // Re-query element refs — createPanel() may have returned early if panel already existed
        toggleBtn               = document.querySelector('#ug-bot-toggle');
        compactBtn              = document.querySelector('#ug-bot-compact-btn');
        hideBtn                 = document.querySelector('#ug-bot-hide-btn');
        closeBtn                = document.querySelector('#ug-bot-close-btn');
        autoDepositInput        = document.querySelector('#ug-bot-autodeposit');
        depositThresholdEl           = document.querySelector('#ug-bot-deposit-threshold');
        bustNoReloadInput            = document.querySelector('#ug-bot-bust-noreload');
        bustPollMinEl                = document.querySelector('#ug-bot-bust-poll-min');
        bustPollMaxEl                = document.querySelector('#ug-bot-bust-poll-max');
        extendBulletsThreshEl        = document.querySelector('#ug-bot-extend-bullets-threshold');
        extendRaresThreshEl          = document.querySelector('#ug-bot-extend-rares-threshold');
        extendDoubleMeltsThreshEl    = document.querySelector('#ug-bot-extend-double-melts-threshold');
        extendBulletValueThreshEl    = document.querySelector('#ug-bot-extend-bullet-value-threshold');
        extendDoubleXpThreshEl       = document.querySelector('#ug-bot-extend-double-xp-threshold');
        extendAlwaysSuccThreshEl     = document.querySelector('#ug-bot-extend-always-successful-threshold');
        extendAlwaysBustThreshEl     = document.querySelector('#ug-bot-extend-always-bust-threshold');
        extendDoubleCashThreshEl     = document.querySelector('#ug-bot-extend-double-cash-threshold');
        autoRepairInput         = document.querySelector('#ug-bot-autorepair');
        repairEveryEl           = document.querySelector('#ug-bot-repair-every');
        autoMissionsInput       = document.querySelector('#ug-bot-automissions');
        autoGiveCarsInput       = document.querySelector('#ug-bot-autogivecars');
        autoDrugsInput          = document.querySelector('#ug-bot-autodrugs');
        drugDepositMultiplierEl = document.querySelector('#ug-bot-drug-deposit-multiplier');
        leaveJailInput          = document.querySelector('#ug-bot-leavejail');
        leaveJailMinPointsEl    = document.querySelector('#ug-bot-leavejail-minpoints');
        resetCrimesInput        = document.querySelector('#ug-bot-reset-crimes');
        resetCrimesFastModeInput= document.querySelector('#ug-bot-reset-crimes-fast');
        resetGTAInput           = document.querySelector('#ug-bot-reset-gta');
        resetMeltInput          = document.querySelector('#ug-bot-reset-melt');
        resetTimerMinPointsEl   = document.querySelector('#ug-bot-reset-minpoints');
        bgCrimeEnabledInput     = document.querySelector('#ug-bot-bg-crime');
        diceJoinEnabledInput    = document.querySelector('#ug-bot-dice-join-enabled');
        bulletFactoryEnabledInput= document.querySelector('#ug-bot-bullet-factory');
        killScanOnlineInput     = document.querySelector('#ug-bot-kill-scan-online');
        killScanIntervalEl      = document.querySelector('#ug-bot-kill-scan-interval');
        killSearchInput         = document.querySelector('#ug-bot-kill-search');
        killBgCheckInput        = document.querySelector('#ug-bot-kill-bgcheck');
        killBgSpamInput          = document.querySelector('#ug-bot-kill-bg-spam');
        killBgSpamIntervalEl     = document.querySelector('#ug-bot-kill-bg-spam-interval');
        killBgSpamTargetEl       = document.querySelector('#ug-bot-kill-bg-spam-target');
        killShootInput          = document.querySelector('#ug-bot-kill-shoot');
        killAnonymousInput      = document.querySelector('#ug-bot-kill-anonymous');
        killBgCheckIntervalEl   = document.querySelector('#ug-bot-kill-bgcheck-interval');
        killPenaltyThresholdEl  = document.querySelector('#ug-bot-kill-penalty-threshold');
        killProtectedRecheckInput  = document.querySelector('#ug-bot-kill-protected-recheck');
        killProtectedRecheckMinsEl = document.querySelector('#ug-bot-kill-protected-recheck-mins');
        qtBgEnabledInput        = document.querySelector('#ug-bot-qt-bg-enabled');
        qtBgThresholdEl         = document.querySelector('#ug-bot-qt-bg-threshold');
        qtBulletsEnabledInput   = document.querySelector('#ug-bot-qt-bullets-enabled');
        qtBulletsThresholdEl    = document.querySelector('#ug-bot-qt-bullets-threshold');
        qtBulletsMinEl          = document.querySelector('#ug-bot-qt-bullets-min');
        qtPollMinEl             = document.querySelector('#ug-bot-qt-poll-min');
        qtPollMaxEl             = document.querySelector('#ug-bot-qt-poll-max');
        qtPointsEnabledInput    = document.querySelector('#ug-bot-qt-points-enabled');
        qtPointsThresholdEl     = document.querySelector('#ug-bot-qt-points-threshold');
        qtCarsEnabledInput      = document.querySelector('#ug-bot-qt-cars-enabled');
        qtBustEnabledInput      = document.querySelector('#ug-bot-qt-bust-enabled');
        qtBustMaxPtsEl          = document.querySelector('#ug-bot-qt-bust-maxpts');
        qtBustMinAmtEl          = document.querySelector('#ug-bot-qt-bust-minamt');
        qtAlwaysSuccEnabledInput = document.querySelector('#ug-bot-qt-always-succ-enabled');
        qtAlwaysSuccMaxPtsEl    = document.querySelector('#ug-bot-qt-always-succ-maxpts');
        qtAlwaysSuccMinAmtEl    = document.querySelector('#ug-bot-qt-always-succ-minamt');
        qtDoubleMeltsEnabledInput = document.querySelector('#ug-bot-qt-double-melts-enabled');
        qtDoubleMeltsMaxPtsEl   = document.querySelector('#ug-bot-qt-double-melts-maxpts');
        qtDoubleMeltsMinAmtEl   = document.querySelector('#ug-bot-qt-double-melts-minamt');
        qtDoubleXpEnabledInput  = document.querySelector('#ug-bot-qt-double-xp-enabled');
        qtDoubleXpMaxPtsEl      = document.querySelector('#ug-bot-qt-double-xp-maxpts');
        qtDoubleXpMinAmtEl      = document.querySelector('#ug-bot-qt-double-xp-minamt');
        qtDoubleCashEnabledInput = document.querySelector('#ug-bot-qt-double-cash-enabled');
        qtDoubleCashMaxPtsEl    = document.querySelector('#ug-bot-qt-double-cash-maxpts');
        qtDoubleCashMinAmtEl    = document.querySelector('#ug-bot-qt-double-cash-minamt');
        qtRareEnabledInput      = document.querySelector('#ug-bot-qt-rare-enabled');
        qtRareMaxPtsEl          = document.querySelector('#ug-bot-qt-rare-maxpts');
        qtRareMinAmtEl          = document.querySelector('#ug-bot-qt-rare-minamt');
        qtBulletValueEnabledInput = document.querySelector('#ug-bot-qt-bullet-value-enabled');
        qtBulletValueMaxPtsEl   = document.querySelector('#ug-bot-qt-bullet-value-maxpts');
        qtBulletValueMinAmtEl   = document.querySelector('#ug-bot-qt-bullet-value-minamt');
        qtCarsIntervalEl        = document.querySelector('#ug-bot-qt-cars-interval');
        qtPerkExtendEnabledInput = document.querySelector('#ug-bot-qt-perk-extend-enabled');
        qtPerkExtendMinsEl      = document.querySelector('#ug-bot-qt-perk-extend-mins');
        logEl                   = document.querySelector('#ug-bot-log');
        try { syncGTAReadyFromQuickLink(); } catch(e) {}
        try { syncMeltReadyFromQuickLink(); } catch(e) {}
        // Sync drive timer from quick link — but don't let an "available" reading on a page
        // without a drive quick link reset a cooldown we just set after a drive submission
        const prevDriveReadyAt = state.nextDriveReadyAt;
        let driveWasSynced = false;
        try { driveWasSynced = syncDriveReadyFromQuickLink(); } catch(e) {}
        // Only preserve if quick link showed drive as available (which would set nextDriveReadyAt = now())
        // but we have a future cooldown — indicates quick link isn't present/reliable on this page
        if (driveWasSynced === false && state.nextDriveReadyAt < prevDriveReadyAt) {
            state.nextDriveReadyAt = prevDriveReadyAt;
        }
        try { protectMeltRows(); } catch(e) {}

        // On non-game pages (login, username, rules) always show the panel regardless of
        // panelHidden state — the user needs to be able to interact with it.
        const _isGamePage = !!currentPage(); // game pages have a ?p= param
        const _panel = document.querySelector('#ug-bot-panel');

        if (!_isGamePage) {
            // Non-game page — force panel visible and expanded, ignore panelHidden
            if (_panel) {
                _panel.style.display = '';
                _panel.classList.remove('ug-collapsed');
            }
            try { updatePanel(); } catch(e) {}
        } else if (state.panelHidden) {
            if (_panel) _panel.style.display = 'none';
            try { injectSidebarButton(); } catch(e) {}
        } else {
            if (_panel) _panel.style.display = '';
            try { updatePanel(); } catch(e) {}
        }

        // 1000ms display timer — smoothly updates runtime and countdown timers
        // in the compact view. Purely cosmetic, no bot logic involved.
        setInterval(() => {
            if (!toggleBtn || !compactBtn || !hideBtn || !closeBtn) return;
            const panel = document.querySelector('#ug-bot-panel');
            if (!panel) return;

            // Only update the time-sensitive display elements
            if (state.panelCollapsed && state.panelCompact) {
                // Re-render just the compact view lines that show timers
                const compactEl = document.querySelector('#ug-bot-collapsed-controls');
                if (compactEl) {
                    const runtimeText   = formatRuntime(getCurrentRuntimeMs());
                    const gtaStatus     = !isGTAEnabled() ? 'off' : isGTALocked() ? 'locked' :
                                          (getInternalGTARemainingMs() > 0 ? `${Math.ceil(getInternalGTARemainingMs() / 1000)}s` : 'ready');
                    const meltStatus    = !isMeltEnabled() ? 'off' : isMeltLocked() ? 'locked' :
                                          (getInternalMeltRemainingMs() > 0 ? `${Math.ceil(getInternalMeltRemainingMs() / 1000)}s` : 'ready');
                    const drugRunStatus = !isDrugsEnabled() ? 'off' :
                                          (getInternalDriveRemainingMs() > 0 ? `${Math.ceil(getInternalDriveRemainingMs() / 1000)}s` : 'ready');

                    // Update only the specific lines rather than rebuilding the whole compact view
                    [...compactEl.querySelectorAll('.ug-status-line')].forEach(el => {
                        const bold = el.querySelector('b');
                        if (!bold) return;
                        const label = bold.textContent;
                        if (label === 'Runtime:')  el.innerHTML = `<b>Runtime:</b> ${escapeHtml(runtimeText)}`;
                        if (label === 'GTA:')      el.innerHTML = `<b>GTA:</b> ${escapeHtml(gtaStatus)}`;
                        if (label === 'Melt:')     el.innerHTML = `<b>Melt:</b> ${escapeHtml(meltStatus)}`;
                        if (label === 'Drug run:') el.innerHTML = `<b>Drug run:</b> ${escapeHtml(drugRunStatus)}`;
                        if (label === 'Kill scan:') {
                            const msUntil = (state.killScanOnlineInterval * 60 * 1000) - (now() - state.killLastOnlineScan);
                            const killScanStatus = !state.killScanOnlineEnabled ? 'off' :
                                msUntil <= 0 ? 'ready' :
                                (() => {
                                    const mins = Math.floor(msUntil / 60000);
                                    const secs = Math.floor((msUntil % 60000) / 1000);
                                    return mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
                                })();
                            el.innerHTML = `<b>Kill scan:</b> ${escapeHtml(killScanStatus)} | Search: ${state.killSearchEnabled ? 'on' : 'off'} | Players: ${getKillPlayers().length}`;
                        }
                    });
                }
            }

            if (isMeltPage()) protectMeltRows();
        }, 1000);

        // 30s interval — update kill list time-since labels (no need to refresh more often)
        setInterval(() => {
            if (document.querySelector('#ug-bot-kill-list')) renderKillList();
        }, 30000);

        CTC.attachObserver(handleCTCMessage);

        // Expose a console-accessible reset function
        window.ugbotResetPersonality = function() {
            GM_setValue('ugbot_personality', null);
            console.log('[UG Bot] Personality reset — reload the page to generate a new one.');
        };

        applyPersonalityDefaults();
        if (state.enabled) startHeartbeat();
        setSetting('autoBuyGunPending', false); // clear any stale lock from previous session

        // Initialise lastBgCheck for BG Farm players that have never been checked
        // so the interval fires after the configured time, not immediately on startup
        if (state.killBgCheckEnabled) {
            const _players = state.killPlayers || [];
            let _changed = false;
            for (const _p of _players) {
                if (isPlayerBgFarmEnabled(_p.name) && !_p.lastBgCheck) {
                    _p.lastBgCheck = now();
                    _changed = true;
                }
            }
            if (_changed) saveKillPlayers(_players);
        }

        addLiveLog('Script loaded');
        if (personalityJustGenerated) addLiveLog(`[Personality] Deposit: $${PERSONALITY.depositThreshold.toLocaleString()} | Drug mult: ${PERSONALITY.drugDepositMult}x | Scan: ${PERSONALITY.scanIntervalMins}min | Visit: ${PERSONALITY.idleVisitChancePct}%`);

        // Inject "Repair All" button on the cars page — sits after the Sell button
        if (isCarsPage() || hasCarsPageMarkers()) {
            const repairBtn = document.querySelector('form input[type="submit"][name="repair"][value="Repair"]');
            if (repairBtn && !document.querySelector('#ug-bot-repair-all-btn')) {
                const repairAllBtn = document.createElement('input');
                repairAllBtn.type  = 'button';
                repairAllBtn.value = 'Repair All';
                repairAllBtn.id    = 'ug-bot-repair-all-btn';
                repairAllBtn.setAttribute('data-role', 'none');
                repairAllBtn.style.cssText = 'margin-left:4px;cursor:pointer;';

                repairAllBtn.addEventListener('click', async () => {
                    if (repairAllBtn.disabled) return;
                    repairAllBtn.disabled = true;
                    repairAllBtn.value    = 'Repairing...';

                    const delay = ms => new Promise(r => setTimeout(r, ms));
                    let totalRepaired = 0;

                    try {
                        // Read total pages from current page DOM first
                        const pageMatch = document.body.innerHTML.match(/Page <u>1<\/u> of <u>([\d,]+)<\/u>/);
                        const totalPages = pageMatch ? parseInt(pageMatch[1].replace(/,/g, '')) : 1;
                        addLiveLog(`Repair All: ${totalPages} page(s) to process`);

                        for (let page = 1; page <= totalPages; page++) {
                            repairAllBtn.value = `Repairing... (${page}/${totalPages})`;

                            const resp = await fetch(`/?p=cars&page=${page}`, { credentials: 'include' });
                            const text = await resp.text();
                            const doc  = new DOMParser().parseFromString(text, 'text/html');

                            const checkboxes = [...doc.querySelectorAll('input[type="checkbox"][name="id[]"]')];
                            if (!checkboxes.length) continue;

                            const body = checkboxes.map(cb => `id[]=${cb.value}`).join('&') + '&repair=Repair';
                            await fetch(`/?p=cars&page=${page}`, {
                                method: 'POST',
                                credentials: 'include',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body
                            });

                            totalRepaired += checkboxes.length;
                            if (page < totalPages) await delay(300);
                        }

                        addLiveLog(`Repair All: done — repaired ${totalRepaired} car(s)`);
                    } catch (e) {
                        addLiveLog(`Repair All: error — ${e.message}`);
                    }

                    repairAllBtn.value    = 'Repair All';
                    repairAllBtn.disabled = false;
                });

                // Find the tac mb container and append a new inline button div to it
                const wrapper = document.createElement('div');
                wrapper.className = 'i in';
                wrapper.appendChild(repairAllBtn);
                const container = repairBtn.closest('.tac.mb');
                if (container) container.appendChild(wrapper);
            }
        }

        // Inject per-table Select All buttons on the perks page
        if (document.querySelectorAll('.sortable-table').length > 0) {
            document.querySelectorAll('.sortable-table').forEach(table => {
                const rows = table.querySelectorAll('tr');
                const headerRow = rows[1]; // second row is "Perk / For Sale / Expires / Select"
                if (!headerRow) return;
                const lastTh = headerRow.querySelector('td:last-child, th:last-child');
                if (!lastTh) return;
                const link = document.createElement('a');
                link.href = 'javascript:void(0)';
                link.className = 'myc';
                link.style.marginLeft = '4px';
                link.textContent = '(Select All)';
                link.addEventListener('click', () => {
                    const boxes = table.querySelectorAll('.perk-select-check');
                    const allChecked = [...boxes].every(cb => cb.checked);
                    boxes.forEach(cb => {
                        cb.checked = !allChecked;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                });
                lastTh.appendChild(link);
            });
        }
    }

    init();

    }); // end window.onload
})();
