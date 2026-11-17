import fs from "node:fs/promises"
import fsSync from "node:fs"
import crypto from "node:crypto"
import imageSize from "image-size"
import path from "node:path"
import puppeteer from "../../../lib/puppeteer/puppeteer.js"
import { config, avatarCacheKey } from "./context.js"
import { fileURLToPath } from "node:url"

const escHtml = s =>
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

const FILE_MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
    amr: "audio/amr", flac: "audio/flac", silk: "audio/silk",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
    pdf: "application/pdf", zip: "application/zip", txt: "text/plain",
}
const mimeOf = s =>
    FILE_MIME[String(s).split(/[?#]/)[0].split(".").pop().toLowerCase()] || "application/octet-stream"

async function segFileSrc(file, web = false, defaultMime = "image/png") {
    try {
        if (Buffer.isBuffer(file))
            return `data:${defaultMime};base64,${file.toString("base64")}`
        const s = String(file ?? "")
        if (/^https?:\/\//.test(s) || s.startsWith("data:"))
            return s
        if (s.startsWith("base64://"))
            return `data:${defaultMime};base64,${s.slice(9)}`
        if (s && fsSync.existsSync(s)) {
            if (!web) return "file:///" + s.replace(/\\/g, "/")
            const buf = await fs.readFile(s)
            const mime = mimeOf(s) === "application/octet-stream" ? defaultMime : mimeOf(s)
            return `data:${mime};base64,${buf.toString("base64")}`
        }
    } catch { }
    return ""
}

const nameFromSrc = src => {
    try {
        if (/^https?:\/\//.test(src)) {
            const p = new URL(src).pathname.split("/").filter(Boolean).pop()
            if (p) return decodeURIComponent(p)
        } else if (/^([a-zA-Z]:)?[\\/]/.test(src)) {
            const p = String(src).split(/[\\/]/).pop()
            if (p) return p
        }
    } catch { }
    return ""
}

const FILE_ICON_SVG = `<svg class="file-icon" viewBox="0 0 24 24"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#6a7cfa"/><path d="M15 2v5h5z" fill="#3b4bd8"/><path d="M8 13h8M8 16.5h8M8 9.5h4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`
const DL_ARROW_SVG = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 4v13m0 0l-5.5-5.5M12 17l5.5-5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`

async function mediaCard(seg, kind) {
    const src = await segFileSrc(seg.file, true,
        kind === "audio" ? "audio/mpeg" : kind === "video" ? "video/mp4" : "application/octet-stream")
    if (!src) return {}
    const label = kind === "audio" ? "语音" : kind === "video" ? "视频" : "文件"
    // 显示名：seg.name → URL 提取 → 类型默认名；无后缀时补上推断的后缀（QQ 文件卡片样式）
    const ext = extOf(seg, null).toLowerCase()
    let name = String(seg.name || nameFromSrc(src) || "")
    if (!name)
        name = ext && ext !== "bin" ? `${label}.${ext}` : label
    else if (ext && ext !== "bin" && !/\.[a-z0-9]{1,5}$/i.test(name))
        name += `.${ext}`
    name = escHtml(name)
    const badge = ext && ext !== "bin" ? `<span class="file-ext">${escHtml(ext.toUpperCase())}</span>` : ""
    const html = kind === "audio"
        ? `<audio controls preload="none" src="${src}"></audio>`
        : kind === "video"
            ? `<video controls preload="metadata" src="${src}"></video>`
            : `<div class="file-card">${FILE_ICON_SVG}<span class="file-name">${name}</span>${badge}</div>`
    return { html, src, name }
}

const rowsHtml = rows => rows.map(r => `
    <div class="msg">
        ${r.avatar ? `<img class="avatar" src="${r.avatar}">` : ""}
        <div class="body">
            <div class="nickname">${r.nickname}</div>
            <div class="bubble">${r.content}</div>
        </div>${r.dl ? `<a class="dl-arrow" href="${r.dl}" download="${r.dlName || ""}" target="_blank" title="下载">${DL_ARROW_SVG}</a>` : ""}
    </div>`).join("")

const FORWARD_KEY = "QQBot:forward:"
const FORWARD_INDEX = "QQBot:forward:index"
const FORWARD_FILES = "QQBot:forward:files"
const FORWARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/forward")
const FORWARD_TTL = 7 * 86400
const FORWARD_ID_RE = /^[A-Za-z0-9_-]{8,32}$/
const FORWARD_ENTRY_MAX = 8 * 1024 * 1024
const FORWARD_MAX_COUNT = 100
const FORWARD_MAX_BYTES = 100 * 1024 * 1024
const FORWARD_DL_MAX = 50 * 1024 * 1024
const FORWARD_DL_TIMEOUT = 30000
const MEDIA_TYPES = new Set(["image", "record", "audio", "voice", "video", "file"])
let forwardRouteReady = false

async function safeMediaSeg(seg) {
    let buf
    try {
        const file = seg.file
        if (Buffer.isBuffer(file))
            buf = file
        else if (typeof file === "string") {
            const s = file
            if (s.startsWith("base64://"))
                buf = Buffer.from(s.slice(9), "base64")
            else if (s.startsWith("data:")) {
                const i = s.indexOf(",")
                if (i === -1) return seg
                buf = Buffer.from(s.slice(i + 1), "base64")
            } else if (s && fsSync.existsSync(s))
                buf = await fs.readFile(s)
            else if (/^https?:\/\//.test(s)) {
                buf = await downloadMedia(s)
                if (!buf) return seg
            } else
                return seg
        } else
            return seg

        const ext = extOf(seg, buf)
        const name = `${crypto.createHash("md5").update(buf).digest("hex")}.${ext}`
        await fs.mkdir(FORWARD_DIR, { recursive: true })
        await fs.writeFile(path.join(FORWARD_DIR, name), buf).catch(() => {})
        await redis.zAdd(FORWARD_FILES, { score: Date.now(), value: name }).catch(() => {})
        return { ...seg, file: path.join(FORWARD_DIR, name) }
    } catch (err) {
        logger.warn(`[QQBot] 合并转发媒体落盘失败: ${err?.stack || err}`)
        if (Buffer.isBuffer(buf)) return { ...seg, file: `base64://${buf.toString("base64")}` }
        return seg
    }
}

async function downloadMedia(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FORWARD_DL_TIMEOUT) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > FORWARD_DL_MAX) {
            logger.warn(`[QQBot] 合并转发媒体 ${(buf.length / 1048576).toFixed(1)}MB 超出下载上限，保持 URL 引用`)
            return null
        }
        return buf
    } catch (err) {
        logger.warn(`[QQBot] 合并转发媒体下载失败，保持 URL 引用: ${err.message}`)
        return null
    }
}

