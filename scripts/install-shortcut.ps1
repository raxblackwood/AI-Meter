# Adds "AI Meter" to the Windows Start menu, so it can be found with Windows search and pinned.
# Run with `npm run install-shortcut`. The shortcut starts the app from this folder; running it while the
# app is already open just brings the dashboard back.
$repo = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $repo "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "Electron is not installed yet. Run npm install first." }

$programs = [Environment]::GetFolderPath("Programs")
$link = Join-Path $programs "AI Meter.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $electron
$shortcut.Arguments = "`"$repo`""
$shortcut.WorkingDirectory = $repo
$shortcut.IconLocation = (Join-Path $repo "app\icon.ico") + ",0"
$shortcut.Description = "AI Meter: Claude and Antigravity usage at a glance"
$shortcut.Save()
"Added: $link"
