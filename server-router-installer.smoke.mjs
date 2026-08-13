#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const routerRoot = dirname(fileURLToPath(import.meta.url))
const observatoryDistRoot = join(routerRoot, 'observatory')
const installerPath = join(routerRoot, 'server-router-installer.mjs')
const gatewayPayloads = new Map([
  ['__init__.py', Buffer.from('# standalone installer smoke\n')],
  ['adapter.py', Buffer.from('# standalone installer smoke adapter\n')],
  ['operational_metrics.py', Buffer.from('# standalone installer smoke metrics\n')],
  ['outbound_writer.py', Buffer.from('# standalone installer smoke writer\n')],
  ['protocol.py', Buffer.from('# standalone installer smoke protocol\n')],
  ['plugin.yaml', Buffer.from('name: hermes-hub-gateway-smoke\n')],
  ['install.mjs', Buffer.from('export const smoke = true\n')],
])
const gatewayManifest = Buffer.from(JSON.stringify({
  schema: 'hermes-hub-gateway-package/v1',
  version: '0.0.0-smoke',
  files: [...gatewayPayloads].map(([name, body]) => ({
    name,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  })),
}) + '\n')
const release = {
  packageName: '@hermes-hub/gateway-smoke',
  packageVersion: '0.0.0-smoke',
  runtimeManifestSha256: createHash('sha256').update(gatewayManifest).digest('hex'),
}
const gatewayReleaseMetadata = Buffer.from(JSON.stringify({
  schema: 'hermes-hub-gateway-release-metadata/v1',
  ...release,
}) + '\n')

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
const stage = name => console.error(`[router-installer-smoke] ${name}`)

async function reserveLoopbackPort() {
  const probe = createNetServer()
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = probe.address()
  assert.ok(address && typeof address === 'object')
  await new Promise((resolvePromise, reject) => probe.close(error => error ? reject(error) : resolvePromise()))
  return address.port
}

async function readSourceFile(base, pathname, roots = {}) {
  const prefix = `/${base}/`
  if (!pathname.startsWith(prefix)) return null
  const relative = decodeURIComponent(pathname.slice(prefix.length))
  if (!relative || relative.split('/').some(part => part === '.' || part === '..')) return null
  if (base === 'router' && relative === 'gateway-release-metadata.json') return null
  if (base === 'router' && relative.startsWith('observatory/')) {
    const asset = relative.slice('observatory/'.length)
    if (!asset || asset.split('/').some(part => part === '.' || part === '..')) return null
    try { return await readFile(join(observatoryDistRoot, asset)) } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const root = base === 'router'
    ? roots.routerRoot || routerRoot
    : roots.gatewayRuntimeRoot
  if (base === 'gateway' && !root) {
    if (relative === 'package-manifest.json') return gatewayManifest
    if (relative === 'gateway-release-metadata.json') return gatewayReleaseMetadata
    return gatewayPayloads.get(relative) || null
  }
  try {
    const body = await readFile(join(root, relative))
    if (base === 'gateway') {
      assert.ok(!body.includes(0x0d), `Gateway runtime fixture ${relative} contains CRLF bytes`)
    }
    return body
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function sourceServer(metadataOverride = '') {
  const requests = new Set()
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
    requests.add(pathname)
    const body = pathname === '/gateway/gateway-release-metadata.json' && metadataOverride
      ? Buffer.from(metadataOverride, 'utf8')
      : await readSourceFile('router', pathname) || await readSourceFile('gateway', pathname)
    if (!body) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body)
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (options.stream) process.stderr.write(chunk)
  })
  child.stderr.on('data', chunk => {
    output += String(chunk)
    if (options.stream) process.stderr.write(chunk)
  })
  return new Promise((resolvePromise, reject) => {
    let settled = false
    let timeout
    let forcedExitTimeout
    let timedOut = false
    const finish = callback => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forcedExitTimeout)
      callback()
    }
    child.once('error', error => finish(() => reject(error)))
    child.once('exit', (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`${command} ${args.join(' ')} timed out\n${output}`))
          return
        }
        if (code === 0 && !signal) {
          resolvePromise(output)
          return
        }
        reject(new Error(`${command} ${args.join(' ')} failed (${signal || code})\n${output}`))
      })
    })
    timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      forcedExitTimeout = setTimeout(() => {
        finish(() => reject(new Error(
          `${command} ${args.join(' ')} did not exit after timeout\n${output}`,
        )))
      }, 5_000)
    }, options.timeoutMs || 60_000)
  })
}

