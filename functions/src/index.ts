import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, WriteBatch } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { PDFParse } from "pdf-parse";
import AdmZip from "adm-zip";
import mammoth from "mammoth";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_LIBRARY_ID,
  DEFAULT_VECTOR_INDEX_NAME,
  DEFAULT_WORKSPACE_ID,
  RetrievedBookChunk,
} from "./retrieval/bookRetrievalBackend";
import {
  buildBookVectorMetadata,
  buildPineconeNamespace,
  buildPineconeVectorId,
  resolveLibraryId,
  resolveTenantId,
  resolveWorkspaceId,
} from "./retrieval/pineconeMetadata";
import { PineconeBookRetrievalBackend } from "./retrieval/pineconeBookRetrievalBackend";

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
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/epub+zip",
]);

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 160;
const SECTION_SIZE = 1800;
const MAX_EXTRACTED_TEXT_BYTES = 2_500_000;
const MAX_SEARCH_QUERY_LENGTH = 240;
const MAX_SEARCH_RESULTS = 5;
const PINECONE_SEARCH_CANDIDATE_COUNT = 30;
const MAX_ACTIVE_SESSIONS = 3;
const DELETE_CONFIRMATION_PHRASE = "ReadWiseHub 2026";
const PDF_EXTRACTOR_URL =
  process.env.PDF_EXTRACTOR_URL ||
  "https://readwisehub-pdf-extractor-ydgljnpaua-uc.a.run.app";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const CHUNKER_VERSION = "rwh_chunker_1";
const EXTRACTOR_VERSION = "rwh_extractor_1";
const openAiApiKey = defineSecret("OPENAI_API_KEY");
const pineconeApiKey = defineSecret("PINECONE_API_KEY");
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
  chunkId?: string;
  bookId: string;
  bookTitle: string;
  chunkIndex: number;
  charStart?: number;
  charEnd?: number;
  score: number;
  excerpt: string;
};

type SearchableBook = {
  title: string;
  scope: BookScope;
  pineconeIndexedChunkCount: number;
  pineconeMissingChunkCount: number;
};

type RetrievalDiagnostics = {
  backend: "firestore" | "pinecone";
  requestedBackend: "firestore" | "pinecone" | "auto";
  pineconeEnabledForUser: boolean;
  pineconeAttempted: boolean;
  fallbackReason: string;
  bookCount: number;
  scopedBookId: string;
  candidateCount: number;
  resultCount: number;
  pineconeCompleteBookCount: number;
  pineconeIncompleteBookIds: string[];
  sectionMapMatched?: boolean;
  activeArtifactId?: string;
  activeSectionNumber?: number;
};

type AdminViewer = AuthContext & {
  role: "admin";
};

type LibrarySearchResponse = {
  results: LibrarySearchResult[];
  diagnostics: RetrievalDiagnostics;
  activeArtifactId?: string;
  activeSectionNumber?: number;
};

type ConversationContext = {
  conversationId: string;
  bookId: string;
  activeArtifactId: string;
  activeSectionNumber: number;
};

type SourceBookSummary = {
  bookId: string;
  bookTitle: string;
};

type TextChunk = ReturnType<typeof chunkText>[number];
type BookSection = {
  sectionIndex: number;
  title: string;
  text: string;
  textPreview: string;
  paragraphStart?: number;
  paragraphEnd?: number;
  pageStart?: number;
  pageEnd?: number;
};
type SectionMapEntry = {
  sectionNumber: number;
  title: string;
  summary: string;
  sourceSectionStart: number;
  sourceSectionEnd: number;
  pageStart: number;
  pageEnd: number;
};
type SectionSourceForMap = {
  sectionIndex: number;
  title: string;
  textPreview: string;
  text: string;
  pageStart: number;
  pageEnd: number;
};
type NumberedHeadingCandidate = {
  number: number;
  title: string;
  sectionIndex: number;
  pageStart: number;
  pageEnd: number;
  textPreview: string;
  bodyPreview: string;
  position: number;
};
type TextExtractionResult = {
  text: string;
  pageCount: number;
  sections?: BookSection[];
  outline?: Array<{ sectionIndex: number; title: string }>;
  quality?: string;
};
type StructureAssessment = {
  structureQuality: string;
  formatWarning: string;
};
type BookScope = {
  tenantId: string;
  workspaceId: string;
  libraryId: string;
  vectorNamespace: string;
};

function buildDefaultBookScope(userId: string): BookScope {
  const tenantId = resolveTenantId(userId);
  return {
    tenantId,
    workspaceId: DEFAULT_WORKSPACE_ID,
    libraryId: DEFAULT_LIBRARY_ID,
    vectorNamespace: buildPineconeNamespace(tenantId),
  };
}

function resolveBookScope(userId: string, source?: FirebaseFirestore.DocumentSnapshot): BookScope {
  const tenantId = resolveTenantId(userId, source?.get("tenantId"));
  return {
    tenantId,
    workspaceId: resolveWorkspaceId(source?.get("workspaceId")),
    libraryId: resolveLibraryId(source?.get("libraryId")),
    vectorNamespace: buildPineconeNamespace(tenantId),
  };
}

function requireAuth(auth: AuthContext | undefined): AuthContext {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in before using ReadWiseHub.");
  }

  return auth;
}

function getAdminAllowedUids(): string[] {
  return parseUidAllowlist(process.env.ADMIN_ALLOWED_UIDS);
}

function requireAdmin(auth: AuthContext | undefined): AdminViewer {
  const viewer = requireAuth(auth);
  const allowedUids = getAdminAllowedUids();

  if (allowedUids.length === 0 || !allowedUids.includes(viewer.uid)) {
    throw new HttpsError("permission-denied", "Admin access is not enabled for this account.");
  }

  return {
    ...viewer,
    role: "admin",
  };
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

async function requireActiveSession(auth: AuthContext, rawSessionId: unknown) {
  const sessionId = sanitizeClientLabel(rawSessionId);
  if (!sessionId || sessionId.length < 16) {
    throw new HttpsError("failed-precondition", "Active device session is required.");
  }

  const sessionRef = db.collection("userSessions").doc(`${auth.uid}_${sessionId}`);
  const sessionSnapshot = await sessionRef.get();
  if (!sessionSnapshot.exists || sessionSnapshot.get("userId") !== auth.uid) {
    throw new HttpsError("permission-denied", "This device session is not registered.");
  }

  const status = sessionSnapshot.get("status") || "";
  if (status !== "active") {
    throw new HttpsError("permission-denied", "This device session is no longer active.");
  }

  await sessionRef.update({
    lastSeenAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
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

function createDisplayTitle(title: string): string {
  const withoutExtension = title.replace(/\.[^.]+$/, "");
  const spaced = withoutExtension
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stopWords = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "v", "v2"]);
  const words = spaced.split(" ").filter(Boolean);
  const titleCase = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && stopWords.has(lower)) {
        return lower;
      }
      if (/^[A-Z]{2,}$/.test(word)) {
        return word;
      }
      if (/^[0-9]+$/.test(word)) {
        return word;
      }
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");

  return titleCase.slice(0, 90) || "Untitled";
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
      "Only PDF, TXT, Markdown, DOCX, and EPUB files are supported right now."
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
  if (lowerName.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lowerName.endsWith(".epub")) {
    return "application/epub+zip";
  }

  return contentType;
}

function detectContentTypeFromBuffer(buffer: Buffer, fallback: string): string {
  const header = buffer.subarray(0, 8);
  const asciiHeader = header.toString("ascii");

  if (asciiHeader.startsWith("%PDF")) {
    return "application/pdf";
  }

  if (header[0] === 0x50 && header[1] === 0x4b) {
    try {
      const zip = new AdmZip(buffer);
      const names = new Set(zip.getEntries().map((entry) => entry.entryName));
      if (names.has("mimetype")) {
        const mimetype = zip.readAsText("mimetype").trim();
        if (mimetype === "application/epub+zip") {
          return "application/epub+zip";
        }
      }
      if (Array.from(names).some((name) => name.startsWith("word/"))) {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      }
    } catch {
      return fallback;
    }
  }

  if (fallback === "text/plain" || fallback === "text/markdown") {
    return fallback;
  }

  return fallback;
}

function assertContentMatches(buffer: Buffer, expectedType: string) {
  const detectedType = detectContentTypeFromBuffer(buffer, expectedType);
  const compatible =
    detectedType === expectedType ||
    ((expectedType === "text/plain" || expectedType === "text/markdown") &&
      (detectedType === "text/plain" || detectedType === "text/markdown"));

  if (!compatible) {
    throw new HttpsError(
      "invalid-argument",
      "The uploaded file type does not match the selected document format."
    );
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtmlToText(html: string): string {
  return normalizeText(
    decodeXmlEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, "\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function splitIntoParagraphs(text: string): string[] {
  return normalizeText(text)
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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

function isLikelyHeading(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > 120) {
    return false;
  }

  return /^(chapter|section|part|book|kapitel|teil)\b/i.test(trimmed) ||
    /^#{1,6}\s+\S/.test(trimmed) ||
    /^[0-9ivxlcdm]+[.)]\s+\S/i.test(trimmed);
}

function createBookSections(text: string) {
  const paragraphs = splitIntoParagraphs(text);
  const sections: Array<{
    sectionIndex: number;
    title: string;
    text: string;
    textPreview: string;
    paragraphStart: number;
    paragraphEnd: number;
  }> = [];
  let currentTitle = "";
  let currentParagraphs: string[] = [];
  let paragraphStart = 0;

  function flush(nextParagraphIndex: number) {
    const sectionText = currentParagraphs.join("\n\n").trim();
    if (!sectionText) {
      return;
    }

    sections.push({
      sectionIndex: sections.length,
      title: currentTitle,
      text: sectionText,
      textPreview: sectionText.slice(0, 300),
      paragraphStart,
      paragraphEnd: Math.max(paragraphStart, nextParagraphIndex - 1),
    });
  }

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const heading = isLikelyHeading(paragraph) ? paragraph.replace(/^#{1,6}\s+/, "") : "";
    const currentLength = currentParagraphs.join("\n\n").length;

    if (
      currentParagraphs.length > 0 &&
      (heading || currentLength + paragraph.length > SECTION_SIZE)
    ) {
      flush(paragraphIndex);
      currentParagraphs = [];
      currentTitle = heading;
      paragraphStart = paragraphIndex;
    } else if (!currentTitle && heading) {
      currentTitle = heading;
    }

    currentParagraphs.push(paragraph);
  });

  flush(paragraphs.length);

  if (sections.length === 0 && text.trim()) {
    const cleanText = normalizeText(text);
    sections.push({
      sectionIndex: 0,
      title: "",
      text: cleanText,
      textPreview: cleanText.slice(0, 300),
      paragraphStart: 0,
      paragraphEnd: 0,
    });
  }

  return sections;
}

function buildBookOutline(sections: BookSection[]) {
  return sections
    .filter((section) => section.title)
    .slice(0, 80)
    .map((section) => ({
      sectionIndex: section.sectionIndex,
      title: section.title,
    }));
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

async function getIdentityToken(audience: string): Promise<string> {
  const metadataUrl =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
  const response = await fetch(`${metadataUrl}?audience=${encodeURIComponent(audience)}`, {
    headers: {
      "Metadata-Flavor": "Google",
    },
  });

  if (!response.ok) {
    throw new Error(`Identity token request failed: ${response.status}`);
  }

  return response.text();
}

function normalizeLayoutSections(value: unknown): BookSection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((section) => section && typeof section === "object")
    .map((section, index) => {
      const record = section as Record<string, unknown>;
      const text = typeof record.text === "string" ? normalizeText(record.text) : "";
      return {
        sectionIndex:
          typeof record.sectionIndex === "number" && Number.isFinite(record.sectionIndex)
            ? Math.max(0, Math.floor(record.sectionIndex))
            : index,
        title: typeof record.title === "string" ? record.title.slice(0, 160) : "",
        text,
        textPreview:
          typeof record.textPreview === "string" ? record.textPreview.slice(0, 300) : text.slice(0, 300),
        paragraphStart:
          typeof record.paragraphStart === "number" ? Math.max(0, Math.floor(record.paragraphStart)) : index,
        paragraphEnd:
          typeof record.paragraphEnd === "number" ? Math.max(0, Math.floor(record.paragraphEnd)) : index,
        pageStart:
          typeof record.pageStart === "number" ? Math.max(0, Math.floor(record.pageStart)) : undefined,
        pageEnd:
          typeof record.pageEnd === "number" ? Math.max(0, Math.floor(record.pageEnd)) : undefined,
      };
    })
    .filter((section) => section.text)
    .sort((left, right) => left.sectionIndex - right.sectionIndex);
}

function normalizeOutline(value: unknown): Array<{ sectionIndex: number; title: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        sectionIndex:
          typeof record.sectionIndex === "number" && Number.isFinite(record.sectionIndex)
            ? Math.max(0, Math.floor(record.sectionIndex))
            : 0,
        title: typeof record.title === "string" ? record.title.slice(0, 160) : "",
      };
    })
    .filter((entry) => entry.title)
    .slice(0, 80);
}

async function extractPdfWithLayoutService(
  bucket: string,
  storagePath: string,
  maxBytes: number
): Promise<TextExtractionResult | null> {
  if (!PDF_EXTRACTOR_URL) {
    return null;
  }

  try {
    const token = await getIdentityToken(PDF_EXTRACTOR_URL);
    const response = await fetch(`${PDF_EXTRACTOR_URL}/extract`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucket,
        storagePath,
        maxBytes,
      }),
    });

    if (!response.ok) {
      console.error("PDF layout extraction failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const payload = await response.json() as Record<string, unknown>;
    const text = typeof payload.text === "string" ? normalizeText(payload.text) : "";
    if (!text) {
      return null;
    }

    return {
      text,
      pageCount: typeof payload.pageCount === "number" ? payload.pageCount : 0,
      sections: normalizeLayoutSections(payload.sections),
      outline: normalizeOutline(payload.outline),
      quality: typeof payload.quality === "string" ? payload.quality : "layout",
    };
  } catch (error) {
    console.error("PDF layout extraction unavailable", createSafeError(error));
    return null;
  }
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

function hasHeavyChunkOverlap(left: LibrarySearchResult, right: LibrarySearchResult): boolean {
  if (
    left.bookId !== right.bookId ||
    typeof left.charStart !== "number" ||
    typeof left.charEnd !== "number" ||
    typeof right.charStart !== "number" ||
    typeof right.charEnd !== "number"
  ) {
    return false;
  }

  const overlap = Math.min(left.charEnd, right.charEnd) - Math.max(left.charStart, right.charStart);
  if (overlap <= 0) {
    return false;
  }

  const leftLength = Math.max(1, left.charEnd - left.charStart);
  const rightLength = Math.max(1, right.charEnd - right.charStart);
  return overlap > 80 || overlap / Math.min(leftLength, rightLength) > 0.25;
}

function selectDistinctResults(results: LibrarySearchResult[]): LibrarySearchResult[] {
  const selected: LibrarySearchResult[] = [];

  for (const result of results) {
    if (!selected.some((existing) => hasHeavyChunkOverlap(existing, result))) {
      selected.push(result);
    }

    if (selected.length >= MAX_SEARCH_RESULTS) {
      break;
    }
  }

  return selected;
}

function getOpenAiApiKey(): string {
  try {
    return openAiApiKey.value() || process.env.OPENAI_API_KEY || "";
  } catch {
    return process.env.OPENAI_API_KEY || "";
  }
}

function getPineconeApiKey(): string {
  try {
    return pineconeApiKey.value() || process.env.PINECONE_API_KEY || "";
  } catch {
    return process.env.PINECONE_API_KEY || "";
  }
}

function parseUidAllowlist(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeFirestoreValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFirestoreValue);
  }

  if (value && typeof value === "object") {
    if (typeof (value as { toDate?: unknown }).toDate === "function") {
      return ((value as { toDate: () => Date }).toDate()).toISOString();
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeFirestoreValue(item),
      ])
    );
  }

  return value;
}

