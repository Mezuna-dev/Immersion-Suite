import asyncio
import base64
import json
import os
import shutil
import sys
import threading
import uuid
from pathlib import Path

import websockets
from websockets.server import serve

HOST = '127.0.0.1'
PORT = 8765

# Cap so a misbehaving caller can't fill the disk with a runaway clip.
MAX_CLIP_SECONDS = 30
# Cap on yt-dlp + ffmpeg runtime; the WS callsite uses 90s on its end.
MEDIA_TIMEOUT_SECONDS = 75


# ── Action dispatch ──────────────────────────────────────────────────────────

async def _handle(websocket):
    async for raw in websocket:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue

        action = msg.get('action')
        msg_id = msg.get('id', '')

        try:
            response = await _dispatch(action, msg)
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            response = {'error': f'{type(exc).__name__}: {exc}'}

        response['id'] = msg_id
        await websocket.send(json.dumps(response, ensure_ascii=False))


async def _dispatch(action, msg):
    if action == 'ping':
        return {'action': 'pong'}

    loop = asyncio.get_running_loop()

    if action == 'lookup':
        text = msg.get('text', '')
        if not text:
            return {'matched': None, 'entries': []}
        return await loop.run_in_executor(None, _lookup, text)

    if action == 'get_decks':
        return await loop.run_in_executor(None, _get_decks)

    if action == 'get_card_types':
        return await loop.run_in_executor(None, _get_card_types)

    if action == 'create_card_with_media':
        return await loop.run_in_executor(None, _create_card_with_media, msg)

    if action == 'tokenize':
        text = msg.get('text', '')
        return await loop.run_in_executor(None, _tokenize, text)

    return {'error': f'unknown action: {action}'}


def _tokenize(text: str) -> dict:
    from furigana import tokenize_sentence
    return tokenize_sentence(text)


# ── Lookup (existing) ────────────────────────────────────────────────────────

def _lookup(text: str) -> dict:
    from dictionary.handler import get_dict_module
    module = get_dict_module()
    if not module.is_available:
        return {
            'error': 'Dictionary not available. Run scripts/build_jitendex.py to set it up.',
            'matched': None,
            'entries': [],
        }
    return module.lookup_text(text)


# ── Decks + card types ───────────────────────────────────────────────────────

def _get_decks() -> dict:
    import database
    decks = database.get_all_decks()
    return {
        'decks': [
            {
                'id': d.id,
                'name': d.name,
                'parent_id': d.parent_id,
            }
            for d in decks
        ],
    }


def _get_card_types() -> dict:
    import database
    types = database.get_all_card_types()
    return {
        'card_types': [
            {
                'id': t.id,
                'name': t.name,
                'fields': t.fields,
                'is_default': bool(t.is_default),
            }
            for t in types
        ],
    }


# ── Card creation with media ─────────────────────────────────────────────────

def _create_card_with_media(msg: dict) -> dict:
    import database

    video_url   = msg.get('video_url') or ''
    sentence    = (msg.get('sentence') or '').strip()
    image_b64   = msg.get('image_b64') or ''
    deck_id     = msg.get('deck_id')
    type_id     = msg.get('card_type_id')
    field_map   = msg.get('field_map') or {}
    start_ms    = int(msg.get('start_ms') or 0)
    end_ms      = int(msg.get('end_ms') or 0)

    if not deck_id or not type_id:
        return {'error': 'deck_id and card_type_id are required'}
    if not sentence:
        return {'error': 'sentence is empty'}

    media_dir = _media_dir()
    media_dir.mkdir(parents=True, exist_ok=True)

    uid = uuid.uuid4().hex

    image_filename = ''
    if image_b64:
        try:
            image_bytes = base64.b64decode(image_b64)
            image_filename = f'yt_{uid}.jpg'
            (media_dir / image_filename).write_bytes(image_bytes)
        except (ValueError, OSError) as exc:
            return {'error': f'failed to write screenshot: {exc}'}

    audio_filename = ''
    audio_skipped = ''
    if video_url and end_ms > start_ms:
        clip_seconds = (end_ms - start_ms) / 1000.0
        if clip_seconds > MAX_CLIP_SECONDS:
            audio_skipped = f'clip too long ({clip_seconds:.1f}s > {MAX_CLIP_SECONDS}s)'
        else:
            ffmpeg = _resolve_ffmpeg()
            if not ffmpeg:
                audio_skipped = 'ffmpeg not found (install ffmpeg or pip install imageio-ffmpeg)'
            elif not _yt_dlp_available():
                audio_skipped = 'yt-dlp not available (pip install yt-dlp)'
            else:
                audio_filename = f'yt_{uid}.mp3'
                out_path = media_dir / audio_filename
                err = _download_audio_clip(
                    ffmpeg=ffmpeg,
                    video_url=video_url,
                    start_ms=start_ms, end_ms=end_ms,
                    out_path=out_path,
                )
                if err:
                    audio_filename = ''
                    audio_skipped = err

    fields = _build_fields(field_map, sentence, image_filename, audio_filename)

    # Match the in-app convention (app_widget.createCard): front = first
    # field's value, back = the rest joined by ' / '. The card type's
    # Front_Style/Back_Style templates are applied at review time on the web
    # side and override this when present.
    card_type = database.get_card_type_by_id(int(type_id))
    if not card_type:
        return {'error': f'card type {type_id} not found'}
    field_values = [str(fields.get(f, '')) for f in card_type.fields]
    front = field_values[0] if field_values else sentence
    back = ' / '.join(v for v in field_values[1:] if v) if len(field_values) > 1 else ''
    if not front:
        front = sentence

    card_id = database.create_card(
        deck_id=int(deck_id),
        front=front,
        back=back,
        card_type_id=int(type_id),
        fields_json=json.dumps(fields, ensure_ascii=False),
    )

    return {
        'card_id': card_id,
        'image_filename': image_filename,
        'audio_filename': audio_filename,
        'audio_skipped': audio_skipped,
    }


