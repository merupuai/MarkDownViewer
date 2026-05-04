; MarkdownViewerSetup.iss — Inno Setup script for the Markdown Viewer
; Windows installer. Produces a single MarkdownViewerSetup.exe that:
;   * Installs to %LOCALAPPDATA%\Programs\MarkdownViewer (per-user, no admin)
;   * Registers .md / .markdown / .mdown / .mkd / .mkdn / .mdx file types
;   * Adds "Open with Markdown Viewer" to the Explorer right-click menu
;   * Provides a checkbox to set the app as the default for .md
;   * Creates Start Menu and optional Desktop shortcuts
;
; Build:
;   1. Install Inno Setup 6.x: https://jrsoftware.org/isinfo.php
;   2. From this project root on Windows, build the app first:
;        powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
;   3. Compile the installer:
;        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\MarkdownViewerSetup.iss
;   4. Output: build\windows-installer\MarkdownViewerSetup.exe

#define MyAppName        "Markdown Viewer"
#define MyAppVersion     "1.1.0"
#define MyAppPublisher   "MFTLabs"
#define MyAppDeveloper   "CoBolt"
#define MyAppPublisherURL "https://mftlabs.io"
#define MyAppCopyright   "Copyright (c) 2026 MFTLabs. Developed by CoBolt. Resale prohibited."
#define MyAppExeName     "Markdown Viewer.exe"
; Real on-disk path of the runnable inside {app}. Electrobun's stable build
; places the launcher under bin/, not at the install root, so registry
; commands and shortcuts must use this path. MyAppExeName above stays as the
; "friendly" basename used for the HKCU\Software\Classes\Applications subkey.
#define MyAppExeRelPath  "bin\launcher.exe"
#define MyAppId          "com.local.markdownviewer"
#define MyAppProgId      "MarkdownViewer.MarkdownDocument"
; Pre-staged unpacked layout produced by extracting the stable tarball.
; See scripts/stage-windows-app.ps1 (or the equivalent commands in README).
#define MyAppSourceDir   "..\build\stable-win-x64-app"
#define MyAppIcon        "..\assets\brand\AppIcon.ico"
#define MyAppLicenseFile "..\LICENSE"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppPublisherURL}
AppSupportURL={#MyAppPublisherURL}
AppCopyright={#MyAppCopyright}
VersionInfoCompany={#MyAppPublisher}
VersionInfoCopyright={#MyAppCopyright}
VersionInfoDescription={#MyAppName} — Developed by {#MyAppDeveloper}
VersionInfoProductName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\MarkdownViewer
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\build\windows-installer
OutputBaseFilename=MarkdownViewerSetup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesAssociations=yes
SetupIconFile={#MyAppIcon}
UninstallDisplayIcon={app}\AppIcon.ico

; ---------------------------------------------------------------------------
; LICENSE ACCEPTANCE (click-through EULA)
;
; Inno Setup will render LicenseFile on a dedicated wizard page with
; "I accept the agreement" / "I do not accept the agreement" radio buttons.
; The Next button is disabled until the user explicitly accepts. This gives
; us contractual click-through acceptance of the MIT (Non-Resale Variant)
; license — required to make the no-resale clause enforceable against
; downstream redistributors.
;
; InfoBeforeFile is an additional plain-info screen highlighting the
; non-resale restriction in plain language before the legal text.
; ---------------------------------------------------------------------------
LicenseFile={#MyAppLicenseFile}
InfoBeforeFile=license-notice.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";   Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "associatemd";   Description: "Associate &Markdown files (.md, .markdown, .mdown, .mkd, .mkdn, .mdx) with {#MyAppName}"; GroupDescription: "File associations:"; Flags: checkedonce
Name: "setdefault";    Description: "&Open the Default Apps page after install so I can set {#MyAppName} as my default"; GroupDescription: "File associations:"; Flags: unchecked

[Files]
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs
; Branded icon — used by Start Menu shortcuts, Add/Remove Programs, and the
; .md file-type DefaultIcon below. Placed alongside the .exe in {app}.
Source: "{#MyAppIcon}"; DestDir: "{app}"; DestName: "AppIcon.ico"; Flags: ignoreversion
; Bundle the LICENSE alongside the executable so users can re-read the
; no-resale terms after install. Surfaced via a Start Menu shortcut below.
Source: "{#MyAppLicenseFile}"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeRelPath}"; IconFilename: "{app}\AppIcon.ico"
Name: "{group}\License (MFTLabs · Non-Resale)"; Filename: "{app}\LICENSE.txt"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeRelPath}"; IconFilename: "{app}\AppIcon.ico"; Tasks: desktopicon

[Registry]
; ProgID
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}";              ValueType: string; ValueName: "";                ValueData: "Markdown Document"; Flags: uninsdeletekey; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\DefaultIcon";  ValueType: string; ValueName: "";                ValueData: """{app}\AppIcon.ico"""; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\shell\open";   ValueType: string; ValueName: "";                ValueData: "Open"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\shell\open\command"; ValueType: string; ValueName: "";          ValueData: """{app}\{#MyAppExeRelPath}"" ""%1"""; Tasks: associatemd

; App registration
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#MyAppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeRelPath}"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".md";       ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".markdown"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".mdown";    ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".mkd";      ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".mkdn";     ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".mdx";      ValueData: ""

; OpenWithProgIds for each extension
Root: HKCU; Subkey: "Software\Classes\.md\OpenWithProgids";       ValueType: none; ValueName: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: none; ValueName: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\.mdown\OpenWithProgids";    ValueType: none; ValueName: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\.mkd\OpenWithProgids";      ValueType: none; ValueName: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\.mkdn\OpenWithProgids";     ValueType: none; ValueName: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\.mdx\OpenWithProgids";      ValueType: none; ValueName: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associatemd

; Default Apps integration
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities"; ValueType: string; ValueName: "ApplicationName";        ValueData: "{#MyAppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Native markdown viewer with Mermaid/C4 diagrams — © MFTLabs, developed by CoBolt"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".md";       ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".markdown"; ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mdown";    ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mkd";      ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mkdn";     ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mdx";      ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: "Software\{#MyAppName}\Capabilities"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeRelPath}"; Description: "Launch {#MyAppName}"; Flags: postinstall nowait skipifsilent
Filename: "ms-settings:defaultapps"; Description: "Open Default Apps to set {#MyAppName} as default"; Flags: postinstall shellexec skipifsilent runasoriginaluser; Tasks: setdefault

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\com.local.markdownviewer"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  EulaDir:  String;
  EulaFile: String;
  EulaText: AnsiString;
begin
  if CurStep = ssPostInstall then begin
    // Notify shell of association changes (WM_SETTINGCHANGE = $001A — Inno
    // Pascal doesn't predefine the Win32 message constants, so use the raw
    // value).
    SendBroadcastMessage($001A, 0, 0);

    // Pre-populate the runtime EULA marker so the app's first-run license
    // dialog is skipped for installer-based installs (the user already
    // accepted on the License Agreement wizard page above).
    // Path must match eulaUserDataDir() / EULA_VERSION in src/bun/index.ts.
    EulaDir  := ExpandConstant('{userappdata}\MarkdownViewer');
    EulaFile := EulaDir + '\eula-accepted-v1';
    if not DirExists(EulaDir) then ForceDirectories(EulaDir);
    EulaText := AnsiString(GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':')
                + ' (accepted via Inno Setup installer)');
    SaveStringToFile(EulaFile, EulaText, False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  EulaFile: String;
begin
  if CurUninstallStep = usPostUninstall then begin
    // Remove the EULA marker on uninstall so a future reinstall re-prompts.
    EulaFile := ExpandConstant('{userappdata}\MarkdownViewer\eula-accepted-v1');
    if FileExists(EulaFile) then DeleteFile(EulaFile);
    RemoveDir(ExpandConstant('{userappdata}\MarkdownViewer'));
  end;
end;
