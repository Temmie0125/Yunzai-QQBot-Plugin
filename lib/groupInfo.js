/**
 * 群信息共享模块
 * - 被 QQBot-Plugin 和 QQBot-Web-Adapter 共同使用
 * - 优先通过 QQ 适配器获取，回退到 Napcat HTTP
 * - initGroupInfoMap 中的批量获取不阻塞启动（后台异步补充）
 */

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

// __dirname 在 ESM 中不可用，用 import.meta.url 推导本文件所在目录
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 读取 Napcat 配置（QQBot-Web-Adapter/config/config.yaml）
 * @returns {{ napcatHost: string, napcatPort: number, napcatToken: string }}
 */
async function getNapcatConfig() {
  try {
    const waConfigFile = path.join(__dirname, '..', '..', 'QQBot-Web-Adapter', 'config', 'config.yaml')
    const raw = await fs.readFile(waConfigFile, 'utf8')
    const waConfig = YAML.parse(raw) || {}
    return {
      napcatHost: waConfig.napcatHost || '127.0.0.1',
      napcatPort: waConfig.napcatPort || 3000,
      napcatToken: waConfig.napcatToken || '',
    }
  } catch {}
  return { napcatHost: '127.0.0.1', napcatPort: 3000, napcatToken: '' }
}

/**
 * 获取单个群信息
 * @param {string} groupQQ - QQ群号
 * @param {{ napcatHost?: string, napcatPort?: number, napcatToken?: string }} [napcatConfig]
 * @returns {Promise<object|null>}
 */
export async function fetchGroupInfo(groupQQ, napcatConfig) {
  const qq = String(groupQQ)

  // 优先使用 QQ 适配器实例
  let qqAdapterUin = null
  for (const uin of Bot.uin) {
    if (Bot[uin]?.adapter?.id === 'QQ') { qqAdapterUin = uin; break }
  }

  if (qqAdapterUin) {
    try {
      const result = await Bot[qqAdapterUin].sendApi('get_group_info', { group_id: Number(qq) })
      if (result?.data) {
        return {
          group_id: result.data.group_id || Number(qq),
          group_name: result.data.group_name || result.data.groupName || '',
          member_count: result.data.member_count || result.data.memberNum || 0,
          max_member_count: result.data.max_member_count || result.data.maxMemberNum || 0,
          group_remark: result.data.group_remark || result.data.remarkName || '',
        }
      }
    } catch (err) {
      logger.error(`[GroupInfo] QQ适配器 get_group_info(${qq}) 失败: ${err.message}`)
    }
  }

  // 回退：Napcat HTTP（仅当启用 Napcat 时）
  if (!Bot.napcatEnabled) return null

  const { napcatHost, napcatPort, napcatToken } = { ...await getNapcatConfig(), ...napcatConfig }
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (napcatToken) headers['Authorization'] = `Bearer ${napcatToken}`
    const res = await fetch(`http://${napcatHost}:${napcatPort}/get_group_info`, {
      method: 'POST', headers,
      body: JSON.stringify({ group_id: qq }),
    })
    const data = await res.json()
    if (data?.data) {
      return {
        group_id: data.data.group_id || Number(qq),
        group_name: data.data.group_name || data.data.groupName || '',
        member_count: data.data.member_count || data.data.memberNum || 0,
        max_member_count: data.data.max_member_count || data.data.maxMemberNum || 0,
        group_remark: data.data.group_remark || data.data.remarkName || '',
      }
    }
  } catch {}

  return null
}

/**
 * 初始化群信息缓存 Map
 * - 同步从 Redis 恢复已缓存数据（快速）
 * - 后台异步扫描已绑定群并补充获取缺失信息（不阻塞启动）
 * - 幂等：Bot.groupInfoMap 已存在时直接返回
 */
export async function initGroupInfoMap() {
  if (Bot.groupInfoMap) return

  Bot.groupInfoMap = new Map()

  // 1. 同步恢复 Redis 缓存（快）
  try {
    const cachedKeys = await redis.keys('wind-group-info:*')
    for (const key of cachedKeys) {
      const qq = key.split(':')[2]
      const raw = await redis.get(key)
      if (raw) {
        try { Bot.groupInfoMap.set(qq, JSON.parse(raw)) } catch {}
      }
    }
    if (Bot.groupInfoMap.size) {
      logger.info(logger.green(`[GroupInfo] 已从 Redis 加载 ${Bot.groupInfoMap.size} 个群的缓存信息`))
    }
  } catch {}

  // 2. 后台异步补充获取未缓存的绑定群（不阻塞，仅当启用 Napcat 时）
  if (!Bot.napcatEnabled) return
  setTimeout(async () => {
    try {
      const napcatConfig = await getNapcatConfig()
      const binds = await redis.hGetAll('wind-group-bind')
      const toFetch = Object.values(binds).filter(qq => !Bot.groupInfoMap.has(qq))
      if (!toFetch.length) return
      let fetched = 0
      for (const qq of toFetch) {
        const info = await fetchGroupInfo(qq, napcatConfig)
        if (info) {
          Bot.groupInfoMap.set(qq, info)
          await redis.set(`wind-group-info:${qq}`, JSON.stringify(info))
          fetched++
        }
        await Bot.sleep(200)
      }
      logger.info(logger.green(`[GroupInfo] 绑定群信息加载完成: ${fetched}/${toFetch.length}`))
    } catch {}
  })
}
