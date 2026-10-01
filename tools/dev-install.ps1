# Sync this plugin into a dsh profile's node_modules as a REAL directory.
#
# Why a copy instead of a symlink/junction:
#   Node resolves bare specifiers after realpath. When the plugin is a junction
#   into the workspace, the real path lands outside the profile and packages that
#   ship with the dsh installation (e.g. @deepseek-ai/schemastery) no longer
#   resolve: DS H's chain is <profile>/node_modules -> <DSH_HOME>/profiles/node_modules
#   (the installation-scope projection). Official plugins installed from npm are
#   real directories, which is why they work.
#
# Usage:
#   powershell -File tools/dev-install.ps1
#   powershell -File tools/dev-install.ps1 -DshHome C:\Users\Administrator\.dsh -Profile desktop
param(
    [string]$DshHome = 'C:\Users\Administrator\.dsh-dev',
    [string]$Profile = 'assetdev',
    [string]$ProjectionDonor = 'C:\Users\Administrator\.dsh\profiles\node_modules',
    [switch]$SkipProjection
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\dsh-asset-library'

if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile does not exist: $profileDir (create it with: dsh --profile $Profile --from-default-profile web --help)"
}

# Remove only the link itself; never recurse into a junction (that would delete
# the workspace sources it points at).
function Remove-LinkOrDirectory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        & cmd.exe /c rmdir "$Path" | Out-Null
    }
    else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

# The desktop app keeps a projection of the installation's own packages at
# <DSH_HOME>\profiles\node_modules. A profile created straight from the CLI has
# none, so link one in from a home that does.
# The desktop app provides the installation's own packages itself, so a profile
# that is managed by the app (e.g. the Electron desktop profile) needs no
# projection. Pass -SkipProjection for those; only CLI-created dev profiles need
# one linked in from a home that has it.
$projection = Join-Path $DshHome 'profiles\node_modules'
if ($SkipProjection) {
    Write-Output "skip projection (app-managed profile provides its own packages)"
}
elseif (-not (Test-Path -LiteralPath $projection)) {
    if (-not (Test-Path -LiteralPath $ProjectionDonor)) { throw "projection donor missing: $ProjectionDonor" }
    New-Item -ItemType Junction -Path $projection -Target $ProjectionDonor | Out-Null
    Write-Output "created projection: $projection -> $ProjectionDonor"
}

Remove-LinkOrDirectory $target
New-Item -ItemType Directory -Path $target -Force | Out-Null

foreach ($file in @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md')) {
    $from = Join-Path $source $file
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $target $file) -Force }
}
foreach ($dir in @('lib', 'locale', 'tools')) {
    $from = Join-Path $source $dir
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $target $dir) -Recurse -Force }
}

$count = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object).Count
Write-Output "synced $count files -> $target"
