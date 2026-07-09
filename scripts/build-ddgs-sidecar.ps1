<#
.SYNOPSIS
    Build the Zeus ddgs sidecar (Windows native entry point for build-ddgs-sidecar.sh).

.DESCRIPTION
    Wraps PyInstaller to produce a single-file ddgs.exe that bundles
    Python + ddgs + curl-cffi. Output is named to satisfy Tauri's
    sidecar convention: src-tauri/binaries/ddgs-<target-triple>.exe.

    OPT-IN: this script does nothing unless ZEUS_BUNDLE_DDGS=1 is set.
    The ddgs sidecar is not part of the default Zeus install — it ships
    ~50 MB of Python + dependencies. Most users get a working webSearch
    either by installing ddgs via `pip install ddgs` (auto-detected at
    runtime) or by pointing ZEUS_SEARXNG_URL at a self-hosted SearXNG.
    The bundling is for environments where neither is feasible.

.PARAMETER TargetTriple
    Tauri target triple. Defaults to x86_64-pc-windows-msvc.
#>
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"

if ($env:ZEUS_BUNDLE_DDGS -ne "1") {
    Write-Host "ddgs sidecar build is opt-in. Set ZEUS_BUNDLE_DDGS=1 to enable."
    Write-Host "  `$env:ZEUS_BUNDLE_DDGS=1; npm run sidecar:build:win"
    Write-Host "Without the sidecar, webSearch falls back to a pip-installed ddgs"
    Write-Host "(if on PATH) or SearXNG (if ZEUS_SEARXNG_URL is set), then the"
    Write-Host "raw DuckDuckGo HTML scrape (likely bot-challenged on consumer IPs)."
    exit 0
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$Entry     = Join-Path $ScriptDir "ddgs_sidecar_entry.py"
$OutDir    = Join-Path $RepoRoot "src-tauri\binaries"
$OutName   = "ddgs"

if (-not (Test-Path $Entry)) { throw "missing $Entry" }
$py = (Get-Command python -ErrorAction Stop).Source

# Install PyInstaller if missing.
& $py -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
    & $py -m pip install --quiet pyinstaller
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stage = Join-Path $OutDir "_stage"
$work  = Join-Path $OutDir "_work"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
if (Test-Path $work)  { Remove-Item -Recurse -Force $work  }

# PyInstaller flags:
#   --onefile       bundle python + ddgs + curl-cffi into one exe
#   --name          output base name
#   --distpath      where --onefile drops the final exe
#   --workpath      scratch (extracted files during build)
#   --specpath      .spec file location
#   --noconfirm     overwrite without prompting
#   --clean         purge caches before build
& $py -m PyInstaller `
    --onefile `
    --name $OutName `
    --distpath $stage `
    --workpath $work `
    --specpath $work `
    --noconfirm `
    --clean `
    $Entry

$sidecarExe = "ddgs-$TargetTriple.exe"
$built = Join-Path $stage "$OutName.exe"
Move-Item -Force $built (Join-Path $OutDir $sidecarExe)
Remove-Item -Recurse -Force $stage, $work

Write-Host "wrote $OutDir\$sidecarExe"
Get-ChildItem (Join-Path $OutDir $sidecarExe) | Select-Object Name, Length