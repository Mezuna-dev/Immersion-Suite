<div align="center">

<img src="docs/icon.png" width="100" height="100" alt="Immersion Suite" />

# Immersion Suite

**The all-in-one desktop toolkit for language immersion learners.**

Flashcards · Immersion tracking · Statistics · Popup dictionary · YouTube mining

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-aa00ff.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.1-aa00ff)](https://github.com/Mezuna-dev/Immersion-Suite/releases/latest)
[![Status](https://img.shields.io/badge/status-open%20beta-aa00ff)](https://github.com/Mezuna-dev/Immersion-Suite/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-aa00ff)](https://github.com/Mezuna-dev/Immersion-Suite/releases/latest)
[![Python](https://img.shields.io/badge/python-3.10%2B-aa00ff)](https://www.python.org/)

[**Download**](https://github.com/Mezuna-dev/Immersion-Suite/releases/latest) · [**Website**](https://mezuna-dev.github.io/Immersion-Suite/) · [**Report a Bug**](https://github.com/Mezuna-dev/Immersion-Suite/issues) · [**Request a Feature**](https://github.com/Mezuna-dev/Immersion-Suite/issues)

</div>

---

## What is Immersion Suite?

> 🧪 **Open beta** - Immersion Suite is stable enough for daily use and under active development. Expect the occasional rough edge, and please [report bugs or request features](https://github.com/Mezuna-dev/Immersion-Suite/issues).

Immersion Suite is a free, open-source desktop app built for learners who use the immersion method. It combines everything you need into one place including a full SM-2 based spaced-repetition system, an immersion log, detailed statistics, and a browser extension that adds a popup dictionary to any webpage plus a YouTube subtitle layer with sentence mining.

No subscriptions. No cloud. Everything runs on your machine.

---

## Features

### 🧠 Spaced Repetition (SRS)
- SM2 scheduling: cards surface exactly when you need them
- Multiple decks with independent settings
- Custom card types with HTML/CSS front & back templates
- Configurable learning and relearning steps
- Study order: new first, mixed, or new last
- Two-button or four-button review mode
- Keyboard shortcuts and audio autoplay

### 📦 Anki Import
- Import `.apkg` files directly from the File menu
- Supports both old and new (zstd-compressed) Anki formats
- Full import of note types, templates, CSS, media, and review history

### ⏱️ Immersion Tracking
- Log immersed content: books, shows, podcasts, visual novels, and more
- Track total time per category over time

### 📊 Statistics & Dashboard
- Full-year review activity heatmap
- Retention rings (young, mature, total)
- Retention stats filterable by day, week, month, or year
- Streak tracking and daily averages

### 🔍 Browser Extension
- Hold **Shift** and hover over any Japanese text in Chrome or Firefox
- Instant popup dictionary powered by [Jitendex](https://jitendex.org/) (~295k entries)
- Furigana, part-of-speech, frequency tags, pitch accent, and deinflection
- Connects to the desktop app over a local WebSocket with no external requests
- Works on any website

### 🎬 YouTube Immersion & Mining
- A clean subtitle bar over the YouTube player with Shift-hover word lookup
- Sub-line navigation (previous / replay / next) with **A / S / D** shortcuts
- Auto-pause at the end of each line so you can read before moving on
- One-click **furigana** toggle (accurate readings via SudachiPy)
- **Sentence mining** - turn the current line into a card with a screenshot and an
  audio clip, mapped to your deck, card type, and fields
- Subtitle queue (click to seek, mine any line) and a subtitle timing offset
- yt-dlp + ffmpeg bundled, so audio mining works out of the box

---

## Installation

### Windows

Download and run the installer from the [latest release](https://github.com/Mezuna-dev/Immersion-Suite/releases/latest):

```
ImmersionSuite_v1.3.1_Setup.exe
```

### Linux

Download the installer from the [latest release](https://github.com/Mezuna-dev/Immersion-Suite/releases/latest) and run:

```bash
bash ImmersionSuite_v1.3.1_Linux_x86_64.run
```

---

## Building from Source

**Requirements:** Python 3.10+

```bash
# 1. Clone the repo
git clone https://github.com/Mezuna-dev/Immersion-Suite.git
cd Immersion-Suite

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run
cd src
python gui.py
```

<details>
<summary>Optional: rebuild the Jitendex dictionary</summary>

The browser extension ships with a prebuilt `data/dicts/jitendex.sqlite`. To rebuild it from the latest upstream data:

```bash
python scripts/build_jitendex.py
```

This downloads the latest Jitendex release from jitendex.org and rebuilds the SQLite database (~103 MB, ~295k entries).

</details>

<details>
<summary>Optional: add pitch-accent or frequency dictionaries</summary>

The popup reads **Yomitan-format** frequency and pitch-accent dictionaries at runtime — just drop the `.zip` into `data/dicts/` (no rebuild needed). Any zip containing `term_meta_bank_*.json` files works; `freq` rows add frequency ranking and `pitch` rows add the pitch-accent graph shown above each entry's reading.

A frequency dictionary (JPDB) ships by default. For **pitch accent**, add a free Yomitan pitch dictionary such as the Kanjium-derived **"Kanjium Pitch Accents"** build. Mind redistribution licensing before bundling one in a release — the NHK accent dictionary, for example, is **not** freely redistributable.

</details>

<details>
<summary>Building a distributable installer</summary>

First fetch the bundled media tools (yt-dlp + ffmpeg) the YouTube features use. They
are downloaded into `vendor/bin/<platform>/` and bundled by the build:

```bash
python scripts/fetch_binaries.py
```

Then build for your platform:

- **Windows:** `build_windows.bat` (PyInstaller + Inno Setup → `installer/output/`)
- **Linux:** `bash build_linux.sh` (PyInstaller + makeself → `installer/output/`)

The build bundles SudachiPy and its dictionary (for furigana), so the frozen app works
without any extra setup. See [`CHANGELOG.md`](CHANGELOG.md) for release notes.

</details>

---

## Browser Extension

The browser extension (popup dictionary + YouTube tools) is **installed alongside the desktop app**. You load it into your browser once; after that it reconnects automatically.

> **Before you start:** open the Immersion Suite desktop app and leave it running. The extension talks to it and does nothing on its own.

### Step 1 - Find the extension folder

| How you installed | Where the folder is |
|---|---|
| **Windows installer** | Start Menu → **Immersion Suite → "Browser Extension (load unpacked)"** (this opens the folder). It also lives in the `extension` folder inside the install directory. |
| **Linux installer** | `~/.local/share/ImmersionSuite/app/extension` |
| **From source** | the `extension` folder in this repo |

### Step 2 - Load it into your browser

**Chrome / Edge / Brave**
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked**.
4. Select the extension folder from Step 1.

**Firefox**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the **`manifest.json`** file inside the extension folder.
   > Firefox removes temporary add-ons when it closes, so you reload it the same way next session.

### Step 3 - Use it

- Hold **Shift** and hover over Japanese text on any page for an instant definition.
- On YouTube, a subtitle bar appears with click-to-look-up, line navigation, furigana, and one-click sentence mining.

If a lookup ever says it can't connect, the desktop app isn't running - open it and try again.

---

## Project Structure

```
Immersion-Suite/
├── src/
│   ├── gui.py                  # Entry point and main window
│   ├── database.py             # SQLite database layer
│   ├── scheduler.py            # SM2 algorithm
│   ├── anki_importer.py        # .apkg import logic
│   ├── ws_server.py            # WebSocket server (extension bridge)
│   ├── furigana.py             # SudachiPy tokenizer (furigana)
│   ├── models.py               # Core data models
│   ├── dictionary/             # Dictionary backends + deinflection
│   └── widgets/                # PyQt6 widgets and URL scheme handler
├── extension/
│   ├── manifest.json           # MV3 manifest (Chrome + Firefox)
│   ├── background/             # Service worker / background page
│   └── content/                # content.js (popup) + youtube.js (overlay & mining)
├── web/
│   ├── pages/                  # HTML + JS frontend
│   ├── styles/                 # Bootstrap and custom CSS
│   └── fonts/                  # Bundled Inter font
├── data/
│   └── dicts/
│       └── jitendex.sqlite     # Prebuilt dictionary (built by scripts/)
├── scripts/
│   ├── build_jitendex.py       # Dictionary build script
│   └── fetch_binaries.py       # Downloads bundled yt-dlp + ffmpeg
├── vendor/
│   └── bin/                    # Bundled yt-dlp + ffmpeg (per platform)
└── docs/                       # GitHub Pages site + documentation
```

---

## Contributing

Issues and pull requests are welcome. If you're reporting a bug, please include your OS, app version, and steps to reproduce.

---

## License

GPL-3.0 - see [LICENSE](LICENSE).

Dictionary data: [Jitendex](https://jitendex.org/) (CC BY-SA 4.0), derived from [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) (CC BY-SA 4.0).
