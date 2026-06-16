var bridge;
var cardTypes = [];
var decks = [];
var fieldCounter = 0;
var createCardPreselectedDeckId = null;
var currentAccent = '#aa00ff';
var currentFontSize = 'medium';
var FONT_SIZE_MAP = { small: '1.5rem', medium: '2.5rem', large: '4rem' };
var collapsedDecks = new Set();
var deckCollapseInitialized = false;

new QWebChannel(qt.webChannelTransport, function(channel) {
    bridge = channel.objects.bridge;
    bridge.refreshStats();
    bridge.getAppSettings();
    bridge.getDecks();
    bridge.getMediaBaseUrl();
    bridge.getAppInfo();
    bridge.getExtensionToken();
    bridge.checkForUpdates(false);  // silent startup check; backend honours the setting
});

// Theme presets - the accent family applied app-wide (and mirrored by the
// browser extension via the get_theme WS action). 'violet' is the historical
// default look. Keys are persisted in settings.json, so renaming one needs a
// migration. Deprecates the old free-form accent_color picker; accent_color is
// still written (= theme accent) for anything legacy that reads it.
var THEMES = {
    violet:  { name: 'Neon Violet', accent: '#aa00ff', dark: '#7f00bf', light: '#cc66ff', rgb: '170, 0, 255', lightRgb: '204, 102, 255' },
    ocean:   { name: 'Ocean',       accent: '#2563eb', dark: '#1d4ed8', light: '#60a5fa', rgb: '37, 99, 235', lightRgb: '96, 165, 250' },
    emerald: { name: 'Emerald',     accent: '#059669', dark: '#047857', light: '#34d399', rgb: '5, 150, 105', lightRgb: '52, 211, 153' },
    sunset:  { name: 'Sunset',      accent: '#ea580c', dark: '#c2410c', light: '#fb923c', rgb: '234, 88, 12', lightRgb: '251, 146, 60' },
    sakura:  { name: 'Sakura',      accent: '#db2777', dark: '#be185d', light: '#f472b6', rgb: '219, 39, 119', lightRgb: '244, 114, 182' },
};
var currentTheme = 'violet';
var currentMode = 'light';

function applyThemeVars(themeId, mode) {
    var t = THEMES[themeId] || THEMES.violet;
    var root = document.documentElement;
    root.style.setProperty('--accent', t.accent);
    root.style.setProperty('--accent-dark', t.dark);
    root.style.setProperty('--accent-light', t.light);
    root.style.setProperty('--accent-rgb', t.rgb);
    root.style.setProperty('--accent-light-rgb', t.lightRgb);
    root.style.setProperty('--accent-dim', 'rgba(' + t.rgb + (mode === 'dark' ? ', 0.16)' : ', 0.1)'));
    root.setAttribute('data-mode', mode === 'dark' ? 'dark' : 'light');
    currentAccent = t.accent;  // legacy var, still used for chart/badge inline colours
}

// Migration: installs that saved a custom accent_color before themes existed
// snap to the theme with that exact accent, else the default.
function themeFromSettings(settings) {
    if (settings.theme && THEMES[settings.theme]) return settings.theme;
    var legacy = (settings.accent_color || '').toLowerCase();
    for (var id in THEMES) {
        if (THEMES[id].accent.toLowerCase() === legacy) return id;
    }
    return 'violet';
}

function applyAppSettings(settings) {
    currentTheme = themeFromSettings(settings);
    currentMode = settings.ui_mode === 'dark' ? 'dark' : 'light';
    applyThemeVars(currentTheme, currentMode);
    currentFontSize = settings.font_size || 'medium';
    document.documentElement.style.setProperty('--review-font-size', FONT_SIZE_MAP[currentFontSize] || '2.5rem');
    currentSRSDefaults = {
        new_cards_limit: settings.default_new_cards_limit !== undefined ? settings.default_new_cards_limit : 15,
        learning_steps: settings.default_learning_steps || '1 10',
        relearning_steps: settings.default_relearning_steps || '10',
        study_order: settings.default_study_order || 'new_first',
        day_start_hour: settings.day_start_hour !== undefined ? settings.day_start_hour : 4,
        scheduler: settings.default_scheduler || 'sm2',
        desired_retention: settings.default_desired_retention !== undefined ? settings.default_desired_retention : 0.9,
    };
    currentReviewBehavior = {
        autoplay_audio: settings.review_autoplay_audio !== undefined ? settings.review_autoplay_audio : true,
        shortcut_enabled: settings.review_shortcut_enabled !== undefined ? settings.review_shortcut_enabled : true,
        shortcut_key: settings.review_shortcut_key || 'Space',
        two_button_mode: settings.review_two_button_mode || false,
    };
    currentUpdatePrefs = {
        check_enabled: settings.update_check_enabled !== undefined ? settings.update_check_enabled : true,
    };
    applyRatingButtonMode();
}

var currentSRSDefaults = { new_cards_limit: 15, learning_steps: '1 10', relearning_steps: '10', study_order: 'new_first', day_start_hour: 4, scheduler: 'sm2', desired_retention: 0.9 };
var currentReviewBehavior = { autoplay_audio: true, shortcut_enabled: true, shortcut_key: 'Space', two_button_mode: false };
var currentUpdatePrefs = { check_enabled: true };
var capturingKey = false;

function getKeyDisplayName(code) {
    if (code === 'Space') return 'Space';
    if (code === 'Enter') return 'Enter';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Arrow')) return { Left: '←', Right: '→', Up: '↑', Down: '↓' }[code.slice(5)] || code;
    return code;
}

function startKeyCapture() {
    if (capturingKey) return;
    capturingKey = true;
    var btn = document.getElementById('shortcut-key-btn');
    btn.textContent = 'Press a key…';
    btn.style.outline = '2px solid var(--accent)';
    function onKey(e) {
        if (e.code === 'Escape') {
            btn.textContent = getKeyDisplayName(currentReviewBehavior.shortcut_key);
            btn.style.outline = '';
            capturingKey = false;
            document.removeEventListener('keydown', onKey, true);
            return;
        }
        var disallowed = ['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','Tab'];
        if (disallowed.includes(e.code)) return;
        e.preventDefault();
        e.stopPropagation();
        currentReviewBehavior.shortcut_key = e.code;
        btn.textContent = getKeyDisplayName(e.code);
        btn.style.outline = '';
        capturingKey = false;
        document.removeEventListener('keydown', onKey, true);
    }
    document.addEventListener('keydown', onKey, true);
}

// Pending (unsaved) appearance choices while the settings page is open.
var pendingTheme = null;
var pendingMode = null;

function renderThemeSwatches() {
    var wrap = document.getElementById('settings-theme-swatches');
    if (!wrap) return;
    wrap.innerHTML = '';
    Object.keys(THEMES).forEach(function(id) {
        var t = THEMES[id];
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theme-swatch' + ((pendingTheme || currentTheme) === id ? ' is-active' : '');
        btn.dataset.theme = id;
        btn.style.setProperty('--swatch-color', t.accent);
        btn.style.setProperty('--swatch-light', t.light);
        var dot = document.createElement('span');
        dot.className = 'theme-swatch-dot';
        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(t.name));
        btn.addEventListener('click', function() { previewTheme(id); });
        wrap.appendChild(btn);
    });
}

function syncModeButtons() {
    var mode = pendingMode || currentMode;
    document.querySelectorAll('#settings-mode-toggle .mode-btn').forEach(function(b) {
        b.classList.toggle('is-active', b.dataset.mode === mode);
    });
}

// Live preview: applied immediately, persisted only on Save.
function previewTheme(id) {
    pendingTheme = id;
    applyThemeVars(id, pendingMode || currentMode);
    renderThemeSwatches();
}

function previewMode(mode) {
    pendingMode = mode;
    applyThemeVars(pendingTheme || currentTheme, mode);
    syncModeButtons();
}

function showAppSettings() {
    pendingTheme = currentTheme;
    pendingMode = currentMode;
    renderThemeSwatches();
    syncModeButtons();
    document.getElementById('settings-font-size').value = currentFontSize;
    document.getElementById('srs-default-new-limit').value = currentSRSDefaults.new_cards_limit;
    document.getElementById('srs-default-learning-steps').value = currentSRSDefaults.learning_steps;
    document.getElementById('srs-default-relearning-steps').value = currentSRSDefaults.relearning_steps;
    document.getElementById('srs-default-study-order').value = currentSRSDefaults.study_order;
    document.getElementById('srs-default-scheduler').value = currentSRSDefaults.scheduler || 'sm2';
    document.getElementById('srs-default-retention').value = (currentSRSDefaults.desired_retention != null ? currentSRSDefaults.desired_retention : 0.9);
    var hourSelect = document.getElementById('srs-day-start-hour');
    if (hourSelect.options.length === 0) {
        for (var h = 0; h < 24; h++) {
            var opt = document.createElement('option');
            opt.value = h;
            var ampm = h === 0 ? '12:00 AM' : h < 12 ? h + ':00 AM' : h === 12 ? '12:00 PM' : (h - 12) + ':00 PM';
            opt.textContent = ampm;
            hourSelect.appendChild(opt);
        }
    }
    hourSelect.value = currentSRSDefaults.day_start_hour;
    document.getElementById('review-autoplay-audio').checked = currentReviewBehavior.autoplay_audio;
    document.getElementById('review-shortcut-enabled').checked = currentReviewBehavior.shortcut_enabled;
    document.getElementById('shortcut-key-btn').textContent = getKeyDisplayName(currentReviewBehavior.shortcut_key);
    document.getElementById('review-two-button-mode').checked = currentReviewBehavior.two_button_mode;
    var updEl = document.getElementById('update-check-enabled');
    if (updEl) updEl.checked = currentUpdatePrefs.check_enabled;
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function updateDataInfo(info) {
    var pathEl = document.getElementById('data-db-path');
    if (pathEl) pathEl.textContent = info.db_path;
    var sizeEl = document.getElementById('data-db-size');
    if (sizeEl) sizeEl.textContent = formatBytes(info.db_size_bytes);
    var statsEl = document.getElementById('data-stats');
    if (statsEl) statsEl.textContent = info.deck_count + ' decks · ' + info.card_count + ' cards · ' + info.review_count + ' reviews';
}


// ===== Updates =====

var currentAppVersion = '';
var pendingUpdate = null;

function applyAppInfo(info) {
    currentAppVersion = info.version || '';
    var el = document.getElementById('about-version');
    if (el) el.textContent = 'Version ' + currentAppVersion;
}

function applyExtensionToken(token) {
    var el = document.getElementById('ext-token-value');
    if (el) el.textContent = token || '(unavailable)';
}

function copyExtensionToken() {
    if (bridge) bridge.copyExtensionToken();
    var btn = document.getElementById('ext-token-copy');
    if (btn) {
        var original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = original; }, 1400);
    }
}

function onUpdateCheckResult(data) {
    if (data.error) {
        if (data.manual) showAlert('Could not check for updates: ' + data.error);
        return;
    }
    if (!data.available) {
        if (data.manual) showAlert("You're running the latest version (v" + currentAppVersion + ').');
        return;
    }
    pendingUpdate = data;
    showUpdateModal(data);
}

function showUpdateModal(data) {
    document.getElementById('update-modal-version').textContent =
        'Version ' + data.version + ' is available (you have ' + currentAppVersion + ').';
    var notesEl = document.getElementById('update-modal-notes');
    notesEl.textContent = (data.notes || '').trim() || 'No release notes provided.';
    // Reset to the prompt state (hide progress, show action buttons).
    document.getElementById('update-modal-progress').style.display = 'none';
    document.getElementById('update-modal-actions').style.display = 'flex';
    document.getElementById('update-modal-status').textContent = '';
    var bar = document.getElementById('update-modal-bar');
    bar.style.width = '0%';
    var modalEl = document.getElementById('update-modal');
    blurActiveElement(modalEl);
    new bootstrap.Modal(modalEl).show();
}

function updateNow() {
    if (!pendingUpdate || !bridge) return;
    // Switch to the downloading state.
    document.getElementById('update-modal-actions').style.display = 'none';
    document.getElementById('update-modal-progress').style.display = 'block';
    document.getElementById('update-modal-status').textContent =
        pendingUpdate.download_url ? 'Downloading update…' : 'Opening download page…';
    bridge.downloadUpdate(pendingUpdate.download_url || '', pendingUpdate.asset_name || '');
    if (!pendingUpdate.download_url) {
        // No installer asset for this platform - the backend opened the page.
        var modal = bootstrap.Modal.getInstance(document.getElementById('update-modal'));
        if (modal) modal.hide();
    }
}

function onUpdateDownloadProgress(received, total) {
    var bar = document.getElementById('update-modal-bar');
    if (total > 0) {
        var pct = Math.round((received / total) * 100);
        bar.style.width = pct + '%';
        document.getElementById('update-modal-status').textContent =
            'Downloading update… ' + pct + '% (' + formatBytes(received) + ' / ' + formatBytes(total) + ')';
    } else {
        document.getElementById('update-modal-status').textContent =
            'Downloading update… ' + formatBytes(received);
    }
}

function onUpdateDownloadComplete() {
    document.getElementById('update-modal-bar').style.width = '100%';
    document.getElementById('update-modal-status').textContent =
        'Download complete. Launching installer — the app will now close.';
}

function onUpdateDownloadError(message) {
    document.getElementById('update-modal-progress').style.display = 'none';
    document.getElementById('update-modal-actions').style.display = 'flex';
    showAlert(message || 'Update failed.');
}

function skipThisVersion() {
    if (pendingUpdate && bridge) bridge.skipUpdateVersion(pendingUpdate.version);
    var modal = bootstrap.Modal.getInstance(document.getElementById('update-modal'));
    if (modal) modal.hide();
}

function applyRatingButtonMode() {
    var container = document.getElementById('review-rating-buttons');
    if (!container) return;
    var buttons = container.querySelectorAll('button');
    var twoBtn = currentReviewBehavior.two_button_mode;
    // buttons order: Again(1), Hard(3), Good(4), Easy(5)
    if (buttons.length >= 4) {
        buttons[1].style.display = twoBtn ? 'none' : '';  // Hard
        buttons[3].style.display = twoBtn ? 'none' : '';  // Easy
        // In two-button mode, Good gets accent color text; in four-button mode, Good is green text
        buttons[2].style.color = twoBtn ? 'var(--accent)' : '#27ae60';
    }
}

function buildSettings(overrides) {
    return Object.assign({
        theme: currentTheme,
        ui_mode: currentMode,
        accent_color: currentAccent,  // deprecated; kept = theme accent for legacy readers
        font_size: currentFontSize,
        default_new_cards_limit: currentSRSDefaults.new_cards_limit,
        default_learning_steps: currentSRSDefaults.learning_steps,
        default_relearning_steps: currentSRSDefaults.relearning_steps,
        default_study_order: currentSRSDefaults.study_order,
        day_start_hour: currentSRSDefaults.day_start_hour,
        default_scheduler: currentSRSDefaults.scheduler,
        default_desired_retention: currentSRSDefaults.desired_retention,
        review_autoplay_audio: currentReviewBehavior.autoplay_audio,
        review_shortcut_enabled: currentReviewBehavior.shortcut_enabled,
        review_shortcut_key: currentReviewBehavior.shortcut_key,
        review_two_button_mode: currentReviewBehavior.two_button_mode,
        update_check_enabled: currentUpdatePrefs.check_enabled,
    }, overrides);
}

function saveAppSettings() {
    var newLimit = parseInt(document.getElementById('srs-default-new-limit').value, 10);
    var settings = buildSettings({
        theme: pendingTheme || currentTheme,
        ui_mode: pendingMode || currentMode,
        accent_color: (THEMES[pendingTheme || currentTheme] || THEMES.violet).accent,
        font_size: document.getElementById('settings-font-size').value,
        default_new_cards_limit: isNaN(newLimit) ? 15 : newLimit,
        default_learning_steps: document.getElementById('srs-default-learning-steps').value.trim() || '1 10',
        default_relearning_steps: document.getElementById('srs-default-relearning-steps').value.trim() || '10',
        default_study_order: document.getElementById('srs-default-study-order').value,
        day_start_hour: parseInt(document.getElementById('srs-day-start-hour').value, 10),
        default_scheduler: document.getElementById('srs-default-scheduler').value || 'sm2',
        default_desired_retention: (function () {
            var r = parseFloat(document.getElementById('srs-default-retention').value);
            return isNaN(r) ? 0.9 : Math.min(0.99, Math.max(0.7, r));
        })(),
        review_autoplay_audio: document.getElementById('review-autoplay-audio').checked,
        review_shortcut_enabled: document.getElementById('review-shortcut-enabled').checked,
        review_shortcut_key: currentReviewBehavior.shortcut_key,
        review_two_button_mode: document.getElementById('review-two-button-mode').checked,
        update_check_enabled: document.getElementById('update-check-enabled').checked,
    });
    applyAppSettings(settings);
    if (bridge) bridge.saveAppSettings(JSON.stringify(settings));
}

function resetAppearanceSettings() {
    var settings = buildSettings({ theme: 'violet', ui_mode: 'light', accent_color: '#aa00ff', font_size: 'medium' });
    applyAppSettings(settings);
    showAppSettings();
    if (bridge) bridge.saveAppSettings(JSON.stringify(settings));
}

function resetSRSDefaults() {
    var settings = buildSettings({
        default_new_cards_limit: 15,
        default_learning_steps: '1 10',
        default_relearning_steps: '10',
        default_study_order: 'new_first',
        day_start_hour: 4,
        default_scheduler: 'sm2',
        default_desired_retention: 0.9,
    });
    applyAppSettings(settings);
    showAppSettings();
    if (bridge) bridge.saveAppSettings(JSON.stringify(settings));
}

function resetReviewBehavior() {
    var settings = buildSettings({
        review_autoplay_audio: true,
        review_shortcut_enabled: true,
        review_shortcut_key: 'Space',
        review_two_button_mode: false,
    });
    applyAppSettings(settings);
    showAppSettings();
    if (bridge) bridge.saveAppSettings(JSON.stringify(settings));
}

function importDeck() {
    if (bridge) {
        bridge.importDeck();
    }
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('collapsed');
}

function showView(viewId) {
    applyThemeVars(currentTheme, currentMode);
    document.querySelectorAll('.view-section').forEach(function(el) {
        el.classList.add('view-hidden');
    });
    document.getElementById(viewId + '-view').classList.remove('view-hidden');
    if (viewId !== 'review') {
        var cssEl = document.getElementById('review-card-css');
        if (cssEl) cssEl.textContent = '';
    }
    if (viewId !== 'card-preview') {
        var previewCssEl = document.getElementById('preview-card-css');
        if (previewCssEl) previewCssEl.textContent = '';
    }
    if (viewId === 'dashboard' && bridge) {
        bridge.refreshStats();
        populateRetentionDeckSelect();
        fetchRetentionStats();
        populateHeatmapDeckSelect();
        fetchHeatmap();
        if (decks.length === 0) bridge.getDecks();
    }
    if (viewId === 'srs' && bridge) bridge.getDecks();
    if (viewId === 'settings') { showAppSettings(); if (bridge) bridge.getDataInfo(); }
    if (viewId === 'card-types' && bridge) bridge.getCardTypes();
    if (viewId === 'create-card-type') initCreateCardTypeView();
    if (viewId === 'card-browser') {
        populateBrowseDeckSelect();
        if (bridge) { if (cardTypes.length === 0) bridge.getCardTypes(); }
        fetchBrowseCards();
    }
    if (viewId === 'edit-card' && bridge) {
        if (cardTypes.length === 0) bridge.getCardTypes();
    }
    if (viewId === 'create-deck') {
        populateParentDeckSelect('deck-parent-select');
    }
    if (viewId === 'create-card' && bridge) {
        if (cardTypes.length === 0) bridge.getCardTypes();
        else updateCardTypes(cardTypes);
        if (decks.length === 0) bridge.getDecks();
        else populateCardDeckSelect();
    }
    if (viewId === 'immersion' && bridge) {
        bridge.getImmersionCategories();
        fetchImmersionStats();
        bridge.getImmersionLogs();
        bridge.getMediaCategories();
        bridge.getMediaItems();
    }
}

function updateStats(due, newCards) {
    document.getElementById('due-cards').textContent = due;
    document.getElementById('new-cards').textContent = newCards;
}

function populateDeckSelectHierarchical(select, flat) {
    var frag = document.createDocumentFragment();
    flat.forEach(function(item) {
        var opt = document.createElement('option');
        opt.value = item.deck.id;
        var indent = '';
        for (var i = 0; i < item.depth; i++) indent += '\u00A0\u00A0\u00A0\u00A0';
        opt.textContent = indent + item.deck.name;
        frag.appendChild(opt);
    });
    select.appendChild(frag);
}

function populateCardDeckSelect() {
    var select = document.getElementById('card-deck-select');
    if (!select) return;
    var preselect = createCardPreselectedDeckId !== null ? String(createCardPreselectedDeckId) : select.value;
    select.innerHTML = '';
    var tree = buildDeckTree(decks);
    var flat = flattenDeckTree(tree, 0);
    populateDeckSelectHierarchical(select, flat);
    if (preselect && decks.some(function(d) { return String(d.id) === preselect; })) {
        select.value = preselect;
    }
}

function populateRetentionDeckSelect() {
    var select = document.getElementById('retention-deck-select');
    if (!select) return;
    var prev = select.value;
    select.innerHTML = '<option value="0">All Decks</option>';
    var tree = buildDeckTree(decks);
    var flat = flattenDeckTree(tree, 0);
    populateDeckSelectHierarchical(select, flat);
    if (prev && (prev === '0' || decks.some(function(d) { return String(d.id) === prev; }))) {
        select.value = prev;
    }
    syncCustomSelect('retention-deck-select');
}

function fetchRetentionStats() {
    if (!bridge) return;
    var deckSel = document.getElementById('retention-deck-select');
    var periodSel = document.getElementById('retention-period-select');
    if (!deckSel || !periodSel) return;
    bridge.getRetentionStats(String(deckSel.value || '0'), periodSel.value || 'last_month');
}

