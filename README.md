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
| Commands | 3 worker-handled + 3 bound to built-in actions |
| Keybindings | 3 |
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

## Limits worth knowing

- Plugins are **declarative plus a sandboxed worker**. There is no API for
  arbitrary renderer JS, no DOM access to Orca's own UI, no network capability,
  and no process execution. Scoped `net:fetch` and `process:exec` kinds are
  named as future phases in the capability model but are not implemented.
- Consent is fingerprinted over capabilities and worker trust, so changing
  either re-prompts.
- Orca ships a plugin **kill list**; a blocked plugin reports
  "Blocked by Orca's plugin safety list".
- Idle workers are reaped on a 60s timer.

## License

MIT
