import admin from "firebase-admin";

const PROJECT_ID = "readwisehub";
const API_KEY = "AIzaSyArbWHoYcBOP2ZVGL5BH7Kr-DsalktSoVY";
const REGION = "us-central1";
const CALLABLE_BASE_URL = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;
const runId = `readwisehub-regression-${Date.now()}`;
const email = `${runId}@example.invalid`;
const password = `Rwh-${Date.now()}-regression`;
const sessionId = `${runId}-session`;
const failures = [];
let uid = "";
let idToken = "";
let primaryBookId = "";
let structuredBookId = "";
let chapterOnlyBookId = "";
let accountDeleteBookId = "";
let accountDeleteConversationId = "";
let unverifiedUid = "";

admin.initializeApp({ projectId: PROJECT_ID });

const db = admin.firestore();
const auth = admin.auth();

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function createRegressionAuthUser() {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    }
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `Regression Auth user creation failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }

  uid = payload.localId;
  idToken = payload.idToken;
  globalThis.readWiseHubRegressionIdToken = idToken;
  await auth.updateUser(uid, { emailVerified: true });
  primaryBookId = `${uid}-book`;
  structuredBookId = `${uid}-structured-book`;
  chapterOnlyBookId = `${uid}-chapter-only-book`;
  accountDeleteBookId = `${uid}-account-delete-book`;
  accountDeleteConversationId = `${uid}-account-delete-conversation`;
}

async function callFunction(name, data, idToken) {
  const payloadData =
    idToken === globalThis.readWiseHubRegressionIdToken && data && typeof data === "object" && !("sessionId" in data)
      ? { ...data, sessionId }
      : data;
  const response = await fetch(`${CALLABLE_BASE_URL}/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: payloadData }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error) {
    throw new Error(`${name} failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload.result;
}

async function callFunctionExpectFailure(name, data, idToken) {
  const payloadData =
    idToken === globalThis.readWiseHubRegressionIdToken && data && typeof data === "object" && !("sessionId" in data)
      ? { ...data, sessionId }
      : data;
  const response = await fetch(`${CALLABLE_BASE_URL}/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: payloadData }),
  });
  const payload = await response.json().catch(() => ({}));

  if (response.ok && !payload.error) {
    throw new Error(`${name} unexpectedly succeeded.`);
  }

  return payload.error ?? payload;
}

async function clearBook(bookId) {
  const chunks = await db.collection("bookChunks").where("bookId", "==", bookId).get();
  const sections = await db.collection("bookSections").where("bookId", "==", bookId).get();
  const pages = await db.collection("bookPages").where("bookId", "==", bookId).get();
  const inlineMedia = await db.collection("bookInlineMedia").where("bookId", "==", bookId).get();
  const jobs = await db.collection("ingestionJobs").where("bookId", "==", bookId).get();
  const batch = db.batch();
  chunks.docs.forEach((doc) => batch.delete(doc.ref));
  sections.docs.forEach((doc) => batch.delete(doc.ref));
  pages.docs.forEach((doc) => batch.delete(doc.ref));
  inlineMedia.docs.forEach((doc) => batch.delete(doc.ref));
  jobs.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(db.collection("books").doc(bookId));
  await batch.commit();
}

async function writeReaderSettingsViaClient(bookId) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}/readerSettings/${bookId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          userId: { stringValue: uid },
          bookId: { stringValue: bookId },
          lastPage: { integerValue: "1" },
          bookmarks: {
            arrayValue: {
              values: [
                {
                  mapValue: {
                    fields: {
                      page: { integerValue: "1" },
                      label: { stringValue: "Page 2" },
                      snippet: { stringValue: "safe reader settings regression snippet" },
                      createdAt: { integerValue: String(Date.now()) },
                    },
                  },
                },
              ],
            },
          },
          highlights: {
            mapValue: {
              fields: {
                "chunk-1": { stringValue: "safe reader highlight regression text" },
              },
            },
          },
        },
      }),
    }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Reader settings Firestore client write failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
}

async function clearConversation(conversationId) {
  const messages = await db
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .get();
  const batch = db.batch();
  messages.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(db.collection("conversations").doc(conversationId));
  await batch.commit();
}

