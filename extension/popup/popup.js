'use strict';

// Storage keys shared with the content scripts.
const DICT_KEY  = 'imm_dict_settings';  // { enabled, modifier }  - content.js
const YT_KEY    = 'imm_yt_settings';    // YouTube layer (youtube.js owns most of it)
const TOKEN_KEY = 'imm_ws_token';       // pairing secret - background.js
const MINE_KEY  = 'imm_mine_settings';     // { deckId, typeId, fieldMaps } - content.js mining
const YT_MINE_KEY = 'imm_yt_mine_settings'; // { deckId, typeId, fieldMaps } - youtube.js mining

// Defaults must mirror the content scripts so the form shows the real behaviour
// before the user has ever changed anything.
const DICT_DEFAULTS = { enabled: true, modifier: 'shift' };
const YT_DEFAULTS = { furigana: true, autoPause: false, knownColoring: true, audioStartPadMs: 0, audioEndPadMs: 400 };

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  $('version').textContent = 'v' + (chrome.runtime.getManifest().version || '');
  loadSettings();
  loadToken();
  checkConnection();
  $('refreshBtn').addEventListener('click', checkConnection);
  $('saveTokenBtn').addEventListener('click', saveToken);
  wireInputs();
  initPageFurigana();
  initCardDefaults();
});

function loadToken() {
  chrome.storage.local.get(TOKEN_KEY, (data) => {
    $('wsToken').value = (data[TOKEN_KEY] || '');
  });
}

function saveToken() {
  const token = $('wsToken').value.trim();
  chrome.storage.local.set({ [TOKEN_KEY]: token }, () => {
    flashSaved();
    // The background worker holds a live socket from before the token changed;
    // drop it so the next request re-connects and re-authenticates.
    try { chrome.runtime.sendMessage({ action: '__imm_reconnect' }); } catch {}
    setTimeout(checkConnection, 250);
  });
}

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
  const done = (ok, err) => {
    if (settled) return;
    settled = true;
    if (ok) {
      setStatus('is-ok', 'Connected', 'The desktop app is running and reachable.');
    } else if (err && /authoriz|token/i.test(err)) {
      setStatus('is-down', 'Not authorized',
        'Paste the pairing token from the app (Settings → Browser Extension) above.');
    } else {
      setStatus('is-down', 'Not running',
        'Start the Immersion Suite desktop app, then re-check.');
    }
  };

  // Fallback in case the service worker never answers.
  const t = setTimeout(() => done(false), 8000);

  try {
    chrome.runtime.sendMessage({ action: 'ping' }, (resp) => {
      clearTimeout(t);
      if (chrome.runtime.lastError) return done(false);
      done(!!resp && !resp.error, resp && resp.error);
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
    $('ytKnownColoring').checked = !!yt.knownColoring;
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
      knownColoring: $('ytKnownColoring').checked,
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
  $('ytKnownColoring').addEventListener('change', saveYt);
  // Normalise number fields to the clamped value on save so the box reflects it.
  for (const id of ['ytAudioStart', 'ytAudioEnd']) {
    $(id).addEventListener('change', () => {
      $(id).value = clampPad($(id).value,
        id === 'ytAudioStart' ? YT_DEFAULTS.audioStartPadMs : YT_DEFAULTS.audioEndPadMs);
      saveYt();
    });
  }
}

// ── Page furigana (per-tab toggle) ──────────────────────────────────────────
async function initPageFurigana() {
  const btn  = $('pageFuriBtn');
  const hint = $('pageFuriHint');
  const setBtn = (on) => {
    btn.dataset.on = on ? '1' : '';
    btn.textContent = on ? 'Remove furigana from this page' : 'Show furigana on this page';
  };
  const fail = (msg) => {
    btn.disabled = true;
    hint.textContent = msg;
    hint.hidden = false;
  };

  const tab = await new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
    } catch {
      resolve(null);
    }
  });
  if (!tab || tab.id == null) return fail('Not available on this page.');

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, msg, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp);
      });
    } catch {
      resolve(null);
    }
  });

  // No content script in chrome:// pages, the web store, this options tab, …
  const state = await send({ action: 'imm_page_furigana_get' });
  if (!state) return fail('Not available on this page.');
  setBtn(state.enabled);
  if (state.error) { hint.textContent = state.error; hint.hidden = false; }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const r = await send({ action: 'imm_page_furigana_set', enabled: !btn.dataset.on });
    btn.disabled = false;
    if (!r) return fail('Not available on this page.');
    setBtn(r.enabled);
    hint.hidden = true;
  });
}

// ── Card creation defaults (mining templates) ───────────────────────────────
// Two surfaces share the same form logic: the hover dictionary (content.js,
// MINE_KEY) and YouTube sentence mining (youtube.js, YT_MINE_KEY). Slot keys
// and the fuzzy field guessers must stay in sync with their content scripts.
const MINE_SLOTS = [
  { key: 'expression', label: 'Expression' },
  { key: 'reading',    label: 'Reading' },
  { key: 'definition', label: 'Definition' },
  { key: 'sentence',   label: 'Sentence' },
];

const YT_MINE_SLOTS = [
  { key: 'sentence', label: 'Sentence' },
  { key: 'image',    label: 'Image' },
  { key: 'audio',    label: 'Audio' },
];

