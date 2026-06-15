import sqlite3
import zipfile
from pathlib import Path
import json
import re
import io
import database
import shutil
import zstandard as zstd
from datetime import date, timedelta, datetime


# ===========================================================
# Section: Extraction
# ===========================================================

def extract_apkg(apkg_path):
    BASE_DIR = Path(__file__).resolve().parent.parent
    import_path = BASE_DIR / "imported"

    if import_path.exists():
        shutil.rmtree(import_path)

    import_path.mkdir(parents=True, exist_ok=True)

    apkg_file = Path(apkg_path)
    if not apkg_file.exists():
        print(f"Error: File {apkg_path} not found")
        return None, None

    with zipfile.ZipFile(apkg_path) as zip_apkg:
        zip_apkg.extractall(import_path)

    new_anki_file_type = import_path / "collection.anki21b"
    if new_anki_file_type.exists():
        with open(new_anki_file_type, 'rb') as compressed:
            dctx = zstd.ZstdDecompressor()
            with open(import_path / "collection", 'wb') as decompressed:
                dctx.copy_stream(compressed, decompressed)
        db_path = import_path / "collection"
        if db_path.exists():
            return db_path, import_path
    else:
        for db_name in ["collection.anki21", "collection.anki2"]:
            db_path = import_path / db_name
            if db_path.exists():
                return db_path, import_path

    print("Error: No Anki database found in package")
    return None, import_path


# ===========================================================
# Section: Media Import
# ===========================================================

ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'


def _copy_media_file(src: Path, dest: Path):
    """Copy src to dest, decompressing zstd if the file starts with the zstd magic bytes."""
    raw = src.read_bytes()
    if raw[:4] == ZSTD_MAGIC:
        dctx = zstd.ZstdDecompressor()
        with dctx.stream_reader(io.BytesIO(raw)) as reader:
            raw = reader.read()
    dest.write_bytes(raw)


