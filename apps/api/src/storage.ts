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

/**
 * 文件索引（FileIndexEntry.sha256）必须记录「落盘字节」的哈希，readVerifiedFile 按它校验。
 * storeImage 会去 EXIF 重编码，落盘字节与上传原始字节不同；ImageRef.sha256 仍是上传指纹（查重用），
 * 落盘哈希在 fileSha256。旧数据没有 fileSha256，两者相同。
 */
export function fileIndexSha256(image: ImageRef): string {
  return image.fileSha256 ?? image.sha256;
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
  // 指纹仍按用户上传的原始字节计算，保证同一文件重复上传时查重结果稳定（P-32 依赖）
  const hashes = await fingerprint(input.bytes);
  // P-35：rotate() 把 EXIF 方向转正后重新编码；sharp 重编码默认不携带任何
  // EXIF/GPS/设备元数据，存盘、PDF 与缩略图一律使用去除元数据后的版本
  const stripped = await sharp(input.bytes, {
    limitInputPixels: MAX_IMAGE_PIXELS,
  })
    .rotate()
    .toFormat(
      metadata.format as keyof typeof imageFormats,
      // png 的 quality 仅在 palette 模式下有效，传了会报错；jpeg/webp 用 92 保清晰度
      metadata.format === 'png' ? {} : { quality: 92 },
    )
    .toBuffer();
  const strippedMetadata = await sharp(stripped).metadata();
  // 完整性校验按实际写盘的字节计算；不能沿用上传指纹，否则导出时 readVerifiedFile 必然失败
  const fileSha256 = createHash('sha256').update(stripped).digest('hex');
  await ensureMonthDirs(config.dataDir, month);

  let handle;
  try {
    handle = await open(absolutePath, 'wx');
    await handle.writeFile(stripped);
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
    fileSha256,
    perceptualHash: hashes.perceptualHash,
    bytes: stripped.length,
    width: strippedMetadata.width ?? metadata.width,
    height: strippedMetadata.height ?? metadata.height,
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
