import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(__dirname, '..')

/** 获取保存天数（与适配器 saveDays getter 逻辑一致） */
function getSaveDays() {
  const t = Bot.saveTimes
  return (t >= 1 && t <= 7 && Number.isInteger(t)) ? t : 3
}

/**
 * 检测 Buffer 的媒体文件扩展名
 */
export function detectMediaExt(buffer, seg) {
  const name = seg.fileName || seg.name || ''
  const extMatch = name.match(/\.(\w{2,5})$/i)
  if (extMatch) return extMatch[1].toLowerCase()
  // Magic bytes 检测
  if (buffer.length >= 8) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png'
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg'
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif'
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'webp'
  }
  return 'bin'
}

/**
 * 将 Buffer 存入本地 data/{md5}.{ext}，扁平目录
 * 返回相对路径（相对于插件目录），方便 Web Adapter 拼 local-media 端点
 * Redis: 单一 ZSet wind-media-cache，value={md5}.{ext}，score=Date.now()
 */
export async function saveMediaFile(buffer, seg) {
  const md5 = crypto.createHash('md5').update(buffer).digest('hex')
  const ext = detectMediaExt(buffer, seg)
  const member = `${md5}.${ext}`
  const absPath = path.join(pluginRoot, 'data', 'imgs', member)
  const relPath = `data/imgs/${member}` // 相对路径：data/imgs/{md5}.{ext}

  // 去重：Redis ZSCORE 非 null 表示文件已缓存，仅刷新 score（同 md5 = 再次使用）
  const cachedScore = await redis.zScore('wind-media-cache', member).catch(() => null)
  if (cachedScore !== null) {
    redis.zAdd('wind-media-cache', { score: Date.now(), value: member }).catch(() => {})
    return relPath
  }

  // 新文件：写入磁盘 + ZAdd
  const dir = path.join(pluginRoot, 'data', 'imgs')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(absPath, buffer)
  await redis.zAdd('wind-media-cache', { score: Date.now(), value: member })

  return relPath
}

/**
 * 剥离 segment 中的 Buffer：存本地文件，段内放相对路径
 * 避免 JSON.stringify(Buffer) → {"type":"Buffer","data":[...]} 爆炸 Redis
 */
export async function sanitizeSegments(segs) {
  if (!Array.isArray(segs)) return segs
  const result = []
  for (const s of segs) {
    if (!s || typeof s !== 'object') { result.push(s); continue }
    if (['image', 'video', 'record', 'file', 'audio'].includes(s.type)) {
      const clean = { type: s.type }
      if (s.file && typeof s.file === 'string' && (s.file.startsWith('http://') || s.file.startsWith('https://'))) {
        clean.file = s.file  // QQ CDN URL → 直接保留
        clean._local = false // 远程 URL，未缓存
      } else if (s.file && Buffer.isBuffer(s.file) && s.file.length > 0) {
        clean.file = await saveMediaFile(s.file, s)
        clean._local = true    // 标记需前端通过 local-media 端点拉取
      } else if (s.file && typeof s.file === 'string') {
        // 非 HTTP 字符串路径（如 /web/api/bot/.../local-media?path=... 或相对/绝对路径）
        const localMediaMatch = s.file.match(/[?&]path=([^&]+)/)
        clean.file = localMediaMatch ? decodeURIComponent(localMediaMatch[1]) : s.file
        clean._local = true
      }
      if (s.url && typeof s.url === 'string' && (s.url.startsWith('http://') || s.url.startsWith('https://'))) {
        clean.url = s.url
      }
      if (s.fileName) clean.fileName = s.fileName
      if (s.name) clean.name = s.name
      if (s.width) clean.width = s.width
      if (s.height) clean.height = s.height
      result.push(clean)
    } else {
      result.push(s)
    }
  }
  return result
}

/**
 * 扫描用户消息 segments，将远程 HTTP 图片/视频下载到本地缓存
 * 仅缓存 image 和 video（文件链接有效期长，音频有 voice_wav_url 长时链接不需缓存）
 */
export async function cacheRemoteMedia(segments) {
  if (!Array.isArray(segments)) return segments
  const results = []
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') { results.push(seg); continue }
    const mediaTypes = ['image', 'video']
    if (!mediaTypes.includes(seg.type)) { results.push(seg); continue }

    // 从 url / file 字段中查找可下载的 HTTP 链接
    let remoteUrl = null
    for (const key of ['url', 'file']) {
      const v = seg[key]
      if (v && typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
        remoteUrl = v
        break
      }
    }
    if (!remoteUrl) { results.push(seg); continue }

    try {
      // 下载远程媒体文件
      const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const arr = await res.arrayBuffer()
      if (arr.byteLength === 0) throw new Error('empty body')
      const maxSize = (Bot.maxMediaCacheSize || 10) * 1024 * 1024
      if (arr.byteLength > maxSize) { results.push(seg); continue }
      const buffer = Buffer.from(arr)

      const localPath = await saveMediaFile(buffer, seg)
      if (!localPath) { results.push(seg); continue }

      // 成功：覆盖 file 为本地路径
      const clean = { ...seg }
      clean.file = localPath
      clean._local = true
      results.push(clean)
    } catch (err) {
      logger.debug(`[QQBot] 缓存媒体失败: ${err.message}`)
      results.push(seg)
    }
  }
  return results
}

/**
 * 基于 ZSet 清理过期媒体：ZRANGEBYSCORE 取 score < cutoff 的成员，删文件 + ZREM
 */
export async function cleanupMediaFiles() {
  const saveDays = getSaveDays()
  const cutoff = Date.now() - saveDays * 86400 * 1000
  try {
    const expired = await redis.zRangeByScore('wind-media-cache', '-inf', cutoff)
    if (!expired?.length) return
    for (const member of expired) {
      try {
        // 先删 Redis 再删文件：避免并发请求在"文件已删但 Redis 仍存活"窗口命中过期记录
        await redis.zRem('wind-media-cache', member)
        await fs.unlink(path.join(pluginRoot, 'data', 'imgs', member))
        logger.info(`[QQBot-Plugin] 清理过期媒体: ${member}`)
      } catch { /* 单个文件清理失败不影响后续 */ }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.error(`[QQBot-Plugin] 清理媒体文件失败:`, err)
  }
}

/**
 * 压缩图片
 * @param {Object} data - 消息数据（含 self_id 用于日志）
 * @param {string|Buffer} file - 图片文件路径或 Buffer
 * @param {Object} config - QQBot 配置对象
 * @param {Object} sharp - sharp 实例
 */
export async function compressImage(data, file, config, sharp) {
  try {
    const size = config.imageLength * 1024 * 1024
    const buffer = await Bot.Buffer(file, { http: true })

    if (!Buffer.isBuffer(buffer))
      return file

    if (buffer.length <= size)
      return buffer

    // GIF 动图不压缩，避免转 JPEG 后丢失动画
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      Bot.makeLog("debug", `跳过 GIF 压缩 (${(buffer.length/1024).toFixed(2)}KB)`, data.self_id)
      return buffer
    }

    let quality = 105, output
    do {
      quality -= 10
      output = await sharp(buffer).jpeg({ quality }).toBuffer()
      Bot.makeLog("debug", `图片压缩完成 ${quality}%(${(output.length/1024).toFixed(2)}KB)`, data.self_id)
    } while (output.length > size && quality > 10)

    return output
  } catch (err) {
    Bot.makeLog("error", ["图片压缩错误", err], data.self_id)
    return file
  }
}
