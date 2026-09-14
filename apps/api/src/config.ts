import { join, resolve } from 'node:path';

export type Config = {
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  corsOrigins: string[];
  ai: { baseUrl: string; model: string; apiKey: string } | null;
  concurrency: number;
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
  };
}
