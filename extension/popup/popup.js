'use strict';

// Storage keys shared with the content scripts.
const DICT_KEY = 'imm_dict_settings';   // { enabled, modifier }  - content.js
const YT_KEY   = 'imm_yt_settings';     // YouTube layer (youtube.js owns most of it)

// Defaults must mirror the content scripts so the form shows the real behaviour
// before the user has ever changed anything.
const DICT_DEFAULTS = { enabled: true, modifier: 'shift' };
const YT_DEFAULTS = { furigana: false, autoPause: false, audioStartPadMs: 0, audioEndPadMs: 400 };

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  $('version').textContent = 'v' + (chrome.runtime.getManifest().version || '');
  loadSettings();
  checkConnection();
  $('refreshBtn').addEventListener('click', checkConnection);
  wireInputs();
});

// ── Connection status ──────────────────────────────────────────────────────
function setStatus(state, text, hint) {
  const badge = $('statusBadge');
  badge.className = 'status-badge ' + state;
  $('statusText').textContent = text;
  $('statusHint').textContent = hint;
}

function checkConnection() {
  setStatus('is-checking', 'Checking…', 'Looking for the desktop app…');
  let settled = false;
  const done = (ok) => {
    if (settled) return;
    settled = true;
    if (ok) {
      setStatus('is-ok', 'Connected', 'The desktop app is running and reachable.');
    } else {
      setStatus('is-down', 'Not running',
        'Start the Immersion Suite desktop app, then re-check.');
    }
  };

  // Fallback in case the service worker never answers.
  const t = setTimeout(() => done(false), 6000);

  try {
    chrome.runtime.sendMessage({ action: 'ping' }, (resp) => {
      clearTimeout(t);
      if (chrome.runtime.lastError) return done(false);
      done(!!resp && !resp.error);
    });
  } catch {
    clearTimeout(t);
    done(false);
  }
}

// ── Settings load / save ────────────────────────────────────────────────────
function loadSettings() {
  chrome.storage.local.get([DICT_KEY, YT_KEY], (data) => {
    const dict = { ...DICT_DEFAULTS, ...(data[DICT_KEY] || {}) };
    const yt   = { ...YT_DEFAULTS, ...(data[YT_KEY] || {}) };

    $('dictEnabled').checked = dict.enabled !== false;
    $('lookupModifier').value = dict.modifier || 'shift';

    $('ytFurigana').checked = !!yt.furigana;
    $('ytAutoPause').checked = !!yt.autoPause;
    $('ytAudioStart').value = clampPad(yt.audioStartPadMs, YT_DEFAULTS.audioStartPadMs);
    $('ytAudioEnd').value   = clampPad(yt.audioEndPadMs, YT_DEFAULTS.audioEndPadMs);
  });
}

function clampPad(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5000, Math.max(0, Math.round(n)));
}

function saveDict() {
  chrome.storage.local.set({
    [DICT_KEY]: {
      enabled: $('dictEnabled').checked,
      modifier: $('lookupModifier').value,
    },
  }, flashSaved);
}

// youtube.js owns extra fields (queueOpen, subOffsetMs); read-merge-write so we
// only touch the ones this form exposes.
function saveYt() {
  chrome.storage.local.get(YT_KEY, (data) => {
    const merged = {
      ...(data[YT_KEY] || {}),
      furigana: $('ytFurigana').checked,
      autoPause: $('ytAutoPause').checked,
      audioStartPadMs: clampPad($('ytAudioStart').value, YT_DEFAULTS.audioStartPadMs),
      audioEndPadMs: clampPad($('ytAudioEnd').value, YT_DEFAULTS.audioEndPadMs),
    };
    chrome.storage.local.set({ [YT_KEY]: merged }, flashSaved);
  });
}

function wireInputs() {
  $('dictEnabled').addEventListener('change', saveDict);
  $('lookupModifier').addEventListener('change', saveDict);
  $('ytFurigana').addEventListener('change', saveYt);
  $('ytAutoPause').addEventListener('change', saveYt);
  // Normalise number fields to the clamped value on save so the box reflects it.
  for (const id of ['ytAudioStart', 'ytAudioEnd']) {
    $(id).addEventListener('change', () => {
      $(id).value = clampPad($(id).value,
        id === 'ytAudioStart' ? YT_DEFAULTS.audioStartPadMs : YT_DEFAULTS.audioEndPadMs);
      saveYt();
    });
  }
}

let savedTimer = null;
function flashSaved() {
  const note = $('savedNote');
  note.textContent = 'Saved';
  note.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => note.classList.remove('show'), 1200);
}
