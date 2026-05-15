import { FormEvent, useEffect, useMemo, useState } from "react";
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

type BookRecord = {
  id: string;
  title: string;
  status: string;
  sizeBytes: number;
  chunkCount: number;
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
  conversationId: string;
  results: LibrarySearchResult[];
};

type ConversationRecord = {
  id: string;
  title: string;
  latestAnswerPreview: string;
  sourceCount: number;
  sourceBookIds: string[];
  hasUnavailableSources: boolean;
  unavailableBookTitles: string[];
  updatedAtMs: number;
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
        monthlyMessages: 50,
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
  const [askSources, setAskSources] = useState<LibrarySearchResult[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsReady, setConversationsReady] = useState(false);
  const [selectedBookScope, setSelectedBookScope] = useState("");
  const [deleteBusyId, setDeleteBusyId] = useState("");
  const [confirmDeleteBookId, setConfirmDeleteBookId] = useState("");
  const [deleteConversationBusyId, setDeleteConversationBusyId] = useState("");
  const [lastUploadedBookId, setLastUploadedBookId] = useState("");
  const [usage, setUsage] = useState<UserUsage>({
    messages: 0,
    monthlyMessages: 50,
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
  const userLabel = user?.displayName || user?.email?.split("@")[0] || t.userFallback;
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
            typeof limits.monthlyMessages === "number" ? limits.monthlyMessages : 50,
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

          <nav className="top-nav workspace-nav" aria-label="Workspace navigation">
            <a href="#dashboard">{t.navDashboard}</a>
            <a href="#library">{t.navLibrary}</a>
            <a href="#account">{t.navAccount}</a>
          </nav>

          <div className="user-header-actions">
            <span className="welcome-user">
              {t.welcomeBack}, <strong>{userLabel}</strong>
            </span>
            {languageToggle}
            <button
              className="button header-button"
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? t.light : t.dark}
            </button>
            <button className="button header-button" type="button" onClick={() => signOut(auth)}>
              {t.signOut}
            </button>
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

          <section id="library" className="content-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{t.navLibrary}</p>
                <h2>{t.libraryTitle}</h2>
              </div>
            </div>

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
                  <h4>{t.answerTitle}</h4>
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
                      <h4>{conversation.title}</h4>
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

            {!booksReady ? (
              <p>Loading...</p>
            ) : books.length === 0 ? (
              <div className="empty-state">
                <h3>{t.libraryEmptyTitle}</h3>
                <p>{t.libraryEmpty}</p>
              </div>
            ) : (
              <div className="book-list">
                {books.map((book) => (
                  <article key={book.id}>
                    <h3>{book.title}</h3>
                    <p>{book.status === "text_ready" ? t.textReady : book.status}</p>
                    {book.chunkCount > 0 ? <p>{book.chunkCount} chunks</p> : null}
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
                ))}
              </div>
            )}
          </section>

          <section className="content-section next-step-section">
            <h2>{t.nextStepTitle}</h2>
            <p>{t.nextStepCopy}</p>
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
          <button
            className="button header-button"
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? t.light : t.dark}
          </button>
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
                <p>2 books · 20 MB · 50 messages/month</p>
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