function isPineconeTestUser(userId: string): boolean {
  return parseUidAllowlist(process.env.PINECONE_TEST_USER_IDS).includes(userId);
}

function canViewRetrievalDiagnostics(userId: string): boolean {
  return (
    isPineconeTestUser(userId) ||
    parseUidAllowlist(process.env.PINECONE_SEARCH_USER_IDS).includes(userId)
  );
}

function requirePineconeTestUser(auth: AuthContext) {
  if (!isPineconeTestUser(auth.uid)) {
    throw new HttpsError(
      "permission-denied",
      "Pinecone prototype indexing is limited to configured test users."
    );
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

function isPineconeSearchEnabledForUser(userId: string): boolean {
  const explicitBackend = (process.env.READWISEHUB_RETRIEVAL_BACKEND || "").trim().toLowerCase();
  if (explicitBackend === "pinecone") {
    return true;
  }
  if (explicitBackend === "firestore") {
    return false;
  }

  return parseUidAllowlist(process.env.PINECONE_SEARCH_USER_IDS).includes(userId);
}

function hasCompletePineconeCoverage(book: SearchableBook): boolean {
  return book.pineconeIndexedChunkCount > 0 && book.pineconeMissingChunkCount === 0;
}

function getRequestedRetrievalBackend(): RetrievalDiagnostics["requestedBackend"] {
  const requested = (process.env.READWISEHUB_RETRIEVAL_BACKEND || "").trim().toLowerCase();
  return requested === "pinecone" || requested === "firestore" ? requested : "auto";
}

function createRetrievalDiagnostics(input: {
  userId: string;
  bookId: string;
  books: Map<string, SearchableBook>;
}): RetrievalDiagnostics {
  const bookEntries = Array.from(input.books.entries());
  const pineconeIncompleteBookIds = bookEntries
    .filter(([, book]) => !hasCompletePineconeCoverage(book))
    .map(([currentBookId]) => currentBookId);

  return {
    backend: "firestore",
    requestedBackend: getRequestedRetrievalBackend(),
    pineconeEnabledForUser: isPineconeSearchEnabledForUser(input.userId),
    pineconeAttempted: false,
    fallbackReason: "",
    bookCount: input.books.size,
    scopedBookId: input.bookId,
    candidateCount: 0,
    resultCount: 0,
    pineconeCompleteBookCount: bookEntries.length - pineconeIncompleteBookIds.length,
    pineconeIncompleteBookIds,
  };
}

async function collectSearchableBooks(userId: string, bookId: string) {
  const books = new Map<string, SearchableBook>();

  if (bookId) {
    const bookSnapshot = await db.collection("books").doc(bookId).get();
    if (
      bookSnapshot.exists &&
      bookSnapshot.get("userId") === userId &&
      bookSnapshot.get("status") === "text_ready"
    ) {
      books.set(bookSnapshot.id, {
        title:
          typeof bookSnapshot.get("displayTitle") === "string" && bookSnapshot.get("displayTitle")
            ? String(bookSnapshot.get("displayTitle"))
            : createDisplayTitle(assertString(bookSnapshot.get("title"), "title")),
        scope: resolveBookScope(userId, bookSnapshot),
        pineconeIndexedChunkCount: Number(bookSnapshot.get("pineconeIndexedChunkCount")) || 0,
        pineconeMissingChunkCount: Number(bookSnapshot.get("pineconeMissingChunkCount")) || 0,
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
      title:
        typeof bookSnapshot.get("displayTitle") === "string" && bookSnapshot.get("displayTitle")
          ? String(bookSnapshot.get("displayTitle"))
          : createDisplayTitle(assertString(bookSnapshot.get("title"), "title")),
      scope: resolveBookScope(userId, bookSnapshot),
      pineconeIndexedChunkCount: Number(bookSnapshot.get("pineconeIndexedChunkCount")) || 0,
      pineconeMissingChunkCount: Number(bookSnapshot.get("pineconeMissingChunkCount")) || 0,
    });
  });

  return books;
}

async function runPineconeLibrarySearch(
  userId: string,
  queryText: string,
  queryEmbedding: number[],
  books: Map<string, SearchableBook>
): Promise<{ results: LibrarySearchResult[]; candidateCount: number; fallbackReason: string }> {
  const apiKey = getPineconeApiKey();
  if (!apiKey || queryEmbedding.length === 0 || books.size === 0) {
    return {
      results: [],
      candidateCount: 0,
      fallbackReason: !apiKey
        ? "pinecone_api_key_missing"
        : queryEmbedding.length === 0
          ? "query_embedding_missing"
          : "no_searchable_books",
    };
  }

  const bookEntries = Array.from(books.entries());
  if (!bookEntries.every(([, book]) => hasCompletePineconeCoverage(book))) {
    return {
      results: [],
      candidateCount: 0,
      fallbackReason: "pinecone_coverage_incomplete",
    };
  }

  const firstScope = bookEntries[0][1].scope;
  const sameScope = bookEntries.every(([, book]) =>
    book.scope.tenantId === firstScope.tenantId &&
    book.scope.workspaceId === firstScope.workspaceId &&
    book.scope.libraryId === firstScope.libraryId
  );
  if (!sameScope) {
    return {
      results: [],
      candidateCount: 0,
      fallbackReason: "pinecone_scope_mismatch",
    };
  }

  const backend = new PineconeBookRetrievalBackend({
    apiKey,
    firestore: db,
    indexName: process.env.PINECONE_INDEX_NAME || DEFAULT_VECTOR_INDEX_NAME,
    indexHost: process.env.PINECONE_INDEX_HOST || "",
    embeddingModel: OPENAI_EMBEDDING_MODEL,
    chunkerVersion: CHUNKER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
  });
  const terms = tokenizeSearchQuery(queryText);
  const chunks = await backend.search({
    scope: {
      userId,
      tenantId: firstScope.tenantId,
      workspaceId: firstScope.workspaceId,
      libraryId: firstScope.libraryId,
      bookIds: bookEntries.map(([currentBookId]) => currentBookId),
    },
    queryText,
    queryEmbedding,
    topK: PINECONE_SEARCH_CANDIDATE_COUNT,
    mode: bookEntries.length > 1 ? "library" : "book",
  });

  const results = chunks
    .map((chunk: RetrievedBookChunk) => {
      const book = books.get(chunk.bookId);
      if (!book) {
        return null;
      }

      const vectorSimilarity = chunk.score;
      const lexicalScore = scoreChunk(chunk.text, terms) + scorePhrase(chunk.text, queryText);
      const score = lexicalScore + Math.max(0, vectorSimilarity) * 12;

      if (score <= 0 || (lexicalScore <= 0 && vectorSimilarity < 0.18)) {
        return null;
      }

      const result: LibrarySearchResult = {
        chunkId: chunk.chunkId,
        bookId: chunk.bookId,
        bookTitle: book.title,
        chunkIndex: chunk.chunkIndex,
        score,
        excerpt: createExcerpt(chunk.text, terms),
      };

      if (typeof chunk.charStart === "number") {
        result.charStart = chunk.charStart;
      }
      if (typeof chunk.charEnd === "number") {
        result.charEnd = chunk.charEnd;
      }

      return result;
    })
    .filter((result): result is LibrarySearchResult => result !== null)
    .sort((left, right) => right.score - left.score);

  return {
    results,
    candidateCount: chunks.length,
    fallbackReason: results.length > 0 ? "" : "pinecone_no_ranked_results",
  };
}

async function runLibrarySearch(userId: string, queryText: string, bookId = ""): Promise<LibrarySearchResponse> {
  const terms = tokenizeSearchQuery(queryText);
  const queryEmbeddings = await createEmbeddings([queryText]);
  const queryEmbedding = queryEmbeddings[0] ?? [];

  if (terms.length === 0 && queryEmbedding.length === 0) {
    throw new HttpsError("invalid-argument", "Please use a more specific question.");
  }

  const books = await collectSearchableBooks(userId, bookId);
  const diagnostics = createRetrievalDiagnostics({
    userId,
    bookId,
    books,
  });

  if (books.size === 0) {
    diagnostics.fallbackReason = "no_searchable_books";
    return {
      results: [],
      diagnostics,
    };
  }

  const wantsStructure =
    /\b(chapter|chapters|section|sections|toc|contents|outline|kapitel|inhaltsverzeichnis|abschnitt)\b/i.test(queryText) ||
    /\b(list|enumerate|name|what are|which are).{0,80}\b(problem|problems|unsolved|biggest|questions)\b/i.test(queryText);
  let pineconeSeedResults: LibrarySearchResult[] = [];

  if (isPineconeSearchEnabledForUser(userId)) {
    diagnostics.pineconeAttempted = true;
    const pineconeSearch = await runPineconeLibrarySearch(userId, queryText, queryEmbedding, books);
    diagnostics.candidateCount = pineconeSearch.candidateCount;
    diagnostics.fallbackReason = pineconeSearch.fallbackReason;
    if (pineconeSearch.results.length > 0) {
      const results = selectDistinctResults(pineconeSearch.results);
      diagnostics.backend = "pinecone";
      diagnostics.fallbackReason = "";
      diagnostics.resultCount = results.length;
      if (wantsStructure) {
        pineconeSeedResults = results;
      } else {
        return {
          results,
          diagnostics,
        };
      }
    }
  } else {
    diagnostics.fallbackReason = "pinecone_not_enabled_for_user";
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
  const scoredResults: LibrarySearchResult[] = [...pineconeSeedResults];

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
        chunkId: chunkSnapshot.id,
        bookId: currentBookId,
        bookTitle: book.title,
        chunkIndex: Number(chunkSnapshot.get("chunkIndex")) || 0,
        charStart: Number(chunkSnapshot.get("charStart")) || 0,
        charEnd: Number(chunkSnapshot.get("charEnd")) || 0,
        score,
        excerpt: createExcerpt(text, terms),
      });
    });
  });

  if (wantsStructure) {
    const bookSnapshots = await Promise.all(
      Array.from(books.keys()).map((currentBookId) => db.collection("books").doc(currentBookId).get())
    );
    const sectionSnapshots = await Promise.all(
      Array.from(books.keys()).map((currentBookId) =>
        db
          .collection("bookSections")
          .where("bookId", "==", currentBookId)
          .limit(600)
          .get()
      )
    );
    bookSnapshots.forEach((bookSnapshot) => {
      const book = books.get(bookSnapshot.id);
      if (!book || bookSnapshot.get("userId") !== userId) {
        return;
      }
      const outline = Array.isArray(bookSnapshot.get("outline")) ? bookSnapshot.get("outline") : [];
      const outlineText = outline
        .filter((entry: unknown) => entry && typeof entry === "object")
        .map((entry: { sectionIndex?: unknown; title?: unknown }) => {
          const sectionNumber = Number(entry.sectionIndex);
          const title = typeof entry.title === "string" ? entry.title : "";
          return title ? `${Number.isFinite(sectionNumber) ? sectionNumber + 1 : "-"}: ${title}` : "";
        })
        .filter(Boolean)
        .join("\n");

      if (outlineText) {
        scoredResults.push({
          bookId: bookSnapshot.id,
          bookTitle: book.title,
          chunkIndex: -1,
          score: 50,
          excerpt: `Book outline:\n${outlineText.slice(0, 1200)}`,
        });
      }
    });
    sectionSnapshots.forEach((snapshot) => {
      const firstSection = snapshot.docs[0];
      const currentBookId = firstSection ? assertString(firstSection.get("bookId"), "bookId") : "";
      const book = books.get(currentBookId);
      if (!book) {
        return;
      }
      const sectionSources: SectionSourceForMap[] = snapshot.docs
        .filter((sectionSnapshot) => sectionSnapshot.get("userId") === userId)
        .map((sectionSnapshot) => ({
          sectionIndex: Number(sectionSnapshot.get("sectionIndex")) || 0,
          title: typeof sectionSnapshot.get("title") === "string" ? sectionSnapshot.get("title") : "",
          textPreview:
            typeof sectionSnapshot.get("textPreview") === "string"
              ? sectionSnapshot.get("textPreview")
              : "",
          text: typeof sectionSnapshot.get("text") === "string" ? sectionSnapshot.get("text") : "",
          pageStart: Number(sectionSnapshot.get("pageStart")) || 0,
          pageEnd: Number(sectionSnapshot.get("pageEnd")) || 0,
        }))
        .sort((left, right) => left.sectionIndex - right.sectionIndex);
      const targetCount = parseRequestedStructureCount(queryText) || 12;
      const headingMap = createHeadingAwareSectionMapEntries(sectionSources, targetCount);
      if (headingMap.length > 0) {
        const headingText = headingMap
          .map((entry) => `${entry.sectionNumber}. ${entry.title}`)
          .join("\n");
        scoredResults.push({
          bookId: currentBookId,
          bookTitle: book.title,
          chunkIndex: -1,
          score: 90,
          excerpt: `Detected numbered structure:\n${headingText}`,
        });
      }
    });
  }

  scoredResults.sort((left, right) => right.score - left.score);

  const results = selectDistinctResults(scoredResults);
  diagnostics.backend = "firestore";
  diagnostics.candidateCount = scoredResults.length;
  diagnostics.resultCount = results.length;

  return {
    results,
    diagnostics,
  };
}

function parseRequestedSectionNumber(queryText: string): number {
  const match = queryText.match(/\b(?:section|part|abschnitt|teil)\s+(\d{1,2})\b/i);
  const sectionNumber = match ? Number(match[1]) : 0;
  return Number.isInteger(sectionNumber) && sectionNumber > 0 ? sectionNumber : 0;
}

