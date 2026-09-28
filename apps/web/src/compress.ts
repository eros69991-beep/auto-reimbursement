// P-12：上传前在客户端压缩大图（长边 2000px、JPEG 0.85），弱网下体积通常降到 1/4–1/5。
// 压缩只是优化，不是必经路径：任何一步失败都回退为原文件。
const MAX_EDGE = 2000;
const COMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export async function compressForUpload(file: File): Promise<File> {
  if (file.size <= COMPRESS_THRESHOLD_BYTES) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
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
