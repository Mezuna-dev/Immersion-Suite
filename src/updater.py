"""Pure helpers for the in-app updater.

Kept free of Qt imports so the version-comparison and asset-selection logic can
be unit tested in isolation. The network/UI side lives in AppBridge.
"""
import re

REPO = "Mezuna-dev/Immersion-Suite"
RELEASES_API_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_PAGE_URL = f"https://github.com/{REPO}/releases/latest"


def parse_version(text):
    """Turn a version string/tag (e.g. 'v1.3.1', '1.3.1-beta') into a comparable
    tuple of ints, e.g. (1, 3, 1). Missing components are padded with zeros."""
    nums = re.findall(r"\d+", text or "")
    parts = [int(n) for n in nums[:3]]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def is_newer(latest_tag, current_version):
    """True if latest_tag represents a strictly newer version than current."""
    return parse_version(latest_tag) > parse_version(current_version)


def select_asset(assets, platform):
    """Pick the right release asset for the running platform.

    assets: list of dicts with at least 'name' and 'browser_download_url'.
    platform: a sys.platform value ('win32', 'linux', 'darwin').
    Returns the matching asset dict, or None if there's no suitable asset.
    """
    if platform == "win32":
        suffixes = (".exe",)
    elif platform.startswith("linux"):
        suffixes = (".run", ".appimage")
    else:
        suffixes = ()
    for asset in assets or []:
        name = (asset.get("name") or "").lower()
        if name.endswith(suffixes):
            return asset
    return None
