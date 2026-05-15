export type Locale = "de" | "en";

type Dictionary = Record<string, string>;

export const dictionaries: Record<Locale, Dictionary> = {
  en: {
    brandTagline: "Read with clearer answers.",
    navHow: "How it works",
    navPricing: "Pricing",
    navHelp: "Help",
    navDashboard: "Dashboard",
    navLibrary: "Library",
    navAccount: "Account",
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
    libraryTitle: "Library",
    libraryEmptyTitle: "No books yet",
    libraryEmpty:
      "The upload pipeline is the next implementation step. For now, this library is ready to show only books that belong to your account.",
    uploadTitle: "Upload a document",
    uploadCopy:
      "Upload is prepared in the interface, but it stays locked until Firebase Storage is initialized and Functions can be deployed on Blaze.",
    uploadBlockedTitle: "Upload backend pending",
    uploadBlocked:
      "Firebase Storage and callable Functions must be live before files can be uploaded safely.",
    chooseFile: "Choose file",
    selectedFile: "Selected file",
    allowedFiles: "PDF, TXT, or Markdown up to 20 MB.",
    fileTooLarge: "This file is larger than the 20 MB Free limit.",
    fileTypeBlocked: "Only PDF, TXT, and Markdown files are allowed right now.",
    usageTitle: "Your Free limits",
    usageBooks: "2 books",
    usageStorage: "20 MB storage",
    usageMessages: "50 messages/month",
    nextStepTitle: "Next build step",
    nextStepCopy:
      "Add the controlled upload flow, ingestion job status, and document validation before chat is enabled.",
    accountTitle: "Account",
    signedInAs: "Signed in as",
    noBooks: "No books are connected to this account yet.",
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
    navLibrary: "Bibliothek",
    navAccount: "Konto",
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
    libraryTitle: "Bibliothek",
    libraryEmptyTitle: "Noch keine Bücher",
    libraryEmpty:
      "Die Upload-Strecke ist der nächste Umsetzungsschritt. Diese Bibliothek ist vorbereitet und zeigt später nur Bücher, die zu deinem Konto gehören.",
    uploadTitle: "Dokument hochladen",
    uploadCopy:
      "Der Upload ist in der Oberfläche vorbereitet, bleibt aber gesperrt, bis Firebase Storage eingerichtet ist und Functions auf Blaze deployt werden können.",
    uploadBlockedTitle: "Upload-Backend fehlt noch",
    uploadBlocked:
      "Firebase Storage und Callable Functions müssen live sein, bevor Dateien sicher hochgeladen werden können.",
    chooseFile: "Datei auswählen",
    selectedFile: "Ausgewählte Datei",
    allowedFiles: "PDF, TXT oder Markdown bis 20 MB.",
    fileTooLarge: "Diese Datei ist größer als das Free-Limit von 20 MB.",
    fileTypeBlocked: "Aktuell sind nur PDF, TXT und Markdown erlaubt.",
    usageTitle: "Deine Free-Grenzen",
    usageBooks: "2 Bücher",
    usageStorage: "20 MB Speicher",
    usageMessages: "50 Nachrichten/Monat",
    nextStepTitle: "Nächster Entwicklungsschritt",
    nextStepCopy:
      "Als Nächstes folgen kontrollierter Upload, Verarbeitungsstatus und Dokumentprüfung, bevor der Chat aktiviert wird.",
    accountTitle: "Konto",
    signedInAs: "Angemeldet als",
    noBooks: "Mit diesem Konto sind noch keine Bücher verbunden.",
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
