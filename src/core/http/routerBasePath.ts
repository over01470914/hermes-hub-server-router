export function routerBasePath(routerUrl: string): string {
  const pathname = new URL(routerUrl).pathname.replace(/\/+$/, '')
  return pathname === '/' ? '' : pathname
}

export function stripRouterBasePath(pathname: string, basePath: string): string {
  if (!basePath) return pathname
  if (pathname === basePath) return '/'
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : pathname
}
