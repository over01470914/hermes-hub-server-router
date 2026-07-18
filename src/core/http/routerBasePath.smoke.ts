import assert from 'node:assert/strict'

import { routerBasePath, stripRouterBasePath } from './routerBasePath.js'

assert.equal(routerBasePath('https://router.example.test'), '')
assert.equal(routerBasePath('https://router.example.test/'), '')
assert.equal(routerBasePath('https://router.example.test/router-prefix/'), '/router-prefix')
assert.equal(routerBasePath('https://router.example.test/a%20b'), '/a%20b')

assert.equal(stripRouterBasePath('/router/health', ''), '/router/health')
assert.equal(stripRouterBasePath('/router-prefix', '/router-prefix'), '/')
assert.equal(
  stripRouterBasePath('/router-prefix/router/health', '/router-prefix'),
  '/router/health',
)
assert.equal(
  stripRouterBasePath('/router-prefix/apps/hermes-hub-gateway-plugin/install.mjs', '/router-prefix'),
  '/apps/hermes-hub-gateway-plugin/install.mjs',
)
assert.equal(
  stripRouterBasePath('/router-other-prefix/router/health', '/router-prefix'),
  '/router-other-prefix/router/health',
)
assert.equal(
  stripRouterBasePath('/router/health', '/router-prefix'),
  '/router/health',
)

console.log('Router base-path smoke passed.')
