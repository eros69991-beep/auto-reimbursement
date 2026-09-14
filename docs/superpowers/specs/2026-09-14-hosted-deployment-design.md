# Netlify and Railway Deployment Design

## Objective

Make the existing `feature/mvp-implementation` application deploy reliably as
a Netlify-hosted Vite frontend backed by a Railway-hosted API, without exposing
provider secrets or losing SQLite and uploaded-file data on redeploy.

The production frontend origin is `https://zidongbx.netlify.app`. The Railway
public API URL is assigned when the backend service domain is generated and is
therefore supplied to Netlify through `VITE_API_BASE_URL`, not committed to the
repository.

## Current State and Root Causes

The complete application is in the existing linked worktree on branch
`feature/mvp-implementation`; `master` contains only the early scaffold and
must not be used for this deployment work.

The current deployment gaps are:

- the monorepo has no production backend start script for Railway to select;
- the API configuration fixes the listener host to `127.0.0.1`;
- mutation protection permits only loopback origins and emits no browser CORS
  response headers, so the Netlify frontend cannot call the Railway API;
- the frontend uses relative `/api` URLs and has no production API-base
  configuration;
- the existing `/health` route is suitable but is not documented as Railway's
  health-check path;
- persisted SQLite data and uploaded/generated files use `DATA_DIR`, but a
  Railway volume and `/app/data` runtime setting are not yet documented;
- the untracked Netlify deployment draft needs to be reconciled with the
  backend deployment rather than discarded.

The pre-change baseline is green: 25 contract tests, 167 API tests, and 20 web
tests pass; workspace typechecking and the Vite production build also pass.

## Deployment Architecture

Netlify builds only the web workspace from the monorepo root and publishes
`apps/web/dist`. At build time it receives the non-secret variable
`VITE_API_BASE_URL=https://<railway-domain>`. Vite embeds this public API origin
in the browser bundle.

Railway checks out the same repository at its root, installs the locked pnpm
workspace, and runs an explicit root-level backend start command. The command
starts `apps/api/src/server.ts` through the project's pinned `tsx` runtime.
`tsx` must be a runtime dependency of the API rather than relying only on a
development install.

The API listens on the host and port returned by `loadConfig`. Local defaults
remain `127.0.0.1:3000`; Railway supplies `HOST=0.0.0.0` and injects `PORT`.
The application must never replace Railway's `PORT` with a committed production
port.

Railway mounts one persistent volume at `/app/data` and supplies
`DATA_DIR=/app/data`. This keeps `app.sqlite`, its SQLite side files, original
receipt images, refund evidence, signatures, and generated exports together on
the volume. The service runs as a single replica because the current SQLite and
in-process recognition queue design is not safe for horizontally scaled writers.

## Backend Configuration Contract

`Config` gains:

- `host: string`, read from `HOST` with default `127.0.0.1`;
- `corsOrigins: string[]`, read from a comma-separated `CORS_ORIGINS` value.

Origins are normalized and validated as complete HTTP or HTTPS origins without
paths, query strings, fragments, or credentials. Invalid or empty configured
values fail startup rather than silently weakening the policy. The local
default allowlist includes the normal Vite development origins on `localhost`
and `127.0.0.1` for ports 5173 and 5174.

Production Railway variables use:

```text
HOST=0.0.0.0
DATA_DIR=/app/data
CORS_ORIGINS=https://zidongbx.netlify.app
AI_BASE_URL=<DeepSeek OpenAI-compatible base URL>
AI_MODEL=<DeepSeek vision-capable model identifier>
AI_API_KEY=<secret entered only in Railway>
```

`PORT` is omitted from user-entered variables because Railway injects it.
`CONCURRENCY` remains optional and retains the existing validated default.

Provider configuration continues to require all three `AI_*` variables or none.
No API response, log message, frontend environment declaration, Netlify file, or
documentation example may contain a real key.

## Health Check and Startup

`GET /health` remains a dependency-free liveness endpoint returning HTTP 200 and
`{"status":"ok"}`. It must not invoke the AI provider or encode the state of
provider credentials. It may be called without an `Origin` header by Railway.

Railway service settings use:

```text
Root Directory: /
Build Command: pnpm install --frozen-lockfile
Start Command: pnpm start:api
Healthcheck Path: /health
```

Repository scripts make `pnpm start:api` the stable public entry point. No
deprecated `railway.json` or `railway.toml` is added: as of this design date,
Railway has deprecated Config as Code for new services and scheduled its hard
cutoff for 2026-12-01. A project-specific `.railway/railway.ts` is also omitted
because it would couple the repository to account and service identifiers; the
small set of service fields is documented and entered explicitly in the
dashboard.

