(function () {
  'use strict';

  // Guard against double-injection on SPA navigations.
  if (window.__immDictLoaded) return;
  window.__immDictLoaded = true;

  // ── Constants ──────────────────────────────────────────────────────────────
  const SCAN_LEN    = 25;   // characters to extract from the caret position
  const DEBOUNCE_MS = 16;   // ~one frame - coalesces rapid mousemoves
  const CACHE_MAX   = 512;  // LRU cap for lookup results
  const DICT_SETTINGS_KEY = 'imm_dict_settings';  // shared with the popup/options page

  // ── State ──────────────────────────────────────────────────────────────────
  let shadowHost        = null;
  let shadowRoot        = null;
  let popupEl           = null;
  let contentEl         = null;
  let debounceTimer     = null;
  let hideTimer         = null;
  let modHeld           = false;   // the configured lookup modifier is currently held
  let dictEnabled       = true;    // master on/off (popup setting)
  let lookupModifier    = 'shift'; // 'shift' | 'alt' | 'ctrl' | 'none'

  // Mining (hover popup → flashcard) state
  let currentLookup     = null;    // last lookup data shown, for the mine button
  let currentSentence   = '';      // sentence context captured at show time
  let currentAnchor     = null;    // {x, y, textNode, offset} for repositioning
  let miningOpen        = false;   // mining panel open → suppress auto-hide
  let decksCache        = null;
  let cardTypesCache    = null;
  // Remembered mining config: { deckId, typeId, fieldMaps: { typeId: {slot:field} } }
  let mineSettings      = { deckId: null, typeId: null, fieldMaps: {} };
  const MINE_SETTINGS_KEY = 'imm_mine_settings';

  // Known-words set (manual marks + SRS card words, lives in the desktop DB).
  let knownSet          = new Set();
  let ignoredSet        = new Set();   // words excluded from comprehension
  let knownLoaded       = false;
  let popupHovered      = false;
  let lastChunk         = null;   // chunk currently shown / in flight
  let latestLookupChunk = null;   // staleness guard for async responses
  let lastShownKey      = null;   // identity of rendered content (avoids redundant innerHTML)
  const _cache          = new Map();

  // ── Japanese character detection ───────────────────────────────────────────
  // Tests the first *codepoint* of `str` (codePointAt handles surrogate pairs,
  // so Supplementary-plane kanji like CJK Ext B trigger correctly - charCodeAt
  // would only see the lone high surrogate).
  function isJapanese(str) {
    const c = str.codePointAt(0);
    return (
      (c >= 0x3005 && c <= 0x3007) || // 々 〆 〇 iteration / closing / number marks
      (c >= 0x3040 && c <= 0x30FF) || // Hiragana + Katakana
      (c >= 0x3400 && c <= 0x4DBF) || // CJK Extension A
      (c >= 0x4E00 && c <= 0x9FFF) || // CJK unified ideographs
      (c >= 0xFF65 && c <= 0xFF9F) || // Halfwidth Katakana
      (c >= 0x20000 && c <= 0x3FFFF)  // CJK Ext B-F (Supplementary Ideographic Plane)
    );
  }

  // ── Inline element set - text flows through these without a block break ────
  const _INLINE = new Set([
    'A','ABBR','B','BDI','BDO','CITE','CODE','DATA','DFN','EM','FONT',
    'I','KBD','MARK','Q','RUBY','S','SAMP','SMALL','SPAN','STRONG',
    'SUB','TIME','U','VAR','WBR','INS','DEL',
  ]);

  // ── Walk DOM forward from startNode to gather up to maxLen characters ──────
  function collectForwardText(startNode, maxLen) {
    let root = startNode.parentNode;
    while (root && root !== document.body && _INLINE.has(root.nodeName)) {
      root = root.parentNode;
    }
    if (!root) root = document.body;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let el = node.parentNode;
        while (el && el !== root) {
          if (el.nodeName === 'RT' || el.nodeName === 'RP') return NodeFilter.FILTER_REJECT;
          el = el.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    walker.currentNode = startNode;
    let text = '';
    while (text.length < maxLen && walker.nextNode()) {
      text += walker.currentNode.textContent.slice(0, maxLen - text.length);
    }
    return text;
  }

  // ── Cross-browser caret-at-point ───────────────────────────────────────────
  function caretAt(x, y) {
    if (document.caretRangeFromPoint) {
      return document.caretRangeFromPoint(x, y);
    }
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  // ── Extract the Japanese text chunk starting at the cursor position ─────────
  function getChunkAtPoint(x, y) {
    const range = caretAt(x, y);
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

    let node = range.startContainer.parentNode;
    while (node && node !== document.body) {
      if (node.nodeName === 'RT' || node.nodeName === 'RP') return null;
      node = node.parentNode;
    }

    const textNode = range.startContainer;
    let   offset   = range.startOffset;

    // caretRangeFromPoint places the caret between glyphs - probe the previous
    // character's bounding box and step back if the cursor is visually inside it.
    if (offset > 0) {
      try {
        const probe = document.createRange();
        probe.setStart(textNode, offset - 1);
        probe.setEnd(textNode, offset);
        const pr = probe.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0 &&
            x >= pr.left && x <= pr.right &&
            y >= pr.top  && y <= pr.bottom) {
          offset -= 1;
        }
      } catch (_) {}
    }

    let chunk = textNode.textContent.slice(offset, offset + SCAN_LEN);
    if (chunk.length < SCAN_LEN) {
      chunk += collectForwardText(textNode, SCAN_LEN - chunk.length);
    }

    if (!chunk || !isJapanese(chunk)) return null;
    return { chunk, textNode, offset };
  }

  // ── LRU cache ─────────────────────────────────────────────────────────────
  function cacheGet(key) {
    if (!_cache.has(key)) return undefined;
    const v = _cache.get(key);
    _cache.delete(key);
    _cache.set(key, v);
    return v;
  }

  function cachePut(key, value) {
    _cache.set(key, value);
    if (_cache.size > CACHE_MAX) {
      _cache.delete(_cache.keys().next().value);
    }
  }

  // ── HTML escaping ──────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Gloss cleanup ──────────────────────────────────────────────────────────
  const _POS_TERMS = new Set([
    'noun','verb','adjective','adverb','particle','conjunction','copula',
    'interjection','pronoun','prefix','suffix','counter','expression',
    'transitive','intransitive','auxiliary','prenominal','adnominal',
    '1-dan','5-dan','ichidan','godan','irregular','suru','kana',
    'na-adjective','i-adjective','no-adjective',
    'archaic','colloquial','honorific','humble','formal','informal',
    'slang','literary','dated','rare','vulgar','familiar','male',
    'female','polite','derogatory','abbreviation','onomatopoeia',
  ]);

  const _NOISE = new Set([
    'jmdict','see also','also written as','note','notes',
    'used with','★','priority','form','forms','links',
    'tatoeba','this','|','-','-','/','language of origin','man','boy',
  ]);

  function _hasJP(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x4E00 && c <= 0x9FFF) ||
          (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xFF00 && c <= 0xFFEF)) return true;
    }
    return false;
  }

  function _isNoise(s) {
    if (_NOISE.has(s.toLowerCase())) return true;
    if (_hasJP(s)) return true;
    if (s.length <= 2 && !/^[a-zA-Z]{1,2}$/.test(s)) return true;
    if (/^\[\d+\]$/.test(s)) return true;
    if (/[.!?]$/.test(s) && s.split(/\s+/).length >= 2) return true;
    if (/^[A-Z][a-z]/.test(s) && s.split(/\s+/).length >= 4) return true;
    if (/^[A-Z][a-z]+:\s/.test(s)) return true;
    return false;
  }

  function _cleanSense(sense) {
    const tags = [];
    const defs = [];

    for (const p of (sense.pos || [])) {
      const lp = p.toLowerCase().trim();
      if (_POS_TERMS.has(lp)) tags.push(p);
    }

    for (const g of (sense.glosses || [])) {
      const t = g.trim();
      if (!t) continue;
      const lo = t.toLowerCase();
      if (_POS_TERMS.has(lo))  { tags.push(t); continue; }
      if (_isNoise(t))         continue;
      const cleaned = t.replace(/^[①-⑳]\s*/, '');
      if (cleaned && !_isNoise(cleaned)) defs.push(cleaned);
    }

    const seen = new Set();
    const uniqueTags = [];
    for (const t of tags) {
      const lo = t.toLowerCase();
      if (!seen.has(lo)) { seen.add(lo); uniqueTags.push(t); }
    }

    return { tags: uniqueTags, defs };
  }

  // ── Tag colour class ───────────────────────────────────────────────────────
  function _tagClass(label) {
    const l = label.toLowerCase();
    if (l === 'common')         return 'etag-common';
    if (l === 'news')           return 'etag-news';
    if (l === 'loanword')       return 'etag-loan';
    if (l.startsWith('top '))   return 'etag-freq';
    if (l === 'spec')           return 'etag-spec';
    if (l === 'priority form')  return 'etag-prio';
    return 'etag-misc';
  }

  // ── Ruby token rendering ───────────────────────────────────────────────────
  function _renderRuby(tokens) {
    if (!tokens || !tokens.length) return '';
    let out = '';
    for (const t of tokens) {
      if (typeof t === 'string') {
        out += esc(t);
      } else if (Array.isArray(t) && t.length >= 2) {
        out += `<ruby>${esc(t[0])}<rt>${esc(t[1])}</rt></ruby>`;
      }
    }
    return out;
  }

  function _renderHeadword(kanji, readings) {
    if (kanji.length && readings.length) {
      let html = `<ruby class="head-ruby">${esc(kanji[0])}<rt>${esc(readings[0])}</rt></ruby>`;
      if (kanji.length > 1) {
        html += `<span class="alt-kanji">${kanji.slice(1, 3).map(esc).join('・')}</span>`;
      }
      return html;
    }
    const all = kanji.length ? kanji : readings;
    return `<span class="head-plain">${all.slice(0, 3).map(esc).join('・')}</span>`;
  }

  // ── Forms table ────────────────────────────────────────────────────────────
  const _FORM_PRIORITY_LABEL = {
    'form-pri':   'high priority',
    'form-valid': 'valid',
    'form-rare':  'rare',
    'form-irreg': 'irregular',
    'form-sk':    'search only',
  };

  function _renderForms(forms) {
    if (!forms) return '';
    const kanji    = forms.kanji    || [];
    const readings = forms.readings || [];
    if (!kanji.length && !readings.length) return '';

    let html = '<div class="forms"><div class="forms-label">forms</div>';
    if (kanji.length) {
      html += `<div class="forms-kanji">${kanji.map(esc).join('、')}</div>`;
    }
    if (readings.length) {
      html += '<div class="forms-readings">';
      for (const r of readings) {
        const cls   = r.priority ? ` ${esc(r.priority)}` : '';
        const title = r.priority ? ` title="${esc(_FORM_PRIORITY_LABEL[r.priority] || r.priority)}"` : '';
        html += `<span class="form-reading${cls}"${title}>${esc(r.text)}</span>`;
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ── Examples ───────────────────────────────────────────────────────────────
  function _renderExamples(examples) {
    if (!examples || !examples.length) return '';
    let html = '<div class="examples">';
    examples.slice(0, 2).forEach(ex => {
      const ja = _renderRuby(ex.ja);
      if (!ja && !ex.en) return;
      html += '<div class="example">';
      if (ja)    html += `<div class="example-ja">${ja}</div>`;
      if (ex.en) html += `<div class="example-en">${esc(ex.en)}</div>`;
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  // ── Render entry list HTML ─────────────────────────────────────────────────
  function renderEntries(data) {
    const { entries, error, reason, source } = data;

    if (error) return `<div class="error">${esc(error)}</div>`;
    if (!entries || !entries.length) return '';

    let html = '<div class="list">';

    let entryIdx = -1;
    for (const entry of entries) {
      entryIdx += 1;
      html += '<div class="entry">';

      const kanji    = entry.kanji_forms   || [];
      const readings = entry.reading_forms || [];

      html += '<div class="word-head"><div class="kanji-row">';
      html += _renderHeadword(kanji.slice(0, 3), readings.slice(0, 3));
      html += `<button class="audio-btn" data-entry="${entryIdx}" title="Play pronunciation">🔊</button>`;
      if (reason) html += `<span class="reason">${esc(reason)}</span>`;
      html += '</div>';
      const forms = [...new Set([...kanji, ...readings].filter(Boolean))];
      if (!forms.length && data.matched) forms.push(data.matched);
      // Known/ignored status reflects the MORPHEME under the cursor (タイ), not
      // the whole looked-up entry (タイ人) — tracking is per-morpheme. The button
      // tooltips name that morpheme so it's clear what gets marked.
      const markForms = (Array.isArray(data.mark) && data.mark.length) ? data.mark : forms;
      const isKnown = markForms.some(f => knownSet.has(f));
      const isIgnored = markForms.some(f => ignoredSet.has(f));
      const mw = esc(data.mark_word || markForms[0] || '');
      html += '<div class="mine-actions-inline">'
        + `<button class="known-btn${isKnown ? ' is-known' : ''}" data-entry="${entryIdx}" `
        + `title="${isKnown ? `「${mw}」 known — click to unmark` : `Mark 「${mw}」 as known`}">${isKnown ? '✓' : '○'}</button>`
        + `<button class="ignore-btn${isIgnored ? ' is-ignored' : ''}" data-entry="${entryIdx}" `
        + `title="${isIgnored ? `「${mw}」 ignored — click to unmark` : `Ignore 「${mw}」 (exclude from comprehension)`}">⊘</button>`
        + `<button class="mine-btn" data-entry="${entryIdx}" title="Add this word as a card">＋</button>`
        + `<button class="mine-config" data-entry="${entryIdx}" title="Mining options">⚙</button>`
        + '</div>';
      html += '</div>';

      const entryTags = entry.tags || [];
      if (entryTags.length) {
        html += '<div class="entry-tags">';
        entryTags.forEach(t => {
          html += `<span class="etag ${_tagClass(t)}">${esc(t)}</span>`;
        });
        html += '</div>';
      }

      html += '<div class="senses">';
      (entry.senses || []).slice(0, 6).forEach((sense, i) => {
        const { tags, defs } = _cleanSense(sense);
        if (!tags.length && !defs.length) return;
        html += '<div class="sense">';
        if (tags.length) {
          html += '<div class="pos-row">';
          tags.forEach(t => { html += `<span class="pos">${esc(t)}</span>`; });
          html += '</div>';
        }
        if (defs.length) {
          html += '<div class="gloss-list">';
          defs.slice(0, 5).forEach(g => {
            html += `<div class="gloss"><span class="gloss-num">${i + 1}.</span> ${esc(g)}</div>`;
          });
          html += '</div>';
        }
        html += _renderExamples(sense.examples);
        html += '</div>';
      });
      html += '</div>';

      html += _renderForms(entry.forms);
      html += '</div>';
    }

    if (source) html += `<div class="source">${esc(source)}</div>`;
    html += '</div>';
    return html;
  }

  // ── Popup CSS (injected into shadow root - isolated from page styles) ───────
  const POPUP_CSS = `
    :host { all: initial; }

    #popup {
      position: fixed;
      width: 440px;
      max-height: 320px;
      background: #ffffff;
      border: 1.5px solid rgba(0, 0, 0, 0.11);
      border-top: none;
      border-radius: 16px;
      box-shadow:
        0 1px 3px rgba(0, 0, 0, 0.06),
        0 4px 16px rgba(0, 0, 0, 0.08),
        0 16px 48px rgba(170, 0, 255, 0.10);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 14px;
      color: #1a1133;
      overflow: hidden;
      display: none;
      z-index: 2147483647;
    }

    /* Purple accent strip matching the app card design */
    #popup::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, #aa00ff, #cc66ff);
      pointer-events: none;
    }

    .list { max-height: 320px; overflow-y: auto; }
    .list::-webkit-scrollbar       { width: 6px; }
    .list::-webkit-scrollbar-track { background: transparent; }
    .list::-webkit-scrollbar-thumb { background: rgba(170, 0, 255, 0.20); border-radius: 3px; }
    .list::-webkit-scrollbar-thumb:hover { background: rgba(170, 0, 255, 0.35); }

    .entry { padding: 14px 20px 16px; border-bottom: 1px solid rgba(0, 0, 0, 0.06); }
    .entry:last-child { border-bottom: none; }

    .word-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .kanji-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }

    .mine-actions-inline { display: flex; gap: 4px; flex: 0 0 auto; }
    .audio-btn {
      appearance: none; border: 1px solid rgba(37, 99, 235, 0.25);
      background: rgba(37, 99, 235, 0.08); color: #2563eb;
      font-size: 12px; line-height: 1; cursor: pointer;
      width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      align-self: center;
      transition: background .14s ease, transform .14s ease;
    }
    .audio-btn:hover { background: rgba(37, 99, 235, 0.18); transform: translateY(-1px); }
    .audio-btn:disabled { opacity: .6; cursor: default; transform: none; }
    .audio-btn.is-unavailable { opacity: .4; cursor: default; transform: none; }
    .known-btn {
      appearance: none; border: 1px solid rgba(22, 163, 74, 0.30);
      background: rgba(22, 163, 74, 0.08); color: #16a34a;
      font-size: 13px; line-height: 1; cursor: pointer;
      width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .14s ease, color .14s ease, transform .14s ease;
    }
    .known-btn:hover { background: rgba(22, 163, 74, 0.18); transform: translateY(-1px); }
    .known-btn.is-known { background: #16a34a; color: #fff; border-color: transparent; }
    .known-btn:disabled { opacity: .6; cursor: default; transform: none; }
    .ignore-btn {
      appearance: none; border: 1px solid rgba(148, 163, 184, 0.30);
      background: rgba(148, 163, 184, 0.08); color: #94a3b8;
      font-size: 13px; line-height: 1; cursor: pointer;
      width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .14s ease, color .14s ease, transform .14s ease;
    }
    .ignore-btn:hover { background: rgba(148, 163, 184, 0.20); transform: translateY(-1px); }
    .ignore-btn.is-ignored { background: #64748b; color: #fff; border-color: transparent; }
    .ignore-btn:disabled { opacity: .6; cursor: default; transform: none; }
    .mine-btn, .mine-config {
      appearance: none; border: 1px solid rgba(170, 0, 255, 0.25);
      background: rgba(170, 0, 255, 0.08); color: #aa00ff;
      font-size: 14px; line-height: 1; cursor: pointer;
      width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .14s ease, color .14s ease, transform .14s ease;
    }
    .mine-config { font-size: 12px; }
    .mine-btn:hover, .mine-config:hover {
      background: linear-gradient(135deg, #aa00ff, #cc66ff); color: #fff; transform: translateY(-1px);
    }
    .mine-btn:disabled { opacity: .6; cursor: default; transform: none; }

    /* Mining panel */
    .mine-panel { padding: 14px 18px 16px; display: flex; flex-direction: column; gap: 10px; }
    .mine-loading { font-size: 12.5px; color: #6b5f8a; }
    .mine-head { display: flex; align-items: center; gap: 8px; }
    .mine-back {
      appearance: none; border: none; background: rgba(0, 0, 0, 0.05); color: #1a1133;
      width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1;
    }
    .mine-back:hover { background: rgba(170, 0, 255, 0.12); }
    .mine-title { font-size: 16px; font-weight: 700; color: #1a1133; word-break: break-all; }
    .mine-row { display: flex; align-items: center; gap: 10px; }
    .mine-label { flex: 0 0 92px; font-size: 11.5px; color: #6b5f8a; font-weight: 600; }
    .mine-select {
      flex: 1; min-width: 0; appearance: none;
      background: #faf8ff; color: #1a1133; border: 1px solid rgba(170, 0, 255, 0.20);
      border-radius: 7px; padding: 6px 8px; font: inherit; font-size: 12.5px;
    }
    .mine-select:focus { outline: none; border-color: #aa00ff; }
    .mine-select-sm { font-size: 12px; padding: 5px 7px; }
    .mine-fieldmap {
      display: flex; flex-direction: column; gap: 7px;
      padding-top: 8px; border-top: 1px solid rgba(0, 0, 0, 0.07);
    }
    .mine-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 8px; }
    .mine-status { font-size: 12px; color: #6b5f8a; }
    .mine-status[data-level="ok"]  { color: #16a34a; font-weight: 600; }
    .mine-status[data-level="err"] { color: #dc2626; }
    .mine-add {
      appearance: none; border: none; cursor: pointer;
      background: linear-gradient(135deg, #aa00ff, #cc66ff); color: #fff;
      font-weight: 700; font-size: 13px; padding: 8px 16px; border-radius: 10px;
      box-shadow: 0 2px 8px rgba(170, 0, 255, 0.35);
      transition: transform .14s cubic-bezier(0.34, 1.4, 0.64, 1), filter .15s ease;
    }
    .mine-add:hover { filter: brightness(1.06); transform: translateY(-2px); }
    .mine-add:active { transform: scale(0.96); }
    .mine-add:disabled { opacity: .7; cursor: default; transform: none; }

    .head-ruby  { font-size: 26px; font-weight: 700; color: #1a1133; letter-spacing: .02em; ruby-position: over; line-height: 2.2; }
    .head-ruby rt { font-size: 13px; font-weight: 600; color: #6b5f8a; letter-spacing: .04em; margin-bottom: 6px; }
    .head-plain { font-size: 26px; font-weight: 700; color: #1a1133; letter-spacing: .02em; }
    .alt-kanji  { font-size: 14px; color: #a898c8; align-self: center; }

    .reason {
      display: inline-block; padding: 2px 8px 3px; font-size: 10px; font-weight: 600;
      color: #aa00ff; background: rgba(170, 0, 255, 0.08);
      border: 1px solid rgba(170, 0, 255, 0.18); border-radius: 5px;
      letter-spacing: .3px; text-transform: lowercase; white-space: nowrap;
    }

    .entry-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
    .etag { font-size: 10px; font-weight: 700; padding: 2px 8px 3px; border-radius: 4px; letter-spacing: .3px; text-transform: lowercase; white-space: nowrap; }
    .etag-common { color: #16a34a; background: rgba(22, 163, 74, 0.08);   border: 1px solid rgba(22, 163, 74, 0.20); }
    .etag-freq   { color: #d97706; background: rgba(217, 119, 6, 0.08);   border: 1px solid rgba(217, 119, 6, 0.20); }
    .etag-news   { color: #2563eb; background: rgba(37, 99, 235, 0.08);   border: 1px solid rgba(37, 99, 235, 0.18); }
    .etag-loan   { color: #aa00ff; background: rgba(170, 0, 255, 0.08);  border: 1px solid rgba(170, 0, 255, 0.20); }
    .etag-spec   { color: #6b5f8a; background: rgba(107, 95, 138, 0.07);  border: 1px solid rgba(107, 95, 138, 0.15); }
    .etag-misc   { color: #6b5f8a; background: rgba(107, 95, 138, 0.06);  border: 1px solid rgba(107, 95, 138, 0.12); }
    .etag-prio   { color: #d97706; background: rgba(217, 119, 6, 0.08);   border: 1px solid rgba(217, 119, 6, 0.20); }

    .senses { display: flex; flex-direction: column; gap: 10px; }
    .sense  { line-height: 1.55; }

    .pos-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
    .pos {
      font-size: 10px; color: #aa00ff; text-transform: lowercase; letter-spacing: .3px;
      font-weight: 600; padding: 3px 9px; background: rgba(170, 0, 255, 0.08);
      border: 1px solid rgba(170, 0, 255, 0.20); border-radius: 5px; white-space: nowrap;
    }

    .gloss-list { display: flex; flex-direction: column; gap: 2px; }
    .gloss      { color: #1a1133; font-size: 13.5px; line-height: 1.55; padding-left: 4px; }
    .gloss-num  { color: #a898c8; font-size: 12px; font-weight: 600; margin-right: 2px; }

    .examples {
      margin: 6px 0 0 4px; display: flex; flex-direction: column; gap: 6px;
      border-left: 2px solid rgba(170, 0, 255, 0.20); padding: 4px 0 4px 10px;
    }
    .example-ja    { font-size: 13px; color: #1a1133; line-height: 1.9; }
    .example-ja ruby rt { font-size: 10.5px; color: #6b5f8a; font-weight: 500; }
    .example-en    { font-size: 12px; color: #6b5f8a; font-style: italic; line-height: 1.5; margin-top: 1px; }

    .forms {
      margin-top: 12px; padding: 8px 10px;
      background: rgba(170, 0, 255, 0.04); border: 1px solid rgba(170, 0, 255, 0.12); border-radius: 6px;
    }
    .forms-label    { font-size: 9.5px; font-weight: 700; color: #a898c8; text-transform: uppercase; letter-spacing: .6px; margin-bottom: 4px; }
    .forms-kanji    { font-size: 14px; color: #1a1133; font-weight: 600; margin-bottom: 4px; }
    .forms-readings { display: flex; flex-wrap: wrap; gap: 6px; }
    .form-reading   { font-size: 12px; color: #6b5f8a; padding: 1px 6px; border-radius: 4px; background: rgba(170, 0, 255, 0.06); border: 1px solid rgba(170, 0, 255, 0.12); }
    .form-reading.form-pri  { color: #d97706; background: rgba(217, 119, 6, 0.08); border-color: rgba(217, 119, 6, 0.20); }
    .form-reading.form-rare { color: #a898c8; }

    .source {
      padding: 8px 20px 10px; font-size: 10px; color: #a898c8;
      text-align: right; letter-spacing: .3px; border-top: 1px solid rgba(0, 0, 0, 0.06);
    }
    .error { padding: 18px 20px; color: #dc2626; font-size: 13px; line-height: 1.6; }

    #close-btn {
      position: absolute; top: 9px; right: 10px;
      width: 22px; height: 22px;
      background: rgba(170, 0, 255, 0.08); border: 1px solid rgba(170, 0, 255, 0.18);
      border-radius: 50%; color: #a898c8; font-size: 15px; line-height: 22px;
      cursor: pointer; padding: 0; text-align: center; z-index: 1;
    }
    #close-btn:hover {
      background: rgba(170, 0, 255, 0.15); border-color: rgba(170, 0, 255, 0.32);
      color: #aa00ff;
    }
  `;

  // ── Word highlight (CSS Custom Highlight API) ──────────────────────────────
  // The ::highlight(immersion-match) rule lives in content.css (page-level).
  function applyHighlight(textNode, offset, length) {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    try {
      const r = document.createRange();
      r.setStart(textNode, offset);
      r.setEnd(textNode, Math.min(offset + length, textNode.length));
      CSS.highlights.set('immersion-match', new Highlight(r));
    } catch (_) {}
  }

  function clearHighlight() {
    try {
      if (window.CSS && CSS.highlights) CSS.highlights.delete('immersion-match');
    } catch (_) {}
  }

  // ── Popup DOM setup ────────────────────────────────────────────────────────
  function ensurePopup() {
    if (shadowHost && document.body.contains(shadowHost)) return;

    shadowHost = document.createElement('div');
    shadowHost.id = '__imm_dict_host';
    Object.assign(shadowHost.style, {
      position: 'fixed', top: '0', left: '0',
      width: '0', height: '0',
      zIndex: '2147483647', pointerEvents: 'none',
    });
    document.body.appendChild(shadowHost);

    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = POPUP_CSS;
    shadowRoot.appendChild(style);

    popupEl = document.createElement('div');
    popupEl.id = 'popup';
    shadowRoot.appendChild(popupEl);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); hidePopup(); });
    popupEl.appendChild(closeBtn);

    contentEl = document.createElement('div');
    contentEl.id = 'popup-content';
    popupEl.appendChild(contentEl);

    // Delegated handling for the per-entry audio (🔊), known (○/✓), mine (＋)
    // and config (⚙) buttons.
    contentEl.addEventListener('click', (e) => {
      const audioBtn = e.target.closest('.audio-btn');
      const knownBtn = e.target.closest('.known-btn');
      const ignoreBtn = e.target.closest('.ignore-btn');
      const cfgBtn = e.target.closest('.mine-config');
      const mineBtn = e.target.closest('.mine-btn');
      const btn = audioBtn || knownBtn || ignoreBtn || cfgBtn || mineBtn;
      if (!btn) return;
      e.stopPropagation();
      const entry = currentLookup && currentLookup.entries
        && currentLookup.entries[Number(btn.dataset.entry)];
      if (!entry) return;
      if (audioBtn) playWordAudio(entry, audioBtn);
      else if (knownBtn) toggleKnown(entry, knownBtn);
      else if (ignoreBtn) toggleIgnore(entry, ignoreBtn);
      else if (cfgBtn || !mineConfigured()) openMinePanel(entry);
      else quickMine(entry, mineBtn);
    });

    popupEl.addEventListener('mouseenter', () => {
      popupHovered = true;
      clearTimeout(hideTimer);
    });
    popupEl.addEventListener('mouseleave', () => {
      popupHovered = false;
      if (!modHeld && !miningOpen) scheduleHide(200);
    });
  }

  // ── Show / position / hide ─────────────────────────────────────────────────
  function showPopup(data, x, y, textNode, offset) {
    ensurePopup();

    // Capture context for the mine button (valid even when we skip re-rendering).
    currentLookup = data;
    currentAnchor = { x, y, textNode, offset };
    currentSentence = getSentenceContext(textNode, offset);
    miningOpen = false;
    if (!knownLoaded) loadKnownWords();

    const renderKey = (data.matched || '') + '|' + (data.reason || '');
    const wasHidden = popupEl.style.display === 'none' || popupEl.style.display === '';

    if (renderKey !== lastShownKey || wasHidden) {
      const html = renderEntries(data);
      if (!html) { hidePopup(); return; }
      if (wasHidden) {
        popupEl.style.left = '-9999px';
        popupEl.style.top  = '-9999px';
      }
      const doc = new DOMParser().parseFromString(html, 'text/html');
      contentEl.replaceChildren(...Array.from(doc.body.childNodes));
      lastShownKey = renderKey;
    }

    if (data.matched && textNode != null && offset != null) {
      applyHighlight(textNode, offset, data.matched.length);
    }

    popupEl.style.display = 'block';
    shadowHost.style.pointerEvents = 'auto';
    positionPopup(x, y, textNode, offset);
  }

  function positionPopup(x, y, textNode, offset) {
    if (!popupEl || popupEl.style.display === 'none') return;

    const GAP = 8, MARGIN = 10;
    const popupRect = popupEl.getBoundingClientRect();
    const W = popupRect.width  || 440;
    const H = popupRect.height || 200;

    let lineBottom = y + 20;
    let lineTop    = y;
    let anchorLeft = x;

    if (textNode != null && offset != null) {
      try {
        const r = document.createRange();
        r.setStart(textNode, offset);
        r.setEnd(textNode, Math.min(offset + 1, textNode.length));
        const rect = r.getBoundingClientRect();
        if (rect.height > 0) {
          lineBottom = rect.bottom;
          lineTop    = rect.top;
          anchorLeft = rect.left;
        }
      } catch (_) {}
    }

    let left = anchorLeft;
    if (left + W > window.innerWidth - MARGIN) left = window.innerWidth - W - MARGIN;
    if (left < MARGIN) left = MARGIN;

    const spaceBelow = window.innerHeight - lineBottom - GAP - MARGIN;
    const spaceAbove = lineTop - GAP - MARGIN;
    let top;
    if      (H <= spaceBelow)          top = lineBottom + GAP;
    else if (H <= spaceAbove)          top = lineTop - H - GAP;
    else if (spaceBelow >= spaceAbove) top = lineBottom + GAP;
    else                               top = lineTop - H - GAP;

    if (top < MARGIN) top = MARGIN;
    if (top + H > window.innerHeight - MARGIN) top = Math.max(MARGIN, window.innerHeight - H - MARGIN);

    popupEl.style.left = left + 'px';
    popupEl.style.top  = top  + 'px';
  }

  function scheduleHide(delay) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopup, delay);
  }

  function hidePopup() {
    if (popupEl)    { popupEl.style.display = 'none'; }
    if (shadowHost) { shadowHost.style.pointerEvents = 'none'; }
    popupHovered = false;
    miningOpen   = false;
    lastChunk    = null;
    lastShownKey = null;
    clearHighlight();
  }

  function reposition() {
    if (currentAnchor) {
      positionPopup(currentAnchor.x, currentAnchor.y, currentAnchor.textNode, currentAnchor.offset);
    }
  }

  // ── Lookup via background WebSocket connection ─────────────────────────────
  async function doLookup(chunk, x, y, textNode, offset) {
    latestLookupChunk = chunk;

    const cached = cacheGet(chunk);
    if (cached !== undefined) {
      onResult(cached, chunk, x, y, textNode, offset);
      return;
    }

    let result;
    try {
      result = await chrome.runtime.sendMessage({ action: 'lookup', text: chunk });
    } catch (_) {
      return;
    }

    cachePut(chunk, result ?? null);
    onResult(result, chunk, x, y, textNode, offset);
  }

  // ── Result handler ────────────────────────────────────────────────────────
  function onResult(data, chunk, x, y, textNode, offset) {
    if (chunk !== latestLookupChunk) return;  // stale response - a newer hover won
    if (!data || (!data.entries?.length && !data.error)) {
      if (!popupHovered) hidePopup();
      return;
    }
    showPopup(data, x, y, textNode, offset);
  }

  // ── Settings (shared with the popup/options page) ──────────────────────────
  // Is the configured lookup modifier active for this event? 'none' means the
  // popup fires on plain hover (no key held).
  function modifierActive(e) {
    switch (lookupModifier) {
      case 'alt':  return e.altKey;
      case 'ctrl': return e.ctrlKey;
      case 'none': return true;
      case 'shift':
      default:     return e.shiftKey;
    }
  }

  // Does this KeyboardEvent.key correspond to the configured modifier?
  function isModifierKey(key) {
    return (lookupModifier === 'shift' && key === 'Shift')
        || (lookupModifier === 'alt'   && key === 'Alt')
        || (lookupModifier === 'ctrl'  && key === 'Control');
  }

  function applyDictSettings(s) {
    if (!s) return;
    if (typeof s.enabled === 'boolean') dictEnabled = s.enabled;
    if (typeof s.modifier === 'string') lookupModifier = s.modifier;
    if (!dictEnabled) hidePopup();
  }

  try {
    chrome.storage.local.get([DICT_SETTINGS_KEY, MINE_SETTINGS_KEY], (data) => {
      applyDictSettings(data && data[DICT_SETTINGS_KEY]);
      if (data && data[MINE_SETTINGS_KEY]) {
        mineSettings = { fieldMaps: {}, ...data[MINE_SETTINGS_KEY] };
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[DICT_SETTINGS_KEY]) {
        applyDictSettings(changes[DICT_SETTINGS_KEY].newValue);
      }
      // The settings page edits the mining template; pick it up without a reload.
      if (changes[MINE_SETTINGS_KEY]) {
        mineSettings = { deckId: null, typeId: null, fieldMaps: {}, ...(changes[MINE_SETTINGS_KEY].newValue || {}) };
      }
    });
  } catch (_) { /* no storage permission in some contexts */ }

  loadKnownWords();

  // ── Sentence extraction (for the mined card's context field) ───────────────
  const SENT_MAX    = 140;                       // chars gathered each direction
  const SENT_ENDERS = /[。．.!?！？…\n]/;          // sentence boundaries

  // Walk text nodes backward from (startNode, startOffset), gathering up to
  // maxLen characters. Mirrors collectForwardText but in reverse.
  function collectBackwardText(startNode, startOffset, maxLen) {
    let root = startNode.parentNode;
    while (root && root !== document.body && _INLINE.has(root.nodeName)) {
      root = root.parentNode;
    }
    if (!root) root = document.body;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let el = node.parentNode;
        while (el && el !== root) {
          if (el.nodeName === 'RT' || el.nodeName === 'RP') return NodeFilter.FILTER_REJECT;
          el = el.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let text = startNode.textContent.slice(0, startOffset);
    walker.currentNode = startNode;
    while (text.length < maxLen && walker.previousNode()) {
      text = walker.currentNode.textContent + text;
    }
    return text.slice(-maxLen);
  }

  function getSentenceContext(textNode, offset) {
    if (!textNode || offset == null) return '';
    let before, after;
    try {
      before = collectBackwardText(textNode, offset, SENT_MAX);
      after  = textNode.textContent.slice(offset) + collectForwardText(textNode, SENT_MAX);
    } catch (_) {
      return '';
    }
    let start = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      if (SENT_ENDERS.test(before[i])) { start = i + 1; break; }
    }
    let end = after.length;
    for (let i = 0; i < after.length; i++) {
      if (SENT_ENDERS.test(after[i])) { end = i + 1; break; }
    }
    return (before.slice(start) + after.slice(0, end)).replace(/\s+/g, ' ').trim();
  }

  // ── Known words ────────────────────────────────────────────────────────────
  function loadKnownWords() {
    chrome.runtime.sendMessage({ action: 'get_known_words' }).then((r) => {
      if (r && !r.error && Array.isArray(r.known)) {
        knownSet = new Set(r.known);
        ignoredSet = new Set(Array.isArray(r.ignored) ? r.ignored : []);
        knownLoaded = true;
      }
    }).catch(() => {});
  }

  // All spellings/readings of an entry. Storing every form means a word marked
  // known still matches the tokenizer's lemma whether the text writes it in
  // kanji or kana (e.g. 為る / する, 綺麗 / きれい). Used for card mining.
  function entryForms(entry) {
    const forms = [...new Set([...(entry.kanji_forms || []), ...(entry.reading_forms || [])].filter(Boolean))];
    if (!forms.length && currentLookup && currentLookup.matched) forms.push(currentLookup.matched);
    return forms;
  }

  // Known/ignored marking targets the MORPHEME under the cursor (タイ in タイ人),
  // not the whole looked-up entry — tracking is per-morpheme like the colouring.
  // Falls back to entry forms if the backend didn't supply a mark target.
  function markForms(entry) {
    if (currentLookup && Array.isArray(currentLookup.mark) && currentLookup.mark.length) {
      return currentLookup.mark;
    }
    return entryForms(entry);
  }

  // Set a status across all forms of an entry and sync local sets + the YouTube
  // layer. `status` is 'known' | 'ignored' | 'unknown' (clear).
  async function _setEntryStatus(forms, status) {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ action: 'set_known_word', terms: forms, status });
    } catch (_) {
      return false;
    }
    if (!resp || resp.error) return false;
    for (const f of forms) {
      knownSet.delete(f); ignoredSet.delete(f);
      if (status === 'known') knownSet.add(f);
      else if (status === 'ignored') ignoredSet.add(f);
    }
    try {
      window.dispatchEvent(new CustomEvent('imm-known-changed',
        { detail: { terms: forms, status, known: status === 'known' } }));
    } catch (_) {}
    return true;
  }

  async function toggleKnown(entry, btn) {
    const forms = markForms(entry);
    if (!forms.length) return;
    const makeKnown = !forms.some(f => knownSet.has(f));
    btn.disabled = true;
    const ok = await _setEntryStatus(forms, makeKnown ? 'known' : 'unknown');
    btn.disabled = false;
    if (!ok) return;
    btn.classList.toggle('is-known', makeKnown);
    btn.textContent = makeKnown ? '✓' : '○';
    btn.title = makeKnown ? 'Known — click to unmark' : 'Mark as known';
    // Clearing/setting known may have cleared an ignored mark; resync that button.
    const ignoreBtn = btn.parentElement && btn.parentElement.querySelector('.ignore-btn');
    if (ignoreBtn) {
      ignoreBtn.classList.remove('is-ignored');
      ignoreBtn.title = 'Ignore (exclude from comprehension)';
    }
  }

  async function toggleIgnore(entry, btn) {
    const forms = markForms(entry);
    if (!forms.length) return;
    const makeIgnored = !forms.some(f => ignoredSet.has(f));
    btn.disabled = true;
    const ok = await _setEntryStatus(forms, makeIgnored ? 'ignored' : 'unknown');
    btn.disabled = false;
    if (!ok) return;
    btn.classList.toggle('is-ignored', makeIgnored);
    btn.title = makeIgnored ? 'Ignored — click to unmark' : 'Ignore (exclude from comprehension)';
    // Ignoring clears any known mark; resync that button.
    const knownBtn = btn.parentElement && btn.parentElement.querySelector('.known-btn');
    if (knownBtn) {
      knownBtn.classList.remove('is-known');
      knownBtn.textContent = '○';
      knownBtn.title = 'Mark as known';
    }
  }

  // ── Word audio (pronunciation playback) ────────────────────────────────────
  // Clips come from the desktop app (get_word_audio: fetched once, then served
  // from its disk cache) and play through Web Audio - unlike an <audio> element
  // or data: URI, decodeAudioData isn't subject to the host page's CSP.
  const AUDIO_CACHE_MAX = 32;
  const _audioCache = new Map();  // `${term}|${reading}` → AudioBuffer | 'unavailable'
  let _audioCtx = null;

  function _audioTarget(entry) {
    const kanji = entry.kanji_forms || [];
    const readings = entry.reading_forms || [];
    const term = kanji[0] || readings[0] || (currentLookup && currentLookup.matched) || '';
    return { term, reading: readings[0] || term };
  }

  async function _decodeAudioB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!_audioCtx) _audioCtx = new AudioContext();
    return _audioCtx.decodeAudioData(bytes.buffer);
  }

  function _playAudioBuffer(buf) {
    if (!_audioCtx) return;
    const play = () => {
      const src = _audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(_audioCtx.destination);
      src.start();
    };
    if (_audioCtx.state === 'suspended') {
      _audioCtx.resume().then(play).catch(() => {});
    } else {
      play();
    }
  }

  function _audioBtnUnavailable(btn) {
    btn.disabled = true;
    btn.classList.add('is-unavailable');
    btn.textContent = '🔇';
    btn.title = 'No audio available for this word';
  }

  function _audioBtnError(btn, original, message) {
    btn.disabled = false;
    btn.textContent = '⚠';
    btn.title = message;
    setTimeout(() => { btn.textContent = original; btn.title = 'Play pronunciation'; }, 1600);
  }

  async function playWordAudio(entry, btn) {
    const { term, reading } = _audioTarget(entry);
    if (!term) return;

    const key = term + '|' + reading;
    const cached = _audioCache.get(key);
    if (cached === 'unavailable') { _audioBtnUnavailable(btn); return; }
    if (cached) { _playAudioBuffer(cached); return; }

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ action: 'get_word_audio', term, reading });
    } catch (_) {
      resp = null;
    }

    if (!resp || resp.error || !resp.audio_b64) {
      if (resp && resp.unavailable) {
        _audioCache.set(key, 'unavailable');
        _audioBtnUnavailable(btn);
        return;
      }
      _audioBtnError(btn, original, (resp && resp.error) || 'Could not reach Immersion Suite');
      return;
    }

    let buf;
    try {
      buf = await _decodeAudioB64(resp.audio_b64);
    } catch (_) {
      _audioBtnError(btn, original, 'Could not decode audio');
      return;
    }

    _audioCache.set(key, buf);
    if (_audioCache.size > AUDIO_CACHE_MAX) {
      _audioCache.delete(_audioCache.keys().next().value);
    }
    btn.disabled = false;
    btn.textContent = original;
    _playAudioBuffer(buf);
  }

  // ── Mining (build a card from the hovered entry) ───────────────────────────
  const MINE_SLOTS = [
    { key: 'expression', label: 'Expression' },
    { key: 'reading',    label: 'Reading' },
    { key: 'definition', label: 'Definition' },
    { key: 'sentence',   label: 'Sentence' },
  ];

  function saveMineSettings() {
    try { chrome.storage.local.set({ [MINE_SETTINGS_KEY]: mineSettings }); } catch (_) {}
  }

  function mineConfigured() {
    return !!(mineSettings.deckId && mineSettings.typeId &&
      mineSettings.fieldMaps && mineSettings.fieldMaps[mineSettings.typeId]);
  }

  // Map mining slots → a card type's field names by fuzzy name match.
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

  function entryDefinition(entry) {
    const out = [];
    (entry.senses || []).slice(0, 5).forEach(s => {
      const { defs } = _cleanSense(s);
      if (defs.length) out.push(defs.slice(0, 3).join('; '));
    });
    return out.join(' / ');
  }

  function mineValues(entry) {
    const kanji = entry.kanji_forms || [];
    const readings = entry.reading_forms || [];
    return {
      expression: kanji[0] || readings[0] || (currentLookup && currentLookup.matched) || '',
      reading: readings[0] || '',
      definition: entryDefinition(entry),
      sentence: currentSentence || '',
    };
  }

  function fieldsFromMap(entry, slotMap) {
    const vals = mineValues(entry);
    const fields = {};
    for (const slot of MINE_SLOTS) {
      const f = slotMap[slot.key];
      if (f && vals[slot.key]) fields[f] = vals[slot.key];
    }
    return fields;
  }

  async function ensureDeckData() {
    if (!decksCache) {
      const r = await chrome.runtime.sendMessage({ action: 'get_decks' });
      if (!r || r.error) throw new Error((r && r.error) || 'no decks available');
      decksCache = r.decks || [];
    }
    if (!cardTypesCache) {
      const r = await chrome.runtime.sendMessage({ action: 'get_card_types' });
      if (!r || r.error) throw new Error((r && r.error) || 'no card types available');
      cardTypesCache = r.card_types || [];
    }
  }

  function _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function _labeledRow(label, control, title) {
    const row = _el('div', 'mine-row');
    if (title) row.title = title;
    row.appendChild(_el('label', 'mine-label', label));
    row.appendChild(control);
    return row;
  }

  // One-click mine using the remembered deck / type / field map.
  async function quickMine(entry, btn) {
    try { await ensureDeckData(); } catch (_) { return openMinePanel(entry); }
    const slotMap = mineSettings.fieldMaps[mineSettings.typeId];
    const haveDeck = decksCache.some(d => String(d.id) === String(mineSettings.deckId));
    const haveType = cardTypesCache.some(t => String(t.id) === String(mineSettings.typeId));
    const fields = slotMap ? fieldsFromMap(entry, slotMap) : {};
    if (!haveDeck || !haveType || !Object.keys(fields).length) return openMinePanel(entry);

    const original = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        action: 'create_card',
        deck_id: Number(mineSettings.deckId),
        card_type_id: Number(mineSettings.typeId),
        fields,
      });
    } catch (_) {
      btn.disabled = false; btn.textContent = '⚠'; btn.title = 'Could not reach Immersion Suite';
      setTimeout(() => { btn.textContent = original; btn.title = 'Add this word as a card'; }, 1600);
      return;
    }
    btn.disabled = false;
    if (!resp || resp.error) {
      btn.textContent = '⚠'; btn.title = (resp && resp.error) || 'Failed to add';
      setTimeout(() => { btn.textContent = original; btn.title = 'Add this word as a card'; }, 1600);
      return;
    }
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = original; }, 1400);
  }

  async function openMinePanel(entry) {
    miningOpen = true;
    clearTimeout(hideTimer);
    const panel = _el('div', 'mine-panel');
    panel.appendChild(_el('div', 'mine-loading', 'Loading decks…'));
    contentEl.replaceChildren(panel);
    reposition();

    try {
      await ensureDeckData();
    } catch (e) {
      panel.replaceChildren(_el('div', 'mine-status', 'Could not reach Immersion Suite. Is it running?'));
      panel.querySelector('.mine-status').dataset.level = 'err';
      return;
    }
    if (!miningOpen) return;  // panel was closed while loading
    buildMinePanel(panel, entry);
  }

  function buildMinePanel(panel, entry) {
    const vals = mineValues(entry);
    panel.replaceChildren();

    const head = _el('div', 'mine-head');
    const back = _el('button', 'mine-back', '←');
    back.title = 'Back';
    back.addEventListener('click', (e) => { e.stopPropagation(); closeMinePanel(); });
    head.appendChild(back);
    head.appendChild(_el('span', 'mine-title', vals.expression || 'Mine word'));
    panel.appendChild(head);

    const deckSel = _el('select', 'mine-select');
    for (const d of decksCache) {
      const o = _el('option', null, d.name); o.value = String(d.id);
      if (String(mineSettings.deckId) === String(d.id)) o.selected = true;
      deckSel.appendChild(o);
    }
    const typeSel = _el('select', 'mine-select');
    for (const t of cardTypesCache) {
      const o = _el('option', null, t.name); o.value = String(t.id);
      if (String(mineSettings.typeId) === String(t.id)) o.selected = true;
      typeSel.appendChild(o);
    }
    panel.appendChild(_labeledRow('Deck', deckSel));
    panel.appendChild(_labeledRow('Type', typeSel));

    const mapWrap = _el('div', 'mine-fieldmap');
    panel.appendChild(mapWrap);

    const renderMap = () => {
      mapWrap.replaceChildren();
      const t = cardTypesCache.find(t => String(t.id) === typeSel.value);
      if (!t) return;
      const fields = t.fields || [];
      const stored = (mineSettings.fieldMaps && mineSettings.fieldMaps[t.id]) || autoMapDict(fields);
      for (const slot of MINE_SLOTS) {
        const sub = _el('select', 'mine-select mine-select-sm');
        sub.dataset.slot = slot.key;
        const none = _el('option', null, '— skip —'); none.value = '';
        sub.appendChild(none);
        for (const f of fields) {
          const o = _el('option', null, f); o.value = f;
          if (stored[slot.key] === f) o.selected = true;
          sub.appendChild(o);
        }
        mapWrap.appendChild(_labeledRow(slot.label, sub, vals[slot.key] || '(empty)'));
      }
    };
    typeSel.addEventListener('change', renderMap);
    renderMap();

    const status = _el('div', 'mine-status');
    const addBtn = _el('button', 'mine-add', '＋ Add card');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitMine(entry, { deckSel, typeSel, mapWrap, status, addBtn });
    });
    const actions = _el('div', 'mine-actions');
    actions.appendChild(status);
    actions.appendChild(addBtn);
    panel.appendChild(actions);

    reposition();
  }

  async function submitMine(entry, ui) {
    const { deckSel, typeSel, mapWrap, status, addBtn } = ui;
    const deckId = deckSel.value, typeId = typeSel.value;
    if (!deckId || !typeId) { _mineStatus(status, 'Pick a deck and card type.', 'err'); return; }

    const slotMap = {};
    for (const sel of mapWrap.querySelectorAll('select[data-slot]')) slotMap[sel.dataset.slot] = sel.value;
    const fields = fieldsFromMap(entry, slotMap);
    if (!Object.keys(fields).length) { _mineStatus(status, 'Map at least one field.', 'err'); return; }

    addBtn.disabled = true;
    _mineStatus(status, 'Adding…');
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        action: 'create_card', deck_id: Number(deckId), card_type_id: Number(typeId), fields,
      });
    } catch (_) {
      addBtn.disabled = false; _mineStatus(status, 'Could not reach Immersion Suite.', 'err'); return;
    }
    addBtn.disabled = false;
    if (!resp || resp.error) { _mineStatus(status, (resp && resp.error) || 'Failed to add.', 'err'); return; }

    // Remember for one-click next time.
    mineSettings.deckId = deckId;
    mineSettings.typeId = typeId;
    mineSettings.fieldMaps = mineSettings.fieldMaps || {};
    mineSettings.fieldMaps[typeId] = slotMap;
    saveMineSettings();

    _mineStatus(status, '✓ Added', 'ok');
    addBtn.textContent = '✓ Added';
    setTimeout(closeMinePanel, 750);
  }

  function _mineStatus(el, msg, level) {
    el.textContent = msg || '';
    el.dataset.level = level || '';
  }

  function closeMinePanel() {
    miningOpen = false;
    if (currentLookup) {
      const html = renderEntries(currentLookup);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      contentEl.replaceChildren(...Array.from(doc.body.childNodes));
      reposition();
      if (!popupHovered && !modHeld) scheduleHide(500);
    } else {
      hidePopup();
    }
  }

  // The YouTube subtitle bar text exists for lookups, so plain hover works
  // there without the modifier. Only the text element - the bar's toolbar
  // buttons (あ / 語 / …) would otherwise trigger bogus lookups.
  function inNoKeyZone(target) {
    return !!(target && target.closest && target.closest('.imm-yt-subbar-text'));
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  document.addEventListener('mousemove', (e) => {
    if (miningOpen) return;  // don't start new lookups while the panel is open
    const active = dictEnabled && (modifierActive(e) || inNoKeyZone(e.target));
    modHeld = active;

    if (!active) {
      clearTimeout(debounceTimer);
      if (popupEl && popupEl.style.display === 'block' && !popupHovered) {
        scheduleHide(150);
      }
      return;
    }

    const x = e.clientX;
    const y = e.clientY;
    clearTimeout(debounceTimer);
    // Without a held key (no-key mode or the subtitle-bar hover zone) the popup
    // would chase every pixel of movement, so debounce harder to avoid spam.
    const debounce = (lookupModifier === 'none' || !modifierActive(e)) ? 120 : DEBOUNCE_MS;
    debounceTimer = setTimeout(() => {
      const hit = getChunkAtPoint(x, y);
      if (!hit) {
        lastChunk = null;
        if (!popupHovered) hidePopup();
        return;
      }
      // Same chunk still under the cursor - reposition without re-fetching.
      if (hit.chunk === lastChunk && popupEl && popupEl.style.display === 'block') {
        positionPopup(x, y, hit.textNode, hit.offset);
        return;
      }
      lastChunk = hit.chunk;
      doLookup(hit.chunk, x, y, hit.textNode, hit.offset);
    }, debounce);
  });

  document.addEventListener('keydown', (e) => {
    if (isModifierKey(e.key)) modHeld = true;
  });

  document.addEventListener('keyup', (e) => {
    if (isModifierKey(e.key)) {
      modHeld = false;
      if (!popupHovered && !miningOpen) scheduleHide(200);
    }
  });

  // Dismiss on click outside the popup.
  document.addEventListener('click', () => {
    if (!popupHovered && !miningOpen) hidePopup();
  }, true);

  // Dismiss on scroll - popup position becomes stale.
  document.addEventListener('scroll', () => {
    if (!popupHovered && !miningOpen) hidePopup();
  }, true);

})();
