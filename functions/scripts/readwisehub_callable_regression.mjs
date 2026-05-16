import admin from "firebase-admin";

const PROJECT_ID = "readwisehub";
const API_KEY = "AIzaSyArbWHoYcBOP2ZVGL5BH7Kr-DsalktSoVY";
const REGION = "us-central1";
const CALLABLE_BASE_URL = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;
const runId = `readwisehub-regression-${Date.now()}`;
const email = `${runId}@example.invalid`;
const password = `Rwh-${Date.now()}-regression`;
const failures = [];
let uid = "";
let idToken = "";
let primaryBookId = "";
let accountDeleteBookId = "";
let accountDeleteConversationId = "";

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
  primaryBookId = `${uid}-book`;
  accountDeleteBookId = `${uid}-account-delete-book`;
  accountDeleteConversationId = `${uid}-account-delete-conversation`;
}

async function callFunction(name, data, idToken) {
  const response = await fetch(`${CALLABLE_BASE_URL}/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error) {
    throw new Error(`${name} failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload.result;
}

async function clearBook(bookId) {
  const chunks = await db.collection("bookChunks").where("bookId", "==", bookId).get();
  const jobs = await db.collection("ingestionJobs").where("bookId", "==", bookId).get();
  const batch = db.batch();
  chunks.docs.forEach((doc) => batch.delete(doc.ref));
  jobs.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(db.collection("books").doc(bookId));
  await batch.commit();
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

  const conversations = await db.collection("conversations").where("userId", "==", uid).get();
  for (const conversation of conversations.docs) {
    await clearConversation(conversation.id);
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
    textLength: 1500,
    chunkCount: 2,
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
  });
  await batch.commit();
}

async function seedAccountDeleteData() {
  await seedBook(accountDeleteBookId, "Account Delete Regression Book");
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

async function run() {
  await createRegressionAuthUser();
  await seedUser();
  await seedBook(primaryBookId, "Callable Regression Book");

  const search = await callFunction(
    "searchLibrary",
    { query: "What does the lighthouse archive store?", bookId: primaryBookId },
    idToken
  );
  check(search.ok === true, "searchLibrary did not return ok.");
  check(search.results?.length > 0, "searchLibrary returned no source results.");
  check(search.results?.[0]?.bookId === primaryBookId, "searchLibrary returned the wrong book.");

  const ask = await callFunction(
    "askLibrary",
    { query: "What does the lighthouse archive store?", locale: "en", bookId: primaryBookId },
    idToken
  );
  check(ask.ok === true, "askLibrary did not return ok.");
  check(ask.mode === "ai_grounded", `askLibrary mode was ${ask.mode}, expected ai_grounded.`);
  check(Boolean(ask.conversationId), "askLibrary did not create a conversation.");
  check(ask.results?.length > 0, "askLibrary returned no sources.");

  const bookDetail = await callFunction("getBookDetail", { bookId: primaryBookId }, idToken);
  check(bookDetail.ok === true, "getBookDetail did not return ok.");
  check(bookDetail.book?.id === primaryBookId, "getBookDetail returned the wrong book.");
  check(bookDetail.chunks?.length === 2, "getBookDetail did not return chunk previews.");

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

  const deleteConversation = await callFunction(
    "deleteConversation",
    { conversationId: ask.conversationId },
    idToken
  );
  check(deleteConversation.ok === true, "deleteConversation did not return ok.");
  const deletedConversation = await db.collection("conversations").doc(ask.conversationId).get();
  check(!deletedConversation.exists, "deleteConversation left conversation document behind.");

  const deleteBook = await callFunction("deleteBook", { bookId: primaryBookId }, idToken);
  check(deleteBook.ok === true, "deleteBook did not return ok.");
  const deletedBook = await db.collection("books").doc(primaryBookId).get();
  const deletedChunks = await db.collection("bookChunks").where("bookId", "==", primaryBookId).get();
  check(!deletedBook.exists, "deleteBook left book document behind.");
  check(deletedChunks.empty, "deleteBook left chunk documents behind.");

  await seedAccountDeleteData();
  const deleteAccountData = await callFunction("deleteAccountData", {}, idToken);
  check(deleteAccountData.ok === true, "deleteAccountData did not return ok.");

  const remainingUser = await db.collection("users").doc(uid).get();
  const remainingBooks = await db.collection("books").where("userId", "==", uid).get();
  const remainingConversations = await db.collection("conversations").where("userId", "==", uid).get();
  const remainingChunks = await db.collection("bookChunks").where("userId", "==", uid).get();
  check(!remainingUser.exists, "deleteAccountData left user document behind.");
  check(remainingBooks.empty, "deleteAccountData left books behind.");
  check(remainingConversations.empty, "deleteAccountData left conversations behind.");
  check(remainingChunks.empty, "deleteAccountData left chunks behind.");

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
