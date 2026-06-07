# YouTube Integration

Status: phases 1–3 implemented; phase 4 (per-video subtitle override) still
TODO. Binary bundling (`scripts/fetch_binaries.py`, PyInstaller `vendor/bin`)
not done - `yt-dlp` and `ffmpeg` are looked up on PATH and audio capture is
skipped gracefully if either is missing. Last updated: 2026-05-28.

A subtitle-aware YouTube layer for the browser extension: custom subtitle bar
with click-to-lookup, sub-line navigation, sentence-mining cards with screenshot
and audio clip, and optional `.srt`/`.ass` override per video.

---

## Goal

Bring a full YouTube subtitle and sentence-mining feature set to the existing
`extension/` content script, so users can immerse on YouTube in their normal
browser and mine cards directly into the desktop app's SRS.

Out of scope for v1: pitch-accent overlays, multiple translation tracks,
batch mining of full episodes, vocabulary tracking ("known word" lists).

---

## Architecture

The extension already runs on every page and talks to the desktop app over
`ws://127.0.0.1:8765`. YouTube features slot into that pipe - the extension
gains a YouTube-aware module, the desktop app gains new WS actions for media
handling and card creation.

```
Browser (YouTube tab)                     Desktop App
┌─────────────────────────────────┐       ┌──────────────────────────────┐
│  content.js (existing)          │       │  ws_server.py                │
│   └─ youtube.js (NEW)           │       │   • lookup           (exist) │
│       • detect /watch           │       │   • get_decks         (new)  │
│       • inject page-script ──┐  │       │   • get_card_types    (new)  │
│       • fetch caption track  │  │       │   • create_card_media (new)  │
│       • render sub bar       │  │       │      └─ yt-dlp + ffmpeg      │
│       • toolbar + shortcuts  │  │       │      └─ database.create_card │
│       • make-card flow       │  │       │                              │
│                              │  │       │  media/                      │
│  page-script (NEW, in page)  ◄──┘       │   audio/<id>.mp3   (new)     │
│   • reads ytInitialPlayer-   │  │       │   image/<id>.jpg   (new)     │
│     Response, posts cue list │  │       │                              │
│   • postMessage → content.js │  │       └──────────────────────────────┘
└─────────────────────────────────┘
```

---

## Phasing

Each phase is independently shippable - Phase 1 already delivers usable hover
lookup on the custom subtitle bar.

### Phase 1 - Subtitle overlay

Deliverable: custom subtitle bar on `youtube.com/watch` that the existing
Shift+hover popup works on. Native YT captions hidden.

Files:
- `extension/content/youtube.js` (new) - main YouTube controller
- `extension/content/page-script.js` (new) - injected into page context
- `extension/content/content.js` - load `youtube.js` when host matches
- `extension/content/content.css` - styles for sub bar
- `extension/manifest.json` - declare `web_accessible_resources` for page-script

Caption acquisition (the tricky part):
1. `youtube.js` injects `page-script.js` as a `<script src=…>` tag so it runs in
   the page's JS world and can read `window.ytInitialPlayerResponse`.
2. Page-script reads `playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`,
   picks the user's preferred language (default: first track matching the UI
   locale, fallback: first track), and posts `{type:'imm-yt-track', url}` to
   `window`.
3. Content-script listens on `window` for that message, fetches the timed-text
   URL with `&fmt=json3` appended → parses into `[{start, end, text}, ...]`.
4. SPA navigation: hook `yt-navigate-finish` event so we re-init on each video
   change without a full reload.

Subtitle bar:
- Fixed-position `<div>` inside the player container (`#movie_player`).
- Sub text is rendered as a single text node so the existing chunk-collector
  picks it up correctly.
- Hide native captions with `.ytp-caption-window-container { display: none }`
  injected via `content.css`.
- Update loop: `requestAnimationFrame`, binary-search the cue list against
  `video.currentTime`.

### Phase 2 - Sub navigation

Deliverable: toolbar above the sub bar with **⏮ prev / ↻ replay / ⏭ next**,
plus keyboard shortcuts (A / S / D, configurable later).

- Prev: seek to `cues[i-1].start`, where `i` is the cue currently playing.
- Replay: seek to `cues[i].start`.
- Next: seek to `cues[i+1].start`.
- Auto-pause-at-end-of-sub toggle (off by default).

### Phase 3 - Card creation

Deliverable: "Make Card" button on the toolbar opens a small inline form
(deck dropdown + card type dropdown + preview), creates a card with sentence
text + frame screenshot + audio clip of the active sub.

Extension side:
- "Make Card" button → fetch deck list and card-type list from desktop app
  (cached for the session).
- Screenshot: `canvas.drawImage(videoEl, 0, 0, w, h)` → `canvas.toBlob('image/jpeg', 0.85)`.
- Send `create_card_with_media`:
  ```json
  {
    "id": "...",
    "action": "create_card_with_media",
    "video_url": "https://www.youtube.com/watch?v=...",
    "start_ms": 83400,
    "end_ms": 88200,
    "sentence": "今日は良い天気ですね。",
    "image_b64": "<jpeg base64>",
    "deck_id": 3,
    "card_type_id": 1,
    "field_map": {"Sentence": "sentence", "Image": "image", "Audio": "audio"}
  }
  ```

