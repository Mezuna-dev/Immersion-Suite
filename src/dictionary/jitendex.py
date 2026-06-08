import sqlite3
import json
import re
import sys
import os
import threading
import zipfile
from collections import OrderedDict
from pathlib import Path
from .base import DictionaryModule
from .deinflect import deinflect

if getattr(sys, 'frozen', False):
    if sys.platform == 'win32':
        _BASE_DIR = Path(sys.executable).resolve().parent
    else:
        _xdg = os.environ.get('XDG_DATA_HOME', '')
        _BASE_DIR = (Path(_xdg) / 'ImmersionSuite' if _xdg
                     else Path.home() / '.local' / 'share' / 'ImmersionSuite')
else:
    _BASE_DIR = Path(__file__).resolve().parent.parent.parent

# data/dicts can live in two places: the user/runtime dir (_BASE_DIR, where a
# user-rebuilt dictionary lands) and, in frozen builds, the copy bundled under
# PyInstaller's _MEIPASS. Prefer the user dir so a rebuild overrides the bundle.
def _dicts_dirs() -> list[Path]:
    dirs = [_BASE_DIR / 'data' / 'dicts']
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        dirs.append(Path(meipass) / 'data' / 'dicts')
    return dirs


def _resolve_db_path() -> Path:
    for d in _dicts_dirs():
        candidate = d / 'jitendex.sqlite'
        if candidate.exists():
            return candidate
    return _dicts_dirs()[0] / 'jitendex.sqlite'


DB_PATH: Path = _resolve_db_path()
_MAX_SCAN_LEN = 20
_CACHE_SIZE   = 256

_COLS = ("e.score, e.seq, e.kanji_json, e.reading_json, e.meanings_json, "
         "COALESCE(e.tags_json, '[]') AS tags_json, "
         "COALESCE(e.forms_json, 'null') AS forms_json")


def _load_freq_dicts() -> dict[str, int]:
    """Scan data/dicts/ for Yomitan frequency dictionaries and return a term→rank map.

    Any zip that contains term_meta_bank_*.json files is treated as a frequency
    dictionary. Multiple dicts are merged; the lowest (best) rank wins for each term.
    """
    freq: dict[str, int] = {}
    seen: set[str] = set()
    for dicts_dir in _dicts_dirs():
        if not dicts_dir.exists():
            continue
        for zip_path in sorted(dicts_dir.glob('*.zip')):
            if zip_path.name in seen:  # user dir wins over the bundled copy
                continue
            seen.add(zip_path.name)
            try:
                with zipfile.ZipFile(str(zip_path)) as zf:
                    bank_names = sorted(
                        n for n in zf.namelist()
                        if re.match(r'term_meta_bank_\d+\.json', n.split('/')[-1])
                    )
                    if not bank_names:
                        continue
                    for name in bank_names:
                        with zf.open(name) as f:
                            rows = json.loads(f.read())
                        for row in rows:
                            if not isinstance(row, list) or len(row) < 3 or row[1] != 'freq':
                                continue
                            term = row[0]
                            val  = row[2]
                            rank = val.get('value') if isinstance(val, dict) else val
                            if not isinstance(rank, (int, float)):
                                continue
                            rank = int(rank)
                            if term not in freq or rank < freq[term]:
                                freq[term] = rank
            except Exception:
                continue
    return freq


def _load_pitch_dicts() -> dict[str, list[dict]]:
    """Scan data/dicts/ for Yomitan pitch-accent dictionaries.

    Pitch dicts use the same term_meta_bank format as frequency dicts, but with
    'pitch' rows: [term, 'pitch', {reading, pitches:[{position:int, ...}]}].
    Returns term → [{'reading': str, 'positions': [int]}], merging duplicate
    readings and dicts. 'position' is the downstep mora index (0 = heiban).
    """
    pitch: dict[str, list[dict]] = {}
    seen: set[str] = set()
    for dicts_dir in _dicts_dirs():
        if not dicts_dir.exists():
            continue
        for zip_path in sorted(dicts_dir.glob('*.zip')):
            if zip_path.name in seen:  # user dir wins over the bundled copy
                continue
            seen.add(zip_path.name)
            try:
                with zipfile.ZipFile(str(zip_path)) as zf:
                    bank_names = sorted(
                        n for n in zf.namelist()
                        if re.match(r'term_meta_bank_\d+\.json', n.split('/')[-1])
                    )
                    if not bank_names:
                        continue
                    for name in bank_names:
                        with zf.open(name) as f:
                            rows = json.loads(f.read())
                        for row in rows:
                            if not isinstance(row, list) or len(row) < 3 or row[1] != 'pitch':
                                continue
                            term = row[0]
                            data = row[2]
                            if not isinstance(data, dict):
                                continue
                            reading = data.get('reading')
                            if not reading:
                                continue
                            positions = [
                                p['position'] for p in (data.get('pitches') or [])
                                if isinstance(p, dict) and isinstance(p.get('position'), int)
                            ]
                            if not positions:
                                continue
                            _add_pitch(pitch, term, reading, positions)
            except Exception:
                continue
    return pitch


