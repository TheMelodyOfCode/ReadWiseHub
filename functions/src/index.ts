import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, WriteBatch } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { PDFParse } from "pdf-parse";

initializeApp();

const db = getFirestore();

const PLAN_LIMITS = {
  free: {
    maxBooks: 2,
    maxStorageBytes: 20 * 1024 * 1024,
    maxFileBytes: 20 * 1024 * 1024,
    monthlyMessages: 20,
    monthlyIngestions: 2,
  },
  plus: {
    maxBooks: 10,
    maxStorageBytes: 200 * 1024 * 1024,
    maxFileBytes: 20 * 1024 * 1024,
    monthlyMessages: 200,
    monthlyIngestions: 10,
  },
  pro: {
    maxBooks: 50,
    maxStorageBytes: 1024 * 1024 * 1024,
    maxFileBytes: 50 * 1024 * 1024,
    monthlyMessages: 1000,
    monthlyIngestions: 50,
  },
} as const;

const FREE_LIMITS = {
  maxBooks: 2,
  maxStorageBytes: 20 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  monthlyMessages: 20,
  monthlyIngestions: 2,
};

type PlanLimits = typeof FREE_LIMITS;

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 160;
const MAX_EXTRACTED_TEXT_BYTES = 2_500_000;
const MAX_SEARCH_QUERY_LENGTH = 240;
const MAX_SEARCH_RESULTS = 5;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const openAiApiKey = defineSecret("OPENAI_API_KEY");
const ACTIVE_BOOK_STATUSES = [
  "upload_reserved",
  "uploading",
  "queued",
  "processing",
  "text_ready",
  "ready",
  "failed",
];

type AuthContext = {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
};

type UserPlan = keyof typeof PLAN_LIMITS;

type LibrarySearchResult = {
  bookId: string;
  bookTitle: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
};

type SourceBookSummary = {
  bookId: string;
  bookTitle: string;
};

type TextChunk = ReturnType<typeof chunkText>[number];

function requireAuth(auth: AuthContext | undefined): AuthContext {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in before using ReadWiseHub.");
  }

  return auth;
}

async function getAuthEmailVerified(userId: string): Promise<boolean> {
  const user = await getAuth().getUser(userId);
  return user.emailVerified === true;
}

async function requireVerifiedEmail(auth: AuthContext) {
  if (!(await getAuthEmailVerified(auth.uid))) {
    throw new HttpsError("failed-precondition", "Verify your email before using this feature.");
  }
}

function normalizePlan(plan: unknown): UserPlan {
  return plan === "plus" || plan === "pro" ? plan : "free";
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }

  return value.trim();
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

  return cleaned || "document";
}

function getBookTitleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function normalizeBookTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function assertAllowedContentType(contentType: string) {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new HttpsError(
      "invalid-argument",
      "Only PDF, TXT, and Markdown files are supported in this early version."
    );
  }
}

function resolveContentType(contentType: string, fileName: string): string {
  if (ALLOWED_CONTENT_TYPES.has(contentType)) {
    return contentType;
  }

  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (lowerName.endsWith(".txt")) {
    return "text/plain";
  }
  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }

  return contentType;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectLanguage(text: string): "de" | "en" | "unknown" {
  const lower = text.slice(0, 6000).toLowerCase();
  const germanHits = (lower.match(/\b(der|die|das|und|nicht|mit|ein|eine|ist|für)\b/g) ?? []).length;
  const englishHits = (lower.match(/\b(the|and|not|with|a|an|is|for|this|that)\b/g) ?? []).length;

  if (germanHits === 0 && englishHits === 0) {
    return "unknown";
  }

  return germanHits > englishHits ? "de" : "en";
}

function chunkText(text: string) {
  const chunks: Array<{
    chunkIndex: number;
    text: string;
    textPreview: string;
    charStart: number;
    charEnd: number;
  }> = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = Math.min(start + CHUNK_SIZE, text.length);
    const slice = text.slice(start, hardEnd);
    const breakpoints = [
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf(" "),
    ];
    const safeBreak = Math.max(...breakpoints);
    const end =
      safeBreak > Math.floor(CHUNK_SIZE * 0.55) && hardEnd < text.length
        ? start + safeBreak + 1
        : hardEnd;
    const chunk = text.slice(start, end).trim();

    if (chunk) {
      chunks.push({
        chunkIndex: chunks.length,
        text: chunk,
        textPreview: chunk.slice(0, 240),
        charStart: start,
        charEnd: end,
      });
    }

    if (end >= text.length) {
      break;
    }

    const nextStart = Math.max(0, end - CHUNK_OVERLAP);
    const nextWhitespace = text.indexOf(" ", nextStart);
    start =
      nextWhitespace > nextStart && nextWhitespace - nextStart <= 80
        ? nextWhitespace + 1
        : nextStart;
  }

  return chunks;
}

function createSafeError(error: unknown) {
  if (error instanceof HttpsError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal",
      message: error.message.slice(0, 500),
    };
  }

  return {
    code: "internal",
    message: "Unknown ingestion error.",
  };
}

function tokenizeSearchQuery(query: string): string[] {
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

function scoreChunk(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = lower.match(new RegExp(`\\b${escaped}`, "g"));
    return score + (matches?.length ?? 0);
  }, 0);
}

function scorePhrase(text: string, query: string): number {
  const normalizedText = text.toLowerCase().replace(/\s+/g, " ");
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();

  if (normalizedQuery.length < 8) {
    return 0;
  }

  return normalizedText.includes(normalizedQuery) ? 20 : 0;
}

function getOpenAiApiKey(): string {
  try {
    return openAiApiKey.value() || process.env.OPENAI_API_KEY || "";
  } catch {
    return process.env.OPENAI_API_KEY || "";
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
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

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function createEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey || texts.length === 0) {
    return [];
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    console.error("OpenAI embedding generation failed", {
      status: response.status,
      statusText: response.statusText,
    });
    return [];
  }

  const payload = await response.json();
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .sort((left: { index?: number }, right: { index?: number }) => (left.index ?? 0) - (right.index ?? 0))
    .map((item: { embedding?: unknown }) =>
      Array.isArray(item.embedding)
        ? item.embedding.filter((value): value is number => typeof value === "number")
        : []
    );
}

