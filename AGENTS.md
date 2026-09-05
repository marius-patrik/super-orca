# Working on Super Orca

Guidance for coding agents. `CLAUDE.md` is a symlink to this file — edit `AGENTS.md`.

## What this repo is

A single Orca plugin that deliberately uses the *entire* plugin API v0 surface.
Its value is twofold: a working reference implementation, and the API
documentation in `README.md` — none of which Orca publishes. Keep both accurate.

## Layout

```
orca-plugin.json    manifest (the contract; validate any change)
src/main.mjs        worker entry - ESM, default-exported activate()
panels/control.html panel body - host prepends its own shell
README.md           reverse-engineered API v0 reference
```

## Hard rules

These come from the host and will break activation if violated:

- `src/main.mjs` must stay an **ES module** with a **default-exported** activate
  function. It is loaded via `import()` of a file URL in a child process.
- Every command registered in the worker must be declared in the manifest
  **without** an `action` field. Registering an undeclared command fails
  activation with `registered undeclared command <id>`.
- A manifest command **with** an `action` is handled by a built-in and must not
  be registered in the worker. Only the 16 allowlisted actions parse.
- Never implement an `orca-panel-pong` responder in panel HTML. The host shell
  injects one; a second responder is not needed and the watchdog demotes panels
  that miss a 5s pong deadline.
- Panel HTML runs under `connect-src 'none'`. No fetch, no XHR, no WebSocket, no
  external stylesheets, fonts or images. Inline everything, `data:` URIs only.
- Panels may only call host methods flagged panel-callable:
  `workspace.readContext`, `terminal.sendText`, `notifications.show`. Storage,
  secrets, settings and event subscription are worker-only.
- Adding or removing a capability changes the consent fingerprint and re-prompts
  the user. Do not add capabilities the code does not actually use.

## Validate before committing

Run the manifest through Orca's own validator rather than eyeballing it:

```bash
node -e "
const P='C:/Users/patrik/AppData/Local/Programs/orca/resources/app.asar.unpacked/out/shared/plugins/';
const m=require(P+'plugin-manifest.js');
const r=m.parsePluginManifest(require('fs').readFileSync('orca-plugin.json','utf8')&&JSON.parse(require('fs').readFileSync('orca-plugin.json','utf8')));
console.log(r.ok ? 'valid: '+m.qualifiedPluginKey(r.manifest) : 'INVALID: '+r.error)"
```

Adjust the path for your Orca install; it needs `zod`, so run it with the
`resources` directory as cwd.

Check the worker still loads the way the host loads it:

```bash
node -e "import('file:///ABSOLUTE/PATH/src/main.mjs').then(m=>console.log(typeof m.default))"
```

## Testing in Orca

Add the repo path under Settings → Advanced → dev plugin paths, then approve the
consent prompt. Dev paths are watched, so saves hot-reload the plugin. Idle
workers are reaped after 60s — a command invocation restarts one.

`Mod+Alt+P` runs the self test and reports per-capability pass/fail; use it to
confirm a change did not silently drop a capability.

## Do not

- Do not add a build step, bundler or dependencies. The host imports
  `src/main.mjs` directly and the panel is plain inline HTML. Keep it zero-install.
- Do not claim API surface in `README.md` that has not been verified against the
  files in `out/shared/plugins/`. The reference's worth is that it is accurate.
- Do not commit anything derived from the Orca app bundle — cite behaviour,
  never copy code.
