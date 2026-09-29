import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    /* forks 池在本机 Windows 环境偶发 worker 崩溃（全部用例已通过仍报 exit 1），threads 池稳定 */
    pool: 'threads'
  }
});
