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
