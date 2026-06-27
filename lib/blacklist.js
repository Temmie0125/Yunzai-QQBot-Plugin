/**
 * QQBot 黑名单模块
 * 配置文件：QQBot-Plugin/data/black/black-groups.yaml & black-users.yaml
 * 内存运行，文件持久化
 *
 * 存储规则：
 * - user_id: 完整 user_id（即 selfId{sep}openid，由调用方拼好传入）
 * - group_id: 完整 group_id（即 selfId{sep}groupOpenid，由调用方拼好传入）
 * - unionid: 纯 unionid（所有Bot共享）
 *
 * 注意：本模块不持有 sep，需要拆分字符串的函数由调用方传入 sep
 */
import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BLACK_DIR = path.join(__dirname, "..", "data", "black")
const BLACK_GROUPS_FILE = path.join(BLACK_DIR, "black-groups.yaml")
const BLACK_USERS_FILE = path.join(BLACK_DIR, "black-users.yaml")

/** @type {{ groups: Set<string>, users: { userid: Set<string>, unionid: Set<string> } }} */
const state = {
  groups: new Set(),
  users: { userid: new Set(), unionid: new Set() },
}

// ====== 初始化 ======

async function ensureFiles() {
  try { await fs.mkdir(BLACK_DIR, { recursive: true }) } catch {}
  for (const [file, def] of [
    [BLACK_GROUPS_FILE, { groups: [] }],
    [BLACK_USERS_FILE, { userid: [], unionid: [] }],
  ]) {
    try { await fs.access(file) } catch {
      await fs.writeFile(file, YAML.stringify(def), "utf8")
    }
  }
}

export async function loadBlacklist() {
  await ensureFiles()
  try {
    const d = YAML.parse(await fs.readFile(BLACK_GROUPS_FILE, "utf8")) || {}
    state.groups = new Set((d.groups || []).map(String))
  } catch { state.groups = new Set() }
  try {
    const d = YAML.parse(await fs.readFile(BLACK_USERS_FILE, "utf8")) || {}
    state.users.userid = new Set((d.userid || []).map(String))
    state.users.unionid = new Set((d.unionid || []).map(String))
  } catch { state.users = { userid: new Set(), unionid: new Set() } }
}

// ====== 持久化 ======

async function saveGroups() {
  try {
    await fs.writeFile(BLACK_GROUPS_FILE, YAML.stringify({ groups: [...state.groups] }), "utf8")
  } catch (e) { logger.debug("[黑名单] 保存群列表失败:", e) }
}

async function saveUsers() {
  try {
    await fs.writeFile(BLACK_USERS_FILE, YAML.stringify({
      userid: [...state.users.userid],
      unionid: [...state.users.unionid],
    }), "utf8")
  } catch (e) { logger.debug("[黑名单] 保存用户列表失败:", e) }
}

// ====== 查询 ======

/** 检查群是否被拉黑 */
export function isGroupBlacklisted(groupId) {
  return typeof groupId === "string" && state.groups.has(groupId)
}

/** 检查用户是否被拉黑 */
export function isUserBlacklisted(userId, unionid) {
  if (userId && state.users.userid.has(userId)) return true
  if (unionid && state.users.unionid.has(unionid)) return true
  return false
}

// ====== 修改 ======

/** 拉黑群聊 */
export async function blacklistGroup(groupId) {
  if (!groupId) return
  state.groups.add(String(groupId))
  await saveGroups()
}

/** 取消拉黑群聊 */
export async function unblacklistGroup(groupId) {
  state.groups.delete(String(groupId))
  await saveGroups()
}

/** 拉黑用户 */
export async function blacklistUser(userId, unionid) {
  if (userId) state.users.userid.add(String(userId))
  if (unionid) state.users.unionid.add(String(unionid))
  await saveUsers()
}

/** 取消拉黑用户 */
export async function unblacklistUser(userId, unionid) {
  if (userId) state.users.userid.delete(String(userId))
  if (unionid) state.users.unionid.delete(String(unionid))
  await saveUsers()
}

// ====== 导出数据（供 Web API） ======

/**
 * 获取黑名单数据，可按 selfId 过滤
 * @param {string} [selfId] - 可选，过滤特定 Bot 的黑名单
 */
export function getBlacklistData(selfId) {
  if (!selfId) {
    return {
      groups: [...state.groups],
      userid: [...state.users.userid],
      unionid: [...state.users.unionid],
    }
  }
  const sep = (typeof Bot !== "undefined" && Bot[selfId]?.adapter?.sep) || ":"
  const prefix = `${selfId}${sep}`
  return {
    groups: [...state.groups].filter(g => g.startsWith(prefix)),
    userid: [...state.users.userid]
      .filter(u => u.startsWith(prefix))
      .map(u => u.slice(prefix.length)),
    unionid: [...state.users.unionid],
  }
}

// ====== 工具：从 user_id 提取原始 openid ======

/**
 * @param {string} userId - 格式: selfId{sep}openid
 */
export function extractOpenid(userId) {
  if (!userId) return ""
  if (userId.startsWith("qg_")) return userId.slice(3)
  // 从 userId 提取 selfId，再从 Bot 获取该适配器的 sep
  let sep = ":"
  const firstColon = userId.indexOf(":")
  if (firstColon > -1) {
    const selfId = userId.slice(0, firstColon)
    sep = (typeof Bot !== "undefined" && Bot[selfId]?.adapter?.sep) || ":"
  }
  const idx = userId.indexOf(sep)
  return idx > -1 ? userId.slice(idx + 1) : userId
}