function updateRetentionStats(stats) {
    var CIRC = 188.5;
    function fmtEl(elId, ringId, countId, s) {
        var el = document.getElementById(elId);
        var ring = document.getElementById(ringId);
        var countEl = document.getElementById(countId);
        if (!s || s.rate === null || s.rate === undefined) {
            el.textContent = '-';
            el.style.color = '';
            if (ring) ring.style.strokeDashoffset = CIRC;
            if (countEl) countEl.textContent = '';
            return;
        }
        el.textContent = s.rate + '%';
        var col = s.rate >= 90 ? '#22c55e' : s.rate >= 70 ? '#f59e0b' : '#ef4444';
        el.style.color = col;
        if (ring) {
            ring.style.strokeDashoffset = CIRC * (1 - s.rate / 100);
            ring.style.stroke = col;
        }
        if (countEl) countEl.textContent = s.successful + ' / ' + s.total;
    }
    fmtEl('retention-young', 'retention-young-ring', 'retention-young-count', stats.young);
    fmtEl('retention-mature', 'retention-mature-ring', 'retention-mature-count', stats.mature);
    fmtEl('retention-total', 'retention-total-ring', 'retention-total-count', stats.total);

    var yTotal = (stats.young && stats.young.total) ? stats.young.total : 0;
    var mTotal = (stats.mature && stats.mature.total) ? stats.mature.total : 0;
    var grand = yTotal + mTotal;
    if (grand > 0) {
        var mPct = Math.round(mTotal / grand * 100);
        var yPct = 100 - mPct;
        var mFill = document.getElementById('dash-ratio-mature-fill');
        var yFill = document.getElementById('dash-ratio-young-fill');
        var mPctEl = document.getElementById('dash-ratio-mature-pct');
        var yPctEl = document.getElementById('dash-ratio-young-pct');
        if (mFill) mFill.style.width = mPct + '%';
        if (yFill) yFill.style.width = yPct + '%';
        if (mPctEl) mPctEl.textContent = mPct + '%';
        if (yPctEl) yPctEl.textContent = yPct + '%';
    }
}

function populateHeatmapDeckSelect() {
    var select = document.getElementById('heatmap-deck-select');
    if (!select) return;
    var prev = select.value;
    select.innerHTML = '<option value="0">All Decks</option>';
    var tree = buildDeckTree(decks);
    var flat = flattenDeckTree(tree, 0);
    populateDeckSelectHierarchical(select, flat);
    if (prev && (prev === '0' || decks.some(function(d) { return String(d.id) === prev; }))) {
        select.value = prev;
    }
    syncCustomSelect('heatmap-deck-select');
}

function fetchHeatmap() {
    if (!bridge) return;
    var sel = document.getElementById('heatmap-deck-select');
    bridge.getDailyReviewCounts(String(sel ? sel.value : '0'));
}

function updateHeatmap(data) {
    document.getElementById('heatmap-current-streak').textContent = data.current_streak;
    document.getElementById('heatmap-longest-streak').textContent = data.longest_streak;
    document.getElementById('heatmap-year-total').textContent = data.year_total.toLocaleString();

    // Use the SRS today the backend computed (honors day_start_hour) instead of
    // new Date(), so the heatmap and KPI cards agree with the forecast keys.
    var today = data.today ? new Date(data.today + 'T00:00:00') : new Date();
    today.setHours(0, 0, 0, 0);
    function toDS(d) {
        return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }

    var elToday = document.getElementById('dash-today-reviews');
    if (elToday) elToday.textContent = (data.counts[toDS(today)] || 0).toLocaleString();

    var sum7 = 0;
    for (var i = 0; i < 7; i++) {
        var d7 = new Date(today);
        d7.setDate(d7.getDate() - i);
        sum7 += data.counts[toDS(d7)] || 0;
    }
    var avg7 = Math.round(sum7 / 7 * 10) / 10;
    var el7 = document.getElementById('dash-7day-avg');
    if (el7) el7.textContent = avg7 + ' / day';

    var dayOfYear = Math.max(1, Math.ceil((today - new Date(today.getFullYear(), 0, 1)) / 86400000));
    var yearAvg = Math.round(data.year_total / dayOfYear * 10) / 10;
    var elYA = document.getElementById('dash-year-avg');
    if (elYA) elYA.textContent = yearAvg + ' / day';

    var elTomorrow = document.getElementById('due-tomorrow-cards');
    if (elTomorrow) elTomorrow.textContent = (data.due_tomorrow || 0).toLocaleString();

    renderHeatmapSVG(data.counts, data.forecast || {}, today);
}

function renderHeatmapSVG(counts, forecast, today) {
    forecast = forecast || {};
    var CELL = 11, GAP = 3, WEEKS = 53;
    var DAY_LABEL_W = 26, MONTH_LABEL_H = 18, LEGEND_H = 22;

    if (!today) {
        today = new Date();
        today.setHours(0, 0, 0, 0);
    }

    // Calculate the start date for the current year
    var startDay = new Date(today.getFullYear(), 0, 1); // January 1 of current year
    startDay.setDate(startDay.getDate() - startDay.getDay()); // rewind to Sunday

    var svgW = DAY_LABEL_W + WEEKS * (CELL + GAP);
    var svgH = MONTH_LABEL_H + 7 * (CELL + GAP) + LEGEND_H;

    var svg = document.getElementById('heatmap-svg');
    svg.setAttribute('width', svgW);
    svg.setAttribute('height', svgH);
    svg.innerHTML = '';

    // Mode-aware ramp: empty cells sit just off the card surface and the
    // intensity blends from there to the theme accent, so the map is readable
    // on both light and dark surfaces (the old version blended from a fixed
    // dark navy, which rendered as a near-black slab on the light theme).
    var isDark = document.documentElement.getAttribute('data-mode') === 'dark';
    var ac = currentAccent.length === 7 ? currentAccent : '#aa00ff';
    var r0 = parseInt(ac.slice(1,3),16), g0 = parseInt(ac.slice(3,5),16), b0 = parseInt(ac.slice(5,7),16);
    var base = isDark ? [42, 36, 56] : [232, 229, 242];
    function blend(t) {
        return 'rgb('+Math.round(base[0]+(r0-base[0])*t)+','+Math.round(base[1]+(g0-base[1])*t)+','+Math.round(base[2]+(b0-base[2])*t)+')';
    }
    var LEVELS = [0, 0.3, 0.55, 0.78, 1.0];
    function cellColor(n) {
        if (!n)     return blend(LEVELS[0]);
        if (n <= 3) return blend(LEVELS[1]);
        if (n <= 7) return blend(LEVELS[2]);
        if (n <= 14) return blend(LEVELS[3]);
        return blend(LEVELS[4]);
    }
    var labelCol = isDark ? '#9486b5' : '#8a7fa8';            // --text-muted per mode
    var todayRing = isDark ? '#f1edfa' : '#1a1133';           // --text-1 per mode
    var futureStroke = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)';
    function toDateStr(d) {
        return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    }

    var ns = 'http://www.w3.org/2000/svg';
    var MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    var frag = document.createDocumentFragment();

    // Day-of-week labels (Mon, Wed, Fri)
    [[1,'Mon'],[3,'Wed'],[5,'Fri']].forEach(function(pair) {
        var txt = document.createElementNS(ns, 'text');
        txt.setAttribute('x', DAY_LABEL_W - 3);
        txt.setAttribute('y', MONTH_LABEL_H + pair[0] * (CELL + GAP) + CELL);
        txt.setAttribute('text-anchor', 'end');
        txt.setAttribute('fill', labelCol);
        txt.setAttribute('font-size', '9');
        txt.setAttribute('font-weight', '600');
        txt.textContent = pair[1];
        frag.appendChild(txt);
    });

    var lastMonthW = -5;

    for (var w = 0; w < WEEKS; w++) {
        var weekX = DAY_LABEL_W + w * (CELL + GAP);
        var weekStart = new Date(startDay);
        weekStart.setDate(startDay.getDate() + w * 7);

        // Month label when 1st of month appears in this week
        for (var di = 0; di < 7; di++) {
            var probe = new Date(weekStart);
            probe.setDate(weekStart.getDate() + di);
            if (probe.getDate() === 1 && w - lastMonthW >= 3) {
                var mTxt = document.createElementNS(ns, 'text');
                mTxt.setAttribute('x', weekX);
                mTxt.setAttribute('y', MONTH_LABEL_H - 5);
                mTxt.setAttribute('fill', labelCol);
                mTxt.setAttribute('font-size', '10');
                mTxt.setAttribute('font-weight', '600');
                mTxt.textContent = MONTH_NAMES[probe.getMonth()];
                frag.appendChild(mTxt);
                lastMonthW = w;
                break;
            }
        }

        for (var d = 0; d < 7; d++) {
            var day = new Date(weekStart);
            day.setDate(weekStart.getDate() + d);

            var dStr = toDateStr(day);
            var isFuture = day > today;
            var cnt = isFuture ? (forecast[dStr] || 0) : (counts[dStr] || 0);

            var rect = document.createElementNS(ns, 'rect');
            rect.setAttribute('x', weekX);
            rect.setAttribute('y', MONTH_LABEL_H + d * (CELL + GAP));
            rect.setAttribute('width', CELL);
            rect.setAttribute('height', CELL);
            rect.setAttribute('rx', 2);
            rect.setAttribute('fill', cellColor(cnt));
            if (isFuture) {
                // Forecast (cards due): washed out + outlined so it reads as
                // "planned", clearly apart from solid history cells.
                rect.setAttribute('opacity', '0.45');
                if (cnt > 0) {
                    rect.setAttribute('stroke', futureStroke);
                    rect.setAttribute('stroke-width', '1');
                    rect.setAttribute('stroke-dasharray', '2,1.5');
                }
            }
            if (dStr === toDateStr(today)) {
                // Ring today so the eye finds "now" instantly.
                rect.setAttribute('stroke', todayRing);
                rect.setAttribute('stroke-width', '1.6');
                rect.removeAttribute('stroke-dasharray');
                rect.setAttribute('opacity', '1');
            }
            rect.dataset.date = dStr;
            rect.dataset.count = cnt;
            rect.dataset.future = isFuture ? '1' : '0';

            frag.appendChild(rect);
        }
    }

    // Legend: intensity ramp bottom-right, forecast key bottom-left.
    var legendY = MONTH_LABEL_H + 7 * (CELL + GAP) + 8;
    function legendText(x, label, anchor) {
        var t = document.createElementNS(ns, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', legendY + CELL - 2);
        t.setAttribute('fill', labelCol);
        t.setAttribute('font-size', '9');
        t.setAttribute('font-weight', '600');
        if (anchor) t.setAttribute('text-anchor', anchor);
        t.textContent = label;
        frag.appendChild(t);
        return t;
    }
    var rampX = svgW - (LEVELS.length * (CELL + GAP)) - 34;
    legendText(rampX - 6, 'Less', 'end');
    LEVELS.forEach(function(t, i) {
        var sq = document.createElementNS(ns, 'rect');
        sq.setAttribute('x', rampX + i * (CELL + GAP));
        sq.setAttribute('y', legendY);
        sq.setAttribute('width', CELL);
        sq.setAttribute('height', CELL);
        sq.setAttribute('rx', 2);
        sq.setAttribute('fill', blend(t));
        frag.appendChild(sq);
    });
    legendText(svgW - 28, 'More');
    // Forecast key: one washed/dashed sample + caption.
    var fx = DAY_LABEL_W;
    var fsq = document.createElementNS(ns, 'rect');
    fsq.setAttribute('x', fx);
    fsq.setAttribute('y', legendY);
    fsq.setAttribute('width', CELL);
    fsq.setAttribute('height', CELL);
    fsq.setAttribute('rx', 2);
    fsq.setAttribute('fill', blend(0.55));
    fsq.setAttribute('opacity', '0.45');
    fsq.setAttribute('stroke', futureStroke);
    fsq.setAttribute('stroke-width', '1');
    fsq.setAttribute('stroke-dasharray', '2,1.5');
    frag.appendChild(fsq);
    legendText(fx + CELL + 6, 'upcoming due cards · outlined cell = today');

    svg.appendChild(frag);

    // Single delegated event listener for tooltips instead of one per cell
    svg.addEventListener('mouseenter', function(e) {
        if (e.target.tagName === 'rect' && e.target.dataset.date) {
            var tip = document.getElementById('heatmap-tooltip');
            var count = parseInt(e.target.dataset.count, 10);
            var isFuture = e.target.dataset.future === '1';
            if (tip) {
                if (isFuture) {
                    tip.textContent = e.target.dataset.date + ': ' + count + (count === 1 ? ' card due' : ' cards due');
                } else {
                    tip.textContent = e.target.dataset.date + ': ' + count + (count === 1 ? ' review' : ' reviews');
                }
            }
        }
    }, true);
    svg.addEventListener('mouseleave', function(e) {
        if (e.target.tagName === 'rect' && e.target.dataset.date) {
            var tip = document.getElementById('heatmap-tooltip');
            if (tip) tip.textContent = '';
        }
    }, true);
}

function buildDeckTree(deckList) {
    var map = {};
    var roots = [];
    deckList.forEach(function(d) { map[d.id] = { deck: d, children: [] }; });
    deckList.forEach(function(d) {
        if (d.parent_id && map[d.parent_id]) {
            map[d.parent_id].children.push(map[d.id]);
        } else {
            roots.push(map[d.id]);
        }
    });
    // Sort children by position at each level
    function sortByPos(nodes) {
        nodes.sort(function(a, b) { return (a.deck.position || 0) - (b.deck.position || 0); });
        nodes.forEach(function(n) { sortByPos(n.children); });
    }
    sortByPos(roots);
    return roots;
}

function flattenDeckTree(nodes, depth, respectCollapse) {
    var result = [];
    nodes.forEach(function(node, idx) {
        var isCollapsed = respectCollapse && collapsedDecks.has(node.deck.id);
        result.push({ deck: node.deck, depth: depth, hasChildren: node.children.length > 0, collapsed: isCollapsed, siblingIndex: idx, siblingCount: nodes.length });
        if (!isCollapsed) {
            result = result.concat(flattenDeckTree(node.children, depth + 1, respectCollapse));
        }
    });
    return result;
}

function toggleDeckCollapse(deckId) {
    if (collapsedDecks.has(deckId)) {
        collapsedDecks.delete(deckId);
    } else {
        collapsedDecks.add(deckId);
    }
    renderDeckList();
}

function expandAllDecks() {
    collapsedDecks.clear();
    deckCollapseInitialized = true;
    renderDeckList();
}

function updateDecks(deckData) {
    decks = deckData;
    populateCardDeckSelect();
    populateRetentionDeckSelect();
    populateHeatmapDeckSelect();
    if (!document.getElementById('dashboard-view').classList.contains('view-hidden')) {
        fetchRetentionStats();
        fetchHeatmap();
    }
    // On first load, auto-collapse all parent decks
    if (!deckCollapseInitialized) {
        deckCollapseInitialized = true;
        decks.forEach(function(d) {
            if (decks.some(function(c) { return c.parent_id === d.id; })) {
                collapsedDecks.add(d.id);
            }
        });
    }
    renderDeckList();
}

function isDescendantOf(childId, ancestorId) {
    var queue = [ancestorId];
    while (queue.length) {
        var cur = queue.shift();
        for (var i = 0; i < decks.length; i++) {
            if (decks[i].parent_id === cur) {
                if (decks[i].id === childId) return true;
                queue.push(decks[i].id);
            }
        }
    }
    return false;
}

var deckDragId = null;

