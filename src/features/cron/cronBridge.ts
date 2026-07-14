export type CronBridgeLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type CronBridgePermission = 'read' | 'write' | 'execute'

export interface CronBridgeRequest {
  method: string
  pathname: string
  searchParams?: URLSearchParams
  body?: unknown
}

export interface CronUpstreamRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}

export interface CronUpstreamResponse {
  status: number
  body: unknown
  via?: 'hermes-hub-gateway'
  responseBytes?: number
}

export interface CronBridgeResponse {
  status: number
  body: Record<string, unknown>
}

export interface CronJobScheduleDto {
  kind?: string
  expr?: string
  display?: string
}

export type CronJobKind = 'prompt' | 'script'

export interface CronJobDto {
  id: string
  name: string | null
  prompt: string
  prompt_truncated: boolean
  schedule: string | CronJobScheduleDto | null
  schedule_display: string | null
  enabled: boolean
  deliver: string
  kind: CronJobKind
  manageable: boolean
  executable: boolean
  state: string | null
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_error_category: CronErrorCategory | null
}

export type CronErrorCategory =
  | 'authentication'
  | 'conflict'
  | 'feature_unavailable'
  | 'not_found'
  | 'timeout'
  | 'upstream'
  | 'validation'

export interface CronBridgeLogMetadata {
  [key: string]: unknown
  method: string
  operation: string
  path: string
  queryKeys: string[]
  bodyFields: string[]
  bodyBytes?: number
  jobId?: string
  runId?: string
}

export interface CronBridgeAdapterDependencies {
  proxy(request: CronUpstreamRequest): Promise<CronUpstreamResponse>
  log?: (
    level: CronBridgeLogLevel,
    message: string,
    metadata: Record<string, unknown>
  ) => void
  now?: () => number
}

export interface CronBridgeAdapter {
  handle(request: CronBridgeRequest): Promise<CronBridgeResponse | null>
}

type CronRoute =
  | { kind: 'jobs' }
  | { kind: 'job'; jobId: string }
  | { kind: 'action'; jobId: string; action: 'pause' | 'resume' | 'run' }
  | { kind: 'runs'; jobId: string }
  | { kind: 'run'; jobId: string; runId: string }
  | { kind: 'unknown' }

const JOB_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/
const RUN_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/
const MAX_NAME_LENGTH = 160
const MAX_SCHEDULE_LENGTH = 512
const MAX_PROMPT_INPUT_LENGTH = 5000
const MAX_PROMPT_BYTES = 64 * 1024
const DEFAULT_RUN_LIMIT = 50
const MAX_RUN_LIMIT = 100

class CronBridgeFailure extends Error {
  constructor(readonly response: CronBridgeResponse) {
    super(String(response.body.error || response.body.code || 'Cron bridge request failed'))
  }
}

class CronBridgeAdapterImpl implements CronBridgeAdapter {
  constructor(private readonly dependencies: CronBridgeAdapterDependencies) {}

  async handle(request: CronBridgeRequest): Promise<CronBridgeResponse | null> {
    let route: CronRoute | null
    try {
      route = matchCronRoute(request.pathname)
    } catch (error) {
      if (error instanceof CronBridgeFailure) return error.response
      return bridgeError(400, 'invalid_path', 'Invalid Cron bridge path')
    }
    if (!route) return null

    const metadata = cronBridgeLogMetadata(request)
    this.dependencies.log?.('info', 'Cron bridge request accepted', metadata)
    const startedAt = this.now()

    try {
      const response = await this.dispatch(request, route)
      this.dependencies.log?.(
        response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info',
        'Cron bridge request completed',
        {
          ...metadata,
          status: response.status,
          latencyMs: Math.max(0, this.now() - startedAt),
          errorCode: typeof response.body.code === 'string' ? response.body.code : undefined
        }
      )
      return response
    } catch (error) {
      const response = error instanceof CronBridgeFailure
        ? error.response
        : bridgeError(502, 'upstream_unreachable', 'The connected Hermes host could not complete the Cron request')
      this.dependencies.log?.(
        response.status >= 500 ? 'error' : 'warn',
        'Cron bridge request failed',
        {
          ...metadata,
          status: response.status,
          latencyMs: Math.max(0, this.now() - startedAt),
          errorCode: typeof response.body.code === 'string' ? response.body.code : 'upstream_unreachable'
        }
      )
      return response
    }
  }