async function cleanup() {
  if (!uid) {
    return;
  }

  const books = await db.collection("books").where("userId", "==", uid).get();
  for (const book of books.docs) {
    await clearBook(book.id);
  }

  const artifacts = await db.collection("bookArtifacts").where("userId", "==", uid).get();
  for (const artifact of artifacts.docs) {
    await artifact.ref.delete();
  }

  const articleVersions = await db.collection("articleVersions").where("userId", "==", uid).get();
  for (const version of articleVersions.docs) {
    await version.ref.delete();
  }

  const articleDrafts = await db.collection("articleDrafts").where("userId", "==", uid).get();
  for (const draft of articleDrafts.docs) {
    await draft.ref.delete();
  }

  const conversations = await db.collection("conversations").where("userId", "==", uid).get();
  for (const conversation of conversations.docs) {
    await clearConversation(conversation.id);
  }

  const routeTraces = await db.collection("routeTraces").where("userId", "==", uid).get();
  for (const routeTrace of routeTraces.docs) {
    await routeTrace.ref.delete();
  }

  const readerSettings = await db
    .collection("users")
    .doc(uid)
    .collection("readerSettings")
    .get();
  for (const setting of readerSettings.docs) {
    await setting.ref.delete();
  }

  const sessions = await db.collection("userSessions").where("userId", "==", uid).get();
  for (const session of sessions.docs) {
    await session.ref.delete();
  }

  await db.collection("users").doc(uid).delete().catch(() => undefined);
  await auth.deleteUser(uid).catch(async () => {
    if (!idToken) {
      return;
    }

    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ idToken }),
    }).catch(() => undefined);
  });
  if (unverifiedUid) {
    const unverifiedSessions = await db
      .collection("userSessions")
      .where("userId", "==", unverifiedUid)
      .get();
    for (const session of unverifiedSessions.docs) {
      await session.ref.delete();
    }
    await db.collection("users").doc(unverifiedUid).delete().catch(() => undefined);
    await auth.deleteUser(unverifiedUid).catch(() => undefined);
  }
}

