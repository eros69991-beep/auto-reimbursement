import { createFixtureRuntime } from './fixture-runtime.ts';

async function main(): Promise<void> {
const runtime = await createFixtureRuntime(3100);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void runtime.close().then(() => process.exit(0), () => process.exit(1)));
}
}

void main();
