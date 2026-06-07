#!/usr/bin/env python3
"""
Build the Jitendex SQLite dictionary database.

Run once (or to update the dictionary):

    python scripts/build_jitendex.py

Downloads the latest Jitendex Yomitan release from jitendex.org, parses its
term bank files, and writes  data/dicts/jitendex.sqlite.

Requirements: Python 3.10+, no extra packages.
"""

import io
import json
import re
import sqlite3
import sys
import urllib.request
import zipfile
from pathlib import Path

# ── Output path ───────────────────────────────────────────────────────────────
_PROJECT_ROOT = Path(__file__).resolve().parent.parent

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

DB_PATH = _BASE_DIR / 'data' / 'dicts' / 'jitendex.sqlite'

# Since v4.4, Jitendex is distributed via jitendex.org (hosted on the author's
# GitHub Pages repo).  This URL always resolves to the latest Yomitan zip.
_JITENDEX_URL = (
    'https://github.com/stephenmk/stephenmk.github.io'
    '/releases/latest/download/jitendex-yomitan.zip'
)
_HEADERS = {'User-Agent': 'ImmersionSuite/1.0'}

# ── Download ──────────────────────────────────────────────────────────────────

def _get_download_url() -> tuple[str, str]:
    """Return (resolved_url, filename) for the latest Jitendex Yomitan zip."""
    print('Resolving latest Jitendex URL...')
    req = urllib.request.Request(_JITENDEX_URL, headers=_HEADERS, method='HEAD')
    try:
        with urllib.request.urlopen(req) as r:
            final_url = r.url
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f'Could not reach Jitendex download ({e.code}: {e.reason}).\n'
            'Download manually from  https://jitendex.org/pages/downloads.html\n'
            'then run:  python scripts/build_jitendex.py --file <path/to/file.zip>'
        ) from e
    name = final_url.rstrip('/').split('/')[-1] or 'jitendex-yomitan.zip'
    print(f'  File: {name}')
    return final_url, name


def _download(url: str, name: str) -> zipfile.ZipFile:
    print(f'Downloading {name} ...')
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req) as r:
        raw = r.read()
    print(f'  {len(raw) / 1_048_576:.1f} MB downloaded.')
    return zipfile.ZipFile(io.BytesIO(raw))


# ── Structured-content parsing (Jitendex / Yomitan format) ───────────────────
# A definition is a tree shaped roughly like:
#
#   structured-content
#   └── sense-groups (ul)
#       └── sense-group (li)          ← shared POS + senses
#           ├── part-of-speech-info   ← e.g. "noun", "transitive"
#           └── sense (li)            ← one sense
#               └── glossary (ul)     ← <li> items = individual glosses
#
# Everything else (extra-info, examples, forms, attribution, cross-refs, etc.)
# is noise for popup purposes and is skipped.

# Markers whose entire subtree we ignore.
_SKIP_MARKERS = frozenset({
    'extra-info', 'example-sentence', 'example-sentence-a', 'example-sentence-b',
    'example-keyword', 'attribution', 'attribution-footnote',
    'forms', 'forms-label', 'forms-header-row', 'forms-row-senses',
    'forms-col-senses-row',
    'xref', 'xref-content', 'xref-glossary', 'reference-label',
    'antonym', 'antonym-content',
    'sense-note', 'sense-note-label', 'sense-note-content',
    'info-gloss', 'info-gloss-label', 'info-gloss-content',
    'lang-source', 'lang-source-label', 'lang-source-content', 'lang-source-wasei',
    'misc-info', 'dialect-info', 'field-info',
    'graphic', 'graphic-attribution',
})

# HTML tags whose subtree we ignore (furigana readings, superscripts).
_SKIP_TAGS = frozenset({'rt', 'rp', 'sup'})


def _marker(node) -> str | None:
    data = node.get('data') if isinstance(node, dict) else None
    return data.get('content') if isinstance(data, dict) else None


def _node_text(node) -> str:
    """Flatten a structured-content node to plain text, skipping non-gloss subtrees."""
    if node is None or isinstance(node, (int, float)):
        return ''
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return ''.join(_node_text(c) for c in node)
    if isinstance(node, dict):
        if node.get('tag') in _SKIP_TAGS:
            return ''
        if _marker(node) in _SKIP_MARKERS:
            return ''
        return _node_text(node.get('content'))
    return ''


def _collect_li_texts(node, out: list[str]) -> None:
    """Collect text of every <li> descendant, not descending into skipped subtrees."""
    if isinstance(node, list):
        for c in node:
            _collect_li_texts(c, out)
        return
    if not isinstance(node, dict):
        return
    if _marker(node) in _SKIP_MARKERS:
        return
    if node.get('tag') == 'li':
        text = _node_text(node.get('content')).strip()
        if text:
            out.append(text)
        return  # <li> is atomic - don't descend further
    content = node.get('content')
    if content is not None:
        _collect_li_texts(content, out)