function environmentFrom(path) {
  const environment = { ...process.env }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index > 0) environment[line.slice(0, index)] = line.slice(index + 1)
  }
  return environment
}

async function startRouter(workdir, environment) {
  const tsxCli = join(workdir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  await access(tsxCli)
  const child = spawn(process.execPath, [tsxCli, join(workdir, 'src', 'bridgeServer.ts')], {
    cwd: workdir,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  return { child, output: () => output }
}

async function waitForHealth(baseUrl, router) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (router.child.exitCode !== null) throw new Error(`Installed Router exited early\n${router.output()}`)
    try {
      const response = await fetch(`${baseUrl}/router/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return response.json()
    } catch {
      // Router is still starting.
    }
    await delay(50)
  }
  throw new Error(`Installed Router health did not become ready\n${router.output()}`)
}

async function stopRouter(router) {
  if (router.child.exitCode !== null || router.child.signalCode !== null) return
  const exited = Promise.race([
    once(router.child, 'exit').then(() => true),
    delay(2_000).then(() => false),
  ])
  router.child.kill('SIGTERM')
  if (await exited) return

  const forcedExit = Promise.race([
    once(router.child, 'exit').then(() => true),
    delay(5_000).then(() => false),
  ])
  router.child.kill('SIGKILL')
  if (!await forcedExit) {
    throw new Error(`Installed Router did not exit after forced termination\n${router.output()}`)
  }
}

async function closeServer(server) {
  const closed = Promise.race([
    once(server, 'close'),
    delay(5_000).then(() => {
      throw new Error('Source server did not close after terminating connections')
    }),
  ])
  server.close()
  server.closeIdleConnections?.()
  server.closeAllConnections?.()
  await closed
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
  const payload = await response.json()
  assert.equal(
    response.status,
    200,
    `POST ${new URL(url).pathname} failed: ${JSON.stringify(payload)}`,
  )
  return payload
}

async function assertPairingApprovalStillWorks(baseUrl, environment, suffix) {
  const requested = await postJson(`${baseUrl}/router/pairing/request`, {
    deviceId: `installer_metadata_${suffix}`,
    ttlSeconds: 300,
  })
  const approved = await postJson(
    `${baseUrl}/router/pairing/approve`,
    {
      requestId: requested.requestId,
      hermesAgentId: `agent_metadata_${suffix}`,
      gatewayId: `gw_metadata_${suffix}`,
      gatewayToken: `gateway-metadata-${suffix}-token-0000000000000000000001`,
    },
    { 'x-hermes-hub-agent-approval': environment.HERMES_HUB_AGENT_APPROVAL_TOKEN },
  )
  assert.match(approved.randomCode, /^\d{8}$/)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'hermes-hub-router-installer-'))
const workdir = join(tempRoot, 'runtime')
const envFile = join(workdir, '.env')
const routerPort = await reserveLoopbackPort()
const crlfGatewayRuntimeRoot = join(tempRoot, 'crlf-gateway-runtime')
await mkdir(crlfGatewayRuntimeRoot, { recursive: true })
await writeFile(join(crlfGatewayRuntimeRoot, 'adapter.py'), 'fixture\r\n')
await assert.rejects(
  () => readSourceFile('gateway', '/gateway/adapter.py', { gatewayRuntimeRoot: crlfGatewayRuntimeRoot }),
  /Gateway runtime fixture adapter\.py contains CRLF bytes/,
)
const source = await sourceServer()
const baseUrl = `http://127.0.0.1:${routerPort}`
const deployedGatewayDirectory = join(workdir, 'apps', 'hermes-hub-gateway-runtime')
const deployedMetadataPath = join(deployedGatewayDirectory, 'gateway-release-metadata.json')

let router
try {
  stage('mismatched metadata rejection')
  const mismatchedSource = await sourceServer(JSON.stringify({
    schema: 'hermes-hub-gateway-release-metadata/v1',
    ...release,
    runtimeManifestSha256: '0'.repeat(64),
  }))
  try {
    await assert.rejects(
      run(process.execPath, [
        installerPath,
        '--platform', process.platform,
        '--base-url', `${mismatchedSource.baseUrl}/router/`,
        '--gateway-package-base-url', `${mismatchedSource.baseUrl}/gateway/`,
        '--workdir', join(tempRoot, 'mismatched-runtime'),
        '--router-env', join(tempRoot, 'mismatched-runtime.env'),
        '--offline',
        '--no-start',
        '--no-autostart',
      ]),
      /Gateway release metadata does not match the downloaded package manifest/,
    )
  } finally {
    await closeServer(mismatchedSource.server)
  }

  stage('installer')
  await run(process.execPath, [
    installerPath,
    '--platform', process.platform,
    '--base-url', `${source.baseUrl}/router/`,
    '--gateway-package-base-url', `${source.baseUrl}/gateway/`,
    '--workdir', workdir,
    '--router-env', envFile,
    '--host', '127.0.0.1',
    '--port', String(routerPort),
    '--router-url', baseUrl,
    '--no-start',
    '--no-autostart',
  ], {
    stream: true,
    timeoutMs: 60_000,
  })

  stage('valid metadata health')
  await access(deployedMetadataPath)
  const installedPackage = JSON.parse(await readFile(join(workdir, 'package.json'), 'utf8'))
  assert.equal(installedPackage.scripts?.['router:dev'], 'tsx src/bridgeServer.ts')
  assert.equal(installedPackage.scripts?.['server-router:dev'], undefined)
  assert.equal(installedPackage.pnpm, undefined)
  assert.equal(
    await readFile(join(workdir, 'pnpm-workspace.yaml'), 'utf8'),
    "packages:\n  - '.'\nallowBuilds:\n  esbuild: true\n",
  )
  assert.ok(source.requests.has('/gateway/gateway-release-metadata.json'))
  assert.ok(!source.requests.has('/router/gateway-release-metadata.json'))
  const installedEnvironment = environmentFrom(envFile)
  assert.equal(installedEnvironment.HERMES_HUB_GATEWAY_RELEASE_METADATA_PATH, deployedMetadataPath)
  assert.equal(
    installedEnvironment.HERMES_HUB_SESSION_DIRECTORY_CACHE_STORE_PATH,
    join(workdir, 'state', 'session-directory-cache.json'),
  )
  await access(join(workdir, 'src', 'features', 'sessions', 'sessionDirectoryCacheStore.ts'))
  await access(join(workdir, 'observatory', 'index.html'))
  assert.ok(source.requests.has('/router/observatory/index.html'))

  router = await startRouter(workdir, installedEnvironment)
  const validHealth = await waitForHealth(baseUrl, router)
  assert.deepEqual(validHealth.gatewayPlugin.release, release)
  const productionObservatory = await fetch(`${baseUrl}/_debug/observatory/`)
  assert.equal(productionObservatory.status, 404, 'production Router must fail closed for Observatory')
  await stopRouter(router)
  router = undefined

  stage('missing metadata health')
  await unlink(deployedMetadataPath)
  router = await startRouter(workdir, installedEnvironment)
  const missingHealth = await waitForHealth(baseUrl, router)
  assert.equal(missingHealth.gatewayPlugin.release, undefined)
  await assertPairingApprovalStillWorks(baseUrl, installedEnvironment, 'missing')
  await stopRouter(router)
  router = undefined

  stage('corrupt metadata health')
  await writeFile(deployedMetadataPath, '{invalid-json')
  router = await startRouter(workdir, installedEnvironment)
  const corruptHealth = await waitForHealth(baseUrl, router)
  assert.equal(corruptHealth.gatewayPlugin.release, undefined)
  await assertPairingApprovalStillWorks(baseUrl, installedEnvironment, 'corrupt')
} finally {
  stage('cleanup')
  if (router) await stopRouter(router)
  await closeServer(source.server)
  await rm(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}

stage('complete')
console.log('Server Router installer release metadata smoke passed.')
