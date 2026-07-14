#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const approvalTokenKey = 'HERMES_HUB_AGENT_APPROVAL_TOKEN'

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      options._.push(item)
      continue
    }
    const [key, inline] = item.slice(2).split('=', 2)
    if (inline !== undefined) options[key] = inline
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index]
    else options[key] = true
  }
  return options
}

function textOption(options, key, fallback = '') {
  const value = options[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function tokenIsValid(value) {
  return typeof value === 'string' && value.length >= 32 && !/[\s\r\n]/.test(value)
}

let cachedWindowsUserSid = ''

function windowsUserSid(commandRunner = spawnSync) {
  if (cachedWindowsUserSid) return cachedWindowsUserSid
  const result = commandRunner('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const match = result?.status === 0 ? String(result.stdout || '').match(/S-1-[0-9-]+/) : null
  if (!match) throw new Error('Could not determine the current Windows user for the private Router environment.')
  cachedWindowsUserSid = match[0]
  return cachedWindowsUserSid
}

export function hardenPrivateEnvFile(path, options = {}) {
  const platform = options.platform || process.platform
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Router environment must be a regular local file.')
  }
  if (platform === 'win32') {
    const commandRunner = options.commandRunner || spawnSync
    const commands = [
      [path, '/reset'],
      [path, '/inheritance:r'],
      [path, '/grant:r', `*${windowsUserSid(commandRunner)}:F`],
    ]
    for (const commandArgs of commands) {
      const result = commandRunner('icacls.exe', commandArgs, {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (result?.status !== 0) {
        throw new Error('Could not restrict Windows permissions for the private Router environment.')
      }
    }
    return
  }
  chmodSync(path, 0o600)
  if ((lstatSync(path).mode & 0o077) !== 0) {
    throw new Error('Could not restrict permissions for the private Router environment.')
  }
}

export function writePrivateEnvFile(path, content, options = {}) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('Router environment target must be a regular local file.')
    }
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    hardenPrivateEnvFile(temporary, options)
    renameSync(temporary, path)
    hardenPrivateEnvFile(path, options)
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    rmSync(temporary, { force: true })
  }
}

function envLines(text) {
  return text ? text.split(/\r?\n/) : []
}

function approvalTokenEntries(lines) {
  const prefix = `${approvalTokenKey}=`
  return lines
    .map((line, index) => ({ index, line }))
    .filter(entry => entry.line.startsWith(prefix))
}

export function ensureRouterEnvFile(path, options = {}) {
  const rotate = options.rotate === true
  const tokenFactory = options.tokenFactory || (() => randomBytes(32).toString('hex'))
  if (existsSync(path)) hardenPrivateEnvFile(path, options)
  const existingText = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = envLines(existingText)
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  const entries = approvalTokenEntries(lines)
  if (entries.length > 1) {
    throw new Error(`${approvalTokenKey} appears more than once in the Router environment.`)
  }
  if (!rotate && entries.length === 1) {
    const token = entries[0].line.slice(approvalTokenKey.length + 1)
    if (!tokenIsValid(token)) {
      throw new Error(`${approvalTokenKey} must contain at least 32 non-whitespace characters.`)
    }
    return { created: false, rotated: false, path }
  }

  const nextToken = tokenFactory()
  if (!tokenIsValid(nextToken)) throw new Error('Generated Router approval token is invalid.')
  const nextLine = `${approvalTokenKey}=${nextToken}`
  if (entries.length === 1) lines[entries[0].index] = nextLine
  else {
    lines.push(nextLine)
  }
  writePrivateEnvFile(path, `${lines.join('\n')}\n`, options)
  return { created: entries.length === 0, rotated: rotate && entries.length === 1, path }
}

export function clearRouterApprovalToken(path, options = {}) {
  if (!existsSync(path)) return { cleared: false, path }
  hardenPrivateEnvFile(path, options)
  const lines = envLines(readFileSync(path, 'utf8'))
  const entries = approvalTokenEntries(lines)
  if (entries.length === 0) return { cleared: false, path }

  // Remove every matching entry rather than failing on duplicates. This is an
  // explicit local recovery action; the next init/run creates exactly one new
  // token and the normal startup path remains fail-closed for duplicates.
  const retained = lines.filter(line => !line.startsWith(`${approvalTokenKey}=`))
  while (retained.length > 0 && retained.at(-1) === '') retained.pop()
  writePrivateEnvFile(path, `${retained.join('\n')}\n`, options)
  return { cleared: true, path }
}

export function loadRouterEnvFile(path, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment }
  const lines = envLines(readFileSync(path, 'utf8'))
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = rawLine.indexOf('=')
    if (separator <= 0) throw new Error(`Router environment contains an invalid entry at line ${index + 1}.`)
    const key = rawLine.slice(0, separator)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Router environment contains an invalid key.')
    environment[key] = rawLine.slice(separator + 1)
  }
  return environment
}

function defaultEnvFile(cwd) {
  return join(cwd, '.env')
}

