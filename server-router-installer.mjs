#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
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
import { dirname, join } from 'node:path'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import os from 'node:os'

const VERSION = '2026-07-14.4'
const DEFAULT_BASE_URL = 'https://raw.githubusercontent.com/over01470914/hermes-hub-server-router/main/'
const DEFAULT_GATEWAY_PACKAGE_BASE_URL = 'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/'
const DEFAULT_ROUTER_URL = 'https://hermes-hub.s3studio.fun/router-dev'
const GATEWAY_PACKAGE_MANIFEST_SCHEMA = 'hermes-hub-gateway-package/v1'
const GATEWAY_PACKAGE_MANIFEST = 'package-manifest.json'
const GATEWAY_PACKAGE_PAYLOAD_FILES = Object.freeze([
  '__init__.py',
  'adapter.py',
  'protocol.py',
  'plugin.yaml',
  'install.mjs',
])
const GATEWAY_PACKAGE_FILES = Object.freeze([
  ...GATEWAY_PACKAGE_PAYLOAD_FILES,
  GATEWAY_PACKAGE_MANIFEST,
])
const MAX_RUNTIME_FILE_BYTES = 2 * 1024 * 1024
const MAX_GATEWAY_MANIFEST_BYTES = 64 * 1024
const MAX_GATEWAY_FILE_BYTES = 2 * 1024 * 1024
const MAX_GATEWAY_PACKAGE_BYTES = 4 * 1024 * 1024
const SERVER_FILES = [
  'README.md',
  'src/bridgeServer.ts',
  'src/core/http/boundedSseWriter.ts',
  'src/core/http/routerBasePath.ts',
  'src/core/observability/routerLogger.ts',
  'src/core/persistence/privateStateFile.ts',
  'src/core/protocol/bridgeProtocol.ts',
  'src/core/security/bridgeAuth.ts',
  'src/core/security/bridgePolicy.ts',
  'src/features/cron/cronBridge.ts',
  'src/features/diagnostics/diagnosticsReceipt.ts',
  'src/features/gateway/gatewayPluginSource.ts',
  'src/features/gateway/gatewayRegistry.ts',
  'src/features/gateway/hermesGatewayRepository.ts',
  'src/features/kanban/kanbanBridgeAdapter.ts',
  'src/features/pairing/pairingRateLimiter.ts',
  'src/features/pairing/pairingStore.ts',
  'src/features/realtime/clientEventHub.ts',
  'src/features/realtime/pendingRealtimeFrames.ts',
  'src/features/sessions/sessionMetadata.ts',
  'src/features/sessions/sessionMetadataStore.ts',
]
const MANAGED_ENV_KEYS = new Set([
  'NODE_ENV',
  'HERMES_HUB_ROUTER_URL',
  'HERMES_HUB_ROUTER_HOST',
  'HERMES_HUB_ROUTER_PORT',
  'HERMES_HUB_DIAGNOSTICS_DIR',
  'HERMES_HUB_PAIRING_STORE_PATH',
  'HERMES_HUB_SESSION_METADATA_STORE_PATH',
])

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--') continue
    if (!item.startsWith('--')) {
      args._.push(item)
      continue
    }
    const [key, inline] = item.slice(2).split('=', 2)
    if (inline !== undefined) args[key] = inline
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[key] = argv[++index]
    else args[key] = true
  }
  return args
}

