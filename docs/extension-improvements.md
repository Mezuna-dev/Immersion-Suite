# Extension Improvements & Roadmap

Implementation reference for upgrading the Immersion Suite browser extension into a
best-in-class Japanese immersion tool. Generated from a full review of the
extension stack on 2026-06-07.

**Scope of the review:**
- `extension/content/content.js` - universal Shift-hover dictionary popup
- `extension/content/youtube.js` - YouTube immersion layer (subbar, nav, mining, queue, furigana)
- `extension/content/page-script.js` - page-world bridge that reads `ytInitialPlayerResponse`
- `extension/background/background.js` - WebSocket bridge to the desktop app
- `extension/manifest.json` - MV3 manifest
- `src/ws_server.py` - desktop-app WebSocket backend (lookup, decks, card types, media, tokenize, subs)

Related plans: [`docs/youtube-integration.md`](youtube-integration.md),
[`docs/yomitan-integration.md`](yomitan-integration.md),
[`docs/browser-extension.md`](browser-extension.md).

---

## What already works (baseline - do not regress)

- Universal Shift-hover dictionary: deinflection, frequency-ranked entries, Shadow
  DOM isolated popup, CSS Custom Highlight matched span, smart above/below
  positioning (`content.js:574`).
- YouTube layer: custom subtitle bar, A/S/D sub-navigation, auto-pause, Sudachi
  furigana, sentence-mining cards (screenshot + yt-dlp audio clip), gamified
  sidebar queue, subtitle timing offset.
- 3-tier caption pipeline: direct timedtext fetch → yt-dlp backend → DOM-mirror
  fallback, degrading gracefully against YouTube PoT-gating (`youtube.js:608`).
- Backend WS actions: `lookup`, `get_decks`, `get_card_types`,
  `create_card_with_media`, `tokenize`, `get_youtube_subs`.

---

## Priority overview

| # | Item | Category | Effort | Priority |
|---|------|----------|--------|----------|
| 1 | WS origin / token authentication | Security | Low | 🔴 Now |
| 2 | rAF loop should rest when idle | Performance | Low | 🔴 Now |
| 3 | MV3 service-worker keepalive for long downloads | Correctness | Low | 🔴 Now |
| 4 | Frame-step key conflict (`,` `.` `<` `>`) | Bug/UX | Low | 🔴 Now |
| 5 | Widen `isJapanese` start-char detection | Bug | Low | 🟡 Soon |
| 6 | Guard `socket.send` on closed socket | Bug | Low | 🟡 Soon |
| 7 | Toolbar popup + options page (connection status, settings) | UX | Med | 🟡 Soon |
| 8 | Mine-word button in hover popup | Feature | Med | 🟡 Soon |
| 9 | Configurable lookup modifier key | UX | Low | 🟡 Soon |
| 10 | Document Shadow DOM / iframe lookup limits | Docs | Low | 🟢 Backlog |
| 11 | Pitch accent display | Feature | High | 🟢 Strategic |
| 12 | External subtitle files (SRT/ASS) + sync | Feature | Med-High | 🟢 Strategic |
| 13 | Known / unknown word tracking | Feature | High | 🟢 Strategic |
| 14 | More streaming sites (Netflix, Crunchyroll, …) | Feature | High | 🟢 Strategic |
| 15 | Word audio + whole-page furigana toggle | Feature | Med | 🟢 Strategic |

---

# 🔴 Immediate fixes

## 1. WS server origin / token authentication

**Problem.** `src/ws_server.py:548` starts the server with `origins=None`, so the
WebSocket performs **no origin checking**. Any website the user visits can open
`ws://127.0.0.1:8765` and invoke every action - including
`create_card_with_media`, which feeds an arbitrary `video_url` into yt-dlp and
writes files to disk. This is a drive-by card-spam / arbitrary-download vector.
**This is the most important fix in the review.**

**Approach (cheapest first - ideally do both):**

1. **Origin allowlist.** In `_handle` (`ws_server.py:25`), inspect the connection's
   `Origin` header and reject anything that isn't the extension's own origin.
   - Chrome: `chrome-extension://<id>`
   - Firefox: `moz-extension://<uuid>` (the per-install UUID is not the static
     `gecko.id`, so this alone is awkward for Firefox - pair with the token).
   - With the `websockets` library, the request headers are available on the
     connection object (`websocket.request.headers` in modern versions, or via a
     `process_request` callback). Confirm the installed `websockets` version's API
     before wiring this.

2. **Shared token (recommended primary defense).** On first run the desktop app
   writes a random secret to a known file. The extension reads it (manual paste in
   the options page, or a localhost HTTP handshake) and sends it as the first
   message, or as a query param `ws://127.0.0.1:8765/?token=…`. Server rejects any
   socket that doesn't authenticate within N ms.

