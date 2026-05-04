# build-windows.ps1 - Build the Markdown Viewer for Windows.
#
# Run from PowerShell (PS 5.1 or 7+) at the project root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
#
# Optional flags:
#   -SkipBunInstall   skip the auto-install of Bun if missing
#   -Env <dev|canary|stable>   build environment (default: stable)
#   -Stage            also extract the stable tarball into a flat
#                     build\stable-win-x64-app\ tree consumable by
#                     windows\MarkdownViewerSetup.iss. Default: $true when
#                     -Env is stable, $false otherwise.
#   -NoStage          force-disable staging (overrides the default).
#
# This script does NOT install or register the app. After the build finishes
# you'll find the .exe under build\stable-win-x64\. Run install-windows.ps1
# to copy it to %LOCALAPPDATA% and register the file associations, or run
# scripts\build-installer.ps1 to produce a single MarkdownViewerSetup.exe.

param(
    [switch]$SkipBunInstall,
    [string]$Env = "stable",
    [switch]$Stage,
    [switch]$NoStage
)

# Default -Stage to ON for stable env unless -NoStage is set
if (-not $NoStage -and -not $PSBoundParameters.ContainsKey('Stage') -and $Env -eq "stable") {
    $Stage = $true
}
if ($NoStage) { $Stage = $false }

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

Write-Host "==> Markdown Viewer - Windows build" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"
Write-Host "Build env:    $Env"

# --- Ensure Bun ---
# Bun installs as either a raw bun.exe (Bun's own installer puts it under
# %USERPROFILE%\.bun\bin) OR as a bun.ps1 shim (npm-based install puts it
# under %APPDATA%\npm). Get-Command without the .exe suffix matches both.
function Ensure-Bun {
    $bun = Get-Command bun -ErrorAction SilentlyContinue
    if ($bun) {
        Write-Host "Bun: $(bun --version)"
        return
    }
    if ($SkipBunInstall) { throw "Bun not found and -SkipBunInstall set" }
    Write-Host "Bun not found. Installing..." -ForegroundColor Yellow
    # The official URL moved between bun.sh and bun.com over time; try both.
    $installed = $false
    foreach ($url in @("https://bun.sh/install.ps1", "https://bun.com/install.ps1")) {
        try {
            & powershell.exe -NoProfile -Command "irm $url | iex"
            $installed = $true
            break
        } catch { Write-Warning "Bun install via $url failed: $_" }
    }
    if (-not $installed) { throw "Bun install failed. Install manually from https://bun.sh" }
    $bunDir = Join-Path $env:USERPROFILE ".bun\bin"
    if (-not (Test-Path (Join-Path $bunDir "bun.exe"))) {
        throw "Bun install completed but bun.exe not at $bunDir"
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
    Write-Warning "Build output not found at $buildDir - searching..."
    $found = Get-ChildItem (Join-Path $ProjectRoot "build") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$Env-win*" } | Select-Object -First 1
    if ($found) { $buildDir = $found.FullName }
}

if (-not (Test-Path $buildDir)) { throw "Build failed - no output directory found." }

Write-Host ""
Write-Host "==> Build complete: $buildDir" -ForegroundColor Green
Get-ChildItem $buildDir | Format-Table Name, Length, LastWriteTime

# ---------------------------------------------------------------------------
# Stage the unpacked app for Inno Setup
#
# Stable Electrobun builds pack the runnable into Resources\<hash>.tar.zst -
# that layout is meant to be unpacked at install time by Electrobun's own
# Setup extractor. Inno Setup needs the unpacked tree on disk before the
# .iss can be compiled, so we extract the tarball into a sibling directory.
#
# The resulting tree mirrors the dev build's shape:
#   build\stable-win-x64-app\
#     Info.plist
#     bin\launcher.exe, bun.exe, *.dll
#     Resources\app\... (renderer + bun bundles)
#
# zstd dependency: we try zstd.exe -> 7z.exe -> an existing local Electrobun
# build's bin\zig-zstd.exe (dev/canary/stable subdir). Hard-error otherwise.
# ---------------------------------------------------------------------------
function Find-Zstd {
    $z = Get-Command zstd.exe -ErrorAction SilentlyContinue
    if ($z) { return @{ Tool = "zstd";  Path = $z.Source } }

    $sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if ($sevenZip) { return @{ Tool = "7z"; Path = $sevenZip.Source } }

    $candidates = Get-ChildItem (Join-Path $ProjectRoot "build") -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter "zig-zstd.exe" -ErrorAction SilentlyContinue }
    if ($candidates) {
        return @{ Tool = "zig-zstd"; Path = ($candidates | Select-Object -First 1).FullName }
    }
    return $null
}

