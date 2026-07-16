import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { WebSocket } from 'ws'
import { issueBridgeToken, readBridgeConfig } from '../../core/security/bridgeAuth.js'

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Failed to reserve diagnostics smoke port')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function waitForRouter(baseUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Router exited before health check (${child.exitCode})`)
    try {
      const response = await fetch(`${baseUrl}/router/health`)
      if (response.ok) return
    } catch {
      // The Router process is still starting.
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for diagnostics smoke Router')
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return
  const exited = once(child, 'exit')
  child.kill()
  await Promise.race([exited, delay(2000)])
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
}

async function sendMalformedGatewayUpgrade(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let connected = false
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error('Malformed Gateway upgrade did not close')), 1500)
    socket.once('connect', () => {
      connected = true
      socket.write([
        'GET /router/hermes-hub-gateways/%ZZ/stream HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: Z2F0ZXdheS1zbW9rZQ==',
        'Authorization: Bearer invalid-smoke-token',
        '',
        '',
      ].join('\r\n'))
    })
    socket.once('close', () => finish())
    socket.once('error', error => {
      if (connected) finish()
      else finish(error)
    })
  })
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function waitForWebSocketFrame(socket: WebSocket, type: string, timeoutMs = 1500): Promise<Record<string, unknown>> {
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

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
    .filter(frame => typeof frame.type === 'string')
}

const routerPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const repositoryRoot = join(routerPackageRoot, '../..')
const port = await reserveLoopbackPort()
const workdir = await mkdtemp(join(tmpdir(), 'hermes-hub-router-diagnostics-'))
const diagnosticsDir = join(workdir, 'diagnostics')
const baseUrl = `http://127.0.0.1:${port}`
const bridgeSecret = 'diagnostics-smoke-bridge-secret-value'
const pairingCode = '24681357'
const diagnosticsApproval = 'diagnostics-smoke-read-approval-value'
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  HERMES_HUB_ROUTER_HOST: '127.0.0.1',
  HERMES_HUB_ROUTER_PORT: String(port),
  HERMES_HUB_ROUTER_URL: baseUrl,
  HERMES_HUB_BRIDGE_SECRET: bridgeSecret,
  HERMES_HUB_PAIRING_CODE: pairingCode,
  HERMES_HUB_AGENT_APPROVAL_TOKEN: diagnosticsApproval,
  HERMES_HUB_DIAGNOSTICS_DIR: diagnosticsDir,
  HERMES_HUB_PAIRING_STORE_PATH: join(workdir, 'pairing-store.json'),
  HERMES_HUB_SESSION_METADATA_STORE_PATH: join(workdir, 'session-metadata.json'),
  HERMES_HUB_LOG_LEVEL: 'info'
}
const tsxCli = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const routerEntry = join(routerPackageRoot, 'src', 'bridgeServer.ts')
const child = spawn(process.execPath, [tsxCli, routerEntry], {
  cwd: repositoryRoot,
  env,
  stdio: ['pipe', 'pipe', 'pipe']
})
let stdout = ''
let stderr = ''
let gatewaySocket: WebSocket | undefined
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += String(chunk) })
child.stderr.on('data', chunk => { stderr += String(chunk) })

