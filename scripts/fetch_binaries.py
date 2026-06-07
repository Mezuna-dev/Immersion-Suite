"""Fetch the helper binaries the YouTube features need (yt-dlp + ffmpeg)
into ``vendor/bin/<platform>/`` so they can be bundled into distributable builds.

The frozen app finds them through ``ws_server._resolve_binary``, which checks
``vendor/bin/<platform>/`` and the PyInstaller ``sys._MEIPASS`` copy before
falling back to PATH. ``ImmersionSuite.spec`` ships whatever this script writes
for the build machine's platform, so run this once before building.

Usage::

    python scripts/fetch_binaries.py                 # current platform
    python scripts/fetch_binaries.py --platform linux
    python scripts/fetch_binaries.py --all           # windows + macos + linux
    python scripts/fetch_binaries.py --force         # re-download existing

All binaries are plain downloads, so ``--all`` works from any OS (handy for
prepping a release from one machine). Binaries fetched for a foreign platform
are not verified (they can't run here); same-platform ones are smoke-tested
with ``-version`` / ``--version``.
"""

from __future__ import annotations

import argparse
import io
import os
import stat
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR_BIN = REPO_ROOT / 'vendor' / 'bin'

# Platform key -> our vendor/bin subdir name.
PLATFORMS = {'win32': 'windows', 'darwin': 'macos', 'linux': 'linux'}

# yt-dlp publishes one self-contained binary per platform on each GitHub release.
YT_DLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
YT_DLP_ASSET = {
    'windows': 'yt-dlp.exe',
    'macos':   'yt-dlp_macos',
    'linux':   'yt-dlp_linux',
}

# ffmpeg only (no ffprobe - yt-dlp falls back to ffmpeg for probing, and our
# clip->mp3 use doesn't need it; dropping it saves ~195MB on Windows). We pick
# the leanest reliable build per platform that still ships libmp3lame:
#   - Windows: gyan.dev "essentials" (~80MB vs BtbN's ~195MB full static)
#   - Linux:   BtbN "lgpl" (smaller than gpl; libmp3lame is LGPL so mp3 works)
#   - macOS:   evermeet.cx single-binary zip
FFMPEG_BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
FFMPEG_SOURCES = {
    'windows': {
        'archive': 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
        'members': {'ffmpeg.exe'},
    },
    'linux': {
        'archive': f'{FFMPEG_BTBN}/ffmpeg-master-latest-linux64-lgpl.tar.xz',
        'members': {'ffmpeg'},
    },
    'macos': {
        # evermeet serves a single-file zip per tool.
        'singles': {
            'ffmpeg': 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
        },
    },
}

_UA = {'User-Agent': 'Immersion-Suite-fetch-binaries/1.0'}


def _download(url: str) -> bytes:
    print(f'    - {url}')
    req = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310 - trusted release hosts
        return resp.read()


def _write_binary(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    # Make it runnable on unix (no-op effect on Windows).
    mode = dest.stat().st_mode
    dest.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _extract_member(archive: bytes, url: str, basename: str) -> bytes:
    """Pull a single file (matched by basename) out of a .zip or .tar.xz blob."""
    if url.endswith('.zip') or url.endswith('/zip'):
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            for name in zf.namelist():
                if Path(name).name == basename:
                    return zf.read(name)
    else:  # tar.xz / tar.*
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:*') as tf:
            for member in tf.getmembers():
                if member.isfile() and Path(member.name).name == basename:
                    f = tf.extractfile(member)
                    if f:
                        return f.read()
    raise FileNotFoundError(f'{basename} not found inside {url}')


def _fetch_yt_dlp(plat: str, force: bool) -> None:
    out = VENDOR_BIN / plat / ('yt-dlp.exe' if plat == 'windows' else 'yt-dlp')
    if out.exists() and not force:
        print(f'  yt-dlp     OK already present ({out.name})')
        return
    print('  yt-dlp     fetching...')
    data = _download(f'{YT_DLP_BASE}/{YT_DLP_ASSET[plat]}')
    _write_binary(out, data)
    print(f'  yt-dlp     OK {out.relative_to(REPO_ROOT)}')


def _fetch_ffmpeg(plat: str, force: bool) -> None:
    src = FFMPEG_SOURCES[plat]
    suffix = '.exe' if plat == 'windows' else ''
    if 'singles' in src:
        target_files = [f'{t}{suffix}' for t in src['singles']]
    else:
        target_files = sorted(src['members'])

    if all((VENDOR_BIN / plat / t).exists() for t in target_files) and not force:
        print(f'  ffmpeg     OK already present ({", ".join(target_files)})')
        return

    if 'singles' in src:  # macOS - one zip per tool
        for tool, url in src['singles'].items():
            out = VENDOR_BIN / plat / f'{tool}{suffix}'
            if out.exists() and not force:
                print(f'  {tool:<10} OK already present')
                continue
            print(f'  {tool:<10} fetching...')
            blob = _download(url)
            _write_binary(out, _extract_member(blob, url, tool))
            print(f'  {tool:<10} OK {out.relative_to(REPO_ROOT)}')
        return

    # Windows / Linux - one archive holds both binaries.
    print('  ffmpeg     fetching archive...')
    blob = _download(src['archive'])
    for member in sorted(src['members']):
        out = VENDOR_BIN / plat / member
        _write_binary(out, _extract_member(blob, src['archive'], member))
        print(f'  {member:<10} OK {out.relative_to(REPO_ROOT)}')


def _smoke_test(plat: str) -> None:
    """Run the just-fetched binaries if they're for this OS."""
    if PLATFORMS.get(sys.platform) != plat:
        print('  (skipped smoke test - foreign platform)')
        return
    import subprocess
    suffix = '.exe' if plat == 'windows' else ''
    checks = [('yt-dlp', '--version'), ('ffmpeg', '-version')]
    for name, flag in checks:
        exe = VENDOR_BIN / plat / f'{name}{suffix}'
        if not exe.exists():
            continue
        try:
            kw = {'creationflags': 0x08000000} if sys.platform == 'win32' else {}
            r = subprocess.run([str(exe), flag], capture_output=True, text=True,
                               timeout=30, **kw)
            first = (r.stdout or r.stderr or '').strip().splitlines()
            ok = 'OK' if r.returncode == 0 else 'x'
            print(f'  {ok} {name}: {first[0] if first else f"exit {r.returncode}"}')
        except Exception as exc:  # noqa: BLE001 - smoke test only
            print(f'  x {name}: {type(exc).__name__}: {exc}')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--platform', choices=sorted(PLATFORMS.values()),
                    help='target platform (default: this machine)')
    ap.add_argument('--all', action='store_true', help='fetch for all platforms')
    ap.add_argument('--force', action='store_true', help='re-download existing files')
    args = ap.parse_args()

    if args.all:
        plats = sorted(set(PLATFORMS.values()))
    elif args.platform:
        plats = [args.platform]
    else:
        plats = [PLATFORMS.get(sys.platform)]
        if plats == [None]:
            print(f'Unsupported platform: {sys.platform}', file=sys.stderr)
            return 2

    for plat in plats:
        print(f'\n=== {plat} -> {(VENDOR_BIN / plat).relative_to(REPO_ROOT)} ===')
        try:
            _fetch_yt_dlp(plat, args.force)
            _fetch_ffmpeg(plat, args.force)
        except Exception as exc:  # noqa: BLE001 - surface a clean message
            print(f'  ! failed: {type(exc).__name__}: {exc}', file=sys.stderr)
            return 1
        _smoke_test(plat)

    print('\nDone. These will be bundled by ImmersionSuite.spec on the next build.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