function autoMapDict(fields) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
  const find = (...keys) => fields.find(f => keys.includes(norm(f)));
  return {
    expression: find('expression', 'word', 'kanji', 'vocab', 'vocabulary', 'term', 'front') || fields[0] || '',
    reading:    find('reading', 'kana', 'furigana', 'pronunciation', 'yomigana', 'yomi') || '',
    definition: find('definition', 'meaning', 'gloss', 'glosses', 'english', 'back', 'translation', 'sense') || '',
    sentence:   find('sentence', 'example', 'context', 'sentences') || '',
  };
}

// Mirrors youtube.js autoMap().
function autoMapYt(fields) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
  const find = (...keys) => fields.find(f => keys.includes(norm(f)));
  return {
    sentence: find('sentence', 'expression', 'text', 'front', 'japanese') || fields[0] || '',
    image:    find('image', 'picture', 'screenshot') || '',
    audio:    find('audio', 'sound', 'sentenceaudio') || '',
  };
}

function bgRequest(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp);
      });
    } catch {
      resolve(null);
    }
  });
}

// Sections sharing one decks/card-types fetch. preferType pre-selects the
// matching seeded card type the first time, so a fresh install is one click
// from working defaults.
const MINE_SECTIONS = [
  { storageKey: MINE_KEY,    slots: MINE_SLOTS,    autoMap: autoMapDict, preferType: 'Pop-Dictionary',
    hintId: 'mineHint',   formId: 'mineForm',   deckId: 'mineDeck',   typeId: 'mineType',   slotsId: 'mineSlots' },
  { storageKey: YT_MINE_KEY, slots: YT_MINE_SLOTS, autoMap: autoMapYt,   preferType: 'Sentence Mining',
    hintId: 'ytMineHint', formId: 'ytMineForm', deckId: 'ytMineDeck', typeId: 'ytMineType', slotsId: 'ytMineSlots' },
];

async function initCardDefaults() {
  const [deckResp, typeResp] = await Promise.all([
    bgRequest({ action: 'get_decks' }),
    bgRequest({ action: 'get_card_types' }),
  ]);
  const decks = deckResp && !deckResp.error && Array.isArray(deckResp.decks) ? deckResp.decks : null;
  const types = typeResp && !typeResp.error && Array.isArray(typeResp.card_types) ? typeResp.card_types : null;
  if (!decks || !types || !decks.length || !types.length) {
    const msg = (decks && types)
      ? 'No decks or card types found. Create them in the desktop app first.'
      : 'Start the desktop app, then reopen this popup to configure the template.';
    for (const sec of MINE_SECTIONS) {
      const hint = $(sec.hintId);
      hint.textContent = msg;
      hint.hidden = false;
    }
    return;
  }
  for (const sec of MINE_SECTIONS) initMineSection(sec, decks, types);
}

async function initMineSection(sec, decks, types) {
  const form = $(sec.formId);

  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(sec.storageKey, (data) => resolve(data[sec.storageKey] || {}));
  });
  const mine = { deckId: null, typeId: null, fieldMaps: {}, ...stored };

  // First open: suggest the seeded card type made for this surface.
  if (mine.typeId == null && sec.preferType) {
    const t = types.find(t => t.name === sec.preferType);
    if (t) mine.typeId = String(t.id);
  }

  const deckSel = $(sec.deckId);
  const typeSel = $(sec.typeId);
  const fillSelect = (sel, items, storedId) => {
    sel.replaceChildren();
    const hasStored = storedId != null && items.some(i => String(i.id) === String(storedId));
    if (!hasStored) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '— choose —';
      sel.appendChild(o);
    }
    for (const item of items) {
      const o = document.createElement('option');
      o.value = String(item.id);
      o.textContent = item.name;
      if (hasStored && String(item.id) === String(storedId)) o.selected = true;
      sel.appendChild(o);
    }
  };
  fillSelect(deckSel, decks, mine.deckId);
  fillSelect(typeSel, types, mine.typeId);

  const slotsWrap = $(sec.slotsId);
  const renderSlots = () => {
    slotsWrap.replaceChildren();
    const t = types.find(t => String(t.id) === typeSel.value);
    if (!t) return;
    const fields = t.fields || [];
    const map = mine.fieldMaps[t.id] || mine.fieldMaps[String(t.id)] || sec.autoMap(fields);
    for (const slot of sec.slots) {
      const label = document.createElement('label');
      label.className = 'row';
      const name = document.createElement('span');
      name.className = 'row-label';
      name.textContent = slot.label;
      const sel = document.createElement('select');
      sel.className = 'select';
      sel.dataset.slot = slot.key;
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— skip —';
      sel.appendChild(none);
      for (const f of fields) {
        const o = document.createElement('option');
        o.value = f;
        o.textContent = f;
        if (map[slot.key] === f) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', save);
      label.appendChild(name);
      label.appendChild(sel);
      slotsWrap.appendChild(label);
    }
  };

  function save() {
    mine.deckId = deckSel.value || null;
    mine.typeId = typeSel.value || null;
    if (typeSel.value) {
      const map = {};
      for (const sel of slotsWrap.querySelectorAll('select[data-slot]')) {
        map[sel.dataset.slot] = sel.value;
      }
      mine.fieldMaps = { ...mine.fieldMaps, [typeSel.value]: map };
    }
    chrome.storage.local.set({ [sec.storageKey]: mine }, flashSaved);
  }

  deckSel.addEventListener('change', save);
  typeSel.addEventListener('change', () => { renderSlots(); save(); });

  renderSlots();
  form.hidden = false;
}

let savedTimer = null;
function flashSaved() {
  const note = $('savedNote');
  note.textContent = 'Saved';
  note.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => note.classList.remove('show'), 1200);
}
