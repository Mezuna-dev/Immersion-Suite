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
  let videoEl = null;
  let captionObserver = null;   // MutationObserver used in DOM-mirror fallback
  let domMirrorActive = false;  // true when cues are being synthesized from the DOM
  let pendingMirrorCue = null;  // {start, text} - open cue waiting for its end timestamp
  let autoPauseEnabled = false; // pause playback at the end of the active sub
  let furiganaEnabled = false;  // show ruby annotations above kanji
  let furiganaAvailable = true; // flips off after a backend tokenize failure

  // Audio-clip padding around the active cue, in ms. Subs are usually
  // timed at or slightly before the audio they describe, so we use zero
  // pre-roll by default and a small post-roll to catch trailing syllables
  // when the sub disappears before the speaker stops. Overridable in
  // chrome.storage.local under imm_yt_settings.{audioStartPadMs,audioEndPadMs}.
  let audioStartPadMs = 0;
  let audioEndPadMs   = 400;

  // Display-timing offset (ms). Positive = delay subs (show later relative
  // to audio); negative = advance them. Lets users dial out drift between
  // yt-dlp's cue timing and YouTube's actual audio rendering. Adjusted with
  // `,` / `.` keys or the queue-header buttons.
  let subOffsetMs = 0;

  const SETTINGS_KEY = 'imm_yt_settings';

  // Tokenized text cache: exact sub text → [{text, reading}, ...]. Keyed by
  // the raw string so the same sub never round-trips the backend twice.
  const tokenCache = new Map();
  const TOKEN_CACHE_MAX = 200;
  // Last text we asked the backend to tokenize, used to drop stale responses
  // when the sub changes while a request is in flight.
  let lastTokenizeRequest = '';

  // Queue (sidebar) state. queueRows[i] is the DOM row for cues[i]; in
  // DOM-mirror mode an extra "pending" row may live at queueRows[cues.length]
  // representing the currently-on-screen cue that hasn't closed yet.
  let queueEl = null;
  let queueListEl = null;
  let queueRows = [];
  let queueOpen = false;
  let queueLoading = false;
  // When the user manually wheels/touches the list, suspend auto-follow until
  // this timestamp (performance.now() ms). Clicking a row resets it.
  let queueScrollGuardUntil = 0;
  // Observer used to wait for #secondary-inner to appear when ensureQueue()
  // is called before YouTube has hydrated it (common on cold page loads).
  let queueHostObserver = null;

  // ── Settings (chrome.storage.local - Phase 4 will expose UI for these) ──
  function loadSettings() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (data) => {
        const s = data && data[SETTINGS_KEY];
        if (!s) return;
        autoPauseEnabled = !!s.autoPause;
        furiganaEnabled = !!s.furigana;
        queueOpen = !!s.queueOpen;
        if (Number.isFinite(s.audioStartPadMs)) audioStartPadMs = s.audioStartPadMs;
        if (Number.isFinite(s.audioEndPadMs))   audioEndPadMs   = s.audioEndPadMs;
        if (Number.isFinite(s.subOffsetMs))     subOffsetMs     = s.subOffsetMs;
        syncAutoPauseButton();
        syncFuriganaButton();
        syncQueueButton();
        syncQueueVisibility();
        syncOffsetDisplay();
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
          queueOpen,
          audioStartPadMs,
          audioEndPadMs,
          subOffsetMs,
        },
      });
    } catch (_) {}
  }

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
    t.appendChild(makeButton('imm-yt-btn-card',   '＋', 'Make card from sub', toggleCardPanel));
    t.appendChild(makeButton('imm-yt-btn-queue',  '☰', 'Show subtitle queue', toggleQueue));

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
      onClick();
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

  // Current sub text in plain form (no markup). The bar's actual DOM may
  // contain <ruby> annotations when furigana is on.
  let currentText = '';

  function setText(text) {
    if (currentText === text && textEl && textEl.dataset.lastFurigana === String(furiganaEnabled)) return;
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

    if (!text) {
      textEl.textContent = '';
      if (barEl) barEl.style.display = cardPanelOpen() ? 'flex' : 'none';
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
    if (!videoEl || !cues.length) {
      scheduleTick();
      return;
    }
    const t = effectiveTime();
    let idx = activeCueIndex;
    if (idx >= 0 && idx < cues.length) {
      const c = cues[idx];
      const end = cueEnd(idx);
      if (t >= c.start && t < end) {
        scheduleTick();
        return;
      }
      if (idx + 1 < cues.length) {
        const n = cues[idx + 1];
        if (t >= n.start && t < cueEnd(idx + 1)) {
          setActiveCue(idx + 1);
          scheduleTick();
          return;
        }
      }
      // Cue just ended - honour auto-pause and leave the text visible so the
      // user can read while paused. We only fire once per cue end by gating
      // on a small window past the cue's end.
      if (autoPauseEnabled && t >= end && t < end + 0.5 && !videoEl.paused) {
        try { videoEl.pause(); } catch (_) {}
        scheduleTick();
        return;
      }
    }
    idx = findCueIndex(t);
    if (idx !== activeCueIndex) setActiveCue(idx);
    scheduleTick();
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

    if (!trackUrl) return;

    videoEl = document.querySelector('#movie_player video') || document.querySelector('video');
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

  async function toggleCardPanel() {
    if (cardPanelOpen()) { closeCardPanel(); return; }
    openCardPanel();
  }

  async function openCardPanel() {
    if (!cardPanelEl) return;
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
    const stored = cardFieldMap.get(t.id) || autoMap(fields);

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
    offsetGroup.title = 'Subtitle timing offset - , and . to nudge ±100ms';

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
    mine.title = 'Make card from this line';
    mine.textContent = '＋';
    mine.addEventListener('click', (e) => {
      e.stopPropagation();
      mineQueueRow(parseInt(row.dataset.idx, 10));
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

  async function mineQueueRow(idx) {
    queueScrollGuardUntil = 0;
    if (idx < cues.length) {
      const cue = cues[idx];
      seekToCueStart(cue);
      setActiveCue(idx);
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

    const k = e.key.toLowerCase();
    if (k === 'a') { prevCue(); e.preventDefault(); }
    else if (k === 's') { replayCue(); e.preventDefault(); }
    else if (k === 'd') { nextCue(); e.preventDefault(); }
    // Sub-timing offset: , and . nudge by ±100ms; < and > by ±500ms; 0 resets.
    else if (e.key === ',') { nudgeOffset(-100); e.preventDefault(); }
    else if (e.key === '<') { nudgeOffset(-500); e.preventDefault(); }
    else if (e.key === '.') { nudgeOffset(+100); e.preventDefault(); }
    else if (e.key === '>') { nudgeOffset(+500); e.preventDefault(); }
    else if (k === '0') { resetOffset(); e.preventDefault(); }
  }, true);

  // ── Message bridge from page-script ─────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'imm-yt' || data.type !== 'track') return;
    if (data.videoId && data.videoId === currentVideoId && cues.length) return;
    loadVideo(data.videoId, data.url);
  });

  // ── Boot ────────────────────────────────────────────────────────────────
  loadSettings();
  injectPageScript();
})();
