// QQBot 使用统计指令：获取当前机器人的统计数据并渲染成图片输出
// 触发：
//   #QQBot统计     近七天汇总（可加天数：#QQBot统计 30天；可指定截止日：#QQBot统计 2026-08-15）
//   #QQBot月统计   本月汇总（可指定月份：#QQBot月统计 2026-08）
import { config } from "../adapter/context.js"
import { getSummary, dateStr, isStatBot } from "../lib/stat.js"
import puppeteer from "../../../lib/puppeteer/puppeteer.js"

const _path = process.cwd().replace(/\\/g, "/")

/** 增长率展示：null 表示上期为 0（本期为新增） */
function fmtRate(v) {
    if (v == null) return "新增"
    return `${v > 0 ? "+" : ""}${v}%`
}

/**
 * 折线图数据：预计算坐标与网格，供模板直接拼 SVG（避免在模板内做复杂运算）
 * 尺寸与模板可用宽度（900 - 左右内边距）对齐
 */
function buildLine(trend) {
    const W = 812, H = 170, padL = 36, padR = 14, padT = 18, padB = 28
    const iw = W - padL - padR, ih = H - padT - padB
    const max = Math.max(1, ...trend.map(t => t.messages))
    const step = trend.length > 1 ? iw / (trend.length - 1) : 0

    const items = trend.map((t, i) => ({
        md: String(t.date).slice(5),
        day: String(t.date).slice(8),
        messages: t.messages,
        x: Number((padL + (trend.length > 1 ? step * i : iw / 2)).toFixed(1)),
        y: Number((padT + ih - (t.messages / max) * ih).toFixed(1)),
    }))

    const grid = []
    for (let i = 0; i <= 4; i++) {
        grid.push({
            y: Number((padT + (ih / 4) * i).toFixed(1)),
            val: Math.round(max * (1 - i / 4)),
        })
    }

    return {
        w: W, h: H, padL, right: W - padR, items, grid,
        points: items.map(p => `${p.x},${p.y}`).join(" "),
    }
}

/**
 * 使用人数 / 使用群数 双折线图（与 Web 页面趋势图一致，两条线共用 Y 轴）
 * 点数较多（如整月 31 天）时不再逐点标注数值，避免文字重叠
 */
function buildTrend(trend) {
    const W = 812, H = 190, padL = 36, padR = 14, padT = 18, padB = 28
    const iw = W - padL - padR, ih = H - padT - padB
    const max = Math.max(1, ...trend.map(t => t.users), ...trend.map(t => t.groups))
    const step = trend.length > 1 ? iw / (trend.length - 1) : 0

    const items = trend.map((t, i) => ({
        md: String(t.date).slice(5),
        day: String(t.date).slice(8),
        users: t.users,
        groups: t.groups,
        x: Number((padL + (trend.length > 1 ? step * i : iw / 2)).toFixed(1)),
        yu: Number((padT + ih - (t.users / max) * ih).toFixed(1)),
        yg: Number((padT + ih - (t.groups / max) * ih).toFixed(1)),
    }))

    const grid = []
    for (let i = 0; i <= 4; i++) {
        grid.push({
            y: Number((padT + (ih / 4) * i).toFixed(1)),
            val: Math.round(max * (1 - i / 4)),
        })
    }

    return {
        w: W, h: H, padL, right: W - padR, items, grid,
        pointsU: items.map(p => `${p.x},${p.yu}`).join(" "),
        pointsG: items.map(p => `${p.x},${p.yg}`).join(" "),
        showLabels: items.length <= 10,
    }
}

export class QQBotStat extends plugin {
    constructor() {
        super({
            name: "QQBot数据统计",
            dsc: "查看当前 QQBot 的使用统计（#QQBot统计=近七天，#QQBot月统计=本月）",
            event: "message",
            rule: [
                // 月统计（放在前面优先匹配，避免被"统计"规则先命中）
                {
                    reg: "^#[Qq]+[Bb]ot月(统计|数据统计|数据)",
                    fnc: "statMonth",
                    permission: "master",
                },
                // 近七天统计
                {
                    reg: "^#[Qq]+[Bb]ot(数据|统计|数据统计)",
                    fnc: "statRange",
                    permission: "master",
                },
            ],
        })
    }

