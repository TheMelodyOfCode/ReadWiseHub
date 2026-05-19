import { execFileSync } from "node:child_process";
import admin from "firebase-admin";
import { Pinecone } from "@pinecone-database/pinecone";

const PROJECT_ID = "readwisehub";
const DEFAULT_INDEX_NAME = "readwisehub-books-v1";
const DEFAULT_INDEX_HOST = "readwisehub-books-v1-q8mjywr.svc.aped-4627-b74a.pinecone.io";
const DEFAULT_WORKSPACE_ID = "workspace_default";
const DEFAULT_LIBRARY_ID = "library_default";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const CHUNKER_VERSION = "rwh_chunker_1";
const EXTRACTOR_VERSION = "rwh_extractor_1";

const args = process.argv.slice(2);
const mode = args.includes("--audit") ? "audit" : args.includes("--delete") ? "delete" : "backfill";
const bookId = args.find((arg) => !arg.startsWith("--"));

if (!bookId) {
  console.error("Usage: npm run pinecone:backfill -- <bookId>");
  console.error("       npm run pinecone:audit -- <bookId>");
  console.error("       npm run pinecone:delete -- <bookId>");
  process.exit(1);
}

function readSecret(secretName) {
  return execFileSync(
    "gcloud",
    ["secrets", "versions", "access", "latest", "--secret", secretName, "--project", PROJECT_ID],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

function sanitizeVectorToken(value) {
  return String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

function resolveTenantId(userId, tenantId) {
  return tenantId ? sanitizeVectorToken(tenantId) : `user_${sanitizeVectorToken(userId)}`;
}

function resolveWorkspaceId(workspaceId) {
  return workspaceId ? sanitizeVectorToken(workspaceId) : DEFAULT_WORKSPACE_ID;
}

function resolveLibraryId(libraryId) {
  return libraryId ? sanitizeVectorToken(libraryId) : DEFAULT_LIBRARY_ID;
}

function buildNamespace(tenantId) {
  return `tenant_${sanitizeVectorToken(tenantId)}`;
}

function buildVectorId(bookId, chunkIndex) {
  return `book_${sanitizeVectorToken(bookId)}_chunk_${String(chunkIndex).padStart(6, "0")}`;
}

function buildMetadata(scope, bookId, chunk) {
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    libraryId: scope.libraryId,
    userId: scope.userId,
    bookId,
    fileId: chunk.fileId,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    chapterId: chunk.chapterId || "",
    sectionId: chunk.sectionId || "",
    pageStart: chunk.pageStart || 0,
    pageEnd: chunk.pageEnd || 0,
    contentType: "book_chunk",
    status: "ready",
    language: scope.language || "",
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    chunkerVersion: CHUNKER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    vectorIndexName: DEFAULT_INDEX_NAME,
  };
}

async function getBookScope(db, bookId) {
  const bookSnapshot = await db.collection("books").doc(bookId).get();
  if (!bookSnapshot.exists) {
    throw new Error(`Book not found: ${bookId}`);
  }

  const userId = String(bookSnapshot.get("userId") || "");
  if (!userId) {
    throw new Error(`Book ${bookId} has no userId.`);
  }

  const tenantId = resolveTenantId(userId, bookSnapshot.get("tenantId"));
  return {
    userId,
    tenantId,
    workspaceId: resolveWorkspaceId(bookSnapshot.get("workspaceId")),
    libraryId: resolveLibraryId(bookSnapshot.get("libraryId")),
    namespace: buildNamespace(tenantId),
    language: typeof bookSnapshot.get("language") === "string" ? bookSnapshot.get("language") : "",
    displayTitle:
      typeof bookSnapshot.get("displayTitle") === "string"
        ? bookSnapshot.get("displayTitle")
        : bookSnapshot.get("title") || bookId,
    bookRef: bookSnapshot.ref,
  };
}

async function loadChunks(db, bookId, scope) {
  const snapshot = await db
    .collection("bookChunks")
    .where("userId", "==", scope.userId)
    .where("bookId", "==", bookId)
    .limit(2000)
    .get();

  return snapshot.docs
    .map((doc) => {
      const embedding = doc.get("embedding");
      const text = doc.get("text");
      const chunkIndex = Number(doc.get("chunkIndex")) || 0;
      if (!Array.isArray(embedding) || typeof text !== "string") {
        return null;
      }

      const cleanEmbedding = embedding.filter((value) => typeof value === "number");
      if (cleanEmbedding.length !== EMBEDDING_DIMENSIONS) {
        return null;
      }

      return {
        chunkId: doc.id,
        fileId: typeof doc.get("fileId") === "string" ? doc.get("fileId") : bookId,
        chunkIndex,
        chapterId: typeof doc.get("chapterId") === "string" ? doc.get("chapterId") : "",
        sectionId: typeof doc.get("sectionId") === "string" ? doc.get("sectionId") : "",
        pageStart: Number(doc.get("pageStart")) || 0,
        pageEnd: Number(doc.get("pageEnd")) || 0,
        embedding: cleanEmbedding,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
}

async function fetchIndexedCount(index, namespace, scope, bookId) {
  const response = await index.fetchByMetadata({
    namespace,
    filter: {
      workspaceId: { $eq: scope.workspaceId },
      libraryId: { $eq: scope.libraryId },
      bookId: { $eq: bookId },
    },
    limit: 10000,
  });

  return Object.keys(response.records || {}).length;
}

admin.initializeApp({ projectId: PROJECT_ID });

const db = admin.firestore();
const apiKey = readSecret("PINECONE_API_KEY");
const pinecone = new Pinecone({ apiKey });
const indexHost = (process.env.PINECONE_INDEX_HOST || DEFAULT_INDEX_HOST)
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/g, "");
const index = pinecone.index({ host: indexHost });
const scope = await getBookScope(db, bookId);

if (mode === "delete") {
  await index.deleteMany({
    namespace: scope.namespace,
    filter: {
      workspaceId: { $eq: scope.workspaceId },
      libraryId: { $eq: scope.libraryId },
      bookId: { $eq: bookId },
    },
  });
  await scope.bookRef.update({
    pineconeDeletedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(JSON.stringify({ ok: true, mode, bookId, namespace: scope.namespace }, null, 2));
  await admin.app().delete();
  process.exit(0);
}

const chunks = await loadChunks(db, bookId, scope);

if (mode === "backfill") {
  if (chunks.length === 0) {
    throw new Error(`No embedded chunks found for ${bookId}.`);
  }

  const batchSize = 100;
  for (let start = 0; start < chunks.length; start += batchSize) {
    const records = chunks.slice(start, start + batchSize).map((chunk) => ({
      id: buildVectorId(bookId, chunk.chunkIndex),
      values: chunk.embedding,
      metadata: buildMetadata(scope, bookId, chunk),
    }));
    await index.upsert({ namespace: scope.namespace, records });
  }
}

const indexedChunkCount = await fetchIndexedCount(index, scope.namespace, scope, bookId);
const missingChunkCount = Math.max(0, chunks.length - indexedChunkCount);

if (mode === "backfill") {
  await scope.bookRef.update({
    pineconeIndexedChunkCount: indexedChunkCount,
    pineconeMissingChunkCount: missingChunkCount,
    pineconeIndexedAt: admin.firestore.FieldValue.serverTimestamp(),
    vectorBackendCandidate: "pinecone",
    vectorIndexName: DEFAULT_INDEX_NAME,
    vectorNamespace: scope.namespace,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      mode,
      bookId,
      displayTitle: scope.displayTitle,
      namespace: scope.namespace,
      embeddedChunkCount: chunks.length,
      indexedChunkCount,
      missingChunkCount,
    },
    null,
    2
  )
);

await admin.app().delete();