async function createChunkEmbeddingMap(chunks: TextChunk[]): Promise<Map<number, number[]>> {
  const embeddingsByIndex = new Map<number, number[]>();
  const batchSize = 64;

  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const embeddings = await createEmbeddings(batch.map((chunk) => chunk.text));
    embeddings.forEach((embedding, offset) => {
      if (embedding.length > 0) {
        embeddingsByIndex.set(batch[offset].chunkIndex, embedding);
      }
    });
  }

  return embeddingsByIndex;
}

function nearestReadableStart(text: string, preferredStart: number): number {
  if (preferredStart <= 0) {
    return 0;
  }

  const windowStart = Math.max(0, preferredStart - 80);
  const slice = text.slice(windowStart, preferredStart + 1);
  const sentenceBreak = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("\n")
  );

  if (sentenceBreak >= 0) {
    const absoluteBreak = windowStart + sentenceBreak;
    return text[absoluteBreak] === "\n" ? absoluteBreak + 1 : absoluteBreak + 2;
  }

  const spaceBreak = slice.lastIndexOf(" ");
  return spaceBreak >= 0 ? windowStart + spaceBreak + 1 : preferredStart;
}

function nearestReadableEnd(text: string, preferredEnd: number): number {
  if (preferredEnd >= text.length) {
    return text.length;
  }

  const windowEnd = Math.min(text.length, preferredEnd + 80);
  const slice = text.slice(preferredEnd, windowEnd);
  const sentenceBreaks = [slice.indexOf(". "), slice.indexOf("! "), slice.indexOf("? ")].filter(
    (index) => index >= 0
  );

  if (sentenceBreaks.length > 0) {
    return preferredEnd + Math.min(...sentenceBreaks) + 1;
  }

  const spaceBreak = slice.indexOf(" ");
  return spaceBreak >= 0 ? preferredEnd + spaceBreak : preferredEnd;
}

function avoidWordStartCut(text: string, start: number): number {
  let safeStart = start;

  while (
    safeStart > 0 &&
    safeStart < text.length &&
    /\S/.test(text[safeStart - 1]) &&
    /\S/.test(text[safeStart])
  ) {
    safeStart -= 1;
  }

  return safeStart;
}

function avoidWordEndCut(text: string, end: number): number {
  let safeEnd = end;

  while (
    safeEnd > 0 &&
    safeEnd < text.length &&
    /\S/.test(text[safeEnd - 1]) &&
    /\S/.test(text[safeEnd])
  ) {
    safeEnd += 1;
  }

  return safeEnd;
}

function trimLeadingChunkFragment(text: string, start: number): { start: number; fragmentTrimmed: boolean } {
  if (start !== 0 || text.length === 0) {
    return {
      start,
      fragmentTrimmed: false,
    };
  }

  const firstWord = text.match(/^\S+/)?.[0] ?? "";
  const firstBreak = text.search(/\s/);

  if (
    firstWord.length > 0 &&
    firstBreak > 0 &&
    !/^[A-Z0-9"'(<[]/.test(firstWord) &&
    !/^[.!?]/.test(firstWord)
  ) {
    return {
      start: firstBreak + 1,
      fragmentTrimmed: true,
    };
  }

  if (/^[,;:)]/.test(text)) {
    const nextWord = text.search(/[A-Za-z0-9]/);
    return {
      start: nextWord > 0 ? nextWord : start,
      fragmentTrimmed: nextWord > 0,
    };
  }

  return {
    start,
    fragmentTrimmed: false,
  };
}

function createExcerpt(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const center = firstMatch ?? 0;
  const initialStart = avoidWordStartCut(text, nearestReadableStart(text, Math.max(0, center - 180)));
  const cleanedStart = trimLeadingChunkFragment(text, initialStart);
  const start = cleanedStart.start;
  const end = avoidWordEndCut(text, nearestReadableEnd(text, Math.min(text.length, center + 420)));
  const prefix = start > 0 || cleanedStart.fragmentTrimmed ? "... " : "";
  const suffix = end < text.length ? " ..." : "";

  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

async function collectSearchableBooks(userId: string, bookId: string) {
  const books = new Map<string, { title: string }>();

  if (bookId) {
    const bookSnapshot = await db.collection("books").doc(bookId).get();
    if (
      bookSnapshot.exists &&
      bookSnapshot.get("userId") === userId &&
      bookSnapshot.get("status") === "text_ready"
    ) {
      books.set(bookSnapshot.id, {
        title: assertString(bookSnapshot.get("title"), "title"),
      });
    }
    return books;
  }

  const booksSnapshot = await db
    .collection("books")
    .where("userId", "==", userId)
    .where("status", "==", "text_ready")
    .get();

  booksSnapshot.docs.forEach((bookSnapshot) => {
    books.set(bookSnapshot.id, {
      title: assertString(bookSnapshot.get("title"), "title"),
    });
  });

  return books;
}

async function runLibrarySearch(userId: string, queryText: string, bookId = "") {
  const terms = tokenizeSearchQuery(queryText);
  const queryEmbeddings = await createEmbeddings([queryText]);
  const queryEmbedding = queryEmbeddings[0] ?? [];

  if (terms.length === 0 && queryEmbedding.length === 0) {
    throw new HttpsError("invalid-argument", "Please use a more specific question.");
  }

  const books = await collectSearchableBooks(userId, bookId);

  if (books.size === 0) {
    return [];
  }

  const chunkSnapshots = await Promise.all(
    Array.from(books.keys()).map((currentBookId) =>
      db
        .collection("bookChunks")
        .where("bookId", "==", currentBookId)
        .limit(800)
        .get()
    )
  );
  const scoredResults: LibrarySearchResult[] = [];

  chunkSnapshots.forEach((snapshot) => {
    snapshot.docs.forEach((chunkSnapshot) => {
      const currentBookId = assertString(chunkSnapshot.get("bookId"), "bookId");
      const book = books.get(currentBookId);

      if (!book || chunkSnapshot.get("userId") !== userId) {
        return;
      }

      const text = assertString(chunkSnapshot.get("text"), "text");
      const embedding = chunkSnapshot.get("embedding");
      const vectorSimilarity =
        Array.isArray(embedding) && queryEmbedding.length > 0
          ? cosineSimilarity(
              embedding.filter((value): value is number => typeof value === "number"),
              queryEmbedding
            )
          : 0;
      const lexicalScore = scoreChunk(text, terms) + scorePhrase(text, queryText);
      const score = lexicalScore + Math.max(0, vectorSimilarity) * 12;

      if (score <= 0 || (lexicalScore <= 0 && vectorSimilarity < 0.18)) {
        return;
      }

      scoredResults.push({
        bookId: currentBookId,
        bookTitle: book.title,
        chunkIndex: Number(chunkSnapshot.get("chunkIndex")) || 0,
        score,
        excerpt: createExcerpt(text, terms),
      });
    });
  });

  scoredResults.sort((left, right) => right.score - left.score);

  return scoredResults.slice(0, MAX_SEARCH_RESULTS);
}

function createGroundedDraft(queryText: string, results: LibrarySearchResult[], locale: string) {
  if (results.length === 0) {
    return locale === "de"
      ? "Ich habe dazu noch keine passende Stelle in deinen hochgeladenen Dokumenten gefunden."
      : "I could not find a matching passage in your uploaded documents yet.";
  }

  const topResults = results.slice(0, 3);
  const sourceList = topResults
    .map((result, index) => `${index + 1}. ${result.bookTitle}, chunk ${result.chunkIndex + 1}`)
    .join("\n");

  if (locale === "de") {
    return [
      `Frage: ${queryText}`,
      "",
      "Ich habe passende Quellenstellen gefunden, konnte aber diesmal keine KI-Antwort erstellen. Diese Antwort zeigt dir die relevantesten Quellenstellen.",
      "",
      topResults.map((result) => `- ${result.excerpt}`).join("\n"),
      "",
      "Quellen:",
      sourceList,
    ].join("\n");
  }

  return [
    `Question: ${queryText}`,
    "",
    "I found matching source passages, but could not create an AI answer this time. This response shows the most relevant source passages.",
    "",
    topResults.map((result) => `- ${result.excerpt}`).join("\n"),
    "",
    "Sources:",
    sourceList,
  ].join("\n");
}

function buildGroundingContext(results: LibrarySearchResult[]) {
  return results
    .slice(0, 5)
    .map(
      (result, index) =>
        `[${index + 1}] ${result.bookTitle}, chunk ${result.chunkIndex + 1}\n${result.excerpt}`
    )
    .join("\n\n");
}

function extractOpenAiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const outputText = (payload as { output_text?: unknown }).output_text;
  if (typeof outputText === "string") {
    return outputText.trim();
  }

  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        return [];
      }
      return content
        .map((part) => {
          if (!part || typeof part !== "object") {
            return "";
          }
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        })
        .filter(Boolean);
    })
    .join("\n")
    .trim();
}

