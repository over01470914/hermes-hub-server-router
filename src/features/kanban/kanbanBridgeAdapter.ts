const BRIDGE_PREFIX = '/bridge/kanban'
const BOARD_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_TASK_BODY_BYTES = 64 * 1024
const MAX_COMMENT_BODY_BYTES = 64 * 1024
const MAX_TASK_COMMENTS = 100
const MAX_TASK_LINKS = 200

const MOVABLE_TASK_STATUSES = new Set(['triage', 'todo', 'ready'])
export const KANBAN_TASK_ACTIONS = ['block', 'unblock', 'complete', 'archive'] as const

export type KanbanTaskAction = typeof KANBAN_TASK_ACTIONS[number]
export type KanbanBridgePermission = 'read' | 'write' | 'execute'
export type KanbanBridgeMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'
export type KanbanBridgeOperation =
  | 'boards.list'
  | 'columns.list'
  | 'task.get'
  | 'task.create'
  | 'task.update'
  | 'task.action.block'
  | 'task.action.unblock'
  | 'task.action.complete'
  | 'task.action.archive'
  | 'comment.create'
  | 'link.create'
  | 'link.delete'
  | 'dispatch.preview'
  | 'dispatch.run'

export interface KanbanBridgeRequestInput {
  method?: string
  pathname: string
  search?: string
  body?: unknown
}

export interface PlannedKanbanBridgeRequest {
  operation: KanbanBridgeOperation
  permission: KanbanBridgePermission
  method: KanbanBridgeMethod
  upstreamPath: string
  body?: Record<string, unknown>
  requestId?: string
  retryPolicy?: 'never'
}

export class KanbanBridgeRequestError extends Error {
  constructor(
    message: string,
    readonly code: string = 'invalid_request',
    readonly status: number = 400
  ) {
    super(message)
    this.name = 'KanbanBridgeRequestError'
  }
}

function invalid(message: string, code = 'invalid_request', status = 400): never {
  throw new KanbanBridgeRequestError(message, code, status)
}

function invalidUpstream(message: string): never {
  throw new KanbanBridgeRequestError(message, 'invalid_upstream_response', 502)
}

function requireMethod(actual: string | undefined, expected: KanbanBridgeMethod): void {
  if ((actual || '').toUpperCase() !== expected) {
    invalid(`Kanban endpoint requires ${expected}`, 'method_not_allowed', 405)
  }
}

function decodePathSegment(raw: string, kind: 'board' | 'task' | 'action'): string {
  let value: string
  try {
    value = decodeURIComponent(raw)
  } catch {
    invalid(`Invalid ${kind} path encoding`, `invalid_${kind}`)
  }
  if (value !== value.trim() || value.includes('/') || value.includes('\\') || value.includes('..')) {
    invalid(`Invalid ${kind}`, `invalid_${kind}`)
  }
  return value
}

function boardSlug(raw: string): string {
  const value = decodePathSegment(raw, 'board')
  if (!BOARD_SLUG_PATTERN.test(value)) invalid('Invalid board slug', 'invalid_board')
  return value
}

function taskId(raw: string): string {
  const value = decodePathSegment(raw, 'task')
  if (!TASK_ID_PATTERN.test(value)) invalid('Invalid task id', 'invalid_task')
  return value
}

function taskAction(raw: string): KanbanTaskAction {
  const value = decodePathSegment(raw, 'action')
  if (!(KANBAN_TASK_ACTIONS as readonly string[]).includes(value)) {
    invalid('Invalid task action', 'invalid_action')
  }
  return value as KanbanTaskAction
}

