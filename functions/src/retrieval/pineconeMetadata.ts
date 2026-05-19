import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_LIBRARY_ID,
  DEFAULT_VECTOR_INDEX_NAME,
  DEFAULT_WORKSPACE_ID,
} from "./bookRetrievalBackend";

const VECTOR_SAFE_REPLACEMENT = "_";

function sanitizeVectorToken(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, VECTOR_SAFE_REPLACEMENT)
    .replace(/_+/g, VECTOR_SAFE_REPLACEMENT)
    .replace(/^_+|_+$/g, "");

  return safe || "default";
}

export function resolveTenantId(userId: string, tenantId?: unknown): string {
  if (typeof tenantId === "string" && tenantId.trim()) {
    return sanitizeVectorToken(tenantId);
  }

  return `user_${sanitizeVectorToken(userId)}`;
}

export function resolveWorkspaceId(workspaceId?: unknown): string {
  if (typeof workspaceId === "string" && workspaceId.trim()) {
    return sanitizeVectorToken(workspaceId);
  }

  return DEFAULT_WORKSPACE_ID;
}

export function resolveLibraryId(libraryId?: unknown): string {
  if (typeof libraryId === "string" && libraryId.trim()) {
    return sanitizeVectorToken(libraryId);
  }

  return DEFAULT_LIBRARY_ID;
}

export function buildPineconeNamespace(tenantId: string): string {
  return `tenant_${sanitizeVectorToken(tenantId)}`;
}

export function buildPineconeVectorId(bookId: string, chunkIndex: number): string {
  return `book_${sanitizeVectorToken(bookId)}_chunk_${String(chunkIndex).padStart(6, "0")}`;
}

export type BookVectorMetadataInput = {
  userId: string;
  tenantId: string;
  workspaceId: string;
  libraryId: string;
  bookId: string;
  fileId: string;
  chunkId: string;
  chunkIndex: number;
  chapterId?: string;
  sectionId?: string;
  pageStart?: number;
  pageEnd?: number;
  language?: string;
  contentType?: string;
  status?: string;
  embeddingModel: string;
  chunkerVersion: string;
  extractorVersion: string;
};

export function buildBookVectorMetadata(input: BookVectorMetadataInput): Record<string, string | number> {
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    libraryId: input.libraryId,
    userId: input.userId,
    bookId: input.bookId,
    fileId: input.fileId,
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex,
    chapterId: input.chapterId || "",
    sectionId: input.sectionId || "",
    pageStart: input.pageStart ?? 0,
    pageEnd: input.pageEnd ?? 0,
    contentType: input.contentType || "book_chunk",
    status: input.status || "ready",
    language: input.language || "",
    embeddingModel: input.embeddingModel,
    embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    chunkerVersion: input.chunkerVersion,
    extractorVersion: input.extractorVersion,
    vectorIndexName: DEFAULT_VECTOR_INDEX_NAME,
  };
}