def import_media(import_path, apkg_path=None):
    """Copy media files from extracted apkg to data/media/. Returns set of imported filenames."""
    dest_dir = database.BASE_DIR / 'data' / 'media'
    dest_dir.mkdir(parents=True, exist_ok=True)
    imported = set()
    log = []

    # ---- Diagnostic: zip entry list ----
    if apkg_path:
        try:
            with zipfile.ZipFile(apkg_path) as zf:
                entries = zf.infolist()
                log.append(f"ZIP entries ({len(entries)} total):")
                for e in entries:
                    log.append(f"  {e.filename!r}  size={e.file_size}")
        except Exception as ex:
            log.append(f"Could not read zip: {ex}")

    # ---- Diagnostic: extracted files ----
    extracted = list(import_path.iterdir())
    log.append(f"\nExtracted files in {import_path}:")
    for f in sorted(extracted):
        log.append(f"  {'DIR' if f.is_dir() else 'file':4s}  {f.name!r}")

    media_path = import_path / "media"

    # Case A: media/ is a directory - newer Anki variant
    if media_path.is_dir():
        log.append("\nmedia is a DIRECTORY - copying contents directly")
        for src in media_path.iterdir():
            log.append(f"  {src.name}")
            if src.is_file():
                _copy_media_file(src, dest_dir / src.name)
                imported.add(src.name)
        _write_media_log(log, imported)
        return imported

    # Case B: media is a JSON file
    media_map = {}
    if media_path.is_file():
        try:
            raw_bytes = media_path.read_bytes()
            log.append(f"\nmedia file size: {len(raw_bytes)} bytes")
            log.append(f"media file first 4 bytes: {raw_bytes[:4]!r}")
            # New Anki format: media manifest is also zstd-compressed (magic = \x28\xb5\x2f\xfd)
            # Use stream_reader (not decompress) because the frame may omit the content size header
            if raw_bytes[:4] == b'\x28\xb5\x2f\xfd':
                dctx = zstd.ZstdDecompressor()
                with dctx.stream_reader(io.BytesIO(raw_bytes)) as reader:
                    raw_bytes = reader.read()
                log.append("media file was zstd-compressed - decompressed successfully")
            try:
                raw = json.loads(raw_bytes.decode('utf-8'))
                if isinstance(raw, dict):
                    media_map = raw
                    log.append(f"media JSON parsed - {len(media_map)} entries")
                    for k, v in list(media_map.items())[:20]:
                        log.append(f"  {k!r}: {v!r}")
                    if len(media_map) > 20:
                        log.append(f"  ... ({len(media_map) - 20} more)")
                else:
                    log.append(f"media JSON is not a dict: {type(raw)}")
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as json_ex:
                log.append(f"media JSON parse failed ({json_ex}) - trying protobuf")
                try:
                    media_map = parse_media_manifest_proto(raw_bytes)
                    log.append(f"media manifest parsed as protobuf - {len(media_map)} entries")
                    for k, v in list(media_map.items())[:20]:
                        log.append(f"  {k!r}: {v!r}")
                    if len(media_map) > 20:
                        log.append(f"  ... ({len(media_map) - 20} more)")
                except Exception as proto_ex:
                    log.append(f"media protobuf parse error: {proto_ex}")
        except Exception as ex:
            log.append(f"media file read/decompress error: {ex}")
    else:
        log.append("\nNo 'media' file or directory found in extracted path")

    # Try copying based on map entries
    log.append("\nCopy attempts:")
    for key, val in media_map.items():
        # Old format: {"0": "audio.mp3"} - numeric key, filename value, stored as "0"
        # New format: {"audio.mp3": "sha256"} - filename key, hash value, stored as hash or filename
        candidates = []
        if key.isdigit():
            # Old format
            candidates = [(import_path / key, val if isinstance(val, str) else key)]
        else:
            # New format - file may be stored by hash (val) or by actual name (key)
            if isinstance(val, str) and val:
                candidates.append((import_path / val, key))   # stored as hash
            candidates.append((import_path / key, key))        # stored by actual name

        copied = False
        for src, dest_name in candidates:
            if src.is_file():
                _copy_media_file(src, dest_dir / dest_name)
                imported.add(dest_name)
                log.append(f"  COPIED {src.name!r} -> {dest_name!r}")
                copied = True
                break
        if not copied:
            tried = [str(c[0].name) for c in candidates]
            log.append(f"  MISS  key={key!r} val={val!r}  tried: {tried}")

    if imported:
        _write_media_log(log, imported)
        return imported

    # Fallback: copy files with known media extensions that aren't collection/meta files
    log.append("\nFallback: scanning for media-extension files")
    NON_MEDIA = {'collection.anki21b', 'collection.anki21', 'collection.anki2',
                 'collection', 'meta', 'media'}
    MEDIA_EXT = {'.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac',
                 '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
                 '.mp4', '.webm', '.ogv'}
    for src in import_path.iterdir():
        if src.is_file() and src.name not in NON_MEDIA and src.suffix.lower() in MEDIA_EXT:
            _copy_media_file(src, dest_dir / src.name)
            imported.add(src.name)
            log.append(f"  fallback copied {src.name!r}")

    _write_media_log(log, imported)
    return imported


def _write_media_log(log, imported):
    """Write media import diagnostic to data/media_import_debug.txt"""
    log.append(f"\nTotal imported: {len(imported)}")
    if imported:
        log.append("Files imported:")
        for f in sorted(imported):
            log.append(f"  {f}")
    try:
        debug_path = database.BASE_DIR / 'data' / 'media_import_debug.txt'
        debug_path.write_text('\n'.join(log), encoding='utf-8')
        print(f"[anki_importer] Media debug log written to: {debug_path}")
    except Exception as ex:
        print(f"[anki_importer] Could not write debug log: {ex}")


def convert_anki_media_refs(text):
    """
    Convert Anki field media references to our marker format.
    - <img src="filename.jpg">  →  [image:filename.jpg]
    - [sound:filename.mp3]      →  kept as-is (same format)
    """
    if not text:
        return text
    # Only convert bare filenames (no path separators or protocols)
    text = re.sub(
        r'<img\s[^>]*src="([^"\/\\:]+)"[^>]*\/?>',
        r'[image:\1]',
        text,
        flags=re.IGNORECASE
    )
    return text


# ===========================================================
# Section: Protobuf Parsing (for new Anki format)
# ===========================================================

def _parse_varint(data, pos):
    """Parse a protobuf varint from data at pos. Returns (value, new_pos)."""
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]; pos += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    return result, pos


