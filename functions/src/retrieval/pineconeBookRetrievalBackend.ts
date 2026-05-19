import {
  Pinecone,
  PineconeRecord,
  RecordMetadata,
  ScoredPineconeRecord,
} from "@pinecone-database/pinecone";
import {
  BookRetrievalBackend,
  BookRetrievalSearchInput,
  ChunkForIndex,
  DEFAULT_VECTOR_INDEX_NAME,
  RetrievedBookChunk,
  RetrievalAudit,
} from "./bookRetrievalBackend";
import {
  buildBookVectorMetadata,
  buildPineconeNamespace,
  buildPineconeVectorId,
} from "./pineconeMetadata";

type BookChunkMetadata = RecordMetadata & {
  tenantId: string;
  workspaceId: string;
  libraryId: string;
  userId: string;
  bookId: string;
  fileId: string;
  chunkId: string;
  chunkIndex: number;
  chapterId: string;
  sectionId: string;
  pageStart: number;
  pageEnd: number;
  contentType: string;
  status: string;
  language: string;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkerVersion: string;
  extractorVersion: string;
  vectorIndexName: string;
};

type PineconeBackendOptions = {
  apiKey: string;
  firestore: FirebaseFirestore.Firestore;
  indexName?: string;
  indexHost?: string;
  embeddingModel: string;
  chunkerVersion: string;
  extractorVersion: string;
};

function buildScopeFilter(input: BookRetrievalSearchInput): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    workspaceId: { $eq: input.scope.workspaceId },
    libraryId: { $eq: input.scope.libraryId },
    status: { $eq: "ready" },
  };

  if (input.scope.bookIds && input.scope.bookIds.length === 1) {
    filter.bookId = { $eq: input.scope.bookIds[0] };
  } else if (input.scope.bookIds && input.scope.bookIds.length > 1) {
    filter.bookId = { $in: input.scope.bookIds.slice(0, 50) };
  }

  if (input.scope.sectionIds && input.scope.sectionIds.length === 1) {
    filter.sectionId = { $eq: input.scope.sectionIds[0] };
  } else if (input.scope.sectionIds && input.scope.sectionIds.length > 1) {
    filter.sectionId = { $in: input.scope.sectionIds.slice(0, 50) };
  }

  return filter;
}

function getStringMetadata(
  metadata: BookChunkMetadata | undefined,
  field: keyof BookChunkMetadata
): string {
  const value = metadata?.[field];
  return typeof value === "string" ? value : "";
}

function getNumberMetadata(
  metadata: BookChunkMetadata | undefined,
  field: keyof BookChunkMetadata
): number {
  const value = metadata?.[field];
  return typeof value === "number" ? value : 0;
}

function getSnapshotStringOrFallback(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  field: string,
  fallback: string
): string {
  const value = snapshot.get(field);
  return typeof value === "string" && value.trim() ? value : fallback;
}

export class PineconeBookRetrievalBackend implements BookRetrievalBackend {
  private readonly firestore: FirebaseFirestore.Firestore;
  private readonly indexName: string;
  private readonly embeddingModel: string;
  private readonly chunkerVersion: string;
  private readonly extractorVersion: string;
  private readonly pinecone: Pinecone;
  private readonly indexHost?: string;

  constructor(options: PineconeBackendOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Pinecone API key is required.");
    }

    this.firestore = options.firestore;
    this.indexName = options.indexName || DEFAULT_VECTOR_INDEX_NAME;
    this.indexHost = options.indexHost
      ? options.indexHost.replace(/^https?:\/\//i, "").replace(/\/+$/g, "")
      : undefined;
    this.embeddingModel = options.embeddingModel;
    this.chunkerVersion = options.chunkerVersion;
    this.extractorVersion = options.extractorVersion;
    this.pinecone = new Pinecone({ apiKey: options.apiKey });
  }

  private index() {
    if (this.indexHost) {
      return this.pinecone.index<BookChunkMetadata>({ host: this.indexHost });
    }

    return this.pinecone.index<BookChunkMetadata>({ name: this.indexName });
  }

  async upsertBookChunks(input: {
    scope: {
      userId: string;
      tenantId: string;
      workspaceId: string;
      libraryId: string;
    };
    chunks: Array<ChunkForIndex & { embedding?: number[] }>;
  }): Promise<void> {
    const records: Array<PineconeRecord<BookChunkMetadata>> = input.chunks
      .filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0)
      .map((chunk) => {
        const recordId = buildPineconeVectorId(chunk.bookId, chunk.chunkIndex);
        const metadata = buildBookVectorMetadata({
          userId: input.scope.userId,
          tenantId: input.scope.tenantId,
          workspaceId: input.scope.workspaceId,
          libraryId: input.scope.libraryId,
          bookId: chunk.bookId,
          fileId: chunk.fileId,
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          chapterId: chunk.chapterId,
          sectionId: chunk.sectionId,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          language: chunk.language,
          embeddingModel: this.embeddingModel,
          chunkerVersion: this.chunkerVersion,
          extractorVersion: this.extractorVersion,
        }) as BookChunkMetadata;

        return {
          id: recordId,
          values: chunk.embedding,
          metadata,
        };
      });

