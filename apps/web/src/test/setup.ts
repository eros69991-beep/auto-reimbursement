import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// vitest 未开 globals，Testing Library 的自动 cleanup 不生效；
// 显式挂上，避免跨用例残留 DOM（P-29，此前到处用 getAllBy…().at(-1) 绕过）
afterEach(cleanup);
