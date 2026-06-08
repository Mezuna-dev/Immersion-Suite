# Changelog

All notable changes to Immersion Suite are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project follows
[semantic versioning](https://semver.org/).

> Immersion Suite is currently in **open beta** - usable day to day, but still under
> active development. Bug reports and feedback are very welcome.

## [Unreleased]

Work in progress toward 1.4.0.

## [1.3.1] - 2026-06-08

A maintenance release focused on correct SRS scheduling, a useful menu bar, and
built-in update checking.

### Added
- **In-app updates** - the app checks GitHub for a newer version on startup (and on
  demand via **Help → Check for Updates**), shows the new version with its release
  notes, and can download and launch the installer for you. Can be turned off under
  **Settings → Updates**, and individual versions can be skipped.
- **Menu bar** - the top menu is now fully wired up: **File** (Import Deck, Export
  Backup, Open Data Folder, Exit), **Decks** (New Deck, New Card, Browse, Card Types),
  **View** (Dashboard / SRS / Immersion / Settings), and **Help** (Check for Updates,
  About, GitHub, Report a Bug), with keyboard shortcuts.

### Fixed
- **Lapses no longer inflate intervals.** Failing a review card (Again) now correctly
  resets it - interval drops to 1 day, ease is reduced, and the card enters relearning -
  instead of keeping (and growing) its pre-lapse interval. Previously, with relearning
  steps configured, forgetting a card could schedule it *further* out than before.
- **Hard / Good / Easy now schedule distinct intervals** on review cards (Hard shrinks
  the growth, Easy adds a bonus), and the button labels match what actually gets
  scheduled. Easy also graduates a new card further out than Good.
- **Ease is frozen during relearning** - it drops once when a card lapses and is no
  longer nudged again each time the card graduates out of relearning.

### Changed
- The About screen now shows the running version dynamically (no more stale number).

## [1.3.0] - 2026-06-07

The YouTube release: turn any YouTube video into an immersion + sentence-mining
session, right inside your normal browser.

### Added
- **Browser extension** for Chrome and Firefox: hold Shift and hover over Japanese text
  on any page for an instant popup dictionary (Jitendex, ~295k entries) with furigana,
  part of speech, frequency tags, and deinflection. Connects to the desktop app over a
  local connection with no external requests.
- **YouTube immersion layer** (in the same extension) - a custom subtitle bar over the
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
- **Immersion tracking and media library** - a built-in immersion timer with
  per-category tagging and manual logging, time totals and breakdowns filterable by
  day / week / month / year, and a media library for the anime, manga, and books you
  are working through (with MyAnimeList search).

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

## [1.2.0] - Anki subdecks and review improvements

### Added
- **Anki subdeck support:** decks with `::` hierarchy import as proper parent/child
  decks, and every card template per note is imported (each as its own card type with
  the correct front/back styles).
- **Deck hierarchy:** nested tree view with collapsible parents, hierarchical dropdowns,
  drag-and-drop to nest and reorder decks, a Parent Deck selector, and cascade delete.
- **Subdeck-aware review:** reviewing a parent processes its subdecks in order under a
  shared new-card budget; sibling cards (same note, different template) are spaced apart;
  stats, retention, heatmap, and the card browser aggregate across subdecks.
- **Review screen:** a live counter of remaining new / learning / review cards, dynamic
  queue interleaving, and mid-session resume.
- **Two-button review mode** (Again / Good).
- `{{^Field}}` negation conditionals in card templates.
- A configurable "next day starts at" hour for the review-day rollover.

### Changed
- Redesigned answer buttons (dark style with the colour in the text; Easy uses the accent).

## [1.1.0] - Card browser, rich editor, and settings overhaul

### Added
- **Card browser:** a searchable, paginated table to view, edit, and delete cards across
  decks, attach images and audio, and sort by created date, due date, interval, or front.
- **Rich-text card editor** (bold, italic, underline, strikethrough, highlight) with a
  formatting toolbar and a live card preview.
- **Settings overhaul:** consistent card-based panels, a configurable review shortcut and
  audio-autoplay toggle, app-wide SRS defaults, and a deck-deletion danger zone.
- **Official Windows installer** (`.exe`, built with PyInstaller + Inno Setup).

### Changed
- Performance: single aggregated deck-stats query (removes N+1), DocumentFragment batch
  rendering, event delegation, and lazy image loading in the card browser.

## [1.0.0] - First stable release

### Added
- SM-2 spaced repetition.
- Anki `.apkg` import (including the modern compressed format).
- Statistics dashboard with review heatmap and retention tracking.
- Customizable card types with front/back templates.
- Per-deck settings (new card limits, learning steps, study order).
- Media support (images and audio in cards).
- Data export and backup.
