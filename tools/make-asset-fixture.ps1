# Build a throwaway asset-library fixture project.
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 script as
# ANSI, so any non-ASCII literal in this file would be mangled into a mojibake
# path. Every non-ASCII value (folder names, tags) arrives as a parameter from
# the caller, which the OS passes as UTF-16 and therefore arrives intact.
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$NonAsciiFolder = 'covers'
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
foreach ($dir in @("assets\images\$NonAsciiFolder", 'assets\video', 'assets\audio', 'assets\deep\nested', 'assets\.git\objects', '.hidden')) {
    New-Item -ItemType Directory -Path (Join-Path $Root $dir) -Force | Out-Null
}

function New-Png([string]$Path, [int]$Width, [int]$Height, [string]$Color) {
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.Point(0, 0)),
            (New-Object System.Drawing.Point($Width, $Height)),
            [System.Drawing.ColorTranslator]::FromHtml($Color),
            [System.Drawing.Color]::White)
        $g.FillRectangle($brush, 0, 0, $Width, $Height)
        $g.Dispose()
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        return
    }
    catch {
        $bytes = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==')
        [System.IO.File]::WriteAllBytes($Path, $bytes)
    }
}

function New-Wav([string]$Path, [double]$Seconds = 1.0) {
    $rate = 8000
    $samples = [int]($rate * $Seconds)
    $stream = [System.IO.File]::Create($Path)
    $writer = New-Object System.IO.BinaryWriter($stream)
    $dataSize = $samples * 2
    $writer.Write([char[]]'RIFF'); $writer.Write([int](36 + $dataSize)); $writer.Write([char[]]'WAVE')
    $writer.Write([char[]]'fmt '); $writer.Write([int]16); $writer.Write([int16]1); $writer.Write([int16]1)
    $writer.Write([int]$rate); $writer.Write([int]($rate * 2)); $writer.Write([int16]2); $writer.Write([int16]16)
    $writer.Write([char[]]'data'); $writer.Write([int]$dataSize)
    for ($i = 0; $i -lt $samples; $i++) {
        $writer.Write([int16]([math]::Sin(2 * [math]::PI * 440 * $i / $rate) * 12000))
    }
    $writer.Dispose(); $stream.Dispose()
}

New-Png (Join-Path $Root 'assets\images\cover.png') 640 360 '#1f6feb'
New-Png (Join-Path $Root 'assets\images\portrait.png') 360 640 '#d93025'
New-Png (Join-Path $Root "assets\images\$NonAsciiFolder\banana.png") 320 320 '#f9ab00'
New-Png (Join-Path $Root 'assets\deep\nested\extra.png') 200 200 '#188038'
New-Png (Join-Path $Root '.hidden\secret.png') 100 100 '#000000'
New-Png (Join-Path $Root 'assets\.git\objects\x.png') 100 100 '#000000'
New-Wav (Join-Path $Root 'assets\audio\theme.wav')

Set-Content -LiteralPath (Join-Path $Root 'assets\images\logo.svg') -Encoding UTF8 -Value '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#f9ab00"/></svg>'

# Placeholder containers: the scanner keys on extension; real playback is a browser concern.
[System.IO.File]::WriteAllBytes((Join-Path $Root 'assets\video\scene-01.mp4'), (New-Object byte[] 200000))
[System.IO.File]::WriteAllBytes((Join-Path $Root 'assets\video\scene-02.mov'), (New-Object byte[] 150000))
[System.IO.File]::WriteAllBytes((Join-Path $Root 'assets\audio\vo-01.mp3'), (New-Object byte[] 90000))

# Non-assets: must never appear in the library.
Set-Content -LiteralPath (Join-Path $Root 'assets\notes.txt') -Value 'not an asset'
Set-Content -LiteralPath (Join-Path $Root 'assets\images\readme.md') -Value 'not an asset'

$files = Get-ChildItem -LiteralPath $Root -Recurse -File
Write-Output ("fixture at {0}: {1} files, {2} bytes" -f $Root, $files.Count, ($files | Measure-Object -Property Length -Sum).Sum)
