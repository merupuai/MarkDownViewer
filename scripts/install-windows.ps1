# install-windows.ps1 — Install Markdown Viewer to %LOCALAPPDATA% and register
# file associations for .md / .markdown / .mdown / .mkd / .mkdn / .mdx.
#
# This is a per-user install — no admin rights required. The app shows up
# in Open With > Choose another app and the user can select "Always" to
# make it the default.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
#
# Flags:
#   -BuildFirst      Run scripts\build-windows.ps1 before installing
#   -InstallDir <d>  Override install location (default: %LOCALAPPDATA%\Programs\MarkdownViewer)
#   -Uninstall       Remove the app and its registry entries
#   -SetDefault      Open Windows' Default Apps page so you can set as default
#                    (Windows 10/11 require user confirmation per UserChoice ACL)

param(
    [switch]$BuildFirst,
    [string]$InstallDir = "",
    [switch]$Uninstall,
    [switch]$SetDefault
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

$AppName = "Markdown Viewer"
$ProgId  = "MarkdownViewer.MarkdownDocument"
$ExeName = "Markdown Viewer.exe"
$Exts    = @(".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx")

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\MarkdownViewer"
}

function Remove-Registration {
    Write-Host "==> Removing registry entries (HKCU)" -ForegroundColor Cyan
    Remove-Item -Path "HKCU:\Software\Classes\$ProgId" -Recurse -ErrorAction SilentlyContinue
    Remove-Item -Path "HKCU:\Software\Classes\Applications\$ExeName" -Recurse -ErrorAction SilentlyContinue
    foreach ($ext in $Exts) {
        Remove-Item -Path "HKCU:\Software\Classes\$ext\OpenWithProgids" -Recurse -ErrorAction SilentlyContinue
    }
    Remove-Item -Path "HKCU:\Software\$AppName" -Recurse -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "HKCU:\Software\RegisteredApplications" -Name $AppName -ErrorAction SilentlyContinue
}

if ($Uninstall) {
    Write-Host "==> Uninstalling Markdown Viewer" -ForegroundColor Cyan
    Get-Process | Where-Object { $_.Path -like "$InstallDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Registration
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
        Write-Host "Removed $InstallDir"
    }
    $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk"
    Remove-Item $startMenu -ErrorAction SilentlyContinue
    Write-Host "Uninstalled." -ForegroundColor Green
    exit 0
}

# 1) Build if requested
if ($BuildFirst) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build-windows.ps1")
}

# 2) Locate build output
$buildDir = Join-Path $ProjectRoot "build\stable-win-x64"
if (-not (Test-Path $buildDir)) {
    $found = Get-ChildItem (Join-Path $ProjectRoot "build") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "stable-win*" } | Select-Object -First 1
    if ($found) { $buildDir = $found.FullName }
}
if (-not (Test-Path $buildDir)) {
    throw "Build output not found. Run with -BuildFirst, or run scripts\build-windows.ps1 first."
}

# 3) Stop any running instances
Get-Process -Name "Markdown Viewer", "bun" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$InstallDir*" -or $_.MainWindowTitle -like "*Markdown Viewer*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 4) Copy build output to install dir
Write-Host "==> Installing to $InstallDir" -ForegroundColor Cyan
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
New-Item -ItemType Directory -Path $InstallDir | Out-Null
Copy-Item -Recurse "$buildDir\*" $InstallDir
$exePath = Join-Path $InstallDir $ExeName
if (-not (Test-Path $exePath)) {
    # Electrobun may name the exe slightly differently (e.g. with channel suffix).
    $found = Get-ChildItem $InstallDir -Filter "*.exe" | Select-Object -First 1
    if ($found) {
        $exePath = $found.FullName
        $ExeName = $found.Name
    } else {
        throw "No .exe found in $InstallDir"
    }
}
Write-Host "Installed: $exePath"

# 5) Register file associations (per-user, no admin)
Write-Host "==> Registering file associations" -ForegroundColor Cyan

$progIdKey = "HKCU:\Software\Classes\$ProgId"
New-Item -Path $progIdKey -Force | Out-Null
Set-ItemProperty -Path $progIdKey -Name "(Default)" -Value "Markdown Document"

$iconKey = "$progIdKey\DefaultIcon"
New-Item -Path $iconKey -Force | Out-Null
Set-ItemProperty -Path $iconKey -Name "(Default)" -Value "`"$exePath`",0"

$cmdKey = "$progIdKey\shell\open\command"
New-Item -Path $cmdKey -Force | Out-Null
Set-ItemProperty -Path $cmdKey -Name "(Default)" -Value "`"$exePath`" `"%1`""

# Friendly app name for shell
$appKey = "HKCU:\Software\Classes\Applications\$ExeName"
New-Item -Path $appKey -Force | Out-Null
Set-ItemProperty -Path $appKey -Name "FriendlyAppName" -Value $AppName
$appCmdKey = "$appKey\shell\open\command"
New-Item -Path $appCmdKey -Force | Out-Null
Set-ItemProperty -Path $appCmdKey -Name "(Default)" -Value "`"$exePath`" `"%1`""
$supportedKey = "$appKey\SupportedTypes"
New-Item -Path $supportedKey -Force | Out-Null
foreach ($ext in $Exts) { Set-ItemProperty -Path $supportedKey -Name $ext -Value "" }

# Register each extension's OpenWithProgIds
foreach ($ext in $Exts) {
    $extKey = "HKCU:\Software\Classes\$ext\OpenWithProgids"
    New-Item -Path $extKey -Force | Out-Null
    Set-ItemProperty -Path $extKey -Name $ProgId -Value ([byte[]]@()) -Type Binary
}

# RegisteredApplications + Capabilities (so the app appears in Default Apps)
$capKey = "HKCU:\Software\$AppName\Capabilities"
New-Item -Path $capKey -Force | Out-Null
Set-ItemProperty -Path $capKey -Name "ApplicationName"        -Value $AppName
Set-ItemProperty -Path $capKey -Name "ApplicationDescription" -Value "Native markdown viewer with Mermaid/C4 diagrams"
$capFa = "$capKey\FileAssociations"
New-Item -Path $capFa -Force | Out-Null
foreach ($ext in $Exts) { Set-ItemProperty -Path $capFa -Name $ext -Value $ProgId }
$regAppsKey = "HKCU:\Software\RegisteredApplications"
New-Item -Path $regAppsKey -Force | Out-Null
Set-ItemProperty -Path $regAppsKey -Name $AppName -Value "Software\$AppName\Capabilities"

# 6) Start Menu shortcut
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($startMenu)
$shortcut.TargetPath  = $exePath
$shortcut.WorkingDirectory = $InstallDir
$shortcut.IconLocation = "$exePath,0"
$shortcut.Save()
Write-Host "Created Start Menu shortcut: $startMenu"

# 7) Tell shell to refresh icons / associations
$signature = '[DllImport("Shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
$type = Add-Type -MemberDefinition $signature -Name Win32SHChangeNotify -Namespace Win32Functions -PassThru
$type::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) # SHCNE_ASSOCCHANGED

Write-Host ""
Write-Host "Installed successfully!" -ForegroundColor Green
Write-Host "  • Right-click any .md file in Explorer -> Open With -> Markdown Viewer"
Write-Host "  • To make it the default: right-click .md -> Open With -> Choose another app -> Markdown Viewer -> [x] Always use this app"

if ($SetDefault) {
    Write-Host ""
    Write-Host "Opening Default Apps settings (set Markdown Viewer as default for .md)..."
    Start-Process "ms-settings:defaultapps"
}
