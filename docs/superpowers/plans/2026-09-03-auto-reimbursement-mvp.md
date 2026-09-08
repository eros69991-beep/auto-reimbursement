# Auto-Reimbursement MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local receipt-to-reimbursement-PDF workflow in which ordinary receipts pass automatically and the user handles exceptions and chooses when to close a batch.

**Architecture:** A React/Vite browser application calls an Express server bound to loopback. SQLite stores structured data and immutable batch snapshots; original image bytes and generated PDFs live in a configurable local data directory. Replaceable AI adapters identify receipts, while integer arithmetic, decisions, splitting, form rendering, and attachment ordering are deterministic local code.

**Tech Stack:** Existing pnpm 11.19.0 workspace, TypeScript 5.9, React 19, Vite 7, Express 5, Vitest 3, Supertest, Testing Library; planned Node.js 24 LTS with built-in `node:sqlite`, Sharp, Zod, PDFKit, PDF.js, Playwright and a redistributable Chinese font.

**Spec:** `docs/superpowers/specs/2026-09-03-auto-reimbursement-mvp-design.md` (authoritative recovered design, read in full before execution).

## Global Constraints

The following requirements are quoted verbatim from the design; English implementation choices below do not change them.

- 目标平台：本地网页（联网调用多模态 AI API）
- 系统分类只能从以下 10 类中选择，不允许 AI 自创分类：
- 食材；百慕达食材；日常用品；耗材；能耗费；人工费用；肉类；租金及管理费；酒水；员工餐
- 规则：一张凭证只归一个分类。公司后续可要求采购严格按分类拆单。
- 单次最多 50 张。
- 当月总量不限，可分批上传。
- 保持用户上传顺序，不按日期自动重排。
- 后台采用 3–5 张并发队列调用 AI。
- 失败自动重试。
- 金额置信度 ≥ 0.95
- 分类置信度 ≥ 0.90
- 禁止猜测。
- 重复检测发生在调用 AI 前，以降低误报和 API 成本。
- 检测范围：整个历史数据库，包括已归档月份。
- 连续确认 3 次后，可升级为强规则。
- 不存在固定金额门槛。
- AI 不参与排版。
- 同分类的凭证保持原上传顺序。
- 一个分类尽量完整出现在同一张报销单。
- 金额统一保留 2 位小数。
- 所有金额计算、分类小计、整单合计、中文大写金额由程序完成，不由 AI 计算。
- 原图不修改。
- 退款不是主状态，而是报销记录属性。
- 最终实报金额 = 原实付金额 - 退款金额
- PDF 中原支付凭证后紧跟退款凭证。
- 第一版仅保留 5 个主状态：
- 识别中；待处理；可报销；已生成报销单；已归档
- API Key 只存本地后端环境配置，不写进 React 前端。
- 默认长期保留全部数据。
- 删除原始图片后仍保留 PDF、金额、分类、日期、报销批次和历史结构化记录。

---

## Recovery context and execution rules

This document reconstructs the missing implementation plan from the recovered design and the existing Task 1 brief. It is not a claim that the original missing plan text has been recovered. Task 1 is already committed as `033c3b5` (`chore: initialize reimbursement app workspace`). Preserve that implementation; verify it instead of recreating it. Tasks 2–20 describe future work, not completed features.

The MVP is one integrated local workflow, so the required 20-task plan keeps storage, recognition, finance and rendering contracts together. Out of scope: WeChat ingestion, login/permissions, approvals, banking/accounting integrations, cloud accounts/sync, mobile apps, automated refund tracking, fine-tuning, multi-store collaboration, analytics and SaaS. Do not add those features.

All commands run at the repository root in PowerShell. Package names are exactly `@auto-reimbursement/api`, `@auto-reimbursement/web` and the new `@auto-reimbursement/contracts`. API relative TypeScript imports use `.js`; frontend imports follow existing Vite conventions. The existing API package has no `type: module`; preserve its NodeNext/CommonJS behavior and avoid import.meta in its runtime files. Browser type-only imports use `import type` because verbatimModuleSyntax is enabled. Keep `vitest run --configLoader runner`. Root `pnpm test` and `pnpm typecheck` remain workspace-wide. Do not run npm or replace the pnpm lockfile.

Each checkbox is one concrete action; split implementation checkboxes by the named file when executing so a step remains approximately 2–5 minutes. Capture each RED failure before production edits in `docs/superpowers/implementation-log.md`, then capture GREEN exit code/test counts and the commit SHA. Missing module/export is an acceptable initial RED; runtime dependency or syntax errors are not behavior verification. Commands ending in a named test file use Vitest's file filter. After each GREEN, run `pnpm typecheck` and the affected package's complete tests before committing. Add only listed task files and dependency lockfile changes, never data or secrets.

Implementation decisions absent from the spec are explicit: Node 24 LTS; queue concurrency 4; three total attempts at 0/1/3 second scheduling delays; medium confidence floors 0.80 amount and 0.70 category; maximum image size 20 MiB; JPEG/PNG/WebP inputs; custom 270×165 mm landscape reimbursement forms and A4 portrait attachment pages. These are configurable, tested defaults. The user subsequently supplied two paper-form photos, inspected during this recovery. Task 15 must reproduce their printed structure and compare rendered output against both. The photos have perspective/curvature and no ruler, so 270×165 mm is an explicit initial physical-size assumption; normalize proportions and document calibration instead of claiming millimeter-perfect measurements. Handwritten names, accounts, amounts and descriptions are example data only and must never become defaults, fixtures or committed assets.

## File structure and ownership

