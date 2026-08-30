// QQBot 使用统计：按 botQQ 分别记录每日/每月使用数据（SQLite）
// DB 文件：plugins/QQBot-Plugin/data/db/stat.db
// 开关：config.stat（默认关闭，关闭时不记录、不初始化展示页）
//
// 只统计 QQBot 适配器的机器人，沙盒（adapter id 为 QQBotSandbox）不计入、不展示。
// 本模块只做业务聚合，数据访问全部通过 model/StatDB.js 的静态方法
//   stat_user       每日使用者（msg_count = 当日消息数，用于排名）
//   stat_group      每日使用群（msg_count = 群消息数）
//   stat_group_user 某群当日使用者（去重，算各群使用人数）
//   stat_event      每日事件：新加入群 / 被踢出群 / 新增好友 / 减少好友
import { config } from "../adapter/context.js"
import { statSequelize, StatUser, StatGroup, StatGroupUser, StatEvent } from "../model/StatDB.js"

// 数据保留天数（一年）
export const KEEP_DAYS = 365

// 群内使用者去重缓存（避免对同一组合重复查询），key = bot|date|gid|uid
const guCache = new Set()
const GU_CACHE_MAX = 20000

// ====== 日期工具（本地时区） ======
export function dateStr(d = new Date()) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
}

/** 日期偏移 n 天（n 可为负） */
export function shiftDate(date, n) {
    const [y, m, d] = String(date).split("-").map(Number)
    const dt = new Date(y, m - 1, d)
    dt.setDate(dt.getDate() + n)
    return dateStr(dt)
}

/** 时间戳 -> 日期字符串 */
export function tsToDate(ts) {
    const n = Number(ts) || Date.now() / 1000
    return dateStr(new Date(n * 1000))
}

/**
 * 某年月的起止日期（YYYY-MM-DD）。m 可越界（0=上一年12月，13=下一年1月）
 */
export function monthRange(y, m) {
    const d = new Date(Number(y), Number(m) - 1, 1)
    const yy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    const last = new Date(yy, d.getMonth() + 1, 0).getDate()
    return {
        start: `${yy}-${mm}-01`,
        end: `${yy}-${mm}-${String(last).padStart(2, "0")}`,
        year: yy,
        month: d.getMonth() + 1,
        days: last,
    }
}

/**
 * 只统计 QQBot：沙盒（QQBotSandbox）及其他非 QQBot 适配器的机器人一律跳过
 * 尚未加载实例时无法判断，按允许处理
 */
export function isStatBot(bot) {
    const adapterId = Bot[bot]?.adapter?.id
    if (!adapterId) return true
    return adapterId === "QQBot"
}

/** 建表 + 清理过期数据（由插件入口调用） */
export async function initStat() {
    await statSequelize.sync()
    if (config?.stat) await cleanExpired()
}

// ====== 记录 ======

/**
 * 记录一条消息（在 Bot.em 下发前调用，统计"真实收到"的消息）
 * @param {object} data adapter 构造的 data（含 self_id / user_id / group_id / time）
 */
export async function recordMessage(data) {
    if (!config?.stat) return
    const bot = String(data?.self_id || "")
    if (!bot || !isStatBot(bot)) return

    try {
        const uid = String(data?.user_id || "")
        if (!uid) return

        const d = tsToDate(data.time)
        const gid = data.group_id ? String(data.group_id) : ""

        await StatUser.incrMsg(bot, d, uid, data.nickname ? String(data.nickname) : "")

        if (gid) {
            await StatGroup.incrMsg(bot, d, gid, data.group_name ? String(data.group_name) : "")
            const ck = `${bot}|${d}|${gid}|${uid}`
            if (!guCache.has(ck)) {
                if (guCache.size > GU_CACHE_MAX) guCache.clear()
                await StatGroupUser.ensure(bot, d, gid, uid)
                guCache.add(ck)
            }
        }
    } catch (err) {
        logger.debug(`[QQBot] 统计记录消息失败: ${err?.message || err}`)
    }
}

/**
 * 记录通知事件（机器人入群 / 被移出群 / 新增好友 / 减少好友）
 * sub_type：increase=入群 decrease=移出 add=新增好友 del=减少好友
 * （群成员增减是 member.increase / member.decrease，不计入）
 */
