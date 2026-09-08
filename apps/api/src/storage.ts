import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export function safePath(root: string, input: string): string {
  if (isAbsolute(input) || input.includes('\0')) {
    throw new Error('UNSAFE_PATH');
  }

  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, input);
  const pathFromRoot = relative(resolvedRoot, target);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('UNSAFE_PATH');
  }
  return target;
}

export async function ensureMonthDirs(
  dataDir: string,
  month: string,
): Promise<{ originals: string; refunds: string; exports: string }> {
  if (!monthPattern.test(month)) {
    throw new Error('INVALID_MONTH');
  }

  const monthDir = safePath(dataDir, month);
  const originals = safePath(monthDir, 'originals');
  const refunds = safePath(monthDir, 'refunds');
  const exports = safePath(monthDir, 'exports');
  await Promise.all(
    [originals, refunds, exports].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  return { originals, refunds, exports };
}
