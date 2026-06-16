#!/usr/bin/env bash
# ============================================================
# Build script for Immersion Suite v1.4.0 Linux installer
# Run this from the repository root on a Linux machine.
# Requirements:
#   pip install pyinstaller pillow
#   makeself installed (https://makeself.io or: apt install makeself)
# ============================================================

set -euo pipefail

APP_NAME="ImmersionSuite"
APP_VERSION="1.4.0"
OUTPUT_DIR="installer/output"
INSTALLER_NAME="${APP_NAME}_v${APP_VERSION}_Linux_x86_64.run"

echo "=== Immersion Suite v${APP_VERSION} Linux Installer Build ==="
echo

# Step 1 - install / verify dependencies
echo "[1/4] Installing Python dependencies..."
pip install -r requirements.txt
pip install pyinstaller pillow

# Step 1b - fetch bundled binaries and build the dictionary
echo
echo "[1b/4] Fetching binaries and building dictionary..."
python scripts/fetch_binaries.py
python scripts/build_jitendex.py --file data/dicts/jitendex-yomitan.zip

# Step 2 - build the executable bundle with PyInstaller
echo
echo "[2/4] Building executable with PyInstaller..."
pyinstaller ImmersionSuite.spec --noconfirm

# Step 3 - add icon and installer script to the bundle
echo
echo "[3/4] Adding icon and setup script to bundle..."
python3 - <<'PYEOF'
from PIL import Image
img = Image.open("installer/icon.ico")
sizes = [s for s in img.info.get("sizes", [(256, 256)])]
best = max(sizes) if sizes else (256, 256)
img.size = best
img.save("dist/ImmersionSuite/icon.png", format="PNG")
PYEOF
cp installer/linux_setup.sh dist/ImmersionSuite/linux_setup.sh
chmod +x dist/ImmersionSuite/linux_setup.sh
cp -r extension dist/ImmersionSuite/extension
rm -rf dist/ImmersionSuite/extension/web-ext-artifacts
cp THIRD_PARTY_LICENSES.txt dist/ImmersionSuite/THIRD_PARTY_LICENSES.txt

# Step 4 - build the self-extracting installer with makeself
echo
echo "[4/4] Creating ${INSTALLER_NAME}..."
mkdir -p "${OUTPUT_DIR}"
makeself dist/ImmersionSuite \
    "${OUTPUT_DIR}/${INSTALLER_NAME}" \
    "Immersion Suite v${APP_VERSION}" \
    ./linux_setup.sh

echo
echo "=== Build complete ==="
echo "Installer output: ${OUTPUT_DIR}/${INSTALLER_NAME}"
echo "To install: bash ${OUTPUT_DIR}/${INSTALLER_NAME}"
