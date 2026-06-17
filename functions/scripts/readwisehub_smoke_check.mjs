import admin from "firebase-admin";

admin.initializeApp({ projectId: "readwisehub" });

const db = admin.firestore();
const failures = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

const response = await fetch("https://readwisehub.web.app");
check(response.ok, `Hosting did not return OK: ${response.status}`);

const users = await db.collection("users").get();
check(!users.empty, "No users found.");

for (const user of users.docs) {
  const data = user.data();
  const books = await db.collection("books").where("userId", "==", user.id).get();
  const maxBooks = Number(data.limits?.maxBooks) || 0;
  const activeBooks = books.docs.filter((book) => book.get("planActive") !== false);

  check(
    maxBooks >= activeBooks.length,
    `${user.id} has ${activeBooks.length} active books but maxBooks is ${maxBooks}.`
  );

  for (const book of books.docs) {
    const bookData = book.data();
    check(bookData.userId === user.id, `${book.id} owner mismatch.`);

    if (bookData.status === "text_ready") {
      check(Number(bookData.chunkCount) > 0, `${book.id} is text_ready without chunks.`);

      const chunks = await db.collection("bookChunks").where("bookId", "==", book.id).limit(5).get();
      check(!chunks.empty, `${book.id} has no readable chunk docs.`);
      chunks.docs.forEach((chunk) => {
        check(chunk.get("userId") === user.id, `${chunk.id} chunk owner mismatch.`);
      });
    }
  }
}

if (failures.length > 0) {
  console.error("ReadWiseHub smoke check failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("ReadWiseHub smoke check passed.");