function textArg(args, key, fallback = '') {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function boolArg(args, key) {
  return args[key] === true || args[key] === '1' || args[key] === 'true'
}

function platformArg(args) {
  const value = textArg(args, 'platform', process.platform)
  if (!['linux', 'darwin', 'win32'].includes(value)) throw new Error(`Unsupported platform: ${value}`)
  return value
}

function defaultWorkdir(platform) {
  if (platform === 'linux') return '/opt/hermes-hub'
  if (platform === 'win32') return join(os.homedir(), 'AppData', 'Local', 'HermesHub', 'server-router')
  return join(os.homedir(), '.hermes-hub', 'server-router')
}

function defaultEnvFile(platform, workdir) {
  return platform === 'linux' ? '/etc/hermes-hub-router.env' : join(workdir, '.env')
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}

function normalizeSourceBase(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${label} is invalid`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) fail(`${label} must use http:// or https://`)
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(`${label} must not contain credentials, query, or fragment`)
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
  if (parsed.protocol === 'http:' && !loopback) fail(`${label} must use HTTPS outside loopback`)
  return ensureTrailingSlash(parsed.toString())
}

function sourceFileUrl(sourceBase, name) {
  const parsed = new URL(sourceBase)
  const treeMarker = '/-/tree/'
  const treeIndex = parsed.pathname.indexOf(treeMarker)
  if (parsed.hostname.toLowerCase() === 'cnb.cool' && treeIndex >= 0) {
    const treePath = parsed.pathname.slice(treeIndex + treeMarker.length)
    const refSeparator = treePath.indexOf('/')
    if (refSeparator <= 0 || refSeparator === treePath.length - 1) {
      fail('CNB source URL must include a ref and directory path')
    }
    const ref = treePath.slice(0, refSeparator)
    const directory = treePath.slice(refSeparator + 1).replace(/\/+$/, '')
    parsed.pathname = `${parsed.pathname.slice(0, treeIndex)}/-/git/raw/${ref}/${directory}/`
  }
  return new URL(name, parsed).toString()
}

function sourceRequestHeaders(url) {
  const token = typeof process.env.CNB_TOKEN === 'string' ? process.env.CNB_TOKEN.trim() : ''
  if (new URL(url).hostname.toLowerCase() !== 'cnb.cool' || !token) return {}
  return { authorization: `Basic ${Buffer.from(`cnb:${token}`).toString('base64')}` }
}

function log(message) {
  console.log(`[server-router-installer] ${message}`)
}

function fail(message) {
  throw new Error(message)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [command] : ['-lc', `command -v ${shellQuote(command)}`], { encoding: 'utf8' })
  if (result.status !== 0) return ''
  const candidates = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  if (process.platform !== 'win32') return candidates[0] || ''
  return candidates.find(path => /\.(?:exe|com|cmd|bat)$/i.test(path)) || candidates[0] || ''
}

function run(command, args = [], options = {}) {
  const label = [command, ...args].join(' ')
  if (options.dryRun) {
    log(`dry-run ${label}`)
    return ''
  }
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    windowsHide: true,
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function sudo(args, options = {}) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return run(args[0], args.slice(1), options)
  return run('sudo', args, options)
}

function writeFile(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  if (mode) chmodSync(path, mode)
}

let cachedWindowsUserSid = ''

function windowsUserSid() {
  if (cachedWindowsUserSid) return cachedWindowsUserSid
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const match = result.status === 0 ? String(result.stdout || '').match(/S-1-[0-9-]+/) : null
  if (!match) fail('Could not determine the current Windows user for the private Router environment')
  cachedWindowsUserSid = match[0]
  return cachedWindowsUserSid
}

function hardenPrivateEnvFile(path, platform = process.platform) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Router environment must be a regular local file')
  if (platform === 'win32') {
    const commands = [
      [path, '/reset'],
      [path, '/inheritance:r'],
      [path, '/grant:r', `*${windowsUserSid()}:F`],
    ]
    for (const commandArgs of commands) {
      const result = spawnSync('icacls.exe', commandArgs, { encoding: 'utf8', windowsHide: true })
      if (result.status !== 0) fail('Could not restrict Windows permissions for the private Router environment')
    }
    return
  }
  chmodSync(path, 0o600)
  if ((lstatSync(path).mode & 0o077) !== 0) fail('Could not restrict permissions for the private Router environment')
}

function writePrivateEnvFile(path, content, platform = process.platform) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (!existing.isFile() || existing.isSymbolicLink()) fail('Router environment target must be a regular local file')
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    hardenPrivateEnvFile(temporary, platform)
    renameSync(temporary, path)
    hardenPrivateEnvFile(path, platform)
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    rmSync(temporary, { force: true })
  }
}

function npmInvocation() {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (process.platform === 'win32' && existsSync(npmCli)) {
    return { command: process.execPath, prefixArgs: [npmCli] }
  }
  const npm = commandExists('npm')
  return npm ? { command: npm, prefixArgs: [] } : null
}