**Files.** `src/ws_server.py` (`_handle`, `_run`), `extension/background/background.js`
(send token), `extension/manifest.json` (CSP `connect-src` already pinned to the
host), new options page (#7) to surface/paste the token.

**Acceptance.** A page from `https://example.com` cannot create a card or trigger a
download; the extension still works normally.

---

## 2. rAF loop should rest when idle

**Problem.** `tick()` (`youtube.js:447`) calls `scheduleTick()` unconditionally -
even when the video is paused or no cues are loaded - producing a perpetual ~60fps
loop on every YouTube tab for the page's lifetime.

**Approach.** Drive cue updates off the video element's events instead of a
free-running rAF:
- Start the rAF loop only while `videoEl` is playing; stop it on `pause`/`ended`.
- Listen to `play`, `pause`, `seeked`, `timeupdate` on `videoEl` and recompute the
  active cue there. Keep a lightweight rAF only during active playback for smooth
  sub-boundary timing, or rely on `timeupdate` (fires ~4Hz) plus a short
  `setTimeout` scheduled to the exact next cue boundary.
- Ensure `stopTick()` is called on pause and re-armed on play.

**Files.** `extension/content/youtube.js` (`tick`, `scheduleTick`, `stopTick`,
`loadVideo`, add `videoEl` event listeners).

**Acceptance.** A paused YouTube tab shows ~0 scripting in the performance profiler
from this extension; sub transitions remain frame-accurate during playback.

---

## 3. MV3 service-worker keepalive for long downloads

**Problem.** In Manifest V3 the background service worker is torn down after ~30s
idle. An active WebSocket keeps it alive *only while messages flow*; during a 75s
yt-dlp clip (`MEDIA_TIMEOUT_SECONDS = 75`, WS callsite waits `LONG_TIMEOUT_MS =
90000`) with no traffic, Chrome can suspend the worker and drop the socket
mid-download (`background.js:86` `LONG_ACTIONS`).

**Approach.** While any `LONG_ACTIONS` request is in flight, send a periodic
keepalive over the socket (e.g. `{ action: 'ping' }` every ~20s - `ws_server.py`
already answers `ping` → `pong` at line 45). Stop the interval when the request
resolves. Optionally also use `chrome.alarms` as a secondary keepalive.

**Files.** `extension/background/background.js` (`request`, keepalive interval
keyed to in-flight long actions).

**Acceptance.** A 60–80s audio clip completes reliably with the popup/tab
backgrounded; no "Connection to Immersion Suite was lost" during normal clips.

---

## 4. Frame-step key conflict

**Problem.** `youtube.js:1440` binds `,` `.` `<` `>` for subtitle offset, but these
are YouTube's native shortcuts: `,`/`.` step one frame (while paused) and
`<`/`>` change playback speed. Immersion learners use frame-step and speed.

**Approach.** Move offset nudging behind a modifier that doesn't collide (the
handler already ignores events when `altKey/ctrlKey/metaKey` are held, so pick one
of those, e.g. `Shift+,` / `Shift+.`), **or** only consume these keys when the
queue panel is open/focused. Keep the on-screen `−`/`+` offset buttons
(`youtube.js:1130`) as the discoverable path. Update the tooltips
(`offsetGroup.title`, queue-header buttons) to match whatever binding is chosen.

**Files.** `extension/content/youtube.js` (keydown handler ~`1429`, offset button
tooltips).

**Acceptance.** Native YouTube frame-step and speed keys work again; offset is
still adjustable via buttons and the new binding.

---

# 🟡 Near-term fixes & features

## 5. Widen `isJapanese` start-char detection

**Problem.** `content.js:28` `isJapanese` only tests `chunk[0]` and omits iteration
marks (々 U+3005, 〆 U+3006, 〇 U+3007) and CJK Extension B+ (U+20000+). A hover
whose first glyph is 々 won't trigger a lookup.

**Approach.** Add the CJK Symbols range covering 々〆〇 (U+3005–U+3007) to the
accepted set; optionally handle surrogate pairs for Ext B. Keep it cheap - this is
only the trigger test.

**Files.** `extension/content/content.js` (`isJapanese`).

---

## 6. Guard `socket.send` on a just-closed socket

**Problem.** In `background.js:80`, between `ensureConnected()` and `socket.send()`
the socket can close, and `send()` will throw - rejecting the outer promise instead
of resolving a clean `{ error }`.

**Approach.** Wrap the `send` in try/catch and `resolve({ id, error: … })` on
failure; clear the pending entry and timer.

**Files.** `extension/background/background.js` (`request`).

---

## 7. Toolbar popup + options page

