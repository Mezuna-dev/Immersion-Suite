# Changelog

All notable changes to Immersion Suite are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project follows
[semantic versioning](https://semver.org/).

> Immersion Suite is currently in **open beta** - usable day to day, but still under
> active development. Bug reports and feedback are very welcome.

## [1.4.0] - 2026-06-15

### Added
- **FSRS scheduling, switchable per deck.** Each deck can keep the classic SM-2
  scheduler or switch to **FSRS** — a modern algorithm that models every card's memory
  as a *stability* and *difficulty* and adapts intervals to a retention target you
  choose. Pick the algorithm in a deck's **Scheduler** settings; you can switch either
  way at any time. Turning FSRS on seeds each card's memory from its review history, and
  your SM-2 progress is preserved if you switch back. Set a **desired retention** (e.g.
  0.90), and once a deck has a few hundred reviews, **Optimize parameters** trains FSRS's
  21 weights on that deck's own history in the background. New decks follow the default
  scheduler and retention you set in Settings.
- **Word status tracking: known, learning, and ignored.** Every entry in the hover
  dictionary has status buttons — **○/✓** known, **学** learning (started studying,
  still counts as unknown), **⊘** ignored (excluded from scores) — kept in a list
  independent of your SRS deck. Tracking is per word unit (タイ人 marks タイ and 人
  separately), conjugated forms resolve to their dictionary form (食べた counts as
  食べる), and even particles and function words are trackable.
- **Comprehension scores on YouTube.** With word colouring on (語 toolbar button),
  unknown words get a purple underline and learning words an amber one (colours and
  which statuses show are configurable in the ⚙ appearance panel). Each subtitle
  line shows its **comprehension %** — highlighted when the line has exactly one
  unknown word (the i+1 sweet spot) — and the queue shows a **whole-video score** so
  you can judge a video's difficulty before committing. Words you already have
  cards for count as known automatically.
- **Whole-page furigana.** A button in the extension popup adds kana readings above
  the kanji on the page you're reading — any site, not just YouTube. Annotation is
  lazy (only text near the viewport is processed) and handles dynamically loaded
  content; toggle it off to restore the page exactly.
- **Review a card before it's saved.** Mining (＋) now opens an edit dialog first:
  every field of the card type as an editable input, prefilled where your template
  maps it, so you can fix a definition or add context before the card lands. A
  **＋ Add field** button extends the card type with a brand-new field on the spot.
  Prefer instant mining? Turn **Review before adding** off in the extension popup.
- **One-click mining with saved defaults.** The extension popup now has card-creation
  sections for both miners — default deck, card type, and field template for the
  hover dictionary and for YouTube sentence mining. With defaults saved (and review
  off), every ＋ creates the card instantly; Shift+click still opens the full panel.
  Two ready-made card types — **Pop-Dictionary** and **Sentence Mining** — ship with
  the app with fields matching the miners, so setup is one click.
- **Mine words from any web page.** The hover dictionary now has a **＋** button on
  each entry that creates a flashcard from the word's expression, reading,
  definition, and the **sentence it appeared in** — no more leaving the page. A **⚙**
  button picks the deck, card type, and field mapping. (Previously mining only
  worked on YouTube.)
- **Themes and dark mode.** Pick from five colour themes (Neon Violet — the classic
  look — plus Ocean, Emerald, Sunset, and Sakura) and a light/dark mode in
  **Settings → Appearance**, with live preview. The browser extension — hover
  dictionary, toolbar popup, and YouTube overlay accents — follows the app's
  appearance automatically. (Replaces the free-form accent colour picker; a custom
  accent migrates to the closest theme.)
- **Subtitle appearance panel.** A ⚙ cog on the YouTube subtitle bar: font family,
  size, weight, text colour, outline strength, and bar opacity, plus per-status
  underline colours for the word markers.
- **Card browser overhaul.** Filter by lifecycle status (Due Now / New / Learning /
  Young / Mature) and card type, select cards with checkboxes for **bulk move or
  delete**, see status badges and due dates that turn amber today / red overdue,
  and page through with a proper range indicator and per-page size choice.
- **Toolbar popup & options page.** Clicking the extension icon now shows whether
  the desktop app is connected and a settings panel: enable/disable the hover
  dictionary, choose the **lookup key** (Shift / Alt / Ctrl / hover-only), and set
  YouTube defaults (furigana, auto-pause, and audio pre/post-roll padding for
  mined clips). Settings apply live where possible.
- **Word pronunciation audio.** Every entry in the hover dictionary now has a **🔊**
  button that plays a native-speaker recording of the word. Clips are fetched
  through the desktop app and cached locally, so each word downloads once and
  replays instantly (and works offline afterwards); words with no recording show
  a muted 🔇 instead.

### Changed
- **No key needed on subtitles.** Hovering a word in the YouTube subtitle bar or
  the queue opens the dictionary popup directly — the lookup key is only needed
  elsewhere on the page.
- **Better defaults on YouTube.** Furigana, known-word colouring, and the subtitle
  queue are all on from the first video (each still toggleable).
- **More readable queue.** Subtitle queue text is larger, brighter, and set in a
  proper Japanese typeface, with more breathing room between lines.
- **More accurate word segmentation.** Subtitle colouring now splits text at the
  level learners actually track vocabulary (共感してくれて → 共感 | して | くれて),
  keeps a verb's conjugation with its stem (食べました is one unit), and handles
  prefixes (お元気), counters (三人 vs タイ人 readings), spelling variants
  (言う↔いう), and stacked conjugations (取り残されている → 取り残す).
- **Clearer activity heatmap.** The dashboard heatmap now adapts to the active
  theme and mode (no more near-black cells on the light theme), spreads its
  intensity levels wider, rings today, renders the due-cards forecast as washed,
  dash-outlined cells, and includes a Less→More legend.
- **About page rebuilt** around what you can do with the app — feature tiles and a
  three-step getting-started guide instead of a tech-stack list.

### Security
- **Browser-extension bridge now rejects web origins.** The desktop app's local
  WebSocket (`127.0.0.1:8765`) is reachable by any page the browser visits; it
  now refuses handshakes whose `Origin` isn't the extension's
  (`chrome-extension://` / `moz-extension://`), closing a drive-by vector where a
  website could create cards or trigger downloads.
- **Pairing token required.** Beyond the origin check, the bridge now requires a
  shared secret as the first message before any action runs, blocking other local
  extensions and processes. The token is generated on first run and shown in
  **Settings → Browser Extension**; paste it into the extension's options
  (**Pairing**) to connect. **Existing installs must pair once after updating.**

### Fixed
- **The review log now records every answer.** Learning and relearning step presses
  are logged too (previously only introductions, graduations and lapses were), so the
  review heatmap and counts reflect all of your reviewing — and FSRS has the complete
  history it needs to seed and optimize accurately.
- **Three SRS scheduling bugs.** Deleting a card mid-review could re-show the
  previously answered card and inflate the queue count; the learning queue's delete
  matched the wrong field; and Anki-imported cards that were mid-learning could jump
  straight to a multi-day interval on their first graduation.
- **Switching videos no longer leaves the previous video's subtitles in the
  queue.** YouTube's navigation data could lag behind the page; the extension now
  reads the fresh state, ignores stale announcements, and clears the bar and queue
  the moment you navigate.
- **The mining dialogs scroll properly.** Tall panels in the hover popup and the
  YouTube card panel scroll within themselves, and the page underneath no longer
  scrolls while the cursor is over them.
- **YouTube tabs no longer run a perpetual ~60fps loop.** The subtitle update
  loop now rests while the video is paused/ended and re-arms on play, seek, and
  cue load.
- **YouTube native keys work again.** Subtitle-offset keys (`,` `.` `<` `>` `0`)
  are only consumed while the immersion queue panel is open, so frame-step, speed,
  and seek shortcuts are unaffected during normal viewing. The on-screen −/+
  buttons still adjust the offset anytime.
- **Long audio clips no longer drop mid-download.** The extension keeps the MV3
  service worker alive with a periodic ping while a download/sub-fetch is in
  flight, preventing "Connection to Immersion Suite was lost" on 60-80s clips.
- **Lookups trigger on more characters.** The hover dictionary now recognises the
  iteration marks 々 〆 〇 and Supplementary-plane kanji (CJK Ext B+) as the first
  character of a hovered word.
- **Cleaner handling of a dropped connection.** If the bridge socket closes at the
  instant a request is sent, the extension now returns a normal error instead of
  an unhandled rejection.

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
