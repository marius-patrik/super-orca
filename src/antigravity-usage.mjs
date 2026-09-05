/**
 * Antigravity quota, read headlessly.
 *
 * `agy -p "/usage" --dangerously-skip-permissions` prints a machine-readable
 * TSV and exits. No terminal, no PTY, no visible window, and no model turn:
 * `/usage` is handled client-side, so print mode emits the table directly
 * rather than sending anything to a model.
 *
 *   Gemini Models          \t Weekly Limit Remaining     \t 30% \t 2026-09-10T19:42:09Z
 *   Gemini Models          \t Five Hour Limit Remaining  \t  0% \t 2026-09-05T18:24:25Z
 *   Claude and GPT models  \t Weekly Limit Remaining     \t 66% \t 2026-09-12T12:36:14Z
 *   Claude and GPT models  \t Five Hour Limit Remaining  \t  0% \t 2026-09-05T17:36:14Z
 *
 * WHY NOT THE REST API: every quota endpoint returns 403 SUBSCRIPTION_REQUIRED
 * on a Google AI Pro consumer plan - `retrieveUserQuota` and
 * `retrieveUserQuotaSummary`, on both `cloudcode-pa` and `daily-cloudcode-pa`,
 * with either the Gemini CLI or the Antigravity token. The CLI's own log shows
 * `doRefreshQuota` succeeding while issuing only `loadCodeAssist` and
 * `fetchAvailableModels`, neither of which returns quota to us on any accepted
 * metadata. The client identity that unlocks it is numeric on the wire.
 *
 * CAUTION when testing from Git Bash / MSYS: `/usage` is rewritten to
 * `C:/Program Files/Git/usage` unless MSYS_NO_PATHCONV=1 is set, at which point
 * it stops being a slash command and DOES cost a model turn. Node's execFile
 * has no such rewriting, so the plugin path is safe.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AGY = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
         'Microsoft', 'WinGet', 'Links', 'agy.exe')
  : 'agy'

const TIMEOUT_MS = 30000

/** Maps the CLI's window label onto a stable key. */
function windowKey(label) {
  const s = label.toLowerCase()
  if (s.includes('weekly')) return 'weekly'
  if (s.includes('five hour') || s.includes('5 hour')) return 'five-hour'
  return s.replace(/\s+limit\s+remaining$/, '').trim()
}

/** Parses the TSV into groups of buckets. */
export function parseUsageTsv(stdout) {
  const groups = new Map()
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean)
    if (cols.length < 3) continue
    const [group, window, percent, reset] = cols
    const value = Number.parseFloat(String(percent).replace('%', ''))
    if (!Number.isFinite(value)) continue
    if (!groups.has(group)) groups.set(group, { group, buckets: [] })
    groups.get(group).buckets.push({
      window: windowKey(window),
      label: window,
      remainingPercent: value,
      remainingFraction: value / 100,
      resetsAt: reset && !Number.isNaN(Date.parse(reset)) ? reset : null,
      disabled: false
    })
  }
  return [...groups.values()]
}

/**
 * Reads quota. Resolves to { available, groups } and never throws, so a chip
 * can render an honest state.
 */
export function readQuota({ timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(AGY, ['-p', '/usage', '--dangerously-skip-permissions'],
      { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        // A timeout still yields usable stdout: the table prints before exit.
        const groups = parseUsageTsv(stdout || '')
        if (groups.length > 0) return resolve({ available: true, groups, source: 'agy /usage' })
        resolve({
          available: false,
          reason: err ? (err.code === 'ENOENT' ? 'agy not installed' : err.message) : 'no usage rows',
          groups: []
        })
      })
  })
}

/** Shortest useful group name: "Gemini Models" -> "G". */
function initial(group) {
  return group.trim().charAt(0).toUpperCase()
}

/**
 * Chip label across every pool, weekly first then five-hour:
 *   "AG G 30%/0% · C 66%/0%"
 *
 * Orca's own meter cannot show this - it hardcodes `weekly: null` and reduces
 * buckets with `max(usedPercent)`, so a provider with two pools collapses to
 * one number.
 */
export function chipLabel(quota) {
  if (!quota.available) return `AG ${String(quota.reason).slice(0, 18)}`
  const parts = quota.groups.map((g) => {
    const pct = (w) => {
      const b = g.buckets.find((x) => x.window === w)
      return b ? `${Math.round(b.remainingPercent)}%` : '—'
    }
    return `${initial(g.group)} ${pct('weekly')}/${pct('five-hour')}`
  })
  return `AG ${parts.join(' · ')}`
}

/** Full detail for the chip tooltip. */
export function chipTooltip(quota) {
  if (!quota.available) return `Antigravity quota unavailable: ${quota.reason}`
  return quota.groups
    .map((g) => `${g.group}: ` + g.buckets
      .map((b) => {
        const when = b.resetsAt ? new Date(b.resetsAt).toLocaleString() : 'unknown'
        return `${b.label} ${b.remainingPercent}% (resets ${when})`
      })
      .join(', '))
    .join(' | ')
}