## CORS and Mutation Protection

The backend handles CORS before JSON parsing and API routes:

- requests without `Origin`, including Railway health checks and direct
  server-to-server requests, continue normally;
- an allowed origin receives `Access-Control-Allow-Origin` containing that
  exact origin plus `Vary: Origin`;
- an allowed `OPTIONS` preflight receives the allowed methods and requested
  safe headers and terminates successfully;
- a browser mutation from an origin outside the allowlist returns the existing
  structured `CROSS_ORIGIN_MUTATION` 403 response;
- disallowed cross-origin reads receive no allow-origin header, so browsers
  cannot expose the response to the caller;
- local Vite development remains usable through the default local allowlist.

The policy uses exact origin equality. Wildcards and reflected arbitrary origins
are prohibited, especially because the application exposes uploaded receipts and
supports destructive operations.

## Frontend API URL Contract

The web client reads `import.meta.env.VITE_API_BASE_URL`. Missing or blank values
fall back to `http://127.0.0.1:3000` for local development. A small URL builder
normalizes a trailing slash and joins every JSON request, upload, image, receipt
evidence, and delete URL to the same base.

Only `VITE_API_BASE_URL` is exposed to the Vite client. `AI_BASE_URL`, `AI_MODEL`,
and `AI_API_KEY` are never prefixed with `VITE_` and remain backend-only.

Netlify supplies:

```text
VITE_API_BASE_URL=https://<generated-railway-domain>
```

The value contains the origin only, without `/api` and without a trailing slash.
Changing it requires a new Netlify build because Vite variables are embedded at
build time.

## Repository and Documentation Changes

Expected modifications are limited to:

- root and API `package.json` plus the lockfile for the stable API start command
  and runtime dependency;
- `apps/api/src/config.ts`, `apps/api/src/app.ts`, and focused API tests for host
  parsing, allowed origins, preflight behavior, rejection behavior, and health;
- `apps/web/src/api.ts` and focused web tests for base-URL joining across fetch
  and media URLs;
- the existing untracked `netlify.toml`, its deployment test, and supporting
  static fallback only where still applicable;
- `.env.example`, `.gitignore`, and `README.md` for environment separation,
  Railway fields, Netlify fields, volume mounting, domain generation, and final
  smoke checks;
- a repository-level deployment-contract test that verifies the documented start
  command exists, `DATA_DIR` remains configurable, the health path is correct,
  and frontend deployment files contain no server-secret names or key-shaped
  values.

Existing user-owned changes outside this list are preserved. The dirty `master`
checkout is not modified.

## Testing and Verification

Implementation follows test-driven development for behavior changes:

1. Extend configuration tests and observe failures for `HOST` and
   `CORS_ORIGINS`.
2. Extend health/CORS tests and observe failures for the Netlify origin and
   preflight contract.
3. Add frontend URL-builder tests and observe failures for production base URLs.
4. Add deployment-contract tests and observe failures for the missing Railway
   start contract and incomplete environment documentation.
5. Implement the smallest changes needed for each test group to pass.
6. Run the complete workspace unit suite and typecheck.
7. Run the Vite production build with a non-secret sample Railway origin and
   inspect the generated client assets for correct URL embedding and absence of
   `AI_API_KEY` or key-like samples.
8. Start the API with temporary `DATA_DIR`, `HOST=127.0.0.1`, and an unused local
   port; call `/health`, verify CORS response headers for the Netlify origin, and
   shut down cleanly.

No claim of a live end-to-end deployment is made until the user has entered the
Railway secret, created the volume and public domain, set the resulting domain in
Netlify, redeployed both services, and completed the documented browser smoke
test.

## Manual Console Responsibilities

The user must perform account-bound actions that source control cannot safely
perform:

- in Railway, select the correct GitHub branch, set the root/build/start/health
  fields, add the three provider variables without sharing the key, set host,
  data directory and CORS origin, attach the `/app/data` volume, generate a
  public domain, and redeploy;
- in Netlify, select the same deployment branch, keep the repository root as the
  base, set the documented build and publish fields, add only
  `VITE_API_BASE_URL`, and trigger a clean production deploy;
- verify `/health`, load the Netlify site, upload a non-sensitive test receipt,
  and confirm data survives a Railway redeploy.

The final handoff will list every console field and distinguish public values
from secrets.
