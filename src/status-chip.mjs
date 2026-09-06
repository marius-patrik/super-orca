/**
 * Status-bar chip injection over the Chrome DevTools Protocol.
 *
 * Orca's plugin API has no status-bar contribution point, so this is the only
 * route to one. It requires Orca to have been launched with
 * `--remote-debugging-port=<port>`; Orca never appends that switch itself and
 * does not block it.
 *
 * The port is never assumed - it is read off the running Orca process (see
 * src/cdp-port.mjs), because the flag is fixed at launch and drifts whenever
 * the default port is left bound by a crashed instance.
 *
 * SECURITY: an open CDP port lets any local process drive the renderer with
 * full privileges - read tokens out of the app, click things, exfiltrate. This
 * module is opt-in and does nothing when the port is closed.
 *
 * Node 22+ ships a global WebSocket, so there are no dependencies.
 */

import { resolvePort } from './cdp-port.mjs'

const CHIP_ID = 'super-orca-chip'

/** Resolves an explicit port, or discovers the live one. Throws when there is none. */
async function livePort(port) {
  if (port != null) return port
  const found = await resolvePort()
  if (found == null) throw new Error('Orca is not running with --remote-debugging-port')
  return found
}

/**
 * Target discovery.
 *
 * Chrome's DevTools HTTP endpoint can wedge - the port stays LISTENING while
 * /json/list never answers, e.g. while another target is hung. Observed in
 * practice, so every request is bounded and the last good target is cached and
 * retried directly before giving up.
 */
const cachedTargets = new Map()

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function discoverTarget(port, { timeoutMs = 4000, attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs)
      const page = list.find((t) => t.type === 'page')
      if (page) {
        cachedTargets.set(port, page.webSocketDebuggerUrl)
        return page.webSocketDebuggerUrl
      }
    } catch {
      // fall through to the next attempt, then the cache
    }
  }
  const cached = cachedTargets.get(port)
  if (cached) return cached
  throw new Error(`no reachable renderer target on port ${port} (DevTools endpoint unresponsive)`)
}

/** Minimal CDP client for one page target. */
async function attach(port) {
  const wsUrl = await discoverTarget(port)
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let id = 0

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    const entry = pending.get(m.id)
    if (!entry) return
    pending.delete(m.id)
    m.error ? entry.reject(new Error(m.error.message)) : entry.resolve(m.result)
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      cachedTargets.delete(port)
      reject(new Error('CDP socket did not open within 5s'))
    }, 5000)
    ws.onopen = () => { clearTimeout(timer); resolve() }
    ws.onerror = () => { clearTimeout(timer); cachedTargets.delete(port); reject(new Error('CDP socket failed')) }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })

  return {
    close: () => ws.close(),
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      }
      return r.result.value
    }
  }
}

/**
 * Renders (or updates) a chip in Orca's status bar.
 *
 * The status bar is found by geometry, not by class name and not by text:
 * Orca's classes are Tailwind utilities that churn between releases, and the
 * bar's text is whatever providers happen to be configured. Geometry is the
 * stable part - it is the innermost full-width row of normal height sitting
 * flush against the bottom of the viewport.
 *
 * Matching on text was the previous approach and it silently stopped working:
 * the patterns live inside a template literal, where `\d` and `\s` lose their
 * backslash before the renderer ever sees them, so `/\d+\s+hosts?/` arrived as
 * `/d+s+hosts?/` and matched nothing. Any regex used here must be written with
 * doubled backslashes; avoiding them entirely is safer.
 *
 * The chip re-renders idempotently by id.
 */
export async function renderChip({ port, label, tooltip = '', tone = 'muted' } = {}) {
  const cdp = await attach(await livePort(port))
  try {
    return await cdp.evaluate(`(() => {
      const ID = ${JSON.stringify(CHIP_ID)}

      // Reuse the bar we already injected into, if it is still mounted.
      const existing = document.getElementById(ID)
      let bar = existing && existing.parentElement ? existing.parentElement : null

      if (!bar) {
        // The status bar: a full-width row, one line tall, flush with the
        // bottom edge. Full-height ancestors fail the height test and the
        // inner chip groups fail the width test, which leaves the bar itself.
        const vh = window.innerHeight
        const vw = window.innerWidth
        const depth = (e) => { let d = 0; for (let n = e; n; n = n.parentElement) d++; return d }
        const rows = [...document.querySelectorAll('div,footer,section')].filter(e => {
          if (!e.children.length) return false
          const r = e.getBoundingClientRect()
          return r.height >= 16 && r.height <= 60 &&
                 Math.abs(r.bottom - vh) <= 4 &&
                 r.width >= vw * 0.8
        })
        // Innermost wins: outer wrappers of the same geometry are just padding.
        bar = rows.sort((a, b) => depth(b) - depth(a))[0] || null
      }
      if (!bar) return { ok: false, reason: 'status bar not found' }

      let chip = document.getElementById(ID)
      if (!chip) {
        chip = document.createElement('div')
        chip.id = ID
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;' +
          'font:inherit;white-space:nowrap;cursor:default'
        bar.insertBefore(chip, bar.firstChild)
      }
      chip.title = ${JSON.stringify(tooltip)}
      chip.style.opacity = ${JSON.stringify(tone)} === 'muted' ? '0.7' : '1'
      chip.textContent = ${JSON.stringify(label)}
      return { ok: true, text: chip.textContent }
    })()`)
  } finally {
    cdp.close()
  }
}

/** Removes the chip. Safe to call when it was never rendered. */
export async function removeChip({ port } = {}) {
  const cdp = await attach(await livePort(port))
  try {
    return await cdp.evaluate(
      `(() => { const e = document.getElementById(${JSON.stringify(CHIP_ID)});
                if (e) e.remove(); return { removed: Boolean(e) } })()`
    )
  } finally {
    cdp.close()
  }
}

/**
 * True when a renderer target is reachable - on `port` when given, otherwise on
 * whatever port the running Orca actually opened.
 */
export async function cdpAvailable(port) {
  try {
    await discoverTarget(await livePort(port), { timeoutMs: 3000, attempts: 2 })
    return true
  } catch {
    return false
  }
}
