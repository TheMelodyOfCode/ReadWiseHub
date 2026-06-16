import { FormEvent, TouchEvent, useEffect, useMemo, useRef, useState } from "react";
import { FirebaseError } from "firebase/app";
import {
  EmailAuthProvider,
  User,
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
  verifyPasswordResetCode,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { auth, db, functions, googleProvider, storage } from "./firebase";
import { Locale, detectInitialLocale, dictionaries } from "./i18n";
import { type ReaderChunk, type ReaderParagraph, formatReaderParagraphs } from "./readerFormatting";
import readWiseHubIcon from "./assets/readwisehub-icon.png";
import { UAParser } from "ua-parser-js";

type Theme = "light" | "dark";
type WorkspaceTab = "ask" | "library" | "read" | "articles" | "history" | "help";
const DELETE_CONFIRMATION_PHRASE = "ReadWiseHub 2026";
const CANONICAL_ORIGIN = "https://readwisehub.com";
const LARGE_UPLOAD_NOTICE_BYTES = 3 * 1024 * 1024;
const AUTH_ACTION_URL = `${CANONICAL_ORIGIN}/auth-action`;

type BookRecord = {
  id: string;
  title: string;
  displayTitle: string;
  status: string;
  sizeBytes: number;
  chunkCount: number;
  sectionCount: number;
  pageCount: number;
  textLength: number;
  language: string;
  embeddedChunkCount: number;
  pineconeIndexedChunkCount: number;
  pineconeMissingChunkCount: number;
  vectorBackendCandidate: string;
  vectorBackfillStatus: string;
  vectorBackfillProcessedChunkCount: number;
  renderedPageCount: number;
  originalPageView: boolean;
  structureQuality: string;
  formatWarning: string;
  preferredReaderMode: ReaderMode;
  createdAtMs: number;
  updatedAtMs: number;
};

type IngestionJobRecord = {
  id: string;
  bookId: string;
  status: string;
  stage: string;
  progress: number;
  errorMessageSafe: string;
};

type BookChunkPreview = {
  id: string;
  chunkIndex: number;
  textPreview: string;
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

type BookArtifact = {
  id: string;
  title: string;
  type: string;
  bookId: string;
  bookTitle: string;
  status: string;
  generatedBy: string;
  targetSectionCount: number;
  sourceSectionCount: number;
  weakTitleCount: number;
  mapQuality: string;
  sections: SectionMapEntry[];
  createdAt?: string;
  updatedAt?: string;
};

type ReaderNavigationEntry = {
  label: string;
  page: number;
};

type ReaderSelection = {
  text: string;
  paragraphId: string;
};

type ReaderHighlight = {
  id: string;
  text: string;
  page: number;
  paragraphId: string;
  createdAt: number;
};

type ReaderBookmark = {
  page: number;
  label: string;
  snippet: string;
  createdAt: number;
};

type ReaderOriginalPage = {
  pageNumber: number;
  storagePath: string;
  width: number;
  height: number;
  contentType: string;
};

type ReaderInlineMedia = {
  id: string;
  pageNumber: number;
  sectionIndex: number;
  mediaIndex: number;
  kind: string;
  storagePath: string;
  width: number;
  height: number;
  contentType: string;
  bbox: number[];
};

type ReaderMode = "text" | "original";

function getUploadTitle(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function createDisplayTitle(title: string) {
  const spaced = title
    .replace(/\.[^.]+$/, "")
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

function normalizeBookTitle(title: string) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

type LibrarySearchResult = {
  chunkId?: string;
  bookId: string;
  bookTitle: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
};

type AskLibraryResponse = {
  ok: boolean;
  answer: string;
  mode: string;
  conversationId: string;
  results: LibrarySearchResult[];
  activeMode?: string;
  activeBookId?: string;
  activeArtifactId?: string;
  activeSectionNumber?: number;
};

type ArticleSource = LibrarySearchResult & {
  sourceNumber: number;
};

type ArticleDraftRecord = {
  id: string;
  bookId: string;
  bookTitle: string;
  title: string;
  prompt: string;
  status: string;
  latestVersionId: string;
  articleContext?: ArticleContext;
  createdAt?: string;
  updatedAt?: string;
};

type ArticleVersionRecord = {
  id: string;
  title: string;
  body: string;
  versionNumber: number;
  sources: ArticleSource[];
  articleContext?: ArticleContext;
};

type ArticleDraftResponse = {
  ok: boolean;
  draft: ArticleDraftRecord;
  version: ArticleVersionRecord;
};

type ArticleContext = {
  sourceType: "answer" | "section" | "section_map" | "selection" | "manual";
  conversationId?: string;
  activeMode?: string;
  activeBookId?: string;
  activeArtifactId?: string;
  activeSectionNumber?: number;
  titleHint?: string;
};

type SuggestionChip = {
  label: string;
  question: string;
  bookId?: string;
};

type SuggestionAction = "fill" | "ask";

type ConversationRecord = {
  id: string;
  title: string;
  mode: string;
  latestAnswerPreview: string;
  sourceCount: number;
  sourceBookIds: string[];
  hasUnavailableSources: boolean;
  unavailableBookTitles: string[];
  updatedAtMs: number;
};

type ConversationMessage = {
  id: string;
  role: string;
  text: string;
  mode: string;
  sources: LibrarySearchResult[];
};

type ConversationDetail = {
  id: string;
  title: string;
  mode: string;
  messages: ConversationMessage[];
};

type AccountSession = {
  id: string;
  browser: string;
  os: string;
  device: string;
  locationLabel: string;
  status: string;
  lastSeenAtMs: number;
  createdAtMs: number;
};

type UserUsage = {
  plan: string;
  subscriptionStatus: string;
  billingProvider: string;
  billingCustomerId: string;
  billingSubscriptionId: string;
  messages: number;
  monthlyMessages: number;
  articleGenerations: number;
  books: number;
  maxBooks: number;
  storageBytes: number;
  maxStorageBytes: number;
};

type AdminDashboardPayload = {
  ok: boolean;
  viewer: {
    uid: string;
    email: string;
  };
  counts: Record<string, number>;
  pineconeBooks: Array<{
    bookId: string;
    title: string;
    userId: string;
    userLabel: string;
    userEmail: string;
    userDisplayName: string;
    indexedChunkCount: number;
    missingChunkCount: number;
  }>;
};

type AdminConversationSummary = {
  id: string;
  userId: string;
  userLabel: string;
  userEmail: string;
  userDisplayName: string;
  title: string;
  mode: string;
  scopedBookId: string;
  scope: string;
  sourceCount: number;
  latestQuestion: string;
  latestAnswerPreview: string;
  retrievalDiagnostics?: Record<string, unknown>;
  routeTraceId: string;
  createdAt?: string;
  updatedAt?: string;
};

type AdminConversationDebug = {
  ok: boolean;
  conversation: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  routeTrace: Record<string, unknown> | null;
};

type AdminBookSummary = {
  id: string;
  userId: string;
  userLabel: string;
  userEmail: string;
  userDisplayName: string;
  title: string;
  displayTitle: string;
  status: string;
  contentType: string;
  sizeBytes: number;
  pageCount: number;
  chunkCount: number;
  sectionCount: number;
  embeddedChunkCount: number;
  pineconeIndexedChunkCount: number;
  pineconeMissingChunkCount: number;
  vectorBackendCandidate: string;
  structureQuality: string;
  formatWarning: string;
  readerTextRepairStatus: string;
  readerTextRepairJobId: string;
  readerTextRepairError: string;
  language: string;
  createdAt?: string;
  updatedAt?: string;
};

type AdminBookDebug = {
  ok: boolean;
  book: Record<string, unknown>;
  ingestionJobs: Array<Record<string, unknown>>;
  chunks: Array<Record<string, unknown>>;
  sections: Array<Record<string, unknown>>;
  artifacts: Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    generatedBy: string;
    targetSectionCount: number;
    sourceSectionCount: number;
    sectionCount: number;
    weakTitleCount: number;
    mapQuality: string;
    createdAt?: string;
    updatedAt?: string;
    sections: Array<{
      sectionNumber: number;
      title: string;
      sourceSectionStart: number;
      sourceSectionEnd: number;
      pageStart: number;
      pageEnd: number;
      summaryPreview: string;
    }>;
  }>;
};

type AdminUserSummary = {
  userId: string;
  email: string;
  displayName: string;
  userLabel: string;
  plan: string;
  subscriptionStatus: string;
  emailVerified: boolean;
  onboardingStatus: string;
  usageCurrentPeriod?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  bookCount: number;
  conversationCount: number;
  activeSessionCount: number;
  lastLoginAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

const UPLOAD_BACKEND_ENABLED = true;
const MAX_FREE_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/epub+zip",
]);

function getHighlightedParts(text: string, highlights: string[]) {
  const activeHighlights = highlights
    .map((highlight) => highlight.trim())
    .filter((highlight) => highlight.length >= 2);
  const matches = activeHighlights
    .flatMap((highlight) => {
      const positions: Array<{ start: number; end: number }> = [];
      let start = text.toLowerCase().indexOf(highlight.toLowerCase());
      while (start >= 0) {
        positions.push({ start, end: start + highlight.length });
        start = text.toLowerCase().indexOf(highlight.toLowerCase(), start + highlight.length);
      }
      return positions;
    })
    .sort((left, right) => left.start - right.start);
  const merged = matches.reduce<Array<{ start: number; end: number }>>((result, match) => {
    const previous = result[result.length - 1];
    if (previous && match.start <= previous.end) {
      previous.end = Math.max(previous.end, match.end);
      return result;
    }
    result.push({ ...match });
    return result;
  }, []);
  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;

  merged.forEach((match) => {
    if (match.start > cursor) {
      parts.push({ text: text.slice(cursor, match.start), highlighted: false });
    }
    parts.push({ text: text.slice(match.start, match.end), highlighted: true });
    cursor = match.end;
  });

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false });
  }

  return parts.length > 0 ? parts : [{ text, highlighted: false }];
}