function requestObject(body: unknown, allowMissing = false): Record<string, unknown> {
  if (body === undefined && allowMissing) return {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalid('Request body must be a JSON object', 'invalid_body')
  }
  return body as Record<string, unknown>
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  options: { trim?: boolean } = { trim: true }
): string {
  const raw = value[key]
  if (typeof raw !== 'string') invalid(`${key} is required`, `invalid_${key}`)
  const result = options.trim === false ? raw : raw.trim()
  if (!result || result.length > maxLength) invalid(`Invalid ${key}`, `invalid_${key}`)
  return result
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  options: { nullable?: boolean; trim?: boolean } = {}
): string | null | undefined {
  if (!hasOwn(value, key)) return undefined
  const raw = value[key]
  if (raw === null && options.nullable) return null
  if (typeof raw !== 'string') invalid(`Invalid ${key}`, `invalid_${key}`)
  const result = options.trim === false ? raw : raw.trim()
  if (result.length > maxLength) invalid(`Invalid ${key}`, `invalid_${key}`)
  if (!result && options.nullable) return null
  return result
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  if (!hasOwn(value, key)) return undefined
  if (typeof value[key] !== 'boolean') invalid(`Invalid ${key}`, `invalid_${key}`)
  return value[key] as boolean
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (!hasOwn(value, key)) return undefined
  const raw = value[key]
  if (!Number.isInteger(raw) || (raw as number) < minimum || (raw as number) > maximum) {
    invalid(`Invalid ${key}`, `invalid_${key}`)
  }
  return raw as number
}

function optionalTaskIds(value: Record<string, unknown>, key: string): string[] | undefined {
  if (!hasOwn(value, key)) return undefined
  const raw = value[key]
  if (!Array.isArray(raw) || raw.length > 64) invalid(`Invalid ${key}`, `invalid_${key}`)
  const ids = raw.map((entry) => {
    if (typeof entry !== 'string') invalid(`Invalid ${key}`, `invalid_${key}`)
    return taskId(encodeURIComponent(entry))
  })
  return [...new Set(ids)]
}

function optionalSkills(value: Record<string, unknown>): string[] | undefined {
  if (!hasOwn(value, 'skills')) return undefined
  const raw = value.skills
  if (!Array.isArray(raw) || raw.length > 32) invalid('Invalid skills', 'invalid_skills')
  return raw.map((entry) => {
    if (typeof entry !== 'string') invalid('Invalid skills', 'invalid_skills')
    const skill = entry.trim()
    if (!skill || skill.length > 128 || /[\u0000-\u001f\u007f]/.test(skill)) {
      invalid('Invalid skills', 'invalid_skills')
    }
    return skill
  })
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value
}

function createTaskBody(body: unknown): Record<string, unknown> {
  const input = requestObject(body)
  if (hasOwn(input, 'workspace_path') && input.workspace_path !== null && input.workspace_path !== '') {
    invalid('M1 task creation does not accept workspace_path', 'workspace_path_not_allowed')
  }
  if (hasOwn(input, 'workspace_kind') && input.workspace_kind !== 'scratch') {
    invalid('M1 task creation requires a scratch workspace', 'workspace_kind_not_allowed')
  }

  const result: Record<string, unknown> = {
    title: requiredString(input, 'title', 512),
    created_by: 'hermes-hub',
    workspace_kind: 'scratch'
  }
  assignDefined(result, 'body', optionalString(input, 'body', 64 * 1024, { nullable: true, trim: false }))
  assignDefined(result, 'assignee', optionalString(input, 'assignee', 128, { nullable: true }))
  assignDefined(result, 'tenant', optionalString(input, 'tenant', 128, { nullable: true }))
  assignDefined(result, 'priority', optionalInteger(input, 'priority', -1000, 1000))
  assignDefined(result, 'parents', optionalTaskIds(input, 'parents'))
  assignDefined(result, 'triage', optionalBoolean(input, 'triage'))
  assignDefined(result, 'max_runtime_seconds', optionalInteger(input, 'max_runtime_seconds', 1, 86_400))
  assignDefined(result, 'skills', optionalSkills(input))

  if (hasOwn(input, 'idempotency_key')) {
    const key = requiredString(input, 'idempotency_key', 128)
    if (!REQUEST_ID_PATTERN.test(key) || key.includes('..')) {
      invalid('Invalid idempotency_key', 'invalid_idempotency_key')
    }
    result.idempotency_key = key
  }

  if (hasOwn(input, 'status')) {
    const status = requiredString(input, 'status', 16).toLowerCase()
    if (!MOVABLE_TASK_STATUSES.has(status)) {
      invalid('Create status must be triage, todo, or ready', 'invalid_status')
    }
    result.status = status
  }
  return result
}

