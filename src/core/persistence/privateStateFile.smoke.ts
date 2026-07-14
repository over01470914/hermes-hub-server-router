import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readPrivateTextFileSync, writePrivateTextFileAtomicSync } from './privateStateFile.js'

interface AclEntry {
  sid: string
  type: string
  rights: string
  inherited: boolean
}

function windowsRoot(): string {
  return process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
}

function run(executable: string, args: string[], extraEnvironment: Record<string, string> = {}): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: {
      SystemRoot: windowsRoot(),
      WINDIR: windowsRoot(),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      ...extraEnvironment,
    },
    windowsHide: true,
  })
  assert.equal(result.status, 0, `ACL inspection command failed: ${result.status ?? 'spawn'}`)
  return result.stdout || ''
}

function currentSid(): string {
  const output = run(join(windowsRoot(), 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'])
  const match = output.match(/S-\d+(?:-\d+)+/i)
  assert.ok(match, 'current Windows SID must be available')
  return match[0].toUpperCase()
}

function aclEntries(path: string): AclEntry[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$acl = Get-Acl -LiteralPath $env:HERMES_HUB_ACL_SMOKE_TARGET',
    '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
    '$rules | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited } } | ConvertTo-Json -Compress',
  ].join('; ')
  const output = run(
    join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { HERMES_HUB_ACL_SMOKE_TARGET: path },
  ).trim()
  const parsed = JSON.parse(output) as AclEntry | AclEntry[]
  return (Array.isArray(parsed) ? parsed : [parsed]).map(entry => ({
    ...entry,
    sid: entry.sid.toUpperCase(),
  }))
}

function assertWindowsPrivate(path: string): void {
  const required = new Set([currentSid(), 'S-1-5-18', 'S-1-5-32-544'])
  const entries = aclEntries(path)
  const grants = entries.filter(entry => entry.type === 'Allow')
  assert.ok(grants.length > 0)
  assert.equal(grants.some(entry => entry.inherited), false, 'private ACL must not inherit grants')
  assert.equal(grants.some(entry => !required.has(entry.sid)), false, 'private ACL must not grant another SID')
  for (const sid of required) {
    assert.ok(
      grants.some(entry => entry.sid === sid && /FullControl/i.test(entry.rights)),
      `required SID ${sid} must have FullControl`,
    )
  }
}

const root = mkdtempSync(join(tmpdir(), 'hermes-hub-private-state-'))
const stateDirectory = join(root, 'state')
const statePath = join(stateDirectory, 'pairing-store.json')

try {
  writePrivateTextFileAtomicSync(statePath, '{"version":1}\n')
  assert.equal(readPrivateTextFileSync(statePath), '{"version":1}\n')

  writePrivateTextFileAtomicSync(statePath, '{"version":2}\n')
  assert.equal(readPrivateTextFileSync(statePath), '{"version":2}\n')
  assert.throws(
    () => readPrivateTextFileSync(stateDirectory),
    /must be a regular local file/,
    'private state reads must reject non-file targets',
  )
  assert.equal(
    readdirSync(stateDirectory).some(name => name.endsWith('.tmp')),
    false,
    'atomic writes must not leave temporary state files behind',
  )

  if (process.platform === 'win32') {
    assertWindowsPrivate(stateDirectory)
    assertWindowsPrivate(statePath)

    // Re-enable inheritance to simulate a legacy permissive destination. An
    // atomic replacement must not inherit it, and a later load must repair it
    // before content is read.
    run(join(windowsRoot(), 'System32', 'icacls.exe'), [statePath, '/inheritance:e'])
    assert.equal(aclEntries(statePath).some(entry => entry.inherited), true)
    writePrivateTextFileAtomicSync(statePath, '{"version":3}\n')
    assertWindowsPrivate(statePath)

    run(join(windowsRoot(), 'System32', 'icacls.exe'), [statePath, '/inheritance:e'])
    assert.equal(aclEntries(statePath).some(entry => entry.inherited), true)
    assert.equal(readPrivateTextFileSync(statePath), '{"version":3}\n')
    assertWindowsPrivate(statePath)
  } else {
    assert.equal(statSync(stateDirectory).mode & 0o777, 0o700)
    assert.equal(statSync(statePath).mode & 0o777, 0o600)
  }

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'private state is replaced atomically without temporary residue',
      'sensitive content is readable only after file hardening',
      process.platform === 'win32'
        ? 'Windows DACL allows only current SID, SYSTEM, and Administrators'
        : 'POSIX directory and file modes are 0700 and 0600',
      'legacy file permissions are repaired on load',
    ],
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
