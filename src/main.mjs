/**
 * Super Orca — plugin worker entry.
 *
 * Orca loads this file with a dynamic import() of its file:// URL, so it must
 * be an ES module whose DEFAULT export is the activate function. An optional
 * named `deactivate` export is awaited on shutdown.
 *
 * activate(ctx) receives:
 *   ctx.commands.register(commandId, handler)  handler(args) -> value
 *   ctx.events.on(eventName, handler)          handler(payload)
 *   ctx.host.call(method, params) -> Promise
 *   ctx.grantedCapabilities                    array of { kind }
 *   ctx.log(message)                           string, truncated at 8192
 *
 * Every command registered here MUST also be declared in orca-plugin.json
 * WITHOUT an `action` field — declaring `action` hands the command to a
 * built-in instead, and registering an undeclared command fails activation.
 */

import { orca, runtimeDescriptor, cdpTargets } from './orca-runtime.mjs'
import { readAccount, readQuota, chipLabel } from './antigravity.mjs'
import { readQuota as readUsageQuota, chipLabel as usageChipLabel, chipTooltip } from './antigravity-usage.mjs'
import { renderChip, cdpAvailable } from './status-chip.mjs'
import { ensure as ensureCdpFlag, status as cdpFlagStatus } from './cdp-enforce.mjs'

const EVENT_LOG_KEY = 'event-log'
const EVENT_LOG_MAX = 50

/** Capability-gated host methods, so a missing grant fails loudly, not silently. */
function makeHost(ctx) {
  const granted = new Set((ctx.grantedCapabilities ?? []).map((c) => c.kind ?? c))
  return {
    granted,
    has: (kind) => granted.has(kind),
    async call(method, params, requiredCapability) {
      if (requiredCapability && !granted.has(requiredCapability)) {
        throw new Error(`missing capability ${requiredCapability} for ${method}`)
      }
      return ctx.host.call(method, params)
    }
  }
}

async function readEventLog(host) {
  if (!host.has('storage')) return []
  try {
    const res = await host.call('storage.get', { key: EVENT_LOG_KEY }, 'storage')
    return Array.isArray(res?.value) ? res.value : []
  } catch {
    return []
  }
}

async function appendEvent(host, entry) {
  if (!host.has('storage')) return
  const log = await readEventLog(host)
  log.push(entry)
  // Ring buffer: storage values are JSON and size-capped host-side.
  while (log.length > EVENT_LOG_MAX) log.shift()
  await host.call('storage.set', { key: EVENT_LOG_KEY, value: log }, 'storage')
}

