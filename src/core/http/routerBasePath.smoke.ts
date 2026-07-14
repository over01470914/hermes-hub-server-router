import assert from 'node:assert/strict'

import { routerBasePath, stripRouterBasePath } from './routerBasePath.js'

assert.equal(routerBasePath('https://router.example.test'), '')
assert.equal(routerBasePath('https://router.example.test/'), '')
assert.equal(routerBasePath('https://router.example.test/router-dev/'), '/router-dev')
assert.equal(routerBasePath('https://router.example.test/a%20b'), '/a%20b')

assert.equal(stripRouterBasePath('/router/health', ''), '/router/health')
assert.equal(stripRouterBasePath('/router-dev', '/router-dev'), '/')
assert.equal(
  stripRouterBasePath('/router-dev/router/health', '/router-dev'),
  '/router/health',
)
assert.equal(
  stripRouterBasePath('/router-dev/apps/hermes-hub-gateway-plugin/install.mjs', '/router-dev'),
  '/apps/hermes-hub-gateway-plugin/install.mjs',
)
assert.equal(
  stripRouterBasePath('/router-development/router/health', '/router-dev'),
  '/router-development/router/health',
)
assert.equal(
  stripRouterBasePath('/router/health', '/router-dev'),
  '/router/health',
)

console.log('Router base-path smoke passed.')
