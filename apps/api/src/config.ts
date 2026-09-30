import { join, resolve } from 'node:path';

export type Config = {
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  corsOrigins: string[];
  ai: { baseUrl: string; model: string; apiKey: string } | null;
  concurrency: number;
  accessCodeSha256: string | null;
  /** P-18：Railway 注入的部署 commit，经 /api/version 暴露用于核对前后端版本 */
  commitSha: string | null;
  /**
   * 前面有几层反向代理（Express 的 trust proxy 跳数）。限流按客户端 IP 分桶依赖它；
   * 为 0 时所有经代理进来的请求都被当成同一个 IP，所有人共用一份限流额度。
   * 缺省为 0（本机直连）。
   */
  trustProxy?: number;
};

export const LOCAL_CORS_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
] as const;

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  error: 'INVALID_PORT' | 'INVALID_CONCURRENCY',
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(error);
  }
  return number;
}

function corsOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [...LOCAL_CORS_ORIGINS];
  }

  const values = value.split(',').map((item) => item.trim());
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    throw new Error('INVALID_CORS_ORIGINS');
  }

  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('INVALID_CORS_ORIGINS');
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.origin !== value ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.hostname.includes('*')
    ) {
      throw new Error('INVALID_CORS_ORIGINS');
    }
  }

  return [...new Set(values)];
}

export function loadConfig(env: NodeJS.ProcessEnv, cwd: string): Config {
  const dataDir = resolve(cwd, env.DATA_DIR ?? 'data');
  const providerValues = [env.AI_BASE_URL, env.AI_MODEL, env.AI_API_KEY].map(
    (value) => value?.trim() ?? '',
  );
  const configuredValues = providerValues.filter(Boolean).length;

  if (configuredValues !== 0 && configuredValues !== providerValues.length) {
    throw new Error('PARTIAL_AI_CONFIG');
  }

  const [baseUrl, model, apiKey] = providerValues;
  return {
    dataDir,
    dbPath: join(dataDir, 'app.sqlite'),
    host: env.HOST?.trim() || '127.0.0.1',
    port: integer(env.PORT, 3000, 1, 65535, 'INVALID_PORT'),
    corsOrigins: corsOrigins(env.CORS_ORIGINS),
    ai: configuredValues === 0 ? null : { baseUrl, model, apiKey },
    concurrency: integer(env.CONCURRENCY, 4, 3, 5, 'INVALID_CONCURRENCY'),
    accessCodeSha256: accessCodeSha256(env.ACCESS_CODE_SHA256),
    commitSha: env.RAILWAY_GIT_COMMIT_SHA?.trim() || null,
    trustProxy: trustProxy(env),
  };
}

// TRUST_PROXY：反向代理跳数（0–10）。未设置时，在 Railway 上（有 RAILWAY_* 注入变量）
// 按 1 跳处理——Railway 边缘代理会把真实客户端 IP 追加到 X-Forwarded-For；本机默认 0。
// 如在 Railway 前面再加 Cloudflare 等代理，需显式设为 2。
function trustProxy(env: NodeJS.ProcessEnv): number {
  const raw = env.TRUST_PROXY?.trim() ?? '';
  if (raw === '') {
    const onRailway = Boolean(
      env.RAILWAY_ENVIRONMENT_ID?.trim() || env.RAILWAY_PROJECT_ID?.trim() || env.RAILWAY_ENVIRONMENT_NAME?.trim(),
    );
    return onRailway ? 1 : 0;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error('INVALID_TRUST_PROXY');
  }
  return value;
}

function accessCodeSha256(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? '';
  if (trimmed === '') {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error('INVALID_ACCESS_CODE_SHA256');
  }
  return trimmed;
}
