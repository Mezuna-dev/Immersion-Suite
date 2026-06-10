(function () {
  'use strict';

  // Guard against double-injection on SPA navigations.
  if (window.__immPageFuriLoaded) return;
  window.__immPageFuriLoaded = true;

  // Whole-page furigana: opt-in per tab (toolbar popup button). When enabled,
  // every visible text node containing kanji is tokenized by the desktop app
  // (Sudachi) and rewritten as <ruby>漢字<rt>かんじ</rt></ruby>. Tokenization is
  // lazy - nodes are queued only when their element scrolls near the viewport -
  // so enabling it on a long page stays cheap.

  // ── Constants ──────────────────────────────────────────────────────────────
  const BATCH_MAX   = 40;    // text nodes tokenized per WS round-trip
  const FLUSH_MS    = 60;    // debounce before sending a batch
  const CACHE_MAX   = 2000;  // tokenized-text LRU cap

  // Elements whose text must never be annotated. Matched with closest(), so it
  // covers ancestors too. `.imm-page-furi` are our own wrappers; the imm ids
  // are the hover dictionary host and the YouTube layer (it has its own ruby).
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'textarea', 'input', 'select', 'option',
    'code', 'pre', 'kbd', 'samp', 'ruby', 'svg', 'math', 'iframe', 'object',
    'canvas', 'title', '.imm-page-furi', '#__imm_dict_host',
    '#__imm_yt_subbar', '#__imm_yt_queue',
  ].join(',');

  // Kanji (incl. iteration marks and supplementary-plane ideographs) - only
  // text that can carry ruby is worth a tokenize round-trip.
  const HAS_KANJI = /[\u3005\u3006\u3400-\u9FFF\uF900-\uFAFF\u{20000}-\u{3FFFF}]/u;

  // ── State ──────────────────────────────────────────────────────────────────
  let enabled     = false;
  let lastError   = null;
  let io          = null;   // IntersectionObserver - lazy tokenization trigger
  let mo          = null;   // MutationObserver - dynamically added content
  let flushTimer  = null;
  let inFlight    = false;
  const pendingByEl = new Map();  // element → Text[] awaiting visibility
  const queue       = [];         // Text nodes ready to tokenize
  const annotated   = [];         // [{span, original}] for clean restore
  const cache       = new Map();  // text → tokens (LRU)

  function cacheGet(key) {
    if (!cache.has(key)) return undefined;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  function cachePut(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // ── Node eligibility ───────────────────────────────────────────────────────
  function eligible(node) {
    const t = node.nodeValue;
    if (!t || !HAS_KANJI.test(t)) return false;
    const el = node.parentElement;
    if (!el || el.isContentEditable) return false;
    try {
      if (el.closest(SKIP_SELECTOR)) return false;
    } catch (_) {
      return false;
    }
    return true;
  }

  // ── Scan: collect kanji text nodes, observe their parents ─────────────────
  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (eligible(root)) registerNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    try {
      if (root.closest(SKIP_SELECTOR)) return;
    } catch (_) {
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return eligible(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) registerNode(walker.currentNode);
  }

  function registerNode(node) {
    const el = node.parentElement;
    if (!el) return;
    let nodes = pendingByEl.get(el);
    if (!nodes) {
      nodes = [];
      pendingByEl.set(el, nodes);
      io.observe(el);
    }
    if (!nodes.includes(node)) nodes.push(node);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const nodes = pendingByEl.get(el);
      pendingByEl.delete(el);
      io.unobserve(el);
      if (nodes && nodes.length) {
        queue.push(...nodes);
        scheduleFlush();
      }
    }
  }

  function onMutations(mutations) {
    if (!enabled) return;
    for (const m of mutations) {
      for (const added of m.addedNodes) scan(added);
    }
  }

  // ── Tokenize queue ─────────────────────────────────────────────────────────
  function scheduleFlush() {
    if (flushTimer == null && !inFlight) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  async function flush() {
    flushTimer = null;
    if (inFlight || !enabled) return;

    const batch = [];
    while (queue.length && batch.length < BATCH_MAX) {
      const node = queue.shift();
      if (!node.isConnected || !eligible(node)) continue;
      const tokens = cacheGet(node.nodeValue);
      if (tokens !== undefined) {
        annotate(node, node.nodeValue, tokens);
        continue;
      }
      batch.push(node);
    }
    if (!batch.length) {
      if (queue.length) scheduleFlush();
      return;
    }

    // Repeated strings (nav items, list templates) tokenize once per batch.
    const texts = [];
    const indexOf = new Map();
    const nodeTextIdx = batch.map((node) => {
      const t = node.nodeValue;
      let i = indexOf.get(t);
      if (i === undefined) {
        i = texts.length;
        indexOf.set(t, i);
        texts.push(t);
      }
      return i;
    });

    inFlight = true;
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ action: 'tokenize', texts });
    } catch (_) { /* fall through to the error path */ }
    inFlight = false;
    if (!enabled) return;

    if (!resp || resp.error || !Array.isArray(resp.results)) {
      // Backend unreachable / tokenizer unavailable: switch off rather than
      // hammering a dead socket. The popup shows the message on next open.
      lastError = (resp && resp.error) || 'Could not reach Immersion Suite. Is the app running?';
      setEnabled(false);
      return;
    }

    batch.forEach((node, bi) => {
      const r = resp.results[nodeTextIdx[bi]];
      const tokens = r && Array.isArray(r.tokens) ? r.tokens : null;
      if (!tokens) return;
      cachePut(texts[nodeTextIdx[bi]], tokens);
      annotate(node, texts[nodeTextIdx[bi]], tokens);
    });

    if (queue.length) scheduleFlush();
  }

  // ── Ruby injection / restore ───────────────────────────────────────────────
  function annotate(node, text, tokens) {
    // The page may have rewritten the node while its batch was in flight.
    if (!node.isConnected || node.nodeValue !== text) return;
    if (!tokens.some(t => t.reading)) return;  // nothing to ruby

    const span = document.createElement('span');
    span.className = 'imm-page-furi';
    for (const tok of tokens) {
      if (tok.reading) {
        const ruby = document.createElement('ruby');
        ruby.appendChild(document.createTextNode(tok.text));
        const rt = document.createElement('rt');
        rt.textContent = tok.reading;
        ruby.appendChild(rt);
        span.appendChild(ruby);
      } else {
        span.appendChild(document.createTextNode(tok.text));
      }
    }

    try {
      node.replaceWith(span);
    } catch (_) {
      return;
    }
    annotated.push({ span, original: text });
  }

  function restoreAll() {
    for (const { span, original } of annotated) {
      if (!span.isConnected) continue;
      try { span.replaceWith(document.createTextNode(original)); } catch (_) {}
    }
    annotated.length = 0;
  }

  // ── Enable / disable ───────────────────────────────────────────────────────
  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      // Pre-annotate a viewport's worth of margin so scrolling rarely waits.
      io = new IntersectionObserver(onIntersect, { rootMargin: '50% 0px' });
      mo = new MutationObserver(onMutations);
      scan(document.body);
      mo.observe(document.body, { childList: true, subtree: true });
    } else {
      if (io) { io.disconnect(); io = null; }
      if (mo) { mo.disconnect(); mo = null; }
      clearTimeout(flushTimer);
      flushTimer = null;
      pendingByEl.clear();
      queue.length = 0;
      restoreAll();
    }
  }

  // ── Toolbar popup control channel ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.action === 'imm_page_furigana_get') {
      sendResponse({ enabled, error: lastError });
      return;
    }
    if (msg.action === 'imm_page_furigana_set') {
      lastError = null;
      setEnabled(!!msg.enabled);
      sendResponse({ enabled, error: lastError });
      return;
    }
  });

})();