def _build_fields(field_map: dict, sentence: str, image_file: str, audio_file: str) -> dict:
    """Map mining slots → user-chosen field names. Unmapped slots are skipped."""
    fields: dict = {}
    sentence_field = field_map.get('sentence') or ''
    image_field    = field_map.get('image') or ''
    audio_field    = field_map.get('audio') or ''

    if sentence_field:
        fields[sentence_field] = sentence

    if image_field and image_file:
        fields[image_field] = f'[image:{image_file}]'

    if audio_field and audio_file:
        fields[audio_field] = f'[sound:{audio_file}]'

    return fields


# ── Media helpers ────────────────────────────────────────────────────────────

def _media_dir() -> Path:
    import database
    return database.BASE_DIR / 'data' / 'media'


def _resolve_binary(name: str) -> str:
    """Find an executable across (1) bundled vendor/bin, (2) PyInstaller MEIPASS,
    (3) PATH. Returns absolute path or '' if not found."""
    exe = name + ('.exe' if sys.platform == 'win32' else '')

    candidates = []

    # 1. Bundled vendor/bin/<platform>/
    import database
    platform_dir = {
        'win32': 'windows',
        'darwin': 'macos',
        'linux': 'linux',
    }.get(sys.platform, sys.platform)
    candidates.append(database.BASE_DIR / 'vendor' / 'bin' / platform_dir / exe)

    # 2. PyInstaller's _MEIPASS extraction dir (frozen builds).
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        candidates.append(Path(meipass) / 'vendor' / 'bin' / platform_dir / exe)
        candidates.append(Path(meipass) / exe)

    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)

    # 3. PATH.
    found = shutil.which(name)
    return found or ''


def _resolve_ffmpeg() -> str:
    """Return path to an ffmpeg binary, or '' if unavailable.

    Search order:
      1. Bundled vendor/bin/<platform>/ffmpeg(.exe)
      2. PATH (system install)
      3. The imageio-ffmpeg package's bundled static binary (auto-downloads
         on first call, cached under the user's data dir).
    """
    found = _resolve_binary('ffmpeg')
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 — any import or download error here is "not available"
        return ''


def _yt_dlp_available() -> bool:
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        return False


def _download_audio_clip(*, ffmpeg: str, video_url: str,
                         start_ms: int, end_ms: int, out_path: Path) -> str:
    """Download a section of a video as mp3 using yt-dlp's Python API.

    Returns '' on success or an error string. We import yt_dlp inline so the
    rest of the server still works when the package isn't installed."""

    if not (video_url.startswith('http://') or video_url.startswith('https://')):
        return 'only http(s) video URLs are supported'

    start_s = max(0.0, start_ms / 1000.0)
    end_s = max(start_s + 0.1, end_ms / 1000.0)

    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError
    except ImportError:
        return 'yt-dlp not available (pip install yt-dlp)'

    def _ranges(info_dict, ydl):
        return [{'start_time': start_s, 'end_time': end_s}]

    # yt-dlp writes the source extension first, then the postprocessor
    # rewrites to mp3. Using outtmpl with %(ext)s lets it work either way,
    # and we sweep up the final file by stem afterwards.
    template = str(out_path.with_suffix('')) + '.%(ext)s'

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'ffmpeg_location': str(Path(ffmpeg).parent),
        'download_ranges': _ranges,
        'force_keyframes_at_cuts': True,
        'format': 'bestaudio/best',
        'outtmpl': template,
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '5',
        }],
        # Be a polite client — no progress bar, no terminal noise.
        'progress_hooks': [],
        'logger': _SilentLogger(),
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
    except DownloadError as exc:
        return f'yt-dlp failed: {str(exc)[:200]}'
    except Exception as exc:  # noqa: BLE001 — protocol boundary
        return f'audio download failed: {type(exc).__name__}: {str(exc)[:200]}'

    if not out_path.exists():
        # Postprocessor may write a slightly different filename when the
        # source extension doesn't match — find the produced file by stem.
        sibling = next(out_path.parent.glob(out_path.stem + '.*'), None)
        if sibling and sibling != out_path:
            try:
                if out_path.exists():
                    out_path.unlink()
                sibling.rename(out_path)
            except OSError:
                return f'audio file not at expected location: {sibling.name}'
        else:
            return 'audio file was not produced'

    return ''


class _SilentLogger:
    """Suppress yt-dlp's noisy info/warning chatter; surface errors only."""
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg):  # noqa: D401 — minimal duck type
        print(f'[yt-dlp] {msg}', file=sys.stderr)


# ── Boot ─────────────────────────────────────────────────────────────────────

async def _run():
    async with serve(_handle, HOST, PORT, origins=None, max_size=8 * 1024 * 1024):
        await asyncio.Future()


def start():
    """Start the WebSocket server in a background daemon thread."""
    def _thread():
        asyncio.run(_run())

    threading.Thread(target=_thread, daemon=True, name='ws-server').start()