  private async dispatch(request: CronBridgeRequest, route: CronRoute): Promise<CronBridgeResponse> {
    const method = request.method.trim().toUpperCase()
    const searchParams = request.searchParams || new URLSearchParams()

    if (route.kind === 'unknown') {
      throw new CronBridgeFailure(bridgeError(404, 'not_found', 'Unknown Cron bridge operation'))
    }

    if (route.kind === 'jobs') {
      assertOnlyQueryKeys(searchParams, [])
      if (method === 'GET') return this.listJobs()
      if (method === 'POST') return this.createJob(request.body)
      throw methodNotAllowed('GET, POST')
    }

    if (route.kind === 'job') {
      assertOnlyQueryKeys(searchParams, [])
      if (method === 'GET') return this.getJob(route.jobId)
      if (method === 'PATCH') return this.updateJob(route.jobId, request.body)
      if (method === 'DELETE') {
        assertEmptyBody(request.body)
        return this.deleteJob(route.jobId)
      }
      throw methodNotAllowed('GET, PATCH, DELETE')
    }

    if (route.kind === 'action') {
      assertOnlyQueryKeys(searchParams, [])
      if (method !== 'POST') throw methodNotAllowed('POST')
      assertEmptyBody(request.body)
      return this.runAction(route.jobId, route.action)
    }

    if (route.kind === 'runs') {
      if (method !== 'GET') throw methodNotAllowed('GET')
      assertOnlyQueryKeys(searchParams, ['limit'])
      return this.listRuns(route.jobId, parseRunLimit(searchParams))
    }

    if (method !== 'GET') throw methodNotAllowed('GET')
    assertOnlyQueryKeys(searchParams, [])
    return this.getRun(route.jobId, route.runId)
  }

  private async listJobs(): Promise<CronBridgeResponse> {
    const jobs = await this.fetchRawJobs('cron.jobs.list')
    return {
      status: 200,
      body: { jobs: jobs.map(normalizeCronJob).filter(isPresent) }
    }
  }

  private async getJob(jobId: string): Promise<CronBridgeResponse> {
    const job = await this.findRawJob(jobId, 'cron.jobs.detail')
    const normalized = normalizeCronJob(job)
    if (!normalized) throw invalidUpstreamResponse()
    return { status: 200, body: { job: normalized } }
  }

  private async createJob(body: unknown): Promise<CronBridgeResponse> {
    const input = validateCreateBody(body)
    const response = await this.proxy({
      method: 'POST',
      path: '/api/jobs',
      body: input.upstream
    }, 'cron.jobs.create')
    const payload = requireSuccessPayload(response, 'cron.jobs.create')
    let job = normalizeMutationJob(payload)

    if (input.enabled === false) {
      const paused = await this.proxy({
        method: 'POST',
        path: `/api/jobs/${encodeURIComponent(job.id)}/pause`
      }, 'cron.jobs.pause-after-create')
      job = normalizeMutationJob(requireSuccessPayload(paused, 'cron.jobs.pause-after-create'))
    }

    return { status: 201, body: { ok: true, job } }
  }

