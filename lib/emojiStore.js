import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const EMOJI_ROOT = path.join(process.cwd(), "plugins", "QQBot-Plugin", "data", "emoji")
const ICON_DIR = path.join(EMOJI_ROOT, "icon")

function slugify(s) {
  return String(s || "list")
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 48) || "list"
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8")
}

async function ensureRoot() {
  await fs.mkdir(EMOJI_ROOT, { recursive: true })
}

// 列出所有表情列表（读取每个子目录里的 emoji.json）
export async function listLists() {
  await ensureRoot()
  let entries = []
  try {
    entries = await fs.readdir(EMOJI_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  const lists = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const metaFile = path.join(EMOJI_ROOT, e.name, "emoji.json")
    const meta = await readJson(metaFile)
    if (!meta) continue
    lists.push({
      folder: e.name,
      icon: meta.icon || null,
      title: meta.title || e.name,
      order: typeof meta.order === "number" ? meta.order : 9999,
      count: 0,
    })
  }
  lists.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  // 填充每个列表的表情数量
  for (const l of lists) {
    l.count = (await listEmojis(l.folder)).length
  }
  return lists
}

export async function createList({ title, icon, folder, iconBuffer, iconExt }) {
  await ensureRoot()
  const safeFolder = slugify(folder || title || "list")
  let finalFolder = safeFolder
  let i = 1
  while (fsSync.existsSync(path.join(EMOJI_ROOT, finalFolder))) {
    finalFolder = `${safeFolder}_${i++}`
  }
  const emojiDir = path.join(EMOJI_ROOT, finalFolder)
  await fs.mkdir(emojiDir, { recursive: true })
  const order = (await listLists()).length
  // 图标：若传入图片 buffer，则保存到 icon/ 目录；否则使用传入的 icon 文件名或默认占位
  let finalIcon = icon || null
  if (iconBuffer && iconExt) {
    finalIcon = await saveListIcon(finalFolder, iconBuffer, iconExt)
  }
  await writeJson(path.join(emojiDir, "emoji.json"), {
    title: title || finalFolder,
    icon: finalIcon,
    folder: finalFolder,
    order,
  })
  return {
    folder: finalFolder,
    icon: finalIcon,
    title: title || finalFolder,
    order,
    count: 0,
  }
}

// 保存列表图标图片到 icon/ 目录，返回图标文件名（meta.icon 存此文件名）
export async function saveListIcon(folder, buffer, ext) {
  await fs.mkdir(ICON_DIR, { recursive: true })
  const safeExt = String(ext || "png").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "png"
  let fileName = `${slugify(folder) || "icon"}.${safeExt}`
  let n = 1
  while (fsSync.existsSync(path.join(ICON_DIR, fileName))) {
    fileName = `${slugify(folder) || "icon"}_${n++}.${safeExt}`
  }
  await fs.writeFile(path.join(ICON_DIR, fileName), buffer)
  return fileName
}

export async function deleteList(folder) {
  const dir = path.join(EMOJI_ROOT, folder)
  // 删除对应的图标文件（meta.icon 存的是 icon/ 目录下的文件名）
  try {
    const metaFile = path.join(dir, "emoji.json")
    if (fsSync.existsSync(metaFile)) {
      const meta = await readJson(metaFile)
      const icon = meta && meta.icon
      if (icon && typeof icon === "string" && icon.includes(".") && !icon.startsWith("data:")) {
        const iconPath = path.join(ICON_DIR, path.basename(icon))
        if (fsSync.existsSync(iconPath)) await fs.rm(iconPath, { force: true })
      }
    }
  } catch (e) {
    // 图标清理失败不影响列表目录删除
  }
  await fs.rm(dir, { recursive: true, force: true })
}

// 修改列表设置：标题与图标（图标可重新上传图片）
export async function updateList(folder, { title, icon, iconBuffer, iconExt }) {
  const emojiDir = path.join(EMOJI_ROOT, folder)
  const metaFile = path.join(emojiDir, "emoji.json")
  if (!fsSync.existsSync(metaFile)) throw new Error("列表不存在")
  const meta = await readJson(metaFile)
  if (title != null) meta.title = title
  if (iconBuffer && iconExt) {
    meta.icon = await saveListIcon(folder, iconBuffer, iconExt)
  } else if (icon != null) {
    meta.icon = icon
  }
  await writeJson(metaFile, meta)
  return {
    folder: meta.folder,
    icon: meta.icon,
    title: meta.title,
    order: meta.order,
    count: Array.isArray(meta.emojis) ? meta.emojis.length : 0,
  }
}

export async function reorderLists(order) {
  // order: string[] of folder names
  for (let i = 0; i < order.length; i++) {
    const metaFile = path.join(EMOJI_ROOT, order[i], "emoji.json")
    const meta = await readJson(metaFile)
    if (meta) {
      meta.order = i
      await writeJson(metaFile, meta)
    }
  }
}

export async function listEmojis(folder, baseUrl = "") {
  const metaFile = path.join(EMOJI_ROOT, folder, "emoji.json")
  const meta = await readJson(metaFile)
  if (!meta) return []
  const items = Array.isArray(meta.emojis) ? meta.emojis : []
  items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
  const prefix = `${baseUrl}/emoji-static`
  return items.map((e, idx) => ({
    url: `${prefix}/${folder}/${e.file}`,
    file: e.file,
    name: e.name,
    order: e.order ?? idx,
  }))
}

// 添加一个或多个表情图片文件，返回新增的表情信息；相同内容图片自动跳过（去重）
export async function addEmojis(folder, files) {
  const emojiDir = path.join(EMOJI_ROOT, folder)
  const metaFile = path.join(emojiDir, "emoji.json")
  const meta = (await readJson(metaFile)) || { title: folder, icon: "📁" }
  if (!Array.isArray(meta.emojis)) meta.emojis = []
  const startOrder = meta.emojis.length
  const added = []
  let skipped = 0
  let i = 0
  // 预计算已存在表情的内容哈希，用于重复检测
  const existingHashes = new Set()
  for (const e of meta.emojis) {
    try {
      const buf = await fs.readFile(path.join(emojiDir, e.file))
      existingHashes.add(crypto.createHash("md5").update(buf).digest("hex"))
    } catch { /* 忽略损坏文件 */ }
  }
  for (const f of files) {
    const srcName = f.filename || f.originalname || f.name || `emoji_${i}`
    const ext = (srcName.split(".").pop() || "png").replace(/[^a-zA-Z0-9]/g, "")
    const base = slugify(srcName.replace(/\.[^.]+$/, "")) || `emoji`
    // 内容去重：与已存在（含本次已新增）的哈希比对
    const md5 = crypto.createHash("md5").update(f.buffer).digest("hex")
    if (existingHashes.has(md5)) { skipped++; continue }
    existingHashes.add(md5)
    let fileName = `${base}.${ext}`
    let n = 1
    while (fsSync.existsSync(path.join(emojiDir, fileName))) {
      fileName = `${base}_${n++}.${ext}`
    }
    await fs.writeFile(path.join(emojiDir, fileName), f.buffer)
    meta.emojis.push({ name: srcName.replace(/\.[^.]+$/, ""), file: fileName, order: startOrder + i })
    added.push({ file: fileName, name: srcName })
    i++
  }
  await writeJson(metaFile, meta)
  return { added, skipped }
}

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i

// 同步文件夹：删除失效记录（文件不存在），把文件夹内未记录的图片追加到末尾（内容去重）
export async function syncFolder(folder) {
  const emojiDir = path.join(EMOJI_ROOT, folder)
  if (!fsSync.existsSync(emojiDir)) throw new Error("列表不存在")
  const metaFile = path.join(emojiDir, "emoji.json")
  const meta = (await readJson(metaFile)) || { title: folder, icon: null }
  if (!Array.isArray(meta.emojis)) meta.emojis = []
  // 1. 删除失效记录（对应的图片文件已不存在）
  meta.emojis = meta.emojis.filter(e => e && typeof e.file === "string" && fsSync.existsSync(path.join(emojiDir, e.file)))
  // 2. 读取文件夹内所有图片，追加未记录项（内容去重）
  const existingFiles = new Set(meta.emojis.map(e => e.file))
  const existingHashes = new Set()
  for (const e of meta.emojis) {
    try {
      const buf = await fs.readFile(path.join(emojiDir, e.file))
      existingHashes.add(crypto.createHash("md5").update(buf).digest("hex"))
    } catch { /* 忽略 */ }
  }
  let added = 0
  let i = 0
  const files = await fs.readdir(emojiDir)
  for (const name of files) {
    if (name === "emoji.json") continue
    if (!IMG_EXT_RE.test(name)) continue
    if (existingFiles.has(name)) continue
    let buf
    try { buf = await fs.readFile(path.join(emojiDir, name)) } catch { continue }
    const md5 = crypto.createHash("md5").update(buf).digest("hex")
    if (existingHashes.has(md5)) continue
    existingHashes.add(md5)
    meta.emojis.push({ name: name.replace(/\.[^.]+$/, ""), file: name, order: meta.emojis.length + i })
    added++
    i++
  }
  // 重新规整顺序
  meta.emojis.forEach((e, idx) => { e.order = idx })
  await writeJson(metaFile, meta)
  return { added, total: meta.emojis.length }
}

export async function deleteEmoji(folder, file) {
  const emojiDir = path.join(EMOJI_ROOT, folder)
  const metaFile = path.join(emojiDir, "emoji.json")
  const meta = await readJson(metaFile)
  if (!meta || !Array.isArray(meta.emojis)) return
  meta.emojis = meta.emojis.filter(e => e.file !== file)
  await writeJson(metaFile, meta)
  await fs.unlink(path.join(emojiDir, file)).catch(() => {})
}

export async function reorderEmojis(folder, order) {
  // order: string[] of file names
  const metaFile = path.join(EMOJI_ROOT, folder, "emoji.json")
  const meta = await readJson(metaFile)
  if (!meta || !Array.isArray(meta.emojis)) return
  const map = new Map(meta.emojis.map(e => [e.file, e]))
  const newArr = []
  for (let i = 0; i < order.length; i++) {
    const e = map.get(order[i])
    if (e) {
      e.order = i
      newArr.push(e)
      map.delete(order[i])
    }
  }
  for (const e of map.values()) newArr.push(e)
  meta.emojis = newArr
  await writeJson(metaFile, meta)
}

export function getEmojiRoot() {
  return EMOJI_ROOT
}
