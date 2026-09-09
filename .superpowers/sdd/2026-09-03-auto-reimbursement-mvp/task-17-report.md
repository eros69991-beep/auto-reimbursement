# Task 17 report: batch upload and recognition progress UI

## RED

`pnpm --filter @auto-reimbursement/web test src/pages/UploadPage.test.tsx` exited 1 before implementation. Vitest reported that `./UploadPage` could not be resolved, so the new 51-file interaction test could not load the missing page.

## GREEN

The browser client uses typed upload, progress, and image URL methods. Upload serializes the selected `File[]` into `FormData` in received order without a manually set multipart header; errors expose only a safe API message. The upload page accepts keyboard-accessible file selection and drag/drop, blocks batches over 50 files before HTTP, shows the active upload count, accepted/rejected filenames, and links exact duplicates to their image route.

Accepted IDs are polled once per second only while the API reports active recognition. The polling effect cancels its timer and aborts its request on replacement or unmount. A progress failure stops polling and offers an explicit retry. Upload/network failure remains a visible upload error, separate from recognition results that are pending AI review. The page shell retains the accessible English title, adds 首页 / 上传凭证 navigation, responsive Chinese-friendly styling, and development proxies for `/api` and `/health`; it does not add Task 18+ pages or browser configuration.

## Evidence

- Focused GREEN: `pnpm --filter @auto-reimbursement/web test src/pages/UploadPage.test.tsx` exited 0 with 5/5 tests. It covers the 50-file client-side limit, received drop order, rejected duplicate filename/link, failed-poll retry, and completion stopping polling.
- Full web suite: `pnpm --filter @auto-reimbursement/web test` exited 0 with 6/6 tests across 2 files.
- Workspace typecheck: `pnpm typecheck` exited 0 for contracts, API, and web.
- Production build: `pnpm --filter @auto-reimbursement/web build` exited 0. A case-insensitive scan of `apps/web/dist` found no API-key, OpenAI-key, secret, or `sk-` strings.

## Scope and concern

The existing untracked `tmp/` and `apps/api/tmp/` QA artifacts remain outside this commit. Client mocks are intentionally restricted to upload/progress/image URL methods, and the web client contains no backend key or configuration values. Task 18 reimbursement-pool and exception-review UI remains out of scope.
