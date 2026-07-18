export const canonicalPublicRouterUrl = 'https://hermes-hub.s3studio.fun'

export interface PublicRouterUrlResolution {
  routerUrl: string
  strippedCanonicalPath: boolean
}

/**
 * This production hostname is origin-only. Normalize any historical path from
 * its environment value to the canonical root without constraining other
 * Router deployments that intentionally use a public base path.
 */
export function resolvePublicRouterUrl(value: string): PublicRouterUrlResolution {
  const routerUrl = value.trim().replace(/\/+$/, '')
  try {
    if (new URL(routerUrl).origin === canonicalPublicRouterUrl) {
      return {
        routerUrl: canonicalPublicRouterUrl,
        strippedCanonicalPath: routerUrl !== canonicalPublicRouterUrl,
      }
    }
  } catch {
    // Preserve the existing Router startup validation and its error message.
  }
  return { routerUrl, strippedCanonicalPath: false }
}