# Markers whose subtree we do NOT descend into when collecting example sentences.
_NON_EXAMPLE_MARKERS = frozenset({
    'forms', 'forms-label', 'forms-header-row', 'forms-row-senses',
    'forms-col-senses-row', 'attribution', 'xref', 'xref-content',
    'xref-glossary', 'antonym', 'antonym-content', 'redirect-glossary',
})


def _find_marker_node(node, target):
    """Return first descendant dict with data.content == target, or None."""
    if isinstance(node, list):
        for c in node:
            r = _find_marker_node(c, target)
            if r is not None:
                return r
        return None
    if isinstance(node, dict):
        if _marker(node) == target:
            return node
        c = node.get('content')
        if c is not None:
            return _find_marker_node(c, target)
    return None


def _collect_tag(node, tag_name) -> list:
    """Return all descendants with the given HTML tag (in document order)."""
    out: list = []

    def walk(n):
        if isinstance(n, list):
            for c in n:
                walk(c)
        elif isinstance(n, dict):
            if n.get('tag') == tag_name:
                out.append(n)
            c = n.get('content')
            if c is not None:
                walk(c)

    walk(node)
    return out


def _append_token(out: list, s: str) -> None:
    """Append a plain-string token, merging with the previous if adjacent."""
    if not s:
        return
    if out and isinstance(out[-1], str):
        out[-1] += s
    else:
        out.append(s)


def _to_ruby_tokens(node) -> list:
    """Flatten content to a list of tokens - strings, or [base, rt] ruby pairs."""
    out: list = []

    def walk(n):
        if n is None:
            return
        if isinstance(n, str):
            _append_token(out, n)
            return
        if isinstance(n, list):
            for c in n:
                walk(c)
            return
        if not isinstance(n, dict):
            return
        tag = n.get('tag')
        if tag in _SKIP_TAGS:
            return
        if tag == 'ruby':
            base = ''
            rt = ''
            content = n.get('content')
            parts = content if isinstance(content, list) else [content]
            for p in parts:
                if isinstance(p, str):
                    base += p
                elif isinstance(p, dict) and p.get('tag') == 'rt':
                    rt += _node_text(p.get('content'))
                elif p is not None:
                    base += _node_text(p)
            if rt and base:
                out.append([base, rt])
            elif base:
                _append_token(out, base)
            return
        walk(n.get('content'))

    walk(node)
    return out


def _extract_examples(node, out: list) -> None:
    """Find every example-sentence block under *node* and append {ja, en} dicts."""
    if isinstance(node, list):
        for c in node:
            _extract_examples(c, out)
        return
    if not isinstance(node, dict):
        return
    marker = _marker(node)
    if marker == 'example-sentence':
        ja = _find_marker_node(node, 'example-sentence-a')
        en = _find_marker_node(node, 'example-sentence-b')
        ja_tokens = _to_ruby_tokens(ja.get('content')) if ja else []
        en_text = _node_text(en.get('content')).strip() if en else ''
        # Strip trailing "[1]"-style footnote numbers from the translation.
        en_text = re.sub(r'\s*\[\d+\]\s*$', '', en_text)
        if ja_tokens or en_text:
            out.append({'ja': ja_tokens, 'en': en_text})
        return
    if marker in _NON_EXAMPLE_MARKERS:
        return
    content = node.get('content')
    if content is not None:
        _extract_examples(content, out)


def _walk(node, senses: list[dict], pos_stack: list[str]) -> None:
    """Walk the definition tree, emitting one dict per <sense> into *senses*.

    *pos_stack* carries POS tags inherited from the enclosing <sense-group>.
    """
    if isinstance(node, list):
        for c in node:
            _walk(c, senses, pos_stack)
        return
    if not isinstance(node, dict):
        return

    marker = _marker(node)
    if marker in _SKIP_MARKERS:
        return

    content = node.get('content')

    if marker == 'part-of-speech-info':
        text = _node_text(content).strip()
        if text and text not in pos_stack:
            pos_stack.append(text)
        return

    if marker == 'sense-group':
        local_pos: list[str] = []
        _walk(content, senses, local_pos)
        return

    if marker == 'sense':
        glosses: list[str] = []
        _collect_li_texts(content, glosses)
        examples: list = []
        _extract_examples(content, examples)
        if glosses:
            senses.append({
                'pos': list(pos_stack),
                'glosses': glosses,
                'examples': examples,
            })
        return

    if marker in ('glossary', 'redirect-glossary'):
        # Glossary outside a wrapping <sense> (rare) - attach to current POS.
        glosses: list[str] = []
        _collect_li_texts(node, glosses)
        if glosses:
            senses.append({
                'pos': list(pos_stack),
                'glosses': glosses,
                'examples': [],
            })
        return

    if content is not None:
        _walk(content, senses, pos_stack)


