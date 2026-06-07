#!/usr/bin/env python3
"""
Build the JMdict SQLite dictionary database.

Run this script once (or whenever you want to update the dictionary):

    python scripts/build_jmdict.py

It will:
  1. Fetch the latest jmdict-simplified English JSON release from GitHub.
  2. Parse it into a compact SQLite file at  data/dicts/jmdict.sqlite.

Requirements: Python 3.10+ with stdlib only (no extra packages needed).
Expected download size: ~10 MB compressed, ~50 MB uncompressed.
Expected output size:   ~35–45 MB SQLite.
"""

import io
import json
import sqlite3
import sys
import urllib.request
import zipfile
from pathlib import Path

# ── Locate project root and output path ───────────────────────────────────────
_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parent

# Mirror the BASE_DIR logic from database.py so the file lands in the right
# place whether we're running from source or a frozen build.
if getattr(sys, 'frozen', False):
    import os
    if sys.platform == 'win32':
        _BASE_DIR = Path(sys.executable).resolve().parent
    else:
        _xdg = os.environ.get('XDG_DATA_HOME', '')
        _BASE_DIR = (Path(_xdg) / 'ImmersionSuite' if _xdg
                     else Path.home() / '.local' / 'share' / 'ImmersionSuite')
else:
    _BASE_DIR = _PROJECT_ROOT

DB_PATH = _BASE_DIR / 'data' / 'dicts' / 'jmdict.sqlite'

GITHUB_API = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest'


# ── Download ──────────────────────────────────────────────────────────────────

def _get_download_url() -> tuple[str, str]:
    """Return (download_url, asset_name) for the latest jmdict-eng release."""
    print('Fetching latest release info from GitHub...')
    req = urllib.request.Request(GITHUB_API,
                                 headers={'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req) as r:
        release = json.loads(r.read())

    # Prefer the common-words-only variant (smaller) if available, otherwise
    # fall back to the full jmdict-eng build.
    for candidate in ('jmdict-eng-common', 'jmdict-eng'):
        for asset in release.get('assets', []):
            name = asset['name']
            if name.startswith(candidate) and name.endswith('.json.zip'):
                return asset['browser_download_url'], name

    raise RuntimeError(
        'Could not find a jmdict-eng*.json.zip asset in the latest release.\n'
        f'Assets available: {[a["name"] for a in release.get("assets", [])]}'
    )


def _download_and_decompress(url: str, name: str) -> dict:
    print(f'Downloading {name} ...')
    with urllib.request.urlopen(url) as r:
        raw = r.read()
    print(f'  Downloaded {len(raw) / 1_048_576:.1f} MB.')
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        # The zip contains a single JSON file with the same base name.
        json_name = next(n for n in zf.namelist() if n.endswith('.json'))
        data = zf.read(json_name)
    print(f'  Extracted {len(data) / 1_048_576:.1f} MB JSON.')
    return json.loads(data)


# ── Build SQLite ──────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE entry (
    id           INTEGER PRIMARY KEY,
    kanji_json   TEXT NOT NULL DEFAULT '[]',
    reading_json TEXT NOT NULL DEFAULT '[]',
    meanings_json TEXT NOT NULL DEFAULT '[]',
    tags_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE kanji_form (
    entry_id INTEGER NOT NULL,
    kanji    TEXT    NOT NULL,
    PRIMARY KEY (entry_id, kanji)
);

CREATE TABLE reading_form (
    entry_id INTEGER NOT NULL,
    reading  TEXT    NOT NULL,
    PRIMARY KEY (entry_id, reading)
);

CREATE INDEX idx_kanji   ON kanji_form(kanji);
CREATE INDEX idx_reading ON reading_form(reading);
"""


_JM_TAG_MAP = {
    'news1': 'news', 'news2': 'news',
    'ichi1': 'common', 'ichi2': 'common',
    'spec1': 'spec', 'spec2': 'spec',
    'gai1': 'loanword', 'gai2': 'loanword',
}
for _i in range(1, 49):
    _JM_TAG_MAP[f'nf{_i:02d}'] = f'top {_i * 500}'


def _jm_tag(raw: str) -> str | None:
    """Map a jmdict-simplified priority string to a display label."""
    return _JM_TAG_MAP.get(raw)


def _build_sqlite(jmdict: dict, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)

    if db_path.exists():
        db_path.unlink()

    con = sqlite3.connect(str(db_path))
    con.executescript(_SCHEMA)

    words = jmdict.get('words', [])
    print(f'Building SQLite with {len(words):,} entries ...')

    batch_entry   = []
    batch_kanji   = []
    batch_reading = []
    BATCH = 5000

    def _flush():
        con.executemany(
            'INSERT INTO entry VALUES (?, ?, ?, ?, ?)', batch_entry)
        con.executemany(
            'INSERT OR IGNORE INTO kanji_form VALUES (?, ?)', batch_kanji)
        con.executemany(
            'INSERT OR IGNORE INTO reading_form VALUES (?, ?)', batch_reading)
        con.commit()
        batch_entry.clear()
        batch_kanji.clear()
        batch_reading.clear()

    for i, word in enumerate(words):
        entry_id = int(word['id'])

        kanji_forms   = [k['text'] for k in word.get('kanji', [])]
        reading_forms = [r['text'] for r in word.get('kana',  [])]

        senses = []
        for sense in word.get('sense', []):
            pos     = sense.get('partOfSpeech', [])
            glosses = [g['text'] for g in sense.get('gloss', [])
                       if g.get('lang') == 'eng']
            if glosses:
                senses.append({'pos': pos, 'glosses': glosses})

        if not reading_forms or not senses:
            continue

        # jmdict-simplified stores priority info on kanji/kana entries.
        tags: list[str] = []
        _seen: set[str] = set()
        for k in word.get('kanji', []):
            for p in k.get('priorities', []):
                label = _jm_tag(p)
                if label and label not in _seen:
                    _seen.add(label)
                    tags.append(label)
        for r in word.get('kana', []):
            for p in r.get('priorities', []):
                label = _jm_tag(p)
                if label and label not in _seen:
                    _seen.add(label)
                    tags.append(label)

        batch_entry.append((
            entry_id,
            json.dumps(kanji_forms,   ensure_ascii=False),
            json.dumps(reading_forms, ensure_ascii=False),
            json.dumps(senses,        ensure_ascii=False),
            json.dumps(tags,          ensure_ascii=False),
        ))

        for k in kanji_forms:
            batch_kanji.append((entry_id, k))
        for r in reading_forms:
            batch_reading.append((entry_id, r))

        if len(batch_entry) >= BATCH:
            _flush()
            if (i + 1) % 50_000 == 0:
                print(f'  {i + 1:,} / {len(words):,}')

    if batch_entry:
        _flush()

    print('Optimising database (ANALYZE + VACUUM) ...')
    con.execute('ANALYZE')
    con.execute('VACUUM')
    con.close()

    size_mb = db_path.stat().st_size / 1_048_576
    print(f'\nDone!  {db_path}  ({size_mb:.1f} MB)')


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    print(f'Output path: {DB_PATH}\n')

    if DB_PATH.exists():
        answer = input('jmdict.sqlite already exists. Re-build? [y/N] ').strip().lower()
        if answer != 'y':
            print('Aborted.')
            return

    try:
        url, name = _get_download_url()
        jmdict    = _download_and_decompress(url, name)
        _build_sqlite(jmdict, DB_PATH)
    except KeyboardInterrupt:
        print('\nInterrupted.')
        if DB_PATH.exists():
            DB_PATH.unlink()
        sys.exit(1)
    except Exception as exc:
        print(f'\nError: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