- Root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`, `.env.example`, `README.md`: workspace, runtime commands and local operation.
- `packages/contracts/{package.json,tsconfig.json,src/index.ts,src/index.test.ts}`: browser-safe shared types, category/status constants, exact money parsing/formatting.
- `apps/api/src/config.ts`, `storage.ts`: environment parsing and safe filesystem access.
- `apps/api/src/db.ts`, `migrations/001-initial.sql`: SQLite schema and transactions.
- `apps/api/src/receipts.ts`, `duplicates.ts`, `refunds.ts`: receipt lifecycle, immutable images and duplicate evidence.
- `apps/api/src/ai/{types,prompt,openai-compatible,validate}.ts`, `queue.ts`, `decision.ts`, `learning.ts`: provider-neutral recognition and local corrections.
- `apps/api/src/settings.ts`, `batches.ts`, `uppercase.ts`: editable defaults, snapshots and deterministic totals.
- `apps/api/src/render/{layout,form,attachments,pdf}.ts`, `assets/fonts/`: measured layout and PDF drawing.
- `apps/api/src/archive.ts`, `backup.ts`, `routes.ts`, existing `app.ts`/`server.ts`: local HTTP boundary and maintenance.
- `apps/api/test/*.test.ts`, `test/support.ts`, `test/fixtures/`: isolated unit/integration fixtures; never personal receipts or API keys.
- `apps/web/src/api.ts`, `components/`, `pages/`, `styles.css`: typed browser client and the six specified views.
- `e2e/`, `playwright.config.ts`, `docs/acceptance.md`: full-workflow verification and human accuracy assessment.

## Private paper-form references

Read these local images only for visual comparison; do not copy them into the repository, generated deliverables or test fixtures. They contain handwritten personal/payment details.

- Reference A: `C:\Users\Admin（无密码）\Documents\xwechat_files\wxid_y57klib3pzx722_7c52\temp\RWTemp\2026-09\9e20f478899dc29eb19741386f9343c8\73998b74c9cf32892f8da14250f50b5a.jpg`
- Reference B: `C:\Users\Admin（无密码）\Documents\xwechat_files\wxid_y57klib3pzx722_7c52\temp\RWTemp\2026-09\9e20f478899dc29eb19741386f9343c8\5a2e0780e97ef1f391e8627c73c7a8e7.jpg`

The printed form has a centered, spaced blue title and double black underline; department/date/attachment-page fields above the grid; project and wide summary columns; nine narrow amount digit columns labeled 百、十、万、千、百、十、元、角、分; a narrow vertical 备注/领导审批 label column with an upper notes box and lower blank approval box; total row; uppercase amount, 原借款 and 应退（补）款 strip; and bottom 会计主管、复核、出纳、报销人 labels. Preserve this structure, not the sample handwriting.

## Shared contracts and invariants

Task 3 creates the complete shared types below before consumers are implemented. All production IDs are UUID strings (readable fixed IDs in isolated tests are allowed); `month` is local upload month in `YYYY-MM`, while `date` is an optional transaction/form date in `YYYY-MM-DD`. Upload order is a monotonically increasing SQLite integer across the entire history. All money is a safe integer number of fen; supported range is 0 through 999,999,999,999 fen and totals exceeding it are rejected, never rounded. Images are addressed using generated opaque IDs, never a browser-supplied filesystem path.

```ts
export const CATEGORIES = ['食材','百慕达食材','日常用品','耗材','能耗费',
  '人工费用','肉类','租金及管理费','酒水','员工餐'] as const;
export type Category = typeof CATEGORIES[number];
export type Status = 'recognizing'|'pending'|'ready'|'generated'|'archived';
export const STATUS_LABELS: Record<Status,string> = {
  recognizing:'识别中',pending:'待处理',ready:'可报销',
  generated:'已生成报销单',archived:'已归档'
};
export type Reason = 'amount_uncertain'|'category_uncertain'|'api_failed'|
  'suspected_duplicate'|'ambiguous_amount'|'unreadable'|'rule_conflict';
export interface Confidence { amount:number; category:number }
export interface Analysis {
  amount: string|null; category: Category|null; merchant:string|null;
  date:string|null; confidence:Confidence; ambiguous:boolean;
  keywords:string[]; evidence:string;
}
export interface ImageRef {
  id:string; path:string; mime:'image/jpeg'|'image/png'|'image/webp';
  sha256:string; perceptualHash:string; bytes:number; width:number;
  height:number; deletedAt:string|null;
}
export interface Receipt {
  id:string; original:ImageRef; refundImages:ImageRef[]; month:string;
  uploadedAt:string; uploadOrder:number; analysis:Analysis|null;
  recognizedFen:number|null; paidFen:number|null; refundFen:number;
  category:Category|null; merchant:string|null; date:string|null;
  status:Status; pendingReasons:Reason[]; duplicateIds:string[];
  duplicateOverride:boolean; attempts:number; nextAttemptAt:string|null;
  batchId:string|null; archivedAt:string|null; statusBeforeArchive:Status|null;
  deletedAt:string|null;
}
export interface Rule {
  id:string; kind:'merchant'|'keyword'; key:string;
  originalCategory:Category|null; category:Category; confirmations:number;
  strong:boolean; updatedAt:string;
}
export interface Note { id:string; name:string; content:string }
export interface Settings {
  id:'default'; department:string; dateMode:'today'|'blank'|'custom';
  customDate:string|null; signerMode:'text'|'image'; signerName:string;
  signature:ImageRef|null; amountThreshold:number; categoryThreshold:number;
}
export interface FormOptions {
  department:string; date:string|null; signerMode:'text'|'image';
  signerName:string; signature:ImageRef|null;
}
export interface Snapshot {
  receiptId:string; uploadOrder:number; category:Category; paidFen:number;
  refundFen:number; netFen:number; original:ImageRef; refundImages:ImageRef[];
}
export interface FormGroup {
  category:Category; receiptIds:string[]; amountsFen:number[]; totalFen:number;
}
export interface FormSheet { id:string; groups:FormGroup[]; noteId:string|null }
export interface Batch {
  id:string; month:string; createdAt:string; totalFen:number;
  items:Snapshot[]; sheets:FormSheet[]; options:FormOptions;
  notes:Note[]; pdfPath:string|null; archivedAt:string|null;
}
export interface FileIndexEntry {
  id:string; ownerId:string; kind:'original'|'refund'|'signature'|'pdf';
  path:string; sha256:string; deletedAt:string|null;
}
export interface Tables {
  receipts:Receipt; rules:Rule; settings:Settings; notes:Note;
  batches:Batch; files:FileIndexEntry;
}
export type Table = keyof Tables;
export interface Totals {
  count:number; totalFen:number; byCategory:Record<Category,number>;
}
export interface UploadResult {
  accepted:Receipt[]; rejected:Array<{index:number; code:string;
    duplicateId?:string}>;
}
export interface Progress {
  recognizing:number; ready:number; pending:number; total:number;
}
export interface ApiStatus { configured:boolean; provider:string|null }
export interface Preview {
  batch:Batch; pdfUrl:string;
}
export interface HistoryMonth { month:string; batches:Batch[] }
export interface MaintenanceResult { affected:number }
export interface BackupResult { downloadUrl:string; includesImages:boolean }
export interface ApiErrorBody { code:string; message:string }
export function parseFen(value:string):number;
export function formatFen(value:number):string;
export function netFen(r:Pick<Receipt,'paidFen'|'refundFen'>):number;
```

Function declarations above describe exports, not ambient declarations to paste into the implementation. `parseFen` accepts digits plus zero, one or two decimal digits, rejects signs/exponents/commas and overflow. `netFen` throws for null paid amount or refunds outside 0..paidFen. A fully refunded record retains its main status but contributes zero and cannot be selected for a batch. Deleted records are hidden from workspace lists but remain in duplicate detection, history and the file index. Generated/archived records are immutable financial history; edits/refunds/deletion return HTTP 409. Changes to form options before export update a draft batch only; once `pdfPath` is set, the batch snapshot is immutable.

HTTP JSON uses these types; errors are `{code,message}` with 400 invalid input, 404 missing ID, 409 lifecycle/duplicate conflict, 413 size/batch limit and 500 internal failure. Server logs may contain error classes and receipt IDs but never API keys or image base64. Reject cross-origin mutations, bind 127.0.0.1, serve images only by indexed ID and restrict configured upstream URLs to http/https.

## Task 1: Project skeleton and test environment (already completed)

**Files:** Existing root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`; `apps/api/{package.json,tsconfig.json,vitest.config.ts,src/app.ts,src/server.ts,test/health.test.ts}`; `apps/web/{package.json,index.html,vite.config.ts,vitest.config.ts,tsconfig.json,tsconfig.app.json,tsconfig.node.json,src/main.tsx,src/App.tsx,src/App.test.tsx,src/test/setup.ts}`. Create `docs/superpowers/implementation-log.md` when execution resumes.

**Interfaces:** Produces existing `app: express.Express`; `GET /health -> 200 {status:'ok'}`; `App(): JSX.Element` renders the English bootstrap title. No database/upload/config behavior exists yet.

- [ ] **Step 1: Verify the recorded boundary.** Read commit `033c3b5` and the existing health/render tests; retain these exact behavior assertions:
```ts
expect((await request(app).get('/health')).body).toEqual({status:'ok'});
expect(screen.getByRole('heading', {
  name:'Automatic Reimbursement Assistant'
})).toBeInTheDocument();
```
- [ ] **Step 2: Record the historical RED limitation.** Do not manufacture a RED run by damaging the completed app. In the implementation log write: `Task 1 was completed before this plan recovery; historical RED output is not available in this document.`
- [ ] **Step 3: Verify GREEN.** Run `pnpm test`, then `pnpm typecheck`. Expected: both exit 0, health and frontend render tests pass without warnings. Fix any real regression using a failing reproduction before changing code; this task has no planned production edits.
- [ ] **Step 4: Record completion.** Add the fresh command results to the implementation log. Commit only that log with `git add docs/superpowers/implementation-log.md` then `git commit -m "docs: record recovered task one verification"`. Do not recreate the existing initialization commit.

## Task 2: Backend-only configuration and local data directories

**Files:** Create `apps/api/src/config.ts`, `apps/api/src/storage.ts`, `apps/api/test/config.test.ts`, `.env.example`, `README.md`; modify `apps/api/src/server.ts`, `.gitignore`, root `package.json`.

**Interfaces:** `loadConfig(env:NodeJS.ProcessEnv, cwd:string):Config`; `Config = {dataDir:string; dbPath:string; host:'127.0.0.1'; port:number; ai:{baseUrl:string; model:string; apiKey:string}|null; concurrency:number}`; `ensureMonthDirs(dataDir:string, month:string):Promise<{originals:string;refunds:string;exports:string}>`; `safePath(root:string, relative:string):string`. Configuration stays server-only.

- [ ] **Step 1: Write `config.test.ts`.** Use `mkdtemp` and remove only that exact temp directory in teardown.
```ts
import {mkdtemp, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {loadConfig} from '../src/config.js';
import {ensureMonthDirs,safePath} from '../src/storage.js';
it('creates local month folders and never accepts traversal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reimburse-config-'));
  try {
    const c=loadConfig({DATA_DIR:root},root);
    const dirs=await ensureMonthDirs(c.dataDir,'2026-09');
    expect((await stat(dirs.originals)).isDirectory()).toBe(true);
    expect(c.ai).toBeNull();
    expect(c.concurrency).toBe(4);
    expect(()=>safePath(root,'../secret')).toThrow('UNSAFE_PATH');
    expect(()=>loadConfig({PORT:'NaN'},root)).toThrow('INVALID_PORT');
  } finally {await rm(root,{recursive:true,force:true});}
});
```
- [ ] **Step 2: RED.** Run `pnpm --filter @auto-reimbursement/api test test/config.test.ts`; expect missing `config.js`/exports.
- [ ] **Step 3: Implement configuration.** Resolve `DATA_DIR` against cwd (default `data`); database is `data/app.sqlite`; port defaults 3000, integer 1..65535; accept concurrency integers 3..5 only. Require either all three `AI_BASE_URL/AI_MODEL/AI_API_KEY` or none; reject partially configured providers. Return safe API status separately in Task 6; never serialize `Config` to a browser.
```ts
const integer=(s:string|undefined,fallback:number,min:number,max:number)=>{
  const n=s===undefined?fallback:Number(s);
  if(!Number.isInteger(n)||n<min||n>max) throw new Error('INVALID_PORT');
  return n;
};
// Use a distinct INVALID_CONCURRENCY error for the queue setting.
```
- [ ] **Step 4: Implement directories and startup.** `safePath` uses `resolve` plus `relative`; reject absolute input, any escaping relative path and NUL. Check `month` against `/^\d{4}-(0[1-9]|1[0-2])$/`; recursively create only the three known child directories. Add `data/` to gitignore; example env has empty key and a commented provider URL, never a real key. Set root engines to `{"node":">=24 <25"}`; use Node 24 and add root `dev:api` as `pnpm --filter @auto-reimbursement/api exec node --env-file-if-exists=../../.env --import tsx src/server.ts`; loadConfig receives the repository root (`resolve(process.cwd(),'../..')` in server.ts, launched by the documented pnpm package command), so data paths do not depend on pnpm's package cwd; `dev:web` runs the existing web dev script. Bind server with `app.listen(config.port,config.host)`. README states local launch and storage location.
```ts
export function safePath(root:string,input:string):string {
  if(isAbsolute(input)||input.includes('\0')) throw new Error('UNSAFE_PATH');
  const target=resolve(root,input), rel=relative(resolve(root),target);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))
    throw new Error('UNSAFE_PATH');
  return target;
}
// Import isAbsolute, resolve, relative and sep from node:path.
```

- [ ] **Step 5: GREEN.** Run the RED command, then `pnpm test` and `pnpm typecheck`; expect all pass. Confirm `git check-ignore data/probe .env` reports both and `git check-ignore .env.example` does not.
- [ ] **Step 6: Commit.** `git add apps/api/src/config.ts apps/api/src/storage.ts apps/api/src/server.ts apps/api/test/config.test.ts .env.example .gitignore package.json README.md docs/superpowers/implementation-log.md`; `git commit -m "feat: configure local data storage"`.

## Task 3: Shared contracts, money invariants and SQLite persistence

**Files:** Create `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`, `packages/contracts/src/index.test.ts`, `apps/api/src/db.ts`, `apps/api/src/migrations/001-initial.sql`, `apps/api/test/db.test.ts`, `apps/api/test/support.ts`; modify `pnpm-workspace.yaml`, both app package manifests and `pnpm-lock.yaml`.

**Interfaces:** All shared contracts above; `openStore(path:string):Store`; `Store.get<K extends Table>(table:K,id:string):Tables[K]|null`, `list<K extends Table>(table:K):Tables[K][]`, `put<K extends Table>(table:K,row:Tables[K]):void`, `remove(table:Table,id:string):void`, `transact<T>(fn:()=>T):T`, `nextOrder():number`, `backupTo(path:string):Promise<void>`, `close():void`. `transact` is synchronous; never await filesystem/network inside it. Test helper `sampleReceipt(overrides?:Partial<Receipt>):Receipt` returns a complete valid receipt.

- [ ] **Step 1: Write money and database tests.**
```ts
// packages/contracts/src/index.test.ts
import {expect,it} from 'vitest';
import {parseFen,formatFen,netFen} from './index';
it('calculates exact fen and rejects uncertain input',()=>{
  expect(parseFen('36.33')+parseFen('17.30')).toBe(5363);
  expect(formatFen(5363)).toBe('53.63');
  expect(()=>parseFen('1.001')).toThrow();
  expect(()=>parseFen('1e2')).toThrow();
  expect(netFen({paidFen:30000,refundFen:8000})).toBe(22000);
});
// apps/api/test/db.test.ts
import {expect,it} from 'vitest';
import {openStore} from '../src/db.js';
import {sampleReceipt} from './support.js';
it('rolls back a write and sequence allocation together',()=>{
  const s=openStore(':memory:');
  try {
    expect(()=>s.transact(()=>{
      s.put('receipts',sampleReceipt({uploadOrder:s.nextOrder()}));
      throw new Error('abort');
    })).toThrow('abort');
    expect(s.list('receipts')).toEqual([]);
    expect(s.nextOrder()).toBe(1);
  } finally {s.close();}
});
```
- [ ] **Step 2: RED.** Run API's `test test/db.test.ts`; expect missing `db.js`. Create the contracts manifest with name `@auto-reimbursement/contracts`, private true, version 0.0.0, exports/types `./src/index.ts`, and scripts `test: vitest run`, `typecheck: tsc --noEmit`; add TypeScript/Vitest matching existing versions. Add `packages/*` to workspace and `workspace:*` dependency to each app. Run `pnpm install`, then `pnpm --filter @auto-reimbursement/contracts test`; expect missing money exports.
- [ ] **Step 3: Implement contracts and money.** Copy the shared type bodies into `index.ts`; write actual functions:
```ts
export function parseFen(v:string):number {
  if(!/^\d+(\.\d{1,2})?$/.test(v)) throw new Error('INVALID_AMOUNT');
  const [whole,fraction='']=v.split('.');
  const n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(n>999999999999n) throw new Error('AMOUNT_OVERFLOW');
  return Number(n);
}
export function formatFen(n:number):string {
  if(!Number.isSafeInteger(n)||n<0||n>999999999999)
    throw new Error('INVALID_AMOUNT');
  return Math.floor(n/100)+'.'+String(n%100).padStart(2,'0');
}
export function netFen(r:Pick<Receipt,'paidFen'|'refundFen'>):number {
  if(r.paidFen===null||!Number.isSafeInteger(r.refundFen)||
      r.refundFen<0||r.refundFen>r.paidFen) throw new Error('INVALID_REFUND');
  return r.paidFen-r.refundFen;
}
```
Use ES2022/Bundler resolution with strict, noEmit for the contracts tsconfig. Do not export Node APIs from this package.
- [ ] **Step 4: Implement schema and Store.** Use `DatabaseSync` from `node:sqlite`, `PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;`, schema migration version via `user_version`. Create each of receipts/rules/settings/notes/batches/files as `(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))` plus `counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL)`. Add indexes on receipt `json_extract(data,'$.original.sha256')`, `$.month`, `$.status`, `$.batchId`. SQL table names must come from an internal fixed whitelist; parameters bind IDs/JSON. Use BEGIN IMMEDIATE/COMMIT/ROLLBACK and reject nested transactions. Counter increment is an UPDATE RETURNING with initial row `upload_order=0`. `backupTo` uses SQLite's backup API (not copying the active WAL database file).
```sql
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX IF NOT EXISTS receipt_sha
  ON receipts(json_extract(data,'$.original.sha256'));
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters VALUES ('upload_order',0);
-- nextOrder executes this statement:
UPDATE counters SET value=value+1 WHERE name='upload_order' RETURNING value;
```

- [ ] **Step 5: Implement fixture factory and durable tests.** Factory defaults: UUID fixed as `receipt-1`, valid dummy ImageRef with path `2026-09/originals/image-1.png`, 10x10, no deletions; month 2026-09, upload timestamp ISO, uploadOrder 1; ready, paidFen/recognizedFen 1000, category 耗材, refundFen 0; nullable analysis/merchant/date/batch/archive fields null; arrays empty, attempts 0, override false. Add reopen-on-disk test for receipts, settings, rules and notes; assert sequence persists, all five status strings round trip and invalid JSON is rejected. Temp cleanup occurs after close.
- [ ] **Step 6: GREEN and commit.** Run `pnpm test`, `pnpm typecheck`; expect pass. `git add packages/contracts pnpm-workspace.yaml pnpm-lock.yaml apps/api/package.json apps/web/package.json apps/api/src/db.ts apps/api/src/migrations/001-initial.sql apps/api/test/db.test.ts apps/api/test/support.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: persist reimbursement records in sqlite"`.

## Task 4: Ordered image upload and immutable local storage

**Files:** Create `apps/api/src/receipts.ts`, `apps/api/src/routes.ts`, `apps/api/test/upload.test.ts`; modify `storage.ts`, `app.ts`, `server.ts`, API manifest/lockfile.

**Interfaces:** `InputImage={name:string;mime:string;bytes:Buffer}`; `storeImage(config:Config,month:string,kind:'originals'|'refunds',input:InputImage):Promise<ImageRef>`; `uploadReceipts(store:Store,config:Config,files:InputImage[],now:Date):Promise<UploadResult>`; `createApp(deps?:{store:Store;config:Config}):express.Express` retains `export const app=createApp()` for isolated health tests. API `POST /api/receipts/upload` multipart field `files` -> 201 UploadResult; `GET /api/images/:id` -> indexed original bytes.

- [ ] **Step 1: Write `upload.test.ts`.** Add Sharp and Multer plus `@types/multer` with pnpm. Generate test pixels in memory and assert HTTP behavior:
```ts
const png=await sharp({create:{width:8,height:8,channels:3,
  background:'#123456'}}).png().toBuffer();
const response=await request(createApp({store,config}))
  .post('/api/receipts/upload')
  .attach('files',png,'../../one.png').attach('files',png,'two.png');
expect(response.status).toBe(201);
expect(response.body.accepted.map((r:Receipt)=>r.uploadOrder)).toEqual([1,2]);
const image=await request(createApp({store,config}))
  .get('/api/images/'+response.body.accepted[0].original.id);
expect(image.body).toEqual(png);
```
In this test define `store=openStore(':memory:')` and `config=loadConfig({DATA_DIR:temp},temp)` using a mkdtemp/afterEach harness; import Sharp, Supertest, Receipt and the named functions. After Task 5, use two different pixel buffers in this order test and add the renamed duplicate assertion there.
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/upload.test.ts`; expect createApp missing or upload route 404.
- [ ] **Step 3: Implement storage.** Validate JPEG/PNG/WebP by decoded Sharp metadata, not filename; enforce per-image 20 MiB and decoded pixel count <=40 million. Preserve input bytes exactly using exclusive `writeFile(path,bytes,{flag:'wx'})`; never recompress originals. Generate UUID paths under month/kind. SHA-256 is computed from bytes; perceptualHash is populated in Task 5 (empty string until then). On validation failure persist nothing for that item.
```ts
const metadata=await sharp(input.bytes,{limitInputPixels:40_000_000}).metadata();
const formats={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'} as const;
if(!metadata.format||!(metadata.format in formats))
  throw new Error('INVALID_IMAGE');
if(input.bytes.length>20*1024*1024) throw new Error('IMAGE_TOO_LARGE');
await writeFile(absolutePath,input.bytes,{flag:'wx'});
// absolutePath is safePath(config.dataDir, generatedRelativePath).
```

- [ ] **Step 4: Implement upload and routes.** Multer memoryStorage limits files=50 and fileSize=20 MiB; map size/count failures to 413. Iterate multipart files in input order, assign order inside store transaction, initialize recognizing receipt with nullable money/category, and persist a FileIndexEntry. If DB write fails remove only the newly written orphan file. Return per-item indexed rejection for malformed images while accepting valid items. Cap HTTP body memory at 50×20 MiB using Multer's per-file and count limits, and document that uploading maximum-size images may require significant local RAM; do not base64 images in HTTP JSON. Zero files ->400. Never enumerate all files via static hosting; indexed image ID resolution goes through safePath and returns 410 when deletedAt is set.
```ts
router.post('/receipts/upload',upload.array('files',50),async(req,res,next)=>{
  try {
    const files=(req.files as Express.Multer.File[]).map(file=>({
      name:file.originalname,mime:file.mimetype,bytes:file.buffer
    }));
    if(!files.length) return res.status(400).json({
      code:'EMPTY_UPLOAD',message:'请选择凭证图片'
    });
    res.status(201).json(await uploadReceipts(store,config,files,new Date()));
  } catch(error) {next(error);}
});
```

- [ ] **Step 5: Wire lifecycle.** `server.ts` loads config, opens store once and calls createApp; close store on server shutdown. createApp without deps exposes only health. Add JSON size limit 1 MiB and one centralized error mapper; do not expose stack traces.
- [ ] **Step 6: GREEN.** Run upload tests and add 51-file, spoofed MIME, huge image, traversal-name and DB-failure cleanup cases; assert original bytes/selection order, then API tests and typecheck pass.
- [ ] **Step 7: Commit.** `git add apps/api/src/receipts.ts apps/api/src/routes.ts apps/api/src/storage.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/test/upload.test.ts apps/api/package.json pnpm-lock.yaml docs/superpowers/implementation-log.md`; `git commit -m "feat: upload immutable receipt images in order"`.

## Task 5: Historical exact and suspected duplicate detection before AI

**Files:** Create `apps/api/src/duplicates.ts`, `apps/api/test/duplicates.test.ts`; modify `storage.ts`, `receipts.ts`, `routes.ts`, `test/upload.test.ts`.

**Interfaces:** `fingerprint(bytes:Buffer):Promise<{sha256:string;perceptualHash:string}>`; `findDuplicates(store:Store,image:ImageRef):{exactId:string|null;suspectedIds:string[]}`; `refineDuplicates(store:Store,receipt:Receipt):string[]`; `confirmDistinct(store:Store,id:string):Receipt`. API `POST /api/receipts/:id/confirm-distinct -> Receipt`. Exact duplicate rejection code `EXACT_DUPLICATE` includes duplicateId.

- [ ] **Step 1: Write the test.**
```ts
it('blocks renamed originals even after history is archived',()=>{
  const s=openStore(':memory:');
  const prior=sampleReceipt({status:'archived',archivedAt:'2026-10-01'});
  s.put('receipts',prior);
  expect(findDuplicates(s,prior.original).exactId).toBe(prior.id);
  s.close();
});
```
Add a fixture pair made from one source PNG with altered compression and a visually distinct checkerboard PNG; do not use two flat-color images for a dHash distinction assertion because both have the same edge hash. Assert perceptual detection catches the first pair; unrelated pair is not flagged.
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/duplicates.test.ts`; expect missing duplicates module.
- [ ] **Step 3: Implement hashes and comparison.** SHA-256 is exact bytes; dHash uses decoded grayscale resized 9x8 pixels, comparing adjacent columns into 64 bits and emitting 16 hex digits. Hamming distance <=5 is a suspected image match. Empty fingerprints never match. Search all receipts, including deleted and archived; exclude self. Exact equality is checked again inside the upload persistence transaction to prevent concurrent duplicate races.
```ts
const distance=(a:string,b:string)=>{
  let v=BigInt('0x'+a)^BigInt('0x'+b), n=0;
  while(v){v&=v-1n;n++;}
  return n;
};
```
- [ ] **Step 4: Wire before AI.** Compute both fingerprints before upload persistence; exact matches return rejection and remove the new unreferenced file. Suspected matches persist as pending with `suspected_duplicate` and reference IDs, without enqueueing. `confirmDistinct` clears that reason, records override, returns to recognizing when analysis is absent. After analysis, `refineDuplicates` flags image distance <=10 combined with equal paidFen, normalized nonempty merchant and equal nonnull date; do not use metadata alone as a definitive duplicate. Override bypasses later suspected flags only for that receipt.
```ts
const match=findDuplicates(store,image);
if(match.exactId) return {index,code:'EXACT_DUPLICATE',duplicateId:match.exactId};
receipt.duplicateIds=match.suspectedIds;
receipt.status=match.suspectedIds.length?'pending':'recognizing';
receipt.pendingReasons=match.suspectedIds.length?['suspected_duplicate']:[];
// In uploadReceipts, rejected items are appended to rejected;
// accepted receipts are written together with their FileIndexEntry.
```

- [ ] **Step 5: GREEN.** Run duplicate/upload tests, API suite and typecheck. Assert unknown/archived confirmation gets 404/409, exact detection occurs before any adapter call, and history image endpoint supplies evidence unless cleaned.
- [ ] **Step 6: Commit.** `git add apps/api/src/duplicates.ts apps/api/src/storage.ts apps/api/src/receipts.ts apps/api/src/routes.ts apps/api/test/duplicates.test.ts apps/api/test/upload.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: block duplicate receipts across history"`.

## Task 6: Replaceable multimodal recognition and strict payment extraction

**Files:** Create `apps/api/src/ai/types.ts`, `prompt.ts`, `validate.ts`, `openai-compatible.ts` within that directory; `apps/api/test/ai.test.ts`; modify `routes.ts`, API manifest/lockfile.

**Interfaces:** `AiError` is exported from ai/types.ts with the code/retryable fields defined in Step 3; `AiImage={bytes:Buffer;mime:ImageRef['mime']}`; `ReceiptAnalyzer={analyzeReceipt(image:AiImage):Promise<Analysis>}`; `createAnalyzer(config:Config,fetcher:typeof fetch=fetch):ReceiptAnalyzer`; `validateAnalysis(input:unknown):Analysis`; `getApiStatus(config:Config):ApiStatus`. API `GET /api/ai/status -> ApiStatus`. No consumers depend on a vendor response shape.

- [ ] **Step 1: Write a provider-neutral test.**
```ts
const valid={amount:'36.33',category:'耗材',merchant:'店铺',date:null,
  confidence:{amount:0.98,category:0.94},ambiguous:false,
  keywords:['包装'],evidence:'实付款 36.33'};
it('rejects invented categories and ambiguous payment certainty',()=>{
  expect(validateAnalysis(valid).amount).toBe('36.33');
  expect(()=>validateAnalysis({...valid,category:'办公费'})).toThrow();
  expect(()=>validateAnalysis({...valid,amount:'36.333'})).toThrow();
  expect(validateAnalysis({...valid,amount:null,ambiguous:true}).amount).toBeNull();
});
```
Add mock fetch assertions for endpoint, Authorization header existing only upstream, image data URL and response parsing.
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/ai.test.ts`; expect missing validator/adapter.
- [ ] **Step 3: Implement strict schema.** Add Zod; schema enumerates CATEGORIES, nullable amount/date/merchant, finite confidence 0..1, keywords string array capped 20 and evidence <=2000 chars. Validate real calendar dates by ISO round trip and money with parseFen. Require JSON object only; malformed response throws `AiError(code,retryable)` with code union `'NOT_CONFIGURED'|'AUTH'|'RATE_LIMIT'|'TIMEOUT'|'UPSTREAM'|'INVALID_RESPONSE'` and boolean retryable. Never coerce unknown category to a default.
```ts
const confidence=z.object({amount:z.number().min(0).max(1),
  category:z.number().min(0).max(1)}).strict();
// validate.ts imports AiError from ./types.js.
const analysisSchema=z.object({
  amount:z.string().nullable(),category:z.enum(CATEGORIES).nullable(),
  merchant:z.string().max(200).nullable(),date:z.string().nullable(),
  confidence,ambiguous:z.boolean(),keywords:z.array(z.string().max(100)).max(20),
  evidence:z.string().max(2000)
}).strict();
// Put this class in ai/types.ts, not validate.ts.
export class AiError extends Error {
  constructor(public code:'NOT_CONFIGURED'|'AUTH'|'RATE_LIMIT'|'TIMEOUT'|
    'UPSTREAM'|'INVALID_RESPONSE',public retryable:boolean){super(code);}
}
```

- [ ] **Step 4: Implement prompt and adapter.** Export `RECEIPT_PROMPT:string` containing the exact 10 categories and keys, emphasizing 实付/实付款/实际支付/已支付/支付金额/本次支付/合计支付. Explicitly exclude 原价/优惠/立减/余额/应付/单独运费/退款金额, require null amount plus ambiguous=true when final amounts cannot be distinguished, no item-description output or total computation. Adapter sends POST to configured base URL plus `/chat/completions`, model, temperature 0, user content with prompt text and image_url; parses `choices[0].message.content` as JSON through validator. AbortSignal.timeout(45000). 401/403 and absent config are terminal; 429/5xx/network/timeout and malformed JSON retryable. Safe error messages omit bodies and credentials.
```ts
const response=await fetcher(config.ai.baseUrl.replace(/\/$/,'')+'/chat/completions',{
  method:'POST',signal:AbortSignal.timeout(45000),
  headers:{Authorization:'Bearer '+config.ai.apiKey,'Content-Type':'application/json'},
  body:JSON.stringify({model:config.ai.model,temperature:0,messages:[{
    role:'user',content:[{type:'text',text:RECEIPT_PROMPT},{
      type:'image_url',image_url:{url:'data:'+image.mime+';base64,'+
        image.bytes.toString('base64')}
    }]
  }]})
});
// Execute only after checking config.ai is nonnull; map HTTP errors
// before decoding the successful response.
```

- [ ] **Step 5: GREEN.** Run ai tests and add 401,429,timeout,malformed JSON,unknown formats and ambiguous amounts; assert `getApiStatus` returns only configured/provider, never model key or base URL credentials. Run API tests/typecheck.
- [ ] **Step 6: Commit.** `git add apps/api/src/ai apps/api/src/routes.ts apps/api/test/ai.test.ts apps/api/package.json pnpm-lock.yaml docs/superpowers/implementation-log.md`; `git commit -m "feat: add replaceable receipt analysis adapter"`.

## Task 7: Durable recognition queue, bounded concurrency and retries

**Files:** Create `apps/api/src/queue.ts`, `apps/api/test/queue.test.ts`; modify `app.ts`, `server.ts`, `routes.ts`.

**Interfaces:** `createQueue({store,config,analyzer,onAnalyzed,now?}):RecognitionQueue`, where `onAnalyzed:(id:string,result:Analysis)=>void`, `now?:()=>Date`; `RecognitionQueue={start():void;enqueue(ids:string[]):void;drain():Promise<void>;stop():Promise<void>}`. `getProgress(store:Store,ids:string[]):Progress`; `GET /api/progress?ids=comma-separated -> Progress`; `POST /api/receipts/:id/retry -> Receipt`. Extend createApp deps with optional queue; production supplies it, tests may inject a fake.

- [ ] **Step 1: Write concurrency and retry tests.**
```ts
it('never exceeds four simultaneous calls and retries three times',async()=>{
  let active=0,peak=0,calls=0;
  const analyzer:ReceiptAnalyzer={analyzeReceipt:async()=>{
    active++; peak=Math.max(peak,active); calls++;
    await new Promise(resolve=>setTimeout(resolve,5)); active--;
    throw new AiError('UPSTREAM',true);
  }};
  // Insert five recognizing sampleReceipt rows with unique IDs/orders and
  // real small PNGs under each indexed path in this test's temp directory.
  const q=createQueue({store,config:{...config,concurrency:4},analyzer,
    onAnalyzed:()=>{throw new Error('unexpected success');}});
  q.start(); await q.drain(); await q.stop();
  expect(peak).toBe(4); expect(calls).toBe(15);
  expect(store.list('receipts').every(r=>
    r.status==='pending'&&r.attempts===3)).toBe(true);
});
```
Create the five rows with a for loop from 1 to 5 and `storeImage(config,'2026-09','originals',{name:'x.png',mime:'image/png',bytes:png})`; persist each image before queue start. Use fake timers with `advanceTimersByTimeAsync(10000)` concurrent with drain for fast deterministic retries.
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/queue.test.ts`; expect missing queue.
- [ ] **Step 3: Implement scheduler.** Maintain in-flight Set and one timer for earliest due work. Scan recognizing, non-deleted rows ordered by uploadOrder; skip duplicate pending rows. Persist attempts increment before adapter invocation, read indexed original, invoke adapter, then call onAnalyzed. On transient failure schedule remaining attempts at now+1000 then now+3000 ms; after three attempts set pending/api_failed. Terminal AiError enters pending immediately. On process restart, recognizing rows are scheduled from persisted nextAttemptAt; attempts already exhausted enter pending. Never hold a SQLite transaction across await.
```ts
const candidates=store.list('receipts').filter(r=>
  r.status==='recognizing'&&!r.deletedAt&&!inFlight.has(r.id)&&
  (!r.nextAttemptAt||r.nextAttemptAt<=now().toISOString())
).sort((a,b)=>a.uploadOrder-b.uploadOrder);
const launch=candidates.slice(0,config.concurrency-inFlight.size);
// Mark each launch ID in inFlight synchronously before starting its Promise.
// Retry due time after failed attempt n is now + [1000,3000][n-1].
```

- [ ] **Step 4: Integrate lifecycle.** Until Task 8, successful onAnalyzed stores analysis/recognizedFen and marks pending with amount_uncertain/category_uncertain, deliberately requiring a decision. Enqueue accepted uploads and confirmDistinct results; user retry resets attempts/reasons only for pending api_failed receipts and requeues. start resumes once, stop waits for active calls and clears timers, drain resolves only after all scheduled retries and active work end. Compute progress over requested upload IDs, not the whole historical pool.
- [ ] **Step 5: GREEN.** Run queue tests plus restart, missing key and one-success cases; assert uploadOrder remains unchanged despite completion order. Run API tests/typecheck.
- [ ] **Step 6: Commit.** `git add apps/api/src/queue.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/src/routes.ts apps/api/test/queue.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: queue receipt analysis with durable retries"`.

## Task 8: Confidence decisions and automatic release

**Files:** Create `apps/api/src/decision.ts`, `apps/api/test/decision.test.ts`; modify `server.ts`.

**Interfaces:** `decide(analysis:Analysis,rules:Rule[],settings:Settings):{status:'ready'|'pending';reasons:Reason[];category:Category|null}`; `applyAnalysis(store:Store,id:string,analysis:Analysis):Receipt`. Calls refineDuplicates from Task 5. Matching strong rules use normalized exact merchant or keyword tokens (normalizer is local here until extracted by Task 9).

- [ ] **Step 1: Write behavior table test.**
```ts
it.each([
  [0.95,0.90,false,'ready'],
  [0.94,0.90,false,'pending'],
  [0.99,0.99,true,'pending'],
  [0.79,0.99,false,'pending'],
] as const)('decides %s/%s ambiguous=%s',(a,c,ambiguous,status)=>{
  const analysis:Analysis={amount:'12.30',category:'耗材',merchant:null,
    date:null,confidence:{amount:a,category:c},ambiguous,keywords:[],evidence:''};
  const settings:Settings={id:'default',department:'',dateMode:'today',
    customDate:null,signerMode:'text',signerName:'',signature:null,
    amountThreshold:0.95,categoryThreshold:0.90};
  expect(decide(analysis,[],settings).status).toBe(status);
});
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/decision.test.ts`; expect decision missing.
- [ ] **Step 3: Implement strict ordering.** If ambiguous ->pending/ambiguous_amount; null amount ->amount_uncertain; null category ->category_uncertain. Below medium floors 0.80/0.70 ->pending; never infer amount from a merchant rule. Check matching strong rules before release: conflicting target categories or a target differing from the AI category ->pending/rule_conflict. At configured high thresholds with no conflict ->ready. At medium confidence, at least one matching strong rule with identical category and all matching strong rules agreeing ->ready; otherwise pending with the relevant confidence reasons.
```ts
if(analysis.ambiguous) return {
  status:'pending',reasons:['ambiguous_amount'],category:analysis.category
};
if(analysis.amount===null) return {
  status:'pending',reasons:['amount_uncertain'],category:analysis.category
};
if(analysis.category===null) return {
  status:'pending',reasons:['category_uncertain'],category:null
};
// Evaluate low floors, conflicting strong rules, high thresholds and
// consistent medium rules in exactly that order described in this step.
```

- [ ] **Step 4: Implement persistence.** applyAnalysis loads receipt, rejects generated/archived/missing or non-recognizing state, stores original analysis and recognizedFen, copies parsed paidFen/category/merchant/date, runs decision and refineDuplicates, merges unique reasons and persists atomically. No ready record has null amount/category. Default settings are the literal fixture until Task 11 stores them. Replace temporary queue callback with applyAnalysis.
- [ ] **Step 5: GREEN.** Add medium-with-agreeing-rule, conflicting rules, high-with-conflicting-rule, boundary confidences, null amount/category, no-guess and duplicate veto tests. Run API tests/typecheck.
- [ ] **Step 6: Commit.** `git add apps/api/src/decision.ts apps/api/src/server.ts apps/api/test/decision.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: release reliable receipts and isolate exceptions"`.

## Task 9: Local correction learning and editable rules

**Files:** Create `apps/api/src/learning.ts`, `apps/api/src/migrations/002-corrections.sql`, `apps/api/test/learning.test.ts`; modify `db.ts`, `decision.ts`, `receipts.ts`, `routes.ts`.

**Interfaces:** `normalizeFeature(value:string):string`; `recordCorrection(store:Store,id:string,category:Category):Rule|null`; `listRules(store:Store):Rule[]`; `saveRule(store:Store,rule:Rule):Rule`; `deleteRule(store:Store,id:string):void`; `updateReceipt(store:Store,id:string,patch:{paidFen?:number;category?:Category}):Receipt`; `confirmReceipt(store:Store,id:string):Receipt`. HTTP `PATCH /api/receipts/:id`, `POST /api/receipts/:id/confirm`, and GET/PUT/DELETE `/api/rules[/:id]`.

- [ ] **Step 1: Write consecutive-confirmation test.**
```ts
it('promotes only after three consistent confirmed corrections',()=>{
  const s=openStore(':memory:');
  for(let n=1;n<=3;n++){
    s.put('receipts',sampleReceipt({id:String(n),merchant:'  某供应商  ',
      category:'日常用品',analysis:{amount:'10.00',category:'日常用品',
      merchant:'某供应商',date:null,confidence:{amount:0.99,category:0.8},
      ambiguous:false,keywords:[],evidence:''}}));
    recordCorrection(s,String(n),'耗材');
  }
  expect(listRules(s)[0]).toMatchObject({key:'某供应商',
    category:'耗材',confirmations:3,strong:true});
  s.close();
});
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/learning.test.ts`; expect missing learning module.
- [ ] **Step 3: Implement learning.** Normalize with NFKC, trim, lowercase and collapse whitespace. Prefer merchant; if absent choose first nonempty normalized AI keyword; no usable feature ->null. A rule records original AI category, latest user category, count and timestamp; a differing correction resets count to 1 and strong false; identical corrections increment. A receipt can contribute at most one confirmation to a specific final category: store correction audit in a new `corrections` SQLite table with unique (receipt_id,category) and JSON payload (Task 3 Store exposes an added `recordConfirmation(receiptId:string,category:Category):boolean` implemented with INSERT OR IGNORE and migration `002-corrections.sql`). Rule edits validate count integer >=0 and require count>=3 for strong; deletion removes only rule/audit association, never receipts. Keep these records entirely vendor-neutral.
```ts
export function normalizeFeature(value:string):string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
}
const confirmations=previous?.category===category?previous.confirmations+1:1;
const strong=confirmations>=3;
```

- [ ] **Step 4: Implement explicit correction flow.** updateReceipt validates fen/category, prohibits generated/archived, saves paid amount/category, leaves pending until confirmReceipt. Confirmation requires nonnull valid paidFen/category and no unresolved duplicate; removes confidence/ambiguity/API reasons on explicit user confirmation, sets ready. recordCorrection runs only on confirmation, with the final category, not on each keystroke/PATCH. Preserve original analysis. Move decision normalization imports to learning.ts.
```ts
const receipt=store.get('receipts',id);
if(!receipt) throw new Error('NOT_FOUND');
if(receipt.status==='generated'||receipt.status==='archived')
  throw new Error('IMMUTABLE_RECEIPT');
if(receipt.paidFen===null||receipt.category===null)
  throw new Error('INCOMPLETE_RECEIPT');
if(receipt.duplicateIds.length&&!receipt.duplicateOverride)
  throw new Error('UNRESOLVED_DUPLICATE');
// Confirmation persists ready only after these guards and correction audit.
```

- [ ] **Step 5: GREEN.** Run learning tests plus reset-on-conflict, no-feature, repeat-confirmation, CRUD, unknown category, provider-switch and archived-edit cases. Run API tests/typecheck.
- [ ] **Step 6: Commit.** `git add apps/api/src/learning.ts apps/api/src/decision.ts apps/api/src/receipts.ts apps/api/src/routes.ts apps/api/src/db.ts apps/api/src/migrations/002-corrections.sql apps/api/test/learning.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: learn from confirmed local category corrections"`.

## Task 10: Full and partial refunds with evidence

**Files:** Create `apps/api/src/refunds.ts`, `apps/api/test/refunds.test.ts`; modify `routes.ts`.

**Interfaces:** `setRefund(store:Store,id:string,refundFen:number):Receipt`; `addRefundImage(store:Store,config:Config,id:string,input:InputImage):Promise<Receipt>`; `isEligible(receipt:Receipt):boolean`. HTTP `PUT /api/receipts/:id/refund` body `{refundFen}`; `POST /api/receipts/:id/refund-images` multipart single `file`.

- [ ] **Step 1: Write refund test.**
```ts
it('keeps main status and excludes a full refund from eligibility',()=>{
  const s=openStore(':memory:');s.put('receipts',sampleReceipt({paidFen:30000}));
  expect(netFen(setRefund(s,'receipt-1',8000))).toBe(22000);
  const full=setRefund(s,'receipt-1',30000);
  expect(full.status).toBe('ready'); expect(isEligible(full)).toBe(false);
  expect(()=>setRefund(s,'receipt-1',30001)).toThrow('INVALID_REFUND');
  expect(()=>setRefund(s,'receipt-1',-1)).toThrow('INVALID_REFUND');s.close();
});
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/refunds.test.ts`; expect missing refunds module.
- [ ] **Step 3: Implement refunds.** Require mutable receipt and nonnull paidFen; integer refund 0..paidFen. Keep original and recognizedFen unchanged. isEligible requires ready, no deletion/archive/batch, known category and netFen>0. Evidence uses storeImage with kind refunds under original upload month, preserves addition order, stores FileIndexEntry, and rolls back newly written file if persistence fails. Limit evidence upload to one file/request and 20 MiB.
```ts
export function isEligible(r:Receipt):boolean {
  return r.status==='ready'&&!r.deletedAt&&!r.archivedAt&&!r.batchId&&
    r.category!==null&&r.paidFen!==null&&netFen(r)>0;
}
```

- [ ] **Step 4: Extend refund verification.** Add zero/reset refund, multiple evidence ordering, immutable original hash, generated/archived 409, over-refund and invalid type tests. Confirm there is no new status string.
- [ ] **Step 5: GREEN and commit.** Run refund test, API suite and typecheck. `git add apps/api/src/refunds.ts apps/api/src/routes.ts apps/api/test/refunds.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: record refunds and ordered evidence"`.

## Task 11: Reimbursement defaults, signer modes and note library

**Files:** Create `apps/api/src/settings.ts`, `apps/api/test/settings.test.ts`; modify `routes.ts`, `decision.ts`, `storage.ts`.

**Interfaces:** `getSettings(store:Store):Settings`; `saveSettings(store:Store,input:Settings):Settings`; `saveSignature(store:Store,config:Config,image:InputImage):Promise<Settings>`; `saveNote(store:Store,note:Note):Note`; `deleteNote(store:Store,id:string):void`; `resolveOptions(settings:Settings,now:Date):FormOptions`. HTTP GET/PUT `/api/settings`; POST `/api/settings/signature`; GET/POST/PUT/DELETE `/api/notes[/:id]`.

- [ ] **Step 1: Write persistence and signer test.**
```ts
it('keeps multiline notes and supports deliberately blank dates',()=>{
  const s=openStore(':memory:');
  saveNote(s,{id:'note-1',name:'采购',content:'第一行\n第二行'});
  const settings=saveSettings(s,{...getSettings(s),dateMode:'blank',
    department:'门店',signerMode:'text',signerName:'张三'});
  expect(resolveOptions(settings,new Date('2026-09-03T12:00:00+08:00')))
    .toMatchObject({department:'门店',date:null,signerName:'张三'});
  expect(s.get('notes','note-1')?.content).toBe('第一行\n第二行');s.close();
});
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/settings.test.ts`; expect missing settings.
- [ ] **Step 3: Implement defaults and validation.** Default department/name empty, dateMode today, customDate null, signerMode text, signature null, thresholds 0.95/0.90. Date uses local calendar components, never UTC month truncation. Custom date must exist in the calendar; text fields limited department/name 100 chars, note name 100 and content 2000. Thresholds finite within medium floors..1. Signature mode requires an indexed image; store generated UUID image under `data/settings/signatures/` with a FileIndexEntry, safe storage and immutable bytes, including exclusive-write/DB-failure cleanup. Persist signature into Settings.
```ts
export function getSettings(store:Store):Settings {
  return store.get('settings','default')??{
    id:'default',department:'',dateMode:'today',customDate:null,
    signerMode:'text',signerName:'',signature:null,
    amountThreshold:0.95,categoryThreshold:0.90
  };
}
```

- [ ] **Step 4: Implement notes and option resolution.** IDs generated server-side on create; PUT ID must match path; delete default only after existence check. Batch snapshots later copy note content so editing/deleting the library cannot rewrite exported history. resolveOptions selects local today/custom/null, carries signer mode and the signature ref only in image mode. Replace decision.ts temporary defaults with getSettings.
```ts
export function resolveOptions(s:Settings,now:Date):FormOptions {
  const today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),
    String(now.getDate()).padStart(2,'0')].join('-');
  return {department:s.department,
    date:s.dateMode==='blank'?null:s.dateMode==='custom'?s.customDate:today,
    signerMode:s.signerMode,signerName:s.signerName,
    signature:s.signerMode==='image'?s.signature:null};
}
```

- [ ] **Step 5: GREEN.** Run settings tests including signature/text switching, invalid dates, zero-length note names, multiline round trip, secret absence and durable reopen; API suite/typecheck pass.
- [ ] **Step 6: Commit.** `git add apps/api/src/settings.ts apps/api/src/routes.ts apps/api/src/decision.ts apps/api/src/storage.ts apps/api/test/settings.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: manage reimbursement defaults and notes"`.

## Task 12: Pool totals, manual batch creation and immutable snapshots

**Files:** Create `apps/api/src/batches.ts`, `apps/api/test/batches.test.ts`; modify `receipts.ts`, `routes.ts`.

**Interfaces:** `poolTotals(receipts:Receipt[]):Totals`; `createBatch(store:Store,ids:string[],options:FormOptions,now:Date):Batch`; `getBatch(store:Store,id:string):Batch`; `deleteReceipt(store:Store,id:string,now:Date):void`; `listReceipts(store:Store,view:'pool'|'pending'):Receipt[]`. HTTP GET `/api/receipts?view=pool|pending`; GET `/api/pool/totals`; DELETE `/api/receipts/:id`; POST `/api/batches` body `{receiptIds,options}`; GET `/api/batches/:id`.

- [ ] **Step 1: Write atomic batch test.**
```ts
it('uses integer net amounts and only manually selected ready receipts',()=>{
  const s=openStore(':memory:');
  s.put('receipts',sampleReceipt({id:'a',paidFen:3633,uploadOrder:2}));
  s.put('receipts',sampleReceipt({id:'b',paidFen:30000,refundFen:8000,uploadOrder:1}));
  const b=createBatch(s,['a','b'],resolveOptions(getSettings(s),new Date()),new Date());
  expect(b.totalFen).toBe(25633);
  expect(b.items.map(i=>i.receiptId)).toEqual(['b','a']);
  expect(s.get('receipts','a')?.status).toBe('generated');
  expect(()=>createBatch(s,['a'],b.options,new Date())).toThrow('NOT_ELIGIBLE');
  expect(s.list('batches')).toHaveLength(1);s.close();
});
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/batches.test.ts`; expect batches missing.
- [ ] **Step 3: Implement totals and soft deletion.** Initialize every category subtotal to 0; count only isEligible rows; add netFen using safe integer/overflow checks. Pool list includes unbatched ready fully refunded records so users can see/edit refunds; totals excludes them. Pending list shows only pending, non-deleted/non-archived records. Sort all lists by uploadOrder. Soft deletion writes deletedAt, leaves hashes and files; generated/archived deletion returns conflict.
```ts
export function poolTotals(receipts:Receipt[]):Totals {
  const byCategory=Object.fromEntries(CATEGORIES.map(c=>[c,0])) as Record<Category,number>;
  let totalFen=0,count=0;
  for(const receipt of receipts.filter(isEligible)){
    const value=netFen(receipt);count++;totalFen+=value;
    formatFen(totalFen);byCategory[receipt.category!]+=value;
  }
  return {count,totalFen,byCategory};
}
```

- [ ] **Step 4: Implement manual transaction.** Reject empty/repeated/missing IDs and any ineligible receipt before writes. No amount threshold or automatic month-end closure. Snapshot fields from receipts; stable sort by uploadOrder; group order will be first appearance (Task 14). Copy options, current notes and image refs. Batch month is local creation month; receipts may span upload months. Persist batch and mark all selected generated/batchId atomically; one receipt cannot belong to two batches. Initially sheets=[]; Task 14 creates sheets during batch creation before persistence. No API returns a falsely usable preview while sheets is empty. Validate FormOptions server-side using the same department/date/signer constraints as settings; resolve any signature ID through the file index and ignore client-supplied paths/hashes. A text-mode option clears signature.
```ts
return store.transact(()=>{
  if(!ids.length||new Set(ids).size!==ids.length) throw new Error('INVALID_SELECTION');
  const rows=ids.map(id=>store.get('receipts',id));
  if(rows.some(r=>!r||!isEligible(r))) throw new Error('NOT_ELIGIBLE');
  const selected=(rows as Receipt[]).sort((a,b)=>a.uploadOrder-b.uploadOrder);
  const items:Snapshot[]=selected.map(r=>({
    receiptId:r.id,uploadOrder:r.uploadOrder,category:r.category!,
    paidFen:r.paidFen!,refundFen:r.refundFen,netFen:netFen(r),
    original:structuredClone(r.original),refundImages:structuredClone(r.refundImages)
  }));
  const totalFen=items.reduce((sum,item)=>sum+item.netFen,0);
  formatFen(totalFen);
  const batch:Batch={
    id:randomUUID(),month:now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0'),
    createdAt:now.toISOString(),totalFen,items,sheets:[],
    options:structuredClone(options),notes:structuredClone(store.list('notes')),
    pdfPath:null,archivedAt:null
  };
  store.put('batches',batch);
  for(const receipt of selected)
    store.put('receipts',{...receipt,status:'generated',batchId:batch.id});
  return batch;
});
```

- [ ] **Step 5: GREEN.** Add partial/full refund totals, all ten categories, invalid selection rollback, double generation, deleted record, single-fen batch and cross-month cases. Run API tests/typecheck.
- [ ] **Step 6: Commit.** `git add apps/api/src/batches.ts apps/api/src/receipts.ts apps/api/src/routes.ts apps/api/test/batches.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: close selected receipts into immutable batches"`.

## Task 13: Programmatic Chinese uppercase currency

**Files:** Create `apps/api/src/uppercase.ts`, `apps/api/test/uppercase.test.ts`.

**Interfaces:** `chineseUppercase(fen:number):string`, accepts the same integer range as formatFen. No API/AI call.

- [ ] **Step 1: Write table-driven test.**
```ts
it.each([
  [0,'零元整'],[1,'零元壹分'],[10,'零元壹角'],[100,'壹元整'],
  [101,'壹元零壹分'],[110,'壹元壹角'],[100100,'壹仟零壹元整'],
  [1000100,'壹万零壹元整'],[100000001,'壹佰万元零壹分'],
  [123456789,'壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分']
])('formats %s as %s',(fen,text)=>expect(chineseUppercase(fen)).toBe(text));
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/uppercase.test.ts`; expect uppercase module missing.
- [ ] **Step 3: Implement four-digit section conversion.**
```ts
const digits='零壹贰叁肆伍陆柒捌玖';
function section(n:number):string {
  let out='',gap=false;
  for(let p=3;p>=0;p--){
    const d=Math.floor(n/10**p)%10;
    if(d){if(gap&&out)out+='零';out+=digits[d]+['','拾','佰','仟'][p];gap=false;}
    else if(out)gap=true;
  }
  return out;
}
```
For integer yuan, decompose into three base-10000 groups 亿/万/units. Append nonzero sections descending; insert one 零 between nonzero groups if an intervening group is zero or lower group <1000, collapsing duplicate 零. Zero yuan is 零. Append 元; if both decimal digits zero append 整; otherwise append nonzero 角 and 分, inserting 零 before 分 only when yuan>0 and jiao=0. Validate integer/range before arithmetic with formatFen.
- [ ] **Step 4: GREEN.** Run uppercase tests plus 10000000100 -> 壹亿零壹元整, 100100000 -> 壹佰万壹仟元整, overflow/negative/fraction rejection. Run API suite/typecheck.
- [ ] **Step 5: Commit.** `git add apps/api/src/uppercase.ts apps/api/test/uppercase.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: format exact Chinese uppercase amounts"`.

## Task 14: Deterministic category grouping, measured packing and manual moves

**Files:** Create `apps/api/src/render/layout.ts`, `apps/api/test/layout.test.ts`; modify `batches.ts`, `routes.ts`.

**Interfaces:** `LayoutMetrics={summaryWidth:number;bodyHeight:number;lineHeight:number;groupPadding:number;maxSheetFen:number;measure:(text:string)=>number}`; `groupItems(items:Snapshot[]):FormGroup[]`; `wrapAmounts(amountsFen:number[],metrics:LayoutMetrics):string[]`; `groupHeight(group:FormGroup,metrics:LayoutMetrics):number`; `packGroups(groups:FormGroup[],metrics:LayoutMetrics):FormSheet[]`; `moveGroup(sheets:FormSheet[],category:Category,direction:-1|1,metrics:LayoutMetrics):FormSheet[]`; `updateBatchLayout(store:Store,id:string,sheets:FormSheet[]):Batch` (server validates using metrics). HTTP POST `/api/batches/:id/move` body `{category,direction}`; PATCH `/api/batches/:id/options` body `{options,noteBySheet:Record<string,string|null>}`.

- [ ] **Step 1: Write deterministic packing test.**
```ts
const m:LayoutMetrics={summaryWidth:55,bodyHeight:40,lineHeight:10,
  groupPadding:10,maxSheetFen:999999999,measure:t=>t.length*5};
it('keeps categories intact and amounts in upload order',()=>{
  const item=(receiptId:string,category:Category,uploadOrder:number,netFen:number):Snapshot=>({
    receiptId,category,uploadOrder,netFen,paidFen:netFen,refundFen:0,
    original:sampleReceipt().original,refundImages:[]});
  const groups=groupItems([item('b','耗材',2,1730),item('a','耗材',1,3633),
    item('c','食材',3,100)]);
  expect(groups[0].amountsFen).toEqual([3633,1730]);
  const sheets=packGroups(groups,m);
  expect(sheets).toHaveLength(2);
  expect(sheets[0].groups[0].totalFen).toBe(5363);
});
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/layout.test.ts`; expect layout missing.
- [ ] **Step 3: Implement measured greedy packing.** Group sorted items in Map insertion order; append formatFen(netFen) tokens separated by two spaces. Wrap whole tokens only when measured width exceeds summaryWidth. Reject even a single too-wide token with `LAYOUT_OVERFLOW`. Height is max(lineHeight,wrappedLines*lineHeight)+groupPadding. Append whole category to current sheet while remaining height and the nine-digit money grid's maxSheetFen=999999999 permit, otherwise create next sheet; IDs deterministic `sheet-001`, etc. Oversized category or a category total over maxSheetFen -> `CATEGORY_TOO_LARGE` with category and measured required height/amount, before creating a batch. This physical grid capacity is a split constraint, never a minimum reimbursement threshold.
```ts
export function groupHeight(g:FormGroup,m:LayoutMetrics):number {
  return Math.max(m.lineHeight,wrapAmounts(g.amountsFen,m).length*m.lineHeight)
    +m.groupPadding;
}
```
- [ ] **Step 4: Implement allowed moves and snapshot update.** Find category once; destination must be adjacent existing sheet or a new trailing sheet; reject previous-of-first. Move the whole group; preserve group item order. Validate destination measured height and summed amount capacity, remove empty source sheet, keep persistent sheet IDs/notes, and ensure each original category/receipt appears exactly once with unchanged amounts. No silent repacking after user's move. Refuse edits when pdfPath set. Wire group/pack into createBatch using a local `defaultMetrics():LayoutMetrics` exported by layout.ts with summaryWidth=98*72/25.4-12, bodyHeight=58*72/25.4, lineHeight=14, groupPadding=8, maxSheetFen=999999999 and provisional measure `text.length*5`; Task 15 replaces that provisional measurement with exact PDF font metrics.
- [ ] **Step 5: GREEN.** Run layout tests plus deterministic repeated calls, dates out of order, exact fit, too-large single category, move overflow and preservation of attachment sequence. Run API tests/typecheck.
- [ ] **Step 6: Commit.** `git add apps/api/src/render/layout.ts apps/api/src/batches.ts apps/api/src/routes.ts apps/api/test/layout.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: pack categories into measured reimbursement sheets"`.

## Task 15: Measured reimbursement form with text or handwritten signer

**Files:** Create `apps/api/src/render/form.ts`, `apps/api/assets/form-geometry.json`, `apps/api/assets/fonts/NotoSansSC-Regular.ttf`, `apps/api/assets/fonts/OFL.txt`, `apps/api/test/form.test.ts`, `docs/form-calibration.md`; modify `batches.ts`, API manifest/lockfile.

**Interfaces:** `createFormDocument():PDFKit.PDFDocument`; `formMetrics(doc:PDFKit.PDFDocument):LayoutMetrics`; `drawForm(doc:PDFKit.PDFDocument,batch:Batch,sheet:FormSheet,signatureBytes:Buffer|null):void`; `sheetAttachmentCount(batch:Batch,sheet:FormSheet):number`. Rendering adds one landscape page per call. All signed/notes text is literal text, never markup.

- [ ] **Step 1: Add test/render dependencies.** `pnpm --filter @auto-reimbursement/api add pdfkit`; `pnpm --filter @auto-reimbursement/api add -D @types/pdfkit pdfjs-dist`. Obtain static Noto Sans SC Regular TTF from its official distribution, retain OFL license, verify font loads in PDFKit; never silently substitute a font missing Chinese glyphs. Record source/checksum in calibration doc.
- [ ] **Step 2: Write a real PDF extraction test.**
```ts
const doc=createFormDocument(), chunks:Buffer[]=[];
doc.on('data',b=>chunks.push(b));
const done=new Promise<Buffer>(resolve=>doc.on('end',()=>resolve(Buffer.concat(chunks))));
drawForm(doc,batch,sheet,null);doc.end();
const pdf=await getDocument({data:new Uint8Array(await done),
  useSystemFonts:false}).promise;
const content=await (await pdf.getPage(1)).getTextContent();
const text=content.items.flatMap(i=>'str' in i?[i.str]:[]).join('');
for(const label of ['费用报销单','报销部门','报销项目','摘要','金额',
  '合计','大写','单据及附件共','备注','报销人','会计主管','复核','出纳','领导审批'])
  expect(text).toContain(label);
expect(text).toContain('壹佰叁拾元柒角肆分');
```
Define batch using createBatch with receipts 3633,1730,3575,4136 fen in 耗材 and resolveOptions from settings; obtain `sheet=batch.sheets[0]`. Import PDF.js `getDocument` from `pdfjs-dist/legacy/build/pdf.mjs`.
- [ ] **Step 3: RED.** `pnpm --filter @auto-reimbursement/api test test/form.test.ts`; expect missing form renderer.
- [ ] **Step 4: Implement geometry and exact metrics.** JSON uses millimeters and the photographed proportions: page 270x165, margins 5, centered title y=9 with underlines y=21 and 22; department/date/attachment count baseline y=29; table x=5,y=34,width=260; columns project=50, summary=98, amount=46, vertical label=8, notes/approval=58. Header height=17 (amount heading 8.5 plus digit labels 8.5), writable body=58, total row=12, uppercase/loan strip=14; footer baseline y=146. The right notes area spans header plus approximately half the body, with a horizontal split to a blank leader-approval area; its vertical labels read 备注 above and 领导审批 below. Use thin black 0.5pt rules and muted printed blue `#4B859E`; dynamic values are black. Nine equal amount digit columns span the 46mm region. Convert once with `pt=mm*72/25.4`. Font size 10pt, summary lineHeight 14pt, groupPadding 8pt, bodyHeight 58mm in points, summaryWidth 98mm minus 12pt padding, maxSheetFen 999999999. Use identical PDF font and `doc.widthOfString` for pack and draw. Export createFormDocument with autoFirstPage false and font registered. Fail visibly if font unavailable.
```ts
const mm=(n:number)=>n*72/25.4;
export function formMetrics(doc:PDFKit.PDFDocument):LayoutMetrics {
  doc.font('NotoSansSC').fontSize(10);
  return {summaryWidth:mm(98)-12,bodyHeight:mm(58),lineHeight:14,
    groupPadding:8,maxSheetFen:999999999,measure:text=>doc.widthOfString(text)};
}
```

- [ ] **Step 5: Implement drawing.** Draw the photographed printed structure, including double title underline, top 单据及附件共 __ 页 field, digit-grid amounts, upper notes box/lower leader-approval box, uppercase/loan strip and footer labels. Keep 原借款 and 应退（补）款 blank because they are printed template fields outside MVP financial calculations. Preserve at least five faint body-row guides, letting a category span multiple rows without splitting it. Each category region contains only wrapped numeric summary and its programmatic subtotal; no copied handwritten item names. Render fen as nine right-aligned digits in the amount grid (`String(fen).padStart(3,'0').padStart(9,' ')`), one character per column, with blank leading cells. Summary and attachment labels use formatFen; the amount grid's rightmost two columns always carry 角/分 even when zero. Total and Chinese uppercase use the sheet's groups, not the whole multi-sheet batch. Top sheet-plus-attachment-page count is `1 + sheetAttachmentCount(batch,sheet)` under the one-image-per-page rule; show the separate attachment-image count in preview metadata as 附件张数, while retaining the reference form's printed page-count wording. Multiline note is chosen per sheet from batch.notes and occupies only the upper notes box; measure/reject NOTE_OVERFLOW before export. Print signer text or aspect-fit signature image only in the 报销人 cell; accountant/reviewer/cashier/approval fields remain blank. Reject FORM_TEXT_OVERFLOW instead of clipping; use safe local reads for signatures.
```ts
const total=sheet.groups.reduce((sum,group)=>sum+group.totalFen,0);
const digits=String(total).padStart(3,'0').padStart(9,' ');
if(digits.length>9) throw new Error('FORM_AMOUNT_OVERFLOW');
const uppercase=chineseUppercase(total);
const note=batch.notes.find(n=>n.id===sheet.noteId)?.content??'';
// Use total/uppercase/digits in the total row and note in the upper right box.
```

- [ ] **Step 6: GREEN and visual calibration.** Run test, API suite/typecheck. Render fixture PDF to PNG using a local PDF rasterizer (install Playwright/Chromium for a browser PDF.js rasterizer here if none exists; record the exact command in calibration doc). Compare separately against private references A and B using normalized page corners to account for perspective, without committing either source image or a derivative containing handwriting. Inspect title/underline, five body guides, column ratios, digit labels, notes/approval split, totals, uppercase/loan strip and footer alignment; adjust geometry JSON until both comparisons agree on printed structure. Test long summaries, text/image signer variants and blank dates for overlap/cropping. Record assumptions about unmeasured physical dimensions; no exact-millimeter fidelity claim is justified by perspective photos alone.
- [ ] **Step 7: Commit.** `git add apps/api/src/render/form.ts apps/api/assets apps/api/src/batches.ts apps/api/test/form.test.ts apps/api/package.json pnpm-lock.yaml docs/form-calibration.md docs/superpowers/implementation-log.md`; `git commit -m "feat: render measured Chinese reimbursement forms"`.

## Task 16: Full preview PDF with ordered originals and refund evidence

**Files:** Create `apps/api/src/render/attachments.ts`, `apps/api/src/render/pdf.ts`, `apps/api/test/pdf.test.ts`; modify `routes.ts`, `storage.ts`.

**Interfaces:** `Attachment={receiptId:string;image:ImageRef;kind:'original'|'refund';label:string}`; `orderedAttachments(batch:Batch,sheet:FormSheet):Attachment[]`; `drawAttachment(doc:PDFKit.PDFDocument,attachment:Attachment,bytes:Buffer):void`; `renderBatchPdf(config:Config,batch:Batch):Promise<Buffer>`; `exportBatchPdf(store:Store,config:Config,id:string):Promise<Batch>`. GET `/api/batches/:id/preview.pdf` renders the full draft PDF or serves the immutable saved PDF when pdfPath exists; POST `/api/batches/:id/export -> Batch`; GET `/api/batches/:id/pdf` serves saved bytes.

- [ ] **Step 1: Write attachment ordering test.**
```ts
const ordered=orderedAttachments(batch,sheet);
expect(ordered.map(a=>[a.receiptId,a.kind])).toEqual([
  ['a','original'],['a','refund'],['b','original']
]);
expect(ordered[0].label).toContain('原实付 ¥300.00 / 退款 ¥80.00 / 实报 ¥220.00');
```
Build batch with two snapshots in one group (a 30000 paid/8000 refund, b 4100 paid), attach one refund ImageRef to a and real in-memory-generated PNG files in test temp storage. Add two-sheet PDF assertion: pages are form1, originals/refunds1, form2, originals/refunds2.
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/api test test/pdf.test.ts`; expect missing attachment/PDF exports.
- [ ] **Step 3: Implement ordered pages.** Flatten sheet.groups receiptIds and resolve exactly one snapshot per ID; for each append original then refundImages in stored order. Labels carry category, formatFen(netFen), 原始凭证/退款凭证 and refund breakdown. One image per portrait A4 attachment page is an acceptable deterministic MVP layout: margin 12mm, 18mm non-overlapping label area, aspect-fit image in remaining area, never stretch or crop. Decode WebP to PNG only in render memory because PDFKit cannot embed WebP; saved originals remain byte-identical.
```ts
export function orderedAttachments(batch:Batch,sheet:FormSheet):Attachment[] {
  return sheet.groups.flatMap(group=>group.receiptIds.flatMap(id=>{
    const item=batch.items.find(i=>i.receiptId===id);
    if(!item) throw new Error('INVALID_BATCH');
    const money=item.refundFen?'原实付 ¥'+formatFen(item.paidFen)+
      ' / 退款 ¥'+formatFen(item.refundFen)+' / 实报 ¥'+formatFen(item.netFen):
      '¥'+formatFen(item.netFen);
    return [
      {receiptId:id,image:item.original,kind:'original' as const,
        label:group.category+' · '+money+' · 原始凭证'},
      ...item.refundImages.map(image=>({receiptId:id,image,kind:'refund' as const,
        label:group.category+' · '+money+' · 退款凭证'}))
    ];
  }));
}
```

- [ ] **Step 4: Implement preview and atomic export.** Render all pages to one Buffer, awaiting stream completion/error. Read indexed images with safePath; missing required image -> `MISSING_ATTACHMENT`, identify receipt in UI and produce no partial export. Render form then its attachment pages in sheet order. Draft preview uses identical renderBatchPdf; exported preview serves the stored PDF so archived/cleaned history remains previewable. Export exclusive temporary file under the batch creation month exports directory, rename atomically to UUID.pdf, then save Batch.pdfPath and file index/hash in a DB transaction; on failure remove only the new file. Repeated export returns the existing immutable PDF; no duplicate financial batch.
```ts
for(const sheet of batch.sheets){
  drawForm(doc,batch,sheet,signatureBytes);
  for(const attachment of orderedAttachments(batch,sheet)){
    if(attachment.image.deletedAt) throw new Error('MISSING_ATTACHMENT');
    const bytes=await readFile(safePath(config.dataDir,attachment.image.path));
    drawAttachment(doc,attachment,bytes);
  }
}
doc.end();
// Resolve renderBatchPdf only on the stream end event, reject on error.
```

- [ ] **Step 5: GREEN.** Assert PDF.js page count/text/order, no raw file paths or API keys, byte equality of stored originals before/after, both signer modes, multi-page set and missing-image failure. Run API suite/typecheck.
- [ ] **Step 6: Commit.** `git add apps/api/src/render/attachments.ts apps/api/src/render/pdf.ts apps/api/src/routes.ts apps/api/src/storage.ts apps/api/test/pdf.test.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: export full PDFs with ordered refund evidence"`.

## Task 17: Browser upload screen and batch-specific progress

**Files:** Create `apps/web/src/api.ts`, `apps/web/src/pages/UploadPage.tsx`, `apps/web/src/pages/UploadPage.test.tsx`, `apps/web/src/styles.css`; modify `App.tsx`, `App.test.tsx`, `vite.config.ts`.

**Interfaces:** `api.upload(files:File[]):Promise<UploadResult>`; `api.progress(ids:string[]):Promise<Progress>`; `api.imageUrl(id:string):string`; `UploadPage({client=api}:{client?:typeof api}):React.JSX.Element`. API client object gains named methods in subsequent tasks; use `Pick<typeof api,'upload'|'progress'|'imageUrl'>` for UploadPage client prop to keep mocks narrow. Vite proxies `/api` and `/health` to `http://127.0.0.1:3000`.

- [ ] **Step 1: Write upload interaction test.**
```tsx
const client={upload:vi.fn().mockResolvedValue({accepted:[],rejected:[]}),
  progress:vi.fn(),imageUrl:(id:string)=>'/api/images/'+id};
render(<UploadPage client={client}/>);
fireEvent.change(screen.getByLabelText('选择凭证图片'),{
  target:{files:Array.from({length:51},(_,n)=>new File(['x'],n+'.png',{type:'image/png'}))}
});
expect(screen.getByRole('alert')).toHaveTextContent('单次最多 50 张');
expect(client.upload).not.toHaveBeenCalled();
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/web test src/pages/UploadPage.test.tsx`; expect missing UploadPage.
- [ ] **Step 3: Implement typed client.** Shared `requestJson<T>(path:string,init?:RequestInit):Promise<T>` checks response.ok and throws an Error with safe ApiErrorBody.message. Upload FormData appends each File in received array order without sorting; no manual multipart Content-Type. Never include backend config/key in Vite env.
```ts
export async function requestJson<T>(path:string,init?:RequestInit):Promise<T>{
  const response=await fetch(path,init);
  if(!response.ok){
    const error=await response.json() as ApiErrorBody;
    throw new Error(error.message);
  }
  return response.json() as Promise<T>;
}
const upload=async(files:File[])=>{
  const data=new FormData();for(const file of files)data.append('files',file);
  return requestJson<UploadResult>('/api/receipts/upload',{method:'POST',body:data});
};
```

- [ ] **Step 4: Implement upload view.** Large labeled drag target and file picker, keyboard accessible; reject >50 client-side with visible alert, allow future upload batches with no monthly cap. Disable submission during HTTP upload, show uploading count, accepted/rejected filenames and exact duplicate links. Poll progress for accepted IDs every 1 second while recognizing>0; show total/recognizing/success(ready)/pending counts; cleanup timer and abort on unmount. Failed polling shows a retry control and stops tight loops. Distinguish network upload errors from AI pending results.
```tsx
<input aria-label="选择凭证图片" type="file" multiple
  accept="image/jpeg,image/png,image/webp"
  onChange={event=>void submit(Array.from(event.target.files??[]))}/>
<p>识别中：{progress.recognizing}</p>
<p>成功数：{progress.ready}</p>
<p>待处理数：{progress.pending}</p>
{error&&<p role="alert">{error}</p>}
```
Declare component state `progress:Progress` initialized to all zeros, `error:string|null`, and local `submit(files:File[]):Promise<void>` implementing the stated upload/poll lifecycle.

- [ ] **Step 5: Wire page shell.** Keep Automatic Reimbursement Assistant as accessible app title for existing smoke test and add Chinese navigation label 首页 / 上传凭证. Import styles with legible Chinese font fallback, clear focus rings and responsive content width. Other pages added in Tasks 18–19.
- [ ] **Step 6: GREEN.** Add drag/drop order, retry, completed polling stops and rejected item message tests. Run web suite, `pnpm typecheck`, and `pnpm --filter @auto-reimbursement/web build`; expect pass and no key strings in generated assets.
- [ ] **Step 7: Commit.** `git add apps/web/src/api.ts apps/web/src/pages/UploadPage.tsx apps/web/src/pages/UploadPage.test.tsx apps/web/src/styles.css apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/vite.config.ts docs/superpowers/implementation-log.md`; `git commit -m "feat: add batch upload and recognition progress UI"`.

## Task 18: Reimbursement pool and exception-only pending UI

**Files:** Create `apps/web/src/pages/PoolPage.tsx`, `PendingPage.tsx`, their `.test.tsx` files, `apps/web/src/components/ReceiptEditor.tsx`, `ReceiptCard.tsx`; modify `api.ts`, `App.tsx`, `styles.css`.

**Interfaces:** API methods `receipts(view:'pool'|'pending'):Promise<Receipt[]>`, `totals():Promise<Totals>`, `updateReceipt(id:string,patch:{paidFen?:number;category?:Category}):Promise<Receipt>`, `confirmReceipt(id:string):Promise<Receipt>`, `confirmDistinct(id:string):Promise<Receipt>`, `retryReceipt(id:string):Promise<Receipt>`, `setRefund(id:string,refundFen:number):Promise<Receipt>`, `addRefundImage(id:string,file:File):Promise<Receipt>`, `deleteReceipt(id:string):Promise<void>`, `settings():Promise<Settings>`, `createBatch(ids:string[],options:FormOptions):Promise<Batch>`. `PoolPage({onBatch}:{onBatch:(id:string)=>void})` and `PendingPage()`.

- [ ] **Step 1: Write accessible interaction tests.** Mock api module with Vitest and use fixed Receipt fixtures constructed with the complete shared shape in `apps/web/src/test/fixtures.ts` (create this file). Return pending uncertain/duplicate/API-failed records and ready pool records independently.
```tsx
render(<PendingPage/>);
expect(await screen.findByText('金额无法确定')).toBeInTheDocument();
fireEvent.change(screen.getByLabelText('最终实付金额'),{target:{value:'36.33'}});
fireEvent.change(screen.getByLabelText('分类'),{target:{value:'耗材'}});
fireEvent.click(screen.getByRole('button',{name:'确认可报销'}));
await waitFor(()=>expect(api.updateReceipt).toHaveBeenCalledWith('a',
  {paidFen:3633,category:'耗材'}));
await waitFor(()=>expect(api.confirmReceipt).toHaveBeenCalledWith('a'));
```
- [ ] **Step 2: RED.** `pnpm --filter @auto-reimbursement/web test src/pages/PoolPage.test.tsx src/pages/PendingPage.test.tsx`; expect missing page exports.
- [ ] **Step 3: Implement cards and editor.** Show thumbnail link, formatFen amount, fixed category, Chinese status, auxiliary merchant/date, original analysis/confidence in expandable details. Editor accepts decimal text through parseFen and a CATEGORIES select; partial/full refund controls show original/refund/net separately, upload refund evidence, delete with explicit confirmation. Save and confirm are separate HTTP calls, with button disabled until both complete; server errors remain visible and preserve inputs.
```tsx
<label>分类<select aria-label="分类" value={category}
  onChange={event=>setCategory(event.target.value as Category)}>
  {CATEGORIES.map(value=><option key={value} value={value}>{value}</option>)}
</select></label>
```
ReceiptEditor props are `{receipt:Receipt;onSaved:(receipt:Receipt)=>void}`; local category state starts with receipt.category or an empty option labeled 请选择分类. Do not cast that empty value to a real category on submit.

- [ ] **Step 4: Implement pool/pending.** Pool displays all ten subtotals, eligible count and total from backend; checkboxes select eligible positive-net rows only. Generate invokes createBatch with current settings-derived FormOptions (local date rule shared as explicit browser helper `formOptionsFromSettings(settings:Settings,now:Date):FormOptions` in api.ts), then onBatch navigates to preview. Pending displays only exceptions with mapped reasons; suspected duplicate includes historical image and button 确认不是重复，继续加入; API failure offers retry; unknown amount never prefilled with zero. Normal ready results need no per-image confirmation.
```ts
async function confirmEdit(id:string,amount:string,category:Category){
  await api.updateReceipt(id,{paidFen:parseFen(amount),category});
  return api.confirmReceipt(id);
}
const labels:Record<Reason,string>={
  amount_uncertain:'金额无法确定',category_uncertain:'分类低置信度',
  api_failed:'API 最终失败',suspected_duplicate:'疑似重复',
  ambiguous_amount:'存在多个支付金额',unreadable:'图片无法读取',
  rule_conflict:'历史规则冲突'
};
```

- [ ] **Step 5: GREEN.** Assert decimal precision, fixed categories, full refund disabled selection, empty selection message, successful correction leaves pending, original viewer, duplicate evidence and no ready records in pending. Run web suite/typecheck/build.
- [ ] **Step 6: Commit.** `git add apps/web/src/pages/PoolPage.tsx apps/web/src/pages/PoolPage.test.tsx apps/web/src/pages/PendingPage.tsx apps/web/src/pages/PendingPage.test.tsx apps/web/src/components apps/web/src/test/fixtures.ts apps/web/src/api.ts apps/web/src/App.tsx apps/web/src/styles.css docs/superpowers/implementation-log.md`; `git commit -m "feat: build reimbursement pool and exception review"`.

## Task 19: Preview, history, settings, archive and backup workflows

**Files:** Create `apps/api/src/archive.ts`, `apps/api/src/backup.ts`, `apps/api/src/migrations/003-backups.sql`, `apps/api/test/maintenance.test.ts`; modify `apps/api/src/db.ts`, API manifest/lockfile; `apps/web/src/pages/PreviewPage.tsx`, `HistoryPage.tsx`, `SettingsPage.tsx`, `pages/WorkflowPages.test.tsx`; `apps/web/src/components/NotesEditor.tsx`, `RulesEditor.tsx`; modify `routes.ts`, `api.ts`, `App.tsx`, `styles.css`.

**Interfaces:** `archiveMonth(store:Store,month:string,now:Date):MaintenanceResult`; `unarchiveMonth(store:Store,month:string):MaintenanceResult`; `cleanOriginals(store:Store,config:Config,month:string,confirmation:string):Promise<MaintenanceResult>`; `backupAll(store:Store,config:Config):Promise<{path:string;includesImages:false}>`; `history(store:Store):HistoryMonth[]`. API GET `/api/history`; POST `/api/archive/:month`, `/api/unarchive/:month`; POST `/api/cleanup/:month` body `{confirmation:'DELETE ORIGINALS YYYY-MM'}`; POST `/api/backup -> BackupResult`; GET `/api/backups/:id` streams an indexed generated backup.

Browser API methods: `batch(id):Promise<Batch>`, `moveGroup(id,category,direction):Promise<Batch>`, `saveBatchOptions(id,options,noteBySheet):Promise<Batch>`, `exportBatch(id):Promise<Batch>`, `history():Promise<HistoryMonth[]>`, `saveSettings(settings):Promise<Settings>`, `saveSignature(file):Promise<Settings>`, `notes():Promise<Note[]>`, `saveNote(note):Promise<Note>`, `deleteNote(id):Promise<void>`, `rules():Promise<Rule[]>`, `saveRule(rule):Promise<Rule>`, `deleteRule(id):Promise<void>`, `apiStatus():Promise<ApiStatus>`, `archive(month):Promise<MaintenanceResult>`, `unarchive(month):Promise<MaintenanceResult>`, `cleanup(month,confirmation):Promise<MaintenanceResult>`, `backup():Promise<BackupResult>`. Parameters are string IDs/months, Category, direction -1|1, FormOptions and Record<string,string|null> as in prior contracts; files are File. Preview/PDF URLs are `/api/batches/{id}/preview.pdf` and `/api/batches/{id}/pdf`.

- [ ] **Step 1: Write maintenance RED test.**
```ts
it('archives without losing duplicate evidence or financial history',()=>{
  const s=openStore(':memory:');s.put('receipts',sampleReceipt());
  expect(archiveMonth(s,'2026-09',new Date()).affected).toBe(1);
  expect(s.get('receipts','receipt-1')?.status).toBe('archived');
  expect(findDuplicates(s,s.get('receipts','receipt-1')!.original).exactId)
    .toBe('receipt-1');
  unarchiveMonth(s,'2026-09');
  expect(s.get('receipts','receipt-1')?.status).toBe('ready');s.close();
});
```
Run `pnpm --filter @auto-reimbursement/api test test/maintenance.test.ts`; expect missing archive module.
- [ ] **Step 2: Implement archive invariants.** Archiving month selects receipts by upload month plus batches by creation month. Archive all receipts linked to selected batches even if their upload month differs, and batches linked to selected receipts only if all their receipts can be included; include the entire linked batch consistently. Reject recognizing/pending receipts and draft batches (pdfPath null) with `MONTH_HAS_UNFINISHED_WORK`, leaving all rows unchanged. Store previous status and archivedAt, set archived, never remove files. Unarchive restores prior ready/generated status and clears archive timestamps for the same linked set. History retains all records and groups batches by creation month.
```ts
const unfinished=selectedReceipts.some(r=>r.status==='recognizing'||r.status==='pending')||
  selectedBatches.some(b=>b.pdfPath===null);
if(unfinished) throw new Error('MONTH_HAS_UNFINISHED_WORK');
store.transact(()=>{
  for(const r of selectedReceipts){
    if(r.status==='archived') continue;
    store.put('receipts',{...r,statusBeforeArchive:r.status,
      status:'archived',archivedAt:now.toISOString()});
  }
  for(const b of selectedBatches)
    store.put('batches',{...b,archivedAt:now.toISOString()});
});
```
Compute selectedReceipts/selectedBatches as a fixed point: seed the target month, repeatedly add linked batches and all of their receipts until both sets stop growing. Apply the same linked-set selection to unarchive.

- [ ] **Step 3: Implement explicit cleanup and consistent backup.** Cleanup only archived months with exported PDFs for every affected receipt; require exact confirmation text. Delete original payment image files only, not refund evidence/PDFs; resolve every target under dataDir using file index and safePath, check record association, mark original.deletedAt and file index entries after successful per-file deletion. Update matching batch image refs' deletedAt metadata without changing financial snapshots. Missing already-cleaned file is idempotent. Errors return count and a safe failed-ID message; never remove directories recursively. Backup uses store.backupTo into UUID temp folder, then opens that completed SQLite snapshot with openStore to read settings.json, rules.json and files.json; close the snapshot handle before ZIP creation. This ensures all four artifacts describe the same snapshot without holding a synchronous transaction across async backup. Include manifest.json with schema version, timestamp and `includesImages:false`. Add `fflate` dependency to produce ZIP from these explicit filenames, persist under data/backups/UUID.zip, index download IDs separately in a new `backups` SQLite table migration `003-backups.sql` and Store methods `putBackup(id:string,path:string):void`, `getBackup(id:string):string|null`. No environment/API key included. UI states that original images/PDFs are not included in this minimum structured backup and that copying the whole data folder is needed for complete media recovery.
```ts
await store.backupTo(snapshotPath);
const snapshot=openStore(snapshotPath);
try {
  const structured={
    'settings.json':JSON.stringify(snapshot.list('settings')),
    'rules.json':JSON.stringify(snapshot.list('rules')),
    'files.json':JSON.stringify(snapshot.list('files'))
  };
  const databaseBytes=new Uint8Array(await readFile(snapshotPath));
  const entries=Object.fromEntries(Object.entries(structured)
    .map(([name,text])=>[name,strToU8(text)]));
  const zip=zipSync({...entries,'app.sqlite':databaseBytes,
    'manifest.json':strToU8(JSON.stringify({
      schemaVersion:3,createdAt:new Date().toISOString(),includesImages:false
    }))});
  await writeFile(backupPath,zip,{flag:'wx'});
  store.putBackup(backupId,backupRelativePath);
} finally {snapshot.close();}
```
Here snapshotPath is the newly generated temp SQLite path, backupId is randomUUID(), backupRelativePath is `backups/` + backupId + `.zip`, backupPath is safePath(config.dataDir,backupRelativePath); import zipSync/strToU8 from fflate and create the backups directory before writing.

- [ ] **Step 4: Write browser RED test.**
```tsx
render(<SettingsPage/>);
fireEvent.click(await screen.findByRole('button',{name:'备份全部数据'}));
await waitFor(()=>expect(api.backup).toHaveBeenCalledTimes(1));
expect(await screen.findByText('此备份包含数据库、设置、学习规则和文件索引，不包含图片和 PDF'))
  .toBeInTheDocument();
```
Mock api.settings/status/notes/rules and backup with valid shared shapes. Run `pnpm --filter @auto-reimbursement/web test src/pages/WorkflowPages.test.tsx`; expect missing page exports.
- [ ] **Step 5: Implement preview.** PreviewPage({batchId:string}) fetches batch, shows full inline PDF iframe plus open/download link, edits department/date/signer options, chooses note per sheet, and moves whole categories prev/next. Save successful changes refresh preview URL using a cache-busting revision, retaining sheet IDs. Display CATEGORY_TOO_LARGE/NOTE_OVERFLOW without losing choices. Generate PDF calls export only on user action and shows saved link; exported batch controls become read-only. All option/notes edits go through server validation.
```tsx
<iframe title="完整报销 PDF 预览"
  src={'/api/batches/'+batch.id+'/preview.pdf?revision='+revision}/>
<button disabled={busy||batch.pdfPath!==null}
  onClick={()=>void exportCurrent()}>生成 PDF</button>
```
Local `exportCurrent():Promise<void>` calls api.exportBatch(batch.id), updates batch state and sets visible error on rejection. Revision is a local integer incremented after successful option/move requests.

- [ ] **Step 6: Implement settings/history/navigation.** SettingsPage edits defaults, signer upload/mode, notes CRUD, learning-rule CRUD and safe configured/unconfigured API status. NotesEditor preserves multiline content; RulesEditor displays feature/original/final category/count/strong flag. HistoryPage groups by month and shows batches, totals, saved PDF, original/refund evidence and archive state. Archive/unarchive controls reflect unfinished work errors. Cleanup is a two-stage dialog: select month -> explanatory confirm dialog -> require exact typed phrase -> submit. Add six page navigation entries (首页 / 上传凭证、本期报销池、待处理、生成预览、历史报销单、设置); preview navigation uses most recently selected draft/history batch or displays an empty-state message.
```tsx
<p>此备份包含数据库、设置、学习规则和文件索引，不包含图片和 PDF</p>
<button onClick={()=>void createBackup()}>备份全部数据</button>
```
Local `createBackup():Promise<void>` calls api.backup(), then displays an anchor with returned downloadUrl; errors are role=alert. API delete methods handle HTTP 204 without JSON decoding.

- [ ] **Step 7: GREEN.** Test ZIP reopening with `openStore` on extracted backup, matching rules/settings/indexes, no credentials, cleanup denial without confirmation/export/archive, PDF retained, duplicate still blocked, unarchive behavior, exported UI immutability, sheet-specific note selection, month history and cleanup dialogs. Run `pnpm test`, `pnpm typecheck`, web build.
- [ ] **Step 8: Commit.** `git add apps/api/src/archive.ts apps/api/src/backup.ts apps/api/src/db.ts apps/api/src/migrations/003-backups.sql apps/api/src/routes.ts apps/api/test/maintenance.test.ts apps/api/package.json pnpm-lock.yaml apps/web/src/pages/PreviewPage.tsx apps/web/src/pages/HistoryPage.tsx apps/web/src/pages/SettingsPage.tsx apps/web/src/pages/WorkflowPages.test.tsx apps/web/src/components/NotesEditor.tsx apps/web/src/components/RulesEditor.tsx apps/web/src/api.ts apps/web/src/App.tsx apps/web/src/styles.css docs/superpowers/implementation-log.md`; `git commit -m "feat: complete preview history and local maintenance UI"`.

## Task 20: End-to-end validation and representative acceptance fixtures

**Files:** Create `playwright.config.ts`, `e2e/workflow.spec.ts`, `e2e/start-api.ts`, `e2e/fixtures/manifest.json`, `e2e/fixtures/generate.ts`, `docs/acceptance.md`; modify root `package.json`, `pnpm-lock.yaml`, `README.md`. Create generated synthetic `e2e/fixtures/images/*.png` via fixture script; no private receipts committed.

**Interfaces:** `FakeAnalyzer implements ReceiptAnalyzer` in e2e/start-api.ts maps exact fixture SHA-256 to Analysis or AiError. This test-only composition root uses real createApp/store/queue/applyAnalysis with temp data and loopback port 3100. There is no production endpoint to override AI responses. Root scripts `test:e2e: playwright test`, `fixtures: tsx e2e/fixtures/generate.ts`. Manifest entries `{id:string;file:string;expected:{paidFen:number|null;category:Category|null;outcome:'ready'|'pending'|'duplicate';reason:Reason|null};analysis:Analysis|null;failure:'transient'|'terminal'|null}`.

- [ ] **Step 1: Add dependencies and fixture source.** Add `@playwright/test`, `tsx` and `sharp` as root dev dependencies; `pnpm exec playwright install chromium`. Generate labeled synthetic PNG receipts from escaped SVG using Sharp, fixed font and seeded geometric background markers large enough to survive 9×8 downsampling; verify normal fixture pairs exceed the dHash suspicion threshold and the intended cropped pair remains below it. Manifest includes 50-item upload batch: 35 high-confidence normal receipts covering ten categories and WeChat/Alipay/Taobao/JD/takeaway/transfer/photo/unknown layouts; 5 ambiguous paid-vs-discount/refund cases; 3 low-category cases; 2 transient-then-success cases; 1 terminal API failure; 1 exact renamed duplicate; 1 similar crop pending; 2 manual correction examples. Add a second run fixture for three consecutive supplier corrections and later matching-medium receipt. Real store images are tested separately with explicit user-provided truth labels outside git.
- [ ] **Step 2: Write workflow RED.**
```ts
import {test,expect} from '@playwright/test';
test('uploads, resolves exceptions, refunds, previews and exports',async({page})=>{
  await page.goto('/');
  await page.getByLabel('选择凭证图片').setInputFiles([
    'e2e/fixtures/images/normal-01.png','e2e/fixtures/images/ambiguous-01.png'
  ]);
  await expect(page.getByText('识别中：0',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'待处理',exact:true}).click();
  await page.getByLabel('最终实付金额').fill('300.00');
  await page.getByLabel('分类',{exact:true}).selectOption('耗材');
  await page.getByRole('button',{name:'确认可报销'}).click();
  await page.getByRole('button',{name:'本期报销池',exact:true}).click();
  await expect(page.getByText('可报销笔数：2',{exact:true})).toBeVisible();
});
```
Match these explicit accessible labels in the UI; extend the same test with receipt-card-scoped refund input 80.00, one evidence file, selecting both receipts, generate batch, form option edits, preview response status and export download.
- [ ] **Step 3: Run RED against unimplemented acceptance behavior.** `pnpm fixtures`, then `pnpm test:e2e`. Expect the specific missing accessible control/workflow expectation to fail if integration remains incomplete. If the whole flow already passes, record that as regression GREEN and add a genuinely missing case (restart during queued work or cleanup history retention) before fixing a discovered defect; do not deliberately break production to claim RED.
- [ ] **Step 4: Implement test runtime and integration fixes.** Playwright webServer starts API test composition root plus Vite at 127.0.0.1:5174 proxying 3100 via an explicit test env `API_PROXY_TARGET` consumed only in Vite server config (modify `apps/web/vite.config.ts`). API temp directory is created with mkdtemp; test fixture fake returns deterministic outputs and uses real retry scheduler; shutdown closes queue/store before deleting that exact temp path. Disable reuseExistingServer in CI. Only fix failures demonstrated by test output and add their regression assertions.
- [ ] **Step 5: Verify complete financial/PDF behavior.** Add E2E scenarios: 51 rejected, renamed duplicate blocked before analyzer counter increases, suspect history confirmation, all-medium rule promotion/conflict, full refund excluded, partial refund evidence immediately after original, multi-sheet automatic grouping/manual movement, multiple notes, blank date, image signer, immutable generated history, API credential absence in requests/assets, queued restart, archive/unarchive, explicit cleanup and backup reopen. Download PDF and parse with PDF.js to assert exact totals, uppercase, attachment count/order and expected pages; hash stored originals before/after generation.
- [ ] **Step 6: Run visual and real-image acceptance.** Capture screenshots of six UI pages and render default/long-summary/multisheet/signature/notes/refund PDF pages, inspect all at 100% for missing glyphs, clipping, overlap and readable attachment labels. Record screenshots locally under `work/acceptance/`, not git. With provided consented real fixtures, compare outputs against human-labeled final paid amount/category and exception expectations. Record normal auto-release rate, paid-amount accuracy, category accuracy, exception interception, duplicate interception, upload-to-PDF wall time and user-estimated manual baseline/time saved. Do not invent target numbers absent from the design; record numerator/denominator and limitations. The two supplied paper forms are visual references, not recognition ground truth. Compare form geometry against both references and record outcomes. If no labeled purchase receipts are supplied, mark real-recognition metrics unperformed; do not describe the project as validated on real receipts or claim exact physical dimensions from perspective photos.
- [ ] **Step 7: GREEN and operational handoff.** Run `pnpm test`, `pnpm typecheck`, `pnpm --filter @auto-reimbursement/web build`, `pnpm test:e2e`; all must exit 0. README covers Node/pnpm startup, backend-only env, choosing a vision provider, data directory, backup limitations, safe shutdown, restoring structured ZIP into a fresh data directory with server stopped and separately restoring indexed media from the original data copy. Acceptance doc records exact commands/results, fixture counts and missing real-world evidence.
- [ ] **Step 8: Commit.** `git add playwright.config.ts e2e docs/acceptance.md README.md package.json pnpm-lock.yaml apps/web/vite.config.ts docs/superpowers/implementation-log.md`; add only other files actually fixed by evidenced failures using explicit paths; `git commit -m "test: validate reimbursement workflow end to end"`.

## Spec coverage and final review map

| Design section | Implementation and verification |
| --- | --- |
| 1 Product goal | Tasks 4–20; Task 20 upload-to-PDF and exception-only workflow |
| 2 Explicit exclusions | Recovery context; no excluded subsystem added |
| 3 Ten fixed categories | Tasks 3, 6, 9, 18; shared enum, strict AI/UI validation |
| 4 Upload, recognition, release, payment semantics | Tasks 4, 6–8, 17; 50 cap, order, four workers, retries and threshold cases |
| 5 Historical duplicates | Tasks 5, 8, 19–20; exact/similar, before AI, post-analysis refinement, archive retention |
| 6 Local AI learning | Tasks 8–9, 19–20; three consecutive confirmations and vendor-neutral editable rules |
| 7 Pool operations and totals | Tasks 10, 12, 18; images, analysis, edit/refund/delete and ten subtotals |
| 8 Manual batches | Tasks 12, 18; explicit selection, no monetary threshold |
| 9 Deterministic splitting and numeric summaries | Tasks 14–16; measured categories, preserved upload order, oversized error |
| 10 Paper form | Tasks 13–16; complete fields, fen arithmetic, Chinese font; comparison against both supplied paper photos, with physical-size assumption recorded |
| 11 Reimburser modes | Tasks 11, 15, 19–20; text/signature switch |
| 12 Note library | Tasks 11, 14–15, 19; CRUD, multiline, per-sheet choice and snapshot |
| 13 Attachment order | Tasks 14, 16, 20; group-summary sequence, immutable image bytes and non-overlapping labels |
| 14 Refund attributes | Tasks 10, 12, 16, 18; full/partial, evidence adjacency, exact net |
| 15 Five statuses | Tasks 3, 7–12, 19; no refund/deletion status added |
| 16 Complete PDF and preview | Tasks 14–16, 19–20; form plus its evidence, moves and one export |
| 17 Six pages | Tasks 17–19; upload/pool/pending/preview/history/settings |
| 18 Local storage and fields | Tasks 2–4, 9–12, 19; SQLite structured data, indexed files and month folders |
| 19 Key secrecy/provider independence | Tasks 2, 6–7, 17, 20; backend config and standard Analysis |
| 20 Archive and deliberate cleanup | Task 19; hide only, two-stage confirmation, retained PDF/financial data |
| 21 Minimum backup | Tasks 19–20; consistent SQLite/settings/rules/index ZIP and honest media limitation |
| 22 Success standards | Task 20; seven metrics, representative fixtures and explicit real-data evidence gap |
| 23 Future non-MVP work | Recovery context exclusions; no future features introduced |

Self-review at recovery: the 20 tasks preserve the known original order, all 23 spec sections map above, and each consumer interface is named in this document. The contracts deliberately distinguish recognized/paid/refund/net money, uploaded month vs batch month, original vs refund image order, and draft vs exported batch mutability. No production feature beyond Task 1 is marked complete. Execution must record fresh RED/GREEN evidence and must not claim real-image accuracy or 1:1 paper fidelity without measured comparisons and labeled source material.
