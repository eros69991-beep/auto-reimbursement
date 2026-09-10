# Task 19 report: preview, history, settings and local maintenance

## RED and GREEN

The maintenance test initially failed because `archive.ts` did not exist. The settings-page test initially failed because `SettingsPage` did not exist. Both focused suites are now green.

Archive selection reaches a linked receipt/batch fixed point before validation or writes. It rejects unfinished receipt work and draft batches atomically, preserves duplicate/financial history, and restores recorded prior status on unarchive. Cleanup is explicitly confirmation-gated, operates only on archived exported work, removes only indexed original image files through safe paths, validates receipt ownership, retains refunds/PDFs, and records idempotent cleanup metadata.

Structured backups use a completed SQLite snapshot, then package that same snapshot's database, settings, rules and file index with a versioned manifest. ZIP indexes are stored in schema migration 003. Images, PDFs and credentials are excluded.

The browser adds a complete PDF preview/editor with export immutability, grouped history/archive/cleanup dialogs, settings with signer/notes/rules/API status/backup, and six primary navigation entries.

## Evidence

- Focused API maintenance suite: 3/3 passed.
- Focused browser workflow suite: 1/1 passed.
- Workspace suite: 200/200 tests passed (25 contracts, 160 API, 15 web).
- `pnpm typecheck`, web production build and `git diff --check` passed.

## Scope and concern

Existing untracked `tmp/` and `apps/api/tmp/` QA artifacts are intentionally excluded. A prior full-suite attempt hit an unrelated queue timing race; its focused suite and a fresh immediately repeated full suite passed without changes.

## Review fix round 1

Dynamic `#batches/:id/preview` hashes now render the preview page, so both pool and history navigation reach their selected batch. Settings now edits every persisted default; notes can be reopened for editing; and rules can be created or updated through the typed client. History exposes indexed original and refund-evidence links.

Preview client errors retain safe server error codes and visibly report `NOTE_OVERFLOW`/`CATEGORY_TOO_LARGE` while preserving the unchanged draft choices. Both errors are mapped as HTTP 400 rather than server failures. Cleanup validates every affected exported PDF with its live, correctly indexed, hash-verified bytes before it deletes any original image. Its partial-failure response includes the completed count plus a bounded-safe receipt ID. Backup closes the snapshot database before synchronous ZIP packaging, and ZIP downloads now pipe a read stream.

Fresh review-fix evidence: focused maintenance 4/4 and focused browser 4/4 passed; workspace tests passed 203/203 (25 contracts, 161 API, 17 web), along with typecheck, production web build and diff check.

## Review fix round 2

The editable-rule form now disables strong status until a rule has at least three confirmations, including every new draft, and shows a safe in-context alert when saving fails. The API maps `INVALID_STRONG_RULE` to an ordinary 400 validation response rather than a server error. Focused browser workflow tests passed 4/4, focused learning/API tests passed 18/18, workspace typecheck and the web production build passed.
