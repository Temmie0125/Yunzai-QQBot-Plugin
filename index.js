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