export async function recordNotice(data) {
    if (!config?.stat) return
    const bot = String(data?.self_id || "")
    if (!bot || !isStatBot(bot)) return

    try {
        let field = null
        if (data.notice_type === "group") {
            if (data.sub_type === "increase") field = "group_join"
            else if (data.sub_type === "decrease") field = "group_kick"
        } else if (data.notice_type === "friend") {
            if (data.sub_type === "add") field = "friend_add"
            else if (data.sub_type === "del") field = "friend_del"
        }
        if (!field) return

        await StatEvent.incr(bot, tsToDate(data.time), field)
    } catch (err) {
        logger.debug(`[QQBot] 统计记录通知失败: ${err?.message || err}`)
    }
}

// ====== 查询 ======

/** 两个 id 数组的交集数量 */
function intersectCount(a, b) {
    const set = new Set(b)
    let n = 0
    for (const x of a) if (set.has(x)) n++
    return n
}

/** 计算环比 / 同比增长率（base 为 0 时返回 null 表示"新增"） */
function growth(cur, base) {
    if (!base) return cur > 0 ? null : 0
    return Number((((cur - base) / base) * 100).toFixed(2))
}

/**
 * 获取指定 bot 某日的完整统计（环比=较昨日，同比=较上周同日）
 * @param {string} bot botQQ
 * @param {string} date YYYY-MM-DD，默认今天
 */
export async function getDaily(bot, date = dateStr()) {
    const prev = shiftDate(date, -1)
    const week = shiftDate(date, -7)

    const [users, groups, prevUsers, prevGroups, weekUsers, weekGroups, messages, events, keepUsers, keepGroups, prevMessages, weekMessages] =
        await Promise.all([
            StatUser.countByDate(bot, date),
            StatGroup.countByDate(bot, date),
            StatUser.countByDate(bot, prev),
            StatGroup.countByDate(bot, prev),
            StatUser.countByDate(bot, week),
            StatGroup.countByDate(bot, week),
            StatUser.sumMsgByDate(bot, date),
            StatEvent.get(bot, date),
            StatUser.countKeep(bot, date, prev),
            StatGroup.countKeep(bot, date, prev),
            StatUser.sumMsgByDate(bot, prev),
            StatUser.sumMsgByDate(bot, week),
        ])

    const userCount = Number(users) || 0
    const groupCount = Number(groups) || 0
    const prevUserCount = Number(prevUsers) || 0
    const prevGroupCount = Number(prevGroups) || 0
    const keepUsersN = Number(keepUsers) || 0
    const keepGroupsN = Number(keepGroups) || 0

    return {
        date,
        // 人数
        users: userCount,
        newUsers: Math.max(0, userCount - keepUsersN),
        keepUsers: keepUsersN,
        lostUsers: Math.max(0, prevUserCount - keepUsersN),
        // 群
        groups: groupCount,
        newGroups: Math.max(0, groupCount - keepGroupsN),
        keepGroups: keepGroupsN,
        lostGroups: Math.max(0, prevGroupCount - keepGroupsN),
        // 消息
        messages: Number(messages) || 0,
        // 事件
        events,
        // 环比（较昨日） / 同比（较上周同日）
        usersQoQ: growth(userCount, prevUserCount),
        usersYoY: growth(userCount, Number(weekUsers) || 0),
        groupsQoQ: growth(groupCount, prevGroupCount),
        groupsYoY: growth(groupCount, Number(weekGroups) || 0),
        messagesQoQ: growth(Number(messages) || 0, Number(prevMessages) || 0),
        messagesYoY: growth(Number(messages) || 0, Number(weekMessages) || 0),
    }
}

/**
 * 获取指定 bot 某月的完整统计（环比=较上月，同比=较去年同月）
 * @param {string} bot botQQ
 * @param {string} month YYYY-MM，默认本月
 */
