import { execFileSync } from "node:child_process";
import admin from "firebase-admin";
import { Pinecone } from "@pinecone-database/pinecone";

const PROJECT_ID = "readwisehub";
const DEFAULT_INDEX_HOST = "readwisehub-books-v1-q8mjywr.svc.aped-4627-b74a.pinecone.io";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const MAX_RESULTS = 5;

const [bookId, ...queryParts] = process.argv.slice(2);
const queryText = queryParts.join(" ").trim();

if (!bookId || !queryText) {
  console.error("Usage: npm run pinecone:compare -- <bookId> <query text>");
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
  return workspaceId ? sanitizeVectorToken(workspaceId) : "workspace_default";
}

function resolveLibraryId(libraryId) {
  return libraryId ? sanitizeVectorToken(libraryId) : "library_default";
}

function buildNamespace(tenantId) {
  return `tenant_${sanitizeVectorToken(tenantId)}`;
}

function tokenizeSearchQuery(query) {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "der",
    "die",
    "das",
    "den",
    "dem",
    "des",
    "ein",
    "eine",
    "for",
    "in",
    "ist",
    "it",
    "mit",
    "of",
    "oder",
    "the",
    "to",
    "und",
    "was",
    "what",
    "wie",
    "zu",
  ]);

  return Array.from(
    new Set(
      query
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{Letter}\p{Number}\s-]+/gu, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3 && !stopWords.has(term))
    )
  ).slice(0, 12);
}

function scoreChunk(text, terms) {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = lower.match(new RegExp(`\\b${escaped}`, "g"));
    return score + (matches?.length ?? 0);
  }, 0);
}

function scorePhrase(text, query) {
  const normalizedText = text.toLowerCase().replace(/\s+/g, " ");
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedQuery.length < 8) {
    return 0;
  }

  return normalizedText.includes(normalizedQuery) ? 20 : 0;
}

function cosineSimilarity(left, right) {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function createExcerpt(text, terms) {
  const lower = text.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const center = firstMatch ?? 0;
  const start = Math.max(0, center - 180);
  const end = Math.min(text.length, center + 420);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function getSnapshotStringOrFallback(snapshot, field, fallback) {
  const value = snapshot.get(field);
  return typeof value === "string" && value.trim() ? value : fallback;
}

async function createEmbedding(query) {
  const apiKey = readSecret("OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: query,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embedding failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const embedding = payload?.data?.[0]?.embedding ?? [];
  const cleanEmbedding = Array.isArray(embedding)
    ? embedding.filter((value) => typeof value === "number")
    : [];
  if (cleanEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding dimension: ${cleanEmbedding.length}`);
  }

  return cleanEmbedding;
}

async function loadBookScope(db) {
  const bookSnapshot = await db.collection("books").doc(bookId).get();
  if (!bookSnapshot.exists) {
    throw new Error(`Book not found: ${bookId}`);
  }

  const userId = String(bookSnapshot.get("userId") || "");
  const tenantId = resolveTenantId(userId, bookSnapshot.get("tenantId"));
  return {
    userId,
    tenantId,
    workspaceId: resolveWorkspaceId(bookSnapshot.get("workspaceId")),
    libraryId: resolveLibraryId(bookSnapshot.get("libraryId")),
    namespace: buildNamespace(tenantId),
    title: bookSnapshot.get("displayTitle") || bookSnapshot.get("title") || bookId,
  };
}

async function firestoreResults(db, scope, queryEmbedding) {
  const terms = tokenizeSearchQuery(queryText);
  const snapshot = await db
    .collection("bookChunks")
    .where("userId", "==", scope.userId)
    .where("bookId", "==", bookId)
    .limit(800)
    .get();

  return snapshot.docs
    .map((doc) => {
      const text = doc.get("text");
      const embedding = doc.get("embedding");
      if (typeof text !== "string" || !Array.isArray(embedding)) {
        return null;
      }

      const cleanEmbedding = embedding.filter((value) => typeof value === "number");
      const vectorSimilarity = cosineSimilarity(cleanEmbedding, queryEmbedding);
      const lexicalScore = scoreChunk(text, terms) + scorePhrase(text, queryText);
      const score = lexicalScore + Math.max(0, vectorSimilarity) * 12;

      if (score <= 0 || (lexicalScore <= 0 && vectorSimilarity < 0.18)) {
        return null;
      }

      return {
        chunkId: doc.id,
        chunkIndex: Number(doc.get("chunkIndex")) || 0,
        score: Number(score.toFixed(4)),
        lexicalScore,
        vectorSimilarity: Number(vectorSimilarity.toFixed(4)),
        excerpt: createExcerpt(text, terms),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_RESULTS);
}

async function pineconeResults(db, scope, queryEmbedding) {
  const apiKey = readSecret("PINECONE_API_KEY");
  const indexHost = (process.env.PINECONE_INDEX_HOST || DEFAULT_INDEX_HOST)
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "");
  const pinecone = new Pinecone({ apiKey });
  const index = pinecone.index({ host: indexHost });
  const response = await index.query({
    namespace: scope.namespace,
    vector: queryEmbedding,
    topK: MAX_RESULTS,
    includeMetadata: true,
    includeValues: false,
    filter: {
      workspaceId: { $eq: scope.workspaceId },
      libraryId: { $eq: scope.libraryId },
      bookId: { $eq: bookId },
      status: { $eq: "ready" },
    },
  });
  const matches = response.matches || [];
  const chunkIds = matches
    .map((match) => (typeof match.metadata?.chunkId === "string" ? match.metadata.chunkId : ""))
    .filter(Boolean);
  const snapshots = chunkIds.length
    ? await db.getAll(...chunkIds.map((chunkId) => db.collection("bookChunks").doc(chunkId)))
    : [];
  const chunksById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const terms = tokenizeSearchQuery(queryText);

  return matches
    .map((match) => {
      const metadata = match.metadata || {};
      const chunkId = typeof metadata.chunkId === "string" ? metadata.chunkId : "";
      const snapshot = chunksById.get(chunkId);
      const text = snapshot?.get("text");
      if (
        !snapshot?.exists ||
        snapshot.get("userId") !== scope.userId ||
        getSnapshotStringOrFallback(snapshot, "tenantId", scope.tenantId) !== scope.tenantId ||
        getSnapshotStringOrFallback(snapshot, "workspaceId", scope.workspaceId) !== scope.workspaceId ||
        getSnapshotStringOrFallback(snapshot, "libraryId", scope.libraryId) !== scope.libraryId ||
        typeof text !== "string"
      ) {
        return null;
      }

      return {
        chunkId,
        chunkIndex: typeof metadata.chunkIndex === "number" ? metadata.chunkIndex : 0,
        score: Number((match.score || 0).toFixed(4)),
        excerpt: createExcerpt(text, terms),
      };
    })
    .filter(Boolean);
}

admin.initializeApp({ projectId: PROJECT_ID });

const db = admin.firestore();
const scope = await loadBookScope(db);
const queryEmbedding = await createEmbedding(queryText);
const [firestore, pinecone] = await Promise.all([
  firestoreResults(db, scope, queryEmbedding),
  pineconeResults(db, scope, queryEmbedding),
]);

console.log(
  JSON.stringify(
    {
      ok: true,
      bookId,
      title: scope.title,
      query: queryText,
      namespace: scope.namespace,
      firestore,
      pinecone,
      overlapChunkIds: firestore
        .map((result) => result.chunkId)
        .filter((chunkId) => pinecone.some((result) => result.chunkId === chunkId)),
    },
    null,
    2
  )
);

await admin.app().delete();
