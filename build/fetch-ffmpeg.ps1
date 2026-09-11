# Dev-only helper: fetch an ffmpeg binary for local development and testing.
#
# The app looks for a sidecar named emulsion-ffmpeg(.exe) next to the built
# executable (build/bin). Local development grabs a prebuilt third-party
# binary here; release builds compile their own minimal LGPL ffmpeg in CI
# (see .github/workflows/release.yml, job "ffmpeg-bundle") — do NOT ship this
# download in a release.
#
# Usage:  pwsh build/fetch-ffmpeg.ps1
param(
    [string]$Destination = "$PSScriptRoot\bin\emulsion-ffmpeg.exe"
)

$ErrorActionPreference = 'Stop'

# Pinned BtbN GPL build (dev only). Update by changing both the version and
# the SHA-256 below.
$ffmpegVersion = 'latest'
$downloadUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
$expectedHash = '' # optional; paste the zip's SHA-256 here to pin it

$destination = [System.IO.Path]::GetFullPath($Destination)
$binDir = Split-Path $destination -Parent
New-Item -ItemType Directory -Path $binDir -Force | Out-Null

if (Test-Path $destination) {
    Write-Output "emulsion-ffmpeg already exists: $destination"
    Write-Output "Delete it first to re-fetch."
    exit 0
}

$tempDir = Join-Path $env:TEMP "emulsion-ffmpeg-$(New-Guid)"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$zipPath = Join-Path $tempDir 'ffmpeg.zip'

try {
    Write-Output "Downloading $downloadUrl"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath

    if ($expectedHash) {
        $actualHash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
            throw "SHA-256 mismatch: expected $expectedHash, got $actualHash"
        }
    }

    Write-Output 'Extracting...'
    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force

    $ffmpeg = Get-ChildItem $tempDir -Recurse -File -Filter 'ffmpeg.exe' | Select-Object -First 1
    if (-not $ffmpeg) {
        throw 'ffmpeg.exe was not found inside the downloaded archive'
    }

    Copy-Item $ffmpeg.FullName $destination
    Write-Output "Installed: $destination"
    & $destination -hide_banner -version | Select-Object -First 1
}
finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
