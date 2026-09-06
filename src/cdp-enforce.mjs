/**
 * Keeps Orca's CDP port open across restarts.
 *
 * Orca launches the plugin, so a plugin can never add a flag to its own host's
 * current process. What it CAN do is make the flag survive to the next launch.
 * Where that lives differs per machine:
 *
 *   Windows - every shortcut that launches Orca.exe, including the Startup
 *             "Orca Server" shortcut, since that is what starts the serve
 *             instance at logon.
 *   macOS   - the `com.orca.serve` LaunchAgent, which is what starts the serve
 *             instance at login.
 *
 * The macOS agent normally runs the `orca` CLI, and the CLI builds its child
 * argv from known flags only (out/cli/runtime/launch.js: serveOrcaApp) - it does
 * NOT forward extra switches. So enforcing the flag there means running the app
 * binary directly with the same `--serve*` switches the CLI would have passed.
 * launchd's KeepAlive then owns restarts, in place of the CLI's foreground
 * serve supervisor.
 *
 * SECURITY: this is a deliberate, persistent weakening. An open CDP port lets
 * any local process drive Orca's renderer with full privileges - read tokens
 * out of the app, click things, exfiltrate. It is the price of a status-bar
 * chip, because Orca exposes no contribution point for one. `disable()` puts
 * every launcher back.
 */

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FLAG = '--remote-debugging-port'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.orca.serve.plist')
const APP_BINARY = '/Applications/Orca.app/Contents/MacOS/Orca'
const CLI_BINARY = '/Applications/Orca.app/Contents/Resources/bin/orca'

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

/**
 * Where Windows keeps the shortcuts that launch Orca.
 *
 * Resolved in Node, not in PowerShell. The plugin worker does not inherit a
 * full environment from Orca - APPDATA is absent - so a script expanding
 * `$env:APPDATA` searches a root that does not exist, finds nothing, and
 * reports one shortcut (the Desktop one) where there are four. `os.homedir()`
 * does not depend on the environment.
 */
function shortcutRoots() {
  const home = homedir()
  // `||`, not `??`: the worker's APPDATA is present but empty, and an empty
  // root makes the scan silently miss three of the four shortcuts.
  const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  return [
    join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(home, 'Desktop'),
    join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  ]
}

/** The roots as a PowerShell array literal, single-quoted so nothing expands. */
function rootsLiteral() {
  const quoted = shortcutRoots().map((r) => `'${r.replace(/'/g, "''")}'`)
  return `@(\n  ${quoted.join(',\n  ')}\n)`
}

