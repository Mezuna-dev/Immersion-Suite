# Browser Extension

Last updated: 2026-06-07.

The Immersion Suite browser extension has two surfaces: a **popup dictionary** that works
on any webpage, and a **YouTube immersion layer** (subtitle overlay, navigation, furigana,
and sentence mining). Both are thin UI layers; the desktop app owns all data (dictionary,
SRS, media) and does the heavy lifting. The extension talks to it over a local WebSocket.

---

## How it works end-to-end

1. User holds **Shift** and hovers over Japanese text in the browser.
2. `content.js` detects the text at the cursor, extracts up to 25 characters, and sends
   a lookup request to `background.js` via `chrome.runtime.sendMessage`.
3. `background.js` forwards the request over the WebSocket to the desktop app.
4. The desktop app's `src/ws_server.py` looks up the text in Jitendex (`data/dicts/jitendex.sqlite`)
   and returns a JSON response.
5. `background.js` routes the response back to the tab that sent the request.
6. `content.js` renders the result in a shadow DOM popup positioned at the cursor.

---

## Architecture

```
Browser (Chrome or Firefox)               Desktop App (Python / PyQt6)
┌─────────────────────────────────┐       ┌──────────────────────────────┐
│  content.js (injected in tabs)  │       │  src/ws_server.py            │
│  • Shift+hover text detection   │       │  • asyncio + websockets lib  │
│  • Shadow DOM popup rendering   │◄─────►│  • ws://127.0.0.1:8765       │
│  • 512-entry LRU result cache   │  WS   │  • origins=None (any origin) │
│                                 │       │  • calls lookup_text(text)   │
│  background.js (persistent)     │       │    from src/dictionary/      │
│  • Owns the WS connection       │       └──────────────────────────────┘
│  • Reconnects on demand         │
│  • Pending map: id → resolve    │
│  • Graceful error on no app     │
└─────────────────────────────────┘
```

---

## File structure

```
extension/
  manifest.json               MV3, Chrome + Firefox compatible
  background/
    background.js             WS connection owner and message router
  content/
    content.js                Text detection + popup render (IIFE, injected in all tabs)
    content.css               Popup ::highlight rule + YouTube overlay/queue styles
    youtube.js                YouTube subtitle overlay, navigation, furigana, mining
    page-script.js            Runs in the page world to read ytInitialPlayerResponse
  icons/
    16.png  48.png  128.png   Extracted from installer/icon.ico
```

```
src/
  ws_server.py                asyncio WebSocket server, started as daemon thread
  furigana.py                 SudachiPy tokenizer (powers the `tokenize` action)
  dictionary/
    handler.py                DictionaryUrlSchemeHandler + get_dict_module()
    jitendex.py               Primary dictionary backend (SQLite)
    jmdict.py                 Fallback dictionary backend (SQLite)
data/
  dicts/
    jitendex.sqlite           Built by scripts/build_jitendex.py (103 MB, ~295k entries)
  media/                      Mined screenshots + audio clips (yt_<uuid>.{jpg,mp3})
vendor/
  bin/<platform>/             Bundled yt-dlp + ffmpeg (fetch_binaries.py); resolved by
                              ws_server._resolve_binary, else PATH
```

---

## WebSocket protocol

All messages are JSON. The extension always initiates; the desktop always responds.
Every message carries an `id` (UUID v4) so concurrent in-flight lookups route correctly.

**Lookup request** (extension → desktop):
```json
{ "id": "uuid", "action": "lookup", "text": "読む" }
```

**Lookup response** (desktop → extension):
```json
{
  "id": "uuid",
  "matched": "読む",
  "entries": [
    {
      "kanji_forms":   ["読む"],
      "reading_forms": ["よむ"],
      "senses": [{ "pos": ["verb"], "glosses": ["to read"] }],
      "tags": ["common"],
      "reason": "masu-stem"
    }
  ]
}
```

**Error response** (dictionary unavailable, timeout, etc.):
```json
{ "id": "uuid", "error": "Dictionary not available.", "matched": null, "entries": [] }
```

