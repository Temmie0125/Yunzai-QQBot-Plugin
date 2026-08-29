// QQBot 交互式设置命令（使用 Yunzai 上下文连接器）
// 触发：#[Qq]+[Bb]ot设置 （如 #QQBot设置 / #QqBot设置）
// 通过上下文逐步引导：appid → (自动获取/手动输入)QQ → secret → webhook → (非 webhook) 公私域 / 群事件
// 中途发送「取消」可随时退出；连接成功才写入配置
import { config, configSave } from "../adapter/context.js"
import { adapter } from "../adapter/adapter.js"
import { _qrGetRobotUin } from "../adapter/qr.js"

export class QQBotAppSet extends plugin {
    constructor() {
        super({
            name: "QQBot交互设置",
            dsc: "通过上下文交互引导式设置 QQBot（appid/secret/webhook/公私域/群事件）",
            event: "message",
            rule: [
                {
                    reg: "^#[Qq]+[Bb]ot设置$",
                    fnc: "interactiveSet",
                    permission: config.permission,
                },
            ],
        })
    }

    // 通用问答：返回用户输入字符串；超时 / 取消返回 null；validate 失败则重新提问
    // validate(s) 返回 true 表示通过，返回字符串表示错误提示
    async ask(prompt, validate) {
        while (true) {
            await this.reply(prompt)
            const e2 = await this.awaitContext()
            if (!e2) {
                await this.reply("操作超时已取消")
                return null
            }
            const s = (e2.msg || "").trim()
            if (s === "取消") {
                await this.reply("已取消设置")
                return null
            }
            if (typeof validate === "function") {
                const err = validate(s)
                if (err !== true) {
                    await this.reply(err)
                    continue
                }
            }
            return s
        }
    }

    async interactiveSet() {
        // 1. AppID
        const appid = await this.ask(
            "请输入 AppID：\r>可发送`取消`以取消设置",
            s => (/^\d+$/.test(s) ? true : "AppID 必须为数字，请重新输入（或发送 取消）："),
        )
        if (appid == null) return

        // 2. 尝试通过 AppID 获取 QQ
        let uin = null
        const gotQQ = await _qrGetRobotUin(appid).catch(() => null)
        if (gotQQ) {
            uin = String(gotQQ)
            await this.reply(`已通过 AppID 获取 QQ：${uin}`)
        } else {
            const qq = await this.ask(
                "未能通过 AppID 获取 QQ，请输入机器人的 QQ 号：\r>可发送`取消`以取消设置",
                s => (/^\d+$/.test(s) ? true : "QQ 号必须为数字，请重新输入（或发送 取消）："),
            )
            if (qq == null) return
            uin = qq
        }

        // 3. Secret
        const secret = await this.ask("请输入 Secret：")
        if (secret == null) return

        // 4. Webhook 模式
        const wh = await this.ask(
            "是否使用 Webhook 模式？请填入 是 或 否：\r>可发送`取消`以取消设置",
            s => (s === "是" || s === "否" ? true : "请输入 是 或 否（或发送 取消）："),
        )
        if (wh == null) return
        const webhook = wh === "是"

        // Webhook 模式无需设置公私域与群事件
        let privateDomain = false
        let groupEvent = false
        if (!webhook) {
            const pd = await this.ask(
                "是否私域（公私域）？请填入 是 或 否：\r>可发送`取消`以取消设置",
                s => (s === "是" || s === "否" ? true : "请输入 是 或 否（或发送 取消）："),
            )
            if (pd == null) return
            privateDomain = pd === "是"

            const ge = await this.ask(
                "是否开启群事件？请填入 是 或 否：\r>可发送`取消`以取消设置",
                s => (s === "是" || s === "否" ? true : "请输入 是 或 否（或发送 取消）："),
            )
            if (ge == null) return
            groupEvent = ge === "是"
        }

        const botObj = {
            QQ: uin,
            appid,
            secret,
            webhook,
        }
        // Webhook 模式无需公私域与群事件字段，避免误导
        if (!webhook) {
            botObj.private = privateDomain
            botObj.group = groupEvent
        }

        await this.reply("正在连接并验证配置，请稍候...")
        const ok = await this.connectAndSave(botObj)
        if (ok) {
            await this.reply(`QQBot ${uin} 设置成功并已连接`)
        } else {
            await this.reply("连接失败，未保存配置，请检查 AppID / Secret 是否正确")
        }
    }

    // 连接成功后写入 config.token（bot 对象格式，与 QQBot-Plugin 的 connect 一致）
    async connectAndSave(botObj) {
        const uinStr = String(botObj.QQ)
        try {
            if (!Array.isArray(config.token)) config.token = []

            if (Bot[uinStr] && Bot[uinStr].sdk?.config) {
                // 已有实例：热重启（避免重建 Bot[id] 导致 LevelDB 文件锁冲突）
                try { Bot[uinStr].sdk.stop() } catch {}
                await new Promise(r => setTimeout(r, 500))
                Bot[uinStr].sdk.config.secret = botObj.secret
                Bot[uinStr].info.secret = botObj.secret
                const sm = Bot[uinStr].sdk.sessionManager
                if (sm) {
                    sm.tokenTask = null
                    if (sm.tokenTimer) { clearTimeout(sm.tokenTimer); sm.tokenTimer = null }
                    sm.wsUrl = null
                    sm.access_token = null
                    sm.fatalError = false
                    sm.userClose = false
                    sm.retry = 0
                    await sm.start()
                }
            } else {
                const connected = await adapter.connect(botObj)
                if (!connected) return false
                await new Promise(r => setTimeout(r, 1000))
            }

            // 连接成功后再保存配置
            const idx = config.token.findIndex(t => String(t.QQ) === uinStr)
            if (idx >= 0) config.token[idx] = botObj
            else config.token.push(botObj)
            await configSave()
            return true
        } catch (err) {
            logger.error(`[QQBot] 交互式设置连接失败: ${err?.stack || err}`)
            return false
        }
    }
}
