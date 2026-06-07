@echo off
:: ============================================================
:: Build script for Immersion Suite v1.3.0 Windows installer
:: Run this from the repository root on a Windows machine.
:: Requirements:
::   pip install pyinstaller
::   Inno Setup 6 installed (iscc.exe on PATH, or edit ISCC path below)
:: ============================================================

setlocal

set APP_NAME=ImmersionSuite
set APP_VERSION=1.3.0
set ISCC="C:\Program Files (x86)\Inno Setup 6\iscc.exe"

echo === Immersion Suite v%APP_VERSION% Windows Build ===
echo.

:: Step 1 - install / verify dependencies
echo [1/3] Installing Python dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: pip install failed.
    exit /b 1
)
pip install pyinstaller
if errorlevel 1 (
    echo ERROR: Could not install PyInstaller.
    exit /b 1
)

:: Step 2 - build the executable bundle with PyInstaller
echo.
echo [2/3] Building executable with PyInstaller...
pyinstaller ImmersionSuite.spec --noconfirm
if errorlevel 1 (
    echo ERROR: PyInstaller build failed.
    exit /b 1
)

:: Step 3 - compile the Inno Setup installer
echo.
echo [3/3] Compiling installer with Inno Setup...
if not exist %ISCC% (
    echo WARNING: Inno Setup compiler not found at %ISCC%.
    echo          Install Inno Setup 6 or update the ISCC path in this script.
    echo          You can compile installer\ImmersionSuite_Setup.iss manually.
    goto :done
)
%ISCC% installer\ImmersionSuite_Setup.iss
if errorlevel 1 (
    echo ERROR: Inno Setup compilation failed.
    exit /b 1
)

:done
echo.
echo === Build complete ===
echo Installer output: installer\output\ImmersionSuite_v%APP_VERSION%_Setup.exe
endlocal
