/**
 * Keeps Orca's CDP port open across restarts.
 *
 * Orca launches the plugin, so a plugin can never add a flag to its own host's
 * current process. What it CAN do is make the flag survive: every shortcut that
 * launches Orca gets `--remote-debugging-port=<port>` appended, so the next
 * normal launch comes up with the renderer debuggable.
 *
 * SECURITY: this is a deliberate, persistent weakening. An open CDP port lets
 * any local process drive Orca's renderer with full privileges - read tokens
 * out of the app, click things, exfiltrate. It is the price of a status-bar
 * chip, because Orca exposes no contribution point for one. `disable()` puts
 * every shortcut back.
 */

import { execFile } from 'node:child_process'

const FLAG = '--remote-debugging-port'

function powershell(script, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message))
        resolve(stdout.trim())
      })
  })
}

/** PowerShell that walks Orca shortcuts and applies `mutate` to their args. */
function shortcutScript(mutate) {
  return `
$ErrorActionPreference = 'Stop'
$roots = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:USERPROFILE\\Desktop",
  "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"
)
$sh = New-Object -ComObject WScript.Shell
$changed = @()
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk = $sh.CreateShortcut($_.FullName)
    if ($lnk.TargetPath -like "*orca*Orca.exe") {
      $old = $lnk.Arguments
      ${mutate}
      if ($new -ne $old) { $lnk.Arguments = $new; $lnk.Save(); $changed += $_.FullName }
    }
  }
}
$changed -join "\`n"`
}

/**
 * Appends the debug flag to every Orca shortcut that lacks it.
 * Returns the shortcut paths actually modified.
 */
export async function enable(port = 9222) {
  const mutate = `
      $stripped = ($old -replace '--remote-debugging-port=\\d+', '').Trim()
      $new = ("$stripped ${FLAG}=${port}").Trim()`
  const out = await powershell(shortcutScript(mutate))
  return out ? out.split('\n').filter(Boolean) : []
}

/** Removes the debug flag from every Orca shortcut. */
export async function disable() {
  const mutate = `
      $new = ($old -replace '--remote-debugging-port=\\d+', '').Trim()`
  const out = await powershell(shortcutScript(mutate))
  return out ? out.split('\n').filter(Boolean) : []
}

/** Reports the flag state of each Orca shortcut without changing anything. */
export async function status() {
  const script = `
$roots = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:USERPROFILE\\Desktop",
  "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"
)
$sh = New-Object -ComObject WScript.Shell
$rows = @()
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk = $sh.CreateShortcut($_.FullName)
    if ($lnk.TargetPath -like "*orca*Orca.exe") {
      $rows += [pscustomobject]@{ path = $_.FullName; args = $lnk.Arguments }
    }
  }
}
$rows | ConvertTo-Json -Compress`
  const out = await powershell(script)
  if (!out) return []
  const parsed = JSON.parse(out)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((r) => ({
    path: r.path,
    args: r.args ?? '',
    enforced: new RegExp(`${FLAG}=\\d+`).test(r.args ?? '')
  }))
}

/**
 * Idempotent reconcile for activate(): ensures every shortcut carries the flag.
 * Never restarts Orca - the flag takes effect on the next launch.
 */
export async function ensure(port = 9222) {
  const before = await status()
  if (before.length > 0 && before.every((s) => s.enforced)) {
    return { alreadyEnforced: true, shortcuts: before.length, changed: [] }
  }
  const changed = await enable(port)
  return { alreadyEnforced: false, shortcuts: before.length, changed }
}
