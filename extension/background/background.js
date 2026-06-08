const WS_URL = 'ws://127.0.0.1:8765';
const DEFAULT_TIMEOUT_MS = 5000;
const LONG_TIMEOUT_MS = 90000;  // for media downloads

// Live WebSocket instance, or null when disconnected.
let ws = null;
// In-flight connect Promise so concurrent callers share one attempt.
let connecting = null;
// Pending requests: id → resolve callback.
const pending = new Map();

function onMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
}

function onClose() {
  ws = null;
  connecting = null;
  for (const [id, resolve] of pending) {
    resolve({ id, error: 'Connection to Immersion Suite was lost.' });
  }
  pending.clear();
}

function connect() {
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    socket.onopen = () => {
      ws = socket;
      connecting = null;
      resolve(socket);
    };
    socket.onerror = (event) => {
      console.error('[immersion] WebSocket error:', event);
      connecting = null;
      reject(new Error('Could not connect to Immersion Suite. Is the app running?'));
    };
    socket.onclose = onClose;
    socket.onmessage = onMessage;
  });
  return connecting;
}

async function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  return connect();
}

// One generic request/response pipe. Callers pass { action, ...payload };
// `timeoutMs` is per-action so media downloads can wait longer than lookups.
async function request(payload, { timeoutMs } = {}) {
  let socket;
  try {
    socket = await ensureConnected();
  } catch (e) {
    return { error: e.message };
  }

  const id = crypto.randomUUID();
  const t = timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, error: 'Request timed out.' });
    }, t);

    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    // The socket can close in the gap between ensureConnected() and here; a
    // throwing send() would otherwise reject this promise instead of resolving
    // a clean { error } like every other failure path.
    try {
      socket.send(JSON.stringify({ id, ...payload }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ id, error: `Could not reach Immersion Suite: ${e.message}` });
    }
  });
}

// Some actions can be heavy (downloading + clipping audio). Bump the timeout
// on those so the WS request doesn't get killed before yt-dlp finishes.
const LONG_ACTIONS = new Set(['create_card_with_media', 'get_youtube_subs']);

// MV3 tears the service worker down after ~30s idle. An open WebSocket only
// keeps it alive *while messages flow*, so during a long, silent yt-dlp job
// (clips can run 60-80s) Chrome can suspend the worker and drop the socket
// mid-download. While any long action is in flight we send a ping every 20s;
// each ping/pong is WebSocket activity that resets the idle timer, and the
// server already answers ping → pong cheaply.
const KEEPALIVE_MS = 20000;
let longActionsInFlight = 0;
let keepaliveTimer = null;

function startKeepalive() {
  longActionsInFlight += 1;
  if (keepaliveTimer != null) return;
  keepaliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ id: 'keepalive', action: 'ping' })); } catch {}
    }
  }, KEEPALIVE_MS);
}

function stopKeepalive() {
  longActionsInFlight = Math.max(0, longActionsInFlight - 1);
  if (longActionsInFlight === 0 && keepaliveTimer != null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !msg.action) return;

  // Legacy popup-lookup path: { action: 'lookup', text }
  if (msg.action === 'lookup') {
    request({ action: 'lookup', text: msg.text }).then((r) => {
      if (r && !('matched' in r) && !('entries' in r) && !r.error) {
        sendResponse({ ...r, matched: null, entries: [] });
      } else {
        sendResponse(r);
      }
    });
    return true;
  }

  // Generic pass-through for YouTube-integration actions.
  const { action, ...rest } = msg;
  const isLong = LONG_ACTIONS.has(action);
  const opts = isLong ? { timeoutMs: LONG_TIMEOUT_MS } : {};
  if (isLong) startKeepalive();
  request({ action, ...rest }, opts).then((r) => {
    if (isLong) stopKeepalive();
    sendResponse(r);
  });
  return true; // keep the message channel open for the async reply
});