def _add_pitch(pitch: dict[str, list[dict]], term: str, reading: str, positions: list[int]) -> None:
    bucket = pitch.setdefault(term, [])
    for existing in bucket:
        if existing['reading'] == reading:
            for p in positions:
                if p not in existing['positions']:
                    existing['positions'].append(p)
            return
    bucket.append({'reading': reading, 'positions': list(positions)})


def _attach_pitch(entries: list[dict], pitch: dict[str, list[dict]] | None) -> None:
    """Attach matching pitch-accent data to each entry in-place as entry['pitch'].

    A pitch record is kept only when its reading is one of the entry's own
    readings, so an ambiguous kanji doesn't pick up an unrelated reading's accent.
    """
    if not pitch:
        return
    for e in entries:
        readings = e.get('reading_forms') or []
        if not readings:
            continue
        reading_set = set(readings)
        terms = (e.get('kanji_forms') or []) + readings
        found: list[dict] = []
        seen: set[tuple] = set()
        for t in terms:
            for pa in pitch.get(t, []):
                if pa['reading'] not in reading_set:
                    continue
                key = (pa['reading'], tuple(pa['positions']))
                if key in seen:
                    continue
                seen.add(key)
                found.append({'reading': pa['reading'], 'positions': list(pa['positions'])})
        if found:
            e['pitch'] = found


class JitendexModule(DictionaryModule):
    """Jitendex Japanese-English dictionary backed by a local SQLite file.

    Build the file once by running  scripts/build_jitendex.py.
    """

    def __init__(self):
        self._source_cache: str | None = None
        self._con: sqlite3.Connection | None = None
        self._lock = threading.Lock()
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self._freq: dict[str, int] = _load_freq_dicts()
        self._pitch: dict[str, list[dict]] = _load_pitch_dicts()

    @property
    def name(self) -> str:
        return 'Jitendex (Japanese-English)'

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

    def _source_title(self, con: sqlite3.Connection) -> str | None:
        if self._source_cache is not None:
            return self._source_cache or None
        try:
            row = con.execute("SELECT value FROM meta WHERE key = 'title'").fetchone()
            self._source_cache = row['value'] if row else ''
        except sqlite3.Error:
            self._source_cache = ''
        return self._source_cache or None

    def lookup_text(self, text: str) -> dict:
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

        source = self._source_title(con)

        for length in range(min(len(text), _MAX_SCAN_LEN), 0, -1):
            word = text[:length]
            candidates = [(word, None)]
            for c in deinflect(word):
                candidates.append((c['word'], c['reason']))

            matched_reason, entries = _query_batch(candidates, con, self._freq)
            if entries:
                _attach_pitch(entries, self._pitch)
                result = {'matched': word, 'entries': entries}
                if matched_reason:
                    result['reason'] = matched_reason
                if source:
                    result['source'] = source
                return result

        return {'matched': None, 'entries': []}


def _is_japanese(ch: str) -> bool:
    c = ord(ch)
    return (
        0x3040 <= c <= 0x30FF or
        0x4E00 <= c <= 0x9FFF or
        0x3400 <= c <= 0x4DBF or
        0xFF65 <= c <= 0xFF9F
    )


def _trim_to_japanese(text: str) -> str:
    for i, ch in enumerate(text):
        if _is_japanese(ch):
            return text[i:]
    return ''