function renderDeckList() {
    var container = document.getElementById('deck-list');
    container.innerHTML = '';
    if (decks.length === 0) {
        container.innerHTML = '<p class="text">No decks found. Create or import a deck to get started.</p>';
        return;
    }
    var tree = buildDeckTree(decks);
    var flat = flattenDeckTree(tree, 0, true);
    var frag = document.createDocumentFragment();

    // Helper: create a reorder drop zone between sibling decks
    function makeSiblingDropZone(parentId, position, depth) {
        var zone = document.createElement('div');
        zone.className = 'deck-drop-zone';
        // Use padding for a large invisible hit area; the visible bar is drawn via border
        zone.style.cssText = 'padding:6px 0; margin:-6px 0; border-top:2px solid transparent; border-radius:4px; transition:border-color 0.15s ease; max-width:600px; box-sizing:content-box; position:relative; z-index:1;';
        if (depth > 0) {
            zone.style.marginLeft = (depth * 1.5) + 'rem';
            zone.style.maxWidth = (600 - depth * 24) + 'px';
        }
        zone.addEventListener('dragover', function(e) {
            if (!deckDragId) return;
            var dragged = decks.find(function(d) { return d.id === deckDragId; });
            if (!dragged) return;
            if (parentId && isDescendantOf(parentId, deckDragId)) return;
            if (parentId === deckDragId) return;
            var sameParent = (dragged.parent_id || 0) === (parentId || 0);
            if (sameParent && (dragged.position === position || dragged.position === position - 1)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            zone.style.borderColor = currentAccent;
        });
        zone.addEventListener('dragleave', function() {
            zone.style.borderColor = 'transparent';
        });
        zone.addEventListener('drop', function(e) {
            e.preventDefault();
            zone.style.borderColor = 'transparent';
            if (!deckDragId || !bridge) return;
            var dragged = decks.find(function(d) { return d.id === deckDragId; });
            if (!dragged) return;
            if (parentId && isDescendantOf(parentId, deckDragId)) return;
            if (parentId === deckDragId) return;
            // Adjust position if moving within the same parent and the deck was before the target
            var adjustedPos = position;
            var sameParent = (dragged.parent_id || 0) === (parentId || 0);
            if (sameParent && dragged.position < position) {
                adjustedPos = position - 1;
            }
            bridge.reorderDeck(deckDragId, parentId || 0, adjustedPos);
            deckDragId = null;
        });
        return zone;
    }

    // Top-level drop zone - reorder to position 0 at root
    frag.appendChild(makeSiblingDropZone(null, 0, 0));

    var pendingTrailingZones = []; // stack of {parentId, position, depth}

    flat.forEach(function(item, idx) {
        var deck = item.deck;
        var depth = item.depth;

        // Flush trailing zones for deeper/equal depth levels that are now closed
        while (pendingTrailingZones.length > 0 && pendingTrailingZones[pendingTrailingZones.length - 1].depth >= depth) {
            var z = pendingTrailingZones.pop();
            frag.appendChild(makeSiblingDropZone(z.parentId, z.position, z.depth));
        }

        // "Before" drop zone: first child in a subgroup, or between siblings
        if (item.siblingIndex === 0 && depth > 0) {
            frag.appendChild(makeSiblingDropZone(deck.parent_id, 0, depth));
        } else if (item.siblingIndex > 0) {
            frag.appendChild(makeSiblingDropZone(deck.parent_id, item.siblingIndex, depth));
        }
        var card = document.createElement('div');
        card.className = 'card mb-3 deck-card';
        card.setAttribute('draggable', 'true');
        card.dataset.deckId = deck.id;
        card.style.cursor = 'pointer';
        card.style.maxWidth = '600px';
        card.style.transition = 'background-color 0.15s ease, box-shadow 0.15s ease, outline 0.15s ease, opacity 0.15s ease';
        if (depth > 0) {
            card.style.marginLeft = (depth * 1.5) + 'rem';
            card.style.maxWidth = (600 - depth * 24) + 'px';
        }

        // --- Drag source ---
        card.addEventListener('dragstart', function(e) {
            deckDragId = deck.id;
            card.style.opacity = '0.5';
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(deck.id));
        });
        card.addEventListener('dragend', function() {
            card.style.opacity = '1';
            deckDragId = null;
        });

        // --- Drop target (reparent: drop onto center of card) ---
        card.addEventListener('dragover', function(e) {
            if (!deckDragId || deckDragId === deck.id) return;
            if (isDescendantOf(deck.id, deckDragId)) return;
            var dragged = decks.find(function(d) { return d.id === deckDragId; });
            if (dragged && dragged.parent_id === deck.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            card.style.outline = '2px solid ' + currentAccent;
            card.style.outlineOffset = '-2px';
        });
        card.addEventListener('dragleave', function() {
            card.style.outline = '';
            card.style.outlineOffset = '';
        });
        card.addEventListener('drop', function(e) {
            e.preventDefault();
            card.style.outline = '';
            card.style.outlineOffset = '';
            if (!deckDragId || deckDragId === deck.id) return;
            if (isDescendantOf(deck.id, deckDragId)) return;
            if (bridge) {
                bridge.setDeckParent(deckDragId, deck.id);
            }
            deckDragId = null;
        });

        var chevron = '';
        if (item.hasChildren) {
            var rotation = item.collapsed ? '0' : '90';
            chevron = '<span class="deck-collapse-toggle" data-deck-id="' + deck.id + '" style="cursor:pointer; margin-right:0.75rem; user-select:none; display:inline-flex; align-items:center; justify-content:center; width:2rem; height:2rem; border-radius:4px; transition:transform 0.15s ease, background-color 0.15s ease; transform:rotate(' + rotation + 'deg);">' +
                '<svg width="16" height="16" viewBox="0 0 12 12" fill="none" style="flex-shrink:0;"><path d="M3 1.5L8.5 6L3 10.5" stroke="#aaa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</span>';
        }
        var dueBadge = deck.due > 0
            ? '<span class="badge" style="background-color:' + currentAccent + '; font-size:0.82rem; padding:0.35rem 0.65rem;">' + deck.due + ' due</span>'
            : '';
        var newBadge = deck.new > 0
            ? '<span class="badge" style="background-color:#4a90d9; font-size:0.82rem; padding:0.35rem 0.65rem;">' + deck.new + ' new</span>'
            : '';
        var emptyLabel = (deck.due === 0 && deck.new === 0)
            ? '<span style="color:#666; font-size:0.85rem;">Nothing due</span>'
            : '';
        card.innerHTML =
            '<div class="card-body d-flex justify-content-between align-items-center" style="padding: 0.9rem 1.25rem;">' +
                '<div style="display:flex; align-items:center;">' +
                    chevron +
                    '<div>' +
                        '<h5 class="card-title mb-0" style="color: var(--text-1); font-weight: 600;">' + deck.name + '</h5>' +
                        '<small style="color: #888; font-size: 0.78rem;">' + deck.total + ' card' + (deck.total !== 1 ? 's' : '') + '</small>' +
                    '</div>' +
                '</div>' +
                '<div class="d-flex gap-2 align-items-center">' +
                    dueBadge + newBadge + emptyLabel +
                '</div>' +
            '</div>';
        card.addEventListener('mouseenter', function() { if (!deckDragId) card.classList.add('deck-card-hover'); });
        card.addEventListener('mouseleave', function() { card.classList.remove('deck-card-hover'); });
        card.addEventListener('click', function(e) {
            // If the chevron toggle was clicked, collapse/expand instead of navigating
            var toggle = e.target.closest('.deck-collapse-toggle');
            if (toggle) {
                e.preventDefault();
                e.stopPropagation();
                toggleDeckCollapse(deck.id);
                return;
            }
            e.preventDefault();
            showDeckDetails(deck);
        });
        frag.appendChild(card);

        // If last sibling in group, schedule a trailing drop zone (placed after subtree)
        if (item.siblingIndex === item.siblingCount - 1) {
            pendingTrailingZones.push({ parentId: deck.parent_id, position: item.siblingIndex + 1, depth: depth });
        }
    });

    // Flush any remaining trailing zones
    while (pendingTrailingZones.length > 0) {
        var z = pendingTrailingZones.pop();
        frag.appendChild(makeSiblingDropZone(z.parentId, z.position, z.depth));
    }

    container.appendChild(frag);
}

function showCreateCard(deckId) {
    createCardPreselectedDeckId = (deckId !== undefined) ? deckId : null;
    showView('create-card');
}

function populateParentDeckSelect(selectId, excludeDeckId) {
    var select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = '<option value="0">None (top level)</option>';
    var tree = buildDeckTree(decks);
    var flat = flattenDeckTree(tree, 0);
    // Collect IDs to exclude (the deck itself and all its descendants)
    var excludeIds = new Set();
    if (excludeDeckId) {
        excludeIds.add(excludeDeckId);
        var queue = [excludeDeckId];
        while (queue.length) {
            var cur = queue.shift();
            decks.forEach(function(d) {
                if (d.parent_id === cur) {
                    excludeIds.add(d.id);
                    queue.push(d.id);
                }
            });
        }
    }
    var frag = document.createDocumentFragment();
    flat.forEach(function(item) {
        if (excludeIds.has(item.deck.id)) return;
        var opt = document.createElement('option');
        opt.value = item.deck.id;
        var indent = '';
        for (var i = 0; i < item.depth; i++) indent += '\u00A0\u00A0\u00A0\u00A0';
        opt.textContent = indent + item.deck.name;
        frag.appendChild(opt);
    });
    select.appendChild(frag);
}

function createDeck() {
    var name = document.getElementById('deck-name').value.trim();
    var description = document.getElementById('deck-description').value.trim();
    var parentId = parseInt(document.getElementById('deck-parent-select').value, 10) || 0;
    if (name === '') {
        showAlert('Please enter a deck name.');
        return;
    }
    if (bridge) {
        bridge.createDeck(name, description, parentId);
        document.getElementById('deck-name').value = '';
        document.getElementById('deck-description').value = '';
        document.getElementById('deck-parent-select').value = '0';
        showView('srs');
    }
}

function showDeckDetails(deck) {
    currentDeckForDetails = deck;
    var deckDetailsView = document.getElementById('deck-details-view');
    var remainingNew = Math.max(0, deck.total - deck.young - deck.mature);
    deckDetailsView.innerHTML = `
        <input type="hidden" id="current-deck-id" value="${deck.id}">
        <button class="btn btn-dark btn-back mb-3" onclick="showView('srs')">\u2190 Back</button>
        <div class="d-flex align-items-center justify-content-between mb-4" style="flex-wrap: wrap; gap: 1rem;">
            <h1 class="mb-0">${deck.name}</h1>
            <div class="d-flex" style="gap: 0.75rem; flex-wrap: wrap;">
                <button class="btn btn-dark btn-accent" onclick="startReview(${deck.id})" style="font-weight: 600; min-width: 9rem; height: 2.75rem;">Start Review</button>
                <button class="btn btn-dark btn-accent" onclick="showCreateCard(${deck.id})" style="font-weight: 600; height: 2.75rem;">Add Card</button>
                <button class="btn btn-dark btn-action" onclick="showDeckSettings()">Settings</button>
            </div>
        </div>

        <div class="card mb-3 settings-card" style="max-width: 560px;">
            <div class="card-body text-white">
                <h2 class="settings-section-title">Card Stats</h2>
                <div class="row text-center g-0 mb-3">
                    <div class="col dash-stat-cell">
                        <div class="dash-stat-label">Due</div>
                        <div class="dash-stat-value" style="color: var(--accent);">${deck.due}</div>
                    </div>
                    <div class="col dash-stat-cell">
                        <div class="dash-stat-label">New</div>
                        <div class="dash-stat-value" style="color: #4a90d9;">${deck.new}</div>
                    </div>
                    <div class="col dash-stat-cell" style="border-right: none;">
                        <div class="dash-stat-label">Total</div>
                        <div class="dash-stat-value">${deck.total}</div>
                    </div>
                </div>
                <hr style="margin: 0 0 0.75rem;">
                <div class="row text-center g-0">
                    <div class="col dash-stat-cell">
                        <div class="dash-stat-label">Young</div>
                        <div class="dash-stat-value" style="font-size: 1.4rem;">${deck.young}</div>
                    </div>
                    <div class="col dash-stat-cell" style="border-right: none;">
                        <div class="dash-stat-label">Mature</div>
                        <div class="dash-stat-value" style="font-size: 1.4rem; color: #27ae60;">${deck.mature}</div>
                    </div>
                </div>
            </div>
        </div>

        ${deck.total > 0 ? `
        <div class="card mb-3 settings-card" style="max-width: 560px;">
            <div class="card-body text-white">
                <h2 class="settings-section-title">Breakdown</h2>
                <div id="deck-pie-chart"></div>
            </div>
        </div>` : ''}

        ${deck.description ? `
        <div class="card mb-3 settings-card" style="max-width: 560px;">
            <div class="card-body text-white">
                <h2 class="settings-section-title">Description</h2>
                <p style="font-size: 0.95rem; opacity: 0.85; margin-bottom: 0;">${deck.description}</p>
            </div>
        </div>` : ''}
    `;
    showView('deck-details');
    if (deck.total > 0 && typeof Plotly !== 'undefined') {
        var sliceValues  = [deck.young,   deck.mature,  remainingNew];
        var sliceLabels  = ['Young',       'Mature',     'New'];
        var sliceColors  = [currentAccent,  '#27ae60',    '#4a90d9'];
        var fVals = [], fLabels = [], fColors = [];
        sliceValues.forEach(function(v, i) {
            if (v > 0) { fVals.push(v); fLabels.push(sliceLabels[i]); fColors.push(sliceColors[i]); }
        });
        Plotly.newPlot('deck-pie-chart', [{
            values: fVals,
            labels: fLabels,
            type: 'pie',
            hole: 0.45,
            marker: { colors: fColors, line: { color: '#242038', width: 2 } },
            textinfo: 'label+percent',
            textfont: { color: 'white', size: 13 },
            hovertemplate: '%{label}: %{value} cards (%{percent})<extra></extra>'
        }], {
            paper_bgcolor: 'transparent',
            plot_bgcolor:  'transparent',
            showlegend: true,
            legend: { font: { color: '#1a1133', size: 13 }, bgcolor: 'transparent', orientation: 'h', x: 0.5, xanchor: 'center', y: -0.08 },
            margin: { t: 10, b: 40, l: 10, r: 10 },
            font: { color: '#1a1133' },
            hoverlabel: { bgcolor: '#2d2a3e', bordercolor: currentAccent, font: { color: 'white', size: 13 } }
        }, { responsive: true, displayModeBar: false });
    }
}

var currentDeckForDetails = null;

function deleteDeck(deckId) {
    if (!bridge) return;
    if (!confirm('Are you sure you want to delete this deck? All cards in this deck will also be deleted. This cannot be undone.')) return;
    bridge.deleteDeck(deckId);
    showView('srs');
}

function deleteDeckFromSettings() {
    if (!currentDeckForDetails || !bridge) return;
    if (!confirm('Are you sure you want to delete "' + currentDeckForDetails.name + '"? All cards in this deck will also be deleted. This cannot be undone.')) return;
    bridge.deleteDeck(currentDeckForDetails.id);
    showView('srs');
}

function showDeckSettings() {
    var deck = currentDeckForDetails;
    if (!deck) return;
    document.getElementById('settings-deck-name').textContent = deck.name;
    document.getElementById('settings-deck-name-input').value = deck.name;
    populateParentDeckSelect('settings-deck-parent-select', deck.id);
    document.getElementById('settings-deck-parent-select').value = deck.parent_id ? String(deck.parent_id) : '0';
    document.getElementById('settings-deck-description-input').value = deck.description || '';
    document.getElementById('settings-new-cards-limit').value = deck.new_cards_limit !== undefined ? deck.new_cards_limit : 15;
    document.getElementById('settings-learning-steps').value = deck.learning_steps !== undefined ? deck.learning_steps : '1 10';
    document.getElementById('settings-relearning-steps').value = deck.relearning_steps !== undefined ? deck.relearning_steps : '10';
    document.getElementById('settings-study-order').value = deck.study_order !== undefined ? deck.study_order : 'new_first';
    document.getElementById('settings-answer-display').value = deck.answer_display !== undefined ? deck.answer_display : 'replace';
    var sched = deck.scheduler || 'sm2';
    document.getElementById('settings-scheduler').value = sched;
    document.getElementById('settings-desired-retention').value = (deck.desired_retention != null ? deck.desired_retention : 0.9);
    document.getElementById('settings-fsrs-params').value = deck.fsrs_params || '';
    document.getElementById('settings-fsrs-options').style.display = sched === 'fsrs' ? 'block' : 'none';
    var optStatus = document.getElementById('settings-fsrs-optimize-status');
    if (optStatus) optStatus.textContent = '';
    showView('deck-settings');
}

// Switching the algorithm takes effect immediately (and seeds FSRS state from
// history when turning FSRS on); retention/params persist on Save.
function onDeckSchedulerChange() {
    var sched = document.getElementById('settings-scheduler').value;
    document.getElementById('settings-fsrs-options').style.display = sched === 'fsrs' ? 'block' : 'none';
    if (currentDeckForDetails && bridge) {
        bridge.setDeckScheduler(currentDeckForDetails.id, sched);
        currentDeckForDetails.scheduler = sched;
    }
}

function optimizeFsrsParams() {
    if (!currentDeckForDetails || !bridge) return;
    var btn = document.getElementById('settings-fsrs-optimize-btn');
    var status = document.getElementById('settings-fsrs-optimize-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Starting…';
    bridge.optimizeDeckParams(currentDeckForDetails.id);
}

function fsrsOptimizeProgress(i, n, loss) {
    var status = document.getElementById('settings-fsrs-optimize-status');
    if (status) status.textContent = 'Optimizing… ' + Math.round(i / n * 100) + '% (loss ' + loss.toFixed(4) + ')';
}

function fsrsOptimizeDone(data) {
    var btn = document.getElementById('settings-fsrs-optimize-btn');
    var status = document.getElementById('settings-fsrs-optimize-status');
    if (btn) btn.disabled = false;
    if (status) status.textContent = 'Done — trained on ' + data.count + ' reviews.';
    var ta = document.getElementById('settings-fsrs-params');
    if (ta) ta.value = data.params.join(', ');
    if (currentDeckForDetails) currentDeckForDetails.fsrs_params = JSON.stringify(data.params);
}

function fsrsOptimizeInsufficient(count) {
    var btn = document.getElementById('settings-fsrs-optimize-btn');
    var status = document.getElementById('settings-fsrs-optimize-status');
    if (btn) btn.disabled = false;
    if (status) status.textContent = 'Need ~400+ reviews to optimize (have ' + count + '). Keeping current parameters.';
}

function fsrsOptimizeError(msg) {
    var btn = document.getElementById('settings-fsrs-optimize-btn');
    var status = document.getElementById('settings-fsrs-optimize-status');
    if (btn) btn.disabled = false;
    if (status) status.textContent = 'Optimize failed: ' + msg;
}

function saveDeckSettings() {
    if (!currentDeckForDetails || !bridge) return;
    var name = document.getElementById('settings-deck-name-input').value.trim();
    if (name === '') { showAlert('Deck name cannot be empty.'); return; }
    var parentId = parseInt(document.getElementById('settings-deck-parent-select').value, 10) || 0;
    var description = document.getElementById('settings-deck-description-input').value.trim();
    var limit = parseInt(document.getElementById('settings-new-cards-limit').value, 10);
    if (isNaN(limit) || limit < 0) { showAlert('Please enter a valid number.'); return; }
    var learningSteps = document.getElementById('settings-learning-steps').value.trim();
    var relearningSteps = document.getElementById('settings-relearning-steps').value.trim();
    var studyOrder = document.getElementById('settings-study-order').value || 'new_first';
    var answerDisplay = document.getElementById('settings-answer-display').value || 'replace';
    var desiredRetention = parseFloat(document.getElementById('settings-desired-retention').value);
    if (isNaN(desiredRetention)) desiredRetention = 0.9;
    desiredRetention = Math.min(0.99, Math.max(0.7, desiredRetention));
    // Params textarea accepts comma/space separated numbers; stored as a JSON array
    // (or '' for defaults). Kept in sync with the deck so Save never wipes optimized weights.
    var fsrsRaw = document.getElementById('settings-fsrs-params').value.trim();
    var fsrsParamsJson = '';
    if (fsrsRaw) {
        var nums = fsrsRaw.split(/[\s,]+/).filter(function(x) { return x !== ''; }).map(Number);
        if (nums.length !== 21 || nums.some(function(n) { return isNaN(n); })) {
            showAlert('FSRS parameters must be exactly 21 numbers (or leave blank for defaults).');
            return;
        }
        fsrsParamsJson = JSON.stringify(nums);
    }
    bridge.saveDeckSettings(currentDeckForDetails.id, name, description, limit, learningSteps, relearningSteps, studyOrder, answerDisplay, parentId, desiredRetention, fsrsParamsJson);
    currentDeckForDetails.name = name;
    currentDeckForDetails.description = description;
    currentDeckForDetails.new_cards_limit = limit;
    currentDeckForDetails.learning_steps = learningSteps;
    currentDeckForDetails.relearning_steps = relearningSteps;
    currentDeckForDetails.study_order = studyOrder;
    currentDeckForDetails.answer_display = answerDisplay;
    currentDeckForDetails.parent_id = parentId || null;
    currentDeckForDetails.desired_retention = desiredRetention;
    currentDeckForDetails.fsrs_params = fsrsParamsJson;
    showDeckDetails(currentDeckForDetails);
}

var newQueue = [];
var dueQueue = [];
var learningQueue = []; // [{card, showAfter (ms timestamp)}] - time-gated cards waiting to return
var newCardIndex = 0;
var dueCardIndex = 0;
var currentCard = null;
var currentCardSource = null; // 'new', 'due', or 'learning'
var currentDeckIdForReview = null;
var currentDeckLearningSteps = [];
var currentDeckRelearnSteps = [];
// FSRS context for the active review session (set by updateReviewQueue).
var currentDeckScheduler = 'sm2';
var currentFsrsParams = null;       // 21-float array, or null for SM-2
var currentDesiredRetention = 0.9;
var srsToday = null;                // 'YYYY-MM-DD' SRS day, for elapsed-day math
var currentDeckAnswerDisplay = 'replace';
var studyOrder = 'mix';
var interspersionRatio = 1;
var mediaBaseUrl = '';

function updateReviewCounts() {
    var newCount = newQueue.length - newCardIndex;
    var reviewCount = dueQueue.length - dueCardIndex;
    var learningCount = learningQueue.length;
    // The current learning card was removed from the array to be shown,
    // so add it back to the displayed count to stay consistent with
    // new/due counts (which include the current card).
    if (currentCardSource === 'learning') {
        learningCount++;
    }
    document.getElementById('review-count-new').textContent = newCount;
    document.getElementById('review-count-learning').textContent = learningCount;
    document.getElementById('review-count-review').textContent = reviewCount;

    var newEl = document.getElementById('review-count-new');
    var learnEl = document.getElementById('review-count-learning');
    var reviewEl = document.getElementById('review-count-review');
    newEl.style.textDecoration = currentCardSource === 'new' ? 'underline' : 'none';
    learnEl.style.textDecoration = currentCardSource === 'learning' ? 'underline' : 'none';
    reviewEl.style.textDecoration = currentCardSource === 'due' ? 'underline' : 'none';
}

function startReview(deckId) {
    // Resume the existing session if one is active for this deck
    if (currentDeckIdForReview === deckId &&
        (newCardIndex < newQueue.length || dueCardIndex < dueQueue.length || learningQueue.length > 0)) {
        showView('review');
        return;
    }
    currentDeckIdForReview = deckId;
    if (bridge) {
        bridge.startReview(deckId);
    }
}

function updateReviewQueue(data) {
    currentDeckLearningSteps = data.learning_steps || [];
    currentDeckRelearnSteps = data.relearning_steps || [];
    currentDeckAnswerDisplay = data.answer_display || 'replace';
    currentDeckScheduler = data.scheduler || 'sm2';
    currentFsrsParams = data.fsrs_params || null;
    currentDesiredRetention = data.desired_retention || 0.9;
    srsToday = data.srs_today || null;
    mediaBaseUrl = data.media_base_url || '';
    studyOrder = data.study_order || 'mix';
    newQueue = data.new_cards || [];
    dueQueue = data.due_cards || [];
    learningQueue = (data.learning_cards || []).map(function(card) {
        return { card: card, showAfter: Date.now() };
    });
    newCardIndex = 0;
    dueCardIndex = 0;
    currentCardSource = null;
    // Anki-style intersperser ratio for 'mix' mode
    interspersionRatio = (dueQueue.length + 1) / (newQueue.length + 1);
    document.getElementById('review-card-section').style.display = 'block';
    document.getElementById('review-action-bar').style.display = 'flex';
    document.getElementById('review-complete-section').style.display = 'none';
    showView('review');
    updateReviewCounts();
    if (newQueue.length === 0 && dueQueue.length === 0) {
        showReviewComplete();
        return;
    }
    showNextCard();
}

function applyFuriganaFilter(text, filter) {
    // Parses "漢字[かんじ]" segments into ruby HTML (or kanji/kana only)
    return text.replace(/([^\s\[）」』]+)\[([^\]]+)\]/g, function(match, word, reading) {
        if (filter === 'kanji') return word;
        if (filter === 'kana')  return reading;
        return '<ruby>' + word + '<rt>' + reading + '</rt></ruby>';
    });
}

function renderTemplate(template, fields, frontHtml) {
    var result = template;
    // {{FrontSide}} - Anki special token: re-render the already-rendered front HTML
    result = result.replace(/\{\{FrontSide\}\}/gi, frontHtml || '');
    // Positive conditional blocks: {{#Field}}...{{/Field}} - show content when field is non-empty
    result = result.replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, function(match, key, content) {
        key = key.trim();
        return (fields[key] && fields[key].trim()) ? content : '';
    });
    // Negation conditional blocks: {{^Field}}...{{/Field}} - show content when field is empty
    result = result.replace(/\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, function(match, key, content) {
        key = key.trim();
        return (!fields[key] || !fields[key].trim()) ? content : '';
    });
    // Simple placeholders: {{Field}} or {{filter:Field}}
    result = result.replace(/\{\{([^}]+)\}\}/g, function(match, key) {
        key = key.trim();
        var filter = null;
        if (key.indexOf(':') !== -1) {
            var parts = key.split(':');
            filter = parts[0].trim().toLowerCase();
            key = parts[parts.length - 1].trim();
        }
        var value = fields.hasOwnProperty(key) ? (fields[key] || '') : '';
        if (filter === 'furigana' || filter === 'kanji' || filter === 'kana') {
            return applyFuriganaFilter(value, filter);
        }
        return value;
    });
    return result;
}

// Set innerHTML and re-execute any <script> tags, which browsers suppress on innerHTML injection.
function setInnerHTMLWithScripts(element, html) {
    element.innerHTML = html;
    Array.from(element.querySelectorAll('script')).forEach(function(oldScript) {
        var newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(function(attr) {
            newScript.setAttribute(attr.name, attr.value);
        });
        newScript.textContent = oldScript.textContent;
        oldScript.parentNode.replaceChild(newScript, oldScript);
    });
}

function playAudioSequentially(container) {
    var audios = Array.from(container.querySelectorAll('audio'));
    if (audios.length === 0) return;
    function playNext(index) {
        if (index >= audios.length) return;
        var audio = audios[index];
        audio.play().catch(function(){});
        audio.addEventListener('ended', function() { playNext(index + 1); }, { once: true });
    }
    playNext(0);
}

function resolveMedia(text) {
    if (!text) return text;
    text = text.replace(/\[image:([^\]]+)\]/g,
        '<img loading="lazy" src="' + mediaBaseUrl + '$1" style="max-width:100%;max-height:300px;border-radius:6px;display:block;margin:0.5rem auto;">');
    text = text.replace(/\[sound:([^\]]+)\]/g,
        '<audio controls src="' + mediaBaseUrl + '$1" style="display:block;margin:0.5rem auto;"></audio>');
    // Handle bare <img src="filename"> from Anki templates (no protocol or path separator in src)
    text = text.replace(/(<img\b[^>]*?\bsrc=")([^"\/\\:]+)(")/gi,
        '$1' + mediaBaseUrl + '$2$3');
    return text;
}