def _parse_proto_message(data):
    """Parse protobuf message fields. Returns list of (field_num, wire_type, value)."""
    fields = []
    pos = 0
    try:
        while pos < len(data):
            tag, pos = _parse_varint(data, pos)
            if tag == 0:
                break
            field_num = tag >> 3
            wire_type = tag & 0x7

            if wire_type == 0:
                val, pos = _parse_varint(data, pos)
                fields.append((field_num, 0, val))
            elif wire_type == 1:
                if pos + 8 > len(data): break
                fields.append((field_num, 1, data[pos:pos + 8]))
                pos += 8
            elif wire_type == 2:
                length, pos = _parse_varint(data, pos)
                if pos + length > len(data): break
                val = bytes(data[pos:pos + length])
                pos += length
                fields.append((field_num, 2, val))
            elif wire_type == 5:
                if pos + 4 > len(data): break
                fields.append((field_num, 5, data[pos:pos + 4]))
                pos += 4
            else:
                break
    except Exception:
        pass
    return fields


def parse_media_manifest_proto(data):
    """
    Parse the new Anki media manifest protobuf into {zip_filename: actual_filename}.

    Structure:
      MediaEntries { repeated MediaEntry entries = 1; }
      MediaEntry   { string name = 1; bytes sha1 = 2; uint32 size = 3; bool deleted = 4; }

    The nth entry (0-indexed) in the repeated field corresponds to the zip file named str(n),
    matching the numeric filenames ('0', '1', '2', ...) extracted from the apkg.
    """
    result = {}
    entry_index = 0
    for field_num, wire_type, value in _parse_proto_message(data):
        if field_num == 1 and wire_type == 2:
            # Each field-1 LEN blob is a MediaEntry
            name = None
            deleted = False
            for ef_num, ef_wt, ef_val in _parse_proto_message(value):
                if ef_num == 1 and ef_wt == 2:       # string name
                    try:
                        name = ef_val.decode('utf-8')
                    except UnicodeDecodeError:
                        pass
                elif ef_num == 4 and ef_wt == 0:     # bool deleted
                    deleted = bool(ef_val)
            if name and not deleted:
                result[str(entry_index)] = name
            entry_index += 1
    return result


def extract_proto_strings(data):
    """
    Naively extract (field_number, string) pairs from a protobuf blob.
    Only handles top-level wire-type-2 (length-delimited) fields that
    decode cleanly as UTF-8. Used to pull qfmt/afmt/css from Anki configs.
    """
    results = []
    i = 0
    while i < len(data):
        b = data[i]
        field_num = b >> 3
        wire_type = b & 0x7
        i += 1

        if wire_type == 0:  # varint - skip
            while i < len(data) and (data[i] & 0x80):
                i += 1
            i += 1
        elif wire_type == 2:  # length-delimited (strings, bytes, embedded messages)
            length = 0
            shift = 0
            while i < len(data):
                b2 = data[i]; i += 1
                length |= (b2 & 0x7F) << shift
                shift += 7
                if not (b2 & 0x80):
                    break
            end = i + length
            if end <= len(data):
                try:
                    s = data[i:end].decode('utf-8')
                    results.append((field_num, s))
                except UnicodeDecodeError:
                    pass
            i = end
        elif wire_type == 1:  # 64-bit fixed
            i += 8
        elif wire_type == 5:  # 32-bit fixed
            i += 4
        else:
            break  # unknown wire type - stop

    return results


def get_template_formats(config_bytes):
    """
    Extract (qfmt, afmt) from a CardTemplateConfig protobuf blob.
    Anki proto: field 1 = q_format, field 2 = a_format.
    Falls back to heuristic string matching if field-specific extraction fails.
    """
    if not config_bytes:
        return '', ''
    strings = extract_proto_strings(bytes(config_bytes))
    qfmt = next((s for fnum, s in strings if fnum == 1), '')
    afmt = next((s for fnum, s in strings if fnum == 2), '')
    # Heuristic fallback: pick strings that look like Anki template syntax
    if not qfmt and not afmt:
        candidates = [s for _, s in strings if '{{' in s]
        qfmt = candidates[0] if len(candidates) >= 1 else ''
        afmt = candidates[1] if len(candidates) >= 2 else ''
    return qfmt, afmt