function updateTaskBody(body: unknown): Record<string, unknown> {
  const input = requestObject(body)
  if (hasOwn(input, 'workspace_kind') || hasOwn(input, 'workspace_path')) {
    invalid('Task workspace fields are immutable', 'immutable_workspace')
  }

  const result: Record<string, unknown> = {}
  if (hasOwn(input, 'title')) result.title = requiredString(input, 'title', 512)
  assignDefined(result, 'body', optionalString(input, 'body', 64 * 1024, { nullable: true, trim: false }))
  assignDefined(result, 'assignee', optionalString(input, 'assignee', 128, { nullable: true }))
  assignDefined(result, 'tenant', optionalString(input, 'tenant', 128, { nullable: true }))
  assignDefined(result, 'priority', optionalInteger(input, 'priority', -1000, 1000))

  if (hasOwn(input, 'status')) {
    const status = requiredString(input, 'status', 16).toLowerCase()
    if (status === 'running') {
      invalid('Cannot set running directly; use dispatcher/claim', 'running_requires_dispatch')
    }
    if (!MOVABLE_TASK_STATUSES.has(status)) {
      invalid('Use a structured task action for this status', 'status_requires_action')
    }
    result.status = status
  }

  if (Object.keys(result).length === 0) invalid('No supported task fields supplied', 'empty_update')
  return result
}

function actionBody(action: KanbanTaskAction, body: unknown): Record<string, unknown> {
  const input = requestObject(body, true)
  if (action === 'block') {
    const reason = optionalString(input, 'reason', 4096, { nullable: true, trim: false })
    const result: Record<string, unknown> = {}
    assignDefined(result, 'reason', reason)
    return result
  }
  if (action === 'complete') {
    const result: Record<string, unknown> = { status: 'done' }
    assignDefined(result, 'result', optionalString(input, 'result', 64 * 1024, { nullable: true, trim: false }))
    assignDefined(result, 'summary', optionalString(input, 'summary', 16 * 1024, { nullable: true, trim: false }))
    return result
  }
  if (action === 'archive') return { status: 'archived' }
  return {}
}

function commentBody(body: unknown): Record<string, unknown> {
  const input = requestObject(body)
  const comment = requiredString(input, 'body', 64 * 1024, { trim: false })
  if (!comment.trim()) invalid('body is required', 'invalid_body')
  return {
    author: 'hermes-hub',
    body: comment
  }
}

function linkBody(body: unknown): Record<string, unknown> {
  const input = requestObject(body)
  const parent = requiredString(input, 'parent_id', 128)
  const child = requiredString(input, 'child_id', 128)
  const parentId = taskId(encodeURIComponent(parent))
  const childId = taskId(encodeURIComponent(child))
  if (parentId === childId) invalid('A task cannot depend on itself', 'self_link')
  return { parent_id: parentId, child_id: childId }
}

function query(search = ''): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
}

function singleQuery(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key)
  if (values.length > 1) invalid(`Duplicate ${key} query parameter`, `invalid_${key}`)
  return values[0]
}

function queryBoolean(params: URLSearchParams, key: string): boolean | undefined {
  const raw = singleQuery(params, key)
  if (raw === undefined) return undefined
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  invalid(`Invalid ${key} query parameter`, `invalid_${key}`)
}