**Problem.** The manifest has no `action` and no options UI (Phase 4 in
`youtube-integration.md`). Every setting - furigana default, audio padding, sub
offset defaults, lookup modifier (#9), WS token (#1) - is invisible, and there is
**no surfaced "is the desktop app running?" status**, which is the most common
source of "why isn't it working" confusion.

**Approach.**
- Add `"action": { "default_popup": "popup/index.html" }` to the manifest plus an
  `"options_ui"` (or reuse the popup).
- Popup shows live connection status by pinging the WS (`{action:'ping'}` →
  `pong`) and a settings form.
- Persist via `chrome.storage.local`. The YouTube layer already reads/writes
  `imm_yt_settings` (`youtube.js:38`, `loadSettings`/`saveSettings`); extend that
  schema and add a content-side settings object for the hover dictionary
  (modifier key, enabled toggle).
- Files referenced in the existing plan: `extension/popup/index.html`,
  `popup.js`, `popup.css` (`youtube-integration.md:229`).

**Acceptance.** Clicking the toolbar icon shows connected/disconnected status and
lets the user change at least: lookup modifier, furigana default, audio
pre/post-roll padding, and (if implemented) the WS token.

---

## 8. Mine-word button in the hover popup

**Problem.** Sentence mining only exists on YouTube. When reading manga/news/VNs in
the browser, there is no "＋ add this word" action in the dictionary popup - arguably
the most-wanted immersion feature. The backend already exposes `get_card_types`,
`get_decks`, and card creation.

**Approach.**
- Add a mine button per entry in `renderEntries` (`content.js:306`).
- On click, build a card from: expression (kanji form), reading, gloss(es), and
  **sentence context** - grab the surrounding sentence from the DOM around the
  hovered text node (reuse/extend `collectForwardText`, plus a backward walk).
- Reuse the YouTube card pipeline. Either add a lighter `create_card`
  (text-only, no media) WS action, or call `create_card_with_media` with no
  `video_url`/media. Mirror the field-mapping UX from `youtube.js`
  (`renderFieldMap`/`autoMap`, `youtube.js:929`) - possibly factor that into a
  shared module so both surfaces stay consistent.
- Remember the last-used deck / card type / field map in `chrome.storage` so mining
  is one click after first setup.

**Files.** `extension/content/content.js` (popup render + mine handler + sentence
extraction), `src/ws_server.py` (optional text-only `create_card`), shared
field-map helper.

**Acceptance.** Hovering a word in an article and clicking ＋ creates a card with
expression, reading, definition, and the sentence it appeared in.

---

## 9. Configurable lookup modifier key

**Problem.** The lookup modifier is hard-coded to Shift (`content.js:666`,
`mousemove` checks `e.shiftKey`). No alternate key or no-modifier hover mode.

**Approach.** Read the chosen modifier from settings (#7): `shift` | `alt` | `ctrl`
| `none`. Generalize the `mousemove`/`keydown`/`keyup` checks to the configured
key. For `none`, debounce more aggressively to avoid popup spam.

**Files.** `extension/content/content.js` (event wiring), options page (#7).

---

## 10. Document Shadow DOM / cross-origin iframe lookup limits

**Problem.** `caretRangeFromPoint`/`caretPositionFromPoint` (`content.js:73`) can't
reach into closed shadow roots or cross-origin iframes, so lookups silently fail on
some sites (and some embedded players).

**Approach.** Document the limitation in `docs/browser-extension.md`. Longer term,
investigate `getComposedRanges`/composed-tree caret APIs and per-frame injection
(content scripts already run in all frames via `<all_urls>` - verify framed text
gets its own popup instance).

---

# 🟢 Strategic features

## 11. Pitch accent display

**Why.** The #1 reason serious learners choose Yomitan. Confirmed absent today:
`src/dictionary/jitendex.py` handles frequency (`_load_freq_dicts`, `_rank_entries`)
but nothing surfaces pitch accent.

**Approach.** Natural home is the [Yomitan embedding](yomitan-integration.md)
([[project-yomitan-integration]]). Two paths:
1. Load a Yomitan-format pitch-accent dictionary (e.g. Kanjium/NHK-derived) into
   the SQLite build pipeline (`scripts/build_jitendex.py` / a new builder) and
   return pitch data from `lookup_text`; render the standard pitch graph
   (downstep notation / overline + drop) in the popup.
2. Defer entirely to the embedded Yomitan popup once Phase 6 cutover lands.

**Render.** Add a pitch component to `renderEntries` (`content.js:306`) - the
classic mora dots with the overline/downstep, plus the accent number badge.

**Files.** `src/dictionary/*.py`, `scripts/build_*.py`, `extension/content/content.js`,
data under `data/dicts/`.

---

## 12. External subtitle files (SRT/ASS) + sync

**Why.** A top-requested immersion-player feature and your own Phase 4 TODO
(`youtube-integration.md:141`). Human-made subs hugely outperform auto-gen
captions.

**Approach.**
- File picker in the YouTube toolbar/queue header to load a local `.srt`/`.ass`
  (and `.vtt`) file; parse into the same `cues` shape `{start, end, text}` the
  pipeline already uses.
- Add SRT and ASS parsers (the backend already has `_parse_subs_vtt`/json3/srv3 in
  `ws_server.py` to mirror; ASS needs dialogue-line parsing and tag stripping).
- Manual sync controls: the existing `subOffsetMs` offset (`youtube.js:36`) covers
  global drift; consider a 2-point linear re-time (anchor two cues to two audio
  positions) for stretched/mismatched subs.
- Per-video persistence: remember the chosen sub file + offset keyed by `videoId`.
- This also lays groundwork for #14 (other sites) since loaded cues are
  site-agnostic.

**Files.** `extension/content/youtube.js` (loader UI + parsers, or call backend),
optionally `src/ws_server.py` (SRT/ASS parse helpers reusing existing patterns).

---

## 13. Known / unknown word tracking

**Why.** A signature immersion feature - color words by learned status to gauge
comprehensibility at a glance and track progress. Transformative across every page.

**Approach.**
- Known-words store: derive from existing Anki-style cards in the desktop DB
  (`src/database.py`) plus an explicit "mark known" action; expose via a new WS
  action `get_known_words` (return a compact set/bloom filter for performance).
- Content side: after the page is tokenized (reuse the `tokenize` WS action /
  Sudachi), wrap each token in a span colored by status (known / learning /
  unknown). Cache aggressively; only re-scan visible text (IntersectionObserver).
- A comprehension meter (% known) per page or per subtitle.
- Settings toggle (#7) since full-page tokenization is heavy - make it opt-in.

**Files.** `src/database.py` + `src/ws_server.py` (known-words export), new content
module for page tokenization + coloring, options (#7).

**Performance note.** Full-page tokenization is the expensive part; batch requests,
cache by text, and consider a JS-side tokenizer for the hot path with Sudachi for
accuracy where it matters.

---

## 14. More streaming sites

**Why.** The YouTube layer is a near-complete, mostly site-agnostic template
(cue engine, queue, mining, offset, DOM-mirror). Netflix/Crunchyroll/Disney+ would
multiply the extension's value.

**Approach.**
- Factor the site-agnostic core out of `youtube.js`: the cue model (`cues`,
  `findCueIndex`, `cueEnd`), the subbar, the queue, mining, offset, and the
  tick/nav logic. Leave site adapters that provide: the `<video>` element, caption
  source (API/DOM-mirror/external file), and the clean media URL for clipping.
- Add per-site content-script matches + adapters. Netflix exposes timed-text via
  its player; Crunchyroll has its own. Where no API is reachable, the DOM-mirror
  fallback (`startCaptionObserver`, `youtube.js:666`) generalizes.
- Audio/screenshot mining: non-YouTube sites may be DRM/EME (canvas taint on
  `captureScreenshot`, `youtube.js:1048`, already try/caught) - fall back to
  full-window capture or skip image; audio clipping via yt-dlp depends on the site
  being supported by yt-dlp.

**Files.** New `extension/content/core/` (shared engine), `extension/content/sites/*.js`
(adapters), `manifest.json` matches, `src/ws_server.py` (per-site URL handling).

---

## 15. Word audio + whole-page furigana toggle

**Why.** The hover popup has no pronunciation audio, and furigana is YouTube-only.

**Approach.**
- **Word audio:** add an audio button to popup entries. Source options: a local
  audio dictionary (Yomitan-format audio sources), or the desktop app's TTS.
  Add a WS action to fetch/stream the clip; play in the popup.
- **Whole-page furigana:** a content-side toggle (and toolbar/options control)
  that tokenizes visible text (reuse `tokenize` WS action + the ruby rendering
  already in `youtube.js` `paintTokens`/`escapeHtml`) and injects ruby over kanji
  runs. Share the renderer with #13's tokenization pass to avoid duplicate work.

**Files.** `extension/content/content.js` (popup audio button, page furigana),
`src/ws_server.py` (word-audio action), shared ruby/tokenize helpers.

---

## Cross-cutting refactors worth doing alongside

- **Shared field-map / card module** used by both YouTube mining (#8 prerequisite)
  and popup mining, so deck/type/field-mapping behaves identically.
- **Shared tokenize + ruby renderer** used by YouTube furigana, page furigana
  (#15), and known-word coloring (#13).
- **Shared settings schema** in `chrome.storage.local` surfaced by the options
  page (#7), consumed by both content scripts.
- **Extract a site-agnostic immersion-player core** (#14) before adding sites, to
  avoid forking `youtube.js` per site.