function extOf(seg, buf) {
    const src = typeof seg.file === "string" ? seg.file.split(/[?#]/)[0] : ""
    const m = String(seg.name || src).match(/\.([a-z0-9]{1,5})$/i)
    if (m) return m[1].toLowerCase()
    if (seg.type === "image" && Buffer.isBuffer(buf)) {
        try { return imageSize(buf).type || "png" } catch { }
        return "png"
    }
    return { record: "mp3", audio: "mp3", video: "mp4", file: "bin" }[seg.type] || "bin"
}

async function serializeForward(v) {
    if (Buffer.isBuffer(v)) return `base64://${v.toString("base64")}`
    if (Array.isArray(v)) return Promise.all(v.map(i => serializeForward(i)))
    if (v && typeof v === "object") {
        if (MEDIA_TYPES.has(v.type) && v.file != null)
            return safeMediaSeg(v)
        const o = {}
        for (const k in v) o[k] = await serializeForward(v[k])
        return o
    }
    return v
}

async function storeForward(id, payload) {
    const raw = JSON.stringify(payload)
    const size = Buffer.byteLength(raw)
    if (size > FORWARD_ENTRY_MAX)
        throw new Error(`合并转发内容 ${(size / 1048576).toFixed(1)}MB，超出单条 ${(FORWARD_ENTRY_MAX / 1048576).toFixed(0)}MB 上限`)

    await redis.set(FORWARD_KEY + id, raw, { EX: FORWARD_TTL })
    await redis.zAdd(FORWARD_INDEX, { score: Date.now(), value: `${id}:${size}` })
    await trimForward().catch(err =>
        logger.warn(`[QQBot] 合并转发索引裁剪失败: ${err?.stack || err}`))
}

async function trimForward() {
    await redis.zRemRangeByScore(FORWARD_INDEX, 0, Date.now() - FORWARD_TTL * 1000)
    let members = await redis.zRange(FORWARD_INDEX, 0, -1)
    let total = members.reduce((s, m) => s + Number(m.slice(m.lastIndexOf(":") + 1)) || 0, 0)
    while (members.length > FORWARD_MAX_COUNT || total > FORWARD_MAX_BYTES) {
        const m = members.shift()
        if (!m) break
        const id = m.slice(0, m.lastIndexOf(":"))
        total -= Number(m.slice(m.lastIndexOf(":") + 1)) || 0
        await redis.del(FORWARD_KEY + id)
        await redis.zRem(FORWARD_INDEX, m)
    }
}

export async function cleanForwardFiles() {
    const cutoff = Date.now() - FORWARD_TTL * 1000
    const stale = await redis.zRangeByScore(FORWARD_FILES, 0, cutoff)
    if (!stale?.length) return
    await redis.zRemRangeByScore(FORWARD_FILES, 0, cutoff)
    for (const name of stale)
        await fs.rm(path.join(FORWARD_DIR, name)).catch(() => {})
}

export function registerForwardRoute() {
    if (forwardRouteReady || !Bot.express) return false
    forwardRouteReady = true
    Bot.express.get("/forward/:id", async (req, res) => {
        try {
            const id = String(req.params.id || "")
            if (!FORWARD_ID_RE.test(id)) return res.status(400).send("非法链接")
            const raw = await redis.get(FORWARD_KEY + id)
            if (!raw) return res.status(404).send("链接不存在或已过期")
            const payload = JSON.parse(raw)
            const data = {
                bot: {
                    nickname: payload.bot?.nickname,
                    avatar: payload.bot?.avatar,
                    fl: new Map(payload.bot?.fl || []),
                },
            }
            const { rows } = await buildForwardRows(data, payload.msgList, true)
            if (!rows.length) return res.status(404).send("消息为空")
            const tplFile = path.join(process.cwd(), "plugins", "QQBot-Plugin", "resources", "html", "forward.html")
            const tpl = fsSync.readFileSync(tplFile, "utf8")
            res.send(tpl.replace("{{@ html}}", () => rowsHtml(rows)))
        } catch (err) {
            logger.error(`[QQBot] 合并转发链接页渲染失败: ${err?.stack || err}`)
            res.status(500).send("页面渲染失败")
        }
    })
    if (Array.isArray(Bot.express.quiet)) Bot.express.quiet.push("/forward")
    if (Array.isArray(Bot.express.skip_auth) && !Bot.express.skip_auth.includes("/forward"))
        Bot.express.skip_auth.push("/forward")
    return true
}

async function buildForwardRows(data, msgList, web = false) {
    const rows = [], buttons = [], files = []
    const MAX_NODE_DEPTH = 5

    const buildRows = async (list, depth = 0) => {
        if (depth > MAX_NODE_DEPTH) {
            logger.warn(`[QQBot] 合并转发嵌套超过 ${MAX_NODE_DEPTH} 层，已截断`)
            return
        }
        for (const item of list || []) {
            const message = item?.message
            if (!message) continue
            const nickname = item.nickname || item.user_id || data.bot?.nickname || ""
            let avatar = item.avatar
                || (typeof item.user_id === "number" ? `https://q1.qlogo.cn/g?b=qq&nk=${item.user_id}&s=640&t=${avatarCacheKey()}` : "")
                || data.pickFriend?.(item.user_id)?.avatar
                || data.bot?.avatar
                || ""
            avatar = escHtml(String(await segFileSrc(avatar, web, "image/png")))
            const parts = []
            const flushRow = () => {
                const content = parts.filter(Boolean).join("")
                parts.length = 0
                if (content.trim())
                    rows.push({ nickname: escHtml(String(nickname)), avatar, content })
            }
            for (const seg of Array.isArray(message) ? message : [message]) {
                if (!seg) continue
                switch (seg.type) {
                    case "text":
                        parts.push(escHtml(seg.text))
                        break
                    case "at":
                        let atUser = data.bot.fl.get(seg.qq || seg.user_id)
                        parts.push(`<span class="at">@${escHtml(String(atUser?.nickname || seg.qq || seg.user_id || ""))}</span>`)
                        break
                    case "face":
                        parts.push("[表情]")
                        break
                    case "image": {
                        const src = await segFileSrc(seg.file, web, "image/png")
                        if (!src) { parts.push("[图片]"); break }
                        if (!web) { parts.push(`<img class="img" src="${src}">`); break }
                        flushRow()
                        rows.push({
                            nickname: escHtml(String(nickname)), avatar,
                            content: `<a class="img-link" href="${src}" target="_blank" title="点击查看原图"><img class="img" src="${src}" loading="lazy" decoding="async"></a>`,
                            dl: src,
                            dlName: escHtml(String(seg.name || nameFromSrc(src) || "图片.png")),
                        })
                        break
                    }
                    case "record":
                    case "audio":
                    case "video":
                    case "file": {
                        if (!web) {
                            files.push(seg)
                            const label = { record: "语音", audio: "语音", video: "视频", file: "文件" }[seg.type]
                            parts.push(`[${label}附件${files.length}]见后续消息`)
                            break
                        }
                        const kind = seg.type === "record" || seg.type === "audio" ? "audio" : seg.type === "video" ? "video" : "file"
                        const m = await mediaCard(seg, kind)
                        if (!m.src) { parts.push("[附件加载失败]"); break }
                        flushRow()
                        rows.push({ nickname: escHtml(String(nickname)), avatar, content: m.html, dl: m.src, dlName: m.name })
                        break
                    }
                    case "markdown":
                        parts.push(escHtml(Bot.String(seg.content)))
                        break
                    case "button":
                        buttons.push(seg)
                        break
                    case "node": {
                        flushRow()
                        await buildRows(seg.data, depth + 1)
                        break
                    }
                    default:
                        parts.push(escHtml(Bot.String(seg.text ?? seg)))
                }
            }
            flushRow()
        }
    }

    await buildRows(msgList)
    return { rows, buttons, files }
}

export const forwardMethods = {
    async makeForwardMsg(data, msgList, builder = "makeRawMarkdownMsg") {
        const method = config.forwardMethod
        if (method === "url" || method === "card") {
            try {
                const link = await this.forwardToUrl(data, msgList, builder)
                if (link && method === "card") 
                    return await this[builder](data, [segment.card({
                        title: "合并转发消息",
                        description: "点击查看",
                        pic_url: data.bot.avatar,
                        url: link?.startsWith("https://") ? link : 'https://docs.qq.com/scenario/link.html?url=' + link,
                    })])
                if (link) return [{ type: "text", text: `发送了一条合并转发消息\n点击查看：${link}`}]
            } catch (err) {
                logger.warn(`[QQBot] 合并转发链接生成失败，回退为渲染图片: ${err.message}`)
            }
            try {
                const img = await this.forwardToImage(data, msgList, builder)
                if (img) return img
            } catch (err) {
                logger.warn(`[QQBot] 合并转发渲染图片失败，回退为合并发送: ${err.message}`)
            }
        }
        if (method === "image") {
            try {
                const img = await this.forwardToImage(data, msgList, builder)
                if (img) return img
            } catch (err) {
                logger.warn(`[QQBot] 合并转发渲染图片失败，回退为合并发送: ${err.message}`)
            }
        }
        if (method === "image" || method === "merge") {
            try {
                const merged = await this.forwardToMerge(data, msgList, builder)
                if (merged) return merged
            } catch (err) {
                logger.warn(`[QQBot] 合并转发合并失败，回退为逐条发送: ${err.message}`)
            }
        }
        const messages = []
        for (const { message } of msgList)
            messages.push(...(await this[builder](data, message)))

        return messages
    },

    async forwardToMerge(data, msgList, builder) {
        const separator = { type: "text", text: "\n***\n" }
        const result = []
        for (const item of msgList) {
            const msg = item?.message
            const parts = Array.isArray(msg) ? msg.flat(Infinity) : (msg == null ? [] : [msg])
            if (!parts.length) continue
            for (const part of parts){
                if (part.type === "image"){
                    if (!part.height || !part.width) {
                        try {
                            const buffer = await Bot.Buffer(part.file)
                            const size = imageSize(buffer)
                            part.width = size.width
                            part.height = size.height
                        } catch {
                            continue
                        }
                    }
                    if (part.height > 100){
                        part.width = Math.floor(part.width * 100 / part.height)
                        part.height = 100
                    }
                }
            }
            result.push(...parts, separator)
        }
        if (result.length) result.pop()
        const message = await this[builder](data, result)
        return message.length ? message : null
    },

    async forwardToImage(data, msgList, builder) {
        const { rows, buttons, files } = await buildForwardRows(data, msgList)
        if (!rows.length) return null

        const html = rowsHtml(rows)

        const tplFile = path.join(process.cwd(), "plugins", "QQBot-Plugin", "resources", "html", "forward.html")
        const seg = await puppeteer.screenshot("QQBot-Plugin", {
            tplFile,
            html,
            saveId: `qqbot_forward_${Date.now()}`,
        })
        if (!seg) return null

        const file = seg.file ?? seg
        return await this[builder](data, [{ type: "image", file }, ...files, ...buttons])
    },

    async forwardToUrl(data, msgList, builder) {
        const url = String(Bot.url || "").replace(/\/$/, "")
        if (!forwardRouteReady || !url) throw new Error("HTTP 服务地址不可用")

        const id = crypto.randomBytes(16).toString("base64url")
        const payload = {
            msgList: await serializeForward(msgList),
            bot: {
                nickname: data.bot?.nickname,
                avatar: data.bot?.avatar,
                fl: data.bot?.fl ? [...data.bot.fl] : [],
            },
        }
        await storeForward(id, payload)

        return `${url}/forward/${id}`
    },
}
