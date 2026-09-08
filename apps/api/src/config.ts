import { join, resolve } from 'node:path';

export type Config = {
  dataDir: string;
  dbPath: string;
  host: '127.0.0.1';
  port: number;
  ai: { baseUrl: string; model: string; apiKey: string } | null;
  concurrency: number;
};

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
    host: '127.0.0.1',
    port: integer(env.PORT, 3000, 1, 65535, 'INVALID_PORT'),
    ai: configuredValues === 0 ? null : { baseUrl, model, apiKey },
    concurrency: integer(env.CONCURRENCY, 4, 3, 5, 'INVALID_CONCURRENCY'),
  };
}
