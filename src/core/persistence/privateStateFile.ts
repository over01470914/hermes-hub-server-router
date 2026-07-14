import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

type PrivatePathKind = 'file' | 'directory'

interface WindowsAclEntry {
  sid: string
  type: 'Allow' | 'Deny' | string
  rights: string
  inherited: boolean
}

const windowsSystemSid = 'S-1-5-18'
const windowsAdministratorsSid = 'S-1-5-32-544'
let cachedWindowsUserSid: string | undefined

function windowsRoot(): string {
  return process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
}

function windowsChildEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: windowsRoot(),
    WINDIR: windowsRoot(),
    ...extra,
  }
  for (const key of ['TEMP', 'TMP']) {
    const value = process.env[key]
    if (value) environment[key] = value
  }
  return environment
}

function runWindowsTool(executable: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: environment || windowsChildEnvironment(),
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0 || result.error) {
    throw new Error(`Private state ACL operation failed (${result.status ?? 'spawn'})`)
  }
  return result.stdout || ''
}

function currentWindowsUserSid(): string {
  if (cachedWindowsUserSid) return cachedWindowsUserSid
  const output = runWindowsTool(
    join(windowsRoot(), 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
  )
  const match = output.match(/S-\d+(?:-\d+)+/i)
  if (!match) throw new Error('Unable to resolve the current Windows user SID for private state')
  cachedWindowsUserSid = match[0].toUpperCase()
  return cachedWindowsUserSid
}

function inspectWindowsAcl(path: string): WindowsAclEntry[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$target = $env:HERMES_HUB_PRIVATE_ACL_TARGET',
    '$acl = Get-Acl -LiteralPath $target',
    '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
    '$rules | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited } } | ConvertTo-Json -Compress',
  ].join('; ')
  const output = runWindowsTool(
    join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    windowsChildEnvironment({ HERMES_HUB_PRIVATE_ACL_TARGET: path }),
  ).trim()
  if (!output) return []
  const parsed = JSON.parse(output) as WindowsAclEntry | WindowsAclEntry[]
  return (Array.isArray(parsed) ? parsed : [parsed]).map(entry => ({
    sid: String(entry.sid).toUpperCase(),
    type: String(entry.type),
    rights: String(entry.rights),
    inherited: Boolean(entry.inherited),
  }))
}

function runIcacls(path: string, args: string[]): void {
  runWindowsTool(join(windowsRoot(), 'System32', 'icacls.exe'), [path, ...args])
}

function windowsGrant(sid: string, kind: PrivatePathKind): string {
  return `*${sid}:${kind === 'directory' ? '(OI)(CI)F' : 'F'}`
}

function assertWindowsAclEntriesArePrivate(entries: WindowsAclEntry[], kind: PrivatePathKind): void {
  const currentSid = currentWindowsUserSid()
  const allowed = new Set([currentSid, windowsSystemSid, windowsAdministratorsSid])
  const grants = entries.filter(entry => entry.type === 'Allow')
  if (
    grants.length === 0 ||
    grants.some(entry => entry.inherited || !allowed.has(entry.sid)) ||
    entries.some(entry => entry.type === 'Deny' && allowed.has(entry.sid))
  ) {
    throw new Error('Private state ACL contains an unauthorized or inherited access rule')
  }
  for (const sid of allowed) {
    const fullControl = grants.some(entry => entry.sid === sid && /FullControl/i.test(entry.rights))
    if (!fullControl) throw new Error(`Private state ACL is missing required FullControl for ${kind}`)
  }
}