function isContextualFollowUp(queryText: string): boolean {
  const normalized = queryText.trim().toLowerCase();
  if (!normalized || normalized.length > 180) {
    return false;
  }

  return (
    /\b(that|this|it|there|above|previous|vorher|das|dies|dazu)\b/.test(normalized) ||
    /\b(evidence|support|supports|examples|beispiele|belege|quelle|quellen)\b/.test(normalized) ||
    /\b(tell me more|explain (that|this)|why is (that|this)|what does (that|this) mean|simpler)\b/.test(normalized) ||
    /\b(what else|was noch|mehr dazu|genauer)\b/.test(normalized)
  );
}

async function loadLatestConversationContext(userId: string): Promise<ConversationContext | null> {
  const conversationsSnapshot = await db
    .collection("conversations")
    .where("userId", "==", userId)
    .limit(30)
    .get();
  const latestConversation = conversationsSnapshot.docs
    .sort((left, right) => {
      const leftCreatedAt = left.get("createdAt")?.toMillis?.() ?? 0;
      const rightCreatedAt = right.get("createdAt")?.toMillis?.() ?? 0;
      return rightCreatedAt - leftCreatedAt;
    })
    .find((conversationSnapshot) => {
      const scopedBookId =
        typeof conversationSnapshot.get("activeBookId") === "string" && conversationSnapshot.get("activeBookId")
          ? conversationSnapshot.get("activeBookId")
          : conversationSnapshot.get("scopedBookId");
      const sourceBookIds = Array.isArray(conversationSnapshot.get("sourceBookIds"))
        ? conversationSnapshot.get("sourceBookIds").filter((value: unknown) => typeof value === "string")
        : [];
      return Boolean(scopedBookId) || sourceBookIds.length === 1;
    });

  if (!latestConversation) {
    return null;
  }

  const sourceBookIds = Array.isArray(latestConversation.get("sourceBookIds"))
    ? latestConversation.get("sourceBookIds").filter((value: unknown): value is string => typeof value === "string")
    : [];
  const bookId =
    (typeof latestConversation.get("activeBookId") === "string" && latestConversation.get("activeBookId")) ||
    (typeof latestConversation.get("scopedBookId") === "string" && latestConversation.get("scopedBookId")) ||
    sourceBookIds[0] ||
    "";

  if (!bookId) {
    return null;
  }

  return {
    conversationId: latestConversation.id,
    bookId,
    activeArtifactId:
      typeof latestConversation.get("activeArtifactId") === "string"
        ? latestConversation.get("activeArtifactId")
        : "",
    activeSectionNumber: Number(latestConversation.get("activeSectionNumber")) || 0,
  };
}

function parseSectionMapTargetCount(queryText: string): number {
  const wantsSectionMap =
    /\b(?:divide|split|organize|map|outline|glieder|gliedere|teile|aufteilen)\b.{0,120}\b(?:sections|parts|abschnitte|teile)\b/i.test(queryText) ||
    /\b(?:section map|reading map|book map|gliederung|lesekarte)\b/i.test(queryText);

  if (!wantsSectionMap) {
    return 0;
  }

  const countMatch = queryText.match(/\b(\d{1,2})\s+(?:logical\s+|natural\s+)?(?:sections|parts|abschnitte|teile)\b/i);
  const targetCount = countMatch ? Number(countMatch[1]) : 6;
  return Math.max(3, Math.min(12, Math.floor(targetCount) || 6));
}

function parseRequestedStructureCount(queryText: string): number {
  const digitMatch = queryText.match(/\b(\d{1,2})\b/);
  if (digitMatch) {
    return Math.max(1, Math.min(30, Number(digitMatch[1]) || 0));
  }
  if (/\bten\b/i.test(queryText)) {
    return 10;
  }
  return 0;
}

function normalizeSectionMapEntry(value: unknown): SectionMapEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Partial<SectionMapEntry>;
  const sectionNumber = Number(entry.sectionNumber);
  const sourceSectionStart = Number(entry.sourceSectionStart);
  const sourceSectionEnd = Number(entry.sourceSectionEnd);

  if (
    !Number.isInteger(sectionNumber) ||
    !Number.isInteger(sourceSectionStart) ||
    !Number.isInteger(sourceSectionEnd)
  ) {
    return null;
  }

  return {
    sectionNumber,
    title: typeof entry.title === "string" ? entry.title : `Section ${sectionNumber}`,
    summary: typeof entry.summary === "string" ? entry.summary : "",
    sourceSectionStart,
    sourceSectionEnd,
    pageStart: Number(entry.pageStart) || 0,
    pageEnd: Number(entry.pageEnd) || 0,
  };
}

function countWeakSectionMapTitles(sections: SectionMapEntry[]): number {
  return sections.filter((section) =>
    /^(Chapter|Section|Part) \d+$/i.test(section.title) ||
    /^https?:\/\//i.test(section.title) ||
    /^\[\d+\]/.test(section.title) ||
    /^Here$/i.test(section.title)
  ).length;
}

async function supersedePriorSectionMaps(userId: string, bookId: string, targetSectionCount: number, currentArtifactId: string) {
  const snapshot = await db
    .collection("bookArtifacts")
    .where("userId", "==", userId)
    .where("bookId", "==", bookId)
    .where("type", "==", "section_map")
    .where("targetSectionCount", "==", targetSectionCount)
    .limit(50)
    .get();

  const batch = db.batch();
  let writes = 0;
  snapshot.docs.forEach((artifactSnapshot) => {
    if (artifactSnapshot.id === currentArtifactId || artifactSnapshot.get("status") !== "ready") {
      return;
    }
    batch.update(artifactSnapshot.ref, {
      status: "superseded",
      supersededBy: currentArtifactId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    writes += 1;
  });

  if (writes > 0) {
    await batch.commit();
  }
}

async function createBookSectionMapArtifact(userId: string, bookId: string, targetSectionCount: number) {
  const bookSnapshot = await db.collection("books").doc(bookId).get();
  if (!bookSnapshot.exists || bookSnapshot.get("userId") !== userId) {
    throw new HttpsError("not-found", "Book was not found.");
  }

  if (bookSnapshot.get("status") !== "text_ready") {
    throw new HttpsError("failed-precondition", "Book text is not ready yet.");
  }

  const sectionsSnapshot = await db
    .collection("bookSections")
    .where("bookId", "==", bookId)
    .limit(600)
    .get();
  const sectionSources: SectionSourceForMap[] = sectionsSnapshot.docs
    .filter((sectionSnapshot) => sectionSnapshot.get("userId") === userId)
    .map((sectionSnapshot) => ({
      sectionIndex: Number(sectionSnapshot.get("sectionIndex")) || 0,
      title:
        typeof sectionSnapshot.get("title") === "string"
          ? sectionSnapshot.get("title")
          : "",
      textPreview:
        typeof sectionSnapshot.get("textPreview") === "string"
          ? sectionSnapshot.get("textPreview")
          : "",
      text:
        typeof sectionSnapshot.get("text") === "string"
          ? sectionSnapshot.get("text")
          : "",
      pageStart: Number(sectionSnapshot.get("pageStart")) || 0,
      pageEnd: Number(sectionSnapshot.get("pageEnd")) || 0,
    }))
    .sort((left, right) => left.sectionIndex - right.sectionIndex);

  if (sectionSources.length === 0) {
    throw new HttpsError("failed-precondition", "This book has no sections to map yet.");
  }

  const bookScope = resolveBookScope(userId, bookSnapshot);
  const displayTitle =
    bookSnapshot.get("displayTitle") ||
    createDisplayTitle(String(bookSnapshot.get("title") || "Untitled"));
  const deterministicMapEntries = createSectionMapEntries(sectionSources, targetSectionCount);
  const polishedMap = await polishSectionMapEntriesWithAi(String(displayTitle), deterministicMapEntries);
  const mapEntries = polishedMap.entries;
  const artifactRef = db.collection("bookArtifacts").doc();
  const now = FieldValue.serverTimestamp();
  const artifact = {
    id: artifactRef.id,
    userId,
    tenantId: bookScope.tenantId,
    workspaceId: bookScope.workspaceId,
    libraryId: bookScope.libraryId,
    bookId,
    bookTitle: displayTitle,
    type: "section_map",
    title: `${displayTitle} section map`,
    status: "ready",
    generatedBy: polishedMap.polished
      ? "readwisehub_section_map_v1_ai_polished"
      : "readwisehub_section_map_v1",
    aiPolishedTitles: polishedMap.polished,
    targetSectionCount,
    sourceSectionCount: sectionSources.length,
    sections: mapEntries,
    createdAt: now,
    updatedAt: now,
  };

  await artifactRef.set(artifact);
  await supersedePriorSectionMaps(userId, bookId, targetSectionCount, artifactRef.id);

  return {
    artifact,
    artifactId: artifactRef.id,
    bookSnapshot,
    bookTitle: String(displayTitle),
    sections: mapEntries,
  };
}

function createSectionMapAnswer(bookTitle: string, sections: SectionMapEntry[], locale: string): string {
  const sectionLines = sections
    .map((section) => {
      const pageLabel =
        section.pageStart || section.pageEnd
          ? `, pages ${section.pageStart || "?"}-${section.pageEnd || "?"}`
          : "";
      return `${section.sectionNumber}. ${section.title}${pageLabel}\n   ${section.summary}`;
    })
    .join("\n\n");

  if (locale === "de") {
    return [
      `Ich habe eine Abschnittskarte fuer "${bookTitle}" erstellt und gespeichert.`,
      "",
      sectionLines,
      "",
      "Du kannst jetzt natuerlich weiterfragen, zum Beispiel: \"Fasse Abschnitt 2 zusammen.\"",
    ].join("\n");
  }

  return [
    `I created and saved a section map for "${bookTitle}".`,
    "",
    sectionLines,
    "",
    "You can now ask follow-ups such as: \"Summarize section 2.\"",
  ].join("\n");
}

function buildSectionMapCreationSearch(
  userId: string,
  bookId: string,
  bookTitle: string,
  bookSnapshot: FirebaseFirestore.DocumentSnapshot,
  artifactId: string,
  sections: SectionMapEntry[]
): LibrarySearchResponse {
  const diagnostics = createRetrievalDiagnostics({
    userId,
    bookId,
    books: new Map([
      [
        bookId,
        {
          title: bookTitle,
          scope: resolveBookScope(userId, bookSnapshot),
          pineconeIndexedChunkCount: Number(bookSnapshot.get("pineconeIndexedChunkCount")) || 0,
          pineconeMissingChunkCount: Number(bookSnapshot.get("pineconeMissingChunkCount")) || 0,
        },
      ],
    ]),
  });
  diagnostics.backend = "firestore";
  diagnostics.fallbackReason = "section_map_created";
  diagnostics.candidateCount = sections.length;
  diagnostics.resultCount = sections.length;
  diagnostics.sectionMapMatched = true;
  diagnostics.activeArtifactId = artifactId;

  return {
    results: sections.map((section, index) => ({
      chunkId: `${artifactId}_section_${section.sectionNumber}`,
      bookId,
      bookTitle,
      chunkIndex: section.sourceSectionStart,
      score: 100 - index,
      excerpt: [
        `Generated section ${section.sectionNumber}: ${section.title}`,
        `Source sections ${section.sourceSectionStart + 1}-${section.sourceSectionEnd + 1}`,
        section.summary,
      ].join("\n"),
    })),
    diagnostics,
    activeArtifactId: artifactId,
  };
}

async function resolveSectionMapSearch(
  userId: string,
  queryText: string,
  bookId: string
): Promise<LibrarySearchResponse | null> {
  const activeSectionNumber = parseRequestedSectionNumber(queryText);
  if (!bookId || !activeSectionNumber) {
    return null;
  }

  const bookSnapshot = await db.collection("books").doc(bookId).get();
  if (!bookSnapshot.exists || bookSnapshot.get("userId") !== userId) {
    return null;
  }

  const artifactsSnapshot = await db
    .collection("bookArtifacts")
    .where("userId", "==", userId)
    .where("bookId", "==", bookId)
    .where("type", "==", "section_map")
    .limit(20)
    .get();

  const latestArtifact = artifactsSnapshot.docs
    .filter((artifactSnapshot) => artifactSnapshot.get("status") === "ready")
    .sort((left, right) => {
      const leftCreatedAt = left.get("createdAt")?.toMillis?.() ?? 0;
      const rightCreatedAt = right.get("createdAt")?.toMillis?.() ?? 0;
      return rightCreatedAt - leftCreatedAt;
    })[0];

  const createdArtifact = !latestArtifact && activeSectionNumber <= 12
    ? await createBookSectionMapArtifact(
        userId,
        bookId,
        Math.max(6, activeSectionNumber)
      )
    : null;
  let artifactForSearch: FirebaseFirestore.DocumentSnapshot | undefined =
    latestArtifact ?? (createdArtifact ? await db.collection("bookArtifacts").doc(createdArtifact.artifactId).get() : undefined);

  if (!artifactForSearch?.exists) {
    return null;
  }

  const rawSectionEntries: unknown[] = Array.isArray(artifactForSearch.get("sections"))
    ? artifactForSearch.get("sections")
    : [];
  const sectionEntries = rawSectionEntries
    .map(normalizeSectionMapEntry)
    .filter((entry): entry is SectionMapEntry => entry !== null);

  const weakTitleCount = countWeakSectionMapTitles(sectionEntries);
  if (latestArtifact && weakTitleCount > 0) {
    const replacement = await createBookSectionMapArtifact(
      userId,
      bookId,
      Math.max(
        activeSectionNumber,
        Number(latestArtifact.get("targetSectionCount")) || sectionEntries.length || 6
      )
    );
    const replacementWeakTitleCount = countWeakSectionMapTitles(replacement.sections);
    if (replacementWeakTitleCount < weakTitleCount) {
      artifactForSearch = await db.collection("bookArtifacts").doc(replacement.artifactId).get();
      rawSectionEntries.splice(0, rawSectionEntries.length, ...replacement.sections);
      sectionEntries.splice(0, sectionEntries.length, ...replacement.sections);
    } else {
      await db.collection("bookArtifacts").doc(replacement.artifactId).delete().catch(() => undefined);
    }
  }

  const activeSection = sectionEntries.find((entry) => entry.sectionNumber === activeSectionNumber);

  if (!activeSection) {
    return null;
  }

  const sectionStart = Math.min(activeSection.sourceSectionStart, activeSection.sourceSectionEnd);
  const sectionEnd = Math.max(activeSection.sourceSectionStart, activeSection.sourceSectionEnd);
  const sectionsSnapshot = await db
    .collection("bookSections")
    .where("bookId", "==", bookId)
    .limit(600)
    .get();
  const bookTitle =
    String(bookSnapshot.get("displayTitle") || "") ||
    createDisplayTitle(String(bookSnapshot.get("title") || "Untitled"));
  const results = sectionsSnapshot.docs
    .filter((sectionSnapshot) => sectionSnapshot.get("userId") === userId)
    .map((sectionSnapshot) => ({
      snapshot: sectionSnapshot,
      sectionIndex: Number(sectionSnapshot.get("sectionIndex")) || 0,
    }))
    .filter(({ sectionIndex }) => sectionIndex >= sectionStart && sectionIndex <= sectionEnd)
    .sort((left, right) => left.sectionIndex - right.sectionIndex)
    .slice(0, 8)
    .map(({ snapshot, sectionIndex }, index) => {
      const title = String(snapshot.get("title") || "").trim();
      const text = String(snapshot.get("text") || snapshot.get("textPreview") || "").replace(/\s+/g, " ").trim();
      const excerptParts = [
        `Generated section ${activeSection.sectionNumber}: ${activeSection.title}`,
        title ? `Source section: ${title}` : "",
        text.slice(0, 2400),
      ].filter(Boolean);

      return {
        chunkId: snapshot.id,
        bookId,
        bookTitle,
        chunkIndex: sectionIndex,
        score: 120 - index,
        excerpt: excerptParts.join("\n"),
      };
    });

  if (results.length === 0) {
    return null;
  }

  const diagnostics = createRetrievalDiagnostics({
    userId,
    bookId,
    books: new Map([
      [
        bookId,
        {
          title: bookTitle,
          scope: resolveBookScope(userId, bookSnapshot),
          pineconeIndexedChunkCount: Number(bookSnapshot.get("pineconeIndexedChunkCount")) || 0,
          pineconeMissingChunkCount: Number(bookSnapshot.get("pineconeMissingChunkCount")) || 0,
        },
      ],
    ]),
  });
  diagnostics.backend = "firestore";
  diagnostics.fallbackReason = "section_map_scope";
  diagnostics.candidateCount = results.length;
  diagnostics.resultCount = results.length;
  diagnostics.sectionMapMatched = true;
  diagnostics.activeArtifactId = artifactForSearch.id;
  diagnostics.activeSectionNumber = activeSectionNumber;

  return {
    results,
    diagnostics,
    activeArtifactId: artifactForSearch.id,
    activeSectionNumber,
  };
}

async function resolveArtifactSectionSearch(
  userId: string,
  queryText: string,
  bookId: string,
  artifactId: string,
  activeSectionNumber: number
): Promise<LibrarySearchResponse | null> {
  if (!bookId || !artifactId || !activeSectionNumber) {
    return null;
  }

  const [bookSnapshot, artifactSnapshot] = await Promise.all([
    db.collection("books").doc(bookId).get(),
    db.collection("bookArtifacts").doc(artifactId).get(),
  ]);

  if (
    !bookSnapshot.exists ||
    bookSnapshot.get("userId") !== userId ||
    !artifactSnapshot.exists ||
    artifactSnapshot.get("userId") !== userId ||
    artifactSnapshot.get("bookId") !== bookId
  ) {
    return null;
  }

  const rawSectionEntries: unknown[] = Array.isArray(artifactSnapshot.get("sections"))
    ? artifactSnapshot.get("sections")
    : [];
  const sectionEntries = rawSectionEntries
    .map(normalizeSectionMapEntry)
    .filter((entry): entry is SectionMapEntry => entry !== null);
  const activeSection = sectionEntries.find((entry) => entry.sectionNumber === activeSectionNumber);
  if (!activeSection) {
    return null;
  }

  const sectionStart = Math.min(activeSection.sourceSectionStart, activeSection.sourceSectionEnd);
  const sectionEnd = Math.max(activeSection.sourceSectionStart, activeSection.sourceSectionEnd);
  const sectionsSnapshot = await db
    .collection("bookSections")
    .where("bookId", "==", bookId)
    .limit(600)
    .get();
  const bookTitle =
    String(bookSnapshot.get("displayTitle") || "") ||
    createDisplayTitle(String(bookSnapshot.get("title") || "Untitled"));
  const terms = tokenizeSearchQuery(queryText);
  const results = sectionsSnapshot.docs
    .filter((sectionSnapshot) => sectionSnapshot.get("userId") === userId)
    .map((sectionSnapshot) => ({
      snapshot: sectionSnapshot,
      sectionIndex: Number(sectionSnapshot.get("sectionIndex")) || 0,
    }))
    .filter(({ sectionIndex }) => sectionIndex >= sectionStart && sectionIndex <= sectionEnd)
    .sort((left, right) => left.sectionIndex - right.sectionIndex)
    .slice(0, 8)
    .map(({ snapshot, sectionIndex }, index) => {
      const title = String(snapshot.get("title") || "").trim();
      const text = String(snapshot.get("text") || snapshot.get("textPreview") || "").replace(/\s+/g, " ").trim();
      const excerptParts = [
        `Generated section ${activeSection.sectionNumber}: ${activeSection.title}`,
        title ? `Source section: ${title}` : "",
        createExcerpt(text, terms) || text.slice(0, 2400),
      ].filter(Boolean);

      return {
        chunkId: snapshot.id,
        bookId,
        bookTitle,
        chunkIndex: sectionIndex,
        score: 120 - index,
        excerpt: excerptParts.join("\n"),
      };
    });

  if (results.length === 0) {
    return null;
  }

  const diagnostics = createRetrievalDiagnostics({
    userId,
    bookId,
    books: new Map([
      [
        bookId,
        {
          title: bookTitle,
          scope: resolveBookScope(userId, bookSnapshot),
          pineconeIndexedChunkCount: Number(bookSnapshot.get("pineconeIndexedChunkCount")) || 0,
          pineconeMissingChunkCount: Number(bookSnapshot.get("pineconeMissingChunkCount")) || 0,
        },
      ],
    ]),
  });
  diagnostics.backend = "firestore";
  diagnostics.fallbackReason = "conversation_context_section";
  diagnostics.candidateCount = results.length;
  diagnostics.resultCount = results.length;
  diagnostics.sectionMapMatched = true;
  diagnostics.activeArtifactId = artifactSnapshot.id;
  diagnostics.activeSectionNumber = activeSectionNumber;

  return {
    results,
    diagnostics,
    activeArtifactId: artifactSnapshot.id,
    activeSectionNumber,
  };
}

function createGroundedDraft(queryText: string, results: LibrarySearchResult[], locale: string) {
  if (results.length === 0) {
    return locale === "de"
      ? "Ich habe dazu noch keine passende Stelle in deinen hochgeladenen Dokumenten gefunden."
      : "I could not find a matching passage in your uploaded documents yet.";
  }

  const topResults = results.slice(0, 3);
  const sourceList = topResults
    .map((result, index) =>
      `${index + 1}. ${result.bookTitle}, ${result.chunkIndex >= 0 ? `chunk ${result.chunkIndex + 1}` : "outline"}`
    )
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
        `[${index + 1}] ${result.bookTitle}, ${result.chunkIndex >= 0 ? `chunk ${result.chunkIndex + 1}` : "outline"}\n${result.excerpt}`
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
  const userScope = resolveBookScope(auth.uid, snapshot);

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
        tenantId: userScope.tenantId,
        defaultWorkspaceId: userScope.workspaceId,
        defaultLibraryId: userScope.libraryId,
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
    tenantId: userScope.tenantId,
    defaultWorkspaceId: userScope.workspaceId,
    defaultLibraryId: userScope.libraryId,
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
): Promise<TextExtractionResult> {
  const bucket = getStorage().bucket();
  const [buffer] = await bucket.file(storagePath).download();

  if (buffer.byteLength > limits.maxFileBytes) {
    throw new HttpsError("resource-exhausted", "Uploaded file exceeds the plan limit.");
  }
  assertContentMatches(buffer, contentType);

  if (contentType === "application/pdf") {
    const layoutExtraction = await extractPdfWithLayoutService(
      bucket.name,
      storagePath,
      limits.maxFileBytes
    );
    if (layoutExtraction?.text) {
      return layoutExtraction;
    }

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

  if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: normalizeText(result.value || ""),
      pageCount: 0,
    };
  }

  if (contentType === "application/epub+zip") {
    const zip = new AdmZip(buffer);
    const textParts = zip
      .getEntries()
      .filter((entry) => /\.(xhtml|html|htm)$/i.test(entry.entryName) && !entry.isDirectory)
      .sort((left, right) => left.entryName.localeCompare(right.entryName))
      .map((entry) => stripHtmlToText(entry.getData().toString("utf8")))
      .filter(Boolean);

    return {
      text: normalizeText(textParts.join("\n\n")),
      pageCount: 0,
    };
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
    .limit(20)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 20) {
    await clearExistingChunks(bookId);
  }
}

async function clearExistingSections(bookId: string) {
  const snapshot = await db
    .collection("bookSections")
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
    await clearExistingSections(bookId);
  }
}

