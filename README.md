# Hermes Hub Server Router

The Router is the public HTTP/WebSocket boundary between paired Flutter
devices and lifecycle-owned Hermes Hub Gateway Plugins.

```text
Flutter -> Router -> Hermes Hub Gateway Plugin -> Hermes Agent
```

It never connects directly to Hermes, never calls a model, and has no alternate
host transport.

## Native session v2

The Gateway WSS protocol is `hermes-hub-gateway-rpc/v2`.

- Read plane: `rpc_request` / `rpc_response` and heartbeat.
- Router to Gateway: `session_submit`, `session_prompt_response`.
- Gateway to Router: `session_submit_ack`, unsolicited `session_event`.
- Native capabilities: `session.message`, `session.prompt-response`.

The Router keeps an Agent-scoped persistent registry keyed by
`hermesAgentId + conversationId`. It stores lane/session/submission/prompt ids,
state, and timestamps only. Message bodies, outputs, tokens, and credentials
are never stored in that registry.

`POST /bridge/session-messages` returns `202` after native adapter
acknowledgement. It does not wait for turn completion. Submission ids are
idempotent; ambiguous sends are not retried. The Router does not impose a busy
409 on a lane, so follow-up, `/steer`, and `/stop` remain Hermes-native input.

`/bridge/events` is a v2 Agent-scoped journal. It fans native events to every
paired device, including origin, with cursor replay and event-id dedup.

Request-bound conversation routes are removed:

- `/bridge/chat-run` -> `410 native_session_required`
- `/bridge/chat-run/stream` -> `410 native_session_required`
- old run stop/approval command dispatch -> `410 native_session_required`

Legacy sessions remain readable/exportable and are projected as read-only.

## Running locally

From this standalone repository:

```powershell
pnpm install
pnpm init:router
pnpm dev
```

From the Hermes Hub monorepo root:

```powershell
pnpm router:init
pnpm router:dev
pnpm router:stop
```

Compatibility alias: `pnpm server-router:dev`.

`HERMES_HUB_AGENT_APPROVAL_TOKEN` is required in development and production.
The local initializer creates it in the ignored private environment. Rotate or
clear it only through the provided Router scripts, restart Router afterward,
and never place it in source, arguments, logs, prompts, or
`.workspace/local.env`.

The launcher uses a private PID state file, validates the recorded process
identity before stopping it, and never kills by process name. Environment
writes are atomic; POSIX permissions are `0600`, and Windows ACL inheritance is
removed where supported.

## Pairing and release metadata

Each device receives a bridge token scoped to one stable `hermesAgentId`.
Gateway credentials are separate rotatable transport principals with
provisional, active, and revoked states. A provisional Gateway cannot carry
existing Agent traffic until claim atomically promotes its exact connection.

GitHub publishes agent-facing skills. npm publishes
`@over01470914/hermes-hub-gateway@0.4.1`, including the manifest-verified
runtime and deterministic pairing core. `/router/health` publishes the package
name, version, and runtime manifest SHA-256. The Router does not serve
executable Gateway runtime files.

The pairing prompt uses the concise npm CLI flow. The CLI verifies its bundled
release policy and runtime manifest, performs Hermes readiness checks, runs one
installer transaction, and returns the Router-issued 8-digit code. Prompt text
does not grant terminal access; Hermes must request native approval for the
exact command.

## Contract rules

- Pairing, bridge auth, Agent selection, and event scope stay at the Router.
- Gateway and Agent identities have separate lifetimes.
- Unknown Agent/lane/event/prompt correlation fails closed.
- All Hermes slash commands are message text; Router does not interpret them.
- `HermesGatewayRepository` is the only host transport seam.
- Read-plane calls use a bounded allowlist and required capability checks.
- Missing capability returns explicit unsupported; there is no private API or
  transport fallback.
- No message body, prompt, output, token, pairing code, or secret in logs.
- Cron and Kanban routes remain shaped and fail closed until a complete
  approved public capability is available.

## Verification

From the monorepo root:

```powershell
pnpm server:check
pnpm hermes-hub-gateway:test
pnpm smoke:router-contract
pnpm smoke:mock-hub
```

## Source layout

```text
router-local-env.mjs
router-local-env.smoke.mjs
server-router-installer.mjs
src/
  bridgeServer.ts
  core/
  features/
    cron/
    diagnostics/
    gateway/
    kanban/
    pairing/
    realtime/
    sessions/
```

Feature smoke files stay beside the implementation they verify.
