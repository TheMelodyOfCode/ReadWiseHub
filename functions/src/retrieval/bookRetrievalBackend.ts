export const DEFAULT_WORKSPACE_ID = "workspace_default";
export const DEFAULT_LIBRARY_ID = "library_default";
export const DEFAULT_VECTOR_INDEX_NAME = "readwisehub-books-v1";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export type RetrievalMode = "book" | "section" | "library" | "evidence" | "cross_book";

export type BookRetrievalScope = {
  userId: string;
  tenantId: string;
  workspaceId: string;
  libraryId: string;
  bookIds?: string[];
  sectionIds?: string[];
};

export type ChunkForIndex = {
  chunkId: string;
  bookId: string;
  fileId: string;
  chunkIndex: number;
  text: string;
  textPreview: string;
  charStart: number;
  charEnd: number;
  chapterId?: string;
  sectionId?: string;
  pageStart?: number;
  pageEnd?: number;
  language?: string;
};

export type RetrievedBookChunk = {
  chunkId: string;
  bookId: string;
  fileId: string;
  chunkIndex: number;
  text: string;
  score: number;
  charStart?: number;
  charEnd?: number;
  textPreview?: string;
  chapterId?: string;
  sectionId?: string;
  pageStart?: number;
  pageEnd?: number;
};

export type RetrievalAudit = {
  backend: string;
  userId: string;
  tenantId: string;
  workspaceId: string;
  libraryId: string;
  bookId: string;
  indexedChunkCount: number;
  missingChunkCount: number;
};

export type BookRetrievalSearchInput = {
  scope: BookRetrievalScope;
  queryText: string;
  queryEmbedding: number[];
  topK: number;
  mode: RetrievalMode;
};

export interface BookRetrievalBackend {
  upsertBookChunks(input: {
    scope: BookRetrievalScope;
    chunks: ChunkForIndex[];
  }): Promise<void>;

  search(input: BookRetrievalSearchInput): Promise<RetrievedBookChunk[]>;

  deleteBook(input: {
    scope: BookRetrievalScope;
    bookId: string;
  }): Promise<void>;

  deleteTenant(input: {
    tenantId: string;
  }): Promise<void>;

  auditBook(input: {
    scope: BookRetrievalScope;
    bookId: string;
  }): Promise<RetrievalAudit>;
}
