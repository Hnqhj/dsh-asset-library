# Sync the workspace plugin into EVERY profile that runs it.
#
# The plugin is installed as a real directory (file: spec copies it), so updating
# the workspace sources does nothing for installed profiles until they are synced.
# This is the one-liner to run after every change:
#
#   powershell -File tools/sync-all.ps1
#
# Remember: the host half (lib/*.js) needs a process restart of whichever app
# uses the profile; the client half (client.js) just needs a window reload.
param(
    [string]$DevHome = 'C:\Users\Administrator\.dsh-dev',
    [string]$DevProfile = 'assetdev',
    [string]$DesktopHome = 'C:\Users\Administrator\.dsh',
    [string]$DesktopProfile = 'desktop'
)

$ErrorActionPreference = 'Continue'
$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\dev-install.ps1'

Write-Output "== dev profile ($DevHome / $DevProfile) =="
& powershell -NoProfile -ExecutionPolicy Bypass -File $script -DshHome $DevHome -Profile $DevProfile

if (Test-Path -LiteralPath (Join-Path $DesktopHome "profiles\$DesktopProfile")) {
    Write-Output "== desktop profile ($DesktopHome / $DesktopProfile) =="
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script -DshHome $DesktopHome -Profile $DesktopProfile
}
else {
    Write-Output "skip: desktop profile not found at $DesktopHome\profiles\$DesktopProfile"
}