def _extract_forms(definition_root) -> dict | None:
    """Pull the forms table out of a definition tree.

    Returns ``{'kanji': [str], 'readings': [{'text', 'priority'}]}`` or None.
    """
    forms_root = _find_marker_node(definition_root, 'forms')
    if forms_root is None:
        return None
    tables = _collect_tag(forms_root, 'table')
    if not tables:
        return None

    kanji: list[str] = []
    readings: list[dict] = []

    for row in _collect_tag(tables[0], 'tr'):
        ths = _collect_tag(row, 'th')
        tds = _collect_tag(row, 'td')
        if _marker(row) == 'forms-header-row':
            for th in ths:
                text = _node_text(th.get('content')).strip()
                if text:
                    kanji.append(text)
            continue
        if not ths:
            continue
        reading = _node_text(ths[0].get('content')).strip()
        if not reading:
            continue
        readings.append({'text': reading, 'priority': _form_priority(tds)})

    if not kanji and not readings:
        return None
    return {'kanji': kanji, 'readings': readings}


_FORM_PRIORITY_RANK = {'form-pri': 3, 'form-valid': 2}


def _form_priority(tds) -> str | None:
    """Return the highest-ranked form-class string among a row's <td> cells."""
    best: str | None = None
    best_rank = 0
    for td in tds:
        data = td.get('data') or {}
        cls = data.get('class') if isinstance(data, dict) else None
        if not cls:
            continue
        rank = _FORM_PRIORITY_RANK.get(cls, 1)
        if rank > best_rank:
            best_rank = rank
            best = cls
    return best


def _extract_senses(definitions: list, def_tags: str) -> list[dict]:
    """Build a senses list from a Yomitan definitions array."""
    senses: list[dict] = []

    for defn in definitions:
        if isinstance(defn, str):
            t = defn.strip()
            if t:
                senses.append({'pos': [], 'glosses': [t], 'examples': []})
        elif isinstance(defn, dict):
            root = defn.get('content') if defn.get('type') == 'structured-content' else defn
            _walk(root, senses, [])

    return senses


def _extract_entry_forms(definitions: list) -> dict | None:
    """Extract the forms table from the first structured definition with one."""
    for defn in definitions:
        if isinstance(defn, dict):
            root = defn.get('content') if defn.get('type') == 'structured-content' else defn
            forms = _extract_forms(root)
            if forms:
                return forms
    return None


# ── Entry-level tag extraction ───────────────────────────────────────────────
# Yomitan term_tags / def_tags contain JMdict priority & frequency markers.
# We map them to user-friendly labels with a category for colour coding.

_TAG_LABEL = {
    'P':     'common',
    'news1': 'news',   'news2': 'news',
    'ichi1': 'common', 'ichi2': 'common',
    'spec1': 'spec',   'spec2': 'spec',
    'gai1':  'loanword', 'gai2': 'loanword',
    '\u2605': 'common',
    # NBSP-joined tag from Jitendex's tag bank - a single label.
    'priority\u00a0form': 'priority form',
}
# nf01-nf48 are frequency bands (nf01 = top 500 words, nf02 = top 1000, …)
for _i in range(1, 49):
    _TAG_LABEL[f'nf{_i:02d}'] = f'top {_i * 500}'


def _parse_entry_tags(def_tags: str, term_tags: str, score: int) -> list[str]:
    """Return deduplicated, user-friendly tag list for an entry."""
    seen: set[str] = set()
    tags: list[str] = []

    # Yomitan joins multi-word tag names with NBSP so splitting on regular
    # spaces keeps them intact. str.split() would collapse NBSP too.
    raw_tokens = [
        t for s in (def_tags, term_tags)
        for t in re.split(r' +', s.strip()) if t
    ]

    for raw in raw_tokens:
        label = _TAG_LABEL.get(raw)
        if label and label not in seen:
            seen.add(label)
            tags.append(label)

    # High-score entries without any explicit tag still deserve a "common" flag.
    if score >= 50 and 'common' not in seen:
        tags.insert(0, 'common')

    return tags