function Expand-StableApp {
    param([string]$BuildDir, [string]$StageDir)

    $tarballs = Get-ChildItem (Join-Path $BuildDir "MarkdownViewer\Resources") -Filter "*.tar.zst" -ErrorAction SilentlyContinue
    if (-not $tarballs) {
        throw "No .tar.zst found under $BuildDir\MarkdownViewer\Resources - is this a stable build?"
    }
    $tarball = $tarballs | Select-Object -First 1
    Write-Host "    Tarball: $($tarball.FullName) ($([math]::Round($tarball.Length/1MB,1)) MB compressed)"

    $zstd = Find-Zstd
    if (-not $zstd) {
        throw @"
Cannot find a zstd-capable extractor. Install one:
  winget install Facebook.Zstandard      (~600 KB, recommended)
  winget install 7zip.7zip               (~2 MB, also handles .tar.zst)
...or run a -Env=dev build first so a bundled zig-zstd.exe is available locally.
"@
    }
    Write-Host "    Extractor: $($zstd.Tool) @ $($zstd.Path)"

    if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
    New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
    $tempTar = Join-Path $env:TEMP ("mdv-stable-{0}.tar" -f [guid]::NewGuid().ToString("N"))

    try {
        switch ($zstd.Tool) {
            "zstd"     { & $zstd.Path -d -f -o $tempTar $tarball.FullName | Out-Null }
            "zig-zstd" { & $zstd.Path decompress -i $tarball.FullName -o $tempTar --no-timing | Out-Null }
            "7z"       {
                # 7-Zip extracts .tar.zst -> .tar in one pass when given the right args
                $tempDir = Join-Path $env:TEMP ("mdv-7z-{0}" -f [guid]::NewGuid().ToString("N"))
                New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
                & $zstd.Path x -y -o"$tempDir" $tarball.FullName | Out-Null
                $extracted = Get-ChildItem $tempDir -Filter "*.tar" | Select-Object -First 1
                if (-not $extracted) { throw "7z extraction did not produce a .tar file" }
                Move-Item $extracted.FullName $tempTar
                Remove-Item $tempDir -Recurse -Force
            }
        }
        if (-not (Test-Path $tempTar)) { throw "Decompression produced no output" }

        # Use BSD tar (Win10 1803+) - handles plain .tar fine
        & tar.exe -xf $tempTar -C $StageDir
        if ($LASTEXITCODE -ne 0) { throw "tar extraction failed (exit $LASTEXITCODE)" }
    } finally {
        if (Test-Path $tempTar) { Remove-Item $tempTar -Force }
    }

    # Inner MarkdownViewer\ from the tarball IS the runnable app.
    # Hoist its contents to $StageDir root so the .iss source path is clean.
    $inner = Join-Path $StageDir "MarkdownViewer"
    if (Test-Path $inner) {
        Get-ChildItem $inner | Move-Item -Destination $StageDir -Force
        Remove-Item $inner -Recurse -Force
    }

    $launcher = Join-Path $StageDir "bin\launcher.exe"
    if (-not (Test-Path $launcher)) {
        throw "Staged tree is missing bin\launcher.exe - Electrobun layout may have changed"
    }
    Write-Host "    Staged: $StageDir ($([math]::Round((Get-ChildItem $StageDir -Recurse | Measure-Object -Property Length -Sum).Sum/1MB,1)) MB unpacked)"
}

if ($Stage) {
    Write-Host ""
    Write-Host "==> Staging unpacked app for Inno Setup" -ForegroundColor Cyan
    $stageDir = Join-Path $ProjectRoot "build\$Env-win-x64-app"
    Expand-StableApp -BuildDir $buildDir -StageDir $stageDir
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  Install + register:   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1"
if ($Stage) {
    Write-Host "  Compile installer:   powershell -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -SkipBuild"
} else {
    Write-Host "  Compile installer:   powershell -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1"
}