async function createAiGroundedAnswer(
  queryText: string,
  results: LibrarySearchResult[],
  locale: string
): Promise<string | null> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey || results.length === 0) {
    return null;
  }

  const systemInstruction =
    locale === "de"
      ? "Du bist ReadWiseHub. Antworte klar und einfach auf Deutsch. Nutze nur die bereitgestellten Quellen. Wenn die Quellen nicht ausreichen, sage das ehrlich. Verweise knapp auf Quellen wie [1] oder [2]."
      : "You are ReadWiseHub. Answer clearly and simply in English. Use only the provided sources. If the sources are not enough, say so honestly. Cite sources briefly as [1] or [2].";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: systemInstruction,
      input: [
        `Question: ${queryText}`,
        "",
        "Sources:",
        buildGroundingContext(results),
      ].join("\n"),
      max_output_tokens: 700,
    }),
  });

  if (!response.ok) {
    console.error("OpenAI answer generation failed", {
      status: response.status,
      statusText: response.statusText,
    });
    return null;
  }

  const payload = await response.json();
  return extractOpenAiText(payload) || null;
}

async function ensureUserProfile(auth: AuthContext) {
  const userRef = db.collection("users").doc(auth.uid);
  const snapshot = await userRef.get();
  const now = FieldValue.serverTimestamp();
  const emailVerified = await getAuthEmailVerified(auth.uid);

  if (snapshot.exists) {
    const plan = normalizePlan(snapshot.get("plan"));
    const currentLimits = snapshot.get("limits") ?? {};
    const normalizedFreeLimits =
      plan === "free"
        ? {
            maxBooks: Math.max(Number(currentLimits.maxBooks) || 0, FREE_LIMITS.maxBooks),
            maxStorageBytes: Math.max(
              Number(currentLimits.maxStorageBytes) || 0,
              FREE_LIMITS.maxStorageBytes
            ),
            maxFileBytes: Math.max(Number(currentLimits.maxFileBytes) || 0, FREE_LIMITS.maxFileBytes),
            monthlyMessages: FREE_LIMITS.monthlyMessages,
            monthlyIngestions: Math.max(
              Number(currentLimits.monthlyIngestions) || 0,
              FREE_LIMITS.monthlyIngestions
            ),
          }
        : currentLimits;
    await userRef.set(
      {
        email: auth.email ?? snapshot.get("email") ?? "",
        displayName: auth.name ?? snapshot.get("displayName") ?? "",
        photoURL: auth.picture ?? snapshot.get("photoURL") ?? "",
        emailVerified,
        onboardingStatus: emailVerified ? "active" : "email_verification_pending",
        billingProvider: snapshot.get("billingProvider") ?? "none",
        billingCustomerId: snapshot.get("billingCustomerId") ?? "",
        billingPriceId: snapshot.get("billingPriceId") ?? "",
        billingCurrentPeriodEnd: snapshot.get("billingCurrentPeriodEnd") ?? null,
        limits: normalizedFreeLimits,
        updatedAt: now,
        lastLoginAt: now,
      },
      { merge: true }
    );
    return userRef;
  }

  await userRef.set({
    email: auth.email ?? "",
    displayName: auth.name ?? "",
    photoURL: auth.picture ?? "",
    plan: "free",
    subscriptionStatus: "none",
    emailVerified,
    onboardingStatus: emailVerified ? "active" : "email_verification_pending",
    billingProvider: "none",
    billingCustomerId: "",
    billingPriceId: "",
    billingCurrentPeriodEnd: null,
    locale: "de",
    theme: "light",
    limits: FREE_LIMITS,
    usageCurrentPeriod: {
      messages: 0,
      ingestions: 0,
      storageBytes: 0,
      books: 0,
    },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  });

  return userRef;
}

