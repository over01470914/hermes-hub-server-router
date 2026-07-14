export type SessionCategoryId =
  | 'all'
  | 'chat-link'
  | 'direct'
  | 'projects'
  | 'agents'
  | 'channels'
  | 'drafts';

export interface SessionMetadataPatch {
  categoryId?: SessionCategoryId;
  category?: SessionCategoryId;
  title?: string;
}

export interface SessionMetadataRecord {
  hermesAgentId: string;
  sessionId: string;
  categoryId?: SessionCategoryId;
  updatedAt: string;
}

const knownCategoryIds = new Set<SessionCategoryId>([
  'all',
  'chat-link',
  'direct',
  'projects',
  'agents',
  'channels',
  'drafts',
]);

export function normalizeMetadataCategory(
  value: unknown,
): SessionCategoryId | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().toLowerCase() as SessionCategoryId;
  return knownCategoryIds.has(candidate) && candidate !== 'all'
    ? candidate
    : undefined;
}

export function metadataFromPatch(input: unknown): {
  categoryId?: SessionCategoryId;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const data = input as Record<string, unknown>;
  const metadata =
    data.metadata &&
    typeof data.metadata === 'object' &&
    !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : {};
  const categoryId =
    normalizeMetadataCategory(data.categoryId) ||
    normalizeMetadataCategory(data.category) ||
    normalizeMetadataCategory(metadata.categoryId) ||
    normalizeMetadataCategory(metadata.category);
  return categoryId ? { categoryId } : {};
}

export function attachSessionMetadata<T extends Record<string, unknown>>(
  session: T,
  record?: Pick<SessionMetadataRecord, 'categoryId'>,
): T {
  if (!record?.categoryId) return session;
  const existingMetadata =
    session.metadata &&
    typeof session.metadata === 'object' &&
    !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>)
      : {};
  return {
    ...session,
    categoryId: record.categoryId,
    category: record.categoryId,
    metadata: { ...existingMetadata, category: record.categoryId },
  };
}