function secureWindowsPath(path: string, kind: PrivatePathKind, verifyExisting = true): void {
  const currentSid = currentWindowsUserSid()
  const allowed = new Set([currentSid, windowsSystemSid, windowsAdministratorsSid])
  const grants = [...allowed].map(sid => windowsGrant(sid, kind))

  // Remove inherited entries first and establish the three identities that are
  // allowed to read Router private state. Numeric SIDs avoid localized account
  // names and make the policy stable across Windows installations.
  runIcacls(path, ['/inheritance:r', '/grant:r', ...grants])
  if (!verifyExisting) return

  const entries = inspectWindowsAcl(path)
  const unauthorizedGrants = [...new Set(
    entries
      .filter(entry => entry.type === 'Allow' && !allowed.has(entry.sid))
      .map(entry => `*${entry.sid}`),
  )]
  if (unauthorizedGrants.length > 0) runIcacls(path, ['/remove:g', ...unauthorizedGrants])

  const requiredDenies = [...new Set(
    entries
      .filter(entry => entry.type === 'Deny' && allowed.has(entry.sid))
      .map(entry => `*${entry.sid}`),
  )]
  if (requiredDenies.length > 0) runIcacls(path, ['/remove:d', ...requiredDenies])

  if (unauthorizedGrants.length === 0 && requiredDenies.length === 0) {
    assertWindowsAclEntriesArePrivate(entries, kind)
    return
  }

  // Re-apply grants after removing explicit legacy entries, then verify the
  // effective DACL independently. Any tooling or ACL failure is fail-closed.
  runIcacls(path, ['/inheritance:r', '/grant:r', ...grants])
  assertWindowsAclEntriesArePrivate(inspectWindowsAcl(path), kind)
}

function assertPosixMode(path: string, expected: number): void {
  const actual = statSync(path).mode & 0o777
  if (actual !== expected) {
    throw new Error(`Private state path has mode ${actual.toString(8)}; expected ${expected.toString(8)}`)
  }
}

function securePrivatePath(path: string, kind: PrivatePathKind, verifyExisting = true): void {
  if (process.platform === 'win32') {
    secureWindowsPath(path, kind, verifyExisting)
    return
  }
  const mode = kind === 'directory' ? 0o700 : 0o600
  chmodSync(path, mode)
  assertPosixMode(path, mode)
}

function assertPrivatePathType(path: string, kind: PrivatePathKind): void {
  const stats = lstatSync(path)
  const valid = kind === 'file' ? stats.isFile() : stats.isDirectory()
  if (!valid || stats.isSymbolicLink()) {
    throw new Error(`Private state ${kind} must be a regular local ${kind}`)
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function ensureParentDirectory(path: string): string {
  const directory = dirname(path)
  const existed = existsSync(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertPrivatePathType(directory, 'directory')
  if (!existed) {
    // Only directories created for this state path are modified. Existing
    // parents can be shared or operator-managed and must never have their ACL
    // or mode rewritten as a side effect of loading one Router file.
    securePrivatePath(directory, 'directory', false)
    fsyncDirectory(dirname(directory))
  }
  return directory
}

export function readPrivateTextFileSync(path: string): string | null {
  if (!existsSync(path)) return null
  assertPrivatePathType(path, 'file')
  securePrivatePath(path, 'file')
  return readFileSync(path, 'utf8')
}

export function writePrivateTextFileAtomicSync(path: string, content: string): void {
  const directory = ensureParentDirectory(path)
  if (existsSync(path)) assertPrivatePathType(path, 'file')
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600)
    closeSync(descriptor)
    descriptor = undefined

    // On Windows the empty file is hardened before any sensitive content is
    // written. On POSIX it was created 0600 atomically above.
    securePrivatePath(temporaryPath, 'file', false)
    descriptor = openSync(temporaryPath, 'r+')
    writeFileSync(descriptor, content, { encoding: 'utf8' })
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined

    // The replacement object already has a private descriptor. Existing
    // destination permissions are never used to create or write the new
    // content, and the smoke test verifies the descriptor survives replace.
    renameSync(temporaryPath, path)
    assertPrivatePathType(path, 'file')
    securePrivatePath(path, 'file')
    fsyncDirectory(directory)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporaryPath, { force: true })
  }
}