function attachMedia(btn) {
    var fieldName = btn.getAttribute('data-field');
    var mediaType = btn.getAttribute('data-media');
    if (!bridge) return;
    bridge.selectMediaFile(mediaType, function(result) {
        if (result) {
            var ta = document.querySelector('.card-field-input[data-field="' + fieldName + '"]');
            if (ta) {
                if (ta.value && !ta.value.endsWith('\n')) ta.value += '\n';
                ta.value += result;
            }
        }
    });
}

function showNextCard() {
    var now = Date.now();
    var hasNew = newCardIndex < newQueue.length;
    var hasDue = dueCardIndex < dueQueue.length;
    var hasRegular = hasNew || hasDue;

    if (!hasRegular && learningQueue.length === 0) {
        showReviewComplete();
        return;
    }

    // Priority 1: Learning cards whose timer has elapsed (Anki always shows these first)
    var overdue = learningQueue.filter(function(item) { return item.showAfter <= now; });
    overdue.sort(function(a, b) { return a.showAfter - b.showAfter; });

    if (!hasRegular) {
        // All regular cards done - show the earliest pending learning card
        learningQueue.sort(function(a, b) { return a.showAfter - b.showAfter; });
        var item = learningQueue.shift();
        currentCard = item.card;
        currentCardSource = 'learning';
    } else if (overdue.length > 0) {
        // A learning card's timer has elapsed - show it immediately (highest priority)
        var item = overdue[0];
        learningQueue = learningQueue.filter(function(i) { return i !== item; });
        currentCard = item.card;
        currentCardSource = 'learning';
    } else {
        // Priority 2: Dynamically pick from new or due queue based on study_order
        var pickNew = false;
        if (hasNew && !hasDue) {
            pickNew = true;
        } else if (!hasNew && hasDue) {
            pickNew = false;
        } else if (studyOrder === 'new_first') {
            pickNew = true;
        } else if (studyOrder === 'new_last') {
            pickNew = false;
        } else {
            // 'mix' - Anki-style intersperser: evenly distribute new cards among due cards
            pickNew = (newCardIndex + 1) * interspersionRatio <= (dueCardIndex + 1);
        }
        if (pickNew) {
            currentCard = newQueue[newCardIndex];
            currentCardSource = 'new';
        } else {
            currentCard = dueQueue[dueCardIndex];
            currentCardSource = 'due';
        }
    }

    document.getElementById('review-card-css').textContent = currentCard.css_style || '';
    var frontEl = document.getElementById('review-front-text');
    if (currentCard.front_style) {
        setInnerHTMLWithScripts(frontEl, resolveMedia(renderTemplate(currentCard.front_style, currentCard.fields || {})));
    } else {
        var ft = currentCard.front || '';
        if (ft.indexOf('[image:') !== -1 || ft.indexOf('[sound:') !== -1) {
            setInnerHTMLWithScripts(frontEl, resolveMedia(ft));
        } else {
            setInnerHTMLWithScripts(frontEl, ft);
        }
    }
    if (currentReviewBehavior.autoplay_audio) playAudioSequentially(frontEl);
    document.getElementById('review-back-container').style.display = 'none';
    document.getElementById('review-rating-buttons').style.display = 'none';
    document.getElementById('review-show-answer-btn').style.display = 'block';
    updateReviewCounts();
}

// Mirrors src/scheduler.py:calculate_next_review so button labels match the
// interval the backend will actually schedule. Keep the two in sync.
var SM2_HARD_MULTIPLIER = 1.2;
var SM2_EASY_BONUS = 1.3;
var SM2_EASY_GRADUATING_INTERVAL = 4;
function sm2Interval(reps, easeFactor, currentInterval, rating) {
    if (rating < 3) return 1;
    var r = reps || 0;
    var ivl = currentInterval || 1;
    var ease = easeFactor || 2.5;
    if (r === 0) return rating === 5 ? SM2_EASY_GRADUATING_INTERVAL : 1;
    if (r === 1) return rating === 5 ? Math.ceil(6 * SM2_EASY_BONUS) : 6;
    var next;
    if (rating === 3) next = Math.ceil(ivl * SM2_HARD_MULTIPLIER);
    else if (rating === 4) next = Math.ceil(ivl * ease);
    else next = Math.ceil(ivl * ease * SM2_EASY_BONUS);
    return Math.max(ivl + 1, next);
}

// ── FSRS-6 preview mirror (keep in sync with src/fsrs.py) ──────────────────
// Display/preview only - the Python side is authoritative for actual scheduling.
var RATING_TO_GRADE = { 1: 1, 3: 2, 4: 3, 5: 4 };
function fsrsDecayFactor(p) {
    var decay = -p[20];
    return [decay, Math.pow(0.9, 1.0 / decay) - 1.0];
}
function fsrsRetrievability(elapsed, S, p) {
    if (!S || S <= 0) return 0.0;
    var df = fsrsDecayFactor(p);
    return Math.pow(1.0 + df[1] * Math.max(0, elapsed) / S, df[0]);
}
function fsrsNextInterval(S, retention, p) {
    var df = fsrsDecayFactor(p);
    var ivl = (S / df[1]) * (Math.pow(retention, 1.0 / df[0]) - 1.0);
    return Math.min(Math.max(Math.round(ivl), 1), 36500);
}
function fsrsInitialStability(g, p) { return Math.max(p[g - 1], 0.001); }
function fsrsInitialDifficulty(g, p, clamp) {
    var d = p[4] - Math.exp(p[5] * (g - 1)) + 1.0;
    return clamp ? Math.min(Math.max(d, 1.0), 10.0) : d;
}
function fsrsNextDifficulty(D, g, p) {
    var target = fsrsInitialDifficulty(4, p, false);
    var damped = D + (10.0 - D) * (-(p[6] * (g - 3))) / 9.0;
    return Math.min(Math.max(p[7] * target + (1.0 - p[7]) * damped, 1.0), 10.0);
}
function fsrsShortTermStability(S, g, p) {
    var inc = Math.exp(p[17] * (g - 3 + p[18])) * Math.pow(S, -p[19]);
    if (g >= 3) inc = Math.max(inc, 1.0);
    return Math.max(S * inc, 0.001);
}
function fsrsNextStability(D, S, r, g, p) {
    var s;
    if (g === 1) {
        var lt = p[11] * Math.pow(D, -p[12]) * (Math.pow(S + 1.0, p[13]) - 1.0) * Math.exp((1.0 - r) * p[14]);
        s = Math.min(lt, S / Math.exp(p[17] * p[18]));
    } else {
        var hard = g === 2 ? p[15] : 1.0, easy = g === 4 ? p[16] : 1.0;
        s = S * (1.0 + Math.exp(p[8]) * (11.0 - D) * Math.pow(S, -p[9]) * (Math.exp((1.0 - r) * p[10]) - 1.0) * hard * easy);
    }
    return Math.max(s, 0.001);
}
// Returns [stability, difficulty] after one press.
function fsrsApply(S, D, g, elapsed, p) {
    if (S === null || S === undefined || D === null || D === undefined)
        return [fsrsInitialStability(g, p), fsrsInitialDifficulty(g, p, true)];
    if (elapsed !== null && elapsed !== undefined && elapsed < 1)
        return [fsrsShortTermStability(S, g, p), fsrsNextDifficulty(D, g, p)];
    var r = (elapsed !== null && elapsed !== undefined) ? fsrsRetrievability(elapsed, S, p) : 0.0;
    return [fsrsNextStability(D, S, r, g, p), fsrsNextDifficulty(D, g, p)];
}
function fsrsElapsedForCard(card) {
    if (!card.last_reviewed || !srsToday) return null;
    var a = new Date(card.last_reviewed + 'T00:00:00'), b = new Date(srsToday + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / 86400000));
}
// FSRS memory state [S, D] after pressing `rating` on this card.
function fsrsApplyToCard(card, rating) {
    return fsrsApply(card.stability, card.difficulty, RATING_TO_GRADE[rating] || 3,
                     fsrsElapsedForCard(card), currentFsrsParams);
}
// Graduated/review interval label for a rating, honouring the active scheduler.
function gradInterval(card, rating) {
    if (currentDeckScheduler === 'fsrs' && currentFsrsParams) {
        return formatDays(fsrsNextInterval(fsrsApplyToCard(card, rating)[0], currentDesiredRetention, currentFsrsParams));
    }
    return formatDays(sm2Interval(card.reps, card.ease_factor, card.interval, rating));
}

// Merge updated FSRS memory state into a requeued learning/relearning card so its
// next button-label preview reflects this press (no-op under SM-2).
function fsrsRequeueOverlay(card, rating, extra) {
    if (currentDeckScheduler === 'fsrs' && currentFsrsParams) {
        var sd = fsrsApplyToCard(card, rating);
        extra.stability = sd[0];
        extra.difficulty = sd[1];
        extra.last_reviewed = srsToday;
    }
    return extra;
}

function formatIntervalLabel(minutes) {
    if (!minutes || minutes < 1) return '1m';
    if (minutes < 60) return minutes + 'm';
    var hours = minutes / 60;
    if (hours < 24) return Math.round(hours) + 'h';
    return Math.round(minutes / 1440) + 'd';
}

function formatDays(days) {
    if (!days || isNaN(days) || days < 1) return '1d';
    if (days < 31) return days + 'd';
    return Math.round(days / 30.5) + 'mo';
}

function updateRatingButtonLabels() {
    var card = currentCard;
    if (!card) return;

    var steps = currentDeckLearningSteps;
    var relearnSteps = currentDeckRelearnSteps;
    var again, hard, good, easy;

    if (card.is_new && steps.length > 0) {
        var curStep = (card.learning_step !== null && card.learning_step !== undefined)
            ? card.learning_step : -1;
        again = formatIntervalLabel(steps[0]);
        hard = formatIntervalLabel(steps[Math.max(0, curStep)]);
        var goodStep = curStep + 1;
        good = goodStep >= steps.length
            ? gradInterval(card, 4)
            : formatIntervalLabel(steps[goodStep]);
        easy = gradInterval(card, 5);
    } else if (card.is_relearning && relearnSteps.length > 0) {
        var curStep = (card.learning_step !== null && card.learning_step !== undefined)
            ? card.learning_step : 0;
        again = formatIntervalLabel(relearnSteps[0]);
        hard = formatIntervalLabel(relearnSteps[Math.min(curStep, relearnSteps.length - 1)]);
        var goodStep = curStep + 1;
        good = goodStep >= relearnSteps.length
            ? gradInterval(card, 4)
            : formatIntervalLabel(relearnSteps[goodStep]);
        easy = gradInterval(card, 5);
    } else {
        again = relearnSteps.length > 0 ? formatIntervalLabel(relearnSteps[0]) : gradInterval(card, 1);
        hard = gradInterval(card, 3);
        good = gradInterval(card, 4);
        easy = gradInterval(card, 5);
    }

    function setBtn(id, name, interval) {
        var btn = document.getElementById(id);
        if (!btn) return;
        btn.innerHTML = name + '<br><span style="font-size:0.7em;opacity:0.65;">' + interval + '</span>';
        btn.style.height = 'auto';
        btn.style.minHeight = '2.75rem';
        btn.style.paddingTop = '0.35rem';
        btn.style.paddingBottom = '0.35rem';
        btn.style.lineHeight = '1.3';
    }

    setBtn('btn-rate-again', 'Again', again);
    setBtn('btn-rate-hard', 'Hard', hard);
    setBtn('btn-rate-good', 'Good', good);
    setBtn('btn-rate-easy', 'Easy', easy);
}

function revealAnswer() {
    var frontEl = document.getElementById('review-front-text');
    var backEl = document.getElementById('review-back-text');
    var frontHtml = frontEl.innerHTML;
    if (currentDeckAnswerDisplay === 'replace') {
        if (currentCard.back_style) {
            setInnerHTMLWithScripts(frontEl, resolveMedia(renderTemplate(currentCard.back_style, currentCard.fields || {}, frontHtml)));
        } else {
            var bt = currentCard.back || '';
            if (bt.indexOf('[image:') !== -1 || bt.indexOf('[sound:') !== -1) {
                setInnerHTMLWithScripts(frontEl, resolveMedia(bt));
            } else {
                setInnerHTMLWithScripts(frontEl, bt);
            }
        }
        if (currentReviewBehavior.autoplay_audio) playAudioSequentially(frontEl);
    } else {
        if (currentCard.back_style) {
            setInnerHTMLWithScripts(backEl, resolveMedia(renderTemplate(currentCard.back_style, currentCard.fields || {}, frontHtml)));
        } else {
            var bt = currentCard.back || '';
            if (bt.indexOf('[image:') !== -1 || bt.indexOf('[sound:') !== -1) {
                setInnerHTMLWithScripts(backEl, resolveMedia(bt));
            } else {
                setInnerHTMLWithScripts(backEl, bt);
            }
        }
        if (currentReviewBehavior.autoplay_audio) playAudioSequentially(backEl);
        document.getElementById('review-back-container').style.display = 'block';
    }
    document.getElementById('review-rating-buttons').style.display = 'flex';
    document.getElementById('review-show-answer-btn').style.display = 'none';
    updateRatingButtonLabels();
}

function rateCard(rating) {
    if (!bridge || !currentCard) return;
    var steps = currentDeckLearningSteps;

    if (currentCard.is_new && steps.length > 0) {
        var curStep = (currentCard.learning_step !== null && currentCard.learning_step !== undefined)
            ? currentCard.learning_step : -1;
        var newStep;

        if (rating === 1) {         // Again → reset to step 0
            newStep = 0;
        } else if (rating === 3) {  // Hard → stay at current (or step 0 if fresh)
            newStep = Math.max(0, curStep);
        } else if (rating === 4) {  // Good → advance
            newStep = curStep + 1;
        } else {                    // Easy → graduate immediately
            newStep = steps.length;
        }

        if (newStep >= steps.length) {
            // Graduate: run through the active scheduler (SM-2 or FSRS)
            bridge.submitRating(currentCard.id, rating);
        } else {
            // Schedule card to return after the step's real-time delay
            bridge.updateCardLearningStep(currentCard.id, rating, newStep);
            var requeueCard = Object.assign({}, currentCard, fsrsRequeueOverlay(currentCard, rating, { learning_step: newStep }));
            learningQueue.push({ card: requeueCard, showAfter: Date.now() + steps[newStep] * 60 * 1000 });
        }
    } else if (currentCard.is_relearning && currentDeckRelearnSteps.length > 0) {
        var relearnSteps = currentDeckRelearnSteps;
        var curStep = (currentCard.learning_step !== null && currentCard.learning_step !== undefined)
            ? currentCard.learning_step : 0;
        var newStep;

        if (rating === 1) {         // Again → reset to step 0
            newStep = 0;
        } else if (rating === 3) {  // Hard → stay at current step
            newStep = curStep;
        } else if (rating === 4) {  // Good → advance
            newStep = curStep + 1;
        } else {                    // Easy → graduate immediately
            newStep = relearnSteps.length;
        }

        if (newStep >= relearnSteps.length) {
            // Graduated from relearning. Under SM-2 ease was already dropped at
            // lapse, so graduateRelearning freezes it; under FSRS the memory-state
            // update on each press already accounts for the grade.
            bridge.graduateRelearning(currentCard.id, rating);
        } else {
            // Schedule card to return after the relearn step's real-time delay
            bridge.updateCardLearningStep(currentCard.id, rating, newStep);
            var requeueCard = Object.assign({}, currentCard, fsrsRequeueOverlay(currentCard, rating, { learning_step: newStep, is_relearning: true }));
            learningQueue.push({ card: requeueCard, showAfter: Date.now() + relearnSteps[newStep] * 60 * 1000 });
        }
    } else if (!currentCard.is_new && rating === 1 && currentDeckRelearnSteps.length > 0) {
        // Card lapsed - record the failure; logLapse now also parks the card in the
        // relearning queue (step 0, due today), so no separate step call is needed.
        // Mirror the backend lapse state so the graduation labels use post-lapse values.
        bridge.logLapse(currentCard.id, rating);
        var overlay = { learning_step: 0, is_relearning: true };
        if (currentDeckScheduler === 'fsrs' && currentFsrsParams) {
            var sd = fsrsApplyToCard(currentCard, rating);  // rating 1 → forget-stability
            overlay.stability = sd[0];
            overlay.difficulty = sd[1];
            overlay.last_reviewed = srsToday;
        } else {
            overlay.reps = 0;
            overlay.interval = 1;
            overlay.ease_factor = Math.max(1.3, (currentCard.ease_factor || 2.5) - 0.20);
        }
        var requeueCard = Object.assign({}, currentCard, overlay);
        learningQueue.push({ card: requeueCard, showAfter: Date.now() + currentDeckRelearnSteps[0] * 60 * 1000 });
    } else {
        bridge.submitRating(currentCard.id, rating);
    }

    // Advance the appropriate queue pointer
    if (currentCardSource === 'new') {
        newCardIndex++;
    } else if (currentCardSource === 'due') {
        dueCardIndex++;
    }

    showNextCard();
}

function showReviewComplete() {
    document.getElementById('review-card-section').style.display = 'none';
    document.getElementById('review-action-bar').style.display = 'none';
    document.getElementById('review-complete-section').style.display = 'flex';
    var cssEl = document.getElementById('review-card-css');
    if (cssEl) cssEl.textContent = '';
}

// ── Review card menu ──────────────────────────────────────────

function toggleReviewMenu(e) {
    if (e) e.stopPropagation();
    var menu = document.getElementById('review-card-menu');
    var open = menu.style.display !== 'none';
    menu.style.display = open ? 'none' : 'block';
    if (!open) {
        document.addEventListener('click', closeReviewMenu, { once: true });
    }
}

function closeReviewMenu() {
    var menu = document.getElementById('review-card-menu');
    if (menu) menu.style.display = 'none';
}

function editReviewCard() {
    closeReviewMenu();
    if (!currentCard) return;
    editSourceView = 'review';
    editCardFromBrowser(currentCard.id);
}

function deleteReviewCard() {
    closeReviewMenu();
    if (!currentCard) return;
    var cardId = currentCard.id;
    showConfirm('Delete this card? This cannot be undone.', function() {
        if (bridge) bridge.deleteCardFromBrowser(cardId);
        if (currentCardSource === 'new') {
            // The index points AT the current card; after splicing it out the next
            // card shifts into this slot, so the index must stay put. (Decrementing
            // would re-show the previously-reviewed card and inflate the count.)
            newQueue.splice(newCardIndex, 1);
        } else if (currentCardSource === 'due') {
            dueQueue.splice(dueCardIndex, 1);
        } else if (currentCardSource === 'learning') {
            // learningQueue holds {card, showAfter} wrappers, so match on e.card.id.
            var idx = learningQueue.findIndex(function(e) { return e.card.id === cardId; });
            if (idx !== -1) learningQueue.splice(idx, 1);
        }
        currentCard = null;
        updateReviewCounts();
        showNextCard();
    });
}

document.addEventListener('keydown', function(e) {
    if (!currentReviewBehavior.shortcut_enabled || e.code !== currentReviewBehavior.shortcut_key) return;
    var tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
    if (document.getElementById('review-view').classList.contains('view-hidden')) return;
    e.preventDefault();
    var showBtn = document.getElementById('review-show-answer-btn');
    if (showBtn && showBtn.style.display !== 'none') {
        revealAnswer();
    } else if (document.getElementById('review-rating-buttons').style.display !== 'none') {
        rateCard(4);
    }
});

function updateCardTypes(types) {
    cardTypes = types;
    var list = document.getElementById('card-type-list');
    if (list) {
        list.innerHTML = '';
        if (types.length === 0) {
            list.innerHTML = '<p>No card types found.</p>';
        } else {
            var listFrag = document.createDocumentFragment();
            types.forEach(function(ct) {
                var div = document.createElement('div');
                div.className = 'card text-white mb-3';
                div.style.cssText = 'background-color:' + currentAccent + ';width:50%;';
                var actionButtons = ct.is_default ? '' :
                    '<div class="mt-2 d-flex gap-2">' +
                    '<button class="btn btn-dark btn-sm" onclick="showEditCardTypeById(' + ct.id + ')" style="background-color:#2d2a3e;">Edit</button>' +
                    '<button class="btn btn-dark btn-sm" onclick="confirmDeleteCardType(' + ct.id + ')" style="background-color:#c0392b;">Delete</button>' +
                    '</div>';
                div.innerHTML = '<div class="card-body"><h5 class="card-title mb-1">' + ct.name +
                    (ct.is_default ? ' <span class="badge" style="background-color:#2d2a3e;font-size:0.75rem;">Default</span>' : '') +
                    '</h5><p class="mb-1" style="font-size:0.9rem;">Fields: ' + ct.fields.join(', ') + '</p>' +
                    actionButtons + '</div>';
                listFrag.appendChild(div);
            });
            list.appendChild(listFrag);
        }
    }
    var select = document.getElementById('card-type-select');
    if (select) {
        var prev = select.value;
        select.innerHTML = '';
        var selectFrag = document.createDocumentFragment();
        types.forEach(function(ct) {
            var opt = document.createElement('option');
            opt.value = ct.id;
            opt.textContent = ct.name;
            selectFrag.appendChild(opt);
        });
        select.appendChild(selectFrag);
        if (prev && types.some(function(ct) { return String(ct.id) === prev; })) select.value = prev;
        renderCardFields(select.value);
    }
}