def get_css_from_config(config_bytes):
    """
    Extract CSS string from a NoteTypeConfig protobuf blob.
    Anki proto: field 4 = css.
    Falls back to heuristic if field-specific extraction fails.
    """
    if not config_bytes:
        return ''
    strings = extract_proto_strings(bytes(config_bytes))
    css = next((s for fnum, s in strings if fnum == 4), '')
    if not css:
        # Heuristic: any string that looks like CSS
        for _, s in strings:
            if '{' in s and ':' in s:
                css = s
                break
    return css


# ===========================================================
# Section: Note Type Parsing
# ===========================================================

def get_note_types_old(cur):
    """
    Parse note types from col.models JSON (old Anki format).
    Returns {anki_model_id: {name, fields, templates: [{qfmt, afmt}], css}}.
    """
    try:
        cur.execute("SELECT models FROM col")
        row = cur.fetchone()
        if not row or not row[0]:
            return {}
        models = json.loads(row[0])
    except Exception:
        return {}

    result = {}
    for mid_str, model in models.items():
        try:
            mid = int(mid_str)
        except (ValueError, TypeError):
            continue
        field_defs = sorted(model.get('flds', []), key=lambda x: x.get('ord', 0))
        fields = [f['name'] for f in field_defs]
        tmpls = model.get('tmpls', [])
        templates = []
        for tmpl in sorted(tmpls, key=lambda t: t.get('ord', 0)):
            templates.append({
                'name': tmpl.get('name', ''),
                'qfmt': tmpl.get('qfmt', ''),
                'afmt': tmpl.get('afmt', ''),
            })
        if not templates:
            templates = [{'name': '', 'qfmt': '', 'afmt': ''}]
        result[mid] = {
            'name': model.get('name', f'NoteType_{mid}'),
            'fields': fields if fields else ['Front', 'Back'],
            'templates': templates,
            'css': model.get('css', ''),
        }
    return result


def get_note_types_new(cur):
    """
    Parse note types from notetypes/fields/templates tables (new Anki format).
    Returns {anki_model_id: {name, fields, templates: [{qfmt, afmt}], css}}.
    """
    result = {}
    try:
        cur.execute("SELECT id, name, config FROM notetypes")
        nts = cur.fetchall()
    except Exception:
        return result

    for nt_id, nt_name, nt_config in nts:
        # Field names
        try:
            cur.execute("SELECT name FROM fields WHERE ntid = ? ORDER BY ord", (nt_id,))
            fields = [row[0] for row in cur.fetchall()]
        except Exception:
            fields = []

        # CSS from notetype config
        css = get_css_from_config(nt_config)

        # All templates, ordered by ord
        templates = []
        try:
            cur.execute("SELECT config FROM templates WHERE ntid = ? ORDER BY ord", (nt_id,))
            for tmpl_row in cur.fetchall():
                qfmt, afmt = get_template_formats(tmpl_row[0])
                templates.append({'name': '', 'qfmt': qfmt, 'afmt': afmt})
        except Exception:
            pass
        if not templates:
            templates = [{'name': '', 'qfmt': '', 'afmt': ''}]

        result[nt_id] = {
            'name': nt_name or f'NoteType_{nt_id}',
            'fields': fields if fields else ['Front', 'Back'],
            'templates': templates,
            'css': css,
        }

    return result


# ===========================================================
# Section: Debug Helper
# ===========================================================

def explore_anki_database(db_path):
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    for (table_name,) in cur.fetchall():
        print(f'\n{table_name}')
        cur.execute(f"PRAGMA table_info({table_name})")
        print(cur.fetchall())
        for row in cur.execute(f"SELECT * FROM {table_name} LIMIT 3"):
            print(row)
    con.close()


# ===========================================================
# Section: Scheduling
# ===========================================================

# Anki revlog ease → app rating  (1=Again, 2=Hard, 3=Good, 4=Easy)
_EASE_TO_RATING = {1: 1, 2: 3, 3: 4, 4: 5}


def _get_col_crt_date(cur):
    """
    Read the collection creation date from col.crt (Unix timestamp).
    Anki's review due values are day offsets from this date, NOT from a fixed epoch.
    Falls back to today if unavailable.
    """
    try:
        cur.execute("SELECT crt FROM col LIMIT 1")
        row = cur.fetchone()
        if row and row[0]:
            return datetime.fromtimestamp(row[0]).date()
    except Exception:
        pass
    return date.today()