export default async function activate(ctx) {
  const host = makeHost(ctx)
  ctx.log(`super-orca activating with capabilities: ${[...host.granted].join(', ') || '(none)'}`)

  // --- commands -----------------------------------------------------------
  ctx.commands.register('context-dump', async () => {
    const ctxRes = await host.call('workspace.readContext', {}, 'workspace:read')
    ctx.log(`workspace.readContext -> ${JSON.stringify(ctxRes)}`)
    return ctxRes
  })

  ctx.commands.register('event-log', async () => {
    const log = await readEventLog(host)
    ctx.log(`event-log has ${log.length} entr${log.length === 1 ? 'y' : 'ies'}`)
    return log
  })

  ctx.commands.register('ping', async () => {
    const report = { capabilities: [...host.granted], checks: {} }

    for (const [name, fn] of [
      ['workspace:read', () => host.call('workspace.readContext', {}, 'workspace:read')],
      ['storage', async () => {
        await host.call('storage.set', { key: 'self-test', value: { at: Date.now() } }, 'storage')
        const got = await host.call('storage.get', { key: 'self-test' }, 'storage')
        const keys = await host.call('storage.keys', {}, 'storage')
        return { roundTrip: got?.value ?? null, keys: keys?.keys ?? [] }
      }],
      ['secrets', async () => {
        await host.call('secrets.set', { key: 'self-test', value: 'ok' }, 'secrets')
        const got = await host.call('secrets.get', { key: 'self-test' }, 'secrets')
        await host.call('secrets.delete', { key: 'self-test' }, 'secrets')
        return { roundTrip: got?.value ?? null }
      }],
      ['settings:own', async () => {
        await host.call('settings.set', { key: 'lastSelfTest', value: Date.now() }, 'settings:own')
        return host.call('settings.get', {}, 'settings:own')
      }],
      ['notifications:show', () =>
        host.call('notifications.show', { title: 'Super Orca', body: 'Self test passed.' }, 'notifications:show')]
    ]) {
      try {
        report.checks[name] = { ok: true, value: await fn() }
      } catch (err) {
        report.checks[name] = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    ctx.log(`self test: ${JSON.stringify(report.checks)}`)
    return report
  })

  // Escape hatch. Declares no capability and needs none: the worker is a plain
  // unrestricted Node process, so it reaches Orca's whole runtime through the
  // CLI regardless of what the manifest asks for. See src/orca-runtime.mjs.
  ctx.commands.register('runtime-probe', async () => {
    const descriptor = await runtimeDescriptor()
    const [worktrees, terminals, cdp] = await Promise.all([
      orca(['worktree', 'list']).catch((e) => ({ error: e.message })),
      orca(['terminal', 'list']).catch((e) => ({ error: e.message })),
      cdpTargets()
    ])
    const report = {
      runtime: {
        pid: descriptor.pid,
        transports: descriptor.transports.map((t) => t.kind),
        authTokenReadable: Boolean(descriptor.authToken)
      },
      worktrees: worktrees.worktrees?.length ?? worktrees,
      terminals: terminals.terminals?.length ?? terminals,
      // Non-null only when Orca was launched with --remote-debugging-port.
      // With a target attached, Runtime.evaluate can modify Orca's UI directly.
      rendererDebugTargets: cdp ? cdp.length : null
    }
    ctx.log(`runtime probe: ${JSON.stringify(report)}`)
    return report
  })

  // Status-bar chip. No contribution point exists for this, so it goes in
  // through CDP and is a no-op unless Orca was launched with
  // --remote-debugging-port. See src/status-chip.mjs for the security note.
  ctx.commands.register('antigravity-chip', async () => {
    if (!(await cdpAvailable())) {
      ctx.log('chip skipped: no CDP port (launch Orca with --remote-debugging-port=9222)')
      return { rendered: false, reason: 'cdp-unavailable' }
    }
    const account = await readAccount().catch((e) => ({ error: e.message }))

    // `agy -p /usage` is headless, takes ~4s, spawns no terminal and costs no
    // model turn. The REST API 403s on a consumer plan, so this is the source.
    const quota = await readUsageQuota()
    const label = usageChipLabel(quota)
    const tooltip = quota.available
      ? chipTooltip(quota)
      : `${chipTooltip(quota)} (auth: ${account.authMethod ?? 'unknown'})`

    const result = await renderChip({ label, tooltip })
    ctx.log(`chip: ${label} (${result.ok ? 'rendered' : result.reason})`)
    return { rendered: result.ok, label, account, quota }
  })

  // Keeps the CDP port alive across restarts by writing the launch flag into
  // every Orca shortcut. Deliberate, persistent, and reversible via disable().
  ctx.commands.register('cdp-enforce', async () => {
    const result = await ensureCdpFlag(9222)
    ctx.log(`cdp enforce: ${result.alreadyEnforced ? 'already set' : 'updated ' + result.changed.length} of ${result.shortcuts} shortcut(s)`)
    return { ...result, live: await cdpAvailable() }
  })

  // --- events -------------------------------------------------------------
  // Subscribing is a host call; delivery then arrives through ctx.events.on.
  const wanted = ['worktree.created', 'worktree.removed', 'agent.status.changed']
  if (host.has('events:subscribe')) {
    try {
      const res = await host.call('events.subscribe', { events: wanted }, 'events:subscribe')
      ctx.log(`subscribed to: ${(res?.subscribed ?? []).join(', ')}`)
    } catch (err) {
      ctx.log(`events.subscribe failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const name of wanted) {
    ctx.events.on(name, async (payload) => {
      await appendEvent(host, { event: name, at: Date.now(), payload })
      ctx.log(`event ${name}`)
    })
  }

  // Reconcile the launch flag on every activation so a reinstall or a shortcut
  // rewrite cannot silently drop it. Never restarts Orca; takes effect next launch.
  try {
    const enforced = await ensureCdpFlag(9222)
    ctx.log(`cdp flag: ${enforced.alreadyEnforced ? 'already enforced' : 'applied to ' + enforced.changed.length} (${enforced.shortcuts} shortcuts)`)
  } catch (err) {
    ctx.log(`cdp flag reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  ctx.log('super-orca ready')
}

export function deactivate() {
  // Nothing to unwind: subscriptions and the worker die with the process.
}
