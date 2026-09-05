# Super Orca

A local development plugin for [Orca](https://orca.computer) that exercises **every**
capability, contribution point and host API method exposed by Orca's plugin API v0.

Built against Orca **1.4.197**. The API is marked `stability: "experimental"`
throughout, so treat everything below as a moving target.

## What it does

| Surface | Included |
| --- | --- |
| Capabilities | all 7 |
| Panels | 1 (`Super Orca` control panel) |
| Commands | 6 worker-handled + 3 bound to built-in actions |
| Keybindings | 5 |
| Events | all 3 |
| Host API methods | all 13 |

`Mod+Alt+P` runs a self test that round-trips storage, secrets and settings, reads
workspace context and fires a notification, reporting per-capability pass/fail.

## Install (development)

1. Clone anywhere, e.g. `C:\Users\you\super-orca`
2. Orca -> Settings -> **Advanced** -> add that path to **dev plugin paths**
3. Approve the consent prompt - it lists the 7 capabilities
4. Panel appears as **Super Orca**; commands are in the command palette

Dev paths are watched, so edits reload the plugin without restarting Orca.

## Plugin API v0 reference

Reconstructed from `orca/resources/app.asar.unpacked/out/shared/plugins/*` and the
manifest validator. Useful because none of this is published.

### Manifest

`orca-plugin.json` at the plugin root. `manifestVersion: 1`, `pluginApi: 1`.

- `id`, `publisher`, and panel ids are kebab-case, max 64 chars,
  matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`, and may not be `__proto__`,
  `prototype` or `constructor`
- the plugin key is `publisher.id`
- `version` is semver; `engines.orca` must match `>=x.y.z`
- every path is relative, inside the plugin dir, and Windows-portable
  (no reserved device names, no trailing dot or space)
- `main` is **required** when `contributes.events` is non-empty

### Capabilities

A closed set of 7. Unknown kinds fail manifest validation rather than silently
granting nothing. Declared as objects (`{ "kind": "storage" }`) so scoped fields
can be added later.

`workspace:read` - `terminal:send` - `notifications:show` - `storage` - `secrets` -
`events:subscribe` - `settings:own`

### Contribution points

| Point | Max | Shape |
| --- | --- | --- |
| `panels` | 64 | `{ id, title, icon?, entry }` |
| `commands` | 256 | `{ id, title, context?, action? }` |
| `events` | 3 | `{ on }` |
| `languagePacks` | 16 | `{ locale, path }` |
| `keybindings` | 256 | `{ command, key, when? }` |
| `vmRecipes` | 64 | `{ path }` |
| `agents` | 64 | `{ path }` |

`context` and `when` are `global` or `worktree`, and a keybinding's `when` must
match its command's `context`.

A command with an `action` maps to a built-in and is **not** dispatched to the
worker. A command without one **must** be registered by the worker - registering
an undeclared command fails activation.

The 16 built-in actions:

```
worktree.history.back            worktree.history.forward
sidebar.left.toggle              sidebar.right.toggle
sidebar.explorer.toggle          sidebar.search.toggle
sidebar.sourceControl.toggle     sidebar.checks.toggle
sidebar.ports.toggle             sidebar.sleepingWorkspaces.toggle
floatingWorkspace.maximize       tab.rename
workspace.rename                 workspace.openBoard
view.tasks
```

Keybindings need at least one modifier. `Mod` is Cmd on macOS and Ctrl elsewhere;
`DoubleTap+<mod>` is also accepted.

### Worker entry (`main`)

Loaded via a dynamic `import()` of a file URL in a **child process**, so it must
be an ES module with a **default-exported** activate function. An optional named
`deactivate` export is awaited on shutdown.

```js
export default async function activate(ctx) {
  ctx.commands.register('my-command', async (args) => ({ ok: true }))
  ctx.events.on('agent.status.changed', async (payload) => {})
  const result = await ctx.host.call('workspace.readContext', {})
  ctx.grantedCapabilities // [{ kind }]
  ctx.log('message')      // truncated at 8192 chars
}

export function deactivate() {}
```

### Host API

| Method | Capability | Panel-callable |
| --- | --- | --- |
| `workspace.readContext` | `workspace:read` | yes |
| `terminal.sendText` | `terminal:send` | yes |
| `notifications.show` | `notifications:show` | yes |
| `storage.get` / `.set` / `.delete` / `.keys` | `storage` | no |
| `secrets.get` / `.set` / `.delete` | `secrets` | no |
| `settings.get` / `.set` | `settings:own` | no |
| `events.subscribe` | `events:subscribe` | no |

Events are `worktree.created`, `worktree.removed` and `agent.status.changed`.
Subscribe through `host.call`; delivery arrives via `ctx.events.on`.

### Panels

Orca prepends a host-generated shell to your HTML, so supply the body only. The
shell provides the CSP, design tokens, a ping responder (do **not** write your own
`orca-panel-pong` - the watchdog pings every 10s and demotes a panel that misses
a 5s deadline), and neutralises `window.open`, link navigation and form submits.

```
default-src 'none'; connect-src 'none'; script-src 'unsafe-inline';
style-src 'unsafe-inline'; img-src data:; font-src data:;
base-uri 'none'; form-action 'none'
```

`connect-src 'none'` means **panels cannot reach the network at all** - inline
everything, use `data:` URIs for images, and route anything external through the
worker.

The frame is sandboxed with an opaque origin, so neither side trusts origins.
Call the host by posting to `window.parent`:

```js
window.parent.postMessage(
  { type: 'orca-panel-action', requestId, action, params }, '*'
)
```

Results return as `orca-panel-action-result` carrying the same `requestId`.
Budgets are 64KB per message and 30 messages per 10s, enforced host-side.

Design tokens injected as CSS custom properties: `--background`, `--foreground`,
`--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`,
`--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`,
`--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`,
`--destructive-foreground`, `--border`, `--input`, `--ring`, `--radius`.

## Status-bar chip (CDP)

Orca has **no status-bar contribution point**, so `src/status-chip.mjs` injects
one over the Chrome DevTools Protocol. It needs Orca started with
`--remote-debugging-port=9222`; without it, `antigravity-chip` (`Mod+Alt+G`)
is a no-op that says so.

The chip is located structurally, not by class name - Orca's Tailwind classes
churn between releases - and re-renders idempotently by element id.

### Antigravity quota status

`src/antigravity.mjs` reads Antigravity's credentials from the OS keyring
(Windows generic credential `gemini:antigravity`, **not**
`~/.gemini/oauth_creds.json`, which belongs to the Gemini CLI - a different
OAuth client) and calls
`daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`.

Request and response field names come from the protobuf descriptors embedded
in `agy.exe`:

```
RetrieveUserQuotaSummaryRequest { project }
QuotaSummaryBucket { bucketId, displayName, description, window,
                     remainingFraction, remainingAmount, disabled, resetTime }
QuotaSummaryGroup  { displayName, description, buckets }
```

**On a Google AI Pro consumer subscription this returns 403
`SUBSCRIPTION_REQUIRED`** and the chip renders `AG n/a`. The endpoint is gated
on a Gemini Code Assist licence, which a consumer plan does not carry
(`onboarding.json` shows `enterpriseOnboardingComplete: false`). This was
verified with the correct `project` field and Antigravity's own token, so it is
an entitlement gate, not a malformed request. The reader surfaces that state
instead of inventing a number; drop in a working source and the chip renders
`AG <n>% left` unchanged.

### Keeping the CDP port open

A plugin cannot add a flag to the process that launched it, but it can make the
flag survive. `src/cdp-enforce.mjs` appends `--remote-debugging-port=9222` to
every shortcut that launches Orca (Start Menu, Desktop, taskbar), reconciled on
every activation so a reinstall cannot silently drop it. `disable()` reverts all
of them.

This is a deliberate, persistent weakening: an open CDP port lets any local
process drive Orca's renderer with full privileges. It is the price of a
status-bar chip, because Orca exposes no contribution point for one.

### Why Orca's own Gemini/Antigravity meters read 100%

Orca resolves the quota project by calling `loadCodeAssist` with
`metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }` and reading
`cloudaicompanionProject` from the response. **Consumer accounts get no such
field**, so the lookup throws, the fetch never happens, and the meter renders a
full bar instead of an error. A meter reading "100% left" there means "no data",
not "no usage".

Orca also hardcodes `weekly: null` and reduces all buckets with
`max(usedPercent)`, so a provider with more than one pool can only ever show one
number. `chipLabel()` renders every active bucket instead.

## Limits worth knowing

The plugin **API** is declarative plus a sandboxed-looking worker. There is no
API for arbitrary renderer JS, no DOM access to Orca's own UI, no network
capability and no process execution. Scoped `net:fetch` and `process:exec` kinds
are named as future phases in the capability model but are not implemented.

**The worker is not actually sandboxed, though.** Orca spawns it with:

```js
fork(entry, [], { env, execArgv: [], serialization: 'advanced', stdio: [...] })
```

`execArgv: []` means no Node permission flags. The `capabilities` array gates
`host.call` and the panel bridge only - it is an access-control list for the
host API, not an OS sandbox. A worker declaring zero capabilities still has full
`fs`, `net` and `child_process` access. `src/orca-runtime.mjs` uses that
deliberately, and `Mod+Alt+R` (`runtime-probe`) demonstrates it.

Three tiers of reach, in increasing order of intrusiveness:

1. **Runtime RPC** - no setup. The worker shells out to the `orca` CLI, or reads
   `orca-runtime.json` from userData for a pid, an authToken and transports
   (a named pipe plus `ws://0.0.0.0:6768` - bound to every interface, not just
   loopback). That covers terminals, worktrees, browser automation, computer-use,
   automations, artifacts, projects and orchestration.
2. **Renderer CDP** - requires launching Orca with `--remote-debugging-port`.
   Orca never appends that switch and does not block it. With a target attached,
   `Runtime.evaluate` runs arbitrary JS inside Orca's UI, which is the only route
   to changes with no contribution point - adding a status-bar item, for example.
   An open CDP port lets any local process drive the app: opt in deliberately.
3. **Patching `app.asar`** - deepest and persistent, but breaks on every update
   and invalidates bundle integrity. Not recommended.

Other things to know:

- Consent is fingerprinted over capabilities and worker trust, so changing
  either re-prompts.
- Orca ships a plugin **kill list**; a blocked plugin reports
  "Blocked by Orca's plugin safety list".
- Idle workers are reaped on a 60s timer.

## License

MIT
