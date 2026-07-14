import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const gatewayPluginSourcePrefix = '/apps/hermes-hub-gateway-plugin/'

export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

export const gatewayPluginReleaseUrls = Object.freeze({
  sourceUrl:
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/',
  installerUrl:
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/install.mjs',
  manifestUrl:
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/package-manifest.json',
})

export interface GatewayPluginPublicUrls {
  sourceUrl: string
  installerUrl: string
  manifestUrl: string
}

export function gatewayPluginPublicUrls(routerUrl: string): GatewayPluginPublicUrls {
  const router = new URL(routerUrl)
  router.hash = ''
  router.search = ''
  router.pathname = router.pathname.replace(/\/+$/, '')
  const base = router.toString().replace(/\/$/, '')
  const sourceUrl = `${base}${gatewayPluginSourcePrefix}`
  return {
    sourceUrl,
    installerUrl: `${sourceUrl}install.mjs`,
    manifestUrl: `${sourceUrl}package-manifest.json`,
  }
}

export const gatewayPluginPublicFiles = Object.freeze([
  '__init__.py',
  'adapter.py',
  'install.mjs',
  'package-manifest.json',
  'plugin.yaml',
  'protocol.py',
])

const publicFileSet = new Set(gatewayPluginPublicFiles)
const maxPublicFileBytes = 2 * 1024 * 1024

export interface GatewayPluginSourceResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function contentType(name: string): string {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  if (name.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.yaml')) return 'application/yaml; charset=utf-8'
  return 'text/x-python; charset=utf-8'
}

function empty(status: number): GatewayPluginSourceResponse {
  return {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-length': '0',
      'x-content-type-options': 'nosniff',
    },
    body: Buffer.alloc(0),
  }
}

export async function loadGatewayPluginSource(
  method: string | undefined,
  pathname: string,
  workspaceRoot = process.cwd(),
): Promise<GatewayPluginSourceResponse | null> {
  if (!pathname.startsWith(gatewayPluginSourcePrefix)) return null
  if (method !== 'GET' && method !== 'HEAD') return empty(405)

  const name = pathname.slice(gatewayPluginSourcePrefix.length)
  if (!publicFileSet.has(name)) return empty(404)

  const packageRoot = resolve(workspaceRoot, 'apps', 'hermes-hub-gateway-plugin')
  const filePath = resolve(packageRoot, name)
  if (!filePath.startsWith(`${packageRoot}\\`) && !filePath.startsWith(`${packageRoot}/`)) {
    return empty(404)
  }

  let stats
  try {
    stats = await lstat(filePath)
  } catch {
    return empty(404)
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxPublicFileBytes) {
    return empty(404)
  }

  const body = method === 'HEAD' ? Buffer.alloc(0) : await readFile(filePath)
  return {
    status: 200,
    headers: {
      // The package path is not content-addressed. Prevent intermediaries from
      // mixing an older manifest with newer files during an atomic deployment.
      'cache-control': 'no-store',
      'content-length': String(stats.size),
      'content-type': contentType(name),
      'x-content-type-options': 'nosniff',
    },
    body,
  }
}
