#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clearRouterApprovalToken,
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

try {
  const generated = ensureRouterEnvFile(envFile, {
    platform: process.platform,
    tokenFactory: () => 'a'.repeat(64),
  })
  assert.equal(generated.created, true)
  assert.match(readFileSync(envFile, 'utf8'), /^HERMES_HUB_AGENT_APPROVAL_TOKEN=a{64}\n$/)

  const reused = ensureRouterEnvFile(envFile, {
    platform: process.platform,
    tokenFactory: () => 'b'.repeat(64),
  })
  assert.equal(reused.created, false)
  assert.equal(reused.rotated, false)
  assert.match(readFileSync(envFile, 'utf8'), /^HERMES_HUB_AGENT_APPROVAL_TOKEN=a{64}\n$/)

  const rotated = ensureRouterEnvFile(envFile, {
    platform: process.platform,
    rotate: true,
    tokenFactory: () => 'c'.repeat(64),
  })
  assert.equal(rotated.rotated, true)
  assert.match(readFileSync(envFile, 'utf8'), /^HERMES_HUB_AGENT_APPROVAL_TOKEN=c{64}\n$/)

  const loaded = loadRouterEnvFile(envFile, { PRESERVED: 'yes' })
  assert.equal(loaded.PRESERVED, 'yes')
  assert.equal(loaded.HERMES_HUB_AGENT_APPROVAL_TOKEN, 'c'.repeat(64))
  assert.equal(readFileSync(envFile, 'utf8').includes('b'.repeat(64)), false)

  writeFileSync(envFile, `UNCHANGED=value\nHERMES_HUB_AGENT_APPROVAL_TOKEN=${'d'.repeat(64)}\n`, 'utf8')
  ensureRouterEnvFile(envFile, { platform: process.platform })
  assert.match(readFileSync(envFile, 'utf8'), /^UNCHANGED=value\nHERMES_HUB_AGENT_APPROVAL_TOKEN=d{64}\n$/)

  const cleared = clearRouterApprovalToken(envFile, { platform: process.platform })
  assert.equal(cleared.cleared, true)
  assert.equal(readFileSync(envFile, 'utf8'), 'UNCHANGED=value\n')
  const regenerated = ensureRouterEnvFile(envFile, {
    platform: process.platform,
    tokenFactory: () => 'g'.repeat(64),
  })
  assert.equal(regenerated.created, true)
  assert.match(readFileSync(envFile, 'utf8'), /^UNCHANGED=value\nHERMES_HUB_AGENT_APPROVAL_TOKEN=g{64}\n$/)

  if (process.platform === 'win32') {
    const acl = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$acl = Get-Acl -LiteralPath $env:HERMES_HUB_ROUTER_ENV_SMOKE_PATH; $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString(); type = $_.AccessControlType.ToString() } } | ConvertTo-Json -Compress',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HERMES_HUB_ROUTER_ENV_SMOKE_PATH: envFile },
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
    () => ensureRouterEnvFile(duplicateEnvFile, { platform: process.platform }),
    /appears more than once/,
  )
  const duplicateClear = clearRouterApprovalToken(duplicateEnvFile, { platform: process.platform })
  assert.equal(duplicateClear.cleared, true)
  assert.equal(readFileSync(duplicateEnvFile, 'utf8'), '\n')

  const shortEnvFile = join(workdir, 'short.env')
  writeFileSync(shortEnvFile, 'HERMES_HUB_AGENT_APPROVAL_TOKEN=short\n', 'utf8')
  assert.throws(
    () => ensureRouterEnvFile(shortEnvFile, { platform: process.platform }),
    /at least 32 non-whitespace characters/,
  )

  const invalidTarget = join(workdir, 'not-a-file.env')
  mkdirSync(invalidTarget)
  assert.throws(
    () => ensureRouterEnvFile(invalidTarget, { platform: process.platform }),
    /regular local file/,
  )

  const cliEnvFile = join(workdir, 'cli.env')
  const initialized = spawnSync(process.execPath, [scriptPath, 'init', '--router-env', cliEnvFile], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(initialized.status, 0)
  const initialToken = loadRouterEnvFile(cliEnvFile, {}).HERMES_HUB_AGENT_APPROVAL_TOKEN
  assert.equal(initialized.stdout.includes(initialToken), false)
  assert.equal(initialized.stderr.includes(initialToken), false)
  const cliRotated = spawnSync(process.execPath, [scriptPath, 'rotate-approval-token', '--router-env', cliEnvFile], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(cliRotated.status, 0)
  const rotatedToken = loadRouterEnvFile(cliEnvFile, {}).HERMES_HUB_AGENT_APPROVAL_TOKEN
  assert.notEqual(rotatedToken, initialToken)
  assert.equal(cliRotated.stdout.includes(rotatedToken), false)
  assert.equal(cliRotated.stderr.includes(rotatedToken), false)
  const cliCleared = spawnSync(process.execPath, [scriptPath, 'clear-approval-token', '--router-env', cliEnvFile], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(cliCleared.status, 0)
  const clearedCliEnvironment = loadRouterEnvFile(cliEnvFile, {})
  assert.equal('HERMES_HUB_AGENT_APPROVAL_TOKEN' in clearedCliEnvironment, false)
  assert.equal(cliCleared.stdout.includes(rotatedToken), false)
  assert.equal(cliCleared.stderr.includes(rotatedToken), false)
  const cliRegenerated = spawnSync(process.execPath, [scriptPath, 'init', '--router-env', cliEnvFile], {
    cwd: workdir,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(cliRegenerated.status, 0)
  const regeneratedCliToken = loadRouterEnvFile(cliEnvFile, {}).HERMES_HUB_AGENT_APPROVAL_TOKEN
  assert.notEqual(regeneratedCliToken, rotatedToken)
  assert.equal(cliRegenerated.stdout.includes(regeneratedCliToken), false)
  assert.equal(cliRegenerated.stderr.includes(regeneratedCliToken), false)

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
      'startup preflight distinguishes legacy and Gateway-only Router listeners',
      'startup preflight accepts an available configured port',
      ...(process.platform === 'win32' ? ['the environment file has a non-inherited private Windows ACL'] : []),
    ],
  }, null, 2) + '\n')
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