async function boundedBytes(response, maximumBytes, label) {
  const rawLength = response.headers.get('content-length')
  if (rawLength && !/^\d+$/.test(rawLength)) fail(`${label} returned an invalid content length`)
  if (rawLength && Number(rawLength) > maximumBytes) fail(`${label} exceeded the download size limit`)
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maximumBytes) fail(`${label} exceeded the download size limit`)
    return bytes
  }
  const chunks = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      fail(`${label} exceeded the download size limit`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function download(url, maximumBytes, label) {
  const response = await fetch(url, {
    headers: sourceRequestHeaders(url),
    redirect: 'manual',
  })
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    fail(`${label} redirected; redirects are not allowed`)
  }
  if (!response.ok) {
    const authenticationHint = new URL(url).hostname.toLowerCase() === 'cnb.cool'
      && response.status === 404
      && !process.env.CNB_TOKEN?.trim()
      ? '; set a machine-local read-only CNB_TOKEN if the repository is private'
      : ''
    fail(`${label} download failed with status ${response.status}${authenticationHint}`)
  }
  return boundedBytes(response, maximumBytes, label)
}

async function downloadRuntime(baseUrl, workdir, dryRun) {
  const root = join(workdir, 'apps', 'server-router')
  if (dryRun) {
    log(`dry-run download ${SERVER_FILES.length} files from ${baseUrl} -> ${root}`)
    return
  }
  mkdirSync(root, { recursive: true })
  for (const file of SERVER_FILES) {
    writeFile(
      join(root, file),
      await download(sourceFileUrl(baseUrl, file), MAX_RUNTIME_FILE_BYTES, `Router runtime file ${file}`),
    )
  }
  writeFile(join(workdir, 'package.json'), JSON.stringify({
    name: 'hermes-hub-router-runtime',
    private: true,
    version: VERSION,
    type: 'module',
    scripts: {
      'router:dev': 'tsx apps/server-router/src/bridgeServer.ts',
      'server-router:dev': 'tsx apps/server-router/src/bridgeServer.ts',
      'server:check': 'tsc -p tsconfig.server.json --pretty false',
    },
    dependencies: { ws: '^8.18.3' },
    devDependencies: {
      '@types/node': '^26.0.1',
      '@types/ws': '^8.18.1',
      tsx: '^4.20.6',
      typescript: '^5.7.3',
    },
  }, null, 2) + '\n')
  writeFile(join(workdir, 'tsconfig.server.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['apps/server-router/src/**/*.ts'],
  }, null, 2) + '\n')
  writeFile(join(workdir, 'dist', 'index.html'), '<!doctype html><meta charset="utf-8"><title>Hermes Hub Router</title><body>Hermes Hub Router</body>\n')
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function gatewayManifest(bytes) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('Gateway package manifest contains invalid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, ['schema', 'version', 'files'])) {
    fail('Gateway package manifest shape is invalid')
  }
  if (value.schema !== GATEWAY_PACKAGE_MANIFEST_SCHEMA) fail('Gateway package manifest schema is unsupported')
  if (typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.version)) {
    fail('Gateway package manifest version is invalid')
  }
  if (!Array.isArray(value.files) || value.files.length !== GATEWAY_PACKAGE_PAYLOAD_FILES.length) {
    fail('Gateway package manifest file allowlist is invalid')
  }
  const files = new Map()
  let total = bytes.length
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, ['name', 'bytes', 'sha256'])) {
      fail('Gateway package manifest file entry is invalid')
    }
    if (!GATEWAY_PACKAGE_PAYLOAD_FILES.includes(entry.name) || files.has(entry.name)) {
      fail('Gateway package manifest file allowlist is invalid')
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > MAX_GATEWAY_FILE_BYTES) {
      fail('Gateway package manifest file size is invalid')
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      fail('Gateway package manifest file hash is invalid')
    }
    total += entry.bytes
    if (total > MAX_GATEWAY_PACKAGE_BYTES) fail('Gateway package exceeds the total size limit')
    files.set(entry.name, entry)
  }
  if (GATEWAY_PACKAGE_PAYLOAD_FILES.some(name => !files.has(name))) {
    fail('Gateway package manifest file allowlist is invalid')
  }
  return { files }
}

