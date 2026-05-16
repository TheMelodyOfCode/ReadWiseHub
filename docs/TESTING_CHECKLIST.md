# ReadWiseHub Testing Checklist

Run these checks from the ReadWiseHub repo, not from the private Vega parent repo.

## Before Code Changes

```bash
git -C /home/lobbygow/firebaseVegaPinecone/readwisehub status -sb
git -C /home/lobbygow/firebaseVegaPinecone/readwisehub diff --stat
git -C /home/lobbygow/firebaseVegaPinecone/readwisehub diff --check
```

## Local Build Checks

Use these before every commit:

```bash
npm --prefix /home/lobbygow/firebaseVegaPinecone/readwisehub run build
npm --prefix /home/lobbygow/firebaseVegaPinecone/readwisehub/functions run build
```

The frontend build currently warns about a JavaScript chunk larger than 500 kB. That warning is accepted for the MVP and should be addressed later with route or Firebase code splitting.

## Smoke Check

Use smoke after deploys and before handoff:

```bash
npm --prefix /home/lobbygow/firebaseVegaPinecone/readwisehub/functions run smoke
```

Smoke checks that:

- Hosting returns OK.
- At least one user exists.
- User book limits are not lower than active book count.
- Text-ready books have chunks.
- Sample chunk ownership matches book ownership.

## Callable Regression

Use regression when Functions, Firestore rules, retrieval, account export/delete, book deletion, or the OpenAI secret changes:

```bash
npm --prefix /home/lobbygow/firebaseVegaPinecone/readwisehub/functions run regression
```

Regression creates a disposable Firebase Auth user and synthetic Firestore test data, calls live deployed Functions, then deletes its own data.

It covers:

- `searchLibrary`
- `askLibrary`
- `getBookDetail`
- `getConversationDetail`
- `exportAccountData`
- `deleteConversation`
- `deleteBook`
- `deleteAccountData`

Expected result:

```text
ReadWiseHub callable regression passed.
```

Important: the regression calls live deployed Functions and OpenAI. It is intentionally not a unit test.

## Deploy Verification

After live deploys:

```bash
curl -sSI https://readwisehub.web.app
firebase functions:list --project readwisehub
firebase hosting:sites:list --project readwisehub
```

Expected:

- Hosting returns `HTTP/2 200`.
- Functions are listed in `us-central1`.
- Hosting site is `readwisehub`.

## Repo Boundary Check

Before final response:

```bash
git -C /home/lobbygow/firebaseVegaPinecone/readwisehub status -sb
git -C /home/lobbygow/firebaseVegaPinecone status -sb
git -C /home/lobbygow/firebaseVegaPinecone diff --stat
git -C /home/lobbygow/pinecone-sync status -sb
```

The private Vega parent repo may show:

```text
?? readwisehub/
```

That is expected because ReadWiseHub is a nested standalone git repo. Do not add it to the private Vega parent repo.