def _anki_scheduling(anki_type, anki_queue, due, ivl, factor, reps, crt_date):
    """
    Convert Anki card scheduling fields to app Card fields.

    Anki card types:
      0 = New       queue 0
      1 = Learning  queue 1 (due = seconds timestamp) or 3 (due = day offset)
      2 = Review    queue 2  (due = days since crt_date)
      3 = Relearn   queue 1/3

    Returns a dict with keys: is_new, reps, ease_factor, interval, due_date, last_reviewed
    """
    if anki_type == 2 and anki_queue == 2:
        # Graduated review card - due is days since collection creation date
        ease = round(factor / 1000.0, 4) if factor else 2.5
        interval = ivl if ivl > 0 else 1
        due_date = (crt_date + timedelta(days=due)).strftime('%Y-%m-%d')
        last_reviewed = (crt_date + timedelta(days=due - interval)).strftime('%Y-%m-%d')
        return dict(is_new=False, reps=reps, ease_factor=ease,
                    interval=interval, due_date=due_date, last_reviewed=last_reviewed)

    if anki_type in (1, 3):
        # In learning or relearning - restart as a fresh new card so it surfaces
        # immediately. reps must be 0 (not Anki's count): a card with interval 0 but
        # reps>=1 would otherwise hit the graduating-interval shortcuts in the
        # scheduler (reps==1 -> 6 days) and jump far out on its first graduation.
        return dict(is_new=True, reps=0, ease_factor=2.5,
                    interval=0, due_date=None, last_reviewed=None)

    # New card (type 0) - default state
    return dict(is_new=True, reps=0, ease_factor=2.5,
                interval=0, due_date=None, last_reviewed=None)


# ===========================================================
# Section: Main Import Function
# ===========================================================

