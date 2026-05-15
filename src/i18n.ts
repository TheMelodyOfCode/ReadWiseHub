export type Locale = "de" | "en";

type Dictionary = Record<string, string>;

export const dictionaries: Record<Locale, Dictionary> = {
  en: {
    brandTagline: "Read with clearer answers.",
    navHow: "How it works",
    navPricing: "Pricing",
    navHelp: "Help",
    navDashboard: "Dashboard",
    signIn: "Sign in",
    signOut: "Sign out",
    createAccount: "Create account",
    email: "Email",
    password: "Password",
    continueWithGoogle: "Continue with Google",
    welcomeTitle: "Chat with your books without losing the source.",
    welcomeCopy:
      "ReadWiseHub will help readers upload documents, ask simple questions, and get grounded answers with citations.",
    primaryCta: "Open dashboard",
    secondaryCta: "See how it works",
    howTitle: "Simple by design",
    howCopy:
      "Upload a document, wait for processing, then ask natural questions. The first version will focus on one-book chat before advanced tools are added.",
    pricingTitle: "Start small, grow when you need more",
    freePlan: "Free",
    plusPlan: "Plus",
    proPlan: "Pro",
    freePlanCopy: "One small book, basic chat, and simple citations.",
    plusPlanCopy: "More books, chapter maps, summaries, and limited cross-book search.",
    proPlanCopy: "Advanced writing, follow-ups, priority processing, and deeper analysis.",
    dashboardTitle: "Your reading workspace",
    dashboardEmpty:
      "Upload and chat features are intentionally not active yet. This first build establishes secure sign-in, account records, language, and theme.",
    accountReady: "Account foundation is ready.",
    theme: "Theme",
    light: "Light",
    dark: "Dark",
    language: "Language",
    german: "Deutsch",
    english: "English",
    authRequired: "Sign in to open your dashboard.",
    authError: "Sign-in failed. Please check the details and try again.",
    userCreated: "Your ReadWiseHub account is ready.",
  },
  de: {
    brandTagline: "Lesen mit klareren Antworten.",
    navHow: "So funktioniert es",
    navPricing: "Preise",
    navHelp: "Hilfe",
    navDashboard: "Dashboard",
    signIn: "Anmelden",
    signOut: "Abmelden",
    createAccount: "Konto erstellen",
    email: "E-Mail",
    password: "Passwort",
    continueWithGoogle: "Mit Google fortfahren",
    welcomeTitle: "Chatte mit deinen Büchern, ohne die Quelle zu verlieren.",
    welcomeCopy:
      "ReadWiseHub soll Lesern helfen, Dokumente hochzuladen, einfache Fragen zu stellen und belegte Antworten mit Quellen zu erhalten.",
    primaryCta: "Dashboard öffnen",
    secondaryCta: "So funktioniert es",
    howTitle: "Einfach von Anfang an",
    howCopy:
      "Lade ein Dokument hoch, warte auf die Verarbeitung und stelle natürliche Fragen. Die erste Version konzentriert sich auf den Chat mit einem Buch, bevor erweiterte Werkzeuge folgen.",
    pricingTitle: "Klein starten, später erweitern",
    freePlan: "Free",
    plusPlan: "Plus",
    proPlan: "Pro",
    freePlanCopy: "Ein kleines Buch, einfacher Chat und klare Quellen.",
    plusPlanCopy: "Mehr Bücher, Kapitelkarten, Zusammenfassungen und begrenzte buchübergreifende Suche.",
    proPlanCopy: "Fortgeschrittenes Schreiben, Follow-ups, Priorität und tiefere Analyse.",
    dashboardTitle: "Dein Lesebereich",
    dashboardEmpty:
      "Upload und Chat sind bewusst noch nicht aktiv. Dieser erste Build legt sichere Anmeldung, Kontodaten, Sprache und Designmodus an.",
    accountReady: "Dein ReadWiseHub-Konto ist bereit.",
    theme: "Design",
    light: "Hell",
    dark: "Dunkel",
    language: "Sprache",
    german: "Deutsch",
    english: "English",
    authRequired: "Melde dich an, um dein Dashboard zu öffnen.",
    authError: "Die Anmeldung ist fehlgeschlagen. Bitte prüfe die Angaben und versuche es erneut.",
    userCreated: "Dein ReadWiseHub-Konto ist bereit.",
  },
};

export function detectInitialLocale(): Locale {
  const stored = window.localStorage.getItem("readwisehub_locale");
  if (stored === "de" || stored === "en") {
    return stored;
  }

  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}