function renderCardFields(typeId) {
    var container = document.getElementById('card-fields-container');
    if (!container) return;
    container.innerHTML = '';
    var ct = cardTypes.find(function(t) { return String(t.id) === String(typeId); });
    if (!ct) return;
    var card = document.createElement('div');
    card.className = 'card mb-4 settings-card';
    card.style.maxWidth = '560px';
    var cardBody = document.createElement('div');
    cardBody.className = 'card-body text-white';
    var title = document.createElement('h2');
    title.className = 'settings-section-title';
    title.textContent = 'Content';
    cardBody.appendChild(title);
    ct.fields.forEach(function(fieldName) {
        var wrapper = document.createElement('div');
        wrapper.className = 'mb-3';
        wrapper.innerHTML = '<label class="form-label settings-label">' + fieldName + '</label>' +
            '<textarea class="form-control settings-input card-field-input" data-field="' + fieldName +
            '" placeholder="Enter ' + fieldName +
            '" style="height:100px;"></textarea>' +
            '<div class="mt-1 d-flex gap-2">' +
            '<button type="button" class="btn btn-dark btn-sm" data-field="' + fieldName + '" data-media="image" onclick="attachMedia(this)" style="background-color:#2d2a3e;font-size:0.8rem;">📷 Image</button>' +
            '<button type="button" class="btn btn-dark btn-sm" data-field="' + fieldName + '" data-media="audio" onclick="attachMedia(this)" style="background-color:#2d2a3e;font-size:0.8rem;">🔊 Audio</button>' +
            '</div>';
        cardBody.appendChild(wrapper);
    });
    card.appendChild(cardBody);
    container.appendChild(card);
}

function addCardTypeField(defaultValue) {
    fieldCounter++;
    var id = 'ct-field-' + fieldCounter;
    var row = document.createElement('div');
    row.className = 'd-flex align-items-center mb-2';
    row.id = 'row-' + id;
    row.innerHTML = '<input type="text" class="form-control settings-input card-type-field-input" id="' + id +
        '" placeholder="Field name" value="' + (defaultValue || '') + '">' +
        '<button class="btn btn-dark ms-2" onclick="removeCardTypeField(\'row-' + id +
        '\')" style="background-color:#c0392b;min-width:2.5rem;">✕</button>';
    document.getElementById('card-type-fields-list').appendChild(row);
}

function removeCardTypeField(rowId) {
    var row = document.getElementById(rowId);
    if (row) row.remove();
}

function initCreateCardTypeView() {
    document.getElementById('card-type-name').value = '';
    document.getElementById('card-type-fields-list').innerHTML = '';
    document.getElementById('card-type-front-style').value = '';
    document.getElementById('card-type-back-style').value = '';
    document.getElementById('card-type-css-style').value = '';
    fieldCounter = 0;
    addCardTypeField('');
    addCardTypeField('');
}

function submitCreateCardType() {
    var name = document.getElementById('card-type-name').value.trim();
    if (!name) { showAlert('Please enter a card type name.'); return; }
    var inputs = document.querySelectorAll('.card-type-field-input');
    var fields = Array.from(inputs).map(function(i) { return i.value.trim(); }).filter(Boolean);
    if (fields.length === 0) { showAlert('Please add at least one field.'); return; }
    var frontStyle = document.getElementById('card-type-front-style').value;
    var backStyle = document.getElementById('card-type-back-style').value;
    var cssStyle = document.getElementById('card-type-css-style').value;
    if (bridge) { bridge.createCardType(name, JSON.stringify(fields), frontStyle, backStyle, cssStyle); showView('card-types'); }
}

var currentEditingCardType = null;

function showEditCardTypeById(id) {
    var ct = cardTypes.find(function(t) { return t.id === id; });
    if (!ct) return;
    currentEditingCardType = ct;
    document.getElementById('edit-card-type-name').value = ct.name;
    document.getElementById('edit-card-type-fields-list').innerHTML = '';
    fieldCounter = 0;
    ct.fields.forEach(function(f) { addEditCardTypeField(f); });
    document.getElementById('edit-card-type-front-style').value = ct.front_style || '';
    document.getElementById('edit-card-type-back-style').value = ct.back_style || '';
    document.getElementById('edit-card-type-css-style').value = ct.css_style || '';
    showView('edit-card-type');
}

function addEditCardTypeField(defaultValue) {
    fieldCounter++;
    var id = 'edit-ct-field-' + fieldCounter;
    var row = document.createElement('div');
    row.className = 'd-flex align-items-center mb-2';
    row.id = 'edit-row-' + id;
    row.innerHTML = '<input type="text" class="form-control settings-input edit-card-type-field-input" id="' + id +
        '" placeholder="Field name" value="' + (defaultValue || '') + '">' +
        '<button class="btn btn-dark ms-2" onclick="removeEditCardTypeField(\'edit-row-' + id +
        '\')" style="background-color:#c0392b;min-width:2.5rem;">✕</button>';
    document.getElementById('edit-card-type-fields-list').appendChild(row);
}

function removeEditCardTypeField(rowId) {
    var row = document.getElementById(rowId);
    if (row) row.remove();
}

function submitEditCardType() {
    if (!currentEditingCardType) return;
    var name = document.getElementById('edit-card-type-name').value.trim();
    if (!name) { showAlert('Please enter a card type name.'); return; }
    var inputs = document.querySelectorAll('.edit-card-type-field-input');
    var fields = Array.from(inputs).map(function(i) { return i.value.trim(); }).filter(Boolean);
    if (fields.length === 0) { showAlert('Please add at least one field.'); return; }
    var frontStyle = document.getElementById('edit-card-type-front-style').value;
    var backStyle = document.getElementById('edit-card-type-back-style').value;
    var cssStyle = document.getElementById('edit-card-type-css-style').value;
    if (bridge) { bridge.updateCardType(currentEditingCardType.id, name, JSON.stringify(fields), frontStyle, backStyle, cssStyle); showView('card-types'); }
}

function blurActiveElement(modalEl) {
    modalEl.addEventListener('hide.bs.modal', function() {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, { once: true });
}

function showAlert(message) {
    var modalEl = document.getElementById('alert-modal');
    document.getElementById('alert-modal-message').textContent = message;
    blurActiveElement(modalEl);
    var modal = new bootstrap.Modal(modalEl);
    modal.show();
}

var confirmModalCallback = null;

function showConfirm(message, callback) {
    var modalEl = document.getElementById('confirm-modal');
    confirmModalCallback = callback;
    document.getElementById('confirm-modal-message').textContent = message;
    blurActiveElement(modalEl);
    var modal = new bootstrap.Modal(modalEl);
    modal.show();
}

function confirmModalAction() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    var modal = bootstrap.Modal.getInstance(document.getElementById('confirm-modal'));
    if (modal) modal.hide();
    if (confirmModalCallback) {
        confirmModalCallback();
        confirmModalCallback = null;
    }
}

function confirmDeleteCardType(id) {
    showConfirm('Delete this card type? Cards using it will keep their existing data.', function() {
        if (bridge) bridge.deleteCardType(id);
    });
}

function createCard() {
    var deckSelect = document.getElementById('card-deck-select');
    var currentDeckId = parseInt(deckSelect.value, 10);
    var typeSelect = document.getElementById('card-type-select');
    var cardTypeId = parseInt(typeSelect.value, 10);
    if (!currentDeckId) { showAlert('Please select a deck.'); return; }
    var fieldsObj = {};
    var hasContent = false;
    document.querySelectorAll('.card-field-input').forEach(function(ta) {
        fieldsObj[ta.getAttribute('data-field')] = ta.value.trim();
        if (ta.value.trim()) hasContent = true;
    });
    if (!hasContent) { showAlert('Please fill in at least one field.'); return; }
    if (bridge) {
        bridge.createCard(currentDeckId, cardTypeId, JSON.stringify(fieldsObj));
        document.querySelectorAll('.card-field-input').forEach(function(ta) { ta.value = ''; });
        showView('srs');
    }
}

// ===== Card Browser =====

var browseDebounceTimer = null;
var browseCards = [];          // raw result from the backend
var browseFiltered = [];       // after the client-side status/type filters
var browsePage = 0;
var browsePageSize = 100;
var browseSelected = new Set(); // card ids ticked for bulk actions

function populateBrowseDeckSelect() {
    var select = document.getElementById('browse-deck-select');
    if (!select) return;
    var prev = select.value;
    select.innerHTML = '<option value="0">All Decks</option>';
    var tree = buildDeckTree(decks);
    var flat = flattenDeckTree(tree, 0);
    populateDeckSelectHierarchical(select, flat);
    if (prev && (prev === '0' || decks.some(function(d) { return String(d.id) === prev; }))) {
        select.value = prev;
    }
    syncCustomSelect('browse-deck-select');

    // The bulk bar's move-target select mirrors the deck list.
    var bulk = document.getElementById('browse-bulk-deck');
    if (bulk) {
        var prevBulk = bulk.value;
        bulk.innerHTML = '<option value="0">Move to deck…</option>';
        populateDeckSelectHierarchical(bulk, flat);
        if (prevBulk && decks.some(function(d) { return String(d.id) === prevBulk; })) {
            bulk.value = prevBulk;
        }
        syncCustomSelect('browse-bulk-deck');
    }
}

// Card-type filter options come from the loaded cards themselves, so the list
// only offers types that actually occur in the current deck/search result.
function populateBrowseTypeSelect() {
    var select = document.getElementById('browse-type-select');
    if (!select) return;
    var prev = select.value;
    var seen = {};
    browseCards.forEach(function(c) {
        if (c.card_type_id && c.type_name) seen[c.card_type_id] = c.type_name;
    });
    select.innerHTML = '<option value="0">All Types</option>';
    Object.keys(seen)
        .sort(function(a, b) { return seen[a].localeCompare(seen[b]); })
        .forEach(function(id) {
            var opt = document.createElement('option');
            opt.value = id;
            opt.textContent = seen[id];
            select.appendChild(opt);
        });
    if (prev && (prev === '0' || seen[prev])) select.value = prev;
    syncCustomSelect('browse-type-select');
}

function fetchBrowseCards() {
    if (!bridge) return;
    var deckSel = document.getElementById('browse-deck-select');
    var searchInput = document.getElementById('browse-search-input');
    var sortSel = document.getElementById('browse-sort-select');
    bridge.browseCards(
        String(deckSel ? deckSel.value : '0'),
        searchInput ? searchInput.value : '',
        sortSel ? sortSel.value : 'date_created_desc'
    );
}

function debounceBrowseSearch() {
    if (browseDebounceTimer) clearTimeout(browseDebounceTimer);
    browseDebounceTimer = setTimeout(fetchBrowseCards, 300);
}

function stripHtmlTags(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
}

function truncate(text, maxLen) {
    text = stripHtmlTags(text || '');
    text = text.replace(/\[image:[^\]]+\]/g, '[img]').replace(/\[sound:[^\]]+\]/g, '[audio]');
    if (text.length > maxLen) return text.substring(0, maxLen) + '...';
    return text;
}

function updateBrowseCards(cards) {
    browseCards = cards;
    browseSelected.clear();
    populateBrowseTypeSelect();
    applyBrowseFilters();
}

// A card's lifecycle stage, for the Status column + filter. Mirrors the
// scheduler's buckets: New → Learning (in steps) → Young → Mature (21d+).
function browseCardStatus(c) {
    if (c.is_new) return 'new';
    if (c.learning_step && c.learning_step > 0) return 'learning';
    if ((c.interval || 0) >= 21) return 'mature';
    return 'young';
}

var BROWSE_STATUS_LABELS = { 'new': 'New', learning: 'Learning', young: 'Young', mature: 'Mature' };

function browseIsDue(c) {
    if (c.is_new) return false;
    if (!c.due_date) return false;
    return c.due_date <= todayStr();
}

function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

function applyBrowseFilters() {
    var statusSel = document.getElementById('browse-status-select');
    var typeSel = document.getElementById('browse-type-select');
    var status = statusSel ? statusSel.value : 'all';
    var typeId = typeSel ? typeSel.value : '0';

    browseFiltered = browseCards.filter(function(c) {
        if (typeId !== '0' && String(c.card_type_id) !== typeId) return false;
        if (status === 'all') return true;
        if (status === 'due') return browseIsDue(c);
        return browseCardStatus(c) === status;
    });
    browsePage = 0;
    renderBrowsePage();
}

function renderBrowsePage() {
    var container = document.getElementById('browse-card-list');
    var countEl = document.getElementById('browse-card-count');
    if (!container) return;

    var totalCards = browseFiltered.length;
    var filtered = totalCards !== browseCards.length;
    countEl.textContent = totalCards + (totalCards === 1 ? ' card' : ' cards') +
        (filtered ? ' (of ' + browseCards.length + ')' : '');

    if (totalCards === 0) {
        container.innerHTML = '<p style="opacity: 0.6;">' + (browseCards.length
            ? 'No cards match these filters - try widening the status or card-type filter.'
            : 'No cards here yet. Mine some from the browser extension, or create one under SRS → Create Card.') + '</p>';
        updateBrowseBulkBar();
        return;
    }

    var totalPages = Math.ceil(totalCards / browsePageSize);
    if (browsePage >= totalPages) browsePage = totalPages - 1;
    var start = browsePage * browsePageSize;
    var end = Math.min(start + browsePageSize, totalCards);
    var pageCards = browseFiltered.slice(start, end);

    var table = document.createElement('table');
    table.className = 'browse-table';

    // One delegated click handler: ticking the checkbox toggles selection,
    // clicking anywhere else on the row opens the editor.
    table.addEventListener('click', function(e) {
        var check = e.target.closest('.browse-check');
        if (check) {
            var id = parseInt(check.dataset.cardId, 10);
            if (check.checked) browseSelected.add(id);
            else browseSelected.delete(id);
            var rowEl = check.closest('.browse-row');
            if (rowEl) rowEl.classList.toggle('browse-row-selected', check.checked);
            updateBrowseBulkBar();
            syncBrowseHeaderCheck();
            return;
        }
        if (e.target.closest('.browse-check-cell')) return; // checkbox cell incl. header
        var row = e.target.closest('.browse-row');
        if (row && row.dataset.cardId) {
            editCardFromBrowser(parseInt(row.dataset.cardId, 10));
        }
    });

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr>' +
        '<th class="browse-check-cell"><input type="checkbox" id="browse-check-all" title="Select all on this page"></th>' +
        '<th>Front</th><th>Back</th><th>Deck</th><th>Type</th><th>Status</th><th>Due</th><th>Interval</th></tr>';
    table.appendChild(thead);

    var today = todayStr();
    var tbody = document.createElement('tbody');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < pageCards.length; i++) {
        var card = pageCards[i];
        var tr = document.createElement('tr');
        tr.className = 'browse-row' + (browseSelected.has(card.id) ? ' browse-row-selected' : '');
        tr.dataset.cardId = card.id;
        var st = browseCardStatus(card);
        var statusBadge = '<span class="browse-badge browse-badge-' + st + '">' + BROWSE_STATUS_LABELS[st] + '</span>';
        var due = card.is_new ? '-' : (card.due_date || '-');
        var dueCls = '';
        if (!card.is_new && card.due_date) {
            if (card.due_date < today) dueCls = ' class="browse-due-overdue"';
            else if (card.due_date === today) dueCls = ' class="browse-due-today"';
        }
        tr.innerHTML =
            '<td class="browse-check-cell"><input type="checkbox" class="browse-check" data-card-id="' + card.id + '"' +
                (browseSelected.has(card.id) ? ' checked' : '') + '></td>' +
            '<td class="browse-front">' + escapeHtml(truncate(card.front, 60)) + '</td>' +
            '<td>' + escapeHtml(truncate(card.back, 80)) + '</td>' +
            '<td>' + escapeHtml(card.deck_name || '') + '</td>' +
            '<td>' + escapeHtml(card.type_name || '') + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td' + dueCls + '>' + escapeHtml(due) + '</td>' +
            '<td>' + (card.interval || 0) + 'd</td>';
        frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    table.appendChild(tbody);

    container.innerHTML = '';
    container.appendChild(table);

    // Select-all toggles every row on the current page.
    var checkAll = table.querySelector('#browse-check-all');
    checkAll.addEventListener('change', function() {
        pageCards.forEach(function(c) {
            if (checkAll.checked) browseSelected.add(c.id);
            else browseSelected.delete(c.id);
        });
        table.querySelectorAll('.browse-check').forEach(function(cb) {
            cb.checked = checkAll.checked;
            var rowEl = cb.closest('.browse-row');
            if (rowEl) rowEl.classList.toggle('browse-row-selected', checkAll.checked);
        });
        updateBrowseBulkBar();
    });
    syncBrowseHeaderCheck();

    // Pagination footer: range + page controls + page size.
    var nav = document.createElement('div');
    nav.className = 'browse-pagination';

    var range = document.createElement('span');
    range.className = 'browse-page-range';
    range.textContent = 'Showing ' + (start + 1) + '–' + end + ' of ' + totalCards;
    nav.appendChild(range);

    if (totalPages > 1) {
        var mkBtn = function(label, title, disabled, onClick) {
            var b = document.createElement('button');
            b.className = 'btn btn-dark btn-sm browse-page-btn';
            b.textContent = label;
            b.title = title;
            b.disabled = disabled;
            b.addEventListener('click', onClick);
            return b;
        };
        nav.appendChild(mkBtn('«', 'First page', browsePage === 0,
            function() { browsePage = 0; renderBrowsePage(); }));
        nav.appendChild(mkBtn('‹', 'Previous page', browsePage === 0,
            function() { browsePage--; renderBrowsePage(); }));
        var info = document.createElement('span');
        info.className = 'browse-page-info';
        info.textContent = 'Page ' + (browsePage + 1) + ' of ' + totalPages;
        nav.appendChild(info);
        nav.appendChild(mkBtn('›', 'Next page', browsePage >= totalPages - 1,
            function() { browsePage++; renderBrowsePage(); }));
        nav.appendChild(mkBtn('»', 'Last page', browsePage >= totalPages - 1,
            function() { browsePage = totalPages - 1; renderBrowsePage(); }));
    }

    var sizeWrap = document.createElement('span');
    sizeWrap.className = 'browse-page-size';
    sizeWrap.textContent = 'Per page: ';
    [50, 100, 250].forEach(function(n) {
        var b = document.createElement('button');
        b.className = 'btn btn-dark btn-sm browse-page-btn' + (browsePageSize === n ? ' browse-page-btn-on' : '');
        b.textContent = String(n);
        b.addEventListener('click', function() {
            browsePageSize = n;
            browsePage = 0;
            renderBrowsePage();
        });
        sizeWrap.appendChild(b);
    });
    nav.appendChild(sizeWrap);

    container.appendChild(nav);
    updateBrowseBulkBar();
}

function syncBrowseHeaderCheck() {
    var checkAll = document.getElementById('browse-check-all');
    if (!checkAll) return;
    var boxes = document.querySelectorAll('#browse-card-list .browse-check');
    var checked = 0;
    boxes.forEach(function(cb) { if (cb.checked) checked++; });
    checkAll.checked = boxes.length > 0 && checked === boxes.length;
    checkAll.indeterminate = checked > 0 && checked < boxes.length;
}

function updateBrowseBulkBar() {
    var bar = document.getElementById('browse-bulk-bar');
    var count = document.getElementById('browse-bulk-count');
    if (!bar) return;
    var n = browseSelected.size;
    bar.hidden = n === 0;
    if (count) count.textContent = n + ' selected';
}

function clearBrowseSelection() {
    browseSelected.clear();
    document.querySelectorAll('#browse-card-list .browse-check').forEach(function(cb) {
        cb.checked = false;
        var rowEl = cb.closest('.browse-row');
        if (rowEl) rowEl.classList.remove('browse-row-selected');
    });
    syncBrowseHeaderCheck();
    updateBrowseBulkBar();
}

function bulkDeleteBrowse() {
    var n = browseSelected.size;
    if (!n || !bridge) return;
    showConfirm('Delete ' + n + (n === 1 ? ' card' : ' cards') + '? This cannot be undone.', function() {
        bridge.deleteCardsFromBrowser(JSON.stringify(Array.from(browseSelected)));
        browseSelected.clear();
        updateBrowseBulkBar();
    });
}

function bulkMoveBrowse() {
    var n = browseSelected.size;
    var deckSel = document.getElementById('browse-bulk-deck');
    var deckId = deckSel ? parseInt(deckSel.value, 10) : 0;
    if (!n || !deckId || !bridge) return;
    bridge.moveCardsToDeck(JSON.stringify(Array.from(browseSelected)), deckId);
    browseSelected.clear();
    updateBrowseBulkBar();
}

var editCardData = null; // Store the card being edited
var editSourceView = null; // Track where the edit was initiated from

function editCardFromBrowser(cardId) {
    if (bridge) {
        bridge.getCardForEdit(cardId);
    }
}

function loadCardForEdit(data) {
    var card = data.card;
    // Update cardTypes from bundled data to avoid race condition
    if (data.card_types) {
        cardTypes = data.card_types;
    }

    editCardData = card;
    document.getElementById('edit-card-id').value = card.id;

    // Populate deck select
    var deckSelect = document.getElementById('edit-card-deck-select');
    deckSelect.innerHTML = '';
    var tree = buildDeckTree(decks);
    var flat = flattenDeckTree(tree, 0);
    populateDeckSelectHierarchical(deckSelect, flat);
    if (card.deck_id) deckSelect.value = card.deck_id;

    // Populate card type select
    var typeSelect = document.getElementById('edit-card-type-select');
    typeSelect.innerHTML = '';
    var typeFrag = document.createDocumentFragment();
    cardTypes.forEach(function(ct) {
        var opt = document.createElement('option');
        opt.value = ct.id;
        opt.textContent = ct.name;
        typeFrag.appendChild(opt);
    });
    typeSelect.appendChild(typeFrag);
    if (card.card_type_id) typeSelect.value = card.card_type_id;

    // Stats
    var statusText = card.is_new ? 'New' : (card.interval >= 21 ? 'Mature' : 'Young');
    document.getElementById('edit-card-status').textContent = statusText;
    document.getElementById('edit-card-reps').textContent = card.reps || 0;
    document.getElementById('edit-card-interval').textContent = card.interval || 0;
    document.getElementById('edit-card-ease').textContent = card.ease_factor || '2.5';
    document.getElementById('edit-card-due').textContent = card.due_date || '-';
    document.getElementById('edit-card-created').textContent = card.date_created || '-';
    document.getElementById('edit-card-last-reviewed').textContent = card.last_reviewed || '-';
    var fsrsRow = document.getElementById('edit-card-fsrs-row');
    if (fsrsRow) {
        if (card.scheduler === 'fsrs') {
            fsrsRow.style.display = 'flex';
            document.getElementById('edit-card-stability').textContent = card.stability != null ? card.stability : '-';
            document.getElementById('edit-card-difficulty').textContent = card.difficulty != null ? card.difficulty : '-';
        } else {
            fsrsRow.style.display = 'none';
        }
    }

    // Parse existing field data
    var fields = {};
    if (card.fields) {
        try { fields = typeof card.fields === 'string' ? JSON.parse(card.fields) : card.fields; }
        catch(e) { fields = {}; }
    }

    // If no fields JSON exists, build from front/back
    var ct = cardTypes.find(function(t) { return String(t.id) === String(card.card_type_id); });
    if (Object.keys(fields).length === 0 && (card.front || card.back)) {
        if (ct && ct.fields.length > 0) {
            fields[ct.fields[0]] = card.front || '';
            if (ct.fields.length > 1) fields[ct.fields[1]] = card.back || '';
        }
    }

    renderEditCardFields(typeSelect.value, fields);
    showView('edit-card');
}

