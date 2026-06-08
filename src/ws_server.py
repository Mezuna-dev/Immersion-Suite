import asyncio
import base64
import hmac
import http
import json
import os
import secrets
import shutil
import subprocess
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
# A client must present the shared token within this window of connecting.
AUTH_TIMEOUT_SECONDS = 5


# ── Shared-token authentication ──────────────────────────────────────────────
# The origin gate (below) stops *websites* reaching the bridge, but other local
# extensions connect with their own chrome-extension:// origin and any local
# process can speak WebSocket. A shared secret - generated on first run, shown to
# the user in the app's Settings → Browser Extension, and pasted into the
# extension's options - is required as the first message before any action runs.

_token_cache = None


def _token_path() -> Path:
    import database
    return database.BASE_DIR / 'data' / 'ws_token.txt'


def get_or_create_token() -> str:
    """Return the shared secret, generating and persisting it on first use."""
    global _token_cache
    if _token_cache:
        return _token_cache
    path = _token_path()
    try:
        if path.exists():
            tok = path.read_text(encoding='utf-8').strip()
            if tok:
                _token_cache = tok
                return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(tok, encoding='utf-8')
    except OSError:
        pass
    _token_cache = tok
    return tok


async def _authenticate(websocket) -> bool:
    """Require a valid `{action:'auth', token}` as the first message. Sends an
    explicit auth reply either way so the extension can distinguish a bad token
    from the app simply not running (a rejected WS handshake is opaque to JS)."""
    expected = get_or_create_token()
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=AUTH_TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001 - timeout or early close → not authenticated
        return False

    try:
        msg = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        msg = {}
    if not isinstance(msg, dict):
        msg = {}

    msg_id = msg.get('id', '')
    token = str(msg.get('token', ''))
    if msg.get('action') == 'auth' and hmac.compare_digest(token, expected):
        await websocket.send(json.dumps({'action': 'auth', 'ok': True, 'id': msg_id}))
        return True

    try:
        await websocket.send(json.dumps({
            'action': 'auth', 'ok': False,
            'error': 'invalid or missing token', 'id': msg_id,
        }))
    except Exception:  # noqa: BLE001 - best-effort error reply
        pass
    return False


# ── Connection origin gate ───────────────────────────────────────────────────
# The bridge listens on 127.0.0.1, but "localhost" is reachable by every page
# the user visits. Without this gate any website could open ws://127.0.0.1:8765
# and invoke every action - including create_card_with_media, which feeds an
# arbitrary URL into yt-dlp and writes files to disk (drive-by card-spam /
# download vector). Browsers set the Origin header on WebSocket handshakes and
# page JavaScript cannot override it, so rejecting web origins reliably shuts
# the website attack out.
#
# The extension's background service worker connects with a chrome-extension://
# or moz-extension:// origin, which we allow. A missing Origin (some non-browser
# clients / older extension runtimes) is allowed too so we never silently break
# the extension. Hardening against *local non-browser* clients needs a shared
# token; that lands with the options page (roadmap item #7) which can surface the
# token for the user to paste.

_ALLOWED_ORIGIN_SCHEMES = ('chrome-extension://', 'moz-extension://')


def _origin_allowed(origin) -> bool:
    if not origin:
        return True
    return origin.startswith(_ALLOWED_ORIGIN_SCHEMES)


async def _process_request(path, request_headers):
    """Reject the handshake before the WS opens if the Origin isn't allowed.

    Legacy-server signature: return None to proceed, or an
    (status, headers, body) tuple to reject.
    """
    origin = request_headers.get('Origin')
    if not _origin_allowed(origin):
        return http.HTTPStatus.FORBIDDEN, [], b'origin not allowed\n'
    return None


# ── Action dispatch ──────────────────────────────────────────────────────────

async def _handle(websocket):
    if not await _authenticate(websocket):
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        return
    async for raw in websocket:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue

        action = msg.get('action')
        msg_id = msg.get('id', '')

        try:
            response = await _dispatch(action, msg)
        except Exception as exc:  # noqa: BLE001 - protocol boundary
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

    if action == 'create_card':
        return await loop.run_in_executor(None, _create_card, msg)

    if action == 'tokenize':
        text = msg.get('text', '')
        return await loop.run_in_executor(None, _tokenize, text)

    if action == 'analyze':
        text = msg.get('text', '')
        return await loop.run_in_executor(None, _analyze, text)

    if action == 'get_known_words':
        return await loop.run_in_executor(None, _get_known_words)

    if action == 'set_known_word':
        return await loop.run_in_executor(None, _set_known_word, msg)

    if action == 'get_youtube_subs':
        return await loop.run_in_executor(None, _get_youtube_subs, msg)

    return {'error': f'unknown action: {action}'}


