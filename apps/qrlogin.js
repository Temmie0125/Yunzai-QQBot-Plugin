// QQBot 扫码登录 / 关闭推送用户 命令
import { config, configSave, MAX } from "../adapter/context.js"
import { adapter } from "../adapter/adapter.js"
import { _qrCreateBindTask, _qrPollBindResult, _qrDecryptSecret, _qrGetRobotUin, QR_URL_TPL } from "../adapter/qr.js"

export class QQBotQrLogin extends plugin {
    constructor() {
        super({
            name: "QQBot扫码登录",
            dsc: "QQBot 扫码登录 / 关闭推送用户列表",
            event: "message",
            rule: [
                {
                    reg: "^#QQBot(扫码)?登录$",
                    fnc: "qrlogin",
                    permission: "master",
                },
                {
                    reg: "^#关闭推送用户(列表)?$",
                    fnc: "disablepushusers",
                    permission: "master",
                }
            ]
        })
    }

    formatUserList(set, max = MAX) {
        const list = Array.from(set)
        const total = list.length

        if (total <= max) {
            return {
                text: list.map(item => item.slice(11, 16) + "***" + item.slice(-5)).join("\r"),
                total
            }
        }

        return {
            text: list.map(item => item.slice(11, 16) + "***" + item.slice(-5)).slice(0, max).join("\r"),
            total
        }
    }

    async disablepushusers(e) {
        if (e.adapter_id !== "QQBot") return true
        const users = Bot.disablePushUsers.get(e.self_id) || new Set()
        if (!users.size) {
            return this.reply("当前机器人暂无关闭推送的用户")
        }
        const { text, total } = this.formatUserList(users, MAX)
        return this.reply(
            `***${Bot[selfId].nickname}***：共\`${total}个\`关闭推送的用户\r` +
            (total > 100 ? "（仅展示前 100 个）" : "") +
            `\r\`\`\`users\r${text}\r\`\`\``
        )
    }

    // ====== QR 扫码登录 ======
    async qrlogin(e) {
        if (this._qrLoginRunning) {
            return e.reply("已有扫码登录任务正在进行中，请等待完成后再试")
        }
        this._qrLoginRunning = true

        try {
            await e.reply("正在生成二维码，请稍候...")

            const { taskId, key } = await _qrCreateBindTask()
            const qrUrl = QR_URL_TPL.replace("{task_id}", taskId)

            await e.reply([
                "请使用手机 QQ 扫码或打开链接：\r",
                segment.image(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`),
                `\r链接：${qrUrl}\r>注意:使用此方法登录QQBot会自动刷新Secret，请自行留意。`,
            ])

            const bindData = await _qrPollBindResult(taskId)
            if (!bindData) {
                return e.reply("二维码已过期，请重新发起 #QQBot扫码登录")
            }

            const secret = _qrDecryptSecret(bindData.bot_encrypt_secret, key)
            const uin = await _qrGetRobotUin(bindData.bot_appid)
            if (!uin) {
                return e.reply("获取机器人 uin 失败，请检查 BKN 是否有效")
            }

            await this._saveAndConnectBot(uin, bindData.bot_appid, secret)

            return e.reply(
                [
                    "#QQBot 登录成功",
                    `UIN: ${uin}`,
                    `AppID: ${bindData.bot_appid}`,
                    `Secret: 详情见 QQBot 配置`,
                ].join("\n")
            )
        } finally {
            this._qrLoginRunning = false
        }
    }

    async _saveAndConnectBot(uin, appId, secret) {
        const uinStr = String(uin)
        const botObj = { QQ: uin, appid: appId, secret, webhook: false, private: true, group: false }

        // 更新或新增 config.token
        const idx = config.token.findIndex(t => String(t.QQ) === uinStr)
        if (idx >= 0) {
            config.token[idx] = botObj
        } else {
            config.token.push(botObj)
        }
        await configSave()

        // 热加载 Bot 实例
        if (Bot[uinStr] && Bot[uinStr].sdk?.config) {
            // 已有实例：停止旧连接，用新 secret 重新连接
            try { Bot[uinStr].sdk.stop() } catch {}
            await new Promise(r => setTimeout(r, 500))
            Bot[uinStr].sdk.config.secret = secret
            Bot[uinStr].info.secret = secret
            const sm = Bot[uinStr].sdk.sessionManager
            if (sm) {
                sm.tokenTask = null
                if (sm.tokenTimer) {
                    clearTimeout(sm.tokenTimer)
                    sm.tokenTimer = null
                }
                sm.wsUrl = null
                sm.access_token = null
                sm.fatalError = false
                sm.tokenExpired = false
                sm.userClose = false
                sm.retry = 0
                await sm.start()
            }
        } else {
            await adapter.connect(botObj)
            await new Promise(r => setTimeout(r, 1000))
        }
    }
}
