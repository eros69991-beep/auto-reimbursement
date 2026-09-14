# Hosted Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing monorepo deploy as a Netlify Vite frontend backed by a Railway API with safe cross-origin access, explicit startup, and persistent `/app/data` storage.

**Architecture:** Keep the shared monorepo root as the build context for both providers. Railway runs an explicit root API start script and supplies backend-only runtime configuration; Netlify embeds one public `VITE_API_BASE_URL` during its frontend build. The API validates an exact origin allowlist, exposes a dependency-free `/health`, and stores SQLite plus all indexed media beneath a volume-backed `DATA_DIR`.

**Tech Stack:** pnpm 11 workspace, Node.js 24, TypeScript 5.9, Express 5, React 19, Vite 7, Vitest 3, Supertest, Node test runner, Railway Railpack, Netlify.

**Spec:** `docs/superpowers/specs/2026-09-14-hosted-deployment-design.md`

## Global Constraints

- Work only in the existing linked worktree on `feature/mvp-implementation`; do not modify the dirty `master` checkout.
- Preserve existing untracked Netlify draft files and reconcile them deliberately; do not discard them.
- Never read, print, commit, or place a real `AI_API_KEY` in a command argument, test fixture, log, frontend variable, or documentation.
- Local API defaults remain `127.0.0.1:3000`; production Railway uses `HOST=0.0.0.0` and Railway's injected `PORT`.
- The only frontend runtime configuration is the public `VITE_API_BASE_URL`; all `AI_*` variables remain backend-only.
- Production mutation access uses exact origin equality for `https://zidongbx.netlify.app`; no wildcard CORS origin is permitted.
- Railway runs one replica while SQLite and the recognition queue are process-local.
- Persistent Railway state lives entirely below `DATA_DIR=/app/data`, mounted to a Railway Volume at `/app/data`.
- Do not add deprecated `railway.json` or `railway.toml` configuration.

---

### Task 1: Configurable listener and validated origin allowlist

**Files:**
- Modify: `apps/api/test/config.test.ts`
- Modify: `apps/api/src/config.ts`

**Interfaces:**
- Consumes: existing `loadConfig(env: NodeJS.ProcessEnv, cwd: string): Config`
- Produces: `Config.host: string`; `Config.corsOrigins: string[]`; default local origins; exact validated production origins

- [ ] **Step 1: Add failing configuration tests.** Split the current configuration test so temporary-directory cleanup remains shared, then add these assertions:

```ts
it('defaults to the local listener and local Vite origins', () => {
  const config = loadConfig({}, process.cwd());
  expect(config.host).toBe('127.0.0.1');
  expect(config.corsOrigins).toEqual([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:5174',
    'http://localhost:5174',
  ]);
});

it('accepts Railway host and an exact comma-separated production origin list', () => {
  const config = loadConfig({
    HOST: '0.0.0.0',
    CORS_ORIGINS: ' https://zidongbx.netlify.app,https://preview.example.com ',
  }, process.cwd());
  expect(config.host).toBe('0.0.0.0');
  expect(config.corsOrigins).toEqual([
    'https://zidongbx.netlify.app',
    'https://preview.example.com',
  ]);
});

it.each([
  '',
  'zidongbx.netlify.app',
  'https://zidongbx.netlify.app/path',
  'https://user@example.com',
  'https://*.netlify.app',
])('rejects an invalid configured CORS origin: %s', (value) => {
  expect(() => loadConfig({ CORS_ORIGINS: value }, process.cwd()))
    .toThrow('INVALID_CORS_ORIGINS');
});
```

- [ ] **Step 2: Run the focused test and verify RED.**

Run: `pnpm --filter @auto-reimbursement/api test test/config.test.ts`

Expected: failures show that `host` is still the literal `127.0.0.1`, `corsOrigins` is missing, and invalid origins are not rejected.

- [ ] **Step 3: Implement minimal parsing in `config.ts`.** Add the local defaults and an origin parser that requires an HTTP(S) URL whose serialized `url.origin` equals the configured value and whose username, password, path, query, and fragment are empty/default:

```ts
export const LOCAL_CORS_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
] as const;

function corsOrigins(value: string | undefined): string[] {
  if (value === undefined) return [...LOCAL_CORS_ORIGINS];
  const values = value.split(',').map((item) => item.trim());
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    throw new Error('INVALID_CORS_ORIGINS');
  }
  for (const value of values) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('INVALID_CORS_ORIGINS'); }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.origin !== value || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash
    ) throw new Error('INVALID_CORS_ORIGINS');
  }
  return [...new Set(values)];
}
```