async function downloadGatewayPackage(baseUrl, workdir, dryRun) {
  const target = join(workdir, 'apps', 'hermes-hub-gateway-plugin')
  if (dryRun) {
    log(`dry-run download verified Gateway package from ${baseUrl} -> ${target}`)
    return
  }
  const manifestBytes = await download(
    sourceFileUrl(baseUrl, GATEWAY_PACKAGE_MANIFEST),
    MAX_GATEWAY_MANIFEST_BYTES,
    'Gateway package manifest',
  )
  const manifest = gatewayManifest(manifestBytes)
  const verified = new Map([[GATEWAY_PACKAGE_MANIFEST, manifestBytes]])
  for (const name of GATEWAY_PACKAGE_PAYLOAD_FILES) {
    const expected = manifest.files.get(name)
    const bytes = await download(sourceFileUrl(baseUrl, name), expected.bytes, `Gateway package file ${name}`)
    if (bytes.length !== expected.bytes) fail(`Gateway package file ${name} has an invalid byte length`)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== expected.sha256) fail(`Gateway package file ${name} failed SHA-256 verification`)
    verified.set(name, bytes)
  }

  const stage = `${target}.stage-${process.pid}`
  const displaced = `${target}.rollback-${process.pid}`
  rmSync(stage, { recursive: true, force: true })
  rmSync(displaced, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  try {
    for (const name of GATEWAY_PACKAGE_FILES) writeFile(join(stage, name), verified.get(name))
    if (existsSync(target)) renameSync(target, displaced)
    renameSync(stage, target)
    rmSync(displaced, { recursive: true, force: true })
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    if (!existsSync(target) && existsSync(displaced)) renameSync(displaced, target)
    throw error
  }
}

function installDependencies(workdir, dryRun) {
  if (process.platform !== 'win32') {
    const pnpm = commandExists('pnpm')
    if (pnpm) return run(pnpm, ['install', '--prod=false'], { cwd: workdir, dryRun, capture: false })
  }
  const npm = npmInvocation()
  if (!npm) fail('npm or pnpm is required')
  return run(npm.command, [...npm.prefixArgs, 'install', '--no-audit', '--no-fund'], { cwd: workdir, dryRun, capture: false })
}

function randomPairingCode() {
  return String(randomInt(0, 100000000)).padStart(8, '0')
}

function updateEnvFile(path, config, dryRun) {
  if (existsSync(path) && !(config.platform === 'linux' && path.startsWith('/etc/'))) {
    hardenPrivateEnvFile(path, config.platform)
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  const preserved = []
  let hasPairingCode = false
  let hasBridgeSecret = false
  let hasAgentApprovalToken = false
  let agentApprovalTokenCount = 0
  for (const line of existing) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (match) {
      if (match[1] === 'HERMES_HUB_PAIRING_CODE') hasPairingCode = true
      if (match[1] === 'HERMES_HUB_BRIDGE_SECRET') hasBridgeSecret = true
      if (match[1] === 'HERMES_HUB_AGENT_APPROVAL_TOKEN') {
        if (config.rotateAgentApprovalToken) continue
        agentApprovalTokenCount += 1
        const value = line.slice('HERMES_HUB_AGENT_APPROVAL_TOKEN='.length)
        if (value.length < 32 || /\s/.test(value)) {
          fail('HERMES_HUB_AGENT_APPROVAL_TOKEN must contain at least 32 non-whitespace characters')
        }
        hasAgentApprovalToken = true
      }
      if (MANAGED_ENV_KEYS.has(match[1])) continue
    }
    if (line.trim()) preserved.push(line)
  }
  if (agentApprovalTokenCount > 1) fail('HERMES_HUB_AGENT_APPROVAL_TOKEN appears more than once')
  const additions = []
  if (!hasPairingCode) additions.push(`HERMES_HUB_PAIRING_CODE=${randomPairingCode()}`)
  if (!hasBridgeSecret) additions.push(`HERMES_HUB_BRIDGE_SECRET=${randomBytes(32).toString('hex')}`)
  if (!hasAgentApprovalToken) additions.push(`HERMES_HUB_AGENT_APPROVAL_TOKEN=${randomBytes(32).toString('hex')}`)
  additions.push(
    'NODE_ENV=production',
    `HERMES_HUB_ROUTER_URL=${config.routerUrl}`,
    `HERMES_HUB_ROUTER_HOST=${config.host}`,
    `HERMES_HUB_ROUTER_PORT=${config.port}`,
    `HERMES_HUB_DIAGNOSTICS_DIR=${join(config.workdir, 'diagnostics')}`,
    `HERMES_HUB_PAIRING_STORE_PATH=${join(config.workdir, 'state', 'pairing-store.json')}`,
    `HERMES_HUB_SESSION_METADATA_STORE_PATH=${join(config.workdir, 'state', 'session-metadata.json')}`,
  )
  const content = [...preserved, ...additions, ''].join('\n')
  if (dryRun) return log(`dry-run update env ${path}; secret values are not printed`)
  const tmp = join(os.tmpdir(), `${config.service}.env.${process.pid}`)
  if (config.platform === 'linux' && path.startsWith('/etc/')) {
    writePrivateEnvFile(tmp, content, 'linux')
    sudo(['install', '-m', '0600', '-o', 'root', '-g', 'root', tmp, path])
    rmSync(tmp, { force: true })
  } else {
    writePrivateEnvFile(path, content, config.platform)
  }
}

