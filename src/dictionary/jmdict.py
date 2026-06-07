import sqlite3
import json
import sys
import os
import threading
from collections import OrderedDict
from pathlib import Path
from .base import DictionaryModule
from .deinflect import deinflect

# Resolve BASE_DIR the same way database.py does so the dict lives alongside
# the rest of the app data.
if getattr(sys, 'frozen', False):
    if sys.platform == 'win32':
        _BASE_DIR = Path(sys.executable).resolve().parent
    else:
        _xdg = os.environ.get('XDG_DATA_HOME', '')
        _BASE_DIR = (Path(_xdg) / 'ImmersionSuite' if _xdg
                     else Path.home() / '.local' / 'share' / 'ImmersionSuite')
else:
    _BASE_DIR = Path(__file__).resolve().parent.parent.parent

DB_PATH: Path = _BASE_DIR / 'data' / 'dicts' / 'jmdict.sqlite'

_MAX_SCAN_LEN = 20
_CACHE_SIZE   = 256

_COLS = ("e.kanji_json, e.reading_json, e.meanings_json, "
         "COALESCE(e.tags_json, '[]') AS tags_json")


class JMdictModule(DictionaryModule):
    """JMdict Japanese-English dictionary backed by a local SQLite file.

    The SQLite file is built by running ``scripts/build_jmdict.py`` once.
    If the file is missing, ``is_available`` returns False and lookups
    return an empty result rather than raising.
    """

    def __init__(self):
        self._con: sqlite3.Connection | None = None
        self._lock = threading.Lock()
        self._cache: OrderedDict[str, dict] = OrderedDict()

    @property
    def name(self) -> str:
        return 'JMdict (Japanese-English)'

    @property
    def language(self) -> str:
        return 'ja'

    @property
    def is_available(self) -> bool:
        return DB_PATH.exists()

    def _get_con(self) -> sqlite3.Connection | None:
        if self._con is not None:
            return self._con
        if not DB_PATH.exists():
            return None
        try:
            con = sqlite3.connect(str(DB_PATH), check_same_thread=False)
            con.row_factory = sqlite3.Row
            self._con = con
            return con
        except sqlite3.Error:
            return None

    def lookup_text(self, text: str) -> dict:
        """Longest-match scan with deinflection support."""
        text = _trim_to_japanese(text)
        if not text:
            return {'matched': None, 'entries': []}

        cached = self._cache.get(text)
        if cached is not None:
            self._cache.move_to_end(text)
            return cached

        with self._lock:
            cached = self._cache.get(text)
            if cached is not None:
                self._cache.move_to_end(text)
                return cached

            result = self._do_lookup(text)
            self._cache[text] = result
            if len(self._cache) > _CACHE_SIZE:
                self._cache.popitem(last=False)
            return result

    def _do_lookup(self, text: str) -> dict:
        con = self._get_con()
        if con is None:
            return {'matched': None, 'entries': []}

        for length in range(min(len(text), _MAX_SCAN_LEN), 0, -1):
            word = text[:length]
            candidates = [(word, None)]
            for c in deinflect(word):
                candidates.append((c['word'], c['reason']))

            matched_reason, entries = _query_batch(candidates, con)
            if entries:
                result = {'matched': word, 'entries': entries}
                if matched_reason:
                    result['reason'] = matched_reason
                return result

        return {'matched': None, 'entries': []}


# ── helpers ───────────────────────────────────────────────────────────────────

def _is_japanese(ch: str) -> bool:
    c = ord(ch)
    return (
        0x3040 <= c <= 0x30FF or   # Hiragana + Katakana
        0x4E00 <= c <= 0x9FFF or   # CJK unified ideographs (common)
        0x3400 <= c <= 0x4DBF or   # CJK Extension A
        0xFF65 <= c <= 0xFF9F      # Halfwidth Katakana
    )


def _trim_to_japanese(text: str) -> str:
    """Return text starting from its first Japanese character."""
    for i, ch in enumerate(text):
        if _is_japanese(ch):
            return text[i:]
    return ''


def _query_batch(
    candidates: list[tuple[str, str | None]],
    con: sqlite3.Connection,
) -> tuple[str | None, list[dict]]:
    """Look up every candidate form in a single SQL statement.

    Candidates are ordered by priority (exact match first, deinflections after).
    The winning candidate is the highest-priority one that returned any rows.
    Returns (reason_for_winner, entries). reason is None for exact matches.
    """
    if not candidates:
        return None, []

    words = [w for w, _ in candidates]
    placeholders = ','.join('?' * len(words))
    try:
        cur = con.cursor()
        cur.execute(
            f"""
            SELECT e.id AS entry_id, k.kanji AS matched_word, {_COLS}
            FROM entry e JOIN kanji_form k ON k.entry_id = e.id
            WHERE k.kanji IN ({placeholders})
            UNION
            SELECT e.id AS entry_id, r.reading AS matched_word, {_COLS}
            FROM entry e JOIN reading_form r ON r.entry_id = e.id
            WHERE r.reading IN ({placeholders})
            ORDER BY entry_id
            LIMIT 64
            """,
            words + words,
        )
        rows = cur.fetchall()
    except sqlite3.Error:
        return None, []

    if not rows:
        return None, []

    priority = {w: i for i, (w, _) in enumerate(candidates)}
    best_idx = len(candidates)
    best_word: str | None = None
    for row in rows:
        w = row['matched_word']
        idx = priority.get(w, len(candidates))
        if idx < best_idx:
            best_idx = idx
            best_word = w
            if idx == 0:
                break

    if best_word is None:
        return None, []

    winning_rows = [r for r in rows if r['matched_word'] == best_word]
    reason = candidates[best_idx][1]
    return reason, _rank_entries(_parse_rows(winning_rows))


def _entry_score(entry: dict) -> int:
    tags_lo = [t.lower() for t in (entry.get('tags') or [])]
    return 1 if 'common' in tags_lo else 0


def _rank_entries(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=_entry_score, reverse=True)


def _parse_rows(rows) -> list[dict]:
    results: list[dict] = []
    for row in rows:
        try:
            results.append({
                'kanji_forms':   json.loads(row['kanji_json']   or '[]'),
                'reading_forms': json.loads(row['reading_json'] or '[]'),
                'senses':        json.loads(row['meanings_json'] or '[]'),
                'tags':          json.loads(row['tags_json']    or '[]'),
            })
        except (json.JSONDecodeError, IndexError):
            pass
    return results[:8]
