# Server Router Agent Notes

This directory owns the public Router / bridge server.

## Layout

- Keep all TypeScript under `src/`.
- Put feature-owned code and its focused smoke beside each other under
  `src/features/<feature>/`.
- Put only cross-feature HTTP, protocol, security, persistence, and logging
  utilities under `src/core/`.
- Keep `src/bridgeServer.ts` as the composition root; do not move feature
  business logic back into the application root.

## Boundary

- Router handles pairing, bridge auth, Agent-scoped native conversation lanes,
  typed event journaling/fan-out, read-plane Gateway RPC, and public
  health/smoke surfaces.
- `HermesGatewayRepository` is the only host-transport seam. Do not add a
  direct Hermes proxy, a second transport registry, or a compatibility route.
- Router must not parse transcript content for UI rendering.
- Router must not expose local Hermes admin/provider credentials.

## Native Session Contract

- Accept new turns only through `/bridge/session-messages`, dispatch them as
  `session_submit`, and fan out `session_event` frames through `/bridge/events`.
- `/bridge/chat-run*` and old command dispatch return
  `410 native_session_required`; they must not start a model turn.
- Preserve native event names and payloads. Do not collapse message updates,
  reasoning, tool calls, prompt requests, or final responses into one status
  string.
- Do not interpret `/model`, `/steer`, `/stop`, or other Hermes slash commands.
  Their original text belongs to the native Gateway lane.
- Include timing/request metrics that help debug latency without logging
  message bodies, pairing codes, bridge tokens, or Gateway credentials.
- Keep fallback response handling compatible with Flutter final-text dedupe.

## Verification

For Router changes run:

```bash
pnpm server:check
```

For native session changes, also run the Gateway contract and provide non-secret
smoke/log evidence showing event names are preserved end to end:

```bash
pnpm smoke:router-contract
pnpm gateway:test
```