/** PowerShell that walks Orca shortcuts and applies `mutate` to their args. */
function shortcutScript(mutate) {
  return `
$ErrorActionPreference = 'Stop'
$roots = ${rootsLiteral()}
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

/** Runs a command, rejecting on a non-zero exit. */
function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: timeoutMs },
      (err, stdout, stderr) => err ? reject(new Error(stderr?.trim() || err.message)) : resolve(stdout))
  })
}

/** The LaunchAgent as a plain object, or null when there is no agent. */
async function readAgent() {
  try {
    return JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', PLIST]))
  } catch {
    return null
  }
}

async function writeAgent(agent) {
  // plutil is the only writer that reliably produces the dialect launchd wants;
  // hand-rolling the XML here would be a bug farm.
  const staging = `${PLIST}.staging.json`
  await writeFile(staging, JSON.stringify(agent), 'utf-8')
  await run('plutil', ['-convert', 'xml1', staging, '-o', PLIST])
  await run('rm', ['-f', staging])
}

/** Reads `--flag value` out of an argv array. */
function argValue(args, ...flags) {
  for (const flag of flags) {
    const i = args.indexOf(flag)
    if (i >= 0 && args[i + 1]) return args[i + 1]
  }
  return null
}

/**
 * The direct-launch argv: what the CLI would have spawned, plus the debug flag.
 *
 * `orca serve --port P --pairing-address A` becomes
 * `Orca --serve --serve-port P --serve-pairing-address A --remote-debugging-port=N`.
 * That is exactly the argv `serveOrcaApp` builds, and exactly what the Windows
 * Startup shortcut carries.
 */
function serveArgv(args, port) {
  const servePort = argValue(args, '--serve-port', '--port')
  const pairing = argValue(args, '--serve-pairing-address', '--pairing-address')
  const argv = [APP_BINARY, '--serve']
  if (servePort) argv.push('--serve-port', String(servePort))
  if (pairing) argv.push('--serve-pairing-address', String(pairing))
  if (args.includes('--no-pairing') || args.includes('--serve-no-pairing')) argv.push('--serve-no-pairing')
  argv.push(`${FLAG}=${port}`)
  return argv
}

/** The CLI form, restored from either shape. */
function cliArgv(args) {
  const servePort = argValue(args, '--serve-port', '--port')
  const pairing = argValue(args, '--serve-pairing-address', '--pairing-address')
  const argv = [CLI_BINARY, 'serve']
  if (pairing) argv.push('--pairing-address', String(pairing))
  if (servePort) argv.push('--port', String(servePort))
  return argv
}

const PORTED = new RegExp(`^${FLAG}=\\d+$`)

async function darwinStatus() {
  const agent = await readAgent()
  if (!agent) return []
  const args = agent.ProgramArguments ?? []
  return [{ path: PLIST, args: args.join(' '), enforced: args.some((a) => PORTED.test(a)) }]
}

async function darwinEnable(port) {
  const agent = await readAgent()
  if (!agent) return []
  const before = (agent.ProgramArguments ?? []).join(' ')
  agent.ProgramArguments = serveArgv(agent.ProgramArguments ?? [], port)
  if (agent.ProgramArguments.join(' ') === before) return []
  await writeAgent(agent)
  return [PLIST]
}

async function darwinDisable() {
  const agent = await readAgent()
  if (!agent) return []
  const args = agent.ProgramArguments ?? []
  if (!args.some((a) => PORTED.test(a))) return []
  agent.ProgramArguments = cliArgv(args)
  await writeAgent(agent)
  return [PLIST]
}

/**
 * Appends the debug flag to every Orca launcher that lacks it.
 * Returns the launcher paths actually modified.
 *
 * Neither platform restarts Orca: the flag is read at launch, so it takes
 * effect on the next one. On macOS a rewritten plist needs a RELOAD, not a
 * restart - `launchctl kickstart -k` re-runs the definition launchd already
 * has loaded and will start the old argv again:
 *
 *   launchctl bootout gui/$(id -u)/com.orca.serve
 *   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.orca.serve.plist
 */
export async function enable(port = 9222) {
  if (process.platform === 'darwin') return darwinEnable(port)
  const mutate = `
      $stripped = ($old -replace '--remote-debugging-port=\\d+', '').Trim()
      $new = ("$stripped ${FLAG}=${port}").Trim()`
  const out = await powershell(shortcutScript(mutate))
  return out ? out.split('\n').filter(Boolean) : []
}

/** Removes the debug flag from every Orca launcher. */
export async function disable() {
  if (process.platform === 'darwin') return darwinDisable()
  const mutate = `
      $new = ($old -replace '--remote-debugging-port=\\d+', '').Trim()`
  const out = await powershell(shortcutScript(mutate))
  return out ? out.split('\n').filter(Boolean) : []
}

/** Reports the flag state of each Orca launcher without changing anything. */
export async function status() {
  if (process.platform === 'darwin') return darwinStatus()
  const script = `
$roots = ${rootsLiteral()}
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
 * Idempotent reconcile for activate(): ensures every launcher carries the flag.
 * Never restarts Orca - the flag takes effect on the next launch.
 *
 * `port` is only what gets written into launchers that carry no port at all. A
 * launcher naming some other port is left alone: 9222 stays bound by an
 * orphaned crashpad handler after a hard kill, so a launch gets moved to 9223,
 * and rewriting the launcher back to 9222 desyncs it from the running app -
 * which is precisely how the chip went dark on the desktop. The chip discovers
 * the live port at runtime, so any port is fine as long as it is not clobbered.
 */
export async function ensure(port = 9222) {
  const before = await status()
  if (before.length > 0 && before.every((s) => s.enforced)) {
    return { alreadyEnforced: true, shortcuts: before.length, changed: [] }
  }
  const changed = await enable(port)
  return { alreadyEnforced: false, shortcuts: before.length, changed }
}
