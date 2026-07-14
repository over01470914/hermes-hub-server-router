import assert from 'node:assert/strict'
import {
  KanbanBridgeRequestError,
  normalizeKanbanBridgeError,
  normalizeKanbanBridgeResponse,
  planKanbanBridgeRequest
} from './kanbanBridgeAdapter.js'

function expectRequestError(run: () => unknown, code: string, status = 400): void {
  assert.throws(run, (error: unknown) => {
    assert(error instanceof KanbanBridgeRequestError)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  })
}

assert.equal(
  planKanbanBridgeRequest({ method: 'GET', pathname: '/bridge/sessions' }),
  null,
  'the isolated adapter must ignore non-Kanban routes'
)

const boardsRequest = planKanbanBridgeRequest({
  method: 'GET',
  pathname: '/bridge/kanban/boards',
  search: '?include_archived=true&ignored=host-path'
})
assert.deepEqual(boardsRequest, {
  operation: 'boards.list',
  permission: 'read',
  method: 'GET',
  upstreamPath: 'api/kanban/boards?include_archived=1'
})

assert.deepEqual(
  normalizeKanbanBridgeResponse('boards.list', {
    boards: [
      {
        slug: 'default',
        name: 'Default board',
        description: 'Main queue',
        icon: 'inbox',
        color: '#112233',
        counts: { triage: 1, ready: 2 },
        directory: 'C:\\Users\\operator\\.hermes\\kanban\\default',
        db_path: 'C:\\Users\\operator\\.hermes\\kanban\\default\\kanban.db'
      }
    ],
    current: 'default',
    read_only: false
  }),
  {
    boards: [
      {
        slug: 'default',
        name: 'Default board',
        description: 'Main queue',
        icon: 'inbox',
        color: '#112233',
        task_count: 3
      }
    ],
    active_board: 'default',
    read_only: false
  },
  'board DTOs must not expose host paths'
)

const columnsRequest = planKanbanBridgeRequest({
  method: 'GET',
  pathname: '/bridge/kanban/boards/product-v02/columns',
  search: '?since=42&include_archived=0'
})
assert.deepEqual(columnsRequest, {
  operation: 'columns.list',
  permission: 'read',
  method: 'GET',
  upstreamPath: 'api/kanban/board?board=product-v02&since=42&include_archived=0'
})

const columns = normalizeKanbanBridgeResponse('columns.list', {
  columns: [
    {
      name: 'ready',
      tasks: [
        {
          id: 't_1',
          title: 'Ship adapter',
          status: 'ready',
          priority: -5,
          workspace_kind: 'scratch',
          workspace_path: 'D:\\work\\scratch\\task-t_1',
          claim_lock: 'opaque-claim',
          worker_pid: 31337
        }
      ]
    }
  ],
  latest_event_id: 42,
  changed: true,
  read_only: false
})
assert.deepEqual(columns, {
  columns: [
    {
      name: 'ready',
      tasks: [
        {
          id: 't_1',
          title: 'Ship adapter',
          status: 'ready',
          priority: -5,
          workspace_kind: 'scratch',
          workspace_label: 'task-t_1'
        }
      ]
    }
  ],
  latest_event_id: 42,
  changed: true,
  read_only: false
})

expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'GET',
    pathname: '/bridge/kanban/boards/%2e%2e/columns'
  }),
  'invalid_board'
)
expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'GET',
    pathname: '/bridge/kanban/boards/default/columns',
    search: '?since=-1'
  }),
  'invalid_since'
)

const taskRequest = planKanbanBridgeRequest({
  method: 'GET',
  pathname: '/bridge/kanban/boards/default/tasks/task%3A7'
})
assert.equal(taskRequest?.upstreamPath, 'api/kanban/tasks/task%3A7?board=default')
assert.deepEqual(
  normalizeKanbanBridgeResponse('task.get', {
    task: {
      id: 'task:7',
      title: 'Inspect detail',
      status: 'ready',
      workspace_path: '/tmp/hermes/task-7',
      claim_lock: 'opaque-claim',
      worker_pid: 31337
    },
    links: { parents: ['t_1'], children: [] },
    comments: [{ id: 1, body: 'Ready' }],
    events: [{ id: 7, payload: { secret: 'must-not-cross' } }],
    runs: [{ id: 'run-1', worker_pid: 31337 }]
  }),
  {
    task: {
      id: 'task:7',
      title: 'Inspect detail',
      status: 'ready',
      workspace_label: 'task-7'
    },
    links: { parents: ['t_1'], children: [] },
    comments: [{ id: '1', body: 'Ready' }]
  }
)

const createRequest = planKanbanBridgeRequest({
  method: 'POST',
  pathname: '/bridge/kanban/boards/default/tasks',
  body: {
    title: '  Build remote Kanban  ',
    body: 'Keep the module isolated.',
    priority: 2,
    parents: ['t_1', 't_1'],
    workspace_kind: 'scratch',
    workspace_path: '',
    idempotency_key: 'create-task-7',
    unknown_host_field: 'must-not-pass-through'
  }
})
assert.deepEqual(createRequest, {
  operation: 'task.create',
  permission: 'write',
  method: 'POST',
  upstreamPath: 'api/kanban/tasks?board=default',
  body: {
    title: 'Build remote Kanban',
    created_by: 'hermes-hub',
    workspace_kind: 'scratch',
    body: 'Keep the module isolated.',
    priority: 2,
    parents: ['t_1'],
    idempotency_key: 'create-task-7'
  }
})

expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'POST',
    pathname: '/bridge/kanban/boards/default/tasks',
    body: { title: 'Unsafe path', workspace_kind: 'dir', workspace_path: 'C:\\private' }
  }),
  'workspace_path_not_allowed'
)
expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'POST',
    pathname: '/bridge/kanban/boards/default/tasks',
    body: { title: 'Unsafe kind', workspace_kind: 'worktree' }
  }),
  'workspace_kind_not_allowed'
)

