// ==UserScript==
// @name         UG Crimes + GTA + Melt Helper v6.3.44
// @namespace    ug-bot
// @version      1.1.4
// @description  Auto-runs crimes, GTA, melting, repair, missions, drug running with Swiss Bank management, live log, session stats, action checkboxes, jail handling, runtime tracking, melt pagination, repair cycles, automatic CTC solving, and point-spending features.
// @match        *://www.underworldgangsters.com/*
// @match        *://underworldgangsters.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/ssdddssdfswee/ugbot/main/ug-bot.user.js
// @downloadURL  https://raw.githubusercontent.com/ssdddssdfswee/ugbot/main/ug-bot.user.js
// ==/UserScript==

(function () {
    'use strict';

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
        const SIMILARITY_FLOOR  = 0.75;
        const SCORE_GAP_FLOOR   = 0.05;
        const SOLVE_TIMEOUT_MS  = 8000;
        const NORM_SIZE         = 96;
        const COLOR_THRESHOLD   = 40;
        const SETTLE_DELAY_MS   = 300;
        const BLANK_THRESHOLD   = 0.01;

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

        function cropToContentCanvas(canvas) {
            const ctx = canvas.getContext('2d');
            const { width, height } = canvas;
            const { data } = ctx.getImageData(0, 0, width, height);

            let minX = width;
            let minY = height;
            let maxX = -1;
            let maxY = -1;

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i     = (y * width + x) * 4;
                    const value = Math.max(data[i], data[i + 1], data[i + 2]);

                    if (value > COLOR_THRESHOLD) {
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            if (maxX < minX || maxY < minY) return null;

            const pad = 2;
            minX = Math.max(0, minX - pad);
            minY = Math.max(0, minY - pad);
            maxX = Math.min(width - 1, maxX + pad);
            maxY = Math.min(height - 1, maxY + pad);

            const cropW = maxX - minX + 1;
            const cropH = maxY - minY + 1;

            const out = document.createElement('canvas');
            out.width  = cropW;
            out.height = cropH;

            out.getContext('2d').drawImage(
                canvas,
                minX, minY, cropW, cropH,
                0, 0, cropW, cropH
            );

            return out;
        }

        function toFingerprint(canvas) {
            const cropped = cropToContentCanvas(canvas);
            if (!cropped) return null;

            const out = document.createElement('canvas');
            out.width  = NORM_SIZE;
            out.height = NORM_SIZE;

            const ctx = out.getContext('2d');
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, NORM_SIZE, NORM_SIZE);

            const scale = Math.min(
                NORM_SIZE / cropped.width,
                NORM_SIZE / cropped.height
            );

            const drawW = Math.max(1, Math.round(cropped.width  * scale));
            const drawH = Math.max(1, Math.round(cropped.height * scale));
            const offX  = Math.floor((NORM_SIZE - drawW) / 2);
            const offY  = Math.floor((NORM_SIZE - drawH) / 2);

            ctx.drawImage(cropped, offX, offY, drawW, drawH);

            const { data } = ctx.getImageData(0, 0, NORM_SIZE, NORM_SIZE);
            const bits = new Uint8Array(NORM_SIZE * NORM_SIZE);

            for (let i = 0, p = 0; i < data.length; i += 4, p++) {
                bits[p] = Math.max(data[i], data[i + 1], data[i + 2]) > COLOR_THRESHOLD ? 1 : 0;
            }

            return bits;
        }

        function isBlankFingerprint(bits) {
            if (!bits) return true;

            let litPixels = 0;
            for (let i = 0; i < bits.length; i++) {
                if (bits[i] === 1) litPixels++;
            }

            return litPixels / bits.length < BLANK_THRESHOLD;
        }

        function pixelSimilarity(bitsA, bitsB) {
            let matches = 0;
            for (let i = 0; i < bitsA.length; i++) {
                if (bitsA[i] === bitsB[i]) matches++;
            }
            return matches / bitsA.length;
        }

        // Returns the CTC container element if visible, null otherwise.
        // The CTC appears in two different locations depending on the page:
        //   - Most pages: #ctcbox (a dedicated div, hidden by default via display:none)
        //   - GTA page:   td.veg.lettuce.centd (always visible when present, no hiding)
        function getCTCContainer() {
            // Check standard ctcbox first
            const box = document.getElementById('ctcbox');
            if (box) {
                const style = window.getComputedStyle(box);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const rect = box.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return box;
                }
            }

            // Check GTA page variant — td with classes veg, lettuce, centd
            // Only treat it as a CTC if it contains the CTC image sources
            const gtaTd = document.querySelector('td.veg.lettuce.centd');
            if (gtaTd) {
                const hasRefImg    = !!gtaTd.querySelector('img[src*="text.php"]');
                const hasChoices   = gtaTd.querySelectorAll('input[type="image"]').length === 4;
                const hasInstruct  = /match the 3 letters/i.test(gtaTd.textContent || '');
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

        async function doSolve(widget, logFn, solveCtx = { cancelled: false }) {
            const { refImg, choiceInputs } = widget;

            if (solveCtx.cancelled) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC solve cancelled' };
            }

            const refElement = await resolveImage(refImg);

            if (solveCtx.cancelled || !isVisible()) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC no longer active — aborted' };
            }

            const refBits = toFingerprint(imageToCanvas(refElement));

            if (!refBits || isBlankFingerprint(refBits)) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC reference image appears blank — aborting, will retry' };
            }

            const results = [];

            for (let i = 0; i < choiceInputs.length; i++) {
                if (solveCtx.cancelled || !isVisible()) {
                    return { solved: false, choice: null, similarity: 0, message: 'CTC no longer active — aborted' };
                }

                const img  = await resolveImage(choiceInputs[i]);
                const bits = toFingerprint(imageToCanvas(img));

                if (!bits || isBlankFingerprint(bits)) {
                    logFn(`CTC choice ${i + 1}: appears blank — skipping`);
                    results.push({ index: i, similarity: -1, el: choiceInputs[i] });
                    continue;
                }

                const similarity = pixelSimilarity(refBits, bits);
                results.push({ index: i, similarity, el: choiceInputs[i] });
                logFn(`CTC choice ${i + 1}: ${(similarity * 100).toFixed(1)}% match`);
            }

            const validResults = results.filter(r => r.similarity >= 0);
            if (!validResults.length) {
                return { solved: false, choice: null, similarity: 0, message: 'CTC all choices appear blank — aborting, will retry' };
            }

            validResults.sort((a, b) => b.similarity - a.similarity);
            const winner   = validResults[0];
            const runnerUp = validResults[1] || null;

            if (winner.similarity < SIMILARITY_FLOOR) {
                return {
                    solved: false,
                    choice: winner.index + 1,
                    similarity: winner.similarity,
                    message: `CTC: best match ${(winner.similarity * 100).toFixed(1)}% below floor — skipping`
                };
            }

            if (runnerUp && (winner.similarity - runnerUp.similarity) < SCORE_GAP_FLOOR) {
                return {
                    solved: false,
                    choice: winner.index + 1,
                    similarity: winner.similarity,
                    message: `CTC: top two matches too close (${(winner.similarity * 100).toFixed(1)}% vs ${(runnerUp.similarity * 100).toFixed(1)}%) — skipping`
                };
            }

            if (solveCtx.cancelled || !isVisible() || !winner.el.isConnected) {
                return { solved: false, choice: winner.index + 1, similarity: winner.similarity, message: 'CTC no longer active before click — aborted' };
            }

            winner.el.click();

            return {
                solved: true,
                choice: winner.index + 1,
                similarity: winner.similarity,
                message: `CTC solved — clicked choice ${winner.index + 1} (${(winner.similarity * 100).toFixed(1)}% match)`
            };
        }

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
                        solved: false,
                        choice: null,
                        similarity: 0,
                        message: 'CTC solver timed out'
                    });
                }, SOLVE_TIMEOUT_MS)
            );

            try {
                const result = await Promise.race([doSolve(widget, logFn, solveCtx), timeout]);
                logFn(result.message);
                return { attempted: true, solved: result.solved, message: result.message };
            } catch (err) {
                const message = 'CTC solver error: ' + err.message;
                logFn(message);
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
                if (box) {
                    observeBox(box);
                    return;
                }

                // Also check for the GTA page CTC variant which is not a #ctcbox
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
                    // Check for GTA page variant appearing via AJAX
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

    const SCRIPT_VERSION = '1.1.4';

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

    // =========================================================================
    // KILL SCANNER CONSTANTS
    // =========================================================================

    const KILL_SCANNER_SEARCH_HOURS  = 24;   // Always search for 24 hours
    const KILL_SCANNER_RESCAN_MS     = 23 * 60 * 60 * 1000; // Re-search alive players after 23hrs (1hr buffer before 24hr expiry)
    const KILL_SCANNER_PROTECTED_RESCAN_MS = 60 * 60 * 1000; // Re-check protected players every 1hr (failsafe)

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

        actionDelayMin: 450,
        actionDelayMax: 1100,

        burstDelayMin: 180,
        burstDelayMax: 420,
        maxBurstActions: 4,

        navDelayMin: 700,
        navDelayMax: 1500,

        heartbeatMs: 1200,

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

        // Timer reset settings — mutually exclusive (including bust)
        resetCrimesEnabled:  false,
        resetCrimesFastMode: false,
        resetGTAEnabled:     false,
        resetMeltEnabled:    false,
        resetTimerMinPoints: 200,

        // Bust settings
        bustEnabled:  false,
        bustFastMode: false,

        // Kill scanner settings
        killScanOnlineEnabled:  false,
        killScanOnlineInterval: 10,   // minutes between Players Online checks
        killSearchEnabled:      false,

        maxLiveLogEntries: 80
    };

    const SAFETY = {
        sameCrimeMinGapMs:      3500,
        postClickSettleMs:      2200,
        postClickPollMs:        150,
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

        get bustEnabled()          { return !!getSetting('bustEnabled', DEFAULTS.bustEnabled); },
        set bustEnabled(v)         { setSetting('bustEnabled', !!v); },

        get bustFastMode()         { return !!getSetting('bustFastMode', DEFAULTS.bustFastMode); },
        set bustFastMode(v)        { setSetting('bustFastMode', !!v); },

        get bustLoopActive()       { return !!getSetting('bustLoopActive', false); },
        set bustLoopActive(v)      { setSetting('bustLoopActive', !!v); },

        // Kill scanner
        get killScanOnlineEnabled()   { return !!getSetting('killScanOnlineEnabled', DEFAULTS.killScanOnlineEnabled); },
        set killScanOnlineEnabled(v)  { setSetting('killScanOnlineEnabled', !!v); },

        get killScanOnlineInterval()  { return Number(getSetting('killScanOnlineInterval', DEFAULTS.killScanOnlineInterval)); },
        set killScanOnlineInterval(v) { setSetting('killScanOnlineInterval', Number(v)); },

        get killSearchEnabled()       { return !!getSetting('killSearchEnabled', DEFAULTS.killSearchEnabled); },
        set killSearchEnabled(v)      { setSetting('killSearchEnabled', !!v); },

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

        // Username currently being searched (persists across page reload)
        get killCurrentSearch()       { return getSetting('killCurrentSearch', ''); },
        set killCurrentSearch(v)      { setSetting('killCurrentSearch', String(v || '')); },

        // Cached drug capacity — set on each drugs page visit so crimes page can use it
        get drugCapacityCache()    { return Number(getSetting('drugCapacityCache', 0)); },
        set drugCapacityCache(v)   { setSetting('drugCapacityCache', Math.max(0, Number(v) || 0)); },

        // Pending bank action — survives page reload so the bank page handler knows what to do
        get pendingBankAction()    { return getSetting('pendingBankAction', null); },
        set pendingBankAction(v)   { setSetting('pendingBankAction', v); },

        get nextDriveReadyAt()     { return Number(getSetting('nextDriveReadyAt', 0)); },
        set nextDriveReadyAt(v)    { setSetting('nextDriveReadyAt', Number(v)); },

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

        get stats() {
            return getSetting('stats', {
                crimes: 0,
                gtas: 0,
                melts: 0,
                bulletsReceived: 0,
                repairs: 0,
                deposits: 0,
                jails: 0,
                jailEscapes: 0,
                ctcSolved: 0,
                ctcFailed: 0,
                missionsAccepted: 0,
                missionsDeclined: 0,
                missionCarsUsed: 0,
                drugRuns: 0,
                drugRepairs: 0,
                swissDeposits: 0,
                swissWithdrawals: 0,
                crimeResets: 0,
                gtaResets: 0,
                meltResets: 0,
                bustsSuccess: 0,
                bustsFailed: 0,
                pageLoads: 0,
                lastActionText: 'None'
            });
        },
        set stats(v) { setSetting('stats', v); },

        get liveLog()  { return getSetting('liveLog', []); },
        set liveLog(v) { setSetting('liveLog', v); }
    };

    // -------------------------------------------------------------------------
    // In-memory flags — not persisted, reset fresh on each page load
    // -------------------------------------------------------------------------

    // Prevents crime timer reset being clicked more than once per crimes page visit.
    // Cleared each time handleCrimesPage() is entered.
    let crimeResetUsedThisVisit = false;

    // Prevents the bust success/failure message being logged repeatedly on
    // every heartbeat tick — only logs once per page load.
    let bustResultHandledThisLoad = false;

    // Prevents the kill search result being logged repeatedly per page load.
    let killSearchResultHandledThisLoad = false;

    let loopBusy         = false;
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
    let lastRenderedStatsJson = '';

    let toggleBtn                   = null;
    let autoDepositInput            = null;
    let depositThresholdEl          = null;
    let autoRepairInput             = null;
    let repairEveryEl               = null;
    let autoMissionsInput           = null;
    let autoGiveCarsInput           = null;
    let autoDrugsInput              = null;
    let drugDepositMultiplierEl     = null;
    let leaveJailInput              = null;
    let leaveJailMinPointsEl        = null;
    let resetCrimesInput            = null;
    let resetCrimesFastModeInput    = null;
    let bustEnabledInput            = null;
    let bustFastModeInput           = null;
    let killScanOnlineInput         = null;
    let killScanIntervalEl          = null;
    let killSearchInput             = null;
    let resetGTAInput               = null;
    let resetMeltInput              = null;
    let resetTimerMinPointsEl       = null;
    let statsEl                     = null;
    let logEl                       = null;
    let compactBtn                  = null;
    let hideBtn                     = null;
    let closeBtn                    = null;

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

    function updateStats(mutator) {
        const s = { ...state.stats };
        mutator(s);
        state.stats = s;
        renderStats();
    }

    function setLastActionText(text) {
        updateStats(s => { s.lastActionText = text; });
    }

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
        state.stats = {
            crimes: 0,
            gtas: 0,
            melts: 0,
            bulletsReceived: 0,
            repairs: 0,
            deposits: 0,
            jails: 0,
            jailEscapes: 0,
            ctcSolved: 0,
            ctcFailed: 0,
            missionsAccepted: 0,
            missionsDeclined: 0,
            missionCarsUsed: 0,
            drugRuns: 0,
            drugRepairs: 0,
            swissDeposits: 0,
            swissWithdrawals: 0,
            crimeResets: 0,
            gtaResets: 0,
            meltResets: 0,
            bustsSuccess: 0,
            bustsFailed: 0,
            pageLoads: 0,
            lastActionText: 'None'
        };
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
        state.bustLoopActive      = false;
        state.killSearchLoopActive = false;
        state.killSearchIndex      = 0;
        state.killCurrentSearch    = '';
        clearPendingMeltResult();
        renderStats();
        renderLiveLog();
        addLiveLog('Session stats reset');
    }

    function rand(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
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
        clearScheduledReload();
        state.gtaResetLoopActive   = false;
        state.meltResetLoopActive  = false;
        state.bustLoopActive       = false;
        state.killSearchLoopActive = false;
        state.killCurrentSearch    = '';
        updatePanel();
        addLiveLog(`Paused: ${reason}`);
    }

    function hasCTCChallenge() {
        return CTC.isVisible();
    }

    function gotoPage(pageName, extraParams = {}) {
        clearScheduledReload();
        const url = new URL(window.location.href);
        url.searchParams.set('p', pageName);
        url.searchParams.delete('a'); // Never carry over the action/type param between pages

        for (const [key, value] of Object.entries(extraParams)) {
            if (value == null || value === '') {
                url.searchParams.delete(key);
            } else {
                url.searchParams.set(key, String(value));
            }
        }

        addLiveLog(`Navigating to ${pageName}${extraParams.page ? ' page ' + extraParams.page : ''}`);
        window.location.href = url.toString();
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
        return Number(clean.replace(/[^0-9.]/g, '')) || 0;
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
    function getPlayerSwiss()    { return parseMoney(document.querySelector('#player-swiss')?.textContent    || '0'); }
    function getPlayerLocation() { return (document.querySelector('#player-location')?.textContent || '').trim(); }

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
        if (!isCrimesPage())           return false;

        const money     = getPlayerMoney();
        const threshold = state.autoDepositThreshold;
        const btn       = getQuickDepositButton();

        if (!btn)              return false;
        if (money < threshold) return false;

        state.lastActionAt = Date.now();

        await wait(rand(400, 900));
        btn.click();

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

    const RANKS = [
        'Civilian', 'Vandal', 'Hustler', 'Riff-Raff', 'Ruffian',
        'Homeboy', 'Homie', 'Criminal', 'Hitman', 'Trusted Hitman',
        'Assassin', 'Trusted Assassin', 'Gangster', 'Original Gangster',
        'Boss', 'Regional Boss', 'Global Boss', 'Don', 'Regional Don',
        'Global Don', 'Godfather', 'Regional Godfather', 'Global Godfather'
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
            if (!isInternalGTAReady()) state.nextGTAReadyAt = now();
            return true;
        }

        if (gtaInfo.ms != null && gtaInfo.ms > 0) {
            const newReadyAt = now() + gtaInfo.ms;
            if (newReadyAt > state.nextGTAReadyAt || isInternalGTAReady()) {
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
            if (newReadyAt > state.nextMeltReadyAt || isInternalMeltReady()) {
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

        freshBtn.click();
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

        freshBtn.click();

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

        freshBtn.click();

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
        freshAction.click();
        return true;
    }

    function shouldDoSwissDeposit() {
        if (!isDrugsEnabled()) return false;

        const capacity = state.drugCapacityCache;
        if (capacity <= 0) return false;

        const cash       = getPlayerMoney();
        const reserve    = calcDrugReserve(capacity);
        const multiplier = state.drugDepositMultiplier;
        const trigger    = reserve * multiplier;

        return cash > trigger;
    }

    function calcSwissDepositAmount() {
        const capacity = state.drugCapacityCache;
        const cash     = getPlayerMoney();
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (pending.type === 'withdraw' && hasBankWithdrawSuccess()) {
            addLiveLog(`Swiss Bank: withdrew $${pending.amount.toLocaleString()} successfully`);
            updateStats(s => {
                s.swissWithdrawals += 1;
                s.lastActionText    = `Swiss withdrew $${pending.amount.toLocaleString()}`;
            });
            state.pendingBankAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('drugs');
            return;
        }

        if (pending.type === 'deposit' && hasBankDepositSuccess()) {
            addLiveLog(`Swiss Bank: deposited $${pending.amount.toLocaleString()} successfully`);
            updateStats(s => {
                s.swissDeposits  += 1;
                s.lastActionText  = `Swiss deposited $${pending.amount.toLocaleString()}`;
            });
            state.pendingBankAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        addLiveLog(`Swiss Bank: submitting ${pending.type} of $${pending.amount.toLocaleString()}`);
        const submitted = await submitSwissBankAction(pending.amount, pending.type === 'deposit');

        if (!submitted) {
            addLiveLog('Swiss Bank: submission failed — clearing pending action, returning to crimes');
            state.pendingBankAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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

        freshSell.click();
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
        freshBuy.click();

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
        freshGo.click();

        // Set a pessimistic placeholder so the bot doesn't think drive is ready
        // immediately on the next page load. The tick sync will correct this.
        state.nextDriveReadyAt = now() + 120000;

        addLiveLog(`Drug run: driving to ${destinationName}`);
        return true;
    }

    async function handleDrugsPage() {
        stopJailObserver();

        if (!isDrugsEnabled()) {
            addLiveLog('Drug running disabled — returning to crimes');
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (hasCTCChallenge()) {
            setLastActionText('CTC solving…');
            await maybeSolveCTC();
            return;
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (isDrugCarTooDamaged()) {
            const carLink = getDrugCarLink();
            if (!carLink) {
                addLiveLog('Drug run: car too damaged but no car link found — returning to crimes');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
                return;
            }
            addLiveLog('Drug run: car too damaged — navigating to car page to repair');
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            window.location.href = new URL(carLink.getAttribute('href'), window.location.href).toString();
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
            setLastActionText(`Drug run: drive in ${remaining}s`);
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (country.toUpperCase() === DRUG_RUN_ROUTE.countryA.toUpperCase()) {

            if (available <= 0) {
                addLiveLog('Drug run: fully loaded in USA — driving to England');

            } else if (capacity <= 0) {
                addLiveLog('Drug run: capacity unknown — returning to crimes to wait for next visit');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
                return;

            } else if (cash < reserve) {
                const swiss     = getPlayerSwiss();
                const shortfall = reserve - cash;

                if (swiss >= shortfall) {
                    addLiveLog(`Drug run: insufficient cash ($${cash.toLocaleString()}) — withdrawing $${shortfall.toLocaleString()} from Swiss Bank`);
                    state.pendingBankAction = { type: 'withdraw', amount: shortfall };
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('bank');
                    return;
                } else {
                    addLiveLog(`Drug run: insufficient funds — cash $${cash.toLocaleString()}, Swiss $${swiss.toLocaleString()}, need $${reserve.toLocaleString()} — skipping this run`);
                    setLastActionText('Drug run: insufficient funds — skipped');
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('crimes');
                    return;
                }

            } else if (drugToBuy && available > 0) {
                addLiveLog(`Drug run: buying ${available} units of ${drugToBuy.name} in ${country}`);
                const didBuy = await buyDrugs(drugToBuy, available);
                if (!didBuy) {
                    addLiveLog('Drug run: buy failed — returning to crimes');
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('bank');
                    return;
                } else {
                    addLiveLog(`Drug run: insufficient funds — cash $${cash.toLocaleString()}, Swiss $${swiss.toLocaleString()}, need $${reserve.toLocaleString()} for Heroin reserve — skipping this run`);
                    setLastActionText('Drug run: insufficient funds — skipped');
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('crimes');
                    return;
                }
            }

            addLiveLog(`Drug run: buying ${available} units of ${drugToBuy.name} in ${country}`);
            const didBuy = await buyDrugs(drugToBuy, available);
            if (!didBuy) {
                addLiveLog('Drug run: buy failed — returning to crimes');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
            }
            return;
        }

        if (destValue && destName) {
            const didDrive = await driveToDestination(destValue, destName);
            if (!didDrive) {
                addLiveLog('Drug run: drive failed — returning to crimes');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
            }
            return;
        }

        addLiveLog(`Drug run: in unrecognised country "${country}" — driving to ${DRUG_RUN_ROUTE.countryA} to start route`);
        const didDriveToStart = await driveToDestination(DRUG_RUN_ROUTE.countryALocation, DRUG_RUN_ROUTE.countryA);
        if (!didDriveToStart) {
            addLiveLog('Drug run: could not drive to route start — returning to crimes');
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
        }
    }

    async function handleCarPage() {
        stopJailObserver();

        if (!isDrugsEnabled()) {
            addLiveLog('Car page: drug running off — returning to crimes');
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (hasCarRepairConfirmation()) {
            addLiveLog('Drug run: car repaired successfully — returning to drugs');
            updateStats(s => {
                s.drugRepairs   += 1;
                s.lastActionText = 'Drug run: car repaired';
            });
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('drugs');
            return;
        }

        if (isCarPageCarDamaged()) {
            const repairBtn = getCarPageRepairButton();
            if (!repairBtn) {
                addLiveLog('Drug run: car damaged but no repair button — returning to crimes');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
                return;
            }

            state.lastActionAt = now();
            await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

            const freshRepair = getCarPageRepairButton();
            if (!freshRepair) return;

            freshRepair.click();
            addLiveLog('Drug run: repair button clicked');
            return;
        }

        addLiveLog('Car page: car not damaged — returning to drugs');
        await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
        gotoPage('drugs');
    }


    // =========================================================================
    // KILL SCANNER
    // =========================================================================

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
    // Returns the next player to search based on priority:
    // 1. Unknown — search immediately
    // 2. Protected — always search whenever the loop runs for any reason
    // 3. Alive with 3hrs or less remaining — re-search to keep active
    // 4. Protected standalone 1hr failsafe — handled by #2 above since
    //    protected players are always priority when the loop activates
    // 5. Unkillable — never search
    function getNextKillTarget() {
        const players = getKillPlayers();
        if (!players.length) return null;

        const nowMs = now();

        // Priority 1: Unknown players — search immediately
        const unknown = players.find(p => p.status === KILL_STATUS.UNKNOWN);
        if (unknown) return unknown;

        // Priority 2: Protected players — search all of them whenever the loop
        // runs. To cycle through all protected players rather than repeatedly
        // searching the same one, skip any searched in the last 5 minutes.
        // This allows the bot to work through the full list in one run.
        const RECENTLY_SEARCHED_MS = 5 * 60 * 1000; // 5 minutes
        const nextProtected = players.find(p =>
            p.status === KILL_STATUS.PROTECTED &&
            (nowMs - (p.lastChecked || 0)) >= RECENTLY_SEARCHED_MS
        );
        if (nextProtected) return nextProtected;

        // Priority 3: Alive players with 3hrs or less remaining — re-search
        // to keep their location permanently active with no gap.
        const RESCAN_BUFFER_MS = 3 * 60 * 60 * 1000; // 3hr buffer before expiry
        const expiredAlive = players.find(p => {
            if (p.status !== KILL_STATUS.ALIVE) return false;
            if (p.searchExpiresAt) return (p.searchExpiresAt - nowMs) < RESCAN_BUFFER_MS;
            return (nowMs - p.lastChecked) >= KILL_SCANNER_RESCAN_MS;
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
        } else {
            players[idx].status      = status;
            players[idx].lastChecked = now();
            players[idx].searchCount = (players[idx].searchCount || 0) + 1;
            // Clear stored expiry when status changes — syncKillExpiryFromPage
            // will populate it accurately on the next kill page load
            if (status !== KILL_STATUS.ALIVE) {
                delete players[idx].searchExpiresAt;
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

    // Reads the "Players found" section on the kill page and:
    // 1. Updates each known player's stored expiry time with the accurate "Lost in X" value
    // 2. Adds any unknown players found there to the list as "alive" — this acts as a
    //    cross-device sync so switching devices populates the list from existing searches
    function syncKillExpiryFromPage() {
        const players = state.killPlayers || [];

        // "Players found" rows — each has a player link and a "Lost in" timer span
        const rows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs')];
        if (!rows.length) return;

        let updated = 0;
        let added   = 0;

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

            const idx = players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());

            if (idx === -1) {
                // Player not in list — add them as alive with accurate expiry.
                // This handles cross-device sync: existing searches on the kill page
                // populate the list automatically on a new device.
                players.push({
                    name,
                    status:         KILL_STATUS.ALIVE,
                    lastChecked:    now(),
                    firstSeen:      now(),
                    searchCount:    1,
                    searchExpiresAt: expiresAt
                });
                added++;
            } else {
                // Player already in list — update their expiry and mark as alive
                players[idx].searchExpiresAt = expiresAt;
                players[idx].status          = KILL_STATUS.ALIVE;
                updated++;
            }
        }

        if (updated > 0 || added > 0) {
            saveKillPlayers(players);
            if (added > 0) {
                addLiveLog(`Kill scanner: synced ${added} player(s) from Players found section`);
                renderKillList();
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        const names = scrapeOnlinePlayers();
        const added = mergeOnlinePlayers(names);
        state.killLastOnlineScan = now();

        addLiveLog(`Kill scanner: found ${names.length} online players, added ${added} new`);
        renderKillList();

        await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));

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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // Sync accurate expiry times from the "Players found" section on every
        // kill page load — this is more reliable than the 23hr fallback window.
        syncKillExpiryFromPage();

        if (hasCTCChallenge()) {
            setLastActionText('CTC solving…');
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
                    updateKillPlayerStatus(current, KILL_STATUS.DEAD);
                    addLiveLog(`Kill scanner: ${current} is dead — removed`);
                    state.killCurrentSearch = '';
                    renderKillList();
                } else if (hasKillUncillableMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.UNKILLABLE);
                    addLiveLog(`Kill scanner: ${current} cannot be killed — marked unkillable`);
                    state.killCurrentSearch = '';
                    renderKillList();
                } else if (hasKillSelfSearchMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.UNKILLABLE);
                    addLiveLog(`Kill scanner: ${current} is you — marked unkillable, will never search again`);
                    state.killCurrentSearch = '';
                    renderKillList();
                } else if (hasKillProtectedMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.PROTECTED);
                    addLiveLog(`Kill scanner: ${current} is protected`);
                    state.killCurrentSearch = '';
                    renderKillList();
                } else if (hasKillSearchStartedMessage()) {
                    killSearchResultHandledThisLoad = true;
                    updateKillPlayerStatus(current, KILL_STATUS.ALIVE);
                    addLiveLog(`Kill scanner: ${current} — search started`);
                    state.killCurrentSearch = '';
                    renderKillList();
                }
            }
        }

        // Find the next player to search
        const target = getNextKillTarget();

        if (!target) {
            // No targets right now — revert to normal script but keep the toggle ON.
            // The loop will restart automatically when:
            // - Toggle 1 adds new unknown players
            // - An alive player drops below 1hr remaining
            // - A protected player hits the 1hr failsafe
            addLiveLog('Kill scanner: no targets right now — reverting to normal script (toggle stays on)');
            state.killSearchLoopActive = false;
            // killSearchEnabled stays true — init() will re-activate the loop
            // on the next page load when getNextKillTarget() finds a target
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // Submit search for next target
        const usernameInput = getKillSearchUsernameInput();
        const hoursInput    = getKillSearchHoursInput();
        const searchBtn     = getKillSearchButton();

        if (!usernameInput || !searchBtn) {
            addLiveLog('Kill scanner: search form not found — retrying next tick');
            return;
        }

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshUsernameInput = getKillSearchUsernameInput();
        const freshHoursInput    = getKillSearchHoursInput();
        const freshSearchBtn     = getKillSearchButton();

        if (!freshUsernameInput || !freshSearchBtn) return;

        freshUsernameInput.value = target.name;
        if (freshHoursInput) freshHoursInput.value = String(KILL_SCANNER_SEARCH_HOURS);

        state.killCurrentSearch = target.name;
        addLiveLog(`Kill scanner: searching ${target.name} (status: ${target.status})`);

        freshSearchBtn.click();
        // Page reloads — result handled on next load
    }

    // -------------------------------------------------------------------------
    // Render the kill player list in the UI
    // -------------------------------------------------------------------------

    function renderKillList() {
        const el = document.querySelector('#ug-bot-kill-list');
        if (!el) return;

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

        for (const [, group] of Object.entries(groups)) {
            if (!group.players.length) continue;

            html += `<div class="ug-kill-group-title">${escapeHtml(group.label)} (${group.players.length})</div>`;

            for (const p of group.players) {
                let meta = '';
                if (p.status === KILL_STATUS.ALIVE && p.searchExpiresAt) {
                    const remaining = p.searchExpiresAt - now();
                    if (remaining > 3600000) {
                        // More than 1hr left — show time remaining
                        const hrs  = Math.floor(remaining / 3600000);
                        const mins = Math.floor((remaining % 3600000) / 60000);
                        meta = `${hrs}h ${mins}m left`;
                    } else if (remaining > 0) {
                        // Less than 1hr — bot should be re-searching soon
                        const mins = Math.floor(remaining / 60000);
                        meta = `renewing (${mins}m left)`;
                    } else {
                        meta = 'expired — re-searching';
                    }
                } else if (p.lastChecked) {
                    meta = formatTimeSince(p.lastChecked);
                } else {
                    meta = 'never';
                }
                html += `<div class="ug-kill-entry">
                    <span class="ug-kill-name" style="color:${group.colour};">${escapeHtml(p.name)}</span>
                    <span class="ug-kill-meta">${escapeHtml(meta)}</span>
                </div>`;
            }
        }

        el.innerHTML = html;
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

    function hasBustPageMarkers() {
        return currentPage() === 'jail' || !!document.querySelector('#jailn');
    }

    function isBustJailEmpty() {
        return /the jail is empty!/i.test(textOf(document.querySelector('#jailn')));
    }

    function hasBustSuccess() {
        return [...document.querySelectorAll('.bgm.cg')].some(el =>
            /you helped .+ out of jail/i.test(textOf(el))
        );
    }

    function hasBustFailure() {
        return [...document.querySelectorAll('.bgm.cred')].some(el =>
            /you failed helping .+ out of jail/i.test(textOf(el))
        );
    }

    // Returns all bustable prisoner rows sorted by lowest time remaining first.
    // Excludes our own row (which has the Leave Jail button instead of Bust).
    function getBustCandidates() {
        const rows = [...document.querySelectorAll('#jailn tr')];
        const candidates = [];

        for (const row of rows) {
            const bustBtn = row.querySelector('input[type="submit"][value="Bust"]');
            if (!bustBtn) continue; // skip our own row and header rows

            const cells    = row.querySelectorAll('td');
            if (cells.length < 2) continue;

            const timerText = textOf(cells[1]);

            // Parse seconds from "X seconds" text
            let seconds = Infinity;
            const secMatch = timerText.match(/(\d+)\s*seconds?/i);
            if (secMatch) seconds = parseInt(secMatch[1], 10);

            // Also handle "X minutes Y seconds" or "X minutes"
            const minMatch = timerText.match(/(\d+)\s*minutes?/i);
            if (minMatch) seconds = parseInt(minMatch[1], 10) * 60 + (secMatch ? parseInt(secMatch[1], 10) : 0);

            candidates.push({ row, bustBtn, seconds, timerText });
        }

        // Sort by lowest time remaining first (easiest to bust)
        candidates.sort((a, b) => a.seconds - b.seconds);
        return candidates;
    }

    async function doBust(fastMode = false) {
        const candidates = getBustCandidates();
        if (!candidates.length) return false;

        const target = candidates[0];

        state.lastActionAt = now();

        if (fastMode) {
            await wait(rand(60, 120));
        } else {
            await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
        }

        // Re-fetch the button in case the DOM updated
        const freshCandidates = getBustCandidates();
        if (!freshCandidates.length) return false;

        const freshTarget = freshCandidates[0];
        freshTarget.bustBtn.click();

        addLiveLog(`Bust attempted: ${textOf(freshTarget.row.querySelector('a'))} (${freshTarget.timerText})`);
        return true;
    }

    async function handleBustPage() {
        stopJailObserver();

        if (!state.bustEnabled) {
            addLiveLog('Bust disabled — returning to crimes');
            state.bustLoopActive = false;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // Handle CTC first
        if (hasCTCChallenge()) {
            setLastActionText('CTC solving…');
            await maybeSolveCTC();
            return;
        }

        // Check if we got jailed from a failed bust
        const ownRow = getOwnJailRow();
        if (ownRow) {
            addLiveLog('Jailed after failed bust');
            updateStats(s => { s.jails += 1; });
            if (state.leaveJailEnabled) {
                const didLeave = await tryLeaveJail();
                if (didLeave) {
                    addLiveLog('Left jail — returning to bust');
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('jail');
                    return;
                }
            }
            // Wait in jail — jail observer will handle returning to jail page
            startJailObserver();
            jailPassiveMode = true;
            jailHadOwnRow   = true;
            const jailMs = getOwnJailTimerMs();
            setLastActionText(jailMs != null ? `Busting: in jail (${Math.ceil(jailMs / 1000)}s)` : 'Busting: in jail');
            return;
        }

        // Log result of previous bust attempt — only once per page load
        if (!bustResultHandledThisLoad) {
            if (hasBustSuccess()) {
                bustResultHandledThisLoad = true;
                updateStats(s => { s.bustsSuccess += 1; s.lastActionText = 'Bust: success'; });
                addLiveLog('Bust successful');
            } else if (hasBustFailure()) {
                bustResultHandledThisLoad = true;
                updateStats(s => { s.bustsFailed += 1; s.lastActionText = 'Bust: failed'; });
                addLiveLog('Bust failed');
            }
        }

        // If jail is empty, just wait — the game's AJAX refreshes #jailn every 3s
        if (isBustJailEmpty()) {
            setLastActionText('Busting: jail empty — waiting');
            return;
        }

        // Bust the lowest-timer prisoner
        const didBust = await doBust(state.bustFastMode);
        if (!didBust) {
            setLastActionText('Busting: no targets');
        }
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

        while (now() - start < SAFETY.postClickSettleMs) {
            if (!isRunValid(token)) return 'cancelled';
            if (isLikelyJailPage()) return 'jail';
            if (hasCTCChallenge())  return 'ctc';

            const currentState = getCrimeState(id);
            if (initialState === 'available' && currentState !== 'available') return 'changed';
            if (!isCrimesPage() && !hasCrimePageMarkers()) return 'changed';

            await wait(SAFETY.postClickPollMs);
        }

        return 'timeout';
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
            freshBtn.click();

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
                updateStats(s => { s.lastActionText = 'CTC solving…'; });
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
                updateStats(s => { s.lastActionText = 'CTC solving…'; });
                break;
            }
            if (isLikelyJailPage()) {
                updateStats(s => { s.jails += 1; s.lastActionText = 'Jailed during fast burst'; });
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
                btn.click();
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
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshBtn = getGTAStealButton();
        if (!freshBtn || freshBtn.disabled) return false;

        freshBtn.click();
        markGTACooldownStarted();

        updateStats(s => {
            s.gtas          += 1;
            s.lastActionText = 'GTA attempted';
        });
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
        freshSubmit.click();
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

        freshSelectAll.click();
        addLiveLog('Cars: Select All clicked');

        await wait(SAFETY.repairAfterSelectAllMs);

        const checkedNow  = getCarsCheckboxes().filter(cb => cb.checked);
        const freshRepair = getCarsRepairButton();
        if (!freshRepair || !checkedNow.length) {
            addLiveLog('Repair cycle failed — no cars selected after Select All');
            return false;
        }

        state.lastActionAt = now();
        freshRepair.click();

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

        freshBtn.click();

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
        // Only match on structural page elements — the #jailn element is the
        // reliable indicator of the jail page. Body text checks were removed
        // because AJAX-loaded content (chat messages, crime results etc.) on
        // other pages can contain words like "leave jail" and cause false positives.
        if (currentPage() === 'jail') return true;
        if (document.querySelector('#jailn')) return true;
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
                setLastActionText(jailMs != null ? `In jail (${Math.ceil(jailMs / 1000)}s)` : 'In jail');
                return;
            }

            if (jailHadOwnRow || /the jail is empty!/i.test(jailText)) {
                stopJailObserver();
                clearScheduledReload();
                await wait(rand(500, 1200));
                // Return to the correct page based on which loop is active
                if (state.bustLoopActive) {
                    addLiveLog('Own jail row gone — returning to jail page (bust active)');
                    gotoPage('jail');
                } else if (state.gtaResetLoopActive) {
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

    async function handleJailState() {
        clearScheduledReload();
        jailPassiveMode = true;

        const jailNode = document.querySelector('#jailn');
        const ownRow   = getOwnJailRow();

        if (jailNode) startJailObserver();

        if (ownRow) {
            if (!jailHadOwnRow) addLiveLog('Confirmed own jail row');
            jailHadOwnRow = true;

            // If Leave Jail toggle is on and we have enough points, use it immediately
            if (state.leaveJailEnabled) {
                const didLeave = await tryLeaveJail();
                if (didLeave) {
                    stopJailObserver();
                    clearScheduledReload();
                    await wait(rand(800, 1500));
                    // Return to the correct page based on which loop is active
                    if (state.bustLoopActive) {
                        addLiveLog('Bust loop: returning to jail after leaving jail');
                        gotoPage('jail');
                    } else if (state.gtaResetLoopActive) {
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

            const jailMs = getOwnJailTimerMs();
            setLastActionText(jailMs != null ? `In jail (${Math.ceil(jailMs / 1000)}s)` : 'In jail');
            return;
        }

        stopJailObserver();
        clearScheduledReload();
        await wait(rand(500, 1200));
        // Return to the correct page based on which loop is active
        if (state.bustLoopActive) {
            addLiveLog('Not in jail — staying on jail page (bust active)');
            gotoPage('jail');
        } else if (state.gtaResetLoopActive) {
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

    // =========================================================================
    // CTC HANDLER
    // =========================================================================

    function handleCTCMessage(message) {
        addLiveLog(message);

        if (message.startsWith('CTC solved')) {
            updateStats(s => {
                s.ctcSolved     += 1;
                s.lastActionText = message;
            });
        } else if (
            message.includes('below floor') ||
            message.includes('timed out') ||
            message.includes('error') ||
            message.includes('too close')
        ) {
            updateStats(s => {
                s.ctcFailed     += 1;
                s.lastActionText = message;
            });
        } else if (
            message.includes('attempting auto-solve') ||
            message.includes('visible on load') ||
            message.includes('became visible')
        ) {
            setLastActionText('CTC solving…');
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

        freshBtn.click();
        return true;
    }

    async function clickMissionDecline() {
        const btn = getMissionDeclineButton();
        if (!btn || btn.disabled) return false;

        state.lastActionAt = now();
        await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

        const freshBtn = getMissionDeclineButton();
        if (!freshBtn || freshBtn.disabled) return false;

        freshBtn.click();
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
            selectAllLink.click();
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

                freshSubmit.click();
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

        freshSubmit.click();
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                window.location.href = new URL(hereLink.getAttribute('href'), window.location.href).toString();
                return true;
            }

            const hereLink = getMissionHereLink();
            if (!hereLink) {
                addLiveLog('Mission Here link not found — declining');
                const didDecline = await clickMissionDecline();
                if (didDecline) {
                    updateStats(s => {
                        s.missionsDeclined += 1;
                        s.lastActionText    = `Declined car mission: no Here link`;
                    });
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            window.location.href = new URL(hereLink.getAttribute('href'), window.location.href).toString();
            return true;
        }

        return false;
    }

    // =========================================================================
    // PAGE HANDLERS
    // =========================================================================

    async function handleCrimesPage() {
        stopJailObserver();
        resetMeltSearchState();
        clearPendingMeltResult();

        // Reset the crime reset flag each time we arrive at the crimes page fresh.
        // This allows a reset on the next visit if needed, while preventing a
        // double-reset within the same AJAX-based crimes page session.
        crimeResetUsedThisVisit = false;



        if (hasCTCChallenge()) {
            setLastActionText('CTC solving…');
            await maybeSolveCTC();
            return;
        }

        if (shouldRunRepairCycle()) {
            addLiveLog(`Repair threshold reached (${state.meltsSinceRepair}/${state.repairEveryMelts})`);
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
            setLastActionText('Crime reset mode — waiting');
            return;
        }

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
        const meltUsable  = isMeltEnabled() && !isMeltLocked();
        const drugsUsable = isDrugsEnabled();

        if (drugsUsable && isInternalDriveReady()) {
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('drugs');
            return;
        }

        if (gtaUsable && isInternalGTAReady()) {
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('gta');
            return;
        }

        if (meltUsable && isInternalMeltReady()) {
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
            setLastActionText(`Waiting for ${parts.join(' / ')}`);
            return;
        }

        setLastActionText('Waiting for actions');
    }

    async function handleGTAPage() {
        stopJailObserver();

        if (isGTALocked()) {
            addLiveLog('GTA is rank-locked — returning to crimes');
            state.gtaResetLoopActive = false;
            state.resetGTAEnabled    = false;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // Allow entry if GTA toggle is on OR if GTA reset loop is active
        if (!isGTAEnabled() && !state.gtaResetLoopActive) {
            addLiveLog('GTA disabled by user — returning to crimes');
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // CTC can appear on the GTA page after a reset — handle it before anything else.
        // Without this check the bot would see no Steal button and no reset button and
        // incorrectly treat it as a reset failure, exiting the loop.
        if (hasCTCChallenge()) {
            setLastActionText('CTC solving…');
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('gta');
                return;
            }
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
        await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (!isMeltEnabled() && !state.meltResetLoopActive) {
            addLiveLog('Melting disabled by user — returning to crimes');
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (hasCTCChallenge()) {
            setLastActionText('CTC solving…');
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

            addLiveLog(
                expectedBullets > 0 && expectedBullets !== confirmedBullets
                    ? `Melt success confirmed — ${meltLabel}, received ${confirmedBullets} bullets (expected ${expectedBullets})`
                    : `Melt success confirmed — ${meltLabel}, received ${confirmedBullets} bullets`
            );

            clearPendingMeltResult();
            resetMeltSearchState();

            // If we are in melt reset loop mode, handle repair then loop back
            if (state.meltResetLoopActive) {
                if (shouldRunRepairCycle()) {
                    addLiveLog(`Melt reset loop: repair threshold reached (${state.meltsSinceRepair}/${state.repairEveryMelts}) — going to cars`);
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('cars', { page: 1 });
                    return;
                }

                // Check points before committing to the next loop iteration
                if (getPlayerPoints() < state.resetTimerMinPoints) {
                    addLiveLog(`Melt reset loop: points dropped below threshold — exiting melt reset loop, reverting to normal`);
                    state.meltResetLoopActive = false;
                    state.resetMeltEnabled    = false;
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('crimes');
                    return;
                }

                addLiveLog('Melt reset loop: melt complete — going back to melt page');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoCleanMeltPage(1);
                return;
            }

            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
                return;
            }

            // Normal mode — paginate and retry as before
            if (state.meltRecoveryCount < 1) {
                state.meltRecoveryCount += 1;
                addLiveLog(`Melt page ${pagination.page} empty/incomplete — retrying once`);
                setLastActionText(`Melt page ${pagination.page} retrying`);
                await wait(rand(600, 1100));
                gotoCleanMeltPage(pagination.page);
                return;
            }

            if (pagination.hasNext) {
                resetMeltSearchState();
                addLiveLog(`Melt page ${pagination.page} still empty — checking page ${pagination.nextPage}`);
                setLastActionText(`Checking melt page ${pagination.nextPage}`);
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoCleanMeltPage(pagination.nextPage);
                return;
            }

            // No meltable cars across all pages and not in reset loop — return to crimes
            addLiveLog(`No meltable cars found — returning to crimes`);
            setLastActionText('No meltable cars');
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        const protectedOnly = candidates.length > 0 && !candidate;

        if (protectedOnly && pagination.hasNext) {
            resetMeltSearchState();
            addLiveLog(`No safe meltable cars on page ${pagination.page} — checking page ${pagination.nextPage}`);
            setLastActionText(`Checking melt page ${pagination.nextPage}`);
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoCleanMeltPage(pagination.nextPage);
            return;
        }

        if (protectedOnly) {
            // Only protected cars across all pages — exit melt reset loop
            addLiveLog('No safe meltable cars across checked pages — exiting melt reset loop, reverting to normal');
            setLastActionText('No safe melt target');
            state.meltResetLoopActive = false;
            state.resetMeltEnabled    = false;
            resetMeltSearchState();
            clearPendingMeltResult();
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // Normal cooldown handling — sync timer and return to crimes
        const synced = syncMeltReadyFromQuickLink();
        if (!synced) state.nextMeltReadyAt = now() + 15000;

        addLiveLog('Melt not ready yet — returning to crimes');
        resetMeltSearchState();
        clearPendingMeltResult();
        await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
        gotoPage('crimes');
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        if (!state.autoRepairEnabled) {
            addLiveLog('Auto repair disabled — returning to crimes');
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        const didRepair = await doRepairCycle();
        if (didRepair) {
            // If we came here from the melt reset loop, go back to melt
            if (state.meltResetLoopActive) {
                addLiveLog('Repair done — resuming melt reset loop');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoCleanMeltPage(1);
                return;
            }
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        addLiveLog('Repair cycle failed — returning to crimes');
        state.meltResetLoopActive = false;
        state.resetMeltEnabled    = false;
        await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
        gotoPage('crimes');
    }

    // =========================================================================
    // TICK / HEARTBEAT
    // =========================================================================

    async function tick() {
        if (!state.enabled || loopBusy || reloadPending) return;

        // ── Dedicated loop intercepts ─────────────────────────────────────────
        // When a reset loop is active the bot ignores all other page logic and
        // routes exclusively to the relevant page. Jail handling is still active
        // so the bot can leave jail and return to the loop immediately.

        // Kill search mode — dedicated loop, searches players one by one
        if (state.killSearchLoopActive) {
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
            // Navigate to kill page if not already there
            if (!isKillPage()) {
                addLiveLog('Kill search: navigating to kill page');
                gotoPage('kill');
                return;
            }
            loopBusy = true;
            try { updatePanel(); await handleKillPage(); } finally { loopBusy = false; }
            return;
        }

        // Bust mode — always route to jail page, bust continuously
        if (state.bustLoopActive) {
            if (hasCTCChallenge()) {
                loopBusy = true;
                try { updatePanel(); setLastActionText('CTC solving…'); await maybeSolveCTC(); } finally { loopBusy = false; }
                return;
            }
            // If jailed (from failed bust), handle jail
            if (isLikelyJailPage() && getOwnJailRow()) {
                loopBusy = true;
                try { updatePanel(); await handleBustPage(); } finally { loopBusy = false; }
                return;
            }
            // Navigate to jail page if not already there
            if (!hasBustPageMarkers()) {
                addLiveLog('Bust loop: navigating to jail');
                gotoPage('jail');
                return;
            }
            loopBusy = true;
            try { updatePanel(); await handleBustPage(); } finally { loopBusy = false; }
            return;
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
                const jailMs  = getOwnJailTimerMs();
                setLastActionText(jailMs != null ? `In jail (${Math.ceil(jailMs / 1000)}s)` : 'In jail');
                return;
            }

            stopJailObserver();
            clearScheduledReload();
            await wait(rand(500, 1200));
            // Return to the correct page based on which loop is active
            if (state.bustLoopActive) {
                addLiveLog('Passive check: no own jail row — returning to jail (bust active)');
                gotoPage('jail');
            } else if (state.gtaResetLoopActive) {
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
            if (recentlyActed(600)) return;

            if (hasCTCChallenge()) {
                setLastActionText('CTC solving…');
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

            // Players Online scan — fires opportunistically during normal script.
            // Only runs when no dedicated loop is active and scan is due.
            if (isKillOnlineScanDue() && !state.bustLoopActive && !state.gtaResetLoopActive &&
                !state.meltResetLoopActive && !state.resetCrimesEnabled) {
                addLiveLog('Kill scanner: online scan due — navigating to Players Online');
                gotoPage('online');
                return;
            }

            if (isBankPage()) {
                await handleBankPage();
                return;
            }

            if (isDrugsPage() || hasDrugsPageMarkers()) {
                await handleDrugsPage();
                return;
            }

            if (isCarPage()) {
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

            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
        } finally {
            loopBusy = false;
        }
    }

    function startHeartbeat() {
        stopHeartbeat();
        startRuntimeIfNeeded();
        heartbeatHandle = setInterval(() => tick(), DEFAULTS.heartbeatMs);
        setTimeout(() => tick(), 400);
        addLiveLog('Heartbeat started');
    }

    function stopHeartbeat() {
        if (heartbeatHandle) {
            clearInterval(heartbeatHandle);
            heartbeatHandle = null;
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

    function renderStats() {
        if (!statsEl) return;
        const s = state.stats;

        // Only rebuild the DOM when values have actually changed.
        // This preserves text selection between heartbeat ticks.
        const currentJson = JSON.stringify(s);
        if (currentJson === lastRenderedStatsJson) return;
        lastRenderedStatsJson = currentJson;

        statsEl.innerHTML = `
            <div><b>Crimes:</b> ${s.crimes}</div>
            <div><b>Crime resets:</b> ${s.crimeResets || 0}</div>
            <div><b>GTAs:</b> ${s.gtas}</div>
            <div><b>GTA resets:</b> ${s.gtaResets || 0}</div>
            <div><b>Melts:</b> ${s.melts}</div>
            <div><b>Melt resets:</b> ${s.meltResets || 0}</div>
            <div><b>Busts successful:</b> ${s.bustsSuccess || 0}</div>
            <div><b>Busts failed:</b> ${s.bustsFailed || 0}</div>
            <div><b>Bullets received:</b> ${s.bulletsReceived.toLocaleString()}</div>
            <div><b>Repairs:</b> ${s.repairs}</div>
            <div><b>Deposits:</b> ${s.deposits}</div>
            <div><b>Jails:</b> ${s.jails}</div>
            <div><b>Jail escapes (1pt):</b> ${s.jailEscapes || 0}</div>
            <div><b>CTC solved:</b> ${s.ctcSolved}</div>
            <div><b>CTC failed:</b> ${s.ctcFailed}</div>
            <div><b>Missions accepted:</b> ${s.missionsAccepted}</div>
            <div><b>Missions declined:</b> ${s.missionsDeclined}</div>
            <div><b>Mission cars used:</b> ${s.missionCarsUsed}</div>
            <div><b>Drug runs:</b> ${s.drugRuns}</div>
            <div><b>Drug car repairs:</b> ${s.drugRepairs}</div>
            <div><b>Swiss deposits:</b> ${s.swissDeposits}</div>
            <div><b>Swiss withdrawals:</b> ${s.swissWithdrawals}</div>
            <div><b>Page loads:</b> ${s.pageLoads}</div>
            <div><b>Last action:</b> ${s.lastActionText}</div>
        `;
    }

    function renderLiveLog() {
        if (!logEl) return;
        const log = state.liveLog;
        if (log.length === lastRenderedLogLength && log[0] === lastRenderedLogFirst) return;
        lastRenderedLogLength = log.length;
        lastRenderedLogFirst  = log[0] || '';
        logEl.innerHTML = log
            .map(entry => `<div class="ug-log-entry">${escapeHtml(entry)}</div>`)
            .join('');
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

        crimesContainer.innerHTML = crimeRows.join('');
        gtaContainer.innerHTML    = [gtaRow, meltRow].join('');
    }

    function refreshActionLockStates() {
        const allDefs = [...CRIME_DEFS, GTA_DEF, MELT_DEF];

        for (const def of allDefs) {
            const cb    = document.querySelector(`.ug-action-cb[data-id="${def.id}"]`);
            const label = cb?.closest('.ug-action-label');
            if (!cb || !label) continue;

            const locked =
                def.id === GTA_DEF.id  ? isGTALocked()  :
                def.id === MELT_DEF.id ? isMeltLocked() :
                isCrimeLocked(def.id);

            cb.disabled = locked;
            label.classList.toggle('ug-action-locked', locked);

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
        return `
            <label class="ug-action-label ${locked ? 'ug-action-locked' : ''}">
                <input
                    type="checkbox"
                    class="ug-action-cb"
                    data-id="${id}"
                    ${checked ? 'checked' : ''}
                    ${locked ? 'disabled' : ''}
                />
                ${escapeHtml(name)}
                ${locked ? '<span class="ug-locked-tag">locked</span>' : ''}
            </label>
        `;
    }

    // Active tab persisted so it survives page navigation.
    // If a user had 'stats' or 'log' saved from a previous version, map to 'statslog'.
    let activeTab = getSetting('activeTab', 'crimes');
    if (activeTab === 'stats' || activeTab === 'log') activeTab = 'statslog';
    // Ensure activeTab is a valid tab that exists in the current version
    const validTabs = ['crimes', 'gta', 'drugs', 'points', 'kill', 'statslog'];
    if (!validTabs.includes(activeTab)) activeTab = 'crimes';

    // Active sub-tab within Stats/Log combined tab
    let activeStatsLogTab = getSetting('activeStatsLogTab', 'stats');

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
        state.bustEnabled            = bustEnabledInput      ? bustEnabledInput.checked      : state.bustEnabled;
        state.bustFastMode           = bustFastModeInput     ? bustFastModeInput.checked     : state.bustFastMode;
        state.killScanOnlineEnabled  = killScanOnlineInput   ? killScanOnlineInput.checked   : state.killScanOnlineEnabled;
        state.killScanOnlineInterval = killScanIntervalEl    ? Number(killScanIntervalEl.value) : state.killScanOnlineInterval;
        state.killSearchEnabled      = killSearchInput       ? killSearchInput.checked       : state.killSearchEnabled;

        // Activate or deactivate the persisted loop flags to match the toggles.
        // These survive page reloads so the dedicated loops maintain themselves.
        state.gtaResetLoopActive   = state.resetGTAEnabled;
        state.meltResetLoopActive  = state.resetMeltEnabled;
        state.bustLoopActive       = state.bustEnabled;
        // Kill search loop activation logic:
        // - If the toggle is off, always deactivate
        // - If the loop was already active (persisted), keep it active — never
        //   deactivate mid-run. handleKillPage() is the only place that sets
        //   killSearchLoopActive to false when there are genuinely no targets.
        // - If the loop was inactive, check if there are targets to start it:
        //   unknowns, expiring alives (3hr window), or protected players past
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
                (nowMs - p.lastChecked) >= KILL_SCANNER_PROTECTED_RESCAN_MS
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
        if (!resetCrimesInput || !resetGTAInput || !resetMeltInput || !bustEnabledInput || !killSearchInput) return;

        const all = [
            { id: 'crimes',      el: resetCrimesInput },
            { id: 'gta',         el: resetGTAInput },
            { id: 'melt',        el: resetMeltInput },
            { id: 'bust',        el: bustEnabledInput },
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

        // Fast bust only applies when bust is active
        if (bustFastModeInput) {
            const bustNowChecked = bustEnabledInput.checked;
            bustFastModeInput.disabled = !bustNowChecked;
            if (!bustNowChecked) bustFastModeInput.checked = false;
        }

        saveSettings();
    }

    // Debounce timer for text input auto-save
    let autoSaveTimer = null;

    function scheduleAutoSave() {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => { autoSaveTimer = null; saveSettings(); }, 800);
    }

    function switchStatsLogTab(subtab) {
        activeStatsLogTab = subtab;
        setSetting('activeStatsLogTab', subtab);
        document.querySelectorAll('.ug-subtab-btn').forEach(btn => {
            btn.classList.toggle('ug-subtab-active', btn.dataset.subtab === subtab);
        });
        document.querySelectorAll('.ug-subtab-pane').forEach(pane => {
            pane.style.display = pane.dataset.subtab === subtab ? 'block' : 'none';
        });
    }

    function switchTab(tab) {
        activeTab = tab;
        setSetting('activeTab', tab);

        const tabBtns  = document.querySelectorAll('.ug-tab-btn');
        const tabPanes = document.querySelectorAll('.ug-tab-pane');

        tabBtns.forEach(btn => {
            btn.classList.toggle('ug-tab-active', btn.dataset.tab === tab);
        });

        tabPanes.forEach(pane => {
            pane.style.display = pane.dataset.tab === tab ? 'block' : 'none';
        });

        // When switching to the statslog tab, restore the active sub-tab
        if (tab === 'statslog') {
            switchStatsLogTab(activeStatsLogTab);
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

            <div id="ug-bot-collapsed-controls">
            </div>

            <div id="ug-bot-extra">
                <div id="ug-bot-tabs">
                    <button class="ug-tab-btn" data-tab="crimes">Crimes</button>
                    <button class="ug-tab-btn" data-tab="gta">GTA</button>
                    <button class="ug-tab-btn" data-tab="drugs">Drugs</button>
                    <button class="ug-tab-btn" data-tab="points">Points</button>
                    <button class="ug-tab-btn" data-tab="kill">Kill</button>
                    <button class="ug-tab-btn" data-tab="statslog">Stats/Log</button>
                </div>

                <div id="ug-bot-tab-content">

                <!-- CRIMES TAB -->
                <div class="ug-tab-pane" data-tab="crimes">
                    <div class="ug-row ug-check">
                        <label><input id="ug-bot-autodeposit" type="checkbox" /> Enable auto quick deposit</label>
                    </div>
                    <div class="ug-row">
                        <div class="ug-subtitle">Auto deposit threshold</div>
                        <input id="ug-bot-deposit-threshold" type="text" inputmode="numeric" />
                        <div class="ug-helptext">Deposit when cash is at or above this amount. Disabled automatically when drug running is on.</div>
                    </div>
                    <div class="ug-row">
                        <div id="ug-bot-actions"></div>
                    </div>
                </div>

                <!-- GTA TAB — includes GTA/Melt toggles, repair settings, and missions -->
                <div class="ug-tab-pane" data-tab="gta">
                    <div class="ug-row">
                        <div id="ug-bot-gta-actions">
                            <div id="ug-bot-gta-checkboxes"></div>
                            <div class="ug-action-divider"></div>
                            <label class="ug-action-label">
                                <input id="ug-bot-autorepair" type="checkbox" /> Enable auto repair
                            </label>
                            <div style="margin-top:6px;">
                                <div class="ug-subtitle" style="margin-bottom:4px;">Repair every X melts</div>
                                <input id="ug-bot-repair-every" type="number" min="1" step="1" style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #555;border-radius:6px;background:#111;color:#fff;font-size:12px;" />
                                <div class="ug-helptext">After this many melts, go to My Cars, click Select All, then Repair.</div>
                            </div>
                            <div class="ug-action-divider"></div>
                            <label class="ug-action-label">
                                <input id="ug-bot-automissions" type="checkbox" /> Enable missions
                            </label>
                            <label class="ug-action-label">
                                <input id="ug-bot-autogivecars" type="checkbox" /> Enable give car missions
                            </label>
                        </div>
                    </div>
                </div>

                <!-- DRUGS TAB -->
                <div class="ug-tab-pane" data-tab="drugs">
                    <div class="ug-row">
                        <div id="ug-bot-drugs">
                            <label class="ug-action-label">
                                <input id="ug-bot-autodrugs" type="checkbox" /> Enable drug running
                            </label>
                            <div class="ug-helptext" style="margin-top:4px;">Route: USA &#8596; England — Heroin outbound, Cannabis inbound. Swiss Bank deposit replaces quick deposit when enabled.</div>
                            <div class="ug-helptext" style="margin-top:2px;color:#f8c84a;">Requires a favourited car.</div>
                        </div>
                    </div>
                    <div class="ug-row">
                        <div class="ug-subtitle">Swiss Bank deposit multiplier</div>
                        <input id="ug-bot-drug-deposit-multiplier" type="number" min="1" step="1" />
                        <div class="ug-helptext">Deposit to Swiss Bank when cash exceeds this many times the cost of a full Heroin run. Scales automatically with your capacity and rank.</div>
                        <div id="ug-bot-drug-deposit-calc" class="ug-drug-calc-info"></div>
                    </div>
                    <div class="ug-row">
                        <div class="ug-section-box">
                            <div class="ug-section-title">Bust</div>
                            <div class="ug-helptext" style="margin-bottom:6px;">Stays on the jail page busting the lowest-timer prisoner continuously. If jail is empty, waits for new prisoners. Enabling bust disables timer reset modes and vice versa.</div>
                            <label class="ug-action-label">
                                <input id="ug-bot-bust-enabled" type="checkbox" class="ug-reset-cb" data-reset="bust" />
                                Enable bust
                            </label>
                            <label class="ug-action-label ug-fast-mode-label" id="ug-bot-bust-fast-label">
                                <input id="ug-bot-bust-fast" type="checkbox" />
                                Fast bust — bust players instantly
                            </label>
                        </div>
                    </div>
                </div>

                <!-- POINTS TAB -->
                <div class="ug-tab-pane" data-tab="points">

                    <!-- Leave Jail section -->
                    <div class="ug-row">
                        <div class="ug-section-box">
                            <div class="ug-section-title">Leave Jail</div>
                            <label class="ug-action-label">
                                <input id="ug-bot-leavejail" type="checkbox" /> Leave Jail instantly (costs 1 point)
                            </label>
                            <div style="margin-top:6px;">
                                <div class="ug-subtitle" style="margin-bottom:4px;">Minimum points to use Leave Jail</div>
                                <input id="ug-bot-leavejail-minpoints" type="number" min="1" step="1" style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #555;border-radius:6px;background:#111;color:#fff;font-size:12px;" />
                                <div class="ug-helptext">Only spend a point to leave jail if you have at least this many points remaining.</div>
                            </div>
                        </div>
                    </div>

                    <!-- Timer Resets section -->
                    <div class="ug-row">
                        <div class="ug-section-box">
                            <div class="ug-section-title">Timer Resets</div>
                            <div class="ug-helptext" style="margin-bottom:8px;">Only one can be active at a time — enabling one disables the others. When active, the bot focuses exclusively on that action until points drop below the threshold or no valid targets remain.</div>
                            <label class="ug-action-label">
                                <input id="ug-bot-reset-crimes" type="checkbox" class="ug-reset-cb" data-reset="crimes" />
                                Reset Crime timers
                            </label>
                            <label class="ug-action-label ug-fast-mode-label">
                                <input id="ug-bot-reset-crimes-fast" type="checkbox" />
                                Fast mode — commit crimes instantly after reset
                            </label>
                            <label class="ug-action-label">
                                <input id="ug-bot-reset-gta" type="checkbox" class="ug-reset-cb" data-reset="gta" />
                                Reset GTA timer
                            </label>
                            <label class="ug-action-label">
                                <input id="ug-bot-reset-melt" type="checkbox" class="ug-reset-cb" data-reset="melt" />
                                Reset Melt timer
                            </label>
                            <div style="margin-top:8px;">
                                <div class="ug-subtitle" style="margin-bottom:4px;">Minimum points for timer resets</div>
                                <input id="ug-bot-reset-minpoints" type="number" min="1" step="1" style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #555;border-radius:6px;background:#111;color:#fff;font-size:12px;" />
                                <div class="ug-helptext">Never spend points on timer resets if below this threshold. Shared across all three reset types.</div>
                            </div>
                        </div>
                    </div>

                </div>

                <!-- KILL TAB -->
                <div class="ug-tab-pane" data-tab="kill">
                    <div class="ug-row">
                        <div class="ug-section-box">
                            <div class="ug-section-title">Players Online Scanner</div>
                            <div class="ug-helptext" style="margin-bottom:6px;">Periodically visits the Players Online page and adds new players to the list. Runs in the background during normal script operation only — not during dedicated modes.</div>
                            <label class="ug-action-label">
                                <input id="ug-bot-kill-scan-online" type="checkbox" />
                                Scan Players Online
                            </label>
                            <div style="margin-top:6px;">
                                <div class="ug-subtitle" style="margin-bottom:4px;">Scan interval</div>
                                <select id="ug-bot-kill-scan-interval" data-role="none" style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #555;border-radius:6px;background:#111;color:#fff;font-size:12px;">
                                    <option value="5">Every 5 minutes</option>
                                    <option value="10">Every 10 minutes</option>
                                    <option value="15">Every 15 minutes</option>
                                    <option value="20">Every 20 minutes</option>
                                    <option value="30">Every 30 minutes</option>
                                    <option value="60">Every 60 minutes</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="ug-row">
                        <div class="ug-section-box">
                            <div class="ug-section-title">Search Players</div>
                            <div class="ug-helptext" style="margin-bottom:6px;">Searches all tracked players one by one (24hrs each). Enabling this disables other dedicated modes. Once all players are searched it reverts to the normal script and restarts when new targets appear.</div>
                            <label class="ug-action-label">
                                <input id="ug-bot-kill-search" type="checkbox" class="ug-reset-cb" data-reset="killsearch" />
                                Search players
                            </label>
                        </div>
                    </div>
                    <div class="ug-row">
                        <div class="ug-section-box" style="padding:0;border:none;background:none;">
                            <div class="ug-subtitle" style="margin-bottom:6px;">Player list <span id="ug-bot-kill-count" style="font-weight:normal;color:#aaa;font-size:11px;"></span></div>
                            <div id="ug-bot-kill-list" class="ug-kill-list"></div>
                            <div style="display:flex;gap:6px;margin-top:8px;">
                                <button id="ug-bot-kill-clear" type="button" style="font-size:11px;padding:4px 8px;">Clear list</button>
                                <button id="ug-bot-kill-copy" type="button" style="font-size:11px;padding:4px 8px;">Copy names</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- STATS/LOG COMBINED TAB -->
                <div class="ug-tab-pane" data-tab="statslog">
                    <div class="ug-statslog-subtabs">
                        <button class="ug-subtab-btn" data-subtab="stats">Stats</button>
                        <button class="ug-subtab-btn" data-subtab="log">Log</button>
                        <button id="ug-bot-reset" type="button" class="ug-reset-stats-btn">Reset Stats</button>
                    </div>
                    <div class="ug-subtab-pane" data-subtab="stats">
                        <div class="ug-row">
                            <div id="ug-bot-stats"></div>
                        </div>
                    </div>
                    <div class="ug-subtab-pane" data-subtab="log">
                        <div class="ug-row">
                            <div id="ug-bot-log"></div>
                        </div>
                    </div>
                </div>

                </div>
            </div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            #ug-bot-panel {
                position: fixed;
                right: 16px;
                bottom: 16px;
                z-index: 2147483647;
                width: 390px;
                max-height: 82vh;
                overflow: auto;
                background: rgba(15, 15, 15, 0.96);
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
            .ug-tab-pane { display: none; }
            #ug-bot-tab-content { min-height: 560px; }
            #ug-bot-panel input[type="number"],
            #ug-bot-panel input[type="text"] {
                width: 100%;
                box-sizing: border-box;
                padding: 7px 8px;
                border: 1px solid #555;
                border-radius: 6px;
                background: #1b1b1b;
                color: #fff;
                font-size: 12px;
            }
            #ug-bot-panel .ug-check label { display: flex; align-items: center; gap: 8px; font-size: 12px; }
            .ug-subtitle { font-size: 12px; font-weight: bold; margin-bottom: 6px; color: #d8d8d8; }
            .ug-helptext { margin-top: 5px; font-size: 11px; color: #aaa; line-height: 1.35; }
            #ug-bot-stats {
                font-size: 12px;
                line-height: 1.45;
                background: #1b1b1b;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 8px;
            }
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
            #ug-bot-gta-actions,
            #ug-bot-drugs {
                background: #1b1b1b;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 8px;
                display: flex;
                flex-direction: column;
                gap: 5px;
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
            .ug-action-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                cursor: pointer;
                user-select: none;
            }
            .ug-action-label input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; flex-shrink: 0; }
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
            .ug-statslog-subtabs {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-bottom: 10px;
            }
            .ug-subtab-btn {
                flex: 1;
                padding: 4px 8px !important;
                font-size: 11px !important;
                margin: 0 !important;
                border: 1px solid #555 !important;
                border-radius: 5px !important;
                background: #222 !important;
                color: #aaa !important;
                cursor: pointer;
            }
            .ug-subtab-btn.ug-subtab-active {
                background: #444 !important;
                color: #fff !important;
                border-color: #888 !important;
            }
            .ug-reset-stats-btn {
                margin-left: auto !important;
                padding: 4px 8px !important;
                font-size: 11px !important;
                margin-bottom: 0 !important;
                margin-right: 0 !important;
                border: 1px solid #555 !important;
                border-radius: 5px !important;
                background: #222 !important;
                color: #aaa !important;
                cursor: pointer;
                flex-shrink: 0;
            }
            .ug-reset-stats-btn:hover {
                background: #333 !important;
                color: #fff !important;
            }
            .ug-subtab-pane { display: none; }
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
                background: #111;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 6px;
                font-size: 11px;
                text-align: left;
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
        depositThresholdEl      = document.querySelector('#ug-bot-deposit-threshold');
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
        bustEnabledInput         = document.querySelector('#ug-bot-bust-enabled');
        bustFastModeInput        = document.querySelector('#ug-bot-bust-fast');
        killScanOnlineInput      = document.querySelector('#ug-bot-kill-scan-online');
        killScanIntervalEl       = document.querySelector('#ug-bot-kill-scan-interval');
        killSearchInput          = document.querySelector('#ug-bot-kill-search');
        statsEl                 = document.querySelector('#ug-bot-stats');
        logEl                   = document.querySelector('#ug-bot-log');
        compactBtn              = document.querySelector('#ug-bot-compact-btn');
        hideBtn                 = document.querySelector('#ug-bot-hide-btn');
        closeBtn                = document.querySelector('#ug-bot-close-btn');

        autoDepositInput.checked        = state.autoDepositEnabled;
        depositThresholdEl.value        = formatNumberWithCommas(state.autoDepositThreshold);
        autoRepairInput.checked         = state.autoRepairEnabled;
        repairEveryEl.value             = String(state.repairEveryMelts);
        autoMissionsInput.checked       = state.autoMissionsEnabled;
        autoGiveCarsInput.checked       = state.autoGiveCarMissionsEnabled;
        autoDrugsInput.checked          = state.autoDrugsEnabled;
        drugDepositMultiplierEl.value   = String(state.drugDepositMultiplier);
        leaveJailInput.checked          = state.leaveJailEnabled;
        leaveJailMinPointsEl.value      = String(state.leaveJailMinPoints);
        resetCrimesInput.checked             = state.resetCrimesEnabled;
        resetCrimesFastModeInput.checked     = state.resetCrimesFastMode;
        resetCrimesFastModeInput.disabled    = !state.resetCrimesEnabled;
        if (!state.resetCrimesEnabled) {
            resetCrimesFastModeInput.closest('.ug-fast-mode-label')?.classList.add('ug-disabled-sub');
        }
        resetGTAInput.checked                = state.resetGTAEnabled;
        resetMeltInput.checked               = state.resetMeltEnabled;
        resetTimerMinPointsEl.value          = String(state.resetTimerMinPoints);
        bustEnabledInput.checked             = state.bustEnabled;
        bustFastModeInput.checked            = state.bustFastMode;
        bustFastModeInput.disabled           = !state.bustEnabled;
        if (!state.bustEnabled) {
            bustFastModeInput.closest('.ug-fast-mode-label')?.classList.add('ug-disabled-sub');
        }

        if (killScanOnlineInput)  killScanOnlineInput.checked = state.killScanOnlineEnabled;
        if (killScanIntervalEl)   killScanIntervalEl.value    = String(state.killScanOnlineInterval);
        if (killSearchInput)      killSearchInput.checked     = state.killSearchEnabled;

        attachNumberFormatting(depositThresholdEl);

        buildActionCheckboxes();

        // Tab buttons
        document.querySelectorAll('.ug-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        document.querySelectorAll('.ug-subtab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchStatsLogTab(btn.dataset.subtab));
        });

        switchTab(activeTab);
        // Initialise sub-tab state if statslog is the active tab
        if (activeTab === 'statslog') {
            switchStatsLogTab(activeStatsLogTab);
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
                if (bustFastModeInput) {
                    const label = bustFastModeInput.closest('.ug-fast-mode-label');
                    if (label) label.classList.toggle('ug-disabled-sub', !bustEnabledInput.checked);
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

        document.querySelector('#ug-bot-reset').addEventListener('click', () => {
            resetSessionStats();
            updatePanel();
        });

        function handleToggleClick() {
            if (state.enabled) {
                setPaused('Stopped manually');
            } else {
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

        renderStats();
        renderLiveLog();
        renderKillList();
        updatePanel();

        // Kill scanner — clear list button
        const killClearBtn = document.querySelector('#ug-bot-kill-clear');
        if (killClearBtn) {
            killClearBtn.addEventListener('click', () => {
                if (confirm('Clear the entire player list? This cannot be undone.')) {
                    state.killPlayers       = [];
                    state.killCurrentSearch = '';
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
                    setTimeout(() => { killCopyBtn.textContent = 'Copy names'; }, 2000);
                    return;
                }
                const names = players.map(p => p.name).join(String.fromCharCode(10));
                navigator.clipboard.writeText(names).then(() => {
                    killCopyBtn.textContent = `Copied ${players.length}!`;
                    setTimeout(() => { killCopyBtn.textContent = 'Copy names'; }, 2000);
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
                    setTimeout(() => { killCopyBtn.textContent = 'Copy names'; }, 2000);
                });
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
        const bustStatus = state.bustEnabled
            ? `on${state.bustFastMode ? ' (fast)' : ''}`
            : 'off';

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
                    <div class="ug-status-line"><b>Bust:</b> ${escapeHtml(bustStatus)}</div>
                    <div class="ug-status-line"><b>Kill scan:</b> ${(() => {
                        if (!state.killScanOnlineEnabled) return 'off';
                        const msUntil = (state.killScanOnlineInterval * 60 * 1000) - (now() - state.killLastOnlineScan);
                        if (msUntil <= 0) return 'ready';
                        const mins = Math.floor(msUntil / 60000);
                        const secs = Math.floor((msUntil % 60000) / 1000);
                        return mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
                    })()} | Search: ${state.killSearchEnabled ? 'on' : 'off'} | Players: ${getKillPlayers().length}</div>
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
        renderStats();
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

    function init() {
        if (!document.body) {
            setTimeout(init, 300);
            return;
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
        state.bustLoopActive       = state.bustEnabled;
        // Kill search loop activation logic:
        // - If the toggle is off, always deactivate
        // - If the loop was already active (persisted), keep it active — never
        //   deactivate mid-run. handleKillPage() is the only place that sets
        //   killSearchLoopActive to false when there are genuinely no targets.
        // - If the loop was inactive, check if there are targets to start it:
        //   unknowns, expiring alives (3hr window), or protected players past
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
                (nowMs - p.lastChecked) >= KILL_SCANNER_PROTECTED_RESCAN_MS
            );
            state.killSearchLoopActive = hasUnknowns || hasExpiringAlives || hasProtectedDue;
        }

        updateStats(s => { s.pageLoads += 1; });

        // Cache drug capacity on drugs page visits so crimes page can use it for deposit calc
        if (isDrugsPage() || hasDrugsPageMarkers()) {
            const capacity = getDrugCapacity();
            if (capacity > 0) state.drugCapacityCache = capacity;
        }

        createPanel();
        syncGTAReadyFromQuickLink();
        syncMeltReadyFromQuickLink();
        syncDriveReadyFromQuickLink();
        protectMeltRows();

        if (state.panelHidden) {
            const panel = document.querySelector('#ug-bot-panel');
            if (panel) panel.style.display = 'none';
            injectSidebarButton();
        } else {
            updatePanel();
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

        if (state.enabled) startHeartbeat();

        addLiveLog('Script loaded');
    }

    init();

    }); // end window.onload
})();
