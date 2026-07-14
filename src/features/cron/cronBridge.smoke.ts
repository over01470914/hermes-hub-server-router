import assert from 'node:assert/strict'

import {
  cronBridgePermission,
  createCronBridgeAdapter,
  type CronBridgeRequest,
  type CronUpstreamRequest,
  type CronUpstreamResponse,
} from './cronBridge.js'

interface FakeProxy {
  calls: CronUpstreamRequest[]
  push(...responses: CronUpstreamResponse[]): void
  proxy(request: CronUpstreamRequest): Promise<CronUpstreamResponse>
}

function fakeProxy(): FakeProxy {
  const responses: CronUpstreamResponse[] = []
  const calls: CronUpstreamRequest[] = []
  return {
    calls,
    push: (...items) => responses.push(...items),
    proxy: async request => {
      calls.push(request)
      const response = responses.shift()
      if (!response) throw new Error(`No fake Cron response for ${request.method} ${request.path}`)
      return response
    },
  }
}

function ok(body: Record<string, unknown>, status = 200): CronUpstreamResponse {
  return { status, body, via: 'hermes-hub-gateway' }
}

function localJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1b2c3d4e5f6',
    name: 'Local report',
    prompt: 'Summarize local state',
    schedule: '0 9 * * *',
    enabled: true,
    deliver: 'local',
    state: 'active',
    ...overrides,
  }
}

async function handle(fake: FakeProxy, request: CronBridgeRequest, logs?: string[]) {
  return createCronBridgeAdapter({
    proxy: fake.proxy,
    log: logs
      ? (level, message, metadata) => logs.push(JSON.stringify({ level, message, metadata }))
      : undefined,
  }).handle(request)
}

const unrelated = fakeProxy()
assert.equal(await handle(unrelated, { method: 'GET', pathname: '/bridge/sessions' }), null)
assert.equal(cronBridgePermission({ method: 'GET', pathname: '/bridge/cron/jobs' }), 'read')
assert.equal(
  cronBridgePermission({ method: 'PATCH', pathname: '/bridge/cron/jobs/a1b2c3d4e5f6' }),
  'write',
)
assert.equal(
  cronBridgePermission({ method: 'POST', pathname: '/bridge/cron/jobs/a1b2c3d4e5f6/actions/run' }),
  'execute',
)

const list = fakeProxy()
list.push(ok({
  jobs: [
    localJob({
      schedule: { kind: 'cron', expr: '0 9 * * *', display: 'Daily' },
      workspace: 'C:/private/workspace',
      provider_key: 'provider-secret',
      last_error: 'Failed while reading C:/private/workspace/.env',
    }),
    localJob({ id: 'b1b2c3d4e5f6', deliver: 'origin', prompt: 'External delivery prompt' }),
    localJob({ id: 'c1b2c3d4e5f6', script: 'Write-Host script-secret', prompt: null }),
    localJob({ id: '../invalid', prompt: 'invalid id prompt' }),
  ],
}))
const listed = await handle(list, { method: 'GET', pathname: '/bridge/cron/jobs' })
assert.equal(listed?.status, 200)
assert.deepEqual(list.calls, [{ method: 'GET', path: '/api/jobs?include_disabled=true' }])
const listedJobs = listed?.body.jobs as Array<Record<string, unknown>>
assert.equal(listedJobs.length, 3)
assert.equal(listedJobs[0]?.manageable, true)
assert.equal(listedJobs[1]?.manageable, false)
assert.equal(listedJobs[2]?.kind, 'script')
const listedJson = JSON.stringify(listed)
assert(!listedJson.includes('C:/private/workspace'))
assert(!listedJson.includes('provider-secret'))
assert(!listedJson.includes('script-secret'))

const createLogs: string[] = []
const create = fakeProxy()
create.push(ok({ job: localJob({ id: 'd1b2c3d4e5f6', prompt: 'TOP_SECRET_CRON_PROMPT' }) }))
const created = await handle(create, {
  method: 'POST',
  pathname: '/bridge/cron/jobs',
  body: {
    name: 'Daily summary',
    prompt: 'TOP_SECRET_CRON_PROMPT',
    schedule: '0 9 * * *',
  },
}, createLogs)
assert.equal(created?.status, 201)
assert.deepEqual(create.calls, [{
  method: 'POST',
  path: '/api/jobs',
  body: {
    name: 'Daily summary',
    prompt: 'TOP_SECRET_CRON_PROMPT',
    schedule: '0 9 * * *',
    deliver: 'local',
  },
}])
assert(!createLogs.join('\n').includes('TOP_SECRET_CRON_PROMPT'))

const disabledCreate = fakeProxy()
disabledCreate.push(
  ok({ job: localJob({ id: 'e1b2c3d4e5f6' }) }),
  ok({ job: localJob({ id: 'e1b2c3d4e5f6', enabled: false, state: 'paused' }) }),
)
const disabledCreated = await handle(disabledCreate, {
  method: 'POST',
  pathname: '/bridge/cron/jobs',
  body: {
    name: 'Paused job',
    prompt: 'Wait for review',
    schedule: '0 0 * * *',
    enabled: false,
  },
})
assert.equal(disabledCreated?.status, 201)
assert.deepEqual(
  disabledCreate.calls.map(call => `${call.method} ${call.path}`),
  ['POST /api/jobs', 'POST /api/jobs/e1b2c3d4e5f6/pause'],
)