async function seedUser() {
  await db.collection("users").doc(uid).set({
    email,
    displayName: "ReadWiseHub Regression",
    photoURL: "",
    plan: "free",
    subscriptionStatus: "none",
    locale: "en",
    theme: "light",
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
      storageBytes: 4096,
      books: 1,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function seedBook(bookId, title) {
  await db.collection("books").doc(bookId).set({
    userId: uid,
    title,
    normalizedTitle: title.toLowerCase(),
    author: "",
    language: "en",
    status: "text_ready",
    sourceType: "regression",
    storagePath: "",
    originalFileName: `${title}.txt`,
    mimeType: "text/plain",
    sizeBytes: 4096,
    pageCount: 0,
    renderedPageCount: 1,
    originalPageView: true,
    derivedPageImagePrefix: `userDerived/${uid}/${bookId}/pages`,
    textLength: 1500,
    chunkCount: 2,
    sectionCount: 2,
    embeddedChunkCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    textReadyAt: admin.firestore.FieldValue.serverTimestamp(),
    planAtIngestion: "free",
  });

  const chunkTexts = [
    "ReadWiseHub regression source says the lighthouse archive stores coral maps, patient notes, and chapter summaries. The answer should mention coral maps from the lighthouse archive.",
    "The same regression document says calm reading tools should keep source citations visible, use friendly book scope labels, and avoid unsupported claims.",
  ];

  const batch = db.batch();
  chunkTexts.forEach((text, index) => {
    batch.set(db.collection("bookChunks").doc(`${bookId}_${index}`), {
      userId: uid,
      bookId,
      chunkIndex: index,
      text,
      textPreview: text.slice(0, 240),
      charStart: index * 1000,
      charEnd: index * 1000 + text.length,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(db.collection("bookSections").doc(`${bookId}_${index}`), {
      userId: uid,
      bookId,
      sectionIndex: index,
      title: index === 0 ? "Regression Section" : "",
      text,
      textPreview: text.slice(0, 300),
      paragraphStart: index,
      paragraphEnd: index,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (index === 0) {
      batch.set(db.collection("bookPages").doc(`${bookId}_0001`), {
        userId: uid,
        bookId,
        pageNumber: 1,
        storagePath: `userDerived/${uid}/${bookId}/pages/page-0001.jpg`,
        width: 900,
        height: 1200,
        contentType: "image/jpeg",
        sizeBytes: 12345,
        renderDpi: 144,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.set(db.collection("bookInlineMedia").doc(`${bookId}_0001_01`), {
        userId: uid,
        bookId,
        pageNumber: 1,
        sectionIndex: 0,
        mediaIndex: 1,
        kind: "image",
        storagePath: `userDerived/${uid}/${bookId}/pages/inline/page-0001-image-01.jpg`,
        width: 640,
        height: 360,
        contentType: "image/jpeg",
        sizeBytes: 23456,
        renderDpi: 144,
        bbox: [80, 120, 420, 320],
        confidence: "regression",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });
  await batch.commit();
}

async function seedStructuredBook() {
  await db.collection("books").doc(structuredBookId).set({
    userId: uid,
    title: "Structured Problems Regression Book",
    normalizedTitle: "structured problems regression book",
    author: "",
    language: "en",
    status: "text_ready",
    sourceType: "regression",
    storagePath: "",
    originalFileName: "structured-problems.txt",
    mimeType: "text/plain",
    sizeBytes: 8192,
    pageCount: 10,
    textLength: 4000,
    chunkCount: 10,
    sectionCount: 10,
    embeddedChunkCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    textReadyAt: admin.firestore.FieldValue.serverTimestamp(),
    planAtIngestion: "free",
  });

  const headings = [
    "Quantum Gravity",
    "Particle Masses",
    "Measurement Problem",
    "Turbulence",
    "Dark Energy",
    "Dark Matter",
    "Complexity",
    "Matter-Antimatter Asymmetry",
    "Friction",
    "Arrow of Time",
  ];
  const batch = db.batch();
  headings.forEach((heading, index) => {
    const text = `${index + 1}. ${heading}\n\nRegression text explaining why ${heading.toLowerCase()} is one of the major open problems.`;
    batch.set(db.collection("bookChunks").doc(`${structuredBookId}_${index}`), {
      userId: uid,
      bookId: structuredBookId,
      chunkIndex: index,
      text,
      textPreview: text.slice(0, 240),
      charStart: index * 1000,
      charEnd: index * 1000 + text.length,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(db.collection("bookSections").doc(`${structuredBookId}_${index}`), {
      userId: uid,
      bookId: structuredBookId,
      sectionIndex: index,
      title: `${index + 1}. ${heading}`,
      text,
      textPreview: text.slice(0, 300),
      paragraphStart: index,
      paragraphEnd: index,
      pageStart: index + 1,
      pageEnd: index + 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
}

async function seedChapterOnlyBook() {
  await db.collection("books").doc(chapterOnlyBookId).set({
    userId: uid,
    title: "The_restaurant_at_the_end_of_the_universe",
    displayTitle: "The Restaurant at the End of the Universe",
    normalizedTitle: "the restaurant at the end of the universe",
    author: "",
    language: "en",
    status: "text_ready",
    sourceType: "regression",
    storagePath: "",
    originalFileName: "The_restaurant_at_the_end_of_the_universe.md",
    mimeType: "text/markdown",
    sizeBytes: 8192,
    pageCount: 0,
    textLength: 4000,
    chunkCount: 12,
    sectionCount: 12,
    embeddedChunkCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    textReadyAt: admin.firestore.FieldValue.serverTimestamp(),
    planAtIngestion: "free",
  });

  const chapterTexts = [
    "## Chapter 1\n\nArthur tries to get tea from the Nutrimatic machine while the Heart of Gold drifts through danger.",
    "## Chapter 2\n\nWhere's Zaphod? Arthur and Trillian search the ship while Ford studies the damage and tries to understand the danger.",
    "## Chapter 3\n\nMarvin stands in a corridor while a massive tank threatens the building.",
    "## Chapter 4\n\nMilliways appears as travelers arrive at the restaurant near the end of time.",
    "## Chapter 5\n\nHotblack Desiato and Disaster Area become part of Ford's chaotic restaurant evening.",
    "## Chapter 6\n\nThe stuntship heads toward a star while the group scrambles for a way out.",
    "## Chapter 7\n\nThe teleporter sends the travelers into confusion and separates their paths.",
    "## Chapter 8\n\nThe Golgafrinchan ark reveals a civilization built on absurd priorities.",
    "## Chapter 9\n\nArthur and Ford confront the strange logic of prehistoric Earth.",
    "## Chapter 10\n\nThe colonists debate leaves, currency, and survival with impressive incompetence.",
    "## Chapter 11\n\nA new social order forms around committee meetings and misplaced certainty.",
    "## Chapter 12\n\nThe story closes with Earth history bending toward comic disaster.",
  ];
  const batch = db.batch();
  chapterTexts.forEach((text, index) => {
    batch.set(db.collection("bookChunks").doc(`${chapterOnlyBookId}_${index}`), {
      userId: uid,
      bookId: chapterOnlyBookId,
      chunkIndex: index,
      text,
      textPreview: text.slice(0, 240),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(db.collection("bookSections").doc(`${chapterOnlyBookId}_${index}`), {
      userId: uid,
      bookId: chapterOnlyBookId,
      sectionIndex: index,
      title: `Chapter ${index + 1}`,
      text,
      textPreview: text.slice(0, 300),
      paragraphStart: index,
      paragraphEnd: index,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
}

async function seedAccountDeleteData() {
  await seedBook(accountDeleteBookId, "Account Delete Regression Book");
  await seedArticleData(accountDeleteBookId, "account-delete");
  await db.collection("conversations").doc(accountDeleteConversationId).set({
    userId: uid,
    title: "Account delete regression conversation",
    mode: "source_draft",
    status: "answered",
    messageCount: 1,
    sourceCount: 0,
    sourceBookIds: [],
    sourceBookTitles: [],
    hasUnavailableSources: false,
    unavailableBookTitles: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db
    .collection("conversations")
    .doc(accountDeleteConversationId)
    .collection("messages")
    .doc("message")
    .set({
      userId: uid,
      role: "user",
      text: "safe account deletion regression message",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

async function seedArticleData(bookId, suffix = "primary") {
  const draftId = `${uid}-article-${suffix}`;
  const versionId = `${uid}-article-${suffix}-v1`;
  await db.collection("articleDrafts").doc(draftId).set({
    userId: uid,
    bookId,
    bookTitle: "Callable Regression Book",
    title: "Regression Article Draft",
    prompt: "Write a short regression article.",
    status: "draft",
    latestVersionId: versionId,
    versionCount: 1,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("articleVersions").doc(versionId).set({
    userId: uid,
    draftId,
    bookId,
    bookTitle: "Callable Regression Book",
    title: "Regression Article Draft",
    body: "Regression article body with source grounding.",
    versionNumber: 1,
    sourceSnapshots: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { draftId, versionId };
}

async function run() {
  await createRegressionAuthUser();
  await seedUser();
  await seedBook(primaryBookId, "Callable Regression Book");
  await seedStructuredBook();
  await seedChapterOnlyBook();
  const registeredSession = await callFunction(
    "registerLoginSession",
    {
      sessionId,
      browser: "Regression",
      os: "Node",
      device: "Callable regression",
      userAgent: "readwisehub-callable-regression",
    },
    idToken
  );
  check(registeredSession.ok === true, "registerLoginSession did not activate regression session.");

  const unverified = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: `unverified-${runId}@example.invalid`,
        password,
        returnSecureToken: true,
      }),
    }
  );
  const unverifiedPayload = await unverified.json();
  assert(unverified.ok, "Unverified regression user creation failed.");
  unverifiedUid = unverifiedPayload.localId;
  const unverifiedSessionId = `${runId}-unverified-session`;
  await callFunction(
    "registerLoginSession",
    {
      sessionId: unverifiedSessionId,
      browser: "Regression",
      os: "Node",
      device: "Unverified callable regression",
      userAgent: "readwisehub-callable-regression",
    },
    unverifiedPayload.idToken
  );
  const unverifiedSearch = await callFunctionExpectFailure(
    "searchLibrary",
    { query: "blocked before verification", bookId: primaryBookId, sessionId: unverifiedSessionId },
    unverifiedPayload.idToken
  );
  check(
    unverifiedSearch.status === "FAILED_PRECONDITION" ||
      unverifiedSearch.code === "failed-precondition",
    "Unverified user was not blocked by searchLibrary."
  );

  const search = await callFunction(
    "searchLibrary",
    { query: "What does the lighthouse archive store?", bookId: primaryBookId },
    idToken
  );
  check(search.ok === true, "searchLibrary did not return ok.");
  check(search.results?.length > 0, "searchLibrary returned no source results.");
  check(search.results?.[0]?.bookId === primaryBookId, "searchLibrary returned the wrong book.");
  const conversationsAfterSourceSearch = await db
    .collection("conversations")
    .where("userId", "==", uid)
    .get();
  check(
    conversationsAfterSourceSearch.empty,
    "searchLibrary created a conversation/history entry, but source lookup should not."
  );

  const ask = await callFunction(
    "askLibrary",
    { query: "What does the lighthouse archive store?", locale: "en", bookId: primaryBookId },
    idToken
  );
  check(ask.ok === true, "askLibrary did not return ok.");
  check(ask.mode === "ai_grounded", `askLibrary mode was ${ask.mode}, expected ai_grounded.`);
  check(Boolean(ask.conversationId), "askLibrary did not create a conversation.");
  check(ask.results?.length > 0, "askLibrary returned no sources.");
  const askConversation = await db.collection("conversations").doc(ask.conversationId).get();
  check(askConversation.exists, "askLibrary did not save the conversation document.");
  check(
    askConversation.get("mode") === "ai_grounded",
    `askLibrary saved mode ${askConversation.get("mode")}, expected ai_grounded.`
  );
  check(
    Boolean(askConversation.get("routeTraceId")),
    "askLibrary did not save a routeTraceId on the conversation."
  );
  const askMessages = await db
    .collection("conversations")
    .doc(ask.conversationId)
    .collection("messages")
    .get();
  check(askMessages.size >= 2, "askLibrary did not save user and assistant messages.");
  const routeTraceId = askConversation.get("routeTraceId");
  if (routeTraceId) {
    const routeTrace = await db.collection("routeTraces").doc(routeTraceId).get();
    check(routeTrace.exists, "askLibrary routeTraceId did not point to a route trace document.");
    check(
      routeTrace.get("answerMode") === "ai_grounded",
      `askLibrary route trace answerMode was ${routeTrace.get("answerMode")}, expected ai_grounded.`
    );
  }

  const bookDetail = await callFunction("getBookDetail", { bookId: primaryBookId }, idToken);
  check(bookDetail.ok === true, "getBookDetail did not return ok.");
  check(bookDetail.book?.id === primaryBookId, "getBookDetail returned the wrong book.");
  check(bookDetail.chunks?.length === 2, "getBookDetail did not return chunk previews.");

  const bookReader = await callFunction(
    "getBookReader",
    { bookId: primaryBookId, page: 0, pageSize: 4 },
    idToken
  );
  check(bookReader.ok === true, "getBookReader did not return ok.");
  check(bookReader.totalChunks === 2, "getBookReader returned the wrong total section count.");
  check(
    bookReader.chunks?.some((chunk) => chunk.text?.includes("lighthouse archive")),
    "getBookReader did not return readable chunk text."
  );
  check(bookReader.totalPageImages === 1, "getBookReader returned the wrong original page count.");
  check(
    bookReader.originalPage?.storagePath === `userDerived/${uid}/${primaryBookId}/pages/page-0001.jpg`,
    "getBookReader did not return owner-scoped original page metadata."
  );
  check(
    bookReader.inlineMedia?.some(
      (media) =>
        media.storagePath ===
        `userDerived/${uid}/${primaryBookId}/pages/inline/page-0001-image-01.jpg`
    ),
    "getBookReader did not return owner-scoped inline media metadata."
  );

  const sectionMap = await callFunction(
    "generateBookSectionMap",
    { bookId: primaryBookId, targetSectionCount: 3 },
    idToken
  );
  check(sectionMap.ok === true, "generateBookSectionMap did not return ok.");
  check(sectionMap.artifact?.type === "section_map", "generateBookSectionMap returned wrong artifact type.");
  check(
    sectionMap.artifact?.sections?.length > 0,
    "generateBookSectionMap returned no section map entries."
  );
  const listedArtifacts = await callFunction(
    "listBookArtifacts",
    { bookId: primaryBookId },
    idToken
  );
  check(listedArtifacts.ok === true, "listBookArtifacts did not return ok.");
  check(
    listedArtifacts.artifacts?.some((artifact) => artifact.id === sectionMap.artifact.id),
    "listBookArtifacts did not include generated section map."
  );
  const replacementSectionMap = await callFunction(
    "generateBookSectionMap",
    { bookId: primaryBookId, targetSectionCount: 3 },
    idToken
  );
  check(replacementSectionMap.ok === true, "replacement generateBookSectionMap did not return ok.");
  const listedArtifactsAfterReplacement = await callFunction(
    "listBookArtifacts",
    { bookId: primaryBookId },
    idToken
  );
  const listedArtifactIdsAfterReplacement = listedArtifactsAfterReplacement.artifacts?.map((artifact) => artifact.id) || [];
  check(
    listedArtifactIdsAfterReplacement.includes(replacementSectionMap.artifact.id),
    "listBookArtifacts did not include replacement section map."
  );
  check(
    !listedArtifactIdsAfterReplacement.includes(sectionMap.artifact.id),
    "listBookArtifacts included superseded section map."
  );
  const deleteBookArtifact = await callFunction(
    "deleteBookArtifact",
    { artifactId: replacementSectionMap.artifact.id },
    idToken
  );
  check(deleteBookArtifact.ok === true, "deleteBookArtifact did not return ok.");
  const listedArtifactsAfterDelete = await callFunction(
    "listBookArtifacts",
    { bookId: primaryBookId },
    idToken
  );
  const listedArtifactIdsAfterDelete = listedArtifactsAfterDelete.artifacts?.map((artifact) => artifact.id) || [];
  check(
    !listedArtifactIdsAfterDelete.includes(replacementSectionMap.artifact.id),
    "listBookArtifacts included deleted section map."
  );

  const naturalSectionMapAsk = await callFunction(
    "askLibrary",
    { query: "Please divide the book into 4 sections with titles.", locale: "en", bookId: primaryBookId },
    idToken
  );
  check(naturalSectionMapAsk.ok === true, "natural section-map askLibrary did not return ok.");
  check(
    naturalSectionMapAsk.mode === "ai_grounded",
    `natural section-map askLibrary mode was ${naturalSectionMapAsk.mode}, expected ai_grounded.`
  );
  const naturalMapConversation = await db.collection("conversations").doc(naturalSectionMapAsk.conversationId).get();
  check(naturalMapConversation.exists, "natural section-map askLibrary did not save a conversation.");
  check(
    naturalMapConversation.get("activeMode") === "section_map_created",
    `natural section-map activeMode was ${naturalMapConversation.get("activeMode")}.`
  );
  const naturalArtifactId = naturalMapConversation.get("activeArtifactId");
  check(Boolean(naturalArtifactId), "natural section-map conversation did not store an artifact id.");
  const naturalArtifact = naturalArtifactId
    ? await db.collection("bookArtifacts").doc(naturalArtifactId).get()
    : null;
  check(naturalArtifact?.exists, "natural section-map askLibrary did not create a section-map artifact.");
  check(
    naturalArtifact?.get("targetSectionCount") === 4,
    `natural section-map target count was ${naturalArtifact?.get("targetSectionCount")}.`
  );

  const sectionAsk = await callFunction(
    "askLibrary",
    { query: "Summarize section 2.", locale: "en", bookId: primaryBookId },
    idToken
  );
  check(sectionAsk.ok === true, "section-map askLibrary did not return ok.");
  check(
    sectionAsk.mode === "ai_grounded",
    `section-map askLibrary mode was ${sectionAsk.mode}, expected ai_grounded.`
  );
  check(Boolean(sectionAsk.conversationId), "section-map askLibrary did not create a conversation.");
  const sectionAskConversation = await db.collection("conversations").doc(sectionAsk.conversationId).get();
  check(sectionAskConversation.exists, "section-map askLibrary did not save the conversation document.");
  check(
    sectionAskConversation.get("activeMode") === "section_map",
    `section-map conversation activeMode was ${sectionAskConversation.get("activeMode")}.`
  );
  check(
    sectionAskConversation.get("activeArtifactId") === naturalArtifactId,
    "section-map conversation did not store the active artifact id."
  );
  check(
    sectionAskConversation.get("activeSectionNumber") === 2,
    "section-map conversation did not store the active section number."
  );
  const sectionRouteTraceId = sectionAskConversation.get("routeTraceId");
  if (sectionRouteTraceId) {
    const sectionRouteTrace = await db.collection("routeTraces").doc(sectionRouteTraceId).get();
    check(sectionRouteTrace.exists, "section-map routeTraceId did not point to a route trace document.");
    check(
      sectionRouteTrace.get("routeIntent") === "section_qa",
      `section-map route intent was ${sectionRouteTrace.get("routeIntent")}, expected section_qa.`
    );
    check(
      sectionRouteTrace.get("activeArtifactId") === naturalArtifactId,
      "section-map route trace did not store the active artifact id."
    );
  }

  const sectionFollowUp = await callFunction(
    "askLibrary",
    { query: "What evidence supports that?", locale: "en" },
    idToken
  );
  check(sectionFollowUp.ok === true, "section-map follow-up askLibrary did not return ok.");
  const sectionFollowUpConversation = await db
    .collection("conversations")
    .doc(sectionFollowUp.conversationId)
    .get();
  check(
    sectionFollowUpConversation.get("activeMode") === "section_map",
    `section-map follow-up activeMode was ${sectionFollowUpConversation.get("activeMode")}.`
  );
  check(
    sectionFollowUpConversation.get("activeArtifactId") === naturalArtifactId,
    "section-map follow-up did not inherit the active artifact id."
  );
  check(
    sectionFollowUpConversation.get("activeSectionNumber") === 2,
    "section-map follow-up did not inherit the active section number."
  );
  check(
    sectionFollowUpConversation.get("parentConversationId") === sectionAsk.conversationId,
    "section-map follow-up did not store the parent conversation id."
  );
  const sectionFollowUpRouteId = sectionFollowUpConversation.get("routeTraceId");
  if (sectionFollowUpRouteId) {
    const sectionFollowUpRoute = await db.collection("routeTraces").doc(sectionFollowUpRouteId).get();
    check(
      sectionFollowUpRoute.get("contextSource") === "latest_conversation",
      "section-map follow-up route trace did not record latest conversation context."
    );
  }

  const structuredMapAsk = await callFunction(
    "askLibrary",
    {
      query: "Please divide this book into 10 sections with titles.",
      locale: "en",
      bookId: structuredBookId,
    },
    idToken
  );
  check(structuredMapAsk.ok === true, "structured section-map askLibrary did not return ok.");
  const structuredMapConversation = await db.collection("conversations").doc(structuredMapAsk.conversationId).get();
  const structuredArtifactId = structuredMapConversation.get("activeArtifactId");
  const structuredArtifact = structuredArtifactId
    ? await db.collection("bookArtifacts").doc(structuredArtifactId).get()
    : null;
  const structuredTitles = structuredArtifact?.get("sections")?.map((section) => section.title) || [];
  check(
    structuredTitles.some((title) => /quantum gravity/i.test(title)) &&
      structuredTitles.some((title) => /(arrow|direction)\s+of\s+time/i.test(title)),
    `structured section-map titles were not heading-aware: ${structuredTitles.join(", ")}`
  );
  check(
    !structuredTitles.some((title) => /^(Chapter|Section|Part) \d+$/i.test(title)),
    `structured section-map included placeholder titles: ${structuredTitles.join(", ")}`
  );
  const structuredSummaries = structuredArtifact?.get("sections")?.map((section) => section.summary || "") || [];
  check(
    structuredSummaries.every((summary) => !/^\d{1,2}\.\s+/.test(summary)),
    `structured section-map summaries repeated heading prefixes: ${structuredSummaries.join(" | ")}`
  );

  const structuredMapAskEleven = await callFunction(
    "askLibrary",
    {
      query: "Please divide this book into 11 sections with titles.",
      locale: "en",
      bookId: structuredBookId,
    },
    idToken
  );
  check(structuredMapAskEleven.ok === true, "11-section structured map askLibrary did not return ok.");
  const structuredMapElevenConversation = await db
    .collection("conversations")
    .doc(structuredMapAskEleven.conversationId)
    .get();
  const structuredElevenArtifactId = structuredMapElevenConversation.get("activeArtifactId");
  const structuredElevenArtifact = structuredElevenArtifactId
    ? await db.collection("bookArtifacts").doc(structuredElevenArtifactId).get()
    : null;
  const structuredElevenTitles = structuredElevenArtifact?.get("sections")?.map((section) => section.title) || [];
  check(
    !structuredElevenTitles.includes("Here"),
    `11-section structured map accepted intro text as a title: ${structuredElevenTitles.join(", ")}`
  );

  const chapterOnlyMapAsk = await callFunction(
    "askLibrary",
    {
      query: "Please divide this book into 10 sections with titles.",
      locale: "en",
      bookId: chapterOnlyBookId,
    },
    idToken
  );
  check(chapterOnlyMapAsk.ok === true, "chapter-only section map askLibrary did not return ok.");
  const chapterOnlyMapConversation = await db
    .collection("conversations")
    .doc(chapterOnlyMapAsk.conversationId)
    .get();
  const chapterOnlyArtifactId = chapterOnlyMapConversation.get("activeArtifactId");
  const chapterOnlyArtifact = chapterOnlyArtifactId
    ? await db.collection("bookArtifacts").doc(chapterOnlyArtifactId).get()
    : null;
  const chapterOnlyTitles = chapterOnlyArtifact?.get("sections")?.map((section) => section.title) || [];
  check(
    chapterOnlyTitles.every((title) => !/^(Chapter|Section) \d+$/i.test(title)),
    `chapter-only section map returned generic titles: ${chapterOnlyTitles.join(", ")}`
  );

  await writeReaderSettingsViaClient(primaryBookId);
  const readerSettings = await db
    .collection("users")
    .doc(uid)
    .collection("readerSettings")
    .doc(primaryBookId)
    .get();
  check(readerSettings.exists, "Client reader settings write was not stored.");
  check(readerSettings.get("lastPage") === 1, "Client reader settings lastPage was not stored.");
  const seededArticle = await seedArticleData(primaryBookId);

  const conversationDetail = await callFunction(
    "getConversationDetail",
    { conversationId: ask.conversationId },
    idToken
  );
  check(conversationDetail.ok === true, "getConversationDetail did not return ok.");
  check(
    conversationDetail.messages?.some((message) => message.role === "assistant"),
    "getConversationDetail did not return assistant message."
  );

  const exportData = await callFunction("exportAccountData", {}, idToken);
  check(exportData.ok === true, "exportAccountData did not return ok.");
  check(exportData.books?.some((book) => book.id === primaryBookId), "exportAccountData missed book.");
  check(
    exportData.conversations?.some((conversation) => conversation.id === ask.conversationId),
    "exportAccountData missed conversation."
  );
  check(
    exportData.articleDrafts?.some((draft) => draft.id === seededArticle.draftId),
    "exportAccountData missed article draft."
  );
  check(
    exportData.articleVersions?.some((version) => version.id === seededArticle.versionId),
    "exportAccountData missed article version."
  );

  const deleteConversation = await callFunction(
    "deleteConversation",
    { conversationId: ask.conversationId },
    idToken
  );
  check(deleteConversation.ok === true, "deleteConversation did not return ok.");
  const deletedConversation = await db.collection("conversations").doc(ask.conversationId).get();
  check(!deletedConversation.exists, "deleteConversation left conversation document behind.");
  if (routeTraceId) {
    const deletedRouteTrace = await db.collection("routeTraces").doc(routeTraceId).get();
    check(!deletedRouteTrace.exists, "deleteConversation left route trace document behind.");
  }

  const deleteAllConversations = await callFunction(
    "deleteAllConversations",
    { confirmation: "delete complete history" },
    idToken
  );
  check(deleteAllConversations.ok === true, "deleteAllConversations did not return ok.");
  const remainingUserConversationsAfterHistoryDelete = await db
    .collection("conversations")
    .where("userId", "==", uid)
    .get();
  check(
    remainingUserConversationsAfterHistoryDelete.empty,
    "deleteAllConversations left conversations behind."
  );

  const deleteBook = await callFunction("deleteBook", { bookId: primaryBookId }, idToken);
  check(deleteBook.ok === true, "deleteBook did not return ok.");
  const deletedBook = await db.collection("books").doc(primaryBookId).get();
  const deletedChunks = await db.collection("bookChunks").where("bookId", "==", primaryBookId).get();
  const deletedSections = await db.collection("bookSections").where("bookId", "==", primaryBookId).get();
  const deletedPages = await db.collection("bookPages").where("bookId", "==", primaryBookId).get();
  const deletedInlineMedia = await db
    .collection("bookInlineMedia")
    .where("bookId", "==", primaryBookId)
    .get();
  const deletedArtifacts = await db.collection("bookArtifacts").where("bookId", "==", primaryBookId).get();
  const deletedArticleDrafts = await db
    .collection("articleDrafts")
    .where("bookId", "==", primaryBookId)
    .get();
  const deletedArticleVersions = await db
    .collection("articleVersions")
    .where("draftId", "==", seededArticle.draftId)
    .get();
  const deletedReaderSettings = await db
    .collection("users")
    .doc(uid)
    .collection("readerSettings")
    .doc(primaryBookId)
    .get();
  check(!deletedBook.exists, "deleteBook left book document behind.");
  check(deletedChunks.empty, "deleteBook left chunk documents behind.");
  check(deletedSections.empty, "deleteBook left section documents behind.");
  check(deletedPages.empty, "deleteBook left page documents behind.");
  check(deletedInlineMedia.empty, "deleteBook left inline media documents behind.");
  check(deletedArtifacts.empty, "deleteBook left generated artifacts behind.");
  check(deletedArticleDrafts.empty, "deleteBook left article drafts behind.");
  check(deletedArticleVersions.empty, "deleteBook left article versions behind.");
  check(!deletedReaderSettings.exists, "deleteBook left reader settings behind.");

  await seedAccountDeleteData();
  await writeReaderSettingsViaClient(accountDeleteBookId);
  const deleteWithoutPhrase = await callFunctionExpectFailure("deleteAccountData", {}, idToken);
  check(
    deleteWithoutPhrase.status === "FAILED_PRECONDITION" ||
      deleteWithoutPhrase.code === "failed-precondition",
    "deleteAccountData did not require the confirmation phrase."
  );
  const deleteAccountData = await callFunction(
    "deleteAccountData",
    { confirmationPhrase: "ReadWiseHub 2026" },
    idToken
  );
  check(deleteAccountData.ok === true, "deleteAccountData did not return ok.");

  const remainingUser = await db.collection("users").doc(uid).get();
  const remainingBooks = await db.collection("books").where("userId", "==", uid).get();
  const remainingConversations = await db.collection("conversations").where("userId", "==", uid).get();
  const remainingChunks = await db.collection("bookChunks").where("userId", "==", uid).get();
  const remainingSections = await db.collection("bookSections").where("userId", "==", uid).get();
  const remainingPages = await db.collection("bookPages").where("userId", "==", uid).get();
  const remainingInlineMedia = await db.collection("bookInlineMedia").where("userId", "==", uid).get();
  const remainingArtifacts = await db.collection("bookArtifacts").where("userId", "==", uid).get();
  const remainingArticleDrafts = await db.collection("articleDrafts").where("userId", "==", uid).get();
  const remainingArticleVersions = await db.collection("articleVersions").where("userId", "==", uid).get();
  const remainingSessions = await db.collection("userSessions").where("userId", "==", uid).get();
  const remainingRouteTraces = await db.collection("routeTraces").where("userId", "==", uid).get();
  const remainingReaderSettings = await db
    .collection("users")
    .doc(uid)
    .collection("readerSettings")
    .get();
  check(!remainingUser.exists, "deleteAccountData left user document behind.");
  check(remainingBooks.empty, "deleteAccountData left books behind.");
  check(remainingConversations.empty, "deleteAccountData left conversations behind.");
  check(remainingChunks.empty, "deleteAccountData left chunks behind.");
  check(remainingSections.empty, "deleteAccountData left sections behind.");
  check(remainingPages.empty, "deleteAccountData left page documents behind.");
  check(remainingInlineMedia.empty, "deleteAccountData left inline media documents behind.");
  check(remainingArtifacts.empty, "deleteAccountData left generated artifacts behind.");
  check(remainingArticleDrafts.empty, "deleteAccountData left article drafts behind.");
  check(remainingArticleVersions.empty, "deleteAccountData left article versions behind.");
  check(remainingSessions.empty, "deleteAccountData left sessions behind.");
  check(remainingRouteTraces.empty, "deleteAccountData left route traces behind.");
  check(remainingReaderSettings.empty, "deleteAccountData left reader settings behind.");

  if (failures.length > 0) {
    throw new Error(`Callable regression failed:\n- ${failures.join("\n- ")}`);
  }
}

try {
  await run();
  console.log("ReadWiseHub callable regression passed.");
} finally {
  await cleanup();
}
