import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, WriteBatch } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { PDFParse } from "pdf-parse";

initializeApp();

const db = getFirestore();

const FREE_LIMITS = {
  maxBooks: 2,
  maxStorageBytes: 20 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  monthlyMessages: 50,
  monthlyIngestions: 2,
};

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

type LibrarySearchResult = {
  bookId: string;
  bookTitle: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
};

function requireAuth(auth: AuthContext | undefined): AuthContext {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in before using ReadWiseHub.");
  }

  return auth;
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

  if (terms.length === 0) {
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
      const score = scoreChunk(text, terms) + scorePhrase(text, queryText);

      if (score <= 0) {
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
      "Ich habe passende Quellenstellen gefunden. Eine echte KI-Antwort ist noch nicht aktiv; diese Antwort fasst aktuell nur die gefundenen Quellen zusammen.",
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
    "I found matching source passages. Full AI answer generation is not active yet; this response currently summarizes the retrieved sources only.",
    "",
    topResults.map((result) => `- ${result.excerpt}`).join("\n"),
    "",
    "Sources:",
    sourceList,
  ].join("\n");
}

async function ensureUserProfile(auth: AuthContext) {
  const userRef = db.collection("users").doc(auth.uid);
  const snapshot = await userRef.get();
  const now = FieldValue.serverTimestamp();

  if (snapshot.exists) {
    await userRef.set(
      {
        email: auth.email ?? snapshot.get("email") ?? "",
        displayName: auth.name ?? snapshot.get("displayName") ?? "",
        photoURL: auth.picture ?? snapshot.get("photoURL") ?? "",
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

async function extractTextFromStorageFile(storagePath: string, contentType: string) {
  const [buffer] = await getStorage().bucket().file(storagePath).download();

  if (buffer.byteLength > FREE_LIMITS.maxFileBytes) {
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

async function writeChunks(chunks: ReturnType<typeof chunkText>, userId: string, bookId: string) {
  let batch: WriteBatch = db.batch();
  let writes = 0;

  for (const chunk of chunks) {
    const chunkRef = db.collection("bookChunks").doc(`${bookId}_${chunk.chunkIndex}`);
    batch.set(chunkRef, {
      userId,
      bookId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      textPreview: chunk.textPreview,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      createdAt: FieldValue.serverTimestamp(),
    });
    writes += 1;

    if (writes >= 450) {
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
    const extraction = await extractTextFromStorageFile(storagePath, mimeType);
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

    await clearExistingChunks(bookId);
    await writeChunks(chunks, userId, bookId);

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

  return {
    ok: true,
    userId: auth.uid,
  };
});

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

    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new HttpsError("invalid-argument", "sizeBytes must be a positive number.");
    }

    if (sizeBytes > FREE_LIMITS.maxFileBytes) {
      throw new HttpsError(
        "resource-exhausted",
        "This file is larger than the current Free plan limit."
      );
    }

    await ensureUserProfile(auth);

    const activeBookCount = await getActiveBookCount(auth.uid);
    if (activeBookCount >= FREE_LIMITS.maxBooks) {
      throw new HttpsError(
        "resource-exhausted",
        `The current Free plan allows ${FREE_LIMITS.maxBooks} active books.`
      );
    }

    const activeStorageBytes = await getActiveStorageBytes(auth.uid);
    if (activeStorageBytes + sizeBytes > FREE_LIMITS.maxStorageBytes) {
      throw new HttpsError(
        "resource-exhausted",
        "This upload would exceed the current Free storage limit."
      );
    }

    const bookRef = db.collection("books").doc();
    const storagePath = `userUploads/${auth.uid}/${bookRef.id}/${fileName}`;
    const now = FieldValue.serverTimestamp();

    await bookRef.set({
      userId: auth.uid,
      title: fileName.replace(/\.[^.]+$/, ""),
      normalizedTitle: fileName.replace(/\.[^.]+$/, "").toLowerCase(),
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
      planAtIngestion: "free",
    });

    return {
      ok: true,
      bookId: bookRef.id,
      storagePath,
      maxFileBytes: FREE_LIMITS.maxFileBytes,
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

    if (sizeBytes > FREE_LIMITS.maxFileBytes) {
      throw new HttpsError("resource-exhausted", "Uploaded file exceeds the plan limit.");
    }

    const jobRef = db.collection("ingestionJobs").doc();
    const now = FieldValue.serverTimestamp();
    const userRef = db.collection("users").doc(auth.uid);
    const activeBookCount = await getActiveBookCount(auth.uid);
    const activeStorageBytes = await getActiveStorageBytes(auth.uid);
    const currentBookSize = Number(bookSnapshot.get("sizeBytes")) || 0;

    if (activeBookCount > FREE_LIMITS.maxBooks) {
      throw new HttpsError(
        "resource-exhausted",
        `The current Free plan allows ${FREE_LIMITS.maxBooks} active books.`
      );
    }

    if (activeStorageBytes - currentBookSize + sizeBytes > FREE_LIMITS.maxStorageBytes) {
      throw new HttpsError(
        "resource-exhausted",
        "This upload would exceed the current Free storage limit."
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

    await clearExistingChunks(bookId);
    await clearIngestionJobs(bookId);
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
    const jobId = assertString(request.data?.jobId, "jobId");
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
    const queryText = assertString(request.data?.query, "query").slice(0, MAX_SEARCH_QUERY_LENGTH);
    const locale =
      typeof request.data?.locale === "string" && request.data.locale === "de" ? "de" : "en";
    const bookId =
      typeof request.data?.bookId === "string" && request.data.bookId.trim()
        ? request.data.bookId.trim()
        : "";

    await ensureUserProfile(auth);

    const results = await runLibrarySearch(auth.uid, queryText, bookId);
    const answer = createGroundedDraft(queryText, results, locale);
    const now = FieldValue.serverTimestamp();
    const userRef = db.collection("users").doc(auth.uid);
    const conversationRef = db.collection("conversations").doc();
    const userMessageRef = conversationRef.collection("messages").doc();
    const assistantMessageRef = conversationRef.collection("messages").doc();

    await db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      const currentMessages = Number(userSnapshot.get("usageCurrentPeriod.messages")) || 0;
      const monthlyMessages =
        Number(userSnapshot.get("limits.monthlyMessages")) || FREE_LIMITS.monthlyMessages;

      if (currentMessages >= monthlyMessages) {
        throw new HttpsError(
          "resource-exhausted",
          "Your current plan message limit has been reached."
        );
      }

      transaction.set(conversationRef, {
        userId: auth.uid,
        title: queryText.slice(0, 90),
        mode: "source_draft",
        status: "answered",
        messageCount: 2,
        sourceCount: results.length,
        latestQuestion: queryText,
        latestAnswerPreview: answer.slice(0, 360),
        scopedBookId: bookId,
        scope: bookId ? "single_book" : "library",
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
        mode: "source_draft",
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
      conversationId: conversationRef.id,
      results,
    };
  }
);
