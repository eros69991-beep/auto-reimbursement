import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { logger } from './logger.js';

// P-13：列表缩略图。原图动辄 2MB+，手机端报销池一次加载 20 张会卡死；
// 统一生成 320px WebP 缩略图，按内容 sha256 做磁盘缓存（内容不变则永久有效）。
const THUMB_EDGE = 320;

export async function thumbnailWebp(
  dataDir: string,
  sha256: string,
  sourcePath: string,
): Promise<Buffer> {
  const dir = join(dataDir, 'thumbs');
  const cached = join(dir, `${sha256}.webp`);
  try {
    return await readFile(cached);
  } catch {
    // 缓存未命中，现生成
  }
  const bytes = await sharp(sourcePath)
    .rotate()
    .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  await mkdir(dir, { recursive: true });
  // 缓存写失败不影响本次响应
  await writeFile(cached, bytes).catch(() => undefined);
  return bytes;
}

// 对账页看的凭证图：手机和慢网下，几 MB 的大图（合并出来的长截图、没经过压缩的 PNG）要等很久，
// 所以大图给一份「缩小版」：长边不超过 3200px、JPEG 质量 82，读字足够（拼图里每张截图仍有 1000px 左右宽）。
// 只对大图这样做：本来就不大的图（上传时已压缩的照片一般 1MB 上下）原样返回，不重新编码、不损失任何细节。
const VIEW_PASS_BYTES = 1.5 * 1024 * 1024;
const VIEW_MAX_EDGE = 3200;
const VIEW_QUALITY = 82;
// 缩小后至少要小到原图的 80% 才值得用；省不了多少就还是给原图
const VIEW_WORTH_RATIO = 0.8;

/**
 * 返回对账用的缩小版 JPEG；不需要缩小（图本来就不大，或缩小省不了多少，或这张图转换失败）返回 null，
 * 调用方改发原图。缩小版按内容 sha256 落盘缓存。读不到源文件时抛出（调用方按 404 处理）。
 */
export async function viewJpeg(
  dataDir: string,
  sha256: string,
  sourcePath: string,
): Promise<Buffer | null> {
  const dir = join(dataDir, 'thumbs');
  const cached = join(dir, `${sha256}-view.jpg`);
  try {
    return await readFile(cached);
  } catch {
    // 缓存未命中，现生成
  }
  const { size } = await stat(sourcePath);
  if (size <= VIEW_PASS_BYTES) {
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = await sharp(sourcePath)
      .rotate()
      .resize(VIEW_MAX_EDGE, VIEW_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: VIEW_QUALITY })
      .toBuffer();
  } catch (error) {
    logger.warn({ err: error, sha256 }, '生成对账用缩小图失败，改发原图');
    return null;
  }
  if (bytes.length > size * VIEW_WORTH_RATIO) {
    return null;
  }
  await mkdir(dir, { recursive: true });
  // 缓存写失败不影响本次响应
  await writeFile(cached, bytes).catch(() => undefined);
  return bytes;
}
