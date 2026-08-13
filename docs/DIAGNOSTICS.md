# Router Observatory diagnostics

Router Observatory is a passive debugging website owned and shipped by the
standalone Hermes Hub Server Router repository. It visualizes evidence that the
Router actually wrote to Client WebSockets, connected Client counts, sessions,
event identifiers, Router cursors, per-Client send indexes, bounded retention
gaps, and recursively redacted event content.

It is not a control plane. Version 1 cannot replay messages, retry a request,
answer a prompt, restart a process, mutate state, inject faults, or remediate an
incident. Gateway Sidecar, Gateway Plugin, and Hermes Agent remain explicitly
`health-only` / `no event probe` until those runtimes gain separate approved
probes.

## Repository ownership

```text
observatory-web/   React/Vite source
observatory/       compiled, versioned installer payload
src/               Router evidence API and WebSocket implementation
```

Run the build from the Router repository root:

```bash
pnpm install
pnpm observatory:build
```

The build writes relative asset URLs, so the website works both at the Router
root and behind a configured Router base path. The standalone installer fetches
`observatory/index.html` plus only safe referenced `observatory/assets/*` files,
with file-count and byte limits.

## Development startup

Create a random observer token. Configure only its SHA-256 on the Router; keep
the original token in your password manager or ephemeral operator environment.

PowerShell:

```powershell
$observerTokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($observerTokenBytes)
$observerToken = [Convert]::ToHexString($observerTokenBytes).ToLowerInvariant()
$observerHashBytes = [Security.Cryptography.SHA256]::HashData(
  [Text.Encoding]::UTF8.GetBytes($observerToken)
)
$observerHash = [Convert]::ToHexString($observerHashBytes).ToLowerInvariant()

$env:HERMES_HUB_ENVIRONMENT = 'development'
$env:HERMES_HUB_DIAGNOSTICS = '1'
$env:HERMES_HUB_DIAGNOSTICS_OBSERVER_TOKEN_SHA256 = $observerHash

pnpm observatory:build
pnpm dev
```

Linux:

```bash
observer_token="$(openssl rand -hex 32)"
observer_hash="$(printf '%s' "$observer_token" | sha256sum | awk '{print $1}')"

export HERMES_HUB_ENVIRONMENT=development
export HERMES_HUB_DIAGNOSTICS=1
export HERMES_HUB_DIAGNOSTICS_OBSERVER_TOKEN_SHA256="$observer_hash"

pnpm observatory:build
pnpm dev
```

Do not print the original token in shared CI or service logs. Open:

```text
https://router.example/_debug/observatory/
```

For a Router URL such as `https://router.example/hermes`, open:

```text
https://router.example/hermes/_debug/observatory/
```

When prompted, enter the original observer token. The browser retains it only
in the current tab's `sessionStorage`. HTTP evidence requests send it as a
Bearer token; the evidence WebSocket uses the single dedicated
`hermes-hub.observer.bearer.<token>` subprotocol. Tokens are never accepted in
URLs.

## Staging and production

Staging requires all development settings plus a separate authenticated proxy
token hash:

```bash
export HERMES_HUB_ENVIRONMENT=staging
export HERMES_HUB_DIAGNOSTICS=1
export HERMES_HUB_DIAGNOSTICS_OBSERVER_TOKEN_SHA256='<sha256>'
export HERMES_HUB_DIAGNOSTICS_PROXY_TOKEN_SHA256='<different-sha256>'
```

The trusted management proxy supplies `X-Hermes-Hub-Diagnostics-Proxy` over
TLS. Do not reuse the observer token as the proxy token. The static site is
hidden with `404` when the staging proxy/observer boundary is absent.

Production must not set `HERMES_HUB_DIAGNOSTICS=1`; explicit production
enablement aborts Router startup. When disabled, every `/_debug/*` HTTP and
WebSocket path is absent or returns `404`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/_debug/observatory/` | Observatory static website. |
| `GET` | `/_debug/api/v1/topology` | Router and Client topology plus unsupported hops. |
| `GET` | `/_debug/api/v1/evidence?limit=N` | Bounded evidence snapshot. |
| `WS` | `/_debug/ws/v1/evidence` | Initial snapshot followed by live evidence. |

`router_egress` is recorded only after the real Client WebSocket `send`
succeeds. Observer failure never changes or reclassifies delivery. The journal
retains at most 50,000 evidence records and 256 MiB; eviction produces a
canonical `gap` record.

## Client Diagnostics Companion integration

The Client Diagnostics Companion remains outside this Router repository because
it is a local Flutter-development service. Point its server-side observer at
this Router without exposing credentials to its browser:

```powershell
$env:ROUTER_OBSERVER_URL = 'https://router.example/_debug/api/v1/evidence?limit=5000'
$env:ROUTER_OBSERVER_TOKEN = '<original-observer-token>'
```

It can then compare Router-authoritative egress with Flutter raw ingress,
decode, realtime gate, session routing, reducer, Cubit, and UI projection.

## Diagnosis guide

- `404` for every debug path: diagnostics are disabled, production is active,
  or a Router base path was omitted from the URL.
- Router startup rejects diagnostics: the environment is unset/production, or
  the observer/proxy hash is missing or not a 64-character SHA-256 hex value.
- HTML loads but an asset is `404`: run `pnpm observatory:build` and confirm the
  versioned `observatory/index.html` and `observatory/assets/` files exist.
- `401 Observer authentication required`: provide the original token whose
  SHA-256 matches `HERMES_HUB_DIAGNOSTICS_OBSERVER_TOKEN_SHA256`.
- Topology says `health-only` / `no event probe`: expected for Gateway Sidecar,
  Gateway Plugin, and Hermes Agent in version 1; do not infer missing traffic.
- Router evidence has no Client match: first check capture windows, journal
  gaps, reconnect generations, and multiple sockets. It is not automatically
  proof of network packet loss.
- Cursor regression across different connection generations is not TCP frame
  reordering. Ordering warnings are meaningful only within one WebSocket
  connection generation.

## Verification

```bash
pnpm check
pnpm observatory:check
tsx src/core/observability/diagnosticsEvidence.smoke.ts
tsx src/features/realtime/clientEventHub.bounds-smoke.ts
node server-router-installer.smoke.mjs
git diff --check
```

For a release or cross-stack change, also run the owning Hermes Hub
Router-contract and Gateway gates from the outer integration checkout.