function localProbeHost(host) {
  if (host === '0.0.0.0' || host === '') return '127.0.0.1'
  if (host === '::' || host === '[::]') return '::1'
  return host
}

function healthProbeUrl(environment, host, port) {
  const configuredUrl = environment.HERMES_HUB_ROUTER_URL || `http://127.0.0.1:${port}`
  let basePath
  try {
    basePath = new URL(configuredUrl).pathname.replace(/\/+$/, '')
  } catch {
    throw new Error('HERMES_HUB_ROUTER_URL must be a valid HTTP(S) URL.')
  }
  const probeHost = localProbeHost(host)
  const authority = probeHost.includes(':') ? `[${probeHost}]` : probeHost
  return `http://${authority}:${port}${basePath}/router/health`
}

function loopbackRouterUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('The local Gateway launcher requires a valid loopback Router URL.')
  }
  const host = url.hostname.toLowerCase()
  const isLoopback = host === '::1' || host === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host)
  if (!isLoopback || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('The local Gateway launcher only sends Router approval to an HTTP(S) loopback Router URL.')
  }
  return url.toString().replace(/\/$/, '')
}

function verifiedInstallerPath(value) {
  if (!value) throw new Error('pair-gateway requires --installer <verified-installer-path>.')
  const path = resolve(value)
  if (!existsSync(path)) throw new Error('The verified Gateway installer file was not found.')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('The verified Gateway installer must be a regular local file.')
  }
  return path
}

function localRouterPackageSourceBase(value, routerUrl) {
  if (!value) return ''
  const sourceBase = loopbackRouterUrl(value)
  const expected = `${routerUrl}/apps/hermes-hub-gateway-plugin`
  if (sourceBase !== expected) {
    throw new Error('The local Gateway launcher only accepts the exact package mirror advertised by its loopback Router.')
  }
  return `${sourceBase}/`
}

export async function runApprovedGatewayInstaller(options = {}) {
  const envFile = resolve(options.envFile || defaultEnvFile(process.cwd()))
  const installer = verifiedInstallerPath(options.installer)
  const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : ''
  if (!/^pair_[A-Za-z0-9_-]{8,160}$/.test(requestId)) {
    throw new Error('pair-gateway requires a valid --request-id <pair-id>.')
  }
  hardenPrivateEnvFile(envFile, options)
  const environment = loadRouterEnvFile(envFile, options.baseEnvironment || process.env)
  const approvalToken = environment[approvalTokenKey]
  if (!tokenIsValid(approvalToken)) {
    throw new Error('The private Router environment has no valid approval token; run init and restart Router before pairing.')
  }
  const routerUrl = loopbackRouterUrl(
    typeof options.routerUrl === 'string' && options.routerUrl
      ? options.routerUrl
      : environment.HERMES_HUB_ROUTER_URL || 'http://127.0.0.1:4320',
  )
  const sourceBase = localRouterPackageSourceBase(options.sourceBase, routerUrl)
  const childArgs = [installer, '--router', routerUrl, '--request-id', requestId]
  if (sourceBase) {
    childArgs.push('--source-base', sourceBase)
  }
  const child = (options.spawnImpl || spawn)(process.execPath, childArgs, {
    cwd: dirname(installer),
    env: environment,
    stdio: options.stdio || 'inherit',
    windowsHide: true,
  })
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  if (result.signal) throw new Error(`Gateway installer stopped by ${result.signal}.`)
  if (result.code !== 0) throw new Error(`Gateway installer exited with code ${result.code ?? 1}.`)
  return { installer, requestId, routerUrl, sourceBase }
}

async function probeHealth(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 750)
  try {
    const response = await (options.fetchImpl || fetch)(url, { signal: controller.signal })
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    return { reached: true, status: response.status, payload }
  } catch {
    return { reached: false }
  } finally {
    clearTimeout(timeout)
  }
}

async function assertPortAvailable(host, port, options = {}) {
  const server = (options.netServerFactory || createNetServer)()
  await new Promise((resolvePromise, reject) => {
    server.once('error', error => {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (code === 'EADDRINUSE') {
        reject(new Error(`Router port ${host}:${port} is already in use by a process that did not expose Router health.`))
        return
      }
      reject(error)
    })
    server.listen({ host, port, exclusive: true }, () => {
      server.close(closeError => closeError ? reject(closeError) : resolvePromise())
    })
  })
}

export async function preflightRouterStart(environment, options = {}) {
  const port = Number(environment.HERMES_HUB_ROUTER_PORT || 4320)
  const host = environment.HERMES_HUB_ROUTER_HOST || '0.0.0.0'
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('HERMES_HUB_ROUTER_PORT must be an integer between 1 and 65535.')
  }
  const healthUrl = healthProbeUrl(environment, host, port)
  const health = await probeHealth(healthUrl, options)
  if (health.reached) {
    const payload = health.payload && typeof health.payload === 'object' ? health.payload : {}
    if (payload.service === 'hermes-hub-router') {
      const current = payload.topology === 'client-router-hermes-hub-gateway-agent' &&
        payload.pairing === 'prompt-code-claim/v2'
      const kind = current ? 'Gateway-only Router' : 'legacy Router'
      throw new Error(
        `A ${kind} is already running at ${healthUrl}. Stop it before restarting; ` +
        'the running process has not loaded newly initialized or rotated environment values.',
      )
    }
    throw new Error(`Router port ${host}:${port} is occupied by another HTTP service.`)
  }
  await assertPortAvailable(host, port, options)
}

