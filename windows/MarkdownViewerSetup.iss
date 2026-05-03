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
#define MyAppVersion     "1.0.0"
#define MyAppPublisher   "Local"
#define MyAppExeName     "Markdown Viewer.exe"
#define MyAppId          "com.local.markdownviewer"
#define MyAppProgId      "MarkdownViewer.MarkdownDocument"
#define MyAppSourceDir   "..\build\stable-win-x64"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
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
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";   Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "associatemd";   Description: "Associate &Markdown files (.md, .markdown, .mdown, .mkd, .mkdn, .mdx) with {#MyAppName}"; GroupDescription: "File associations:"; Flags: checkedonce
Name: "setdefault";    Description: "&Open the Default Apps page after install so I can set {#MyAppName} as my default"; GroupDescription: "File associations:"; Flags: unchecked

[Files]
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; ProgID
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}";              ValueType: string; ValueName: "";                ValueData: "Markdown Document"; Flags: uninsdeletekey; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\DefaultIcon";  ValueType: string; ValueName: "";                ValueData: """{app}\{#MyAppExeName}"",0"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\shell\open";   ValueType: string; ValueName: "";                ValueData: "Open"; Tasks: associatemd
Root: HKCU; Subkey: "Software\Classes\{#MyAppProgId}\shell\open\command"; ValueType: string; ValueName: "";          ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: associatemd

; App registration
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#MyAppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""
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
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Native markdown viewer with Mermaid/C4 diagrams"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".md";       ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".markdown"; ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mdown";    ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mkd";      ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mkdn";     ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\{#MyAppName}\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mdx";      ValueData: "{#MyAppProgId}"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: "Software\{#MyAppName}\Capabilities"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: postinstall nowait skipifsilent
Filename: "ms-settings:defaultapps"; Description: "Open Default Apps to set {#MyAppName} as default"; Flags: postinstall shellexec skipifsilent runasoriginaluser; Tasks: setdefault

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\com.local.markdownviewer"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    // Notify shell of association changes
    SendBroadcastMessage(WM_SETTINGCHANGE, 0, 0);
  end;
end;
