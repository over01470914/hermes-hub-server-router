import assert from 'node:assert/strict'

import {
  canonicalPublicRouterUrl,
  resolvePublicRouterUrl,
} from './publicRouterUrl.js'

assert.deepEqual(resolvePublicRouterUrl(canonicalPublicRouterUrl), {
  routerUrl: canonicalPublicRouterUrl,
  strippedCanonicalPath: false,
})
assert.deepEqual(resolvePublicRouterUrl(`${canonicalPublicRouterUrl}/legacy-path/`), {
  routerUrl: canonicalPublicRouterUrl,
  strippedCanonicalPath: true,
})
assert.deepEqual(resolvePublicRouterUrl('https://router.example.test/router-prefix/'), {
  routerUrl: 'https://router.example.test/router-prefix',
  strippedCanonicalPath: false,
})

console.log('Public Router URL migration smoke passed.')