**Ping / pong** (keep-alive, optional):
```json
{ "id": "uuid", "action": "ping" }   →   { "id": "uuid", "action": "pong" }
```

### YouTube + mining actions (1.3.0)

The YouTube layer (`content/youtube.js`) adds these actions over the same pipe:

| Action | Request payload | Response |
|---|---|---|
| `get_decks` | `{}` | `{ decks: [{id, name, parent_id}] }` |
| `get_card_types` | `{}` | `{ card_types: [{id, name, fields, is_default}] }` |
| `tokenize` | `{ text }` | `{ tokens: [{text, reading}] }` (furigana) |
| `get_youtube_subs` | `{ video_url, lang }` | `{ cues: [{start, end, text}], source }` or `{ error }` |
| `create_card_with_media` | `{ video_url, start_ms, end_ms, sentence, image_b64, deck_id, card_type_id, field_map }` | `{ card_id, image_filename, audio_filename, audio_skipped }` |

`create_card_with_media` and `get_youtube_subs` shell out to the bundled yt-dlp + ffmpeg
(`vendor/bin/<platform>/`, falling back to the yt-dlp Python module in dev), so they use a
longer WS timeout - see `LONG_ACTIONS` in `background.js`.

---

## background.js

Runs as a **service worker** in Chrome (can be suspended after ~30 s of inactivity) and
as a **persistent background page** in Firefox (never suspended).

Key design points:

- `ensureConnected()` - returns the open WebSocket, creating one on demand if none exists.
  Concurrent callers share a single in-flight `connecting` Promise.
- `pending` Map - maps `id → resolve`. When the server response arrives, `onMessage`
  looks up the id and calls the stored resolve. This handles any number of concurrent
  lookups across all tabs.
- `onClose` - drains the pending map with error responses so no tab hangs indefinitely.
- Timeout - each lookup resolves with an error after 5 seconds if no response arrives.
- Error path - if `ensureConnected()` rejects (desktop not running), the content script
  receives `{ error: "Could not connect..." }` and shows it in the popup.

---

## content.js

Injected into every page at `document_idle`. Wrapped in an IIFE with a
`window.__immDictLoaded` guard against double-injection on SPA navigations.

### Text detection

- `isJapanese(ch)` - checks Unicode ranges: Hiragana+Katakana (3040–30FF),
  CJK unified (4E00–9FFF), CJK Extension A (3400–4DBF), Halfwidth Katakana (FF65–FF9F).
- `caretAt(x, y)` - cross-browser shim: `caretRangeFromPoint` (Chrome/Safari) or
  `caretPositionFromPoint` → Range adapter (Firefox).
- `getChunkAtPoint(x, y)` - resolves the caret, skips `<rt>`/`<rp>` furigana nodes,
  applies the off-by-one bounding-box probe to land on the right glyph, then walks
  forward through inline elements via `collectForwardText` to gather up to 25 characters.
- Debounce - 16 ms (≈ one frame). Rapid mousemoves coalesce into a single lookup.
- Same-chunk optimisation - if the cursor is still over the same chunk and the popup
  is open, `positionPopup` is called directly without a new lookup.

### Staleness guard

`latestLookupChunk` is set before each async send. When the response arrives,
`onResult` drops it silently if `chunk !== latestLookupChunk`, preventing a slow
response from a previous hover from overwriting a newer result.

### LRU cache

512-entry Map (insertion-order eviction). Cache hit skips the entire WS round-trip.

### Popup

Shadow DOM hosted in a zero-size fixed `<div id="__imm_dict_host">`. Shadow isolation
keeps the popup CSS from leaking into the host page and host-page CSS from breaking
the popup.

Positioning logic: anchors to the character's bounding rect, prefers below, flips
above when below doesn't fit, clamps to viewport margins.

Word highlight uses the CSS Custom Highlight API (`CSS.highlights`, `Highlight`).
The `::highlight(immersion-match)` rule lives in `content.css` (page-level);
the highlight range is registered dynamically in JS.

### Event wiring

