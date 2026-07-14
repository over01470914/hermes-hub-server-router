# Hermes Hub Server Router

The Router owns the public HTTP/WebSocket bridge for Hermes Hub. It receives
Flutter client requests, manages device-to-Agent pairing, tracks authenticated
Hermes Hub Gateway Plugin connections, and dispatches work by stable
`hermesAgentId`.

The only production topology is:

```text
Client -> Router -> Hermes Hub Gateway Plugin -> Hermes Agent
```

The Router never connects directly to a Hermes host and has no second host
transport fallback.

`HermesGatewayRepository` is the only host-transport seam. Its allowlist maps
to Hermes' public session, run/event/stop/approval, and model APIs. Usage is
derived from public session metadata. A route that would require generic slash
or command execution, steer, clarify/sudo/secret response, configuration or
reasoning/fast mutation, or a persistent session-model patch fails closed with
an explicit unsupported response.

Run from this standalone repository root:

```bash
pnpm install
pnpm init:router
pnpm dev
```

From the Hermes Hub monorepo root, use:

```bash
pnpm router:init
pnpm router:dev
```

After verifying the Gateway installer from a local loopback pairing prompt,
the monorepo launcher can pass the private Router token directly to that child
without exposing it to the Hermes agent conversation:

```bash
pnpm router:pair-gateway -- --installer <verified-installer> --request-id <pair-id>
```

It rejects non-loopback Router URLs and never prints the token. Remote or
standalone hosts must provision the same token directly into the installer
process environment.

`HERMES_HUB_AGENT_APPROVAL_TOKEN` is required in development and production.
`router:init` generates it once in the ignored repository-root `.env`, and
`router:dev` automatically initializes and loads that file. Normal starts
reuse the existing value. Explicitly rotate it with
`pnpm router:rotate-approval-token`, or clear it with
`pnpm router:clear-approval-token` before the next init/run creates a new
value. Restart the Router after either action and provide the new
value to later one-shot Gateway installer approvals. Never place the value in
source, command arguments, logs, pairing prompts, or `.workspace/local.env`.
Managed Router installation creates the same secret in its private Router
environment file; `--rotate-agent-approval-token` is the explicit managed
rotation switch.

Before spawning Router, the local launcher probes the configured local health
endpoint and verifies that the listen port is available. If a legacy Router,
another Gateway-only Router, or a non-Router process already owns the port, it
fails with an explicit restart/ownership message instead of surfacing Node's
raw `EADDRINUSE` exception. It never terminates an unknown process
automatically.

The local initializer writes atomically and fails closed when the environment
path is a symlink or non-regular file. POSIX uses mode `0600`; Windows removes
inherited ACL entries and grants the current user full control. Neither init
nor rotation prints the token.

The managed Router installer defaults to the public GitHub raw source at
`https://raw.githubusercontent.com/over01470914/hermes-hub-server-router/main/`
and downloads the Gateway package independently from
`https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/`.
Both default sources are public and require no repository credential. An
explicit private CNB mirror may use a machine-local read-only `CNB_TOKEN`, sent
only to the exact `cnb.cool` host and never written to a URL or log. The
installer also deploys the public six-file Gateway package and
`src/features/gateway/gatewayPluginSource.ts`.
It downloads the package manifest and all fixed
payload names without redirects, enforces byte bounds, verifies SHA-256, and
only then atomically replaces the served package directory. The Router exposes
that directory at `apps/hermes-hub-gateway-plugin/` under the configured Router
base path so a pairing command can bootstrap from a standalone `install.mjs`.
`GET /router/health` advertises the optional Router-origin mirror plus the
immutable public release repository, commit, URLs, installer bytes, and SHA-256.
An Agent uses the public content-addressed release in production without
assuming the Router checkout layout or deployment base path.

The pairing prompt bootstraps from an immutable Gateway repository commit and
pins the installer's exact byte count and SHA-256. The Agent writes one new
temporary `.mjs` helper instead of embedding JavaScript in a shell command; the
helper uses only Node.js built-in APIs to download without execution, verifies
the raw bytes, and then runs one direct child with shell execution disabled. It
forbids manual approve
probes, retries, and alternative recovery commands after unexpected HTTP or
process errors.
When an Agent terminal supports execution permission modes, the prompt requires
the first helper invocation to permit loopback HTTP, public HTTPS, OS-temp
writes, and host plugin installation instead of probing in a network-isolated
sandbox and retrying.
The helper checks only that the approval credential reached its environment and
never prints it. Installer failures preserve the last official stderr message
after removing credentials, token-like values, and absolute paths, so operators
can distinguish credential, ACL, lifecycle, and network failures without
exposing secrets or host paths.
The installer discovers Hermes through CLI arguments, environment, PATH, and
`hermes config path`; it does not assume a username, drive letter, home path,
checkout location, shell, or service manager. Git and pnpm are not production
dependencies.
The Agent-side preflight uses `HERMES_COMMAND` when the host launcher provides
it and otherwise resolves `hermes` from PATH; the pairing prompt never embeds a
host-specific executable path.
The Router accepts both prefixed requests and requests whose trusted reverse
proxy has already removed that prefix.

Compatibility alias:

```bash
pnpm server-router:dev
```

## Contract

- Keep pairing and bridge auth at the Router boundary.
- Relay Gateway stream frames without turning Hermes events into flat status
  text.
- Preserve event names, payloads, timing metrics, and fallback response data needed by Flutter.
- Treat Router progress messages as control-plane activity only.
- Do not expose local Hermes admin/provider credentials.
- Keep Gateway transport ids and credentials outside the Flutter contract.
- Resolve stop and approval against an exact active run; never dispatch them as
  an unscoped generic command.

Verify this standalone repository with:

```bash
pnpm test
```

From the Hermes Hub monorepo root, verify Router/Gateway integration changes
with:

```bash
pnpm server:check
pnpm smoke:router-contract
```

## Source layout

All Router TypeScript lives under `src/` and is grouped by ownership:

```text
router-local-env.mjs        # local private-env init, rotation, and dev launcher
router-local-env.smoke.mjs  # local environment and ACL smoke
server-router-installer.mjs # standalone managed installation entrypoint
src/
  bridgeServer.ts              # composition root and public route orchestration
  core/                        # shared HTTP, protocol, security, persistence, logging
  features/
    cron/
    diagnostics/
    gateway/
    kanban/
    pairing/
    realtime/
    sessions/
```

Smoke files stay beside the module or feature they verify. The local
environment launcher and its smoke remain at the application root because
they must run before TypeScript startup. The public `server-router-installer.mjs`
also remains there because its URL is part of the managed installation flow.
