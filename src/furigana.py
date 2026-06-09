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

# Morphemes that are never trackable words (punctuation, symbols, whitespace).
_INERT_POS = {'補助記号', '記号', '空白'}


def _is_verblike(m: dict) -> bool:
    """True if *m* heads a unit that carries its own inflection.

    Verbs / i-adjectives, plus three kinds of 助動詞:
      - verb-like auxiliaries ちゃう/じゃう/てる/でる (conj is a verb type 五段/
        下一段…, not 助動詞-XXX) — split off as their own unit (笑っ | ちゃった).
      - the copula だ/です (助動詞-ダ/助動詞-デス) — its own unit (元気 | です), but
        it still absorbs its own inflection so 大変+だっ+た → 大変 | だった,
        じゃ+ない → じゃない, rather than leaving だっ / じゃ stranded.
    """
    if m['pos0'] in ('動詞', '形容詞'):
        return True
    if m['pos0'] == '助動詞':
        c = m.get('conj', '')
        return (not c.startswith('助動詞-')) or c in ('助動詞-ダ', '助動詞-デス')
    return False


def _is_inflection(m: dict) -> bool:
    """True if *m* is a pure inflectional ending that stays glued to its
    verb/adjective stem (so 比べたくない / 食べました / 言って are one unit each):

      - 接続助詞 て/で (読ん+で), plus ～たり/～ながら/～つつ
      - the 補助形容詞 negation ない (比べたく+ない)
      - inflectional 助動詞 (助動詞-タ/マス/タイ/ナイ/ウ…)

    NOT the copula (助動詞-デス/助動詞-ダ → です/な/だ are their own units) and NOT
    verb-like auxiliaries (ちゃう), which start their own unit.
    """
    p0 = m['pos0']
    if p0 == '助詞':
        if m['surface'] in ('て', 'で'):
            return m.get('pos1') == '接続助詞'
        return m['surface'] in ('たり', 'だり', 'ながら', 'つつ')
    if p0 == '形容詞':
        return m.get('pos1') == '非自立可能' and m['lemma'] == 'ない'
    if p0 == '助動詞':
        c = m.get('conj', '')
        return c.startswith('助動詞-') and c not in ('助動詞-デス', '助動詞-ダ')
    return False


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
        pos0 = pos[0] if pos else ''
        pos1 = pos[1] if len(pos) > 1 else ''
        lemma = m.dictionary_form() or surface
        # UniDic gives some サ/ザ変 verbs a classical ～ずる lemma (感ずる, 信ずる,
        # 重んずる); normalise to the modern ～じる dictionary form so it matches
        # 感じる etc. in the known set.
        if pos0 == '動詞' and len(lemma) > 2 and lemma.endswith('ずる'):
            lemma = lemma[:-2] + 'じる'
        reading = _kata_to_hira(m.reading_form() or '')
        # Sudachi reads the 人 suffix as ニン even for nationalities (タイ人 →
        # タイニン); it should be じん unless counting people (3人 = さんにん).
        if surface == '人' and pos0 == '接尾辞' and reading == 'にん':
            prev = raw[-1] if raw else None
            prev_num = bool(prev) and (prev['pos1'] == '数詞' or prev['surface'].isdigit())
            if not prev_num:
                reading = 'じん'
        raw.append({
            'surface': surface,
            'reading': reading,
            'pos0': pos0,
            'pos1': pos1,
            'conj': pos[4] if len(pos) > 4 else '',
            'lemma': lemma,
            'norm': m.normalized_form() or surface,
        })

    # Word-unit chunking: each content word starts a unit and absorbs only
    # Morpheme-level chunking (matches the competitor): split at every boundary
    # EXCEPT a verb/i-adjective keeps its own inflection (比べたくない, 言って).
    # Prefixes (お), suffixes (人), copula (です/な) and particles (か) are each
    # their own trackable unit; auxiliary verbs (くれる) and ちゃう split off.
    def _emit(lemma, pos, norm, content, ruby, base):
        tokens.append({'lemma': lemma, 'pos': pos, 'norm': norm,
                       'content': content, 'ruby': ruby, 'base': base})

    tokens: list[dict] = []
    i, n = 0, len(raw)
    while i < n:
        cur = raw[i]
        nxt = raw[i + 1] if i + 1 < n else None

        # でも / では: Sudachi splits these compound particles into で + も/は; keep
        # them as one unit (matches the dictionary entry the popup stores).
        if (cur['pos0'] == '助詞' and cur['surface'] == 'で' and nxt is not None
                and nxt['pos0'] == '助詞' and nxt['surface'] in ('も', 'は')):
            surf = cur['surface'] + nxt['surface']
            ruby = (_align_token(cur['surface'], cur['reading'])
                    + _align_token(nxt['surface'], nxt['reading']))
            _emit(surf, '助詞', surf, True, ruby, surf)
            i += 2
            continue

        # Fixed ～いう expressions Sudachi over-splits: quotative って/と + 言う
        # (という / っていう) and demonstrative そう/こう/ああ + 言う (そういう /
        # こういう). One unit headed by 言う. (どういう is already a single 連体詞.)
        _iu_lead = ((cur['pos0'] == '助詞' and cur['surface'] in ('って', 'と'))
                    or (cur['pos0'] == '副詞' and cur['surface'] in ('そう', 'こう', 'ああ')))
        if (_iu_lead and nxt is not None and nxt['pos0'] == '動詞'
                and nxt['lemma'] in ('言う', 'いう')):
            ruby = (_align_token(cur['surface'], cur['reading'])
                    + _align_token(nxt['surface'], nxt['reading']))
            surf = cur['surface'] + nxt['surface']
            j = i + 2
            while j < n and _is_inflection(raw[j]):
                ruby += _align_token(raw[j]['surface'], raw[j]['reading'])
                surf += raw[j]['surface']
                j += 1
            _emit(nxt['lemma'], nxt['pos0'], nxt['norm'], True, ruby, surf)
            i = j
            continue

        # Verb / i-adjective / verb-like auxiliary: keep its inflection attached.
        if _is_verblike(cur):
            ruby = _align_token(cur['surface'], cur['reading'])
            j = i + 1
            while j < n and _is_inflection(raw[j]):
                ruby += _align_token(raw[j]['surface'], raw[j]['reading'])
                j += 1
            _emit(cur['lemma'], cur['pos0'], cur['norm'], True, ruby, cur['surface'])
            i = j
            continue

        # Every other morpheme is its own unit: nouns, 形状詞, prefixes (お),
        # suffixes (人), copula (です/な), particles, conjunctions. All trackable
        # except punctuation/symbols and bare numbers.
        is_num = cur['pos1'] == '数詞' or cur['surface'].isdigit()
        content = (cur['pos0'] not in _INERT_POS and not is_num
                   and _has_japanese(cur['surface']))
        _emit(cur['lemma'], cur['pos0'], cur['norm'], content,
              _align_token(cur['surface'], cur['reading']), cur['surface'])
        i += 1

    # Attach the full kana reading + plain surface of each chunk (used for
    # known-word matching and homograph keying). Plain tokens have no base.
    for t in tokens:
        t['surface'] = chunk_surface(t['ruby'])
        t['reading'] = chunk_reading(t['ruby'])
        t.setdefault('base', t['surface'])
        t.setdefault('norm', t['surface'])

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
            # Also key by the normalized form so a kanji-written card (言う,
            # 美味しい) matches a kana-written token (いう, おいしい) and vice versa.
            keys.add(m.normalized_form() or m.surface())
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
        base = t.get('base') or surface
        keys = (lemma, surface, base, t.get('norm') or surface)
        if any(k in ignored for k in keys):
            continue
        total += 1
        if any(k in known for k in keys):
            known_n += 1
        else:
            unknown_terms.append(lemma)

    unknown_n = total - known_n
    percent = round(known_n / total * 100, 1) if total else None
    return {'total': total, 'known': known_n, 'unknown': unknown_n,
            'percent': percent, 'unknown_terms': unknown_terms,
            'one_t': unknown_n == 1}
