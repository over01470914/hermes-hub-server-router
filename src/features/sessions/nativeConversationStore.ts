import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { logRouter } from '../../core/observability/routerLogger.js'
import { writePrivateTextFileAtomicSync } from '../../core/persistence/privateStateFile.js'
import type { NativeSessionLineage } from './sessionLineage.js'

export type NativeSubmissionState = 'pending' | 'accepted' | 'ambiguous' | 'failed'

export interface NativeConversationRecord {
  hermesAgentId: string
  conversationId: string
  laneId: string
  sessionId?: string
  lineageRootSessionId?: string
  lineageSessionIds?: string[]
  lineagePathSessionIds?: string[]
  supersededByConversationId?: string
  native: boolean
  readOnly: boolean
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
  lineageReconciledAgentIds?: unknown
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
  private readonly lineageReconciledAgentIds = new Set<string>()

  constructor(private readonly path: string) {
    this.load()
  }

  resolveConversation(hermesAgentId: string, conversationId?: string): NativeConversationRecord {
    this.assertAgentId(hermesAgentId)
    if (conversationId) {
      const existing = this.getByConversationId(hermesAgentId, conversationId)
      if (existing) return existing
      if (!conversationPattern.test(conversationId)) throw this.validationError('conversationId is invalid')
      throw Object.assign(new Error('Native conversation was not found'), { code: 'conversation_not_found', statusCode: 404 })
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

  adoptExternalSession(hermesAgentId: string, sessionId: string): NativeConversationRecord {
    this.assertAgentId(hermesAgentId)
    if (!idPattern.test(sessionId)) throw this.validationError('external session id is invalid')
    const existing = this.getByConversationId(hermesAgentId, sessionId)
    if (existing) return existing
    const now = new Date().toISOString()
    const created: NativeConversationRecord = {
      hermesAgentId,
      conversationId: sessionId,
      laneId: `lane_${randomUUID()}`,
      sessionId,
      native: false,
      readOnly: true,
      createdAt: now,
      updatedAt: now,
    }
    this.conversations.set(this.conversationKey(hermesAgentId, created.conversationId), created)
    this.lanes.set(this.laneKey(hermesAgentId, created.laneId), created)
    this.save()
    return created
  }

  ensureForSessions(hermesAgentId: string, sessionIds: Iterable<string>): NativeConversationRecord[] {
    this.assertAgentId(hermesAgentId)
    const knownSessionIds = new Set(
      [...this.conversations.values()]
        .filter(record => record.hermesAgentId === hermesAgentId)
        .flatMap(record => [
          ...(record.sessionId ? [record.sessionId] : []),
          ...(record.lineageSessionIds || []),
        ]),
    )
    let changed = false
    for (const sessionId of sessionIds) {
      if (!idPattern.test(sessionId) || knownSessionIds.has(sessionId)) continue
      const now = new Date().toISOString()
      const created: NativeConversationRecord = {
        hermesAgentId,
        conversationId: `conv_${randomUUID()}`,
        laneId: `lane_${randomUUID()}`,
        sessionId,
        native: true,
        readOnly: false,
        createdAt: now,
        updatedAt: now,
      }
      this.conversations.set(this.conversationKey(hermesAgentId, created.conversationId), created)
      this.lanes.set(this.laneKey(hermesAgentId, created.laneId), created)
      knownSessionIds.add(sessionId)
      changed = true
    }
    if (changed) this.save()
    return this.list(hermesAgentId)
  }

  reconcileSessionLineages(
    hermesAgentId: string,
    lineages: Iterable<NativeSessionLineage>,
  ): NativeConversationRecord[] {
    this.assertAgentId(hermesAgentId)
    let changed = false
    for (const rawLineage of lineages) {
      const lineage = this.cleanLineage(rawLineage)
      if (!lineage) continue
      const lineageIds = new Set(lineage.allSessionIds)
      const candidates = [...this.conversations.values()].filter(record => (
        record.hermesAgentId === hermesAgentId
        && (
          (record.sessionId ? lineageIds.has(record.sessionId) : false)
          || (record.lineageSessionIds || []).some(sessionId => lineageIds.has(sessionId))
        )
      ))

      const canonicalCandidates = [...new Map(candidates.flatMap(record => {
        const resolved = this.getByConversationId(hermesAgentId, record.conversationId)
        return resolved ? [[resolved.conversationId, resolved] as const] : []
      })).values()]
      let canonical = canonicalCandidates
        .sort((left, right) => {
          const leftOwnsRoot = left.sessionId === lineage.rootSessionId
            || left.lineageRootSessionId === lineage.rootSessionId
          const rightOwnsRoot = right.sessionId === lineage.rootSessionId
            || right.lineageRootSessionId === lineage.rootSessionId
          if (leftOwnsRoot !== rightOwnsRoot) return leftOwnsRoot ? -1 : 1
          return left.createdAt.localeCompare(right.createdAt)
        })[0]

      if (!canonical) {
        const now = new Date().toISOString()
        canonical = {
          hermesAgentId,
          conversationId: `conv_${randomUUID()}`,
          laneId: `lane_${randomUUID()}`,
          sessionId: lineage.tipSessionId,
          lineageRootSessionId: lineage.rootSessionId,
          lineageSessionIds: lineage.allSessionIds,
          lineagePathSessionIds: lineage.pathSessionIds,
          native: true,
          readOnly: false,
          createdAt: now,
          updatedAt: now,
        }
        this.conversations.set(this.conversationKey(hermesAgentId, canonical.conversationId), canonical)
        this.lanes.set(this.laneKey(hermesAgentId, canonical.laneId), canonical)
        changed = true
      }

      // A directory response can race a live predecessor-linked rotation. If
      // this record already owns the same lineage but its current tip is absent
      // from the response, retain the newer live binding until a later
      // authoritative list includes it. Legacy migration still advances an
      // unmigrated parent/child because that current id is present in the
      // incoming lineage.
      const canonicalTipSessionId = canonical.lineageRootSessionId === lineage.rootSessionId
        && canonical.sessionId
        && !lineageIds.has(canonical.sessionId)
        ? canonical.sessionId
        : lineage.tipSessionId
      const canonicalLineageIds = this.uniqueSessionIds([
        ...(canonical.lineageSessionIds || []),
        ...lineage.allSessionIds,
        canonicalTipSessionId,
      ])
      const canonicalPathIds = canonicalTipSessionId === lineage.tipSessionId
        ? this.uniqueSessionIds(lineage.pathSessionIds)
        : this.uniqueSessionIds([
            ...(canonical.lineagePathSessionIds || lineage.pathSessionIds),
            canonicalTipSessionId,
          ])
      const canonicalChanged = canonical.sessionId !== canonicalTipSessionId
        || canonical.lineageRootSessionId !== lineage.rootSessionId
        || JSON.stringify(canonical.lineageSessionIds || []) !== JSON.stringify(canonicalLineageIds)
        || JSON.stringify(canonical.lineagePathSessionIds || []) !== JSON.stringify(canonicalPathIds)
        || Boolean(canonical.supersededByConversationId)
      if (canonicalChanged) {
        canonical = {
          ...canonical,
          sessionId: canonicalTipSessionId,
          lineageRootSessionId: lineage.rootSessionId,
          lineageSessionIds: canonicalLineageIds,
          lineagePathSessionIds: canonicalPathIds,
          updatedAt: this.nextUpdatedAt(canonical.updatedAt),
        }
        delete canonical.supersededByConversationId
        this.conversations.set(this.conversationKey(hermesAgentId, canonical.conversationId), canonical)
        changed = true
      }
      this.lanes.set(this.laneKey(hermesAgentId, canonical.laneId), canonical)

      for (const candidate of candidates) {
        if (candidate.conversationId === canonical.conversationId) continue
        const aliasChanged = candidate.sessionId !== canonicalTipSessionId
          || candidate.lineageRootSessionId !== lineage.rootSessionId
          || JSON.stringify(candidate.lineageSessionIds || []) !== JSON.stringify(canonicalLineageIds)
          || JSON.stringify(candidate.lineagePathSessionIds || []) !== JSON.stringify(canonicalPathIds)
          || candidate.supersededByConversationId !== canonical.conversationId
        const alias: NativeConversationRecord = aliasChanged
          ? {
              ...candidate,
              sessionId: canonicalTipSessionId,
              lineageRootSessionId: lineage.rootSessionId,
              lineageSessionIds: canonicalLineageIds,
              lineagePathSessionIds: canonicalPathIds,
              supersededByConversationId: canonical.conversationId,
              updatedAt: this.nextUpdatedAt(candidate.updatedAt),
            }
          : candidate
        if (aliasChanged) {
          this.conversations.set(this.conversationKey(hermesAgentId, alias.conversationId), alias)
          changed = true
        }
        // Existing clients may still address the alias lane until their next
        // list/hydration pass. Resolve it to the canonical conversation without
        // deleting the old lane or Router conversation id.
        this.lanes.set(this.laneKey(hermesAgentId, alias.laneId), canonical)
      }

      const candidateConversationIds = new Set(candidates.map(candidate => candidate.conversationId))
      candidateConversationIds.add(canonical.conversationId)
      for (const [key, submission] of this.submissions) {
        if (submission.hermesAgentId !== hermesAgentId) continue
        if (!candidateConversationIds.has(submission.conversationId)) continue
        if (
          submission.conversationId === canonical.conversationId
          && submission.sessionId === canonicalTipSessionId
        ) continue
        const updated = {
          ...submission,
          conversationId: canonical.conversationId,
          sessionId: canonicalTipSessionId,
          updatedAt: this.nextUpdatedAt(submission.updatedAt),
        }
        this.submissions.set(key, updated)
        changed = true
      }
      for (const [key, prompt] of this.prompts) {
        if (prompt.hermesAgentId !== hermesAgentId) continue
        if (!candidateConversationIds.has(prompt.conversationId)) continue
        if (
          prompt.conversationId === canonical.conversationId
          && prompt.sessionId === canonicalTipSessionId
        ) continue
        this.prompts.set(key, {
          ...prompt,
          conversationId: canonical.conversationId,
          sessionId: canonicalTipSessionId,
          updatedAt: this.nextUpdatedAt(prompt.updatedAt),
        })
        changed = true
      }
    }
    if (changed) this.save()
    return this.list(hermesAgentId)
  }

  needsLegacyLineageReconciliation(hermesAgentId: string): boolean {
    this.assertAgentId(hermesAgentId)
    return !this.lineageReconciledAgentIds.has(hermesAgentId)
  }

  markLegacyLineageReconciled(hermesAgentId: string): void {
    this.assertAgentId(hermesAgentId)
    if (this.lineageReconciledAgentIds.has(hermesAgentId)) return
    this.lineageReconciledAgentIds.add(hermesAgentId)
    this.save()
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
      const existingConversation = this.resolveConversation(hermesAgentId, existing.conversationId)
      const requestedConversation = conversationId
        ? this.resolveConversation(hermesAgentId, conversationId)
        : undefined
      if (requestedConversation && existingConversation.conversationId !== requestedConversation.conversationId) {
        throw Object.assign(new Error('submissionId is already bound to another conversation'), {
          code: 'submission_conflict',
          statusCode: 409,
        })
      }
      return { conversation: existingConversation, submission: existing, duplicate: true }
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
    const conversation = this.getByLane(hermesAgentId, existing.laneId)
    const requestedSessionId = options.sessionId && idPattern.test(options.sessionId)
      ? options.sessionId
      : undefined
    // Submission acknowledgements bind an unresolved lane or confirm its
    // current native tip.  Only a predecessor-linked session event may rotate
    // an already-bound lane, so a late parent acknowledgement cannot undo a
    // compression continuation adopted by acceptSessionEvent().
    const acceptedSessionId = requestedSessionId && (
      !conversation?.sessionId || conversation.sessionId === requestedSessionId
    )
      ? requestedSessionId
      : conversation?.sessionId || existing.sessionId
    const updated: NativeSubmissionRecord = {
      ...existing,
      state,
      ...(acceptedSessionId ? { sessionId: acceptedSessionId } : {}),
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.submissions.set(key, updated)
    if (acceptedSessionId) this.updateConversationSession(hermesAgentId, existing.laneId, acceptedSessionId, false)
    this.save()
    return updated
  }

  acceptSessionEvent(
    hermesAgentId: string,
    laneId: string,
    sessionId?: string,
    previousSessionId?: string,
  ): NativeConversationRecord | undefined {
    const laneKey = this.laneKey(hermesAgentId, laneId)
    const conversation = this.lanes.get(laneKey)
    if (!conversation) return undefined
    const requestedSessionId = sessionId && idPattern.test(sessionId) ? sessionId : undefined
    const rotationPredecessor = previousSessionId && idPattern.test(previousSessionId)
      ? previousSessionId
      : undefined
    const acceptedSessionId = !requestedSessionId
      ? conversation.sessionId
      : !conversation.sessionId || requestedSessionId === conversation.sessionId
        ? requestedSessionId
        : rotationPredecessor === conversation.sessionId
          ? requestedSessionId
          : conversation.sessionId
    const rotated = Boolean(
      requestedSessionId
      && conversation.sessionId
      && requestedSessionId !== conversation.sessionId
      && rotationPredecessor === conversation.sessionId
      && acceptedSessionId === requestedSessionId,
    )
    const lineageRootSessionId = rotated
      ? conversation.lineageRootSessionId || conversation.sessionId
      : conversation.lineageRootSessionId
    const lineageSessionIds = rotated
      ? this.uniqueSessionIds([
          ...(conversation.lineageSessionIds || []),
          conversation.sessionId!,
          requestedSessionId!,
        ])
      : conversation.lineageSessionIds
    const lineagePathSessionIds = rotated
      ? this.uniqueSessionIds([
          ...(conversation.lineagePathSessionIds || [conversation.sessionId!]),
          requestedSessionId!,
        ])
      : conversation.lineagePathSessionIds
    const updated: NativeConversationRecord = {
      ...conversation,
      ...(acceptedSessionId ? { sessionId: acceptedSessionId } : {}),
      ...(lineageRootSessionId ? { lineageRootSessionId } : {}),
      ...(lineageSessionIds ? { lineageSessionIds } : {}),
      ...(lineagePathSessionIds ? { lineagePathSessionIds } : {}),
      updatedAt: this.nextUpdatedAt(conversation.updatedAt),
    }
    this.conversations.set(this.conversationKey(hermesAgentId, conversation.conversationId), updated)
    this.refreshConversationLanes(updated)
    this.save()
    return updated
  }

  getByConversationId(hermesAgentId: string, conversationId: string): NativeConversationRecord | undefined {
    let current = this.conversations.get(this.conversationKey(hermesAgentId, conversationId))
    const seen = new Set<string>()
    while (current?.supersededByConversationId && !seen.has(current.conversationId)) {
      seen.add(current.conversationId)
      current = this.conversations.get(
        this.conversationKey(hermesAgentId, current.supersededByConversationId),
      )
    }
    return current
  }

  getByLane(hermesAgentId: string, laneId: string): NativeConversationRecord | undefined {
    const record = this.lanes.get(this.laneKey(hermesAgentId, laneId))
    return record ? this.getByConversationId(hermesAgentId, record.conversationId) : undefined
  }

  getBySessionId(hermesAgentId: string, sessionId: string): NativeConversationRecord | undefined {
    return [...this.conversations.values()]
      .filter(record => record.hermesAgentId === hermesAgentId && !record.supersededByConversationId)
      .filter(record => record.sessionId === sessionId || record.lineageSessionIds?.includes(sessionId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  }

  getSubmission(hermesAgentId: string, submissionId: string): NativeSubmissionRecord | undefined {
    return this.submissions.get(this.submissionKey(hermesAgentId, submissionId))
  }

  list(hermesAgentId: string): NativeConversationRecord[] {
    return [...this.conversations.values()]
      .filter(record => record.hermesAgentId === hermesAgentId && !record.supersededByConversationId)
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
    this.conversations.set(this.conversationKey(hermesAgentId, existing.conversationId), updated)
    this.refreshConversationLanes(updated)
    if (save) this.save()
  }

  private refreshConversationLanes(conversation: NativeConversationRecord): void {
    for (const [key, laneConversation] of this.lanes) {
      if (
        laneConversation.hermesAgentId === conversation.hermesAgentId
        && laneConversation.conversationId === conversation.conversationId
      ) {
        this.lanes.set(key, conversation)
      }
    }
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
      for (const value of Array.isArray(parsed.lineageReconciledAgentIds)
        ? parsed.lineageReconciledAgentIds
        : []) {
        if (typeof value === 'string' && /^agent_[A-Za-z0-9._:-]{2,154}$/.test(value)) {
          this.lineageReconciledAgentIds.add(value)
        }
      }
      for (const value of Array.isArray(parsed.conversations) ? parsed.conversations : []) {
        const record = this.cleanConversation(value)
        if (!record) continue
        this.conversations.set(this.conversationKey(record.hermesAgentId, record.conversationId), record)
        this.lanes.set(this.laneKey(record.hermesAgentId, record.laneId), record)
      }
      for (const record of this.conversations.values()) {
        if (!record.supersededByConversationId) continue
        const canonical = this.getByConversationId(record.hermesAgentId, record.conversationId)
        if (canonical) this.lanes.set(this.laneKey(record.hermesAgentId, record.laneId), canonical)
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
      logRouter('warn', 'session.conversation_store.load_failed', 'Native conversation state could not be restored from disk.', {
        outcome: 'failed',
        errorCode: 'native_conversation_store_load_failed',
        nextAction: 'start_with_empty_conversation_state',
      }, error)
    }
  }

  private save(): void {
    const compare = (left: { hermesAgentId: string; createdAt: string }, right: { hermesAgentId: string; createdAt: string }) => (
      left.hermesAgentId.localeCompare(right.hermesAgentId) || left.createdAt.localeCompare(right.createdAt)
    )
    writePrivateTextFileAtomicSync(this.path, `${JSON.stringify({
      schemaVersion: 1,
      lineageReconciledAgentIds: [...this.lineageReconciledAgentIds].sort(),
      conversations: [...this.conversations.values()].sort(compare),
      submissions: [...this.submissions.values()].sort(compare),
      prompts: [...this.prompts.values()].sort(compare),
    }, null, 2)}\n`)
  }

  private cleanConversation(value: unknown): NativeConversationRecord | undefined {
    const record = this.record(value)
    const storedConversationId = String(record?.conversationId || '')
    const validConversationId = record?.native === false
      ? idPattern.test(storedConversationId)
      : conversationPattern.test(storedConversationId)
    if (!record || !idPattern.test(String(record.hermesAgentId || '')) || !validConversationId || !lanePattern.test(String(record.laneId || ''))) return undefined
    const {
      lineageRootSessionId: _rawLineageRootSessionId,
      lineageSessionIds: _rawLineageSessionIds,
      lineagePathSessionIds: _rawLineagePathSessionIds,
      supersededByConversationId: _rawSupersededByConversationId,
      ...baseRecord
    } = record
    const lineageSessionIds = this.cleanSessionIds(record.lineageSessionIds)
    const lineagePathSessionIds = this.cleanSessionIds(record.lineagePathSessionIds)
    const lineageRootSessionId = idPattern.test(String(record.lineageRootSessionId || ''))
      ? String(record.lineageRootSessionId)
      : undefined
    const supersededByConversationId = conversationPattern.test(String(record.supersededByConversationId || ''))
      ? String(record.supersededByConversationId)
      : undefined
    return {
      ...(baseRecord as unknown as NativeConversationRecord),
      ...(lineageRootSessionId ? { lineageRootSessionId } : {}),
      ...(lineageSessionIds.length > 0 ? { lineageSessionIds } : {}),
      ...(lineagePathSessionIds.length > 0 ? { lineagePathSessionIds } : {}),
      ...(supersededByConversationId ? { supersededByConversationId } : {}),
    }
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

  private cleanLineage(value: NativeSessionLineage): NativeSessionLineage | undefined {
    const rootSessionId = idPattern.test(String(value.rootSessionId || '')) ? value.rootSessionId : ''
    const tipSessionId = idPattern.test(String(value.tipSessionId || '')) ? value.tipSessionId : ''
    const allSessionIds = this.uniqueSessionIds(value.allSessionIds || [])
    const pathSessionIds = this.uniqueSessionIds(value.pathSessionIds || [])
    if (!rootSessionId || !tipSessionId || !allSessionIds.includes(tipSessionId)) return undefined
    return {
      rootSessionId,
      tipSessionId,
      allSessionIds: this.uniqueSessionIds([rootSessionId, ...allSessionIds]),
      pathSessionIds: this.uniqueSessionIds([rootSessionId, ...pathSessionIds, tipSessionId]),
    }
  }

  private cleanSessionIds(value: unknown): string[] {
    return Array.isArray(value)
      ? this.uniqueSessionIds(value.filter((item): item is string => typeof item === 'string'))
      : []
  }

  private uniqueSessionIds(values: Iterable<string>): string[] {
    return [...new Set([...values].filter(value => idPattern.test(value)))].slice(0, 128)
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
