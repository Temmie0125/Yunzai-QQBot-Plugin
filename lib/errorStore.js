import crypto from "node:crypto"
import { persistSegFiles, cleanupErrFiles } from "./errFileStore.js"

const ERR_ZSET = "QQBot:err:logs"
const TYPE_DAY_PREFIX = "QQBot:err:type:"
const RETAIN_DAYS = 30

const dayKey = ts => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// 类型归一化：优先取 detail.message（接口返回的具体错误描述），旧记录从 err 文本提取
const normalizeType = record =>
    String(record?.message || String(record?.err || "").split('error with code')[1] || "未知错误")

export async function recordSendErrors(errors) {
    try {
        for (const e of errors) {
            const record = {
                id: crypto.randomUUID(),
                ...e
            }

            try {
                await persistSegFiles(record.segs)
            } catch (err) {
                logger.warn(`[QQBot] 错误附件落盘失败: ${err.message}`)
            }

            let value
            try {
                value = JSON.stringify(record)
            } catch {
                value = JSON.stringify({ ...record, segs: Bot.String(record.segs) })
            }
            await redis.zAdd(ERR_ZSET, [{ score: record.timestamp, value }])

            const typeKey = TYPE_DAY_PREFIX + dayKey(record.timestamp)
            await redis.zIncrBy(typeKey, 1, normalizeType(record))
            await redis.expire(typeKey, (RETAIN_DAYS + 1) * 86400)
        }
    } catch (err) {
        logger.error(`[QQBot] 发送错误记录失败: ${err.message}`)
    }
}

export async function getSendErrors({ page = 1, limit = 20 } = {}) {
    page = Math.max(1, page | 0)
    limit = Math.min(100, Math.max(1, limit | 0))
    const total = await redis.zCard(ERR_ZSET)
    const start = (page - 1) * limit
    if (start >= total) return { total, page, limit, list: [] }
    const stop = Math.min(start + limit - 1, total - 1)
    const list = await redis.zRange(ERR_ZSET, total - 1 - stop, total - 1 - start)
    list.reverse()
    return {
        total, page, limit,
        list: list.map(item => {
            try { return JSON.parse(item) } catch { return item }
        }),
    }
}

export async function getSendErrorTypes(topN = 20) {
    const keys = []
    const now = Date.now()
    for (let i = 0; i <= RETAIN_DAYS; i++)
        keys.push(TYPE_DAY_PREFIX + dayKey(now - i * 86400000))

    const tmp = `${TYPE_DAY_PREFIX}rank-tmp`
    await redis.zUnionStore(tmp, keys)
    await redis.expire(tmp, 60)
    const rows = await redis.zRangeWithScores(tmp, 0, -1)
    await redis.del(tmp)
    return rows
        .sort((a, b) => Number(b.score) - Number(a.score))
        .slice(0, topN)
        .map(row => ({ type: row.value, count: Number(row.score) }))
}

export async function cleanupErrStore() {
    const removed = await redis.zRemRangeByScore(ERR_ZSET, "-inf", Date.now() - RETAIN_DAYS * 86400000)
    await cleanupErrFiles()
    return Number(removed) || 0
}
