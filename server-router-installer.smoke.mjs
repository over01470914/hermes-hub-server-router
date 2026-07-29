#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const routerRoot = dirname(fileURLToPath(import.meta.url))
const outerRoot = resolve(routerRoot, '..', '..')
const gatewayPackageRoot = join(outerRoot, 'apps', 'hermes-hub-gateway-npm')
const installerPath = join(routerRoot, 'server-router-installer.mjs')
const release = JSON.parse(await readFile(
  join(gatewayPackageRoot, 'src', 'pairing-core', 'references', 'release.json'),
  'utf8',
))

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))

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
  const root = base === 'router'
    ? roots.routerRoot || routerRoot
    : roots.gatewayRuntimeRoot || join(gatewayPackageRoot, 'runtime')
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
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) return resolvePromise(output)
      reject(new Error(`${command} ${args.join(' ')} failed (${signal || code})\n${output}`))
    })
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
      const response = await fetch(`${baseUrl}/router/health`)
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
  const exited = once(router.child, 'exit')
  router.child.kill('SIGTERM')
  await Promise.race([exited, delay(2_000)])
  if (router.child.exitCode === null && router.child.signalCode === null) router.child.kill('SIGKILL')
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
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
const deployedGatewayDirectory = join(workdir, 'apps', 'hermes-hub-gateway-plugin')
const deployedMetadataPath = join(deployedGatewayDirectory, 'gateway-release-metadata.json')

let router
try {
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
        '--no-start',
        '--no-autostart',
      ]),
      /Gateway release metadata does not match the downloaded package manifest/,
    )
  } finally {
    await new Promise((resolvePromise, reject) => mismatchedSource.server.close(error => error ? reject(error) : resolvePromise()))
  }

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
  ])

  await access(deployedMetadataPath)
  assert.ok(source.requests.has('/gateway/gateway-release-metadata.json'))
  assert.ok(!source.requests.has('/router/gateway-release-metadata.json'))
  const installedEnvironment = environmentFrom(envFile)
  assert.equal(installedEnvironment.HERMES_HUB_GATEWAY_RELEASE_METADATA_PATH, deployedMetadataPath)

  router = await startRouter(workdir, installedEnvironment)
  const validHealth = await waitForHealth(baseUrl, router)
  assert.deepEqual(validHealth.gatewayPlugin.release, release)
  await stopRouter(router)
  router = undefined

  await unlink(deployedMetadataPath)
  router = await startRouter(workdir, installedEnvironment)
  const missingHealth = await waitForHealth(baseUrl, router)
  assert.equal(missingHealth.gatewayPlugin.release, undefined)
  await assertPairingApprovalStillWorks(baseUrl, installedEnvironment, 'missing')
  await stopRouter(router)
  router = undefined

  await writeFile(deployedMetadataPath, '{invalid-json')
  router = await startRouter(workdir, installedEnvironment)
  const corruptHealth = await waitForHealth(baseUrl, router)
  assert.equal(corruptHealth.gatewayPlugin.release, undefined)
  await assertPairingApprovalStillWorks(baseUrl, installedEnvironment, 'corrupt')
} finally {
  if (router) await stopRouter(router)
  await new Promise((resolvePromise, reject) => source.server.close(error => error ? reject(error) : resolvePromise()))
  await rm(tempRoot, { recursive: true, force: true })
}

console.log('Server Router installer release metadata smoke passed.')
