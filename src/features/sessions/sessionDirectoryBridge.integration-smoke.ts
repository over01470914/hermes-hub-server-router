import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

type JsonRecord = Record<string, unknown>

interface RouterProcess {
  child: ChildProcessWithoutNullStreams
  output: () => string
}

interface PlannedGatewayResponse {
  status: number
  body: JsonRecord
}

interface HttpJsonResponse {
  status: number
  body: JsonRecord
}

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Failed to reserve Session Directory smoke port')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return address.port
}

function startRouter(repositoryRoot: string, routerPackageRoot: string, env: NodeJS.ProcessEnv): RouterProcess {
  const tsxCli = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const routerEntry = join(routerPackageRoot, 'src', 'bridgeServer.ts')
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

async function stopRouter(router: RouterProcess): Promise<void> {
  if (router.child.exitCode != null || router.child.signalCode != null) return
  const exited = once(router.child, 'exit')
  router.child.kill()
  await Promise.race([exited, delay(2_000)])
  if (router.child.exitCode == null && router.child.signalCode == null) router.child.kill('SIGKILL')
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
  throw new Error(`Timed out waiting for Session Directory smoke Router\n${router.output()}`)
}

async function waitUntil(label: string, predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function fetchJson(url: string, init?: RequestInit): Promise<HttpJsonResponse> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: JsonRecord = {}
  try {
    const parsed = text ? JSON.parse(text) as unknown : {}
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : { value: parsed }
  } catch {
    body = { error: text }
  }
  return { status: response.status, body }
}

function waitForFrame(socket: WebSocket, type: string, timeoutMs = 2_000): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`Timed out waiting for Gateway ${type} frame`))
    }, timeoutMs)
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as JsonRecord
      if (frame.type !== type) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

function sessionRows(): JsonRecord[] {
  const continuationIds = [
    'session_cache_root',
    'session_cache_compact_2',
    'session_cache_compact_3',
    'session_cache_compact_4',
    'session_cache_compact_5',
    'session_cache_compact_6',
  ]
  const rows = continuationIds.map((id, index): JsonRecord => ({
    id,
    title: index === 0 ? 'Knowledge collaboration' : `Knowledge collaboration #${index + 1}`,
    source: 'cli',
    profile_name: 'default',
    parent_session_id: index === 0 ? null : continuationIds[index - 1],
    started_at: 100 + index * 10,
    ...(index < continuationIds.length - 1
      ? { ended_at: 105 + index * 10, end_reason: 'compression' }
      : {}),
    last_active: 109 + index * 10,
    message_count: 20 + index,
    preview: index === continuationIds.length - 1 ? 'preview_must_not_persist' : undefined,
    user_id: 'user_id_must_not_persist',
    system_prompt: 'system_prompt_must_not_persist',
    model_config: { private: 'model_config_must_not_persist' },
  }))
  rows.push({
    id: 'session_cache_branch',
    title: 'Visible fork',
    source: 'cli',
    profile_name: 'default',
    session_source: 'fork',
    parent_session_id: continuationIds.at(-1),
    started_at: 170,
    last_active: 175,
    message_count: 3,
  })
  return rows
}

async function connectGateway(options: {
  baseUrl: string
  gatewayId: string
  hermesAgentId: string
  gatewayToken: string
  responses: PlannedGatewayResponse[]
  rpcPaths: string[]
  defaultPayload: JsonRecord
}): Promise<{ socket: WebSocket; helloAck: JsonRecord }> {
  const streamUrl = new URL(
    `/router/hermes-hub-gateways/${encodeURIComponent(options.gatewayId)}/stream`,
    options.baseUrl,
  )
  streamUrl.protocol = 'ws:'
  const socket = new WebSocket(streamUrl, {
    headers: { authorization: `Bearer ${options.gatewayToken}` },
  })
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as JsonRecord
    if (frame.type === 'heartbeat' && typeof frame.id === 'string') {
      socket.send(JSON.stringify({
        type: 'heartbeat_ack',
        id: frame.id,
        gatewayId: options.gatewayId,
        hermesAgentId: options.hermesAgentId,
      }))
      return
    }
    if (frame.type !== 'rpc_request' || typeof frame.id !== 'string') return
    const path = typeof frame.path === 'string' ? frame.path : ''
    options.rpcPaths.push(path)
    const planned = options.responses.shift() || { status: 200, body: options.defaultPayload }
    socket.send(JSON.stringify({
      type: 'rpc_response',
      id: frame.id,
      gatewayId: options.gatewayId,
      hermesAgentId: options.hermesAgentId,
      status: planned.status,
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(JSON.stringify(planned.body), 'utf8').toString('base64'),
    }))
  })
  const ready = waitForFrame(socket, 'ready')
  await once(socket, 'open')
  await ready
  const helloAck = waitForFrame(socket, 'hello_ack')
  socket.send(JSON.stringify({
    type: 'hello',
    gatewayId: options.gatewayId,
    hermesAgentId: options.hermesAgentId,
    runtime: 'hermes-hub-gateway',
    mode: 'native-session',
    protocols: ['hermes-hub-gateway-rpc/v2'],
    capabilities: ['health', 'sessions', 'session.message', 'session.prompt-response'],
  }))
  return { socket, helloAck: await helloAck }
}