def import_anki_deck(apkg_path):
    db_path, import_path = extract_apkg(apkg_path)
    if not db_path or not db_path.exists():
        return None

    # --- Import media files ---
    import_media(import_path, apkg_path=apkg_path)

    con = sqlite3.connect(db_path)
    cur = con.cursor()

    # --- Detect format and load note types ---
    note_types = get_note_types_old(cur)
    if not note_types:
        note_types = get_note_types_new(cur)

    # --- Read collection creation date (base for all due-day offsets) ---
    crt_date = _get_col_crt_date(cur)

    # --- Create card types in our DB (one per Anki note type per template) ---
    # note_type_mapping: (anki_mid, ord) -> our card_type_id
    note_type_mapping = {}
    for anki_mid, nt in note_types.items():
        for tmpl_ord, tmpl in enumerate(nt['templates']):
            suffix = f' ({tmpl["name"]})' if tmpl.get('name') and len(nt['templates']) > 1 else ''
            if tmpl_ord > 0 and not suffix:
                suffix = f' (Card {tmpl_ord + 1})'
            ct_id = database.get_or_create_card_type(
                name=nt['name'] + suffix,
                fields=nt['fields'],
                front_style=tmpl['qfmt'],
                back_style=tmpl['afmt'],
                css_style=nt['css'],
            )
            note_type_mapping[(anki_mid, tmpl_ord)] = ct_id

    # --- Import decks (with subdeck hierarchy support) ---
    deck_id_mapping = {}  # anki_deck_id -> our deck_id

    s = database.get_app_settings()
    deck_kwargs = dict(
        new_cards_limit=s.get('default_new_cards_limit', 15),
        learning_steps=s.get('default_learning_steps', '1 10'),
        relearning_steps=s.get('default_relearning_steps', '10'),
        study_order=s.get('default_study_order', 'new_first'),
    )

    # Collect all raw deck entries: list of (anki_deck_id, full_name)
    raw_decks = []
    cur.execute("PRAGMA table_info(decks)")
    has_decks_table = len(cur.fetchall()) > 0

    if has_decks_table:
        cur.execute("SELECT id, name FROM decks WHERE id != 1")
        raw_decks = cur.fetchall()
    else:
        try:
            cur.execute("SELECT decks FROM col")
            row = cur.fetchone()
            if row:
                for deck_data in json.loads(row[0]).values():
                    anki_did = deck_data.get("id")
                    if anki_did and anki_did != 1:
                        raw_decks.append((anki_did, deck_data["name"]))
        except Exception:
            pass

    # Sort by name so parent decks are created before children
    raw_decks.sort(key=lambda x: x[1])

    # Track parent decks created by path prefix -> our_deck_id
    parent_path_map = {}  # "Parent::Child" -> our_deck_id

    for anki_did, full_name in raw_decks:
        parts = [p.strip() for p in full_name.split('::')]
        parent_id = None

        # Ensure all ancestor decks exist
        for i in range(len(parts) - 1):
            ancestor_path = '::'.join(parts[:i + 1])
            if ancestor_path not in parent_path_map:
                ancestor_parent_id = parent_path_map.get('::'.join(parts[:i])) if i > 0 else None
                parent_path_map[ancestor_path] = database.create_deck(
                    parts[i], parent_id=ancestor_parent_id, **deck_kwargs
                )
            parent_id = parent_path_map[ancestor_path]

        # Create the leaf deck
        leaf_name = parts[-1]
        full_path = '::'.join(parts)
        if full_path in parent_path_map:
            # This deck was already created as a parent for a deeper subdeck
            deck_id_mapping[anki_did] = parent_path_map[full_path]
        else:
            our_id = database.create_deck(leaf_name, parent_id=parent_id, **deck_kwargs)
            deck_id_mapping[anki_did] = our_id
            parent_path_map[full_path] = our_id

    # --- Import notes as cards ---
    cur.execute("SELECT id, flds, mid FROM notes")
    notes = cur.fetchall()

    # anki_card_id → our_card_id  (needed for revlog import)
    anki_cid_map = {}

    for note_id, flds, mid in notes:
        raw_fields = flds.split('\x1f')

        # Get field names for this note type
        nt = note_types.get(mid, {})
        field_names = nt.get('fields', [])

        # Build fields_json with converted media references
        fields_json = {}
        for i, value in enumerate(raw_fields):
            name = field_names[i] if i < len(field_names) else f'Field{i + 1}'
            fields_json[name] = convert_anki_media_refs(value)

        converted_values = list(fields_json.values())
        front = converted_values[0] if converted_values else ''
        back = ' / '.join(converted_values[1:]) if len(converted_values) > 1 else ''

        # Import ALL cards for this note (each card template / ord can be
        # in a different deck, which is common with subdecks).
        cur.execute(
            "SELECT id, did, ord, type, queue, due, ivl, factor, reps FROM cards WHERE nid = ? ORDER BY ord",
            (note_id,)
        )
        card_rows = cur.fetchall()
        if not card_rows:
            continue

        for card_row in card_rows:
            anki_cid, anki_did, card_ord, a_type, a_queue, a_due, a_ivl, a_factor, a_reps = card_row

            our_deck_id = deck_id_mapping.get(anki_did)
            if not our_deck_id:
                continue

            # Use the card type for this specific template ord, falling back to ord 0
            our_card_type_id = note_type_mapping.get((mid, card_ord)) or note_type_mapping.get((mid, 0))

            sched = _anki_scheduling(a_type, a_queue, a_due, a_ivl, a_factor, a_reps, crt_date)

            our_card_id = database.create_card(
                our_deck_id,
                front,
                back,
                card_type_id=our_card_type_id,
                fields_json=json.dumps(fields_json),
                reps=sched['reps'],
                ease_factor=sched['ease_factor'],
                interval=sched['interval'],
                due_date=sched['due_date'],
                is_new=sched['is_new'],
                last_reviewed=sched['last_reviewed'],
            )
            anki_cid_map[anki_cid] = our_card_id

    # --- Import review history from revlog ---
    try:
        cur.execute("SELECT id, cid, ease, ivl, factor FROM revlog ORDER BY id")
        revlog_rows = cur.fetchall()
        for rev_ts, anki_cid, ease, ivl, factor in revlog_rows:
            our_card_id = anki_cid_map.get(anki_cid)
            if not our_card_id:
                continue
            review_date = datetime.fromtimestamp(rev_ts / 1000).strftime('%Y-%m-%d')
            rating = _EASE_TO_RATING.get(ease, ease)
            interval_after = ivl if ivl > 0 else 0
            ease_after = round(factor / 1000.0, 4) if factor else 2.5
            database.import_review(our_card_id, review_date, rating, interval_after, ease_after)
    except Exception as ex:
        print(f"[anki_importer] revlog import error: {ex}")

    con.close()
    return deck_id_mapping
