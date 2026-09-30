// P-12：上传前在客户端压缩大图（JPEG 0.85），弱网下体积通常降到原来的 1/3–1/5。
// 按像素总量（约 400 万像素）缩放，而不是按长边：长小票（如 1080×5000）按长边 2000px
// 压会只剩 432px 宽，AI 识别和打印都看不清；按面积缩放仍保留约 885px 宽。
// 压缩只是优化，不是必经路径：任何一步失败都回退为原文件。
const MAX_PIXELS = 4_000_000;
// 画布边长上限，兼顾 iOS Safari 的画布尺寸限制
const MAX_EDGE = 4096;
const COMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export async function compressForUpload(file: File): Promise<File> {
  if (file.size <= COMPRESS_THRESHOLD_BYTES) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = compressionScale(bitmap.width, bitmap.height);
      if (scale >= 1) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (context === null) return file;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      });
      if (blob === null || blob.size >= file.size) return file;
      const name = file.name.replace(/\.[^.]+$/, '');
      return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

/** 缩放比例：总像素不超过 MAX_PIXELS、最长边不超过 MAX_EDGE，且只缩小不放大。 */
export function compressionScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  return Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)), MAX_EDGE / Math.max(width, height));
}
