import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { logRouter } from '../../core/observability/routerLogger.js'
import { writePrivateTextFileAtomicSync } from '../../core/persistence/privateStateFile.js'

export type NativeSubmissionState = 'pending' | 'accepted' | 'ambiguous' | 'failed'

export interface NativeConversationRecord {
  hermesAgentId: string
  conversationId: string
  laneId: string
  sessionId?: string
  native: true
  readOnly: false
  createdAt: string
  updatedAt: string
}

export interface NativeSubmissionRecord {
  hermesAgentId: string
  submissionId: string
  conversationId: string
  laneId: string
  sessionId?: string
  state: NativeSubmissionState
  errorCode?: string
  createdAt: string
  updatedAt: string
}

export interface NativePromptRecord {
  hermesAgentId: string
  promptId: string
  conversationId: string
  laneId: string
  sessionId?: string
  status: 'pending' | 'resolved'
  createdAt: string
  updatedAt: string
}

interface NativeConversationStoreFile {
  schemaVersion?: unknown
  conversations?: unknown
  submissions?: unknown
  prompts?: unknown
}

const idPattern = /^[A-Za-z0-9._:-]{3,200}$/
const conversationPattern = /^conv_[A-Za-z0-9._:-]{8,191}$/
const lanePattern = /^lane_[A-Za-z0-9._:-]{8,191}$/
const submissionPattern = /^sub_[A-Za-z0-9._:-]{8,191}$/
const promptPattern = /^prompt_[A-Za-z0-9._:-]{8,191}$/

export class NativeConversationStore {
  private readonly conversations = new Map<string, NativeConversationRecord>()
  private readonly lanes = new Map<string, NativeConversationRecord>()
  private readonly submissions = new Map<string, NativeSubmissionRecord>()
  private readonly prompts = new Map<string, NativePromptRecord>()

  constructor(private readonly path: string) {
    this.load()
  }

  resolveConversation(hermesAgentId: string, conversationId?: string): NativeConversationRecord {
    this.assertAgentId(hermesAgentId)
    if (conversationId) {
      if (!conversationPattern.test(conversationId)) throw this.validationError('conversationId is invalid')
      const existing = this.conversations.get(this.conversationKey(hermesAgentId, conversationId))
      if (!existing) throw Object.assign(new Error('Native conversation was not found'), { code: 'conversation_not_found', statusCode: 404 })
      return existing
    }
    const now = new Date().toISOString()
    const created: NativeConversationRecord = {
      hermesAgentId,
      conversationId: `conv_${randomUUID()}`,
      laneId: `lane_${randomUUID()}`,
      native: true,
      readOnly: false,
      createdAt: now,
      updatedAt: now,
    }
    this.conversations.set(this.conversationKey(hermesAgentId, created.conversationId), created)
    this.lanes.set(this.laneKey(hermesAgentId, created.laneId), created)
    this.save()
    return created
  }

