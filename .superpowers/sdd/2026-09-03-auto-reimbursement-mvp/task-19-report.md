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
