# Changelog

All notable changes to Immersion Suite are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project follows
[semantic versioning](https://semver.org/).

> Immersion Suite is currently in **open beta** - usable day to day, but still under
> active development. Bug reports and feedback are very welcome.

## [1.3.0] - 2026-06-07

The YouTube release: turn any YouTube video into an immersion + sentence-mining
session, right inside your normal browser.

### Added
- **YouTube immersion layer** (browser extension) - a custom subtitle bar over the
  player with Shift-hover word lookup, plus:
  - **Sub navigation** - previous / replay / next line, with **A / S / D** shortcuts.
  - **Auto-pause** at the end of each subtitle line, so you can read before moving on.
  - **Furigana toggle** - kana readings above kanji, powered by SudachiPy for accurate
    word segmentation.
  - **Sentence mining** - create a card from the current line with a **screenshot** and
    an **audio clip** of that line, mapped to the deck, card type, and fields you choose.
  - **Subtitle queue** - a scrollable cue list in the right column: click a
    line to jump to it, mine any line, with the active line highlighted as it plays.
  - **Subtitle timing offset** - nudge subtitle timing to dial out any drift.
  - **Resilient captions** - direct fetch → desktop yt-dlp fetch → live on-screen mirror,
    so subtitles still load even when YouTube gates its caption endpoint.
- **Bundled media tools** - yt-dlp and ffmpeg now ship with the app, so YouTube audio
  mining and subtitle fetching work out of the box with no manual setup.

### Changed
- **Refreshed UI** - gradient-fill buttons with a soft glow-lift and a springy press,
  squircle corners, and a cleaner, more distinct visual identity.
- The browser extension (popup dictionary **and** YouTube overlay) now shares the desktop
  app's purple palette for one consistent look across the whole product.
- Dictionary popup wording updated ("Hover" → "Popup").

### Build / internal
- New `scripts/fetch_binaries.py` downloads yt-dlp + ffmpeg into `vendor/bin/<platform>/`.
- PyInstaller spec now bundles SudachiPy + the Sudachi dictionary (furigana), the
  WebSocket backend, and the helper binaries.
- New WebSocket actions backing the above: `get_decks`, `get_card_types`,
  `create_card_with_media`, `tokenize`, `get_youtube_subs`.

## [1.2.0]

### Added
- **Browser extension** - hold **Shift** and hover over Japanese text on any webpage for an
  instant popup dictionary (Jitendex, ~295k entries), connected to the desktop app over a
  local WebSocket with no external requests.
- Documentation site.
- Two-button review mode; improved Jitendex ranking and database.

## [1.1.0]

### Added
- **Immersion tracking** - log books, shows, podcasts, visual novels, and more, with total
  time tracked per category.
- **Statistics dashboard** - full-year review heatmap, retention rings (young / mature /
  total), streaks, and daily averages.

## [1.0.0]

### Added
- Initial release: SM-2 spaced repetition with multiple decks, custom card types with
  HTML/CSS templates, configurable learning steps, and Anki (`.apkg`) import.
