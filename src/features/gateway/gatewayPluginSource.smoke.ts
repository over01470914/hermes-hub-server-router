import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  gatewayPluginPublicUrls,
  gatewayPluginPublicFiles,
  gatewayPluginReleaseArtifact,
  gatewayPluginReleaseUrls,
  gatewayPluginRepositoryUrl,
  gatewayPluginSourcePrefix,
  loadGatewayPluginSource,
} from './gatewayPluginSource.js'

assert.deepEqual(
  gatewayPluginPublicUrls('https://router.example.test/router-dev/'),
  {
    sourceUrl: 'https://router.example.test/router-dev/apps/hermes-hub-gateway-plugin/',
    installerUrl: 'https://router.example.test/router-dev/apps/hermes-hub-gateway-plugin/install.mjs',
    manifestUrl: 'https://router.example.test/router-dev/apps/hermes-hub-gateway-plugin/package-manifest.json',
  },
)

assert.equal(
  gatewayPluginRepositoryUrl,
  'https://github.com/over01470914/hermes-hub-gateway-plugin',
)
assert.deepEqual(gatewayPluginReleaseArtifact, {
  commit: '4c0c31e0e99218c189ba96055ccacb700dceb0b6',
  installerBytes: 68536,
  installerSha256: 'c2aabfe14445bff7178fed4904f6361f84114b435e352002d068d5a0afaccbc2',
})
assert.deepEqual(gatewayPluginReleaseUrls, {
  sourceUrl:
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/4c0c31e0e99218c189ba96055ccacb700dceb0b6/',
  installerUrl:
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/4c0c31e0e99218c189ba96055ccacb700dceb0b6/install.mjs',
  manifestUrl:
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/4c0c31e0e99218c189ba96055ccacb700dceb0b6/package-manifest.json',
})

interface PackageManifest {
  schema: string
  version: string
  files: Array<{ name: string; bytes: number; sha256: string }>
}

const packageRoot = join(process.cwd(), 'apps', 'hermes-hub-gateway-plugin')
const manifest = JSON.parse(
  await readFile(join(packageRoot, 'package-manifest.json'), 'utf8'),
) as PackageManifest

assert.equal(manifest.schema, 'hermes-hub-gateway-package/v1')
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
assert.deepEqual(
  [...manifest.files.map(file => file.name)].sort(),
  gatewayPluginPublicFiles.filter(name => name !== 'package-manifest.json').sort(),
)

for (const entry of manifest.files) {
  assert.match(entry.sha256, /^[a-f0-9]{64}$/)
  const body = await readFile(join(packageRoot, entry.name))
  assert.equal(body.length, entry.bytes)
  assert.equal(createHash('sha256').update(body).digest('hex'), entry.sha256)
}

for (const name of gatewayPluginPublicFiles) {
  const pathname = `${gatewayPluginSourcePrefix}${name}`
  const body = await readFile(join(packageRoot, name))
  const get = await loadGatewayPluginSource('GET', pathname)
  assert.ok(get)
  assert.equal(get.status, 200)
  assert.deepEqual(get.body, body)
  assert.equal(get.headers['content-length'], String(body.length))
  assert.equal(get.headers['x-content-type-options'], 'nosniff')

  const head = await loadGatewayPluginSource('HEAD', pathname)
  assert.ok(head)
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-length'], String(body.length))
}

assert.equal(await loadGatewayPluginSource('GET', '/router/health'), null)
assert.equal(
  (await loadGatewayPluginSource('POST', `${gatewayPluginSourcePrefix}install.mjs`))?.status,
  405,
)
for (const name of ['README.md', '../bridgeServer.ts', '', 'adapter.py/extra']) {
  assert.equal(
    (await loadGatewayPluginSource('GET', `${gatewayPluginSourcePrefix}${name}`))?.status,
    404,
  )
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'hermes-hub-gateway-source-'))
try {
  const temporaryPackageRoot = join(temporaryRoot, 'apps', 'hermes-hub-gateway-plugin')
  await mkdir(temporaryPackageRoot, { recursive: true })
  await writeFile(join(temporaryPackageRoot, 'adapter.py'), Buffer.alloc(2 * 1024 * 1024 + 1))
  assert.equal(
    (await loadGatewayPluginSource(
      'GET',
      `${gatewayPluginSourcePrefix}adapter.py`,
      temporaryRoot,
    ))?.status,
    404,
  )

  await mkdir(join(temporaryPackageRoot, 'protocol.py'))
  assert.equal(
    (await loadGatewayPluginSource(
      'GET',
      `${gatewayPluginSourcePrefix}protocol.py`,
      temporaryRoot,
    ))?.status,
    404,
  )

  await writeFile(join(temporaryPackageRoot, '__init__.py.real'), 'safe')
  try {
    await symlink('__init__.py.real', join(temporaryPackageRoot, '__init__.py'), 'file')
    assert.equal(
      (await loadGatewayPluginSource(
        'GET',
        `${gatewayPluginSourcePrefix}__init__.py`,
        temporaryRoot,
      ))?.status,
      404,
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw error
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

console.log('Gateway plugin source smoke passed.')