def _tokenize(text: str) -> dict:
    from furigana import tokenize_sentence
    return tokenize_sentence(text)


def _analyze(text: str) -> dict:
    from furigana import analyze_sentence
    return analyze_sentence(text)


def _get_known_words() -> dict:
    import database
    return {'known': database.get_known_words()}


def _set_known_word(msg: dict) -> dict:
    import database
    term = (msg.get('term') or '').strip()
    if not term:
        return {'error': 'term is required'}
    known = bool(msg.get('known'))
    if known:
        database.add_known_word(term)
    else:
        database.remove_known_word(term)
    return {'term': term, 'known': known, 'count': database.count_known_words()}


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


def _create_card(msg: dict) -> dict:
    """Create a text-only card from a field-name → value map. Used by the hover
    dictionary's mine button (no media). Front/back follow the same convention as
    _create_card_with_media: front = first field's value, back = the rest."""
    import database

    deck_id = msg.get('deck_id')
    type_id = msg.get('card_type_id')
    fields_in = msg.get('fields') or {}

    if not deck_id or not type_id:
        return {'error': 'deck_id and card_type_id are required'}
    if not isinstance(fields_in, dict):
        return {'error': 'fields must be an object'}

    card_type = database.get_card_type_by_id(int(type_id))
    if not card_type:
        return {'error': f'card type {type_id} not found'}

    # Keep only fields that actually belong to the card type, in its order.
    fields = {f: str(fields_in.get(f, '')) for f in card_type.fields}
    field_values = list(fields.values())
    if not any(v.strip() for v in field_values):
        return {'error': 'no field values provided'}

    front = field_values[0] if field_values else ''
    back = ' / '.join(v for v in field_values[1:] if v) if len(field_values) > 1 else ''
    if not front:
        front = next((v for v in field_values if v), '')

    card_id = database.create_card(
        deck_id=int(deck_id),
        front=front,
        back=back,
        card_type_id=int(type_id),
        fields_json=json.dumps(fields, ensure_ascii=False),
    )
    return {'card_id': card_id}


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
        if c.is_file():
            # PyInstaller datas don't preserve the exec bit on unix; restore it
            # so the bundled binary is actually runnable.
            if not os.access(c, os.X_OK):
                try:
                    c.chmod(c.stat().st_mode | 0o111)
                except OSError:
                    pass
            if os.access(c, os.X_OK):
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
    except Exception:  # noqa: BLE001 - any import or download error here is "not available"
        return ''


def _ytdlp_binary() -> str:
    """Path to a bundled/standalone yt-dlp executable, or '' if none is found.

    Preferred over the Python module in frozen builds: the bundled binary is
    self-contained (no fragile PyInstaller extractor collection) and can be
    swapped out to keep up with YouTube changes without rebuilding the app.
    """
    return _resolve_binary('yt-dlp')


def _yt_dlp_available() -> bool:
    if _ytdlp_binary():
        return True
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        return False


def _run_cmd(cmd: list, timeout: int) -> tuple:
    """Run a helper binary without flashing a console window on Windows.

    Returns (returncode, stdout, stderr); returncode is -1 on spawn failure or
    timeout, with the reason in stderr.
    """
    kwargs = {}
    if sys.platform == 'win32':
        kwargs['creationflags'] = 0x08000000  # CREATE_NO_WINDOW
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, **kwargs,
        )
        return proc.returncode, proc.stdout or '', proc.stderr or ''
    except subprocess.TimeoutExpired:
        return -1, '', f'timed out after {timeout}s'
    except (OSError, ValueError) as exc:
        return -1, '', f'{type(exc).__name__}: {exc}'


def _last_line(*streams: str) -> str:
    for s in streams:
        lines = [ln for ln in (s or '').splitlines() if ln.strip()]
        if lines:
            return lines[-1].strip()
    return 'unknown error'


def _download_audio_clip(*, ffmpeg: str, video_url: str,
                         start_ms: int, end_ms: int, out_path: Path) -> str:
    """Download a section of a video as mp3. Returns '' on success or an error.

    Prefers the bundled/standalone yt-dlp binary (frozen builds); falls back to
    the yt-dlp Python module for dev environments that pip-installed it."""

    if not (video_url.startswith('http://') or video_url.startswith('https://')):
        return 'only http(s) video URLs are supported'

    binary = _ytdlp_binary()
    if binary:
        return _download_audio_clip_cli(
            binary=binary, ffmpeg=ffmpeg, video_url=video_url,
            start_ms=start_ms, end_ms=end_ms, out_path=out_path,
        )
    return _download_audio_clip_module(
        ffmpeg=ffmpeg, video_url=video_url,
        start_ms=start_ms, end_ms=end_ms, out_path=out_path,
    )


