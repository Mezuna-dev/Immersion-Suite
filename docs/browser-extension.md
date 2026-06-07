# Browser Extension

The Immersion Suite browser extension brings the desktop app into Chrome and Firefox.
It has two parts: a **popup dictionary** that works on any webpage, and a **YouTube
immersion layer** that adds a subtitle bar, navigation, furigana, and one-click
sentence mining to the YouTube player.

The extension is a thin front end. The desktop app does all the real work (dictionary
lookups, furigana, screenshots, audio clips, and card creation) and the two talk to each
other over a local connection on your own machine. Nothing is sent to the internet.

> The extension is part of the Immersion Suite **open beta**. If something misbehaves,
> please [open an issue](https://github.com/Mezuna-dev/Immersion-Suite/issues).

---

## Requirements

- **The desktop app must be installed and running.** The extension connects to it to
  perform lookups and create cards; on its own it does nothing.
- Google Chrome (or another Chromium browser) or Mozilla Firefox.

---

## Installing the extension

The extension ships in the `extension/` folder of the project (and in the GitHub
releases). Load it as an unpacked / temporary add-on:

**Chrome / Edge**
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.

**Firefox**
1. Open `about:debugging` → **This Firefox**.
2. Click **Load Temporary Add-on** and select `extension/manifest.json`.

Make sure the desktop app is open. The extension connects automatically; no
configuration is needed.

---

## The popup dictionary

On any webpage, hold **Shift** and hover over Japanese text. A popup appears at the
cursor with:

- The word's reading and kanji form
- Part of speech and definitions
- Frequency and common-word tags
- Deinflection (it recognises conjugated forms and shows the dictionary word)

Move the mouse onto the popup to scroll long entries; release Shift or move away to
dismiss it. The popup is rendered in an isolated layer, so it never clashes with the
page's own styling.

---

## YouTube immersion

Open any video on `youtube.com/watch`. The extension replaces YouTube's captions with
its own subtitle bar and adds a small toolbar (hover the bar to reveal it).

**Look up words**
Shift-hover any word in the subtitle bar to open the same dictionary popup.

**Navigate the dialogue**
Jump between subtitle lines without hunting for the scrubber:

| Key | Button | Action |
|-----|--------|--------|
| `A` | ⏮ | Previous line |
| `S` | ↻ | Replay current line |
| `D` | ⏭ | Next line |

**Auto-pause** (⏸) pauses playback at the end of each line so you can read before
moving on.

**Furigana** (あ) toggles kana readings above the kanji in the subtitle bar.

**Sentence mining** (＋) turns the current line into a flashcard. It captures a
screenshot of the frame and an audio clip of the line, then lets you choose the deck,
card type, and which fields receive the sentence, image, and audio. The card is created
directly in the desktop app.

**Subtitle queue** (☰) opens a scrollable list of every line in the video in the right
column. Click a line to jump to it, or use the per-line ＋ to mine it.

**Timing offset** nudges subtitle timing earlier or later if a track is slightly out of
sync, using the buttons in the queue header.

### How subtitles are loaded

The extension tries the fastest source first and falls back automatically, so subtitles
keep working even when YouTube restricts its caption endpoint:

1. YouTube's own caption track (fast).
2. The desktop app fetches the track (reliable).
3. As a last resort, it mirrors the captions YouTube is currently drawing on screen.

---

## Privacy

Everything stays on your machine. The extension talks to the desktop app over a local
connection (`ws://127.0.0.1:8765`) and makes no external requests, has no accounts, and
collects no telemetry.

---

## Troubleshooting

**The popup says it can't connect.**
The desktop app isn't running, or it started after the page loaded. Open the app and try
again; the extension reconnects on the next lookup.

**Furigana won't turn on.**
Furigana needs the tokenizer that ships with the desktop app. If the toggle shows as
unavailable, restart the app. (When building from source, furigana depends on
`sudachipy` and `sudachidict-core` from `requirements.txt`.)

**A mined card has no audio.**
Audio clipping uses bundled media tools. Installed builds include them; if you run from
source, run `python scripts/fetch_binaries.py` so the app can find yt-dlp and ffmpeg.

---

## How it works (developer reference)

The extension's content scripts run in the page, and a background script owns a single
WebSocket to the desktop app. The desktop app's `src/ws_server.py` answers requests on a
background thread.

```
Browser                                   Desktop app (Python / PyQt6)
+----------------------------------+      +------------------------------+
|  content.js  - popup dictionary  |      |  ws_server.py                |
|  youtube.js  - YouTube layer     | <--> |   ws://127.0.0.1:8765        |
|  page-script.js - reads YT data  |  WS  |   dictionary / furigana /    |
|  background.js - owns the socket |      |   media / card creation      |
+----------------------------------+      +------------------------------+
```

Messages are JSON, each tagged with an `id` so concurrent requests route correctly.
The available actions:

| Action | Purpose |
|--------|---------|
| `lookup` | Dictionary lookup for a span of text |
| `tokenize` | Furigana tokenization (SudachiPy) |
| `get_decks` / `get_card_types` | Populate the mining form |
| `create_card_with_media` | Create a card with screenshot + audio clip |
| `get_youtube_subs` | Fetch a video's subtitle track via the desktop app |
| `ping` | Connection check |

Source lives in `extension/` (front end) and `src/ws_server.py` (back end).
