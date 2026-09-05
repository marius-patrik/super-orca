/**
 * Escape hatch: drive Orca's own runtime from the plugin worker.
 *
 * The worker is spawned with `fork(entry, [], { execArgv: [] })` - an ordinary,
 * unrestricted Node child process. The manifest `capabilities` array gates
 * `host.call` only; it is an access-control list for the host API, NOT a
 * sandbox. So the worker keeps full Node privileges: fs, net, child_process.
 *
 * That means anything the `orca` CLI can do, a plugin can do - terminals,
 * worktrees, browser automation, computer-use, automations, artifacts,
 * projects, orchestration - none of which the plugin API exposes.
 *
 * This shells out to the CLI rather than speaking the runtime's WebSocket
 * protocol directly: the CLI is a supported, versioned surface, whereas the
 * wire format is not. `orca-runtime.json` in userData also carries an
 * authToken and advertises ws://0.0.0.0:6768, so the socket is reachable
 * without the CLI - but that is a far more brittle contract.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLI = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
         'Programs', 'orca', 'resources', 'bin', 'orca.exe')
  : 'orca'

/** Runs an orca CLI command and parses its --json envelope. */
export function orca(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(CLI, [...args, '--json'], { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return reject(err)
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {
          return reject(new Error(`orca ${args.join(' ')}: unparseable output`))
        }
        if (parsed.ok === false) {
          return reject(new Error(parsed.error?.message ?? `orca ${args.join(' ')} failed`))
        }
        resolve(parsed.result ?? parsed)
      })
  })
}

/** Reads the runtime descriptor: pid, transports and the auth token. */
export async function runtimeDescriptor() {
  const userData = process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'orca')
    : join(homedir(), '.config', 'orca')
  return JSON.parse(await readFile(join(userData, 'orca-runtime.json'), 'utf-8'))
}

/**
 * Chrome DevTools Protocol target list for Orca's renderer.
 *
 * Returns null unless Orca was started with `--remote-debugging-port=<port>`.
 * Orca never appends that switch itself and does not block it, so launching
 * with the flag exposes the renderer. With a target attached, Runtime.evaluate
 * runs arbitrary JS inside Orca's UI - the only route to changes the plugin
 * API has no contribution point for, such as adding a status-bar item.
 *
 * This is a real security trade-off: an open CDP port lets ANY local process
 * drive the app. Opt in deliberately, not by default.
 */
export async function cdpTargets(port = 9222) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
