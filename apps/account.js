// QQBot 账号 / 模板 / 绑定 / 切换 API 设置命令
import { config, configSave } from "../adapter/context.js"
import { adapter } from "../adapter/adapter.js"
import { cleanupMediaFiles } from "../lib/media.js"

export class QQBotAccount extends plugin {
    constructor() {
        super({
            name: "QQBot账号管理",
            dsc: "QQBot 账号 / 模板 / 绑定 / 切换 API 设置",
            event: "message",
            task: { name: "QQBot媒体文件清理", cron: "0 3 * * *", fnc: () => cleanupMediaFiles() },
            rule: [
                {
                    reg: "^#[Qq]+[Bb]ot账号$",
                    fnc: "List",
                    permission: config.permission,
                },
                {
                    reg: "^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?\\d+:([^:]+(:.+)?)",
                    fnc: "Markdown",
                    permission: config.permission,
                },
                {
                    reg: "^#[Qq]+[Bb]ot绑定用户.+$",
                    fnc: "BindUser",
                },
                {
                    reg: "^#[Qq]+[Bb]ot(确认)?切换api$",
                    fnc: "turn_api",
                    permission: "master",
                }
            ]
        })
    }

    async turn_api(e) {
        if (config.bot.sandbox) return this.reply("当前为沙箱环境，无法切换api")
        if (e.msg.includes("确认")) {
            switch (e.bot.sdk.request.defaults.baseURL) {
                case "https://api.sgroup.qq.com": {
                    config.bot.newapi = true
                    await configSave()
                    break;
                }
                case "https://api.bot.qq.com": {
                    config.bot.newapi = false
                    await configSave()
                    break;
                }
                default: {
                    return this.reply(["api切换失败，请重启机器人再做尝试", segment.button([{ text: "#重启", callback: "#重启", content: "是否确认重启" }])])
                }
            }
            this.reply("api切换成功,请等待重启")
            return await Bot.restart()
        } else {
            switch (e.bot.sdk.request.defaults.baseURL) {
                case "https://api.sgroup.qq.com": {
                    if (config.bot.newapi) return this.reply(["当前为旧api环境`https://api.sgroup.qq.com`，但未机器人设置尚未切换，仅需手动重启即可，若是**确认切换api**，将会将设置切换到使用旧的api", segment.button([{ text: "确认切换api", callback: "#QQBot确认切换api" }], [{ text: "#重启", callback: "#重启", content: "是否确认重启" }])])
                    else return this.reply(["当前为旧api环境`https://api.sgroup.qq.com`，是否确认**确认切换api**至新api", segment.button([{ text: "确认切换api", callback: "#QQBot确认切换api" }])])
                }
                case "https://api.bot.qq.com": {
                    if (!config.bot.newapi) return this.reply(["当前为新api环境`https://api.bot.qq.com`，但未机器人设置尚未切换，仅需手动重启即可，若是**确认切换api**，将会将设置切换到使用新的api", segment.button([{ text: "确认切换api", callback: "#QQBot确认切换api" }], [{ text: "#重启", callback: "#重启", content: "是否确认重启" }])])
                    else return this.reply(["当前为新api环境`https://api.bot.qq.com`，是否确认**确认切换api**至旧api", segment.button([{ text: "确认切换api", callback: "#QQBot确认切换api" }])])
                }
                default: {
                    return this.reply(["api切换失败，请重启机器人再做尝试", segment.button([{ text: "#重启", callback: "#重启", content: "是否确认重启" }])])
                }
            }
        }

    }
    List() {
        const list = config.token.map((b, i) =>
            `${i + 1}. QQ:${b.QQ} appid:${b.appid} 私域:${b.private ? "是" : "否"} 群聊:${b.group ? "是" : "否"}${b.webhook ? " [webhook]" : ""}`
        ).join("\n")
        this.reply(`共${config.token.length}个账号：\n${list}`, true)
    }

    async Markdown() {
        let token = this.e.msg.replace(/^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?/, "").trim().split(":")
        if (token.length < 2) return this.reply("添加错误,格式如下\r#QQBotMD机器人qq号:模板id(原生就填raw,普通就填legacy):模板参数内容(每个参数用,隔开)\r例:#QQBotMD285888888:1909831031_980983013:text0,text1,text2...,原生则为#QQBotMD285888888:raw,普通则为#QQBotMD285888888:legacy")
        const bot_id = token[0]
        const templateid = token[1]
        if (token.length !== 3 && templateid !== "raw" && templateid !== "legacy") return this.reply("添加错误,格式如下\r#QQBotMD机器人qq号:模板id(原生就填raw):模板参数内容(每个参数用,隔开)\r例:#QQBotMD285888888:1909831031_980983013:text0,text1,text2...,原生则为#QQBotMD285888888:raw,普通则为#QQBotMD285888888:legacy")
        let template = token[2] || ""
        template = template.replace(" ", "").split(/[,，]/)
        this.reply(`Bot ${bot_id} Markdown 模板已设置为 ${templateid}\r内容为 [${template.join(",")}]`, true)
        config.markdown[bot_id] = templateid
        if (templateid !== "raw" && templateid !== "legacy") config.template[bot_id] = template
        await configSave()
    }

    BindUser() {
        const id = this.e.msg.replace(/^#[Qq]+[Bb]ot绑定用户(确认)?/, "").trim()
        if (id === this.e.user_id)
            return this.reply("请切换到对应Bot")

        adapter.bind_user[this.e.user_id] = id
        this.reply([
            `绑定 ${id} → ${this.e.user_id}`,
            segment.button([{
                text: "确认绑定",
                callback: `#QQBot绑定用户确认${this.e.user_id}`,
                permission: this.e.user_id,
            }])
        ])
    }
}
