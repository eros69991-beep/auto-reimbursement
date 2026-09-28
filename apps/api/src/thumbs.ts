import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

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