// --- Formatting toolbar helpers ---
var HIGHLIGHT_COLOR = '#f5c842';

function applyFormatting(fieldName, command) {
    var el = document.querySelector('.edit-card-field-input[data-field="' + fieldName + '"]');
    if (!el) return;
    el.focus();
    if (command === 'highlight') {
        applyHighlight(el);
    } else if (command === 'removeFormat') {
        document.execCommand('removeFormat', false, null);
    } else {
        document.execCommand(command, false, null);
    }
    updateToolbarState(fieldName);
}

function applyHighlight(el) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var range = sel.getRangeAt(0);

    // Check if already inside a highlight span
    var node = sel.anchorNode;
    var highlightParent = null;
    while (node && node !== el) {
        if (node.nodeType === 1 && node.tagName === 'SPAN' && node.getAttribute('data-highlight') === 'true') {
            highlightParent = node;
            break;
        }
        node = node.parentNode;
    }

    if (highlightParent) {
        // Remove highlight: unwrap the span
        var parent = highlightParent.parentNode;
        while (highlightParent.firstChild) {
            parent.insertBefore(highlightParent.firstChild, highlightParent);
        }
        parent.removeChild(highlightParent);
    } else if (!range.collapsed) {
        // Apply highlight to selection
        var span = document.createElement('span');
        span.style.backgroundColor = HIGHLIGHT_COLOR;
        span.style.color = '#222';
        span.style.borderRadius = '2px';
        span.setAttribute('data-highlight', 'true');
        try {
            range.surroundContents(span);
            sel.removeAllRanges();
            var newRange = document.createRange();
            newRange.selectNodeContents(span);
            sel.addRange(newRange);
        } catch (e) {
            // surroundContents fails if selection crosses element boundaries
            // Fall back to extracting and wrapping
            var fragment = range.extractContents();
            span.appendChild(fragment);
            range.insertNode(span);
            sel.removeAllRanges();
            var fallbackRange = document.createRange();
            fallbackRange.selectNodeContents(span);
            sel.addRange(fallbackRange);
        }
    }
}

function isInsideHighlight(el) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return false;
    var node = sel.anchorNode;
    while (node && node !== el) {
        if (node.nodeType === 1 && node.tagName === 'SPAN' && node.getAttribute('data-highlight') === 'true') {
            return true;
        }
        node = node.parentNode;
    }
    return false;
}

function updateToolbarState(fieldName) {
    var toolbar = document.querySelector('.formatting-toolbar[data-field="' + fieldName + '"]');
    if (!toolbar) return;
    var el = document.querySelector('.edit-card-field-input[data-field="' + fieldName + '"]');
    toolbar.querySelectorAll('.formatting-btn').forEach(function(btn) {
        var cmd = btn.getAttribute('data-cmd');
        if (!cmd || cmd === 'removeFormat') return;
        var active = false;
        if (cmd === 'highlight') {
            active = el ? isInsideHighlight(el) : false;
        } else {
            active = document.queryCommandState(cmd);
        }
        if (active) {
            btn.classList.add('formatting-btn-active');
        } else {
            btn.classList.remove('formatting-btn-active');
        }
    });
}

function buildFormattingToolbar(fieldName) {
    var buttons = [
        { label: 'B', cmd: 'bold', title: 'Bold (Ctrl+B)', style: 'font-weight:bold;' },
        { label: 'I', cmd: 'italic', title: 'Italic (Ctrl+I)', style: 'font-style:italic;' },
        { label: 'U', cmd: 'underline', title: 'Underline (Ctrl+U)', style: 'text-decoration:underline;' },
        { label: 'S', cmd: 'strikeThrough', title: 'Strikethrough (Ctrl+Shift+S)', style: 'text-decoration:line-through;' },
        { label: 'H', cmd: 'highlight', title: 'Highlight (Ctrl+Shift+H)', style: 'background-color:#f5c842;color:#222;border-radius:2px;' },
        { label: 'C', cmd: 'removeFormat', title: 'Clear Formatting (Ctrl+Shift+X)', style: 'opacity:0.7;' }
    ];
    var escapedField = fieldName.replace(/'/g, "\\'");
    var html = '<div class="d-flex gap-1 mb-1 formatting-toolbar" data-field="' + fieldName + '">';
    buttons.forEach(function(b) {
        html += '<button type="button" class="btn btn-dark btn-sm formatting-btn" ' +
            'data-cmd="' + b.cmd + '" ' +
            'title="' + b.title + '" ' +
            'onmousedown="event.preventDefault(); applyFormatting(\'' + escapedField + '\', \'' + b.cmd + '\')" ' +
            'style="background-color:#35324a;font-size:0.78rem;min-width:28px;padding:2px 6px;' + b.style + '">' +
            b.label + '</button>';
    });
    html += '</div>';
    return html;
}

function setupFormattingShortcuts(editor) {
    var fieldName = editor.getAttribute('data-field');

    editor.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            var cmd = null;
            if (e.key === 'b' && !e.shiftKey) cmd = 'bold';
            else if (e.key === 'i' && !e.shiftKey) cmd = 'italic';
            else if (e.key === 'u' && !e.shiftKey) cmd = 'underline';
            else if (e.key === 'S' || (e.key === 's' && e.shiftKey)) cmd = 'strikeThrough';
            else if (e.key === 'H' || (e.key === 'h' && e.shiftKey)) cmd = 'highlight';
            else if (e.key === 'X' || (e.key === 'x' && e.shiftKey)) cmd = 'removeFormat';
            if (cmd) {
                e.preventDefault();
                applyFormatting(fieldName, cmd);
            }
        }
    });

    // Update toolbar state when cursor moves or selection changes
    editor.addEventListener('keyup', function() { updateToolbarState(fieldName); });
    editor.addEventListener('mouseup', function() { updateToolbarState(fieldName); });
    editor.addEventListener('focus', function() { updateToolbarState(fieldName); });
}

function getEditFieldValue(el) {
    return el.innerHTML.replace(/<br\s*\/?>\s*$/, '').trim();
}

function renderEditCardFields(typeId, existingFields) {
    var container = document.getElementById('edit-card-fields-container');
    if (!container) return;

    // If called from onchange (no existingFields), preserve current field values
    if (!existingFields) {
        existingFields = {};
        document.querySelectorAll('.edit-card-field-input').forEach(function(el) {
            existingFields[el.getAttribute('data-field')] = getEditFieldValue(el);
        });
    }

    container.innerHTML = '';
    var ct = cardTypes.find(function(t) { return String(t.id) === String(typeId); });

    if (!ct) {
        // No card type found - show raw Front / Back fields
        var rawFields = [
            { name: 'Front', value: (existingFields && existingFields['Front']) || (editCardData ? editCardData.front : '') || '' },
            { name: 'Back', value: (existingFields && existingFields['Back']) || (editCardData ? editCardData.back : '') || '' }
        ];
        var rawCard = document.createElement('div');
        rawCard.className = 'card mb-4 settings-card';
        rawCard.style.maxWidth = '560px';
        var rawCardBody = document.createElement('div');
        rawCardBody.className = 'card-body text-white';
        var rawTitle = document.createElement('h2');
        rawTitle.className = 'settings-section-title';
        rawTitle.textContent = 'Content';
        rawCardBody.appendChild(rawTitle);
        rawFields.forEach(function(rf) {
            var wrapper = document.createElement('div');
            wrapper.className = 'mb-3';
            wrapper.innerHTML = '<label class="form-label settings-label">' + rf.name + '</label>' +
                buildFormattingToolbar(rf.name) +
                '<div class="form-control settings-input edit-card-field-input" contenteditable="true" data-field="' + rf.name +
                '" data-placeholder="Enter ' + rf.name +
                '" style="height:100px;overflow-y:auto;"></div>' +
                '<div class="mt-1 d-flex gap-2">' +
                '<button type="button" class="btn btn-dark btn-sm" data-field="' + rf.name + '" data-media="image" onclick="attachEditMedia(this)" style="background-color:#2d2a3e;font-size:0.8rem;">📷 Image</button>' +
                '<button type="button" class="btn btn-dark btn-sm" data-field="' + rf.name + '" data-media="audio" onclick="attachEditMedia(this)" style="background-color:#2d2a3e;font-size:0.8rem;">🔊 Audio</button>' +
                '</div>';
            rawCardBody.appendChild(wrapper);
            var editor = wrapper.querySelector('.edit-card-field-input');
            editor.innerHTML = rf.value;
            setupFormattingShortcuts(editor);
        });
        rawCard.appendChild(rawCardBody);
        container.appendChild(rawCard);
        return;
    }

    var card = document.createElement('div');
    card.className = 'card mb-4 settings-card';
    card.style.maxWidth = '560px';
    var cardBody = document.createElement('div');
    cardBody.className = 'card-body text-white';
    var title = document.createElement('h2');
    title.className = 'settings-section-title';
    title.textContent = 'Content';
    cardBody.appendChild(title);
    ct.fields.forEach(function(fieldName) {
        var wrapper = document.createElement('div');
        wrapper.className = 'mb-3';
        wrapper.innerHTML = '<label class="form-label settings-label">' + fieldName + '</label>' +
            buildFormattingToolbar(fieldName) +
            '<div class="form-control settings-input edit-card-field-input" contenteditable="true" data-field="' + fieldName +
            '" data-placeholder="Enter ' + fieldName +
            '" style="height:100px;overflow-y:auto;"></div>' +
            '<div class="mt-1 d-flex gap-2">' +
            '<button type="button" class="btn btn-dark btn-sm" data-field="' + fieldName + '" data-media="image" onclick="attachEditMedia(this)" style="background-color:#2d2a3e;font-size:0.8rem;">📷 Image</button>' +
            '<button type="button" class="btn btn-dark btn-sm" data-field="' + fieldName + '" data-media="audio" onclick="attachEditMedia(this)" style="background-color:#2d2a3e;font-size:0.8rem;">🔊 Audio</button>' +
            '</div>';
        cardBody.appendChild(wrapper);
        var editor = wrapper.querySelector('.edit-card-field-input');
        if (existingFields && existingFields[fieldName] !== undefined) {
            editor.innerHTML = existingFields[fieldName];
        }
        setupFormattingShortcuts(editor);
    });
    card.appendChild(cardBody);
    container.appendChild(card);
}

function attachEditMedia(btn) {
    var fieldName = btn.getAttribute('data-field');
    var mediaType = btn.getAttribute('data-media');
    if (!bridge) return;
    bridge.selectMediaFile(mediaType, function(result) {
        if (result) {
            var el = document.querySelector('.edit-card-field-input[data-field="' + fieldName + '"]');
            if (el) {
                var content = el.innerHTML.replace(/<br\s*\/?>\s*$/, '');
                if (content && content.length > 0) content += '<br>';
                el.innerHTML = content + result;
            }
        }
    });
}

function saveEditCard() {
    var cardId = parseInt(document.getElementById('edit-card-id').value, 10);
    var deckId = parseInt(document.getElementById('edit-card-deck-select').value, 10);
    var typeId = parseInt(document.getElementById('edit-card-type-select').value, 10);

    var fieldsObj = {};
    var hasContent = false;
    document.querySelectorAll('.edit-card-field-input').forEach(function(el) {
        var val = getEditFieldValue(el);
        fieldsObj[el.getAttribute('data-field')] = val;
        if (val) hasContent = true;
    });

    if (!hasContent) { showAlert('Please fill in at least one field.'); return; }

    var ct = cardTypes.find(function(t) { return t.id === typeId; });
    var fieldValues = ct ? ct.fields.map(function(f) { return fieldsObj[f] || ''; }) : Object.values(fieldsObj);
    var front = fieldValues[0] || '';
    var back = fieldValues.length > 1 ? fieldValues.slice(1).join(' / ') : '';

    if (bridge) {
        bridge.updateCard(cardId, deckId, typeId, JSON.stringify(fieldsObj), front, back);
        showAlert('Card saved.');
        if (editSourceView === 'review' && currentCard && currentCard.id === cardId) {
            currentCard.fields = fieldsObj;
            currentCard.front = front;
            currentCard.back = back;
            document.getElementById('review-card-css').textContent = currentCard.css_style || '';
            var frontEl = document.getElementById('review-front-text');
            if (currentCard.front_style) {
                setInnerHTMLWithScripts(frontEl, resolveMedia(renderTemplate(currentCard.front_style, currentCard.fields || {})));
            } else {
                var ft = currentCard.front || '';
                if (ft.indexOf('[image:') !== -1 || ft.indexOf('[sound:') !== -1) {
                    setInnerHTMLWithScripts(frontEl, resolveMedia(ft));
                } else {
                    setInnerHTMLWithScripts(frontEl, ft);
                }
            }
            document.getElementById('review-back-container').style.display = 'none';
            document.getElementById('review-rating-buttons').style.display = 'none';
            document.getElementById('review-show-answer-btn').style.display = 'block';
            editSourceView = null;
            showView('review');
        } else {
            editSourceView = null;
            showView('card-browser');
        }
    }
}

function deleteCardFromEdit() {
    var cardId = parseInt(document.getElementById('edit-card-id').value, 10);
    showConfirm('Delete this card? This cannot be undone.', function() {
        if (bridge) {
            bridge.deleteCardFromBrowser(cardId);
            showView('card-browser');
        }
    });
}

// ── Card Preview ──

var previewCardTypeId = null;

function openCardPreview() {
    var typeId = document.getElementById('edit-card-type-select').value;
    var ct = cardTypes.find(function(t) { return String(t.id) === String(typeId); });
    previewCardTypeId = typeId;

    // Populate styling fields from the card type
    document.getElementById('preview-front-template').value = (ct && ct.front_style) || '';
    document.getElementById('preview-back-template').value = (ct && ct.back_style) || '';
    document.getElementById('preview-css-style').value = (ct && ct.css_style) || '';

    showView('card-preview');
    refreshCardPreview();
}

function getEditCardFields() {
    var fields = {};
    document.querySelectorAll('.edit-card-field-input').forEach(function(el) {
        fields[el.getAttribute('data-field')] = getEditFieldValue(el);
    });
    return fields;
}

function refreshCardPreview() {
    var frontTemplate = document.getElementById('preview-front-template').value;
    var backTemplate = document.getElementById('preview-back-template').value;
    var css = document.getElementById('preview-css-style').value;
    var fields = getEditCardFields();

    // Apply CSS
    document.getElementById('preview-card-css').textContent = css;

    // Render front
    var frontEl = document.getElementById('preview-front-render');
    if (frontTemplate) {
        setInnerHTMLWithScripts(frontEl, resolveMedia(renderTemplate(frontTemplate, fields)));
    } else {
        var firstField = Object.keys(fields)[0];
        setInnerHTMLWithScripts(frontEl, resolveMedia(firstField ? fields[firstField] : ''));
    }

    // Render back
    var backEl = document.getElementById('preview-back-render');
    var frontHtml = frontEl.innerHTML;
    if (backTemplate) {
        setInnerHTMLWithScripts(backEl, resolveMedia(renderTemplate(backTemplate, fields, frontHtml)));
    } else {
        var fieldKeys = Object.keys(fields);
        setInnerHTMLWithScripts(backEl, resolveMedia(fieldKeys.length > 1 ? fields[fieldKeys[1]] : ''));
    }
}

function savePreviewStyling() {
    var ct = cardTypes.find(function(t) { return String(t.id) === String(previewCardTypeId); });
    if (!ct) { showAlert('Card type not found.'); return; }

    var frontStyle = document.getElementById('preview-front-template').value;
    var backStyle = document.getElementById('preview-back-template').value;
    var cssStyle = document.getElementById('preview-css-style').value;

    if (bridge) {
        bridge.updateCardType(ct.id, ct.name, JSON.stringify(ct.fields), frontStyle, backStyle, cssStyle);
        // Update local cardTypes cache
        ct.front_style = frontStyle;
        ct.back_style = backStyle;
        ct.css_style = cssStyle;
        showAlert('Styling saved.');
        showView('edit-card');
    }
}


// ===========================================================
// Immersion Section
// ===========================================================

document.addEventListener('DOMContentLoaded', function() {
    var immersionTabsEl = document.getElementById('immersion-tabs');
    if (immersionTabsEl) {
        immersionTabsEl.addEventListener('shown.bs.tab', function() {
            if (bridge) {
                fetchImmersionStats();
                bridge.getImmersionLogs();
                bridge.getMediaItems();
            }
        });
    }

    var fullLogModal = document.getElementById('full-media-log-modal');
    if (fullLogModal) {
        fullLogModal.addEventListener('click', function(e) {
            if (e.target === fullLogModal) hideFullMediaLog();
        });
    }
});

var immersionCategories = [];
var immersionTimerInterval = null;
var immersionTimerSeconds = 0;
var immersionTimerRunning = false;
var immersionTimerPaused = false;

// --- Timer ---

function immersionTimerStart() {
    var catSelect = document.getElementById('immersion-timer-category');
    if (!catSelect.value) {
        showAlert('Please select a category first.');
        return;
    }
    immersionTimerSeconds = 0;
    immersionTimerRunning = true;
    immersionTimerPaused = false;
    updateTimerDisplay();
    updateTimerButtons('running');
    document.getElementById('immersion-timer-display').classList.add('running');
    document.getElementById('immersion-timer-display').classList.remove('paused');
    catSelect.disabled = true;
    immersionTimerInterval = setInterval(function() {
        immersionTimerSeconds++;
        updateTimerDisplay();
    }, 1000);
}

function immersionTimerPause() {
    if (immersionTimerInterval) clearInterval(immersionTimerInterval);
    immersionTimerRunning = false;
    immersionTimerPaused = true;
    updateTimerButtons('paused');
    document.getElementById('immersion-timer-display').classList.remove('running');
    document.getElementById('immersion-timer-display').classList.add('paused');
}

function immersionTimerResume() {
    immersionTimerRunning = true;
    immersionTimerPaused = false;
    updateTimerButtons('running');
    document.getElementById('immersion-timer-display').classList.add('running');
    document.getElementById('immersion-timer-display').classList.remove('paused');
    immersionTimerInterval = setInterval(function() {
        immersionTimerSeconds++;
        updateTimerDisplay();
    }, 1000);
}

function immersionTimerStop() {
    if (immersionTimerInterval) clearInterval(immersionTimerInterval);
    var catId = parseInt(document.getElementById('immersion-timer-category').value);
    if (bridge && immersionTimerSeconds > 0) {
        bridge.saveImmersionLog(catId, immersionTimerSeconds);
    }
    immersionTimerReset();
}

function immersionTimerDiscard() {
    if (immersionTimerInterval) clearInterval(immersionTimerInterval);
    immersionTimerReset();
}

function immersionTimerReset() {
    immersionTimerSeconds = 0;
    immersionTimerRunning = false;
    immersionTimerPaused = false;
    immersionTimerInterval = null;
    updateTimerDisplay();
    updateTimerButtons('idle');
    var display = document.getElementById('immersion-timer-display');
    display.classList.remove('running', 'paused');
    document.getElementById('immersion-timer-category').disabled = false;
}

function updateTimerDisplay() {
    var h = Math.floor(immersionTimerSeconds / 3600);
    var m = Math.floor((immersionTimerSeconds % 3600) / 60);
    var s = immersionTimerSeconds % 60;
    var display = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    document.getElementById('immersion-timer-display').textContent = display;
}

function updateTimerButtons(state) {
    var startBtn = document.getElementById('immersion-start-btn');
    var pauseBtn = document.getElementById('immersion-pause-btn');
    var resumeBtn = document.getElementById('immersion-resume-btn');
    var stopBtn = document.getElementById('immersion-stop-btn');
    var discardBtn = document.getElementById('immersion-discard-btn');
    startBtn.style.display = state === 'idle' ? '' : 'none';
    pauseBtn.style.display = state === 'running' ? '' : 'none';
    resumeBtn.style.display = state === 'paused' ? '' : 'none';
    stopBtn.style.display = (state === 'running' || state === 'paused') ? '' : 'none';
    discardBtn.style.display = (state === 'running' || state === 'paused') ? '' : 'none';
}

// --- Categories ---

function updateImmersionCategories(cats) {
    immersionCategories = cats;
    populateImmersionCategorySelects();
    renderImmersionCategoryList();
}

function populateImmersionCategorySelects() {
    // Timer select
    var timerSel = document.getElementById('immersion-timer-category');
    var timerVal = timerSel.value;
    timerSel.innerHTML = '<option value="">- Select a category -</option>';
    immersionCategories.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        timerSel.appendChild(opt);
    });
    if (timerVal) timerSel.value = timerVal;

    // Manual log select
    var manualSel = document.getElementById('manual-log-category');
    if (manualSel) {
        var manualVal = manualSel.value;
        manualSel.innerHTML = '';
        immersionCategories.forEach(function(c) {
            var opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            manualSel.appendChild(opt);
        });
        if (manualVal) manualSel.value = manualVal;
    }

}

