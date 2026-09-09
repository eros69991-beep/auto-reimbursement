import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { FileIndexEntry, ImageRef } from '@auto-reimbursement/contracts';
import sharp from 'sharp';

import type { Config } from './config.js';
import { fingerprint } from './duplicates.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;

const imageFormats = {
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  png: { extension: 'png', mime: 'image/png' },
  webp: { extension: 'webp', mime: 'image/webp' },
} as const;

export type InputImage = { name: string; mime: string; bytes: Buffer };

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

export async function readVerifiedFile(
  config: Config,
  entry: FileIndexEntry,
): Promise<Buffer> {
  const bytes = await readFile(safePath(config.dataDir, entry.path));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('FILE_INTEGRITY');
  }
  return bytes;
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

export async function storeExportPdf(
  config: Config,
  month: string,
  id: string,
  bytes: Buffer,
): Promise<{ path: string; absolutePath: string }> {
  const directories = await ensureMonthDirs(config.dataDir, month);
  const path = `${month}/exports/${id}.pdf`;
  const temporaryPath = safePath(directories.exports, `${id}.tmp`);
  const absolutePath = safePath(config.dataDir, path);
  let handle;
  let temporaryCreated = false;
  try {
    handle = await open(temporaryPath, 'wx');
    temporaryCreated = true;
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, absolutePath);
    return { path, absolutePath };
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Continue with cleanup of this export's exclusive temporary path.
      }
    }
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch {
        // Preserve the exclusive-write or rename failure.
      }
    }
    throw error;
  }
}

export async function storeImage(
  config: Config,
  month: string,
  kind: 'originals' | 'refunds',
  input: InputImage,
): Promise<ImageRef> {
  if (input.bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('IMAGE_TOO_LARGE');
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input.bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    await sharp(input.bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .raw()
      .toBuffer();
  } catch {
    throw new Error('INVALID_IMAGE');
  }

  if (
    metadata.format === undefined ||
    !Object.hasOwn(imageFormats, metadata.format) ||
    metadata.width === undefined ||
    metadata.height === undefined
  ) {
    throw new Error('INVALID_IMAGE');
  }

  const format = imageFormats[metadata.format as keyof typeof imageFormats];
  const id = randomUUID();
  const path = `${month}/${kind}/${id}.${format.extension}`;
  const absolutePath = safePath(config.dataDir, path);
  const hashes = await fingerprint(input.bytes);
  await ensureMonthDirs(config.dataDir, month);

  let handle;
  try {
    handle = await open(absolutePath, 'wx');
    await handle.writeFile(input.bytes);
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Continue with exact-path cleanup after a close failure.
      }
      try {
        await unlink(absolutePath);
      } catch {
        // Preserve the original write/close failure.
      }
    }
    throw error;
  }

  return {
    id,
    path,
    mime: format.mime,
    sha256: hashes.sha256,
    perceptualHash: hashes.perceptualHash,
    bytes: input.bytes.length,
    width: metadata.width,
    height: metadata.height,
    deletedAt: null,
  };
}

export async function storeSignatureImage(
  config: Config,
  input: InputImage,
): Promise<ImageRef> {
  if (input.bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('IMAGE_TOO_LARGE');
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input.bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    await sharp(input.bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).raw().toBuffer();
  } catch {
    throw new Error('INVALID_IMAGE');
  }
  if (
    metadata.format === undefined ||
    !Object.hasOwn(imageFormats, metadata.format) ||
    metadata.width === undefined ||
    metadata.height === undefined
  ) {
    throw new Error('INVALID_IMAGE');
  }

  const format = imageFormats[metadata.format as keyof typeof imageFormats];
  const id = randomUUID();
  const path = `settings/signatures/${id}.${format.extension}`;
  const absolutePath = safePath(config.dataDir, path);
  const hashes = await fingerprint(input.bytes);
  await mkdir(dirname(absolutePath), { recursive: true });

  let handle;
  try {
    handle = await open(absolutePath, 'wx');
    await handle.writeFile(input.bytes);
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Continue with exact-path cleanup after a close failure.
      }
      try {
        await unlink(absolutePath);
      } catch {
        // Preserve the original write/close failure.
      }
    }
    throw error;
  }

  return {
    id,
    path,
    mime: format.mime,
    sha256: hashes.sha256,
    perceptualHash: hashes.perceptualHash,
    bytes: input.bytes.length,
    width: metadata.width,
    height: metadata.height,
    deletedAt: null,
  };
}