async function getUserLimits(userId: string): Promise<PlanLimits> {
  const snapshot = await db.collection("users").doc(userId).get();
  const plan = normalizePlan(snapshot.get("plan"));
  const defaults = PLAN_LIMITS[plan];
  const limits = snapshot.get("limits") ?? {};

  return {
    maxBooks: Math.max(Number(limits.maxBooks) || 0, defaults.maxBooks),
    maxStorageBytes: Math.max(
      Number(limits.maxStorageBytes) || 0,
      defaults.maxStorageBytes
    ),
    maxFileBytes: Math.max(Number(limits.maxFileBytes) || 0, defaults.maxFileBytes),
    monthlyMessages: Math.max(
      Number(limits.monthlyMessages) || 0,
      defaults.monthlyMessages
    ),
    monthlyIngestions: Math.max(
      Number(limits.monthlyIngestions) || 0,
      defaults.monthlyIngestions
    ),
  };
}

async function getActiveBookCount(userId: string): Promise<number> {
  const snapshot = await db
    .collection("books")
    .where("userId", "==", userId)
    .where("status", "in", ACTIVE_BOOK_STATUSES)
    .get();

  return snapshot.size;
}

async function getActiveStorageBytes(userId: string): Promise<number> {
  const snapshot = await db
    .collection("books")
    .where("userId", "==", userId)
    .where("status", "in", ACTIVE_BOOK_STATUSES)
    .get();

  return snapshot.docs.reduce((total, bookSnapshot) => {
    const sizeBytes = Number(bookSnapshot.get("sizeBytes"));
    return total + (Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0);
  }, 0);
}

async function assertNoDuplicateActiveBook(userId: string, title: string) {
  const normalizedTitle = normalizeBookTitle(title);
  const snapshot = await db
    .collection("books")
    .where("userId", "==", userId)
    .where("normalizedTitle", "==", normalizedTitle)
    .where("status", "in", ACTIVE_BOOK_STATUSES)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    throw new HttpsError(
      "already-exists",
      "This book already exists in your library."
    );
  }
}

async function extractTextFromStorageFile(
  storagePath: string,
  contentType: string,
  limits: PlanLimits
) {
  const [buffer] = await getStorage().bucket().file(storagePath).download();

  if (buffer.byteLength > limits.maxFileBytes) {
    throw new HttpsError("resource-exhausted", "Uploaded file exceeds the plan limit.");
  }

  if (contentType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      return {
        text: normalizeText(parsed.text || ""),
        pageCount: typeof parsed.total === "number" ? parsed.total : 0,
      };
    } finally {
      await parser.destroy();
    }
  }

  return {
    text: normalizeText(buffer.toString("utf8")),
    pageCount: 0,
  };
}

async function clearExistingChunks(bookId: string) {
  const snapshot = await db
    .collection("bookChunks")
    .where("bookId", "==", bookId)
    .limit(300)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 300) {
    await clearExistingChunks(bookId);
  }
}

async function clearIngestionJobs(bookId: string) {
  const snapshot = await db
    .collection("ingestionJobs")
    .where("bookId", "==", bookId)
    .limit(300)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 300) {
    await clearIngestionJobs(bookId);
  }
}

async function clearConversationMessages(conversationId: string) {
  const snapshot = await db
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .limit(300)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 300) {
    await clearConversationMessages(conversationId);
  }
}

async function clearUserConversations(userId: string) {
  const snapshot = await db
    .collection("conversations")
    .where("userId", "==", userId)
    .limit(100)
    .get();

  if (snapshot.empty) {
    return;
  }

  for (const conversationSnapshot of snapshot.docs) {
    await clearConversationMessages(conversationSnapshot.id);
    await conversationSnapshot.ref.delete();
  }

  if (snapshot.size === 100) {
    await clearUserConversations(userId);
  }
}

async function clearUserBooks(userId: string) {
  const snapshot = await db
    .collection("books")
    .where("userId", "==", userId)
    .limit(50)
    .get();

  if (snapshot.empty) {
    return;
  }

  for (const bookSnapshot of snapshot.docs) {
    const storagePath =
      typeof bookSnapshot.get("storagePath") === "string" ? bookSnapshot.get("storagePath") : "";
    if (storagePath) {
      await getStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
    }
    await clearExistingChunks(bookSnapshot.id);
    await clearIngestionJobs(bookSnapshot.id);
    await bookSnapshot.ref.delete();
  }

  if (snapshot.size === 50) {
    await clearUserBooks(userId);
  }
}

async function clearUserReaderSettings(userId: string) {
  const snapshot = await db
    .collection("users")
    .doc(userId)
    .collection("readerSettings")
    .limit(100)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((settingsSnapshot) => {
    batch.delete(settingsSnapshot.ref);
  });
  await batch.commit();

  if (snapshot.size === 100) {
    await clearUserReaderSettings(userId);
  }
}

function summarizeSourceBooks(results: LibrarySearchResult[]): SourceBookSummary[] {
  const sourceBooks = new Map<string, string>();

  results.forEach((result) => {
    if (!sourceBooks.has(result.bookId)) {
      sourceBooks.set(result.bookId, result.bookTitle);
    }
  });

  return Array.from(sourceBooks.entries()).map(([bookId, bookTitle]) => ({
    bookId,
    bookTitle,
  }));
}