export async function getMonthly(bot, month = dateStr().slice(0, 7)) {
    const [y, m] = String(month).split("-").map(Number)
    const cur = monthRange(y, m)
    const prevR = monthRange(y, m - 1)
    const lastYearR = monthRange(y - 1, m)

    const [users, groups, messages, events, curUids, prevUids, curGids, prevGids, prevUsers, prevGroups, lyUsers, lyGroups, prevMessages, lyMessages] =
        await Promise.all([
            StatUser.countDistinctRange(bot, cur.start, cur.end),
            StatGroup.countDistinctRange(bot, cur.start, cur.end),
            StatUser.sumMsgRange(bot, cur.start, cur.end),
            StatEvent.sumRange(bot, cur.start, cur.end),
            StatUser.idsRange(bot, cur.start, cur.end),
            StatUser.idsRange(bot, prevR.start, prevR.end),
            StatGroup.idsRange(bot, cur.start, cur.end),
            StatGroup.idsRange(bot, prevR.start, prevR.end),
            StatUser.countDistinctRange(bot, prevR.start, prevR.end),
            StatGroup.countDistinctRange(bot, prevR.start, prevR.end),
            StatUser.countDistinctRange(bot, lastYearR.start, lastYearR.end),
            StatGroup.countDistinctRange(bot, lastYearR.start, lastYearR.end),
            StatUser.sumMsgRange(bot, prevR.start, prevR.end),
            StatUser.sumMsgRange(bot, lastYearR.start, lastYearR.end),
        ])

    const userCount = Number(users) || 0
    const groupCount = Number(groups) || 0
    const prevUserCount = Number(prevUsers) || 0
    const prevGroupCount = Number(prevGroups) || 0
    const keepUsersN = intersectCount(curUids, prevUids)
    const keepGroupsN = intersectCount(curGids, prevGids)

    return {
        date: month,
        users: userCount,
        newUsers: Math.max(0, userCount - keepUsersN),
        keepUsers: keepUsersN,
        lostUsers: Math.max(0, prevUserCount - keepUsersN),
        groups: groupCount,
        newGroups: Math.max(0, groupCount - keepGroupsN),
        keepGroups: keepGroupsN,
        lostGroups: Math.max(0, prevGroupCount - keepGroupsN),
        messages: Number(messages) || 0,
        events,
        // 环比（较上月） / 同比（较去年同月）
        usersQoQ: growth(userCount, prevUserCount),
        usersYoY: growth(userCount, Number(lyUsers) || 0),
        groupsQoQ: growth(groupCount, prevGroupCount),
        groupsYoY: growth(groupCount, Number(lyGroups) || 0),
        messagesQoQ: growth(Number(messages) || 0, Number(prevMessages) || 0),
        messagesYoY: growth(Number(messages) || 0, Number(lyMessages) || 0),
    }
}

/** 用户头像（与适配器一致：qqapp 头像地址），取不到 appid/openid 时返回空串 */
function userAvatar(bot, userId) {
    const appid = Bot[bot]?.info?.appid
    if (!appid) return ""
    const openid = String(userId).split(":").pop()
    if (!openid) return ""
    return `https://q.qlogo.cn/qqapp/${appid}/${openid}/0`
}

/**
 * 获取指定 bot 近 N 天的汇总统计（截至 endDate，含当天）
 * 环比 = 较上一个等长周期；同比 = 较去年同期同区间
 * @param {string} bot botQQ
 * @param {string} endDate 截止日 YYYY-MM-DD，默认今天
 * @param {number} days 天数，默认 7
 */
