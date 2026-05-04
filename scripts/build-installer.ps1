# build-installer.ps1 - Produce the single-file Windows installer
# (build\windows-installer\MarkdownViewerSetup.exe) end-to-end.
#
# What this does, in order:
#   1. Calls scripts\build-windows.ps1 -Stage (unless -SkipBuild)
#      -> builds the Electrobun stable app and extracts the tarball into
#         build\stable-win-x64-app\
#   2. Locates ISCC.exe (Inno Setup 6 compiler) in the standard paths
#   3. Runs `ISCC.exe windows\MarkdownViewerSetup.iss`
#   4. Reports the final artifact path, size, and SHA-256
#
# Run from PowerShell (PS 5.1 or 7+) at the project root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1
#
# Optional flags:
#   -SkipBuild              skip step 1; assume build\stable-win-x64-app\ is current
#   -SkipBunInstall         forwarded to build-windows.ps1
#   -InnoSetupPath <path>   override ISCC.exe location
#
# Prerequisites:
#   - Bun (auto-installed by build-windows.ps1 if missing)
#   - Inno Setup 6:  winget install --id JRSoftware.InnoSetup
#   - A zstd-capable extractor (winget install Facebook.Zstandard) OR
#     7-Zip OR an existing local Electrobun build with bin\zig-zstd.exe
#
# This script does NOT install the app on the current machine; its only
# output is the standalone .exe under build\windows-installer\.

param(
    [switch]$SkipBuild,
    [switch]$SkipBunInstall,
    [string]$InnoSetupPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

Write-Host "==> Markdown Viewer - Windows installer" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"

# --- 1. Build + stage ---
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "==> Step 1/3: build + stage" -ForegroundColor Cyan
    # Hash splatting is the only reliable way to forward named parameters
    # (PS 5.1 array splatting is fragile when forwarding a single -Switch).
    $buildArgs = @{ Stage = $true }
    if ($SkipBunInstall) { $buildArgs.SkipBunInstall = $true }
    & (Join-Path $PSScriptRoot "build-windows.ps1") @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "build-windows.ps1 failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "==> Step 1/3: SKIPPED (-SkipBuild)" -ForegroundColor Yellow
}

$stagingDir = Join-Path $ProjectRoot "build\stable-win-x64-app"
if (-not (Test-Path $stagingDir)) {
    throw "Staging dir missing: $stagingDir - run without -SkipBuild first"
}
$launcher = Join-Path $stagingDir "bin\launcher.exe"
if (-not (Test-Path $launcher)) {
    throw "Staged app is incomplete (no bin\launcher.exe) - re-run without -SkipBuild"
}

# --- 2. Locate ISCC.exe ---
Write-Host ""
Write-Host "==> Step 2/3: locate Inno Setup 6 compiler" -ForegroundColor Cyan

function Find-ISCC {
    param([string]$Override)
    if ($Override) {
        if (Test-Path $Override) { return $Override }
        throw "ISCC.exe not found at -InnoSetupPath: $Override"
    }
    $candidates = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

$ISCC = Find-ISCC -Override $InnoSetupPath
if (-not $ISCC) {
    throw @"
Inno Setup 6 not found. Install it:
  winget install --id JRSoftware.InnoSetup --accept-source-agreements --accept-package-agreements
...or download from https://jrsoftware.org/isinfo.php
...or pass -InnoSetupPath 'C:\path\to\ISCC.exe'
"@
}
Write-Host ("    ISCC path: {0}" -f $ISCC)

# --- 3. Compile installer ---
Write-Host ""
Write-Host "==> Step 3/3: compile installer" -ForegroundColor Cyan
$iss = Join-Path $ProjectRoot "windows\MarkdownViewerSetup.iss"
if (-not (Test-Path $iss)) { throw "Missing $iss" }

$logFile = Join-Path $ProjectRoot "build\_iscc.log"
& $ISCC $iss 2>&1 | Tee-Object -FilePath $logFile | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ISCC failed - last 20 lines of $logFile :" -ForegroundColor Red
    Get-Content $logFile -Tail 20
    throw "ISCC.exe exited $LASTEXITCODE"
}

# --- Report ---
$out = Join-Path $ProjectRoot "build\windows-installer\MarkdownViewerSetup.exe"
if (-not (Test-Path $out)) {
    throw "ISCC succeeded but no .exe at $out - check $logFile for OutputDir/OutputBaseFilename"
}
$f = Get-Item $out
$hash = (Get-FileHash $out -Algorithm SHA256).Hash
$ver = $f.VersionInfo

$bar = "=" * 64
Write-Host ""
Write-Host $bar -ForegroundColor Green
Write-Host "  MarkdownViewerSetup.exe - READY" -ForegroundColor Green
Write-Host $bar -ForegroundColor Green
Write-Host ("  Path:           {0}" -f $f.FullName)
Write-Host ("  Size:           {0:N0} bytes  ({1:N1} MB)" -f $f.Length, ($f.Length / 1MB))
Write-Host ("  Created:        {0}" -f $f.LastWriteTime)
Write-Host ("  Product ver:    {0}" -f $ver.ProductVersion.Trim())
Write-Host ("  Company:        {0}" -f $ver.CompanyName.Trim())
Write-Host ("  SHA-256:        {0}" -f $hash)
Write-Host $bar -ForegroundColor Green
Write-Host ""
Write-Host "Distribute this .exe to end users. They double-click it; it shows"
Write-Host "the EULA screen, registers .md/.markdown/etc., installs to"
Write-Host "%LOCALAPPDATA%\Programs\MarkdownViewer\, and adds an Add/Remove"
Write-Host "Programs entry."