def _clip_section(start_ms: int, end_ms: int) -> tuple:
    start_s = max(0.0, start_ms / 1000.0)
    end_s = max(start_s + 0.1, end_ms / 1000.0)
    return start_s, end_s


def _finalize_clip(out_path: Path) -> str:
    """yt-dlp may write a slightly different extension before the mp3
    postprocessor runs - locate the produced file by stem. Returns '' or error."""
    if out_path.exists():
        return ''
    sibling = next(out_path.parent.glob(out_path.stem + '.*'), None)
    if sibling and sibling != out_path:
        try:
            sibling.rename(out_path)
            return ''
        except OSError:
            return f'audio file not at expected location: {sibling.name}'
    return 'audio file was not produced'


def _download_audio_clip_cli(*, binary: str, ffmpeg: str, video_url: str,
                             start_ms: int, end_ms: int, out_path: Path) -> str:
    start_s, end_s = _clip_section(start_ms, end_ms)
    template = str(out_path.with_suffix('')) + '.%(ext)s'
    cmd = [
        binary,
        '--quiet', '--no-warnings', '--no-playlist',
        '--ffmpeg-location', str(Path(ffmpeg).parent),
        '--download-sections', f'*{start_s}-{end_s}',
        '--force-keyframes-at-cuts',
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'mp3', '--audio-quality', '5',
        '-o', template,
        video_url,
    ]
    rc, out, err = _run_cmd(cmd, MEDIA_TIMEOUT_SECONDS)
    if rc != 0:
        return f'yt-dlp failed: {_last_line(err, out)[:200]}'
    return _finalize_clip(out_path)


def _download_audio_clip_module(*, ffmpeg: str, video_url: str,
                                start_ms: int, end_ms: int, out_path: Path) -> str:
    start_s, end_s = _clip_section(start_ms, end_ms)

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
        # Be a polite client - no progress bar, no terminal noise.
        'progress_hooks': [],
        'logger': _SilentLogger(),
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
    except DownloadError as exc:
        return f'yt-dlp failed: {str(exc)[:200]}'
    except Exception as exc:  # noqa: BLE001 - protocol boundary
        return f'audio download failed: {type(exc).__name__}: {str(exc)[:200]}'

    return _finalize_clip(out_path)


class _SilentLogger:
    """Suppress yt-dlp's noisy info/warning chatter; surface errors only."""
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg):  # noqa: D401 - minimal duck type
        print(f'[yt-dlp] {msg}', file=sys.stderr)


# ── YouTube subtitle fetch (bypasses PoT-gated timedtext endpoint) ────────────

def _get_youtube_subs(msg: dict) -> dict:
    """Fetch the full subtitle list for a YouTube video via yt-dlp.

    Returns {'cues': [{start, end, text}, ...], 'source': 'manual'|'auto'} on
    success, or {'error': ...}. Used by the extension's queue panel when the
    browser-side direct fetch is empty (PoT-gating, late 2024+).
    """
    video_url = (msg.get('video_url') or '').strip()
    lang = (msg.get('lang') or 'ja').strip() or 'ja'

    if not (video_url.startswith('http://') or video_url.startswith('https://')):
        return {'error': 'invalid video_url'}

    if not _yt_dlp_available():
        return {'error': 'yt-dlp not available (pip install yt-dlp)'}

    # Manual subs first, fall back to auto-gen. Two passes so the produced
    # filenames are unambiguous (one pass with both options can collide).
    cues = _fetch_subs_via_ytdlp(video_url, lang, automatic=False)
    if cues:
        return {'cues': cues, 'source': 'manual'}
    cues = _fetch_subs_via_ytdlp(video_url, lang, automatic=True)
    if cues:
        return {'cues': cues, 'source': 'auto'}
    return {'error': f'no {lang} subtitle track available'}


def _fetch_subs_via_ytdlp(video_url: str, lang: str, *, automatic: bool) -> list:
    """Write a sub track to a tempdir and parse it. Prefers the bundled binary
    (frozen builds), falls back to the yt-dlp Python module (dev)."""
    import tempfile
    tempdir = Path(tempfile.mkdtemp(prefix='imm_yt_subs_'))
    try:
        outtmpl = str(tempdir / '%(id)s.%(ext)s')
        binary = _ytdlp_binary()
        if binary:
            cmd = [
                binary,
                '--quiet', '--no-warnings', '--no-playlist',
                '--skip-download',
                ('--write-auto-subs' if automatic else '--write-subs'),
                '--sub-langs', f'{lang},{lang}-orig,{lang}.*',
                '--sub-format', 'json3/srv3/vtt',
                '-o', outtmpl,
                video_url,
            ]
            _run_cmd(cmd, MEDIA_TIMEOUT_SECONDS)  # missing track → no files, handled below
        else:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'noplaylist': True,
                'skip_download': True,
                'writesubtitles': not automatic,
                'writeautomaticsub': automatic,
                'subtitleslangs': [lang, f'{lang}-orig', f'{lang}.*'],
                'subtitlesformat': 'json3/srv3/vtt',
                'outtmpl': outtmpl,
                'logger': _SilentLogger(),
            }
            try:
                from yt_dlp import YoutubeDL
                with YoutubeDL(ydl_opts) as ydl:
                    ydl.download([video_url])
            except Exception:  # noqa: BLE001 - any yt-dlp failure → no cues
                return []

        return _parse_subs_dir(tempdir)
    finally:
        shutil.rmtree(tempdir, ignore_errors=True)