function sessionsFrom(body: JsonRecord): JsonRecord[] {
  assert.ok(Array.isArray(body.sessions), 'Session Directory response must contain sessions')
  return body.sessions.filter((value): value is JsonRecord => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  ))
}

function cacheState(body: JsonRecord): string | undefined {
  const cache = body.cache
  return cache && typeof cache === 'object' && !Array.isArray(cache)
    ? typeof (cache as JsonRecord).state === 'string' ? (cache as JsonRecord).state as string : undefined
    : undefined
}

const routerPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const repositoryRoot = routerPackageRoot
const port = await reserveLoopbackPort()
const workdir = await mkdtemp(join(tmpdir(), 'hermes-hub-session-directory-bridge-'))
const baseUrl = `http://127.0.0.1:${port}`
const pairingStorePath = join(workdir, 'pairing-store.json')
const directoryCachePath = join(workdir, 'session-directory-cache.json')
const hermesAgentId = 'agent_session_directory_flow'
const gatewayId = 'gw_session_directory_flow'
const gatewayToken = 'session-directory-gateway-token-0000000000000000001'
const pairingCode = '24681357'
const requestId = 'pair_session_directory_flow'
const gatewayResponses: PlannedGatewayResponse[] = []
const rpcPaths: string[] = []
const upstreamPayload: JsonRecord = {
  object: 'list',
  limit: 30,
  offset: 0,
  has_more: false,
  sessions: sessionRows(),
}
const router = startRouter(repositoryRoot, routerPackageRoot, {
  ...process.env,
  NODE_ENV: 'development',
  HERMES_HUB_ROUTER_HOST: '127.0.0.1',
  HERMES_HUB_ROUTER_PORT: String(port),
  HERMES_HUB_ROUTER_URL: baseUrl,
  HERMES_HUB_BRIDGE_SECRET: 'session-directory-bridge-secret-value',
  HERMES_HUB_PAIRING_CODE: pairingCode,
  HERMES_HUB_AGENT_APPROVAL_TOKEN: `session-directory-approval-${'a'.repeat(48)}`,
  HERMES_HUB_PAIRING_STORE_PATH: pairingStorePath,
  HERMES_HUB_SESSION_METADATA_STORE_PATH: join(workdir, 'session-metadata.json'),
  HERMES_HUB_NATIVE_CONVERSATION_STORE_PATH: join(workdir, 'native-conversations.json'),
  HERMES_HUB_SESSION_DIRECTORY_CACHE_STORE_PATH: directoryCachePath,
  HERMES_HUB_DIAGNOSTICS_DIR: join(workdir, 'diagnostics'),
  HERMES_HUB_SESSION_DIRECTORY_CACHE_TTL_MS: '300000',
  HERMES_HUB_DEBUG_GATEWAY: '1',
  HERMES_HUB_DEBUG_GATEWAY_BUILD: 'debug-testing',
  HERMES_HUB_DEBUG_GATEWAY_PAIRING_CODE: pairingCode,
  HERMES_HUB_DEBUG_PAIRING_REQUEST_ID: requestId,
  HERMES_HUB_DEBUG_AGENT_ID: hermesAgentId,
  HERMES_HUB_DEBUG_GATEWAY_ID: gatewayId,
  HERMES_HUB_DEBUG_GATEWAY_TOKEN: gatewayToken,
  HERMES_HUB_LOG_LEVEL: 'warn',
})
let gatewaySocket: WebSocket | undefined