def _query_batch(
    candidates: list[tuple[str, str | None]],
    con: sqlite3.Connection,
    freq: dict[str, int] | None = None,
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
            ORDER BY score DESC, seq ASC, entry_id ASC
            LIMIT 80
            """,
            words + words,
        )
        rows = cur.fetchall()
    except sqlite3.Error:
        return None, []

    if not rows:
        return None, []

    # Pick the highest-priority candidate that actually got hits.
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
    entries = _merge_reading_variants(_parse_rows(winning_rows))
    _promote_matched_word(entries, best_word)
    return reason, _rank_entries(entries, freq)


def _promote_matched_word(entries: list[dict], matched_word: str) -> None:
    """Move matched_word to the front of kanji_forms and forms.kanji in-place.

    Jitendex's forms tables order kanji by dictionary priority (e.g. 元 before
    本 for the もと/origin sense). The actual searched form must appear first in
    both the headword (kanji_forms[0]) and the forms panel (forms.kanji[0]) so
    the popup consistently reflects what the user hovered over.
    """
    for e in entries:
        kf = e.get('kanji_forms', [])
        if matched_word in kf and kf[0] != matched_word:
            e['kanji_forms'] = [matched_word] + [k for k in kf if k != matched_word]
        forms = e.get('forms')
        if forms:
            fk = forms.get('kanji') or []
            if matched_word in fk and fk[0] != matched_word:
                forms['kanji'] = [matched_word] + [k for k in fk if k != matched_word]


def _rank_entries(entries: list[dict], freq: dict[str, int] | None = None) -> list[dict]:
    """Sort entries to match Yomitan's priority order.

    1. External frequency rank - lower rank = more common = first.
    2. JMdict score from the term bank.
    3. 'common' tag.
    4. nf frequency band embedded in tags ('top 500' → highest).
    Stable sort preserves sequence order within identical keys.

    Frequency lookup strategy: try kanji forms first (works for kanji-aware dicts
    like full JPDB).  For entries WITH kanji forms, never fall back to the kana
    reading - kana dicts assign one rank to ALL kanji that share a reading (e.g.
    もと covers 元/本/基/素), which contaminates ordering across unrelated words.
    Kana reading lookup is only used for kana-only entries where it is unambiguous.
    """
    def _key(entry: dict) -> tuple[int, int, int, int]:
        freq_rank = 9_999_999
        if freq:
            kanji = entry.get('kanji_forms') or []
            for k in kanji:
                r = freq.get(k, 9_999_999)
                if r < freq_rank:
                    freq_rank = r
            if freq_rank == 9_999_999 and not kanji:
                # Kana-only entry: reading is unambiguous, safe to use.
                for r in (entry.get('reading_forms') or []):
                    rank = freq.get(r, 9_999_999)
                    if rank < freq_rank:
                        freq_rank = rank
        raw_score = entry.get('score', 0)
        tags_lo = [t.lower() for t in (entry.get('tags') or [])]
        is_common = 1 if 'common' in tags_lo else 0
        freq_tag = 0
        for tag in tags_lo:
            if tag.startswith('top '):
                try:
                    freq_tag = 24500 - int(tag[4:])
                except ValueError:
                    pass
        return (-freq_rank, raw_score, is_common, freq_tag)

    return sorted(entries, key=_key, reverse=True)


def _parse_rows(rows) -> list[dict]:
    results: list[dict] = []
    for row in rows:
        try:
            results.append({
                'score':         row['score'],
                'seq':           row['seq'],
                'kanji_forms':   json.loads(row['kanji_json']    or '[]'),
                'reading_forms': json.loads(row['reading_json']  or '[]'),
                'senses':        json.loads(row['meanings_json'] or '[]'),
                'tags':          json.loads(row['tags_json']     or '[]'),
                'forms':         json.loads(row['forms_json']    or 'null'),
            })
        except (json.JSONDecodeError, IndexError):
            pass
    return results[:10]


def _merge_reading_variants(entries: list[dict]) -> list[dict]:
    """Merge rows belonging to the same JMdict entry.

    Jitendex exports one row per (term, reading) pair.  Rows sharing a sequence
    number are the same JMdict entry spelled differently; we consolidate them
    into one card so the popup doesn't show duplicates.

    Entries without a sequence number fall back to (kanji_forms, senses) keying.
    """
    by_seq: dict[int, dict] = {}
    by_key: dict[tuple, dict] = {}
    seq_order: list[int] = []
    key_order: list[tuple] = []

    for e in entries:
        seq = e.get('seq', 0)
        if seq:
            if seq in by_seq:
                existing = by_seq[seq]
                for k in (e.get('kanji_forms') or []):
                    if k not in existing['kanji_forms']:
                        existing['kanji_forms'].append(k)
                for r in (e.get('reading_forms') or []):
                    if r not in existing['reading_forms']:
                        existing['reading_forms'].append(r)
                # Keep the higher-scored row as the base; it contributes its tags.
                if e.get('score', 0) > existing.get('score', 0):
                    e['kanji_forms']   = existing['kanji_forms']
                    e['reading_forms'] = existing['reading_forms']
                    by_seq[seq] = e
            else:
                by_seq[seq] = e
                seq_order.append(seq)
        else:
            # Fallback: normalize via forms.kanji then key by (kanji, senses).
            forms = e.get('forms')
            if forms and forms.get('kanji'):
                e['kanji_forms'] = list(forms['kanji'])
            key = (
                json.dumps(e['kanji_forms'], ensure_ascii=False, sort_keys=True),
                json.dumps(e['senses'],      ensure_ascii=False, sort_keys=True),
            )
            if key in by_key:
                existing = by_key[key]
                for r in (e.get('reading_forms') or []):
                    if r not in existing['reading_forms']:
                        existing['reading_forms'].append(r)
                if len(e.get('tags') or []) > len(existing.get('tags') or []):
                    e['reading_forms'] = existing['reading_forms']
                    by_key[key] = e
            else:
                by_key[key] = e
                key_order.append(key)

    return [by_seq[s] for s in seq_order] + [by_key[k] for k in key_order]
