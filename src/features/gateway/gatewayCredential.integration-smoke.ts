import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Failed to reserve Gateway rotation smoke port')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return address.port
}

interface RouterProcess {
  child: ChildProcessWithoutNullStreams
  output: () => string
}

async function waitForRouter(baseUrl: string, router: RouterProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (router.child.exitCode != null) {
      throw new Error(`Router exited before health check (${router.child.exitCode})\n${router.output()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/router/health`)
      if (response.ok) return
    } catch {
      // Router is still starting.
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for Gateway rotation smoke Router\n${router.output()}`)
}

async function stopRouter(router: RouterProcess): Promise<void> {
  if (router.child.exitCode != null || router.child.signalCode != null) return
  const exited = once(router.child, 'exit')
  router.child.kill()
  await Promise.race([exited, delay(2_000)])
  if (router.child.exitCode == null && router.child.signalCode == null) router.child.kill('SIGKILL')
}

function startRouter(repositoryRoot: string, env: NodeJS.ProcessEnv): RouterProcess {
  const tsxCli = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const routerEntry = join(repositoryRoot, 'apps', 'hermes-hub-server-router', 'src', 'bridgeServer.ts')
  const child = spawn(process.execPath, [tsxCli, routerEntry], {
    cwd: repositoryRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return { child, output: () => `${stdout}\n${stderr}`.trim() }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { error: text }
  }
  if (!response.ok) {
    const error = typeof body === 'object' && body && 'error' in body ? String(body.error) : `HTTP ${response.status}`
    throw new Error(`${error} (${response.status})`)
  }
  return body as T
}

function waitForFrame(socket: WebSocket, type: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`Timed out waiting for Gateway ${type} frame`))
    }, timeoutMs)
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>
      if (frame.type !== type) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

async function connectGateway(
  baseUrl: string,
  gatewayId: string,
  hermesAgentId: string,
  gatewayToken: string,
): Promise<{ socket: WebSocket; helloAck: Record<string, unknown> }> {
  const streamUrl = new URL(`/router/hermes-hub-gateways/${encodeURIComponent(gatewayId)}/stream`, baseUrl)
  streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(streamUrl, {
    headers: { authorization: `Bearer ${gatewayToken}` },
  })
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>
    if (frame.type !== 'heartbeat' || typeof frame.id !== 'string') return
    socket.send(JSON.stringify({
      type: 'heartbeat_ack',
      id: frame.id,
      gatewayId,
      hermesAgentId,
    }))
  })
  const ready = waitForFrame(socket, 'ready')
  await once(socket, 'open')
  await ready
  const helloAck = waitForFrame(socket, 'hello_ack')
  socket.send(JSON.stringify({
    type: 'hello',
    gatewayId,
    hermesAgentId,
    runtime: 'hermes-hub-gateway',
    mode: 'api-server',
    protocols: ['hermes-hub-gateway-rpc/v1'],
    capabilities: ['health', 'sessions'],
  }))
  return { socket, helloAck: await helloAck }
}

async function expectGatewayRejected(
  baseUrl: string,
  gatewayId: string,
  gatewayToken: string,
): Promise<void> {
  const streamUrl = new URL(`/router/hermes-hub-gateways/${encodeURIComponent(gatewayId)}/stream`, baseUrl)
  streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(streamUrl, {
    headers: { authorization: `Bearer ${gatewayToken}` },
  })
  await new Promise<void>((resolve, reject) => {
    let opened = false
    const timeout = setTimeout(() => {
      socket.terminate()
      reject(new Error('Revoked Gateway credential was not rejected promptly'))
    }, 2_000)
    socket.once('open', () => {
      opened = true
      clearTimeout(timeout)
      socket.close()
      reject(new Error('Revoked Gateway credential reopened a WebSocket'))
    })
    socket.once('error', () => {
      if (opened) return
      clearTimeout(timeout)
      resolve()
    })
    socket.once('close', () => {
      if (opened) return
      clearTimeout(timeout)
      resolve()
    })
  })
}

interface PairingApprovalResponse {
  requestId: string
  randomCode: string
  hermesAgentId: string
  gatewayId: string
  gatewayToken?: unknown
}

interface PairingClaimResponse {
  token: string
  hermesAgentId: string
  status: string
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const port = await reserveLoopbackPort()
const workdir = await mkdtemp(join(tmpdir(), 'hermes-hub-gateway-rotation-'))
const pairingStorePath = join(workdir, 'pairing-store.json')
const baseUrl = `http://127.0.0.1:${port}`
const agentApprovalToken = 'rotation-smoke-agent-approval-' + 'a'.repeat(48)
const hermesAgentId = 'agent_integration_rotation'
const originalGatewayId = 'gw_integration_original'
const originalGatewayToken = 'integration-original-gateway-token-00000000000000001'
const candidateGatewayId = 'gw_integration_candidate'
const candidateGatewayToken = 'integration-candidate-gateway-token-0000000000000002'
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  HERMES_HUB_ROUTER_HOST: '127.0.0.1',
  HERMES_HUB_ROUTER_PORT: String(port),
  HERMES_HUB_ROUTER_URL: baseUrl,
  HERMES_HUB_BRIDGE_SECRET: 'rotation-smoke-bridge-secret-value',
  HERMES_HUB_PAIRING_CODE: '13572468',
  HERMES_HUB_AGENT_APPROVAL_TOKEN: agentApprovalToken,
  HERMES_HUB_PAIRING_STORE_PATH: pairingStorePath,
  HERMES_HUB_SESSION_METADATA_STORE_PATH: join(workdir, 'session-metadata.json'),
  HERMES_HUB_DIAGNOSTICS_DIR: join(workdir, 'diagnostics'),
  HERMES_HUB_LOG_LEVEL: 'warn',
}
const approvalHeaders = {
  'content-type': 'application/json',
  'x-hermes-hub-agent-approval': agentApprovalToken,
}

let router = startRouter(repositoryRoot, env)
let originalSocket: WebSocket | undefined
let candidateSocket: WebSocket | undefined
try {
  await waitForRouter(baseUrl, router)

  const health = await fetchJson<{
    gatewayPlugin: { sourceUrl: string; installerUrl: string; manifestUrl: string }
  }>(`${baseUrl}/router/health`)
  assert.deepEqual(health.gatewayPlugin, {
    sourceUrl: `${baseUrl}/apps/hermes-hub-gateway-plugin/`,
    installerUrl: `${baseUrl}/apps/hermes-hub-gateway-plugin/install.mjs`,
    manifestUrl: `${baseUrl}/apps/hermes-hub-gateway-plugin/package-manifest.json`,
  })
  const advertisedInstaller = await fetch(health.gatewayPlugin.installerUrl)
  assert.equal(advertisedInstaller.status, 200)
  assert.match(await advertisedInstaller.text(), /^#!\/usr\/bin\/env node/)

  const firstRequest = await fetchJson<{ requestId: string }>(`${baseUrl}/router/pairing/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device_rotation_first', ttlSeconds: 300 }),
  })
  const firstApproval = await fetchJson<PairingApprovalResponse>(`${baseUrl}/router/pairing/approve`, {
    method: 'POST',
    headers: approvalHeaders,
    body: JSON.stringify({
      requestId: firstRequest.requestId,
      hermesAgentId,
      gatewayId: originalGatewayId,
      gatewayToken: originalGatewayToken,
    }),
  })
  assert.equal(firstApproval.gatewayToken, undefined, 'pairing approval must not echo the Gateway transport token')
  const original = await connectGateway(baseUrl, originalGatewayId, hermesAgentId, originalGatewayToken)
  originalSocket = original.socket
  assert.equal(original.helloAck.routable, false)
  assert.equal(original.helloAck.gatewayCredentialState, 'provisional')
  assert.equal(
    (await fetchJson<{ hermesAgentsOnline: number }>(`${baseUrl}/router/health`)).hermesAgentsOnline,
    0,
    'a provisional connection must not count as an online Agent route',
  )

  const firstClaim = await fetchJson<PairingClaimResponse>(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: firstRequest.requestId, code: firstApproval.randomCode }),
  })
  assert.equal(firstClaim.status, 'paired')
  const recoveredFirstClaim = await fetchJson<PairingClaimResponse>(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: firstRequest.requestId, code: firstApproval.randomCode }),
  })
  assert.equal(recoveredFirstClaim.token, firstClaim.token, 'claim retry must return the same bridge credential')
  const firstHeartbeat = await fetchJson<{ gateway: { online: boolean } }>(`${baseUrl}/router/heartbeat`, {
    headers: { authorization: `Bearer ${firstClaim.token}` },
  })
  assert.equal(firstHeartbeat.gateway.online, true)
  assert.equal((await fetchJson<{ hermesAgentsOnline: number }>(`${baseUrl}/router/health`)).hermesAgentsOnline, 1)

  const rotationRequest = await fetchJson<{ requestId: string }>(`${baseUrl}/router/pairing/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device_rotation_second', ttlSeconds: 300 }),
  })
  const rotationApproval = await fetchJson<PairingApprovalResponse>(`${baseUrl}/router/pairing/approve`, {
    method: 'POST',
    headers: approvalHeaders,
    body: JSON.stringify({
      requestId: rotationRequest.requestId,
      hermesAgentId,
      gatewayId: candidateGatewayId,
      gatewayToken: candidateGatewayToken,
    }),
  })
  assert.equal(rotationApproval.gatewayToken, undefined, 'rotated Gateway transport token must not be echoed')
  const candidate = await connectGateway(baseUrl, candidateGatewayId, hermesAgentId, candidateGatewayToken)
  candidateSocket = candidate.socket
  assert.equal(candidate.helloAck.routable, false)
  assert.equal(candidate.helloAck.gatewayCredentialState, 'provisional')
  const beforeClaimHeartbeat = await fetchJson<{ gateway: { online: boolean } }>(`${baseUrl}/router/heartbeat`, {
    headers: { authorization: `Bearer ${firstClaim.token}` },
  })
  assert.equal(beforeClaimHeartbeat.gateway.online, true, 'existing Bridge traffic must stay on the old active Gateway')

  const originalClosed = once(originalSocket, 'close')
  const rotationClaim = await fetchJson<PairingClaimResponse>(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: rotationRequest.requestId, code: rotationApproval.randomCode }),
  })
  assert.equal(rotationClaim.status, 'paired')
  const recoveredRotationClaim = await fetchJson<PairingClaimResponse>(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: rotationRequest.requestId, code: rotationApproval.randomCode }),
  })
  assert.equal(recoveredRotationClaim.token, rotationClaim.token, 'rotation claim retry must be idempotent')
  const [closeCode] = await Promise.race([
    originalClosed,
    delay(2_000).then(() => { throw new Error('Old Gateway socket was not closed after credential rotation') }),
  ]) as [number, Buffer]
  assert.equal(closeCode, 4403)
  await expectGatewayRejected(baseUrl, originalGatewayId, originalGatewayToken)
  const persistedPairingState = await readFile(pairingStorePath, 'utf8')
  assert.equal(persistedPairingState.includes(originalGatewayToken), false)
  assert.equal(persistedPairingState.includes(candidateGatewayToken), false)
  assert.match(persistedPairingState, /"gatewayCredentialState": "revoked"/)
  assert.match(persistedPairingState, /"gatewayCredentialState": "active"/)
  assert.equal((await readdir(workdir)).some(name => name.endsWith('.tmp')), false)
  if (process.platform !== 'win32') {
    assert.equal((await stat(pairingStorePath)).mode & 0o077, 0, 'pairing store must not be group/world accessible')
  }

  const rotatedHeartbeat = await fetchJson<{ gateway: { online: boolean } }>(`${baseUrl}/router/heartbeat`, {
    headers: { authorization: `Bearer ${rotationClaim.token}` },
  })
  assert.equal(rotatedHeartbeat.gateway.online, true)

  candidateSocket.close()
  await once(candidateSocket, 'close')
  candidateSocket = undefined
  await stopRouter(router)

  router = startRouter(repositoryRoot, env)
  await waitForRouter(baseUrl, router)
  const restartedCandidate = await connectGateway(baseUrl, candidateGatewayId, hermesAgentId, candidateGatewayToken)
  candidateSocket = restartedCandidate.socket
  assert.equal(restartedCandidate.helloAck.routable, true)
  assert.equal(restartedCandidate.helloAck.gatewayCredentialState, 'active')
  await expectGatewayRejected(baseUrl, originalGatewayId, originalGatewayToken)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'first Gateway stays provisional until Client claim',
      'Router health counts only active routable Agents',
      'Router health advertises a reachable Gateway Plugin installer mapping',
      'existing Bridge traffic stays on the active route during rotation',
      'claim promotes the candidate and closes the old WSS',
      'claim retries return the same bridge credential and repeat runtime reconciliation safely',
      'revoked token cannot reconnect',
      'persistent state contains hashes only and uses an atomic private file',
      'active and revoked credential state survives Router restart',
    ],
  }, null, 2))
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nRouter output:\n${router.output()}`)
} finally {
  if (originalSocket?.readyState === WebSocket.OPEN) originalSocket.close()
  if (candidateSocket?.readyState === WebSocket.OPEN) candidateSocket.close()
  await stopRouter(router)
  await rm(workdir, { recursive: true, force: true })
}
