import json
import sys
import urllib.parse
from pathlib import Path

from PyQt6.QtWebEngineCore import QWebEngineUrlSchemeHandler, QWebEngineUrlRequestJob
from PyQt6.QtCore import QBuffer, QByteArray

from .jitendex import JitendexModule
from .jmdict import JMdictModule
from .base import DictionaryModule

# Module-level singleton - Jitendex is primary, JMdict is fallback.
_module: DictionaryModule | None = None


def get_dict_module() -> DictionaryModule:
    global _module
    if _module is None:
        jitendex = JitendexModule()
        _module = jitendex if jitendex.is_available else JMdictModule()
    return _module


def _project_base() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent.parent


def _web_root() -> Path:
    return (_project_base() / 'web').resolve()


def _data_dicts_root() -> Path:
    return (_project_base() / 'data' / 'dicts').resolve()


_MIME_BY_SUFFIX = {
    '.js':    b'text/javascript',
    '.mjs':   b'text/javascript',
    '.json':  b'application/json',
    '.css':   b'text/css',
    '.html':  b'text/html',
    '.htm':   b'text/html',
    '.svg':   b'image/svg+xml',
    '.png':   b'image/png',
    '.jpg':   b'image/jpeg',
    '.jpeg':  b'image/jpeg',
    '.gif':   b'image/gif',
    '.webp':  b'image/webp',
    '.ico':   b'image/x-icon',
    '.woff':  b'font/woff',
    '.woff2': b'font/woff2',
    '.ttf':   b'font/ttf',
    '.otf':   b'font/otf',
    '.wasm':  b'application/wasm',
    '.txt':   b'text/plain',
    '.map':   b'application/json',
    '.zip':   b'application/zip',
}


class DictionaryUrlSchemeHandler(QWebEngineUrlSchemeHandler):
    """Serves routes on the  immersion://  scheme:

      immersion:///lookup?text=...  → JSON dictionary lookup.
      immersion://app/<path>        → static file from web/.
      immersion://data/<path>       → static file from data/dicts/ (ZIPs).

    Installed once on the shared QWebEngineProfile so every tab can reach it.
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self._dict = get_dict_module()
        self._web_root = _web_root()
        self._data_root = _data_dicts_root()

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:
        url = job.requestUrl()
        host = url.host()
        path = url.path()

        if host == '' and path == '/lookup':
            self._serve_lookup(job, url)
        elif host == '' and path == '/dict-zips':
            self._serve_dict_zips(job)
        elif host == 'app':
            self._serve_static(job, url, self._web_root)
        elif host == 'data':
            self._serve_static(job, url, self._data_root)
        else:
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)

    def _serve_dict_zips(self, job: QWebEngineUrlRequestJob) -> None:
        try:
            names = sorted(p.name for p in self._data_root.glob('*.zip')
                           if p.is_file())
        except OSError:
            names = []
        self._reply_bytes(job, b'application/json',
                          json.dumps(names).encode('utf-8'))

    def _serve_lookup(self, job: QWebEngineUrlRequestJob, url) -> None:
        params = urllib.parse.parse_qs(url.query())
        text = params.get('text', [''])[0]

        if not text:
            result = {'matched': None, 'entries': []}
        elif not self._dict.is_available:
            result = {
                'error': (
                    'Dictionary not installed. '
                    'Run  scripts/build_jitendex.py  to set it up.'
                ),
                'matched': None,
                'entries': [],
            }
        else:
            result = self._dict.lookup_text(text)

        self._reply_bytes(job, b'application/json',
                          json.dumps(result, ensure_ascii=False).encode('utf-8'))

    def _serve_static(self, job: QWebEngineUrlRequestJob, url, root: Path,
                      strip_prefix: str = '') -> None:
        path = url.path()
        if strip_prefix and path.startswith(strip_prefix):
            path = path[len(strip_prefix):]
        rel = path.lstrip('/')
        try:
            target = (root / rel).resolve()
        except (OSError, ValueError):
            job.fail(QWebEngineUrlRequestJob.Error.UrlInvalid)
            return

        if root not in target.parents and target != root:
            job.fail(QWebEngineUrlRequestJob.Error.UrlInvalid)
            return
        if not target.is_file():
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return

        try:
            data = target.read_bytes()
        except OSError:
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
            return

        mime = _MIME_BY_SUFFIX.get(target.suffix.lower(),
                                   b'application/octet-stream')
        self._reply_bytes(job, mime, data)

    def _reply_bytes(self, job: QWebEngineUrlRequestJob,
                     mime: bytes, data: bytes) -> None:
        # QBuffer must stay alive until the job finishes reading it.
        # Parenting it to `self` keeps it from being GC'd; job.destroyed
        # cleans it up once Qt is done with the request.
        buf = QBuffer(self)
        buf.setData(QByteArray(data))
        buf.open(QBuffer.OpenModeFlag.ReadOnly)
        job.reply(mime, buf)
        job.destroyed.connect(buf.deleteLater)