function renderImmersionCategoryList() {
    var container = document.getElementById('immersion-category-list');
    if (!immersionCategories.length) {
        container.innerHTML = '<p style="color: #888; font-size: 0.88rem;">No categories yet. Create one to get started.</p>';
        return;
    }
    var html = '';
    immersionCategories.forEach(function(c) {
        html += '<div class="immersion-category-row" id="cat-row-' + c.id + '">'
            + '<span class="immersion-color-dot" style="background-color: ' + c.color + ';"></span>'
            + '<span style="flex: 1; font-size: 0.92rem; color: var(--text-1);">' + escapeHtml(c.name) + '</span>'
            + '<button class="btn btn-sm" onclick="editImmersionCategory(' + c.id + ')" style="color: #888; font-size: 0.75rem; padding: 0.15rem 0.4rem;">Edit</button>'
            + '<button class="btn btn-sm" onclick="deleteImmersionCategory(' + c.id + ', \'' + escapeHtml(c.name).replace(/'/g, "\\'") + '\')" style="color: #e74c3c; font-size: 0.75rem; padding: 0.15rem 0.4rem;">Delete</button>'
            + '</div>';
    });
    container.innerHTML = html;
}

function showCreateCategoryForm() {
    document.getElementById('immersion-create-category-form').style.display = '';
    document.getElementById('new-category-name').value = '';
    document.getElementById('new-category-color').value = currentAccent;
    document.getElementById('new-category-name').focus();
}

function hideCreateCategoryForm() {
    document.getElementById('immersion-create-category-form').style.display = 'none';
}

function submitCreateCategory() {
    var name = document.getElementById('new-category-name').value.trim();
    var color = document.getElementById('new-category-color').value;
    if (!name) { showAlert('Please enter a category name.'); return; }
    if (bridge) bridge.createImmersionCategory(name, color);
    hideCreateCategoryForm();
}

function editImmersionCategory(catId) {
    var cat = immersionCategories.find(function(c) { return c.id === catId; });
    if (!cat) return;
    var row = document.getElementById('cat-row-' + catId);
    row.innerHTML = '<input type="color" id="edit-cat-color-' + catId + '" value="' + cat.color + '" style="width: 2rem; height: 2rem; border: none; border-radius: 4px; cursor: pointer; padding: 1px; background: none;">'
        + '<input type="text" id="edit-cat-name-' + catId + '" value="' + escapeHtml(cat.name) + '" class="form-control settings-input" style="flex: 1; font-size: 0.88rem; height: 2rem; padding: 0.2rem 0.5rem;">'
        + '<button class="btn btn-sm btn-accent" onclick="saveEditCategory(' + catId + ')" style="font-size: 0.75rem; padding: 0.15rem 0.5rem; font-weight: 600;">Save</button>'
        + '<button class="btn btn-sm" onclick="renderImmersionCategoryList()" style="color: #888; font-size: 0.75rem; padding: 0.15rem 0.4rem;">Cancel</button>';
    document.getElementById('edit-cat-name-' + catId).focus();
}

function saveEditCategory(catId) {
    var name = document.getElementById('edit-cat-name-' + catId).value.trim();
    var color = document.getElementById('edit-cat-color-' + catId).value;
    if (!name) { showAlert('Category name cannot be empty.'); return; }
    if (bridge) bridge.updateImmersionCategory(catId, name, color);
}

function deleteImmersionCategory(catId, catName) {
    showConfirm('Delete category "' + catName + '" and all its logs? This cannot be undone.', function() {
        if (bridge) bridge.deleteImmersionCategory(catId);
    });
}

// --- Stats ---

function fetchImmersionStats() {
    var period = document.getElementById('immersion-stats-period').value;
    if (bridge) bridge.getImmersionStats(period);
}

function formatDuration(totalSeconds) {
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
}

function updateImmersionStats(stats) {
    // Total time
    document.getElementById('immersion-total-time').textContent = formatDuration(stats.total_seconds);

    // Breakdown list
    var container = document.getElementById('immersion-stats-breakdown');
    if (!stats.categories.length || stats.total_seconds === 0) {
        container.innerHTML = '<p style="color: #888; font-size: 0.88rem;">No immersion data for this period.</p>';
        renderImmersionPieChart([], []);
        return;
    }

    var html = '';
    stats.categories.forEach(function(c) {
        if (c.total_seconds === 0) return;
        var pct = stats.total_seconds > 0 ? (c.total_seconds / stats.total_seconds * 100) : 0;
        html += '<div class="immersion-stat-row">'
            + '<div class="d-flex justify-content-between align-items-center">'
            + '<div class="d-flex align-items-center gap-2">'
            + '<span class="immersion-color-dot" style="background-color: ' + c.color + ';"></span>'
            + '<span style="font-size: 0.9rem; color: var(--text-1);">' + escapeHtml(c.name) + '</span>'
            + '</div>'
            + '<div style="text-align: right;">'
            + '<span style="font-size: 0.9rem; font-weight: 600; color: var(--text-1);">' + formatDuration(c.total_seconds) + '</span>'
            + '<span style="font-size: 0.78rem; color: #888; margin-left: 0.5rem;">' + pct.toFixed(1) + '%</span>'
            + '</div>'
            + '</div>'
            + '<div class="immersion-stat-bar"><div class="immersion-stat-bar-fill" style="width: ' + pct + '%; background-color: ' + c.color + ';"></div></div>'
            + '</div>';
    });
    container.innerHTML = html;

    // Pie chart
    var labels = [];
    var values = [];
    var colors = [];
    stats.categories.forEach(function(c) {
        if (c.total_seconds > 0) {
            labels.push(c.name);
            values.push(c.total_seconds);
            colors.push(c.color);
        }
    });
    renderImmersionPieChart(labels, values, colors);
}

function renderImmersionPieChart(labels, values, colors) {
    var chartEl = document.getElementById('immersion-pie-chart');
    if (typeof Plotly !== 'undefined' && chartEl.data) Plotly.purge(chartEl);
    if (!labels.length) {
        chartEl.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #888; font-size: 0.9rem;">No data</div>';
        return;
    }

    // Format hover text to show duration instead of raw seconds
    var hoverText = values.map(function(v) { return formatDuration(v); });

    var data = [{
        labels: labels,
        values: values,
        type: 'pie',
        hole: 0.5,
        marker: { colors: colors },
        textinfo: 'percent',
        textfont: { color: '#fff', size: 12 },
        hoverinfo: 'label+text+percent',
        text: hoverText,
        sort: false,
    }];
    var layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: { t: 10, b: 10, l: 10, r: 10 },
        showlegend: false,
        font: { family: 'Inter, sans-serif', color: '#fff' },
    };
    Plotly.newPlot(chartEl, data, layout, { displayModeBar: false, responsive: true });
}

// --- Logs ---

function updateImmersionLogs(logs) {
    var container = document.getElementById('immersion-logs-list');
    if (!logs.length) {
        container.innerHTML = '<p style="color: #888; font-size: 0.88rem;">No logs yet. Start the timer or add a manual entry.</p>';
        return;
    }
    var html = '';
    logs.forEach(function(log) {
        html += '<div class="immersion-log-row">'
            + '<span class="immersion-color-dot" style="background-color: ' + log.category_color + ';"></span>'
            + '<span style="flex: 1; color: var(--text-1);">' + escapeHtml(log.category_name) + '</span>'
            + '<span style="font-weight: 600; color: var(--text-1); min-width: 5rem; text-align: right;">' + formatDuration(log.duration_seconds) + '</span>'
            + '<span style="color: #888; min-width: 6.5rem; text-align: right; font-size: 0.8rem;">' + log.log_date + '</span>'
            + '<button class="btn btn-sm" onclick="deleteImmersionLog(' + log.id + ')" style="color: #e74c3c; font-size: 0.7rem; padding: 0.1rem 0.3rem; margin-left: 0.3rem;" title="Delete">✕</button>'
            + '</div>';
    });
    container.innerHTML = html;
}

function deleteImmersionLog(logId) {
    showConfirm('Delete this immersion log?', function() {
        if (bridge) bridge.deleteImmersionLog(logId);
    });
}

// --- Manual Log ---

function showManualLogForm() {
    document.getElementById('immersion-manual-log-form').style.display = '';
    document.getElementById('manual-log-hours').value = '0';
    document.getElementById('manual-log-minutes').value = '0';
    // Set default date to today
    var today = new Date();
    var yyyy = today.getFullYear();
    var mm = String(today.getMonth() + 1).padStart(2, '0');
    var dd = String(today.getDate()).padStart(2, '0');
    document.getElementById('manual-log-date').value = yyyy + '-' + mm + '-' + dd;
}

function hideManualLogForm() {
    document.getElementById('immersion-manual-log-form').style.display = 'none';
}

function submitManualLog() {
    var catId = parseInt(document.getElementById('manual-log-category').value);
    var hours = parseInt(document.getElementById('manual-log-hours').value) || 0;
    var minutes = parseInt(document.getElementById('manual-log-minutes').value) || 0;
    var logDate = document.getElementById('manual-log-date').value;
    var totalSeconds = (hours * 3600) + (minutes * 60);
    if (!catId) { showAlert('Please select a category.'); return; }
    if (totalSeconds <= 0) { showAlert('Please enter a duration greater than 0.'); return; }
    if (!logDate) { showAlert('Please select a date.'); return; }
    if (bridge) bridge.addManualImmersionLog(catId, totalSeconds, logDate);
    hideManualLogForm();
}

// --- Media Categories ---

var mediaCategories = [];

function updateMediaCategories(cats) {
    mediaCategories = cats;
    populateMediaCategorySelect();
    populateMediaLibraryCategoryFilter();
    renderMediaCategoryList();
}

function populateMediaCategorySelect() {
    var sel = document.getElementById('media-add-item-cat');
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '<option value="0">- None -</option>';
    mediaCategories.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
}

function renderMediaCategoryList() {
    var container = document.getElementById('media-category-list');
    if (!container) return;
    if (!mediaCategories.length) {
        container.innerHTML = '<p style="color: #888; font-size: 0.88rem;">No categories yet.</p>';
        return;
    }
    var html = '';
    mediaCategories.forEach(function(c) {
        html += '<div class="immersion-category-row" id="media-cat-row-' + c.id + '">'
            + '<span class="immersion-color-dot" style="background-color: ' + c.color + ';"></span>'
            + '<span style="flex: 1; font-size: 0.88rem; color: var(--text-1);">' + escapeHtml(c.name) + '</span>'
            + '<button class="btn btn-sm" onclick="editMediaCategory(' + c.id + ')" style="color: #888; font-size: 0.75rem; padding: 0.15rem 0.4rem;">Edit</button>'
            + '<button class="btn btn-sm" onclick="deleteMediaCategory(' + c.id + ', \'' + escapeHtml(c.name).replace(/'/g, "\\'") + '\')" style="color: #e74c3c; font-size: 0.75rem; padding: 0.15rem 0.4rem;">Delete</button>'
            + '</div>';
    });
    container.innerHTML = html;
}

function showCreateMediaCategoryForm() {
    document.getElementById('media-create-category-form').style.display = '';
    document.getElementById('media-new-category-name').value = '';
    document.getElementById('media-new-category-color').value = '#9067C6';
}

function hideCreateMediaCategoryForm() {
    document.getElementById('media-create-category-form').style.display = 'none';
}

function submitCreateMediaCategory() {
    var name = document.getElementById('media-new-category-name').value.trim();
    var color = document.getElementById('media-new-category-color').value;
    if (!name) { showAlert('Please enter a category name.'); return; }
    if (bridge) bridge.createMediaCategory(name, color);
    hideCreateMediaCategoryForm();
}

function editMediaCategory(catId) {
    var cat = mediaCategories.find(function(c) { return c.id === catId; });
    if (!cat) return;
    var row = document.getElementById('media-cat-row-' + catId);
    row.innerHTML = '<input type="text" class="form-control settings-input" value="' + escapeHtml(cat.name) + '" style="flex:1; font-size:0.85rem; height:2rem;" id="media-cat-edit-name-' + catId + '">'
        + '<input type="color" value="' + cat.color + '" style="width:2.4rem; height:2rem; border:none; border-radius:4px; cursor:pointer; padding:2px; background:none;" id="media-cat-edit-color-' + catId + '">'
        + '<button class="btn btn-sm btn-accent" onclick="saveMediaCategoryEdit(' + catId + ')" style="font-size:0.75rem; padding:0.15rem 0.5rem;">Save</button>'
        + '<button class="btn btn-sm" onclick="renderMediaCategoryList()" style="color:#888; font-size:0.75rem; padding:0.15rem 0.4rem;">Cancel</button>';
}

function saveMediaCategoryEdit(catId) {
    var name = document.getElementById('media-cat-edit-name-' + catId).value.trim();
    var color = document.getElementById('media-cat-edit-color-' + catId).value;
    if (!name) return;
    if (bridge) bridge.updateMediaCategory(catId, name, color);
}

function deleteMediaCategory(catId, catName) {
    showConfirm('Delete category "' + catName + '"? Existing entries will become uncategorised.', function() {
        if (bridge) bridge.deleteMediaCategory(catId);
    });
}

// --- Media Library ---

var mediaItems = [];
var mediaStatusFilter = 'all';
var expandedMediaItems = {};

function updateMediaItems(items) {
    mediaItems = items;
    populateMediaLibraryCategoryFilter();
    renderMediaLibrary();
}

function setMediaStatusFilter(status) {
    mediaStatusFilter = status;
    document.querySelectorAll('.media-status-pill').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.status === status);
    });
    renderMediaLibrary();
}

function populateMediaLibraryCategoryFilter() {
    var sel = document.getElementById('media-library-cat-filter');
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '<option value="">All types</option>';
    mediaCategories.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = c.name;
        if (String(c.id) === current) opt.selected = true;
        sel.appendChild(opt);
    });
}

function renderMediaLibrary() {
    var container = document.getElementById('media-library-list');
    if (!container) return;
    var query = (document.getElementById('media-library-search') ? document.getElementById('media-library-search').value : '').toLowerCase().trim();
    var catFilter = document.getElementById('media-library-cat-filter') ? document.getElementById('media-library-cat-filter').value : '';
    var filtered = mediaItems.filter(function(item) {
        if (mediaStatusFilter !== 'all' && item.status !== mediaStatusFilter) return false;
        if (catFilter && String(item.category_id) !== catFilter) return false;
        if (query && item.title.toLowerCase().indexOf(query) === -1) return false;
        return true;
    });
    if (!filtered.length) {
        container.innerHTML = '<p style="color: #888; font-size: 0.88rem; padding: 0.5rem 0;">'
            + (mediaItems.length ? 'No items match.' : 'No items yet. Add one above.') + '</p>';
        return;
    }
    var html = '';
    filtered.forEach(function(item) { html += buildMediaItemHtml(item); });
    container.innerHTML = html;
    wrapAllSelects();
    // Re-expand any previously open items
    Object.keys(expandedMediaItems).forEach(function(id) {
        if (expandedMediaItems[id]) {
            var detail = document.getElementById('media-item-detail-' + id);
            var chevron = document.getElementById('media-item-chevron-' + id);
            if (detail) detail.style.display = '';
            if (chevron) chevron.textContent = '▲';
        }
    });
}

var STATUS_LABELS = { watching: 'Watching', completed: 'Completed', dropped: 'Dropped', plan_to_watch: 'Plan to Watch' };
var STATUS_COLORS = { watching: '#4CAF50', completed: '#4e9af1', dropped: '#e74c3c', plan_to_watch: '#888' };

function buildMediaItemHtml(item) {
    var dotColor = item.category_color || '#555';
    var statusLabel = STATUS_LABELS[item.status] || item.status;
    var statusColor = STATUS_COLORS[item.status] || '#888';
    var progressText = (item.progress || item.progress_max)
        ? escapeHtml((item.progress || '-') + (item.progress_max ? ' / ' + item.progress_max : ''))
        : '';
    var timeText = item.total_seconds > 0 ? formatDuration(item.total_seconds) : '';
    var catBadge = item.category_name
        ? '<span style="font-size:0.7rem; color:' + dotColor + '; border:1px solid ' + dotColor + '; border-radius:3px; padding:0.05rem 0.35rem; white-space:nowrap; flex-shrink:0;">' + escapeHtml(item.category_name) + '</span>'
        : '';
    var statusBadge = '<span style="font-size:0.7rem; font-weight:600; color:' + statusColor + '; border:1px solid ' + statusColor + '; border-radius:3px; padding:0.05rem 0.35rem; white-space:nowrap; flex-shrink:0;">' + statusLabel + '</span>';

    return '<div class="media-item-card" id="media-item-' + item.id + '">'
        + '<div class="media-item-header" onclick="toggleMediaItem(' + item.id + ')">'
        + '<span class="immersion-color-dot" style="background-color:' + dotColor + '; flex-shrink:0;"></span>'
        + '<span style="flex:1; font-weight:600; font-size:0.9rem; color:var(--text-1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(item.title) + '</span>'
        + catBadge + statusBadge
        + (progressText ? '<span style="font-size:0.8rem; color:var(--text-2); white-space:nowrap; flex-shrink:0;">' + progressText + '</span>' : '')
        + (timeText ? '<span style="font-size:0.8rem; color:var(--text-2); white-space:nowrap; flex-shrink:0; min-width:3.5rem; text-align:right;">' + timeText + '</span>' : '')
        + '<span id="media-item-chevron-' + item.id + '" style="color:var(--text-3); font-size:0.65rem; flex-shrink:0;">▼</span>'
        + '</div>'
        + '<div id="media-item-detail-' + item.id + '" style="display:none; padding:0.6rem 0.75rem 0.75rem 1.4rem; border-top:1px solid var(--border);">'
        + buildMediaItemDetailHtml(item)
        + '</div>'
        + '</div>';
}