for (const body of [
  { prompt: 'Do work', schedule: '* * * * *' },
  { name: 'Bad delivery', prompt: 'Do work', schedule: '* * * * *', deliver: 'origin' },
  { name: 'Bad field', prompt: 'Do work', schedule: '* * * * *', profile: 'private-profile' },
]) {
  const rejected = fakeProxy()
  const result = await handle(rejected, { method: 'POST', pathname: '/bridge/cron/jobs', body })
  assert.equal(result?.status, 400)
  assert.equal(rejected.calls.length, 0)
}

const update = fakeProxy()
update.push(
  ok({ job: localJob() }),
  ok({ job: localJob({ name: 'Renamed', enabled: false, state: 'paused' }) }),
)
const updated = await handle(update, {
  method: 'PATCH',
  pathname: '/bridge/cron/jobs/a1b2c3d4e5f6',
  body: { name: 'Renamed', enabled: false },
})
assert.equal(updated?.status, 200)
assert.deepEqual(update.calls, [
  { method: 'GET', path: '/api/jobs/a1b2c3d4e5f6' },
  {
    method: 'PATCH',
    path: '/api/jobs/a1b2c3d4e5f6',
    body: { name: 'Renamed', enabled: false },
  },
])

const resume = fakeProxy()
resume.push(
  ok({ job: localJob({ enabled: false, state: 'paused' }) }),
  ok({ job: localJob({ enabled: true, state: 'active' }) }),
)
const resumed = await handle(resume, {
  method: 'POST',
  pathname: '/bridge/cron/jobs/a1b2c3d4e5f6/actions/resume',
})
assert.equal(resumed?.status, 200)
assert.deepEqual(
  resume.calls.map(call => `${call.method} ${call.path}`),
  ['GET /api/jobs/a1b2c3d4e5f6', 'POST /api/jobs/a1b2c3d4e5f6/resume'],
)

const remove = fakeProxy()
remove.push(ok({ job: localJob() }), ok({ ok: true }))
const removed = await handle(remove, {
  method: 'DELETE',
  pathname: '/bridge/cron/jobs/a1b2c3d4e5f6',
})
assert.equal(removed?.status, 200)
assert.deepEqual(
  remove.calls.map(call => `${call.method} ${call.path}`),
  ['GET /api/jobs/a1b2c3d4e5f6', 'DELETE /api/jobs/a1b2c3d4e5f6'],
)

const run = fakeProxy()
run.push(ok({ job: localJob() }), ok({ job: localJob() }))
const runResult = await handle(run, {
  method: 'POST',
  pathname: '/bridge/cron/jobs/a1b2c3d4e5f6/actions/run',
})
assert.equal(runResult?.status, 202)
assert.equal(run.calls.length, 2, 'run-now must be dispatched exactly once')
assert.equal(run.calls[1]?.path, '/api/jobs/a1b2c3d4e5f6/run')

const external = fakeProxy()
external.push(ok({ job: localJob({ deliver: 'origin' }) }))
const externalRun = await handle(external, {
  method: 'POST',
  pathname: '/bridge/cron/jobs/a1b2c3d4e5f6/actions/run',
})
assert.equal(externalRun?.status, 409)
assert.equal(externalRun?.body.code, 'unsupported_delivery')
assert.equal(external.calls.length, 1)

for (const pathname of [
  '/bridge/cron/jobs/a1b2c3d4e5f6/runs',
  '/bridge/cron/jobs/a1b2c3d4e5f6/runs/2026-07-12T090000.md',
]) {
  const history = fakeProxy()
  const historyResult = await handle(history, { method: 'GET', pathname })
  assert.equal(historyResult?.status, 501)
  assert.equal(historyResult?.body.code, 'feature_unsupported')
  assert.equal(history.calls.length, 0)
}

const unavailable = fakeProxy()
unavailable.push({ status: 501, body: { error: 'Cron module not available' } })
const unavailableResult = await handle(unavailable, { method: 'GET', pathname: '/bridge/cron/jobs' })
assert.equal(unavailableResult?.status, 503)
assert.equal(unavailableResult?.body.code, 'feature_unavailable')

const badMethod = fakeProxy()
const badMethodResult = await handle(badMethod, { method: 'PUT', pathname: '/bridge/cron/jobs' })
assert.equal(badMethodResult?.status, 405)
assert.equal(badMethod.calls.length, 0)

console.log(JSON.stringify({
  ok: true,
  checks: {
    canonicalJobsApi: true,
    localOnlyMutations: true,
    shapedAndRedactedResponses: true,
    exactOnceRunDispatch: true,
    unsupportedRunHistory: true,
    featureUnavailable: true,
    permissionMapping: true,
  },
}, null, 2))