| Event | Action |
|---|---|
| `mousemove` (Shift held) | Debounced chunk detect + lookup |
| `mousemove` (Shift not held) | Schedule hide after 150 ms |
| `keyup` Shift | Schedule hide after 200 ms |
| `click` (outside popup) | Hide immediately |
| `scroll` | Hide immediately |
| Popup `mouseenter` | Cancel hide timer |
| Popup `mouseleave` | Schedule hide after 200 ms |

---

## Chrome vs Firefox differences

| | Chrome | Firefox |
|---|---|---|
| Background type | Service worker (`background.service_worker`) | Persistent page (`background.scripts`) |
| Suspension | After ~30 s idle | Never |
| WS keep-alive needed | Yes (optional ping) | No |
| `connect-src` CSP | Permissive by default | Requires explicit `ws://127.0.0.1:8765/` |
| Extension origin header | None sent on WS connect | Sends `moz-extension://<id>` |
| Min version | Chrome 88 (MV3 launch) | Firefox 109 (MV3 launch) |

The manifest includes both `service_worker` and `scripts` in the `background` field.
Chrome uses `service_worker` and ignores `scripts`; Firefox uses `scripts` and ignores
`service_worker`.

The `content_security_policy.extension_pages` directive in the manifest is required for
Firefox to allow the WebSocket connection. Chrome does not need it but respects it.

The Python server uses `origins=None` in `websockets.serve()` so it accepts connections
from any origin header - necessary because Firefox sends `moz-extension://<id>` as the
WebSocket origin, which `websockets` ≥12.0 would otherwise reject.

---

## Desktop app integration

`src/ws_server.py` is started in `src/gui.py` at the top of `main()`, before
`QApplication` is created:

```python
import ws_server
ws_server.start()   # daemon thread - dies with the process
```

The server runs an asyncio event loop in a daemon thread. SQLite lookups are dispatched
via `loop.run_in_executor(None, ...)` so they don't block the event loop.

The dictionary module is a singleton (`get_dict_module()` in `src/dictionary/handler.py`)
that returns a `JitendexModule` if `data/dicts/jitendex.sqlite` exists, or falls back to
`JMdictModule`. The module is initialised on first call and reused for the lifetime of
the process.

To rebuild the dictionary: `python scripts/build_jitendex.py`
(downloads the latest Jitendex Yomitan zip from jitendex.org and builds the SQLite DB).

---

## Adding new message types

To add a new action (e.g. `"add-card"` for mining):

1. **Server** (`src/ws_server.py`) - add an `elif action == 'add-card':` branch in
   `_handle`, call the relevant desktop function, return `{ "id": ..., ... }`.
2. **Background** (`extension/background/background.js`) - add a new handler alongside
   the `'lookup'` branch in `chrome.runtime.onMessage.addListener`, or create a new
   send helper similar to `lookup()`.
3. **Content script** (`extension/content/content.js`) - call
   `chrome.runtime.sendMessage({ action: 'add-card', ... })` from wherever the user
   triggers the action (e.g. a button click in the popup).

---

## Shipped in 1.3.0 (formerly planned)

- **YouTube subtitle bar** - `content/youtube.js` injects a subtitle overlay into the
  YouTube player with Shift-hover lookup, A/S/D navigation, auto-pause, and a SudachiPy
  furigana toggle. Cues come from a three-tier pipeline: direct timedtext fetch →
  desktop `get_youtube_subs` (yt-dlp) → live DOM mirror of YouTube's own captions.
- **Mining UI** - a card panel mines the active line to a chosen deck / card type /
  field mapping via `create_card_with_media`; the desktop writes the card to `data/app.db`.
- **Sentence audio + screenshot** - rather than `tabCapture`, the desktop clips the line's
  audio directly with the bundled yt-dlp + ffmpeg and the extension captures a video frame;
  both are written to `data/media/` and referenced from the card fields.

## Still planned

- Per-video external subtitle (`.srt` / `.ass`) override.
- See [`extension-improvements.md`](extension-improvements.md) for the broader roadmap
  (pitch accent, mining from the popup, configurable hotkeys, more streaming sites).
