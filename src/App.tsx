import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FirebaseError } from "firebase/app";
import {
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
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
import { ref, uploadBytesResumable } from "firebase/storage";
import { auth, db, functions, googleProvider, storage } from "./firebase";
import { Locale, detectInitialLocale, dictionaries } from "./i18n";
import readWiseHubIcon from "./assets/readwisehub-icon.png";

type Theme = "light" | "dark";
type WorkspaceTab = "ask" | "library" | "read" | "history" | "help";

type BookRecord = {
  id: string;
  title: string;
  status: string;
  sizeBytes: number;
  chunkCount: number;
  pageCount: number;
  textLength: number;
  language: string;
  embeddedChunkCount: number;
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

type ReaderChunk = {
  id: string;
  chunkIndex: number;
  text: string;
};

type ReaderParagraph = {
  id: string;
  chunkIndexes: number[];
  text: string;
};

type ReaderSelection = {
  text: string;
  paragraphId: string;
};

type ReaderBookmark = {
  page: number;
  label: string;
  snippet: string;
  createdAt: number;
};

type LibrarySearchResult = {
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
};

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

type UserUsage = {
  messages: number;
  monthlyMessages: number;
  books: number;
  maxBooks: number;
  storageBytes: number;
  maxStorageBytes: number;
};

const UPLOAD_BACKEND_ENABLED = true;
const MAX_FREE_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

function shouldContinueParagraph(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  return !/[.!?]"?$/.test(trimmed) && !/[:;]$/.test(trimmed);
}

function formatReaderParagraphs(chunks: ReaderChunk[]): ReaderParagraph[] {
  const paragraphs: ReaderParagraph[] = [];
  let currentText = "";
  let currentIndexes: number[] = [];

  chunks.forEach((chunk) => {
    const parts = chunk.text
      .split(/\n{2,}/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    parts.forEach((part) => {
      if (!currentText) {
        currentText = part;
        currentIndexes = [chunk.chunkIndex];
        return;
      }

      if (shouldContinueParagraph(currentText)) {
        currentText = `${currentText} ${part}`;
        currentIndexes = Array.from(new Set([...currentIndexes, chunk.chunkIndex]));
        return;
      }

      paragraphs.push({
        id: `${currentIndexes[0]}-${paragraphs.length}`,
        chunkIndexes: currentIndexes,
        text: currentText,
      });
      currentText = part;
      currentIndexes = [chunk.chunkIndex];
    });
  });

  if (currentText) {
    paragraphs.push({
      id: `${currentIndexes[0]}-${paragraphs.length}`,
      chunkIndexes: currentIndexes,
      text: currentText,
    });
  }

  return paragraphs;
}

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

async function ensureUserRecord(user: User, locale: Locale, theme: Theme) {
  const userRef = doc(db, "users", user.uid);
  const existing = await getDoc(userRef);

  if (existing.exists()) {
    await setDoc(
      userRef,
      {
        displayName: user.displayName ?? existing.data().displayName ?? "",
        photoURL: user.photoURL ?? existing.data().photoURL ?? "",
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
      locale,
      theme,
      limits: {
        maxBooks: 2,
        maxStorageBytes: 20 * 1024 * 1024,
        maxFileBytes: 20 * 1024 * 1024,
        monthlyMessages: 20,
        monthlyIngestions: 2,
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
    return error.message
      ? `${fallback}: ${error.message} (${error.code})`
      : `${fallback} (${error.code})`;
  }

  if (error instanceof Error && error.message) {
    return `${fallback} (${error.message})`;
  }

  return fallback;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => detectInitialLocale());
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [status, setStatus] = useState("");
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [booksReady, setBooksReady] = useState(false);
  const [ingestionJobs, setIngestionJobs] = useState<IngestionJobRecord[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [processBusy, setProcessBusy] = useState(false);
  const [searchQuestion, setSearchQuestion] = useState("");
  const [searchMessage, setSearchMessage] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<LibrarySearchResult[]>([]);
  const [askQuestion, setAskQuestion] = useState("");
  const [askMessage, setAskMessage] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askAnswer, setAskAnswer] = useState("");
  const [askMode, setAskMode] = useState("");
  const [askSources, setAskSources] = useState<LibrarySearchResult[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsReady, setConversationsReady] = useState(false);
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null);
  const [conversationDetailBusyId, setConversationDetailBusyId] = useState("");
  const [selectedBookScope, setSelectedBookScope] = useState("");
  const [deleteBusyId, setDeleteBusyId] = useState("");
  const [confirmDeleteBookId, setConfirmDeleteBookId] = useState("");
  const [deleteConversationBusyId, setDeleteConversationBusyId] = useState("");
  const [lastUploadedBookId, setLastUploadedBookId] = useState("");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("ask");
  const [processingBookId, setProcessingBookId] = useState("");
  const [selectedBookDetailId, setSelectedBookDetailId] = useState("");
  const [bookChunkPreviews, setBookChunkPreviews] = useState<BookChunkPreview[]>([]);
  const [bookDetailMessage, setBookDetailMessage] = useState("");
  const [readerBookId, setReaderBookId] = useState("");
  const [readerChunks, setReaderChunks] = useState<ReaderChunk[]>([]);
  const [readerPage, setReaderPage] = useState(0);
  const [readerTotalChunks, setReaderTotalChunks] = useState(0);
  const [readerBusy, setReaderBusy] = useState(false);
  const [readerMessage, setReaderMessage] = useState("");
  const [readerHighlights, setReaderHighlights] = useState<Record<string, string>>({});
  const [readerSelection, setReaderSelection] = useState<ReaderSelection | null>(null);
  const [readerAskBusy, setReaderAskBusy] = useState(false);
  const [readerAskAnswer, setReaderAskAnswer] = useState("");
  const [readerAskMode, setReaderAskMode] = useState("");
  const [readerAskSources, setReaderAskSources] = useState<LibrarySearchResult[]>([]);
  const [readerAskQuestion, setReaderAskQuestion] = useState("");
  const [readerReturnParagraphId, setReaderReturnParagraphId] = useState("");
  const [readerReturnScrollY, setReaderReturnScrollY] = useState<number | null>(null);
  const [readerBookmarkMessage, setReaderBookmarkMessage] = useState("");
  const [readerBookmarks, setReaderBookmarks] = useState<ReaderBookmark[]>([]);
  const [readerBookmarkMenuOpen, setReaderBookmarkMenuOpen] = useState(false);
  const [readerScrollNavVisible, setReaderScrollNavVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [usage, setUsage] = useState<UserUsage>({
    messages: 0,
    monthlyMessages: 20,
    books: 0,
    maxBooks: 2,
    storageBytes: 0,
    maxStorageBytes: 20 * 1024 * 1024,
  });

  const t = useMemo(() => dictionaries[locale], [locale]);
  const textReadyBooks = useMemo(
    () => books.filter((book) => book.status === "text_ready"),
    [books]
  );
  const activeBookIds = useMemo(() => new Set(books.map((book) => book.id)), [books]);
  const jobsByBookId = useMemo(() => {
    const jobs = new Map<string, IngestionJobRecord>();
    ingestionJobs.forEach((job) => jobs.set(job.bookId, job));
    return jobs;
  }, [ingestionJobs]);
  const readerPageSize = 8;
  const readerBook = useMemo(
    () => books.find((book) => book.id === readerBookId) ?? null,
    [books, readerBookId]
  );
  const readerParagraphs = useMemo(
    () => formatReaderParagraphs(readerChunks),
    [readerChunks]
  );
  const readerPageCount = Math.max(1, Math.ceil(readerTotalChunks / readerPageSize));
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
  const bookPageRef = useRef<HTMLDivElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const bookmarkMenuRef = useRef<HTMLDivElement | null>(null);
  const readerScrollTimeoutRef = useRef<number | null>(null);
  const activeStorageBytes = useMemo(
    () => books.reduce((total, book) => total + book.sizeBytes, 0),
    [books]
  );
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
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
      if (currentUser) {
        try {
          await ensureUserRecord(currentUser, locale, theme);
        } catch (error) {
          setAuthError(getErrorMessage(error, "Account sync failed"));
        }
      }
    });
  }, [locale, theme]);

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
                status: typeof data.status === "string" ? data.status : "unknown",
                sizeBytes:
                  typeof data.sizeBytes === "number" ? data.sizeBytes : 0,
                chunkCount:
                  typeof data.chunkCount === "number" ? data.chunkCount : 0,
                pageCount: typeof data.pageCount === "number" ? data.pageCount : 0,
                textLength: typeof data.textLength === "number" ? data.textLength : 0,
                language: typeof data.language === "string" ? data.language : "",
                embeddedChunkCount:
                  typeof data.embeddedChunkCount === "number" ? data.embeddedChunkCount : 0,
              };
            })
            .sort((left, right) => left.title.localeCompare(right.title))
        );
        setBooksReady(true);
      },
      (error) => {
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
        setAuthError(getErrorMessage(error, "Ingestion status sync failed"));
      }
    );
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
          messages: typeof current.messages === "number" ? current.messages : 0,
          monthlyMessages:
            typeof limits.monthlyMessages === "number" ? limits.monthlyMessages : 20,
          books:
            typeof current.books === "number"
              ? Math.max(current.books, books.length)
              : books.length,
          maxBooks: typeof limits.maxBooks === "number" ? limits.maxBooks : 2,
          storageBytes:
            typeof current.storageBytes === "number"
              ? Math.max(current.storageBytes, activeStorageBytes)
              : activeStorageBytes,
          maxStorageBytes:
            typeof limits.maxStorageBytes === "number"
              ? limits.maxStorageBytes
              : 20 * 1024 * 1024,
        });
      },
      (error) => {
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
        setAuthError(getErrorMessage(error, "Conversation sync failed"));
        setConversationsReady(true);
      }
    );
  }, [t.untitledQuestion, user]);

  useEffect(() => {
    if (!lastUploadedBookId) {
      return;
    }

    const uploadedBook = books.find((book) => book.id === lastUploadedBookId);
    if (!uploadedBook) {
      return;
    }

    if (uploadedBook.status === "text_ready") {
      setUploadMessage(`${t.uploadReady}: ${uploadedBook.title}`);
      setLastUploadedBookId("");
      return;
    }

    if (uploadedBook.status === "processing") {
      setUploadMessage(`${t.uploadProcessing}: ${uploadedBook.title}`);
    }
  }, [books, lastUploadedBookId, t.uploadProcessing, t.uploadReady]);

  useEffect(() => {
    if (!readerBookId) {
      setReaderHighlights({});
    }
  }, [readerBookId]);

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
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen, readerBookmarkMenuOpen]);

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
      await ensureUserRecord(credential.user, locale, theme);
      setStatus(t.userCreated);
    } catch (error) {
      setAuthError(getErrorMessage(error, t.authError));
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

  function handleFileSelection(file: File | undefined) {
    setUploadMessage("");

    if (!file) {
      setSelectedFile(null);
      return;
    }

    if (file.size > MAX_FREE_FILE_BYTES) {
      setSelectedFile(null);
      setUploadMessage(t.fileTooLarge);
      return;
    }

    const extensionAllowed = /\.(pdf|txt|md|markdown)$/i.test(file.name);
    if (!ALLOWED_UPLOAD_TYPES.has(file.type) && !extensionAllowed) {
      setSelectedFile(null);
      setUploadMessage(t.fileTypeBlocked);
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

    setUploadBusy(true);
    setUploadMessage("");

    try {
      const createReservation = httpsCallable<
        { fileName: string; contentType: string; sizeBytes: number },
        { bookId: string; storagePath: string }
      >(functions, "createUploadReservation");
      const finalizeReservation = httpsCallable<
        { bookId: string },
        { bookId: string; jobId: string; status: string }
      >(functions, "finalizeUploadReservation");

      const reservation = await createReservation({
        fileName: selectedFile.name,
        contentType: selectedFile.type || "application/octet-stream",
        sizeBytes: selectedFile.size,
      });
      const uploadRef = ref(storage, reservation.data.storagePath);
      const uploadTask = uploadBytesResumable(uploadRef, selectedFile, {
        contentType: selectedFile.type || "application/octet-stream",
      });

      await new Promise<void>((resolve, reject) => {
        uploadTask.on(
          "state_changed",
          undefined,
          reject,
          () => resolve()
        );
      });

      await finalizeReservation({ bookId: reservation.data.bookId });
      setSelectedFile(null);
      setLastUploadedBookId(reservation.data.bookId);
      setUploadMessage(t.uploadQueued);
    } catch (error) {
      setUploadMessage(getErrorMessage(error, "Upload failed"));
    } finally {
      setUploadBusy(false);
    }
  }

  async function processQueuedJobs() {
    if (!user) {
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
        await processJob({ jobId: jobDoc.id });
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

    const job = jobsByBookId.get(book.id);
    if (!job || (job.status !== "queued" && job.status !== "failed")) {
      setUploadMessage(t.noProcessableJob);
      return;
    }

    setProcessingBookId(book.id);
    setUploadMessage(`${t.uploadProcessing}: ${book.title}`);

    try {
      const processJob = httpsCallable<{ jobId: string }, { ok: boolean }>(
        functions,
        "processIngestionJob"
      );
      await processJob({ jobId: job.id });
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
    if (book.status === "upload_reserved") {
      return t.statusUploadReserved;
    }

    return book.status;
  }

  async function searchExtractedText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!searchQuestion.trim() || textReadyBooks.length === 0) {
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
      const response = await searchLibrary({
        query: searchQuestion.trim(),
        bookId: selectedBookScope || undefined,
      });
      const results = response.data.results ?? [];
      setSearchResults(results);
      setSearchMessage(results.length === 0 ? t.noSearchResults : "");
    } catch (error) {
      setSearchMessage(getErrorMessage(error, "Search failed"));
    } finally {
      setSearchBusy(false);
    }
  }

  async function askLibraryQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!askQuestion.trim() || textReadyBooks.length === 0) {
      return;
    }

    setAskBusy(true);
    setAskMessage("");
    setAskAnswer("");
    setAskMode("");
    setAskSources([]);

    try {
      const askLibrary = httpsCallable<
        { query: string; locale: Locale; bookId?: string },
        AskLibraryResponse
      >(functions, "askLibrary");
      const response = await askLibrary({
        query: askQuestion.trim(),
        locale,
        bookId: selectedBookScope || undefined,
      });
      setAskAnswer(response.data.answer);
      setAskMode(response.data.mode);
      setAskSources(response.data.results ?? []);
      setAskMessage(response.data.results.length === 0 ? t.noSearchResults : "");
    } catch (error) {
      setAskMessage(getErrorMessage(error, "Ask failed"));
    } finally {
      setAskBusy(false);
    }
  }

  async function deleteLibraryBook(book: BookRecord) {
    setDeleteBusyId(book.id);
    setConfirmDeleteBookId("");
    setUploadMessage("");

    try {
      const deleteBook = httpsCallable<{ bookId: string }, { ok: boolean }>(
        functions,
        "deleteBook"
      );
      await deleteBook({ bookId: book.id });
      if (selectedBookScope === book.id) {
        setSelectedBookScope("");
      }
      setUploadMessage(t.deleteDone);
    } catch (error) {
      setUploadMessage(getErrorMessage(error, "Delete failed"));
    } finally {
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
      await deleteConversation({ conversationId });
      setAskMessage(t.questionDeleted);
    } catch (error) {
      setAskMessage(getErrorMessage(error, "Delete failed"));
    } finally {
      setDeleteConversationBusyId("");
    }
  }

  async function openBookDetail(book: BookRecord) {
    setSelectedBookDetailId(book.id);
    setBookDetailMessage("");
    setBookChunkPreviews([]);

    try {
      const getBookDetail = httpsCallable<
        { bookId: string },
        { ok: boolean; chunks: BookChunkPreview[] }
      >(functions, "getBookDetail");
      const response = await getBookDetail({ bookId: book.id });
      setBookChunkPreviews(
        (response.data.chunks ?? [])
          .sort((left, right) => left.chunkIndex - right.chunkIndex)
          .slice(0, 12)
      );
    } catch (error) {
      setBookDetailMessage(getErrorMessage(error, "Book detail failed"));
    }
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

    setReaderBookId(book.id);
    setReaderPage(targetPage);
    setReaderBookmarks(bookmarks);
    setReaderHighlights(highlights);
    setReaderBookmarkMenuOpen(false);
    setReaderBusy(true);
    setReaderMessage("");
    setReaderChunks([]);
    setReaderSelection(null);
    setReaderAskAnswer("");
    setReaderAskMode("");
    setReaderAskSources([]);
    setReaderAskQuestion("");
    setReaderReturnParagraphId("");
    setReaderBookmarkMessage("");
    setWorkspaceTab("read");

    try {
      const getBookReader = httpsCallable<
        { bookId: string; page: number; pageSize: number },
        { ok: boolean; chunks: ReaderChunk[]; totalChunks: number }
      >(functions, "getBookReader");
      const response = await getBookReader({
        bookId: book.id,
        page: targetPage,
        pageSize: readerPageSize,
      });
      setReaderChunks(response.data.chunks ?? []);
      setReaderTotalChunks(response.data.totalChunks ?? 0);
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
    if (nextPage < 0 || nextPage * readerPageSize >= readerTotalChunks) {
      return;
    }

    void openBookReader(readerBook, nextPage);
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

  function parseReaderHighlightsValue(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, highlight]) => key.length <= 120 && typeof highlight === "string")
        .map(([key, highlight]) => [key, highlight.slice(0, 2000)])
        .slice(0, 200)
    );
  }

  async function saveReaderSettings(
    bookId: string,
    settings: {
      lastPage?: number;
      bookmarks?: ReaderBookmark[];
      highlights?: Record<string, string>;
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

  function goToReaderPage(page: number) {
    if (!readerBook) {
      return;
    }

    const nextPage = Math.min(Math.max(0, page), readerPageCount - 1);
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
    setReaderBookmarkMenuOpen(false);
    setReaderScrollNavVisible(false);
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

  function openMenuTab(tab: WorkspaceTab) {
    setWorkspaceTab(tab);
    closeMenu();
  }

  function captureReaderSelection() {
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

  function highlightReaderSelection() {
    if (!readerHighlightKey || !readerSelection) {
      return;
    }

    const nextHighlights = { ...readerHighlights };
    nextHighlights[`${readerSelection.paragraphId}-${Date.now()}`] = readerSelection.text;

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

    const question = `${t.askAboutPassagePrompt}\n\n"${readerSelection.text}"`;
    setReaderAskBusy(true);
    setReaderAskAnswer("");
    setReaderAskMode("");
    setReaderAskSources([]);
    setReaderAskQuestion(readerSelection.text);
    setReaderReturnParagraphId(readerSelection.paragraphId);
    setReaderReturnScrollY(window.scrollY);
    setReaderMessage("");

    try {
      const askLibrary = httpsCallable<
        { query: string; locale: Locale; bookId?: string },
        AskLibraryResponse
      >(functions, "askLibrary");
      const response = await askLibrary({
        query: question,
        locale,
        bookId: readerBook.id,
      });
      setReaderAskAnswer(response.data.answer);
      setReaderAskMode(response.data.mode);
      setReaderAskSources(response.data.results ?? []);
      setReaderSelection(null);
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      setReaderMessage(getErrorMessage(error, "Ask failed"));
    } finally {
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
      const response = await getConversationDetail({ conversationId });
      setConversationDetail({
        id: response.data.conversation.id,
        title: response.data.conversation.title,
        mode: response.data.conversation.mode,
        messages: response.data.messages ?? [],
      });
    } catch (error) {
      setAskMessage(getErrorMessage(error, "Question detail failed"));
    } finally {
      setConversationDetailBusyId("");
    }
  }

  async function backfillEmbeddings(book: BookRecord) {
    setProcessingBookId(book.id);
    setUploadMessage("");

    try {
      const backfillBookEmbeddings = httpsCallable<
        { bookId: string },
        { ok: boolean; embeddedChunkCount: number }
      >(functions, "backfillBookEmbeddings");
      const response = await backfillBookEmbeddings({ bookId: book.id });
      setUploadMessage(`${t.embeddingsReady}: ${response.data.embeddedChunkCount}`);
    } catch (error) {
      setUploadMessage(getErrorMessage(error, "Embedding failed"));
    } finally {
      setProcessingBookId("");
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
      const response = await exportAccountData({});
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
    setAccountBusy(true);
    setAuthError("");

    try {
      const deleteAccountData = httpsCallable<unknown, { ok: boolean }>(
        functions,
        "deleteAccountData"
      );
      await deleteAccountData({});
      await signOut(auth);
    } catch (error) {
      setAuthError(getErrorMessage(error, "Account delete failed"));
    } finally {
      setAccountBusy(false);
      setConfirmDeleteAccount(false);
    }
  }

  if (user) {
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
              <nav className="workspace-nav" aria-label="Workspace navigation">
                <a href="#dashboard" onClick={closeMenu}>
                  {t.navDashboard}
                </a>
                <a href="#library" onClick={() => openMenuTab("library")}>
                  {t.navLibrary}
                </a>
                <a href="#library" onClick={() => openMenuTab("read")}>
                  {t.tabRead}
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
                onClick={() => {
                  closeMenu();
                  void signOut(auth);
                }}
              >
                {t.signOut}
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
            </div>
          </section>

          <section id="library" className="content-section workspace-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{t.navLibrary}</p>
                <h2>{t.workspaceToolsTitle}</h2>
              </div>
            </div>

            <div className="workspace-tabs" aria-label={t.workspaceToolsTitle}>
              {(["ask", "library", "read", "history", "help"] as WorkspaceTab[]).map((tab) => (
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
                  accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                  onChange={(event) => handleFileSelection(event.target.files?.[0])}
                />
              </label>
              {selectedFile ? (
                <div className="selected-file">
                  {t.selectedFile}: <strong>{selectedFile.name}</strong>
                </div>
              ) : null}
              <button
                className="button primary"
                type="button"
                disabled={!selectedFile || uploadBusy || !UPLOAD_BACKEND_ENABLED}
                onClick={reserveAndUploadFile}
              >
                Upload
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={processBusy || books.every((book) => book.status !== "queued")}
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

            <form className="search-panel" onSubmit={searchExtractedText}>
              <div>
                <h3>{t.searchTitle}</h3>
                <p>{t.searchCopy}</p>
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
                      {book.title}
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
                className="button primary"
                type="submit"
                disabled={searchBusy || textReadyBooks.length === 0 || !searchQuestion.trim()}
              >
                {searchBusy ? t.searching : t.searchButton}
              </button>
              {textReadyBooks.length === 0 ? (
                <p className="small-note">{t.searchNeedsText}</p>
              ) : null}
              {searchMessage ? <p className="error-text">{searchMessage}</p> : null}
              {searchResults.length > 0 ? (
                <div className="search-results">
                  {searchResults.map((result) => (
                    <article key={`${result.bookId}-${result.chunkIndex}`}>
                      <h4>{result.bookTitle}</h4>
                      <p>{result.excerpt}</p>
                      <span>
                        {t.sourceChunk} {result.chunkIndex + 1}
                      </span>
                    </article>
                  ))}
                </div>
              ) : null}
            </form>

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
                  return (
                  <article key={book.id}>
                    <h3>{book.title}</h3>
                    <p className={`status-pill status-${book.status.replace(/_/g, "-")}`}>
                      {getBookStatusLabel(book)}
                    </p>
                    {job ? (
                      <div className="job-progress">
                        <span>{job.stage || job.status}</span>
                        <progress value={job.progress} max="100" />
                      </div>
                    ) : null}
                    {job?.errorMessageSafe ? (
                      <p className="error-text">{job.errorMessageSafe}</p>
                    ) : null}
                    {book.chunkCount > 0 ? <p>{book.chunkCount} chunks</p> : null}
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
                        disabled={processingBookId === book.id}
                        onClick={() => processBookJob(book)}
                      >
                        {processingBookId === book.id ? t.processingQueued : t.retryProcessing}
                      </button>
                    ) : null}
                    <div className="book-actions">
                      <button
                        className="button secondary compact"
                        type="button"
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
                      {book.status === "text_ready" && book.embeddedChunkCount < book.chunkCount ? (
                        <button
                          className="button secondary compact"
                          type="button"
                          disabled={processingBookId === book.id}
                          onClick={() => backfillEmbeddings(book)}
                        >
                          {processingBookId === book.id ? t.processingQueued : t.prepareVectorSearch}
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
                            disabled={deleteBusyId === book.id}
                            onClick={() => deleteLibraryBook(book)}
                          >
                            {deleteBusyId === book.id ? t.deletingBook : t.deleteBook}
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
                          disabled={deleteBusyId === book.id || book.status === "processing"}
                          onClick={() => setConfirmDeleteBookId(book.id)}
                        >
                          {deleteBusyId === book.id ? t.deletingBook : t.deleteBook}
                        </button>
                      </div>
                    )}
                  </article>
                  );
                })}
              </div>
            )}
            {selectedBookDetailId ? (
              <section className="book-detail-panel">
                {books
                  .filter((book) => book.id === selectedBookDetailId)
                  .map((book) => (
                    <div key={book.id}>
                      <div className="section-heading">
                        <div>
                          <p className="eyebrow">{t.bookDetails}</p>
                          <h3>{book.title}</h3>
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
                          <dt>{t.language}</dt>
                          <dd>{book.language || "unknown"}</dd>
                        </div>
                        <div>
                          <dt>{t.vectorReady}</dt>
                          <dd>
                            {book.embeddedChunkCount > 0
                              ? `${book.embeddedChunkCount}/${book.chunkCount}`
                              : t.notReadyYet}
                          </dd>
                        </div>
                      </dl>
                      {bookDetailMessage ? <p className="error-text">{bookDetailMessage}</p> : null}
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
                  ))}
              </section>
            ) : null}

              </div>
            ) : null}

            {workspaceTab === "read" ? (
              <div className="workspace-tab-panel">
                <section className="reader-panel">
                  <div className="reader-header">
                    {readerBook ? (
                      <a className="reader-dashboard-link" href="#dashboard">
                        {t.readerNavigation}
                      </a>
                    ) : null}
                    <div className="reader-title-block">
                      <p className="eyebrow">{t.readerEyebrow}</p>
                      <h3>{readerBook ? readerBook.title : t.readerTitle}</h3>
                      <p>
                        {readerBook
                          ? `${t.page} ${readerPage + 1} / ${readerPageCount}`
                          : t.readerCopy}
                      </p>
                    </div>
                    {readerBook ? (
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
                          <span className="visually-hidden">{t.chapter}</span>
                          <select
                            value={readerPage}
                            onChange={(event) => goToReaderPage(Number(event.target.value))}
                            disabled={readerBusy || readerTotalChunks === 0}
                          >
                            {Array.from({ length: readerPageCount }, (_, index) => (
                              <option key={index} value={index}>
                                {t.chapter} {index + 1}
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
                            disabled={readerBusy || readerTotalChunks === 0}
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
                        <button
                          className="reader-icon-button"
                          type="button"
                          disabled={
                            readerBusy ||
                            readerTotalChunks === 0 ||
                            (readerPage + 1) * readerPageSize >= readerTotalChunks
                          }
                          onClick={() => turnReaderPage(1)}
                          aria-label={t.nextPage}
                          title={t.nextPage}
                        >
                          <span aria-hidden="true">→</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {readerBookmarkMessage ? (
                    <p className="success-text reader-bookmark-note">{readerBookmarkMessage}</p>
                  ) : null}

                  {!readerBook ? (
                    <div className="reader-book-picker">
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
                            {book.title}
                          </button>
                        ))
                      )}
                    </div>
                  ) : (
                    <>
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
                            disabled={readerAskBusy}
                            onClick={askReaderSelectionInline}
                          >
                            {readerAskBusy ? t.asking : t.askAboutSelection}
                          </button>
                        </div>
                      ) : null}
                      {readerAskAnswer || readerAskBusy ? (
                        <div className="reader-answer-popover">
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
                                  {source.bookTitle} · {t.sourceChunk} {source.chunkIndex + 1}
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
                        onTouchEnd={captureReaderSelection}
                      >
                        <div className="book-page-top">
                          <span>{readerBook.title}</span>
                          <span>
                            {t.page} {readerPage + 1}
                          </span>
                        </div>
                        {readerBusy ? <p>{t.loading}</p> : null}
                        {readerMessage ? <p className="error-text">{readerMessage}</p> : null}
                        {!readerBusy && readerParagraphs.length === 0 && !readerMessage ? (
                          <p className="small-note">{t.readerEmpty}</p>
                        ) : null}
                        {readerParagraphs.map((paragraph) => {
                          const paragraphHighlights = Object.values(readerHighlights).filter(
                            (highlight) =>
                              paragraph.text.toLowerCase().includes(highlight.toLowerCase())
                          );

                          return (
                            <article
                              key={paragraph.id}
                              id={`reader-passage-${paragraph.id}`}
                              className="reader-paragraph"
                            >
                              <p>
                                {getHighlightedParts(paragraph.text, paragraphHighlights).map(
                                  (part, index) =>
                                    part.highlighted ? (
                                      <mark key={index}>{part.text}</mark>
                                    ) : (
                                      <span key={index}>{part.text}</span>
                                    )
                                )}
                              </p>
                            </article>
                          );
                        })}
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
                          {Math.min(readerTotalChunks, readerPage * readerPageSize + 1)}-
                          {Math.min(readerTotalChunks, (readerPage + 1) * readerPageSize)} /
                          {readerTotalChunks} {t.chunks}
                        </span>
                        <button
                          className="reader-icon-button"
                          type="button"
                          disabled={
                            readerBusy ||
                            readerTotalChunks === 0 ||
                            (readerPage + 1) * readerPageSize >= readerTotalChunks
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
                      {book.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.askLabel}
                <input
                  type="search"
                  value={askQuestion}
                  onChange={(event) => setAskQuestion(event.target.value)}
                  placeholder={t.askPlaceholder}
                  disabled={textReadyBooks.length === 0}
                />
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={askBusy || textReadyBooks.length === 0 || !askQuestion.trim()}
              >
                {askBusy ? t.asking : t.askButton}
              </button>
              {textReadyBooks.length === 0 ? (
                <p className="small-note">{t.searchNeedsText}</p>
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
                  {askSources.length > 0 ? (
                    <div className="source-pills">
                      {askSources.slice(0, 3).map((source) => (
                        <span key={`${source.bookId}-${source.chunkIndex}`}>
                          {source.bookTitle} · {t.sourceChunk} {source.chunkIndex + 1}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </form>
              </div>
            ) : null}

            {workspaceTab === "history" ? (
              <div className="workspace-tab-panel">
            <section className="history-panel">
              <div>
                <h3>{t.historyTitle}</h3>
                <p>{t.historyCopy}</p>
              </div>
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
                  <section className="conversation-detail-panel">
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
                                  {source.bookTitle} · {t.sourceChunk} {source.chunkIndex + 1}
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

            <div className="controls-band inline-controls" aria-label="Preferences">
              <label>
                {t.language}
                <select
                  value={locale}
                  onChange={(event) => setLocale(event.target.value as Locale)}
                >
                  <option value="de">{t.german}</option>
                  <option value="en">{t.english}</option>
                </select>
              </label>

              <label>
                {t.theme}
                <select
                  value={theme}
                  onChange={(event) => setTheme(event.target.value as Theme)}
                >
                  <option value="light">{t.light}</option>
                  <option value="dark">{t.dark}</option>
                </select>
              </label>
            </div>

            <button className="button secondary" type="button" onClick={() => signOut(auth)}>
              {t.signOut}
            </button>
            <div className="privacy-actions">
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
                  <div className="book-actions">
                    <button
                      className="button danger"
                      type="button"
                      disabled={accountBusy}
                      onClick={deleteMyAccountData}
                    >
                      {accountBusy ? t.deletingAccount : t.deleteAccountData}
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={accountBusy}
                      onClick={() => setConfirmDeleteAccount(false)}
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
                {status ? <p className="success-text">{status}</p> : null}
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
          </div>
        </section>

        {user ? (
          <section id="dashboard" className="dashboard-section">
            <h2>{t.dashboardTitle}</h2>
            <p>{t.dashboardEmpty}</p>
            <div className="dashboard-grid">
              <article>
                <h3>Free</h3>
                <p>2 books · 20 MB · 20 messages/month</p>
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
