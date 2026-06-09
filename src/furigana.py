"""Japanese sentence tokenization for furigana rendering.

Wraps SudachiPy. The tokenizer is loaded lazily on first use so the rest of
the app stays importable when sudachi isn't installed - `tokenize_sentence`
returns an `error` payload in that case which the WS handler forwards to the
client so the extension can disable its furigana toggle gracefully.
"""

from __future__ import annotations

import threading
from typing import Iterable

# Module-level singletons; built once and reused for every request.
_lock = threading.Lock()
_tokenizer = None
_split_mode = None
_init_error: str = ''
_initialized = False


_HIRA_LO, _HIRA_HI = 0x3041, 0x3096
_KATA_LO, _KATA_HI = 0x30A1, 0x30F6
_KATA_TO_HIRA_OFFSET = 0x60


def _is_kanji(ch: str) -> bool:
    cp = ord(ch)
    return (0x4E00 <= cp <= 0x9FFF) or (0x3400 <= cp <= 0x4DBF) or (0xF900 <= cp <= 0xFAFF)


def _is_kana(ch: str) -> bool:
    cp = ord(ch)
    return _HIRA_LO <= cp <= _HIRA_HI or _KATA_LO <= cp <= _KATA_HI or cp == 0x30FC  # ー


def _kata_to_hira(s: str) -> str:
    out = []
    for c in s:
        cp = ord(c)
        if _KATA_LO <= cp <= _KATA_HI:
            out.append(chr(cp - _KATA_TO_HIRA_OFFSET))
        else:
            out.append(c)
    return ''.join(out)


def _ensure_tokenizer() -> str:
    """Lazy-init the tokenizer. Returns '' on success or an error string."""
    global _tokenizer, _split_mode, _init_error, _initialized
    if _initialized:
        return _init_error

    with _lock:
        if _initialized:
            return _init_error
        try:
            from sudachipy import dictionary, tokenizer  # type: ignore
        except ImportError as exc:
            _init_error = (
                'SudachiPy not installed. Run: pip install sudachipy sudachidict-core '
                f'({exc})'
            )
            _initialized = True
            return _init_error

        try:
            _tokenizer = dictionary.Dictionary().create()
            # SplitMode.C = full-word segmentation (合成語 stays whole) - best
            # for surfacing the natural reading of compounds like 「天気」.
            _split_mode = tokenizer.Tokenizer.SplitMode.C
        except Exception as exc:  # noqa: BLE001 - initialization failure surfaces to UI
            _init_error = f'SudachiPy init failed: {type(exc).__name__}: {exc}'
        _initialized = True
        return _init_error


def tokenize_sentence(text: str) -> dict:
    """Return {tokens: [{text, reading}]} or {error: str, tokens: []}.

    Each token's `reading` is either '' (no ruby) or a hiragana string that
    should be rendered above `text` as a `<ruby><rt>` annotation.
    """
    if not text or not text.strip():
        return {'tokens': []}

    err = _ensure_tokenizer()
    if err:
        return {'error': err, 'tokens': []}

    try:
        morphemes = list(_tokenizer.tokenize(text, _split_mode))
    except Exception as exc:  # noqa: BLE001
        return {'error': f'tokenize failed: {exc}', 'tokens': []}

    out: list[dict] = []
    for m in morphemes:
        surface = m.surface()
        reading_kata = m.reading_form() or ''
        reading_hira = _kata_to_hira(reading_kata)
        out.extend(_align_token(surface, reading_hira))

    return {'tokens': _coalesce_plain(out)}


# Major POS categories not worth colouring as vocabulary.
_SKIP_POS = {'助詞', '助動詞', '補助記号', '記号', '空白', '接続詞'}

# Bound morphemes that attach to the preceding content word as its
# conjugation/derivation tail rather than starting a new vocab unit.
_TAIL_POS = {'助動詞', '接尾辞'}


def _is_tail(m: dict) -> bool:
    """True if morpheme *m* belongs to the preceding word's conjugation tail.

    Covers auxiliary 助動詞 (た, ない, ます…) and 接尾辞, plus a trailing て/で
    connective so a verb keeps its own te-form (して, くれて) as one unit.
    """
    if m['pos0'] in _TAIL_POS:
        return True
    return m['pos0'] == '助詞' and m['surface'] in ('て', 'で')


def _has_japanese(s: str) -> bool:
    return any(_is_kanji(c) or _is_kana(c) for c in s)


