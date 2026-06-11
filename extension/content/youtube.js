(function () {
  'use strict';

  if (window.__immYTLoaded) return;
  window.__immYTLoaded = true;

  // ── State ────────────────────────────────────────────────────────────────
  let currentVideoId = null;
  let cues = [];            // [{start, end, text}, ...] in seconds
  let activeCueIndex = -1;
  let rafHandle = null;
  let barEl = null;
  let textEl = null;
  let toolbarEl = null;
  let cardPanelEl = null;
  let compEl = null;
  let videoEl = null;
  let captionObserver = null;   // MutationObserver used in DOM-mirror fallback
  let domMirrorActive = false;  // true when cues are being synthesized from the DOM
  let pendingMirrorCue = null;  // {start, text} - open cue waiting for its end timestamp
  let autoPauseEnabled = false; // pause playback at the end of the active sub
  let furiganaEnabled = true;   // show ruby annotations above kanji (on by default)
  let furiganaAvailable = true; // flips off after a backend tokenize failure
  let knownColoring = true;     // colour words by known/unknown status (on by default)
  let knownSet = new Set();     // known lemmas (manual + SRS cards, from the desktop DB)
  let ignoredSet = new Set();   // ignored lemmas (excluded from comprehension)
  let learningSet = new Set();  // learning lemmas (coloured; counted as unknown)
  let knownLoaded = false;

  // Audio-clip padding around the active cue, in ms. Subs are usually
  // timed at or slightly before the audio they describe, so we use zero
  // pre-roll by default and a small post-roll to catch trailing syllables
  // when the sub disappears before the speaker stops. Overridable in
  // chrome.storage.local under imm_yt_settings.{audioStartPadMs,audioEndPadMs}.
  let audioStartPadMs = 0;
  let audioEndPadMs   = 400;

  // Subtitle appearance (the ⚙ cog). subFontScale multiplies the bar's font-size
  // across all display modes; subBgOpacity is the bar background alpha.
  let settingsPanelEl = null;
  let subFontScale = 1;
  let subBgOpacity = 0.78;
  // Font styling: subFontFamily keys into FONT_STACKS, subFontWeight is a CSS
  // weight, subTextColor is the base text colour, subShadow is the outline/shadow
  // strength (0 = none, 1 = default, up to 2 = heavy).
  let subFontFamily = 'sans';
  let subFontWeight = 600;
  let subTextColor = '#ffffff';
  let subShadow = 1;
  // Per-category word-colour markers. Each is an on/off flag + an underline
  // colour, applied to known/unknown-coloured spans (only visible when the 語
  // known-word colouring mode is on). Unknown (purple) and learning (amber)
  // default on; known/ignored default off.
  let markUnknown  = true,  colUnknown  = '#aa00ff';
  let markLearning = true,  colLearning = '#f59e0b';
  let markKnown    = false, colKnown    = '#34d399';
  let markIgnored  = false, colIgnored  = '#94a3b8';

  // Display-timing offset (ms). Positive = delay subs (show later relative
  // to audio); negative = advance them. Lets users dial out drift between
  // yt-dlp's cue timing and YouTube's actual audio rendering. Adjusted with
  // `,` / `.` keys or the queue-header buttons.
  let subOffsetMs = 0;

  const SETTINGS_KEY = 'imm_yt_settings';

  // Sentence-mining defaults (deck / card type / slot→field map), shared with
  // the toolbar popup's "Sentence Mining Cards" section. When configured, the
  // ＋ buttons mine in one click; Shift+click still opens the panel.
  const MINE_KEY = 'imm_yt_mine_settings';
  let ytMine = { deckId: null, typeId: null, fieldMaps: {} };

  // Tokenized text cache: exact sub text → [{text, reading}, ...]. Keyed by
  // the raw string so the same sub never round-trips the backend twice.
  const tokenCache = new Map();
  const TOKEN_CACHE_MAX = 200;
  // Last text we asked the backend to tokenize, used to drop stale responses
  // when the sub changes while a request is in flight.
  let lastTokenizeRequest = '';
  // Word-level analysis cache (for known/unknown colouring): text → tokens.
  const analyzeCache = new Map();
  let lastAnalyzeRequest = '';

  // Queue (sidebar) state. queueRows[i] is the DOM row for cues[i]; in
  // DOM-mirror mode an extra "pending" row may live at queueRows[cues.length]
  // representing the currently-on-screen cue that hasn't closed yet.
  let queueEl = null;
  let queueListEl = null;
  let queueRows = [];
  let queueOpen = true;         // show subtitle queue by default
  let queueLoading = false;
  let videoCompEl = null;       // whole-video comprehension badge (queue header)
  let videoCompReqId = 0;       // guards against stale async responses
  let videoCompTimer = null;    // debounce for recompute on known-set changes
  // When the user manually wheels/touches the list, suspend auto-follow until
  // this timestamp (performance.now() ms). Clicking a row resets it.
  let queueScrollGuardUntil = 0;
  // Observer used to wait for #secondary-inner to appear when ensureQueue()
  // is called before YouTube has hydrated it (common on cold page loads).
  let queueHostObserver = null;

  // ── Settings (chrome.storage.local - Phase 4 will expose UI for these) ──
  function loadSettings() {
    try {
      chrome.storage.local.get([SETTINGS_KEY, MINE_KEY], (data) => {
        if (data && data[MINE_KEY]) {
          ytMine = { deckId: null, typeId: null, fieldMaps: {}, ...data[MINE_KEY] };
        }
        const s = data && data[SETTINGS_KEY];
        if (!s) return;
        autoPauseEnabled = !!s.autoPause;
        // Furigana, known-word colouring and the queue default ON — absent keys
        // (new user / settings saved before these existed) read as enabled, but
        // an explicit false (user turned it off) is still respected.
        furiganaEnabled = s.furigana !== false;
        knownColoring = s.knownColoring !== false;
        queueOpen = s.queueOpen !== false;
        if (Number.isFinite(s.audioStartPadMs)) audioStartPadMs = s.audioStartPadMs;
        if (Number.isFinite(s.audioEndPadMs))   audioEndPadMs   = s.audioEndPadMs;
        if (Number.isFinite(s.subOffsetMs))     subOffsetMs     = s.subOffsetMs;
        if (Number.isFinite(s.subFontScale)) subFontScale = clampScale(s.subFontScale);
        if (Number.isFinite(s.subBgOpacity)) subBgOpacity = clampOpacity(s.subBgOpacity);
        if (typeof s.subFontFamily === 'string' && FONT_STACKS[s.subFontFamily]) subFontFamily = s.subFontFamily;
        if (Number.isFinite(s.subFontWeight)) subFontWeight = s.subFontWeight;
        if (typeof s.subTextColor === 'string') subTextColor = s.subTextColor;
        if (Number.isFinite(s.subShadow)) subShadow = clampShadow(s.subShadow);
        if (typeof s.markUnknown  === 'boolean') markUnknown  = s.markUnknown;
        if (typeof s.markLearning === 'boolean') markLearning = s.markLearning;
        if (typeof s.markKnown    === 'boolean') markKnown    = s.markKnown;
        if (typeof s.markIgnored  === 'boolean') markIgnored  = s.markIgnored;
        if (typeof s.colUnknown  === 'string') colUnknown  = s.colUnknown;
        if (typeof s.colLearning === 'string') colLearning = s.colLearning;
        if (typeof s.colKnown    === 'string') colKnown    = s.colKnown;
        if (typeof s.colIgnored  === 'string') colIgnored  = s.colIgnored;
        applySubAppearance();
        syncAutoPauseButton();
        syncFuriganaButton();
        syncKnownButton();
        syncQueueButton();
        syncQueueVisibility();
        syncOffsetDisplay();
        if (knownColoring && !knownLoaded) loadKnownWords();
        renderText();
      });
    } catch (_) { /* no storage permission in some contexts */ }
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({
        [SETTINGS_KEY]: {
          autoPause: autoPauseEnabled,
          furigana: furiganaEnabled,
          knownColoring,
          queueOpen,
          audioStartPadMs,
          audioEndPadMs,
          subOffsetMs,
          subFontScale,
          subBgOpacity,
          subFontFamily,
          subFontWeight,
          subTextColor,
          subShadow,
          markUnknown,
          markLearning,
          markKnown,
          markIgnored,
          colUnknown,
          colLearning,
          colKnown,
          colIgnored,
        },
      });
    } catch (_) {}
  }

  // Pick up audio-padding changes from the options page live (they're read at
  // clip time, so no re-render is needed). Furigana / auto-pause defaults are
  // applied on the next video load by loadSettings(), to avoid fighting the
  // in-player toggle buttons mid-session.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Mining defaults edited from the toolbar popup apply live.
      if (changes[MINE_KEY]) {
        ytMine = { deckId: null, typeId: null, fieldMaps: {}, ...(changes[MINE_KEY].newValue || {}) };
      }
      if (!changes[SETTINGS_KEY]) return;
      const s = changes[SETTINGS_KEY].newValue;
      if (!s) return;
      if (Number.isFinite(s.audioStartPadMs)) audioStartPadMs = s.audioStartPadMs;
      if (Number.isFinite(s.audioEndPadMs))   audioEndPadMs   = s.audioEndPadMs;
      // Known-colouring toggle from the options page applies live.
      if (typeof s.knownColoring === 'boolean' && s.knownColoring !== knownColoring) {
        knownColoring = s.knownColoring;
        syncKnownButton();
        if (knownColoring && !knownLoaded) loadKnownWords();
        else renderText();
      }
    });
  } catch (_) {}

  // The popup (content.js, same page) fires this when the user marks a word
  // known/unknown, so the sub bar recolours without a round-trip to the backend.
  try {
    window.addEventListener('imm-known-changed', (e) => {
      const d = e.detail || {};
      const terms = Array.isArray(d.terms) ? d.terms : (d.term ? [d.term] : []);
      if (!terms.length) return;
      // status: 'known' | 'ignored' | 'unknown' (cleared). Fall back to the
      // legacy boolean `known` flag.
      const status = d.status || (d.known ? 'known' : 'unknown');
      for (const t of terms) {
        knownSet.delete(t); ignoredSet.delete(t); learningSet.delete(t);
        if (status === 'known') knownSet.add(t);
        else if (status === 'learning') learningSet.add(t);
        else if (status === 'ignored') ignoredSet.add(t);
      }
      if (knownColoring) renderText();
      scheduleVideoComprehension();   // known set changed → restated video score
    });
  } catch (_) {}

  // ── Page-script injection ───────────────────────────────────────────────
  // Runs in the page's JS world so it can read window.ytInitialPlayerResponse.
  function injectPageScript() {
    const url = chrome.runtime.getURL('content/page-script.js');
    if (document.querySelector(`script[src="${url}"]`)) return;
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Caption fetching ────────────────────────────────────────────────────
  // YouTube's timedtext endpoint sometimes returns an empty body for certain
  // formats (esp. ASR / auto-generated tracks). Try JSON3 first, fall back to
  // the XML format, then parse whichever format we got.
  async function fetchCues(trackUrl) {
    const jsonText = await fetchAs(trackUrl, 'json3');
    if (jsonText && jsonText.trim().startsWith('{')) {
      return parseJson3(jsonText);
    }

    const xmlText = await fetchAs(trackUrl, 'srv3');
    if (xmlText && xmlText.trim().startsWith('<')) {
      return parseTimedtextXml(xmlText);
    }

    const rawText = await fetchAs(trackUrl, null);
    if (rawText) {
      if (rawText.trim().startsWith('{')) return parseJson3(rawText);
      if (rawText.trim().startsWith('<')) return parseTimedtextXml(rawText);
    }

    throw new Error('caption track returned empty/unrecognized response');
  }

  async function fetchAs(trackUrl, fmt) {
    const url = new URL(trackUrl);
    if (fmt) url.searchParams.set('fmt', fmt);
    else url.searchParams.delete('fmt');
    const res = await fetch(url.toString(), { credentials: 'include' });
    if (!res.ok) return '';
    return res.text();
  }

  function parseJson3(text) {
    const data = JSON.parse(text);
    const out = [];
    for (const ev of (data.events || [])) {
      if (!ev.segs) continue;
      const t = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
      if (!t) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const end = start + ((ev.dDurationMs || 0) / 1000);
      out.push({ start, end, text: t });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  function parseTimedtextXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const out = [];

    const pNodes = doc.getElementsByTagName('p');
    if (pNodes.length) {
      for (const p of pNodes) {
        const start = (parseInt(p.getAttribute('t') || '0', 10)) / 1000;
        const dur = parseInt(p.getAttribute('d') || '0', 10) / 1000;
        const text = (p.textContent || '').replace(/\n/g, ' ').trim();
        if (!text) continue;
        out.push({ start, end: start + dur, text });
      }
    } else {
      const textNodes = doc.getElementsByTagName('text');
      for (const t of textNodes) {
        const start = parseFloat(t.getAttribute('start') || '0');
        const dur = parseFloat(t.getAttribute('dur') || '0');
        const text = decodeXmlEntities(t.textContent || '').replace(/\n/g, ' ').trim();
        if (!text) continue;
        out.push({ start, end: start + dur, text });
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  function decodeXmlEntities(s) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  }

  // ── Bar + toolbar DOM ───────────────────────────────────────────────────
  function ensureBar() {
    const player = document.getElementById('movie_player');
    if (!player) return null;

    if (barEl && player.contains(barEl)) {
      // Bar persists across SPA nav, but YouTube's polymer rerenders
      // #secondary-inner on each new video - re-attach the queue if so.
      ensureQueue();
      return barEl;
    }

    barEl = document.createElement('div');
    barEl.id = '__imm_yt_subbar';
    barEl.className = 'imm-yt-subbar';

    toolbarEl = buildToolbar();
    barEl.appendChild(toolbarEl);

    textEl = document.createElement('div');
    textEl.className = 'imm-yt-subbar-text';
    barEl.appendChild(textEl);

    cardPanelEl = buildCardPanel();
    barEl.appendChild(cardPanelEl);

    settingsPanelEl = buildSettingsPanel();
    barEl.appendChild(settingsPanelEl);

    applySubAppearance();
    player.appendChild(barEl);
    syncAutoPauseButton();
    syncFuriganaButton();
    syncQueueButton();
    ensureQueue();
    return barEl;
  }

  function buildToolbar() {
    const t = document.createElement('div');
    t.className = 'imm-yt-toolbar';

    t.appendChild(makeButton('imm-yt-btn-prev',   '⏮', 'Previous sub (A)',  prevCue));
    t.appendChild(makeButton('imm-yt-btn-replay', '↻', 'Replay sub (S)',    replayCue));
    t.appendChild(makeButton('imm-yt-btn-next',   '⏭', 'Next sub (D)',      nextCue));
    t.appendChild(makeButton('imm-yt-btn-pause',  '⏸', 'Auto-pause at end of sub', toggleAutoPause));
    t.appendChild(makeButton('imm-yt-btn-furi',   'あ', 'Show furigana',     toggleFurigana));
    t.appendChild(makeButton('imm-yt-btn-known',  '語', 'Colour known / unknown words', toggleKnownColoring));
    t.appendChild(makeButton('imm-yt-btn-card',   '＋', 'Make card from sub (Shift+click to choose deck & fields)', toggleCardPanel));
    t.appendChild(makeButton('imm-yt-btn-queue',  '☰', 'Show subtitle queue', toggleQueue));
    t.appendChild(makeButton('imm-yt-btn-settings', '⚙', 'Subtitle appearance', toggleSettingsPanel));

    compEl = document.createElement('span');
    compEl.id = 'imm-yt-comp';
    compEl.className = 'imm-yt-comp';
    compEl.title = 'Comprehension: known words / scoreable words in this line';
    compEl.style.display = 'none';
    t.appendChild(compEl);

    return t;
  }

  function makeButton(id, label, title, onClick) {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.className = 'imm-yt-btn';
    b.title = title;
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick(e);
    });
    return b;
  }

  function syncAutoPauseButton() {
    const btn = toolbarEl && toolbarEl.querySelector('#imm-yt-btn-pause');
    if (!btn) return;
    btn.classList.toggle('is-on', autoPauseEnabled);
    btn.title = autoPauseEnabled
      ? 'Auto-pause at end of sub (on) - toggle off'
      : 'Auto-pause at end of sub (off) - toggle on';
  }

  function syncFuriganaButton() {
    const btn = toolbarEl && toolbarEl.querySelector('#imm-yt-btn-furi');
    if (!btn) return;
    btn.classList.toggle('is-on', furiganaEnabled);
    // Never `disabled` - the user must always be able to toggle the state
    // back off, even when the backend is misbehaving. We just dim the icon
    // visually so they know it's not actually rendering.
    btn.classList.toggle('is-unavailable', !furiganaAvailable);
    btn.title = !furiganaAvailable
      ? 'Furigana unavailable - restart the desktop app or install sudachipy'
      : furiganaEnabled
        ? 'Hide furigana'
        : 'Show furigana';
  }

  function syncKnownButton() {
    const btn = toolbarEl && toolbarEl.querySelector('#imm-yt-btn-known');
    if (!btn) return;
    btn.classList.toggle('is-on', knownColoring);
    btn.classList.toggle('is-unavailable', !furiganaAvailable);  // same tokenizer
    btn.title = !furiganaAvailable
      ? 'Word colouring unavailable - restart the desktop app or install sudachipy'
      : knownColoring
        ? 'Hide known/unknown colouring'
        : 'Colour known / unknown words';
  }

  function toggleKnownColoring() {
    knownColoring = !knownColoring;
    syncKnownButton();
    saveSettings();
    if (knownColoring && !knownLoaded) loadKnownWords();
    else renderText();
    scheduleVideoComprehension(0);
  }

  function loadKnownWords() {
    sendBackground({ action: 'get_known_words' }).then((r) => {
      if (r && !r.error && Array.isArray(r.known)) {
        knownSet = new Set(r.known);
        ignoredSet = new Set(Array.isArray(r.ignored) ? r.ignored : []);
        learningSet = new Set(Array.isArray(r.learning) ? r.learning : []);
        knownLoaded = true;
        if (knownColoring) renderText();
        scheduleVideoComprehension(0);
      }
    });
  }

  // Current sub text in plain form (no markup). The bar's actual DOM may
  // contain <ruby> annotations when furigana is on.
  let currentText = '';

  function setText(text) {
    if (currentText === text && textEl &&
        textEl.dataset.lastFurigana === String(furiganaEnabled) &&
        textEl.dataset.lastKnown === (knownColoring ? '1' : '0')) return;
    currentText = text;
    renderText();
  }

  // Render `currentText` into the bar - either as plain text or with ruby
  // annotations from the tokenizer cache. If furigana is on but the text
  // isn't tokenized yet, render plain immediately and re-render when the
  // tokens arrive.
  function renderText() {
    if (!textEl) return;
    const text = currentText;
    textEl.dataset.lastFurigana = String(furiganaEnabled);
    textEl.dataset.lastKnown = knownColoring ? '1' : '0';

    // Comprehension badge only applies to the known-colouring view; hide it for
    // every other render path (it's re-shown by paintWords when applicable).
    if (compEl && !(knownColoring && furiganaAvailable)) compEl.style.display = 'none';

    if (!text) {
      textEl.textContent = '';
      if (compEl) compEl.style.display = 'none';
      if (barEl) barEl.style.display = (cardPanelOpen() || settingsPanelOpen()) ? 'flex' : 'none';
      return;
    }

    // Known/unknown colouring uses word-level analysis (which also carries the
    // furigana ruby), so it owns rendering whenever it's on. Same tokenizer
    // availability as furigana.
    if (knownColoring && furiganaAvailable) {
      const atoks = analyzeCache.get(text);
      if (atoks) {
        paintWords(atoks);
      } else {
        textEl.textContent = text;
        if (compEl) compEl.style.display = 'none';
        requestAnalyze(text);
      }
      if (barEl) barEl.style.display = 'flex';
      return;
    }

    if (!furiganaEnabled || !furiganaAvailable) {
      textEl.textContent = text;
      if (barEl) barEl.style.display = 'flex';
      return;
    }

    const tokens = tokenCache.get(text);
    if (tokens) {
      paintTokens(tokens);
    } else {
      textEl.textContent = text;
      requestFurigana(text);
    }
    if (barEl) barEl.style.display = 'flex';
  }

  function tokenSurface(tok) {
    return (tok.ruby || []).map(s => s.text).join('');
  }

  function tokenInnerHtml(tok) {
    let inner = '';
    for (const seg of (tok.ruby || [])) {
      const safe = escapeHtml(seg.text);
      inner += (furiganaEnabled && seg.reading)
        ? `<ruby>${safe}<rt>${escapeHtml(seg.reading)}</rt></ruby>`
        : safe;
    }
    return inner;
  }

  // POS categories that are inflection/derivation tails - they belong to the
  // preceding content word, not standalone (た in 食べた, ない in 高くない).
  const TAIL_POS = new Set(['助動詞', '接尾辞']);
  const MAX_KNOWN_SPAN = 6;

  // Render word-level tokens (from `analyze`): each word is one span classed
  // known/unknown; ruby is included when furigana is also on. Two reconciliations
  // bridge the dictionary↔Sudachi boundary mismatch:
  //   1. merge adjacent tokens whose combined surface is a known term (この間 =
  //      この + 間), and
  //   2. absorb inflection tails into the content word so 食べた (食べ + た) is one
  //      span coloured by the head's dictionary form (食べる).
  function paintWords(tokens) {
    if (!textEl) return;
    const surfaces = tokens.map(tokenSurface);
    const parts = [];
    let scoreTotal = 0;   // scoreable (content, non-ignored) units
    let scoreKnown = 0;
    let i = 0;
    while (i < tokens.length) {
      // 1. Longest run (>=2) whose combined surface is a known term.
      let runLen = 0;
      let combined = '';
      for (let j = i; j < Math.min(tokens.length, i + MAX_KNOWN_SPAN); j++) {
        combined += surfaces[j];
        if (knownSet.has(combined)) runLen = j - i + 1;
      }
      if (runLen >= 2) {
        let inner = '';
        for (let k = i; k < i + runLen; k++) inner += tokenInnerHtml(tokens[k]);
        parts.push(`<span class="imm-word imm-known">${inner}</span>`);
        scoreTotal++; scoreKnown++;
        i += runLen;
        continue;
      }

      const head = tokens[i];
      if (!head.content) {
        // Particles, conjunctions (でも), copula, punctuation: not vocab to
        // study. Dim them like known words so the only thing that stands out is
        // unknown vocab ("not highlighted" == "nothing to learn here").
        parts.push(`<span class="imm-word imm-grammar">${tokenInnerHtml(head)}</span>`);
        i++;
        continue;
      }

      // 2. Content word + its inflection tail(s) as one unit.
      let j = i + 1;
      while (j < tokens.length && TAIL_POS.has(tokens[j].pos)) j++;
      let inner = '';
      let unitSurface = '';
      for (let k = i; k < j; k++) { inner += tokenInnerHtml(tokens[k]); unitSurface += surfaces[k]; }
      const keys = [head.lemma, surfaces[i], unitSurface, head.base, head.norm];
      let cls;
      if (keys.some(k => ignoredSet.has(k))) {
        cls = 'imm-ignored';                 // excluded from the comprehension %
      } else if (keys.some(k => learningSet.has(k))) {
        cls = 'imm-learning'; scoreTotal++;  // being learned - still unknown for the %
      } else if (keys.some(k => knownSet.has(k))) {
        cls = 'imm-known'; scoreTotal++; scoreKnown++;
      } else {
        cls = 'imm-unknown'; scoreTotal++;
      }
      parts.push(`<span class="imm-word ${cls}">${inner}</span>`);
      i = j;
    }
    textEl.innerHTML = parts.join('');
    updateComprehension(scoreKnown, scoreTotal);
  }

  // Show "known/total · NN%" for the current line; i+1 lines (one unknown) get
  // a marker since they're the prime mining targets.
  function updateComprehension(known, total) {
    if (!compEl) return;
    if (!knownColoring || total <= 0) { compEl.style.display = 'none'; return; }
    const pct = Math.round((known / total) * 100);
    const oneT = (total - known) === 1;
    compEl.textContent = `${pct}%` + (oneT ? ' ·1' : '');
    compEl.title = `Comprehension: ${known}/${total} words known in this line`
      + (oneT ? ' — i+1 (one unknown word)' : '');
    compEl.classList.toggle('is-onet', oneT);
    compEl.style.display = 'inline-flex';
  }

  // Whole-video comprehension: send every cue to the backend, which scores them
  // against the effective known set (cards ∪ manual − ignored) and aggregates.
  // Debounced because known-set changes (marking words) fire rapidly.
  function scheduleVideoComprehension(delay = 600) {
    clearTimeout(videoCompTimer);
    videoCompTimer = setTimeout(computeVideoComprehension, delay);
  }

  function computeVideoComprehension() {
    if (!videoCompEl) return;
    // Only worth the backend pass when the user is actually looking at it.
    if (!(queueOpen || knownColoring) || !cues.length) {
      videoCompEl.style.display = 'none';
      return;
    }
    const texts = cues.map(c => c.text).filter(Boolean);
    if (!texts.length) { videoCompEl.style.display = 'none'; return; }
    const myId = ++videoCompReqId;
    const vid = currentVideoId;
    sendBackground({ action: 'comprehension', texts }).then((r) => {
      if (myId !== videoCompReqId || vid !== currentVideoId || !videoCompEl) return;
      if (!r || r.error || typeof r.percent !== 'number') {
        videoCompEl.style.display = 'none';
        return;
      }
      const pct = Math.round(r.percent);
      const oneT = r.one_t_lines || 0;
      videoCompEl.innerHTML =
        '<span class="imm-yt-comp-label">Video Comprehension</span>'
        + `<span class="imm-yt-comp-pill">${pct}%</span>`
        + `<span class="imm-yt-comp-sub">${oneT ? `${oneT} lines with 1 new word` : ''}</span>`;
      videoCompEl.title =
        `Estimated comprehension of the whole video: ${pct}%, across ${r.lines} subtitle lines.`
        + (oneT ? ` ${oneT} lines have exactly one unknown word (good mining targets).` : '');
      videoCompEl.style.display = 'flex';
    }).catch(() => {});
  }

  function requestAnalyze(text) {
    if (lastAnalyzeRequest === text) return;  // already in flight
    lastAnalyzeRequest = text;
    sendBackground({ action: 'analyze', text }).then((resp) => {
      if (currentText !== text) return;  // moved on to a newer sub
      if (resp.error) {
        if (/sudachi/i.test(resp.error) || /not installed/i.test(resp.error)) {
          furiganaAvailable = false;
          syncFuriganaButton();
          syncKnownButton();
        }
        if (textEl && currentText === text) textEl.textContent = text;
        return;
      }
      const tokens = resp.tokens || [];
      if (analyzeCache.size >= TOKEN_CACHE_MAX) {
        const firstKey = analyzeCache.keys().next().value;
        if (firstKey !== undefined) analyzeCache.delete(firstKey);
      }
      analyzeCache.set(text, tokens);
      if (knownColoring) paintWords(tokens);
    });
  }

  function paintTokens(tokens) {
    if (!textEl) return;
    // Use innerHTML with a safe construction (we control the input - it's
    // tokenized output from our own backend, no user-supplied HTML).
    const parts = [];
    for (const tok of tokens) {
      const safe = escapeHtml(tok.text);
      if (tok.reading) {
        parts.push(`<ruby>${safe}<rt>${escapeHtml(tok.reading)}</rt></ruby>`);
      } else {
        parts.push(safe);
      }
    }
    textEl.innerHTML = parts.join('');
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function requestFurigana(text) {
    if (lastTokenizeRequest === text) return;  // already in flight
    lastTokenizeRequest = text;
    sendBackground({ action: 'tokenize', text }).then((resp) => {
      // Drop response if we've moved on to a newer sub.
      if (currentText !== text) return;
      if (resp.error) {
        console.warn('[immersion-yt] tokenize failed:', resp.error);
        // Only flip to permanently-unavailable on errors that say the
        // tokenizer isn't installed. Transient errors (timeout, connection
        // loss, "unknown action" from an old app build) shouldn't lock the
        // toggle - those resolve once the app is restarted with the new
        // ws_server build.
        if (/sudachi/i.test(resp.error) || /not installed/i.test(resp.error)) {
          furiganaAvailable = false;
          syncFuriganaButton();
        }
        if (textEl && currentText === text) textEl.textContent = text;
        return;
      }
      const tokens = resp.tokens || [];
      if (tokenCache.size >= TOKEN_CACHE_MAX) {
        const firstKey = tokenCache.keys().next().value;
        if (firstKey !== undefined) tokenCache.delete(firstKey);
      }
      tokenCache.set(text, tokens);
      if (furiganaEnabled) paintTokens(tokens);
    });
  }

  function toggleFurigana() {
    furiganaEnabled = !furiganaEnabled;
    syncFuriganaButton();
    saveSettings();
    renderText();
  }

  // ── Cue lookup ──────────────────────────────────────────────────────────
  // Effective end of cue i: clamp cue.end to the next cue's start. yt-dlp's
  // (and YouTube's) cue.end values are sometimes longer than the audible
  // duration, so without clamping the bar lingers on the old line after the
  // next one has audibly started.
  function cueEnd(i) {
    const c = cues[i];
    if (!c) return Infinity;
    const next = cues[i + 1];
    return next ? Math.min(c.end, next.start) : c.end;
  }

  function findCueIndex(t) {
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (t < c.start) hi = mid - 1;
      else if (t >= cueEnd(mid)) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  // Nearest preceding cue when no cue is active at time t (used by prev/replay
  // so the user can hit "replay" during a silent gap between subs).
  function findCueIndexAtOrBefore(t) {
    if (!cues.length) return -1;
    let lo = 0, hi = cues.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  // Returns the cue the user is currently watching, as a {start, end, text}
  // object. In DOM-mirror mode the active sub lives in pendingMirrorCue and
  // hasn't been pushed into cues[] yet - we synthesise its end from the
  // current playhead so submitCard and nav use the right timestamps.
  function getActiveCue() {
    if (domMirrorActive && pendingMirrorCue && videoEl) {
      const start = pendingMirrorCue.start;
      const end = Math.max(start + 0.1, videoEl.currentTime);
      return { start, end, text: pendingMirrorCue.text, _pending: true };
    }
    const idx = currentCueIndexForNav();
    if (idx < 0) return null;
    return cues[idx];
  }

  // ── Update loop ─────────────────────────────────────────────────────────
  // Effective time = raw playhead minus the user's display offset. Positive
  // offset → effective_t lags behind → we stay on earlier cues for longer
  // (subs appear later). Used for all cue lookup; raw currentTime is still
  // used for the auto-pause check so the pause point shifts with the offset.
  function effectiveTime() {
    if (!videoEl) return 0;
    return videoEl.currentTime - subOffsetMs / 1000;
  }

  function tick() {
    rafHandle = null;
    updateActiveCueForTime();
    // Keep the rAF loop running only while the video is actively playing with
    // cues loaded. A paused/ended tab - or DOM-mirror mode, which has no cues[]
    // and is driven by a MutationObserver instead - rests until a play/seek
    // event re-arms us (see wireVideoEvents). This stops a perpetual ~60fps
    // loop running on every YouTube tab for the page's whole lifetime.
    if (videoEl && cues.length && !videoEl.paused && !videoEl.ended) {
      scheduleTick();
    }
  }

  // Recompute and apply the active cue for the current playhead. Safe to call
  // ad-hoc from video events (play/pause/seeked) as well as from the rAF loop.
  function updateActiveCueForTime() {
    if (!videoEl || !cues.length) return;
    const t = effectiveTime();
    let idx = activeCueIndex;
    if (idx >= 0 && idx < cues.length) {
      const c = cues[idx];
      const end = cueEnd(idx);
      if (t >= c.start && t < end) return;
      if (idx + 1 < cues.length) {
        const n = cues[idx + 1];
        if (t >= n.start && t < cueEnd(idx + 1)) {
          setActiveCue(idx + 1);
          return;
        }
      }
      // Cue just ended - honour auto-pause and leave the text visible so the
      // user can read while paused. We only fire once per cue end by gating
      // on a small window past the cue's end.
      if (autoPauseEnabled && t >= end && t < end + 0.5 && !videoEl.paused) {
        try { videoEl.pause(); } catch (_) {}
        return;
      }
    }
    idx = findCueIndex(t);
    if (idx !== activeCueIndex) setActiveCue(idx);
  }

  function setActiveCue(idx) {
    activeCueIndex = idx;
    setText(idx >= 0 ? cues[idx].text : '');
    updateActiveRow();
  }

  function scheduleTick() {
    if (rafHandle == null) {
      rafHandle = requestAnimationFrame(tick);
    }
  }

  function stopTick() {
    if (rafHandle != null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  // Drive the rAF loop off the video's own play state: arm it on play, let it
  // stop itself on pause/ended (tick() won't reschedule), and resync the active
  // cue immediately on pause/seek so the subtitle is correct without polling.
  let wiredVideoEl = null;
  function onVideoPlay() { scheduleTick(); }
  function onVideoPauseOrEnd() { stopTick(); updateActiveCueForTime(); }
  function onVideoSeeked() {
    updateActiveCueForTime();
    if (videoEl && !videoEl.paused && !videoEl.ended) scheduleTick();
  }
  function wireVideoEvents() {
    if (videoEl === wiredVideoEl) return;  // YouTube reuses the <video> element
    if (wiredVideoEl) {
      wiredVideoEl.removeEventListener('play', onVideoPlay);
      wiredVideoEl.removeEventListener('playing', onVideoPlay);
      wiredVideoEl.removeEventListener('pause', onVideoPauseOrEnd);
      wiredVideoEl.removeEventListener('ended', onVideoPauseOrEnd);
      wiredVideoEl.removeEventListener('seeked', onVideoSeeked);
    }
    wiredVideoEl = videoEl;
    if (!videoEl) return;
    videoEl.addEventListener('play', onVideoPlay);
    videoEl.addEventListener('playing', onVideoPlay);
    videoEl.addEventListener('pause', onVideoPauseOrEnd);
    videoEl.addEventListener('ended', onVideoPauseOrEnd);
    videoEl.addEventListener('seeked', onVideoSeeked);
  }

  // ── Navigation ──────────────────────────────────────────────────────────
  function currentCueIndexForNav() {
    if (!videoEl || !cues.length) return -1;
    if (activeCueIndex >= 0) return activeCueIndex;
    return findCueIndexAtOrBefore(effectiveTime());
  }

  function seekTo(seconds) {
    if (!videoEl) return;
    try { videoEl.currentTime = Math.max(0, seconds); } catch (_) {}
  }

  // Seek so that `cue` becomes the active displayed cue. For API/yt-dlp
  // cues we add the user's display offset so the bar shows this cue
  // immediately after the seek; mirror cues were recorded against raw
  // playhead time and don't need the shift.
  function seekToCueStart(cue) {
    if (!cue) return;
    const shift = domMirrorActive ? 0 : subOffsetMs / 1000;
    seekTo(cue.start + shift);
  }

  function prevCue() {
    if (!videoEl) return;
    const t = effectiveTime();

    // In DOM-mirror mode the active sub is still in pendingMirrorCue. "prev"
    // there means rewind to that pending cue's start (if we're well past it)
    // or to the last closed cue.
    if (domMirrorActive && pendingMirrorCue) {
      const REWIND = 0.4;
      if (t - pendingMirrorCue.start >= REWIND) {
        seekTo(pendingMirrorCue.start);
      } else if (cues.length) {
        seekToCueStart(cues[cues.length - 1]);
        setActiveCue(cues.length - 1);
      }
      return;
    }

    if (!cues.length) return;
    let idx = currentCueIndexForNav();
    if (idx < 0) return;
    const REWIND_THRESHOLD = 0.4;
    if (t - cues[idx].start < REWIND_THRESHOLD && idx > 0) idx -= 1;
    seekToCueStart(cues[idx]);
    setActiveCue(idx);
  }

  function replayCue() {
    if (!videoEl) return;
    if (domMirrorActive && pendingMirrorCue) {
      seekTo(pendingMirrorCue.start);
      return;
    }
    if (!cues.length) return;
    const idx = currentCueIndexForNav();
    if (idx < 0) return;
    seekToCueStart(cues[idx]);
    setActiveCue(idx);
  }

  function nextCue() {
    if (!videoEl) return;
    // In DOM-mirror mode there's no "next" yet - the active line is still
    // being filled. Best we can do is leave playback as-is.
    if (domMirrorActive && pendingMirrorCue) return;

    if (!cues.length) return;
    let idx = currentCueIndexForNav();
    if (idx < 0) {
      seekToCueStart(cues[0]);
      setActiveCue(0);
      return;
    }
    if (idx + 1 < cues.length) {
      seekToCueStart(cues[idx + 1]);
      setActiveCue(idx + 1);
    }
  }

  function toggleAutoPause() {
    autoPauseEnabled = !autoPauseEnabled;
    syncAutoPauseButton();
    saveSettings();
  }

  // ── Per-video lifecycle ─────────────────────────────────────────────────
  async function loadVideo(videoId, trackUrl) {
    stopTick();
    stopCaptionObserver();
    cues = [];
    activeCueIndex = -1;
    domMirrorActive = false;
    pendingMirrorCue = null;
    currentVideoId = videoId;
    clearQueueRows();
    setText('');
    closeCardPanel();
    if (videoCompEl) videoCompEl.style.display = 'none';  // clear last video's score

    if (!trackUrl) return;

    videoEl = document.querySelector('#movie_player video') || document.querySelector('video');
    wireVideoEvents();
    ensureBar();

    let parsed = null;
    try {
      parsed = await fetchCues(trackUrl);
    } catch (e) {
      // Most common cause: track requires a PoT token we can't generate
      // (timedtext endpoint has been gated this way since late 2024 for both
      // manual and auto-gen tracks on many videos).
      console.warn('[immersion-yt] direct caption fetch failed:', e.message);
    }

    if (currentVideoId !== videoId) return;

    // Direct fetch worked - preload everything.
    if (parsed && parsed.length) {
      cues = parsed;
      syncQueue();
      computeVideoComprehension();
      if (videoEl) scheduleTick();
      return;
    }

    // Direct fetch empty/failed. Ask the desktop app to fetch via yt-dlp,
    // which handles the PoT dance. While waiting, mark the queue as loading
    // so the user sees feedback instead of an empty panel.
    queueLoading = true;
    syncQueue();
    let backendCues = null;
    try {
      const resp = await sendBackground({
        action: 'get_youtube_subs',
        video_url: location.href.split('&')[0],
        lang: 'ja',
      });
      if (resp && !resp.error && Array.isArray(resp.cues) && resp.cues.length) {
        backendCues = resp.cues;
      } else if (resp && resp.error) {
        console.warn('[immersion-yt] backend subs failed:', resp.error);
      }
    } catch (e) {
      console.warn('[immersion-yt] backend subs threw:', e);
    }
    queueLoading = false;

    if (currentVideoId !== videoId) return;

    if (backendCues && backendCues.length) {
      cues = backendCues;
      syncQueue();
      computeVideoComprehension();
      if (videoEl) scheduleTick();
      return;
    }

    // Both API and backend failed - mirror YouTube's own caption DOM as a
    // last resort so the user still sees captions, even if one-at-a-time.
    syncQueue();
    startCaptionObserver();
  }

  // ── DOM-mirror fallback ─────────────────────────────────────────────────
  function startCaptionObserver() {
    const player = document.getElementById('movie_player');
    if (!player) return;

    domMirrorActive = true;

    const ccBtn = player.querySelector('.ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') !== 'true') {
      try { ccBtn.click(); } catch (_) {}
    }

    const readCaptions = () => {
      // YouTube renders each caption inside a .caption-window. Two pitfalls:
      //   1. .ytp-caption-segment lives *inside* .caption-visual-line which
      //      lives inside .caption-window. Selecting more than one level
      //      double-counts the text (visible as the sentence repeated on
      //      each line, or the bar growing taller each transition).
      //   2. During line transitions YouTube leaves the previous caption
      //      window in the DOM (fading out) while the new one fades in. We
      //      skip near-invisible windows and dedupe by text so the user
      //      doesn't see old + new stacked.
      // Collect visible caption windows (skip fading-out ones).
      const allWindows = Array.from(player.querySelectorAll('.caption-window'));
      const visible = allWindows.filter(w =>
        parseFloat(getComputedStyle(w).opacity || '1') >= 0.5
      );

      // For auto-generated (rollup) captions YouTube stacks the previous N
      // lines inside ONE .caption-window - new words roll in at the bottom,
      // older lines stay above. Showing the whole window's textContent makes
      // the bar accumulate every line that ever scrolled by ("wall of text").
      // We always take the LAST .caption-visual-line inside the active
      // window so the bar tracks the current line only.
      const w = visible.length ? visible[visible.length - 1] : null;
      let text = '';
      if (w) {
        const visualLines = w.querySelectorAll('.caption-visual-line');
        const last = visualLines.length
          ? visualLines[visualLines.length - 1]
          : w;
        text = (last.textContent || '').replace(/\s+/g, ' ').trim();
      } else {
        // Fallback for layouts where .caption-window isn't present (some
        // embedded players). Segments alone - never both at once.
        const segs = player.querySelectorAll('.ytp-caption-segment');
        text = Array.from(segs)
          .map(s => s.textContent || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
      }
      setText(text);
      recordMirrorTransition(text);
    };

    captionObserver = new MutationObserver(readCaptions);
    captionObserver.observe(player, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    readCaptions();

    // Auto-pause + tick loop still run, against the synthetic cues we're
    // recording. Without an `end` for the in-flight cue, auto-pause can't
    // fire until the cue closes - that's fine, it pauses at the next change.
    scheduleTick();
  }

  function recordMirrorTransition(text) {
    if (!videoEl) return;
    const t = videoEl.currentTime;

    // Same text as the currently open cue → nothing to update.
    if (pendingMirrorCue && pendingMirrorCue.text === text) return;

    // Auto-generated (rollup) captions add words to the same line one at a
    // time. Treat the new value as a continuation of the same cue when it
    // extends the pending text - keep the original start time and just
    // grow the cue's text. Without this, prev/replay/next would jump to
    // every word boundary and mining would clip just the last word.
    if (pendingMirrorCue && text && (
      text.startsWith(pendingMirrorCue.text) ||
      pendingMirrorCue.text.startsWith(text)
    )) {
      // Keep the longer of the two so a brief partial render doesn't
      // shorten the line we already committed to.
      if (text.length >= pendingMirrorCue.text.length) {
        pendingMirrorCue.text = text;
      }
      return;
    }

    // Real cue boundary - close the pending cue.
    if (pendingMirrorCue) {
      const start = pendingMirrorCue.start;
      const end = Math.max(t, start + 0.05);
      // Drop any existing cue that overlaps this one (re-watches, seeks).
      while (cues.length && cues[cues.length - 1].start >= start) cues.pop();
      cues.push({ start, end, text: pendingMirrorCue.text });
      pendingMirrorCue = null;
    }

    if (text) {
      pendingMirrorCue = { start: t, text };
    }

    activeCueIndex = cues.length - 1;
    syncQueue();
  }

  function stopCaptionObserver() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    domMirrorActive = false;
  }

  // ── Card creation panel ─────────────────────────────────────────────────
  let decksCache = null;
  let cardTypesCache = null;
  const cardFieldMap = new Map(); // key: card_type_id → {sentence, image, audio}
  // When set, submitCard mines this cue instead of getActiveCue(). Used by
  // queue rows so mining a past row in DOM-mirror mode picks the right line
  // even while pendingMirrorCue is set.
  let cardOverrideCue = null;

  function cardPanelOpen() {
    return !!(cardPanelEl && cardPanelEl.classList.contains('is-open'));
  }

  function buildCardPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'imm-yt-card-panel';

    const row1 = document.createElement('div');
    row1.className = 'imm-yt-card-row';

    const deckSel = document.createElement('select');
    deckSel.className = 'imm-yt-select';
    deckSel.id = 'imm-yt-deck-select';
    row1.appendChild(labeled('Deck', deckSel));

    const typeSel = document.createElement('select');
    typeSel.className = 'imm-yt-select';
    typeSel.id = 'imm-yt-type-select';
    typeSel.addEventListener('change', renderFieldMap);
    row1.appendChild(labeled('Card type', typeSel));

    wrap.appendChild(row1);

    const fieldMapWrap = document.createElement('div');
    fieldMapWrap.className = 'imm-yt-fieldmap';
    fieldMapWrap.id = 'imm-yt-fieldmap';
    wrap.appendChild(fieldMapWrap);

    const row2 = document.createElement('div');
    row2.className = 'imm-yt-card-row imm-yt-card-actions';

    const status = document.createElement('span');
    status.className = 'imm-yt-status';
    status.id = 'imm-yt-card-status';
    row2.appendChild(status);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'imm-yt-btn-text';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeCardPanel);
    row2.appendChild(cancel);

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'imm-yt-btn-primary';
    submit.textContent = 'Create card';
    submit.addEventListener('click', submitCard);
    row2.appendChild(submit);

    wrap.appendChild(row2);
    return wrap;
  }

  function labeled(label, control) {
    const w = document.createElement('label');
    w.className = 'imm-yt-field';
    const s = document.createElement('span');
    s.className = 'imm-yt-field-label';
    s.textContent = label;
    w.appendChild(s);
    w.appendChild(control);
    return w;
  }

  function saveYtMine() {
    try { chrome.storage.local.set({ [MINE_KEY]: ytMine }); } catch (_) {}
  }

  function ytMineFieldMap() {
    if (ytMine.typeId == null || !ytMine.fieldMaps) return null;
    return ytMine.fieldMaps[ytMine.typeId] || ytMine.fieldMaps[String(ytMine.typeId)] || null;
  }

  function ytMineConfigured() {
    return !!(ytMine.deckId && ytMine.typeId && ytMineFieldMap());
  }

  // One-click mine of a cue with the saved defaults. Falls back to the panel
  // when the defaults are missing/stale (deleted deck or card type) or the
  // backend is unreachable (the panel surfaces the error). Feedback lands on
  // the clicked ＋ button itself, since no panel is open.
  async function quickMineCue(cue, btn) {
    const origText  = btn ? btn.textContent : '';
    const origTitle = btn ? btn.title : '';
    const flash = (sym, msg) => {
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = sym;
      if (msg) btn.title = msg;
      setTimeout(() => { btn.textContent = origText; btn.title = origTitle; }, 1600);
    };
    const restore = () => {
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    };
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    try {
      await Promise.all([loadDecks(), loadCardTypes()]);
    } catch (_) {
      restore();
      await openCardPanel();
      return;
    }

    const slotMap = ytMineFieldMap();
    const haveDeck = (decksCache || []).some(d => String(d.id) === String(ytMine.deckId));
    const haveType = (cardTypesCache || []).some(t => String(t.id) === String(ytMine.typeId));
    const fieldMap = {};
    for (const [slot, f] of Object.entries(slotMap || {})) {
      if (f) fieldMap[slot] = f;
    }
    if (!haveDeck || !haveType || !Object.keys(fieldMap).length) {
      restore();
      await openCardPanel();
      return;
    }

    let imageB64 = null;
    try {
      imageB64 = captureScreenshot();
    } catch (e) {
      console.warn('[immersion-yt] screenshot failed', e);
    }

    const startMs = Math.max(0, Math.round(cue.start * 1000) + audioStartPadMs);
    const endMs   = Math.max(startMs + 100, Math.round(cue.end * 1000) + audioEndPadMs);
    const resp = await sendBackground({
      action: 'create_card_with_media',
      video_url: location.href.split('&')[0],
      start_ms: startMs,
      end_ms:   endMs,
      sentence: cue.text,
      image_b64: imageB64,
      deck_id: Number(ytMine.deckId),
      card_type_id: Number(ytMine.typeId),
      field_map: fieldMap,
    });
    if (resp.error) {
      flash('⚠', 'Error: ' + resp.error);
      return;
    }
    if (resp.audio_skipped) {
      console.warn('[immersion-yt] audio_skipped:', resp.audio_skipped);
      flash('✓', `Card #${resp.card_id} created - audio skipped: ${resp.audio_skipped}`);
      return;
    }
    flash('✓', `Card #${resp.card_id} created`);
  }

  async function toggleCardPanel(e) {
    if (cardPanelOpen()) { closeCardPanel(); return; }
    if (!(e && e.shiftKey) && ytMineConfigured()) {
      const cue = getActiveCue();
      if (cue && cue.text) {
        const btn = toolbarEl && toolbarEl.querySelector('#imm-yt-btn-card');
        await quickMineCue({ start: cue.start, end: cue.end, text: cue.text }, btn);
        return;
      }
      // No active line - the panel's status message explains that better.
    }
    openCardPanel();
  }

  async function openCardPanel() {
    if (!cardPanelEl) return;
    if (settingsPanelOpen()) closeSettingsPanel();
    cardPanelEl.classList.add('is-open');
    if (barEl) barEl.style.display = 'flex';
    setCardStatus('');

    // Pause playback so the screenshot matches what the user is reading.
    if (videoEl && !videoEl.paused) {
      try { videoEl.pause(); } catch (_) {}
    }

    try {
      await Promise.all([loadDecks(), loadCardTypes()]);
    } catch (e) {
      setCardStatus('Could not reach Immersion Suite: ' + e.message, 'error');
    }
  }

  function closeCardPanel() {
    if (!cardPanelEl) return;
    cardPanelEl.classList.remove('is-open');
    cardOverrideCue = null;
    if (barEl) barEl.style.display = textEl && textEl.textContent ? 'flex' : 'none';
  }

  // ── Subtitle-look settings (⚙) ──────────────────────────────────────────
  function clampScale(v) { return Math.min(2, Math.max(0.5, v)); }
  function clampOpacity(v) { return Math.min(1, Math.max(0, v)); }
  function clampShadow(v) { return Math.min(2, Math.max(0, v)); }

  // Font-family stacks. Each prefers a Latin face then a matching Japanese face
  // so both scripts render in the chosen style across platforms.
  const FONT_STACKS = {
    sans:    "'Inter', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, system-ui, sans-serif",
    serif:   "'Hiragino Mincho ProN', 'Yu Mincho', YuMincho, 'MS Mincho', Georgia, serif",
    rounded: "'Hiragino Maru Gothic ProN', 'Varela Round', Quicksand, system-ui, sans-serif",
    mono:    "ui-monospace, 'MS Gothic', Osaka-Mono, 'Yu Gothic', monospace",
  };
  const FONT_LABELS = [
    ['sans', 'Sans (Gothic)'],
    ['serif', 'Serif (Mincho)'],
    ['rounded', 'Rounded'],
    ['mono', 'Monospace'],
  ];
  const WEIGHT_LABELS = [
    ['300', 'Light'],
    ['400', 'Normal'],
    ['600', 'Semibold'],
    ['800', 'Bold'],
  ];

  // Build the text-shadow string from a strength multiplier (0 = none, 1 =
  // default drop shadow, >=1 adds a thickening 4-way outline for legibility on
  // bright video).
  function subShadowCss(s) {
    if (s <= 0) return 'none';
    const a = Math.min(0.95, 0.55 * s + 0.05).toFixed(2);
    const blur = (3 * s).toFixed(1);
    const layers = [`0 1px ${blur}px rgba(0,0,0,${a})`];
    if (s >= 1) {
      const w = (s - 0.5).toFixed(2);
      const c = `rgba(0,0,0,${a})`;
      layers.push(`${w}px 0 0 ${c}`, `-${w}px 0 0 ${c}`,
                  `0 ${w}px 0 ${c}`, `0 -${w}px 0 ${c}`);
    }
    return layers.join(', ');
  }

  function applySubAppearance() {
    if (!barEl) return;
    barEl.style.setProperty('--imm-sub-scale', String(subFontScale));
    barEl.style.setProperty('--imm-sub-bg', String(subBgOpacity));
    barEl.style.setProperty('--imm-sub-font', FONT_STACKS[subFontFamily] || FONT_STACKS.sans);
    barEl.style.setProperty('--imm-sub-weight', String(subFontWeight));
    barEl.style.setProperty('--imm-sub-color', subTextColor);
    barEl.style.setProperty('--imm-sub-shadow', subShadowCss(subShadow));
    // Marker colours; an unchecked category resolves to transparent (no underline).
    barEl.style.setProperty('--imm-unknown-color',  markUnknown  ? colUnknown  : 'transparent');
    barEl.style.setProperty('--imm-learning-color', markLearning ? colLearning : 'transparent');
    barEl.style.setProperty('--imm-known-color',    markKnown    ? colKnown    : 'transparent');
    barEl.style.setProperty('--imm-ignored-color',  markIgnored  ? colIgnored  : 'transparent');
  }

  function settingsPanelOpen() {
    return !!(settingsPanelEl && settingsPanelEl.classList.contains('is-open'));
  }

  function buildSettingsPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'imm-yt-card-panel imm-yt-settings-panel';
    populateSettingsPanel(wrap);
    return wrap;
  }

  // (Re)builds the ⚙ panel from current state. Called on first build, on open
  // (so the widgets reflect the live values), and after Reset. The header (title
  // + ×) stays fixed while the row body scrolls, so the close control is always
  // reachable even when a large subtitle pushes the toolbar's ⚙ off-screen.
  function populateSettingsPanel(wrap) {
    wrap.textContent = '';

    const header = document.createElement('div');
    header.className = 'imm-yt-settings-header';
    const title = document.createElement('span');
    title.className = 'imm-yt-settings-title';
    title.textContent = 'Subtitle appearance';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'imm-yt-settings-close';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', closeSettingsPanel);
    header.appendChild(title);
    header.appendChild(close);
    wrap.appendChild(header);

    const body = document.createElement('div');
    body.className = 'imm-yt-settings-body';
    wrap.appendChild(body);

    body.appendChild(buildRangeRow('Text size', 50, 200, Math.round(subFontScale * 100), '%',
      (pct) => { subFontScale = clampScale(pct / 100); applySubAppearance(); }));
    body.appendChild(buildRangeRow('Background', 0, 100, Math.round(subBgOpacity * 100), '%',
      (pct) => { subBgOpacity = clampOpacity(pct / 100); applySubAppearance(); }));
    body.appendChild(buildRangeRow('Outline', 0, 200, Math.round(subShadow * 100), '%',
      (pct) => { subShadow = clampShadow(pct / 100); applySubAppearance(); }));

    body.appendChild(buildSelectRow('Font', FONT_LABELS, subFontFamily,
      (v) => { subFontFamily = v; applySubAppearance(); saveSettings(); }));
    body.appendChild(buildSelectRow('Weight', WEIGHT_LABELS, String(subFontWeight),
      (v) => { subFontWeight = Number(v); applySubAppearance(); saveSettings(); }));
    body.appendChild(buildColorRow('Text colour', subTextColor,
      (v) => { subTextColor = v; applySubAppearance(); }));

    const head = document.createElement('div');
    head.className = 'imm-yt-settings-head';
    head.textContent = 'Word colours';
    head.title = 'Underline colours for the 語 known-word view';
    body.appendChild(head);

    body.appendChild(buildMarkerRow('Unknown', markUnknown, colUnknown,
      (on) => { markUnknown = on; applySubAppearance(); saveSettings(); },
      (c) => { colUnknown = c; applySubAppearance(); }));
    body.appendChild(buildMarkerRow('Learning', markLearning, colLearning,
      (on) => { markLearning = on; applySubAppearance(); saveSettings(); },
      (c) => { colLearning = c; applySubAppearance(); }));
    body.appendChild(buildMarkerRow('Known', markKnown, colKnown,
      (on) => { markKnown = on; applySubAppearance(); saveSettings(); },
      (c) => { colKnown = c; applySubAppearance(); }));
    body.appendChild(buildMarkerRow('Ignored', markIgnored, colIgnored,
      (on) => { markIgnored = on; applySubAppearance(); saveSettings(); },
      (c) => { colIgnored = c; applySubAppearance(); }));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'imm-yt-settings-reset';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      subFontScale = 1; subBgOpacity = 0.78; subShadow = 1;
      subFontFamily = 'sans'; subFontWeight = 600; subTextColor = '#ffffff';
      markUnknown  = true;  colUnknown  = '#aa00ff';
      markLearning = true;  colLearning = '#f59e0b';
      markKnown    = false; colKnown    = '#34d399';
      markIgnored  = false; colIgnored  = '#94a3b8';
      applySubAppearance(); saveSettings(); populateSettingsPanel(wrap);
    });
    body.appendChild(reset);
  }

  // One labelled slider row; onInput receives the live integer value.
  function buildRangeRow(label, min, max, value, unit, onInput) {
    const field = document.createElement('div');
    field.className = 'imm-yt-field';
    const lab = document.createElement('span');
    lab.className = 'imm-yt-field-label';
    lab.textContent = label;
    field.appendChild(lab);

    const row = document.createElement('div');
    row.className = 'imm-yt-range-row';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min); range.max = String(max); range.value = String(value);
    range.dataset.unit = unit;
    const val = document.createElement('span');
    val.className = 'imm-yt-range-val';
    val.textContent = value + unit;
    range.addEventListener('input', () => {
      val.textContent = range.value + unit;
      onInput(Number(range.value));      // live preview while dragging
    });
    range.addEventListener('change', saveSettings);  // persist on release
    row.appendChild(range);
    row.appendChild(val);
    field.appendChild(row);
    return field;
  }

  // A labelled dropdown. `options` is [value, label] pairs; onChange owns its own
  // persistence (selects change discretely, so there's no live-drag to debounce).
  function buildSelectRow(label, options, current, onChange) {
    const field = document.createElement('div');
    field.className = 'imm-yt-field';
    const lab = document.createElement('span');
    lab.className = 'imm-yt-field-label';
    lab.textContent = label;
    field.appendChild(lab);

    const sel = document.createElement('select');
    sel.className = 'imm-yt-select imm-yt-select-sm';
    for (const [value, text] of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if (value === current) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    field.appendChild(sel);
    return field;
  }

  // A labelled colour swatch. onInput fires live while picking; the value is
  // persisted on the picker's `change` (close).
  function buildColorRow(label, value, onInput) {
    const field = document.createElement('div');
    field.className = 'imm-yt-field imm-yt-color-field';
    const lab = document.createElement('span');
    lab.className = 'imm-yt-field-label';
    lab.textContent = label;
    const input = makeColorInput(value, onInput);
    field.appendChild(lab);
    field.appendChild(input);
    return field;
  }

  // A word-colour category row: a checkbox toggle on the left and a colour swatch
  // on the right (disabled while the toggle is off).
  function buildMarkerRow(label, enabled, color, onToggle, onColor) {
    const row = document.createElement('div');
    row.className = 'imm-yt-marker-row';

    const toggle = document.createElement('label');
    toggle.className = 'imm-yt-marker-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = enabled;
    const txt = document.createElement('span');
    txt.textContent = label;
    toggle.appendChild(cb);
    toggle.appendChild(txt);

    const swatch = makeColorInput(color, onColor);
    swatch.disabled = !enabled;
    cb.addEventListener('change', () => {
      swatch.disabled = !cb.checked;
      onToggle(cb.checked);
    });

    row.appendChild(toggle);
    row.appendChild(swatch);
    return row;
  }

  // Shared <input type="color"> wiring: live preview on input, persist on change.
  function makeColorInput(value, onInput) {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'imm-yt-color';
    input.value = value;
    input.addEventListener('input', () => onInput(input.value));
    input.addEventListener('change', saveSettings);
    return input;
  }

  // Rebuild the panel body so every widget reflects the live values (after Reset
  // or before opening).
  function refreshSettingsPanel() {
    if (settingsPanelEl) populateSettingsPanel(settingsPanelEl);
  }

  function toggleSettingsPanel() {
    if (settingsPanelOpen()) { closeSettingsPanel(); return; }
    if (cardPanelOpen()) closeCardPanel();
    if (!settingsPanelEl) return;
    refreshSettingsPanel();
    settingsPanelEl.classList.add('is-open');
    if (barEl) barEl.style.display = 'flex';
  }

  function closeSettingsPanel() {
    if (!settingsPanelEl) return;
    settingsPanelEl.classList.remove('is-open');
    if (barEl) barEl.style.display = textEl && textEl.textContent ? 'flex' : 'none';
  }

  async function loadDecks() {
    if (decksCache) { populateDeckSelect(decksCache); return; }
    const resp = await sendBackground({ action: 'get_decks' });
    if (resp.error) throw new Error(resp.error);
    decksCache = resp.decks || [];
    populateDeckSelect(decksCache);
  }

  async function loadCardTypes() {
    if (cardTypesCache) { populateTypeSelect(cardTypesCache); return; }
    const resp = await sendBackground({ action: 'get_card_types' });
    if (resp.error) throw new Error(resp.error);
    cardTypesCache = resp.card_types || [];
    populateTypeSelect(cardTypesCache);
  }

  function populateDeckSelect(decks) {
    const sel = cardPanelEl.querySelector('#imm-yt-deck-select');
    sel.innerHTML = '';
    for (const d of decks) {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d.name;
      if (String(d.id) === String(ytMine.deckId)) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function populateTypeSelect(types) {
    const sel = cardPanelEl.querySelector('#imm-yt-type-select');
    sel.innerHTML = '';
    for (const t of types) {
      const opt = document.createElement('option');
      opt.value = String(t.id);
      opt.textContent = t.name;
      if (String(t.id) === String(ytMine.typeId)) opt.selected = true;
      sel.appendChild(opt);
    }
    renderFieldMap();
  }

  function renderFieldMap() {
    const sel = cardPanelEl.querySelector('#imm-yt-type-select');
    const wrap = cardPanelEl.querySelector('#imm-yt-fieldmap');
    wrap.innerHTML = '';
    if (!cardTypesCache || !sel.value) return;
    const t = cardTypesCache.find(t => String(t.id) === sel.value);
    if (!t) return;

    const fields = t.fields || [];
    const stored = cardFieldMap.get(t.id) || ytMine.fieldMaps[t.id]
      || ytMine.fieldMaps[String(t.id)] || autoMap(fields);

    const slots = [
      { key: 'sentence', label: 'Sentence' },
      { key: 'image',    label: 'Image' },
      { key: 'audio',    label: 'Audio' },
    ];

    for (const slot of slots) {
      const sub = document.createElement('select');
      sub.className = 'imm-yt-select imm-yt-select-sm';
      sub.dataset.slot = slot.key;
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '- skip -';
      sub.appendChild(none);
      for (const f of fields) {
        const o = document.createElement('option');
        o.value = f;
        o.textContent = f;
        if (stored[slot.key] === f) o.selected = true;
        sub.appendChild(o);
      }
      sub.addEventListener('change', () => persistFieldMap(t.id));
      wrap.appendChild(labeled(slot.label, sub));
    }
  }

  function autoMap(fields) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
    const find = (...keys) => fields.find(f => keys.includes(norm(f)));
    return {
      sentence: (find('sentence', 'expression', 'text', 'front', 'japanese') || fields[0] || ''),
      image:    (find('image', 'picture', 'screenshot') || ''),
      audio:    (find('audio', 'sound', 'sentenceaudio') || ''),
    };
  }

  function persistFieldMap(typeId) {
    const wrap = cardPanelEl.querySelector('#imm-yt-fieldmap');
    const map = {};
    for (const sel of wrap.querySelectorAll('select[data-slot]')) {
      map[sel.dataset.slot] = sel.value;
    }
    cardFieldMap.set(typeId, map);
  }

  function setCardStatus(msg, level) {
    const el = cardPanelEl && cardPanelEl.querySelector('#imm-yt-card-status');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.level = level || '';
  }

  async function submitCard() {
    if (!videoEl) { setCardStatus('No video.', 'error'); return; }

    const deckSel = cardPanelEl.querySelector('#imm-yt-deck-select');
    const typeSel = cardPanelEl.querySelector('#imm-yt-type-select');
    const deckId = parseInt(deckSel.value, 10);
    const typeId = parseInt(typeSel.value, 10);
    if (!deckId || !typeId) { setCardStatus('Pick a deck and card type.', 'error'); return; }

    const cue = cardOverrideCue || getActiveCue();
    if (!cue || !cue.text) { setCardStatus('No active subtitle.', 'error'); return; }

    const fieldMap = {};
    for (const sel of cardPanelEl.querySelectorAll('#imm-yt-fieldmap select[data-slot]')) {
      if (sel.value) fieldMap[sel.dataset.slot] = sel.value;
    }

    let imageB64 = null;
    try {
      imageB64 = captureScreenshot();
    } catch (e) {
      console.warn('[immersion-yt] screenshot failed', e);
    }

    setCardStatus('Creating card…');

    const startMs = Math.max(0, Math.round(cue.start * 1000) + audioStartPadMs);
    const endMs   = Math.max(startMs + 100, Math.round(cue.end * 1000) + audioEndPadMs);

    const req = {
      action: 'create_card_with_media',
      video_url: location.href.split('&')[0],
      start_ms: startMs,
      end_ms:   endMs,
      sentence: cue.text,
      image_b64: imageB64,
      deck_id: deckId,
      card_type_id: typeId,
      field_map: fieldMap,
    };

    const resp = await sendBackground(req);
    if (resp.error) {
      setCardStatus('Error: ' + resp.error, 'error');
      return;
    }
    // A successful panel mine becomes the saved default, so the next ＋ click
    // is one-click (mirrors the hover dictionary's behaviour).
    ytMine.deckId = String(deckId);
    ytMine.typeId = String(typeId);
    ytMine.fieldMaps = { ...ytMine.fieldMaps, [String(typeId)]: fieldMap };
    saveYtMine();
    if (resp.audio_skipped) {
      console.warn('[immersion-yt] audio_skipped:', resp.audio_skipped);
      setCardStatus(`Card #${resp.card_id} created - audio skipped: ${resp.audio_skipped}`, 'warn');
      // Leave the panel open so the user can read why audio wasn't attached.
    } else {
      setCardStatus(`Card #${resp.card_id} created`, 'ok');
      setTimeout(() => { if (cardPanelOpen()) closeCardPanel(); }, 1500);
    }
  }

  function captureScreenshot() {
    if (!videoEl || !videoEl.videoWidth) return null;
    const maxW = 960;
    const scale = Math.min(1, maxW / videoEl.videoWidth);
    const w = Math.round(videoEl.videoWidth * scale);
    const h = Math.round(videoEl.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return dataUrl.split(',')[1] || null;
  }

  function sendBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { error: 'empty response' });
        });
      } catch (e) {
        resolve({ error: e.message });
      }
    });
  }

  // ── Sidebar queue ───────────────────────────────────────────────────────
  // Lives in YouTube's right-column container (#secondary-inner). While the
  // queue is open we hide the recommendations next to it with a body class.
  // Survives SPA navigation by re-attaching from ensureBar() / loadVideo().

  function syncQueueButton() {
    const btn = toolbarEl && toolbarEl.querySelector('#imm-yt-btn-queue');
    if (!btn) return;
    btn.classList.toggle('is-on', queueOpen);
    btn.title = queueOpen ? 'Hide subtitle queue' : 'Show subtitle queue';
  }

  function ensureQueue() {
    const host = document.querySelector('#secondary-inner') ||
                 document.querySelector('#secondary');
    if (!host) {
      // YouTube hasn't hydrated the right column yet. Watch for it and
      // re-run; until then queueEl stays null and toggleQueue is a no-op
      // on the visual side.
      watchForQueueHost();
      return null;
    }

    if (queueEl && host.contains(queueEl)) return queueEl;

    queueEl = document.createElement('div');
    queueEl.id = '__imm_yt_queue';
    queueEl.className = 'imm-yt-queue';

    const header = document.createElement('div');
    header.className = 'imm-yt-queue-header';

    const title = document.createElement('span');
    title.className = 'imm-yt-queue-title';
    title.textContent = 'Subtitles';
    header.appendChild(title);

    const count = document.createElement('span');
    count.className = 'imm-yt-queue-count';
    count.id = '__imm_yt_queue_count';
    count.textContent = '0';
    header.appendChild(count);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    header.appendChild(spacer);

    const offsetGroup = document.createElement('div');
    offsetGroup.className = 'imm-yt-queue-offset';
    offsetGroup.title = 'Subtitle timing offset - while this queue is open, , / . nudge ±100ms ( < / > = ±500ms, 0 resets)';

    const offsetMinus = document.createElement('button');
    offsetMinus.type = 'button';
    offsetMinus.className = 'imm-yt-queue-offset-btn';
    offsetMinus.textContent = '−';
    offsetMinus.title = 'Subs earlier (−100ms)';
    offsetMinus.addEventListener('click', (e) => { e.stopPropagation(); nudgeOffset(-100); });
    offsetGroup.appendChild(offsetMinus);

    const offsetLabel = document.createElement('button');
    offsetLabel.type = 'button';
    offsetLabel.className = 'imm-yt-queue-offset-label';
    offsetLabel.id = '__imm_yt_offset_label';
    offsetLabel.textContent = '0.0s';
    offsetLabel.title = 'Click to reset';
    offsetLabel.addEventListener('click', (e) => { e.stopPropagation(); resetOffset(); });
    offsetGroup.appendChild(offsetLabel);

    const offsetPlus = document.createElement('button');
    offsetPlus.type = 'button';
    offsetPlus.className = 'imm-yt-queue-offset-btn';
    offsetPlus.textContent = '+';
    offsetPlus.title = 'Subs later (+100ms)';
    offsetPlus.addEventListener('click', (e) => { e.stopPropagation(); nudgeOffset(100); });
    offsetGroup.appendChild(offsetPlus);

    header.appendChild(offsetGroup);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'imm-yt-queue-close';
    closeBtn.title = 'Hide queue';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', toggleQueue);
    header.appendChild(closeBtn);

    queueEl.appendChild(header);

    // Whole-video comprehension gets its own full-width row so the header isn't
    // cramped and the label has room to be self-explanatory.
    videoCompEl = document.createElement('div');
    videoCompEl.className = 'imm-yt-queue-comp';
    videoCompEl.id = '__imm_yt_video_comp';
    videoCompEl.style.display = 'none';
    videoCompEl.title = 'Estimated comprehension across all subtitles in this video';
    queueEl.appendChild(videoCompEl);

    queueListEl = document.createElement('div');
    queueListEl.className = 'imm-yt-queue-list';
    queueListEl.addEventListener('wheel', noteUserScroll, { passive: true });
    queueListEl.addEventListener('touchmove', noteUserScroll, { passive: true });
    queueEl.appendChild(queueListEl);

    host.insertBefore(queueEl, host.firstChild);
    syncQueueVisibility();
    syncOffsetDisplay();
    syncQueue();
    return queueEl;
  }

  function nudgeOffset(deltaMs) {
    subOffsetMs = Math.max(-10000, Math.min(10000,
      Math.round((subOffsetMs + deltaMs) / 50) * 50));
    syncOffsetDisplay();
    saveSettings();
    // Recompute active cue immediately so the bar reflects the change without
    // waiting for the next natural transition.
    if (cues.length) {
      const idx = findCueIndex(effectiveTime());
      if (idx !== activeCueIndex) setActiveCue(idx);
    }
  }

  function resetOffset() {
    if (subOffsetMs === 0) return;
    subOffsetMs = 0;
    syncOffsetDisplay();
    saveSettings();
    if (cues.length) {
      const idx = findCueIndex(effectiveTime());
      if (idx !== activeCueIndex) setActiveCue(idx);
    }
  }

  function syncOffsetDisplay() {
    const label = queueEl && queueEl.querySelector('#__imm_yt_offset_label');
    if (!label) return;
    const s = subOffsetMs / 1000;
    if (subOffsetMs === 0) {
      label.textContent = '0.0s';
      label.classList.remove('is-nonzero');
    } else {
      label.textContent = (s >= 0 ? '+' : '') + s.toFixed(1) + 's';
      label.classList.add('is-nonzero');
    }
  }

  function watchForQueueHost() {
    if (queueHostObserver) return;
    queueHostObserver = new MutationObserver(() => {
      const host = document.querySelector('#secondary-inner') ||
                   document.querySelector('#secondary');
      if (!host) return;
      queueHostObserver.disconnect();
      queueHostObserver = null;
      // ensureQueue() will build queueEl, call syncQueueVisibility(), and
      // syncQueue() - so whatever the user's queueOpen state and cues are
      // right now, the panel appears with correct contents.
      ensureQueue();
    });
    queueHostObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function noteUserScroll() {
    queueScrollGuardUntil = performance.now() + 3000;
  }

  function syncQueueVisibility() {
    if (queueEl) queueEl.classList.toggle('is-open', queueOpen);
    document.body.classList.toggle('imm-yt-queue-open', queueOpen);
  }

  function toggleQueue() {
    queueOpen = !queueOpen;
    if (queueOpen) ensureQueue();
    syncQueueButton();
    syncQueueVisibility();
    saveSettings();
    if (queueOpen) {
      syncQueue();
      computeVideoComprehension();
      // Snap to the current cue on first open so the user lands on context.
      queueScrollGuardUntil = 0;
      updateActiveRow(true);
    }
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function clearQueueRows() {
    if (queueListEl) queueListEl.innerHTML = '';
    queueRows = [];
  }

  function buildQueueRow(idx) {
    const row = document.createElement('div');
    row.className = 'imm-yt-queue-row';
    row.dataset.idx = String(idx);

    const time = document.createElement('div');
    time.className = 'imm-yt-queue-time';
    row.appendChild(time);

    const text = document.createElement('div');
    text.className = 'imm-yt-queue-text';
    row.appendChild(text);

    const mine = document.createElement('button');
    mine.type = 'button';
    mine.className = 'imm-yt-queue-mine';
    mine.title = 'Make card from this line (Shift+click to choose deck & fields)';
    mine.textContent = '＋';
    mine.addEventListener('click', (e) => {
      e.stopPropagation();
      mineQueueRow(parseInt(row.dataset.idx, 10), e);
    });
    row.appendChild(mine);

    row.addEventListener('click', () => {
      seekToQueueRow(parseInt(row.dataset.idx, 10));
    });

    return row;
  }

  function setRowData(row, idx, start, text, isPending) {
    row.dataset.idx = String(idx);
    const timeEl = row.querySelector('.imm-yt-queue-time');
    const textInner = row.querySelector('.imm-yt-queue-text');
    const newTime = formatTime(start);
    if (timeEl.textContent !== newTime) timeEl.textContent = newTime;
    if (textInner.textContent !== text) textInner.textContent = text;
    row.classList.toggle('is-pending', !!isPending);
  }

  function activeQueueRowIndex() {
    if (domMirrorActive && pendingMirrorCue) return cues.length;
    return activeCueIndex;
  }

  function syncQueue() {
    if (!queueListEl) return;
    // Drop the empty-state placeholder if it's there.
    const placeholder = queueListEl.querySelector('.imm-yt-queue-empty');
    if (placeholder) placeholder.remove();

    const needPending = !!pendingMirrorCue;
    const totalNeeded = cues.length + (needPending ? 1 : 0);

    while (queueRows.length < totalNeeded) {
      const idx = queueRows.length;
      const row = buildQueueRow(idx);
      queueListEl.appendChild(row);
      queueRows.push(row);
    }
    while (queueRows.length > totalNeeded) {
      const row = queueRows.pop();
      if (row && row.parentNode) row.parentNode.removeChild(row);
    }

    for (let i = 0; i < cues.length; i++) {
      setRowData(queueRows[i], i, cues[i].start, cues[i].text, false);
    }
    if (needPending) {
      const i = cues.length;
      setRowData(queueRows[i], i, pendingMirrorCue.start, pendingMirrorCue.text, true);
    }

    if (totalNeeded === 0) {
      const empty = document.createElement('div');
      empty.className = 'imm-yt-queue-empty';
      empty.textContent = queueLoading
        ? 'Loading subtitles…'
        : 'No subtitles loaded.';
      queueListEl.appendChild(empty);
    }

    syncQueueCount();
    updateActiveRow();
  }

  function syncQueueCount() {
    if (!queueEl) return;
    const el = queueEl.querySelector('#__imm_yt_queue_count');
    if (!el) return;
    const total = cues.length + (pendingMirrorCue ? 1 : 0);
    const activeIdx = activeQueueRowIndex();
    const current = activeIdx >= 0 ? activeIdx + 1 : 0;
    el.textContent = total > 0 ? `${current} / ${total}` : '0';
  }

  function updateActiveRow(forceScroll) {
    if (!queueListEl) return;
    const activeIdx = activeQueueRowIndex();
    for (let i = 0; i < queueRows.length; i++) {
      queueRows[i].classList.toggle('is-active', i === activeIdx);
    }
    syncQueueCount();
    if (activeIdx < 0 || !queueRows[activeIdx]) return;
    if (!forceScroll && performance.now() < queueScrollGuardUntil) return;
    if (!queueOpen) return;
    try {
      queueRows[activeIdx].scrollIntoView({
        behavior: forceScroll ? 'auto' : 'smooth',
        block: 'center',
      });
    } catch (_) {}
  }

  function seekToQueueRow(idx) {
    queueScrollGuardUntil = 0; // resume auto-follow
    if (idx < cues.length) {
      seekToCueStart(cues[idx]);
      setActiveCue(idx);
      return;
    }
    if (idx === cues.length && pendingMirrorCue) {
      seekTo(pendingMirrorCue.start);
    }
  }

  // Resolves once the player lands after a seek (or after a short timeout),
  // so a quick-mined screenshot shows the mined line's frame, not the one the
  // user was watching when they clicked.
  function waitForSeek(timeoutMs = 700) {
    return new Promise((resolve) => {
      if (!videoEl) return resolve();
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        videoEl.removeEventListener('seeked', done);
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      videoEl.addEventListener('seeked', done);
    });
  }

  async function mineQueueRow(idx, e) {
    queueScrollGuardUntil = 0;
    if (idx < cues.length) {
      const cue = cues[idx];
      seekToCueStart(cue);
      setActiveCue(idx);
      // One-click path: defaults are set, so mine this row straight away.
      // (The pending DOM-mirror row below always uses the panel - its cue
      // hasn't closed yet, so it has no reliable end time.)
      if (!(e && e.shiftKey) && ytMineConfigured()) {
        const row = queueRows[idx];
        const btn = row && row.querySelector('.imm-yt-queue-mine');
        await waitForSeek();
        await quickMineCue({ start: cue.start, end: cue.end, text: cue.text }, btn);
        return;
      }
      // Pin this cue as the mining target so a stray pendingMirrorCue
      // (still set from before the seek) doesn't hijack submitCard.
      cardOverrideCue = { start: cue.start, end: cue.end, text: cue.text };
    } else if (idx === cues.length && pendingMirrorCue) {
      seekTo(pendingMirrorCue.start);
      cardOverrideCue = null; // let getActiveCue() use pendingMirrorCue
    } else {
      return;
    }
    await openCardPanel();
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  // A / S / D - prev / replay / next. Skipped while typing in an input or
  // while the card panel is taking input.
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  window.addEventListener('keydown', (e) => {
    if (!cues.length && !pendingMirrorCue) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;
    if (cardPanelOpen() && cardPanelEl.contains(e.target)) return;
    if (settingsPanelOpen() && settingsPanelEl.contains(e.target)) return;

    const k = e.key.toLowerCase();
    if (k === 'a') { prevCue(); e.preventDefault(); }
    else if (k === 's') { replayCue(); e.preventDefault(); }
    else if (k === 'd') { nextCue(); e.preventDefault(); }
    // Sub-timing offset keys are only consumed while the queue panel is open,
    // so during normal viewing they don't shadow YouTube's native shortcuts:
    // , / . = frame-step (paused), < / > = playback speed, 0-9 = seek. The
    // on-screen −/+ buttons adjust the offset regardless of panel state.
    else if (queueOpen) {
      if (e.key === ',') { nudgeOffset(-100); e.preventDefault(); }
      else if (e.key === '<') { nudgeOffset(-500); e.preventDefault(); }
      else if (e.key === '.') { nudgeOffset(+100); e.preventDefault(); }
      else if (e.key === '>') { nudgeOffset(+500); e.preventDefault(); }
      else if (k === '0') { resetOffset(); e.preventDefault(); }
    }
  }, true);

  function urlVideoId() {
    try {
      const v = new URLSearchParams(location.search).get('v');
      if (v) return v;
      const m = location.pathname.match(/^\/shorts\/([\w-]+)/);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  // ── Message bridge from page-script ─────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'imm-yt' || data.type !== 'track') return;
    // A stale announce (player response lagging an SPA navigation) names a
    // video other than the one in the URL - acting on it would load the
    // previous video's subs over the new one. Drop it; a fresh announce
    // follows once the player catches up.
    const urlVid = urlVideoId();
    if (urlVid && data.videoId && data.videoId !== urlVid) return;
    if (data.videoId && data.videoId === currentVideoId && cues.length) return;
    loadVideo(data.videoId, data.url);
  });

  // Belt and braces for the stale-queue bug: clear the previous video's bar +
  // queue the moment navigation lands, even if the track announce is late or
  // never comes (e.g. the new video has no captions at all).
  document.addEventListener('yt-navigate-finish', () => {
    const urlVid = urlVideoId();
    if (urlVid !== currentVideoId) loadVideo(urlVid, null);
  });

  // ── Boot ────────────────────────────────────────────────────────────────
  loadSettings();
  injectPageScript();
})();