  private async updateJob(jobId: string, body: unknown): Promise<CronBridgeResponse> {
    const input = validateUpdateBody(body)
    await this.requireManageableJob(jobId, 'cron.jobs.update-check')
    const response = await this.proxy({
      method: 'PATCH',
      path: `/api/jobs/${encodeURIComponent(jobId)}`,
      body: {
        ...input.upstream,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {})
      }
    }, 'cron.jobs.update')
    const job = normalizeMutationJob(requireSuccessPayload(response, 'cron.jobs.update'))
    return { status: 200, body: { ok: true, job } }
  }

  private async deleteJob(jobId: string): Promise<CronBridgeResponse> {
    await this.requireManageableJob(jobId, 'cron.jobs.delete-check')
    const response = await this.proxy({
      method: 'DELETE',
      path: `/api/jobs/${encodeURIComponent(jobId)}`
    }, 'cron.jobs.delete')
    const payload = requireSuccessPayload(response, 'cron.jobs.delete')
    if (payload.ok !== true) throw invalidUpstreamResponse()
    return { status: 200, body: { ok: true, job_id: jobId } }
  }

  private async runAction(
    jobId: string,
    action: 'pause' | 'resume' | 'run'
  ): Promise<CronBridgeResponse> {
    await this.requireManageableJob(jobId, `cron.jobs.${action}-check`)
    const response = await this.proxy({
      method: 'POST',
      path: `/api/jobs/${encodeURIComponent(jobId)}/${action}`
    }, `cron.jobs.${action}`)
    const payload = requireSuccessPayload(response, `cron.jobs.${action}`)

    if (action === 'run') {
      normalizeMutationJob(payload)
      return { status: 202, body: { ok: true, job_id: jobId, status: 'running' } }
    }

    return { status: 200, body: { ok: true, job: normalizeMutationJob(payload) } }
  }

  private async listRuns(jobId: string, limit: number): Promise<CronBridgeResponse> {
    void jobId
    void limit
    throw unsupportedCronRunHistory()
  }

  private async getRun(jobId: string, runId: string): Promise<CronBridgeResponse> {
    void jobId
    void runId
    throw unsupportedCronRunHistory()
  }

  private async requireManageableJob(jobId: string, operation: string): Promise<Record<string, unknown>> {
    const job = await this.findRawJob(jobId, operation)
    const deliver = optionalShortString(job.deliver, 64) || 'local'
    if (deliver !== 'local') {
      throw new CronBridgeFailure(bridgeError(
        409,
        'unsupported_delivery',
        'Only local-delivery Cron jobs can be managed remotely'
      ))
    }
    if (typeof job.script === 'string' && job.script.trim()) {
      throw new CronBridgeFailure(bridgeError(
        409,
        'unsupported_job_kind',
        'Script Cron jobs are read-only in this Hermes Hub release'
      ))
    }
    return job
  }

  private async findRawJob(jobId: string, operation: string): Promise<Record<string, unknown>> {
    const response = await this.proxy({
      method: 'GET',
      path: `/api/jobs/${encodeURIComponent(jobId)}`
    }, operation)
    const payload = requireSuccessPayload(response, operation)
    const job = asRecord(payload.job)
    if (!job) throw invalidUpstreamResponse()
    return job
  }

  private async fetchRawJobs(operation: string): Promise<Record<string, unknown>[]> {
    const response = await this.proxy({ method: 'GET', path: '/api/jobs?include_disabled=true' }, operation)
    const payload = requireSuccessPayload(response, `${operation}.list`)
    if (payload.cron_unavailable === true) {
      throw featureUnavailable()
    }
    if (!Array.isArray(payload.jobs)) throw invalidUpstreamResponse()
    return payload.jobs.map(asRecord).filter(isPresent)
  }

  private async proxy(request: CronUpstreamRequest, operation: string): Promise<CronUpstreamResponse> {
    const startedAt = this.now()
    let response: CronUpstreamResponse
    try {
      response = await this.dependencies.proxy(request)
    } catch {
      throw new CronBridgeFailure(bridgeError(
        502,
        'upstream_unreachable',
        'The connected Hermes host could not be reached'
      ))
    }
    this.dependencies.log?.(
      response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'debug',
      'Cron upstream request completed',
      {
        operation,
        method: request.method,
        path: request.path.split('?')[0],
        queryKeys: queryKeysFromPath(request.path),
        bodyBytes: safeByteLength(request.body),
        status: response.status,
        responseBytes: response.responseBytes ?? safeByteLength(response.body),
        via: response.via,
        latencyMs: Math.max(0, this.now() - startedAt)
      }
    )
    return response
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }
}

