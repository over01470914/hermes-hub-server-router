import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { issueBridgeToken, readBridgeConfig } from '../../core/security/bridgeAuth.js'

type Json = Record<string, unknown>

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (!address || typeof address === 'string') throw new Error('No loopback port')
  return address.port
}

async function response(url: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const raw = await fetch(url, init)
  return { status: raw.status, body: JSON.parse(await raw.text()) as Json }
}

async function waitFor(baseUrl: string, child: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Router exited\n${output()}`)
    try {
      if ((await fetch(`${baseUrl}/router/health`)).ok) return
    } catch { /* starting */ }
    await delay(30)
  }
  throw new Error(`Router did not start\n${output()}`)
}

async function connectGateway(baseUrl: string, gatewayId: string, agentId: string, token: string): Promise<WebSocket> {
  const url = new URL(`/router/hermes-hub-gateways/${gatewayId}/stream`, baseUrl)
  url.protocol = 'ws:'
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  await once(socket, 'open')
  socket.send(JSON.stringify({
    type: 'hello', gatewayId, hermesAgentId: agentId,
    runtime: 'hermes-hub-gateway', mode: 'native-session',
    protocols: ['hermes-hub-gateway-rpc/v2'],
    capabilities: ['health', 'sessions', 'session.message', 'session.prompt-response'],
  }))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No hello acknowledgement')), 2_000)
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()) as Json
      if (frame.type !== 'hello_ack') return
      clearTimeout(timer)
      resolve()
    })
  })
  return socket
}

const routerRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const working = await mkdtemp(join(tmpdir(), 'hermes-hub-connection-health-'))
const listenPort = await port()
const baseUrl = `http://127.0.0.1:${listenPort}`
const agentId = 'agent_connection_health_a'
const gatewayId = 'gw_connection_health_a'
const gatewayToken = `connection-health-gateway-${'a'.repeat(40)}`
const pairingCode = '13572468'
const tsx = createRequire(import.meta.url).resolve('tsx/cli')
let stdout = ''
let stderr = ''
const child = spawn(process.execPath, [tsx, join(routerRoot, 'src', 'bridgeServer.ts')], {
  cwd: routerRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env, NODE_ENV: 'development', HERMES_HUB_ROUTER_HOST: '127.0.0.1',
    HERMES_HUB_ROUTER_PORT: String(listenPort), HERMES_HUB_ROUTER_URL: baseUrl,
    HERMES_HUB_BRIDGE_SECRET: 'connection-health-bridge-secret-value',
    HERMES_HUB_PAIRING_CODE: pairingCode,
    HERMES_HUB_AGENT_APPROVAL_TOKEN: `connection-health-approval-${'a'.repeat(48)}`,
    HERMES_HUB_PAIRING_STORE_PATH: join(working, 'pairing.json'),
    HERMES_HUB_SESSION_METADATA_STORE_PATH: join(working, 'metadata.json'),
    HERMES_HUB_DIAGNOSTICS_DIR: join(working, 'diagnostics'),
    HERMES_HUB_DEBUG_GATEWAY: '1', HERMES_HUB_DEBUG_GATEWAY_BUILD: 'debug-testing',
    HERMES_HUB_DEBUG_GATEWAY_PAIRING_CODE: pairingCode,
    HERMES_HUB_DEBUG_PAIRING_REQUEST_ID: 'pair_connection_health',
    HERMES_HUB_DEBUG_AGENT_ID: agentId, HERMES_HUB_DEBUG_GATEWAY_ID: gatewayId,
    HERMES_HUB_DEBUG_GATEWAY_TOKEN: gatewayToken, HERMES_HUB_LOG_LEVEL: 'warn',
  },
})
child.stdout.on('data', value => { stdout += String(value) })
child.stderr.on('data', value => { stderr += String(value) })
let gateway: WebSocket | undefined
try {
  await waitFor(baseUrl, child, () => `${stdout}\n${stderr}`)
  assert.equal((await response(`${baseUrl}/bridge/connection-health`)).status, 401, 'endpoint must require a bridge token')
  gateway = await connectGateway(baseUrl, gatewayId, agentId, gatewayToken)
  const claim = await response(`${baseUrl}/router/pairing/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'pair_connection_health', code: pairingCode }),
  })
  const authorization = { authorization: `Bearer ${String(claim.body.token)}` }
  const received: Json[] = []
  gateway.on('message', value => received.push(JSON.parse(value.toString()) as Json))
  gateway.send(JSON.stringify({
    type: 'operational_snapshot', gatewayId, hermesAgentId: agentId,
    snapshot: {
      object: 'hermes-hub.gateway.operational', version: 2, sampledAt: Date.now(),
      eventLoop: { sampleCount: 1, lastMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, signal: 'ok' },
      fileDescriptors: { consecutiveHighSamples: 0, signal: 'ok' },
      tasks: {}, semaphore: {}, outbound: {
        control: { depth: 0, oldestAgeMs: 0, highWaterDepth: 2, overflowCount: 0 },
        data: { depth: 0, oldestAgeMs: 0, highWaterDepth: 3, overflowCount: 0 },
      }, rpcCancel: {}, reconnect: { count: 2, lastHandshakeDurationMs: 12, lastHandshakeOutcome: 'reconnected' },
    },
  }))
  await delay(50)
  const health = await response(`${baseUrl}/bridge/connection-health`, { headers: authorization })
  assert.equal(health.status, 200)
  assert.deepEqual(Object.keys(health.body).sort(), ['object', 'pressure', 'recovery', 'route', 'sampledAt', 'stale', 'version'])
  assert.equal(health.body.object, 'hermes-hub.connection-health')
  assert.equal(health.body.stale, false)
  const wire = JSON.stringify(health.body)
  for (const forbidden of [agentId, gatewayId, 'gatewayConnectionId', 'hermesAgentId', 'lastHandshakeDurationMs']) assert.equal(wire.includes(forbidden), false)
  assert.equal(received.filter(frame => frame.type === 'heartbeat' || frame.type === 'rpc_request').length, 0, 'health read must not send a Gateway frame')
  const otherToken = issueBridgeToken({
    pairingCode, deviceId: 'device_connection_health_other', hermesAgentId: 'agent_connection_health_b',
  }, readBridgeConfig({ HERMES_HUB_PAIRING_CODE: pairingCode, HERMES_HUB_BRIDGE_SECRET: 'connection-health-bridge-secret-value' }))
  const isolated = await response(`${baseUrl}/bridge/connection-health`, { headers: { authorization: `Bearer ${otherToken}` } })
  assert.equal(isolated.status, 200)
  assert.equal(JSON.stringify(isolated.body).includes(agentId), false, 'Agent B must not observe Agent A health')
  assert.equal(isolated.body.stale, true, 'Agent B has no cached Gateway snapshot')
  await delay(15_100)
  const stale = await response(`${baseUrl}/bridge/connection-health`, { headers: authorization })
  assert.equal(stale.body.stale, true, 'operational snapshots become stale after 15 seconds')
  console.log('connection health integration smoke passed')
} finally {
  if (gateway?.readyState === WebSocket.OPEN) gateway.close()
  if (child.exitCode === null) child.kill()
  await rm(working, { recursive: true, force: true })
}
