; Inno Setup Script for Immersion Suite v1.4.2
; Requires Inno Setup 6.x - https://jrsoftware.org/isinfo.php
;
; Build steps (run on Windows):
;   1. pip install pyinstaller
;   2. From the repo root: pyinstaller ImmersionSuite.spec
;   3. Open this .iss file in the Inno Setup Compiler and click Build,
;      OR run: iscc installer\ImmersionSuite_Setup.iss

#define AppName      "Immersion Suite"
#define AppVersion   "1.4.2"
#define AppPublisher "Mezuna"
#define AppURL       "https://github.com/mezuna-dev/immersion-app"
#define AppExeName   "ImmersionSuite.exe"
#define BuildDir     "..\dist\ImmersionSuite"
#define AppIcon      "icon.ico"

[Setup]
AppId={{A3F7B2C1-4D5E-4F6A-8B9C-0D1E2F3A4B5C}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} v{#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
LicenseFile=..\LICENSE
OutputDir=.\output
OutputBaseFilename=ImmersionSuite_v{#AppVersion}_Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\{#AppExeName}
MinVersion=10.0.17763

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";    Description: "{cm:CreateDesktopIcon}";    GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked; OnlyBelowVersion: 6.1

[Files]
; Main application bundle (produced by PyInstaller)
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Browser extension source, so users can load it unpacked in Chrome / Firefox
Source: "..\extension\*"; DestDir: "{app}\extension"; Excludes: "web-ext-artifacts\*"; Flags: ignoreversion recursesubdirs createallsubdirs
; Third-party license notices
Source: "..\THIRD_PARTY_LICENSES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}";           Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"
Name: "{group}\Browser Extension (load unpacked)"; Filename: "{app}\extension"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";     Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; Tasks: quicklaunchicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Remove the data directory only if the user chooses to - left as a note.
; User data in {app}\data is intentionally NOT deleted on uninstall
; so that a reinstall or upgrade does not wipe flashcard progress.
