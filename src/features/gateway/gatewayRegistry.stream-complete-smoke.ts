import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { GatewayRegistry } from './gatewayRegistry.js'

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('server did not bind to tcp'))
      else resolve(address.port)
    })
  })
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function waitForFrame(socket: WebSocket, type: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`gateway ${type} frame timed out`))
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

async function main(): Promise<void> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const registry = new GatewayRegistry()
  const clients: WebSocket[] = []
  const pendingConnections: Array<{
    gatewayId: string
    hermesAgentId: string
    resolve: (value: { state: ReturnType<GatewayRegistry['attach']>; serverSocket: WebSocket }) => void
    reject: (error: Error) => void
  }> = []

  wss.on('connection', socket => {
    const pending = pendingConnections.shift()
    if (!pending) {
      socket.close(4400, 'unexpected smoke connection')
      return
    }
    try {
      const state = registry.attach(socket, {
        gatewayId: pending.gatewayId,
        hermesAgentId: pending.hermesAgentId,
        gatewayCredentialState: 'active',
        requestId: `pair_${pending.gatewayId}`,
        user: 'smoke',
        deviceName: 'smoke-device',
      })
      pending.resolve({ state, serverSocket: socket })
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  const connectGateway = async (port: number, gatewayId: string, hermesAgentId: string) => {
    const attached = new Promise<{ state: ReturnType<GatewayRegistry['attach']>; serverSocket: WebSocket }>((resolve, reject) => {
      pendingConnections.push({ gatewayId, hermesAgentId, resolve, reject })
    })
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    clients.push(client)
    await waitForOpen(client)
    const connection = await attached
    assert.equal(connection.state.online, false, 'socket must not be routable before authenticated hello')
    const helloAck = waitForFrame(client, 'hello_ack')
    client.send(JSON.stringify({
      type: 'hello',
      gatewayId,
      hermesAgentId,
      runtime: 'hermes-hub-gateway-smoke',
      mode: 'api-server',
      protocols: ['hermes-hub-gateway-rpc/v1'],
      capabilities: ['chat.stream'],
    }))
    await helloAck
    assert.equal(registry.getByAgentId(hermesAgentId)?.online, true)
    return { client, ...connection }
  }

  try {
    const port = await listen(server)
    const complete = await connectGateway(port, 'gw_complete_smoke', 'agent_complete_smoke')
    let sawChunk = false
    complete.client.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as { type?: string; id?: string }
      if (frame.type !== 'rpc_stream_request' || !frame.id) return
      complete.client.send(JSON.stringify({
        type: 'rpc_stream_chunk',
        id: frame.id,
        event: 'message.delta',
        data: { event: 'message.delta', delta: 'ok' },
        text: 'ok',
      }))
      sawChunk = true
      complete.client.send(JSON.stringify({
        type: 'rpc_stream_end',
        id: frame.id,
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        bodyBase64: Buffer.from(JSON.stringify({ output: 'ok' })).toString('base64'),
        metrics: { requestId: frame.id, streamedEventCount: 1 },
      }))
      complete.client.close(1000, 'stream complete')
    })

    const result = await registry.streamRequestByAgentId('agent_complete_smoke', {
      method: 'POST',
      path: '/api/chat-run/runs',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from('{}').toString('base64'),
    }, {
      onFrame: () => undefined,
    }, 3000)
    assert.equal(sawChunk, true, 'precondition: gateway sent a stream chunk before end')
    assert.equal(result.response.status, 200)
    assert.equal(Buffer.from(result.response.bodyBase64, 'base64').toString('utf8'), '{"output":"ok"}')

    const errored = await connectGateway(port, 'gw_error_smoke', 'agent_error_smoke')
    const pendingRpc = registry.requestByAgentId('agent_error_smoke', {
      method: 'GET',
      path: '/api/sessions',
    }, 3000)
    const pendingStream = registry.streamRequestByAgentId('agent_error_smoke', {
      method: 'POST',
      path: '/api/chat-run/runs',
    }, { onFrame: () => undefined }, 3000)
    const pendingHeartbeat = registry.heartbeatByAgentId('agent_error_smoke', 3000)
    assert.equal(registry.get('gw_error_smoke')?.inFlightRpc, 2)

    const errorHandled = errored.serverSocket.emit('error', new Error('synthetic gateway socket failure'))
    assert.equal(errorHandled, true, 'Gateway socket must install an error listener')
    const rejected = await Promise.allSettled([pendingRpc, pendingStream, pendingHeartbeat])
    assert.deepEqual(rejected.map(item => item.status), ['rejected', 'rejected', 'rejected'])
    assert.equal(registry.get('gw_error_smoke')?.online, false)
    assert.equal(registry.get('gw_error_smoke')?.inFlightRpc, 0)

    const mismatched = await connectGateway(port, 'gw_heartbeat_smoke', 'agent_heartbeat_smoke')
    mismatched.client.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as { type?: string; id?: string }
      if (frame.type !== 'heartbeat' || !frame.id) return
      mismatched.client.send(JSON.stringify({
        type: 'heartbeat_ack',
        id: frame.id,
        gatewayId: 'gw_wrong',
        hermesAgentId: 'agent_wrong',
      }))
    })
    const heartbeat = await registry.heartbeatByAgentId('agent_heartbeat_smoke', 3000)
    assert.equal(heartbeat.ok, false)
    assert.equal(heartbeat.online, false)
    assert.equal(heartbeat.error, 'Gateway heartbeat identity mismatch')
    assert.equal(registry.get('gw_heartbeat_smoke')?.online, false)

    const cancelled = await connectGateway(port, 'gw_cancel_smoke', 'agent_cancel_smoke')
    const streamRequestFrame = waitForFrame(cancelled.client, 'rpc_stream_request')
    const streamCancelFrame = waitForFrame(cancelled.client, 'rpc_stream_cancel')
    const downstreamController = new AbortController()
    const cancelledStream = registry.streamRequestByAgentId('agent_cancel_smoke', {
      method: 'POST',
      path: '/api/chat-run/runs',
    }, {
      onFrame: () => undefined,
      signal: downstreamController.signal,
    }, 3000)
    await streamRequestFrame
    downstreamController.abort(Object.assign(
      new Error('Downstream SSE queue exceeded its per-stream limit'),
      { code: 'downstream_queue_overflow' },
    ))
    await assert.rejects(cancelledStream, /queue exceeded/i)
    const cancelFrame = await streamCancelFrame
    assert.equal(cancelFrame.reason, 'downstream_queue_overflow')
    assert.equal(registry.get('gw_cancel_smoke')?.inFlightRpc, 0)
  } finally {
    for (const client of clients) client.close()
    wss.close()
    server.close()
  }
}

main().then(
  () => {
    console.log('Gateway registry lifecycle OK: stream completion, socket errors, pending cleanup, heartbeat identity, and backpressure cancel')
  },
  error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  },
)
