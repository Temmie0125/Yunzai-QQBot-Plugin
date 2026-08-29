// QQBot 消息过滤 / rawButton 设置命令
import { config, configSave } from "../adapter/context.js"

export class QQBotFilter extends plugin {
    constructor() {
        super({
            name: "QQBot过滤设置",
            dsc: "QQBot 消息过滤 / rawButton 开关",
            event: "message",
            rule: [
                {
                    reg: "^#(开启|关闭)野收官发$",
                    fnc: "turn_fakemsg",
                    permission: config.permission,
                },
                {
                    reg: "^#(开启|关闭)([Bb][Oo][Tt]|机器人)(消息)?过滤$",
                    fnc: "turn_filter_bot",
                    permission: config.permission,
                },
                {
                    reg: "^#(开启|关闭)纯(艾特|[Aa][Tt])其他([Bb][Oo][Tt]|机器人)过滤$",
                    fnc: "turn_filter_onlyother_bot",
                    permission: config.permission,
                },
                {
                    reg: "^#[Rr][Aa][Ww][Bb][Uu][Tt][Tt][Oo][Nn]\\d+(?::(true|false))?$",
                    fnc: "rawButton",
                    permission: config.permission,
                }
            ]
        })
    }

    async turn_filter_onlyother_bot(e) {
        if (e.msg.includes("开启")) {
            config.filter_only_at_other_bot = true
            await configSave()
            return this.reply("开启纯艾特其他bot消息过滤成功")
        }
        if (e.msg.includes("关闭")) {
            config.filter_only_at_other_bot = false
            await configSave()
            return this.reply("关闭纯艾特其他bot消息过滤成功")
        }
        return this.reply("修改失败")
    }
    async turn_filter_bot(e) {
        if (e.msg.includes("开启")) {
            config.filter_bot_msg = true
            await configSave()
            return this.reply("开启bot消息过滤成功")
        }
        if (e.msg.includes("关闭")) {
            config.filter_bot_msg = false
            await configSave()
            return this.reply("关闭bot消息过滤成功")
        }
        return this.reply("修改失败")
    }

    async turn_fakemsg(e) {
        if (e.msg.includes("开启")) {
            config.fakemsg = true
            await configSave()
            return this.reply("开启野收官发成功")
        }
        if (e.msg.includes("关闭")) {
            config.fakemsg = false
            await configSave()
            return this.reply("关闭野收官发成功")
        }
        return this.reply("修改失败")
    }

    async rawButton() {
        const token = this.e.msg.replace(/^#rawButton/, "").trim()
        const bot_id = token.split(":")[0]
        if (!bot_id) return this.reply("请输入正确的指令\r例#rawButton285888888:true,#rawButton285888888:false")
        if (token[1] && token[1] === "false") {
            config.rawButton[bot_id] = false
            await configSave()
            return this.reply(`设置成功${bot_id}的rawButton为false`)
        }
        config.rawButton[bot_id] = true
        await configSave()
        return this.reply(`设置成功${bot_id}的rawButton为true`)
    }
}