export async function getRange(bot, endDate = dateStr(), days = 7) {
    const end = endDate
    const start = shiftDate(end, -(days - 1))
    // 上一个等长周期
    const prevEnd = shiftDate(end, -days)
    const prevStart = shiftDate(prevEnd, -(days - 1))
    // 去年同区间
    const [y, m, d] = String(end).split("-").map(Number)
    const lyEnd = dateStr(new Date(y - 1, m - 1, d))
    const lyStart = shiftDate(lyEnd, -(days - 1))

    const [users, groups, messages, events, curUids, prevUids, curGids, prevGids, prevUsers, prevGroups, lyUsers, lyGroups, prevMessages, lyMessages] =
        await Promise.all([
            StatUser.countDistinctRange(bot, start, end),
            StatGroup.countDistinctRange(bot, start, end),
            StatUser.sumMsgRange(bot, start, end),
            StatEvent.sumRange(bot, start, end),
            StatUser.idsRange(bot, start, end),
            StatUser.idsRange(bot, prevStart, prevEnd),
            StatGroup.idsRange(bot, start, end),
            StatGroup.idsRange(bot, prevStart, prevEnd),
            StatUser.countDistinctRange(bot, prevStart, prevEnd),
            StatGroup.countDistinctRange(bot, prevStart, prevEnd),
            StatUser.countDistinctRange(bot, lyStart, lyEnd),
            StatGroup.countDistinctRange(bot, lyStart, lyEnd),
            StatUser.sumMsgRange(bot, prevStart, prevEnd),
            StatUser.sumMsgRange(bot, lyStart, lyEnd),
        ])

    const userCount = Number(users) || 0
    const groupCount = Number(groups) || 0
    const prevUserCount = Number(prevUsers) || 0
    const prevGroupCount = Number(prevGroups) || 0
    const keepUsersN = intersectCount(curUids, prevUids)
    const keepGroupsN = intersectCount(curGids, prevGids)

    return {
        date: `${start} ~ ${end}`,
        start,
        end,
        days,
        users: userCount,
        newUsers: Math.max(0, userCount - keepUsersN),
        keepUsers: keepUsersN,
        lostUsers: Math.max(0, prevUserCount - keepUsersN),
        groups: groupCount,
        newGroups: Math.max(0, groupCount - keepGroupsN),
        keepGroups: keepGroupsN,
        lostGroups: Math.max(0, prevGroupCount - keepGroupsN),
        messages: Number(messages) || 0,
        events,
        usersQoQ: growth(userCount, prevUserCount),
        usersYoY: growth(userCount, Number(lyUsers) || 0),
        groupsQoQ: growth(groupCount, prevGroupCount),
        groupsYoY: growth(groupCount, Number(lyGroups) || 0),
        messagesQoQ: growth(Number(messages) || 0, Number(prevMessages) || 0),
        messagesYoY: growth(Number(messages) || 0, Number(lyMessages) || 0),
    }
}

/**
 * 使用最多的人（某日）
 */
export async function getTopUsers(bot, date = dateStr(), limit = 10) {
    const rows = await StatUser.topByDate(bot, date, limit)
    return rows.map(r => ({ ...r, name: r.name || shortId(r.id), avatar: userAvatar(bot, r.id) }))
}

/**
 * 各群使用情况（某日，按群内使用人数降序）
 */
export async function getGroupStats(bot, date = dateStr(), limit = 20) {
    const [groups, userCounts] = await Promise.all([
        StatGroup.listByDate(bot, date),
        StatGroupUser.countByGroups(bot, date),
    ])

    const rows = groups.map(g => ({
        id: g.id,
        name: g.name || shortId(g.id),
        users: userCounts.get(g.id) || 0,
        messages: g.messages,
    }))
    rows.sort((a, b) => b.users - a.users || b.messages - a.messages)
    return limit ? rows.slice(0, limit) : rows
}

/** 区间版：使用最多的人 */
export async function getTopUsersRange(bot, range, limit = 10) {
    const rows = await StatUser.topRange(bot, range.start, range.end, limit)
    return rows.map(r => ({ ...r, name: r.name || shortId(r.id), avatar: userAvatar(bot, r.id) }))
}

/** 区间版：各群使用情况 */
export async function getGroupStatsRange(bot, range, limit = 20) {
    const [groups, userCounts] = await Promise.all([
        StatGroup.listRange(bot, range.start, range.end),
        StatGroupUser.countByGroupsRange(bot, range.start, range.end),
    ])

    const rows = groups.map(g => ({
        id: g.id,
        name: g.name || shortId(g.id),
        users: userCounts.get(g.id) || 0,
        messages: g.messages,
    }))
    rows.sort((a, b) => b.users - a.users || b.messages - a.messages)
    return limit ? rows.slice(0, limit) : rows
}

/** 最近 n 天趋势（正序，最后一项为 date 当天） */
export async function getTrend(bot, date = dateStr(), days = 7) {
    const start = shiftDate(date, -(days - 1))

    const [uAgg, gAgg, eMap] = await Promise.all([
        StatUser.dailyAgg(bot, start, date),
        StatGroup.dailyAgg(bot, start, date),
        StatEvent.listRange(bot, start, date),
    ])

    const list = []
    for (let i = days - 1; i >= 0; i--) {
        const d = shiftDate(date, -i)
        const u = uAgg.get(d) || { users: 0, messages: 0 }
        const e = eMap.get(d) || { join: 0, kick: 0, fadd: 0, fdel: 0 }
        list.push({
            date: d,
            users: u.users,
            groups: gAgg.get(d) || 0,
            messages: u.messages,
            join: e.join,
            kick: e.kick,
            fadd: e.fadd,
            fdel: e.fdel,
        })
    }
    return list
}

