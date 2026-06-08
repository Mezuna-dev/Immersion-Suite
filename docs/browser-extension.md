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

The extension is installed together with the desktop app. You load it into your
browser once, as an unpacked / temporary add-on.

**First, find the extension folder:**
- **Windows (installed):** open **Start Menu → Immersion Suite → "Browser Extension
  (load unpacked)"**, which opens the folder. It also lives in the `extension` folder
  inside the install directory.
- **Linux (installed):** `~/.local/share/ImmersionSuite/app/extension`
- **Building from source:** the `extension/` folder in the project.

**Chrome / Edge**
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the extension folder.

**Firefox**
1. Open `about:debugging` → **This Firefox**.
2. Click **Load Temporary Add-on** and select `manifest.json` in the extension folder.
   (Firefox clears temporary add-ons when it restarts, so you reload it the same way
   next session.)

### Pairing the extension with the app

For security, the desktop app only accepts connections from an extension that
presents a one-time **pairing token** (this stops other websites or programs on your
machine from reaching the app). You pair once:

1. In the desktop app, open **Settings → Browser Extension** and click **Copy**.
2. Click the extension's toolbar icon to open its popup, find the **Pairing**
   section, paste the token, and click **Save**.

The status badge at the top of the popup turns to **Connected**. If it shows **Not
authorized**, the token is missing or wrong — re-copy it from the app. If it shows
**Not running**, start the desktop app. (Existing users updating from an earlier
version need to pair once after the update.)

---

## The popup dictionary

On any webpage, hold the **lookup key** (Shift by default) and hover over Japanese
text. A popup appears at the cursor with:

- The word's reading and kanji form
- Part of speech and definitions
- Frequency and common-word tags
- **Pitch accent** graph and downstep number (when a Yomitan pitch-accent
  dictionary is installed in `data/dicts/` — see the README)
- Deinflection (it recognises conjugated forms and shows the dictionary word)

Move the mouse onto the popup to scroll long entries; release the key or move away to
dismiss it. The popup is rendered in an isolated layer, so it never clashes with the
page's own styling.

**Mine a word** — each entry has a **＋** button that creates a flashcard from the
word (expression, reading, definition) plus the **sentence it appeared in**, so you
can mine while reading anything, not just YouTube. The first time, use the **⚙**
button to pick the deck, card type, and which fields receive each piece; after that
**＋** adds a card in one click.

**Options** — click the extension's toolbar icon to enable/disable the dictionary,
change the lookup key (Shift / Alt / Ctrl / hover-only), and set YouTube defaults
(furigana, auto-pause, audio padding).

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

## Where the dictionary can't reach

The popup finds the word under your cursor using the browser's "caret from point"
APIs. A few kinds of text are off-limits to a browser extension, so Shift-hover does
nothing there — it's a browser sandbox limit, not a bug or a connection problem:

- **Text inside iframes.** The dictionary currently runs only in the **top frame** of
  a page, so text inside any embedded frame isn't covered. Frames from *another* site
  (some embedded readers, players, and ad frames) are isolated by the browser and
  can't be read at all, even in principle.
- **Closed Shadow DOM.** Some sites build their UI inside a *closed* shadow root,
  which hides its text from the caret APIs. (Ordinary pages and open shadow roots
  work fine.)
- **Text that isn't selectable text.** Words painted onto a `<canvas>`, baked into
  images, shown in the browser's built-in PDF viewer, or rendered by DRM video
  players aren't real page text and can't be looked up.

If a site mostly works but one region never triggers a lookup, it's usually one of
the above.

### Developer notes (future work)

- **Same-origin iframes:** add `"all_frames": true` to the `content/content.js` entry
  in `manifest.json`. Each frame then injects its own popup instance — verify
  positioning across frame boundaries and that the YouTube layer (`youtube.js`,
  matched to `*.youtube.com`) isn't double-injected into nested players.
- **Open shadow trees:** the composed-tree caret APIs (`getComposedRanges`, and
  `caretPositionFromPoint`'s `shadowRoots` option) may reach into open shadow roots
  more reliably as browser support matures; see `caretAt`/`getChunkAtPoint` in
  `content.js`.
- **Cross-origin frames** can't be bridged from a content script; the browser injects
  per-frame, but their text can never be merged into a single parent-page popup.

---

## Privacy

Everything stays on your machine. The extension talks to the desktop app over a local
connection (`ws://127.0.0.1:8765`) and makes no external requests, has no accounts, and
collects no telemetry.

---

## Troubleshooting

**The popup says it can't connect / "Not running".**
The desktop app isn't running, or it started after the page loaded. Open the app and try
again; the extension reconnects on the next lookup.

**The popup says "Not authorized".**
The pairing token is missing or doesn't match. Open the desktop app's **Settings →
Browser Extension**, click **Copy**, then paste it into the extension popup's
**Pairing** field and **Save**. See [Pairing the extension with the app](#pairing-the-extension-with-the-app).

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

The server checks the connection's `Origin` (only the extension's own origin is
allowed, never websites) and then requires `{action:'auth', token}` as the first
message before any other action runs; the token is generated on first run and stored
in `data/ws_token.txt`. After that, messages are JSON, each tagged with an `id` so
concurrent requests route correctly. The available actions:

| Action | Purpose |
|--------|---------|
| `auth` | Present the pairing token (required first message) |
| `lookup` | Dictionary lookup for a span of text |
| `tokenize` | Furigana tokenization (SudachiPy) |
| `get_decks` / `get_card_types` | Populate the mining form |
| `create_card` | Create a text-only card (popup mining) |
| `create_card_with_media` | Create a card with screenshot + audio clip |
| `get_youtube_subs` | Fetch a video's subtitle track via the desktop app |
| `ping` | Connection check |

Source lives in `extension/` (front end) and `src/ws_server.py` (back end).