Return `host: env.HOST?.trim() || '127.0.0.1'` and `corsOrigins: corsOrigins(env.CORS_ORIGINS)` from `loadConfig`.

- [ ] **Step 4: Run focused and API type checks and verify GREEN.**

Run: `pnpm --filter @auto-reimbursement/api test test/config.test.ts && pnpm --filter @auto-reimbursement/api typecheck`

Expected: configuration tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the configuration contract.**

```bash
git add apps/api/src/config.ts apps/api/test/config.test.ts
git commit -m "feat: configure hosted API listener"
```

---

### Task 2: CORS middleware and health-check safety

**Files:**
- Modify: `apps/api/test/health.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `Config.corsOrigins: string[]` from Task 1
- Produces: exact-origin CORS headers, successful preflight, preserved `CROSS_ORIGIN_MUTATION` response, dependency-free `GET /health`

- [ ] **Step 1: Replace the current loopback-only test with failing hosted CORS cases.** Import `loadConfig` and `openStore`, construct an in-memory store for `/api` assertions, and keep `createApp()` for dependency-free health assertions. Add:

```ts
const netlifyOrigin = 'https://zidongbx.netlify.app';
const hostedConfig = loadConfig({ CORS_ORIGINS: netlifyOrigin }, process.cwd());
const store = openStore(':memory:');

afterAll(() => store.close());

it('returns health without requiring an origin or AI configuration', async () => {
  const response = await request(createApp()).get('/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
});

it('allows the configured Netlify origin and answers preflight', async () => {
  const app = createApp({ store, config: hostedConfig });
  const preflight = await request(app)
    .options('/api/settings')
    .set('Origin', netlifyOrigin)
    .set('Access-Control-Request-Method', 'PUT')
    .set('Access-Control-Request-Headers', 'content-type');
  expect(preflight.status).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(netlifyOrigin);
  expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
  expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
  expect(preflight.headers.vary).toContain('Origin');
});

it('rejects an unconfigured browser mutation', async () => {
  const response = await request(createApp({ store, config: hostedConfig }))
    .post('/api/backup')
    .set('Origin', 'https://attacker.example');
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('CROSS_ORIGIN_MUTATION');
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
});
```

Also assert a configured-origin `GET /health` receives the exact allow-origin header and a disallowed-origin `GET /health` does not.

- [ ] **Step 2: Run the focused test and verify RED.**

Run: `pnpm --filter @auto-reimbursement/api test test/health.test.ts`

Expected: hosted preflight and allowed-origin header assertions fail under the old loopback-only mutation guard.

- [ ] **Step 3: Implement focused CORS handling before routes.** Import `LOCAL_CORS_ORIGINS` from `config.ts` and set `const allowedOrigins = deps?.config.corsOrigins ?? [...LOCAL_CORS_ORIGINS]`. The middleware behavior is:

```ts
const origin = request.get('origin');
const allowed = origin !== undefined && allowedOrigins.includes(origin);
if (allowed) {
  response.set('Access-Control-Allow-Origin', origin);
  response.vary('Origin');
}
if (request.method === 'OPTIONS') {
  if (!allowed) {
    response.status(403).json(crossOriginError);
    return;
  }
  response.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  response.set('Access-Control-Allow-Headers', request.get('access-control-request-headers') ?? 'content-type');
  response.status(204).end();
  return;
}
if (isMutation(request.method) && origin !== undefined && !allowed) {
  response.status(403).json(crossOriginError);
  return;
}
next();
```

Requests without `Origin` continue, including Railway health checks and command-line clients. Remove the host-header loopback requirement and obsolete `hostname`/`isLoopback` helpers; security is based on exact browser origin allowlisting.

- [ ] **Step 4: Run focused tests, the API suite, and typecheck.**

Run: `pnpm --filter @auto-reimbursement/api test test/health.test.ts && pnpm --filter @auto-reimbursement/api test && pnpm --filter @auto-reimbursement/api typecheck`

Expected: 17 API test files pass and TypeScript exits 0.

- [ ] **Step 5: Commit CORS and health behavior.**

```bash
git add apps/api/src/app.ts apps/api/test/health.test.ts
git commit -m "feat: allow configured frontend origins"
```

---

### Task 3: Vite-configured API base URL

**Files:**
- Create: `apps/web/src/api.test.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Produces: `normalizeApiBaseUrl(value: string | undefined): string`; `apiUrl(path: string, baseUrl?: string): string`
- Consumes: `import.meta.env.VITE_API_BASE_URL`
- Default: `http://127.0.0.1:3000`

- [ ] **Step 1: Write failing URL and fetch tests.**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl, normalizeApiBaseUrl, requestJson } from './api';

