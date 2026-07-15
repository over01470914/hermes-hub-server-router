import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Failed to reserve pairing security smoke port')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return address.port
}

interface RouterProcess {
  child: ChildProcessWithoutNullStreams
  output: () => string
}

function startRouter(repositoryRoot: string, routerPackageRoot: string, environment: NodeJS.ProcessEnv): RouterProcess {
  const tsxCli = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const routerEntry = join(routerPackageRoot, 'src', 'bridgeServer.ts')
  const child = spawn(process.execPath, [tsxCli, routerEntry], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return { child, output: () => `${stdout}\n${stderr}`.trim() }
}

async function waitForRouter(baseUrl: string, router: RouterProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (router.child.exitCode != null) {
      throw new Error(`Router exited before pairing security smoke (${router.child.exitCode})\n${router.output()}`)
    }
    try {
      if ((await fetch(`${baseUrl}/router/health`)).ok) return
    } catch {
      // Router is still starting.
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for pairing security smoke Router\n${router.output()}`)
}

async function stopRouter(router: RouterProcess): Promise<void> {
  if (router.child.exitCode != null || router.child.signalCode != null) return
  const exited = once(router.child, 'exit')
  router.child.kill()
  await Promise.race([exited, delay(2_000)])
  if (router.child.exitCode == null && router.child.signalCode == null) router.child.kill('SIGKILL')
}

function windowsRoot(): string {
  const root = process.env.SystemRoot || process.env.WINDIR
  assert.ok(root, 'Windows system root must be available')
  return root
}

function windowsAcl(path: string): Array<{ sid: string; type: string; rights: string; inherited: boolean }> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$acl = Get-Acl -LiteralPath $env:HERMES_HUB_ACL_SMOKE_TARGET',
    '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
    '$rules | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited } } | ConvertTo-Json -Compress',
  ].join('; ')
  const result = spawnSync(
    join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: {
        SystemRoot: windowsRoot(),
        WINDIR: windowsRoot(),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
        HERMES_HUB_ACL_SMOKE_TARGET: path,
      },
      windowsHide: true,
    },
  )
  assert.equal(result.status, 0, 'Windows pairing-store ACL inspection must succeed')
  const parsed = JSON.parse(result.stdout) as { sid: string; type: string; rights: string; inherited: boolean } | Array<{ sid: string; type: string; rights: string; inherited: boolean }>
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function assertPrivateStore(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    return
  }
  const whoami = spawnSync(join(windowsRoot(), 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    env: { SystemRoot: windowsRoot(), WINDIR: windowsRoot() },
    windowsHide: true,
  })
  assert.equal(whoami.status, 0)
  const currentSid = whoami.stdout.match(/S-\d+(?:-\d+)+/i)?.[0].toUpperCase()
  assert.ok(currentSid)
  const allowed = new Set([currentSid, 'S-1-5-18', 'S-1-5-32-544'])
  const entries = windowsAcl(path)
  const grants = entries.filter(entry => entry.type === 'Allow')
  assert.equal(grants.some(entry => entry.inherited || !allowed.has(entry.sid.toUpperCase())), false)
  for (const sid of allowed) {
    assert.ok(grants.some(entry => entry.sid.toUpperCase() === sid && /FullControl/i.test(entry.rights)))
  }
}

const routerPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const repositoryRoot = join(routerPackageRoot, '../..')
const port = await reserveLoopbackPort()
const workdir = await mkdtemp(join(tmpdir(), 'hermes-hub-pairing-security-'))
const pairingStorePath = join(workdir, 'state', 'pairing-store.json')
const localApprovalConfigPath = join(workdir, 'hermes-home', 'hermes-hub', 'pairing.json')
const baseUrl = `http://127.0.0.1:${port}`
const router = startRouter(repositoryRoot, routerPackageRoot, {
  ...process.env,
  NODE_ENV: 'development',
  HERMES_HUB_ROUTER_HOST: '127.0.0.1',
  HERMES_HUB_ROUTER_PORT: String(port),
  HERMES_HUB_ROUTER_URL: baseUrl,
  HERMES_HUB_BRIDGE_SECRET: 'pairing-security-smoke-bridge-secret',
  HERMES_HUB_PAIRING_CODE: '00000000',
  HERMES_HUB_AGENT_APPROVAL_TOKEN: 'pairing-security-smoke-approval-' + 'x'.repeat(32),
  HERMES_HUB_LOCAL_PAIRING_CONFIG_PATH: localApprovalConfigPath,
  HERMES_HUB_PAIRING_STORE_PATH: pairingStorePath,
  HERMES_HUB_SESSION_METADATA_STORE_PATH: join(workdir, 'session-metadata.json'),
  HERMES_HUB_DIAGNOSTICS_DIR: join(workdir, 'diagnostics'),
  HERMES_HUB_LOG_LEVEL: 'error',
})

try {
  await waitForRouter(baseUrl, router)

  const browserOriginBootstrap = await fetch(`${baseUrl}/router/pairing/local-approval-bootstrap`, {
    method: 'POST',
    headers: {
      origin: 'https://untrusted.example.test',
      'x-hermes-hub-local-bootstrap': '1',
    },
  })
  assert.equal(browserOriginBootstrap.status, 403, 'browser-originated requests must not bootstrap local approval')

  const bootstrap = await fetch(`${baseUrl}/router/pairing/local-approval-bootstrap`, {
    method: 'POST',
    headers: { 'x-hermes-hub-local-bootstrap': '1' },
  })
  assert.equal(bootstrap.status, 204)
  assert.equal(await bootstrap.text(), '', 'approval bootstrap must not return a token')
  const localApproval = JSON.parse(await readFile(localApprovalConfigPath, 'utf8')) as {
    schemaVersion?: number
    approvalToken?: string
  }
  assert.equal(localApproval.schemaVersion, 1)
  assert.equal(localApproval.approvalToken, 'pairing-security-smoke-approval-' + 'x'.repeat(32))
  await assertPrivateStore(localApprovalConfigPath)

  const missingRequestId = await fetch(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '00000000' }),
  })
  assert.equal(missingRequestId.status, 400)
  assert.equal((await missingRequestId.json() as { code?: string }).code, 'pairing_request_id_required')

  for (let attempt = 1; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/router/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: `pair_missing_${attempt}`, code: '00000000' }),
    })
    assert.notEqual(response.status, 429)
  }
  const limitedClaim = await fetch(`${baseUrl}/router/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'pair_missing_limited', code: '00000000' }),
  })
  assert.equal(limitedClaim.status, 429)
  assert.ok(Number(limitedClaim.headers.get('retry-after')) > 0)

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${baseUrl}/router/pairing/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${attempt + 1}`,
      },
      body: JSON.stringify({ deviceId: `device_rate_${attempt}` }),
    })
    assert.equal(response.status, 200)
  }
  const limitedRequest = await fetch(`${baseUrl}/router/pairing/request`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.99',
    },
    body: JSON.stringify({ deviceId: 'device_rate_limited' }),
  })
  assert.equal(limitedRequest.status, 429, 'changing X-Forwarded-For must not evade direct-peer limiting')
  assert.ok(Number(limitedRequest.headers.get('retry-after')) > 0)

  await assertPrivateStore(pairingStorePath)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'pairing claim requires requestId and performs no code-only record scan',
      'claim and request limits return 429 with Retry-After',
      'X-Forwarded-For cannot evade direct TCP peer limits',
      process.platform === 'win32'
        ? 'Router pairing store has a verified private Windows DACL'
        : 'Router pairing store uses verified 0700/0600 POSIX modes',
    ],
  }, null, 2))
} finally {
  await stopRouter(router)
  await rm(workdir, { recursive: true, force: true })
}
