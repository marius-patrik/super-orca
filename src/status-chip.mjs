/**
 * Status-bar chip injection over the Chrome DevTools Protocol.
 *
 * Orca's plugin API has no status-bar contribution point, so this is the only
 * route to one. It requires Orca to have been launched with
 * `--remote-debugging-port=<port>`; Orca never appends that switch itself and
 * does not block it.
 *
 * SECURITY: an open CDP port lets any local process drive the renderer with
 * full privileges - read tokens out of the app, click things, exfiltrate. This
 * module is opt-in and does nothing when the port is closed.
 *
 * Node 22+ ships a global WebSocket, so there are no dependencies.
 */

const CHIP_ID = 'super-orca-chip'

/** Minimal CDP client for one page target. */
async function attach(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no renderer page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
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
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP socket failed'))
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
 * The status bar is found structurally rather than by class name: the shortest
 * short-height element whose text contains the hosts chip. Orca's classes are
 * Tailwind utilities and will churn between releases; this heuristic survives
 * that, and the chip re-renders idempotently by id.
 */
export async function renderChip({ port = 9222, label, tooltip = '', tone = 'muted' } = {}) {
  const cdp = await attach(port)
  try {
    return await cdp.evaluate(`(() => {
      const ID = ${JSON.stringify(CHIP_ID)}
      const bar = [...document.querySelectorAll('div,footer,section')]
        .filter(e => /hosts/.test(e.textContent || '')
                  && e.children.length
                  && e.getBoundingClientRect().height < 60)
        .sort((a, b) => a.textContent.length - b.textContent.length)[0]
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
export async function removeChip({ port = 9222 } = {}) {
  const cdp = await attach(port)
  try {
    return await cdp.evaluate(
      `(() => { const e = document.getElementById(${JSON.stringify(CHIP_ID)});
                if (e) e.remove(); return { removed: Boolean(e) } })()`
    )
  } finally {
    cdp.close()
  }
}

/** True when a renderer target is reachable on `port`. */
export async function cdpAvailable(port = 9222) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) return false
    return (await res.json()).some((t) => t.type === 'page')
  } catch {
    return false
  }
}