export function createCronBridgeAdapter(
  dependencies: CronBridgeAdapterDependencies
): CronBridgeAdapter {
  return new CronBridgeAdapterImpl(dependencies)
}

export function cronBridgePermission(
  request: Pick<CronBridgeRequest, 'method' | 'pathname'>
): CronBridgePermission | null {
  let route: CronRoute | null
  try {
    route = matchCronRoute(request.pathname)
  } catch {
    return null
  }
  if (!route || route.kind === 'unknown') return null
  const method = request.method.trim().toUpperCase()
  if (route.kind === 'jobs') {
    if (method === 'GET') return 'read'
    if (method === 'POST') return 'write'
    return null
  }
  if (route.kind === 'job') {
    if (method === 'GET') return 'read'
    if (method === 'PATCH' || method === 'DELETE') return 'write'
    return null
  }
  if (route.kind === 'action') {
    if (method !== 'POST') return null
    return route.action === 'run' ? 'execute' : 'write'
  }
  return method === 'GET' ? 'read' : null
}

export function cronBridgeLogMetadata(request: CronBridgeRequest): CronBridgeLogMetadata {
  let route: CronRoute | null = null
  try {
    route = matchCronRoute(request.pathname)
  } catch {
    // Invalid path segments are deliberately not copied into logs.
  }
  const body = asRecord(request.body)
  const safeBodyFields = new Set(['name', 'prompt', 'schedule', 'enabled', 'deliver'])
  const safeQueryKeys = new Set(['limit'])
  const metadata: CronBridgeLogMetadata = {
    method: request.method.trim().toUpperCase(),
    operation: route?.kind || 'not_cron',
    path: routeLogPath(route),
    queryKeys: [...new Set(
      [...(request.searchParams || new URLSearchParams()).keys()]
        .map(key => safeQueryKeys.has(key) ? key : 'unsupported')
    )]
      .sort()
      .slice(0, 20),
    bodyFields: body
      ? [...new Set(
          Object.keys(body).map(key => safeBodyFields.has(key) ? key : 'unsupported')
        )].sort().slice(0, 20)
      : []
  }
  const bodyBytes = safeByteLength(request.body)
  if (bodyBytes !== undefined) metadata.bodyBytes = bodyBytes
  if (route && 'jobId' in route && isJobId(route.jobId)) metadata.jobId = route.jobId
  if (route && 'runId' in route && isRunId(route.runId)) metadata.runId = route.runId
  return metadata
}

function routeLogPath(route: CronRoute | null): string {
  if (!route) return '/bridge/cron/<unknown>'
  if (route.kind === 'jobs') return '/bridge/cron/jobs'
  if (route.kind === 'job') return '/bridge/cron/jobs/:jobId'
  if (route.kind === 'action') return `/bridge/cron/jobs/:jobId/actions/${route.action}`
  if (route.kind === 'runs') return '/bridge/cron/jobs/:jobId/runs'
  if (route.kind === 'run') return '/bridge/cron/jobs/:jobId/runs/:runId'
  return '/bridge/cron/<unknown>'
}

function matchCronRoute(pathname: string): CronRoute | null {
  if (pathname !== '/bridge/cron' && !pathname.startsWith('/bridge/cron/')) return null
  if (pathname === '/bridge/cron/jobs') return { kind: 'jobs' }

  const actionMatch = pathname.match(/^\/bridge\/cron\/jobs\/([^/]+)\/actions\/(pause|resume|run)$/)
  if (actionMatch) {
    return {
      kind: 'action',
      jobId: decodeAndValidateJobId(actionMatch[1]),
      action: actionMatch[2] as 'pause' | 'resume' | 'run'
    }
  }

  const runMatch = pathname.match(/^\/bridge\/cron\/jobs\/([^/]+)\/runs\/([^/]+)$/)
  if (runMatch) {
    return {
      kind: 'run',
      jobId: decodeAndValidateJobId(runMatch[1]),
      runId: decodeAndValidateRunId(runMatch[2])
    }
  }

  const runsMatch = pathname.match(/^\/bridge\/cron\/jobs\/([^/]+)\/runs$/)
  if (runsMatch) {
    return { kind: 'runs', jobId: decodeAndValidateJobId(runsMatch[1]) }
  }

  const jobMatch = pathname.match(/^\/bridge\/cron\/jobs\/([^/]+)$/)
  if (jobMatch) {
    return { kind: 'job', jobId: decodeAndValidateJobId(jobMatch[1]) }
  }

  return { kind: 'unknown' }
}