function usage() {
  return [
    'Hermes Hub local Router environment',
    '',
    'Usage:',
    '  node router-local-env.mjs init [--router-env <path>]',
    '  node router-local-env.mjs run [--router-env <path>]',
    '  node router-local-env.mjs rotate-approval-token [--router-env <path>]',
    '  node router-local-env.mjs clear-approval-token [--router-env <path>]',
    '  node router-local-env.mjs pair-gateway --installer <verified-installer-path> --request-id <pair-id> [--router <loopback-url>] [--source-base <Router package mirror>] [--router-env <path>]',
    '',
    'Hermes Hub monorepo usage:',
    '  node apps/hermes-hub-server-router/router-local-env.mjs init [--router-env <path>]',
    '  node apps/hermes-hub-server-router/router-local-env.mjs run [--router-env <path>]',
    '  node apps/hermes-hub-server-router/router-local-env.mjs rotate-approval-token [--router-env <path>]',
    '  node apps/hermes-hub-server-router/router-local-env.mjs clear-approval-token [--router-env <path>]',
    '  pnpm router:pair-gateway -- --installer <verified-installer-path> --request-id <pair-id> [--router <loopback-url>] [--source-base <Router package mirror>]',
    '',
    'The token is generated once, never printed, and rotated or cleared only by explicit local commands.',
  ].join('\n')
}

async function runRouter(cwd, envFile) {
  const environment = loadRouterEnvFile(envFile)
  const tsxCli = join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const routerEntryCandidates = [
    join(cwd, 'src', 'bridgeServer.ts'),
    join(cwd, 'apps', 'hermes-hub-server-router', 'src', 'bridgeServer.ts'),
    join(cwd, 'apps', 'server-router', 'src', 'bridgeServer.ts'),
  ]
  const routerEntry = routerEntryCandidates.find(candidate => existsSync(candidate))
  if (!existsSync(tsxCli)) throw new Error('tsx is not installed. Run pnpm install first.')
  if (!routerEntry) {
    throw new Error('Router source was not found in a standalone checkout or Hermes Hub monorepo.')
  }
  await preflightRouterStart(environment)
  const child = spawn(process.execPath, [tsxCli, routerEntry], {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  })
  const forwardInterrupt = () => {
    if (!child.killed) child.kill('SIGINT')
  }
  const forwardTerminate = () => {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.once('SIGINT', forwardInterrupt)
  process.once('SIGTERM', forwardTerminate)
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  process.removeListener('SIGINT', forwardInterrupt)
  process.removeListener('SIGTERM', forwardTerminate)
  if (result.signal) process.kill(process.pid, result.signal)
  if (result.code !== 0) process.exitCode = result.code ?? 1
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv)
  const command = parsed._[0] || 'help'
  if (command === 'help' || parsed.help === true) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const cwd = resolve(options.cwd || process.cwd())
  const envFile = resolve(cwd, textOption(parsed, 'router-env', defaultEnvFile(cwd)))
  if (command === 'init') {
    const result = ensureRouterEnvFile(envFile, options)
    process.stdout.write(`Router environment ready at ${result.path}; approval token ${result.created ? 'generated' : 'reused'}.\n`)
    return
  }
  if (command === 'rotate-approval-token') {
    const result = ensureRouterEnvFile(envFile, { ...options, rotate: true })
    process.stdout.write(`Router approval token rotated in ${result.path}; the value was not printed.\n`)
    return
  }
  if (command === 'clear-approval-token') {
    const result = clearRouterApprovalToken(envFile, options)
    process.stdout.write(
      result.cleared
        ? `Router approval token cleared from ${result.path}; run init or run to generate a new value.\n`
        : `Router environment at ${result.path} has no approval token to clear.\n`,
    )
    return
  }
  if (command === 'pair-gateway') {
    const result = await runApprovedGatewayInstaller({
      ...options,
      envFile,
      installer: textOption(parsed, 'installer'),
      requestId: textOption(parsed, 'request-id'),
      routerUrl: textOption(parsed, 'router'),
      sourceBase: textOption(parsed, 'source-base'),
    })
    process.stdout.write(`Gateway installer completed for ${result.requestId}; Router approval token was not printed.\n`)
    return
  }
  if (command === 'run') {
    ensureRouterEnvFile(envFile, options)
    await runRouter(cwd, envFile)
    return
  }
  throw new Error(`Unknown Router environment command: ${command}`)
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  main().catch(error => {
    console.error(`[router-local-env] ERROR ${error.message}`)
    process.exitCode = 1
  })
}
