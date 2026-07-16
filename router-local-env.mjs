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
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const approvalTokenKey = 'HERMES_HUB_AGENT_APPROVAL_TOKEN'
const pairingConfigSchemaVersion = 1
const pairingConfigFileName = 'pairing.json'
const routerProcessStateSchemaVersion = 1
const routerProcessStateSuffix = '.router-process.json'
const routerPackageRoot = dirname(fileURLToPath(import.meta.url))
const routerEntryPath = join(routerPackageRoot, 'src', 'bridgeServer.ts')

function windowsSystemExecutable(name) {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR
  if (!windowsRoot) throw new Error('Windows system root is unavailable.')
  return join(windowsRoot, 'System32', name)
}

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
  return typeof value === 'string' && value.length >= 32 && !/\s/.test(value)
}

function defaultHermesHome(environment = process.env) {
  const configured = String(environment.HERMES_HOME || '').trim()
  if (configured) return resolve(configured)

  const home = String(environment.USERPROFILE || environment.HOME || homedir()).trim() || homedir()
  if (process.platform === 'win32') {
    return join(String(environment.LOCALAPPDATA || environment.APPDATA || home), 'hermes')
  }
  if (process.platform === 'darwin') {
    return join(String(environment.XDG_CONFIG_HOME || join(home, 'Library', 'Application Support')), 'hermes')
  }
  return join(String(environment.XDG_CONFIG_HOME || join(home, '.config')), 'hermes')
}

export function defaultPairingConfigPath(options = {}) {
  if (options.pairingConfigPath) return resolve(options.pairingConfigPath)
  return join(defaultHermesHome(options.environment), 'hermes-hub', pairingConfigFileName)
}

let cachedWindowsUserSid = ''