function decodeAndValidateJobId(value: string): string {
  const decoded = decodePathSegment(value, 'job_id')
  if (!isJobId(decoded)) {
    throw new CronBridgeFailure(bridgeError(400, 'invalid_job_id', 'Invalid Cron job id'))
  }
  return decoded
}

function decodeAndValidateRunId(value: string): string {
  const decoded = decodePathSegment(value, 'run_id')
  if (!isRunId(decoded)) {
    throw new CronBridgeFailure(bridgeError(400, 'invalid_run_id', 'Invalid Cron run id'))
  }
  return decoded
}

function decodePathSegment(value: string, field: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new CronBridgeFailure(bridgeError(400, `invalid_${field}`, `Invalid Cron ${field}`))
  }
}

function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value) && value !== '.' && value !== '..'
}

function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value) && value !== '.' && value !== '..' && value.endsWith('.md')
}

function validateCreateBody(body: unknown): {
  upstream: Record<string, unknown>
  enabled?: boolean
} {
  const input = requireBodyRecord(body)
  assertOnlyBodyFields(input, ['name', 'prompt', 'schedule', 'enabled', 'deliver'])
  const prompt = requiredText(input.prompt, 'prompt', MAX_PROMPT_INPUT_LENGTH)
  const schedule = requiredText(input.schedule, 'schedule', MAX_SCHEDULE_LENGTH)
  const name = requiredText(input.name, 'name', MAX_NAME_LENGTH)
  const enabled = optionalBoolean(input.enabled, 'enabled')
  const deliver = localDelivery(input.deliver)
  return {
    upstream: {
      prompt,
      schedule,
      name,
      deliver
    },
    enabled
  }
}

function validateUpdateBody(body: unknown): {
  upstream: Record<string, unknown>
  enabled?: boolean
} {
  const input = requireBodyRecord(body)
  assertOnlyBodyFields(input, ['name', 'prompt', 'schedule', 'enabled', 'deliver'])
  if (!Object.keys(input).length) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', 'Cron update requires at least one field'))
  }
  const upstream: Record<string, unknown> = {}
  if ('name' in input) upstream.name = optionalName(input.name) ?? ''
  if ('prompt' in input) upstream.prompt = requiredText(input.prompt, 'prompt', MAX_PROMPT_INPUT_LENGTH)
  if ('schedule' in input) upstream.schedule = requiredText(input.schedule, 'schedule', MAX_SCHEDULE_LENGTH)
  if ('deliver' in input) upstream.deliver = localDelivery(input.deliver)
  const enabled = 'enabled' in input ? optionalBoolean(input.enabled, 'enabled') : undefined
  return { upstream, enabled }
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value)
  if (!record) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', 'Cron request body must be a JSON object'))
  }
  return record
}

function assertEmptyBody(value: unknown): void {
  if (value === undefined || value === null) return
  const record = requireBodyRecord(value)
  if (Object.keys(record).length) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', 'This Cron operation does not accept a body'))
  }
}

function assertOnlyBodyFields(input: Record<string, unknown>, allowed: string[]): void {
  const allowedFields = new Set(allowed)
  const unknown = Object.keys(input).filter(key => !allowedFields.has(key))
  if (unknown.length) {
    throw new CronBridgeFailure(bridgeError(
      400,
      'validation_error',
      `Unsupported Cron request field: ${unknown.sort()[0]}`
    ))
  }
}

