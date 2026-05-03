# build-windows.ps1 — Build the Markdown Viewer for Windows.
#
# Run from PowerShell (PS 5.1 or 7+) at the project root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
#
# Optional flags:
#   -SkipBunInstall   skip the auto-install of Bun if missing
#   -Env <dev|canary|stable>   build environment (default: stable)
#
# This script does NOT install or register the app. After the build finishes
# you'll find the .exe under build\stable-win-x64\. Run install-windows.ps1
# to copy it to %LOCALAPPDATA% and register the file associations.

param(
    [switch]$SkipBunInstall,
    [string]$Env = "stable"
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

Write-Host "==> Markdown Viewer — Windows build" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"
Write-Host "Build env:    $Env"

# --- Ensure Bun ---
function Ensure-Bun {
    $bun = Get-Command bun.exe -ErrorAction SilentlyContinue
    if ($bun) {
        Write-Host "Bun: $(bun --version)"
        return
    }
    if ($SkipBunInstall) { throw "Bun not found and -SkipBunInstall set" }
    Write-Host "Bun not found. Installing..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -Command "irm bun.com/install.ps1 | iex"
    $bunDir = Join-Path $env:USERPROFILE ".bun\bin"
    if (-not (Test-Path (Join-Path $bunDir "bun.exe"))) {
        throw "Bun install failed. Install manually from https://bun.sh"
    }
    $env:Path = "$bunDir;$env:Path"
    Write-Host "Bun: $(bun --version)"
}
Ensure-Bun

# --- Install dependencies ---
if (-not (Test-Path "node_modules")) {
    Write-Host "==> Installing npm dependencies" -ForegroundColor Cyan
    bun install
}

# --- Build ---
Write-Host "==> Running electrobun build --env=$Env" -ForegroundColor Cyan
bun x electrobun build "--env=$Env"

$buildDir = Join-Path $ProjectRoot "build\$Env-win-x64"
if (-not (Test-Path $buildDir)) {
    Write-Warning "Build output not found at $buildDir — searching..."
    $found = Get-ChildItem (Join-Path $ProjectRoot "build") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$Env-win*" } | Select-Object -First 1
    if ($found) { $buildDir = $found.FullName }
}

if (-not (Test-Path $buildDir)) { throw "Build failed — no output directory found." }

Write-Host ""
Write-Host "==> Build complete: $buildDir" -ForegroundColor Green
Get-ChildItem $buildDir | Format-Table Name, Length, LastWriteTime

Write-Host ""
Write-Host "Next steps:"
Write-Host "  Install + register:   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1"
Write-Host "  Or build an installer: see windows\MarkdownViewerSetup.iss (Inno Setup)"