function writeWatchdog(config, dryRun) {
  const npm = npmInvocation()
  if (!npm) fail('npm is required')
  const runner = join(config.workdir, 'scripts', 'run-server-router-watchdog.mjs')
  const content = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
const workdir = ${JSON.stringify(config.workdir)}
const envFile = ${JSON.stringify(config.envFile)}
const npm = ${JSON.stringify(npm.command)}
const npmPrefixArgs = ${JSON.stringify(npm.prefixArgs)}
function loadEnv(path) {
  const env = { ...process.env }
  if (!existsSync(path)) return env
  for (const line of readFileSync(path, 'utf8').split(/\\r?\\n/)) {
    if (!line || line.trim().startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    env[line.slice(0, index)] = line.slice(index + 1)
  }
  return env
}
let child
let stopping = false
function start() {
  const env = loadEnv(envFile)
  child = spawn(npm, [...npmPrefixArgs, 'run', 'server-router:dev'], { cwd: workdir, env, stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    if (stopping) process.exit(code || 0)
    console.error('[server-router-watchdog] child exited', { code, signal })
    setTimeout(start, 3000)
  })
}
process.on('SIGTERM', () => { stopping = true; child?.kill('SIGTERM') })
process.on('SIGINT', () => { stopping = true; child?.kill('SIGINT') })
start()
`
  if (dryRun) return log(`dry-run write watchdog ${runner}`)
  writeFile(runner, content, 0o755)
  return runner
}

function plist(label, runner, workdir, logDir) {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(runner)}</string></array>
  <key>WorkingDirectory</key><string>${esc(workdir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logDir, `${label}.err.log`))}</string>
</dict></plist>
`
}

function installLinuxService(config, runner, dryRun) {
  const unit = `[Unit]
Description=Hermes Hub Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${config.user}
Group=${config.group}
WorkingDirectory=${config.workdir}
ExecStart=${process.execPath} ${runner}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${config.workdir}

[Install]
WantedBy=multi-user.target
`
  const tmp = join(os.tmpdir(), `${config.service}.service.${process.pid}`)
  if (!dryRun) writeFile(tmp, unit)
  sudo(['install', '-m', '0644', '-o', 'root', '-g', 'root', tmp, `/etc/systemd/system/${config.service}.service`], { dryRun })
  if (!dryRun) rmSync(tmp, { force: true })
  sudo(['systemctl', 'daemon-reload'], { dryRun })
  sudo(['systemctl', 'enable', config.service], { dryRun })
  if (!config.noStart) sudo(['systemctl', 'restart', config.service], { dryRun })
}

function installMacLaunchd(config, runner, dryRun) {
  const label = config.service
  const plistPath = join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  const logDir = join(os.homedir(), '.hermes', 'logs')
  if (dryRun) return log(`dry-run install launchd ${plistPath}`)
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(logDir, { recursive: true })
  writeFile(plistPath, plist(label, runner, config.workdir, logDir))
  run('plutil', ['-lint', plistPath], { capture: false })
  spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() || 501}`, plistPath], { encoding: 'utf8' })
  run('launchctl', ['bootstrap', `gui/${process.getuid?.() || 501}`, plistPath], { capture: true })
  if (!config.noStart) run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() || 501}/${label}`], { capture: true })
}