try {
  await waitForRouter(baseUrl, child)
  const requestBody = JSON.stringify({
    logText: 'legacy duplicate private message body',
    entries: [{
      level: 'error',
      category: 'connection',
      message: 'Authorization: Bearer report-secret-value',
      timestamp: '2026-07-12T08:30:00.000Z',
      data: {
        statusCode: 502,
        content: 'private user message body',
        token: 'report-secret-value'
      }
    }],
    metadata: {
      appVersion: '0.1.0-smoke',
      platform: 'windows',
      runtimeLogFileName: 'hermes-hub-client-runtime.log',
      runtimeLogSource: 'local-runtime-file',
      unexpected: 'not persisted'
    }
  })

  const unauthenticated = await fetch(`${baseUrl}/router/diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: requestBody
  })
  assert.equal(unauthenticated.status, 401)

  const config = readBridgeConfig(env)
  const bridgeToken = issueBridgeToken({
    pairingCode,
    user: 'diagnostics-smoke-user',
    deviceId: 'device-diagnostics-smoke',
    hermesAgentId: 'agent-diagnostics-smoke'
  }, config)

  const anonymousHeartbeat = await fetch(`${baseUrl}/router/heartbeat?hermesAgentId=agent-other`)
  assert.equal(anonymousHeartbeat.status, 401)
  const clientHeartbeat = await fetch(`${baseUrl}/router/heartbeat?hermesAgentId=agent-other`, {
    headers: { authorization: `Bearer ${bridgeToken}` }
  })
  assert.equal(clientHeartbeat.status, 200)
  const clientHeartbeatBody = await clientHeartbeat.json() as {
    gateway: Record<string, unknown>
  }
  assert.equal(clientHeartbeatBody.gateway.hermesAgentId, 'agent-diagnostics-smoke')
  assert.equal(clientHeartbeatBody.gateway.online, false)
  assert.equal('gatewayId' in clientHeartbeatBody.gateway, false)
  assert.equal('gatewayConnectionId' in clientHeartbeatBody.gateway, false)

  const operatorHeartbeat = await fetch(
    `${baseUrl}/router/heartbeat?hermesAgentId=agent-operator-smoke`,
    { headers: { 'x-hermes-hub-agent-approval': diagnosticsApproval } }
  )
  assert.equal(operatorHeartbeat.status, 200)
  const operatorHeartbeatBody = await operatorHeartbeat.json() as {
    gateway: Record<string, unknown>
  }
  assert.equal(operatorHeartbeatBody.gateway.hermesAgentId, 'agent-operator-smoke')
  assert.equal('gatewayId' in operatorHeartbeatBody.gateway, false)

  const anonymousGatewayList = await fetch(`${baseUrl}/router/hermes-hub-gateways`)
  assert.equal(anonymousGatewayList.status, 401)
  const operatorGatewayList = await fetch(`${baseUrl}/router/hermes-hub-gateways`, {
    headers: { 'x-hermes-hub-agent-approval': diagnosticsApproval }
  })
  assert.equal(operatorGatewayList.status, 200)
  assert.deepEqual(await operatorGatewayList.json(), { gateways: [] })

  await sendMalformedGatewayUpgrade(port)
  assert.equal(child.exitCode, null, 'malformed Gateway upgrade must not terminate Router')
  const healthAfterMalformedUpgrade = await fetch(`${baseUrl}/router/health`)
  assert.equal(healthAfterMalformedUpgrade.status, 200)
  assert.equal((await healthAfterMalformedUpgrade.json() as { ok?: boolean }).ok, true)

  const gatewayId = 'gw_diagnostics_stream_smoke'
  const hermesAgentId = 'agent_diagnostics_stream_smoke'
  const gatewayToken = 'gateway-diagnostics-stream-smoke-token-value'
  const pairingRequestResponse = await fetch(`${baseUrl}/router/pairing/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: 'stream-smoke-user',
      deviceName: 'Stream smoke client',
      deviceId: 'device-stream-smoke',
      routerUrl: baseUrl,
    }),
  })
  assert.equal(pairingRequestResponse.status, 200)
  const pairingRequest = await pairingRequestResponse.json() as { requestId: string }
  const approvalResponse = await fetch(`${baseUrl}/router/pairing/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hermes-hub-agent-approval': diagnosticsApproval,
    },
    body: JSON.stringify({ requestId: pairingRequest.requestId, gatewayId, hermesAgentId, gatewayToken }),
  })
  assert.equal(approvalResponse.status, 200)
  const approval = await approvalResponse.json() as { randomCode: string }

  const activeGatewaySocket = new WebSocket(`ws://127.0.0.1:${port}/router/hermes-hub-gateways/${gatewayId}/stream`, {
    headers: { authorization: `Bearer ${gatewayToken}` },
  })
  gatewaySocket = activeGatewaySocket
  const readyFrame = waitForWebSocketFrame(activeGatewaySocket, 'ready')
  await waitForWebSocketOpen(activeGatewaySocket)
  await readyFrame
  const helloAck = waitForWebSocketFrame(activeGatewaySocket, 'hello_ack')
  activeGatewaySocket.send(JSON.stringify({
    type: 'hello',
    gatewayId,
    hermesAgentId,
    runtime: 'diagnostics-stream-smoke',
    mode: 'native-session',
    protocols: ['hermes-hub-gateway-rpc/v2'],
    capabilities: ['session.message', 'session.prompt-response'],
  }))
  await helloAck

  const claimResponse = await fetch(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: pairingRequest.requestId, code: approval.randomCode }),
  })
  assert.equal(claimResponse.status, 200)
  const claimed = await claimResponse.json() as { token: string }

  const upstreamStreamRequest = waitForWebSocketFrame(activeGatewaySocket, 'rpc_stream_request')
  const chatResponsePromise = fetch(`${baseUrl}/bridge/chat-run/stream`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claimed.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'non-sensitive smoke input', session_id: 'session-stream-smoke' }),
  })
  const upstreamFrame = await upstreamStreamRequest
  activeGatewaySocket.send(JSON.stringify({
    type: 'rpc_stream_error',
    id: upstreamFrame.id,
    error: 'synthetic upstream stream failure',
    code: 'synthetic_upstream_error',
  }))
  const chatResponse = await chatResponsePromise
  assert.equal(chatResponse.status, 200)
  const chatFrames = parseSseFrames(await chatResponse.text())
  const terminalErrors = chatFrames.filter(frame => frame.type === 'rpc_stream_error')
  assert.equal(terminalErrors.length, 1, 'Gateway error must not be followed by a duplicate Router error')
  assert.equal(terminalErrors[0]?.code, 'synthetic_upstream_error')

  const uploadedResponse = await fetch(`${baseUrl}/router/diagnostics`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      'content-type': 'application/json'
    },
    body: requestBody
  })
  assert.equal(uploadedResponse.status, 200)
  const uploaded = await uploadedResponse.json() as {
    reportId: string
    fileName: string
    receivedAt: string
    entries: number
  }
  assert.match(uploaded.reportId, /^diag_\d{8}T\d{9}Z_diagnostics-smoke-user_device-diagnostics-smoke_[a-f0-9]{32}$/i)
  assert.equal(uploaded.fileName, `${uploaded.reportId}.json`)
  assert.ok(Date.parse(uploaded.receivedAt) > 0)
  assert.equal(uploaded.entries, 1)

  const persistedText = await readFile(join(diagnosticsDir, uploaded.fileName), 'utf8')
  const persisted = JSON.parse(persistedText) as Record<string, unknown>
  assert.equal(persisted.entryCount, 1)
  assert.equal(persisted.hermesAgentId, 'agent-diagnostics-smoke')
  assert.equal(persisted.fileName, uploaded.fileName)
  assert.equal(persisted.sortKey, uploaded.receivedAt)
  assert.deepEqual(persisted.submittedBy, {
    user: 'diagnostics-smoke-user',
    deviceId: 'device-diagnostics-smoke'
  })
  assert.deepEqual(persisted.metadata, {
    appVersion: '0.1.0-smoke',
    platform: 'windows',
    runtimeLogFileName: 'hermes-hub-client-runtime.log',
    runtimeLogSource: 'local-runtime-file'
  })
  assert.equal('logText' in persisted, false)
  assert.equal('remoteAddress' in persisted, false)
  assert.doesNotMatch(persistedText, /report-secret-value|private user message body|legacy duplicate/)
  assert.match(persistedText, /\[redacted\]/)

  const readWithoutApproval = await fetch(`${baseUrl}/router/diagnostics/${uploaded.reportId}`)
  assert.equal(readWithoutApproval.status, 401)
  const approvedRead = await fetch(`${baseUrl}/router/diagnostics/${uploaded.reportId}`, {
    headers: { 'x-hermes-hub-agent-approval': diagnosticsApproval }
  })
  assert.equal(approvedRead.status, 200)
  const approvedRecord = await approvedRead.json() as Record<string, unknown>
  assert.equal(approvedRecord.reportId, uploaded.reportId)

  await delay(20)
  const routerOutput = `${stdout}\n${stderr}`
  assert.match(routerOutput, /Diagnostics report received and persisted/)
  assert.match(routerOutput, /"entryCount":1/)
  assert.doesNotMatch(routerOutput, /report-secret-value|private user message body|legacy duplicate/)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'unauthenticated upload rejected',
      'authenticated upload persisted',
      'timestamped unique filename and authenticated user/device sort identity persisted',
      'Flutter entries array counted',
      'free-form logText ignored',
      'server-side redaction persisted',
      'content-free Router summary emitted',
      'diagnostics read approval retained',
      'anonymous heartbeat and Gateway metadata rejected',
      'bridge heartbeat bound to token Agent identity',
      'operator heartbeat allowed without leaking Gateway transport identity',
      'malformed Gateway upgrade cannot terminate Router',
      'Gateway stream error produces exactly one terminal SSE frame'
    ]
  }))
} finally {
  gatewaySocket?.close()
  await stopChild(child)
  await rm(workdir, { recursive: true, force: true })
}