function windowsUserSid(commandRunner = spawnSync) {
  if (cachedWindowsUserSid) return cachedWindowsUserSid
  const result = commandRunner(windowsSystemExecutable('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
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
      const result = commandRunner(windowsSystemExecutable('icacls.exe'), commandArgs, {
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

function localPairingToken(path, options = {}) {
  if (!existsSync(path)) return ''
  hardenPrivateEnvFile(path, options)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('Local pairing configuration is malformed.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== pairingConfigSchemaVersion) {
    throw new Error('Local pairing configuration schema is unsupported.')
  }
  if (!tokenIsValid(parsed.approvalToken)) {
    throw new Error('Local pairing configuration has no valid approval token.')
  }
  return parsed.approvalToken
}

function writeLocalPairingToken(path, token, options = {}) {
  writePrivateEnvFile(path, `${JSON.stringify({
    schemaVersion: pairingConfigSchemaVersion,
    approvalToken: token,
  }, null, 2)}\n`, options)
}

function withoutApprovalToken(lines) {
  const retained = lines.filter(line => !line.startsWith(`${approvalTokenKey}=`))
  while (retained.length > 0 && retained.at(-1) === '') retained.pop()
  return retained
}

export function ensureRouterEnvFile(path, options = {}) {
  const rotate = options.rotate === true
  const tokenFactory = options.tokenFactory || (() => randomBytes(32).toString('hex'))
  const pairingConfigPath = defaultPairingConfigPath(options)
  if (existsSync(path)) hardenPrivateEnvFile(path, options)
  const existingText = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = envLines(existingText)
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  const entries = approvalTokenEntries(lines)
  if (entries.length > 1) {
    throw new Error(`${approvalTokenKey} appears more than once in the Router environment.`)
  }
  const legacyToken = entries.length === 1 ? entries[0].line.slice(approvalTokenKey.length + 1) : ''
  if (legacyToken && !tokenIsValid(legacyToken)) {
    throw new Error(`${approvalTokenKey} must contain at least 32 non-whitespace characters.`)
  }
  const persistedToken = localPairingToken(pairingConfigPath, options)
  if (persistedToken && legacyToken && persistedToken !== legacyToken) {
    throw new Error('Local pairing configuration disagrees with the legacy Router approval token.')
  }

  const generated = !persistedToken && !legacyToken
  const nextToken = rotate || generated ? tokenFactory() : (persistedToken || legacyToken)
  if (!tokenIsValid(nextToken)) throw new Error('Generated Router approval token is invalid.')
  if (rotate || !persistedToken) writeLocalPairingToken(pairingConfigPath, nextToken, options)

  const retained = withoutApprovalToken(lines)
  if (!existsSync(path) || entries.length > 0) {
    writePrivateEnvFile(path, `${retained.join('\n')}\n`, options)
  }
  return {
    created: generated,
    rotated: rotate && Boolean(persistedToken || legacyToken),
    path,
    pairingConfigPath,
  }
}

export function clearRouterApprovalToken(path, options = {}) {
  const pairingConfigPath = defaultPairingConfigPath(options)
  let cleared = false
  if (existsSync(pairingConfigPath)) {
    hardenPrivateEnvFile(pairingConfigPath, options)
    rmSync(pairingConfigPath)
    cleared = true
  }
  if (existsSync(path)) {
    hardenPrivateEnvFile(path, options)
    const lines = envLines(readFileSync(path, 'utf8'))
    const entries = approvalTokenEntries(lines)
    if (entries.length > 0) {
      writePrivateEnvFile(path, `${withoutApprovalToken(lines).join('\n')}\n`, options)
      cleared = true
    }
  }
  return { cleared, path, pairingConfigPath }
}

export function loadRouterEnvFile(path, baseEnvironment = process.env, options = {}) {
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
  const approvalToken = localPairingToken(
    defaultPairingConfigPath({
      ...options,
      environment: { ...(options.environment || {}), ...environment },
    }),
    options,
  )
  if (approvalToken) environment[approvalTokenKey] = approvalToken
  else delete environment[approvalTokenKey]
  return environment
}

function defaultEnvFile(cwd) {
  return join(cwd, '.env')
}

export function defaultRouterProcessStatePath(envFile) {
  return `${resolve(envFile)}${routerProcessStateSuffix}`
}

function routerProcessState(path) {
  hardenPrivateEnvFile(path)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('Router process state is malformed.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    parsed.schemaVersion !== routerProcessStateSchemaVersion ||
    !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
    parsed.routerEntry !== routerEntryPath ||
    typeof parsed.processStartedAt !== 'string' || !parsed.processStartedAt) {
    throw new Error('Router process state is invalid.')
  }
  return parsed
}

function writeRouterProcessState(path, pid) {
  const processStartedAt = processStartMarker(pid)
  if (!processStartedAt) throw new Error(`Could not record a launch identity for Router PID ${pid}.`)
  writePrivateEnvFile(path, `${JSON.stringify({
    schemaVersion: routerProcessStateSchemaVersion,
    pid,
    routerEntry: routerEntryPath,
    processStartedAt,
  }, null, 2)}\n`)
}

function removeRouterProcessState(path, expectedPid) {
  if (!existsSync(path)) return false
  const state = routerProcessState(path)
  if (expectedPid !== undefined && state.pid !== expectedPid) return false
  rmSync(path)
  return true
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EPERM') return true
    return false
  }
}

function processStartMarker(pid) {
  if (process.platform === 'win32') {
    const powershell = join(windowsSystemExecutable('WindowsPowerShell'), 'v1.0', 'powershell.exe')
    const result = spawnSync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $process) { [Console]::Out.Write($process.StartTime.ToUniversalTime().ToString('o')) }`,
    ], { encoding: 'utf8', windowsHide: true })
    return result.status === 0 ? String(result.stdout || '').trim() : ''
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processIsRunning(pid) && Date.now() < deadline) await delay(50)
  return !processIsRunning(pid)
}

export async function stopRouterProcess(envFile) {
  const statePath = defaultRouterProcessStatePath(envFile)
  if (!existsSync(statePath)) return { stopped: false, statePath }
  const state = routerProcessState(statePath)
  if (!processIsRunning(state.pid)) {
    removeRouterProcessState(statePath, state.pid)
    return { stopped: false, stale: true, statePath, pid: state.pid }
  }
  const currentProcessStartedAt = processStartMarker(state.pid)
  if (currentProcessStartedAt && currentProcessStartedAt !== state.processStartedAt) {
    throw new Error(`Refusing to stop PID ${state.pid}: it does not match the Router launch identity recorded by this launcher.`)
  }

  let exited = false
  try {
    process.kill(state.pid, 'SIGTERM')
    exited = await waitForProcessExit(state.pid, 1_500)
  } catch (error) {
    if (!processIsRunning(state.pid)) {
      removeRouterProcessState(statePath, state.pid)
      return { stopped: false, stale: true, statePath, pid: state.pid }
    }
    if (process.platform !== 'win32') throw error
  }
  if (!exited) {
    if (process.platform === 'win32') {
      const result = spawnSync(windowsSystemExecutable('taskkill.exe'), ['/pid', String(state.pid), '/t', '/f'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (result.status !== 0 && processIsRunning(state.pid)) {
        throw new Error(`Could not force-stop tracked Router PID ${state.pid}.`)
      }
    } else {
      process.kill(state.pid, 'SIGKILL')
    }
    if (!await waitForProcessExit(state.pid, 1_500)) {
      throw new Error(`Tracked Router PID ${state.pid} did not exit.`)
    }
  }
  removeRouterProcessState(statePath, state.pid)
  return { stopped: true, statePath, pid: state.pid }
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
  const environment = loadRouterEnvFile(envFile, options.baseEnvironment || process.env, options)
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
    '  node router-local-env.mjs init [--router-env <path>] [--pairing-config <path>]',
    '  node router-local-env.mjs run [--router-env <path>] [--pairing-config <path>]',
    '  node router-local-env.mjs stop [--router-env <path>]',
    '  node router-local-env.mjs rotate-approval-token [--router-env <path>] [--pairing-config <path>]',
    '  node router-local-env.mjs clear-approval-token [--router-env <path>] [--pairing-config <path>]',
    '  node router-local-env.mjs pair-gateway --installer <verified-installer-path> --request-id <pair-id> [--router <loopback-url>] [--source-base <Router package mirror>] [--router-env <path>] [--pairing-config <path>]',
    '',
    'Hermes Hub monorepo usage:',
    '  node apps/hermes-hub-server-router/router-local-env.mjs init [--router-env <path>]',
    '  node apps/hermes-hub-server-router/router-local-env.mjs run [--router-env <path>]',
    '  node apps/hermes-hub-server-router/router-local-env.mjs stop [--router-env <path>]',
    '  node apps/hermes-hub-server-router/router-local-env.mjs rotate-approval-token [--router-env <path>]',
    '  node apps/hermes-hub-server-router/router-local-env.mjs clear-approval-token [--router-env <path>]',
    '  pnpm router:pair-gateway -- --installer <verified-installer-path> --request-id <pair-id> [--router <loopback-url>] [--source-base <Router package mirror>]',
    '',
    'The token is generated once, never printed, and rotated or cleared only by explicit local commands.',
  ].join('\n')
}

async function runRouter(cwd, envFile, options = {}) {
  const environment = loadRouterEnvFile(envFile, process.env, options)
  const tsxCli = join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (!existsSync(tsxCli)) throw new Error('tsx is not installed. Run pnpm install first.')
  if (!existsSync(routerEntryPath)) {
    throw new Error(`Router source was not found beside ${fileURLToPath(import.meta.url)}.`)
  }
  await preflightRouterStart(environment)
  const child = spawn(process.execPath, [tsxCli, routerEntryPath], {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  })
  const statePath = defaultRouterProcessStatePath(envFile)
  try {
    writeRouterProcessState(statePath, child.pid)
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
  const forwardInterrupt = () => {
    if (!child.killed) child.kill('SIGINT')
  }
  const forwardTerminate = () => {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.once('SIGINT', forwardInterrupt)
  process.once('SIGTERM', forwardTerminate)
  let result
  try {
    result = await new Promise((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolvePromise({ code, signal }))
    })
  } finally {
    process.removeListener('SIGINT', forwardInterrupt)
    process.removeListener('SIGTERM', forwardTerminate)
    removeRouterProcessState(statePath, child.pid)
  }
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
  const pairingConfigPath = resolve(
    cwd,
    textOption(parsed, 'pairing-config', defaultPairingConfigPath(options)),
  )
  const localOptions = { ...options, pairingConfigPath }
  if (command === 'init') {
    const result = ensureRouterEnvFile(envFile, localOptions)
    process.stdout.write(`Router environment ready at ${result.path}; approval token ${result.created ? 'generated' : 'reused'}.\n`)
    return
  }
  if (command === 'rotate-approval-token') {
    const result = ensureRouterEnvFile(envFile, { ...localOptions, rotate: true })
    process.stdout.write(`Router approval token rotated in ${result.path}; the value was not printed.\n`)
    return
  }
  if (command === 'clear-approval-token') {
    const result = clearRouterApprovalToken(envFile, localOptions)
    process.stdout.write(
      result.cleared
        ? `Router approval token cleared from ${result.path}; run init or run to generate a new value.\n`
        : `Router environment at ${result.path} has no approval token to clear.\n`,
    )
    return
  }
  if (command === 'stop') {
    const result = await stopRouterProcess(envFile)
    if (result.stopped) {
      process.stdout.write(`Stopped tracked Router process ${result.pid}.\n`)
    } else if (result.stale) {
      process.stdout.write(`No tracked Router is running; removed stale process state for PID ${result.pid}.\n`)
    } else {
      process.stdout.write('No tracked Router process state was found.\n')
    }
    return
  }
  if (command === 'pair-gateway') {
    const result = await runApprovedGatewayInstaller({
      ...localOptions,
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
    ensureRouterEnvFile(envFile, localOptions)
    await runRouter(cwd, envFile, localOptions)
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
