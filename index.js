// QQBot 插件入口
// 1. 初始化数据库与黑名单
// 2. 注册适配器（adapter 单例在各模块中拆分实现）
// 3. 聚合 apps/ 下的命令类，供 Yunzai 加载器通过 export const apps 展开注册
logger.info(logger.yellow("- 正在加载 QQBot 适配器插件"))

import { adapter } from "./adapter/adapter.js"
import { loadBlacklist } from "./lib/blacklist.js"
import { msgSequelize } from "./model/init.js"
import MessageDB from "./model/MessageDB.js"
import MsgIdxDB from "./model/MsgIdxDB.js"
import ActiveListDB from "./model/ActiveListDB.js"
import PinDB from "./model/PinDB.js"

import { QQBotAccount } from "./apps/account.js"
import { QQBotFilter } from "./apps/filter.js"
import { QQBotBlacklist } from "./apps/blacklist.js"
import { QQBotGroupBind } from "./apps/groupBind.js"
import { QQBotQrLogin } from "./apps/qrlogin.js"
import { QQBotAppSet } from "./apps/appset.js"
import { QQBotStat } from "./apps/stat.js"

Object.assign(global.segment, {
  buble(...data) {
    return { type: 'buble', data }
  },
  small() {
    return { type: 'small' }
  },
  card(data) {
    return { type: 'card', ...data }
  },
  inlinecmd(text, input, enter = false, reply = false) {
    return `[${text}](mqqapi://aio/inlinecmd?command=${encodeURIComponent(input ?? text)}&enter=${enter}&reply=${reply})`
  },
  qqbotcmd(text, input, enter = false, reply = false) {
    return enter ? `<qqbot-cmd-enter text="${encodeURIComponent(input ?? text)}" />` : `<qqbot-cmd-input text="${encodeURIComponent(input ?? text)}" show="${encodeURIComponent(text)}" reference="${reply}" />`
  },
  link(text, link){
    return `[🔗${text}](${link})`
  },
  ark(template_id, data = {}){
    const id = Number(template_id)
    const kv = []
    const get = (...names) => {
      for (const n of names) {
        for (const k of Object.keys(data)) {
          if (k === n || k.toLowerCase() === n.toLowerCase()) return data[k]
        }
      }
      return undefined
    }
    const need = (v, name) => {
      const s = _str(v)
      if (!s) throw new Error(`[ark ${id}] ${name} 必填`)
      return s
    }
    const needUrl = (v, name) => {
      const s = need(v, name)
      //if (!/^https?:\/\/\S+$/.test(s)) throw new Error(`[ark ${id}] ${name} 必须是 http(s) 链接`)
      return s
    }
    const push = (key, value) => kv.push({ key, value })
    switch(Number(template_id)){
      case 23:{
        push('#DESC#',   need(get('desc'), 'desc'))
        push('#PROMPT#', need(get('prompt'), 'prompt'))

        const list = (Array.isArray(get('list')) ? get('list') : [get('list')])
          .flat().filter(Boolean)
          .map((item) => {
            let desc, link
            if (typeof item === 'string')           desc = item
            else if (Array.isArray(item))           [desc, link] = item
            else { desc = item.desc ?? item.text; link = item.link ?? item.url }

            desc = need(desc, 'list[].desc')
            const obj_kv = [{ key: 'desc', value: desc }]
            if (_str(link)) obj_kv.push({ key: 'link', value: needUrl(link, 'list[].link') })
            return { obj_kv }
          })
        if (!list.length) throw new Error(`[ark 23] list 不能为空`)
        kv.push({ key: '#LIST#', obj: list })
        break
      }
      case 24: {
        push('#DESC#',     need(get('desc'), 'desc'))
        push('#PROMPT#',   need(get('prompt'), 'prompt'))
        push('#TITLE#',    need(get('title'), 'title'))
        push('#METADESC#', need(get('metadesc', 'meta_desc', 'metaDesc'), 'metadesc'))
        push('#IMG#',      needUrl(get('img'), 'img'))
        push('#LINK#',     needUrl(get('link'), 'link'))
        push('#SUBTITLE#', need(get('subtitle', 'sub_title', 'subTitle'), 'subtitle'))
        break
      }
      case 37: {
        push('#PROMPT#',       need(get('prompt'), 'prompt'))
        push('#METATITLE#',    need(get('metatitle', 'meta_title', 'metaTitle'), 'metatitle'))
        push('#METASUBTITLE#', need(get('metasubtitle', 'meta_subtitle', 'metaSubtitle'), 'metasubtitle'))
        push('#METACOVER#',    needUrl(get('metacover', 'meta_cover', 'metaCover'), 'metacover'))  // 975×540
        push('#METAURL#',      needUrl(get('metaurl', 'meta_url', 'metaUrl'), 'metaurl'))
        break
      } 
      default:
        throw new Error(`[ark] 不支持的 template_id: ${template_id}，可选 23 / 24 / 37`)
    }
    return { type: 'ark', ark: { template_id: id, kv } }
  },
  ark23(data = {}){
    return this.ark(23, data)
  },
  ark24(data = {}){
    return this.ark(24, data)
  },
  ark37(data = {}){
    return this.ark(37, data)
  }
})

import {
    initStat, getSummary, getDaily, getTrend, getTopUsers, getGroupStats, clearStat, dateStr,
} from "./lib/stat.js"

await msgSequelize.sync()

// 统计库建表 + 清理过期数据
await initStat()

try {
    await msgSequelize.query("ALTER TABLE messages ADD COLUMN bot_nickname TEXT DEFAULT ''")
} catch (e) {
    if (!e.message?.includes("duplicate column")) logger.debug("[QQBot] bot_nickname 列已存在")
}

await loadBlacklist()

Bot.MessageDB = MessageDB
Bot.MsgIdxDB = MsgIdxDB
Bot.ActiveListDB = ActiveListDB
Bot.PinDB = PinDB

// 暴露统计模块给 webadapter 操作模块调用（避免其直接依赖 adapter 层，规避加载顺序问题）
Bot.QQBotStat = { getSummary, getDaily, getTrend, getTopUsers, getGroupStats, clearStat, dateStr }

Bot.adapter.push(adapter)

// 聚合命令类，供 Yunzai 加载器注册
export const apps = {
    QQBotAccount,
    QQBotFilter,
    QQBotBlacklist,
    QQBotGroupBind,
    QQBotQrLogin,
    QQBotAppSet,
    QQBotStat,
}

logger.info(logger.yellow("- QQBot 适配器插件加载完成"))
