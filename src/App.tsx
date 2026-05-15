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
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";
import { Locale, detectInitialLocale, dictionaries } from "./i18n";

type Theme = "light" | "dark";

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
        maxBooks: 1,
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
    return `${fallback} (${error.code})`;
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

  const t = useMemo(() => dictionaries[locale], [locale]);

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

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ReadWiseHub home">
          <span className="brand-mark">R</span>
          <span>
            <strong>ReadWiseHub</strong>
            <small>{t.brandTagline}</small>
          </span>
        </a>

        <nav className="top-nav" aria-label="Main navigation">
          <a href="#how">{t.navHow}</a>
          <a href="#pricing">{t.navPricing}</a>
          <a href="#help">{t.navHelp}</a>
          {user ? <a href="#dashboard">{t.navDashboard}</a> : null}
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">ReadWiseHub</p>
            <h1>{t.welcomeTitle}</h1>
            <p>{t.welcomeCopy}</p>
            <div className="hero-actions">
              <a className="button primary" href={user ? "#dashboard" : "#account"}>
                {t.primaryCta}
              </a>
              <a className="button secondary" href="#how">
                {t.secondaryCta}
              </a>
            </div>
          </div>
          <section id="account" className="account-section compact-account">
            <div>
              <h2>{user ? t.accountReady : t.signIn}</h2>
              <p>{user ? user.email : t.authRequired}</p>
            </div>

            {!authReady ? (
              <p>Loading...</p>
            ) : user ? (
              <button className="button secondary" type="button" onClick={() => signOut(auth)}>
                {t.signOut}
              </button>
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
                <p>1 book · 20 MB · 50 messages/month</p>
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