Desktop app side (new in `ws_server.py`):
- `create_card_with_media` action: writes the image to
  `data/media/image/<uuid>.jpg`, calls `yt-dlp` to download just the audio
  section:
  ```
  yt-dlp --download-sections "*<start>-<end>" -f bestaudio \
         --extract-audio --audio-format mp3 \
         -o data/media/audio/<uuid>.mp3 <video_url>
  ```
  Then inserts a card via `database.create_card` with `fields_json` mapping
  the sentence/image/audio fields per `field_map`.
- Subprocess timeout: 60s. Audio clip cap: 30s.
- yt-dlp errors return `{"error": "..."}` to the extension.

### Phase 4 - `.srt` / `.ass` override

Deliverable: per-video subtitle file upload that replaces the YouTube cue list
for that video.

- Browser-action popup page (`extension/popup/index.html`) with a file picker.
- Parse SRT inline in JS (~50 LOC); ASS uses `ass-compiler` library or a
  trimmed subset parser.
- Store `{video_id → cues[]}` in `chrome.storage.local`, keyed by the `?v=`
  param. Cap at e.g. 50 videos with LRU eviction.
- When `youtube.js` loads a video, check storage first; fall back to YT track.

---

## Bundling yt-dlp and ffmpeg

**Decision: bundle both into the desktop build.** This matches Anki's
approach to ffmpeg and is best practice for a product-grade language app -
asking users to install command-line tools and add them to PATH is the kind
of friction that makes features unused.

Concretely:
- Add `vendor/bin/<platform>/yt-dlp[.exe]` and `vendor/bin/<platform>/ffmpeg[.exe]`
  to the repo (gitignored, fetched by a `scripts/fetch_binaries.py`).
- `ws_server.py` resolves them via a `_resolve_binary("yt-dlp")` helper that
  checks (1) bundled `vendor/bin`, (2) PyInstaller `_MEIPASS` dir when frozen,
  (3) PATH as a last resort.
- `ImmersionSuite.spec` includes `vendor/bin/<platform>` under `datas`.
- `build_windows.bat` / `build_linux.sh` invoke `fetch_binaries.py` before
  PyInstaller.
- README adds a "if you build from source, run `python scripts/fetch_binaries.py`"
  line. Distributed builds ship binaries inside the bundle - no user setup.

Rationale for not requiring system installs:
- Windows users overwhelmingly don't have ffmpeg installed.
- yt-dlp's `--download-sections` flag is newer; system packages lag months
  behind. Pinning the version avoids "works on my machine" reports.
- Each binary is ~30 MB → ~60 MB install size increase. Acceptable for the
  capability gained.

License note: yt-dlp is Unlicense (public-domain equivalent), ffmpeg is
LGPL/GPL depending on build flavor - use an LGPL build to keep our GPL-3.0
compatible without forcing license escalation.

---

## WebSocket protocol additions

Existing actions: `ping`, `lookup`.

New actions:

| action | request fields | response fields |
|---|---|---|
| `get_decks` | - | `{decks: [{id, name, parent_id}, ...]}` |
| `get_card_types` | - | `{card_types: [{id, name, fields: [...]}, ...]}` |
| `create_card_with_media` | see Phase 3 schema | `{card_id}` or `{error}` |

All keep the existing `{id, action, ...}` envelope so the background-script
request/response correlator doesn't change.

---

## Open questions

- **Caption language preference** - UI to pick which track if a video has
  multiple? Default to "ja" hard-coded for now, configurable in settings later.
- **Auto-pause at end of sub** - default on or off? Some tools default it on,
  others default off. Leaning off.
- **Card field convention** - fix a default card type (e.g. "YouTube Mining"
  with Sentence/Image/Audio/Source fields) and auto-create it on first use,
  or require the user to pre-make a card type and pick fields each time?
  Leaning: auto-create on first use, allow override.
- **Caching of audio downloads** - clipping per-card hits yt-dlp once per
  card. If the user mines 20 cards from one video, that's 20 downloads.
  Cache the full bestaudio file per `video_id` for the session? Worth doing
  in v1 since it's a one-line change.
- **Mobile fallback** - extension is desktop-browser only. iPad / phone YT
  users get nothing. Not in scope; future feature could be a web app.

---

## Files touched (summary)

New:
- `docs/youtube-integration.md` (this file)
- `extension/content/youtube.js`
- `extension/content/page-script.js`
- `extension/popup/index.html`, `popup.js`, `popup.css` (Phase 4)
- `scripts/fetch_binaries.py`
- `vendor/bin/.gitkeep` (binaries gitignored)

Modified:
- `extension/manifest.json` - `web_accessible_resources`, popup declaration
- `extension/content/content.js` - gate YT module load
- `extension/content/content.css` - sub bar styles, hide YT captions
- `extension/background/background.js` - pass-through for new actions
- `src/ws_server.py` - new action handlers, binary resolver
- `ImmersionSuite.spec` - include `vendor/bin` in PyInstaller bundle
- `build_windows.bat`, `build_linux.sh` - pre-build `fetch_binaries.py`
- `.gitignore` - `vendor/bin/`