async function clearNestedBookSections(bookId: string) {
  const bookRef = db.collection("books").doc(bookId);
  const snapshot = await bookRef.collection("sections").limit(100).get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 100) {
    await clearNestedBookSections(bookId);
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

async function clearBookArtifacts(bookId: string) {
  const snapshot = await db
    .collection("bookArtifacts")
    .where("bookId", "==", bookId)
    .limit(100)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 100) {
    await clearBookArtifacts(bookId);
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
    const routeTraceId =
      typeof conversationSnapshot.get("routeTraceId") === "string"
        ? conversationSnapshot.get("routeTraceId")
        : "";
    if (routeTraceId) {
      await db.collection("routeTraces").doc(routeTraceId).delete().catch(() => undefined);
    }
    await conversationSnapshot.ref.delete();
  }

  if (snapshot.size === 100) {
    await clearUserConversations(userId);
  }
}

async function clearUserRouteTraces(userId: string) {
  const snapshot = await db
    .collection("routeTraces")
    .where("userId", "==", userId)
    .limit(100)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 100) {
    await clearUserRouteTraces(userId);
  }
}

async function clearUserArtifacts(userId: string) {
  const snapshot = await db
    .collection("bookArtifacts")
    .where("userId", "==", userId)
    .limit(100)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref));
  await batch.commit();

  if (snapshot.size === 100) {
    await clearUserArtifacts(userId);
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
    await clearExistingSections(bookSnapshot.id);
    await clearIngestionJobs(bookSnapshot.id);
    await clearBookArtifacts(bookSnapshot.id);
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

async function clearUserSessions(userId: string) {
  const snapshot = await db
    .collection("userSessions")
    .where("userId", "==", userId)
    .limit(100)
    .get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((sessionSnapshot) => {
    batch.delete(sessionSnapshot.ref);
  });
  await batch.commit();

  if (snapshot.size === 100) {
    await clearUserSessions(userId);
  }
}

function requireRecentAuth(authTime: unknown) {
  const authTimeSeconds =
    typeof authTime === "number"
      ? authTime
      : typeof authTime === "string"
        ? Number(authTime)
        : 0;
  const ageSeconds = Math.floor(Date.now() / 1000) - authTimeSeconds;

  if (!Number.isFinite(ageSeconds) || ageSeconds > 15 * 60) {
    throw new HttpsError(
      "failed-precondition",
      "Please sign in again before deleting your account."
    );
  }
}

function sanitizeClientLabel(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, 160) : fallback;
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
  scope: BookScope,
  language: string,
  embeddingsByIndex = new Map<number, number[]>()
) {
  let batch: WriteBatch = db.batch();
  let writes = 0;
  const maxWritesPerBatch = embeddingsByIndex.size > 0 ? 20 : 300;

  for (const chunk of chunks) {
    const chunkId = `${bookId}_${chunk.chunkIndex}`;
    const vectorRecordId = buildPineconeVectorId(bookId, chunk.chunkIndex);
    const chunkRef = db.collection("bookChunks").doc(chunkId);
    const embedding = embeddingsByIndex.get(chunk.chunkIndex);
    batch.set(chunkRef, {
      userId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      libraryId: scope.libraryId,
      bookId,
      fileId: bookId,
      chunkId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      textPreview: chunk.textPreview,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      vectorBackend: "firestore",
      vectorIndexName: DEFAULT_VECTOR_INDEX_NAME,
      vectorNamespace: scope.vectorNamespace,
      vectorRecordId,
      vectorMetadata: buildBookVectorMetadata({
        userId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        libraryId: scope.libraryId,
        bookId,
        fileId: bookId,
        chunkId,
        chunkIndex: chunk.chunkIndex,
        language,
        embeddingModel: OPENAI_EMBEDDING_MODEL,
        chunkerVersion: CHUNKER_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
      }),
      ...(embedding
        ? {
            embedding,
            embeddingModel: OPENAI_EMBEDDING_MODEL,
            embeddingDimensions: embedding.length,
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

async function writeSections(
  sections: BookSection[],
  userId: string,
  bookId: string,
  scope: BookScope
) {
  let batch: WriteBatch = db.batch();
  let writes = 0;

  for (const section of sections) {
    const sectionRef = db.collection("bookSections").doc(`${bookId}_${section.sectionIndex}`);
    batch.set(sectionRef, {
      userId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      libraryId: scope.libraryId,
      bookId,
      sectionIndex: section.sectionIndex,
      title: section.title,
      text: section.text,
      textPreview: section.textPreview,
      paragraphStart: section.paragraphStart ?? section.sectionIndex,
      paragraphEnd: section.paragraphEnd ?? section.sectionIndex,
      ...(typeof section.pageStart === "number" ? { pageStart: section.pageStart } : {}),
      ...(typeof section.pageEnd === "number" ? { pageEnd: section.pageEnd } : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
    writes += 1;

    if (writes >= 300) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }
}

function createSectionMapEntries(
  sections: Array<{
    sectionIndex: number;
    title: string;
    textPreview: string;
    text?: string;
    pageStart: number;
    pageEnd: number;
  }>,
  targetCount: number
): SectionMapEntry[] {
  if (sections.length === 0) {
    return [];
  }

  const headingEntries = createHeadingAwareSectionMapEntries(sections, targetCount);
  if (headingEntries.length >= Math.min(targetCount, 4)) {
    return headingEntries;
  }

  const groupCount = Math.max(1, Math.min(targetCount, sections.length));
  return Array.from({ length: groupCount }, (_, groupIndex) => {
    const start = Math.floor((groupIndex * sections.length) / groupCount);
    const end = Math.floor(((groupIndex + 1) * sections.length) / groupCount);
    const group = sections.slice(start, Math.max(end, start + 1));
    const first = group[0];
    const last = group[group.length - 1] ?? first;
    const titledSection = group.find((section) => section.title.trim());
    const summarySource = group
      .map((section) => section.textPreview)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const rawTitle = titledSection?.title.trim() || `Section ${groupIndex + 1}`;
    const title = createUserFacingSectionTitle(rawTitle, summarySource, groupIndex + 1);

    return {
      sectionNumber: groupIndex + 1,
      title: title.slice(0, 120),
      summary:
        summarySource.length > 420
          ? `${summarySource.slice(0, 417).trim()}...`
          : summarySource || "No preview text available for this section yet.",
      sourceSectionStart: first.sectionIndex,
      sourceSectionEnd: last.sectionIndex,
      pageStart: first.pageStart,
      pageEnd: last.pageEnd,
    };
  });
}

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanAiSectionTitle(title: string): string {
  return title
    .replace(/^[\s"'`*_#-]+|[\s"'`*_#-]+$/g, "")
    .replace(/^(?:section|chapter|part)\s*\d+\s*[:.\-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

async function polishSectionMapEntriesWithAi(
  bookTitle: string,
  entries: SectionMapEntry[]
): Promise<{ entries: SectionMapEntry[]; polished: boolean }> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey || entries.length === 0 || entries.length > 12) {
    return { entries, polished: false };
  }

  const sectionPayload = entries.map((entry) => ({
    sectionNumber: entry.sectionNumber,
    currentTitle: entry.title,
    summary: entry.summary.slice(0, 700),
    sourceSectionStart: entry.sourceSectionStart + 1,
    sourceSectionEnd: entry.sourceSectionEnd + 1,
  }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions:
        "You create concise, user-facing reading-map titles from provided book excerpts. Return only valid JSON. Do not use generic labels like Chapter 2, Section 2, Part 2. Do not invent facts beyond the excerpt. Titles should be 2-7 words and summaries should be one short sentence.",
      input: [
        `Book: ${bookTitle}`,
        "Rewrite these section titles and summaries for a reader-facing book map.",
        "Return JSON array items with sectionNumber, title, summary.",
        JSON.stringify(sectionPayload),
      ].join("\n\n"),
      max_output_tokens: 900,
    }),
  });

  if (!response.ok) {
    console.error("OpenAI section map polish failed", {
      status: response.status,
      statusText: response.statusText,
    });
    return { entries, polished: false };
  }

  const payload = await response.json();
  const suggestions = extractJsonArray(extractOpenAiText(payload));
  if (!suggestions) {
    return { entries, polished: false };
  }

  const suggestionsByNumber = new Map<number, { title: string; summary: string }>();
  suggestions.forEach((suggestion) => {
    if (!suggestion || typeof suggestion !== "object") {
      return;
    }
    const sectionNumber = Number((suggestion as { sectionNumber?: unknown }).sectionNumber);
    const rawTitle = (suggestion as { title?: unknown }).title;
    const rawSummary = (suggestion as { summary?: unknown }).summary;
    if (!Number.isInteger(sectionNumber) || typeof rawTitle !== "string" || typeof rawSummary !== "string") {
      return;
    }
    const title = cleanAiSectionTitle(rawTitle);
    const summary = rawSummary.replace(/\s+/g, " ").trim().slice(0, 420);
    if (title.length < 3 || isGenericSectionTitle(title) || summary.length < 10) {
      return;
    }
    suggestionsByNumber.set(sectionNumber, { title, summary });
  });

  if (suggestionsByNumber.size < Math.ceil(entries.length * 0.6)) {
    return { entries, polished: false };
  }

  return {
    entries: entries.map((entry) => {
      const suggestion = suggestionsByNumber.get(entry.sectionNumber);
      return suggestion
        ? {
            ...entry,
            title: suggestion.title,
            summary: suggestion.summary,
          }
        : entry;
    }),
    polished: true,
  };
}

function isGenericSectionTitle(title: string): boolean {
  return /^(chapter|section|part)\s+\d+$/i.test(title.trim());
}

function createTopicTitleFromText(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[#>*_`]+/g, " ")
    .replace(/\b(chapter|section|part)\s+\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = cleaned.split(/[.!?]\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  const sentence = sentences.find((candidate) => candidate.split(/\s+/).length >= 6) || cleaned;
  const words = sentence
    .split(" ")
    .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter((word) => word.length > 1)
    .slice(0, 7);

  if (words.length < 3) {
    return fallback;
  }

  return words.join(" ");
}

function createUserFacingSectionTitle(rawTitle: string, summarySource: string, sectionNumber: number): string {
  const trimmedTitle = rawTitle.trim();
  if (!trimmedTitle || isGenericSectionTitle(trimmedTitle)) {
    const topicTitle = createTopicTitleFromText(summarySource, `Section ${sectionNumber}`);
    return topicTitle.slice(0, 120);
  }

  return trimmedTitle.slice(0, 120);
}

function cleanDetectedHeadingTitle(rawTitle: string): string {
  const stopWords = new Set([
    "Although",
    "Because",
    "However",
    "When",
    "Why",
    "What",
    "This",
    "These",
    "There",
    "That",
    "It",
  ]);
  const trailingWords = new Set(["A", "An", "And", "In", "Of", "On", "The", "To", "a", "an", "and", "in", "of", "on", "the", "to"]);
  const words = rawTitle
    .replace(/\s+/g, " ")
    .replace(/^[“"']|[”"']$/g, "")
    .trim()
    .split(" ")
    .filter(Boolean);
  const titleWords: string[] = [];

  for (const word of words) {
    const normalized = word.replace(/^[“"'(]+|[”"'),.;:]+$/g, "");
    const first = normalized.charAt(0);
    const isConnector = trailingWords.has(normalized);
    const startsLikeTitle = first === first.toUpperCase() && /[A-Z0-9“]/.test(first);

    if (titleWords.length > 0 && stopWords.has(normalized)) {
      break;
    }
    if (!startsLikeTitle && !isConnector && titleWords.length > 0) {
      break;
    }
    if (titleWords.length >= 8) {
      break;
    }

    titleWords.push(word.replace(/[.;:,]+$/g, ""));
  }

  while (titleWords.length > 1 && trailingWords.has(titleWords[titleWords.length - 1].replace(/^[“"']|[”"']$/g, ""))) {
    titleWords.pop();
  }

  return titleWords.join(" ").trim().slice(0, 120);
}

function isWeakDetectedHeadingTitle(title: string): boolean {
  return (
    title.length < 3 ||
    /^https?:\/\//i.test(title) ||
    /^\[\d+\]/.test(title) ||
    /^(Here|There|This|That|These|Those|However|Because|Although|When|Why|What)$/i.test(title)
  );
}

function createHeadingBodyPreview(text: string, matchEnd: number, title: string): string {
  const repeatedHeadingPattern = new RegExp(`^\\s*\\d{1,2}\\.\\s+${escapeRegExp(title)}\\s*`, "i");
  const afterHeading = text
    .slice(matchEnd)
    .replace(repeatedHeadingPattern, "")
    .replace(/^\s*[:.-]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = text
    .replace(/\s+/g, " ")
    .replace(repeatedHeadingPattern, "")
    .trim();
  const preview = afterHeading || fallback || title;
  return preview.length > 420 ? `${preview.slice(0, 417).trim()}...` : preview;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNumberedHeadingCandidates(sections: SectionSourceForMap[]): NumberedHeadingCandidate[] {
  const candidates: NumberedHeadingCandidate[] = [];
  const headingPattern = /\b(\d{1,2})\.\s+(.+?)(?=\s+\d{1,2}\.\s+[A-Z“The]|\n{2,}|$)/g;
  let globalPosition = 0;

  sections.forEach((section) => {
    const text = `${section.title ? `${section.title}\n\n` : ""}${section.text || section.textPreview}`;
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(text)) !== null) {
      const number = Number(match[1]);
      const title = cleanDetectedHeadingTitle(match[2] || "");
      if (
        Number.isInteger(number) &&
        number > 0 &&
        number <= 30 &&
        !isWeakDetectedHeadingTitle(title)
      ) {
        candidates.push({
          number,
          title,
          sectionIndex: section.sectionIndex,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          textPreview: section.textPreview || section.text.slice(0, 420),
          bodyPreview: createHeadingBodyPreview(text, match.index + match[0].length, title),
          position: globalPosition + match.index,
        });
      }
    }
    globalPosition += text.length + 1;
  });

  const byNumber = new Map<number, NumberedHeadingCandidate>();
  candidates
    .sort((left, right) => left.position - right.position)
    .forEach((candidate) => {
      if (!byNumber.has(candidate.number)) {
        byNumber.set(candidate.number, candidate);
      }
    });

  return Array.from(byNumber.values()).sort((left, right) => left.number - right.number);
}

function createHeadingAwareSectionMapEntries(
  sections: Array<{
    sectionIndex: number;
    title: string;
    textPreview: string;
    text?: string;
    pageStart: number;
    pageEnd: number;
  }>,
  targetCount: number
): SectionMapEntry[] {
  const sectionSources: SectionSourceForMap[] = sections.map((section) => ({
    ...section,
    text: section.text || section.textPreview,
  }));
  const headings = extractNumberedHeadingCandidates(sectionSources)
    .filter((heading) => heading.number <= targetCount)
    .slice(0, targetCount);

  if (headings.length < Math.min(targetCount, 4)) {
    return [];
  }

  return headings.map((heading) => {
    return {
      sectionNumber: heading.number,
      title: createUserFacingSectionTitle(heading.title, heading.bodyPreview || heading.textPreview, heading.number),
      summary: heading.bodyPreview || heading.textPreview || heading.title,
      sourceSectionStart: heading.sectionIndex,
      sourceSectionEnd: heading.sectionIndex,
      pageStart: heading.pageStart,
      pageEnd: heading.pageEnd,
    };
  });
}

function assessDocumentStructure(
  mimeType: string,
  extraction: TextExtractionResult,
  sections: BookSection[]
): StructureAssessment {
  if (mimeType !== "application/pdf") {
    return {
      structureQuality: extraction.quality ?? "text",
      formatWarning: "",
    };
  }

  const pageCount = extraction.pageCount || 0;
  const sectionsPerPage = pageCount > 0 ? sections.length / pageCount : sections.length;
  const textPerPage = pageCount > 0 ? extraction.text.length / pageCount : extraction.text.length;

  if (extraction.quality !== "layout") {
    return {
      structureQuality: "poor",
      formatWarning:
        "This PDF has limited layout data. Reading may be less comfortable, but search and AI questions can still work.",
    };
  }

  if (sections.length < 4 || sectionsPerPage < 0.18 || textPerPage < 280) {
    return {
      structureQuality: "limited",
      formatWarning:
        "This PDF appears to have sparse or irregular text structure. Reading may be less comfortable, but search and AI questions can still work.",
    };
  }

  return {
    structureQuality: "layout",
    formatWarning: "",
  };
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
    const sections =
      extraction.sections && extraction.sections.length > 0
        ? extraction.sections
        : createBookSections(extraction.text);
    const outline =
      extraction.outline && extraction.outline.length > 0
        ? extraction.outline
        : buildBookOutline(sections);
    const structureAssessment = assessDocumentStructure(mimeType, extraction, sections);
    const language = detectLanguage(extraction.text);
    const bookScope = resolveBookScope(userId, bookSnapshot);

    await jobRef.update({
      stage: "embedding_chunks",
      progress: 65,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const embeddingsByIndex = await createChunkEmbeddingMap(chunks);

    await clearExistingChunks(bookId);
    await clearExistingSections(bookId);
    await writeChunks(chunks, userId, bookId, bookScope, language, embeddingsByIndex);
    await writeSections(sections, userId, bookId, bookScope);

    await db.runTransaction(async (transaction) => {
      transaction.update(bookRef, {
        status: "text_ready",
        tenantId: bookScope.tenantId,
        workspaceId: bookScope.workspaceId,
        libraryId: bookScope.libraryId,
        language,
        pageCount: extraction.pageCount,
        textLength: extraction.text.length,
        textBytes,
        chunkCount: chunks.length,
        sectionCount: sections.length,
        structureQuality: structureAssessment.structureQuality,
        formatWarning: structureAssessment.formatWarning,
        embeddedChunkCount: embeddingsByIndex.size,
        embeddingModel: embeddingsByIndex.size > 0 ? OPENAI_EMBEDDING_MODEL : "",
        embeddingDimensions: embeddingsByIndex.size > 0 ? DEFAULT_EMBEDDING_DIMENSIONS : 0,
        vectorBackend: "firestore",
        vectorIndexName: DEFAULT_VECTOR_INDEX_NAME,
        vectorNamespace: bookScope.vectorNamespace,
        chunkerVersion: CHUNKER_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
        outline,
        updatedAt: FieldValue.serverTimestamp(),
        textReadyAt: FieldValue.serverTimestamp(),
      });
      transaction.update(jobRef, {
        status: "completed",
        tenantId: bookScope.tenantId,
        workspaceId: bookScope.workspaceId,
        libraryId: bookScope.libraryId,
        stage: "text_ready",
        progress: 100,
        chunkCount: chunks.length,
        sectionCount: sections.length,
        embeddedChunkCount: embeddingsByIndex.size,
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
      sectionCount: sections.length,
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

export const registerLoginSession = onCall(
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
    await ensureUserProfile(auth);

    const sessionId = sanitizeClientLabel(request.data?.sessionId);
    if (!sessionId || sessionId.length < 16) {
      throw new HttpsError("invalid-argument", "sessionId is required.");
    }

    const sessionRef = db.collection("userSessions").doc(`${auth.uid}_${sessionId}`);
    const now = FieldValue.serverTimestamp();
    await sessionRef.set(
      {
        userId: auth.uid,
        sessionId,
        browser: sanitizeClientLabel(request.data?.browser, "Unknown browser"),
        os: sanitizeClientLabel(request.data?.os, "Unknown OS"),
        device: sanitizeClientLabel(request.data?.device, "This device"),
        userAgent: sanitizeClientLabel(request.data?.userAgent),
        locationLabel: "Approximate location unavailable",
        status: "active",
        createdAt: now,
        lastSeenAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    const activeSessions = await db
      .collection("userSessions")
      .where("userId", "==", auth.uid)
      .where("status", "==", "active")
      .get();
    const sortedSessions = activeSessions.docs
      .map((sessionSnapshot) => ({
        ref: sessionSnapshot.ref,
        id: sessionSnapshot.id,
        lastSeenAtMs:
          typeof sessionSnapshot.get("lastSeenAt")?.toMillis === "function"
            ? sessionSnapshot.get("lastSeenAt").toMillis()
            : 0,
      }))
      .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs);
    const overflow = sortedSessions
      .filter((session) => session.id !== sessionRef.id)
      .slice(Math.max(0, MAX_ACTIVE_SESSIONS - 1));

    if (overflow.length > 0) {
      const batch = db.batch();
      overflow.forEach((session) => {
        batch.update(session.ref, {
          status: "revoked",
          revokedAt: now,
          updatedAt: now,
        });
      });
      await batch.commit();
    }

    const currentSession = await sessionRef.get();
    const currentStatus = currentSession.get("status") ?? "active";

    if (currentStatus !== "active") {
      await getAuth().revokeRefreshTokens(auth.uid);
    }

    return {
      ok: currentStatus === "active",
      sessionId,
      status: currentStatus,
      activeSessionLimit: MAX_ACTIVE_SESSIONS,
    };
  }
);

export const getAccountSecurity = onCall(
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
    await ensureUserProfile(auth);

    const sessionsSnapshot = await db
      .collection("userSessions")
      .where("userId", "==", auth.uid)
      .limit(20)
      .get();
    const sessions = sessionsSnapshot.docs
      .map((sessionSnapshot) => ({
        id: sessionSnapshot.id,
        sessionId: sessionSnapshot.get("sessionId") ?? "",
        browser: sessionSnapshot.get("browser") ?? "Unknown browser",
        os: sessionSnapshot.get("os") ?? "Unknown OS",
        device: sessionSnapshot.get("device") ?? "This device",
        locationLabel: sessionSnapshot.get("locationLabel") ?? "Approximate location unavailable",
        status: sessionSnapshot.get("status") ?? "unknown",
        lastSeenAtMs:
          typeof sessionSnapshot.get("lastSeenAt")?.toMillis === "function"
            ? sessionSnapshot.get("lastSeenAt").toMillis()
            : 0,
        createdAtMs:
          typeof sessionSnapshot.get("createdAt")?.toMillis === "function"
            ? sessionSnapshot.get("createdAt").toMillis()
            : 0,
      }))
      .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)
      .slice(0, 10);

    return {
      ok: true,
      activeSessionLimit: MAX_ACTIVE_SESSIONS,
      sessions,
    };
  }
);

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
    await requireActiveSession(auth, request.data?.sessionId);

    await ensureUserProfile(auth);

    const [userSnapshot, booksSnapshot, conversationsSnapshot, artifactsSnapshot] = await Promise.all([
      db.collection("users").doc(auth.uid).get(),
      db.collection("books").where("userId", "==", auth.uid).get(),
      db.collection("conversations").where("userId", "==", auth.uid).get(),
      db.collection("bookArtifacts").where("userId", "==", auth.uid).get(),
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
      artifacts: artifactsSnapshot.docs.map((artifactSnapshot) => ({
        id: artifactSnapshot.id,
        ...artifactSnapshot.data(),
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
    await requireActiveSession(auth, request.data?.sessionId);
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
        displayTitle: bookSnapshot.get("displayTitle") ?? createDisplayTitle(String(bookSnapshot.get("title") ?? "Untitled")),
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
    await requireActiveSession(auth, request.data?.sessionId);
    const page = Math.max(0, Math.floor(Number(request.data?.page) || 0));
    const pageSize = Math.min(12, Math.max(4, Math.floor(Number(request.data?.pageSize) || 8)));
    const bookSnapshot = await db.collection("books").doc(bookId).get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    if (bookSnapshot.get("status") !== "text_ready") {
      throw new HttpsError("failed-precondition", "Book text is not ready yet.");
    }

    const sectionsSnapshot = await db
      .collection("bookSections")
      .where("bookId", "==", bookId)
      .limit(900)
      .get();
    const allSections = sectionsSnapshot.docs
      .filter((sectionSnapshot) => sectionSnapshot.get("userId") === auth.uid)
      .map((sectionSnapshot) => ({
        id: sectionSnapshot.id,
        chunkIndex: Number(sectionSnapshot.get("sectionIndex")) || 0,
        title:
          typeof sectionSnapshot.get("title") === "string"
            ? sectionSnapshot.get("title")
            : "",
        text:
          typeof sectionSnapshot.get("text") === "string"
            ? sectionSnapshot.get("text")
            : "",
      }))
      .filter((section) => section.text.trim())
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    const fallbackChunksSnapshot =
      allSections.length === 0
        ? await db
            .collection("bookChunks")
            .where("bookId", "==", bookId)
            .limit(900)
            .get()
        : null;
    const fallbackChunks = fallbackChunksSnapshot
      ? fallbackChunksSnapshot.docs
          .filter((chunkSnapshot) => chunkSnapshot.get("userId") === auth.uid)
          .map((chunkSnapshot) => ({
            id: chunkSnapshot.id,
            chunkIndex: Number(chunkSnapshot.get("chunkIndex")) || 0,
            title: "",
            text:
              typeof chunkSnapshot.get("text") === "string"
                ? chunkSnapshot.get("text")
                : "",
          }))
          .filter((chunk) => chunk.text.trim())
          .sort((left, right) => left.chunkIndex - right.chunkIndex)
      : [];
    const readerItems = allSections.length > 0 ? allSections : fallbackChunks;
    const start = page * pageSize;

    return {
      ok: true,
      book: {
        id: bookSnapshot.id,
        title: bookSnapshot.get("title") ?? "Untitled",
        chunkCount: Number(bookSnapshot.get("sectionCount")) || readerItems.length,
      },
      page,
      pageSize,
      totalChunks: readerItems.length,
      chunks: readerItems.slice(start, start + pageSize),
    };
  }
);

export const listBookArtifacts = onCall(
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
    await requireActiveSession(auth, request.data?.sessionId);
    await requireVerifiedEmail(auth);

    const bookSnapshot = await db.collection("books").doc(bookId).get();
    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    const snapshot = await db
      .collection("bookArtifacts")
      .where("userId", "==", auth.uid)
      .where("bookId", "==", bookId)
      .where("type", "==", "section_map")
      .limit(20)
      .get();

    return {
      ok: true,
      artifacts: snapshot.docs
        .map((artifactSnapshot) => {
          const rawSections: unknown[] = Array.isArray(artifactSnapshot.get("sections"))
            ? artifactSnapshot.get("sections")
            : [];
          const status = artifactSnapshot.get("status") || "";
          if (status !== "ready") {
            return null;
          }
          const sectionEntries = rawSections
            .map(normalizeSectionMapEntry)
            .filter((entry): entry is SectionMapEntry => entry !== null);
          const weakTitleCount = countWeakSectionMapTitles(sectionEntries);
          const hasHeadingAwareTitles =
            sectionEntries.length > 0 &&
              weakTitleCount === 0 &&
              sectionEntries.some((section) => !/^(Chapter|Section|Part) \d+$/i.test(section.title));

          return {
            id: artifactSnapshot.id,
            title: artifactSnapshot.get("title") || "Section map",
            type: artifactSnapshot.get("type") || "",
            bookId: artifactSnapshot.get("bookId") || "",
            bookTitle: artifactSnapshot.get("bookTitle") || "",
            status,
            generatedBy: artifactSnapshot.get("generatedBy") || "",
            targetSectionCount: Number(artifactSnapshot.get("targetSectionCount")) || 0,
            sourceSectionCount: Number(artifactSnapshot.get("sourceSectionCount")) || 0,
            weakTitleCount,
            mapQuality:
              weakTitleCount > 0
                ? "weak_titles"
                : hasHeadingAwareTitles
                  ? "heading_aware"
                  : "grouped",
            sections: sectionEntries,
            createdAt: normalizeFirestoreValue(artifactSnapshot.get("createdAt")),
            updatedAt: normalizeFirestoreValue(artifactSnapshot.get("updatedAt")),
          };
        })
        .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
        .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || ""))),
    };
  }
);

export const generateBookSectionMap = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB", secrets: [openAiApiKey], invoker: "public" },
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
    const targetSectionCount = Math.max(
      3,
      Math.min(12, Math.floor(Number(request.data?.targetSectionCount) || 6))
    );
    await requireActiveSession(auth, request.data?.sessionId);
    await requireVerifiedEmail(auth);

    const sectionMap = await createBookSectionMapArtifact(auth.uid, bookId, targetSectionCount);

    return {
      ok: true,
      artifact: {
        ...sectionMap.artifact,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  }
);

export const deleteBookArtifact = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "256MiB", invoker: "public" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const artifactId = assertString(request.data?.artifactId, "artifactId");
    await requireActiveSession(auth, request.data?.sessionId);
    await requireVerifiedEmail(auth);

    const artifactRef = db.collection("bookArtifacts").doc(artifactId);
    const artifactSnapshot = await artifactRef.get();
    if (!artifactSnapshot.exists || artifactSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book map was not found.");
    }

    await artifactRef.update({
      status: "deleted",
      deletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      artifactId,
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
    await requireActiveSession(auth, request.data?.sessionId);
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
    await requireActiveSession(auth, request.data?.sessionId);
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
    const bookScope = buildDefaultBookScope(auth.uid);
    const storagePath = `userUploads/${auth.uid}/${bookRef.id}/${fileName}`;
    const now = FieldValue.serverTimestamp();

    await bookRef.set({
      userId: auth.uid,
      tenantId: bookScope.tenantId,
      workspaceId: bookScope.workspaceId,
      libraryId: bookScope.libraryId,
      title,
      displayTitle: createDisplayTitle(title),
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
      sectionCount: 0,
      embeddedChunkCount: 0,
      embeddingModel: "",
      embeddingDimensions: 0,
      vectorBackend: "firestore",
      vectorIndexName: DEFAULT_VECTOR_INDEX_NAME,
      vectorNamespace: bookScope.vectorNamespace,
      scanStatus: "pending_basic_check",
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
    await requireActiveSession(auth, request.data?.sessionId);
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
    const bookScope = resolveBookScope(auth.uid, bookSnapshot);

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
        scanStatus: "basic_check_passed",
        scannedAt: now,
        updatedAt: now,
      });

      transaction.set(jobRef, {
        userId: auth.uid,
        tenantId: bookScope.tenantId,
        workspaceId: bookScope.workspaceId,
        libraryId: bookScope.libraryId,
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
  { region: "us-central1", timeoutSeconds: 540, memory: "1GiB" },
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
    await requireActiveSession(auth, request.data?.sessionId);
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
    await clearExistingSections(bookId);
    await clearNestedBookSections(bookId);
    await clearIngestionJobs(bookId);
    await clearBookArtifacts(bookId);
    await db
      .collection("users")
      .doc(auth.uid)
      .collection("readerSettings")
      .doc(bookId)
      .delete();
    await db.recursiveDelete(bookRef);
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
    await requireActiveSession(auth, request.data?.sessionId);
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
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB", secrets: [openAiApiKey, pineconeApiKey] },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
      }
      : undefined);
    await requireActiveSession(auth, request.data?.sessionId);
    await requireVerifiedEmail(auth);
    const queryText = assertString(request.data?.query, "query").slice(0, MAX_SEARCH_QUERY_LENGTH);
    const bookId =
      typeof request.data?.bookId === "string" && request.data.bookId.trim()
        ? request.data.bookId.trim()
        : "";

    await ensureUserProfile(auth);
    const search = await runLibrarySearch(auth.uid, queryText, bookId);

    const response: {
      ok: boolean;
      query: string;
      results: LibrarySearchResult[];
      retrievalDiagnostics?: RetrievalDiagnostics;
    } = {
      ok: true,
      query: queryText,
      results: search.results,
    };

    if (canViewRetrievalDiagnostics(auth.uid)) {
      response.retrievalDiagnostics = search.diagnostics;
    }

    return response;
  }
);

async function getCollectionCount(collectionPath: string): Promise<number> {
  const aggregate = await db.collection(collectionPath).count().get();
  return aggregate.data().count;
}

async function getStatusCount(collectionPath: string, status: string): Promise<number> {
  const aggregate = await db
    .collection(collectionPath)
    .where("status", "==", status)
    .count()
    .get();
  return aggregate.data().count;
}

async function writeAdminAuditEvent(input: {
  viewer: AdminViewer;
  action: string;
  targetUserId?: string;
  targetBookId?: string;
  targetConversationId?: string;
  reason?: string;
}) {
  const auditRef = db.collection("adminAuditEvents").doc();
  await auditRef.set({
    id: auditRef.id,
    viewerUid: input.viewer.uid,
    viewerEmail: input.viewer.email || "",
    action: input.action,
    targetUserId: input.targetUserId || "",
    targetBookId: input.targetBookId || "",
    targetConversationId: input.targetConversationId || "",
    reason: input.reason || "",
    createdAt: FieldValue.serverTimestamp(),
  });
}

type AdminUserLabel = {
  userId: string;
  email: string;
  displayName: string;
  label: string;
};

async function getAdminUserLabels(userIds: string[]): Promise<Map<string, AdminUserLabel>> {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueUserIds.length === 0) {
    return new Map();
  }

  const userSnapshots = await db.getAll(
    ...uniqueUserIds.map((userId) => db.collection("users").doc(userId))
  );
  const labels = new Map<string, AdminUserLabel>();

  userSnapshots.forEach((userSnapshot) => {
    const email =
      typeof userSnapshot.get("email") === "string" ? userSnapshot.get("email") : "";
    const displayName =
      typeof userSnapshot.get("displayName") === "string"
        ? userSnapshot.get("displayName")
        : "";
    const userId = userSnapshot.id;

    labels.set(userId, {
      userId,
      email,
      displayName,
      label: email || displayName || userId,
    });
  });

  uniqueUserIds.forEach((userId) => {
    if (!labels.has(userId)) {
      labels.set(userId, {
        userId,
        email: "",
        displayName: "",
        label: userId,
      });
    }
  });

  return labels;
}

export const adminGetDashboard = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const viewer = requireAdmin(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const [
      userCount,
      bookCount,
      textReadyBookCount,
      failedBookCount,
      conversationCount,
      failedIngestionJobCount,
      queuedIngestionJobCount,
      routeTraceCount,
    ] = await Promise.all([
      getCollectionCount("users"),
      getCollectionCount("books"),
      getStatusCount("books", "text_ready"),
      getStatusCount("books", "failed"),
      getCollectionCount("conversations"),
      getStatusCount("ingestionJobs", "failed"),
      getStatusCount("ingestionJobs", "queued"),
      getCollectionCount("routeTraces"),
    ]);
    const pineconeSnapshot = await db
      .collection("books")
      .where("vectorBackendCandidate", "==", "pinecone")
      .limit(200)
      .get();
    const pineconeUserLabels = await getAdminUserLabels(
      pineconeSnapshot.docs.map((bookSnapshot) => String(bookSnapshot.get("userId") || ""))
    );
    const pineconeBooks = pineconeSnapshot.docs.map((bookSnapshot) => ({
      bookId: bookSnapshot.id,
      title:
        bookSnapshot.get("displayTitle") ||
        bookSnapshot.get("title") ||
        bookSnapshot.id,
      userId: bookSnapshot.get("userId") || "",
      userLabel: pineconeUserLabels.get(String(bookSnapshot.get("userId") || ""))?.label || "",
      userEmail: pineconeUserLabels.get(String(bookSnapshot.get("userId") || ""))?.email || "",
      userDisplayName:
        pineconeUserLabels.get(String(bookSnapshot.get("userId") || ""))?.displayName || "",
      indexedChunkCount: Number(bookSnapshot.get("pineconeIndexedChunkCount")) || 0,
      missingChunkCount: Number(bookSnapshot.get("pineconeMissingChunkCount")) || 0,
    }));

    await writeAdminAuditEvent({
      viewer,
      action: "adminGetDashboard",
    });

    return {
      ok: true,
      viewer: {
        uid: viewer.uid,
        email: viewer.email || "",
      },
      counts: {
        users: userCount,
        books: bookCount,
        textReadyBooks: textReadyBookCount,
        failedBooks: failedBookCount,
        conversations: conversationCount,
        failedIngestionJobs: failedIngestionJobCount,
        queuedIngestionJobs: queuedIngestionJobCount,
        routeTraces: routeTraceCount,
        pineconeBooks: pineconeBooks.length,
      },
      pineconeBooks,
    };
  }
);

export const adminListRecentConversations = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const viewer = requireAdmin(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const limit = Math.max(1, Math.min(Number(request.data?.limit) || 30, 80));
    const snapshot = await db
      .collection("conversations")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    const userLabels = await getAdminUserLabels(
      snapshot.docs.map((conversationSnapshot) => String(conversationSnapshot.get("userId") || ""))
    );
    const conversations = snapshot.docs.map((conversationSnapshot) => ({
      id: conversationSnapshot.id,
      userId: conversationSnapshot.get("userId") || "",
      userLabel: userLabels.get(String(conversationSnapshot.get("userId") || ""))?.label || "",
      userEmail: userLabels.get(String(conversationSnapshot.get("userId") || ""))?.email || "",
      userDisplayName:
        userLabels.get(String(conversationSnapshot.get("userId") || ""))?.displayName || "",
      title: conversationSnapshot.get("title") || "Untitled",
      mode: conversationSnapshot.get("mode") || "",
      scopedBookId: conversationSnapshot.get("scopedBookId") || "",
      scope: conversationSnapshot.get("scope") || "",
      sourceCount: Number(conversationSnapshot.get("sourceCount")) || 0,
      latestQuestion: conversationSnapshot.get("latestQuestion") || "",
      latestAnswerPreview: conversationSnapshot.get("latestAnswerPreview") || "",
      retrievalDiagnostics: normalizeFirestoreValue(conversationSnapshot.get("retrievalDiagnostics")),
      routeTraceId: conversationSnapshot.get("routeTraceId") || "",
      createdAt: normalizeFirestoreValue(conversationSnapshot.get("createdAt")),
      updatedAt: normalizeFirestoreValue(conversationSnapshot.get("updatedAt")),
    }));

    await writeAdminAuditEvent({
      viewer,
      action: "adminListRecentConversations",
    });

    return {
      ok: true,
      conversations,
    };
  }
);

export const adminListBooks = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const viewer = requireAdmin(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const limit = Math.max(1, Math.min(Number(request.data?.limit) || 60, 120));
    const snapshot = await db
      .collection("books")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    const userLabels = await getAdminUserLabels(
      snapshot.docs.map((bookSnapshot) => String(bookSnapshot.get("userId") || ""))
    );
    const books = snapshot.docs.map((bookSnapshot) => ({
      id: bookSnapshot.id,
      userId: bookSnapshot.get("userId") || "",
      userLabel: userLabels.get(String(bookSnapshot.get("userId") || ""))?.label || "",
      userEmail: userLabels.get(String(bookSnapshot.get("userId") || ""))?.email || "",
      userDisplayName:
        userLabels.get(String(bookSnapshot.get("userId") || ""))?.displayName || "",
      title: bookSnapshot.get("title") || "Untitled",
      displayTitle:
        bookSnapshot.get("displayTitle") ||
        createDisplayTitle(String(bookSnapshot.get("title") || "Untitled")),
      status: bookSnapshot.get("status") || "",
      contentType: bookSnapshot.get("contentType") || "",
      sizeBytes: Number(bookSnapshot.get("sizeBytes")) || 0,
      pageCount: Number(bookSnapshot.get("pageCount")) || 0,
      chunkCount: Number(bookSnapshot.get("chunkCount")) || 0,
      sectionCount: Number(bookSnapshot.get("sectionCount")) || 0,
      embeddedChunkCount: Number(bookSnapshot.get("embeddedChunkCount")) || 0,
      pineconeIndexedChunkCount: Number(bookSnapshot.get("pineconeIndexedChunkCount")) || 0,
      pineconeMissingChunkCount: Number(bookSnapshot.get("pineconeMissingChunkCount")) || 0,
      vectorBackendCandidate: bookSnapshot.get("vectorBackendCandidate") || "",
      structureQuality: bookSnapshot.get("structureQuality") || "",
      formatWarning: bookSnapshot.get("formatWarning") || "",
      language: bookSnapshot.get("language") || "",
      createdAt: normalizeFirestoreValue(bookSnapshot.get("createdAt")),
      updatedAt: normalizeFirestoreValue(bookSnapshot.get("updatedAt")),
    }));

    await writeAdminAuditEvent({
      viewer,
      action: "adminListBooks",
    });

    return {
      ok: true,
      books,
    };
  }
);

export const adminListUsers = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const viewer = requireAdmin(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const limit = Math.max(1, Math.min(Number(request.data?.limit) || 80, 120));
    const snapshot = await db.collection("users").limit(limit).get();

    const users = await Promise.all(
      snapshot.docs.map(async (userSnapshot) => {
        const userId = userSnapshot.id;
        const [booksCount, conversationsCount, activeSessionsCount] = await Promise.all([
          db.collection("books").where("userId", "==", userId).count().get(),
          db.collection("conversations").where("userId", "==", userId).count().get(),
          db
            .collection("userSessions")
            .where("userId", "==", userId)
            .where("status", "==", "active")
            .count()
            .get(),
        ]);
        const email = typeof userSnapshot.get("email") === "string" ? userSnapshot.get("email") : "";
        const displayName =
          typeof userSnapshot.get("displayName") === "string"
            ? userSnapshot.get("displayName")
            : "";

        return {
          userId,
          email,
          displayName,
          userLabel: email || displayName || userId,
          plan: userSnapshot.get("plan") || "free",
          subscriptionStatus: userSnapshot.get("subscriptionStatus") || "none",
          emailVerified: userSnapshot.get("emailVerified") === true,
          onboardingStatus: userSnapshot.get("onboardingStatus") || "",
          usageCurrentPeriod: normalizeFirestoreValue(userSnapshot.get("usageCurrentPeriod")),
          limits: normalizeFirestoreValue(userSnapshot.get("limits")),
          bookCount: booksCount.data().count,
          conversationCount: conversationsCount.data().count,
          activeSessionCount: activeSessionsCount.data().count,
          lastLoginAt: normalizeFirestoreValue(userSnapshot.get("lastLoginAt")),
          createdAt: normalizeFirestoreValue(userSnapshot.get("createdAt")),
          updatedAt: normalizeFirestoreValue(userSnapshot.get("updatedAt")),
        };
      })
    );

    await writeAdminAuditEvent({
      viewer,
      action: "adminListUsers",
    });

    return {
      ok: true,
      users,
    };
  }
);

export const adminGetBookDebug = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const viewer = requireAdmin(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const bookId = assertString(request.data?.bookId, "bookId");
    const bookSnapshot = await db.collection("books").doc(bookId).get();
    if (!bookSnapshot.exists) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    const [jobsSnapshot, chunksSnapshot, sectionsSnapshot, artifactsSnapshot] = await Promise.all([
      db
        .collection("ingestionJobs")
        .where("bookId", "==", bookId)
        .limit(20)
        .get(),
      db
        .collection("bookChunks")
        .where("bookId", "==", bookId)
        .limit(20)
        .get(),
      db
        .collection("bookSections")
        .where("bookId", "==", bookId)
        .limit(30)
        .get(),
      db
        .collection("bookArtifacts")
        .where("bookId", "==", bookId)
        .limit(20)
        .get(),
    ]);
    const chunks = chunksSnapshot.docs
      .map((chunkSnapshot) => ({
        id: chunkSnapshot.id,
        chunkIndex: Number(chunkSnapshot.get("chunkIndex")) || 0,
        charStart: Number(chunkSnapshot.get("charStart")) || 0,
        charEnd: Number(chunkSnapshot.get("charEnd")) || 0,
        textPreview:
          typeof chunkSnapshot.get("textPreview") === "string"
            ? chunkSnapshot.get("textPreview")
            : "",
        hasEmbedding: Array.isArray(chunkSnapshot.get("embedding")),
      }))
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    const sections = sectionsSnapshot.docs
      .map((sectionSnapshot) => ({
        id: sectionSnapshot.id,
        sectionIndex: Number(sectionSnapshot.get("sectionIndex")) || 0,
        title:
          typeof sectionSnapshot.get("title") === "string"
            ? sectionSnapshot.get("title")
            : "",
        pageStart: Number(sectionSnapshot.get("pageStart")) || 0,
        pageEnd: Number(sectionSnapshot.get("pageEnd")) || 0,
        textPreview:
          typeof sectionSnapshot.get("textPreview") === "string"
            ? sectionSnapshot.get("textPreview")
            : "",
      }))
      .sort((left, right) => left.sectionIndex - right.sectionIndex);
    const jobs = jobsSnapshot.docs
      .map((jobSnapshot): Record<string, unknown> => ({
        id: jobSnapshot.id,
        ...(normalizeFirestoreValue(jobSnapshot.data()) as Record<string, unknown>),
      }))
      .sort((left, right) =>
        String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
      );
    const artifacts = artifactsSnapshot.docs
      .map((artifactSnapshot) => {
        const rawSections: unknown[] = Array.isArray(artifactSnapshot.get("sections"))
          ? artifactSnapshot.get("sections")
          : [];
        const sectionEntries = rawSections
          .map(normalizeSectionMapEntry)
          .filter((entry): entry is SectionMapEntry => entry !== null);
        const weakTitleCount = countWeakSectionMapTitles(sectionEntries);
        const hasHeadingAwareTitles =
          sectionEntries.length > 0 &&
          weakTitleCount === 0 &&
          sectionEntries.some((section) => !/^Section \d+$/i.test(section.title));

        return {
          id: artifactSnapshot.id,
          type: artifactSnapshot.get("type") || "",
          title: artifactSnapshot.get("title") || "",
          status: artifactSnapshot.get("status") || "",
          generatedBy: artifactSnapshot.get("generatedBy") || "",
          targetSectionCount: Number(artifactSnapshot.get("targetSectionCount")) || 0,
          sourceSectionCount: Number(artifactSnapshot.get("sourceSectionCount")) || 0,
          sectionCount: sectionEntries.length,
          weakTitleCount,
          mapQuality:
            weakTitleCount > 0
              ? "weak_titles"
              : hasHeadingAwareTitles
                ? "heading_aware"
                : "grouped",
          sections: sectionEntries.map((section) => ({
            sectionNumber: section.sectionNumber,
            title: section.title,
            sourceSectionStart: section.sourceSectionStart,
            sourceSectionEnd: section.sourceSectionEnd,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            summaryPreview: section.summary.slice(0, 280),
          })),
          createdAt: normalizeFirestoreValue(artifactSnapshot.get("createdAt")),
          updatedAt: normalizeFirestoreValue(artifactSnapshot.get("updatedAt")),
        };
      })
      .sort((left, right) =>
        String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
      );

    await writeAdminAuditEvent({
      viewer,
      action: "adminGetBookDebug",
      targetUserId: bookSnapshot.get("userId") || "",
      targetBookId: bookId,
      reason:
        typeof request.data?.reason === "string"
          ? request.data.reason.slice(0, 240)
          : "Debug book ingestion and metadata.",
    });

    return {
      ok: true,
      book: {
        id: bookSnapshot.id,
        ...(normalizeFirestoreValue(bookSnapshot.data()) as Record<string, unknown>),
      },
      ingestionJobs: jobs,
      chunks,
      sections,
      artifacts,
    };
  }
);

export const adminGetConversationDebug = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    const viewer = requireAdmin(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    const conversationId = assertString(request.data?.conversationId, "conversationId");
    const conversationSnapshot = await db.collection("conversations").doc(conversationId).get();
    if (!conversationSnapshot.exists) {
      throw new HttpsError("not-found", "Conversation was not found.");
    }

    const messagesSnapshot = await conversationSnapshot.ref
      .collection("messages")
      .orderBy("createdAt", "asc")
      .get();
    const routeTraceId =
      typeof conversationSnapshot.get("routeTraceId") === "string"
        ? conversationSnapshot.get("routeTraceId")
        : "";
    const routeTraceSnapshot = routeTraceId
      ? await db.collection("routeTraces").doc(routeTraceId).get()
      : null;

    await writeAdminAuditEvent({
      viewer,
      action: "adminGetConversationDebug",
      targetUserId: conversationSnapshot.get("userId") || "",
      targetBookId: conversationSnapshot.get("scopedBookId") || "",
      targetConversationId: conversationId,
      reason:
        typeof request.data?.reason === "string"
          ? request.data.reason.slice(0, 240)
          : "Debug conversation retrieval route.",
    });

    return {
      ok: true,
      conversation: {
        id: conversationSnapshot.id,
        ...(normalizeFirestoreValue(conversationSnapshot.data()) as Record<string, unknown>),
      },
      messages: messagesSnapshot.docs.map((messageSnapshot) => ({
        id: messageSnapshot.id,
        ...(normalizeFirestoreValue(messageSnapshot.data()) as Record<string, unknown>),
      })),
      routeTrace:
        routeTraceSnapshot?.exists
          ? {
              id: routeTraceSnapshot.id,
              ...(normalizeFirestoreValue(routeTraceSnapshot.data()) as Record<string, unknown>),
            }
          : null,
    };
  }
);

export const askLibrary = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB", secrets: [openAiApiKey, pineconeApiKey] },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
      }
      : undefined);
    await requireActiveSession(auth, request.data?.sessionId);
    await requireVerifiedEmail(auth);
    const queryText = assertString(request.data?.query, "query").slice(0, MAX_SEARCH_QUERY_LENGTH);
    const locale =
      typeof request.data?.locale === "string" && request.data.locale === "de" ? "de" : "en";
    const requestedBookId =
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

    const inheritedContext = !requestedBookId && isContextualFollowUp(queryText)
      ? await loadLatestConversationContext(auth.uid)
      : null;
    const bookId = requestedBookId || inheritedContext?.bookId || "";
    const sectionMapTargetCount = bookId ? parseSectionMapTargetCount(queryText) : 0;
    const createdSectionMap = sectionMapTargetCount
      ? await createBookSectionMapArtifact(auth.uid, bookId, sectionMapTargetCount)
      : null;
    const sectionMapCreationSearch = createdSectionMap
      ? buildSectionMapCreationSearch(
          auth.uid,
          bookId,
          createdSectionMap.bookTitle,
          createdSectionMap.bookSnapshot,
          createdSectionMap.artifactId,
          createdSectionMap.sections
        )
      : null;
    const inheritedSectionSearch =
      !sectionMapCreationSearch && inheritedContext?.activeArtifactId && inheritedContext.activeSectionNumber
        ? await resolveArtifactSectionSearch(
            auth.uid,
            queryText,
            bookId,
            inheritedContext.activeArtifactId,
            inheritedContext.activeSectionNumber
          )
        : null;
    const sectionMapSearch =
      sectionMapCreationSearch ??
      inheritedSectionSearch ??
      (await resolveSectionMapSearch(auth.uid, queryText, bookId));
    const search = sectionMapSearch ?? (await runLibrarySearch(auth.uid, queryText, bookId));
    const results = search.results;
    const generatedSectionMapAnswer = createdSectionMap
      ? createSectionMapAnswer(createdSectionMap.bookTitle, createdSectionMap.sections, locale)
      : "";
    const aiAnswer = generatedSectionMapAnswer || (await createAiGroundedAnswer(queryText, results, locale));
    const answer = aiAnswer ?? createGroundedDraft(queryText, results, locale);
    const sourceBooks = summarizeSourceBooks(results);
    const conversationScope = buildDefaultBookScope(auth.uid);
    const activeArtifactId = search.activeArtifactId || "";
    const activeSectionNumber = search.activeSectionNumber || 0;
    const activeMode = createdSectionMap
      ? "section_map_created"
      : activeArtifactId && activeSectionNumber
        ? "section_map"
        : "book_qa";
    const now = FieldValue.serverTimestamp();
    const conversationRef = db.collection("conversations").doc();
    const routeTraceRef = db.collection("routeTraces").doc();
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
        tenantId: conversationScope.tenantId,
        workspaceId: conversationScope.workspaceId,
        libraryId: conversationScope.libraryId,
        title: queryText.slice(0, 90),
        mode: aiAnswer ? "ai_grounded" : "source_draft",
        status: "answered",
        messageCount: 2,
        sourceCount: results.length,
        latestQuestion: queryText,
        latestAnswerPreview: answer.slice(0, 360),
        scopedBookId: bookId,
        scope: bookId ? "single_book" : "library",
        activeMode,
        activeBookId: bookId,
        activeArtifactId,
        activeSectionNumber,
        contextSource: inheritedContext ? "latest_conversation" : "explicit_or_fresh",
        parentConversationId: inheritedContext?.conversationId || "",
        sourceBookIds: sourceBooks.map((sourceBook) => sourceBook.bookId),
        sourceBookTitles: sourceBooks.map((sourceBook) => sourceBook.bookTitle),
        retrievalDiagnostics: search.diagnostics,
        routeTraceId: routeTraceRef.id,
        hasUnavailableSources: false,
        unavailableBookTitles: [],
        createdAt: now,
        updatedAt: now,
      });
      transaction.set(userMessageRef, {
        userId: auth.uid,
        tenantId: conversationScope.tenantId,
        workspaceId: conversationScope.workspaceId,
        libraryId: conversationScope.libraryId,
        role: "user",
        text: queryText,
        createdAt: now,
      });
      transaction.set(assistantMessageRef, {
        userId: auth.uid,
        tenantId: conversationScope.tenantId,
        workspaceId: conversationScope.workspaceId,
        libraryId: conversationScope.libraryId,
        role: "assistant",
        text: answer,
        mode: aiAnswer ? "ai_grounded" : "source_draft",
        sources: results.map((result) => ({
          chunkId: result.chunkId || "",
          bookId: result.bookId,
          bookTitle: result.bookTitle,
          chunkIndex: result.chunkIndex,
          excerpt: result.excerpt,
          score: result.score,
        })),
        createdAt: now,
      });
      transaction.set(routeTraceRef, {
        userId: auth.uid,
        tenantId: conversationScope.tenantId,
        workspaceId: conversationScope.workspaceId,
        libraryId: conversationScope.libraryId,
        conversationId: conversationRef.id,
        callable: "askLibrary",
        routeIntent: activeMode === "section_map_created"
          ? "section_map_generation"
          : activeMode === "section_map"
            ? "section_qa"
            : "book_qa",
        selectedBookSource: activeMode === "section_map" || activeMode === "section_map_created"
          ? "section_map_artifact"
          : inheritedContext
            ? "latest_conversation_context"
            : bookId
            ? "explicit_book_scope"
            : "library_scope",
        scopedBookId: bookId,
        activeBookId: bookId,
        activeArtifactId,
        activeSectionNumber,
        contextSource: inheritedContext ? "latest_conversation" : "explicit_or_fresh",
        parentConversationId: inheritedContext?.conversationId || "",
        queryPreview: queryText.slice(0, 180),
        queryLength: queryText.length,
        answerMode: aiAnswer ? "ai_grounded" : "source_draft",
        conversationSaved: true,
        usageIncremented: true,
        sourceCount: results.length,
        sourceBookIds: sourceBooks.map((sourceBook) => sourceBook.bookId),
        sourceChunkIds: results.map((result) => result.chunkId || "").filter(Boolean),
        sourceChunks: results.map((result) => ({
          chunkId: result.chunkId || "",
          bookId: result.bookId,
          bookTitle: result.bookTitle,
          chunkIndex: result.chunkIndex,
          score: result.score,
        })),
        retrievalDiagnostics: search.diagnostics,
        errors: [],
        createdAt: now,
      });
      transaction.update(userRef, {
        "usageCurrentPeriod.messages": FieldValue.increment(1),
        updatedAt: now,
      });
    });

    const response: {
      ok: boolean;
      query: string;
      answer: string;
      mode: string;
      conversationId: string;
      results: LibrarySearchResult[];
      retrievalDiagnostics?: RetrievalDiagnostics;
    } = {
      ok: true,
      query: queryText,
      answer,
      mode: aiAnswer ? "ai_grounded" : "source_draft",
      conversationId: conversationRef.id,
      results,
    };

    if (canViewRetrievalDiagnostics(auth.uid)) {
      response.retrievalDiagnostics = search.diagnostics;
    }

    return response;
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
    await requireActiveSession(auth, request.data?.sessionId);
    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationSnapshot = await conversationRef.get();

    if (!conversationSnapshot.exists || conversationSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Question was not found.");
    }

    await clearConversationMessages(conversationId);
    const routeTraceId =
      typeof conversationSnapshot.get("routeTraceId") === "string"
        ? conversationSnapshot.get("routeTraceId")
        : "";
    if (routeTraceId) {
      await db.collection("routeTraces").doc(routeTraceId).delete().catch(() => undefined);
    }
    await conversationRef.delete();

    return {
      ok: true,
      conversationId,
    };
  }
);

export const deleteAllConversations = onCall(
  { region: "us-central1", timeoutSeconds: 120, memory: "256MiB" },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
        }
      : undefined);
    await requireActiveSession(auth, request.data?.sessionId);
    const confirmation = assertString(request.data?.confirmation, "confirmation");
    if (confirmation.trim().toLowerCase() !== "delete complete history") {
      throw new HttpsError("failed-precondition", "Type the exact confirmation phrase to delete history.");
    }

    await clearUserConversations(auth.uid);

    return {
      ok: true,
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
    await requireActiveSession(auth, request.data?.sessionId);
    const confirmationPhrase = sanitizeClientLabel(request.data?.confirmationPhrase);
    if (confirmationPhrase !== DELETE_CONFIRMATION_PHRASE) {
      throw new HttpsError(
        "failed-precondition",
        `Type ${DELETE_CONFIRMATION_PHRASE} to delete your account.`
      );
    }
    requireRecentAuth(request.auth?.token?.auth_time);

    await clearUserBooks(auth.uid);
    await clearUserConversations(auth.uid);
    await clearUserRouteTraces(auth.uid);
    await clearUserArtifacts(auth.uid);
    await clearUserReaderSettings(auth.uid);
    await clearUserSessions(auth.uid);
    await db.collection("users").doc(auth.uid).delete();
    await getAuth().deleteUser(auth.uid);

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
    await requireActiveSession(auth, request.data?.sessionId);
    const bookSnapshot = await db.collection("books").doc(bookId).get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }
    const bookScope = resolveBookScope(auth.uid, bookSnapshot);
    const language =
      typeof bookSnapshot.get("language") === "string" ? String(bookSnapshot.get("language")) : "";

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

      const chunkId = chunkSnapshot.id;
      const vectorRecordId = buildPineconeVectorId(bookId, chunkIndex);
      batch.update(chunkSnapshot.ref, {
        tenantId: bookScope.tenantId,
        workspaceId: bookScope.workspaceId,
        libraryId: bookScope.libraryId,
        fileId: bookId,
        chunkId,
        embedding,
        embeddingModel: OPENAI_EMBEDDING_MODEL,
        embeddingDimensions: embedding.length,
        vectorBackend: "firestore",
        vectorIndexName: DEFAULT_VECTOR_INDEX_NAME,
        vectorNamespace: bookScope.vectorNamespace,
        vectorRecordId,
        vectorMetadata: buildBookVectorMetadata({
          userId: auth.uid,
          tenantId: bookScope.tenantId,
          workspaceId: bookScope.workspaceId,
          libraryId: bookScope.libraryId,
          bookId,
          fileId: bookId,
          chunkId,
          chunkIndex,
          language,
          embeddingModel: OPENAI_EMBEDDING_MODEL,
          chunkerVersion: CHUNKER_VERSION,
          extractorVersion: EXTRACTOR_VERSION,
        }),
        embeddedAt: FieldValue.serverTimestamp(),
      });
      writes += 1;
    });

    if (writes > 0) {
      await batch.commit();
    }

    await bookSnapshot.ref.update({
      tenantId: bookScope.tenantId,
      workspaceId: bookScope.workspaceId,
      libraryId: bookScope.libraryId,
      embeddingModel: OPENAI_EMBEDDING_MODEL,
      embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      vectorBackend: "firestore",
      vectorIndexName: DEFAULT_VECTOR_INDEX_NAME,
      vectorNamespace: bookScope.vectorNamespace,
      chunkerVersion: CHUNKER_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
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

export const backfillBookToPineconeTest = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "1GiB",
    secrets: [openAiApiKey, pineconeApiKey],
  },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
      }
      : undefined);
    await requireActiveSession(auth, request.data?.sessionId);
    requirePineconeTestUser(auth);

    const confirmation = assertString(request.data?.confirmation, "confirmation");
    if (confirmation !== "BACKFILL_PINECONE_TEST") {
      throw new HttpsError(
        "failed-precondition",
        "Use the confirmation phrase BACKFILL_PINECONE_TEST."
      );
    }

    const apiKey = getPineconeApiKey();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "Pinecone API key is not configured.");
    }

    const bookId = assertString(request.data?.bookId, "bookId");
    const bookSnapshot = await db.collection("books").doc(bookId).get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    if (bookSnapshot.get("status") !== "text_ready") {
      throw new HttpsError("failed-precondition", "Only text-ready books can be indexed.");
    }

    const bookScope = resolveBookScope(auth.uid, bookSnapshot);
    const language =
      typeof bookSnapshot.get("language") === "string" ? String(bookSnapshot.get("language")) : "";
    const chunksSnapshot = await db
      .collection("bookChunks")
      .where("userId", "==", auth.uid)
      .where("bookId", "==", bookId)
      .limit(900)
      .get();
    const chunks = chunksSnapshot.docs
      .map((chunkSnapshot) => {
        const embedding = chunkSnapshot.get("embedding");
        const chunkIndex = Number(chunkSnapshot.get("chunkIndex")) || 0;
        const text = chunkSnapshot.get("text");
        const textPreview = chunkSnapshot.get("textPreview");

        if (!Array.isArray(embedding) || typeof text !== "string") {
          return null;
        }

        return {
          chunkId: chunkSnapshot.id,
          bookId,
          fileId: typeof chunkSnapshot.get("fileId") === "string" ? String(chunkSnapshot.get("fileId")) : bookId,
          chunkIndex,
          text,
          textPreview: typeof textPreview === "string" ? textPreview : text.slice(0, 240),
          charStart: Number(chunkSnapshot.get("charStart")) || 0,
          charEnd: Number(chunkSnapshot.get("charEnd")) || 0,
          language,
          embedding: embedding.filter((value): value is number => typeof value === "number"),
        };
      })
      .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

    if (chunks.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        "This book does not have embedded chunks to index."
      );
    }

    const backend = new PineconeBookRetrievalBackend({
      apiKey,
      firestore: db,
      indexName: process.env.PINECONE_INDEX_NAME || DEFAULT_VECTOR_INDEX_NAME,
      indexHost: process.env.PINECONE_INDEX_HOST || "",
      embeddingModel: OPENAI_EMBEDDING_MODEL,
      chunkerVersion: CHUNKER_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
    });

    await backend.upsertBookChunks({
      scope: {
        userId: auth.uid,
        tenantId: bookScope.tenantId,
        workspaceId: bookScope.workspaceId,
        libraryId: bookScope.libraryId,
      },
      chunks,
    });
    const audit = await backend.auditBook({
      scope: {
        userId: auth.uid,
        tenantId: bookScope.tenantId,
        workspaceId: bookScope.workspaceId,
        libraryId: bookScope.libraryId,
      },
      bookId,
    });

    await bookSnapshot.ref.update({
      pineconeIndexedChunkCount: audit.indexedChunkCount,
      pineconeMissingChunkCount: audit.missingChunkCount,
      pineconeIndexedAt: FieldValue.serverTimestamp(),
      vectorBackendCandidate: "pinecone",
      vectorIndexName: process.env.PINECONE_INDEX_NAME || DEFAULT_VECTOR_INDEX_NAME,
      vectorNamespace: bookScope.vectorNamespace,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      bookId,
      namespace: bookScope.vectorNamespace,
      indexedChunkCount: audit.indexedChunkCount,
      missingChunkCount: audit.missingChunkCount,
    };
  }
);

export const deleteBookFromPineconeTest = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [pineconeApiKey],
  },
  async (request) => {
    const auth = requireAuth(request.auth?.token
      ? {
          uid: request.auth.uid,
          email: request.auth.token.email,
          name: request.auth.token.name,
          picture: request.auth.token.picture,
      }
      : undefined);
    await requireActiveSession(auth, request.data?.sessionId);
    requirePineconeTestUser(auth);

    const confirmation = assertString(request.data?.confirmation, "confirmation");
    if (confirmation !== "DELETE_PINECONE_TEST") {
      throw new HttpsError(
        "failed-precondition",
        "Use the confirmation phrase DELETE_PINECONE_TEST."
      );
    }

    const apiKey = getPineconeApiKey();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "Pinecone API key is not configured.");
    }

    const bookId = assertString(request.data?.bookId, "bookId");
    const bookSnapshot = await db.collection("books").doc(bookId).get();

    if (!bookSnapshot.exists || bookSnapshot.get("userId") !== auth.uid) {
      throw new HttpsError("not-found", "Book was not found.");
    }

    const bookScope = resolveBookScope(auth.uid, bookSnapshot);
    const backend = new PineconeBookRetrievalBackend({
      apiKey,
      firestore: db,
      indexName: process.env.PINECONE_INDEX_NAME || DEFAULT_VECTOR_INDEX_NAME,
      indexHost: process.env.PINECONE_INDEX_HOST || "",
      embeddingModel: OPENAI_EMBEDDING_MODEL,
      chunkerVersion: CHUNKER_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
    });

    await backend.deleteBook({
      scope: {
        tenantId: bookScope.tenantId,
        workspaceId: bookScope.workspaceId,
        libraryId: bookScope.libraryId,
      },
      bookId,
    });

    await bookSnapshot.ref.update({
      pineconeDeletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      bookId,
      namespace: bookScope.vectorNamespace,
    };
  }
);