async function refreshUserBookUsage(userId: string) {
  const [books, storageBytes] = await Promise.all([
    getActiveBookCount(userId),
    getActiveStorageBytes(userId),
  ]);

  await db.collection("users").doc(userId).update({
    "usageCurrentPeriod.books": books,
    "usageCurrentPeriod.storageBytes": storageBytes,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    books,
    storageBytes,
  };
}

async function writeChunks(
  chunks: TextChunk[],
  userId: string,
  bookId: string,
  embeddingsByIndex = new Map<number, number[]>()
) {
  let batch: WriteBatch = db.batch();
  let writes = 0;
  const maxWritesPerBatch = embeddingsByIndex.size > 0 ? 20 : 300;

  for (const chunk of chunks) {
    const chunkRef = db.collection("bookChunks").doc(`${bookId}_${chunk.chunkIndex}`);
    const embedding = embeddingsByIndex.get(chunk.chunkIndex);
    batch.set(chunkRef, {
      userId,
      bookId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      textPreview: chunk.textPreview,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      ...(embedding
        ? {
            embedding,
            embeddingModel: OPENAI_EMBEDDING_MODEL,
          }
        : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
    writes += 1;

    if (writes >= maxWritesPerBatch) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }
}

async function processIngestionJobById(jobId: string) {
  const jobRef = db.collection("ingestionJobs").doc(jobId);
  const jobSnapshot = await jobRef.get();

  if (!jobSnapshot.exists) {
    throw new HttpsError("not-found", "Ingestion job was not found.");
  }

  const status = jobSnapshot.get("status");
  if (status !== "queued" && status !== "failed") {
    return {
      ok: true,
      skipped: true,
      status,
    };
  }

  const userId = assertString(jobSnapshot.get("userId"), "userId");
  const bookId = assertString(jobSnapshot.get("bookId"), "bookId");
  const bookRef = db.collection("books").doc(bookId);
  const bookSnapshot = await bookRef.get();

  if (!bookSnapshot.exists || bookSnapshot.get("userId") !== userId) {
    throw new HttpsError("failed-precondition", "Book does not match ingestion job.");
  }

  const storagePath = assertString(bookSnapshot.get("storagePath"), "storagePath");
  const mimeType = assertString(bookSnapshot.get("mimeType"), "mimeType");
  assertAllowedContentType(mimeType);
  const limits = await getUserLimits(userId);

  const now = FieldValue.serverTimestamp();

  await db.runTransaction(async (transaction) => {
    transaction.update(jobRef, {
      status: "processing",
      stage: "extracting_text",
      progress: 10,
      attempts: FieldValue.increment(1),
      updatedAt: now,
    });
    transaction.update(bookRef, {
      status: "processing",
      updatedAt: now,
    });
  });

  try {
    const extraction = await extractTextFromStorageFile(storagePath, mimeType, limits);
    const textBytes = Buffer.byteLength(extraction.text, "utf8");

    if (!extraction.text) {
      throw new HttpsError("failed-precondition", "No readable text could be extracted.");
    }

    if (textBytes > MAX_EXTRACTED_TEXT_BYTES) {
      throw new HttpsError(
        "resource-exhausted",
        "Extracted text is too large for this early ingestion worker."
      );
    }

    await jobRef.update({
      stage: "chunking_text",
      progress: 45,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const chunks = chunkText(extraction.text);
    if (chunks.length === 0) {
      throw new HttpsError("failed-precondition", "No text chunks could be created.");
    }

    await jobRef.update({
      stage: "embedding_chunks",
      progress: 65,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const embeddingsByIndex = await createChunkEmbeddingMap(chunks);

    await clearExistingChunks(bookId);
    await writeChunks(chunks, userId, bookId, embeddingsByIndex);

    const language = detectLanguage(extraction.text);
    await db.runTransaction(async (transaction) => {
      transaction.update(bookRef, {
        status: "text_ready",
        language,
        pageCount: extraction.pageCount,
        textLength: extraction.text.length,
        textBytes,
        chunkCount: chunks.length,
        updatedAt: FieldValue.serverTimestamp(),
        textReadyAt: FieldValue.serverTimestamp(),
      });
      transaction.update(jobRef, {
        status: "completed",
        stage: "text_ready",
        progress: 100,
        chunkCount: chunks.length,
        textLength: extraction.text.length,
        textBytes,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return {
      ok: true,
      bookId,
      jobId,
      chunkCount: chunks.length,
      status: "text_ready",
    };
  } catch (error) {
    const safeError = createSafeError(error);
    await db.runTransaction(async (transaction) => {
      transaction.update(bookRef, {
        status: "failed",
        failedReason: safeError.message,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(jobRef, {
        status: "failed",
        stage: "failed",
        errorCode: safeError.code,
        errorMessageSafe: safeError.message,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    throw error;
  }
}

export const syncUserProfile = onCall({ region: "us-central1" }, async (request) => {
  const auth = requireAuth(request.auth?.token
    ? {
        uid: request.auth.uid,
        email: request.auth.token.email,
        name: request.auth.token.name,
        picture: request.auth.token.picture,
      }
    : undefined);

  await ensureUserProfile(auth);
  const userSnapshot = await db.collection("users").doc(auth.uid).get();

  return {
    ok: true,
    userId: auth.uid,
    emailVerified: userSnapshot.get("emailVerified") === true,
    onboardingStatus: userSnapshot.get("onboardingStatus") ?? "",
  };
});

export const exportAccountData = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);

    await ensureUserProfile(auth);

    const [userSnapshot, booksSnapshot, conversationsSnapshot] = await Promise.all([
      db.collection("users").doc(auth.uid).get(),
      db.collection("books").where("userId", "==", auth.uid).get(),
      db.collection("conversations").where("userId", "==", auth.uid).get(),
    ]);
    const conversations = await Promise.all(
      conversationsSnapshot.docs.map(async (conversationSnapshot) => {
        const messagesSnapshot = await conversationSnapshot.ref.collection("messages").get();
        return {
          id: conversationSnapshot.id,
          ...conversationSnapshot.data(),
          messages: messagesSnapshot.docs.map((messageSnapshot) => ({
            id: messageSnapshot.id,
            ...messageSnapshot.data(),
          })),
        };
      })
    );

    return {
      ok: true,
      exportedAt: new Date().toISOString(),
      user: userSnapshot.data() ?? {},
      books: booksSnapshot.docs.map((bookSnapshot) => ({
        id: bookSnapshot.id,
        ...bookSnapshot.data(),
      })),
      conversations,
    };
  }
);

export const getBookDetail = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const bookId = assertString(request.data?.bookId, "bookId");
    await requireVerifiedEmail(auth);
    const bookSnapshot = await db.collection("books").doc(bookId).get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    const chunksSnapshot = await db
      .collection("bookChunks")
      .where("bookId", "==", bookId)
      .limit(24)
      .get();
    const chunks = chunksSnapshot.docs
      .filter((chunkSnapshot) => chunkSnapshot.get("userId") === auth.uid)
      .map((chunkSnapshot) => ({
        id: chunkSnapshot.id,
        chunkIndex: Number(chunkSnapshot.get("chunkIndex")) || 0,
        textPreview:
          typeof chunkSnapshot.get("textPreview") === "string"
            ? chunkSnapshot.get("textPreview")
            : "",
      }))
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
      .slice(0, 12);

    return {
      ok: true,
      book: {
        id: bookSnapshot.id,
        title: bookSnapshot.get("title") ?? "Untitled",
        status: bookSnapshot.get("status") ?? "unknown",
        language: bookSnapshot.get("language") ?? "",
        chunkCount: Number(bookSnapshot.get("chunkCount")) || 0,
        embeddedChunkCount: Number(bookSnapshot.get("embeddedChunkCount")) || 0,
        pageCount: Number(bookSnapshot.get("pageCount")) || 0,
        textLength: Number(bookSnapshot.get("textLength")) || 0,
        sizeBytes: Number(bookSnapshot.get("sizeBytes")) || 0,
      },
      chunks,
    };
  }
);

export const getBookReader = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB", invoker: "public" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const bookId = assertString(request.data?.bookId, "bookId");
    const page = Math.max(0, Math.floor(Number(request.data?.page) || 0));
    const pageSize = Math.min(12, Math.max(4, Math.floor(Number(request.data?.pageSize) || 8)));
    const bookSnapshot = await db.collection("books").doc(bookId).get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    if (bookSnapshot.get("status") !== "text_ready") {
      throw new HttpsError("failed-precondition", "Book text is not ready yet.");
    }

    const chunksSnapshot = await db
      .collection("bookChunks")
      .where("bookId", "==", bookId)
      .limit(900)
      .get();
    const allChunks = chunksSnapshot.docs
      .filter((chunkSnapshot) => chunkSnapshot.get("userId") === auth.uid)
      .map((chunkSnapshot) => ({
        id: chunkSnapshot.id,
        chunkIndex: Number(chunkSnapshot.get("chunkIndex")) || 0,
        text:
          typeof chunkSnapshot.get("text") === "string"
            ? chunkSnapshot.get("text")
            : "",
      }))
      .filter((chunk) => chunk.text.trim())
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    const start = page * pageSize;

    return {
      ok: true,
      book: {
        id: bookSnapshot.id,
        title: bookSnapshot.get("title") ?? "Untitled",
        chunkCount: Number(bookSnapshot.get("chunkCount")) || allChunks.length,
      },
      page,
      pageSize,
      totalChunks: allChunks.length,
      chunks: allChunks.slice(start, start + pageSize),
    };
  }
);

export const getConversationDetail = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const conversationId = assertString(request.data?.conversationId, "conversationId");
    const conversationSnapshot = await db.collection("conversations").doc(conversationId).get();

    if (!conversationSnapshot.exists || conversationSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Question was not found.");
    }

    const messagesSnapshot = await conversationSnapshot.ref.collection("messages").get();
    const messages = messagesSnapshot.docs
      .filter((messageSnapshot) => messageSnapshot.get("userId") === auth.uid)
      .map((messageSnapshot) => ({
        id: messageSnapshot.id,
        role: messageSnapshot.get("role") ?? "",
        text: messageSnapshot.get("text") ?? "",
        mode: messageSnapshot.get("mode") ?? "",
        sources: Array.isArray(messageSnapshot.get("sources"))
          ? messageSnapshot.get("sources")
          : [],
        createdAtMs:
          typeof messageSnapshot.get("createdAt")?.toMillis === "function"
            ? messageSnapshot.get("createdAt").toMillis()
            : 0,
      }))
      .sort((left, right) => left.createdAtMs - right.createdAtMs);

    return {
      ok: true,
      conversation: {
        id: conversationSnapshot.id,
        title: conversationSnapshot.get("title") ?? "Untitled",
        mode: conversationSnapshot.get("mode") ?? "",
        sourceCount: Number(conversationSnapshot.get("sourceCount")) || 0,
        hasUnavailableSources: conversationSnapshot.get("hasUnavailableSources") === true,
        unavailableBookTitles: Array.isArray(conversationSnapshot.get("unavailableBookTitles"))
          ? conversationSnapshot.get("unavailableBookTitles")
          : [],
      },
      messages,
    };
  }
);

export const createUploadReservation = onCall(
  { region: "us-central1" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const fileName = sanitizeFileName(assertString(request.data?.fileName, "fileName"));
    const rawContentType =
      typeof request.data?.contentType === "string" ? request.data.contentType.trim() : "";
    const contentType = resolveContentType(rawContentType, fileName);
    const sizeBytes = Number(request.data?.sizeBytes);

    assertAllowedContentType(contentType);
    await requireVerifiedEmail(auth);

    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new HttpsError("invalid-argument", "sizeBytes must be a positive number.");
    }

    await ensureUserProfile(auth);
    const limits = await getUserLimits(auth.uid);

    if (sizeBytes > limits.maxFileBytes) {
      throw new HttpsError(
        "resource-exhausted",
        "This file is larger than the current plan limit."
      );
    }

    const activeBookCount = await getActiveBookCount(auth.uid);
    if (activeBookCount >= limits.maxBooks) {
      throw new HttpsError(
        "resource-exhausted",
        `The current plan allows ${limits.maxBooks} active books.`
      );
    }

    const activeStorageBytes = await getActiveStorageBytes(auth.uid);
    if (activeStorageBytes + sizeBytes > limits.maxStorageBytes) {
      throw new HttpsError(
        "resource-exhausted",
        "This upload would exceed the current plan storage limit."
      );
    }

    const title = getBookTitleFromFileName(fileName);
    const normalizedTitle = normalizeBookTitle(title);
    await assertNoDuplicateActiveBook(auth.uid, title);

    const bookRef = db.collection("books").doc();
    const storagePath = `userUploads/${auth.uid}/${bookRef.id}/${fileName}`;
    const now = FieldValue.serverTimestamp();

    await bookRef.set({
      userId: auth.uid,
      title,
      normalizedTitle,
      author: "",
      language: "",
      status: "upload_reserved",
      sourceType: "web_upload",
      storagePath,
      originalFileName: fileName,
      mimeType: contentType,
      sizeBytes,
      pageCount: 0,
      textLength: 0,
      chunkCount: 0,
      createdAt: now,
      updatedAt: now,
      planAtIngestion: "current",
    });

    return {
      ok: true,
      bookId: bookRef.id,
      storagePath,
      maxFileBytes: limits.maxFileBytes,
      allowedContentTypes: Array.from(ALLOWED_CONTENT_TYPES),
    };
  }
);

export const finalizeUploadReservation = onCall(
  { region: "us-central1" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const bookId = assertString(request.data?.bookId, "bookId");
    await requireVerifiedEmail(auth);

    const bookRef = db.collection("books").doc(bookId);
    const bookSnapshot = await bookRef.get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book reservation was not found.");
    }

    if (bookSnapshot.get("status") !== "upload_reserved") {
      throw new HttpsError("failed-precondition", "Book is not waiting for upload.");
    }

    const storagePath = assertString(bookSnapshot.get("storagePath"), "storagePath");
    const [metadata] = await getStorage().bucket().file(storagePath).getMetadata();
    const sizeBytes = Number(metadata.size);
    const contentType = resolveContentType(
      metadata.contentType ?? "",
      assertString(bookSnapshot.get("originalFileName"), "originalFileName")
    );

    assertAllowedContentType(contentType);

    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new HttpsError("failed-precondition", "Uploaded file is empty.");
    }

    await ensureUserProfile(auth);
    const limits = await getUserLimits(auth.uid);

    if (sizeBytes > limits.maxFileBytes) {
      throw new HttpsError("resource-exhausted", "Uploaded file exceeds the plan limit.");
    }

    const jobRef = db.collection("ingestionJobs").doc();
    const now = FieldValue.serverTimestamp();
    const userRef = db.collection("users").doc(auth.uid);
    const activeBookCount = await getActiveBookCount(auth.uid);
    const activeStorageBytes = await getActiveStorageBytes(auth.uid);
    const currentBookSize = Number(bookSnapshot.get("sizeBytes")) || 0;

    if (activeBookCount > limits.maxBooks) {
      throw new HttpsError(
        "resource-exhausted",
        `The current plan allows ${limits.maxBooks} active books.`
      );
    }

    if (activeStorageBytes - currentBookSize + sizeBytes > limits.maxStorageBytes) {
      throw new HttpsError(
        "resource-exhausted",
        "This upload would exceed the current plan storage limit."
      );
    }

    await db.runTransaction(async (transaction) => {
      transaction.update(bookRef, {
        status: "queued",
        sizeBytes,
        mimeType: contentType,
        updatedAt: now,
      });

      transaction.set(jobRef, {
        userId: auth.uid,
        bookId,
        status: "queued",
        stage: "waiting_for_ingestion_worker",
        progress: 0,
        attempts: 0,
        errorCode: "",
        errorMessageSafe: "",
        createdAt: now,
        updatedAt: now,
      });

      transaction.update(userRef, {
        "usageCurrentPeriod.books": activeBookCount,
        "usageCurrentPeriod.storageBytes": activeStorageBytes - currentBookSize + sizeBytes,
        "usageCurrentPeriod.ingestions": FieldValue.increment(1),
        updatedAt: now,
      });
    });

    return {
      ok: true,
      bookId,
      jobId: jobRef.id,
      status: "queued",
    };
  }
);

export const deleteBook = onCall(
  { region: "us-central1", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const bookId = assertString(request.data?.bookId, "bookId");
    const bookRef = db.collection("books").doc(bookId);
    const bookSnapshot = await bookRef.get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    const status = assertString(bookSnapshot.get("status"), "status");
    if (status === "processing") {
      throw new HttpsError(
        "failed-precondition",
        "This book is processing. Try deleting it after processing finishes."
      );
    }

    const storagePath =
      typeof bookSnapshot.get("storagePath") === "string"
        ? bookSnapshot.get("storagePath")
        : "";

    await bookRef.update({
      status: "deleting",
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (storagePath) {
      await getStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
    }

    const linkedConversations = await db
      .collection("conversations")
      .where("sourceBookIds", "array-contains", bookId)
      .limit(300)
      .get();
    if (!linkedConversations.empty) {
      const batch = db.batch();
      linkedConversations.docs.forEach((conversationSnapshot) => {
        if (conversationSnapshot.get("userId") !== auth.uid) {
          return;
        }

        batch.update(conversationSnapshot.ref, {
          hasUnavailableSources: true,
          unavailableBookTitles: FieldValue.arrayUnion(
            assertString(bookSnapshot.get("title"), "title")
          ),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
    }

    await clearExistingChunks(bookId);
    await clearIngestionJobs(bookId);
    await db
      .collection("users")
      .doc(auth.uid)
      .collection("readerSettings")
      .doc(bookId)
      .delete();
    await bookRef.delete();
    const usage = await refreshUserBookUsage(auth.uid);

    return {
      ok: true,
      bookId,
      usage,
    };
  }
);

export const processIngestionJob = onCall(
  { region: "us-central1", timeoutSeconds: 300, memory: "1GiB", secrets: [openAiApiKey] },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const jobId = assertString(request.data?.jobId, "jobId");
    await requireVerifiedEmail(auth);
    const jobSnapshot = await db.collection("ingestionJobs").doc(jobId).get();

    if (!jobSnapshot.exists || jobSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Ingestion job was not found.");
    }

    return processIngestionJobById(jobId);
  }
);

export const processQueuedIngestionJob = onDocumentCreated(
  {
    document: "ingestionJobs/{jobId}",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "1GiB",
    secrets: [openAiApiKey],
  },
  async (event) => {
    const jobId = event.params.jobId;
    const status = event.data?.get("status");

    if (status !== "queued") {
      return;
    }

    await processIngestionJobById(jobId);
  }
);

export const searchLibrary = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB", secrets: [openAiApiKey] },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    await requireVerifiedEmail(auth);
    const queryText = assertString(request.data?.query, "query").slice(0, MAX_SEARCH_QUERY_LENGTH);
    const bookId =
      typeof request.data?.bookId === "string" && request.data.bookId.trim()
        ? request.data.bookId.trim()
        : "";

    await ensureUserProfile(auth);
    const results = await runLibrarySearch(auth.uid, queryText, bookId);

    return {
      ok: true,
      query: queryText,
      results,
    };
  }
);

export const askLibrary = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB", secrets: [openAiApiKey] },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    await requireVerifiedEmail(auth);
    const queryText = assertString(request.data?.query, "query").slice(0, MAX_SEARCH_QUERY_LENGTH);
    const locale =
      typeof request.data?.locale === "string" && request.data.locale === "de" ? "de" : "en";
    const bookId =
      typeof request.data?.bookId === "string" && request.data.bookId.trim()
        ? request.data.bookId.trim()
        : "";

    await ensureUserProfile(auth);

    const userRef = db.collection("users").doc(auth.uid);
    const userSnapshot = await userRef.get();
    const currentMessages = Number(userSnapshot.get("usageCurrentPeriod.messages")) || 0;
    const monthlyMessages =
      Number(userSnapshot.get("limits.monthlyMessages")) || FREE_LIMITS.monthlyMessages;
    if (currentMessages >= monthlyMessages) {
      throw new HttpsError(
        "resource-exhausted",
        "Your current plan message limit has been reached."
      );
    }

    const results = await runLibrarySearch(auth.uid, queryText, bookId);
    const aiAnswer = await createAiGroundedAnswer(queryText, results, locale);
    const answer = aiAnswer ?? createGroundedDraft(queryText, results, locale);
    const sourceBooks = summarizeSourceBooks(results);
    const now = FieldValue.serverTimestamp();
    const conversationRef = db.collection("conversations").doc();
    const userMessageRef = conversationRef.collection("messages").doc();
    const assistantMessageRef = conversationRef.collection("messages").doc();

    await db.runTransaction(async (transaction) => {
      const latestUserSnapshot = await transaction.get(userRef);
      const latestMessages =
        Number(latestUserSnapshot.get("usageCurrentPeriod.messages")) || 0;
      const latestMonthlyMessages =
        Number(latestUserSnapshot.get("limits.monthlyMessages")) || FREE_LIMITS.monthlyMessages;

      if (latestMessages >= latestMonthlyMessages) {
        throw new HttpsError(
          "resource-exhausted",
          "Your current plan message limit has been reached."
        );
      }

      transaction.set(conversationRef, {
        userId: auth.uid,
        title: queryText.slice(0, 90),
        mode: aiAnswer ? "ai_grounded" : "source_draft",
        status: "answered",
        messageCount: 2,
        sourceCount: results.length,
        latestQuestion: queryText,
        latestAnswerPreview: answer.slice(0, 360),
        scopedBookId: bookId,
        scope: bookId ? "single_book" : "library",
        sourceBookIds: sourceBooks.map((sourceBook) => sourceBook.bookId),
        sourceBookTitles: sourceBooks.map((sourceBook) => sourceBook.bookTitle),
        hasUnavailableSources: false,
        unavailableBookTitles: [],
        createdAt: now,
        updatedAt: now,
      });
      transaction.set(userMessageRef, {
        userId: auth.uid,
        role: "user",
        text: queryText,
        createdAt: now,
      });
      transaction.set(assistantMessageRef, {
        userId: auth.uid,
        role: "assistant",
        text: answer,
        mode: aiAnswer ? "ai_grounded" : "source_draft",
        sources: results.map((result) => ({
          bookId: result.bookId,
          bookTitle: result.bookTitle,
          chunkIndex: result.chunkIndex,
          excerpt: result.excerpt,
          score: result.score,
        })),
        createdAt: now,
      });
      transaction.update(userRef, {
        "usageCurrentPeriod.messages": FieldValue.increment(1),
        updatedAt: now,
      });
    });

    return {
      ok: true,
      query: queryText,
      answer,
      mode: aiAnswer ? "ai_grounded" : "source_draft",
      conversationId: conversationRef.id,
      results,
    };
  }
);

export const deleteConversation = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const conversationId = assertString(request.data?.conversationId, "conversationId");
    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationSnapshot = await conversationRef.get();

    if (!conversationSnapshot.exists || conversationSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Question was not found.");
    }

    await clearConversationMessages(conversationId);
    await conversationRef.delete();

    return {
      ok: true,
      conversationId,
    };
  }
);

export const deleteAccountData = onCall(
  { region: "us-central1", timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);

    await clearUserBooks(auth.uid);
    await clearUserConversations(auth.uid);
    await clearUserReaderSettings(auth.uid);
    await db.collection("users").doc(auth.uid).delete();

    return {
      ok: true,
      userId: auth.uid,
    };
  }
);

export const backfillBookEmbeddings = onCall(
  { region: "us-central1", timeoutSeconds: 300, memory: "1GiB", secrets: [openAiApiKey] },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const bookId = assertString(request.data?.bookId, "bookId");
    const bookSnapshot = await db.collection("books").doc(bookId).get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    const chunksSnapshot = await db
      .collection("bookChunks")
      .where("bookId", "==", bookId)
      .limit(900)
      .get();
    const chunks: TextChunk[] = chunksSnapshot.docs
      .filter((chunkSnapshot) => chunkSnapshot.get("userId") === auth.uid)
      .map((chunkSnapshot) => ({
        chunkIndex: Number(chunkSnapshot.get("chunkIndex")) || 0,
        text: assertString(chunkSnapshot.get("text"), "text"),
        textPreview:
          typeof chunkSnapshot.get("textPreview") === "string"
            ? chunkSnapshot.get("textPreview")
            : assertString(chunkSnapshot.get("text"), "text").slice(0, 240),
        charStart: Number(chunkSnapshot.get("charStart")) || 0,
        charEnd: Number(chunkSnapshot.get("charEnd")) || 0,
      }));
    const embeddingsByIndex = await createChunkEmbeddingMap(chunks);
    let batch: WriteBatch = db.batch();
    let writes = 0;

    chunksSnapshot.docs.forEach((chunkSnapshot) => {
      const chunkIndex = Number(chunkSnapshot.get("chunkIndex")) || 0;
      const embedding = embeddingsByIndex.get(chunkIndex);
      if (!embedding) {
        return;
      }

      batch.update(chunkSnapshot.ref, {
        embedding,
        embeddingModel: OPENAI_EMBEDDING_MODEL,
        embeddedAt: FieldValue.serverTimestamp(),
      });
      writes += 1;
    });

    if (writes > 0) {
      await batch.commit();
    }

    await bookSnapshot.ref.update({
      embeddingModel: OPENAI_EMBEDDING_MODEL,
      embeddedChunkCount: writes,
      embeddedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      bookId,
      embeddedChunkCount: writes,
    };
  }
);
