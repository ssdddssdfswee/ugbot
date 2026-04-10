// ==UserScript==
// @name         UG Crimes + GTA + Melt Helper v6.3.44
// @namespace    ug-bot
// @version      1.2.2
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

        let consecutiveSkips = 0;
        const MAX_SKIPS_BEFORE_RELOAD = 10;

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
                if (result.solved) {
                    consecutiveSkips = 0;
                } else {
                    consecutiveSkips++;
                    if (consecutiveSkips >= MAX_SKIPS_BEFORE_RELOAD) {
                        consecutiveSkips = 0;
                        logFn('CTC: too many failed attempts — reloading page for fresh CTC');
                        gotoPage(currentPage());
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

    const SCRIPT_VERSION = '1.2.2';

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

        actionDelayMin: 100,
        actionDelayMax: 300,

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
        bustNoReload: false,


        // Kill scanner settings
        killScanOnlineEnabled:  false,
        killScanOnlineInterval: 10,   // minutes between Players Online checks
        killSearchEnabled:      false,
        killProtectedRecheckEnabled:  false,
        killProtectedRecheckMins:     5,

        // Kill BG check / shoot loop settings
        killBgCheckEnabled:      false,  // Global BG check loop toggle
        killShootEnabled:        false,  // Global shoot loop toggle
        killAnonymousShooting:   false,  // Shoot anonymously (no show=y)
        killBgCheckIntervalHrs:  6,      // Hours between BG checks per player
        killPenaltyThreshold:    0,      // Max kill penalty multiplier (0 = disabled)

        maxLiveLogEntries: 500
    };

    const SAFETY = {
        sameCrimeMinGapMs:      3500,
        postClickSettleMs:      500,
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
        get bustNoReload()         { return !!getSetting('bustNoReload', DEFAULTS.bustNoReload); },
        set bustNoReload(v)        { setSetting('bustNoReload', !!v); },


        get bustLoopActive()       { return !!getSetting('bustLoopActive', false); },
        set bustLoopActive(v)      { setSetting('bustLoopActive', !!v); },

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

        // Username currently being searched (persists across page reload)
        get killCurrentSearch()       { return getSetting('killCurrentSearch', ''); },
        set killCurrentSearch(v)      { setSetting('killCurrentSearch', String(v || '')); },
        get penaltyDropsAt()          { return Number(getSetting('penaltyDropsAt', 0)); },
        set penaltyDropsAt(v)         { setSetting('penaltyDropsAt', Number(v) || 0); },
        get pendingPenaltyPage()      { return !!getSetting('pendingPenaltyPage', false); },
        set pendingPenaltyPage(v)     { setSetting('pendingPenaltyPage', !!v); },

        // Kill BG check / shoot loop settings
        get killBgCheckEnabled()       { return !!getSetting('killBgCheckEnabled', false); },
        set killBgCheckEnabled(v)      { setSetting('killBgCheckEnabled', !!v); },

        get killShootEnabled()         { return !!getSetting('killShootEnabled', false); },
        set killShootEnabled(v)        { setSetting('killShootEnabled', !!v); },

        get killAnonymousShooting()    { return !!getSetting('killAnonymousShooting', false); },
        set killAnonymousShooting(v)   { setSetting('killAnonymousShooting', !!v); },

        get killBgCheckIntervalHrs()   { return Math.max(1, Number(getSetting('killBgCheckIntervalHrs', 6)) || 6); },
        set killBgCheckIntervalHrs(v)  { setSetting('killBgCheckIntervalHrs', Math.max(1, Number(v) || 6)); },

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
    let bustNoReloadInput           = null;
    let killProtectedRecheckInput   = null;
    let killProtectedRecheckMinsEl  = null;

    let killScanOnlineInput         = null;
    let killScanIntervalEl          = null;
    let killSearchInput             = null;
    let killBgCheckInput            = null;
    let killShootInput              = null;
    let killAnonymousInput          = null;
    let killBgCheckIntervalEl       = null;
    let killPenaltyThresholdEl      = null;
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
        state.killLoopActive       = false;
        state.killSearchIndex      = 0;
        state.killCurrentSearch    = '';
        state.pendingKillAction    = null;
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
        state.killLoopActive       = false;
        state.killCurrentSearch    = '';
        state.pendingKillAction    = null;
        stopBustObserver();
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

    function gotoPage(pageName, extraParams = {}) {
        saveScrollPositions();
        clearScheduledReload();
        reloadPending = true;
        const url = new URL(window.location.href);
        url.searchParams.set('p', pageName);
        url.searchParams.delete('a');    // Never carry over the action/type param between pages
        url.searchParams.delete('page'); // Never carry over pagination — causes ?p=crimes&page=1 jail bug

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
    function getPlayerBullets()  { return parseUnits((document.querySelector('#player-bullets')?.textContent || '0').replace(/[^0-9,]/g, '')); }
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
        return GUN_VALUES[gunName] || 9; // default to AK47 if not found
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
        return penalty > threshold;
    }

    // -------------------------------------------------------------------------
    // BG check / shoot helpers
    // -------------------------------------------------------------------------

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
            // Include myrank and gun in the calculator URL — required for the result to appear
            const myRankIndex = getPlayerRankIndex() || 20;
            const myGun       = getPlayerGunValue(); // read actual gun from stats bar
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
            const rankName  = rankText.replace(/\s*\([^)]+\)\s*/g, '').trim();
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
    function findBestTravelCarUrl() {
        const allLinks = [...document.querySelectorAll('a[href*="?p=car&id="]')];

        // Build priority groups
        const orange  = [];
        const rstuner = [];
        const black   = [];

        for (const link of allLinks) {
            const text = textOf(link).toLowerCase();
            if (text.includes('orange'))   { orange.push(link);  continue; }
            if (text.includes('rs tuner')) { rstuner.push(link); continue; }
            if (text.includes('black'))    { black.push(link);   continue; }
        }

        const best = orange[0] || rstuner[0] || black[0] || null;
        if (!best) return null;

        try {
            return new URL(best.getAttribute('href'), window.location.href).toString();
        } catch (_) {
            return null;
        }
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
        window.location.href = travelCarUrl;
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
    //    protected players are always priority when the loop activates
    // 5. Unkillable — never search
    // Pending players (searchExpiresAt > now+2.5hrs) are skipped — they're already
    // in the game's search queue and just need time to complete.
    function getNextKillTarget() {
        const players = getKillPlayers();
        if (!players.length) return null;

        const nowMs = now();
        const PENDING_SKIP_MS = 2.5 * 60 * 60 * 1000; // 2.5hrs — skip if search expiry > now+2.5hrs

        // Priority 1: Unknown players — search immediately
        // Skip if they appear to be in a pending state (recently set to 3hr expiry)
        const unknown = players.find(p => {
            if (p.status !== KILL_STATUS.UNKNOWN) return false;
            if (p.searchExpiresAt && (p.searchExpiresAt - nowMs) > PENDING_SKIP_MS) return false;
            return true;
        });
        if (unknown) return unknown;

        // Priority 2: Protected players — search all of them whenever the loop
        // runs. To cycle through all protected players rather than repeatedly
        // searching the same one, skip any searched in the last 5 minutes.
        // This allows the bot to work through the full list in one run.
        // If killProtectedRecheckEnabled, use the user-defined interval instead.
        const RECENTLY_SEARCHED_MS = (state.killProtectedRecheckEnabled && state.killSearchEnabled)
            ? state.killProtectedRecheckMins * 60 * 1000
            : 5 * 60 * 1000;
        const nextProtected = players.find(p =>
            p.status === KILL_STATUS.PROTECTED &&
            (nowMs - (p.lastChecked || 0)) >= RECENTLY_SEARCHED_MS
        );
        if (nextProtected) return nextProtected;

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
            } else {
                // Clear stored expiry when status changes to non-alive
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

    // Reads the "Players found" and "Searching for" sections on the kill page and:
    // 1. Updates each known player's stored expiry time with the accurate "Lost in X" value
    // 2. Adds any unknown players found there to the list as "alive" — cross-device sync
    // 3. Marks pending players (currently being searched, no result yet) so the bot
    //    doesn't try to re-search them — they just need time to be found (3hr window)
    function syncKillExpiryFromPage() {
        const players = state.killPlayers || [];

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
                        const relevant = isPlayerBgCheckEnabled(p.name) || isPlayerShootEnabled(p.name) || p.isBg;
                        if (relevant) {
                            players[idx].expectedFoundAt = now() + foundInMs;
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
                    players[idx].status = KILL_STATUS.ALIVE;
                }
            }
        }

        // "Players found" rows — each has a player link and a "Lost in" timer span
        const rows = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd)')];
        if (!rows.length && !pendingNames.size) return;

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
                    country:         rowCountry
                });
                added++;
            } else {
                // Player already in list — update expiry, never resurrect dead
                if (players[idx].status !== KILL_STATUS.DEAD) {
                    players[idx].searchExpiresAt = expiresAt;
                    players[idx].status          = KILL_STATUS.ALIVE;
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
        if (state.killBgCheckEnabled && !isKillPenaltyTooHigh()) for (const p of players) {
            if (!p.isBg || !p.bgFor) continue;
            if (p.status !== KILL_STATUS.ALIVE) continue;
            if (!isPlayerShootEnabled(p.bgFor)) continue;
            // Skip if we know required bullets and don't have enough yet
            if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) continue;
            const pa = state.pendingKillAction;
            if (pa && (pa.stage === 'bg_shoot' || pa.targetName === p.name)) continue;
            // Verify bodyguard is actually in Players Found right now before queuing shoot
            const inFoundNow = [...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .some(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase() === p.name.toLowerCase(); } catch(_){ return false; } });
            if (!inFoundNow) continue;
            // Skip if already queued for shoot (persistent flag independent of pendingKillAction)
            if (p.bgShootQueued) continue;
            addLiveLog(`Kill loop: bodyguard ${p.name} is now found — queuing shoot for ${p.bgFor}`);
            // Mark as queued so syncKillExpiryFromPage doesn't re-queue on every visit
            const bgQIdx = players.findIndex(pl => pl.name.toLowerCase() === p.name.toLowerCase());
            if (bgQIdx !== -1) { players[bgQIdx].bgShootQueued = true; saveKillPlayers(players); }
            state.pendingKillAction = { stage: 'bg_shoot', targetName: p.name, bgFor: p.bgFor, shootAfterBg: true };
            state.killLoopActive = true;
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
                // BG check due
                if (isPlayerBgCheckEnabled(p.name) && getBgCheckDueMs(p) <= 0) return true;
                // Kill only — only reactivate if penalty not too high
                if (isPlayerShootEnabled(p.name) && !isPlayerBgCheckEnabled(p.name) && !isKillPenaltyTooHigh()) return true;
                return false;
            });
            if (nowActive) {
                addLiveLog('Kill loop: target now in Players Found — reactivating');
                state.killLoopActive = true;
            }
        }

        // Always check: players already in Players Found with Kill ticked and now sufficient bullets
        // This handles the case where bullets accumulate over time for a player already found
        if (state.killBgCheckEnabled && !state.killLoopActive && !isKillPenaltyTooHigh()) { // bullets check — only when penalty ok
            const foundLinks = new Set([...document.querySelectorAll('.bgl.i.wb .bgm.chs:not(.pd) a[href*="?p=profile&u="]')]
                .map(a => { try { return new URL(a.getAttribute('href'), window.location.href).searchParams.get('u').toLowerCase(); } catch(_){ return ''; } })
                .filter(Boolean));
            const bulletsReady = players.some(p => {
                if (p.status !== KILL_STATUS.ALIVE) return false;
                if (!p.requiredBullets) return false;
                const bulletBuffer = isPlayerBgCheckEnabled(p.name) ? 1 : 0;
                if (getPlayerBullets() < p.requiredBullets + bulletBuffer) return false;
                if (!isPlayerShootEnabled(p.name)) return false;
                if (!foundLinks.has(p.name.toLowerCase())) return false;
                return true;
            });
            if (bulletsReady) {
                addLiveLog('Kill loop: bullets now sufficient for player in Players Found — reactivating');
                state.killLoopActive = true;
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
            const penaltyTooHigh = livePenalty > state.killPenaltyThreshold;
            const penaltyChanged = Math.abs(livePenalty - cached) >= 0.05;
            const needsCalc = !state.penaltyDropsAt || penaltyChanged;
            // If live penalty is 1.0 (no penalty), ensure penaltyDropsAt is cleared
            if (livePenalty <= 1.0) {
                if (state.penaltyDropsAt) state.penaltyDropsAt = 0;
            } else if (penaltyTooHigh && needsCalc) {
                const reason = penaltyChanged ? `penalty changed (${cached}x → ${livePenalty}x)` : `penalty ${livePenalty}x exceeds threshold`;
                addLiveLog(`Kill loop: ${reason} — navigating to penalty page`);
                state.pendingPenaltyPage = true;
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('kill-penalty');
                return;
            }
        }

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
            // No search targets — check if kill loop should activate for BG checks
            if (state.killBgCheckEnabled) {
                const alivePlayers = getKillPlayers().filter(p =>
                    p.status === KILL_STATUS.ALIVE || p.status === KILL_STATUS.UNKNOWN
                );
                const hasBgDue = alivePlayers.some(p =>
                    isPlayerBgCheckEnabled(p.name) && getBgCheckDueMs(p) <= 0
                );
                const hasKillable = alivePlayers.some(p => {
                    if (!isPlayerShootEnabled(p.name)) return false;
                    if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) return false;
                    if (isPlayerBgCheckEnabled(p.name) && getBgCheckDueMs(p) <= 0) return false;
                    return true;
                });
                if (hasBgDue || hasKillable) {
                    // syncKillExpiryFromPage already ran above — if kill loop didn't activate,
                    // the players aren't in Players Found yet. Just revert to normal script.
                    // killLoopActive may have been set by syncKillExpiryFromPage — check first.
                    if (!state.killLoopActive) {
                        addLiveLog('Kill scanner: no targets right now — reverting to normal script (toggle stays on)');
                        state.killSearchLoopActive = false;
                        await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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

        for (const [status, group] of Object.entries(groups)) {
            if (!group.players.length) continue;

            const canBgCheck = (status === KILL_STATUS.UNKNOWN || status === KILL_STATUS.ALIVE);

            html += `<div class="ug-kill-group-title">${escapeHtml(group.label)} (${group.players.length})</div>`;

            // Table approach — immune to flex/CSS interference from the game
            html += `<table style="width:100%;border-collapse:collapse;table-layout:fixed;">`;
            if (canBgCheck) {
                html += `<colgroup><col style="width:auto;"/><col style="width:80px;"/><col style="width:46px;"/><col style="width:22px;"/><col style="width:22px;"/></colgroup>`;
                html += `<tr><td style="font-size:9px;color:#555;padding:0;"></td><td style="font-size:9px;color:#ccc;padding:0 4px 2px 0;">Country</td><td style="font-size:9px;color:#ccc;text-align:right;padding:0 4px 2px 0;">Time</td><td style="font-size:9px;color:#ccc;text-align:center;padding:0 0 2px 0;">BG</td><td style="font-size:9px;color:#ccc;text-align:center;padding:0 0 2px 0;">Kill</td></tr>`;
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
                if (p.status === KILL_STATUS.ALIVE && p.lastBgCheck && isPlayerBgCheckEnabled(p.name)) {
                    const dueMs = getBgCheckDueMs(p);
                    if (dueMs <= 0) bgDue = ' ●';
                }

                const bgChecked    = canBgCheck && isPlayerBgCheckEnabled(p.name);
                const shootChecked = canBgCheck && isPlayerShootEnabled(p.name);

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
                        <td style="font-size:11px;color:${group.colour};padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
                        <td style="font-size:9px;color:#888;padding:1px 4px 1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(country)}</td>
                        <td style="font-size:9px;color:#ccc;text-align:right;padding:1px 4px 1px 0;white-space:nowrap;">${escapeHtml(meta)}${bgDue}</td>
                        <td style="text-align:center;padding:1px 2px;"><div class="ug-kcb ug-kill-bg-cb ${bgChecked ? 'checked' : ''}" data-name="${escapeHtml(p.name)}" title="${escapeHtml(bgTooltip)}"></div></td>
                        <td style="text-align:center;padding:1px 2px;"><div class="ug-kcb ug-kill-shoot-cb ${shootChecked ? 'checked' : ''}" data-name="${escapeHtml(p.name)}"></div></td>
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
                    const cols = canBgCheck ? 5 : 3;
                    html += `<tr><td colspan="${cols}" style="font-size:9px;color:#f8c84a;padding:0 0 1px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">&#8594; ${escapeHtml(p.bodyguard)}</td></tr>`;
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
            // Fast mode — minimal delay, use already-found button reference
            // to avoid re-fetch overhead in competitive busting
            await wait(rand(10, 30));
            if (!target.bustBtn.isConnected) return false;
            target.bustBtn.click();
            addLiveLog(`Bust attempted: ${textOf(target.row.querySelector('a'))} (${target.timerText})`);
        } else {
            await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
            // Re-fetch the button in case the DOM updated
            const freshCandidates = getBustCandidates();
            if (!freshCandidates.length) return false;
            const freshTarget = freshCandidates[0];
            freshTarget.bustBtn.click();
            addLiveLog(`Bust attempted: ${textOf(freshTarget.row.querySelector('a'))} (${freshTarget.timerText})`);
        }

        return true;
    }

    // MutationObserver for instant bust — fires the moment #jailn changes,
    // bypassing the 1200ms heartbeat delay for maximum competitive speed.
    let bustObserver     = null;
    let bustObserverBusy = false;

    function startBustObserver() {
        if (bustObserver) return;

        const jailNode = document.querySelector('#jailn');
        if (!jailNode) return;

        bustObserver = new MutationObserver(async () => {
            // Don't fire if: not in bust mode, already handling a bust,
            // CTC is active, or we're jailed ourselves
            if (!state.bustLoopActive)    return;
            if (!state.bustFastMode)      return; // only active in fast mode
            if (bustObserverBusy)         return;
            if (hasCTCChallenge())        return;
            if (getOwnJailRow())          return;

            const candidates = getBustCandidates();
            if (!candidates.length) return;

            bustObserverBusy = true;
            try {
                state.lastActionAt = now();
                await wait(rand(10, 30));

                // Re-check conditions after minimal delay
                if (!state.bustLoopActive) return;
                if (hasCTCChallenge())     return;
                if (getOwnJailRow())       return;

                const freshCandidates = getBustCandidates();
                if (!freshCandidates.length) return;

                const target = freshCandidates[0];
                if (!target.bustBtn.isConnected) return;

                target.bustBtn.click();
                addLiveLog(`Bust (instant): ${textOf(target.row.querySelector('a'))} (${target.timerText})`);
            } finally {
                bustObserverBusy = false;
            }
        });

        bustObserver.observe(jailNode, { childList: true, subtree: true, characterData: true });
        addLiveLog('Bust observer started (instant mode)');
    }

    function stopBustObserver() {
        if (bustObserver) {
            bustObserver.disconnect();
            bustObserver = null;
        }
        bustObserverBusy = false;
    }

    // ── No Reload Bust — background fetch polling ─────────────────────────────
    let noReloadBustTimer  = null;
    let noReloadBustActive = false;

    function startNoReloadBust() {
        if (noReloadBustActive) return;
        noReloadBustActive = true;
        scheduleNoReloadBustPoll();
    }

    function stopNoReloadBust() {
        noReloadBustActive = false;
        if (noReloadBustTimer) {
            clearTimeout(noReloadBustTimer);
            noReloadBustTimer = null;
        }
    }

    function scheduleNoReloadBustPoll() {
        if (!noReloadBustActive) return;
        const delay = rand(800, 1200);
        noReloadBustTimer = setTimeout(doNoReloadBustPoll, delay);
    }

    async function doNoReloadBustPoll() {
        if (!noReloadBustActive || !state.bustNoReload || !state.enabled) {
            scheduleNoReloadBustPoll();
            return;
        }
        // Pause during CTC or if jailed
        if (hasCTCChallenge() || getOwnJailRow()) {
            scheduleNoReloadBustPoll();
            return;
        }
        try {
            const cache = Math.random();
            const resp = await fetch(`/a/jailn.php?cache=${cache}`, {
                credentials: 'include',
                cache: 'no-store'
            });
            const js = await resp.text();
            // Response is JS: document.getElementById('jailn').innerHTML="..."
            // Extract player names from escaped name="player" value="PLAYERNAME"
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
                    updateStats(s => { s.bustsSuccess = (s.bustsSuccess || 0) + 1; });
                    addLiveLog(`No reload bust: ✓ busted ${player}`);
                } else if (/failed helping/i.test(bustText)) {
                    updateStats(s => { s.bustsFailed = (s.bustsFailed || 0) + 1; });
                }
            }
        } catch (e) {
            // Silent fail — network errors shouldn't stop the loop
        }
        scheduleNoReloadBustPoll();
    }

    async function handleBustPage() {
        stopJailObserver();

        if (!state.bustEnabled) {
            addLiveLog('Bust disabled — returning to crimes');
            state.bustLoopActive = false;
            stopBustObserver();
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

        // Start the instant MutationObserver in fast mode — it fires the moment
        // a new prisoner appears in #jailn, bypassing the heartbeat delay
        if (state.bustFastMode) {
            startBustObserver();
            // Also attempt an immediate bust for any already-present targets
            const didBust = await doBust(true);
            if (!didBust) {
                setLastActionText('Busting: waiting for prisoners (instant mode)');
            }
        } else {
            stopBustObserver();
            const didBust = await doBust(false);
            if (!didBust) {
                setLastActionText('Busting: no targets');
            }
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

        if (drugsUsable && isInternalDriveReady() && !state.killLoopActive) {
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

            addLiveLog(`Melt success confirmed — ${meltLabel}, received ${confirmedBullets} bullets`);

            clearPendingMeltResult();
            resetMeltSearchState();

            // No melt reactivation needed — expectedFoundAt timer and search loop
            // handle kill loop activation when players become available

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

        // Handle pending travel — we've just arrived on a car page to drive somewhere
        // ── Stage: travel — on cars LIST page, find and navigate to best car ──
        if (pending && pending.stage === 'travel' && pending.travelTo) {
            // We should be on the cars list page — find best travel car and navigate to it
            const travelCarUrl = findBestTravelCarUrl();
            if (!travelCarUrl) {
                addLiveLog('Kill loop: no suitable travel car found — clearing');
                state.pendingKillAction = null;
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('kill');
                return;
            }
            addLiveLog(`Kill loop: navigating to car detail page for ${pending.travelTo}`);
            state.pendingKillAction = { ...pending, stage: 'travel_car', travelCarUrl };
            window.location.href = travelCarUrl;
            return;
        }

        // ── Stage: travel_car — on car DETAIL page, repair if needed then drive ──
        if (pending && pending.stage === 'travel_car' && pending.travelTo) {
            const locationValue = getLocationValueForCountry(pending.travelTo);
            if (!locationValue) {
                addLiveLog(`Kill loop: invalid travel target "${pending.travelTo}" — clearing`);
                state.pendingKillAction = null;
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                        await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                        gotoPage('cars');
                        return;
                    }
                    addLiveLog('Kill loop: car too damaged — repairing before travel');
                    state.lastActionAt = now();
                    await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
                    const freshRepair = document.querySelector('form input[type="submit"][name="repair"]');
                    if (freshRepair) freshRepair.click();
                    return; // Page reloads — next tick handles post-repair
                }
            }

            // Check if drive is still on cooldown — the form won't be present if so
            if (!isInternalDriveReady()) {
                const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
                addLiveLog(`Kill loop: drive not ready yet (${remaining}s) — returning to crimes to wait`);
                setLastActionText(`Kill loop: drive in ${remaining}s (waiting for ${pending.travelTo})`);
                // Keep pendingKillAction so we resume travel when drive is ready
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
                return;
            }

            // Drive form should be present — select destination using location radio button
            // Car detail page uses: input[name="location"][value="X"] and input[name="subm"][value="Go"]
            const locationRadio = document.querySelector(`form input[type="radio"][name="location"][value="${locationValue}"]`);
            const goBtn = document.querySelector('form input[type="submit"][name="subm"][value="Go"]');

            if (!locationRadio || !goBtn) {
                addLiveLog('Kill loop: drive form not found on car detail page — drive may still be on cooldown, returning to crimes');
                // Don't clear pendingKillAction — retry when drive is ready
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
                return;
            }

            state.lastActionAt = now();
            await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));

            const freshRadio = document.querySelector(`form input[type="radio"][name="location"][value="${locationValue}"]`);
            const freshGo    = document.querySelector('form input[type="submit"][name="subm"][value="Go"]');
            if (!freshRadio || !freshGo) return;

            freshRadio.checked     = true;
            state.nextDriveReadyAt = now() + 120000;
            freshGo.click();
            addLiveLog(`Kill loop: driving to ${pending.travelTo}`);
            state.pendingKillAction = { stage: 'bgcheck', targetName: pending.targetName, shootAfterBg: pending.shootAfterBg, deferred: pending.deferred }; // travelTo cleared intentionally
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
                renderKillList();
            } else if (hasKillDeadMessage()) {
                killSearchResultHandledThisLoad = true;
                updateKillPlayerStatus(cur, KILL_STATUS.DEAD);
                state.killCurrentSearch = '';
                renderKillList();
            } else if (hasKillSearchStartedMessage()) {
                killSearchResultHandledThisLoad = true;
                updateKillPlayerStatus(cur, KILL_STATUS.ALIVE);
                addLiveLog(`Kill scanner: ${cur} — search started`);
                state.killCurrentSearch = '';
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
                    renderKillList();
                }
            }
        }

        // If penalty was being tracked and has changed, recalculate penaltyDropsAt
        if (state.penaltyDropsAt === 0 && isKillPenaltyTooHigh() && !state.pendingPenaltyPage) {
            // Penalty still too high after timer fired — recalculate
            state.pendingPenaltyPage = true;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('kill-penalty');
            return;
        }

        // Startup: on kill page for penalty reading — navigate to penalty page
        if (state.killPenaltyThreshold > 0 &&
            !state.penaltyDropsAt && !state.pendingPenaltyPage && isKillPenaltyTooHigh()) {
            state.pendingPenaltyPage = true;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('kill-penalty');
            return;
        }

        // Sync expiry data from kill page
        syncKillExpiryFromPage();

        // If penalty exceeds threshold and penaltyDropsAt not set, trigger penalty page
        const livePenalty = getKillPenaltyMultiplier();
        const cached = Number(getSetting('cachedKillPenalty', 1.0));
        if (state.killPenaltyThreshold > 0 && !state.pendingPenaltyPage) {
            const penaltyTooHigh = livePenalty > state.killPenaltyThreshold;
            const penaltyChanged = Math.abs(livePenalty - cached) >= 0.05;
            const needsCalc = !state.penaltyDropsAt || penaltyChanged;
            if (penaltyTooHigh && needsCalc) {
                const reason = penaltyChanged ? `penalty changed (${cached}x → ${livePenalty}x)` : `penalty ${livePenalty}x exceeds threshold`;
                addLiveLog(`Kill loop: ${reason} — navigating to penalty page`);
                state.pendingPenaltyPage = true;
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('kill-penalty');
            return;
        }

        // Handle result of a previous shoot action
        if (pending && pending.stage === 'shoot_result') {
            const target = pending.targetName;
            // Check page for shoot result messages
            const failEl    = document.querySelector('.bgm.fail');
            const successEl  = document.querySelector('.bgm.success, .bgm.cg');
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
                                    state.lastActionAt = now();
                                    await wait(rand(DEFAULTS.actionDelayMin, DEFAULTS.actionDelayMax));
                                    submitBtn.click();
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
                                state.pendingKillAction = {
                                    stage:       'bg_shoot',
                                    targetName:  bgName,
                                    bgFor:       target,
                                    shootAfterBg: isPlayerShootEnabled(target)
                                };
                                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                                gotoPage('kill');
                                return;
                            } else {
                                // Still searching (pending) — let search loop find them, then shoot
                                addLiveLog(`Kill loop: ${bgName} already being searched — will shoot when found`);
                                state.killSearchLoopActive = true;
                            }
                        }

                        // Store bodyguard on target player
                        const tIdx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                        if (tIdx !== -1) { players[tIdx].bodyguard = bgName; players[tIdx].lastBgCheck = now(); }
                        saveKillPlayers(players);
                        renderKillList();
                    }
                    state.pendingKillAction = null;
                    // Go directly to kill page so the search loop immediately searches the bodyguard
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('kill');
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
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('kill');
                    return;
                }

                if (/is protected from death/i.test(text)) {
                    addLiveLog(`Kill loop: ${target} is protected`);
                    updateKillPlayerStatus(target, KILL_STATUS.PROTECTED);
                    state.pendingKillAction = null;
                    renderKillList();
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('crimes');
                    return;
                }

                if (/cannot be killed/i.test(text)) {
                    addLiveLog(`Kill loop: ${target} cannot be killed`);
                    updateKillPlayerStatus(target, KILL_STATUS.UNKILLABLE);
                    state.pendingKillAction = null;
                    renderKillList();
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('crimes');
                    return;
                }
            }

            if (credEl && /failed to kill/i.test(textOf(credEl))) {
                // No bodyguard — BG check complete
                const tName = pending.targetName;
                addLiveLog(`Kill loop: ${tName} has no bodyguard`);
                // Update lastBgCheck
                const players = state.killPlayers || [];
                const idx = players.findIndex(p => p.name.toLowerCase() === tName.toLowerCase());
                if (idx !== -1) {
                    players[idx].lastBgCheck = now();
                    players[idx].bodyguard   = null;
                    saveKillPlayers(players);
                }

                // If shoot toggle is on for this player, proceed to shoot
                if (pending.shootAfterBg) {
                    addLiveLog(`Kill loop: no BG on ${tName} — fetching profile for bullet calc`);
                    state.pendingKillAction = { stage: 'fetch_profile', targetName: tName };
                    // Stay on kill page — profile fetch is async
                    await doKillShootFlow(tName);
                    return;
                }

                state.pendingKillAction = null;
                // Check if there are more actionable targets before going to kill page
                // If none, exit loop directly to avoid an unnecessary kill page trip
                const morePlayers = getKillPlayers().filter(p => {
                    if (p.status !== KILL_STATUS.ALIVE && p.status !== KILL_STATUS.UNKNOWN) return false;
                    if (isPlayerBgCheckEnabled(p.name) && getBgCheckDueMs(p) <= 0) return true;
                    if (!isPlayerShootEnabled(p.name)) return false;
                    if (p.requiredBullets && getPlayerBullets() < p.requiredBullets) return false;
                    if (isPlayerBgCheckEnabled(p.name) && getBgCheckDueMs(p) > 0) return true;
                    if (!isPlayerBgCheckEnabled(p.name)) return true;
                    return false;
                });
                if (!morePlayers.length) {
                    addLiveLog('Kill loop: no more targets — reverting to normal script');
                    state.killLoopActive = false;
                }
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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

                // Check if this was a bodyguard kill — if so, BG check the original target next
                const players = state.killPlayers || [];
                const tIdx = players.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                const wasBg = tIdx !== -1 && players[tIdx].isBg;
                const bgFor = wasBg ? players[tIdx].bgFor : null;

                // Clear bgShootQueued flag — player is dead
                const plsDead = state.killPlayers || [];
                const deadIdx = plsDead.findIndex(p => p.name.toLowerCase() === target.toLowerCase());
                if (deadIdx !== -1 && plsDead[deadIdx].bgShootQueued) { delete plsDead[deadIdx].bgShootQueued; saveKillPlayers(plsDead); }
                updateKillPlayerStatus(target, KILL_STATUS.DEAD);
                renderKillList();

                if (wasBg && bgFor && isPlayerShootEnabled(bgFor)) {
                    // Was a bodyguard kill — re-BG check the original target
                    addLiveLog(`Kill loop: ${target} was BG for ${bgFor} — re-BG checking ${bgFor}`);
                    // Clear bodyguard from original target
                    const bgForIdx = (state.killPlayers || []).findIndex(p => p.name.toLowerCase() === bgFor.toLowerCase());
                    if (bgForIdx !== -1) {
                        const pl = state.killPlayers || [];
                        pl[bgForIdx].bodyguard = null;
                        saveKillPlayers(pl);
                    }
                    state.pendingKillAction = {
                        stage:       'shoot_result',
                        targetName:  bgFor,
                        shootAfterBg: true,
                        recheck:     true  // signal this is a re-BG-check after killing bodyguard
                    };
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('kill');
                    return;
                }

                // Continue kill loop — go back to kill page to process next player
                state.pendingKillAction = null;
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('kill');
                return;
            }

            // Genuinely unknown result — clear and move on
            addLiveLog(`Kill loop: unknown shoot result for ${target} — clearing`);
            state.pendingKillAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
        if (pending && pending.stage === 'bg_shoot') {
            const bgName = pending.targetName;
            const bgFor  = pending.bgFor;

            // If penalty too high, skip the bodyguard shoot — BG check only, no kills
            if (isKillPenaltyTooHigh()) {
                addLiveLog(`Kill loop: penalty too high — skipping bodyguard shoot for ${bgName}`);
                state.pendingKillAction = null;
                // Clear bgShootQueued so it can be re-queued when penalty drops
                const plsBg = state.killPlayers || [];
                const bgIdx = plsBg.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());
                if (bgIdx !== -1) { delete plsBg[bgIdx].bgShootQueued; saveKillPlayers(plsBg); }
                // Don't navigate — let loop continue to next BG-due player
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
                        const rowText = textOf(row);
                        const cm = rowText.match(/in\s+([A-Za-z\s]+?)Lost in/i);
                        if (cm) bgCountry = cm[1].trim();
                        break;
                    }
                } catch (_) {}
            }

            if (!bgCountry) {
                addLiveLog(`Kill loop: bodyguard ${bgName} not in Players Found — waiting for search`);
                state.pendingKillAction = null;
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
                return;
            }

            const myLoc = getPlayerLocation();
            const needsBgTravel = myLoc && bgCountry && myLoc.toLowerCase() !== bgCountry.toLowerCase();

            if (needsBgTravel && !isInternalDriveReady()) {
                const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
                addLiveLog(`Kill loop: drive not ready (${remaining}s) — waiting to travel to bodyguard ${bgName}`);
                setLastActionText(`Kill loop: waiting for drive to shoot BG ${bgName}`);
                // Don't lock into travel stage — clear pending and let the main BG check
                // logic continue processing other due players in the current country
                state.pendingKillAction = null;
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('kill');
                return;
            }

            if (needsBgTravel) {
                addLiveLog(`Kill loop: travelling to ${bgCountry} to shoot bodyguard ${bgName}`);
                state.pendingKillAction = { stage: 'travel', travelTo: bgCountry, targetName: bgName,
                    afterTravel: { stage: 'bg_shoot', targetName: bgName, bgFor, shootAfterBg: pending.shootAfterBg } };
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('cars');
                return;
            }

            // In same country — calculate combined cost before shooting bodyguard
            // Fetch target profile to get bullets needed AFTER killing BG (penalty +0.1x)
            if (pending.shootAfterBg && isPlayerShootEnabled(bgFor)) {
                addLiveLog(`Kill loop: calculating combined cost for ${bgFor} + bodyguard ${bgName}`);
                const targetProfile = await fetchPlayerProfile(bgFor);
                const bgProfile     = await fetchPlayerProfile(bgName);
                if (targetProfile && bgProfile) {
                    const currentMult  = getKillPenaltyMultiplier();
                    const postKillMult = currentMult + 0.1; // penalty after killing BG
                    const bgBulletsBase    = await fetchBulletCount(bgProfile.rankIndex, bgProfile.prestige);
                    const bgBullets        = bgProfile.isVip ? bgBulletsBase * 2 : bgBulletsBase;
                    // Calculate target bullets at elevated penalty by adjusting fetched value
                    // fetchBulletCount already uses live penalty — we simulate +0.1x manually
                    const targetBulletsBase = await fetchBulletCount(targetProfile.rankIndex, targetProfile.prestige);
                    // Re-scale: targetBulletsBase uses currentMult, we need postKillMult
                    // Double if target is VIP
                    const targetBullets = Math.ceil(targetBulletsBase * (postKillMult / currentMult)) * (targetProfile.isVip ? 2 : 1);
                    const totalNeeded  = (bgBullets || 0) + (targetBullets || 0);
                    const available    = getPlayerBullets();
                    addLiveLog(`Kill loop: need ${totalNeeded} bullets total (BG: ${bgBullets}, target at ${postKillMult.toFixed(1)}x: ${targetBullets}) — have ${available}`);
                    // Store required bullets on both players for ordering
                    const pls3 = state.killPlayers || [];
                    const tIdx3 = pls3.findIndex(p => p.name.toLowerCase() === bgFor.toLowerCase());
                    const bIdx3 = pls3.findIndex(p => p.name.toLowerCase() === bgName.toLowerCase());
                    if (tIdx3 !== -1) { pls3[tIdx3].requiredBullets = targetBullets; }
                    if (bIdx3 !== -1) { pls3[bIdx3].requiredBullets = bgBullets; }
                    if (tIdx3 !== -1 || bIdx3 !== -1) saveKillPlayers(pls3);
                    if (available < totalNeeded) {
                        addLiveLog(`Kill loop: insufficient bullets for ${bgFor} + ${bgName} — skipping`);
                        state.pendingKillAction = null;
                        // Clear bgShootQueued so it re-queues when bullets sufficient
                        if (bIdx3 !== -1) { delete pls3[bIdx3].bgShootQueued; saveKillPlayers(pls3); }
                        // Don't navigate — let loop continue to next player
                        return;
                    }
                    // Check penalty won't exceed threshold after killing BG
                    if (state.killPenaltyThreshold > 0 && postKillMult > state.killPenaltyThreshold) {
                        addLiveLog(`Kill loop: killing ${bgName} would push penalty to ${postKillMult.toFixed(1)}x — skipping`);
                        state.pendingKillAction = null;
                        if (bIdx3 !== -1) { delete pls3[bIdx3].bgShootQueued; saveKillPlayers(pls3); }
                        return;
                    }
                }
            }
            // Sufficient bullets — shoot the bodyguard
            addLiveLog(`Kill loop: shooting bodyguard ${bgName}`);
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
            if (!isPlayerBgCheckEnabled(p.name)) return false;
            if (deferred.includes(p.name.toLowerCase())) return true; // deferred always retry
            return getBgCheckDueMs(p) <= 0;
        });

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
            // If BG ticked and interval is due — handle via BG check path, not here
            if (isPlayerBgCheckEnabled(p.name) && getBgCheckDueMs(p) <= 0) return false;
            // Must be in Players Found right now — skip if dead, pending, or not found
            if (!foundMap.has(p.name.toLowerCase())) return false;
            // Skip all kill-only players when penalty too high
            if (isKillPenaltyTooHigh()) return false;
            return true;
        });

        // Sync country data from Players Found so foundMap is always fresh
        syncKillExpiryFromPage();

        // Helper: get country from live Players Found only — no stale p.country fallback
        // If a player isn't in Players Found right now (dead, not yet found, moved),
        // they return empty string and are skipped entirely
        const getPlayerCountry = (p) => foundMap.get(p.name.toLowerCase()) || '';

        // ── Kill-only: Kill ticked, BG not ticked — shoot directly ──────────
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
                    // Set travel stage so tick intercept knows to wait rather than bounce to kill page
                    state.pendingKillAction = { stage: 'travel', travelTo: bestCountry, targetName: tgt.name, shootAfterBg: false, killOnly: true };
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    // Stay on crimes — tick intercept will wait until drive is ready
                    return;
                }
                addLiveLog(`Kill loop: travelling to ${bestCountry} for kill-only player ${tgt.name}`);
                state.pendingKillAction = { stage: 'travel', travelTo: bestCountry, targetName: tgt.name, shootAfterBg: false, killOnly: true };
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('cars');
                return;
            }
            // Kill-only players not in Players Found — exit loop, reactivate when found
            addLiveLog('Kill loop: kill-only players not yet in Players Found — reverting to normal script');
            state.killLoopActive    = false;
            state.pendingKillAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // ── BG check targets ─────────────────────────────────────────────────
        if (!duePlayers.length) {
            addLiveLog('Kill loop: no actionable targets — reverting to normal script');
            state.killLoopActive    = false;
            state.pendingKillAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        // Check if we need to travel
        const needsTravel = myLocation && targetCountry &&
            myLocation.toLowerCase() !== targetCountry.toLowerCase();

        if (needsTravel && !isInternalDriveReady()) {
            const remaining = Math.ceil(getInternalDriveRemainingMs() / 1000);
            addLiveLog(`Kill loop: drive not ready (${remaining}s) — waiting before travelling to ${targetCountry}`);
            setLastActionText(`Kill loop: waiting for drive (${remaining}s)`);
            // Set travel stage so tick intercept waits rather than bouncing to kill page
            state.pendingKillAction = { stage: 'travel', travelTo: targetCountry, targetName: bgTarget.name,
                shootAfterBg: isPlayerShootEnabled(bgTarget.name), deferred };
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            return;
        }

        if (needsTravel) {
            addLiveLog(`Kill loop: travelling to ${targetCountry} (${byCountry.get(targetCountry).length} player(s) to check)`);
            state.pendingKillAction = { stage: 'travel', travelTo: targetCountry, targetName: bgTarget.name,
                shootAfterBg: isPlayerShootEnabled(bgTarget.name), deferred };
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
            setLastActionText('Kill loop paused — no bullets');
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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
                submitBtn.click();
                addLiveLog(`Kill loop: BG check shot fired at ${bgTarget.name}`);
                return;
            }
        }

        addLiveLog('Kill loop: shoot form not found — retrying next tick');
        state.pendingKillAction = null;
    }

    // Handles the full shoot flow — shoots targetName, then BG checks bgFor if set
    async function doKillShootFlow(targetName, bgFor = null) {
        // Block all kills when penalty too high — only BG check shots (1 bullet) are allowed
        if (isKillPenaltyTooHigh()) {
            addLiveLog(`Kill loop: penalty too high — skipping kill of ${targetName}`);
            state.pendingKillAction = null;
            // Don't navigate away — let handleKillLoopPage continue to next BG-due player
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
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('crimes');
            return;
        }

        addLiveLog(`Kill loop: ${targetName} is rank index ${profile.rankIndex}, prestige ${profile.prestige}${profile.isVip ? ' (VIP)' : ''}`);

        // Fetch bullet count from calculator
        const bulletCount = await fetchBulletCount(profile.rankIndex, profile.prestige);
        if (!bulletCount) {
            addLiveLog(`Kill loop: could not calculate bullets for ${targetName} — skipping`);
            state.pendingKillAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
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

        // Check available bullets — if not enough, skip this player and try next
        const available = getPlayerBullets();
        if (available < requiredBullets) {
            addLiveLog(`Kill loop: insufficient bullets (${available}/${requiredBullets}) for ${targetName} — waiting for more bullets`);
            setLastActionText(`Kill loop: need ${requiredBullets} bullets for ${targetName}, have ${available}`);
            // Clear bgShootQueued so it re-queues when bullets are sufficient
            const plsBQ = state.killPlayers || [];
            const bqIdx = plsBQ.findIndex(p => p.name.toLowerCase() === targetName.toLowerCase());
            if (bqIdx !== -1 && plsBQ[bqIdx].bgShootQueued) { delete plsBQ[bqIdx].bgShootQueued; saveKillPlayers(plsBQ); }
            state.pendingKillAction = null;
            await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
            gotoPage('kill'); // Continue loop — check other players
            return;
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
                usernameSelect.value = targetName;
                bulletsInput.value   = String(requiredBullets);
                if (showCheckbox) showCheckbox.checked = !state.killAnonymousShooting;
                submitBtn.click();
                addLiveLog(`Kill loop: kill shot fired at ${targetName} (${requiredBullets} bullets)`);
                return;
            }
        }

        addLiveLog('Kill loop: shoot form not found for kill shot — retrying');
        state.pendingKillAction = null;
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
            // If we came from kill loop travel, return to kill page
            if (state.killLoopActive) {
                addLiveLog('Repair done — resuming kill loop');
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('kill');
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

        // ── Kill penalty page — handle immediately, skip all other tick logic ──
        // Prevents any other navigation (search loop, online scanner etc.) from
        // navigating away before the penalty page is parsed.
        if (isKillPenaltyPage() && state.killPenaltyThreshold > 0) {
            loopBusy = true;
            try {
                updatePanel();
                state.pendingPenaltyPage = false;
                state.penaltyDropsAt = calcPenaltyDropsAt();
                await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                gotoPage('crimes');
            } finally { loopBusy = false; }
            return;
        }

        // ── Dedicated loop intercepts ─────────────────────────────────────────
        // When a reset loop is active the bot ignores all other page logic and
        // routes exclusively to the relevant page. Jail handling is still active
        // so the bot can leave jail and return to the loop immediately.

        // Kill loop — BG check and shoot mode, runs alongside or instead of kill search
        if (state.killLoopActive) {
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
            const kpa = state.pendingKillAction;
            const needsDrive = kpa && (kpa.stage === 'travel' || kpa.stage === 'travel_car');
            if (needsDrive && !isInternalDriveReady()) {
                // Let normal script handle this tick — don't bounce to kill page
                const remSec = Math.ceil(getInternalDriveRemainingMs() / 1000);
                setLastActionText(`Kill loop: waiting for drive (${remSec}s)`);
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
                    window.location.href = kpending.travelCarUrl;
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
            if (!isKillPage() && !isKillPenaltyPage()) {
                addLiveLog('Kill loop: navigating to kill page');
                gotoPage('kill');
                return;
            }
            loopBusy = true;
            try { updatePanel(); await handleKillLoopPage(); } finally { loopBusy = false; }
            return;
            } // end drive-ready else block
        }

        // Kill search mode — only runs when kill loop is not mid-chain
        // Kill loop takes priority: if there is a pending kill action in progress,
        // reactivate the kill loop rather than letting the search loop interrupt.
        if (!state.killLoopActive && state.pendingKillAction && state.killBgCheckEnabled) {
            const pa = state.pendingKillAction;
            if (pa.stage && pa.stage !== 'bgcheck') {
                // Mid-chain — reactivate kill loop
                // BG check chains always allowed; kill-only blocked later in doKillShootFlow
                if (!isKillPenaltyTooHigh() || pa.stage === 'bg_shoot' || pa.stage === 'travel') {
                    state.killLoopActive = true;
                }
            }
        }

        // Kill search mode — dedicated loop, searches players one by one
        // Also runs if kill loop is active but waiting for drive (needsDrive && !driveReady)
        const killLoopWaitingForDrive = state.killLoopActive &&
            state.pendingKillAction &&
            (state.pendingKillAction.stage === 'travel' || state.pendingKillAction.stage === 'travel_car') &&
            !isInternalDriveReady();
        if (state.killSearchLoopActive && (!state.killLoopActive || killLoopWaitingForDrive)) {
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
                !state.meltResetLoopActive && !state.resetCrimesEnabled && !isKillPenaltyPage()) {
                addLiveLog('Kill scanner: online scan due — navigating to Players Online');
                gotoPage('online');
                return;
            }

            // Penalty drop timer — navigate to kill page when penalty should have dropped
            if (state.penaltyDropsAt && now() >= state.penaltyDropsAt &&
                !state.killLoopActive && !state.bustLoopActive && !isKillPage() && !isKillPenaltyPage()) {
                addLiveLog('Kill loop: penalty drop timer elapsed — checking kill page');
                state.penaltyDropsAt = 0;
                gotoPage('kill');
                return;
            }

            // Bodyguard expected found — navigate to kill page when timer elapses
            if (state.killBgCheckEnabled && !state.killLoopActive && !state.bustLoopActive &&
                !state.gtaResetLoopActive && !state.meltResetLoopActive && !isKillPage()) {
                const playerReady = getKillPlayers().some(p =>
                    p.expectedFoundAt && now() >= p.expectedFoundAt
                );
                if (playerReady) {
                    // Clear expectedFoundAt — visit kill page once
                    // syncKillExpiryFromPage will handle reactivation if player is in Players Found
                    const pls = state.killPlayers || [];
                    pls.forEach(p => {
                        if (p.expectedFoundAt && now() >= p.expectedFoundAt) {
                            delete p.expectedFoundAt;
                        }
                    });
                    saveKillPlayers(pls);
                    if (!isKillPenaltyTooHigh()) {
                        addLiveLog('Kill loop: player search timer elapsed — navigating to kill page');
                        gotoPage('kill');
                        return;
                    }
                }
            }

            // Kill penalty page handled at top of tick — nothing to do here

            if (isBankPage()) {
                await handleBankPage();
                return;
            }

            if (isDrugsPage() || hasDrugsPageMarkers()) {
                if (state.killLoopActive) {
                    // Kill loop takes priority — drive timer is shared, return to kill page
                    await wait(rand(DEFAULTS.navDelayMin, DEFAULTS.navDelayMax));
                    gotoPage('kill');
                    return;
                }
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

    let protectedRecheckHandle = null;

    function startHeartbeat() {
        stopHeartbeat();
        startRuntimeIfNeeded();
        heartbeatHandle = setInterval(() => tick(), DEFAULTS.heartbeatMs);
        setTimeout(() => tick(), 400);
        addLiveLog('Heartbeat started');
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
                addLiveLog('Kill scanner: protected recheck due — activating search');
                state.killSearchLoopActive = true;
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
        const newBustEnabled  = bustEnabledInput    ? bustEnabledInput.checked    : state.bustEnabled;
        const newBustNoReload = bustNoReloadInput  ? bustNoReloadInput.checked  : state.bustNoReload;
        // Mutual exclusivity — no reload bust vs enable bust
        if (newBustNoReload && !state.bustNoReload) {
            // Switching to no reload — disable enable bust
            state.bustEnabled  = false;
            state.bustFastMode = false;
            if (bustEnabledInput)  bustEnabledInput.checked  = false;
            if (bustFastModeInput) bustFastModeInput.checked = false;
        } else if (newBustEnabled && !state.bustEnabled && state.bustNoReload) {
            // Switching to enable bust — disable no reload
            state.bustNoReload = false;
            if (bustNoReloadInput) bustNoReloadInput.checked = false;
        } else {
            state.bustEnabled  = newBustEnabled;
            state.bustFastMode = bustFastModeInput ? bustFastModeInput.checked : state.bustFastMode;
        }
        state.bustNoReload = bustNoReloadInput ? bustNoReloadInput.checked : state.bustNoReload;
        if (killProtectedRecheckInput)  state.killProtectedRecheckEnabled = killProtectedRecheckInput.checked;
        if (killProtectedRecheckMinsEl) state.killProtectedRecheckMins    = Number(killProtectedRecheckMinsEl.value) || DEFAULTS.killProtectedRecheckMins;
        state.killScanOnlineEnabled  = killScanOnlineInput   ? killScanOnlineInput.checked   : state.killScanOnlineEnabled;
        state.killScanOnlineInterval = killScanIntervalEl    ? Number(killScanIntervalEl.value) : state.killScanOnlineInterval;
        state.killSearchEnabled      = killSearchInput       ? killSearchInput.checked       : state.killSearchEnabled;
        state.killBgCheckEnabled     = killBgCheckInput      ? killBgCheckInput.checked      : state.killBgCheckEnabled;
        state.killShootEnabled       = killShootInput        ? killShootInput.checked        : state.killShootEnabled;
        state.killAnonymousShooting  = killAnonymousInput    ? killAnonymousInput.checked    : state.killAnonymousShooting;
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
            const hasBgTargets = (state.killBgCheckPlayers || []).length > 0;
            if (hasBgTargets) state.killLoopActive = true;
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
        state.bustLoopActive       = state.bustEnabled;
        // Start or stop no reload bust background loop
        if (state.bustNoReload) {
            startNoReloadBust();
        } else {
            stopNoReloadBust();
        }
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
                            <label class="ug-action-label" style="margin-top:6px;">
                                <input id="ug-bot-bust-noreload" type="checkbox" />
                                No reload bust — busts in background via fetch, no page navigation needed
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
                            <div class="ug-helptext" style="margin-bottom:6px;">Periodically visits the Players Online page and adds new players to the list. Runs in the background during normal script operation only &mdash; not during dedicated modes.</div>
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
                        <div class="ug-section-box">
                            <div class="ug-section-title">Protected Player Re-search</div>
                            <div class="ug-helptext" style="margin-bottom:6px;">Additionally re-searches protected players at a set interval. Only active when Search Players is enabled. Does not replace the existing search cycle.</div>
                            <label class="ug-action-label">
                                <input id="ug-bot-kill-protected-recheck" type="checkbox" />
                                Additionally search protected players
                            </label>
                            <div style="margin-top:6px;">
                                <div class="ug-subtitle" style="margin-bottom:4px;">Re-search interval</div>
                                <select id="ug-bot-kill-protected-recheck-mins" data-role="none" style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #555;border-radius:6px;background:#111;color:#fff;font-size:12px;">
                                    <option value="1">Every 1 minute</option>
                                    <option value="2">Every 2 minutes</option>
                                    <option value="3">Every 3 minutes</option>
                                    <option value="4">Every 4 minutes</option>
                                    <option value="5">Every 5 minutes</option>
                                    <option value="6">Every 6 minutes</option>
                                    <option value="7">Every 7 minutes</option>
                                    <option value="8">Every 8 minutes</option>
                                    <option value="9">Every 9 minutes</option>
                                    <option value="10">Every 10 minutes</option>
                                    <option value="11">Every 11 minutes</option>
                                    <option value="12">Every 12 minutes</option>
                                    <option value="13">Every 13 minutes</option>
                                    <option value="14">Every 14 minutes</option>
                                    <option value="15">Every 15 minutes</option>
                                    <option value="16">Every 16 minutes</option>
                                    <option value="17">Every 17 minutes</option>
                                    <option value="18">Every 18 minutes</option>
                                    <option value="19">Every 19 minutes</option>
                                    <option value="20">Every 20 minutes</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="ug-row">
                        <div class="ug-section-box">
                            <div class="ug-section-title">BG Check &amp; Shoot</div>
                            <div class="ug-helptext" style="margin-bottom:6px;">Travels to found players and shoots 1 bullet to check for bodyguards. Tick BG check per-player in the list below. Drug running pauses during travel.</div>
                            <label class="ug-action-label">
                                <input id="ug-bot-kill-bgcheck" type="checkbox" />
                                Enable BG check loop
                            </label>
                            <label class="ug-action-label">
                                <input id="ug-bot-kill-anonymous" type="checkbox" />
                                Shoot anonymously (hide your name)
                            </label>
                            <div style="margin-top:6px;">
                                <div class="ug-subtitle" style="margin-bottom:4px;">BG check interval</div>
                                <select id="ug-bot-kill-bgcheck-interval" data-role="none" style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #555;border-radius:6px;background:#111;color:#fff;font-size:12px;">
                                    <option value="1">1 hour</option>
                                    <option value="2">2 hours</option>
                                    <option value="3">3 hours</option>
                                    <option value="4">4 hours</option>
                                    <option value="5">5 hours</option>
                                    <option value="6">6 hours</option>
                                    <option value="7">7 hours</option>
                                    <option value="8">8 hours</option>
                                    <option value="9">9 hours</option>
                                    <option value="10">10 hours</option>
                                    <option value="11">11 hours</option>
                                    <option value="12">12 hours</option>
                                    <option value="13">13 hours</option>
                                    <option value="14">14 hours</option>
                                    <option value="15">15 hours</option>
                                    <option value="16">16 hours</option>
                                    <option value="17">17 hours</option>
                                    <option value="18">18 hours</option>
                                    <option value="19">19 hours</option>
                                    <option value="20">20 hours</option>
                                    <option value="21">21 hours</option>
                                    <option value="22">22 hours</option>
                                    <option value="23">23 hours</option>
                                    <option value="24">24 hours</option>
                                </select>
                            </div>
                            <div style="margin-top:6px;">
                                <div class="ug-subtitle" style="margin-bottom:4px;">Kill penalty threshold (0 = disabled)</div>
                                <input id="ug-bot-kill-penalty-threshold" type="text" inputmode="decimal" placeholder="e.g. 1.5" style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #555;border-radius:6px;background:#111;color:#fff;font-size:12px;" />
                                <div class="ug-helptext">Pause kill loop if penalty multiplier exceeds this. BG check loop continues regardless.</div>
                            </div>
                        </div>
                    </div>
                    <div class="ug-row">
                        <div class="ug-section-box" style="padding:0;border:none;background:none;">
                            <div class="ug-subtitle" style="margin-bottom:6px;">Player list <span id="ug-bot-kill-count" style="font-weight:normal;color:#aaa;font-size:11px;"></span></div>
                            <div id="ug-bot-kill-list" class="ug-kill-list"></div>
                            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                                <button id="ug-bot-kill-clear" type="button" style="font-size:11px;padding:4px 8px;">Clear list</button>
                                <button id="ug-bot-kill-copy" type="button" style="font-size:11px;padding:4px 8px;">Copy names</button>
                                <button id="ug-bot-kill-select-all-bg" type="button" style="font-size:11px;padding:4px 8px;">All BG</button>
                                <button id="ug-bot-kill-select-all-shoot" type="button" style="font-size:11px;padding:4px 8px;">All Kill</button>
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
                        <div class="ug-row" style="margin-bottom:6px;display:flex;gap:6px;">
                            <button id="ug-bot-copy-log" type="button" style="font-size:11px;padding:4px 8px;">Copy log</button>
                            <button id="ug-bot-clear-log" type="button" style="font-size:11px;padding:4px 8px;">Clear log</button>
                        </div>
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
                overflow-x: hidden;
                background: #111;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 6px;
                font-size: 11px;
                text-align: left;
            }
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
        bustNoReloadInput           = document.querySelector('#ug-bot-bust-noreload');
        killProtectedRecheckInput   = document.querySelector('#ug-bot-kill-protected-recheck');
        killProtectedRecheckMinsEl  = document.querySelector('#ug-bot-kill-protected-recheck-mins');

        killScanOnlineInput      = document.querySelector('#ug-bot-kill-scan-online');
        killScanIntervalEl       = document.querySelector('#ug-bot-kill-scan-interval');
        killSearchInput          = document.querySelector('#ug-bot-kill-search');
        killBgCheckInput         = document.querySelector('#ug-bot-kill-bgcheck');

        // Immediately update scan/search disabled state when BG loop checkbox changes
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

        killShootInput           = document.querySelector('#ug-bot-kill-shoot');
        killAnonymousInput       = document.querySelector('#ug-bot-kill-anonymous');
        killBgCheckIntervalEl    = document.querySelector('#ug-bot-kill-bgcheck-interval');
        killPenaltyThresholdEl   = document.querySelector('#ug-bot-kill-penalty-threshold');
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
        if (bustNoReloadInput) {
            bustNoReloadInput.checked = state.bustNoReload;
        }
        if (killProtectedRecheckInput)  killProtectedRecheckInput.checked = state.killProtectedRecheckEnabled;
        if (killProtectedRecheckMinsEl) {
            killProtectedRecheckMinsEl.value = String(state.killProtectedRecheckMins);
        }


        // Grey out scan/search when BG loop is on.
        // Must sync the checkbox first so its .checked reflects persisted state,
        // then read it back — this way unticking immediately re-enables them
        // AND the persisted on state greys them out on page load.
        if (killBgCheckInput) killBgCheckInput.checked = state.killBgCheckEnabled;
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
        if (killShootInput)       killShootInput.checked      = state.killShootEnabled;
        if (killAnonymousInput)   killAnonymousInput.checked  = state.killAnonymousShooting;
        if (killBgCheckIntervalEl) killBgCheckIntervalEl.value = String(state.killBgCheckIntervalHrs);
        if (killPenaltyThresholdEl) killPenaltyThresholdEl.value = state.killPenaltyThreshold > 0 ? String(state.killPenaltyThreshold) : '';

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
            } else if (e.target === bustNoReloadInput && bustNoReloadInput.checked) {
                // No reload bust enabled — uncheck enable bust and fast bust
                if (bustEnabledInput)  { bustEnabledInput.checked  = false; }
                if (bustFastModeInput) { bustFastModeInput.checked = false; }
                const label = bustFastModeInput ? bustFastModeInput.closest('.ug-fast-mode-label') : null;
                if (label) label.classList.add('ug-disabled-sub');
                saveSettings();
            } else if (e.target === bustEnabledInput && bustEnabledInput.checked) {
                // Enable bust enabled — uncheck no reload bust
                if (bustNoReloadInput) { bustNoReloadInput.checked = false; }
                saveSettings();
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
                // Designate this window as the bot window
                window.name = 'ug-bot';
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
                state.liveLog = [];
                renderLiveLog();
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

        // Kill scanner — Select All BG button
        const killSelectAllBgBtn = document.querySelector('#ug-bot-kill-select-all-bg');
        if (killSelectAllBgBtn) {
            killSelectAllBgBtn.addEventListener('click', () => {
                const players = getKillPlayers().filter(p =>
                    p.status === KILL_STATUS.ALIVE || p.status === KILL_STATUS.UNKNOWN
                );
                const allOn = players.every(p => isPlayerBgCheckEnabled(p.name));
                for (const p of players) setPlayerBgCheckEnabled(p.name, !allOn);
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

        // ── Window identity check ─────────────────────────────────────────────
        // Only run in windows explicitly designated as the bot window via the
        // activate button. window.name persists across page navigations within
        // the same window but starts empty in any new window.
        if (window.name !== 'ug-bot') {
            // Not designated — show a minimal activate button, stay dormant
            const existing = document.querySelector('#ug-bot-activate');
            if (!existing) {
                const btn = document.createElement('div');
                btn.id = 'ug-bot-activate';
                btn.textContent = '⚙ UG Bot';
                btn.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#222;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;z-index:99999;border:1px solid #555;';
                btn.title = 'Click to activate UG Bot in this window';
                btn.addEventListener('click', () => {
                    window.name = 'ug-bot';
                    btn.remove();
                    init();
                });
                document.body.appendChild(btn);
            }
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
        // Start or stop no reload bust background loop
        if (state.bustNoReload) {
            startNoReloadBust();
        } else {
            stopNoReloadBust();
        }
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
                if (!isPlayerBgCheckEnabled(p.name)) return false;
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
                if (isPlayerBgCheckEnabled(p.name) && getBgCheckDueMs(p) <= 0) return false;
                // If on kill page, only activate if player is actually in Players Found
                if (canCheckFound) return foundNames && foundNames.has(p.name.toLowerCase());
                // If not on kill page, only activate if expectedFoundAt has elapsed
                // (player should now be in Players Found) — don't activate based on stale data
                if (!p.expectedFoundAt) return false;
                return now() >= p.expectedFoundAt;
            });
            // Allow kill loop for BG checks even when penalty too high
            // Kill-only players are blocked by doKillShootFlow when penalty exceeded
            state.killLoopActive = hasDueBgCheck || (!isKillPenaltyTooHigh() && hasKillOnly);
        }

        updateStats(s => { s.pageLoads += 1; });

        // Penalty page navigation is handled within handleKillPage / handleKillLoopPage
        // to avoid race conditions with the search loop tick

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
