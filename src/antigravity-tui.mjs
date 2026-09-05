/**
 * Antigravity quota via the CLI's own `/usage` view.
 *
 * WHY NOT THE API: `retrieveUserQuota` and `retrieveUserQuotaSummary` both
 * return 403 SUBSCRIPTION_REQUIRED for a Google AI Pro consumer account, on
 * both `cloudcode-pa` and `daily-cloudcode-pa`, with either the Gemini CLI or
 * the Antigravity token. The CLI's own log shows `doRefreshQuota` succeeding
 * while issuing only `loadCodeAssist` and `fetchAvailableModels` - neither of
 * which returns quota to us, on any accepted metadata combination. The client
 * identity that unlocks it is numeric on the wire and not recoverable from
 * strings, so the TUI is the only source that actually works.
 *
 * HOW: drive `agy` inside an Orca terminal through the CLI escape hatch, send
 * `/usage`, read the RENDERED screen (`terminal read --screen`; the default
 * stream mode returns repaint fragments, useless for a TUI), parse, close.
 *
 * COST: none in model terms. `/usage` is a local view - it triggers a quota
 * refresh, not a turn. No prompt is ever submitted.
 */

import { orca } from './orca-runtime.mjs'

const BOOT_MS = 40000
const VIEW_MS = 8000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Parses the `/usage` screen.
 *
 * Shape (two groups, each with a weekly and a five-hour bucket):
 *
 *   GEMINI MODELS
 *     Models within this group: Gemini Flash, Gemini Pro
 *     Weekly Limit Remaining
 *       [####......] 31.54%
 *       32% remaining · Refreshes in 124h 34m
 *     Five Hour Limit Remaining
 *       [#.........] 6.67%
 *
 * The precise fraction is taken from the bar's own percentage, not the rounded
 * line beneath it. A 0.00% bucket prints no "N% remaining" line at all, which
 * is why the bar is the reliable anchor.
 */
export function parseUsageScreen(text) {
  const lines = text.split('\n').map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd())
  const groups = []
  let group = null
  let window = null

  for (const line of lines) {
    const s = line.trim()

    const heading = s.match(/^([A-Z][A-Z &]+)\s+MODELS$/)
    if (heading) {
      group = { group: heading[1].trim(), models: [], buckets: [] }
      groups.push(group)
      window = null
      continue
    }
    if (!group) continue

    const models = s.match(/^Models within this group:\s*(.+)$/)
    if (models) {
      group.models = models[1].split(',').map((m) => m.trim()).filter(Boolean)
      continue
    }

    const win = s.match(/^(Weekly|Five Hour) Limit Remaining$/)
    if (win) {
      window = win[1] === 'Weekly' ? 'weekly' : 'five-hour'
      continue
    }

    const bar = s.match(/^\[[^\]]*\]\s*([\d.]+)%$/)
    if (bar && window) {
      group.buckets.push({
        window,
        remainingFraction: Number(bar[1]) / 100,
        remainingPercent: Number(bar[1]),
        resetsIn: null,
        disabled: false
      })
      continue
    }

    const reset = s.match(/Refreshes in\s+(.+?)\s*$/)
    if (reset && group.buckets.length > 0) {
      group.buckets[group.buckets.length - 1].resetsIn = reset[1].trim()
    }
  }

  return groups.filter((g) => g.buckets.length > 0)
}

/** Finds any live terminal to split from; Orca needs an anchor pane. */
async function anchorTerminal() {
  const { terminals } = await orca(['terminal', 'list'])
  if (!terminals?.length) throw new Error('no live Orca terminal to split from')
  return terminals[0].handle
}

/**
 * Boots `agy`, reads `/usage`, and tears the pane down again.
 * Resolves to { available, groups } shaped like readQuota()'s contract.
 */
export async function readQuotaViaTui({ bootMs = BOOT_MS } = {}) {
  let handle = null
  try {
    const anchor = await anchorTerminal()
    const { split } = await orca(['terminal', 'split', '--terminal', anchor, '--direction', 'vertical'])
    handle = split.handle

    await orca(['terminal', 'send', '--terminal', handle, '--text', 'agy', '--enter'])
    await sleep(bootMs)

    await orca(['terminal', 'send', '--terminal', handle, '--text', '/usage', '--enter'])
    await sleep(VIEW_MS)

    const res = await orca(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '80'])
    const screen = (res.terminal?.tail ?? []).join('\n')
    const groups = parseUsageScreen(screen)

    if (groups.length === 0) {
      return { available: false, reason: 'usage view not rendered', groups: [] }
    }
    return { available: true, groups, source: 'tui' }
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err), groups: [] }
  } finally {
    if (handle) {
      await orca(['terminal', 'close', '--terminal', handle]).catch(() => {})
    }
  }
}

/**
 * Chip label across every pool, e.g.
 *   "AG  G 32%/7%  ·  C 66%/0%"
 * with weekly first and the five-hour window second per group.
 */
export function tuiChipLabel(quota) {
  if (!quota.available) return `AG ${String(quota.reason).slice(0, 16)}`
  const parts = quota.groups.map((g) => {
    const weekly = g.buckets.find((b) => b.window === 'weekly')
    const short = g.buckets.find((b) => b.window === 'five-hour')
    const initial = g.group.charAt(0)
    const pct = (b) => (b ? `${Math.round(b.remainingPercent)}%` : '—')
    return `${initial} ${pct(weekly)}/${pct(short)}`
  })
  return `AG ${parts.join(' · ')}`
}