# ── SQLite build ──────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE entry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    score         INTEGER NOT NULL DEFAULT 0,
    seq           INTEGER NOT NULL DEFAULT 0,
    kanji_json    TEXT NOT NULL DEFAULT '[]',
    reading_json  TEXT NOT NULL DEFAULT '[]',
    meanings_json TEXT NOT NULL DEFAULT '[]',
    tags_json     TEXT NOT NULL DEFAULT '[]',
    forms_json    TEXT NOT NULL DEFAULT 'null'
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
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX idx_kanji   ON kanji_form(kanji);
CREATE INDEX idx_reading ON reading_form(reading);
"""


def _build_sqlite(zf: zipfile.ZipFile, db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    con = sqlite3.connect(str(db_path))
    con.executescript(_SCHEMA)

    # Persist dictionary metadata (title, revision) for the popup footer.
    try:
        idx = json.loads(zf.read('index.json'))
    except (KeyError, json.JSONDecodeError):
        idx = {}
    for k in ('title', 'revision', 'author', 'url'):
        v = idx.get(k)
        if isinstance(v, str) and v:
            con.execute('INSERT INTO meta(key, value) VALUES(?, ?)', (k, v))
    con.commit()

    # Collect all term_bank_*.json names, sorted so we process them in order.
    bank_names = sorted(
        n for n in zf.namelist()
        if re.match(r'term_bank_\d+\.json', n.split('/')[-1])
    )

    if not bank_names:
        raise RuntimeError('No term_bank_*.json files found inside the zip.')

    total_entries = 0
    batch_e, batch_k, batch_r = [], [], []
    BATCH = 5000

    def flush():
        con.executemany(
            'INSERT INTO entry(score,seq,kanji_json,reading_json,meanings_json,tags_json,forms_json)'
            ' VALUES(?,?,?,?,?,?,?)',
            batch_e,
        )
        # Get the ids of the rows we just inserted
        first_id = con.execute('SELECT last_insert_rowid()').fetchone()[0] - len(batch_e) + 1
        for i, (bk, br) in enumerate(zip(batch_k, batch_r)):
            eid = first_id + i
            for k in bk:
                con.execute('INSERT OR IGNORE INTO kanji_form VALUES(?,?)', (eid, k))
            for r in br:
                con.execute('INSERT OR IGNORE INTO reading_form VALUES(?,?)', (eid, r))
        con.commit()
        batch_e.clear(); batch_k.clear(); batch_r.clear()

    print(f'Processing {len(bank_names)} term bank file(s) ...')

    for bank_name in bank_names:
        with zf.open(bank_name) as f:
            rows = json.loads(f.read())

        for row in rows:
            # Yomitan term bank row:
            # [term, reading, def_tags, rules, score, definitions, sequence, term_tags]
            if not isinstance(row, list) or len(row) < 6:
                continue

            term        = row[0] or ''
            reading     = row[1] or ''
            def_tags    = row[2] or ''
            score       = row[4] if len(row) > 4 and isinstance(row[4], (int, float)) else 0
            definitions = row[5] if isinstance(row[5], list) else []
            sequence    = row[6] if len(row) > 6 and isinstance(row[6], int) else 0
            term_tags   = row[7] if len(row) > 7 and isinstance(row[7], str) else ''

            if not term:
                continue

            # If reading is blank or same as term, treat term as kana-only.
            kanji_forms   = [term] if (reading and reading != term) else []
            reading_forms = [reading or term]

            senses = _extract_senses(definitions, def_tags)
            if not senses:
                continue

            entry_tags = _parse_entry_tags(def_tags, term_tags, int(score))
            forms = _extract_entry_forms(definitions)

            batch_e.append((
                int(score),
                sequence,
                json.dumps(kanji_forms,   ensure_ascii=False),
                json.dumps(reading_forms, ensure_ascii=False),
                json.dumps(senses,        ensure_ascii=False),
                json.dumps(entry_tags,    ensure_ascii=False),
                json.dumps(forms,         ensure_ascii=False),
            ))
            batch_k.append(kanji_forms)
            batch_r.append(reading_forms)
            total_entries += 1

            if len(batch_e) >= BATCH:
                flush()

        print(f'  {bank_name.split("/")[-1]} - {total_entries:,} entries so far')

    if batch_e:
        flush()

    print('Optimising (ANALYZE + VACUUM) ...')
    con.execute('ANALYZE')
    con.execute('VACUUM')
    con.close()

    size_mb = db_path.stat().st_size / 1_048_576
    print(f'\nDone!  {db_path}  ({size_mb:.1f} MB, {total_entries:,} entries)')


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description='Build Jitendex SQLite database.')
    parser.add_argument(
        '--file', metavar='PATH',
        help='Path to a locally downloaded Jitendex .zip instead of fetching from GitHub.',
    )
    args = parser.parse_args()

    print(f'Output: {DB_PATH}\n')

    if DB_PATH.exists():
        ans = input('jitendex.sqlite already exists. Re-build? [y/N] ').strip().lower()
        if ans != 'y':
            print('Aborted.')
            return

    try:
        if args.file:
            local_path = Path(args.file)
            if not local_path.exists():
                print(f'Error: file not found: {local_path}', file=sys.stderr)
                sys.exit(1)
            print(f'Using local file: {local_path}')
            zf = zipfile.ZipFile(str(local_path))
        else:
            url, name = _get_download_url()
            zf        = _download(url, name)

        _build_sqlite(zf, DB_PATH)
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