function installWindowsTask(config, runner, dryRun) {
  const cmd = join(config.workdir, 'scripts', 'run-server-router-watchdog.cmd')
  if (!dryRun) writeFile(cmd, `@echo off\r\ncd /d "${config.workdir}"\r\n"${process.execPath}" "${runner}"\r\n`, 0o755)
  const task = config.service
  run('schtasks.exe', ['/Create', '/TN', task, '/SC', 'ONLOGON', '/TR', cmd, '/F'], { dryRun, capture: false })
  if (!config.noStart) run('schtasks.exe', ['/Run', '/TN', task], { dryRun, capture: false })
}

function installAutostart(config, runner, dryRun) {
  if (config.platform === 'linux') return installLinuxService(config, runner, dryRun)
  if (config.platform === 'darwin') return installMacLaunchd(config, runner, dryRun)
  return installWindowsTask(config, runner, dryRun)
}

async function probe(url) {
  const response = await fetch(url)
  const text = await response.text()
  if (!response.ok) throw new Error(`probe failed ${response.status} ${url}: ${text.slice(0, 200)}`)
  return text
}

async function status(config) {
  if (config.platform === 'linux') {
    const active = spawnSync('systemctl', ['is-active', `${config.service}.service`], { encoding: 'utf8' })
    const enabled = spawnSync('systemctl', ['is-enabled', `${config.service}.service`], { encoding: 'utf8' })
    console.log(`service=${config.service} active=${active.stdout.trim() || active.status} enabled=${enabled.stdout.trim() || enabled.status}`)
  } else if (config.platform === 'darwin') {
    const result = spawnSync('launchctl', ['print', `gui/${process.getuid?.() || 501}/${config.service}`], { encoding: 'utf8' })
    console.log(`launchd=${config.service} installed=${result.status === 0}`)
  } else {
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', config.service], { encoding: 'utf8' })
    console.log(`scheduled_task=${config.service} installed=${result.status === 0}`)
  }
  try { console.log(`local_health=${await probe(`http://${config.host}:${config.port}/router/health`)}`) } catch (error) { console.log(`local_health_error=${error.message}`) }
  try { console.log(`public_health=${await probe(`${config.routerUrl}/router/health`)}`) } catch (error) { console.log(`public_health_error=${error.message}`) }
}

function uninstall(config, dryRun) {
  if (config.platform === 'linux') {
    sudo(['systemctl', 'disable', '--now', config.service], { dryRun })
    sudo(['rm', '-f', `/etc/systemd/system/${config.service}.service`], { dryRun })
    sudo(['systemctl', 'daemon-reload'], { dryRun })
    sudo(['systemctl', 'reset-failed', `${config.service}.service`], { dryRun })
  } else if (config.platform === 'darwin') {
    const plistPath = join(os.homedir(), 'Library', 'LaunchAgents', `${config.service}.plist`)
    run('launchctl', ['bootout', `gui/${process.getuid?.() || 501}`, plistPath], { dryRun, capture: true })
    if (!dryRun) rmSync(plistPath, { force: true })
  } else {
    run('schtasks.exe', ['/Delete', '/TN', config.service, '/F'], { dryRun, capture: false })
  }
  log(`autostart removed; runtime left at ${config.workdir}`)
}

function help() {
  console.log(`Hermes Hub Server Router installer ${VERSION}

Usage:
  node server-router-installer.mjs [options]

Options:
  --base-url <url>       Source folder URL. Default: ${DEFAULT_BASE_URL}
  --gateway-package-base-url <url>
                         Gateway package folder URL. Default: ${DEFAULT_GATEWAY_PACKAGE_BASE_URL}
  --router-url <url>     Public router URL. Default: ${DEFAULT_ROUTER_URL}
  --workdir <path>       Runtime dir. Default: /opt/hermes-hub on Linux, user-local on macOS/Windows
  --service <name>       Service label/name. Default: hermes-hub-router
  --router-env <path>    Env file. Default: /etc/hermes-hub-router.env on Linux, <workdir>/.env elsewhere
  --host <host>          Bind host. Default: 127.0.0.1
  --port <port>          Bind port. Default: 14320
  --platform <name>      linux | darwin | win32. Default: current platform
  --user <user>          Linux service user. Default: SUDO_USER/current user
  --group <group>        Linux service group. Default: same as user
  --dry-run              Print planned changes only
  --status               Show service and health status
  --uninstall            Remove autostart; leave runtime/env files
  --no-start             Install/update without starting service
  --rotate-agent-approval-token
                         Generate a new Router-to-installer approval token
`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (boolArg(args, 'help') || args._[0] === 'help') return help()
  const platform = platformArg(args)
  const workdir = textArg(args, 'workdir', defaultWorkdir(platform))
  const user = textArg(args, 'user', process.env.SUDO_USER || os.userInfo().username)
  const baseUrl = normalizeSourceBase(textArg(args, 'base-url', DEFAULT_BASE_URL), 'Router source URL')
  const gatewayPackageBaseUrl = normalizeSourceBase(
    textArg(
      args,
      'gateway-package-base-url',
      DEFAULT_GATEWAY_PACKAGE_BASE_URL,
    ),
    'Gateway package source URL',
  )
  const config = {
    platform,
    baseUrl,
    gatewayPackageBaseUrl,
    routerUrl: textArg(args, 'router-url', DEFAULT_ROUTER_URL).replace(/\/$/, ''),
    workdir,
    service: textArg(args, 'service', 'hermes-hub-router'),
    envFile: textArg(args, 'router-env', textArg(args, 'env-file', defaultEnvFile(platform, workdir))),
    host: textArg(args, 'host', '127.0.0.1'),
    port: Number(textArg(args, 'port', '14320')),
    user,
    group: textArg(args, 'group', user),
    noStart: boolArg(args, 'no-start'),
    rotateAgentApprovalToken: boolArg(args, 'rotate-agent-approval-token'),
  }
  const dryRun = boolArg(args, 'dry-run')
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) fail(`invalid --port ${config.port}`)
  if (boolArg(args, 'status')) return status(config)
  if (boolArg(args, 'uninstall')) return uninstall(config, dryRun)

  log(`installing from ${config.baseUrl}`)
  log(`target ${config.workdir}; service ${config.service}; platform ${config.platform}; router ${config.routerUrl}`)
  if (config.platform === 'linux') {
    sudo(['mkdir', '-p', config.workdir, join(config.workdir, 'state'), join(config.workdir, 'diagnostics'), join(config.workdir, 'dist')], { dryRun })
    sudo(['chown', '-R', `${config.user}:${config.group}`, config.workdir], { dryRun })
    sudo(['chmod', '700', join(config.workdir, 'state')], { dryRun })
  } else if (!dryRun) {
    mkdirSync(config.workdir, { recursive: true })
    mkdirSync(join(config.workdir, 'state'), { recursive: true, mode: 0o700 })
    if (config.platform !== 'win32') chmodSync(join(config.workdir, 'state'), 0o700)
    mkdirSync(join(config.workdir, 'diagnostics'), { recursive: true })
    mkdirSync(join(config.workdir, 'dist'), { recursive: true })
  }
  await downloadRuntime(config.baseUrl, config.workdir, dryRun)
  await downloadGatewayPackage(config.gatewayPackageBaseUrl, config.workdir, dryRun)
  installDependencies(config.workdir, dryRun)
  updateEnvFile(config.envFile, config, dryRun)
  const runner = writeWatchdog(config, dryRun) || join(config.workdir, 'scripts', 'run-server-router-watchdog.mjs')
  installAutostart(config, runner, dryRun)
  if (!dryRun && !config.noStart) await status(config)
  log('done')
}

main().catch(error => {
  console.error(`[server-router-installer] ERROR ${error.message}`)
  process.exit(1)
})
