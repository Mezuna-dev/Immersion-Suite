# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for Immersion Suite v1.3.1

import sys as _sys
from pathlib import Path as _Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# ── Bundled helper binaries (yt-dlp + ffmpeg/ffprobe) ────────────────────────
# Populated by scripts/fetch_binaries.py into vendor/bin/<platform>/. We ship
# only this build machine's platform. They extract into the PyInstaller
# _internal dir, where ws_server._resolve_binary locates them via sys._MEIPASS.
# Shipped as datas (not binaries) so PyInstaller doesn't run dependency analysis
# on these self-contained executables; ws_server restores the unix exec bit at
# resolve time. Run `python scripts/fetch_binaries.py` before building.
_PLATFORM_DIR = {'win32': 'windows', 'darwin': 'macos', 'linux': 'linux'}.get(_sys.platform, _sys.platform)
_bin_src = _Path('vendor') / 'bin' / _PLATFORM_DIR
_bin_dest = str(_Path('vendor') / 'bin' / _PLATFORM_DIR)
_bin_datas = (
    [(str(p), _bin_dest) for p in _bin_src.iterdir() if p.is_file()]
    if _bin_src.is_dir() else []
)
if not _bin_datas:
    print(f'[spec] WARNING: no helper binaries in {_bin_src} — '
          f'run scripts/fetch_binaries.py so YouTube media features work in the build.')

# ── Data-heavy deps PyInstaller can't fully trace on its own ─────────────────
# sudachipy ships a compiled extension + resource files; sudachidict_core ships
# the ~200MB system.dic that dictionary.Dictionary() loads at runtime — both
# must be collected explicitly or furigana silently fails in the frozen app.
# websockets (the extension's WS backend) loads submodules dynamically.
_pkg_datas, _pkg_binaries, _pkg_hidden = [], [], []
for _pkg in ('sudachipy', 'sudachidict_core'):
    _d, _b, _h = collect_all(_pkg)
    _pkg_datas += _d
    _pkg_binaries += _b
    _pkg_hidden += _h
_pkg_hidden += collect_submodules('websockets')

# Prebuilt dictionary databases. jitendex.sqlite is REQUIRED for the popup
# dictionary; build it with scripts/build_jitendex.py. The 37MB build-source zip
# (jitendex-yomitan.zip) is not needed at runtime, so it is excluded.
_dict_src = _Path('data') / 'dicts'
_dict_datas = []
if _dict_src.is_dir():
    for _p in sorted(_dict_src.glob('*.sqlite')) + sorted(_dict_src.glob('*.zip')):
        if _p.name == 'jitendex-yomitan.zip':
            continue
        _dict_datas.append((str(_p), str(_dict_src)))
if not any(_p[0].endswith('jitendex.sqlite') for _p in _dict_datas):
    print('[spec] WARNING: data/dicts/jitendex.sqlite missing - run '
          'scripts/build_jitendex.py so the popup dictionary works in the build.')

a = Analysis(
    ['src/gui.py'],
    pathex=['src'],
    binaries=[*_pkg_binaries],
    datas=[
        ('web', 'web'),
        ('installer/icon.ico', '.'),
        *_bin_datas,
        *_pkg_datas,
        *_dict_datas,
    ],
    hiddenimports=[
        'zstandard',
        'PyQt6.QtWebEngineWidgets',
        'PyQt6.QtWebEngineCore',
        'PyQt6.QtWebChannel',
        'PyQt6.QtPrintSupport',
        *_pkg_hidden,
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # yt-dlp + imageio-ffmpeg are intentionally NOT frozen: the app uses the
    # bundled standalone yt-dlp/ffmpeg binaries (vendor/bin) at runtime, and
    # ws_server falls back to these modules only in dev. Excluding them keeps
    # the build lean and avoids imageio shipping a second copy of ffmpeg.
    excludes=['yt_dlp', 'imageio_ffmpeg'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ImmersionSuite',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='installer/icon.ico',
    version_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ImmersionSuite',
)