/** 某月内每日趋势（正序，覆盖整月每一天） */
export async function getMonthTrend(bot, month = dateStr().slice(0, 7)) {
    const [y, m] = String(month).split("-").map(Number)
    const r = monthRange(y, m)

    const [uAgg, gAgg, eMap] = await Promise.all([
        StatUser.dailyAgg(bot, r.start, r.end),
        StatGroup.dailyAgg(bot, r.start, r.end),
        StatEvent.listRange(bot, r.start, r.end),
    ])

    const list = []
    for (let i = 1; i <= r.days; i++) {
        const d = `${r.year}-${String(r.month).padStart(2, "0")}-${String(i).padStart(2, "0")}`
        const u = uAgg.get(d) || { users: 0, messages: 0 }
        const e = eMap.get(d) || { join: 0, kick: 0, fadd: 0, fdel: 0 }
        list.push({
            date: d,
            users: u.users,
            groups: gAgg.get(d) || 0,
            messages: u.messages,
            join: e.join,
            kick: e.kick,
            fadd: e.fadd,
            fdel: e.fdel,
        })
    }
    return list
}

/**
 * 汇总（供指令与 Web 页面共用）
 * @param {string} bot   botQQ
 * @param {string} date  日视图传 YYYY-MM-DD，月视图传 YYYY-MM
 * @param {number} days  日视图趋势天数（月视图忽略）
 * @param {number} topN  排行榜条数
 * @param {string} mode  "day"（默认） | "month"
 */
export async function getSummary(bot, date = dateStr(), days = 7, topN = 10, mode = "day") {
    if (mode === "range") {
        const range = { start: shiftDate(date, -(days - 1)), end: date }
        const [daily, trend, topUsers, groupStats] = await Promise.all([
            getRange(bot, date, days),
            getTrend(bot, date, days),
            getTopUsersRange(bot, range, topN),
            getGroupStatsRange(bot, range, 10),
        ])
        return { bot: String(bot), date: daily.date, mode: "range", days, daily, trend, topUsers, groupStats }
    }

    if (mode === "month") {
        const month = String(date).slice(0, 7)
        const [y, m] = month.split("-").map(Number)
        const range = monthRange(y, m)
        const [daily, trend, topUsers, groupStats] = await Promise.all([
            getMonthly(bot, month),
            getMonthTrend(bot, month),
            getTopUsersRange(bot, range, topN),
            getGroupStatsRange(bot, range, 10),
        ])
        return { bot: String(bot), date: month, mode: "month", daily, trend, topUsers, groupStats }
    }

    const [daily, trend, topUsers, groupStats] = await Promise.all([
        getDaily(bot, date),
        getTrend(bot, date, days),
        getTopUsers(bot, date, topN),
        getGroupStats(bot, date, 10),
    ])
    return { bot: String(bot), date, mode: "day", daily, trend, topUsers, groupStats }
}

/** 清空某 bot 的全部统计数据 */
export async function clearStat(bot) {
    const [a, b, c, d] = await Promise.all([
        StatUser.clearByBot(bot),
        StatGroup.clearByBot(bot),
        StatGroupUser.clearByBot(bot),
        StatEvent.clearByBot(bot),
    ])
    guCache.clear()
    return Number(a) + Number(b) + Number(c) + Number(d)
}

/** 清理超过保留天数的统计数据 */
export async function cleanExpired(keepDays = KEEP_DAYS) {
    const cutoff = shiftDate(dateStr(), -keepDays)
    await Promise.all([
        StatUser.cleanExpired(cutoff),
        StatGroup.cleanExpired(cutoff),
        StatGroupUser.cleanExpired(cutoff),
        StatEvent.cleanExpired(cutoff),
    ])
    guCache.clear()
}

/** 短 id：取出自身 openid 部分并脱敏，用于无昵称时的展示 */
export function shortId(id) {
    const raw = String(id).split(":").pop() || String(id)
    if (raw.length <= 12) return raw
    return `${raw.slice(0, 6)}***${raw.slice(-4)}`
}