const updateRequest = planKanbanBridgeRequest({
  method: 'PATCH',
  pathname: '/bridge/kanban/boards/default/tasks/t_1',
  body: { title: 'Updated', status: 'ready', ignored: true }
})
assert.deepEqual(updateRequest?.body, { title: 'Updated', status: 'ready' })

expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'PATCH',
    pathname: '/bridge/kanban/boards/default/tasks/t_1',
    body: { status: 'running' }
  }),
  'running_requires_dispatch'
)
expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'PATCH',
    pathname: '/bridge/kanban/boards/default/tasks/t_1',
    body: { status: 'done' }
  }),
  'status_requires_action'
)

const blockRequest = planKanbanBridgeRequest({
  method: 'POST',
  pathname: '/bridge/kanban/boards/default/tasks/t_1/actions/block',
  body: { reason: 'Waiting on t_0', status: 'running' }
})
assert.deepEqual(blockRequest, {
  operation: 'task.action.block',
  permission: 'write',
  method: 'POST',
  upstreamPath: 'api/kanban/tasks/t_1/block?board=default',
  body: { reason: 'Waiting on t_0' }
})

const completeRequest = planKanbanBridgeRequest({
  method: 'POST',
  pathname: '/bridge/kanban/boards/default/tasks/t_1/actions/complete',
  body: { summary: 'Done once', result: 'ok' }
})
assert.deepEqual(completeRequest, {
  operation: 'task.action.complete',
  permission: 'write',
  method: 'PATCH',
  upstreamPath: 'api/kanban/tasks/t_1?board=default',
  body: { status: 'done', result: 'ok', summary: 'Done once' }
})

expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'POST',
    pathname: '/bridge/kanban/boards/default/tasks/t_1/actions/running'
  }),
  'invalid_action'
)

const commentRequest = planKanbanBridgeRequest({
  method: 'POST',
  pathname: '/bridge/kanban/boards/default/tasks/t_1/comments',
  body: { author: 'spoofed-user', body: 'Remote note' }
})
assert.deepEqual(commentRequest?.body, { author: 'hermes-hub', body: 'Remote note' })
expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'POST',
    pathname: '/bridge/kanban/boards/default/tasks/t_1/comments',
    body: { body: '   ' }
  }),
  'invalid_body'
)

const linkRequest = planKanbanBridgeRequest({
  method: 'POST',
  pathname: '/bridge/kanban/boards/default/links',
  body: { parent_id: 't_1', child_id: 't_2', extra: 'drop-me' }
})
assert.deepEqual(linkRequest, {
  operation: 'link.create',
  permission: 'write',
  method: 'POST',
  upstreamPath: 'api/kanban/links?board=default',
  body: { parent_id: 't_1', child_id: 't_2' }
})
expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'DELETE',
    pathname: '/bridge/kanban/boards/default/links',
    body: { parent_id: 't_1', child_id: 't_1' }
  }),
  'self_link'
)

const previewRequest = planKanbanBridgeRequest({
  method: 'POST',
  pathname: '/bridge/kanban/boards/default/dispatch/preview',
  body: { max: 4 }
})
assert.deepEqual(previewRequest, {
  operation: 'dispatch.preview',
  permission: 'execute',
  method: 'POST',
  upstreamPath: 'api/kanban/dispatch?board=default&dry_run=1&max=4'
})

expectRequestError(
  () => planKanbanBridgeRequest({
    method: 'POST',
    pathname: '/bridge/kanban/boards/default/dispatch/run',
    body: { max: 4 }
  }),
  'confirmation_required',
  409
)

const runRequest = planKanbanBridgeRequest({
  method: 'POST',
  pathname: '/bridge/kanban/boards/default/dispatch/run',
  body: { max: 4, confirmed: true, request_id: 'dispatch-7' }
})
assert.deepEqual(runRequest, {
  operation: 'dispatch.run',
  permission: 'execute',
  method: 'POST',
  upstreamPath: 'api/kanban/dispatch?board=default&dry_run=0&max=4',
  requestId: 'dispatch-7',
  retryPolicy: 'never'
})

assert.deepEqual(
  normalizeKanbanBridgeResponse('dispatch.preview', {
    dry_run: true,
    max_spawn: 4,
    spawned: [
      { task_id: 't_1', workspace_path: '/tmp/t_1' },
      { task_id: 't_2', claim_lock: 'opaque-claim' }
    ]
  }),
  { eligible: 2, claimed: 0 },
  'reference-shaped dry-run spawned candidates must become an eligible count'
)
assert.deepEqual(
  normalizeKanbanBridgeResponse('dispatch.run', {
    eligible_count: 3,
    results: [{ task_id: 't_1', worker_pid: 31337 }],
    status: 'started',
    claim_lock: 'opaque-claim'
  }),
  { eligible: 3, claimed: 1, message: 'started' },
  'dispatcher responses must expose counts only, never worker or claim internals'
)
assert.deepEqual(
  normalizeKanbanBridgeError(409),
  {
    error: 'Kanban operation conflicts with current state',
    code: 'kanban_conflict'
  },
  'upstream errors must use stable shaped categories'
)

expectRequestError(
  () => planKanbanBridgeRequest({ method: 'GET', pathname: '/bridge/kanban/unknown' }),
  'endpoint_not_found',
  404
)

console.log(JSON.stringify({
  ok: true,
  checks: {
    isolatedRouteMatching: true,
    safeRequestMapping: true,
    scratchOnlyCreate: true,
    structuredActions: true,
    dispatchConfirmation: true,
    normalizedResponses: true
  }
}, null, 2))