afterEach(() => vi.restoreAllMocks());

describe('hosted API URLs', () => {
  it('uses the local backend when the Vite value is missing or blank', () => {
    expect(normalizeApiBaseUrl(undefined)).toBe('http://127.0.0.1:3000');
    expect(normalizeApiBaseUrl('  ')).toBe('http://127.0.0.1:3000');
  });

  it('joins API and media paths to a production origin without duplicate slashes', () => {
    expect(apiUrl('/api/health', 'https://api.example.railway.app/'))
      .toBe('https://api.example.railway.app/api/health');
  });

  it('sends JSON requests to the configured API origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await requestJson('/health', undefined, 'https://api.example.railway.app');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.railway.app/health',
      undefined,
    );
  });
});
```

- [ ] **Step 2: Run the focused web test and verify RED.**

Run: `pnpm --filter @auto-reimbursement/web test src/api.test.ts`

Expected: the new exports and base-aware request signature do not exist.

- [ ] **Step 3: Implement the base URL boundary.**

```ts
const LOCAL_API_BASE_URL = 'http://127.0.0.1:3000';

export function normalizeApiBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/$/, '') || LOCAL_API_BASE_URL;
}

const configuredApiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export function apiUrl(path: string, baseUrl = configuredApiBaseUrl): string {
  return `${normalizeApiBaseUrl(baseUrl)}/${path.replace(/^\//, '')}`;
}
```

Change `requestJson` to call `fetch(apiUrl(path, baseUrl), init)` with an optional third test parameter. Route every helper through `requestJson`; wrap `deleteReceipt` with `apiUrl`; return absolute URLs from `imageUrl` and `receiptOriginalUrl`.

- [ ] **Step 4: Run focused tests, the web suite, and typecheck.**

Run: `pnpm --filter @auto-reimbursement/web test src/api.test.ts && pnpm --filter @auto-reimbursement/web test && pnpm --filter @auto-reimbursement/web typecheck`

Expected: 6 web test files pass and TypeScript exits 0.

- [ ] **Step 5: Commit the frontend URL boundary.**

```bash
git add apps/web/src/api.ts apps/web/src/api.test.ts
git commit -m "feat: configure frontend API origin"
```

---

### Task 4: Reliable Railway start contract

**Files:**
- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `test/railway-start.test.mjs`

**Interfaces:**
- Produces: root `start:api` script; API `start` script; runtime `tsx` dependency
- Railway dashboard contract: root `/`, build `pnpm install --frozen-lockfile`, start `pnpm run start:api`, health `/health`

- [ ] **Step 1: Create a failing Railway startup integration test.** The test creates an isolated temporary data directory, spawns the public root command on an unused port with no AI variables, polls `/health` until it answers, verifies the response, and always terminates the child and removes only its own temporary directory:

```js
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
test('pnpm run start:api serves the Railway health contract', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'railway-start-'));
  const port = '3187';
  const child = spawn('pnpm run start:api', {
    cwd: root,
    shell: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: port,
      DATA_DIR: dataDir,
      CORS_ORIGINS: 'https://zidongbx.netlify.app',
      AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '',
    },
    stdio: 'pipe',
  });
  context.after(async () => {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
  });
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { response = await fetch(`http://127.0.0.1:${port}/health`); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(response, 'API did not start within four seconds');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
```

- [ ] **Step 2: Run the deployment-contract test and verify RED.**

Run: `node --test test/railway-start.test.mjs`

Expected: the child exits because the root `start:api` script is missing, and the test reports that the API did not start.

- [ ] **Step 3: Add the production scripts and move `tsx` into API runtime dependencies.** Set:

```json
// package.json scripts
"start:api": "pnpm --filter @auto-reimbursement/api start"

// apps/api/package.json scripts
"start": "node --import tsx src/server.ts"
```

Run `pnpm --filter @auto-reimbursement/api add tsx@^4.23.13` to update the manifest and lockfile mechanically, then remove the older API-only `devDependencies.tsx` entry if pnpm leaves a duplicate. Keep the root development dependency because the root fixture command uses it.

- [ ] **Step 4: Verify the start contract without launching a persistent service.**

Run: `node --test test/railway-start.test.mjs && pnpm install --frozen-lockfile --lockfile-only`

Expected: the contract test passes and the lockfile is already current.

- [ ] **Step 5: Commit the start contract.**

```bash
git add package.json apps/api/package.json pnpm-lock.yaml test/railway-start.test.mjs
git commit -m "build: add Railway API start contract"
```

---

### Task 5: Reliable Netlify build contract and secret boundary

**Files:**
- Modify: `.gitignore`
- Modify: `netlify.toml` (existing untracked draft)
- Modify: `test/netlify-deploy.test.mjs` (existing untracked draft)
- Create: `test/validate-netlify-env.mjs`
- Delete: `apps/web/public/api-unavailable.json` if it is no longer referenced after the absolute API migration

**Interfaces:**
- Netlify build command: `node test/validate-netlify-env.mjs && pnpm --filter @auto-reimbursement/web build`
- Netlify publish directory: `apps/web/dist`
- Required public build variable: `VITE_API_BASE_URL`

- [ ] **Step 1: Extend the Netlify test to fail on missing environment validation and secret leakage.** Keep the existing build/publish and SPA assertions, remove the obsolete relative `/api` fallback assertions, and add:

```js
assert.match(gitignore, /^\.netlify\/$/m);
assert.match(config, /node test\/validate-netlify-env\.mjs/);
assert.doesNotMatch(config, /AI_BASE_URL|AI_MODEL|AI_API_KEY|DEEPSEEK|sk-[A-Za-z0-9_-]+/i);
assert.equal(existsSync(new URL('apps/web/public/api-unavailable.json', root)), false);

const build = spawnSync(command, {
  cwd: root,
  encoding: 'utf8',
  shell: true,
  env: { ...process.env, VITE_API_BASE_URL: 'https://api.example.railway.app' },
});
```

Add a separate test that runs `node test/validate-netlify-env.mjs` with `VITE_API_BASE_URL` removed and expects a nonzero status plus `VITE_API_BASE_URL is required for Netlify production builds` on stderr.

- [ ] **Step 2: Run the Netlify test and verify RED.**

Run: `node --test test/netlify-deploy.test.mjs`

Expected: `.netlify/` is not ignored, the validation script is missing, and the old API fallback artifact still exists.

- [ ] **Step 3: Implement environment validation and reconcile `netlify.toml`.** The validation script must accept only an HTTP(S) origin with no credentials, path, query, or fragment:

```js
const raw = process.env.VITE_API_BASE_URL?.trim();
let valid = false;
try {
  const url = new URL(raw ?? '');
  valid = (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === raw && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash;
} catch {}
if (!valid) {
  console.error('VITE_API_BASE_URL is required for Netlify production builds and must be an HTTP(S) origin');
  process.exitCode = 1;
}
```

Set `netlify.toml` to:

```toml
[build]
  command = "node test/validate-netlify-env.mjs && pnpm --filter @auto-reimbursement/web build"
  publish = "apps/web/dist"

[build.environment]
  NODE_VERSION = "24"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

Retain the existing security headers. Add `.netlify/` to `.gitignore` and remove only the now-unused `api-unavailable.json` draft.

- [ ] **Step 4: Run the Netlify contract and inspect the sample production bundle.**

Run: `$env:VITE_API_BASE_URL='https://api.example.railway.app'; node --test test/netlify-deploy.test.mjs; rg -n -e 'api\.example\.railway\.app|AI_API_KEY|sk-[A-Za-z0-9_-]+' apps/web/dist`

Expected: the test passes; the sample Railway origin is present in the generated JavaScript; `AI_API_KEY` and key-shaped samples are absent. Remove the temporary process variable after the command with `Remove-Item Env:VITE_API_BASE_URL`.

- [ ] **Step 5: Commit the Netlify deployment contract.**

```bash
git add .gitignore netlify.toml test/netlify-deploy.test.mjs test/validate-netlify-env.mjs apps/web/public/api-unavailable.json
git commit -m "build: validate Netlify frontend deployment"
```

---

### Task 6: Environment examples and exact operator checklist

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Documents the exact Railway and Netlify dashboard fields
- Keeps secret values backend-only and uses only non-secret illustrative values

- [ ] **Step 1: Update `.env.example` without real secrets.** Include local defaults and commented Railway examples:

```dotenv
# Local defaults
# HOST=127.0.0.1
# PORT=3000
# DATA_DIR=data
# CORS_ORIGINS=http://127.0.0.1:5173,http://localhost:5173

# Railway runtime examples
# HOST=0.0.0.0
# DATA_DIR=/app/data
# CORS_ORIGINS=https://zidongbx.netlify.app

# Configure all three only on the backend.
# AI_BASE_URL=https://api.deepseek.com/v1
# AI_MODEL=replace-with-your-vision-model
AI_API_KEY=

# CONCURRENCY=4
```

The model line is explicitly illustrative; README instructs the user to enter the exact vision-capable model supported by their DeepSeek account rather than treating the example text as a model identifier.

- [ ] **Step 2: Expand README with exact console settings and verification order.** Document:

```text
Railway source branch: feature/mvp-implementation (or the merged production branch)
Root Directory: /
Build Command: pnpm install --frozen-lockfile
Start Command: pnpm run start:api
Healthcheck Path: /health
Restart Policy: Always
Replicas: 1
Volume Mount Path: /app/data
Variables: HOST, DATA_DIR, CORS_ORIGINS, AI_BASE_URL, AI_MODEL, AI_API_KEY
Do not add PORT manually

Netlify Base directory: empty / repository root
Package directory: apps/web (only if the UI requires it)
Build command: inherited from netlify.toml
Publish directory: apps/web/dist
Production branch: feature/mvp-implementation (or the merged production branch)
Variable: VITE_API_BASE_URL=https://the-generated-domain.up.railway.app
```

Explain that the operator first deploys Railway, attaches the volume before real uploads, generates the domain, verifies `/health`, then sets the exact domain in Netlify and redeploys. Include the final persistence smoke test: upload a non-sensitive sample, redeploy Railway, and confirm the record and image remain.

- [ ] **Step 3: Review the rendered Markdown against the approved spec, then run secret scans.** Manually check that every Railway field, Netlify field, volume step, domain step, secret boundary, and smoke check is present and unambiguous.

Run: `rg -n --hidden -g '!node_modules' -g '!apps/web/dist/**' -e 'sk-[A-Za-z0-9_-]{12,}' -e 'VITE_AI_' .`

Expected: the scan returns no matches. `AI_API_KEY=` in `.env.example` is permitted because its value is empty.

- [ ] **Step 4: Commit operator documentation.**

```bash
git add .env.example README.md
git commit -m "docs: document Railway and Netlify deployment"
```

---

### Task 7: Full verification and local hosted-flow smoke test

**Files:**
- Modify only files implicated by a demonstrated failure; add a regression assertion before any corrective production change

**Interfaces:**
- Verifies all previous task outputs together
- Produces fresh evidence for the final handoff; does not mutate Railway or Netlify accounts

- [ ] **Step 1: Run all repository deployment tests.**

Run: `$env:VITE_API_BASE_URL='https://api.example.railway.app'; node --test test/*.test.mjs; $code=$LASTEXITCODE; Remove-Item Env:VITE_API_BASE_URL; exit $code`

Expected: all Node deployment tests pass.

- [ ] **Step 2: Run the complete workspace unit suite.**

Run: `pnpm test`

Expected: contract, API, and web suites all pass with zero failures.

- [ ] **Step 3: Run full workspace typechecking.**

Run: `pnpm typecheck`

Expected: all three workspace packages exit 0.

- [ ] **Step 4: Run a production frontend build with the sample public origin.**

Run: `$env:VITE_API_BASE_URL='https://api.example.railway.app'; pnpm --filter @auto-reimbursement/web build; $code=$LASTEXITCODE; Remove-Item Env:VITE_API_BASE_URL; exit $code`

Expected: Vite produces `apps/web/dist/index.html` and hashed assets with exit 0.

- [ ] **Step 5: Start the API with hosted CORS and temporary persistent storage.** Create a task-specific directory under the worktree `work/hosted-smoke-data`, choose port `3187`, and launch:

```powershell
$env:HOST='127.0.0.1'
$env:PORT='3187'
$env:DATA_DIR=(Resolve-Path 'work/hosted-smoke-data').Path
$env:CORS_ORIGINS='https://zidongbx.netlify.app'
pnpm run start:api
```

In a second process call `http://127.0.0.1:3187/health` with and without `Origin: https://zidongbx.netlify.app`. Verify HTTP 200, JSON `{"status":"ok"}`, and exact `Access-Control-Allow-Origin` for the origin-bearing request. Send `SIGTERM`/Ctrl+C, verify clean exit, and remove only the exact `work/hosted-smoke-data` directory after resolving and confirming it is inside the worktree.

- [ ] **Step 6: Inspect final change scope and secret safety.**

Run: `git status --short --branch && git diff origin/feature/mvp-implementation...HEAD --check && git diff origin/feature/mvp-implementation...HEAD --stat && rg -n --hidden -g '!node_modules' -g '!apps/web/dist/**' -e 'sk-[A-Za-z0-9_-]{12,}' -e 'VITE_AI_' .`

Expected: only planned files and commits appear, diff check is clean, and secret scans return no matches.

- [ ] **Step 7: Prepare the final handoff.** Report exact test counts and commands from fresh output, list every Railway and Netlify console field, identify `AI_API_KEY` as the only secret the user must enter, and state that account-bound deployment, domain generation, volume attachment, and post-deploy persistence verification still require the user's clicks.
