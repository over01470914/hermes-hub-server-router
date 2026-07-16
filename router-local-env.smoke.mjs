#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clearRouterApprovalToken,
  defaultPairingConfigPath,
  defaultRouterProcessStatePath,
  ensureRouterEnvFile,
  loadRouterEnvFile,
  preflightRouterStart,
} from './router-local-env.mjs'

const workdir = mkdtempSync(join(tmpdir(), 'hermes-hub-router-env-'))
const envFile = join(workdir, '.env')
const scriptPath = fileURLToPath(new URL('./router-local-env.mjs', import.meta.url))

async function listenHealth(payload) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port }
}

async function closeServer(server) {
  await new Promise((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise())
  })
}

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await check()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

try {
  const defaultHermesHome = join(workdir, 'default-hermes-home')
  const defaultConfigPath = join(defaultHermesHome, 'hermes-hub', 'pairing.json')
  assert.equal(
    defaultPairingConfigPath({ environment: { HERMES_HOME: defaultHermesHome } }),
    defaultConfigPath,
  )
  const defaultBackedEnvFile = join(workdir, 'default-backed.env')
  ensureRouterEnvFile(defaultBackedEnvFile, {
    environment: { HERMES_HOME: defaultHermesHome },
    platform: process.platform,
    tokenFactory: () => 'd'.repeat(64),
  })
  assert.equal(JSON.parse(readFileSync(defaultConfigPath, 'utf8')).approvalToken, 'd'.repeat(64))
  assert.equal(
    loadRouterEnvFile(defaultBackedEnvFile, {}, {
      environment: { HERMES_HOME: defaultHermesHome },
    }).HERMES_HUB_AGENT_APPROVAL_TOKEN,
    'd'.repeat(64),
  )

  const configBackedEnvFile = join(workdir, 'config-backed.env')
  const pairingConfigPath = join(workdir, 'hermes-home', 'hermes-hub', 'pairing.json')
  const configBacked = ensureRouterEnvFile(configBackedEnvFile, {
    platform: process.platform,
    pairingConfigPath,
    tokenFactory: () => 'p'.repeat(64),
  })
  assert.equal(configBacked.created, true)
  assert.equal(readFileSync(configBackedEnvFile, 'utf8').includes('HERMES_HUB_AGENT_APPROVAL_TOKEN'), false)
  assert.deepEqual(JSON.parse(readFileSync(pairingConfigPath, 'utf8')), {
    schemaVersion: 1,
    approvalToken: 'p'.repeat(64),
  })
  assert.equal(
    loadRouterEnvFile(configBackedEnvFile, {}, { pairingConfigPath }).HERMES_HUB_AGENT_APPROVAL_TOKEN,
    'p'.repeat(64),
  )

  const routerPairingConfigPath = join(workdir, 'router-hermes-home', 'hermes-hub', 'pairing.json')
  const routerOptions = { platform: process.platform, pairingConfigPath: routerPairingConfigPath }
  const generated = ensureRouterEnvFile(envFile, {
    ...routerOptions,
    tokenFactory: () => 'a'.repeat(64),
  })
  assert.equal(generated.created, true)
  assert.equal(readFileSync(envFile, 'utf8').includes('HERMES_HUB_AGENT_APPROVAL_TOKEN'), false)
  assert.equal(JSON.parse(readFileSync(routerPairingConfigPath, 'utf8')).approvalToken, 'a'.repeat(64))

  const reused = ensureRouterEnvFile(envFile, {
    ...routerOptions,
    tokenFactory: () => 'b'.repeat(64),
  })
  assert.equal(reused.created, false)
  assert.equal(reused.rotated, false)
  assert.equal(JSON.parse(readFileSync(routerPairingConfigPath, 'utf8')).approvalToken, 'a'.repeat(64))

  const rotated = ensureRouterEnvFile(envFile, {
    ...routerOptions,
    rotate: true,
    tokenFactory: () => 'c'.repeat(64),
  })
  assert.equal(rotated.rotated, true)
  assert.equal(JSON.parse(readFileSync(routerPairingConfigPath, 'utf8')).approvalToken, 'c'.repeat(64))

  const loaded = loadRouterEnvFile(envFile, { PRESERVED: 'yes' }, routerOptions)
  assert.equal(loaded.PRESERVED, 'yes')
  assert.equal(loaded.HERMES_HUB_AGENT_APPROVAL_TOKEN, 'c'.repeat(64))
  assert.equal(readFileSync(envFile, 'utf8').includes('b'.repeat(64)), false)

  const legacyPairingConfigPath = join(workdir, 'legacy-hermes-home', 'hermes-hub', 'pairing.json')
  writeFileSync(envFile, `UNCHANGED=value\nHERMES_HUB_AGENT_APPROVAL_TOKEN=${'d'.repeat(64)}\n`, 'utf8')
  ensureRouterEnvFile(envFile, { platform: process.platform, pairingConfigPath: legacyPairingConfigPath })
  assert.equal(readFileSync(envFile, 'utf8'), 'UNCHANGED=value\n')
  assert.equal(JSON.parse(readFileSync(legacyPairingConfigPath, 'utf8')).approvalToken, 'd'.repeat(64))

  const cleared = clearRouterApprovalToken(envFile, { platform: process.platform, pairingConfigPath: legacyPairingConfigPath })
  assert.equal(cleared.cleared, true)
  assert.equal(readFileSync(envFile, 'utf8'), 'UNCHANGED=value\n')
  const regenerated = ensureRouterEnvFile(envFile, {
    platform: process.platform,
    pairingConfigPath: legacyPairingConfigPath,
    tokenFactory: () => 'g'.repeat(64),
  })
  assert.equal(regenerated.created, true)
  assert.equal(readFileSync(envFile, 'utf8'), 'UNCHANGED=value\n')
  assert.equal(JSON.parse(readFileSync(legacyPairingConfigPath, 'utf8')).approvalToken, 'g'.repeat(64))

  if (process.platform === 'win32') {
    const acl = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$acl = Get-Acl -LiteralPath $env:HERMES_HUB_ROUTER_ENV_SMOKE_PATH; $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString(); type = $_.AccessControlType.ToString() } } | ConvertTo-Json -Compress',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HERMES_HUB_ROUTER_ENV_SMOKE_PATH: legacyPairingConfigPath },
      windowsHide: true,
    })
    assert.equal(acl.status, 0)
    const parsed = JSON.parse(acl.stdout)
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    assert.equal(entries.some(entry => entry.inherited), false)
    assert.equal(entries.some(entry => entry.type === 'Allow' && /FullControl/i.test(entry.rights)), true)
  }

  const duplicateEnvFile = join(workdir, 'duplicate.env')
  writeFileSync(
    duplicateEnvFile,
    `HERMES_HUB_AGENT_APPROVAL_TOKEN=${'e'.repeat(64)}\nHERMES_HUB_AGENT_APPROVAL_TOKEN=${'f'.repeat(64)}\n`,
    'utf8',
  )
  assert.throws(
    () => ensureRouterEnvFile(duplicateEnvFile, {
      platform: process.platform,
      pairingConfigPath: join(workdir, 'duplicate-hermes-home', 'hermes-hub', 'pairing.json'),
    }),
    /appears more than once/,
  )
  const duplicateClear = clearRouterApprovalToken(duplicateEnvFile, {
    platform: process.platform,
    pairingConfigPath: join(workdir, 'duplicate-hermes-home', 'hermes-hub', 'pairing.json'),
  })
  assert.equal(duplicateClear.cleared, true)
  assert.equal(readFileSync(duplicateEnvFile, 'utf8'), '\n')

  const shortEnvFile = join(workdir, 'short.env')
  writeFileSync(shortEnvFile, 'HERMES_HUB_AGENT_APPROVAL_TOKEN=short\n', 'utf8')
  assert.throws(
    () => ensureRouterEnvFile(shortEnvFile, {
      platform: process.platform,
      pairingConfigPath: join(workdir, 'short-hermes-home', 'hermes-hub', 'pairing.json'),
    }),
    /at least 32 non-whitespace characters/,
  )

  const invalidTarget = join(workdir, 'not-a-file.env')
  mkdirSync(invalidTarget)
  assert.throws(
    () => ensureRouterEnvFile(invalidTarget, {
      platform: process.platform,
      pairingConfigPath: join(workdir, 'invalid-target-hermes-home', 'hermes-hub', 'pairing.json'),
    }),
    /regular local file/,
  )

  const cliEnvFile = join(workdir, 'cli.env')
  const cliPairingConfigPath = join(workdir, 'cli-hermes-home', 'hermes-hub', 'pairing.json')
  const initialized = spawnSync(process.execPath, [
    scriptPath,
    'init',
    '--router-env', cliEnvFile,
    '--pairing-config', cliPairingConfigPath,
  ], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(initialized.status, 0)
  const initialToken = loadRouterEnvFile(cliEnvFile, {}, { pairingConfigPath: cliPairingConfigPath }).HERMES_HUB_AGENT_APPROVAL_TOKEN
  assert.equal(initialized.stdout.includes(initialToken), false)
  assert.equal(initialized.stderr.includes(initialToken), false)
  const cliRotated = spawnSync(process.execPath, [
    scriptPath,
    'rotate-approval-token',
    '--router-env', cliEnvFile,
    '--pairing-config', cliPairingConfigPath,
  ], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(cliRotated.status, 0)
  const rotatedToken = loadRouterEnvFile(cliEnvFile, {}, { pairingConfigPath: cliPairingConfigPath }).HERMES_HUB_AGENT_APPROVAL_TOKEN
  assert.notEqual(rotatedToken, initialToken)
  assert.equal(cliRotated.stdout.includes(rotatedToken), false)
  assert.equal(cliRotated.stderr.includes(rotatedToken), false)
  const cliCleared = spawnSync(process.execPath, [
    scriptPath,
    'clear-approval-token',
    '--router-env', cliEnvFile,
    '--pairing-config', cliPairingConfigPath,
  ], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(cliCleared.status, 0)
  const clearedCliEnvironment = loadRouterEnvFile(cliEnvFile, {}, { pairingConfigPath: cliPairingConfigPath })
  assert.equal('HERMES_HUB_AGENT_APPROVAL_TOKEN' in clearedCliEnvironment, false)
  assert.equal(cliCleared.stdout.includes(rotatedToken), false)
  assert.equal(cliCleared.stderr.includes(rotatedToken), false)
  const cliRegenerated = spawnSync(process.execPath, [
    scriptPath,
    'init',
    '--router-env', cliEnvFile,
    '--pairing-config', cliPairingConfigPath,
  ], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(cliRegenerated.status, 0)
  const regeneratedCliToken = loadRouterEnvFile(cliEnvFile, {}, { pairingConfigPath: cliPairingConfigPath }).HERMES_HUB_AGENT_APPROVAL_TOKEN
  assert.notEqual(regeneratedCliToken, rotatedToken)
  assert.equal(cliRegenerated.stdout.includes(regeneratedCliToken), false)
  assert.equal(cliRegenerated.stderr.includes(regeneratedCliToken), false)

  const installerReceipt = join(workdir, 'gateway-installer-receipt.json')
  const verifiedInstaller = join(workdir, 'verified-gateway-installer.mjs')
  writeFileSync(verifiedInstaller, [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(process.env.HERMES_HUB_ROUTER_LAUNCH_SMOKE_RECEIPT, JSON.stringify({ args: process.argv.slice(2), approvalTokenLength: (process.env.HERMES_HUB_AGENT_APPROVAL_TOKEN || '').length }))",
  ].join('\n'))
  const launchedInstaller = spawnSync(process.execPath, [
    scriptPath,
    'pair-gateway',
    '--router-env', cliEnvFile,
    '--pairing-config', cliPairingConfigPath,
    '--installer', verifiedInstaller,
    '--router', 'http://127.0.0.1:4320',
    '--source-base', 'http://127.0.0.1:4320/apps/hermes-hub-gateway-plugin/',
    '--request-id', 'pair_gateway_launcher_smoke',
  ], {
    cwd: workdir,
    encoding: 'utf8',
    env: { ...process.env, HERMES_HUB_ROUTER_LAUNCH_SMOKE_RECEIPT: installerReceipt },
    windowsHide: true,
  })
  assert.equal(launchedInstaller.status, 0)
  const installerLaunch = JSON.parse(readFileSync(installerReceipt, 'utf8'))
  assert.equal(installerLaunch.approvalTokenLength, regeneratedCliToken.length)
  assert.deepEqual(installerLaunch.args, [
    '--router', 'http://127.0.0.1:4320',
    '--request-id', 'pair_gateway_launcher_smoke',
    '--source-base', 'http://127.0.0.1:4320/apps/hermes-hub-gateway-plugin/',
  ])
  assert.equal(launchedInstaller.stdout.includes(regeneratedCliToken), false)
  assert.equal(launchedInstaller.stderr.includes(regeneratedCliToken), false)
  const remoteLauncher = spawnSync(process.execPath, [
    scriptPath,
    'pair-gateway',
    '--router-env', cliEnvFile,
    '--pairing-config', cliPairingConfigPath,
    '--installer', verifiedInstaller,
    '--router', 'https://router.example.test',
    '--request-id', 'pair_gateway_launcher_smoke',
  ], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.notEqual(remoteLauncher.status, 0)
  assert.match(remoteLauncher.stderr, /only sends Router approval to an HTTP\(S\) loopback Router URL/)
  assert.equal(remoteLauncher.stdout.includes(regeneratedCliToken), false)
  assert.equal(remoteLauncher.stderr.includes(regeneratedCliToken), false)
  const wrongMirror = spawnSync(process.execPath, [
    scriptPath,
    'pair-gateway',
    '--router-env', cliEnvFile,
    '--pairing-config', cliPairingConfigPath,
    '--installer', verifiedInstaller,
    '--router', 'http://127.0.0.1:4320',
    '--source-base', 'http://127.0.0.1:4320/untrusted-package/',
    '--request-id', 'pair_gateway_launcher_smoke',
  ], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.notEqual(wrongMirror.status, 0)
  assert.match(wrongMirror.stderr, /only accepts the exact package mirror advertised by its loopback Router/)
  assert.equal(wrongMirror.stdout.includes(regeneratedCliToken), false)
  assert.equal(wrongMirror.stderr.includes(regeneratedCliToken), false)

  const legacy = await listenHealth({
    ok: true,
    service: 'hermes-hub-router',
    pairing: 'prompt-code-claim/v1',
  })
  try {
    await assert.rejects(
      preflightRouterStart({
        HERMES_HUB_ROUTER_HOST: '127.0.0.1',
        HERMES_HUB_ROUTER_PORT: String(legacy.port),
        HERMES_HUB_ROUTER_URL: `http://127.0.0.1:${legacy.port}`,
      }),
      /legacy Router is already running.*has not loaded newly initialized or rotated environment values/,
    )
  } finally {
    await closeServer(legacy.server)
  }

  const current = await listenHealth({
    ok: true,
    service: 'hermes-hub-router',
    topology: 'client-router-hermes-hub-gateway-agent',
    pairing: 'prompt-code-claim/v2',
  })
  try {
    await assert.rejects(
      preflightRouterStart({
        HERMES_HUB_ROUTER_HOST: '127.0.0.1',
        HERMES_HUB_ROUTER_PORT: String(current.port),
        HERMES_HUB_ROUTER_URL: `http://127.0.0.1:${current.port}`,
      }),
      /Gateway-only Router is already running.*has not loaded newly initialized or rotated environment values/,
    )
  } finally {
    await closeServer(current.server)
  }

  const freePort = await listenHealth({ ok: true })
  const availablePort = freePort.port
  await closeServer(freePort.server)
  await preflightRouterStart({
    HERMES_HUB_ROUTER_HOST: '127.0.0.1',
    HERMES_HUB_ROUTER_PORT: String(availablePort),
    HERMES_HUB_ROUTER_URL: `http://127.0.0.1:${availablePort}`,
  }, { timeoutMs: 50 })

  const routerPortReservation = await listenHealth({ ok: true })
  const managedRouterPort = routerPortReservation.port
  await closeServer(routerPortReservation.server)
  const managedRouterEnvFile = join(workdir, 'managed-router.env')
  const managedRouterPairingConfigPath = join(workdir, 'managed-router-hermes-home', 'hermes-hub', 'pairing.json')
  writeFileSync(managedRouterEnvFile, [
    'HERMES_HUB_ROUTER_HOST=127.0.0.1',
    `HERMES_HUB_ROUTER_PORT=${managedRouterPort}`,
    `HERMES_HUB_ROUTER_URL=http://127.0.0.1:${managedRouterPort}`,
    '',
  ].join('\n'))
  ensureRouterEnvFile(managedRouterEnvFile, {
    platform: process.platform,
    pairingConfigPath: managedRouterPairingConfigPath,
  })
  const managedRouter = spawn(process.execPath, [
    scriptPath,
    'run',
    '--router-env', managedRouterEnvFile,
    '--pairing-config', managedRouterPairingConfigPath,
  ], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
  })
  const managedRouterStatePath = defaultRouterProcessStatePath(managedRouterEnvFile)
  try {
    await waitFor(() => existsSync(managedRouterStatePath), 'managed Router process state')
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${managedRouterPort}/router/health`)).ok
      } catch {
        return false
      }
    }, 'managed Router health')
    const stopped = spawnSync(process.execPath, [
      scriptPath,
      'stop',
      '--router-env', managedRouterEnvFile,
    ], {
      cwd: workdir,
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, /Stopped tracked Router process \d+\./)
    await waitFor(() => !existsSync(managedRouterStatePath), 'managed Router state cleanup')
  } finally {
    if (managedRouter.exitCode == null) {
      managedRouter.kill('SIGTERM')
      await once(managedRouter, 'exit')
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    checks: [
      'first initialization generates a private approval token',
      'normal initialization reuses the existing token',
      'explicit rotation replaces the token without printing it',
      'explicit local clearing removes every approval token entry without printing it',
      'the next initialization creates one new random approval token after clearing',
      'the Router process environment loads the persisted value',
      'unrelated environment entries survive initialization',
      'duplicate approval token entries fail closed',
      'invalid existing approval tokens fail closed instead of rotating silently',
      'non-file environment targets fail closed before reading',
      'CLI initialization, rotation, and clearing never print token values',
      'the local Gateway launcher injects the token only into a verified installer child and rejects remote Router URLs or untrusted package mirrors',
       'startup preflight distinguishes legacy and Gateway-only Router listeners',
       'startup preflight accepts an available configured port',
       'the stop command terminates only the tracked background Router process and removes its private state',
      ...(process.platform === 'win32' ? ['the environment file has a non-inherited private Windows ACL'] : []),
    ],
  }, null, 2) + '\n')
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