def analyze_sentence(text: str) -> dict:
    """Word-level analysis for known/unknown colouring.

    Returns {tokens: [{lemma, content, ruby: [{text, reading}]}]} where:
      - lemma   : dictionary (base) form, used to match the known-words set so
                  conjugated forms (食べた → 食べる) resolve correctly
      - content : True for content words worth colouring (not particles,
                  auxiliaries, punctuation, …)
      - ruby    : furigana segments for the surface (same shape as `tokenize`)
    """
    if not text or not text.strip():
        return {'tokens': []}

    err = _ensure_tokenizer()
    if err:
        return {'error': err, 'tokens': []}

    try:
        morphemes = list(_tokenizer.tokenize(text, _split_mode))
    except Exception as exc:  # noqa: BLE001
        return {'error': f'analyze failed: {exc}', 'tokens': []}

    # Flatten the morphemes first so the grouping pass below can look ahead
    # (Sudachi splits e.g. 共感してくれて into 共感 / し / て / くれ / て).
    raw: list[dict] = []
    for m in morphemes:
        surface = m.surface()
        if not surface:
            continue
        pos = m.part_of_speech()
        raw.append({
            'surface': surface,
            'reading': _kata_to_hira(m.reading_form() or ''),
            'pos0': pos[0] if pos else '',
            'lemma': m.dictionary_form() or surface,
        })

    # Word-unit chunking: each content word starts a unit and absorbs only
    # its OWN conjugation tail — auxiliary 助動詞 (た, ない, ます…), 接尾辞, and a
    # trailing て/で connective.  A following verb (even a bound auxiliary like
    # くれる/いる) begins a NEW unit, and standalone particles (を, が, は…) and
    # punctuation stay separate.  So 共感してくれて → 共感 | して | くれて.
    tokens: list[dict] = []
    i, n = 0, len(raw)
    while i < n:
        cur = raw[i]
        nxt = raw[i + 1] if i + 1 < n else None

        # Quotative って / と + 言う is the という / っていう expression. Sudachi
        # splits off the って/と as a particle, which would leave only いう
        # coloured; keep the whole thing as one unit headed by 言う.
        if (cur['pos0'] == '助詞' and cur['surface'] in ('って', 'と')
                and nxt is not None and nxt['pos0'] == '動詞'
                and nxt['lemma'] in ('言う', 'いう')):
            ruby = (_align_token(cur['surface'], cur['reading'])
                    + _align_token(nxt['surface'], nxt['reading']))
            j = i + 2
            while j < n and _is_tail(raw[j]):
                ruby += _align_token(raw[j]['surface'], raw[j]['reading'])
                j += 1
            tokens.append({
                'lemma': nxt['lemma'],
                'pos': nxt['pos0'],
                'content': True,
                'ruby': ruby,
            })
            i = j
            continue

        is_head = (cur['pos0'] not in _SKIP_POS
                   and cur['pos0'] not in _TAIL_POS
                   and _has_japanese(cur['surface']))
        if not is_head:
            # Particle / punctuation / stray tail → its own plain token.
            tokens.append({
                'lemma': cur['lemma'],
                'pos': cur['pos0'],
                'content': False,
                'ruby': _align_token(cur['surface'], cur['reading']),
            })
            i += 1
            continue

        ruby = _align_token(cur['surface'], cur['reading'])
        j = i + 1
        while j < n and _is_tail(raw[j]):
            ruby += _align_token(raw[j]['surface'], raw[j]['reading'])
            j += 1
        tokens.append({
            'lemma': cur['lemma'],
            'pos': cur['pos0'],
            'content': True,
            'ruby': ruby,
        })
        i = j

    # Attach the full kana reading + plain surface of each chunk (used for
    # known-word matching and homograph keying).
    for t in tokens:
        t['surface'] = chunk_surface(t['ruby'])
        t['reading'] = chunk_reading(t['ruby'])

    return {'tokens': tokens}