function assertOnlyQueryKeys(searchParams: URLSearchParams, allowed: string[]): void {
  const allowedKeys = new Set(allowed)
  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      throw new CronBridgeFailure(bridgeError(400, 'validation_error', `Unsupported Cron query field: ${key}`))
    }
    if (searchParams.getAll(key).length > 1) {
      throw new CronBridgeFailure(bridgeError(400, 'validation_error', `Cron query field must be unique: ${key}`))
    }
  }
}

function parseRunLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get('limit')
  if (raw === null || raw === '') return DEFAULT_RUN_LIMIT
  if (!/^\d+$/.test(raw)) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', 'Cron run limit must be a positive integer'))
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', 'Cron run limit must be a positive integer'))
  }
  return Math.min(value, MAX_RUN_LIMIT)
}

function requiredText(
  value: unknown,
  field: string,
  maxLengthOrBytes: number,
  byteLimit = false
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', `Cron ${field} is required`))
  }
  const normalized = value.trim()
  const size = byteLimit ? Buffer.byteLength(normalized, 'utf8') : normalized.length
  if (size > maxLengthOrBytes) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', `Cron ${field} is too large`))
  }
  return normalized
}

function optionalName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', 'Cron name must be text'))
  }
  const normalized = value.trim()
  if (normalized.length > MAX_NAME_LENGTH) {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', 'Cron name is too large'))
  }
  return normalized
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new CronBridgeFailure(bridgeError(400, 'validation_error', `Cron ${field} must be a boolean`))
  }
  return value
}

function localDelivery(value: unknown): 'local' {
  const deliver = value === undefined || value === null ? 'local' : value
  if (deliver !== 'local') {
    throw new CronBridgeFailure(bridgeError(
      400,
      'unsupported_delivery',
      'This Hermes Hub release supports local Cron delivery only'
    ))
  }
  return 'local'
}

function requireSuccessPayload(
  response: CronUpstreamResponse,
  operation: string
): Record<string, unknown> {
  const payload = parseUpstreamRecord(response.body)
  if (payload?.cron_unavailable === true || isFeatureUnavailablePayload(payload)) {
    throw featureUnavailable()
  }
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404) {
      if (operation.includes('list') || !isJobOrRunNotFoundPayload(payload)) {
        throw featureUnavailable()
      }
      throw new CronBridgeFailure(bridgeError(404, 'not_found', 'Cron job or run not found'))
    }
    if (response.status === 409) {
      throw new CronBridgeFailure(bridgeError(409, 'conflict', 'The Cron request conflicts with current host state'))
    }
    if (response.status === 400 || response.status === 422) {
      throw new CronBridgeFailure(bridgeError(400, 'upstream_rejected', 'Hermes rejected the Cron request'))
    }
    throw new CronBridgeFailure(bridgeError(502, 'upstream_error', 'Hermes could not complete the Cron request'))
  }
  if (!payload) throw invalidUpstreamResponse()
  return payload
}

function normalizeMutationJob(payload: Record<string, unknown>): CronJobDto {
  const raw = asRecord(payload.job)
  const job = raw ? normalizeCronJob(raw) : null
  if (!job) throw invalidUpstreamResponse()
  return job
}

function normalizeCronJob(raw: Record<string, unknown>): CronJobDto | null {
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!isJobId(id)) return null
  const rawPrompt = typeof raw.prompt === 'string' ? raw.prompt : ''
  const prompt = truncateUtf8(rawPrompt, MAX_PROMPT_BYTES)
  const deliver = optionalShortString(raw.deliver, 64) || 'local'
  const scriptJob = typeof raw.script === 'string' && Boolean(raw.script.trim())
  const state = optionalShortString(raw.state, 64)
  const manageable = deliver === 'local' && !scriptJob
  return {
    id,
    name: optionalShortString(raw.name, MAX_NAME_LENGTH),
    prompt: prompt.value,
    prompt_truncated: prompt.truncated,
    schedule: normalizeSchedule(raw.schedule),
    schedule_display: optionalShortString(raw.schedule_display, MAX_SCHEDULE_LENGTH),
    enabled: typeof raw.enabled === 'boolean'
      ? raw.enabled
      : state !== 'paused' && state !== 'disabled',
    deliver,
    kind: scriptJob ? 'script' : 'prompt',
    manageable,
    executable: manageable,
    state,
    next_run_at: optionalShortString(raw.next_run_at, 128),
    last_run_at: optionalShortString(raw.last_run_at, 128),
    last_status: optionalShortString(raw.last_status, 64),
    last_error_category: typeof raw.last_error === 'string' && raw.last_error.trim()
      ? categorizeError(raw.last_error)
      : null
  }
}

