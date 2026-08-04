// 从 zip 压缩包 Buffer 提取图片（使用内置极简 zip 解析，无需 adm-zip）
import { extractZipImagesFromBuffer } from "./multipart.js"

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export async function extractZipImages(zipFiles) {
  const out = []
  for (const zf of zipFiles) {
    const imgs = extractZipImagesFromBuffer(zf.buffer, IMAGE_RE)
    out.push(...imgs)
  }
  return out
}