function getInitialTheme(): Theme {
  const stored = window.localStorage.getItem("readwisehub_theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getSessionId() {
  const key = "readwisehub_session_id";
  const existing = window.localStorage.getItem(key);
  if (existing && existing.length >= 16) {
    return existing;
  }

  const next =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(key, next);
  return next;
}

function withSession<T extends Record<string, unknown>>(data: T): T & { sessionId: string } {
  return {
    ...data,
    sessionId: getSessionId(),
  };
}

function getSourceLabel(source: LibrarySearchResult, t: Record<string, string>) {
  return source.chunkIndex < 0
    ? t.sourceOutline
    : `${t.sourceChunk} ${source.chunkIndex + 1}`;
}

function formatDateTime(value: number, locale: Locale) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getDeviceInfo() {
  const parser = new UAParser(navigator.userAgent);
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const device = parser.getDevice();

  return {
    browser: [browser.name, browser.version].filter(Boolean).join(" ") || "Unknown browser",
    os: [os.name, os.version].filter(Boolean).join(" ") || "Unknown OS",
    device: device.model || device.type || "This device",
    userAgent: navigator.userAgent,
  };
}

async function ensureUserRecord(user: User, locale: Locale, theme: Theme) {
  const userRef = doc(db, "users", user.uid);
  const existing = await getDoc(userRef);

  if (existing.exists()) {
    await setDoc(
      userRef,
      {
        displayName: user.displayName ?? existing.data().displayName ?? "",
        photoURL: user.photoURL ?? existing.data().photoURL ?? "",
        emailVerified: user.emailVerified,
        onboardingStatus: user.emailVerified ? "active" : "email_verification_pending",
        locale,
        theme,
        updatedAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  await setDoc(userRef, {
      email: user.email ?? "",
      displayName: user.displayName ?? "",
      photoURL: user.photoURL ?? "",
      plan: "free",
      subscriptionStatus: "none",
      emailVerified: user.emailVerified,
      onboardingStatus: user.emailVerified ? "active" : "email_verification_pending",
      billingProvider: "none",
      billingCustomerId: "",
      billingPriceId: "",
      billingCurrentPeriodEnd: null,
      locale,
      theme,
      limits: {
        maxBooks: 1,
        maxStorageBytes: 10 * 1024 * 1024,
        maxFileBytes: 10 * 1024 * 1024,
        monthlyMessages: 10,
        monthlyIngestions: 1,
      },
      usageCurrentPeriod: {
        messages: 0,
        ingestions: 0,
        storageBytes: 0,
        books: 0,
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof FirebaseError) {
    const cleanMessage = error.message
      .replace(/^Firebase:\s*/i, "")
      .replace(/\s*\((?:functions|auth|storage|firestore)\/[^)]+\)\.?/gi, "")
      .trim();
    return cleanMessage ? `${fallback}: ${cleanMessage}` : fallback;
  }

  if (error instanceof Error && error.message) {
    return `${fallback} (${error.message})`;
  }

  return fallback;
}

function getEmailActionSettings() {
  return {
    url: AUTH_ACTION_URL,
  };
}

export function App() {
  const isAdminPath = window.location.pathname.startsWith("/admin");
  const [locale, setLocale] = useState<Locale>(() => detectInitialLocale());
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [status, setStatus] = useState("");
  const [resetActionEmail, setResetActionEmail] = useState("");
  const [resetActionPassword, setResetActionPassword] = useState("");
  const [resetActionConfirmPassword, setResetActionConfirmPassword] = useState("");
  const [resetActionBusy, setResetActionBusy] = useState(false);
  const [resetActionChecked, setResetActionChecked] = useState(false);
  const [resetActionComplete, setResetActionComplete] = useState(false);
  const [resetActionError, setResetActionError] = useState("");
  const [resetActionFormError, setResetActionFormError] = useState("");
  const [verifyActionChecked, setVerifyActionChecked] = useState(false);
  const [verifyActionComplete, setVerifyActionComplete] = useState(false);
  const [verifyActionError, setVerifyActionError] = useState("");
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [booksReady, setBooksReady] = useState(false);
  const [ingestionJobs, setIngestionJobs] = useState<IngestionJobRecord[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processBusy, setProcessBusy] = useState(false);
  const [searchQuestion, setSearchQuestion] = useState("");
  const [searchMessage, setSearchMessage] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<LibrarySearchResult[]>([]);
  const [askQuestion, setAskQuestion] = useState("");
  const [askMessage, setAskMessage] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askProgress, setAskProgress] = useState(0);
  const [askAnswer, setAskAnswer] = useState("");
  const [askMode, setAskMode] = useState("");
  const [askSources, setAskSources] = useState<LibrarySearchResult[]>([]);
  const [askActiveContext, setAskActiveContext] = useState<ArticleContext | null>(null);
  const [usedSuggestionQuestions, setUsedSuggestionQuestions] = useState<string[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsReady, setConversationsReady] = useState(false);
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null);
  const [conversationDetailBusyId, setConversationDetailBusyId] = useState("");
  const [selectedBookScope, setSelectedBookScope] = useState("");
  const [deleteBusyId, setDeleteBusyId] = useState("");
  const [bookDeleteProgress, setBookDeleteProgress] = useState<Record<string, { label: string; progress: number }>>({});
  const [confirmDeleteBookId, setConfirmDeleteBookId] = useState("");
  const [deleteConversationBusyId, setDeleteConversationBusyId] = useState("");
  const [deleteAllHistoryConfirmOpen, setDeleteAllHistoryConfirmOpen] = useState(false);
  const [deleteAllHistoryText, setDeleteAllHistoryText] = useState("");
  const [deleteAllHistoryBusy, setDeleteAllHistoryBusy] = useState(false);
  const [lastUploadedBookId, setLastUploadedBookId] = useState("");
  const [uploadTrackingBookId, setUploadTrackingBookId] = useState("");
  const [uploadPrepNoticeBookId, setUploadPrepNoticeBookId] = useState("");
  const [dismissedUploadPrepNoticeBookIds, setDismissedUploadPrepNoticeBookIds] = useState<string[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("ask");
  const [processingBookId, setProcessingBookId] = useState("");
  const [selectedBookDetailId, setSelectedBookDetailId] = useState("");
  const [bookChunkPreviews, setBookChunkPreviews] = useState<BookChunkPreview[]>([]);
  const [bookArtifacts, setBookArtifacts] = useState<BookArtifact[]>([]);
  const [sectionMapTargetCount, setSectionMapTargetCount] = useState(6);
  const [sectionMapBusy, setSectionMapBusy] = useState(false);
  const [bookDetailMessage, setBookDetailMessage] = useState("");
  const [readerBookId, setReaderBookId] = useState("");
  const [readerChunks, setReaderChunks] = useState<ReaderChunk[]>([]);
  const [readerPage, setReaderPage] = useState(0);
  const [readerTotalChunks, setReaderTotalChunks] = useState(0);
  const [readerActivePageSize, setReaderActivePageSize] = useState(8);
  const [readerOriginalPage, setReaderOriginalPage] = useState<ReaderOriginalPage | null>(null);
  const [readerOriginalPageCount, setReaderOriginalPageCount] = useState(0);
  const [readerOriginalPageUrl, setReaderOriginalPageUrl] = useState("");
  const [readerInlineMedia, setReaderInlineMedia] = useState<ReaderInlineMedia[]>([]);
  const [readerInlineMediaUrls, setReaderInlineMediaUrls] = useState<Record<string, string>>({});
  const [readerMode, setReaderMode] = useState<ReaderMode>("text");
  const [readerBusy, setReaderBusy] = useState(false);
  const [readerMessage, setReaderMessage] = useState("");
  const [readerHighlights, setReaderHighlights] = useState<Record<string, ReaderHighlight>>({});
  const [readerSelection, setReaderSelection] = useState<ReaderSelection | null>(null);
  const [readerAskBusy, setReaderAskBusy] = useState(false);
  const [readerAskProgress, setReaderAskProgress] = useState(0);
  const [readerAskAnswer, setReaderAskAnswer] = useState("");
  const [readerAskMode, setReaderAskMode] = useState("");
  const [readerAskSources, setReaderAskSources] = useState<LibrarySearchResult[]>([]);
  const [readerAskQuestion, setReaderAskQuestion] = useState("");
  const [readerSourceQuestion, setReaderSourceQuestion] = useState("");
  const [readerSourceBusy, setReaderSourceBusy] = useState(false);
  const [readerSourceMessage, setReaderSourceMessage] = useState("");
  const [readerSourceResults, setReaderSourceResults] = useState<LibrarySearchResult[]>([]);
  const [readerReturnParagraphId, setReaderReturnParagraphId] = useState("");
  const [readerReturnScrollY, setReaderReturnScrollY] = useState<number | null>(null);
  const [readerBookmarkMessage, setReaderBookmarkMessage] = useState("");
  const [readerBookmarks, setReaderBookmarks] = useState<ReaderBookmark[]>([]);
  const [readerBookmarkMenuOpen, setReaderBookmarkMenuOpen] = useState(false);
  const [readerHighlightMenuOpen, setReaderHighlightMenuOpen] = useState(false);
  const [readerBookPickerOpen, setReaderBookPickerOpen] = useState(false);
  const [readerPickerScrollPending, setReaderPickerScrollPending] = useState(false);
  const [readerScrollNavVisible, setReaderScrollNavVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [passwordChangeCurrent, setPasswordChangeCurrent] = useState("");
  const [passwordChangeNew, setPasswordChangeNew] = useState("");
  const [passwordChangeRepeat, setPasswordChangeRepeat] = useState("");
  const [accountEmailChange, setAccountEmailChange] = useState("");
  const [accountEmailChangePassword, setAccountEmailChangePassword] = useState("");
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("");
  const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
  const [accountSessions, setAccountSessions] = useState<AccountSession[]>([]);
  const [securityMessage, setSecurityMessage] = useState("");
  const [billingBusy, setBillingBusy] = useState("");
  const [billingMessage, setBillingMessage] = useState("");
  const [usage, setUsage] = useState<UserUsage>({
    plan: "free",
    subscriptionStatus: "none",
    billingProvider: "none",
    billingCustomerId: "",
    billingSubscriptionId: "",
    messages: 0,
    monthlyMessages: 10,
    articleGenerations: 0,
    books: 0,
    maxBooks: 1,
    storageBytes: 0,
    maxStorageBytes: 10 * 1024 * 1024,
  });
  const [articleBookId, setArticleBookId] = useState("");
  const [articlePrompt, setArticlePrompt] = useState("");
  const [articleDraftContext, setArticleDraftContext] = useState<ArticleContext>({ sourceType: "manual" });
  const [articleBusy, setArticleBusy] = useState(false);
  const [articleProgress, setArticleProgress] = useState(0);
  const [articleMessage, setArticleMessage] = useState("");
  const [articleDrafts, setArticleDrafts] = useState<ArticleDraftRecord[]>([]);
  const [articleCurrentDraft, setArticleCurrentDraft] = useState<ArticleDraftRecord | null>(null);
  const [articleCurrentVersion, setArticleCurrentVersion] =
    useState<ArticleVersionRecord | null>(null);
  const [articleRewriteBusy, setArticleRewriteBusy] = useState("");
  const [articleDeleteBusyId, setArticleDeleteBusyId] = useState("");
  const [adminAccess, setAdminAccess] = useState(false);
  const [adminDashboard, setAdminDashboard] = useState<AdminDashboardPayload | null>(null);
  const [adminConversations, setAdminConversations] = useState<AdminConversationSummary[]>([]);
  const [adminConversationDebug, setAdminConversationDebug] =
    useState<AdminConversationDebug | null>(null);
  const [adminBooks, setAdminBooks] = useState<AdminBookSummary[]>([]);
  const [adminBookDebug, setAdminBookDebug] = useState<AdminBookDebug | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [adminSearch, setAdminSearch] = useState("");
  const [adminBookStatusFilter, setAdminBookStatusFilter] = useState("all");
  const [adminConversationModeFilter, setAdminConversationModeFilter] = useState("all");
  const [adminConversationBackendFilter, setAdminConversationBackendFilter] = useState("all");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMessage, setAdminMessage] = useState("");
  const [adminRepairBookId, setAdminRepairBookId] = useState("");
  const [adminRepairRunning, setAdminRepairRunning] = useState(false);
  const [adminRepairProgress, setAdminRepairProgress] = useState(0);
  const [adminRepairMessage, setAdminRepairMessage] = useState("");
  const [adminRepairError, setAdminRepairError] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  const t = useMemo(() => dictionaries[locale], [locale]);
  const authActionParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const authActionMode = authActionParams.get("mode") || "";
  const authActionCode = authActionParams.get("oobCode") || "";
  const isPasswordResetAction =
    window.location.pathname.startsWith("/auth-action") &&
    authActionMode === "resetPassword" &&
    Boolean(authActionCode);
  const isVerifyEmailAction =
    window.location.pathname.startsWith("/auth-action") &&
    authActionMode === "verifyEmail" &&
    Boolean(authActionCode);
  const isVerifyAndChangeEmailAction =
    window.location.pathname.startsWith("/auth-action") &&
    authActionMode === "verifyAndChangeEmail" &&
    Boolean(authActionCode);
  const isRecoverEmailAction =
    window.location.pathname.startsWith("/auth-action") &&
    authActionMode === "recoverEmail" &&
    Boolean(authActionCode);
  const isEmailApplyAction = isVerifyEmailAction || isVerifyAndChangeEmailAction || isRecoverEmailAction;
  const isKnownAuthAction = isPasswordResetAction || isEmailApplyAction;
  const textReadyBooks = useMemo(
    () => books.filter((book) => book.status === "text_ready"),
    [books]
  );
  const hasOpenStripeSubscription =
    usage.billingProvider === "stripe" &&
    Boolean(usage.billingSubscriptionId) &&
    ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(
      usage.subscriptionStatus
    );
  const articleStudioUnlocked =
    usage.plan === "plus" || usage.plan === "pro" || usage.plan === "ultimate";
  const articleReadyBookId = articleBookId || textReadyBooks[0]?.id || "";
  const activeBookIds = useMemo(() => new Set(books.map((book) => book.id)), [books]);
  const jobsByBookId = useMemo(() => {
    const jobs = new Map<string, IngestionJobRecord>();
    ingestionJobs.forEach((job) => jobs.set(job.bookId, job));
    return jobs;
  }, [ingestionJobs]);
  const readerPageSize = 8;
  const readerEffectivePageSize = Math.max(1, readerActivePageSize || readerPageSize);
  const readerBook = useMemo(
    () => books.find((book) => book.id === readerBookId) ?? null,
    [books, readerBookId]
  );
  const readerParagraphs = useMemo(
    () => formatReaderParagraphs(readerChunks),
    [readerChunks]
  );
  const readerPageCount = Math.max(1, Math.ceil(readerTotalChunks / readerEffectivePageSize));
  const readerUsesPhysicalPages = readerEffectivePageSize === 1 && readerTotalChunks > 0;
  const readerSourceToc = useMemo(
    () =>
      bookArtifacts.find(
        (artifact) =>
          artifact.bookId === readerBookId &&
          artifact.type === "source_toc" &&
          artifact.sections.length > 0
      ) ?? null,
    [bookArtifacts, readerBookId]
  );
  const readerNavigationEntries = useMemo<ReaderNavigationEntry[]>(() => {
    if (readerSourceToc) {
      return readerSourceToc.sections.map((section) => ({
        label: section.title,
        page: Math.max(0, (section.pageStart || 1) - 1),
      }));
    }

    return Array.from({ length: readerPageCount }, (_, index) => ({
      label: `${readerUsesPhysicalPages ? t.page : t.chapter} ${index + 1}`,
      page: index,
    }));
  }, [readerPageCount, readerSourceToc, readerUsesPhysicalPages, t.chapter, t.page]);
  const activeReaderPageCount =
    readerMode === "original" && readerOriginalPageCount > 0
      ? readerOriginalPageCount
      : readerPageCount;
  const readerProgressKey = user && readerBookId
    ? `readwisehub_reader_progress_${user.uid}_${readerBookId}`
    : "";
  const readerHighlightKey = user && readerBookId
    ? `readwisehub_reader_highlights_${user.uid}_${readerBookId}`
    : "";
  const readerBookmarkKey = user && readerBookId
    ? `readwisehub_reader_bookmarks_${user.uid}_${readerBookId}`
    : "";
  const currentPageBookmarked = readerBookmarks.some(
    (bookmark) => bookmark.page === readerPage
  );
  const readerHighlightList = useMemo(
    () => Object.values(readerHighlights).sort((left, right) => left.page - right.page || left.createdAt - right.createdAt),
    [readerHighlights]
  );
  const uploadTrackingBook = uploadTrackingBookId
    ? books.find((book) => book.id === uploadTrackingBookId) ?? null
    : null;
  const uploadTrackingJob = uploadTrackingBook
    ? jobsByBookId.get(uploadTrackingBook.id) ?? null
    : null;
  const processingProgress = uploadTrackingBook
    ? uploadTrackingBook.status === "text_ready"
      ? 100
      : uploadTrackingJob
        ? Math.max(0, Math.min(100, uploadTrackingJob.progress))
        : uploadTrackingBook.status === "queued"
          ? 5
          : 0
    : 0;
  const uploadTrackingVectorProgress = uploadTrackingBook
    ? uploadTrackingBook.chunkCount > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              (Math.max(
                uploadTrackingBook.pineconeIndexedChunkCount,
                uploadTrackingBook.vectorBackfillProcessedChunkCount
              ) /
                uploadTrackingBook.chunkCount) *
                100
            )
          )
        )
      : 0
    : 0;
  const uploadPrepNoticeBook = uploadPrepNoticeBookId
    ? books.find((book) => book.id === uploadPrepNoticeBookId) ?? null
    : null;
  const uploadPrepNoticeJob = uploadPrepNoticeBook
    ? jobsByBookId.get(uploadPrepNoticeBook.id) ?? null
    : null;
  const uploadPrepNoticeProgress = uploadPrepNoticeBook
    ? uploadPrepNoticeBook.status === "text_ready"
      ? 100
      : uploadPrepNoticeJob
        ? Math.max(0, Math.min(100, uploadPrepNoticeJob.progress))
        : uploadPrepNoticeBook.status === "queued"
          ? 5
          : 0
    : 0;
  const selectedScopeBook = selectedBookScope
    ? textReadyBooks.find((book) => book.id === selectedBookScope) ?? null
    : null;
  const defaultSuggestionBook = selectedScopeBook ?? textReadyBooks[0] ?? null;
  const onboardingSuggestions = useMemo<SuggestionChip[]>(() => {
    if (!defaultSuggestionBook) {
      return [];
    }

    return [
      {
        label: t.suggestionSummarizeBook,
        question: t.suggestionSummarizeBookQuestion,
        bookId: defaultSuggestionBook.id,
      },
      {
        label: t.suggestionMapBook,
        question: t.suggestionMapBookQuestion,
        bookId: defaultSuggestionBook.id,
      },
      {
        label: t.suggestionKeyIdeas,
        question: t.suggestionKeyIdeasQuestion,
        bookId: defaultSuggestionBook.id,
      },
      {
        label: t.suggestionFinalQuarter,
        question: t.suggestionFinalQuarterQuestion,
        bookId: defaultSuggestionBook.id,
      },
      {
        label: t.suggestionCharacterArc,
        question: t.suggestionCharacterArcQuestion,
        bookId: defaultSuggestionBook.id,
      },
      {
        label: t.suggestionQuestionsForClub,
        question: t.suggestionQuestionsForClubQuestion,
        bookId: defaultSuggestionBook.id,
      },
      {
        label: t.suggestionMemorableQuotes,
        question: t.suggestionMemorableQuotesQuestion,
        bookId: defaultSuggestionBook.id,
      },
      {
        label: t.suggestionPersonalTakeaways,
        question: t.suggestionPersonalTakeawaysQuestion,
        bookId: defaultSuggestionBook.id,
      },
    ];
  }, [defaultSuggestionBook, t]);
  const answerFollowUpSuggestions = useMemo<SuggestionChip[]>(() => {
    const scopedBookId = selectedBookScope || askSources[0]?.bookId || defaultSuggestionBook?.id || "";

    return [
      {
        label: t.suggestionSimpler,
        question: t.suggestionSimplerQuestion,
        bookId: scopedBookId || undefined,
      },
      {
        label: t.suggestionEvidence,
        question: t.suggestionEvidenceQuestion,
        bookId: scopedBookId || undefined,
      },
      {
        label: t.suggestionNext,
        question: t.suggestionNextQuestion,
        bookId: scopedBookId || undefined,
      },
      {
        label: t.suggestionCounterpoint,
        question: t.suggestionCounterpointQuestion,
        bookId: scopedBookId || undefined,
      },
      {
        label: t.suggestionTurnIntoNotes,
        question: t.suggestionTurnIntoNotesQuestion,
        bookId: scopedBookId || undefined,
      },
      {
        label: t.suggestionConnectThemes,
        question: t.suggestionConnectThemesQuestion,
        bookId: scopedBookId || undefined,
      },
      {
        label: t.suggestionChapterContext,
        question: t.suggestionChapterContextQuestion,
        bookId: scopedBookId || undefined,
      },
    ];
  }, [askSources, defaultSuggestionBook, selectedBookScope, t]);
  const bookPageRef = useRef<HTMLDivElement | null>(null);
  const readerAnswerRef = useRef<HTMLDivElement | null>(null);
  const conversationDetailRef = useRef<HTMLElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const bookmarkMenuRef = useRef<HTMLDivElement | null>(null);
  const highlightMenuRef = useRef<HTMLDivElement | null>(null);
  const bookDetailRef = useRef<HTMLElement | null>(null);
  const sourceSearchResultsRef = useRef<HTMLDivElement | null>(null);
  const readerSourceResultsRef = useRef<HTMLDivElement | null>(null);
  const adminBookResultsRef = useRef<HTMLDivElement | null>(null);
  const readerScrollTimeoutRef = useRef<number | null>(null);
  const readerTouchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const signingOutRef = useRef(false);
  const bookCardRefs = useRef(new Map<string, HTMLElement>());
  const askInputRef = useRef<HTMLTextAreaElement | null>(null);
  const askProgressRef = useRef<HTMLDivElement | null>(null);
  const activeStorageBytes = useMemo(
    () => books.reduce((total, book) => total + book.sizeBytes, 0),
    [books]
  );
  const emailVerified = user?.emailVerified === true;
  const articleMessageIsSuccess = [
    t.articleReady,
    t.articleRewriteReady,
    t.articleDeleted,
    t.articlePrepared,
    t.articleCopied,
    t.articleExported,
  ].includes(articleMessage);
  const languageToggle = (
    <div className="language-toggle" aria-label={t.language}>
      <button
        type="button"
        className={locale === "de" ? "active" : ""}
        aria-pressed={locale === "de"}
        onClick={() => setLocale("de")}
      >
        DE
      </button>
      <button
        type="button"
        className={locale === "en" ? "active" : ""}
        aria-pressed={locale === "en"}
        onClick={() => setLocale("en")}
      >
        EN
      </button>
    </div>
  );
  const themeToggle = (
    <button
      className="button header-button theme-toggle"
      type="button"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label={t.theme}
    >
      {theme === "dark" ? t.light : t.dark}
    </button>
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("readwisehub_theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
    window.localStorage.setItem("readwisehub_locale", locale);
  }, [locale]);

  useEffect(() => {
    if (!isPasswordResetAction) {
      return;
    }

    setResetActionChecked(false);
    setResetActionError("");
    verifyPasswordResetCode(auth, authActionCode)
      .then((accountEmail) => {
        setResetActionEmail(accountEmail);
        setResetActionChecked(true);
      })
      .catch(() => {
        setResetActionError(t.passwordResetInvalidLink);
        setResetActionChecked(true);
      });
  }, [authActionCode, isPasswordResetAction, t.passwordResetInvalidLink]);

  useEffect(() => {
    if (!isEmailApplyAction) {
      return;
    }

    setVerifyActionChecked(false);
    setVerifyActionError("");
    setVerifyActionComplete(false);
    const applyEmailAction = isRecoverEmailAction
      ? checkActionCode(auth, authActionCode).then(() => applyActionCode(auth, authActionCode))
      : applyActionCode(auth, authActionCode);

    applyEmailAction
      .then(async () => {
        if (auth.currentUser) {
          await reload(auth.currentUser);
          await ensureUserRecord(auth.currentUser, locale, theme);
          setUser(auth.currentUser);
        }
        setVerifyActionComplete(true);
        setVerifyActionChecked(true);
      })
      .catch(() => {
        setVerifyActionError(t.emailVerificationInvalidLink);
        setVerifyActionChecked(true);
      });
  }, [
    authActionCode,
    isEmailApplyAction,
    isRecoverEmailAction,
    locale,
    theme,
    t.emailVerificationInvalidLink,
  ]);

  useEffect(() => {
    return onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        signingOutRef.current = false;
      }
      setUser(currentUser);
      setAuthReady(true);
      if (currentUser) {
        try {
          await ensureUserRecord(currentUser, locale, theme);
          await registerCurrentSession();
          await loadAccountSecurity();
        } catch (error) {
          setAuthError(getErrorMessage(error, "Account sync failed"));
        }
      } else {
        setAccountSessions([]);
      }
    });
  }, [locale, theme]);

  useEffect(() => {
    setProfileDisplayName(user?.displayName ?? "");
    setProfileMessage("");
  }, [user]);

  useEffect(() => {
    if (!user) {
      setBooks([]);
      setBooksReady(false);
      return;
    }

    const booksQuery = query(collection(db, "books"), where("userId", "==", user.uid));
    return onSnapshot(
      booksQuery,
      (snapshot) => {
        setBooks(
          snapshot.docs
            .map((bookDoc) => {
              const data = bookDoc.data();
              return {
                id: bookDoc.id,
                title: typeof data.title === "string" ? data.title : "Untitled",
                displayTitle:
                  typeof data.displayTitle === "string" && data.displayTitle.trim()
                    ? data.displayTitle
                    : createDisplayTitle(typeof data.title === "string" ? data.title : "Untitled"),
                status: typeof data.status === "string" ? data.status : "unknown",
                sizeBytes:
                  typeof data.sizeBytes === "number" ? data.sizeBytes : 0,
                chunkCount:
                  typeof data.chunkCount === "number" ? data.chunkCount : 0,
                sectionCount:
                  typeof data.sectionCount === "number" ? data.sectionCount : 0,
                pageCount: typeof data.pageCount === "number" ? data.pageCount : 0,
                textLength: typeof data.textLength === "number" ? data.textLength : 0,
                language: typeof data.language === "string" ? data.language : "",
                embeddedChunkCount:
                  typeof data.embeddedChunkCount === "number" ? data.embeddedChunkCount : 0,
                pineconeIndexedChunkCount:
                  typeof data.pineconeIndexedChunkCount === "number"
                    ? data.pineconeIndexedChunkCount
                    : 0,
                pineconeMissingChunkCount:
                  typeof data.pineconeMissingChunkCount === "number"
                    ? data.pineconeMissingChunkCount
                    : 0,
                vectorBackendCandidate:
                  typeof data.vectorBackendCandidate === "string"
                    ? data.vectorBackendCandidate
                    : "",
                vectorBackfillStatus:
                  typeof data.vectorBackfillStatus === "string"
                    ? data.vectorBackfillStatus
                    : "",
                vectorBackfillProcessedChunkCount:
                  typeof data.vectorBackfillProcessedChunkCount === "number"
                    ? data.vectorBackfillProcessedChunkCount
                    : 0,
                renderedPageCount:
                  typeof data.renderedPageCount === "number" ? data.renderedPageCount : 0,
                originalPageView: data.originalPageView === true,
                structureQuality:
                  typeof data.structureQuality === "string" ? data.structureQuality : "",
                formatWarning:
                  typeof data.formatWarning === "string" ? data.formatWarning : "",
                preferredReaderMode:
                  data.preferredReaderMode === "original" ? "original" as ReaderMode : "text" as ReaderMode,
                createdAtMs:
                  typeof data.createdAt?.toMillis === "function"
                    ? data.createdAt.toMillis()
                    : 0,
                updatedAtMs:
                  typeof data.updatedAt?.toMillis === "function"
                    ? data.updatedAt.toMillis()
                    : 0,
              };
            })
            .sort((left, right) => {
              const leftActive = ["upload_reserved", "queued", "processing"].includes(left.status);
              const rightActive = ["upload_reserved", "queued", "processing"].includes(right.status);
              if (leftActive !== rightActive) {
                return leftActive ? -1 : 1;
              }
              const leftRecent = Math.max(left.createdAtMs, left.updatedAtMs);
              const rightRecent = Math.max(right.createdAtMs, right.updatedAtMs);
              if (leftRecent !== rightRecent) {
                return rightRecent - leftRecent;
              }
              return left.displayTitle.localeCompare(right.displayTitle);
            })
        );
        setBooksReady(true);
      },
      (error) => {
        if (signingOutRef.current || !auth.currentUser) {
          return;
        }
        setAuthError(getErrorMessage(error, "Library sync failed"));
        setBooksReady(true);
      }
    );
  }, [user]);

  useEffect(() => {
    if (!user) {
      setIngestionJobs([]);
      return;
    }

    const jobsQuery = query(collection(db, "ingestionJobs"), where("userId", "==", user.uid));
    return onSnapshot(
      jobsQuery,
      (snapshot) => {
        setIngestionJobs(
          snapshot.docs.map((jobDoc) => {
            const data = jobDoc.data();
            return {
              id: jobDoc.id,
              bookId: typeof data.bookId === "string" ? data.bookId : "",
              status: typeof data.status === "string" ? data.status : "unknown",
              stage: typeof data.stage === "string" ? data.stage : "",
              progress: typeof data.progress === "number" ? data.progress : 0,
              errorMessageSafe:
                typeof data.errorMessageSafe === "string" ? data.errorMessageSafe : "",
            };
          })
        );
      },
      (error) => {
        if (signingOutRef.current || !auth.currentUser) {
          return;
        }
        setAuthError(getErrorMessage(error, "Ingestion status sync failed"));
      }
    );
  }, [user]);

  useEffect(() => {
    if (!user) {
      setAdminAccess(false);
      return;
    }

    const getCapabilities = httpsCallable<
      Record<string, never>,
      { ok: boolean; admin: boolean }
    >(functions, "getUserCapabilities");
    getCapabilities({})
      .then((response) => setAdminAccess(response.data.admin === true))
      .catch(() => setAdminAccess(false));
  }, [user]);

  useEffect(() => {
    if (!user) {
      return;
    }

    return onSnapshot(
      doc(db, "users", user.uid),
      (snapshot) => {
        const data = snapshot.data();
        const current = data?.usageCurrentPeriod ?? {};
        const limits = data?.limits ?? {};

        setUsage({
          plan: typeof data?.plan === "string" ? data.plan : "free",
          subscriptionStatus:
            typeof data?.subscriptionStatus === "string" ? data.subscriptionStatus : "none",
          billingProvider:
            typeof data?.billingProvider === "string" ? data.billingProvider : "none",
          billingCustomerId:
            typeof data?.billingCustomerId === "string" ? data.billingCustomerId : "",
          billingSubscriptionId:
            typeof data?.billingSubscriptionId === "string" ? data.billingSubscriptionId : "",
          messages: typeof current.messages === "number" ? current.messages : 0,
          monthlyMessages:
            typeof limits.monthlyMessages === "number" ? limits.monthlyMessages : 10,
          articleGenerations:
            typeof current.articleGenerations === "number" ? current.articleGenerations : 0,
          books:
            typeof current.books === "number"
              ? Math.max(current.books, books.length)
              : books.length,
          maxBooks: typeof limits.maxBooks === "number" ? limits.maxBooks : 1,
          storageBytes:
            typeof current.storageBytes === "number"
              ? Math.max(current.storageBytes, activeStorageBytes)
              : activeStorageBytes,
          maxStorageBytes:
            typeof limits.maxStorageBytes === "number"
              ? limits.maxStorageBytes
              : 10 * 1024 * 1024,
        });
      },
      (error) => {
        if (signingOutRef.current || !auth.currentUser) {
          return;
        }
        setAuthError(getErrorMessage(error, "Usage sync failed"));
      }
    );
  }, [activeStorageBytes, books.length, user]);

  useEffect(() => {
    if (!user) {
      setConversations([]);
      setConversationsReady(false);
      return;
    }

    const conversationsQuery = query(
      collection(db, "conversations"),
      where("userId", "==", user.uid)
    );
    return onSnapshot(
      conversationsQuery,
      (snapshot) => {
        setConversations(
          snapshot.docs
            .map((conversationDoc) => {
              const data = conversationDoc.data();
              return {
                id: conversationDoc.id,
                title: typeof data.title === "string" ? data.title : t.untitledQuestion,
                mode: typeof data.mode === "string" ? data.mode : "",
                latestAnswerPreview:
                  typeof data.latestAnswerPreview === "string"
                    ? data.latestAnswerPreview
                    : "",
                sourceCount: typeof data.sourceCount === "number" ? data.sourceCount : 0,
                sourceBookIds: Array.isArray(data.sourceBookIds)
                  ? data.sourceBookIds.filter((bookId) => typeof bookId === "string")
                  : [],
                hasUnavailableSources: data.hasUnavailableSources === true,
                unavailableBookTitles: Array.isArray(data.unavailableBookTitles)
                  ? data.unavailableBookTitles.filter((title) => typeof title === "string")
                  : [],
                updatedAtMs:
                  typeof data.updatedAt?.toMillis === "function"
                    ? data.updatedAt.toMillis()
                    : 0,
              };
            })
            .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
            .slice(0, 5)
        );
        setConversationsReady(true);
      },
      (error) => {
        if (signingOutRef.current || !auth.currentUser) {
          return;
        }
        setAuthError(getErrorMessage(error, "Conversation sync failed"));
        setConversationsReady(true);
      }
    );
  }, [t.untitledQuestion, user]);

  useEffect(() => {
    if (workspaceTab === "articles") {
      void loadArticleDrafts();
    }
  }, [workspaceTab, user, articleStudioUnlocked, emailVerified]);

  useEffect(() => {
    if (!user || !isAdminPath) {
      return;
    }

    void loadAdminConsole();
  }, [isAdminPath, user]);

  useEffect(() => {
    setBookDeleteProgress((current) => {
      const activeProgress = Object.fromEntries(
        Object.entries(current).filter(([bookId]) =>
          books.some((book) => book.id === bookId && book.status !== "deleting")
        )
      );
      return Object.keys(activeProgress).length === Object.keys(current).length
        ? current
        : activeProgress;
    });

    books
      .filter((book) => book.status === "deleting")
      .forEach((book) => {
        setBookDeleteProgress((current) =>
          current[book.id]
            ? current
            : {
                ...current,
                [book.id]: {
                  label: book.displayTitle,
                  progress: 92,
                },
              }
        );
      });
  }, [books]);

  useEffect(() => {
    if (!lastUploadedBookId) {
      return;
    }

    const uploadedBook = books.find((book) => book.id === lastUploadedBookId);
    if (!uploadedBook) {
      return;
    }

    if (uploadedBook.status === "text_ready") {
      setUploadMessage(`${t.uploadReady}: ${uploadedBook.displayTitle}`);
      return;
    }

    if (uploadedBook.status === "processing" || uploadedBook.status === "queued") {
      setUploadMessage(`${t.uploadProcessing}: ${uploadedBook.displayTitle}`);
    }
  }, [books, lastUploadedBookId, t.uploadProcessing, t.uploadReady]);

  useEffect(() => {
    const trackedBook = uploadTrackingBook;
    if (!trackedBook) {
      return;
    }

    const isPreparing = ["upload_reserved", "queued", "processing"].includes(trackedBook.status);
    const alreadyDismissed = dismissedUploadPrepNoticeBookIds.includes(trackedBook.id);
    if (!isPreparing || alreadyDismissed || uploadPrepNoticeBookId === trackedBook.id) {
      return;
    }

    if (trackedBook.sizeBytes >= LARGE_UPLOAD_NOTICE_BYTES) {
      setUploadPrepNoticeBookId(trackedBook.id);
      return;
    }

    const timer = window.setTimeout(() => {
      setUploadPrepNoticeBookId((currentBookId) => currentBookId || trackedBook.id);
    }, 20000);

    return () => window.clearTimeout(timer);
  }, [
    dismissedUploadPrepNoticeBookIds,
    uploadPrepNoticeBookId,
    uploadTrackingBook,
  ]);

  useEffect(() => {
    if (!uploadPrepNoticeBookId) {
      return;
    }

    const noticeBook = books.find((book) => book.id === uploadPrepNoticeBookId);
    if (!noticeBook || noticeBook.status === "text_ready" || noticeBook.status === "failed") {
      setUploadPrepNoticeBookId("");
    }
  }, [books, uploadPrepNoticeBookId]);

  useEffect(() => {
    if (!lastUploadedBookId) {
      return;
    }

    const target = bookCardRefs.current.get(lastUploadedBookId);
    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("recent-upload");
    window.setTimeout(() => target.classList.remove("recent-upload"), 2400);
  }, [books, lastUploadedBookId]);

  useEffect(() => {
    if (!readerBookId) {
      setReaderHighlights({});
    }
  }, [readerBookId]);

  useEffect(() => {
    if (!adminBookDebug) {
      return;
    }

    window.setTimeout(() => {
      document.getElementById("admin-book-debug")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);
  }, [adminBookDebug]);

  useEffect(() => {
    if (!adminSearch.trim() && adminBookStatusFilter === "all") {
      return;
    }

    window.setTimeout(() => {
      adminBookResultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, [adminBookStatusFilter, adminSearch]);

  useEffect(() => {
    let cancelled = false;
    setReaderOriginalPageUrl("");

    if (!readerOriginalPage?.storagePath) {
      return;
    }

    getDownloadURL(ref(storage, readerOriginalPage.storagePath))
      .then((url) => {
        if (!cancelled) {
          setReaderOriginalPageUrl(url);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setReaderMessage(getErrorMessage(error, "Original page failed"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [readerOriginalPage?.storagePath]);

  useEffect(() => {
    let cancelled = false;
    setReaderInlineMediaUrls({});

    const mediaWithPaths = readerInlineMedia.filter((media) => media.storagePath);
    if (mediaWithPaths.length === 0) {
      return;
    }

    Promise.all(
      mediaWithPaths.map(async (media) => {
        const url = await getDownloadURL(ref(storage, media.storagePath));
        return [media.id, url] as const;
      })
    )
      .then((entries) => {
        if (!cancelled) {
          setReaderInlineMediaUrls(Object.fromEntries(entries));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setReaderMessage(getErrorMessage(error, "Inline image failed"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [readerInlineMedia]);

  useEffect(() => {
    if (!readerBook || activeReaderPageCount <= 0 || readerPage < activeReaderPageCount) {
      return;
    }

    void openBookReader(readerBook, activeReaderPageCount - 1);
  }, [activeReaderPageCount, readerBook, readerPage]);

  useEffect(() => {
    if (!readerPickerScrollPending || readerBookId || workspaceTab !== "read") {
      return;
    }

    const timer = window.setTimeout(() => {
      document
        .getElementById("reader-book-picker")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setReaderPickerScrollPending(false);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [readerBookId, readerPickerScrollPending, workspaceTab]);

  useEffect(() => {
    if (!readerBook) {
      setReaderScrollNavVisible(false);
      return;
    }

    function handleScroll() {
      setReaderScrollNavVisible(true);
      if (readerScrollTimeoutRef.current) {
        window.clearTimeout(readerScrollTimeoutRef.current);
      }
      readerScrollTimeoutRef.current = window.setTimeout(() => {
        setReaderScrollNavVisible(false);
      }, 1800);
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (readerScrollTimeoutRef.current) {
        window.clearTimeout(readerScrollTimeoutRef.current);
      }
    };
  }, [readerBook]);

  useEffect(() => {
    if (!readerBook) {
      return;
    }

    let selectionTimeout: number | null = null;
    function handleSelectionChange() {
      if (selectionTimeout) {
        window.clearTimeout(selectionTimeout);
      }
      selectionTimeout = window.setTimeout(captureReaderSelection, 90);
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (selectionTimeout) {
        window.clearTimeout(selectionTimeout);
      }
    };
  }, [readerBook, readerParagraphs]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (
        menuOpen &&
        !workspaceMenuRef.current?.contains(target) &&
        !menuButtonRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }

      if (readerBookmarkMenuOpen && !bookmarkMenuRef.current?.contains(target)) {
        setReaderBookmarkMenuOpen(false);
      }
      if (readerHighlightMenuOpen && !highlightMenuRef.current?.contains(target)) {
        setReaderHighlightMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen, readerBookmarkMenuOpen, readerHighlightMenuOpen]);

  async function loadAdminDashboard() {
    const getDashboard = httpsCallable<unknown, AdminDashboardPayload>(
      functions,
      "adminGetDashboard"
    );
    const response = await getDashboard({});
    setAdminDashboard(response.data);
  }

  async function loadAdminConversations() {
    const listConversations = httpsCallable<
      { limit: number },
      { ok: boolean; conversations: AdminConversationSummary[] }
    >(functions, "adminListRecentConversations");
    const response = await listConversations({ limit: 40 });
    setAdminConversations(response.data.conversations ?? []);
  }

  async function loadAdminBooks() {
    const listBooks = httpsCallable<
      { limit: number },
      { ok: boolean; books: AdminBookSummary[] }
    >(functions, "adminListBooks");
    const response = await listBooks({ limit: 80 });
    setAdminBooks(response.data.books ?? []);
  }

  async function loadAdminUsers() {
    const listUsers = httpsCallable<
      { limit: number },
      { ok: boolean; users: AdminUserSummary[] }
    >(functions, "adminListUsers");
    const response = await listUsers({ limit: 80 });
    setAdminUsers(response.data.users ?? []);
  }

  async function loadAdminConsole() {
    setAdminBusy(true);
    setAdminMessage("");

    try {
      await Promise.all([
        loadAdminDashboard(),
        loadAdminConversations(),
        loadAdminBooks(),
        loadAdminUsers(),
      ]);
    } catch (error) {
      setAdminMessage(getErrorMessage(error, "Admin console failed"));
    } finally {
      setAdminBusy(false);
    }
  }

  async function openAdminConversation(conversationId: string) {
    setAdminBusy(true);
    setAdminMessage("");

    try {
      const getDebug = httpsCallable<
        { conversationId: string; reason: string },
        AdminConversationDebug
      >(functions, "adminGetConversationDebug");
      const response = await getDebug({
        conversationId,
        reason: "Admin console conversation route trace review.",
      });
      setAdminConversationDebug(response.data);
      window.requestAnimationFrame(() => {
        document.getElementById("admin-debug")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    } catch (error) {
      setAdminMessage(getErrorMessage(error, "Conversation debug failed"));
    } finally {
      setAdminBusy(false);
    }
  }

  async function repairAdminBookReaderText(bookId: string) {
    setAdminBusy(true);
    setAdminRepairRunning(true);
    setAdminRepairProgress(8);
    setAdminRepairMessage("Preparing a reader text repair for this PDF.");
    setAdminRepairError("");
    setAdminMessage("");
    const progressTimer = window.setInterval(() => {
      setAdminRepairProgress((progress) => Math.min(92, progress + (progress < 50 ? 12 : 6)));
      setAdminRepairMessage((message) =>
        message === "Preparing a reader text repair for this PDF."
          ? "Extracting fresh reader pages and source TOC."
          : "Updating the reader text preview. Existing chunks, vectors, highlights, and drafts stay untouched."
      );
    }, 1400);

    try {
      const repairBookReaderText = httpsCallable<
        { bookId: string; confirmation: string; reason: string },
        {
          ok: boolean;
          bookId: string;
          pageTextCount: number;
          sourceTocEntryCount: number;
          structureQuality: string;
          preferredReaderMode?: string;
          queued?: boolean;
          jobId?: string;
        }
      >(functions, "adminRepairBookReaderText");
      const response = await repairBookReaderText({
        bookId,
        confirmation: "REPAIR_READER_TEXT_ONLY",
        reason: "Admin console reader text repair after extractor improvement.",
      });
      await openAdminBook(bookId);
      await loadAdminBooks();
      const successMessage = response.data.queued
        ? `Reader text repair queued. Job ${response.data.jobId || "started"} will continue in the background.`
        : `Reader text repaired: ${response.data.pageTextCount} pages, ${response.data.sourceTocEntryCount} TOC entries, ${response.data.structureQuality}.`;
      setAdminRepairProgress(100);
      setAdminRepairMessage(successMessage);
      setAdminMessage(successMessage);
    } catch (error) {
      const errorMessage = getErrorMessage(error, "Reader text repair failed");
      setAdminRepairError(errorMessage);
      setAdminMessage(errorMessage);
    } finally {
      window.clearInterval(progressTimer);
      setAdminRepairRunning(false);
      setAdminBusy(false);
    }
  }

  async function openAdminBook(bookId: string) {
    setAdminBusy(true);
    setAdminMessage("");

    try {
      const getBookDebug = httpsCallable<
        { bookId: string; reason: string },
        AdminBookDebug
      >(functions, "adminGetBookDebug");
      const response = await getBookDebug({
        bookId,
        reason: "Admin console book metadata and ingestion review.",
      });
      setAdminBookDebug(response.data);
    } catch (error) {
      setAdminMessage(getErrorMessage(error, "Book debug failed"));
    } finally {
      setAdminBusy(false);
    }
  }

  async function handlePasswordAuth(
    event: FormEvent<HTMLFormElement>,
    mode: "signIn" | "signUp"
  ) {
    event.preventDefault();
    await submitPasswordAuth(mode);
  }

  async function submitPasswordAuth(mode: "signIn" | "signUp") {
    setAuthError("");
    setStatus("");

    try {
      const credential =
        mode === "signUp"
          ? await createUserWithEmailAndPassword(auth, email, password)
          : await signInWithEmailAndPassword(auth, email, password);
      if (mode === "signUp" && !credential.user.emailVerified) {
        await sendEmailVerification(credential.user, getEmailActionSettings());
        await ensureUserRecord(credential.user, locale, theme);
        setStatus(t.verificationEmailSent);
        return;
      }
      await ensureUserRecord(credential.user, locale, theme);
      setStatus(credential.user.emailVerified ? t.userCreated : t.verifyEmailPrompt);
    } catch (error) {
      setAuthError(getErrorMessage(error, t.authError));
    }
  }

  async function sendPasswordReset() {
    const resetEmail = email.trim();
    setAuthError("");
    setStatus("");

    if (!resetEmail) {
      setAuthError(t.passwordResetEmailRequired);
      return;
    }

    try {
      await sendPasswordResetEmail(auth, resetEmail, {
        url: AUTH_ACTION_URL,
      });
      setStatus(t.passwordResetSent);
    } catch (error) {
      if (error instanceof FirebaseError && error.code === "auth/user-not-found") {
        setStatus(t.passwordResetSent);
        return;
      }
      setAuthError(getErrorMessage(error, t.passwordResetFailed));
    }
  }

  async function submitResetAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResetActionFormError("");

    if (resetActionPassword.length < 8) {
      setResetActionFormError(t.passwordResetTooShort);
      return;
    }

    if (resetActionPassword !== resetActionConfirmPassword) {
      setResetActionFormError(t.passwordResetMismatch);
      return;
    }

    setResetActionBusy(true);
    try {
      await confirmPasswordReset(auth, authActionCode, resetActionPassword);
      setResetActionComplete(true);
      setResetActionPassword("");
      setResetActionConfirmPassword("");
    } catch (error) {
      setResetActionFormError(getErrorMessage(error, t.passwordResetConfirmFailed));
    } finally {
      setResetActionBusy(false);
    }
  }

  async function handleGoogleAuth() {
    setAuthError("");
    setStatus("");

    try {
      const credential = await signInWithPopup(auth, googleProvider);
      await ensureUserRecord(credential.user, locale, theme);
      setStatus(t.userCreated);
    } catch (error) {
      setAuthError(getErrorMessage(error, t.authError));
    }
  }

  async function resendVerificationEmail() {
    if (!user) {
      return;
    }

    setVerificationBusy(true);
    setAuthError("");

    try {
      await sendEmailVerification(user, getEmailActionSettings());
      setStatus(t.verificationEmailSent);
    } catch (error) {
      setAuthError(getErrorMessage(error, t.verificationEmailFailed));
    } finally {
      setVerificationBusy(false);
    }
  }

  async function refreshEmailVerification() {
    if (!auth.currentUser) {
      return;
    }

    setVerificationBusy(true);
    setAuthError("");

    try {
      await reload(auth.currentUser);
      await ensureUserRecord(auth.currentUser, locale, theme);
      setUser(auth.currentUser);
      setStatus(auth.currentUser.emailVerified ? t.emailVerifiedReady : t.verifyEmailPrompt);
    } catch (error) {
      setAuthError(getErrorMessage(error, t.verificationRefreshFailed));
    } finally {
      setVerificationBusy(false);
    }
  }

  function requireVerifiedUi(messageSetter: (message: string) => void) {
    if (emailVerified) {
      return true;
    }

    messageSetter(t.verifyEmailBeforeFeature);
    return false;
  }

  function handleFileSelection(file: File | undefined) {
    setUploadMessage("");
    setUploadProgress(0);

    if (!file) {
      setSelectedFile(null);
      return;
    }

    if (file.size > MAX_FREE_FILE_BYTES) {
      setSelectedFile(null);
      setUploadMessage(t.fileTooLarge);
      return;
    }

    const extensionAllowed = /\.(pdf|txt|md|markdown|docx|epub)$/i.test(file.name);
    if (!ALLOWED_UPLOAD_TYPES.has(file.type) && !extensionAllowed) {
      setSelectedFile(null);
      setUploadMessage(t.fileTypeBlocked);
      return;
    }

    const uploadTitle = normalizeBookTitle(getUploadTitle(file.name));
    const duplicateBook = books.find(
      (book) =>
        normalizeBookTitle(book.title) === uploadTitle &&
        book.status !== "deleting"
    );
    if (duplicateBook) {
      setSelectedFile(null);
      setUploadMessage(`${t.duplicateBookWarning}: ${duplicateBook.title}`);
      return;
    }

    setSelectedFile(file);
    setUploadMessage("");
  }

  async function reserveAndUploadFile() {
    if (!selectedFile || !UPLOAD_BACKEND_ENABLED) {
      setUploadMessage(t.uploadBlocked);
      return;
    }
    if (!requireVerifiedUi(setUploadMessage)) {
      return;
    }

    setUploadBusy(true);
    setUploadMessage("");
    setUploadProgress(0);

    try {
      const createReservation = httpsCallable<
        { fileName: string; contentType: string; sizeBytes: number },
        { bookId: string; storagePath: string }
      >(functions, "createUploadReservation");
      const finalizeReservation = httpsCallable<
        { bookId: string },
        { bookId: string; jobId: string; status: string }
      >(functions, "finalizeUploadReservation");

      const reservation = await createReservation(withSession({
        fileName: selectedFile.name,
        contentType: selectedFile.type || "application/octet-stream",
        sizeBytes: selectedFile.size,
      }));
      const uploadRef = ref(storage, reservation.data.storagePath);
      const uploadTask = uploadBytesResumable(uploadRef, selectedFile, {
        contentType: selectedFile.type || "application/octet-stream",
      });

      await new Promise<void>((resolve, reject) => {
        uploadTask.on(
          "state_changed",
          (snapshot) => {
            const progress = snapshot.totalBytes > 0
              ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
              : 0;
            setUploadProgress(progress);
          },
          reject,
          () => resolve()
        );
      });

      setUploadMessage(t.uploadFinalizing);
      await finalizeReservation(withSession({ bookId: reservation.data.bookId }));
      setUploadProgress(100);
      setSelectedFile(null);
      setLastUploadedBookId(reservation.data.bookId);
      setUploadTrackingBookId(reservation.data.bookId);
      setUploadMessage(t.uploadQueued);
    } catch (error) {
      setUploadMessage(getErrorMessage(error, "Upload failed"));
    } finally {
      setUploadBusy(false);
    }
  }

  function dismissUploadPrepNotice() {
    if (uploadPrepNoticeBookId) {
      setDismissedUploadPrepNoticeBookIds((bookIds) =>
        bookIds.includes(uploadPrepNoticeBookId) ? bookIds : [...bookIds, uploadPrepNoticeBookId]
      );
    }
    setUploadPrepNoticeBookId("");
  }

  function continueInAskDuringUpload() {
    dismissUploadPrepNotice();
    setWorkspaceTab("ask");
  }

  async function processQueuedJobs() {
    if (!user) {
      return;
    }
    if (!requireVerifiedUi(setUploadMessage)) {
      return;
    }

    const queuedBooks = books.filter((book) => book.status === "queued");

    if (queuedBooks.length === 0) {
      setUploadMessage(t.processQueuedDone);
      return;
    }

    setProcessBusy(true);
    setUploadMessage(t.processingQueued);

    try {
      const processJob = httpsCallable<{ jobId: string }, { ok: boolean }>(
        functions,
        "processIngestionJob"
      );
      const jobsQuery = query(
        collection(db, "ingestionJobs"),
        where("userId", "==", user.uid),
        where("status", "==", "queued")
      );

      const snapshot = await getDocs(jobsQuery);
      for (const jobDoc of snapshot.docs) {
        await processJob(withSession({ jobId: jobDoc.id }));
      }

      setUploadMessage(t.processQueuedDone);
    } catch (error) {
      setUploadMessage(getErrorMessage(error, "Processing failed"));
    } finally {
      setProcessBusy(false);
    }
  }

  async function processBookJob(book: BookRecord) {
    if (!user) {
      return;
    }
    if (!requireVerifiedUi(setUploadMessage)) {
      return;
    }

    const job = jobsByBookId.get(book.id);
    if (!job || (job.status !== "queued" && job.status !== "failed")) {
      setUploadMessage(t.noProcessableJob);
      return;
    }

    setProcessingBookId(book.id);
    setUploadMessage(`${t.uploadProcessing}: ${book.displayTitle}`);

    try {
      const processJob = httpsCallable<{ jobId: string }, { ok: boolean }>(
        functions,
        "processIngestionJob"
      );
      await processJob(withSession({ jobId: job.id }));
      setUploadMessage(t.processQueuedDone);
    } catch (error) {
      setUploadMessage(getErrorMessage(error, "Processing failed"));
    } finally {
      setProcessingBookId("");
    }
  }

  function getBookStatusLabel(book: BookRecord) {
    const job = jobsByBookId.get(book.id);
    const status = job?.status || book.status;

    if (book.status === "text_ready") {
      return t.textReady;
    }
    if (status === "queued") {
      return t.statusQueued;
    }
    if (status === "processing" || book.status === "processing") {
      return t.statusProcessing;
    }
    if (status === "failed" || book.status === "failed") {
      return t.statusFailed;
    }
    if (book.status === "deleting") {
      return t.statusDeleting;
    }
    if (book.status === "deletion_failed") {
      return t.statusDeleteFailed;
    }
    if (book.status === "upload_reserved") {
      return t.statusUploadReserved;
    }

    return book.status;
  }

  function getIngestionStageLabel(job?: IngestionJobRecord | null) {
    if (!job) {
      return t.uploadStageWaiting;
    }

    if (job.status === "failed") {
      return t.uploadStageFailed;
    }
    if (job.status === "completed") {
      return t.uploadStageReady;
    }

    switch (job.stage) {
      case "queued":
        return t.uploadStageQueued;
      case "extracting_text":
        return t.uploadStageExtracting;
      case "chunking_text":
        return t.uploadStageChunking;
      case "embedding_chunks":
        return t.uploadStageEmbedding;
      case "writing_chunks":
        return t.uploadStageWriting;
      case "text_ready":
        return t.uploadStageReady;
      default:
        return job.status === "processing" ? t.uploadStageProcessing : job.stage || job.status;
    }
  }

  function getIngestionStageDetail(job?: IngestionJobRecord | null) {
    if (!job) {
      return t.uploadStageWaitingDetail;
    }

    switch (job.stage) {
      case "queued":
        return t.uploadStageQueuedDetail;
      case "extracting_text":
        return t.uploadStageExtractingDetail;
      case "chunking_text":
        return t.uploadStageChunkingDetail;
      case "embedding_chunks":
        return t.uploadStageEmbeddingDetail;
      case "writing_chunks":
        return t.uploadStageWritingDetail;
      case "text_ready":
        return t.uploadStageReadyDetail;
      default:
        return job.status === "failed" ? job.errorMessageSafe || t.uploadStageFailedDetail : t.uploadStageProcessingDetail;
    }
  }

  function getVectorBackfillProgress(book: BookRecord) {
    if (!book.chunkCount) {
      return 0;
    }

    return Math.max(
      0,
      Math.min(
        100,
        Math.round(
          (Math.max(book.pineconeIndexedChunkCount, book.vectorBackfillProcessedChunkCount) /
            book.chunkCount) *
            100
        )
      )
    );
  }

  function getVectorCoverage(book: {
    chunkCount: number;
    embeddedChunkCount: number;
    pineconeIndexedChunkCount?: number;
    pineconeMissingChunkCount?: number;
    vectorBackendCandidate?: string;
  }) {
    const chunkCount = Math.max(0, book.chunkCount || 0);
    const embeddedCount = Math.max(0, book.embeddedChunkCount || 0);
    const pineconeIndexed = Math.max(0, book.pineconeIndexedChunkCount || 0);
    const pineconeMissing = Math.max(0, book.pineconeMissingChunkCount || 0);
    const pineconeCandidate = book.vectorBackendCandidate === "pinecone" || pineconeIndexed > 0;

    if (pineconeCandidate && pineconeIndexed > 0 && pineconeMissing === 0) {
      return {
        status: "pinecone-ready",
        label: t.smartSearchReady,
        detail: `${pineconeIndexed}/${chunkCount || pineconeIndexed} ${t.passagesReady}`,
      };
    }

    if (pineconeCandidate && (pineconeIndexed > 0 || pineconeMissing > 0)) {
      return {
        status: "pinecone-incomplete",
        label: t.smartSearchPartial,
        detail: `${pineconeIndexed}/${chunkCount || pineconeIndexed + pineconeMissing} ${t.passagesReady} · ${pineconeMissing} ${t.passagesMissing}`,
      };
    }

    if (embeddedCount > 0) {
      return {
        status: "firestore-vectors",
        label: t.storedSearchReady,
        detail: `${embeddedCount}/${chunkCount || embeddedCount} ${t.passagesReady}`,
      };
    }

    if (chunkCount > 0) {
      return {
        status: "text-only",
        label: t.textSearchReady,
        detail: `${chunkCount} ${t.chunks.toLowerCase()} · ${t.smartSearchPending}`,
      };
    }

    return {
      status: "not-ready",
      label: t.notReadyYet,
      detail: "",
    };
  }

  async function searchExtractedText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!searchQuestion.trim() || textReadyBooks.length === 0) {
      return;
    }
    if (!requireVerifiedUi(setSearchMessage)) {
      return;
    }

    setSearchBusy(true);
    setSearchMessage("");
    setSearchResults([]);

    try {
      const searchLibrary = httpsCallable<
        { query: string; bookId?: string },
        { ok: boolean; results: LibrarySearchResult[] }
      >(functions, "searchLibrary");
      const response = await searchLibrary(withSession({
        query: searchQuestion.trim(),
        bookId: selectedBookScope || undefined,
      }));
      const results = response.data.results ?? [];
      setSearchResults(results);
      setSearchMessage(results.length === 0 ? t.noSearchResults : "");
      window.setTimeout(() => {
        sourceSearchResultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (error) {
      setSearchMessage(getErrorMessage(error, "Search failed"));
    } finally {
      setSearchBusy(false);
    }
  }

  async function searchCurrentReaderBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!readerBook || !readerSourceQuestion.trim()) {
      return;
    }
    if (!requireVerifiedUi(setReaderSourceMessage)) {
      return;
    }

    setReaderSourceBusy(true);
    setReaderSourceMessage("");
    setReaderSourceResults([]);

    try {
      const searchLibrary = httpsCallable<
        { query: string; bookId?: string },
        { ok: boolean; results: LibrarySearchResult[] }
      >(functions, "searchLibrary");
      const response = await searchLibrary(withSession({
        query: readerSourceQuestion.trim(),
        bookId: readerBook.id,
      }));
      const results = response.data.results ?? [];
      setReaderSourceResults(results);
      setReaderSourceMessage(results.length === 0 ? t.noSearchResults : "");
      window.setTimeout(() => {
        readerSourceResultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (error) {
      setReaderSourceMessage(getErrorMessage(error, "Search failed"));
      window.setTimeout(() => {
        readerSourceResultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } finally {
      setReaderSourceBusy(false);
    }
  }

  async function submitAskQuestion(question: string, bookId: string) {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || textReadyBooks.length === 0) {
      return;
    }
    if (!requireVerifiedUi(setAskMessage)) {
      return;
    }

    setAskBusy(true);
    setAskMessage("");
    setAskAnswer("");
    setAskMode("");
    setAskSources([]);
    setAskActiveContext(null);
    setAskProgress(10);
    window.requestAnimationFrame(() => {
      askProgressRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const progressTimer = window.setInterval(() => {
      setAskProgress((progress) => Math.min(90, progress + (progress < 45 ? 12 : 7)));
    }, 700);

    try {
      const activeConversationId = askActiveContext?.conversationId || undefined;
      const askLibrary = httpsCallable<
        { query: string; locale: Locale; bookId?: string; conversationId?: string },
        AskLibraryResponse
      >(functions, "askLibrary");
      const response = await askLibrary(withSession({
        query: trimmedQuestion,
        locale,
        bookId: bookId || undefined,
        conversationId: activeConversationId,
      }));
      setAskAnswer(response.data.answer);
      setAskMode(response.data.mode);
      setAskSources(response.data.results ?? []);
      setAskActiveContext({
        sourceType: response.data.activeMode === "section_map" ? "section" : "answer",
        conversationId: response.data.conversationId,
        activeMode: response.data.activeMode,
        activeBookId: response.data.activeBookId || bookId || response.data.results?.[0]?.bookId || "",
        activeArtifactId: response.data.activeArtifactId || "",
        activeSectionNumber: response.data.activeSectionNumber || 0,
        titleHint:
          response.data.activeMode === "section_map" && response.data.activeSectionNumber
            ? `${t.sectionLabel} ${response.data.activeSectionNumber}`
            : trimmedQuestion.slice(0, 90),
      });
      setAskMessage(response.data.results.length === 0 ? t.noSearchResults : "");
      setAskProgress(100);
    } catch (error) {
      setAskMessage(getErrorMessage(error, "Ask failed"));
    } finally {
      window.clearInterval(progressTimer);
      setAskBusy(false);
    }
  }

  async function askLibraryQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitAskQuestion(askQuestion, selectedBookScope);
  }

  function rememberSuggestion(suggestion: SuggestionChip) {
    setUsedSuggestionQuestions((current) => {
      if (current.includes(suggestion.question)) {
        return current;
      }

      return [...current.slice(-20), suggestion.question];
    });
  }

  function changeAskBookScope(bookId: string) {
    setSelectedBookScope(bookId);
    setAskAnswer("");
    setAskMode("");
    setAskSources([]);
    setAskActiveContext(null);
    setAskMessage("");
    setAskProgress(0);
  }

  function useSuggestion(suggestion: SuggestionChip) {
    rememberSuggestion(suggestion);
    setAskQuestion(suggestion.question);
    if (suggestion.bookId) {
      changeAskBookScope(suggestion.bookId);
    }
    setWorkspaceTab("ask");
    window.requestAnimationFrame(() => {
      askInputRef.current?.focus();
      document.getElementById("library")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function askSuggestion(suggestion: SuggestionChip) {
    rememberSuggestion(suggestion);
    setAskQuestion(suggestion.question);
    if (suggestion.bookId) {
      setSelectedBookScope(suggestion.bookId);
    }
    setWorkspaceTab("ask");
    void submitAskQuestion(suggestion.question, suggestion.bookId || selectedBookScope);
  }

  async function loadArticleDrafts() {
    if (!user || !articleStudioUnlocked || !emailVerified) {
      setArticleDrafts([]);
      return;
    }

    try {
      const listArticleDrafts = httpsCallable<
        { sessionId: string },
        { ok: boolean; drafts: ArticleDraftRecord[] }
      >(functions, "listArticleDrafts");
      const response = await listArticleDrafts(withSession({}));
      setArticleDrafts(response.data.drafts ?? []);
    } catch (error) {
      setArticleMessage(getErrorMessage(error, "Article drafts could not be loaded"));
    }
  }

  async function writeArticleDraftFromPrompt(
    prompt: string,
    bookId: string,
    context: ArticleContext = { sourceType: "manual" }
  ) {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || !bookId || articleBusy) {
      return;
    }
    if (!requireVerifiedUi(setArticleMessage)) {
      return;
    }

    setArticleBusy(true);
    setArticleMessage("");
    setArticleCurrentDraft(null);
    setArticleCurrentVersion(null);
    setArticleProgress(10);
    const progressTimer = window.setInterval(() => {
      setArticleProgress((progress) => Math.min(90, progress + (progress < 50 ? 10 : 5)));
    }, 900);

    try {
      const createArticle = httpsCallable<
        { bookId: string; prompt: string; locale: Locale; context?: ArticleContext },
        ArticleDraftResponse
      >(functions, "createArticleDraftTest");
      const response = await createArticle(withSession({
        bookId,
        prompt: trimmedPrompt,
        locale,
        context,
      }));
      setArticleCurrentDraft(response.data.draft);
      setArticleCurrentVersion(response.data.version);
      setArticleDrafts((current) => [response.data.draft, ...current.filter((draft) => draft.id !== response.data.draft.id)]);
      setArticleMessage(t.articleReady);
      setArticleProgress(100);
    } catch (error) {
      setArticleMessage(getErrorMessage(error, "Article writing failed"));
    } finally {
      window.clearInterval(progressTimer);
      setArticleBusy(false);
    }
  }

  async function createArticleDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await writeArticleDraftFromPrompt(articlePrompt, articleReadyBookId, {
      ...articleDraftContext,
      activeBookId: articleDraftContext.activeBookId || articleReadyBookId,
    });
  }

  function getArticleScopeLabel(context?: ArticleContext) {
    if (!context) {
      return t.articleScopeWholeBook;
    }
    if (context.sourceType === "selection") {
      return t.articleScopeSelection;
    }
    if (context.sourceType === "section_map") {
      return t.articleScopeSectionMap;
    }
    if (context.activeSectionNumber) {
      return `${t.sectionLabel} ${context.activeSectionNumber}`;
    }
    return t.articleScopeWholeBook;
  }

  function getArticleSourceDescription(context?: ArticleContext) {
    if (!context || context.sourceType === "manual") {
      return t.articleSourceManual;
    }

    const bookTitle =
      books.find((book) => book.id === (context.activeBookId || articleReadyBookId))?.displayTitle ||
      articleCurrentDraft?.bookTitle ||
      "";
    const scope = getArticleScopeLabel(context);
    const hint = context.titleHint || scope;
    return [scope, bookTitle, hint].filter(Boolean).join(" · ");
  }

  function mapArticleVersionRecord(id: string, data: Record<string, unknown>): ArticleVersionRecord {
    const rawSources = Array.isArray(data.sourceSnapshots)
      ? data.sourceSnapshots
      : Array.isArray(data.sources)
        ? data.sources
        : [];
    const sources: ArticleSource[] = rawSources.map((source, index) => {
      const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
      return {
        chunkId: typeof record.chunkId === "string" ? record.chunkId : "",
        bookId: typeof record.bookId === "string" ? record.bookId : "",
        bookTitle: typeof record.bookTitle === "string" ? record.bookTitle : "",
        chunkIndex: Number(record.chunkIndex) || 0,
        score: Number(record.score) || 0,
        excerpt: typeof record.excerpt === "string" ? record.excerpt : "",
        sourceNumber: Number(record.sourceNumber) || index + 1,
      };
    });
    return {
      id,
      title: typeof data.title === "string" ? data.title : "",
      body: typeof data.body === "string" ? data.body : "",
      versionNumber: Number(data.versionNumber) || 1,
      sources,
      articleContext:
        data.articleContext && typeof data.articleContext === "object"
          ? (data.articleContext as ArticleContext)
          : undefined,
    };
  }

  async function continueArticleDraft(draft: ArticleDraftRecord) {
    setArticleMessage("");
    setArticleCurrentDraft(draft);
    setArticleBookId(draft.bookId);
    setArticlePrompt(draft.prompt);
    setArticleDraftContext(draft.articleContext ?? { sourceType: "manual", activeBookId: draft.bookId });

    try {
      const versionsSnapshot = await getDocs(
        query(collection(db, "articleVersions"), where("draftId", "==", draft.id))
      );
      const versions = versionsSnapshot.docs
        .map((versionDoc) =>
          mapArticleVersionRecord(versionDoc.id, versionDoc.data() as Record<string, unknown>)
        )
        .sort((left, right) => right.versionNumber - left.versionNumber);
      const latestVersion =
        versions.find((version) => version.id === draft.latestVersionId) ?? versions[0] ?? null;
      setArticleCurrentVersion(latestVersion);
      if (!latestVersion) {
        setArticleMessage(t.articleVersionMissing);
      }
    } catch (error) {
      setArticleMessage(getErrorMessage(error, t.articleVersionLoadFailed));
    }
  }

  async function copyCurrentArticleMarkdown() {
    if (!articleCurrentVersion) {
      return;
    }
    try {
      await navigator.clipboard.writeText(articleCurrentVersion.body);
      setArticleMessage(t.articleCopied);
    } catch (error) {
      setArticleMessage(getErrorMessage(error, t.articleCopyFailed));
    }
  }

  function exportCurrentArticleMarkdown() {
    if (!articleCurrentVersion) {
      return;
    }
    const fileTitle = (articleCurrentDraft?.title || articleCurrentVersion.title || "readwisehub-article")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "readwisehub-article";
    const blob = new Blob([articleCurrentVersion.body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileTitle}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setArticleMessage(t.articleExported);
  }

  async function rewriteCurrentArticle(rewriteKind: string) {
    if (!articleCurrentDraft || articleRewriteBusy || articleBusy) {
      return;
    }

    setArticleRewriteBusy(rewriteKind);
    setArticleMessage("");
    try {
      const rewriteArticle = httpsCallable<
        { draftId: string; rewriteKind: string },
        ArticleDraftResponse
      >(functions, "rewriteArticleDraftTest");
      const response = await rewriteArticle(withSession({
        draftId: articleCurrentDraft.id,
        rewriteKind,
      }));
      setArticleCurrentDraft(response.data.draft);
      setArticleCurrentVersion(response.data.version);
      setArticleDrafts((current) => [
        response.data.draft,
        ...current.filter((draft) => draft.id !== response.data.draft.id),
      ]);
      setArticleMessage(t.articleRewriteReady);
    } catch (error) {
      setArticleMessage(getErrorMessage(error, "Article rewrite failed"));
    } finally {
      setArticleRewriteBusy("");
    }
  }

  async function deleteArticleDraft(draftId: string) {
    setArticleDeleteBusyId(draftId);
    setArticleMessage("");
    try {
      const deleteDraft = httpsCallable<{ draftId: string }, { ok: boolean; draftId: string }>(
        functions,
        "deleteArticleDraftTest"
      );
      await deleteDraft(withSession({ draftId }));
      setArticleDrafts((current) => current.filter((draft) => draft.id !== draftId));
      if (articleCurrentDraft?.id === draftId) {
        setArticleCurrentDraft(null);
        setArticleCurrentVersion(null);
      }
      setArticleMessage(t.articleDeleted);
    } catch (error) {
      setArticleMessage(getErrorMessage(error, "Article delete failed"));
    } finally {
      setArticleDeleteBusyId("");
    }
  }

  function writeArticleFromCurrentAnswer() {
    const isSectionContext =
      askActiveContext?.activeMode === "section_map" &&
      Boolean(askActiveContext.activeArtifactId) &&
      Boolean(askActiveContext.activeSectionNumber);
    const bookId =
      askActiveContext?.activeBookId ||
      selectedBookScope ||
      askSources[0]?.bookId ||
      defaultSuggestionBook?.id ||
      "";
    const prompt =
      askAnswer && askQuestion
        ? `${isSectionContext ? t.articleFromSectionAnswerPrompt : t.articleFromAnswerPrompt}\n\n${askQuestion}\n\n${askAnswer.slice(0, 1200)}`
        : t.articlePromptPlaceholder;
    const context: ArticleContext = isSectionContext
      ? {
          ...askActiveContext,
          sourceType: "section",
          titleHint: askActiveContext?.titleHint || t.articleSectionTitleHint,
        }
      : {
          ...(askActiveContext ?? {}),
          sourceType: "answer",
          conversationId: askActiveContext?.conversationId,
          activeBookId: bookId,
          titleHint: askQuestion.slice(0, 90),
        };

    setArticleBookId(bookId);
    setArticlePrompt(prompt);
    setArticleDraftContext(context);
    setArticleCurrentDraft(null);
    setArticleCurrentVersion(null);
    setArticleMessage(t.articlePrepared);
    setWorkspaceTab("articles");
    window.requestAnimationFrame(() => {
      document.getElementById("library")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function writeArticleFromReaderSelection() {
    const prompt = readerSelection
      ? `${t.articleFromPassagePrompt}\n\n${readerSelection.text}`
      : t.articlePromptPlaceholder;
    setArticleBookId(readerBookId);
    setArticlePrompt(prompt);
    setArticleCurrentDraft(null);
    setArticleCurrentVersion(null);
    setArticleMessage(t.articlePrepared);
    setWorkspaceTab("articles");
    window.requestAnimationFrame(() => {
      document.getElementById("library")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    setArticleDraftContext({
      sourceType: "selection",
      activeBookId: readerBookId,
      titleHint: t.articleSelectionTitleHint,
    });
  }

  function writeArticleFromSectionMap(artifact: BookArtifact) {
    const sectionList = artifact.sections
      .map((section) => `${section.sectionNumber}. ${section.title}: ${section.summary}`)
      .join("\n");
    const prompt = `${t.articleFromMapPrompt}\n\n${artifact.title}\n${sectionList}`.slice(0, 1800);
    const context: ArticleContext = {
      sourceType: "section_map",
      activeBookId: artifact.bookId,
      activeArtifactId: artifact.id,
      titleHint: artifact.title,
    };
    setArticleBookId(artifact.bookId);
    setArticlePrompt(prompt);
    setArticleCurrentDraft(null);
    setArticleCurrentVersion(null);
    setArticleMessage(t.articlePrepared);
    setWorkspaceTab("articles");
    window.requestAnimationFrame(() => {
      document.getElementById("library")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    setArticleDraftContext(context);
  }

  function renderSuggestionChips(
    title: string,
    suggestions: SuggestionChip[],
    action: SuggestionAction = "fill"
  ) {
    const visibleSuggestions = suggestions
      .filter((suggestion) => !usedSuggestionQuestions.includes(suggestion.question))
      .slice(0, action === "ask" ? 3 : 4);

    if (visibleSuggestions.length === 0) {
      return null;
    }

    return (
      <div className="suggestion-panel">
        <strong>{title}</strong>
        <div className="suggestion-chips">
          {visibleSuggestions.map((suggestion) => (
            <button
              className="suggestion-chip"
              type="button"
              key={`${suggestion.bookId || "library"}-${suggestion.question}`}
              disabled={askBusy}
              onClick={() =>
                action === "ask" ? askSuggestion(suggestion) : useSuggestion(suggestion)
              }
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  async function deleteLibraryBook(book: BookRecord) {
    setDeleteBusyId(book.id);
    setBookDeleteProgress((current) => ({
      ...current,
      [book.id]: {
        label: book.displayTitle,
        progress: 8,
      },
    }));
    setConfirmDeleteBookId("");
    setUploadMessage("");
    const progressTimer = window.setInterval(() => {
      setBookDeleteProgress((current) => {
        const entry = current[book.id];
        if (!entry) {
          return current;
        }

        return {
          ...current,
          [book.id]: {
            ...entry,
            progress: Math.min(92, entry.progress + (entry.progress < 50 ? 14 : 6)),
          },
        };
      });
    }, 650);

    try {
      const deleteBook = httpsCallable<{ bookId: string }, { ok: boolean; status?: string }>(
        functions,
        "deleteBook"
      );
      await deleteBook(withSession({ bookId: book.id }));
      if (selectedBookScope === book.id) {
        setSelectedBookScope("");
      }
      setBookDeleteProgress((current) => ({
        ...current,
        [book.id]: {
          label: current[book.id]?.label || book.displayTitle,
          progress: 96,
        },
      }));
      setUploadMessage(t.deleteStarted);
    } catch (error) {
      setUploadMessage(getErrorMessage(error, "Delete failed"));
    } finally {
      window.clearInterval(progressTimer);
      setDeleteBusyId("");
    }
  }

  async function deleteRecentQuestion(conversationId: string) {
    setDeleteConversationBusyId(conversationId);
    setAskMessage("");

    try {
      const deleteConversation = httpsCallable<
        { conversationId: string },
        { ok: boolean }
      >(functions, "deleteConversation");
      await deleteConversation(withSession({ conversationId }));
      setAskMessage(t.questionDeleted);
    } catch (error) {
      setAskMessage(getErrorMessage(error, "Delete failed"));
    } finally {
      setDeleteConversationBusyId("");
    }
  }

  async function deleteAllHistory() {
    setDeleteAllHistoryBusy(true);
    setAskMessage("");

    try {
      const deleteAllConversations = httpsCallable<
        { confirmation: string },
        { ok: boolean }
      >(functions, "deleteAllConversations");
      await deleteAllConversations(withSession({ confirmation: deleteAllHistoryText }));
      setDeleteAllHistoryConfirmOpen(false);
      setDeleteAllHistoryText("");
      setConversationDetail(null);
      setAskMessage(t.historyDeleted);
    } catch (error) {
      setAskMessage(getErrorMessage(error, "Delete failed"));
    } finally {
      setDeleteAllHistoryBusy(false);
    }
  }

  async function openBookDetail(book: BookRecord) {
    setSelectedBookDetailId(book.id);
    setBookDetailMessage("");
    setBookChunkPreviews([]);
    setBookArtifacts([]);
    setSectionMapTargetCount(6);

    try {
      const getBookDetail = httpsCallable<
        { bookId: string },
        { ok: boolean; chunks: BookChunkPreview[] }
      >(functions, "getBookDetail");
      const response = await getBookDetail(withSession({ bookId: book.id }));
      setBookChunkPreviews(
        (response.data.chunks ?? [])
          .sort((left, right) => left.chunkIndex - right.chunkIndex)
          .slice(0, 12)
      );
      await loadBookArtifacts(book.id);
      window.requestAnimationFrame(() => {
        bookDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (error) {
      setBookDetailMessage(getErrorMessage(error, "Book detail failed"));
    }
  }

  async function loadBookArtifacts(bookId: string) {
    const listBookArtifacts = httpsCallable<
      { bookId: string; sessionId: string },
      { ok: boolean; artifacts: BookArtifact[] }
    >(functions, "listBookArtifacts");
    const response = await listBookArtifacts(withSession({ bookId }));
    setBookArtifacts(response.data.artifacts ?? []);
  }

  async function generateSectionMap(book: BookRecord) {
    if (!requireVerifiedUi(setBookDetailMessage)) {
      return;
    }

    setSectionMapBusy(true);
    setBookDetailMessage("");

    try {
      const generateBookSectionMap = httpsCallable<
        { bookId: string; targetSectionCount: number; sessionId: string },
        { ok: boolean; artifact: BookArtifact }
      >(functions, "generateBookSectionMap");
      await generateBookSectionMap(withSession({
        bookId: book.id,
        targetSectionCount: sectionMapTargetCount,
      }));
      await loadBookArtifacts(book.id);
      setBookDetailMessage("Section map created.");
    } catch (error) {
      setBookDetailMessage(getErrorMessage(error, "Section map failed"));
    } finally {
      setSectionMapBusy(false);
    }
  }

  async function deleteSectionMap(artifact: BookArtifact) {
    if (!requireVerifiedUi(setBookDetailMessage)) {
      return;
    }

    setBookDetailMessage("");
    try {
      const deleteBookArtifact = httpsCallable<
        { artifactId: string; sessionId: string },
        { ok: boolean; artifactId: string }
      >(functions, "deleteBookArtifact");
      await deleteBookArtifact(withSession({ artifactId: artifact.id }));
      await loadBookArtifacts(artifact.bookId);
      setBookDetailMessage("Section map deleted.");
    } catch (error) {
      setBookDetailMessage(getErrorMessage(error, "Delete map failed"));
    }
  }

  function askThisBook(book: BookRecord) {
    setSelectedBookScope(book.id);
    setWorkspaceTab("ask");
    window.requestAnimationFrame(() => {
      document.getElementById("library")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function openBookReader(book: BookRecord, page = -1) {
    const progressKey = user
      ? `readwisehub_reader_progress_${user.uid}_${book.id}`
      : "";
    const bookmarkKey = user
      ? `readwisehub_reader_bookmarks_${user.uid}_${book.id}`
      : "";
    const legacyBookmarkKey = user
      ? `readwisehub_reader_bookmark_${user.uid}_${book.id}`
      : "";
    const localSavedPage = progressKey
      ? Number(window.localStorage.getItem(progressKey))
      : 0;
    const localBookmarks = bookmarkKey
      ? parseReaderBookmarks(window.localStorage.getItem(bookmarkKey))
      : [];
    const legacyBookmark = legacyBookmarkKey
      ? Number(window.localStorage.getItem(legacyBookmarkKey))
      : Number.NaN;
    const localLegacyBookmarks =
      localBookmarks.length > 0 || !Number.isFinite(legacyBookmark)
        ? localBookmarks
        : [{
            page: legacyBookmark,
            label: `${t.page} ${legacyBookmark + 1}`,
            snippet: "",
            createdAt: Date.now(),
          }];
    const localHighlights = readerHighlightKey
      ? parseReaderHighlights(window.localStorage.getItem(readerHighlightKey))
      : {};
    let savedPage = Number.isFinite(localSavedPage) ? localSavedPage : 0;
    let bookmarks = localLegacyBookmarks;
    let highlights = localHighlights;

    if (user) {
      try {
        const settingsSnapshot = await getDoc(
          doc(db, "users", user.uid, "readerSettings", book.id)
        );
        if (settingsSnapshot.exists()) {
          const data = settingsSnapshot.data();
          savedPage =
            typeof data.lastPage === "number" ? data.lastPage : savedPage;
          bookmarks = parseReaderBookmarksValue(data.bookmarks);
          highlights = parseReaderHighlightsValue(data.highlights);
        }
      } catch (error) {
        setReaderMessage(getErrorMessage(error, "Reader settings sync failed"));
      }
    }

    const targetPage = page >= 0 ? page : savedPage;
    const nextReaderMode =
      page < 0 && book.preferredReaderMode === "original" && book.originalPageView
        ? "original"
        : readerMode;

    setReaderBookId(book.id);
    setReaderPage(targetPage);
    setReaderMode(nextReaderMode);
    setReaderBookmarks(bookmarks);
    setReaderHighlights(highlights);
    setReaderBookmarkMenuOpen(false);
    setReaderBookPickerOpen(false);
    setReaderBusy(true);
    setReaderMessage("");
    setReaderChunks([]);
    setReaderActivePageSize(readerPageSize);
    setReaderOriginalPage(null);
    setReaderOriginalPageUrl("");
    setReaderInlineMedia([]);
    setReaderInlineMediaUrls({});
    setReaderSelection(null);
    setReaderAskAnswer("");
    setReaderAskMode("");
    setReaderAskSources([]);
    setReaderAskQuestion("");
    setReaderReturnParagraphId("");
    setReaderBookmarkMessage("");
    setWorkspaceTab("read");
    void loadBookArtifacts(book.id).catch(() => undefined);

    try {
      const getBookReader = httpsCallable<
        { bookId: string; page: number; pageSize: number; mode?: ReaderMode },
        {
          ok: boolean;
          chunks: ReaderChunk[];
          inlineMedia: ReaderInlineMedia[];
          totalChunks: number;
          pageSize: number;
          originalPage: ReaderOriginalPage | null;
          totalPageImages: number;
        }
      >(functions, "getBookReader");
      const response = await getBookReader(withSession({
        bookId: book.id,
        page: targetPage,
        pageSize: readerPageSize,
        mode: nextReaderMode,
      }));
      setReaderChunks(response.data.chunks ?? []);
      setReaderInlineMedia(response.data.inlineMedia ?? []);
      setReaderTotalChunks(response.data.totalChunks ?? 0);
      setReaderActivePageSize(response.data.pageSize || readerPageSize);
      setReaderOriginalPage(response.data.originalPage ?? null);
      setReaderOriginalPageCount(response.data.totalPageImages ?? 0);
      if (progressKey) {
        window.localStorage.setItem(progressKey, String(targetPage));
      }
      await saveReaderSettings(book.id, {
        lastPage: targetPage,
        bookmarks,
        highlights,
      });
    } catch (error) {
      setReaderMessage(getErrorMessage(error, "Reader failed"));
    } finally {
      setReaderBusy(false);
    }
  }

  function turnReaderPage(direction: -1 | 1) {
    if (!readerBook) {
      return;
    }

    const nextPage = readerPage + direction;
    const maxPage =
      readerMode === "original" && readerOriginalPageCount > 0
        ? readerOriginalPageCount
        : Math.ceil(readerTotalChunks / readerEffectivePageSize);
    if (nextPage < 0 || nextPage >= maxPage) {
      return;
    }

    void openBookReader(readerBook, nextPage);
  }

  function startReaderSwipe(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1 || readerSelection || readerAskBusy) {
      readerTouchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    readerTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  }

  function finishReaderSwipe(event: TouchEvent<HTMLDivElement>) {
    const start = readerTouchStartRef.current;
    readerTouchStartRef.current = null;
    if (!start || !readerBook || readerSelection || readerAskBusy) {
      captureReaderSelectionSoon();
      return;
    }

    const touch = event.changedTouches[0];
    if (!touch) {
      captureReaderSelectionSoon();
      return;
    }

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const elapsed = Date.now() - start.time;
    const horizontal = Math.abs(dx);
    const vertical = Math.abs(dy);

    if (elapsed < 700 && horizontal > 70 && horizontal > vertical * 1.4) {
      turnReaderPage(dx < 0 ? 1 : -1);
      window.getSelection()?.removeAllRanges();
      return;
    }

    captureReaderSelectionSoon();
  }

  function bookmarkReaderPage() {
    if (!readerBookmarkKey) {
      return;
    }

    const existingBookmark = readerBookmarks.find(
      (bookmark) => bookmark.page === readerPage
    );
    const nextBookmarks = existingBookmark
      ? readerBookmarks.filter((bookmark) => bookmark.page !== readerPage)
      : [
          ...readerBookmarks,
          {
            page: readerPage,
            label: `${t.page} ${readerPage + 1}`,
            snippet: getReaderBookmarkSnippet(),
            createdAt: Date.now(),
          },
        ].sort((left, right) => left.page - right.page);

    setReaderBookmarks(nextBookmarks);
    window.localStorage.setItem(readerBookmarkKey, JSON.stringify(nextBookmarks));
    void saveReaderSettings(readerBookId, {
      lastPage: readerPage,
      bookmarks: nextBookmarks,
      highlights: readerHighlights,
    });
    setReaderBookmarkMessage(
      existingBookmark
        ? `${t.bookmarkRemoved}: ${t.page} ${readerPage + 1}`
        : `${t.bookmarkSaved}: ${t.page} ${readerPage + 1}`
    );
  }

  function parseReaderBookmarks(value: string | null): ReaderBookmark[] {
    if (!value) {
      return [];
    }

    try {
      return parseReaderBookmarksValue(JSON.parse(value));
    } catch {
      return [];
    }
  }

  function parseReaderBookmarksValue(value: unknown): ReaderBookmark[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((bookmark) => typeof bookmark?.page === "number")
      .map((bookmark) => ({
        page: Math.max(0, Math.floor(bookmark.page)),
        label: typeof bookmark.label === "string"
          ? bookmark.label.slice(0, 80)
          : `${t.page} ${Math.max(0, Math.floor(bookmark.page)) + 1}`,
        snippet: typeof bookmark.snippet === "string" ? bookmark.snippet.slice(0, 180) : "",
        createdAt:
          typeof bookmark.createdAt === "number" ? bookmark.createdAt : Date.now(),
      }))
      .sort((left, right) => left.page - right.page);
  }

  function parseReaderHighlights(value: string | null) {
    if (!value) {
      return {};
    }

    try {
      return parseReaderHighlightsValue(JSON.parse(value));
    } catch {
      return {};
    }
  }

  function parseReaderHighlightsValue(value: unknown): Record<string, ReaderHighlight> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key.length <= 120)
        .map(([key, highlight]) => {
          if (typeof highlight === "string") {
            return [
              key,
              {
                id: key,
                text: highlight.slice(0, 2000),
                page: 0,
                paragraphId: key.split("-").slice(0, 2).join("-"),
                createdAt: Date.now(),
              },
            ] as const;
          }
          if (!highlight || typeof highlight !== "object") {
            return null;
          }
          const record = highlight as Record<string, unknown>;
          const text = typeof record.text === "string" ? record.text.slice(0, 2000) : "";
          if (!text) {
            return null;
          }
          return [
            key,
            {
              id: typeof record.id === "string" ? record.id : key,
              text,
              page: Math.max(0, Math.floor(Number(record.page) || 0)),
              paragraphId: typeof record.paragraphId === "string" ? record.paragraphId.slice(0, 120) : "",
              createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
            },
          ] as const;
        })
        .filter((entry): entry is readonly [string, ReaderHighlight] => entry !== null)
        .slice(0, 200)
    );
  }

  async function saveReaderSettings(
    bookId: string,
    settings: {
      lastPage?: number;
      bookmarks?: ReaderBookmark[];
      highlights?: Record<string, ReaderHighlight>;
    }
  ) {
    if (!user || !bookId) {
      return;
    }

    try {
      await setDoc(
        doc(db, "users", user.uid, "readerSettings", bookId),
        {
          userId: user.uid,
          bookId,
          ...("lastPage" in settings ? { lastPage: settings.lastPage } : {}),
          ...("bookmarks" in settings ? { bookmarks: settings.bookmarks ?? [] } : {}),
          ...("highlights" in settings ? { highlights: settings.highlights ?? {} } : {}),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      setReaderMessage(getErrorMessage(error, "Reader settings sync failed"));
    }
  }

  function getReaderBookmarkSnippet() {
    const text = readerParagraphs[0]?.text ?? "";
    return text.length > 110 ? `${text.slice(0, 107)}...` : text;
  }

  function openReaderBookmark(page: number) {
    if (!readerBook) {
      return;
    }

    setReaderBookmarkMenuOpen(false);
    void openBookReader(readerBook, page);
  }

  function deleteReaderBookmark(page: number) {
    if (!readerBookmarkKey) {
      return;
    }

    const nextBookmarks = readerBookmarks.filter((bookmark) => bookmark.page !== page);
    setReaderBookmarks(nextBookmarks);
    window.localStorage.setItem(readerBookmarkKey, JSON.stringify(nextBookmarks));
    void saveReaderSettings(readerBookId, {
      lastPage: readerPage,
      bookmarks: nextBookmarks,
      highlights: readerHighlights,
    });
    setReaderBookmarkMessage(`${t.bookmarkRemoved}: ${t.page} ${page + 1}`);
  }

  function openReaderHighlight(highlight: ReaderHighlight) {
    if (!readerBook) {
      return;
    }

    setReaderHighlightMenuOpen(false);
    setReaderReturnParagraphId(highlight.paragraphId);
    void openBookReader(readerBook, highlight.page);
  }

  function deleteReaderHighlight(highlightId: string) {
    if (!readerHighlightKey) {
      return;
    }

    const nextHighlights = { ...readerHighlights };
    delete nextHighlights[highlightId];
    setReaderHighlights(nextHighlights);
    window.localStorage.setItem(readerHighlightKey, JSON.stringify(nextHighlights));
    void saveReaderSettings(readerBookId, {
      lastPage: readerPage,
      bookmarks: readerBookmarks,
      highlights: nextHighlights,
    });
    setReaderBookmarkMessage(t.highlightRemoved);
  }

  function goToReaderPage(page: number) {
    if (!readerBook) {
      return;
    }

    const nextPage = Math.min(Math.max(0, page), activeReaderPageCount - 1);
    void openBookReader(readerBook, nextPage);
  }

  function returnToLibrary() {
    setWorkspaceTab("library");
    setReaderBookId("");
    setReaderChunks([]);
    setReaderMessage("");
    setReaderSelection(null);
    setReaderAskAnswer("");
    setReaderAskMode("");
    setReaderAskSources([]);
    setReaderAskQuestion("");
    setReaderReturnParagraphId("");
    setReaderBookmarkMessage("");
    setReaderBookmarks([]);
    setReaderOriginalPage(null);
    setReaderOriginalPageCount(0);
    setReaderOriginalPageUrl("");
    setReaderInlineMedia([]);
    setReaderInlineMediaUrls({});
    setReaderMode("text");
    setReaderBookmarkMenuOpen(false);
    setReaderBookPickerOpen(false);
    setReaderScrollNavVisible(false);
  }

  function chooseAnotherReaderBook() {
    setReaderMessage("");
    setReaderSelection(null);
    setReaderBookmarkMessage("");
    setReaderBookmarkMenuOpen(false);
    setReaderBookPickerOpen((open) => !open);
  }

  function scrollReaderPage(direction: -1 | 1) {
    window.scrollBy({
      top: direction * Math.max(320, window.innerHeight * 0.72),
      behavior: "smooth",
    });
  }

  function scrollReaderBoundary(direction: -1 | 1) {
    if (direction < 0) {
      bookPageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "smooth",
    });
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  async function handleSignOut() {
    if (signingOut) {
      return;
    }

    signingOutRef.current = true;
    setSigningOut(true);
    setAuthError("");
    setStatus("");
    closeMenu();
    try {
      await signOut(auth);
      setUser(null);
      setAdminAccess(false);
    } catch (error) {
      signingOutRef.current = false;
      setAuthError(getErrorMessage(error, "Sign out failed"));
    } finally {
      setSigningOut(false);
    }
  }

  async function registerCurrentSession() {
    if (!auth.currentUser) {
      return;
    }

    const registerLoginSession = httpsCallable<
      {
        sessionId: string;
        browser: string;
        os: string;
        device: string;
        userAgent: string;
      },
      { ok: boolean; status: string; activeSessionLimit: number }
    >(functions, "registerLoginSession");
    const response = await registerLoginSession({
      sessionId: getSessionId(),
      ...getDeviceInfo(),
    });

    if (!response.data.ok) {
      setAuthError(t.sessionLimitReached);
      await handleSignOut();
    }
  }

  async function loadAccountSecurity() {
    if (!auth.currentUser) {
      setAccountSessions([]);
      return;
    }

    try {
      const getAccountSecurity = httpsCallable<
        unknown,
        { ok: boolean; activeSessionLimit: number; sessions: AccountSession[] }
      >(functions, "getAccountSecurity");
      const response = await getAccountSecurity(withSession({}));
      setAccountSessions(response.data.sessions ?? []);
      setSecurityMessage("");
    } catch (error) {
      setSecurityMessage(getErrorMessage(error, "Security data failed"));
    }
  }

  async function startStripeCheckout(plan: "plus" | "pro" | "ultimate") {
    if (!requireVerifiedUi(setBillingMessage)) {
      return;
    }

    setBillingBusy(plan);
    setBillingMessage("");

    try {
      const createCheckout = httpsCallable<
        { plan: "plus" | "pro" | "ultimate"; sessionId: string },
        { ok: boolean; url: string }
      >(functions, "createStripeCheckoutSession");
      const response = await createCheckout(withSession({ plan }));
      window.location.assign(response.data.url);
    } catch (error) {
      setBillingMessage(getErrorMessage(error, t.billingCheckoutFailed));
    } finally {
      setBillingBusy("");
    }
  }

  async function openStripePortal() {
    if (!requireVerifiedUi(setBillingMessage)) {
      return;
    }

    setBillingBusy("portal");
    setBillingMessage("");

    try {
      const createPortal = httpsCallable<
        { sessionId: string },
        { ok: boolean; url: string }
      >(functions, "createStripePortalSession");
      const response = await createPortal(withSession({}));
      window.location.assign(response.data.url);
    } catch (error) {
      setBillingMessage(getErrorMessage(error, t.billingPortalFailed));
    } finally {
      setBillingBusy("");
    }
  }

  function renderBillingActions() {
    if (hasOpenStripeSubscription) {
      return (
        <>
          <button
            className="button primary compact"
            type="button"
            disabled={Boolean(billingBusy)}
            onClick={() => void openStripePortal()}
          >
            {billingBusy === "portal" ? t.loading : t.billingChangePlan}
          </button>
          <p className="small-note billing-action-note">{t.billingPortalCopy}</p>
        </>
      );
    }

    return (
      <>
        <button
          className="button secondary compact"
          type="button"
          disabled={Boolean(billingBusy) || usage.plan === "plus"}
          onClick={() => void startStripeCheckout("plus")}
        >
          {billingBusy === "plus" ? t.loading : t.billingUpgradePlus}
        </button>
        <button
          className="button secondary compact"
          type="button"
          disabled={Boolean(billingBusy) || usage.plan === "pro"}
          onClick={() => void startStripeCheckout("pro")}
        >
          {billingBusy === "pro" ? t.loading : t.billingUpgradePro}
        </button>
        <button
          className="button secondary compact"
          type="button"
          disabled={Boolean(billingBusy) || usage.plan === "ultimate"}
          onClick={() => void startStripeCheckout("ultimate")}
        >
          {billingBusy === "ultimate" ? t.loading : t.billingUpgradeUltimate}
        </button>
      </>
    );
  }

  async function saveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.currentUser) {
      return;
    }

    const nextName = profileDisplayName.replace(/\s+/g, " ").trim();
    if (nextName.length < 2 || nextName.length > 40 || !/^[\p{Letter}\p{Number} _-]+$/u.test(nextName)) {
      setProfileMessage(t.profileNameInvalid);
      return;
    }

    setAccountBusy(true);
    setProfileMessage("");

    try {
      await updateProfile(auth.currentUser, { displayName: nextName });
      await setDoc(
        doc(db, "users", auth.currentUser.uid),
        {
          displayName: nextName,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setUser(auth.currentUser);
      setProfileMessage(t.profileSaved);
    } catch (error) {
      setProfileMessage(getErrorMessage(error, "Profile update failed"));
    } finally {
      setAccountBusy(false);
    }
  }

  async function sendPasswordChangeEmail() {
    if (!auth.currentUser?.email) {
      return;
    }

    setAccountBusy(true);
    setAuthError("");
    setProfileMessage("");

    try {
      auth.languageCode = locale;
      await sendPasswordResetEmail(auth, auth.currentUser.email, {
        url: AUTH_ACTION_URL,
      });
      setProfileMessage(t.passwordChangeEmailSent);
    } catch (error) {
      setProfileMessage(getErrorMessage(error, t.passwordChangeEmailFailed));
    } finally {
      setAccountBusy(false);
    }
  }

  async function changeAccountPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.currentUser?.email) {
      return;
    }

    if (passwordChangeNew.length < 8) {
      setProfileMessage(t.passwordChangeTooShort);
      return;
    }

    if (passwordChangeNew !== passwordChangeRepeat) {
      setProfileMessage(t.passwordChangeMismatch);
      return;
    }

    setAccountBusy(true);
    setAuthError("");
    setProfileMessage("");

    try {
      await reauthenticateWithCredential(
        auth.currentUser,
        EmailAuthProvider.credential(auth.currentUser.email, passwordChangeCurrent)
      );
      await updatePassword(auth.currentUser, passwordChangeNew);
      await auth.currentUser.getIdToken(true);
      setPasswordChangeCurrent("");
      setPasswordChangeNew("");
      setPasswordChangeRepeat("");
      setProfileMessage(t.passwordChangeSaved);
    } catch (error) {
      setProfileMessage(getErrorMessage(error, t.passwordChangeFailed));
    } finally {
      setAccountBusy(false);
    }
  }

  async function requestAccountEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.currentUser) {
      return;
    }

    const nextEmail = accountEmailChange.trim();
    if (!nextEmail || nextEmail === auth.currentUser.email) {
      setProfileMessage(t.emailChangeInvalid);
      return;
    }

    setAccountBusy(true);
    setAuthError("");
    setProfileMessage("");

    try {
      const hasPasswordProvider = auth.currentUser.providerData.some(
        (provider) => provider.providerId === "password"
      );
      const hasGoogleProvider = auth.currentUser.providerData.some(
        (provider) => provider.providerId === "google.com"
      );

      if (hasPasswordProvider) {
        if (!auth.currentUser.email || !accountEmailChangePassword) {
          setProfileMessage(t.emailChangePasswordRequired);
          return;
        }

        await reauthenticateWithCredential(
          auth.currentUser,
          EmailAuthProvider.credential(auth.currentUser.email, accountEmailChangePassword)
        );
      } else if (hasGoogleProvider) {
        await reauthenticateWithPopup(auth.currentUser, googleProvider);
      } else {
        setProfileMessage(t.emailChangeReauthUnsupported);
        return;
      }

      await auth.currentUser.getIdToken(true);
      auth.languageCode = locale;
      await verifyBeforeUpdateEmail(auth.currentUser, nextEmail, getEmailActionSettings());
      setAccountEmailChange("");
      setAccountEmailChangePassword("");
      setProfileMessage(t.emailChangeVerificationSent);
    } catch (error) {
      setProfileMessage(getErrorMessage(error, t.emailChangeFailed));
    } finally {
      setAccountBusy(false);
    }
  }

  function openMenuTab(tab: WorkspaceTab) {
    setWorkspaceTab(tab);
    closeMenu();
  }

  function captureReaderSelection() {
    if (readerMode === "original") {
      setReaderSelection(null);
      return;
    }

    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";

    if (!selection || !text || text.length < 2 || !bookPageRef.current) {
      setReaderSelection(null);
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      !anchorNode ||
      !focusNode ||
      !bookPageRef.current.contains(anchorNode) ||
      !bookPageRef.current.contains(focusNode)
    ) {
      setReaderSelection(null);
      return;
    }

    const paragraph = readerParagraphs.find((candidate) =>
      candidate.text.toLowerCase().includes(text.toLowerCase())
    );
    if (!paragraph) {
      setReaderSelection(null);
      return;
    }

    setReaderSelection({
      text,
      paragraphId: paragraph.id,
    });
  }

  function captureReaderSelectionSoon() {
    window.setTimeout(captureReaderSelection, 120);
  }

  function highlightReaderSelection() {
    if (!readerHighlightKey || !readerSelection) {
      return;
    }

    const nextHighlights = { ...readerHighlights };
    const id = `${readerSelection.paragraphId}-${Date.now()}`;
    nextHighlights[id] = {
      id,
      text: readerSelection.text,
      page: readerPage,
      paragraphId: readerSelection.paragraphId,
      createdAt: Date.now(),
    };

    setReaderHighlights(nextHighlights);
    window.localStorage.setItem(readerHighlightKey, JSON.stringify(nextHighlights));
    void saveReaderSettings(readerBookId, {
      lastPage: readerPage,
      bookmarks: readerBookmarks,
      highlights: nextHighlights,
    });
    setReaderSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  async function askReaderSelectionInline() {
    if (!readerBook || !readerSelection) {
      return;
    }
    if (!requireVerifiedUi(setReaderMessage)) {
      return;
    }

    const question = `${t.askAboutPassagePrompt}\n\n"${readerSelection.text}"`;
    setReaderAskBusy(true);
    setReaderAskAnswer("");
    setReaderAskMode("");
    setReaderAskSources([]);
    setReaderAskProgress(10);
    setReaderAskQuestion(readerSelection.text);
    setReaderReturnParagraphId(readerSelection.paragraphId);
    setReaderReturnScrollY(window.scrollY);
    setReaderMessage("");

    window.requestAnimationFrame(() => {
      readerAnswerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const progressTimer = window.setInterval(() => {
      setReaderAskProgress((progress) => Math.min(90, progress + (progress < 45 ? 12 : 7)));
    }, 700);

    try {
      const askLibrary = httpsCallable<
        { query: string; locale: Locale; bookId?: string },
        AskLibraryResponse
      >(functions, "askLibrary");
      const response = await askLibrary(withSession({
        query: question,
        locale,
        bookId: readerBook.id,
      }));
      setReaderAskAnswer(response.data.answer);
      setReaderAskMode(response.data.mode);
      setReaderAskSources(response.data.results ?? []);
      setReaderAskProgress(100);
      setReaderSelection(null);
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      setReaderMessage(getErrorMessage(error, "Ask failed"));
    } finally {
      window.clearInterval(progressTimer);
      setReaderAskBusy(false);
    }
  }

  function closeReaderAnswerAndReturn() {
    const paragraphId = readerReturnParagraphId;
    const scrollY = readerReturnScrollY;
    setReaderAskAnswer("");
    setReaderAskMode("");
    setReaderAskSources([]);
    setReaderAskQuestion("");
    setReaderReturnParagraphId("");
    setReaderReturnScrollY(null);

    window.requestAnimationFrame(() => {
      if (typeof scrollY === "number") {
        window.scrollTo({ top: scrollY, behavior: "smooth" });
        return;
      }

      if (paragraphId) {
        document
          .getElementById(`reader-passage-${paragraphId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  async function openConversationDetail(conversationId: string) {
    setConversationDetailBusyId(conversationId);
    setAskMessage("");

    try {
      const getConversationDetail = httpsCallable<
        { conversationId: string },
        { ok: boolean; conversation: { id: string; title: string; mode: string }; messages: ConversationMessage[] }
      >(functions, "getConversationDetail");
      const response = await getConversationDetail(withSession({ conversationId }));
      setConversationDetail({
        id: response.data.conversation.id,
        title: response.data.conversation.title,
        mode: response.data.conversation.mode,
        messages: response.data.messages ?? [],
      });
      window.requestAnimationFrame(() => {
        conversationDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (error) {
      setAskMessage(getErrorMessage(error, "Question detail failed"));
    } finally {
      setConversationDetailBusyId("");
    }
  }

  async function exportMyData() {
    setAccountBusy(true);
    setAuthError("");

    try {
      const exportAccountData = httpsCallable<unknown, Record<string, unknown>>(
        functions,
        "exportAccountData"
      );
      const response = await exportAccountData(withSession({}));
      const blob = new Blob([JSON.stringify(response.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `readwisehub-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setAuthError(getErrorMessage(error, "Export failed"));
    } finally {
      setAccountBusy(false);
    }
  }

  async function deleteMyAccountData() {
    if (!auth.currentUser) {
      return;
    }

    setAccountBusy(true);
    setAuthError("");
    let deletionStarted = false;

    try {
      if (hasOpenStripeSubscription) {
        setAuthError(t.deleteAccountSubscriptionCopy);
        return;
      }

      const hasPasswordProvider = auth.currentUser.providerData.some(
        (provider) => provider.providerId === "password"
      );
      const hasGoogleProvider = auth.currentUser.providerData.some(
        (provider) => provider.providerId === "google.com"
      );

      if (hasPasswordProvider) {
        if (!auth.currentUser.email || !deleteAccountPassword) {
          setAuthError(t.deleteAccountPasswordRequired);
          return;
        }

        await reauthenticateWithCredential(
          auth.currentUser,
          EmailAuthProvider.credential(auth.currentUser.email, deleteAccountPassword)
        );
      } else if (hasGoogleProvider) {
        await reauthenticateWithPopup(auth.currentUser, googleProvider);
      } else {
        setAuthError(t.deleteAccountReauthUnsupported);
        return;
      }

      await auth.currentUser.getIdToken(true);
      const deleteAccountData = httpsCallable<unknown, { ok: boolean }>(
        functions,
        "deleteAccountData"
      );
      await deleteAccountData(withSession({ confirmationPhrase: deleteConfirmationText }));
      deletionStarted = true;
      signingOutRef.current = true;
      await signOut(auth).catch(() => undefined);
    } catch (error) {
      setAuthError(getErrorMessage(error, "Account delete failed"));
    } finally {
      setAccountBusy(false);
      if (deletionStarted) {
        setConfirmDeleteAccount(false);
        setDeleteConfirmationText("");
        setDeleteAccountPassword("");
      }
    }
  }

  function formatAdminJson(value: unknown) {
    return JSON.stringify(value ?? null, null, 2);
  }

  function renderAdminUserCell(user: {
    userId: string;
    userLabel?: string;
    userEmail?: string;
    userDisplayName?: string;
  }) {
    return (
      <>
        <strong>{user.userLabel || user.userEmail || user.userDisplayName || user.userId}</strong>
        <small>{user.userId}</small>
      </>
    );
  }

  function matchesAdminSearch(values: Array<string | undefined>) {
    const needle = adminSearch.trim().toLowerCase();
    if (!needle) {
      return true;
    }

    return values.some((value) => (value || "").toLowerCase().includes(needle));
  }

  function getAdminDiagnosticValue(
    diagnostics: Record<string, unknown> | undefined,
    key: string
  ) {
    return diagnostics && key in diagnostics ? String(diagnostics[key] ?? "") : "";
  }

  function renderDiagnosticSummary(diagnostics: Record<string, unknown> | undefined) {
    if (!diagnostics) {
      return <p className="small-note">No retrieval diagnostics stored.</p>;
    }

    const rows = [
      ["Backend", getAdminDiagnosticValue(diagnostics, "backend") || "-"],
      ["Requested", getAdminDiagnosticValue(diagnostics, "requestedBackend") || "-"],
      ["Pinecone attempted", getAdminDiagnosticValue(diagnostics, "pineconeAttempted") || "false"],
      ["Pinecone enabled", getAdminDiagnosticValue(diagnostics, "pineconeEnabledForUser") || "false"],
      ["Fallback", getAdminDiagnosticValue(diagnostics, "fallbackReason") || "none"],
      ["Candidate chunks", getAdminDiagnosticValue(diagnostics, "candidateCount") || "0"],
      ["Results", getAdminDiagnosticValue(diagnostics, "resultCount") || "0"],
      ["Scoped book", getAdminDiagnosticValue(diagnostics, "scopedBookId") || "library"],
    ];

    return (
      <dl className="admin-diagnostic-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  const filteredAdminUsers = adminUsers.filter((userSummary) =>
    matchesAdminSearch([
      userSummary.userLabel,
      userSummary.email,
      userSummary.displayName,
      userSummary.userId,
      userSummary.plan,
    ])
  );
  const filteredAdminBooks = adminBooks.filter((book) => {
    const statusMatches =
      adminBookStatusFilter === "all" || book.status === adminBookStatusFilter;
    return (
      statusMatches &&
      matchesAdminSearch([
        book.displayTitle,
        book.title,
        book.userLabel,
        book.userEmail,
        book.userDisplayName,
        book.userId,
        book.status,
      ])
    );
  });
  const filteredAdminConversations = adminConversations.filter((conversation) => {
    const backend = getAdminDiagnosticValue(conversation.retrievalDiagnostics, "backend");
    const modeMatches =
      adminConversationModeFilter === "all" || conversation.mode === adminConversationModeFilter;
    const backendMatches =
      adminConversationBackendFilter === "all" || backend === adminConversationBackendFilter;

    return (
      modeMatches &&
      backendMatches &&
      matchesAdminSearch([
        conversation.title,
        conversation.latestQuestion,
        conversation.userLabel,
        conversation.userEmail,
        conversation.userDisplayName,
        conversation.userId,
        conversation.mode,
        backend,
      ])
    );
  });

  function openAdminRepairDialog(bookId: string) {
    setAdminRepairBookId(bookId);
    setAdminRepairProgress(0);
    setAdminRepairRunning(false);
    setAdminRepairMessage("");
    setAdminRepairError("");
  }

  function closeAdminRepairDialog() {
    if (adminRepairRunning) {
      return;
    }
    setAdminRepairBookId("");
    setAdminRepairProgress(0);
    setAdminRepairMessage("");
    setAdminRepairError("");
  }

  function renderAdminRepairDialog() {
    if (!adminRepairBookId) {
      return null;
    }

    const debugBookTitle =
      adminBookDebug && String(adminBookDebug.book.id || "") === adminRepairBookId
        ? String(adminBookDebug.book.displayTitle || adminBookDebug.book.title || "Selected PDF")
        : "";
    const listBookTitle =
      adminBooks.find((book) => book.id === adminRepairBookId)?.displayTitle || "";
    const repairBookTitle = debugBookTitle || listBookTitle || "Selected PDF";
    const canClose = !adminRepairRunning;

    return (
      <div className="modal-backdrop" role="presentation">
        <section
          className="modal-panel admin-repair-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-repair-modal-title"
        >
          <div className="modal-heading">
            <div>
              <p className="eyebrow">Admin repair</p>
              <h3 id="admin-repair-modal-title">Repair reader text and source TOC</h3>
            </div>
            <button
              className="button compact secondary"
              type="button"
              aria-label="Close"
              onClick={closeAdminRepairDialog}
              disabled={!canClose}
            >
              ×
            </button>
          </div>
          <p>
            <strong>{repairBookTitle}</strong>
          </p>
          <p>
            This reprocesses the PDF reader pages and source table of contents only. Chunks,
            vectors, conversations, highlights, and article drafts stay untouched.
          </p>
          {adminRepairRunning || adminRepairProgress > 0 ? (
            <div className="task-progress compact-progress" role="status" aria-live="polite">
              <div>
                <strong>{adminRepairMessage || "Repairing reader text..."}</strong>
                <span>{adminRepairProgress}%</span>
              </div>
              <progress value={adminRepairProgress} max="100" />
            </div>
          ) : null}
          {adminRepairError ? <p className="error-text">{adminRepairError}</p> : null}
          <div className="modal-actions">
            {adminRepairProgress === 100 && !adminRepairError ? (
              <button className="button primary" type="button" onClick={closeAdminRepairDialog}>
                Done
              </button>
            ) : (
              <>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void repairAdminBookReaderText(adminRepairBookId)}
                  disabled={adminRepairRunning || adminBusy}
                >
                  {adminRepairRunning ? "Repairing..." : "Start repair"}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={closeAdminRepairDialog}
                  disabled={!canClose}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderAdminConsole() {
    const counts = adminDashboard?.counts ?? {};

    return (
      <div className="app-shell admin-shell">
        <header className="site-header">
          <a className="brand" href="/" aria-label="ReadWiseHub app">
            <img className="brand-mark" src={readWiseHubIcon} alt="" aria-hidden="true" />
            <span>
              <strong>ReadWiseHub Admin</strong>
              <small>Read-only diagnostics</small>
            </span>
          </a>

          <div className="admin-header-actions">
            <button
              className="button header-button"
              type="button"
              onClick={() => void loadAdminConsole()}
              disabled={adminBusy}
            >
              {adminBusy ? "Refreshing..." : "Refresh"}
            </button>
            <a className="button header-button" href="/">
              Back to app
            </a>
            <button
              className="button header-button sign-out-button"
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
            >
              {signingOut ? t.loading : t.signOut}
            </button>
          </div>
        </header>

        <main className="admin-main">
          <section className="admin-hero">
            <div>
              <p className="eyebrow">Internal diagnostics</p>
              <h1>Admin console</h1>
              <p>
                Read-only operational view for retrieval, Pinecone coverage, route traces,
                and recent book Q&A regressions.
              </p>
            </div>
            {adminDashboard ? (
              <div className="admin-card">
                <h2>Viewer</h2>
                <p>{adminDashboard.viewer.email || adminDashboard.viewer.uid}</p>
              </div>
            ) : null}
          </section>

          {adminMessage ? <p className="status-message error">{adminMessage}</p> : null}

          <section className="admin-section admin-filter-panel">
            <div className="section-heading">
              <p className="eyebrow">Find records</p>
              <h2>Admin filters</h2>
            </div>
            <div className="admin-filter-grid">
              <label>
                Search
                <input
                  type="search"
                  value={adminSearch}
                  placeholder="Email, user, book, question"
                  onChange={(event) => setAdminSearch(event.target.value)}
                />
              </label>
              <label>
                Book status
                <select
                  value={adminBookStatusFilter}
                  onChange={(event) => setAdminBookStatusFilter(event.target.value)}
                >
                  <option value="all">All books</option>
                  <option value="text_ready">Text ready</option>
                  <option value="processing">Processing</option>
                  <option value="queued">Queued</option>
                  <option value="failed">Failed</option>
                  <option value="upload_reserved">Upload reserved</option>
                </select>
              </label>
              <label>
                Conversation mode
                <select
                  value={adminConversationModeFilter}
                  onChange={(event) => setAdminConversationModeFilter(event.target.value)}
                >
                  <option value="all">All modes</option>
                  <option value="ai_grounded">AI grounded</option>
                  <option value="source_draft">Source draft</option>
                </select>
              </label>
              <label>
                Retrieval backend
                <select
                  value={adminConversationBackendFilter}
                  onChange={(event) => setAdminConversationBackendFilter(event.target.value)}
                >
                  <option value="all">All backends</option>
                  <option value="firestore">Firestore</option>
                  <option value="pinecone">Pinecone</option>
                </select>
              </label>
            </div>
          </section>

          <section className="admin-section">
            <div className="section-heading">
              <p className="eyebrow">Security audit</p>
              <h2>Callable enforcement checklist</h2>
            </div>
            <div className="admin-audit-grid">
              {[
                ["Public profile/session", "Auth required; session registration does not require email verification."],
                ["Upload and ingestion", "Auth, verified email, ownership, file checks, and plan limits enforced server-side."],
                ["Book reading/details", "Auth and book ownership enforced; reader detail requires text-ready where needed."],
                ["AI ask/source lookup", "Auth, verified email, ownership/book scope, and message limit enforced server-side."],
                ["Delete/export account data", "Auth and ownership enforced; account deletion requires confirmation phrase."],
                ["Admin diagnostics", "Auth plus ADMIN_ALLOWED_UIDS; access is audit-logged."],
                ["Session/device enforcement", "User-facing authenticated callables require an active registered device session."],
                ["Open audit item", "Admin callables are UID-gated and audit-logged; add session checks there later if admin workflows need stricter device binding."],
              ].map(([title, body]) => (
                <article className="admin-card admin-audit-card" key={title}>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="admin-section">
            <div className="section-heading">
              <p className="eyebrow">Runtime</p>
              <h2>Dashboard</h2>
            </div>
            <div className="admin-grid">
              {[
                ["Users", counts.users],
                ["Books", counts.books],
                ["Text-ready books", counts.textReadyBooks],
                ["Failed books", counts.failedBooks],
                ["Conversations", counts.conversations],
                ["Queued jobs", counts.queuedIngestionJobs],
                ["Failed jobs", counts.failedIngestionJobs],
                ["Route traces", counts.routeTraces],
                ["Pinecone books", counts.pineconeBooks],
              ].map(([label, value]) => (
                <div className="admin-card admin-count-card" key={label}>
                  <span>{label}</span>
                  <strong>{typeof value === "number" ? value : "-"}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="admin-section">
            <div className="section-heading">
              <p className="eyebrow">Accounts</p>
              <h2>Users overview</h2>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table admin-users-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Plan</th>
                    <th>Verified</th>
                    <th>Usage</th>
                    <th>Activity</th>
                    <th>Sessions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAdminUsers.map((userSummary) => {
                    const usageCurrent = userSummary.usageCurrentPeriod ?? {};
                    const limits = userSummary.limits ?? {};
                    return (
                      <tr key={userSummary.userId}>
                        <td data-label="User">{renderAdminUserCell(userSummary)}</td>
                        <td data-label="Plan">
                          {userSummary.plan}
                          <small>{userSummary.subscriptionStatus}</small>
                        </td>
                        <td data-label="Verified">
                          {userSummary.emailVerified ? "yes" : "no"}
                          <small>{userSummary.onboardingStatus || "-"}</small>
                        </td>
                        <td data-label="Usage">
                          {String(usageCurrent.messages ?? 0)}/
                          {String(limits.monthlyMessages ?? "-")} messages
                          <small>
                            {String(usageCurrent.books ?? userSummary.bookCount)}/
                            {String(limits.maxBooks ?? "-")} books
                          </small>
                        </td>
                        <td data-label="Activity">
                          {userSummary.bookCount} books
                          <small>{userSummary.conversationCount} conversations</small>
                        </td>
                        <td data-label="Sessions">
                          {userSummary.activeSessionCount}
                          <small>{userSummary.lastLoginAt || "no login timestamp"}</small>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredAdminUsers.length === 0 ? (
                    <tr>
                      <td colSpan={6}>No users match the current filters.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-section">
            <div className="section-heading">
              <p className="eyebrow">Vector backend</p>
              <h2>Pinecone indexed books</h2>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table admin-pinecone-table">
                <thead>
                  <tr>
                    <th>Book</th>
                    <th>User</th>
                    <th>Indexed</th>
                    <th>Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {(adminDashboard?.pineconeBooks ?? []).map((book) => (
                    <tr key={book.bookId}>
                      <td data-label="Book">
                        <strong>{book.title}</strong>
                        <small>{book.bookId}</small>
                      </td>
                      <td data-label="User">{renderAdminUserCell(book)}</td>
                      <td data-label="Indexed">
                        <span
                          className={`vector-coverage-pill vector-${
                            book.indexedChunkCount > 0 && book.missingChunkCount === 0
                              ? "pinecone-ready"
                              : "pinecone-incomplete"
                          }`}
                        >
                          {book.indexedChunkCount > 0 && book.missingChunkCount === 0
                            ? "Ready"
                            : "Incomplete"}
                        </span>
                        <small>{book.indexedChunkCount} indexed</small>
                      </td>
                      <td data-label="Missing">{book.missingChunkCount}</td>
                    </tr>
                  ))}
                  {adminDashboard && adminDashboard.pineconeBooks.length === 0 ? (
                    <tr>
                      <td colSpan={4}>No Pinecone candidate books found.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-section">
            <div className="section-heading">
              <p className="eyebrow">Library operations</p>
              <h2>Books and ingestion metadata</h2>
            </div>
            <div className="admin-table-wrap" ref={adminBookResultsRef}>
              <table className="admin-table admin-books-table">
                <thead>
                  <tr>
                    <th>Book</th>
                    <th>User</th>
                    <th>Status</th>
                    <th>Structure</th>
                    <th>Chunks</th>
                    <th>Vectors</th>
                    <th>Debug</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAdminBooks.map((book) => (
                    <tr key={book.id}>
                      <td data-label="Book">
                        <strong>{book.displayTitle || book.title}</strong>
                        <small>
                          {book.id} · {book.contentType || "unknown"} ·{" "}
                          {Math.round(book.sizeBytes / 1024)} KB
                        </small>
                      </td>
                      <td data-label="User">{renderAdminUserCell(book)}</td>
                      <td data-label="Status">{book.status || "-"}</td>
                      <td data-label="Structure">
                        {book.structureQuality || "-"}
                        {book.formatWarning ? <small>{book.formatWarning}</small> : null}
                        {book.readerTextRepairStatus ? (
                          <small>Repair: {book.readerTextRepairStatus}</small>
                        ) : null}
                        {book.readerTextRepairError ? (
                          <small>{book.readerTextRepairError}</small>
                        ) : null}
                      </td>
                      <td data-label="Chunks">
                        {book.chunkCount}
                        <small>
                          {book.sectionCount} sections · {book.pageCount || "-"} pages
                        </small>
                      </td>
                      <td data-label="Vectors">
                        {(() => {
                          const vectorCoverage = getVectorCoverage(book);
                          return (
                            <>
                              <span className={`vector-coverage-pill vector-${vectorCoverage.status}`}>
                                {vectorCoverage.label}
                              </span>
                              <small>{vectorCoverage.detail || "No vector coverage yet"}</small>
                            </>
                          );
                        })()}
                      </td>
                      <td data-label="Debug">
                        <button
                          className="button secondary-button"
                          type="button"
                          onClick={() => void openAdminBook(book.id)}
                          disabled={adminBusy}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredAdminBooks.length === 0 ? (
                    <tr>
                      <td colSpan={7}>No books match the current filters.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {adminBookDebug ? (
            <section id="admin-book-debug" className="admin-section">
              <div className="section-heading">
                <p className="eyebrow">Book detail</p>
                <h2>Metadata, ingestion jobs, and structure previews</h2>
                <button
                  className="button secondary-button"
                  type="button"
                  onClick={() => {
                    const bookId = String(adminBookDebug.book.id || "");
                    if (bookId) {
                      openAdminRepairDialog(bookId);
                    }
                  }}
                  disabled={adminBusy || String(adminBookDebug.book.mimeType || "") !== "application/pdf"}
                >
                  Repair reader text
                </button>
              </div>
              <div className="admin-debug-grid">
                <article className="admin-card">
                  <h3>Book metadata</h3>
                  <pre className="admin-json">{formatAdminJson(adminBookDebug.book)}</pre>
                </article>
                <article className="admin-card">
                  <h3>Ingestion jobs</h3>
                  <pre className="admin-json">
                    {formatAdminJson(adminBookDebug.ingestionJobs)}
                  </pre>
                </article>
                <article className="admin-card">
                  <h3>Chunk previews</h3>
                  <pre className="admin-json">{formatAdminJson(adminBookDebug.chunks)}</pre>
                </article>
                <article className="admin-card">
                  <h3>Section previews</h3>
                  <pre className="admin-json">{formatAdminJson(adminBookDebug.sections)}</pre>
                </article>
                <article className="admin-card admin-debug-wide">
                  <h3>Generated artifacts</h3>
                  {adminBookDebug.artifacts?.length ? (
                    <div className="admin-artifact-list">
                      {adminBookDebug.artifacts.map((artifact) => (
                        <article key={artifact.id} className="admin-artifact-card">
                          <div className="admin-artifact-header">
                            <div>
                              <h4>{artifact.title || artifact.id}</h4>
                              <small>
                                {artifact.id} · {artifact.type || "artifact"} ·{" "}
                                {artifact.createdAt || "unknown date"}
                              </small>
                            </div>
                            <span
                              className={`admin-quality-badge quality-${artifact.mapQuality || "unknown"}`}
                            >
                              {artifact.mapQuality || "unknown"}
                            </span>
                          </div>
                          <dl className="admin-artifact-meta">
                            <div>
                              <dt>Status</dt>
                              <dd>{artifact.status || "-"}</dd>
                            </div>
                            <div>
                              <dt>Target</dt>
                              <dd>{artifact.targetSectionCount}</dd>
                            </div>
                            <div>
                              <dt>Sections</dt>
                              <dd>{artifact.sectionCount}</dd>
                            </div>
                            <div>
                              <dt>Source sections</dt>
                              <dd>{artifact.sourceSectionCount}</dd>
                            </div>
                            <div>
                              <dt>Weak titles</dt>
                              <dd>{artifact.weakTitleCount}</dd>
                            </div>
                            <div>
                              <dt>Generator</dt>
                              <dd>{artifact.generatedBy || "-"}</dd>
                            </div>
                          </dl>
                          <div className="admin-artifact-sections">
                            {artifact.sections.map((section) => (
                              <article key={`${artifact.id}-${section.sectionNumber}`}>
                                <strong>
                                  {section.sectionNumber}. {section.title}
                                </strong>
                                <small>
                                  source {section.sourceSectionStart + 1}-
                                  {section.sourceSectionEnd + 1}
                                  {section.pageStart || section.pageEnd
                                    ? ` · pages ${section.pageStart || "?"}-${section.pageEnd || "?"}`
                                    : ""}
                                </small>
                                <p>{section.summaryPreview}</p>
                              </article>
                            ))}
                          </div>
                          <details>
                            <summary>Raw artifact JSON</summary>
                            <pre className="admin-json">{formatAdminJson(artifact)}</pre>
                          </details>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="small-note">No generated artifacts found for this book.</p>
                  )}
                </article>
              </div>
            </section>
          ) : null}

          <section className="admin-section">
            <div className="section-heading">
              <p className="eyebrow">Vega-style trace review</p>
              <h2>Recent conversations</h2>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table admin-conversations-table">
                <thead>
                  <tr>
                    <th>Conversation</th>
                    <th>User</th>
                    <th>Mode</th>
                    <th>Retrieval</th>
                    <th>Sources</th>
                    <th>Debug</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAdminConversations.map((conversation) => {
                    const diagnostics = conversation.retrievalDiagnostics ?? {};
                    return (
                      <tr key={conversation.id}>
                        <td data-label="Conversation">
                          <strong>{conversation.title}</strong>
                          <small>{conversation.latestQuestion}</small>
                        </td>
                        <td data-label="User">{renderAdminUserCell(conversation)}</td>
                        <td data-label="Mode">{conversation.mode || "-"}</td>
                        <td data-label="Retrieval">
                          {String(diagnostics.backend ?? "-")}
                          {diagnostics.fallbackReason ? (
                            <small>{String(diagnostics.fallbackReason)}</small>
                          ) : null}
                        </td>
                        <td data-label="Sources">{conversation.sourceCount}</td>
                        <td data-label="Debug">
                          <button
                            className="button secondary-button"
                            type="button"
                            onClick={() => void openAdminConversation(conversation.id)}
                            disabled={adminBusy}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredAdminConversations.length === 0 ? (
                    <tr>
                      <td colSpan={6}>No conversations match the current filters.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {adminConversationDebug ? (
            <section id="admin-debug" className="admin-section">
              <div className="section-heading">
                <p className="eyebrow">Conversation detail</p>
                <h2>Route trace and messages</h2>
              </div>
              <div className="admin-debug-grid">
                <article className="admin-card">
                  <h3>Readable diagnostics</h3>
                  {renderDiagnosticSummary(
                    adminConversationDebug.conversation.retrievalDiagnostics as
                      | Record<string, unknown>
                      | undefined
                  )}
                </article>
                <article className="admin-card">
                  <h3>Conversation</h3>
                  <pre className="admin-json">
                    {formatAdminJson(adminConversationDebug.conversation)}
                  </pre>
                </article>
                <article className="admin-card">
                  <h3>Route trace</h3>
                  <pre className="admin-json">
                    {formatAdminJson(adminConversationDebug.routeTrace)}
                  </pre>
                </article>
                <article className="admin-card admin-debug-wide">
                  <h3>Messages</h3>
                  <pre className="admin-json">
                    {formatAdminJson(adminConversationDebug.messages)}
                  </pre>
                </article>
              </div>
            </section>
          ) : null}
          {renderAdminRepairDialog()}
        </main>
      </div>
    );
  }

  if (isKnownAuthAction) {
    const passwordLongEnough = resetActionPassword.length >= 8;
    const passwordsMatch =
      resetActionPassword.length > 0 &&
      resetActionPassword === resetActionConfirmPassword;
    const resetSubmitDisabled =
      resetActionBusy ||
      !resetActionChecked ||
      Boolean(resetActionError) ||
      resetActionComplete ||
      !passwordLongEnough ||
      !passwordsMatch;

    return (
      <div className="app-shell auth-action-page">
        <header className="site-header">
          <a className="brand" href="/" aria-label="ReadWiseHub home">
            <img className="brand-mark" src={readWiseHubIcon} alt="" aria-hidden="true" />
            <span>
              <strong>ReadWiseHub</strong>
              <small>{t.brandTagline}</small>
            </span>
          </a>
          <div className="public-header-actions">
            {languageToggle}
            {themeToggle}
          </div>
        </header>

        <main className="auth-action-main">
          <section className="auth-action-card">
            <p className="eyebrow">
              {isPasswordResetAction ? t.passwordResetEyebrow : t.emailVerificationEyebrow}
            </p>
            <h1>
              {isPasswordResetAction
                ? t.passwordResetTitle
                : isRecoverEmailAction
                  ? t.emailRecoveryActionTitle
                  : isVerifyAndChangeEmailAction
                    ? t.emailChangeActionTitle
                    : t.emailVerificationActionTitle}
            </h1>

            {isPasswordResetAction && !resetActionChecked ? <p>{t.loading}</p> : null}
            {isEmailApplyAction && !verifyActionChecked ? <p>{t.loading}</p> : null}

            {isPasswordResetAction && resetActionChecked && resetActionError ? (
              <div className="auth-status-card error-text">
                <h2>{t.passwordResetLinkProblemTitle}</h2>
                <p>{resetActionError}</p>
                <a className="button primary" href="/">
                  {t.backToSignIn}
                </a>
              </div>
            ) : null}

            {isEmailApplyAction && verifyActionChecked && verifyActionError ? (
              <div className="auth-status-card error-text">
                <h2>{t.emailVerificationLinkProblemTitle}</h2>
                <p>{verifyActionError}</p>
                <a className="button primary" href="/">
                  {t.backToSignIn}
                </a>
              </div>
            ) : null}

            {isEmailApplyAction && verifyActionComplete ? (
              <div className="auth-status-card success-text">
                <h2>
                  {isRecoverEmailAction
                    ? t.emailRecoveryCompleteTitle
                    : isVerifyAndChangeEmailAction
                      ? t.emailChangeCompleteTitle
                      : t.emailVerificationCompleteTitle}
                </h2>
                <p>
                  {isRecoverEmailAction
                    ? t.emailRecoveryCompleteCopy
                    : isVerifyAndChangeEmailAction
                      ? t.emailChangeCompleteCopy
                      : t.emailVerificationCompleteCopy}
                </p>
                <a className="button primary" href="/">
                  {t.backToSignIn}
                </a>
              </div>
            ) : null}

            {isPasswordResetAction && resetActionComplete ? (
              <div className="auth-status-card success-text">
                <h2>{t.passwordResetCompleteTitle}</h2>
                <p>{t.passwordResetCompleteCopy}</p>
                <a className="button primary" href="/">
                  {t.backToSignIn}
                </a>
              </div>
            ) : null}

            {isPasswordResetAction && resetActionChecked && !resetActionError && !resetActionComplete ? (
              <form className="auth-panel" onSubmit={submitResetAction}>
                <p className="small-note">
                  {t.passwordResetFor} <strong>{resetActionEmail}</strong>
                </p>
                <label>
                  {t.newPassword}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={resetActionPassword}
                    onChange={(event) => setResetActionPassword(event.target.value)}
                    required
                    minLength={8}
                  />
                </label>
                <label>
                  {t.repeatNewPassword}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={resetActionConfirmPassword}
                    onChange={(event) => setResetActionConfirmPassword(event.target.value)}
                    required
                    minLength={8}
                  />
                </label>
                <ul className="password-check-list">
                  <li className={passwordLongEnough ? "valid" : ""}>
                    {t.passwordResetLengthCheck}
                  </li>
                  <li className={passwordsMatch ? "valid" : ""}>
                    {t.passwordResetMatchCheck}
                  </li>
                </ul>
                <button className="button primary" type="submit" disabled={resetSubmitDisabled}>
                  {resetActionBusy ? t.loading : t.saveNewPassword}
                </button>
                {resetActionFormError ? (
                  <p className="error-text">{resetActionFormError}</p>
                ) : null}
              </form>
            ) : null}
          </section>
        </main>
      </div>
    );
  }

  if (user) {
    if (isAdminPath) {
      return renderAdminConsole();
    }

    return (
      <div className="app-shell workspace-shell">
        <header className="site-header">
          <a className="brand" href="#dashboard" aria-label="ReadWiseHub home">
            <img className="brand-mark" src={readWiseHubIcon} alt="" aria-hidden="true" />
            <span>
              <strong>ReadWiseHub</strong>
              <small>{t.brandTagline}</small>
            </span>
          </a>

          <div className="workspace-header-actions">
            <button
              className="button header-button menu-button"
              type="button"
              ref={menuButtonRef}
              aria-expanded={menuOpen}
              aria-controls="workspace-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
              <span className="visually-hidden">{t.menu}</span>
            </button>

            <div
              id="workspace-menu"
              ref={workspaceMenuRef}
              className={`workspace-menu ${menuOpen ? "open" : ""}`}
            >
              <nav className="workspace-nav" aria-label={t.workspaceToolsTitle}>
                <a href="#library" onClick={() => openMenuTab("ask")}>
                  {t.tabAsk}
                </a>
                <a href="#library" onClick={() => openMenuTab("library")}>
                  {t.navLibrary}
                </a>
                <a href="#library" onClick={() => openMenuTab("read")}>
                  {t.tabRead}
                </a>
                <a href="#library" onClick={() => openMenuTab("articles")}>
                  {t.tabArticles}
                </a>
                {adminAccess ? (
                  <a href="/admin" onClick={closeMenu}>
                    {t.adminSwitch}
                  </a>
                ) : null}
                <a href="#billing" onClick={closeMenu}>
                  {t.billingShortcut}
                </a>
                <a href="#account" onClick={closeMenu}>
                  {t.navAccount}
                </a>
              </nav>
              <div className="header-preferences menu-controls">
                {languageToggle}
                {themeToggle}
              </div>
              <button
                className="button header-button sign-out-button"
                type="button"
                onClick={() => void handleSignOut()}
                disabled={signingOut}
              >
                {signingOut ? t.loading : t.signOut}
              </button>
            </div>
          </div>
        </header>

        <main>
          <section id="dashboard" className="workspace-hero">
            <div>
              <p className="eyebrow">ReadWiseHub</p>
              <h1>{t.dashboardTitle}</h1>
              <p>{t.dashboardEmpty}</p>
            </div>
            <div className="quick-panel">
              <h2>{t.usageTitle}</h2>
              <ul className="usage-list">
                <li>
                  {usage.books}/{usage.maxBooks} {t.usageBooksLabel}
                </li>
                <li>
                  {Math.round(usage.storageBytes / 1024 / 1024)}/
                  {Math.round(usage.maxStorageBytes / 1024 / 1024)} MB {t.usageStorageLabel}
                </li>
                <li>
                  {usage.messages}/{usage.monthlyMessages} {t.usageMessagesLabel}
                </li>
              </ul>
              <div className="dashboard-billing-actions">
                <p className="small-note">{t.billingDashboardCopy}</p>
                <p className="small-note">
                  {t.billingCurrentPlanNote}: {usage.plan.toUpperCase()}
                </p>
                <div className="book-actions billing-actions">
                  {renderBillingActions()}
                </div>
                {billingMessage ? <p className="error-text">{billingMessage}</p> : null}
              </div>
            </div>
          </section>

          {!emailVerified ? (
            <section className="verification-panel">
              <div>
                <p className="eyebrow">{t.emailVerificationEyebrow}</p>
                <h2>{t.emailVerificationTitle}</h2>
                <p>{t.emailVerificationCopy}</p>
                <p className="small-note">{t.unexpectedRegistrationCopy}</p>
              </div>
              <div className="verification-actions">
                <button
                  className="button primary"
                  type="button"
                  disabled={verificationBusy}
                  onClick={resendVerificationEmail}
                >
                  {verificationBusy ? t.loading : t.resendVerification}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={verificationBusy}
                  onClick={refreshEmailVerification}
                >
                  {t.refreshVerification}
                </button>
              </div>
              {status ? <p className="success-text">{status}</p> : null}
              {authError ? <p className="error-text">{authError}</p> : null}
            </section>
          ) : null}

          <section id="library" className="content-section workspace-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{t.navLibrary}</p>
                <h2>{t.workspaceToolsTitle}</h2>
              </div>
            </div>

            <div className="workspace-tabs" aria-label={t.workspaceToolsTitle}>
              {(
                ["ask", "library", "read", "articles", "history", "help"] as WorkspaceTab[]
              ).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={workspaceTab === tab ? "active" : ""}
                  aria-pressed={workspaceTab === tab}
                  onClick={() => setWorkspaceTab(tab)}
                >
                  {tab === "ask"
                    ? t.tabAsk
                    : tab === "library"
                      ? t.tabLibrary
                      : tab === "read"
                        ? t.tabRead
                        : tab === "articles"
                          ? t.tabArticles
                          : tab === "history"
                            ? t.tabHistory
                            : t.tabHelp}
                </button>
              ))}
            </div>

            {workspaceTab === "library" ? (
              <div className="workspace-tab-panel">
            <div className="upload-panel">
              <div>
                <h3>{t.uploadTitle}</h3>
                <p>{t.uploadCopy}</p>
                <p className="small-note">{t.allowedFiles}</p>
              </div>
              <label className="file-picker">
                {t.chooseFile}
                <input
                  type="file"
                  accept=".pdf,.txt,.md,.markdown,.docx,.epub,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/epub+zip"
                  disabled={!emailVerified}
                  onChange={(event) => handleFileSelection(event.target.files?.[0])}
                />
              </label>
              {selectedFile ? (
                <div className="selected-file">
                  {t.selectedFile}: <strong>{selectedFile.name}</strong>
                </div>
              ) : null}
              {uploadBusy ? (
                <div className="upload-progress" role="status" aria-live="polite">
                  <div>
                    <strong>{t.uploadingFile}</strong>
                    <span>{uploadProgress}%</span>
                  </div>
                  <progress value={uploadProgress} max="100" />
                </div>
              ) : null}
              {uploadTrackingBook ? (
                <div className="upload-progress processing-progress" role="status" aria-live="polite">
                  <div>
                    <strong>
                      {uploadTrackingBook.status === "text_ready"
                        ? `${t.uploadReady}: ${uploadTrackingBook.displayTitle}`
                        : `${getIngestionStageLabel(uploadTrackingJob)}: ${uploadTrackingBook.displayTitle}`}
                    </strong>
                    <span>{processingProgress}%</span>
                  </div>
                  <progress value={processingProgress} max="100" />
                  <p>{uploadTrackingBook.status === "text_ready" ? t.uploadStageReadyDetail : getIngestionStageDetail(uploadTrackingJob)}</p>
                </div>
              ) : null}
              {uploadTrackingBook?.status === "text_ready" &&
              ["queued", "processing"].includes(uploadTrackingBook.vectorBackfillStatus) ? (
                <div className="upload-progress vector-progress" role="status" aria-live="polite">
                  <div>
                    <strong>{t.searchIndexPreparing}</strong>
                    <span>{uploadTrackingVectorProgress}%</span>
                  </div>
                  <progress value={uploadTrackingVectorProgress} max="100" />
                  <p>{t.searchIndexPreparingDetail}</p>
                </div>
              ) : null}
              {uploadTrackingBook?.status === "text_ready"
                ? renderSuggestionChips(
                    t.tryNextTitle,
                    [
                      {
                        label: t.suggestionSummarizeBook,
                        question: t.suggestionSummarizeBookQuestion,
                        bookId: uploadTrackingBook.id,
                      },
                      {
                        label: t.suggestionMapBook,
                        question: t.suggestionMapBookQuestion,
                        bookId: uploadTrackingBook.id,
                      },
                      {
                        label: t.suggestionFinalQuarter,
                        question: t.suggestionFinalQuarterQuestion,
                        bookId: uploadTrackingBook.id,
                      },
                    ],
                    "fill"
                  )
                : null}
              <button
                className="button primary"
                type="button"
                disabled={!emailVerified || !selectedFile || uploadBusy || !UPLOAD_BACKEND_ENABLED}
                onClick={reserveAndUploadFile}
              >
                Upload
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={
                  !emailVerified ||
                  processBusy ||
                  books.every((book) => book.status !== "queued")
                }
                onClick={processQueuedJobs}
              >
                {processBusy ? t.processingQueued : t.processQueued}
              </button>
              {!UPLOAD_BACKEND_ENABLED ? (
                <div className="backend-lock">
                  <h3>{t.uploadBlockedTitle}</h3>
                  <p>{t.uploadBlocked}</p>
                </div>
              ) : null}
              {uploadMessage ? <p className="error-text">{uploadMessage}</p> : null}
            </div>

            {!booksReady ? (
              <p>Loading...</p>
            ) : books.length === 0 ? (
              <div className="empty-state">
                <h3>{t.libraryEmptyTitle}</h3>
                <p>{t.libraryEmpty}</p>
              </div>
            ) : (
              <div className="book-list">
                {books.map((book) => {
                  const job = jobsByBookId.get(book.id);
                  const vectorCoverage = getVectorCoverage(book);
                  return (
                  <article
                    key={book.id}
                    ref={(element) => {
                      if (element) {
                        bookCardRefs.current.set(book.id, element);
                      } else {
                        bookCardRefs.current.delete(book.id);
                      }
                    }}
                    className={book.id === lastUploadedBookId ? "uploaded-book-card" : ""}
                  >
                    <h3 title={book.title}>{book.displayTitle}</h3>
                    <p className={`status-pill status-${book.status.replace(/_/g, "-")}`}>
                      {getBookStatusLabel(book)}
                    </p>
                    {job ? (
                      <div className="job-progress">
                        <div>
                          <span>{getIngestionStageLabel(job)}</span>
                          <strong>{Math.max(0, Math.min(100, job.progress))}%</strong>
                        </div>
                        <progress value={job.progress} max="100" />
                        <p>{getIngestionStageDetail(job)}</p>
                      </div>
                    ) : null}
                    {book.formatWarning ? (
                      <p className="format-warning">{book.formatWarning}</p>
                    ) : null}
                    {job?.errorMessageSafe ? (
                      <p className="error-text">{job.errorMessageSafe}</p>
                    ) : null}
                    {book.chunkCount > 0 ? <p>{book.chunkCount} {t.chunks.toLowerCase()}</p> : null}
                    <p className={`vector-coverage-pill vector-${vectorCoverage.status}`}>
                      {vectorCoverage.label}
                      {vectorCoverage.detail ? <span>{vectorCoverage.detail}</span> : null}
                    </p>
                    {["queued", "processing"].includes(book.vectorBackfillStatus) ? (
                      <div className="job-progress vector-job-progress">
                        <div>
                          <span>{t.searchIndexPreparing}</span>
                          <strong>{getVectorBackfillProgress(book)}%</strong>
                        </div>
                        <progress value={getVectorBackfillProgress(book)} max="100" />
                        <p>{t.searchIndexPreparingDetail}</p>
                      </div>
                    ) : null}
                    <p className="small-note">
                      {book.language || "unknown"} · {Math.round(book.sizeBytes / 1024)} KB
                      {book.embeddedChunkCount > 0
                        ? ` · ${book.embeddedChunkCount} ${t.embeddedChunks}`
                        : ""}
                    </p>
                    {job && (job.status === "queued" || job.status === "failed") ? (
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={!emailVerified || processingBookId === book.id}
                        onClick={() => processBookJob(book)}
                      >
                        {processingBookId === book.id ? t.processingQueued : t.retryProcessing}
                      </button>
                    ) : null}
                    <div className="book-actions">
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={book.status === "deleting"}
                        onClick={() => openBookDetail(book)}
                      >
                        {t.viewDetails}
                      </button>
                      {book.status === "text_ready" ? (
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={() => openBookReader(book)}
                        >
                          {t.readBook}
                        </button>
                      ) : null}
                    </div>
                    {confirmDeleteBookId === book.id ? (
                      <div className="inline-confirm">
                        <p>{t.deleteInlineConfirm}</p>
                        <div className="book-actions">
                          <button
                            className="button danger"
                            type="button"
                            disabled={Boolean(bookDeleteProgress[book.id]) || book.status === "deleting"}
                            onClick={() => deleteLibraryBook(book)}
                          >
                            {bookDeleteProgress[book.id] ? t.deletingBook : t.deleteBook}
                          </button>
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => setConfirmDeleteBookId("")}
                          >
                            {t.cancel}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="book-actions">
                        <button
                          className="button danger"
                          type="button"
                          disabled={
                            Boolean(bookDeleteProgress[book.id]) ||
                            book.status === "processing" ||
                            book.status === "deleting"
                          }
                          onClick={() => setConfirmDeleteBookId(book.id)}
                        >
                          {bookDeleteProgress[book.id] ? t.deletingBook : t.deleteBook}
                        </button>
                      </div>
                    )}
                    {bookDeleteProgress[book.id] ? (
                      <div className="task-progress danger-progress deletion-progress" role="status" aria-live="polite">
                        <div>
                          <strong>
                            {`${t.deletingBookTitle}: ${bookDeleteProgress[book.id].label || book.displayTitle}`}
                          </strong>
                          <span>{bookDeleteProgress[book.id].progress}%</span>
                        </div>
                        <progress value={bookDeleteProgress[book.id].progress} max="100" />
                        <p>{t.deleteBookProgressCopy}</p>
                        <p className="small-note">{t.deleteBookProgressDetail}</p>
                      </div>
                    ) : null}
                  </article>
                  );
                })}
              </div>
            )}
            {selectedBookDetailId ? (
              <section className="book-detail-panel" ref={bookDetailRef}>
                {books
                  .filter((book) => book.id === selectedBookDetailId)
                  .map((book) => {
                    const vectorCoverage = getVectorCoverage(book);
                    return (
                    <div key={book.id}>
                      <div className="section-heading">
                        <div>
                          <p className="eyebrow">{t.bookDetails}</p>
                          <h3 title={book.title}>{book.displayTitle}</h3>
                        </div>
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={() => setSelectedBookDetailId("")}
                        >
                          {t.close}
                        </button>
                      </div>
                      <dl className="metadata-grid">
                        <div>
                          <dt>{t.status}</dt>
                          <dd>{getBookStatusLabel(book)}</dd>
                        </div>
                        <div>
                          <dt>{t.chunks}</dt>
                          <dd>{book.chunkCount}</dd>
                        </div>
                        <div>
                          <dt>{t.sections}</dt>
                          <dd>{book.sectionCount || "-"}</dd>
                        </div>
                        <div>
                          <dt>{t.language}</dt>
                          <dd>{book.language || "unknown"}</dd>
                        </div>
                        <div>
                          <dt>{t.documentStructure}</dt>
                          <dd>
                            {book.structureQuality === "layout"
                              ? t.structureGood
                              : book.structureQuality === "complex_layout"
                                ? t.structureComplex
                              : book.structureQuality === "limited"
                                ? t.structureLimited
                                : book.structureQuality === "poor"
                                  ? t.structurePoor
                                  : book.structureQuality || "-"}
                          </dd>
                        </div>
                        <div>
                          <dt>{t.vectorReady}</dt>
                          <dd>
                            <span className={`vector-coverage-pill vector-${vectorCoverage.status}`}>
                              {vectorCoverage.label}
                              {vectorCoverage.detail ? <span>{vectorCoverage.detail}</span> : null}
                            </span>
                          </dd>
                        </div>
                      </dl>
                      {book.formatWarning ? (
                        <p className="format-warning">{book.formatWarning}</p>
                      ) : null}
                      <div className="book-actions book-detail-actions">
                        {book.status === "text_ready" ? (
                          <>
                            <button
                              className="button primary compact"
                              type="button"
                              onClick={() => openBookReader(book)}
                            >
                              {t.readBook}
                            </button>
                            <button
                              className="button secondary compact"
                              type="button"
                              onClick={() => askThisBook(book)}
                            >
                              {t.askThisBook}
                            </button>
                            <div className="section-map-control">
                              <label htmlFor="section-map-count">Map sections</label>
                              <select
                                id="section-map-count"
                                value={sectionMapTargetCount}
                                onChange={(event) =>
                                  setSectionMapTargetCount(Number(event.target.value))
                                }
                              >
                                {[4, 6, 8, 10, 11, 12].map((count) => (
                                  <option key={count} value={count}>
                                    {count}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="button secondary compact"
                                type="button"
                                disabled={sectionMapBusy}
                                onClick={() => generateSectionMap(book)}
                              >
                                {sectionMapBusy
                                  ? "Creating..."
                                  : bookArtifacts.length > 0
                                    ? "Create new map"
                                    : "Create map"}
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                      {book.status === "text_ready"
                        ? renderSuggestionChips(
                            t.bookGuideTitle,
                            [
                              {
                                label: t.suggestionSummarizeBook,
                                question: t.suggestionSummarizeBookQuestion,
                                bookId: book.id,
                              },
                              {
                                label: t.suggestionMapBook,
                                question: t.suggestionMapBookQuestion,
                                bookId: book.id,
                              },
                              {
                                label: t.suggestionKeyIdeas,
                                question: t.suggestionKeyIdeasQuestion,
                                bookId: book.id,
                              },
                              {
                                label: t.suggestionFinalQuarter,
                                question: t.suggestionFinalQuarterQuestion,
                                bookId: book.id,
                              },
                            ],
                            "fill"
                          )
                        : null}
                      {bookDetailMessage ? <p className="error-text">{bookDetailMessage}</p> : null}
                      {bookArtifacts.length > 0 ? (
                        <div className="artifact-list">
                          <div className="artifact-list-heading">
                            <h4>Generated section maps</h4>
                            <small>{bookArtifacts.length} saved</small>
                          </div>
                          {bookArtifacts.map((artifact) => (
                            <article key={artifact.id} className="artifact-card">
                              <div className="artifact-card-header">
                                <div>
                                  <strong>{artifact.title}</strong>
                                  <small>
                                    {artifact.sections.length} sections · target{" "}
                                    {artifact.targetSectionCount || artifact.sections.length}
                                    {artifact.sourceSectionCount
                                      ? ` · from ${artifact.sourceSectionCount} source sections`
                                      : ""}
                                    {artifact.createdAt ? ` · ${artifact.createdAt}` : ""}
                                  </small>
                                </div>
                                <span className={`artifact-quality quality-${artifact.mapQuality || "unknown"}`}>
                                  {artifact.mapQuality === "heading_aware"
                                    ? "Heading-aware"
                                    : artifact.mapQuality === "weak_titles"
                                      ? "Needs review"
                                      : "Grouped"}
                                </span>
                              </div>
                              <button
                                className="button compact danger"
                                type="button"
                                onClick={() => void deleteSectionMap(artifact)}
                              >
                                Delete map
                              </button>
                              {articleStudioUnlocked ? (
                                <button
                                  className="button secondary compact"
                                  type="button"
                                  disabled={articleBusy}
                                  onClick={() => writeArticleFromSectionMap(artifact)}
                                >
                                  {articleBusy ? t.articleWriting : t.articleFromThis}
                                </button>
                              ) : null}
                              <ol>
                                {artifact.sections.map((section) => (
                                  <li key={section.sectionNumber}>
                                    <div className="artifact-section-title">
                                      <strong>
                                        {section.sectionNumber}. {section.title}
                                      </strong>
                                      <small>
                                        source {section.sourceSectionStart + 1}-
                                        {section.sourceSectionEnd + 1}
                                        {section.pageStart || section.pageEnd
                                          ? ` · pages ${section.pageStart || "?"}-${
                                              section.pageEnd || "?"
                                            }`
                                          : ""}
                                      </small>
                                    </div>
                                    <p>{section.summary}</p>
                                  </li>
                                ))}
                              </ol>
                            </article>
                          ))}
                        </div>
                      ) : null}
                      {bookChunkPreviews.length > 0 ? (
                        <div className="chunk-preview-list">
                          {bookChunkPreviews.map((chunk) => (
                            <article key={chunk.id}>
                              <h4>
                                {t.sourceChunk} {chunk.chunkIndex + 1}
                              </h4>
                              <p>{chunk.textPreview}</p>
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    );
                  })}
              </section>
            ) : null}

              </div>
            ) : null}

            {workspaceTab === "read" ? (
              <div className="workspace-tab-panel">
                <section className="reader-panel">
                  <div className="reader-header">
                    {readerBook ? (
                      <button
                        className="reader-dashboard-link"
                        type="button"
                        onClick={returnToLibrary}
                      >
                        {t.readerNavigation}
                      </button>
                    ) : null}
                    <div className="reader-title-block">
                      <p className="eyebrow">{t.readerEyebrow}</p>
                      <h3>{readerBook ? readerBook.displayTitle : t.readerTitle}</h3>
                      <p>
                        {readerBook
                          ? `${t.page} ${readerPage + 1} / ${activeReaderPageCount}`
                          : t.readerCopy}
                      </p>
                      {readerBook && readerOriginalPageCount > 0 ? (
                        <div className="reader-view-toggle" aria-label={t.readerViewMode}>
                          <button
                            type="button"
                            className={readerMode === "text" ? "active" : ""}
                            aria-pressed={readerMode === "text"}
                            onClick={() => setReaderMode("text")}
                          >
                            {t.textView}
                          </button>
                          <button
                            type="button"
                            className={readerMode === "original" ? "active" : ""}
                            aria-pressed={readerMode === "original"}
                            onClick={() => setReaderMode("original")}
                          >
                            {t.originalView}
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {readerBook ? (
                      <div className="reader-nav-area">
                        <div className="reader-controls">
                          <button
                            className="reader-icon-button"
                            type="button"
                            disabled={readerBusy || readerPage === 0}
                            onClick={() => turnReaderPage(-1)}
                            aria-label={t.previousPage}
                            title={t.previousPage}
                          >
                            <span aria-hidden="true">←</span>
                          </button>
                          <label className="reader-jump">
                            <span className="visually-hidden">
                              {readerSourceToc ? t.sourceOutline : readerUsesPhysicalPages ? t.page : t.chapter}
                            </span>
                            <select
                              value={readerPage}
                              onChange={(event) => goToReaderPage(Number(event.target.value))}
                              disabled={readerBusy || activeReaderPageCount === 0}
                            >
                              {readerNavigationEntries.map((entry, index) => (
                                <option key={`${entry.page}-${index}`} value={entry.page}>
                                  {entry.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        <div className="reader-bookmark-menu" ref={bookmarkMenuRef}>
                          <button
                            className={`reader-icon-button reader-bookmark-button ${
                              currentPageBookmarked ? "active" : ""
                            }`}
                            type="button"
                            disabled={readerBusy || activeReaderPageCount === 0}
                            onClick={() => setReaderBookmarkMenuOpen((open) => !open)}
                            aria-expanded={readerBookmarkMenuOpen}
                            aria-label={t.bookmarks}
                            title={t.bookmarks}
                          >
                            <span aria-hidden="true" className="bookmark-ribbon" />
                            {readerBookmarks.length > 0 ? (
                              <span className="bookmark-count">{readerBookmarks.length}</span>
                            ) : null}
                          </button>
                          {readerBookmarkMenuOpen ? (
                            <div className="bookmark-dropdown">
                              <div className="bookmark-dropdown-title">
                                <strong>{t.bookmarks}</strong>
                                <button
                                  type="button"
                                  aria-label={t.close}
                                  onClick={() => setReaderBookmarkMenuOpen(false)}
                                >
                                  ×
                                </button>
                              </div>
                              <button
                                className="bookmark-current-button"
                                type="button"
                                onClick={bookmarkReaderPage}
                              >
                                {currentPageBookmarked ? t.removeBookmark : t.bookmarkPage}
                              </button>
                              {readerBookmarks.length === 0 ? (
                                <p>{t.noBookmarks}</p>
                              ) : (
                                readerBookmarks.map((bookmark) => (
                                  <article key={`${bookmark.page}-${bookmark.createdAt}`}>
                                    <button
                                      type="button"
                                      onClick={() => openReaderBookmark(bookmark.page)}
                                    >
                                      <strong>{bookmark.label}</strong>
                                      {bookmark.snippet ? <span>{bookmark.snippet}</span> : null}
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={t.removeBookmark}
                                      onClick={() => deleteReaderBookmark(bookmark.page)}
                                    >
                                      ×
                                    </button>
                                  </article>
                                ))
                              )}
                            </div>
                          ) : null}
                        </div>
                        <div className="reader-bookmark-menu" ref={highlightMenuRef}>
                          <button
                            className={`reader-icon-button reader-highlight-button ${
                              readerHighlightList.length > 0 ? "active" : ""
                            }`}
                            type="button"
                            disabled={readerBusy || readerMode === "original" || readerTotalChunks === 0}
                            onClick={() => setReaderHighlightMenuOpen((open) => !open)}
                            aria-expanded={readerHighlightMenuOpen}
                            aria-label={t.highlights}
                            title={t.highlights}
                          >
                            <span aria-hidden="true">H</span>
                            {readerHighlightList.length > 0 ? (
                              <span className="bookmark-count">{readerHighlightList.length}</span>
                            ) : null}
                          </button>
                          {readerHighlightMenuOpen ? (
                            <div className="bookmark-dropdown highlight-dropdown">
                              <div className="bookmark-dropdown-title">
                                <strong>{t.highlights}</strong>
                                <button
                                  type="button"
                                  aria-label={t.close}
                                  onClick={() => setReaderHighlightMenuOpen(false)}
                                >
                                  ×
                                </button>
                              </div>
                              {readerHighlightList.length === 0 ? (
                                <p>{t.noHighlights}</p>
                              ) : (
                                readerHighlightList.map((highlight) => (
                                  <article key={highlight.id}>
                                    <button
                                      type="button"
                                      onClick={() => openReaderHighlight(highlight)}
                                    >
                                      <strong>{t.page} {highlight.page + 1}</strong>
                                      <span>{highlight.text}</span>
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={t.removeHighlight}
                                      onClick={() => deleteReaderHighlight(highlight.id)}
                                    >
                                      ×
                                    </button>
                                  </article>
                                ))
                              )}
                            </div>
                          ) : null}
                        </div>
                        <button
                          className="reader-icon-button"
                          type="button"
                          disabled={
                            readerBusy ||
                            activeReaderPageCount === 0 ||
                            readerPage + 1 >= activeReaderPageCount
                          }
                          onClick={() => turnReaderPage(1)}
                          aria-label={t.nextPage}
                          title={t.nextPage}
                        >
                          <span aria-hidden="true">→</span>
                        </button>
                          <button
                            className="reader-icon-button"
                            type="button"
                            onClick={chooseAnotherReaderBook}
                            aria-label={t.switchBook}
                            title={t.switchBook}
                          >
                            <span aria-hidden="true">☰</span>
                          </button>
                        </div>
                        <form className="reader-source-compact" onSubmit={searchCurrentReaderBook}>
                          <input
                            type="search"
                            value={readerSourceQuestion}
                            onChange={(event) => setReaderSourceQuestion(event.target.value)}
                            placeholder={t.readerSearchPlaceholder}
                            aria-label={t.searchTitle}
                            disabled={!readerBook}
                          />
                          <button
                            className="button secondary compact"
                            type="submit"
                            disabled={!emailVerified || readerSourceBusy || !readerBook || !readerSourceQuestion.trim()}
                          >
                            {readerSourceBusy ? t.searching : t.readerSearchButton}
                          </button>
                        </form>
                        <p className="reader-info-box">{t.readerQuickHelp}</p>
                      </div>
                    ) : null}
                  </div>
                  {readerBook && readerBookPickerOpen ? (
                    <div className="reader-book-picker reader-book-switch-panel" id="reader-book-switch-panel">
                      <div>
                        <h3>{t.switchBook}</h3>
                        <p>{t.switchBookCopy}</p>
                      </div>
                      {textReadyBooks.length === 0 ? (
                        <p className="small-note">{t.searchNeedsText}</p>
                      ) : (
                        textReadyBooks.map((book) => (
                          <button
                            className="button secondary"
                            type="button"
                            key={book.id}
                            disabled={readerBusy}
                            onClick={() => openBookReader(book)}
                          >
                            {book.displayTitle}
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                  {readerBookmarkMessage ? (
                    <p className="success-text reader-bookmark-note">{readerBookmarkMessage}</p>
                  ) : null}

                  {!readerBook ? (
                    <div className="reader-book-picker" id="reader-book-picker">
                      <div>
                        <h3>{t.switchBook}</h3>
                        <p>{t.switchBookCopy}</p>
                      </div>
                      {textReadyBooks.length === 0 ? (
                        <p className="small-note">{t.searchNeedsText}</p>
                      ) : (
                        textReadyBooks.map((book) => (
                          <button
                            className="button secondary"
                            type="button"
                            key={book.id}
                            onClick={() => openBookReader(book)}
                          >
                            {book.displayTitle}
                          </button>
                        ))
                      )}
                    </div>
                  ) : (
                    <>
                      <div ref={readerSourceResultsRef} className="reader-source-results">
                        {readerSourceMessage ? <p className="error-text">{readerSourceMessage}</p> : null}
                        {readerSourceResults.length > 0 ? (
                          <div className="search-results">
                            <div className="search-results-header">
                              <h4>{t.sourcePassagesTitle}</h4>
                              <span>{t.noAiBadge}</span>
                            </div>
                            {readerSourceResults.map((result) => (
                              <article key={result.bookId + "-" + result.chunkIndex}>
                                <h4>{result.bookTitle}</h4>
                                <p>{result.excerpt}</p>
                                <span>{getSourceLabel(result, t)}</span>
                              </article>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      {readerSelection ? (
                        <div className="selection-toolbar">
                          <span>{t.selectionActions}</span>
                          <button
                            className="button secondary compact"
                            type="button"
                            onClick={highlightReaderSelection}
                          >
                            {t.highlight}
                          </button>
                          <button
                            className="button secondary compact"
                            type="button"
                            disabled={!emailVerified || readerAskBusy}
                            onClick={askReaderSelectionInline}
                          >
                            {readerAskBusy ? t.asking : t.askAboutSelection}
                          </button>
                          {articleStudioUnlocked ? (
                            <button
                              className="button secondary compact"
                              type="button"
                              disabled={!emailVerified || articleBusy}
                              onClick={writeArticleFromReaderSelection}
                            >
                              {articleBusy ? t.articleWriting : t.articleFromThis}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {readerAskAnswer || readerAskBusy ? (
                        <div className="reader-answer-popover" ref={readerAnswerRef}>
                          <button
                            className="reader-answer-close"
                            type="button"
                            aria-label={t.close}
                            onClick={closeReaderAnswerAndReturn}
                          >
                            ×
                          </button>
                          <div className="answer-heading">
                            <div>
                              <h4>{t.readerAnswerTitle}</h4>
                              {readerAskQuestion ? (
                                <p className="small-note">"{readerAskQuestion}"</p>
                              ) : null}
                            </div>
                            <div className="reader-answer-actions">
                              {readerAskMode ? (
                                <span className="mode-badge">
                                  {readerAskMode === "ai_grounded"
                                    ? t.aiGroundedMode
                                    : t.sourceDraftMode}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {readerAskBusy ? (
                            <div className="reader-answer-loading" role="status" aria-live="polite">
                              <span aria-hidden="true" />
                              <div>
                                <strong>{t.readerAnswerLoadingTitle}</strong>
                                <p>{t.readerAnswerLoadingCopy}</p>
                              </div>
                            </div>
                          ) : (
                            <p>{readerAskAnswer}</p>
                          )}
                          {readerAskBusy || readerAskProgress === 100 ? (
                            <div className="task-progress" role="status" aria-live="polite">
                              <div>
                                <strong>{readerAskProgress === 100 ? t.answerReady : t.asking}</strong>
                                <span>{readerAskProgress}%</span>
                              </div>
                              <progress value={readerAskProgress} max="100" />
                            </div>
                          ) : null}
                          {!readerAskBusy ? (
                            <button
                              className="reader-return-button"
                              type="button"
                              onClick={closeReaderAnswerAndReturn}
                            >
                              <span aria-hidden="true">←</span>
                              {t.backToPassage}
                            </button>
                          ) : null}
                          {readerAskSources.length > 0 ? (
                            <div className="source-pills">
                              {readerAskSources.slice(0, 3).map((source) => (
                                <span key={`${source.bookId}-${source.chunkIndex}`}>
                                  {source.bookTitle} · {getSourceLabel(source, t)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <div
                        className="book-page"
                        ref={bookPageRef}
                        onMouseUp={captureReaderSelection}
                        onTouchStart={startReaderSwipe}
                        onTouchEnd={finishReaderSwipe}
                      >
                        <div className="book-page-top">
                          <span>{readerBook.displayTitle}</span>
                          <span>
                            {t.page} {readerPage + 1}
                          </span>
                        </div>
                        {readerBusy ? <p>{t.loading}</p> : null}
                        {readerMessage ? <p className="error-text">{readerMessage}</p> : null}
                        {readerMode === "original" ? (
                          <div className="original-page-frame">
                            {readerOriginalPageUrl ? (
                              <img
                                src={readerOriginalPageUrl}
                                alt={`${readerBook.displayTitle} ${t.page} ${readerPage + 1}`}
                                width={readerOriginalPage?.width || undefined}
                                height={readerOriginalPage?.height || undefined}
                              />
                            ) : (
                              <p className="small-note">
                                {readerOriginalPage ? t.loadingOriginalPage : t.originalPageUnavailable}
                              </p>
                            )}
                          </div>
                        ) : (
                          <>
                            {!readerBusy && readerParagraphs.length === 0 && !readerMessage ? (
                              <p className="small-note">{t.readerEmpty}</p>
                            ) : null}
                            {readerParagraphs.map((paragraph) => {
                              const paragraphHighlights = Object.values(readerHighlights).filter(
                                (highlight) =>
                                  paragraph.text.toLowerCase().includes(highlight.text.toLowerCase())
                              );
                              const paragraphMedia = readerInlineMedia.filter((media) =>
                                paragraph.chunkIndexes.includes(media.sectionIndex)
                              );

                              return (
                                <div key={paragraph.id} className="reader-paragraph-group">
                                  <article
                                    id={`reader-passage-${paragraph.id}`}
                                    className={`reader-paragraph${paragraph.isHeading ? " reader-paragraph-heading" : ""}`}
                                  >
                                    <p>
                                      {getHighlightedParts(paragraph.text, paragraphHighlights.map((highlight) => highlight.text)).map(
                                        (part, index) =>
                                          part.highlighted ? (
                                            <mark key={index}>{part.text}</mark>
                                          ) : (
                                            <span key={index}>{part.text}</span>
                                          )
                                      )}
                                    </p>
                                  </article>
                                  {paragraphMedia.map((media) => {
                                    const mediaUrl = readerInlineMediaUrls[media.id];
                                    return (
                                      <figure className="reader-inline-media" key={media.id}>
                                        {mediaUrl ? (
                                          <img
                                            src={mediaUrl}
                                            alt={`${t.readerImageAlt} ${t.page} ${media.pageNumber}`}
                                            loading="lazy"
                                            width={media.width || undefined}
                                            height={media.height || undefined}
                                          />
                                        ) : (
                                          <div className="reader-inline-media-placeholder">
                                            {t.loadingOriginalPage}
                                          </div>
                                        )}
                                        <figcaption>
                                          <span>{t.readerImageCaption} {media.pageNumber}</span>
                                          <button
                                            className="button secondary compact"
                                            type="button"
                                            onClick={() => {
                                              setReaderMode("original");
                                              goToReaderPage(Math.max(0, media.pageNumber - 1));
                                            }}
                                          >
                                            {t.openOriginalPage}
                                          </button>
                                        </figcaption>
                                      </figure>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </>
                        )}
                      </div>
                      <div className="reader-footer">
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={returnToLibrary}
                        >
                          {t.backToLibrary}
                        </button>
                        <button
                          className="reader-icon-button"
                          type="button"
                          disabled={readerBusy || readerPage === 0}
                          onClick={() => turnReaderPage(-1)}
                          aria-label={t.previousPage}
                          title={t.previousPage}
                        >
                          <span aria-hidden="true">←</span>
                        </button>
                        <span>
                          {readerMode === "original"
                            ? `${t.page} ${readerPage + 1} / ${activeReaderPageCount}`
                            : readerUsesPhysicalPages
                              ? `${t.page} ${readerPage + 1} / ${activeReaderPageCount}`
                              : `${Math.min(readerTotalChunks, readerPage * readerEffectivePageSize + 1)}-${Math.min(
                                readerTotalChunks,
                                (readerPage + 1) * readerEffectivePageSize
                              )} / ${readerTotalChunks} ${t.chunks}`}
                        </span>
                        <button
                          className="reader-icon-button"
                          type="button"
                          disabled={
                            readerBusy ||
                            activeReaderPageCount === 0 ||
                            readerPage + 1 >= activeReaderPageCount
                          }
                          onClick={() => turnReaderPage(1)}
                          aria-label={t.nextPage}
                          title={t.nextPage}
                        >
                          <span aria-hidden="true">→</span>
                        </button>
                      </div>
                      <div
                        className={`reader-scroll-nav ${
                          readerScrollNavVisible ? "visible" : ""
                        }`}
                        aria-hidden={!readerScrollNavVisible}
                      >
                        <button
                          type="button"
                          aria-label={t.scrollTop}
                          onClick={() => scrollReaderBoundary(-1)}
                        >
                          ⇈
                        </button>
                        <button
                          type="button"
                          aria-label={t.scrollUp}
                          onClick={() => scrollReaderPage(-1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={t.scrollDown}
                          onClick={() => scrollReaderPage(1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label={t.scrollBottom}
                          onClick={() => scrollReaderBoundary(1)}
                        >
                          ⇊
                        </button>
                      </div>
                    </>
                  )}
                </section>
              </div>
            ) : null}

            {workspaceTab === "ask" ? (
              <div className="workspace-tab-panel">
            <form className="ask-panel" onSubmit={askLibraryQuestion}>
              <div>
                <h3>{t.askTitle}</h3>
                <p>{t.askCopy}</p>
              </div>
              {textReadyBooks.length === 0 ? (
                <div className="ask-empty-hint">
                  <div>
                    <h4>{t.askNeedsBookTitle}</h4>
                    <p>{t.askNeedsBookCopy}</p>
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setWorkspaceTab("library")}
                  >
                    {t.openLibrary}
                  </button>
                </div>
              ) : null}
              <label>
                {t.bookScope}
                <select
                  value={selectedBookScope}
                  onChange={(event) => changeAskBookScope(event.target.value)}
                  disabled={textReadyBooks.length === 0}
                >
                  <option value="">{t.allReadyBooks}</option>
                  {textReadyBooks.map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.displayTitle}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.askLabel}
                <span className="textarea-clear-wrap">
                  <textarea
                    ref={askInputRef}
                    value={askQuestion}
                    onChange={(event) => setAskQuestion(event.target.value)}
                    placeholder={t.askPlaceholder}
                    disabled={textReadyBooks.length === 0}
                    rows={3}
                  />
                  {askQuestion ? (
                    <button
                      className="input-clear-button"
                      type="button"
                      aria-label={t.clearQuestion}
                      title={t.clearQuestion}
                      disabled={askBusy}
                      onClick={() => {
                        setAskQuestion("");
                        askInputRef.current?.focus();
                      }}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  ) : null}
                </span>
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={
                  !emailVerified ||
                  askBusy ||
                  textReadyBooks.length === 0 ||
                  !askQuestion.trim()
                }
              >
                {askBusy ? t.asking : t.askButton}
              </button>
              {!askAnswer ? renderSuggestionChips(t.askExamplesTitle, onboardingSuggestions, "fill") : null}
              {askBusy || askProgress === 100 ? (
                <div className="task-progress" ref={askProgressRef} role="status" aria-live="polite">
                  <div>
                    <strong>{askProgress === 100 ? t.answerReady : t.asking}</strong>
                    <span>{askProgress}%</span>
                  </div>
                  <progress value={askProgress} max="100" />
                </div>
              ) : null}
              {askMessage ? <p className="error-text">{askMessage}</p> : null}
              {askAnswer ? (
                <div className="answer-box">
                  <div className="answer-heading">
                    <h4>{t.answerTitle}</h4>
                    {askMode ? (
                      <span className="mode-badge">
                        {askMode === "ai_grounded" ? t.aiGroundedMode : t.sourceDraftMode}
                      </span>
                    ) : null}
                  </div>
                  <p>{askAnswer}</p>
                  {renderSuggestionChips(t.followUpTitle, answerFollowUpSuggestions, "ask")}
                  {articleStudioUnlocked ? (
                    <div className="inline-actions">
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={articleBusy}
                        onClick={writeArticleFromCurrentAnswer}
                      >
                        {articleBusy ? t.articleWriting : t.articleFromThis}
                      </button>
                    </div>
                  ) : null}
                  {askSources.length > 0 ? (
                    <div className="source-pills">
                      {askSources.slice(0, 3).map((source) => (
                        <span key={`${source.bookId}-${source.chunkIndex}`}>
                          {source.bookTitle} · {getSourceLabel(source, t)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </form>
                <section className="recent-questions-panel">
                  <div className="history-header">
                    <div>
                      <h3>{t.historyTitle}</h3>
                      <p>{t.historyCopy}</p>
                    </div>
                    <button
                      className="button compact secondary"
                      type="button"
                      onClick={() => setWorkspaceTab("history")}
                    >
                      {t.tabHistory}
                    </button>
                  </div>
                  {!conversationsReady ? (
                    <p>Loading...</p>
                  ) : conversations.length === 0 ? (
                    <p className="small-note">{t.historyEmpty}</p>
                  ) : (
                    <div className="history-list compact-history-list">
                      {conversations.slice(0, 3).map((conversation) => (
                        <article key={conversation.id}>
                          <div className="history-title-row">
                            <h4>{conversation.title}</h4>
                            {conversation.mode ? (
                              <span className="mode-badge">
                                {conversation.mode === "ai_grounded"
                                  ? t.aiGroundedMode
                                  : t.sourceDraftMode}
                              </span>
                            ) : null}
                          </div>
                          {conversation.latestAnswerPreview ? (
                            <p>{conversation.latestAnswerPreview}</p>
                          ) : (
                            <p>{t.historyNoPreview}</p>
                          )}
                          {conversation.hasUnavailableSources ||
                          conversation.sourceBookIds.some((sourceBookId) => !activeBookIds.has(sourceBookId)) ? (
                            <p className="history-warning">
                              {t.historyUnavailable}
                              {conversation.unavailableBookTitles.length > 0
                                ? " " + conversation.unavailableBookTitles.join(", ")
                                : ""}
                            </p>
                          ) : null}
                          <button
                            className="button compact secondary"
                            type="button"
                            disabled={conversationDetailBusyId === conversation.id}
                            onClick={() => {
                              setWorkspaceTab("history");
                              void openConversationDetail(conversation.id);
                            }}
                          >
                            {conversationDetailBusyId === conversation.id
                              ? t.loading
                              : t.openQuestion}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            ) : null}

            {workspaceTab === "articles" ? (
              <div className="workspace-tab-panel">
                <section className="article-studio-panel">
                  <div className="article-studio-heading">
                    <div>
                      <p className="eyebrow">
                        {articleStudioUnlocked ? t.articleBetaEyebrow : t.articleLockedEyebrow}
                      </p>
                      <h3>{t.articleTitle}</h3>
                      <p>{t.articleCopy}</p>
                    </div>
                    {articleStudioUnlocked ? (
                      <span>{usage.articleGenerations} {t.articleUsedThisMonth}</span>
                    ) : (
                      <span>{usage.plan.toUpperCase()}</span>
                    )}
                  </div>
                  {!articleStudioUnlocked ? (
                    <div className="article-locked-panel">
                      <h4>{t.articleLockedTitle}</h4>
                      <p>{t.articleLockedCopy}</p>
                      <p className="small-note">{t.articleLockedPreview}</p>
                    </div>
                  ) : (
                    <>
                  <div className="article-start-panel">
                    <div>
                      <h4>{t.articleStartTitle}</h4>
                      <p>{t.articleStartCopy}</p>
                    </div>
                    <div className="article-start-actions">
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={!askAnswer || !askQuestion}
                        onClick={writeArticleFromCurrentAnswer}
                      >
                        {t.articleStartCurrentAnswer}
                      </button>
                      {bookArtifacts[0] ? (
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={() => writeArticleFromSectionMap(bookArtifacts[0])}
                        >
                          {t.articleStartSectionMap}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="article-source-panel">
                    <strong>{t.articleSourceTitle}</strong>
                    <span>{getArticleSourceDescription(articleDraftContext)}</span>
                  </div>
                  <form className="article-studio-form" onSubmit={createArticleDraft}>
                    <label>
                      {t.articleBookLabel}
                      <select
                        value={articleReadyBookId}
                        onChange={(event) => {
                          setArticleBookId(event.target.value);
                          setArticleDraftContext({
                            sourceType: "manual",
                            activeBookId: event.target.value,
                          });
                        }}
                        disabled={articleBusy || textReadyBooks.length === 0}
                      >
                        {textReadyBooks.map((book) => (
                          <option key={book.id} value={book.id}>
                            {book.displayTitle}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t.articlePromptLabel}
                      <textarea
                        value={articlePrompt}
                        onChange={(event) => setArticlePrompt(event.target.value)}
                        placeholder={t.articlePromptPlaceholder}
                        disabled={articleBusy || textReadyBooks.length === 0}
                        rows={4}
                      />
                    </label>
                    <button
                      className="button primary"
                      type="submit"
                      disabled={
                        !emailVerified ||
                        articleBusy ||
                        textReadyBooks.length === 0 ||
                        !articlePrompt.trim()
                      }
                    >
                      {articleBusy ? t.articleWriting : t.articleWriteButton}
                    </button>
                    {articleBusy || articleProgress === 100 ? (
                      <div className="task-progress" role="status" aria-live="polite">
                        <div>
                          <strong>{articleProgress === 100 ? t.articleReady : t.articleWriting}</strong>
                          <span>{articleProgress}%</span>
                        </div>
                        <progress value={articleProgress} max="100" />
                      </div>
                    ) : null}
                    {textReadyBooks.length === 0 ? (
                      <p className="small-note">{t.searchNeedsText}</p>
                    ) : null}
                    {articleMessage ? (
                      <p className={articleMessageIsSuccess ? "success-text" : "error-text"}>
                        {articleMessage}
                      </p>
                    ) : null}
                  </form>
                  {articleCurrentDraft && articleCurrentVersion ? (
                    <article className="article-output">
                      <div className="answer-heading">
                        <h4>{articleCurrentDraft.title}</h4>
                        <div className="article-badges">
                          <span className="mode-badge">{t.articleDraftBadge}</span>
                          <span className="mode-badge article-scope-badge">
                            {getArticleScopeLabel(
                              articleCurrentVersion.articleContext ?? articleCurrentDraft.articleContext
                            )}
                          </span>
                        </div>
                      </div>
                      <p className="small-note">
                        {articleCurrentDraft.bookTitle}
                      </p>
                      <div className="article-rewrite-actions">
                        {[
                          ["shorter", t.rewriteShorter],
                          ["personal", t.rewritePersonal],
                          ["formal", t.rewriteFormal],
                          ["intro", t.rewriteIntro],
                          ["conclusion", t.rewriteConclusion],
                        ].map(([kind, label]) => (
                          <button
                            className="button secondary compact"
                            type="button"
                            key={kind}
                            disabled={Boolean(articleRewriteBusy) || articleBusy}
                            onClick={() => rewriteCurrentArticle(kind)}
                          >
                            {articleRewriteBusy === kind ? t.articleWriting : label}
                          </button>
                        ))}
                        <button
                          className="button danger compact"
                          type="button"
                          disabled={articleDeleteBusyId === articleCurrentDraft.id}
                          onClick={() => void deleteArticleDraft(articleCurrentDraft.id)}
                        >
                          {articleDeleteBusyId === articleCurrentDraft.id ? t.deletingQuestion : t.deleteArticle}
                        </button>
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={() => void copyCurrentArticleMarkdown()}
                        >
                          {t.copyMarkdown}
                        </button>
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={exportCurrentArticleMarkdown}
                        >
                          {t.exportMarkdown}
                        </button>
                      </div>
                      <pre>{articleCurrentVersion.body}</pre>
                      {articleCurrentVersion.sources.length > 0 ? (
                        <div className="search-results article-sources">
                          <h4>{t.sourcePassagesTitle}</h4>
                          {articleCurrentVersion.sources.slice(0, 5).map((source) => (
                            <article key={`${source.bookId}-${source.chunkIndex}-${source.sourceNumber}`}>
                              <h4>
                                [{source.sourceNumber}] {source.bookTitle}
                              </h4>
                              <p>{source.excerpt}</p>
                              <span>{getSourceLabel(source, t)}</span>
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ) : null}
                  <div className="article-draft-list">
                    <h4>{t.articleRecentTitle}</h4>
                    {articleDrafts.length === 0 ? (
                      <p className="small-note">{t.articleNoDrafts}</p>
                    ) : (
                      articleDrafts.map((draft) => (
                        <article key={draft.id}>
                          <div>
                            <strong>{draft.title}</strong>
                            <span>{draft.bookTitle} · {getArticleScopeLabel(draft.articleContext)}</span>
                          </div>
                          <button
                            className="button secondary compact"
                            type="button"
                            onClick={() => void continueArticleDraft(draft)}
                          >
                            {t.continueDraft}
                          </button>
                          <button
                            className="button danger compact"
                            type="button"
                            disabled={articleDeleteBusyId === draft.id}
                            onClick={() => void deleteArticleDraft(draft.id)}
                          >
                            {articleDeleteBusyId === draft.id ? t.deletingQuestion : t.deleteArticle}
                          </button>
                        </article>
                      ))
                    )}
                  </div>
                  </>
                  )}
                </section>
              </div>
            ) : null}

            {workspaceTab === "history" ? (
              <div className="workspace-tab-panel">
            <section className="history-panel">
              <div className="history-header">
                <div>
                  <h3>{t.historyTitle}</h3>
                  <p>{t.historyCopy}</p>
                </div>
                {conversations.length > 0 ? (
                  <button
                    className="button compact danger"
                    type="button"
                    onClick={() => setDeleteAllHistoryConfirmOpen(true)}
                  >
                    {t.deleteAllHistory}
                  </button>
                ) : null}
              </div>
              <div className="history-tip">
                <strong>{t.historyTipTitle}</strong>
                <p>{t.historyTipCopy}</p>
              </div>
              {deleteAllHistoryConfirmOpen ? (
                <div className="danger-confirm-panel">
                  <p>{t.deleteAllHistoryCopy}</p>
                  <label htmlFor="delete-all-history-confirm">{t.deleteAllHistoryPrompt}</label>
                  <input
                    id="delete-all-history-confirm"
                    value={deleteAllHistoryText}
                    onChange={(event) => setDeleteAllHistoryText(event.target.value)}
                    placeholder={t.deleteAllHistoryPhrase}
                  />
                  <div className="inline-actions">
                    <button
                      className="button danger"
                      type="button"
                      disabled={deleteAllHistoryBusy || deleteAllHistoryText !== t.deleteAllHistoryPhrase}
                      onClick={() => void deleteAllHistory()}
                    >
                      {deleteAllHistoryBusy ? t.deletingHistory : t.deleteAllHistory}
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={deleteAllHistoryBusy}
                      onClick={() => {
                        setDeleteAllHistoryConfirmOpen(false);
                        setDeleteAllHistoryText("");
                      }}
                    >
                      {t.cancel}
                    </button>
                  </div>
                </div>
              ) : null}
              {!conversationsReady ? (
                <p>Loading...</p>
              ) : conversations.length === 0 ? (
                <p className="small-note">{t.historyEmpty}</p>
              ) : (
                <div className="history-list">
                  {conversations.map((conversation) => (
                    <article key={conversation.id}>
                      <div className="history-title-row">
                        <h4>{conversation.title}</h4>
                        {conversation.mode ? (
                          <span className="mode-badge">
                            {conversation.mode === "ai_grounded"
                              ? t.aiGroundedMode
                              : t.sourceDraftMode}
                          </span>
                        ) : null}
                      </div>
                      {conversation.latestAnswerPreview ? (
                        <p>{conversation.latestAnswerPreview}</p>
                      ) : (
                        <p>{t.historyNoPreview}</p>
                      )}
                      {conversation.hasUnavailableSources ||
                      conversation.sourceBookIds.some((bookId) => !activeBookIds.has(bookId)) ? (
                        <p className="history-warning">
                          {t.historyUnavailable}
                          {conversation.unavailableBookTitles.length > 0
                            ? ` ${conversation.unavailableBookTitles.join(", ")}`
                            : ""}
                        </p>
                      ) : null}
                      <span>
                        {conversation.sourceCount} {t.historySources}
                      </span>
                      <button
                        className="button compact secondary"
                        type="button"
                        disabled={conversationDetailBusyId === conversation.id}
                        onClick={() => openConversationDetail(conversation.id)}
                      >
                        {conversationDetailBusyId === conversation.id
                          ? t.loading
                          : t.openQuestion}
                      </button>
                      <button
                        className="button compact danger"
                        type="button"
                        disabled={deleteConversationBusyId === conversation.id}
                        onClick={() => deleteRecentQuestion(conversation.id)}
                      >
                        {deleteConversationBusyId === conversation.id
                          ? t.deletingQuestion
                          : t.deleteQuestion}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
                {conversationDetail ? (
                  <section className="conversation-detail-panel" ref={conversationDetailRef}>
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">{t.questionDetail}</p>
                        <h3>{conversationDetail.title}</h3>
                      </div>
                      <button
                        className="button secondary compact"
                        type="button"
                        onClick={() => setConversationDetail(null)}
                      >
                        {t.close}
                      </button>
                    </div>
                    <div className="message-list">
                      {conversationDetail.messages.map((message) => (
                        <article key={message.id} className={`message-card ${message.role}`}>
                          <span className="mode-badge">
                            {message.role === "assistant"
                              ? message.mode === "ai_grounded"
                                ? t.aiGroundedMode
                                : t.sourceDraftMode
                              : t.yourQuestion}
                          </span>
                          <p>{message.text}</p>
                          {message.sources?.length > 0 ? (
                            <div className="source-pills">
                              {message.sources.slice(0, 3).map((source) => (
                                <span key={`${source.bookId}-${source.chunkIndex}`}>
                                  {source.bookTitle} · {getSourceLabel(source, t)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {workspaceTab === "help" ? (
              <div className="workspace-tab-panel">
                <section className="help-panel">
                  <div>
                    <h3>{t.helpAppTitle}</h3>
                    <p>{t.helpAppCopy}</p>
                  </div>
                  <div className="help-grid">
                    <article>
                      <h4>{t.helpUploadTitle}</h4>
                      <p>{t.helpUploadCopy}</p>
                    </article>
                    <article>
                      <h4>{t.helpAskTitle}</h4>
                      <p>{t.helpAskCopy}</p>
                    </article>
                    <article>
                      <h4>{t.helpPrivacyTitle}</h4>
                      <p>{t.helpPrivacyCopy}</p>
                    </article>
                    <article>
                      <h4>{t.helpVectorTitle}</h4>
                      <p>{t.helpVectorCopy}</p>
                    </article>
                  </div>
                </section>
                <form className="search-panel advanced-source-panel" onSubmit={searchExtractedText}>
                  <div>
                    <p className="eyebrow">{t.advancedTool}</p>
                    <h3>{t.searchTitle}</h3>
                    <p>{t.searchCopy}</p>
                    <p className="advanced-source-warning">{t.searchNoAiWarning}</p>
                  </div>
                  <label>
                    {t.bookScope}
                    <select
                      value={selectedBookScope}
                      onChange={(event) => setSelectedBookScope(event.target.value)}
                      disabled={textReadyBooks.length === 0}
                    >
                      <option value="">{t.allReadyBooks}</option>
                      {textReadyBooks.map((book) => (
                        <option key={book.id} value={book.id}>
                          {book.displayTitle}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t.searchLabel}
                    <input
                      type="search"
                      value={searchQuestion}
                      onChange={(event) => setSearchQuestion(event.target.value)}
                      placeholder={t.searchPlaceholder}
                      disabled={textReadyBooks.length === 0}
                    />
                  </label>
                  <button
                    className="button secondary"
                    type="submit"
                    disabled={
                      !emailVerified ||
                      searchBusy ||
                      textReadyBooks.length === 0 ||
                      !searchQuestion.trim()
                    }
                  >
                    {searchBusy ? t.searching : t.searchButton}
                  </button>
                  {textReadyBooks.length === 0 ? (
                    <p className="small-note">{t.searchNeedsText}</p>
                  ) : null}
                  {searchMessage ? <p className="error-text">{searchMessage}</p> : null}
                  {searchResults.length > 0 ? (
                    <div className="search-results" ref={sourceSearchResultsRef}>
                      <div className="search-results-header">
                        <h4>{t.sourcePassagesTitle}</h4>
                        <span>{t.noAiBadge}</span>
                      </div>
                      {searchResults.map((result) => (
                        <article key={`${result.bookId}-${result.chunkIndex}`}>
                          <h4>{result.bookTitle}</h4>
                          <p>{result.excerpt}</p>
                          <span>
                            {getSourceLabel(result, t)}
                          </span>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </form>
              </div>
            ) : null}
          </section>

          <section id="account" className="account-section workspace-account">
            <div>
              <p className="eyebrow">{t.navAccount}</p>
              <h2>{t.accountTitle}</h2>
              <p>
                {t.signedInAs}: <strong>{user.email}</strong>
              </p>
            </div>

            <form className="profile-panel" onSubmit={saveDisplayName}>
              <div>
                <h3>{t.profileTitle}</h3>
                <p>{t.profileCopy}</p>
              </div>
              <label>
                {t.displayName}
                <input
                  type="text"
                  value={profileDisplayName}
                  onChange={(event) => setProfileDisplayName(event.target.value)}
                  placeholder={t.displayNamePlaceholder}
                  maxLength={40}
                />
              </label>
              <button
                className="button primary compact"
                type="submit"
                disabled={accountBusy}
              >
                {accountBusy ? t.loading : t.saveProfile}
              </button>
              {profileMessage ? <p className="small-note">{profileMessage}</p> : null}
            </form>

            <section id="billing" className="account-security-panel">
              <div className="section-heading">
                <div>
                  <h3>{t.billingTitle}</h3>
                  <p>{t.billingCopy}</p>
                </div>
              </div>
              <ul className="usage-list">
                <li>
                  {t.billingCurrentPlan}: {usage.plan.toUpperCase()}
                </li>
                <li>
                  {t.billingSubscriptionStatus}: {usage.subscriptionStatus}
                </li>
              </ul>
              <div className="book-actions billing-actions">
                {renderBillingActions()}
              </div>
              <p className="small-note">{t.billingTestMode}</p>
              {billingMessage ? <p className="error-text">{billingMessage}</p> : null}
            </section>

            <section className="account-security-panel">
              <div className="section-heading">
                <div>
                  <h3>{t.accountAccessTitle}</h3>
                  <p>{t.accountAccessCopy}</p>
                </div>
              </div>
              {user.providerData.some((provider) => provider.providerId === "password") ? (
                <>
                  <form className="profile-panel" onSubmit={changeAccountPassword}>
                    <div>
                      <h4>{t.passwordChangeTitle}</h4>
                      <p>{t.passwordChangeCopy}</p>
                    </div>
                    <label>
                      {t.currentPassword}
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={passwordChangeCurrent}
                        onChange={(event) => setPasswordChangeCurrent(event.target.value)}
                      />
                    </label>
                    <label>
                      {t.newPassword}
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={passwordChangeNew}
                        onChange={(event) => setPasswordChangeNew(event.target.value)}
                        minLength={8}
                      />
                    </label>
                    <label>
                      {t.repeatNewPassword}
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={passwordChangeRepeat}
                        onChange={(event) => setPasswordChangeRepeat(event.target.value)}
                        minLength={8}
                      />
                    </label>
                    <button
                      className="button secondary"
                      type="submit"
                      disabled={
                        accountBusy ||
                        !passwordChangeCurrent ||
                        !passwordChangeNew ||
                        !passwordChangeRepeat
                      }
                    >
                      {accountBusy ? t.loading : t.saveNewPassword}
                    </button>
                  </form>
                  <button
                    className="auth-text-button"
                    type="button"
                    disabled={accountBusy}
                    onClick={() => void sendPasswordChangeEmail()}
                  >
                    {t.sendPasswordChangeEmail}
                  </button>
                </>
              ) : (
                <p className="small-note">{t.passwordChangeProviderNote}</p>
              )}

              <form className="profile-panel" onSubmit={requestAccountEmailChange}>
                <div>
                  <h4>{t.emailChangeTitle}</h4>
                  <p>{t.emailChangeCopy}</p>
                </div>
                <label>
                  {t.newEmail}
                  <input
                    type="email"
                    autoComplete="email"
                    value={accountEmailChange}
                    onChange={(event) => setAccountEmailChange(event.target.value)}
                    placeholder={user.email ?? t.email}
                  />
                </label>
                {user.providerData.some((provider) => provider.providerId === "password") ? (
                  <label>
                    {t.currentPassword}
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={accountEmailChangePassword}
                      onChange={(event) => setAccountEmailChangePassword(event.target.value)}
                    />
                  </label>
                ) : null}
                {user.providerData.some((provider) => provider.providerId === "google.com") ? (
                  <p className="small-note">{t.emailChangeGoogleReauth}</p>
                ) : null}
                <button
                  className="button secondary"
                  type="submit"
                  disabled={
                    accountBusy ||
                    !accountEmailChange.trim() ||
                    (user.providerData.some((provider) => provider.providerId === "password") &&
                      !accountEmailChangePassword)
                  }
                >
                  {accountBusy ? t.loading : t.sendEmailChangeVerification}
                </button>
              </form>
            </section>

            <button className="button secondary" type="button" onClick={() => void handleSignOut()} disabled={signingOut}>
              {signingOut ? t.loading : t.signOut}
            </button>
            <section className="account-security-panel">
              <div className="section-heading">
                <div>
                  <h3>{t.securityTitle}</h3>
                  <p>{t.securityCopy}</p>
                </div>
                <button
                  className="button secondary compact"
                  type="button"
                  disabled={accountBusy}
                  onClick={() => void loadAccountSecurity()}
                >
                  {t.refreshSecurity}
                </button>
              </div>
              {securityMessage ? <p className="error-text">{securityMessage}</p> : null}
              {accountSessions.length === 0 ? (
                <p className="small-note">{t.noLoginSessions}</p>
              ) : (
                <div className="session-list">
                  {accountSessions.map((session) => (
                    <article key={session.id}>
                      <strong>{session.device}</strong>
                      <p>
                        {session.browser} · {session.os}
                      </p>
                      <p>
                        {session.locationLabel} · {formatDateTime(session.lastSeenAtMs, locale)}
                      </p>
                      <span className={`status-pill status-${session.status}`}>
                        {session.status}
                      </span>
                    </article>
                  ))}
                </div>
              )}
            </section>
            <div className="privacy-actions">
              <div className="privacy-actions-copy">
                <h3>{t.privacyDataTitle}</h3>
                <p>{t.privacyDataCopy}</p>
              </div>
              <button
                className="button secondary"
                type="button"
                disabled={accountBusy}
                onClick={exportMyData}
              >
                {t.exportData}
              </button>
              {confirmDeleteAccount ? (
                <div className="inline-confirm">
                  <p>{t.deleteAccountConfirm}</p>
                  {hasOpenStripeSubscription ? (
                    <div className="subscription-delete-block">
                      <h4>{t.deleteAccountSubscriptionTitle}</h4>
                      <p>{t.deleteAccountSubscriptionCopy}</p>
                      <button
                        className="button primary compact"
                        type="button"
                        disabled={Boolean(billingBusy)}
                        onClick={() => void openStripePortal()}
                      >
                        {billingBusy === "portal" ? t.loading : t.deleteAccountSubscriptionAction}
                      </button>
                    </div>
                  ) : null}
                  <label>
                    {t.deleteAccountPhraseLabel}
                    <input
                      type="text"
                      value={deleteConfirmationText}
                      onChange={(event) => setDeleteConfirmationText(event.target.value)}
                      placeholder={DELETE_CONFIRMATION_PHRASE}
                    />
                  </label>
                  {user.providerData.some((provider) => provider.providerId === "password") ? (
                    <label>
                      {t.deleteAccountPasswordLabel}
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={deleteAccountPassword}
                        onChange={(event) => setDeleteAccountPassword(event.target.value)}
                      />
                    </label>
                  ) : null}
                  {user.providerData.some((provider) => provider.providerId === "google.com") ? (
                    <p className="small-note">{t.deleteAccountGoogleReauth}</p>
                  ) : null}
                  <div className="book-actions">
                    <button
                      className="button danger"
                      type="button"
                      disabled={
                        accountBusy ||
                        hasOpenStripeSubscription ||
                        deleteConfirmationText.trim() !== DELETE_CONFIRMATION_PHRASE ||
                        (user.providerData.some((provider) => provider.providerId === "password") &&
                          !deleteAccountPassword)
                      }
                      onClick={deleteMyAccountData}
                    >
                      {accountBusy ? t.deletingAccount : t.deleteAccountData}
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={accountBusy}
                      onClick={() => {
                        setConfirmDeleteAccount(false);
                        setDeleteConfirmationText("");
                        setDeleteAccountPassword("");
                      }}
                    >
                      {t.cancel}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="button danger"
                  type="button"
                  disabled={accountBusy}
                  onClick={() => setConfirmDeleteAccount(true)}
                >
                  {t.deleteAccountData}
                </button>
              )}
            </div>
            {authError ? <p className="error-text">{authError}</p> : null}
          </section>
          {uploadPrepNoticeBook ? (
            <div className="modal-backdrop" role="presentation">
              <section
                className="modal-panel upload-prep-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="upload-prep-modal-title"
              >
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">{t.uploadPrepNoticeEyebrow}</p>
                    <h3 id="upload-prep-modal-title">{t.uploadPrepNoticeTitle}</h3>
                  </div>
                  <button
                    className="button compact secondary"
                    type="button"
                    aria-label={t.close}
                    onClick={dismissUploadPrepNotice}
                  >
                    ×
                  </button>
                </div>
                <p>
                  <strong>{uploadPrepNoticeBook.displayTitle}</strong>
                </p>
                <p>{t.uploadPrepNoticeCopy}</p>
                <p className="small-note">{t.uploadPrepNoticeAskCopy}</p>
                <div className="upload-progress compact-progress" role="status" aria-live="polite">
                  <div>
                    <strong>{getIngestionStageLabel(uploadPrepNoticeJob)}</strong>
                    <span>{uploadPrepNoticeProgress}%</span>
                  </div>
                  <progress value={uploadPrepNoticeProgress} max="100" />
                  <p>{getIngestionStageDetail(uploadPrepNoticeJob)}</p>
                </div>
                <div className="modal-actions">
                  <button className="button primary" type="button" onClick={continueInAskDuringUpload}>
                    {t.uploadPrepNoticeAskButton}
                  </button>
                  <button className="button secondary" type="button" onClick={dismissUploadPrepNotice}>
                    {t.uploadPrepNoticeStayButton}
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ReadWiseHub home">
          <img className="brand-mark" src={readWiseHubIcon} alt="" aria-hidden="true" />
          <span>
            <strong>ReadWiseHub</strong>
            <small>{t.brandTagline}</small>
          </span>
        </a>

        <nav className="top-nav" aria-label="Main navigation">
          <a href="#how">{t.navHow}</a>
          <a href="#pricing">{t.navPricing}</a>
          <a href="#help">{t.navHelp}</a>
        </nav>

        <div className="public-header-actions">
          {languageToggle}
          {themeToggle}
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">ReadWiseHub</p>
            <h1>{t.welcomeTitle}</h1>
            <p>{t.welcomeCopy}</p>
            <div className="hero-actions">
              <a className="button primary" href="#account">
                {t.primaryCta}
              </a>
              <a className="button secondary" href="#how">
                {t.secondaryCta}
              </a>
            </div>
          </div>
          <section id="account" className="account-section compact-account">
            <div>
              <h2>{t.signIn}</h2>
              <p>{t.authRequired}</p>
            </div>

            {!authReady ? (
              <p>Loading...</p>
            ) : (
              <div className="auth-panel">
                <form onSubmit={(event) => handlePasswordAuth(event, "signIn")}>
                  <label>
                    {t.email}
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    {t.password}
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      minLength={6}
                    />
                  </label>
                  <button
                    className="auth-text-button"
                    type="button"
                    onClick={sendPasswordReset}
                  >
                    {t.forgotPassword}
                  </button>
                  <div className="auth-actions">
                    <button className="button primary" type="submit">
                      {t.signIn}
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => submitPasswordAuth("signUp")}
                    >
                      {t.createAccount}
                    </button>
                  </div>
                </form>
                <button className="button google" type="button" onClick={handleGoogleAuth}>
                  {t.continueWithGoogle}
                </button>
                {authError ? <p className="error-text">{authError}</p> : null}
                {status === t.passwordResetSent ? (
                  <div className="auth-status-card success-text">
                    <h3>{t.passwordResetSentTitle}</h3>
                    <p>{status}</p>
                  </div>
                ) : status ? (
                  <p className="success-text">{status}</p>
                ) : null}
              </div>
            )}
          </section>
          <div className="preview-panel" aria-label="Product preview">
            <div className="chat-card user-card">Was sagt das Buch über Gewohnheiten?</div>
            <div className="chat-card answer-card">
              ReadWiseHub antwortet mit Quellen, damit du die Stelle wiederfindest.
            </div>
            <div className="source-row">
              <span>Quelle</span>
              <strong>Kapitel 2, Seite 41</strong>
            </div>
          </div>
        </section>

        <section className="controls-band" aria-label="Preferences">
          <label>
            {t.language}
            <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
              <option value="de">{t.german}</option>
              <option value="en">{t.english}</option>
            </select>
          </label>

          <label>
            {t.theme}
            <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
              <option value="light">{t.light}</option>
              <option value="dark">{t.dark}</option>
            </select>
          </label>
        </section>

        <section id="how" className="content-section">
          <h2>{t.howTitle}</h2>
          <p>{t.howCopy}</p>
          <div className="steps-grid">
            <article>
              <span>1</span>
              <h3>Upload</h3>
              <p>Start with one clear document and visible processing status.</p>
            </article>
            <article>
              <span>2</span>
              <h3>Ask</h3>
              <p>Use natural questions instead of technical commands.</p>
            </article>
            <article>
              <span>3</span>
              <h3>Check</h3>
              <p>Answers should point back to the source before advanced tools are added.</p>
            </article>
          </div>
        </section>

        <section id="pricing" className="content-section">
          <h2>{t.pricingTitle}</h2>
          <div className="plans-grid">
            <article>
              <h3>{t.freePlan}</h3>
              <p>{t.freePlanCopy}</p>
            </article>
            <article>
              <h3>{t.plusPlan}</h3>
              <p>{t.plusPlanCopy}</p>
            </article>
            <article>
              <h3>{t.proPlan}</h3>
              <p>{t.proPlanCopy}</p>
            </article>
            <article>
              <h3>{t.ultimatePlan}</h3>
              <p>{t.ultimatePlanCopy}</p>
            </article>
          </div>
        </section>

        {user ? (
          <section id="dashboard" className="dashboard-section">
            <h2>{t.dashboardTitle}</h2>
            <p>{t.dashboardEmpty}</p>
            <div className="dashboard-grid">
              <article>
                <h3>Free</h3>
                <p>1 book · 10 MB · 10 messages/month</p>
              </article>
              <article>
                <h3>Secure foundation</h3>
                <p>Account records are scoped to the signed-in user.</p>
              </article>
            </div>
          </section>
        ) : null}

        <section id="help" className="content-section help-section">
          <h2>{t.navHelp}</h2>
          <p>
            Ask questions in everyday language. The upload and chat workflow will be added after the
            account and ownership foundation is verified.
          </p>
        </section>
      </main>
    </div>
  );
}