    /** 取出命令之后的参数部分 */
    arg() {
        return String(this.e.msg || "").replace(/^#[Qq]+[Bb]ot月?(统计|数据统计|数据)/, "").trim()
    }

    /**
     * 统计：概览为「当天」数据，下方趋势图默认展示近七天
     * 支持指定日期：#QQBot统计 2026-08-15；支持调整趋势天数：#QQBot统计 30天
     */
    async statRange() {
        const arg = this.arg()
        let days = 7
        let date = dateStr()

        const dm = arg.match(/(?:近)?(\d+)天/)
        if (dm) days = Math.min(Math.max(Number(dm[1]), 1), 90)

        const dd = arg.match(/(\d{4}-\d{2}-\d{2})/)
        if (dd) date = dd[1]

        return this.renderStat("day", date, days)
    }

    /** 本月汇总，可指定月份 */
    async statMonth() {
        const arg = this.arg()
        let date = dateStr().slice(0, 7)
        const mm = arg.match(/(\d{4}-\d{2})(?!-\d)/)
        if (mm) date = mm[1]
        return this.renderStat("month", date, 7)
    }

    async renderStat(mode, date, days) {
        if (!config.stat) {
            return this.reply("使用统计功能未开启，可在「QQBot 设置 - 基础设置」中开启「使用统计」（需重启后生效）")
        }

        const bot = String(this.e.self_id || "")
        if (!bot) return this.reply("无法获取当前机器人 QQ")
        if (!isStatBot(bot)) return this.reply("非QQBot不记录使用统计")

        let summary
        try {
            summary = await getSummary(bot, date, days, 10, mode)
        } catch (err) {
            logger.error(`[QQBot] 统计数据获取失败: ${err?.stack || err}`)
            return this.reply("统计数据获取失败，请查看日志")
        }

        const d = summary.daily
        const ev = d.events || {}
        const maxMsg = Math.max(1, ...summary.trend.map(t => t.messages))
        const isMonth = mode === "month"

        // 机器人昵称与头像（取法与 WebAdapter 的 getBots() 保持一致）
        const info = Bot[bot]?.info || {}
        const botName = info.username || info.nickname || Bot[bot]?.nickname || bot
        const botAvatar = String(info.avatar || "").replace(/^http:\/\//, "https://")
            || `https://q.qlogo.cn/g?b=qq&s=0&nk=${bot}`

        const data = {
            bot,
            botName,
            botAvatar,
            date: d.date,
            // 概览
            users: d.users,
            groups: d.groups,
            messages: d.messages,
            // 用户增减
            newUsers: d.newUsers,
            keepUsers: d.keepUsers,
            lostUsers: d.lostUsers,
            // 群增减
            newGroups: d.newGroups,
            keepGroups: d.keepGroups,
            lostGroups: d.lostGroups,
            // 事件
            join: ev.join || 0,
            kick: ev.kick || 0,
            fadd: ev.fadd || 0,
            fdel: ev.fdel || 0,
            // 派生指标（预计算，避免依赖模板内运算）
            netGroup: (ev.join || 0) - (ev.kick || 0),
            netFriend: (ev.fadd || 0) - (ev.fdel || 0),
            avgMsg: d.users ? Math.round(d.messages / d.users) : 0,
            // 环比 / 同比
            qoqUsers: fmtRate(d.usersQoQ),
            yoyUsers: fmtRate(d.usersYoY),
            qoqGroups: fmtRate(d.groupsQoQ),
            yoyGroups: fmtRate(d.groupsYoY),
            upUsers: d.usersQoQ == null || d.usersQoQ >= 0,
            upGroups: d.groupsQoQ == null || d.groupsQoQ >= 0,
            qoqMessages: fmtRate(d.messagesQoQ),
            yoyMessages: fmtRate(d.messagesYoY),
            upMessages: d.messagesQoQ == null || d.messagesQoQ >= 0,
            // 口径说明（随模式变化）
            periodNote: isMonth
                ? "环比=较上月，同比=较去年同月"
                : "环比=较昨日，同比=较上周同日",
            changeNote: isMonth
                ? "新增 = 上月未使用本月使用，减少 = 上月使用本月未使用"
                : "新增 = 昨日未使用今日使用，减少 = 昨日使用今日未使用",
            trendTitle: isMonth ? "本月每日消息数" : `近 ${days} 天每日消息数`,
            isMonth,
            // 柱状图数据（月视图使用）
            trend: summary.trend.map(t => ({
                date: t.date,
                md: String(t.date).slice(5),
                day: String(t.date).slice(8),
                users: t.users,
                groups: t.groups,
                messages: t.messages,
                pct: Math.max(1, Math.round((t.messages / maxMsg) * 100)),
            })),
            // 折线图数据（日视图使用）
            chart: isMonth ? null : buildLine(summary.trend),
            // 使用人数 / 使用群数趋势（两种视图都显示，与 Web 页面一致）
            trendChart: buildTrend(summary.trend),
            topUsers: summary.topUsers || [],
            groupStats: summary.groupStats || [],
        }

        const tplFile = `${_path}/plugins/QQBot-Plugin/resources/html/stat.html`
        let img
        try {
            img = await puppeteer.screenshot("QQBot-Plugin", {
                tplFile,
                ...data,
                saveId: `qqbot_stat_${bot}_${Date.now()}`,
            })
        } catch (err) {
            logger.error(`[QQBot] 统计图片渲染失败: ${err?.stack || err}`)
            return this.reply("图片渲染失败，请查看日志")
        }
        if (!img) return this.reply("图片生成失败")
        return this.reply(img)
    }
}