def _parse_subs_dir(tempdir: Path) -> list:
    """Parse the first non-empty sub file yt-dlp wrote, preferring richer formats."""
    for ext in ('json3', 'srv3', 'vtt', 'srv1'):
        for f in sorted(tempdir.glob(f'*.{ext}')):
            try:
                text = f.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            if ext == 'json3':
                cues = _parse_subs_json3(text)
            elif ext in ('srv3', 'srv1'):
                cues = _parse_subs_timedtext_xml(text)
            else:
                cues = _parse_subs_vtt(text)
            if cues:
                return cues
    return []


def _parse_subs_json3(text: str) -> list:
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return []
    out = []
    for ev in (data.get('events') or []):
        segs = ev.get('segs')
        if not segs:
            continue
        joined = ''.join((s.get('utf8') or '') for s in segs)
        cleaned = joined.replace('\n', ' ').strip()
        if not cleaned:
            continue
        start = (ev.get('tStartMs') or 0) / 1000.0
        end = start + ((ev.get('dDurationMs') or 0) / 1000.0)
        out.append({'start': start, 'end': end, 'text': cleaned})
    out.sort(key=lambda c: c['start'])
    return out


def _parse_subs_timedtext_xml(text: str) -> list:
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    out = []
    # srv3 format: <p t="ms" d="ms">text…</p>
    for p in root.iter('p'):
        try:
            start = int(p.attrib.get('t', '0')) / 1000.0
            dur = int(p.attrib.get('d', '0')) / 1000.0
        except ValueError:
            continue
        content = ''.join(p.itertext()).replace('\n', ' ').strip()
        if not content:
            continue
        out.append({'start': start, 'end': start + dur, 'text': content})
    if not out:
        # Legacy srv1: <text start="s" dur="s">text</text>
        for t in root.iter('text'):
            try:
                start = float(t.attrib.get('start', '0'))
                dur = float(t.attrib.get('dur', '0'))
            except ValueError:
                continue
            content = (''.join(t.itertext()) or '').replace('\n', ' ').strip()
            if not content:
                continue
            out.append({'start': start, 'end': start + dur, 'text': content})
    out.sort(key=lambda c: c['start'])
    return out


def _parse_subs_vtt(text: str) -> list:
    """Minimal WebVTT parser. Strips inline tags (`<c>`, `<v Name>`, word-level
    `<00:00:01.000>` timing markers from YouTube auto-gen) and dedupes
    consecutive identical cues (the rolling-caption artefact)."""
    import re
    ts_re = re.compile(
        r'(\d+):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{3})'
    )
    out = []
    last_text = None
    for block in re.split(r'\n\s*\n', text):
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines or lines[0].strip().upper().startswith('WEBVTT'):
            continue
        ts_match = None
        ts_idx = -1
        for i, ln in enumerate(lines):
            m = ts_re.search(ln)
            if m:
                ts_match = m
                ts_idx = i
                break
        if not ts_match:
            continue
        h1, m1, s1, ms1, h2, m2, s2, ms2 = ts_match.groups()
        start = int(h1) * 3600 + int(m1) * 60 + int(s1) + int(ms1) / 1000.0
        end = int(h2) * 3600 + int(m2) * 60 + int(s2) + int(ms2) / 1000.0
        body_lines = lines[ts_idx + 1:]
        body = re.sub(r'<[^>]+>', '', ' '.join(body_lines))
        body = re.sub(r'\s+', ' ', body).strip()
        if not body or body == last_text:
            continue
        out.append({'start': start, 'end': end, 'text': body})
        last_text = body
    out.sort(key=lambda c: c['start'])
    return out


# ── Boot ─────────────────────────────────────────────────────────────────────

async def _run():
    async with serve(_handle, HOST, PORT, origins=None,
                     process_request=_process_request,
                     max_size=8 * 1024 * 1024):
        await asyncio.Future()


def start():
    """Start the WebSocket server in a background daemon thread."""
    def _thread():
        asyncio.run(_run())

    threading.Thread(target=_thread, daemon=True, name='ws-server').start()