function buildMediaItemDetailHtml(item) {
    var notesHtml = item.notes
        ? '<p style="font-size:0.82rem; color:var(--text-2); margin:0 0 0.5rem; font-style:italic;">' + escapeHtml(item.notes) + '</p>'
        : '';
    var datesHtml = '';
    if (item.date_started || item.date_finished) {
        var parts = [];
        if (item.date_started) parts.push('Started: ' + item.date_started);
        if (item.date_finished) parts.push('Finished: ' + item.date_finished);
        datesHtml = '<p style="font-size:0.78rem; color:var(--text-3); margin:0 0 0.5rem;">' + parts.join('  ·  ') + '</p>';
    }

    var today = new Date();
    var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');

    // Pre-select an immersion category matching the item's media category by name
    var matchedImmCatId = 0;
    if (item.category_name) {
        var matchedCat = immersionCategories.find(function(c) {
            return c.name.toLowerCase() === item.category_name.toLowerCase();
        });
        if (matchedCat) matchedImmCatId = matchedCat.id;
    }
    var defaultChecked = matchedImmCatId > 0;
    var immCatSel = '<select id="session-imm-cat-' + item.id + '" class="form-control dash-select" style="font-size:0.82rem; min-width:8rem;">'
        + '<option value="0">- Category -</option>';
    immersionCategories.forEach(function(c) {
        immCatSel += '<option value="' + c.id + '"' + (c.id === matchedImmCatId ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>';
    });
    immCatSel += '</select>';

    var sessionForm = '<div id="media-session-form-' + item.id + '" style="display:none;" class="media-form-panel mb-3 p-2">'
        + '<div style="font-size:0.78rem; font-weight:600; color:var(--text-2); margin-bottom:0.4rem;">Log Session</div>'
        + '<div class="d-flex flex-wrap gap-2 align-items-end">'
        + '<div><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Hours</label><input type="number" min="0" placeholder="0" id="session-h-' + item.id + '" class="form-control settings-input" style="width:4.5rem; font-size:0.85rem;"></div>'
        + '<div><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Min</label><input type="number" min="0" max="59" placeholder="0" id="session-m-' + item.id + '" class="form-control settings-input" style="width:4.5rem; font-size:0.85rem;"></div>'
        + '<div style="flex:1; min-width:8rem;"><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Progress note</label><input type="text" placeholder="e.g. Ep 12-13" id="session-prog-' + item.id + '" class="form-control settings-input" style="font-size:0.85rem;"></div>'
        + '<div><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Date</label><input type="date" id="session-date-' + item.id + '" value="' + todayStr + '" class="form-control settings-input" style="font-size:0.85rem; width:9.5rem;"></div>'
        + '<button class="btn btn-dark btn-accent btn-sm" onclick="submitMediaSession(' + item.id + '); event.stopPropagation();" style="height:2.2rem; font-size:0.78rem;">Save</button>'
        + '<button class="btn btn-dark btn-sm" onclick="hideMediaSessionForm(' + item.id + '); event.stopPropagation();" style="height:2.2rem; font-size:0.78rem; color:var(--text-muted);">Cancel</button>'
        + '</div>'
        + '<div class="d-flex align-items-center gap-2 mt-2" style="flex-wrap:wrap;">'
        + '<label style="display:flex; align-items:center; gap:0.35rem; font-size:0.8rem; color:var(--text-2); cursor:pointer; user-select:none;">'
        + '<input type="checkbox" id="session-imm-check-' + item.id + '"' + (defaultChecked ? ' checked' : '') + ' onchange="toggleSessionImmCat(' + item.id + ')" style="accent-color:var(--accent);">'
        + 'Count as immersion'
        + '</label>'
        + '<div id="session-imm-cat-wrap-' + item.id + '"' + (defaultChecked ? '' : ' style="display:none;"') + '>'
        + immCatSel
        + '</div>'
        + '</div>'
        + '</div>';

    var statusOpts = [['watching','Watching'],['completed','Completed'],['dropped','Dropped'],['plan_to_watch','Plan to Watch']];
    var statusSel = '<select id="edit-status-' + item.id + '" class="form-control dash-select" style="font-size:0.85rem;">';
    statusOpts.forEach(function(s) { statusSel += '<option value="' + s[0] + '"' + (item.status===s[0]?' selected':'') + '>' + s[1] + '</option>'; });
    statusSel += '</select>';
    var catSel = '<select id="edit-cat-' + item.id + '" class="form-control dash-select" style="font-size:0.85rem;"><option value="0">- None -</option>';
    mediaCategories.forEach(function(c) { catSel += '<option value="' + c.id + '"' + (item.category_id===c.id?' selected':'') + '>' + escapeHtml(c.name) + '</option>'; });
    catSel += '</select>';

    var editForm = '<div id="media-edit-form-' + item.id + '" style="display:none;" class="media-form-panel mb-3 p-2">'
        + '<div style="font-size:0.78rem; font-weight:600; color:var(--text-2); margin-bottom:0.5rem;">Edit Item</div>'
        + '<div class="d-flex flex-wrap gap-2 mb-2">'
        + '<div style="flex:2; min-width:12rem;"><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Title</label><input type="text" id="edit-title-' + item.id + '" value="' + escapeHtml(item.title) + '" class="form-control settings-input" style="font-size:0.85rem;"></div>'
        + '<div style="min-width:9rem;"><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Category</label>' + catSel + '</div>'
        + '<div style="min-width:9rem;"><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Status</label>' + statusSel + '</div>'
        + '</div>'
        + '<div class="d-flex flex-wrap gap-2 mb-2">'
        + '<div><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Progress</label><input type="text" id="edit-prog-' + item.id + '" value="' + escapeHtml(item.progress||'') + '" placeholder="e.g. 12" class="form-control settings-input" style="width:6rem; font-size:0.85rem;"></div>'
        + '<div><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Total</label><input type="text" id="edit-progmax-' + item.id + '" value="' + escapeHtml(item.progress_max||'') + '" placeholder="e.g. 75" class="form-control settings-input" style="width:6rem; font-size:0.85rem;"></div>'
        + '<div><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Started</label><input type="date" id="edit-started-' + item.id + '" value="' + (item.date_started||'') + '" class="form-control settings-input" style="width:9.5rem; font-size:0.85rem;"></div>'
        + '<div><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Finished</label><input type="date" id="edit-finished-' + item.id + '" value="' + (item.date_finished||'') + '" class="form-control settings-input" style="width:9.5rem; font-size:0.85rem;"></div>'
        + '</div>'
        + '<div class="mb-2"><label style="font-size:0.7rem; color:var(--text-muted); display:block;">Notes</label><input type="text" id="edit-notes-' + item.id + '" value="' + escapeHtml(item.notes||'') + '" placeholder="Optional" class="form-control settings-input" style="font-size:0.85rem;"></div>'
        + '<div class="d-flex gap-2">'
        + '<button class="btn btn-dark btn-accent btn-sm" onclick="submitMediaItemEdit(' + item.id + '); event.stopPropagation();" style="font-size:0.78rem;">Save</button>'
        + '<button class="btn btn-dark btn-sm" onclick="hideMediaEditForm(' + item.id + '); event.stopPropagation();" style="font-size:0.78rem; color:var(--text-muted);">Cancel</button>'
        + '</div></div>';

    return notesHtml + datesHtml
        + '<div class="d-flex gap-2 mb-2" style="flex-wrap:wrap;">'
        + '<button class="btn btn-dark btn-accent btn-sm" onclick="showMediaSessionForm(' + item.id + '); event.stopPropagation();" style="font-size:0.78rem;">+ Log Session</button>'
        + '<button class="btn btn-dark btn-sm" onclick="showMediaEditForm(' + item.id + '); event.stopPropagation();" style="font-size:0.78rem; color:var(--text-2);">Edit</button>'
        + '<button class="btn btn-dark btn-sm" onclick="deleteMediaItem(' + item.id + ', ' + jsonAttr(item.title) + '); event.stopPropagation();" style="font-size:0.78rem; color:#e74c3c;">Delete</button>'
        + '</div>'
        + sessionForm + editForm
        + '<div id="media-sessions-list-' + item.id + '" style="margin-top:0.4rem;"><p style="color:#666; font-size:0.82rem; margin:0;">Loading sessions…</p></div>';
}

function toggleMediaItem(itemId) {
    var detail = document.getElementById('media-item-detail-' + itemId);
    var chevron = document.getElementById('media-item-chevron-' + itemId);
    if (!detail) return;
    var isOpen = detail.style.display !== 'none';
    if (isOpen) {
        detail.style.display = 'none';
        if (chevron) chevron.textContent = '▼';
        expandedMediaItems[itemId] = false;
    } else {
        detail.style.display = '';
        if (chevron) chevron.textContent = '▲';
        expandedMediaItems[itemId] = true;
        if (bridge) bridge.getMediaSessions(itemId);
    }
}

function updateMediaSessions(itemId, sessions) {
    var container = document.getElementById('media-sessions-list-' + itemId);
    if (!container) return;
    if (!sessions.length) {
        container.innerHTML = '<p style="color:#666; font-size:0.82rem; margin:0.4rem 0 0;">No sessions logged yet.</p>';
        return;
    }
    var html = '<div style="border-top:1px solid var(--border); padding-top:0.4rem; margin-top:0.4rem;">'
        + '<span style="font-size:0.72rem; font-weight:600; color:var(--text-3); text-transform:uppercase; letter-spacing:0.05em;">Sessions</span></div>';
    sessions.forEach(function(s) {
        var dur = s.duration_seconds ? formatDuration(s.duration_seconds) : '-';
        html += '<div style="display:flex; align-items:center; gap:0.5rem; padding:0.3rem 0; border-bottom:1px solid var(--border); font-size:0.82rem; color:var(--text-2);">'
            + (s.progress_note ? '<span style="color:var(--text-2);">' + escapeHtml(s.progress_note) + '</span><span style="color:#555;">·</span>' : '')
            + '<span style="font-weight:600; color:var(--text-1);">' + dur + '</span>'
            + '<span style="color:#666; margin-left:auto; flex-shrink:0;">' + s.session_date + '</span>'
            + '<button class="btn btn-sm" onclick="deleteMediaSession(' + s.id + ',' + itemId + '); event.stopPropagation();" style="color:#e74c3c; font-size:0.7rem; padding:0.1rem 0.3rem;" title="Delete">✕</button>'
            + '</div>';
    });
    container.innerHTML = html;
}

function toggleSessionImmCat(itemId) {
    var checked = document.getElementById('session-imm-check-' + itemId).checked;
    var wrap = document.getElementById('session-imm-cat-wrap-' + itemId);
    if (wrap) wrap.style.display = checked ? '' : 'none';
}

function showMediaSessionForm(itemId) {
    document.getElementById('media-session-form-' + itemId).style.display = '';
    hideMediaEditForm(itemId);
}
function hideMediaSessionForm(itemId) {
    document.getElementById('media-session-form-' + itemId).style.display = 'none';
}
function submitMediaSession(itemId) {
    var h = parseInt(document.getElementById('session-h-' + itemId).value) || 0;
    var m = parseInt(document.getElementById('session-m-' + itemId).value) || 0;
    var prog = document.getElementById('session-prog-' + itemId).value.trim();
    var sDate = document.getElementById('session-date-' + itemId).value;
    if (!sDate) { showAlert('Please select a date.'); return; }
    var immCatId = 0;
    var immCheck = document.getElementById('session-imm-check-' + itemId);
    if (immCheck && immCheck.checked) {
        immCatId = parseInt(document.getElementById('session-imm-cat-' + itemId).value) || 0;
        if (!immCatId) { showAlert('Please select an immersion category, or uncheck "Count as immersion".'); return; }
    }
    if (bridge) bridge.createMediaSession(itemId, (h * 3600) + (m * 60), prog, sDate, immCatId);
    hideMediaSessionForm(itemId);
}

function showMediaEditForm(itemId) {
    document.getElementById('media-edit-form-' + itemId).style.display = '';
    hideMediaSessionForm(itemId);
}
function hideMediaEditForm(itemId) {
    document.getElementById('media-edit-form-' + itemId).style.display = 'none';
}
function submitMediaItemEdit(itemId) {
    var title = document.getElementById('edit-title-' + itemId).value.trim();
    if (!title) { showAlert('Title is required.'); return; }
    var catId = parseInt(document.getElementById('edit-cat-' + itemId).value) || 0;
    var status = document.getElementById('edit-status-' + itemId).value;
    var prog = document.getElementById('edit-prog-' + itemId).value.trim();
    var progMax = document.getElementById('edit-progmax-' + itemId).value.trim();
    var notes = document.getElementById('edit-notes-' + itemId).value.trim();
    var started = document.getElementById('edit-started-' + itemId).value;
    var finished = document.getElementById('edit-finished-' + itemId).value;
    if (bridge) bridge.updateMediaItem(itemId, title, catId, status, prog, progMax, notes, started, finished);
}

function deleteMediaItem(itemId, title) {
    showConfirm('Delete "' + title + '" and all its sessions? This cannot be undone.', function() {
        if (bridge) bridge.deleteMediaItem(itemId);
        expandedMediaItems[itemId] = false;
    });
}

function deleteMediaSession(sessionId, itemId) {
    showConfirm('Delete this session?', function() {
        if (bridge) bridge.deleteMediaSession(sessionId, itemId);
    });
}

function showAddItemForm() {
    document.getElementById('media-add-item-form').style.display = '';
    document.getElementById('media-add-item-title').value = '';
    document.getElementById('media-add-item-status').value = 'watching';
    document.getElementById('media-add-item-cat').value = '0';
    document.getElementById('media-add-item-prog').value = '';
    document.getElementById('media-add-item-progmax').value = '';
    document.getElementById('media-add-item-notes').value = '';
    document.getElementById('media-add-item-started').value = '';
    document.getElementById('media-add-item-title').focus();
}

function hideAddItemForm() {
    document.getElementById('media-add-item-form').style.display = 'none';
}

function submitAddMediaItem() {
    var title = document.getElementById('media-add-item-title').value.trim();
    if (!title) { showAlert('Please enter a title.'); return; }
    var catId = parseInt(document.getElementById('media-add-item-cat').value) || 0;
    var status = document.getElementById('media-add-item-status').value;
    var prog = document.getElementById('media-add-item-prog').value.trim();
    var progMax = document.getElementById('media-add-item-progmax').value.trim();
    var notes = document.getElementById('media-add-item-notes').value.trim();
    var started = document.getElementById('media-add-item-started').value;
    if (bridge) bridge.createMediaItem(title, catId, status, prog, progMax, notes, started);
    hideAddItemForm();
}

// --- Anime / Manga Search (Jikan) ---

var malSearchMode = 'anime';

function setMalSearchMode(mode) {
    malSearchMode = mode;
    var animeBtn = document.getElementById('mal-toggle-anime');
    var mangaBtn = document.getElementById('mal-toggle-manga');
    if (animeBtn && mangaBtn) {
        animeBtn.style.background = mode === 'anime' ? '#7c6af5' : 'transparent';
        animeBtn.style.color = mode === 'anime' ? '#fff' : '#aaa';
        mangaBtn.style.background = mode === 'manga' ? '#7c6af5' : 'transparent';
        mangaBtn.style.color = mode === 'manga' ? '#fff' : '#aaa';
    }
    var input = document.getElementById('mal-search-input');
    if (input) input.placeholder = mode === 'anime' ? 'Search anime title…' : 'Search manga title…';
    document.getElementById('mal-search-results').innerHTML = '';
    document.getElementById('mal-search-error').style.display = 'none';
}

function malSearch() {
    var query = document.getElementById('mal-search-input').value.trim();
    if (!query) return;
    document.getElementById('mal-search-results').innerHTML = '<p style="color:#888; font-size:0.85rem;">Searching…</p>';
    document.getElementById('mal-search-error').style.display = 'none';
    if (malSearchMode === 'manga') {
        if (bridge) bridge.searchManga(query);
    } else {
        if (bridge) bridge.searchAnime(query);
    }
}

// Keep backward-compat alias
function animeSearch() { malSearch(); }

var animeEpisodesCache = {};

function updateAnimeSearchResults(items, error) {
    animeEpisodesCache = {};
    var errEl = document.getElementById('mal-search-error');
    var resultsEl = document.getElementById('mal-search-results');
    if (error) {
        errEl.textContent = error;
        errEl.style.display = '';
        resultsEl.innerHTML = '';
        return;
    }
    errEl.style.display = 'none';
    if (!items.length) {
        resultsEl.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No results found.</p>';
        return;
    }
    var html = '<div class="d-flex flex-column gap-1">';
    items.forEach(function(item) {
        var displayTitle = item.title_english || item.title;
        if (item.episodes) animeEpisodesCache[item.id] = { totalEpisodes: item.episodes };
        var typeLabel = item.type || '';
        var epLabel = item.episodes ? item.episodes + ' ep' : '';
        var scoreLabel = item.score ? '★ ' + Number(item.score).toFixed(2) : '';
        var meta = [typeLabel, epLabel, scoreLabel].filter(Boolean).join(' · ');
        var img = item.image
            ? '<img src="' + item.image + '" style="width:2.8rem; height:3.8rem; object-fit:cover; border-radius:4px; flex-shrink:0;" onerror="this.style.display=\'none\'">'
            : '<div style="width:2.8rem; height:3.8rem; background:var(--bg-base); border-radius:4px; flex-shrink:0;"></div>';
        html += '<div class="media-item-card" style="border-radius:6px;">'
            + '<div class="d-flex align-items-center gap-2 p-2">'
            + img
            + '<div style="flex:1; min-width:0;">'
            + '<div style="font-weight:600; font-size:0.88rem; color:var(--text-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(displayTitle) + '</div>'
            + (item.title_english && item.title_english !== item.title ? '<div style="font-size:0.73rem; color:var(--text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(item.title) + '</div>' : '')
            + '<div style="font-size:0.73rem; color:var(--text-muted); margin-top:0.1rem;">' + escapeHtml(meta) + '</div>'
            + '</div>'
            + '<button class="btn btn-dark btn-accent btn-sm" onclick="selectAnime(' + item.id + ', ' + jsonAttr(displayTitle) + ')" style="font-size:0.72rem; white-space:nowrap; flex-shrink:0;">+ Add</button>'
            + '</div>'
            + '</div>';
    });
    html += '</div>';
    resultsEl.innerHTML = html;
}

function selectAnime(animeId, title) {
    showAddItemForm();
    document.getElementById('media-add-item-title').value = title;
    var animeCat = mediaCategories.find(function(c) { return c.name.toLowerCase() === 'anime'; });
    if (animeCat) document.getElementById('media-add-item-cat').value = animeCat.id;
    var cached = animeEpisodesCache[animeId];
    if (cached && cached.totalEpisodes) document.getElementById('media-add-item-progmax').value = String(cached.totalEpisodes);
    document.getElementById('mal-search-results').innerHTML = '';
    document.getElementById('mal-search-input').value = '';
}

// --- Manga Search Results ---

function updateMangaSearchResults(items, error) {
    var errEl = document.getElementById('mal-search-error');
    var resultsEl = document.getElementById('mal-search-results');
    if (error) {
        errEl.textContent = error;
        errEl.style.display = '';
        resultsEl.innerHTML = '';
        return;
    }
    errEl.style.display = 'none';
    if (!items.length) {
        resultsEl.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No results found.</p>';
        return;
    }
    var html = '<div class="d-flex flex-column gap-1">';
    items.forEach(function(item) {
        var displayTitle = item.title_english || item.title;
        var typeLabel = item.type || '';
        var chLabel = item.chapters ? item.chapters + ' ch' : '';
        var volLabel = item.volumes ? item.volumes + ' vol' : '';
        var scoreLabel = item.score ? '★ ' + Number(item.score).toFixed(2) : '';
        var meta = [typeLabel, chLabel, volLabel, scoreLabel].filter(Boolean).join(' · ');
        var img = item.image
            ? '<img src="' + item.image + '" style="width:2.8rem; height:3.8rem; object-fit:cover; border-radius:4px; flex-shrink:0;" onerror="this.style.display=\'none\'">'
            : '<div style="width:2.8rem; height:3.8rem; background:var(--bg-base); border-radius:4px; flex-shrink:0;"></div>';
        html += '<div class="media-item-card" style="border-radius:6px;">'
            + '<div class="d-flex align-items-center gap-2 p-2">'
            + img
            + '<div style="flex:1; min-width:0;">'
            + '<div style="font-weight:600; font-size:0.88rem; color:var(--text-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(displayTitle) + '</div>'
            + (item.title_english && item.title_english !== item.title ? '<div style="font-size:0.73rem; color:var(--text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(item.title) + '</div>' : '')
            + '<div style="font-size:0.73rem; color:var(--text-muted); margin-top:0.1rem;">' + escapeHtml(meta) + '</div>'
            + '</div>'
            + '<button class="btn btn-dark btn-accent btn-sm" onclick="selectManga(' + jsonAttr(displayTitle) + ',' + (item.chapters || 0) + ')" style="font-size:0.72rem; white-space:nowrap; flex-shrink:0;">+ Add</button>'
            + '</div>'
            + '</div>';
    });
    html += '</div>';
    resultsEl.innerHTML = html;
}

function selectManga(title, totalChapters) {
    showAddItemForm();
    document.getElementById('media-add-item-title').value = title;
    if (totalChapters) document.getElementById('media-add-item-progmax').value = String(totalChapters);
    var mangaCat = mediaCategories.find(function(c) { return c.name.toLowerCase() === 'manga'; });
    if (mangaCat) document.getElementById('media-add-item-cat').value = mangaCat.id;
    document.getElementById('mal-search-results').innerHTML = '';
    document.getElementById('mal-search-input').value = '';
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Serialize a value to JSON safe for embedding inside an HTML attribute (quotes escaped as &quot;)
function jsonAttr(val) {
    return JSON.stringify(val).replace(/"/g, '&quot;');
}

// ── Custom select dropdowns ──────────────────────────────────────
// Native <select> popups render incorrectly in QtWebEngine (infinite white box).
// Menu is appended directly to <body> when opened so that CSS transforms on
// ancestor cards (e.g. hover translateY) cannot hijack position:fixed coordinates.

var _cselActive = null;
var _cselActiveMenu = null;
var _cselBackdrop = null;

function _cselCloseAll() {
    if (_cselActiveMenu) {
        if (_cselActiveMenu.parentNode) _cselActiveMenu.parentNode.removeChild(_cselActiveMenu);
        _cselActiveMenu = null;
    }
    if (_cselActive) {
        _cselActive.classList.remove('csel-open');
        _cselActive = null;
    }
    if (_cselBackdrop && _cselBackdrop.parentNode) {
        _cselBackdrop.parentNode.removeChild(_cselBackdrop);
    }
}

function _cselShowBackdrop() {
    if (!_cselBackdrop) {
        _cselBackdrop = document.createElement('div');
        _cselBackdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9990;background:transparent;';
        _cselBackdrop.addEventListener('click', _cselCloseAll);
    }
    if (!_cselBackdrop.parentNode) document.body.appendChild(_cselBackdrop);
}

document.addEventListener('scroll', function(e) {
    // Scrolling INSIDE the open dropdown's own overflowing list must not
    // dismiss it; only an outside/page scroll should. e.target is the element
    // that actually scrolled (Node.contains is true for the node itself).
    if (_cselActiveMenu && e.target && e.target.nodeType === 1 &&
        _cselActiveMenu.contains(e.target)) {
        return;
    }
    _cselCloseAll();
}, true);

function wrapSelect(sel) {
    if (sel._cselDone) return;
    sel._cselDone = true;

    var isDash = sel.classList.contains('dash-select');

    var wrap = document.createElement('div');
    wrap.className = 'csel' + (isDash ? ' csel-pill' : ' csel-box');
    if (sel.style.width) {
        wrap.style.width = sel.style.width;
    } else if (!isDash) {
        wrap.style.width = '100%';
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'csel-btn';

    var lbl = document.createElement('span');
    lbl.className = 'csel-lbl';

    var chev = document.createElement('span');
    chev.className = 'csel-chev';
    chev.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    btn.appendChild(lbl);
    btn.appendChild(chev);

    // menu is NOT appended to wrap - it lives in <body> only while open
    var menu = document.createElement('div');
    menu.className = 'csel-menu';
    menu.style.cssText = 'position:fixed;z-index:9999;display:block;';

    wrap.appendChild(btn);
    sel.parentNode.insertBefore(wrap, sel);
    sel.style.cssText = 'display:none !important;';
    wrap.appendChild(sel);

    function syncLabel() {
        var idx = sel.selectedIndex;
        lbl.textContent = (idx >= 0 && sel.options[idx]) ? sel.options[idx].text : '';
    }

    function buildMenu() {
        menu.innerHTML = '';
        Array.from(sel.options).forEach(function(opt) {
            var item = document.createElement('div');
            item.className = 'csel-item' + (opt.value === sel.value ? ' csel-item-on' : '');
            item.textContent = opt.text;
            item.addEventListener('click', function() {
                sel.value = opt.value;
                syncLabel();
                _cselCloseAll();
                sel.dispatchEvent(new Event('change', { bubbles: true }));
            });
            menu.appendChild(item);
        });
    }

    function positionMenu() {
        var rect = btn.getBoundingClientRect();
        menu.style.left = rect.left + 'px';
        menu.style.right = 'auto';
        menu.style.minWidth = rect.width + 'px';
        var spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 160 && rect.top > 160) {
            menu.style.top = 'auto';
            menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        } else {
            menu.style.bottom = 'auto';
            menu.style.top = (rect.bottom + 4) + 'px';
        }
    }

    btn.addEventListener('click', function() {
        var isOpen = (_cselActive === wrap);
        _cselCloseAll();
        if (!isOpen) {
            buildMenu();
            document.body.appendChild(menu);
            positionMenu();
            wrap.classList.add('csel-open');
            _cselActive = wrap;
            _cselActiveMenu = menu;
            _cselShowBackdrop();
        }
    });

    new MutationObserver(syncLabel).observe(sel, { childList: true, subtree: true });

    sel._cselSyncLabel = syncLabel;
    syncLabel();
}

function syncCustomSelect(id) {
    var sel = document.getElementById(id);
    if (sel && sel._cselSyncLabel) sel._cselSyncLabel();
}

function wrapAllSelects() {
    document.querySelectorAll('select').forEach(wrapSelect);
}

document.addEventListener('DOMContentLoaded', wrapAllSelects);
