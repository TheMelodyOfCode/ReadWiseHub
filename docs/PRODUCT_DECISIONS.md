# ReadWiseHub Product Decisions

This document records near-term decisions so the public ReadWiseHub app does not drift into private Vega assumptions.

## Admin And Support Visibility

Current decision: do not build a full admin/support dashboard until the visibility policy is explicit.

Safe support view for MVP:

- user email
- plan and subscription status
- usage counters
- book count and storage total
- book titles and ingestion status
- failed ingestion error messages that are already marked safe
- timestamps needed for support

Not visible by default:

- full uploaded document text
- full chunk text
- full AI answers
- full user questions
- uploaded files
- account export payloads

Support access to private content should require a user-initiated support grant or a separate admin action that is logged. The product should show users what support can see before this exists.

Required before public launch:

- admin role model
- audit log for support/admin access
- support data minimization rules
- policy text in privacy/help pages

## Upload Robustness

Current upload support:

- PDF
- TXT
- Markdown
- 20 MB Free file limit
- ingestion status per book
- manual retry for queued/failed jobs

Next improvements:

- show original filename on book details
- show upload date and processed date
- show file type and file size in a clearer way
- show failed reason in a dedicated error state
- add an "ask this book" shortcut from book detail
- add page count when available
- keep failed books deletable
- preserve a clear retry path for failed ingestion jobs

Later format support:

- EPUB after text extraction and chapter metadata are designed
- DOCX after upload scanning and text extraction reliability are designed
- Kindle formats such as MOBI/AZW/AZW3/KFX after legal, DRM, and parser support are clarified

Kindle-specific caution:

- Do not claim support for DRM-protected Kindle purchases unless there is an explicit legal and technical path.
- Treat user-owned DRM-free Kindle files as a later import format candidate.
- Prefer EPUB first because it is more open and easier to validate.

Security requirements before adding more formats:

- virus/malware scanning
- stricter MIME and extension validation
- per-user ingestion throttling
- storage cleanup for abandoned upload reservations

## Retrieval Backend Decision

Current retrieval is Firestore-backed:

- extracted `bookChunks`
- lexical and phrase scoring
- OpenAI embeddings where available
- cosine similarity in Functions

This is acceptable for MVP validation, but it is not the long-term public launch architecture.

Recommended path:

1. Keep Firestore retrieval for the current private beta.
2. Add regression questions and quality checks for the two current test books.
3. Define target scale: users, books per user, chunks per book, and monthly questions.
4. Evaluate a dedicated vector backend before broader launch.

Likely production options:

- Pinecone for proven managed vector search and familiarity from private Vega.
- Vertex AI Vector Search if tighter Google Cloud integration becomes more important.
- Firestore vector search only if it meets the target scale and operational simplicity requirements at the time of decision.

Decision criteria:

- per-user data isolation
- metadata filtering by user and book
- deletion correctness
- cost at expected Free/Plus/Pro usage
- latency for cross-book questions
- operational simplicity
- regression testability

## Billing Sequence

Do not start billing enforcement before these are settled:

- Free limits are final enough for beta.
- Account deletion semantics are explicit, including Firebase Auth user deletion.
- Upload abuse controls are stronger.
- Retrieval backend direction is known.
- Admin/support visibility policy is written.

Recommended billing order:

1. Add read-only pricing and plan copy.
2. Define Free, Plus, and Pro limits in code and docs.
3. Add Stripe customer/subscription data model.
4. Add webhook handling.
5. Add server-side entitlement checks.
6. Add upgrade/downgrade UI.
7. Add billing regression checks.

## Reader Page Proposal

A reader page would let users read uploaded books inside ReadWiseHub instead of only asking questions.

Recommended MVP reader:

- add a `Read` action on each text-ready book
- show extracted text by chunk or section in a paper-like page view
- keep a sticky book title and search/ask shortcut
- allow "Ask about this passage" from a selected chunk
- show source chunk numbers so answers and reading view connect
- avoid rendering original PDFs in the first version unless PDF page mapping is reliable

Why extracted-text first:

- it works for PDF, TXT, and Markdown
- it reuses existing chunks
- it keeps implementation small
- it connects naturally to citations
- it avoids complex PDF page rendering and mobile zoom issues

Reader formatting approach:

- Fix obvious paragraph breaks at read time first, not by rewriting stored uploads.
- Merge adjacent chunks when a chunk ends mid-sentence.
- Preserve true blank-line paragraph breaks where extraction provides them.
- Later, add format-specific normalization during ingestion once the rules are proven.

Reader interaction path:

- resume reading position per user and book
- page up/down controls
- back to library
- chapter/section jump based on reader pages until real chapter metadata exists
- local highlights for the MVP
- ask AI about a paragraph from the reader

Later reader improvements:

- page-aware PDF view
- EPUB chapter navigation
- real chapter detection during ingestion
- bookmarks
- highlights
- notes
- resume reading position
- side-by-side source and AI answer view on larger screens

Open product question:

Should the reader feel like a simple reading mode, or should it be a research workspace with highlights, notes, and citations from the start? For elderly-friendly MVP use, start with simple reading mode.