function normalizeSchedule(value: unknown): string | CronJobScheduleDto | null {
  if (typeof value === 'string') return value.slice(0, MAX_SCHEDULE_LENGTH)
  const input = asRecord(value)
  if (!input) return null
  const output: CronJobScheduleDto = {}
  const kind = optionalShortString(input.kind, 64)
  const expr = optionalShortString(input.expr, MAX_SCHEDULE_LENGTH)
  const display = optionalShortString(input.display, MAX_SCHEDULE_LENGTH)
  if (kind !== null) output.kind = kind
  if (expr !== null) output.expr = expr
  if (display !== null) output.display = display
  return output
}

function parseUpstreamRecord(value: unknown): Record<string, unknown> | null {
  if (Buffer.isBuffer(value)) {
    if (!value.length) return null
    try {
      return asRecord(JSON.parse(value.toString('utf8')) as unknown)
    } catch {
      return null
    }
  }
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  return asRecord(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalShortString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return { value, truncated: false }
  let end = Math.max(0, maxBytes)
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { value: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

function safeByteLength(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (Buffer.isBuffer(value)) return value.length
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? undefined : Buffer.byteLength(encoded, 'utf8')
  } catch {
    return undefined
  }
}

function queryKeysFromPath(path: string): string[] {
  const queryIndex = path.indexOf('?')
  if (queryIndex < 0) return []
  return [...new Set([...new URLSearchParams(path.slice(queryIndex + 1)).keys()])].sort().slice(0, 20)
}

function categorizeError(value: string): CronErrorCategory {
  const normalized = value.toLowerCase()
  if (/unavailable|no module|cannot find module|not installed/.test(normalized)) return 'feature_unavailable'
  if (/unauthori[sz]ed|forbidden|credential|auth/.test(normalized)) return 'authentication'
  if (/timeout|timed out|deadline/.test(normalized)) return 'timeout'
  if (/already|conflict|running/.test(normalized)) return 'conflict'
  if (/not found|missing/.test(normalized)) return 'not_found'
  if (/invalid|required|validation/.test(normalized)) return 'validation'
  return 'upstream'
}

function isFeatureUnavailablePayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false
  const error = typeof payload.error === 'string' ? payload.error : ''
  return /cron.{0,40}(unavailable|not available|not installed|no module|cannot find module)|no module named.{0,20}cron/i.test(error)
}

function isJobOrRunNotFoundPayload(payload: Record<string, unknown> | null): boolean {
  if (!payload || typeof payload.error !== 'string') return false
  return /\b(?:cron\s+)?(?:job|run)\s+not\s+found\b/i.test(payload.error)
}

function featureUnavailable(): CronBridgeFailure {
  return new CronBridgeFailure(bridgeError(
    503,
    'feature_unavailable',
    'Cron is unavailable on the connected Hermes host'
  ))
}

function unsupportedCronRunHistory(): CronBridgeFailure {
  return new CronBridgeFailure(bridgeError(
    501,
    'feature_unsupported',
    'Cron run history is not exposed by the Hermes Gateway API'
  ))
}

function invalidUpstreamResponse(): CronBridgeFailure {
  return new CronBridgeFailure(bridgeError(
    502,
    'invalid_upstream_response',
    'Hermes returned an invalid Cron response'
  ))
}

function methodNotAllowed(allowed: string): CronBridgeFailure {
  return new CronBridgeFailure({
    status: 405,
    body: { error: 'Method not allowed for this Cron operation', code: 'method_not_allowed', allowed }
  })
}

function bridgeError(status: number, code: string, error: string): CronBridgeResponse {
  return { status, body: { error, code } }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}