function queryInteger(params: URLSearchParams, key: string, minimum: number, maximum: number): number | undefined {
  const raw = singleQuery(params, key)
  if (raw === undefined) return undefined
  if (!/^[0-9]+$/.test(raw)) invalid(`Invalid ${key} query parameter`, `invalid_${key}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`Invalid ${key} query parameter`, `invalid_${key}`)
  }
  return value
}

function appendQuery(path: string, values: ReadonlyArray<readonly [string, string | number | boolean | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of values) {
    if (value === undefined) continue
    params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  }
  const encoded = params.toString()
  return encoded ? `${path}?${encoded}` : path
}

function planned(
  operation: KanbanBridgeOperation,
  permission: KanbanBridgePermission,
  method: KanbanBridgeMethod,
  upstreamPath: string,
  body?: Record<string, unknown>
): PlannedKanbanBridgeRequest {
  return { operation, permission, method, upstreamPath, ...(body ? { body } : {}) }
}

function dispatchPlan(
  method: string | undefined,
  board: string,
  mode: 'preview' | 'run',
  body: unknown
): PlannedKanbanBridgeRequest {
  requireMethod(method, 'POST')
  const input = requestObject(body, true)
  const max = optionalInteger(input, 'max', 1, 100)
  const requestIdValue = hasOwn(input, 'request_id')
    ? requiredString(input, 'request_id', 128)
    : hasOwn(input, 'idempotency_key')
      ? requiredString(input, 'idempotency_key', 128)
      : undefined
  if (requestIdValue && (!REQUEST_ID_PATTERN.test(requestIdValue) || requestIdValue.includes('..'))) {
    invalid('Invalid request_id', 'invalid_request_id')
  }
  if (mode === 'run' && input.confirmed !== true) {
    invalid('Dispatcher run requires explicit confirmation', 'confirmation_required', 409)
  }
  const result = planned(
    mode === 'preview' ? 'dispatch.preview' : 'dispatch.run',
    'execute',
    'POST',
    appendQuery('api/kanban/dispatch', [
      ['board', board],
      ['dry_run', mode === 'preview'],
      ['max', max]
    ])
  )
  if (requestIdValue) result.requestId = requestIdValue
  if (mode === 'run') result.retryPolicy = 'never'
  return result
}

/**
 * Converts the public, shaped Hermes Hub Kanban API into the narrow WebUI
 * Kanban bridge calls. Unknown public routes are rejected and client query or
 * body fields are never copied through wholesale.
 */
export function planKanbanBridgeRequest(input: KanbanBridgeRequestInput): PlannedKanbanBridgeRequest | null {
  const { pathname } = input
  if (pathname !== BRIDGE_PREFIX && !pathname.startsWith(`${BRIDGE_PREFIX}/`)) return null
  if (pathname.includes('?')) invalid('pathname must not include a query string', 'invalid_path')

  if (pathname === `${BRIDGE_PREFIX}/boards`) {
    requireMethod(input.method, 'GET')
    const params = query(input.search)
    const includeArchived = queryBoolean(params, 'include_archived')
    return planned(
      'boards.list',
      'read',
      'GET',
      appendQuery('api/kanban/boards', [['include_archived', includeArchived]])
    )
  }

  let match = pathname.match(/^\/bridge\/kanban\/boards\/([^/]+)\/columns$/)
  if (match) {
    requireMethod(input.method, 'GET')
    const board = boardSlug(match[1])
    const params = query(input.search)
    const since = queryInteger(params, 'since', 0, Number.MAX_SAFE_INTEGER)
    const includeArchived = queryBoolean(params, 'include_archived')
    return planned(
      'columns.list',
      'read',
      'GET',
      appendQuery('api/kanban/board', [
        ['board', board],
        ['since', since],
        ['include_archived', includeArchived]
      ])
    )
  }

  match = pathname.match(/^\/bridge\/kanban\/boards\/([^/]+)\/tasks\/([^/]+)$/)
  if (match) {
    const board = boardSlug(match[1])
    const task = taskId(match[2])
    if ((input.method || '').toUpperCase() === 'GET') {
      return planned(
        'task.get',
        'read',
        'GET',
        appendQuery(`api/kanban/tasks/${encodeURIComponent(task)}`, [['board', board]])
      )
    }
    requireMethod(input.method, 'PATCH')
    return planned(
      'task.update',
      'write',
      'PATCH',
      appendQuery(`api/kanban/tasks/${encodeURIComponent(task)}`, [['board', board]]),
      updateTaskBody(input.body)
    )
  }

  match = pathname.match(/^\/bridge\/kanban\/boards\/([^/]+)\/tasks$/)
  if (match) {
    requireMethod(input.method, 'POST')
    const board = boardSlug(match[1])
    return planned(
      'task.create',
      'write',
      'POST',
      appendQuery('api/kanban/tasks', [['board', board]]),
      createTaskBody(input.body)
    )
  }

  match = pathname.match(/^\/bridge\/kanban\/boards\/([^/]+)\/tasks\/([^/]+)\/actions\/([^/]+)$/)
  if (match) {
    requireMethod(input.method, 'POST')
    const board = boardSlug(match[1])
    const task = taskId(match[2])
    const action = taskAction(match[3])
    const body = actionBody(action, input.body)
    if (action === 'block' || action === 'unblock') {
      return planned(
        `task.action.${action}`,
        'write',
        'POST',
        appendQuery(`api/kanban/tasks/${encodeURIComponent(task)}/${action}`, [['board', board]]),
        body
      )
    }
    return planned(
      `task.action.${action}`,
      'write',
      'PATCH',
      appendQuery(`api/kanban/tasks/${encodeURIComponent(task)}`, [['board', board]]),
      body
    )
  }

  match = pathname.match(/^\/bridge\/kanban\/boards\/([^/]+)\/tasks\/([^/]+)\/comments$/)
  if (match) {
    requireMethod(input.method, 'POST')
    const board = boardSlug(match[1])
    const task = taskId(match[2])
    return planned(
      'comment.create',
      'write',
      'POST',
      appendQuery(`api/kanban/tasks/${encodeURIComponent(task)}/comments`, [['board', board]]),
      commentBody(input.body)
    )
  }

  match = pathname.match(/^\/bridge\/kanban\/boards\/([^/]+)\/links$/)
  if (match) {
    const board = boardSlug(match[1])
    const method = (input.method || '').toUpperCase()
    if (method !== 'POST' && method !== 'DELETE') {
      invalid('Kanban links endpoint requires POST or DELETE', 'method_not_allowed', 405)
    }
    return planned(
      method === 'POST' ? 'link.create' : 'link.delete',
      'write',
      method,
      appendQuery('api/kanban/links', [['board', board]]),
      linkBody(input.body)
    )
  }

  match = pathname.match(/^\/bridge\/kanban\/boards\/([^/]+)\/dispatch\/(preview|run)$/)
  if (match) {
    return dispatchPlan(input.method, boardSlug(match[1]), match[2] as 'preview' | 'run', input.body)
  }

  invalid('Unknown Kanban endpoint', 'endpoint_not_found', 404)
}

function responseObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    invalidUpstream('Kanban host returned a non-object payload')
  }
  return payload as Record<string, unknown>
}

function safeBoardSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const slug = value.trim()
  return BOARD_SLUG_PATTERN.test(slug) ? slug : undefined
}

function optionalResponseString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function taskCount(board: Record<string, unknown>): number | undefined {
  for (const value of [board.task_count, board.total]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  }
  if (!board.counts || typeof board.counts !== 'object' || Array.isArray(board.counts)) return undefined
  const counts = Object.values(board.counts as Record<string, unknown>)
  if (counts.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return undefined
  return counts.reduce<number>((sum, value) => sum + (value as number), 0)
}

function normalizeBoard(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const slug = safeBoardSlug(input.slug)
  if (!slug) return null
  const result: Record<string, unknown> = {
    slug,
    name: optionalResponseString(input.name) || slug
  }
  assignDefined(result, 'description', optionalResponseString(input.description))
  assignDefined(result, 'icon', optionalResponseString(input.icon))
  assignDefined(result, 'color', optionalResponseString(input.color))
  assignDefined(result, 'task_count', taskCount(input))
  return result
}

function workspaceLabel(path: string): string | undefined {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const label = parts.at(-1)?.trim()
  return label || undefined
}

function boundedResponseString(
  value: unknown,
  maxBytes: number,
  trim = true
): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = trim ? value.trim() : value
  if (!normalized.trim()) return undefined
  const encoded = Buffer.from(normalized, 'utf8')
  if (encoded.length <= maxBytes) return normalized
  return encoded.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '')
}

function responseIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return undefined
}

function responseNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function responseBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined
}

function normalizeTask(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidUpstream('Kanban task payload is invalid')
  }
  const input = value as Record<string, unknown>
  const id = responseIdentifier(input.id)
  const title = boundedResponseString(input.title ?? input.summary, 512)
  const status = boundedResponseString(input.status, 32)
  if (!id || !TASK_ID_PATTERN.test(id) || !title || !status) {
    invalidUpstream('Kanban task payload is missing id, title, or status')
  }
  const result: Record<string, unknown> = { id, title, status }
  assignDefined(result, 'body', boundedResponseString(input.body ?? input.description, MAX_TASK_BODY_BYTES, false))
  assignDefined(result, 'assignee', boundedResponseString(input.assignee, 160))
  assignDefined(result, 'tenant', boundedResponseString(input.tenant, 160))
  assignDefined(result, 'priority', responseBoundedInteger(input.priority, -1000, 1000))
  assignDefined(result, 'workspace_kind', boundedResponseString(input.workspace_kind, 32))
  const label = typeof input.workspace_path === 'string' ? workspaceLabel(input.workspace_path) : undefined
  assignDefined(
    result,
    'workspace_label',
    boundedResponseString(input.workspace_label, 256) || boundedResponseString(label, 256)
  )
  assignDefined(result, 'progress', responseNonNegativeInteger(input.progress))
  assignDefined(result, 'age_seconds', responseNonNegativeInteger(input.age_seconds ?? input.age))
  assignDefined(result, 'comment_count', responseNonNegativeInteger(input.comment_count ?? input.commentCount))
  if (input.link_counts && typeof input.link_counts === 'object' && !Array.isArray(input.link_counts)) {
    const counts = input.link_counts as Record<string, unknown>
    result.link_counts = {
      parents: responseNonNegativeInteger(counts.parents) ?? 0,
      children: responseNonNegativeInteger(counts.children) ?? 0
    }
  }
  return result
}

function normalizeComment(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const id = responseIdentifier(input.id ?? input.comment_id)
  const body = boundedResponseString(input.body ?? input.content, MAX_COMMENT_BODY_BYTES, false)
  if (!id || body === undefined) return null
  const result: Record<string, unknown> = { id, body }
  assignDefined(result, 'author', boundedResponseString(input.author ?? input.created_by, 160))
  assignDefined(result, 'created_at', boundedResponseString(input.created_at, 80))
  return result
}

function normalizeTaskLink(value: unknown): string | Record<string, unknown> | null {
  if (typeof value === 'string') {
    const id = responseIdentifier(value)
    return id && TASK_ID_PATTERN.test(id) ? id : null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const id = responseIdentifier(input.id ?? input.task_id)
  if (!id || !TASK_ID_PATTERN.test(id)) return null
  return {
    id,
    title: boundedResponseString(input.title ?? input.summary, 512) || id
  }
}

function normalizeTaskLinks(value: unknown): Record<string, unknown> {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const normalize = (items: unknown): Array<string | Record<string, unknown>> =>
    (Array.isArray(items) ? items : [])
      .slice(0, MAX_TASK_LINKS)
      .map(normalizeTaskLink)
      .filter((item): item is string | Record<string, unknown> => item !== null)
  return {
    parents: normalize(input.parents),
    children: normalize(input.children)
  }
}

function normalizeColumns(payload: unknown): Record<string, unknown> {
  const input = responseObject(payload)
  if (!Array.isArray(input.columns)) invalidUpstream('Kanban board payload is missing columns')
  const columns = input.columns.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalidUpstream('Kanban board contains an invalid column')
    }
    const column = entry as Record<string, unknown>
    if (typeof column.name !== 'string' || !Array.isArray(column.tasks)) {
      invalidUpstream('Kanban board contains an invalid column')
    }
    return {
      name: column.name,
      tasks: column.tasks.map(normalizeTask)
    }
  })
  const result: Record<string, unknown> = { columns }
  assignDefined(result, 'latest_event_id', responseNonNegativeInteger(input.latest_event_id))
  if (typeof input.changed === 'boolean') result.changed = input.changed
  if (typeof input.read_only === 'boolean') result.read_only = input.read_only
  return result
}

function normalizeTaskEnvelope(payload: unknown, includeDetail: boolean): Record<string, unknown> {
  const input = responseObject(payload)
  if (!hasOwn(input, 'task')) invalidUpstream('Kanban task response is missing task')
  const result: Record<string, unknown> = { task: normalizeTask(input.task) }
  if (includeDetail) {
    const comments = (Array.isArray(input.comments) ? input.comments : [])
      .slice(-MAX_TASK_COMMENTS)
      .map(normalizeComment)
      .filter((comment): comment is Record<string, unknown> => comment !== null)
    result.comments = comments
    result.links = normalizeTaskLinks(input.links)
    if (Array.isArray(input.comments) && input.comments.length > comments.length) {
      result.comments_truncated = true
    }
  }
  if (typeof input.read_only === 'boolean') result.read_only = input.read_only
  return result
}

function normalizeMutationResult(payload: unknown): Record<string, unknown> {
  const input = responseObject(payload)
  const result: Record<string, unknown> = { ok: input.ok !== false }
  assignDefined(result, 'comment_id', responseIdentifier(input.comment_id))
  assignDefined(result, 'parent_id', responseIdentifier(input.parent_id))
  assignDefined(result, 'child_id', responseIdentifier(input.child_id))
  if (typeof input.changed === 'boolean') result.changed = input.changed
  if (typeof input.read_only === 'boolean') result.read_only = input.read_only
  return result
}

function dispatchCount(input: Record<string, unknown>, keys: string[], arrays: string[]): number {
  for (const key of keys) {
    const value = responseNonNegativeInteger(input[key])
    if (value !== undefined) return value
  }
  for (const key of arrays) {
    if (Array.isArray(input[key])) return input[key].length
  }
  return 0
}

function normalizeDispatchResult(
  payload: unknown,
  preview: boolean
): Record<string, unknown> {
  const input = responseObject(payload)
  const spawnedCount = Array.isArray(input.spawned)
    ? input.spawned.length
    : responseNonNegativeInteger(input.spawned)
  const result: Record<string, unknown> = {
    eligible: dispatchCount(
      input,
      ['eligible', 'eligible_count', 'would_spawn'],
      preview ? ['spawned', 'tasks', 'eligible_tasks'] : ['tasks', 'eligible_tasks']
    ),
    claimed: preview
      ? dispatchCount(input, ['claimed', 'claimed_count'], ['results'])
      : spawnedCount ?? dispatchCount(input, ['claimed', 'claimed_count'], ['results'])
  }
  assignDefined(
    result,
    'message',
    boundedResponseString(input.message ?? input.status ?? input.result, 1024)
  )
  return result
}

/**
 * Stabilizes the host payloads consumed by Flutter and removes host filesystem
 * paths/claim internals from task projections. Each operation is projected to
 * the fields Flutter consumes; task events, runs, worker and lease internals
 * never cross the public bridge boundary.
 */
export function normalizeKanbanBridgeResponse(
  operation: KanbanBridgeOperation,
  payload: unknown
): Record<string, unknown> {
  if (operation === 'boards.list') {
    const input = responseObject(payload)
    if (!Array.isArray(input.boards)) invalidUpstream('Kanban board list is missing boards')
    const boards = input.boards.map(normalizeBoard).filter((board): board is Record<string, unknown> => board !== null)
    const activeBoard = safeBoardSlug(input.active_board) || safeBoardSlug(input.current)
    return {
      boards,
      ...(activeBoard ? { active_board: activeBoard } : {}),
      ...(typeof input.read_only === 'boolean' ? { read_only: input.read_only } : {})
    }
  }
  if (operation === 'columns.list') return normalizeColumns(payload)
  if (operation === 'task.get') return normalizeTaskEnvelope(payload, true)
  if (operation === 'task.create' || operation === 'task.update' || operation.startsWith('task.action.')) {
    return normalizeTaskEnvelope(payload, false)
  }
  if (operation === 'comment.create' || operation === 'link.create' || operation === 'link.delete') {
    return normalizeMutationResult(payload)
  }
  return normalizeDispatchResult(payload, operation === 'dispatch.preview')
}

export function normalizeKanbanBridgeError(status: number): { error: string; code: string } {
  if (status === 400 || status === 422) {
    return { error: 'Kanban host rejected the request', code: 'kanban_host_rejected' }
  }
  if (status === 401 || status === 403) {
    return { error: 'Kanban host authorization failed', code: 'kanban_host_denied' }
  }
  if (status === 404) return { error: 'Kanban resource not found', code: 'kanban_not_found' }
  if (status === 409) return { error: 'Kanban operation conflicts with current state', code: 'kanban_conflict' }
  if (status === 413) return { error: 'Kanban payload is too large', code: 'kanban_payload_too_large' }
  if (status === 429) return { error: 'Kanban host is busy', code: 'kanban_rate_limited' }
  return { error: 'Kanban host operation failed', code: 'kanban_host_failed' }
}
