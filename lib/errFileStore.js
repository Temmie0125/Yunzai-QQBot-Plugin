// 发送错误附件落盘：文件按 {MD5}.{ext} 存放于 data/errFile，
// Redis ZSET 记录每个文件（按 MD5 去重）的最后使用时间，30 天未使用自动删除。
// 目的：避免 Redis 中直接存会过期的 URL、会变动的本地路径、不可序列化的 Buffer
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ERR_FILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/errFile")

const FILE_ZSET = "QQBot:err:files"
const FILE_HASH_PREFIX = "QQBot:err:file:"
const RETAIN_MS = 30 * 24 * 3600 * 1000

// 含文件的 seg 类型；魔数识别不出扩展名时按类型兜底
const FILE_TYPES = new Set(["image", "record", "audio", "video", "file"])
const DEFAULT_EXT = { image: "png", record: "mp3", audio: "mp3", video: "mp4", file: "bin" }

// seg.file 兼容：字符串(URL/base64/路径)、Buffer、{ file } 对象
function segFileSource(seg) {
    const file = seg.file
    if (Buffer.isBuffer(file) || typeof file === "string") return file
    return file?.file ?? file
}

// 从原始文件引用中提取扩展名（仅作魔数识别失败时的兜底）
function sourceExt(src) {
    const match = String(src).match(/\.([a-z0-9]{1,8})(?:[?#]|$)/i)
    return match ? match[1] : ""
}

async function persistFile(seg) {
    const src = segFileSource(seg)
    const file = await Bot.fileType({ file: src })
    if (!Buffer.isBuffer(file.buffer) || !file.md5) {
        logger.warn(`[QQBot] 错误附件无法读取，跳过落盘: ${Bot.String(src).slice(0, 100)}`)
        return
    }

    let ext = file.type?.ext || sourceExt(src) || DEFAULT_EXT[seg.type] || "bin"
    ext = String(ext).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"

    const name = `${file.md5}.${ext}`
    const target = path.join(ERR_FILE_DIR, name)

    if (!await fs.stat(target).then(() => true, () => false)) {
        await fs.mkdir(ERR_FILE_DIR, { recursive: true })
        const tmp = `${target}.${process.pid}.tmp`
        await fs.writeFile(tmp, file.buffer)
        await fs.rename(tmp, target).catch(() => fs.rm(tmp, { force: true }))
    }

    await redis.set(FILE_HASH_PREFIX + file.md5, JSON.stringify({ name, ext, size: file.buffer.length }))
    await redis.zAdd(FILE_ZSET, [{ score: Date.now(), value: file.md5 }])

    seg.file = target
}

export async function persistSegFiles(segs) {
    if (!segs) return
    for (const seg of Array.isArray(segs) ? segs : [segs]) {
        if (!seg || !FILE_TYPES.has(seg.type) || !seg.file) continue
        try {
            await persistFile(seg)
        } catch (err) {
            logger.warn(`[QQBot] 错误附件落盘失败: ${err.message}`)
        }
    }
}

// 清理最后使用时间超过 30 天的文件
export async function cleanupErrFiles() {
    const expired = await redis.zRangeByScore(FILE_ZSET, "-inf", Date.now() - RETAIN_MS)
    for (const md5 of expired) {
        try {
            const raw = await redis.get(FILE_HASH_PREFIX + md5)
            const info = raw ? JSON.parse(raw) : {}
            if (info.name)
                await fs.rm(path.join(ERR_FILE_DIR, info.name), { force: true })
            await redis.del(FILE_HASH_PREFIX + md5)
            await redis.zRem(FILE_ZSET, md5)
        } catch (err) {
            logger.warn(`[QQBot] 错误附件清理失败(${md5}): ${err.message}`)
        }
    }
    if (expired.length)
        logger.mark(`[QQBot] 已清理 ${expired.length} 个超过 30 天未使用的错误附件`)
    return expired.length
}