    const namespace = buildPineconeNamespace(input.scope.tenantId);
    const batchSize = 100;
    for (let start = 0; start < records.length; start += batchSize) {
      await this.index().upsert({
        namespace,
        records: records.slice(start, start + batchSize),
      });
    }
  }

  async search(input: BookRetrievalSearchInput): Promise<RetrievedBookChunk[]> {
    if (input.queryEmbedding.length === 0) {
      return [];
    }

    const namespace = buildPineconeNamespace(input.scope.tenantId);
    const response = await this.index().query({
      namespace,
      vector: input.queryEmbedding,
      topK: input.topK,
      includeMetadata: true,
      includeValues: false,
      filter: buildScopeFilter(input),
    });
    const matches = response.matches ?? [];
    const chunkIds = matches
      .map((match) => getStringMetadata(match.metadata, "chunkId"))
      .filter(Boolean);

    if (chunkIds.length === 0) {
      return [];
    }

    const chunkRefs = chunkIds.map((chunkId) => this.firestore.collection("bookChunks").doc(chunkId));
    const chunkSnapshots = await this.firestore.getAll(...chunkRefs);
    const chunksById = new Map(chunkSnapshots.map((snapshot) => [snapshot.id, snapshot]));

    return matches
      .map((match) => this.mapMatchToChunk(input, match, chunksById))
      .filter((chunk): chunk is RetrievedBookChunk => chunk !== null);
  }

  async deleteBook(input: {
    scope: {
      tenantId: string;
      workspaceId: string;
      libraryId: string;
    };
    bookId: string;
  }): Promise<void> {
    await this.index().deleteMany({
      namespace: buildPineconeNamespace(input.scope.tenantId),
      filter: {
        workspaceId: { $eq: input.scope.workspaceId },
        libraryId: { $eq: input.scope.libraryId },
        bookId: { $eq: input.bookId },
      },
    });
  }

  async deleteTenant(input: { tenantId: string }): Promise<void> {
    await this.index().deleteAll({
      namespace: buildPineconeNamespace(input.tenantId),
    });
  }

  async auditBook(input: {
    scope: {
      tenantId: string;
      workspaceId: string;
      libraryId: string;
      userId: string;
    };
    bookId: string;
  }): Promise<RetrievalAudit> {
    const response = await this.index().fetchByMetadata({
      namespace: buildPineconeNamespace(input.scope.tenantId),
      filter: {
        workspaceId: { $eq: input.scope.workspaceId },
        libraryId: { $eq: input.scope.libraryId },
        bookId: { $eq: input.bookId },
      },
      limit: 10000,
    });
    const indexedChunkCount = Object.keys(response.records ?? {}).length;
    const firestoreChunks = await this.firestore
      .collection("bookChunks")
      .where("userId", "==", input.scope.userId)
      .where("bookId", "==", input.bookId)
      .get();

    return {
      backend: "pinecone",
      userId: input.scope.userId,
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      libraryId: input.scope.libraryId,
      bookId: input.bookId,
      indexedChunkCount,
      missingChunkCount: Math.max(0, firestoreChunks.size - indexedChunkCount),
    };
  }

  private mapMatchToChunk(
    input: BookRetrievalSearchInput,
    match: ScoredPineconeRecord<BookChunkMetadata>,
    chunksById: Map<string, FirebaseFirestore.DocumentSnapshot>
  ): RetrievedBookChunk | null {
    const metadata = match.metadata;
    const chunkId = getStringMetadata(metadata, "chunkId");
    const snapshot = chunksById.get(chunkId);

    if (
      !snapshot?.exists ||
      snapshot.get("userId") !== input.scope.userId ||
      getSnapshotStringOrFallback(snapshot, "tenantId", input.scope.tenantId) !== input.scope.tenantId ||
      getSnapshotStringOrFallback(snapshot, "workspaceId", input.scope.workspaceId) !== input.scope.workspaceId ||
      getSnapshotStringOrFallback(snapshot, "libraryId", input.scope.libraryId) !== input.scope.libraryId
    ) {
      return null;
    }

    const text = snapshot.get("text");
    if (typeof text !== "string" || !text.trim()) {
      return null;
    }

    return {
      chunkId,
      bookId: getStringMetadata(metadata, "bookId"),
      fileId: getStringMetadata(metadata, "fileId"),
      chunkIndex: getNumberMetadata(metadata, "chunkIndex"),
      text,
      textPreview:
        typeof snapshot.get("textPreview") === "string"
          ? String(snapshot.get("textPreview"))
          : text.slice(0, 240),
      score: typeof match.score === "number" ? match.score : 0,
      chapterId: getStringMetadata(metadata, "chapterId") || undefined,
      sectionId: getStringMetadata(metadata, "sectionId") || undefined,
      pageStart: getNumberMetadata(metadata, "pageStart") || undefined,
      pageEnd: getNumberMetadata(metadata, "pageEnd") || undefined,
    };
  }
}