def _align_token(surface: str, reading: str) -> list[dict]:
    """Split a single morpheme into [(kanji_run, reading), (kana_run, '')] pairs.

    Walks the surface alongside the (hiragana-normalized) reading. Kanji runs
    get the corresponding slice of the reading; kana / punctuation / ASCII
    runs are emitted with reading=''. Falls back to one whole-token ruby on
    misalignment so we never lose information."""
    if not surface:
        return []

    # No reading available (punctuation, ASCII, English words sudachi can't
    # transliterate) → render plain.
    if not reading:
        return [{'text': surface, 'reading': ''}]

    surface_hira = _kata_to_hira(surface)

    # Reading matches surface (already in kana) → no ruby needed.
    if surface_hira == reading:
        return [{'text': surface, 'reading': ''}]

    segs: list[dict] = []
    i = 0  # index into surface
    j = 0  # index into reading

    while i < len(surface):
        if _is_kanji(surface[i]):
            # Extend the kanji run to its end.
            ki = i
            while i < len(surface) and _is_kanji(surface[i]):
                i += 1
            kanji_seg = surface[ki:i]

            # Find where this kanji run's reading ends - at the position of
            # the next surface kana in the reading (or end-of-reading if the
            # kanji run is the suffix of the token).
            if i < len(surface) and _is_kana(surface[i]):
                next_kana = surface_hira[i]
                # Search for the next kana from j+1 so a kanji can never map
                # to zero characters of reading.
                pos = reading.find(next_kana, j + 1)
                if pos < 0 or pos <= j:
                    return [{'text': surface, 'reading': reading}]
                segs.append({'text': kanji_seg, 'reading': reading[j:pos]})
                j = pos
            else:
                # Kanji run is at the very end (or followed by non-kana like
                # punctuation in middle of a token - rare but possible).
                segs.append({'text': kanji_seg, 'reading': reading[j:]})
                j = len(reading)
        elif _is_kana(surface[i]):
            # Kana on the surface should match the same kana in the reading;
            # if not, we've lost alignment.
            if j >= len(reading) or surface_hira[i] != reading[j]:
                return [{'text': surface, 'reading': reading}]
            segs.append({'text': surface[i], 'reading': ''})
            i += 1
            j += 1
        else:
            # Punctuation / ASCII / digits inside a token. Don't consume the
            # reading - sudachi typically excludes these characters from the
            # reading_form, but if it does include them they'll just slip by.
            segs.append({'text': surface[i], 'reading': ''})
            i += 1

    return segs


def _coalesce_plain(segs: Iterable[dict]) -> list[dict]:
    """Merge consecutive reading-less segments so the rendered DOM stays small."""
    out: list[dict] = []
    for s in segs:
        if s['reading'] == '' and out and out[-1]['reading'] == '':
            out[-1] = {'text': out[-1]['text'] + s['text'], 'reading': ''}
        else:
            out.append(s)
    return out


# ── Known-word / comprehension helpers ───────────────────────────────────────

def chunk_surface(ruby: list[dict]) -> str:
    """Plain surface text of an analyze chunk (the visible word)."""
    return ''.join(seg.get('text', '') for seg in ruby)


def chunk_reading(ruby: list[dict]) -> str:
    """Full kana reading of an analyze chunk (reading for kanji runs, text else)."""
    return ''.join(seg.get('reading') or seg.get('text', '') for seg in ruby)


def expand_card_words(words: Iterable[str]) -> set:
    """Turn raw card expressions into known-set keys.

    A single-word card contributes its surface + dictionary lemma (so a 食べる
    card matches the chunk 食べて). A multi-token (sentence) card contributes only
    its raw string, which won't match individual tokens - sentence cards
    therefore don't over-credit every word they contain.
    """
    err = _ensure_tokenizer()
    keys: set = set()
    for w in words:
        w = (w or '').strip()
        if not w:
            continue
        keys.add(w)
        if err:
            continue
        try:
            morphs = [m for m in _tokenizer.tokenize(w, _split_mode) if m.surface().strip()]
        except Exception:  # noqa: BLE001
            continue
        content = [m for m in morphs
                   if (m.part_of_speech()[0] if m.part_of_speech() else '') not in _SKIP_POS]
        if len(content) == 1:
            m = content[0]
            keys.add(m.surface())
            keys.add(m.dictionary_form() or m.surface())
    return keys


def comprehension(text: str, known: set, ignored: set | None = None) -> dict:
    """Estimate comprehension of *text* against a *known* set.

    Counts content (scoreable) chunks only; 'ignored' chunks are dropped from
    both numerator and denominator. Returns coverage %, the unknown lemmas, and
    an i+1 flag (exactly one unknown word).
    """
    ignored = ignored or set()
    res = analyze_sentence(text)
    if res.get('error'):
        return {'error': res['error'], 'total': 0, 'known': 0, 'unknown': 0,
                'percent': None, 'unknown_terms': [], 'one_t': False}

    total = known_n = 0
    unknown_terms: list[str] = []
    for t in res.get('tokens', []):
        if not t.get('content'):
            continue
        surface = t.get('surface') or chunk_surface(t.get('ruby', []))
        lemma = t.get('lemma') or surface
        if lemma in ignored or surface in ignored:
            continue
        total += 1
        if lemma in known or surface in known:
            known_n += 1
        else:
            unknown_terms.append(lemma)

    unknown_n = total - known_n
    percent = round(known_n / total * 100, 1) if total else None
    return {'total': total, 'known': known_n, 'unknown': unknown_n,
            'percent': percent, 'unknown_terms': unknown_terms,
            'one_t': unknown_n == 1}
