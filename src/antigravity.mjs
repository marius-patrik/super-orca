/**
 * Antigravity account + quota reader.
 *
 * Credentials live in the OS keyring, NOT in ~/.gemini/oauth_creds.json (that
 * is the Gemini CLI's, a different OAuth client). Antigravity's own log says
 * `ChainedAuth: authenticated via keyring`, and on Windows the entry is the
 * generic credential `gemini:antigravity`, holding
 * `{ token: { access_token, refresh_token, expiry }, auth_method }`.
 *
 * The quota API is `daily-cloudcode-pa.googleapis.com/v1internal:
 * retrieveUserQuotaSummary` (note the `daily-` host - plain `cloudcode-pa` is
 * the Gemini CLI's). Field names come from the protobuf descriptors embedded
 * in agy.exe:
 *
 *   RetrieveUserQuotaSummaryRequest { project }
 *   QuotaSummaryBucket { bucketId, displayName, description, window,
 *                        remainingFraction, remainingAmount, disabled,
 *                        resetTime }
 *   QuotaSummaryGroup  { displayName, description, buckets }
 *
 * KNOWN LIMITATION: on a Google AI Pro consumer subscription this endpoint
 * returns 403 SUBSCRIPTION_REQUIRED ("You do not have a valid license of this
 * product"). It appears to be gated on a Gemini Code Assist licence, which a
 * consumer plan does not carry - `onboarding.json` shows
 * enterpriseOnboardingComplete: false. Verified with the correct `project`
 * field and with Antigravity's own token, so this is an entitlement gate, not
 * a malformed request. readQuota() surfaces that state rather than pretending.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUOTA_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'

/** Reads the `gemini:antigravity` generic credential via PowerShell + CredRead. */
function readWindowsKeyring(target = 'gemini:antigravity') {
  const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class CredR {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredReadW(string t, uint ty, uint f, out IntPtr c);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr c);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct CREDENTIAL { public uint Flags, Type; public IntPtr TargetName, Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist, AttributeCount; public IntPtr Attributes, TargetAlias, UserName; }
  public static string Read(string t) {
    IntPtr p; if (!CredReadW(t, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize);
      return System.Text.Encoding.UTF8.GetString(b);
    } finally { CredFree(p); }
  }
}
'@
Add-Type -TypeDefinition $sig
[CredR]::Read(${JSON.stringify(target)})`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err)
        const raw = stdout.trim()
        if (!raw) return reject(new Error('antigravity credential not found in keyring'))
        try { resolve(JSON.parse(raw)) } catch { reject(new Error('credential is not JSON')) }
      })
  })
}

/** Account identity and token freshness. Never returns the token itself. */
export async function readAccount() {
  if (process.platform !== 'win32') throw new Error('keyring reader is Windows-only')
  const cred = await readWindowsKeyring()
  const expiry = cred.token?.expiry ? new Date(cred.token.expiry) : null
  return {
    authMethod: cred.auth_method ?? null,
    tokenExpiresAt: expiry ? expiry.toISOString() : null,
    tokenValid: expiry ? expiry.getTime() > Date.now() : false
  }
}

/** Default project id the CLI uses for quota calls. */
async function defaultProject() {
  const p = join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt')
  try {
    return (await readFile(p, 'utf-8')).trim() || 'default-cli-project'
  } catch {
    return 'default-cli-project'
  }
}

/**
 * Fetches the quota summary.
 *
 * Resolves to { available: false, reason } rather than throwing when the
 * account is not entitled, so a chip can render an honest state.
 */
export async function readQuota() {
  const cred = await readWindowsKeyring()
  const token = cred.token?.access_token
  if (!token) return { available: false, reason: 'no access token in keyring' }

  const res = await fetch(QUOTA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: await defaultProject() })
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const reason = body?.error?.details?.[0]?.reason ?? body?.error?.status ?? `HTTP ${res.status}`
    return { available: false, reason, message: body?.error?.message ?? null }
  }

  // Flatten groups -> buckets into the smallest shape a chip needs.
  const buckets = []
  for (const group of body.quotaGroups ?? body.groups ?? []) {
    for (const b of group.buckets ?? []) {
      buckets.push({
        id: b.bucketId ?? null,
        label: b.displayName ?? null,
        window: b.window ?? null,
        remainingFraction: b.remainingFraction ?? null,
        remainingAmount: b.remainingAmount ?? null,
        disabled: b.disabled === true,
        resetTime: b.resetTime ?? null
      })
    }
  }
  return { available: true, buckets }
}

/**
 * Chip label. Renders EVERY active pool, not just one.
 *
 * Orca's own meter cannot do this: it hardcodes `weekly: null` and collapses
 * all buckets with `max(usedPercent)`, so a provider with more than one pool
 * (Antigravity has two) always shows a single number. Keeping each bucket
 * separate is the whole point of rendering our own chip.
 */
export function chipLabel(quota) {
  if (!quota.available) {
    return quota.reason === 'SUBSCRIPTION_REQUIRED'
      ? 'AG n/a'
      : `AG ${String(quota.reason).slice(0, 14)}`
  }
  const active = quota.buckets.filter((b) => !b.disabled && b.remainingFraction != null)
  if (active.length === 0) return 'AG —'
  const parts = active.map((b) => `${Math.round(b.remainingFraction * 100)}%`)
  return `AG ${parts.join(' · ')} left`
}