  beginSubmission(
    hermesAgentId: string,
    submissionId: string,
    conversationId?: string,
  ): { conversation: NativeConversationRecord; submission: NativeSubmissionRecord; duplicate: boolean } {
    this.assertAgentId(hermesAgentId)
    if (!submissionPattern.test(submissionId)) throw this.validationError('submissionId is invalid')
    const existing = this.submissions.get(this.submissionKey(hermesAgentId, submissionId))
    if (existing) {
      if (conversationId && existing.conversationId !== conversationId) {
        throw Object.assign(new Error('submissionId is already bound to another conversation'), {
          code: 'submission_conflict',
          statusCode: 409,
        })
      }
      const conversation = this.resolveConversation(hermesAgentId, existing.conversationId)
      return { conversation, submission: existing, duplicate: true }
    }
    const conversation = this.resolveConversation(hermesAgentId, conversationId)
    const now = new Date().toISOString()
    const submission: NativeSubmissionRecord = {
      hermesAgentId,
      submissionId,
      conversationId: conversation.conversationId,
      laneId: conversation.laneId,
      ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    this.submissions.set(this.submissionKey(hermesAgentId, submissionId), submission)
    this.save()
    return { conversation, submission, duplicate: false }
  }

  updateSubmission(
    hermesAgentId: string,
    submissionId: string,
    state: NativeSubmissionState,
    options: { sessionId?: string; errorCode?: string } = {},
  ): NativeSubmissionRecord {
    const key = this.submissionKey(hermesAgentId, submissionId)
    const existing = this.submissions.get(key)
    if (!existing) throw Object.assign(new Error('Native submission was not found'), { code: 'submission_not_found', statusCode: 404 })
    const updated: NativeSubmissionRecord = {
      ...existing,
      state,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.submissions.set(key, updated)
    if (options.sessionId) this.updateConversationSession(hermesAgentId, existing.laneId, options.sessionId, false)
    this.save()
    return updated
  }

  acceptSessionEvent(hermesAgentId: string, laneId: string, sessionId?: string): NativeConversationRecord | undefined {
    const laneKey = this.laneKey(hermesAgentId, laneId)
    const conversation = this.lanes.get(laneKey)
    if (!conversation) return undefined
    const acceptedSessionId = sessionId && idPattern.test(sessionId)
      ? sessionId
      : conversation.sessionId
    const updated: NativeConversationRecord = {
      ...conversation,
      ...(acceptedSessionId ? { sessionId: acceptedSessionId } : {}),
      updatedAt: this.nextUpdatedAt(conversation.updatedAt),
    }
    this.lanes.set(laneKey, updated)
    this.conversations.set(this.conversationKey(hermesAgentId, conversation.conversationId), updated)
    this.save()
    return updated
  }

  getByConversationId(hermesAgentId: string, conversationId: string): NativeConversationRecord | undefined {
    return this.conversations.get(this.conversationKey(hermesAgentId, conversationId))
  }

  getByLane(hermesAgentId: string, laneId: string): NativeConversationRecord | undefined {
    return this.lanes.get(this.laneKey(hermesAgentId, laneId))
  }

  getSubmission(hermesAgentId: string, submissionId: string): NativeSubmissionRecord | undefined {
    return this.submissions.get(this.submissionKey(hermesAgentId, submissionId))
  }

  list(hermesAgentId: string): NativeConversationRecord[] {
    return [...this.conversations.values()]
      .filter(record => record.hermesAgentId === hermesAgentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  registerPrompt(
    hermesAgentId: string,
    laneId: string,
    promptId: string,
    sessionId?: string,
  ): NativePromptRecord | undefined {
    if (!promptPattern.test(promptId)) return undefined
    const conversation = this.getByLane(hermesAgentId, laneId)
    if (!conversation) return undefined
    const now = new Date().toISOString()
    const prompt: NativePromptRecord = {
      hermesAgentId,
      promptId,
      conversationId: conversation.conversationId,
      laneId,
      ...(sessionId ? { sessionId } : {}),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    this.prompts.set(this.promptKey(hermesAgentId, promptId), prompt)
    this.save()
    return prompt
  }

  pendingPrompt(hermesAgentId: string, promptId: string): NativePromptRecord | undefined {
    const prompt = this.prompts.get(this.promptKey(hermesAgentId, promptId))
    return prompt?.status === 'pending' ? prompt : undefined
  }

  resolvePrompt(hermesAgentId: string, promptId: string): void {
    const key = this.promptKey(hermesAgentId, promptId)
    const existing = this.prompts.get(key)
    if (!existing) return
    this.prompts.set(key, { ...existing, status: 'resolved', updatedAt: new Date().toISOString() })
    this.save()
  }

  private updateConversationSession(
    hermesAgentId: string,
    laneId: string,
    sessionId: string,
    save: boolean,
  ): void {
    if (!idPattern.test(sessionId)) return
    const laneKey = this.laneKey(hermesAgentId, laneId)
    const existing = this.lanes.get(laneKey)
    if (!existing) return
    const updated = { ...existing, sessionId, updatedAt: this.nextUpdatedAt(existing.updatedAt) }
    this.lanes.set(laneKey, updated)
    this.conversations.set(this.conversationKey(hermesAgentId, existing.conversationId), updated)
    if (save) this.save()
  }

  private nextUpdatedAt(previous: string): string {
    const previousMs = Date.parse(previous)
    const nextMs = Number.isFinite(previousMs)
      ? Math.max(Date.now(), previousMs + 1)
      : Date.now()
    return new Date(nextMs).toISOString()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as NativeConversationStoreFile
      if (parsed.schemaVersion !== 1) throw new Error('unsupported schema')
      for (const value of Array.isArray(parsed.conversations) ? parsed.conversations : []) {
        const record = this.cleanConversation(value)
        if (!record) continue
        this.conversations.set(this.conversationKey(record.hermesAgentId, record.conversationId), record)
        this.lanes.set(this.laneKey(record.hermesAgentId, record.laneId), record)
      }
      for (const value of Array.isArray(parsed.submissions) ? parsed.submissions : []) {
        const record = this.cleanSubmission(value)
        if (record) this.submissions.set(this.submissionKey(record.hermesAgentId, record.submissionId), record)
      }
      for (const value of Array.isArray(parsed.prompts) ? parsed.prompts : []) {
        const record = this.cleanPrompt(value)
        if (record) this.prompts.set(this.promptKey(record.hermesAgentId, record.promptId), record)
      }
    } catch (error) {
      logRouter('warn', 'Native conversation store load failed', { storePath: this.path }, error)
    }
  }

  private save(): void {
    const compare = (left: { hermesAgentId: string; createdAt: string }, right: { hermesAgentId: string; createdAt: string }) => (
      left.hermesAgentId.localeCompare(right.hermesAgentId) || left.createdAt.localeCompare(right.createdAt)
    )
    writePrivateTextFileAtomicSync(this.path, `${JSON.stringify({
      schemaVersion: 1,
      conversations: [...this.conversations.values()].sort(compare),
      submissions: [...this.submissions.values()].sort(compare),
      prompts: [...this.prompts.values()].sort(compare),
    }, null, 2)}\n`)
  }

  private cleanConversation(value: unknown): NativeConversationRecord | undefined {
    const record = this.record(value)
    if (!record || !idPattern.test(String(record.hermesAgentId || '')) || !conversationPattern.test(String(record.conversationId || '')) || !lanePattern.test(String(record.laneId || ''))) return undefined
    return record as unknown as NativeConversationRecord
  }

  private cleanSubmission(value: unknown): NativeSubmissionRecord | undefined {
    const record = this.record(value)
    if (!record || !submissionPattern.test(String(record.submissionId || '')) || !this.getByConversationId(String(record.hermesAgentId || ''), String(record.conversationId || ''))) return undefined
    if (!['pending', 'accepted', 'ambiguous', 'failed'].includes(String(record.state || ''))) return undefined
    return record as unknown as NativeSubmissionRecord
  }

  private cleanPrompt(value: unknown): NativePromptRecord | undefined {
    const record = this.record(value)
    if (!record || !promptPattern.test(String(record.promptId || '')) || !this.getByLane(String(record.hermesAgentId || ''), String(record.laneId || ''))) return undefined
    return record as unknown as NativePromptRecord
  }

  private record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  }

  private assertAgentId(value: string): void {
    if (!/^agent_[A-Za-z0-9._:-]{2,154}$/.test(value)) throw this.validationError('Hermes Agent id is invalid')
  }

  private validationError(message: string): Error {
    return Object.assign(new Error(message), { code: 'validation_error', statusCode: 400 })
  }

  private conversationKey(agentId: string, conversationId: string): string { return `${agentId}\u0000${conversationId}` }
  private laneKey(agentId: string, laneId: string): string { return `${agentId}\u0000${laneId}` }
  private submissionKey(agentId: string, submissionId: string): string { return `${agentId}\u0000${submissionId}` }
  private promptKey(agentId: string, promptId: string): string { return `${agentId}\u0000${promptId}` }
}
