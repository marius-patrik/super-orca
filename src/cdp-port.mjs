/**
 * Which port Orca's renderer is ACTUALLY debuggable on.
 *
 * The debug port is fixed at launch and is not stable across launches. After a
 * hard kill, 9222 stays bound by an orphaned crashpad handler until a reboot,
 * so Orca gets started on another port - and a hardcoded 9222 then silently
 * finds nothing. That is exactly how the status chip died on this desktop: the
 * shortcuts carried `--remote-debugging-port=9222` while the live serve
 * instance ran on 9223, `cdpAvailable()` answered false, and the chip was never
 * painted (no error anywhere, because "no CDP" is a legitimate state).
 *
 * So never assume the port: read it off the running Orca process's own command
 * line, and verify the endpoint answers before handing it out.
 */

import { execFile } from 'node:child_process'

export const DEFAULT_PORT = 9222

const FLAG = /--remote-debugging-port[= ](\d+)/g

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
      (err, stdout) => resolve(err && !stdout ? '' : stdout || ''))
  })
}

/**
 * Command lines of the running Orca app processes.
 *
 * Windows: every Orca.exe, renderers included - a renderer child inherits the
 * flag on its command line too, so matching broadly is harmless and cheaper
 * than isolating the main process.
 * macOS/Linux: `ps -axo command=`, filtered to the app binary.
 */
async function orcaCommandLines() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='Orca.exe'\").CommandLine -join \"`n\""], 15000)
    return out.split(/\r?\n/).filter(Boolean)
  }
  const out = await run('ps', ['-axo', 'command='], 15000)
  return out.split('\n').filter((l) => /Orca(\.app)?[\/]/i.test(l) || /\bOrca\b/.test(l))
}

/** Ports named on any Orca command line, most recently seen first. */
export async function declaredPorts() {
  const ports = new Set()
  for (const line of await orcaCommandLines()) {
    for (const m of line.matchAll(FLAG)) ports.add(Number(m[1]))
  }
  return [...ports]
}

/** True when a DevTools endpoint answers on `port`. */
export async function answers(port, timeoutMs = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`,
      { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * The live debug port, or null when the renderer is not debuggable.
 *
 * Order: whatever the process says, then the default as a last resort (a launch
 * this process cannot see - e.g. a differently named binary - may still be on
 * it). Each candidate is probed, so a stale flag on a dead process is skipped.
 */
export async function resolvePort({ fallback = DEFAULT_PORT } = {}) {
  const candidates = await declaredPorts()
  if (!candidates.includes(fallback)) candidates.push(fallback)
  for (const port of candidates) {
    if (await answers(port)) return port
  }
  return null
}
