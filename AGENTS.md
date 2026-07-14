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

- Router handles pairing, bridge auth, Hermes Agent-scoped Gateway dispatch,
  stream relay, timeout/error framing, and public health/smoke surfaces.
- `HermesGatewayRepository` is the only host-transport seam. Do not add a
  direct Hermes proxy, a second transport registry, or a compatibility route.
- Router must not parse transcript content for UI rendering.
- Router must not expose local Hermes admin/provider credentials.

## Stream Contract

- Preserve Hermes event names and payloads in `/bridge/chat-run/stream`.
- Do not collapse deltas, reasoning, tool calls, prompt requests, or final responses into one status string.
- Router status such as `Router accepted the stream request` is control-plane activity only.
- Include timing/request metrics that help debug latency without logging
  message bodies, pairing codes, bridge tokens, or Gateway credentials.
- Keep fallback response handling compatible with Flutter final-text dedupe.

## Verification

For Router changes run:

```bash
pnpm server:check
```

For stream changes, also run the Gateway contract and provide non-secret
smoke/log evidence showing event names are preserved end to end:

```bash
pnpm smoke:router-contract
pnpm hermes-hub-gateway:test
```
