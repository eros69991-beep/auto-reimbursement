# Automatic Reimbursement Assistant

## Local development

Use Node.js 24 and pnpm 11. Install dependencies with `pnpm install`, then start
the backend and web app in separate terminals:

```sh
pnpm dev:api
pnpm dev:web
```

Copy `.env.example` to `.env` only when configuring a vision provider. Keep all
provider settings, especially `AI_API_KEY`, in `.env`; the browser never reads
that file. A provider is enabled only when `AI_BASE_URL`, `AI_MODEL`, and
`AI_API_KEY` are all supplied.

The backend binds to `127.0.0.1:3000` by default. Set `PORT` to an integer from
1 through 65535 to change it. `CONCURRENCY` accepts only 3 through 5 and
defaults to 4.

## Local storage

Data is stored in `data/` at the repository root by default, including the
SQLite database at `data/app.sqlite`. Set `DATA_DIR` in `.env` to choose a
different local directory. Per-month files are kept under
`YYYY-MM/originals`, `YYYY-MM/refunds`, and `YYYY-MM/exports`. Local data and
`.env` are ignored by Git.

## Backup, restore, and shutdown

Create a structured backup from **设置** after the backend has finished any
current upload or PDF export. It contains a consistent SQLite snapshot plus
settings, learning rules, and file indexes. It intentionally excludes original
images, refund evidence, exported PDFs, and provider credentials; keep a
separate secure copy of the whole data directory when complete media recovery
is required.

For a structured restore, stop the backend first, use a fresh empty
`DATA_DIR`, and extract the ZIP contents there. Restore the indexed media from
the preserved original data-directory copy separately; the ZIP alone cannot
recreate those files. Do not overwrite a running database or replace files
while the backend is serving requests. Stop the API with `Ctrl+C` and allow it
to close the queue and SQLite store before copying, backing up, or restoring
data.