try {
  await waitForRouter(baseUrl, router)
  const gateway = await connectGateway({
    baseUrl,
    gatewayId,
    hermesAgentId,
    gatewayToken,
    responses: gatewayResponses,
    rpcPaths,
    defaultPayload: upstreamPayload,
  })
  gatewaySocket = gateway.socket
  assert.equal(gateway.helloAck.gatewayCredentialState, 'provisional')

  const claim = await fetchJson(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, code: pairingCode }),
  })
  assert.equal(claim.status, 200)
  assert.equal(claim.body.status, 'paired')
  assert.equal(claim.body.hermesAgentId, hermesAgentId)
  assert.equal(typeof claim.body.token, 'string')
  const authorization = { authorization: `Bearer ${String(claim.body.token)}` }

  const first = await fetchJson(`${baseUrl}/bridge/sessions?limit=30`, { headers: authorization })
  assert.equal(first.status, 200)
  assert.equal(cacheState(first.body), 'refreshed')
  assert.equal(rpcPaths.length, 1)
  const firstSessions = sessionsFrom(first.body)
  assert.equal(firstSessions.length, 2, 'six compression rows must collapse while a fork remains visible')
  const root = firstSessions.find(row => (row.topology as JsonRecord | undefined)?.relation === 'root')
  const branch = firstSessions.find(row => (row.topology as JsonRecord | undefined)?.relation === 'fork')
  assert.ok(root)
  assert.ok(branch)
  assert.notEqual(root.id, 'session_cache_root')
  assert.equal((root.topology as JsonRecord).childCount, 1)
  assert.equal((branch.topology as JsonRecord).parentConversationId, root.id)
  assert.deepEqual(first.body.sessions, first.body.data)
  assert.equal(JSON.stringify(first.body).includes('preview_must_not_persist'), true)

  const second = await fetchJson(`${baseUrl}/bridge/sessions?limit=30`, { headers: authorization })
  assert.equal(second.status, 200)
  assert.equal(cacheState(second.body), 'fresh')
  assert.equal(rpcPaths.length, 1, 'a fresh identical list request must not reach the Gateway')
  assert.deepEqual(
    sessionsFrom(second.body).map(row => row.id),
    firstSessions.map(row => row.id),
  )
  const cachedWire = JSON.stringify(second.body)
  for (const forbidden of [
    'preview_must_not_persist',
    'user_id_must_not_persist',
    'system_prompt_must_not_persist',
    'model_config_must_not_persist',
  ]) assert.equal(cachedWire.includes(forbidden), false)

  gatewayResponses.push({
    status: 503,
    body: { error: 'temporary upstream failure', code: 'upstream_unavailable' },
  })
  const transient = await fetchJson(`${baseUrl}/bridge/sessions?refresh=1&limit=30`, { headers: authorization })
  assert.equal(transient.status, 200)
  assert.equal(cacheState(transient.body), 'stale-fallback')
  assert.equal(rpcPaths.length, 2)

  gatewayResponses.push({
    status: 404,
    body: { error: 'directory not found', code: 'not_found' },
  })
  const notFound = await fetchJson(`${baseUrl}/bridge/sessions?limit=30&refresh=true`, { headers: authorization })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.body.code, 'not_found')
  assert.equal(rpcPaths.length, 3)

  const refreshed = await fetchJson(`${baseUrl}/bridge/sessions?limit=30&refresh=1`, { headers: authorization })
  assert.equal(refreshed.status, 200)
  assert.equal(cacheState(refreshed.body), 'refreshed')
  assert.equal(rpcPaths.length, 4)
  assert.ok(rpcPaths.every(path => path === '/api/sessions?limit=30'))

  gatewaySocket.send(JSON.stringify({
    type: 'global_event',
    eventId: 'evt_session_directory_changed_0001',
    gatewayId,
    hermesAgentId,
    event: 'sessions.changed',
    data: { profile: 'default' },
    sentAt: Date.now(),
  }))
  await waitUntil('Session Directory invalidation', async () => {
    try {
      const cache = JSON.parse(await readFile(directoryCachePath, 'utf8')) as { entries?: unknown[] }
      return Array.isArray(cache.entries) && cache.entries.length === 0
    } catch {
      return false
    }
  })
  const afterInvalidation = await fetchJson(`${baseUrl}/bridge/sessions?limit=30`, { headers: authorization })
  assert.equal(afterInvalidation.status, 200)
  assert.equal(cacheState(afterInvalidation.body), 'refreshed')
  assert.equal(rpcPaths.length, 5, 'sessions.changed must force the next list request upstream')

  const closed = once(gatewaySocket, 'close')
  gatewaySocket.close()
  await closed
  gatewaySocket = undefined
  const offline = await fetchJson(`${baseUrl}/bridge/sessions?limit=30&refresh=1`, { headers: authorization })
  assert.equal(offline.status, 200)
  assert.equal(cacheState(offline.body), 'stale-fallback')
  assert.equal(rpcPaths.length, 5)

  const persisted = await readFile(directoryCachePath, 'utf8')
  for (const forbidden of [
    'preview_must_not_persist',
    'user_id_must_not_persist',
    'system_prompt_must_not_persist',
    'model_config_must_not_persist',
  ]) assert.equal(persisted.includes(forbidden), false)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'Client HTTP reaches Router and authenticated Gateway WSS',
      'six compression rows collapse into one stable conversation',
      'a visible fork retains an independent stable id and parent conversation id',
      'a second identical request avoids a Gateway RPC',
      'refresh is Router-local and never forwarded upstream',
      'transient 5xx and offline refreshes return an explicit stale fallback',
      'non-transient 404 remains authoritative',
      'sessions.changed invalidates the Agent directory cache',
      'persisted and cache-hit payloads exclude message and raw private fields',
    ],
  }, null, 2))
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nRouter output:\n${router.output()}`)
} finally {
  if (gatewaySocket?.readyState === WebSocket.OPEN) gatewaySocket.close()
  await stopRouter(router)
  await rm(workdir, { recursive: true, force: true })
}
