// QQBot 用户 / 群聊黑名单命令
import { blacklistUser, unblacklistUser, blacklistGroup, unblacklistGroup, extractOpenid } from "../lib/blacklist.js"

export class QQBotBlacklist extends plugin {
    constructor() {
        super({
            name: "QQBot黑名单",
            dsc: "QQBot 拉黑 / 取消拉黑 用户与群聊",
            event: "message",
            rule: [
                {
                    reg: "^#拉黑用户",
                    fnc: "cmdBlacklistUser",
                    permission: "master",
                },
                {
                    reg: "^#取消拉黑用户",
                    fnc: "cmdUnblacklistUser",
                    permission: "master",
                },
                {
                    reg: "^#拉黑群聊",
                    fnc: "cmdBlacklistGroup",
                    permission: "master",
                },
                {
                    reg: "^#取消拉黑群聊",
                    fnc: "cmdUnblacklistGroup",
                    permission: "master",
                }
            ]
        })
    }

    async cmdBlacklistUser(e) {
        if (e.adapter_id !== "QQBot") return
        let targetOpenid = ""
        if (e.at && e.at !== e.atBot && !e.msg.includes("@all")) {
            targetOpenid = extractOpenid(e.at)
        } else {
            const raw = e.msg.replace(/^#拉黑用户\s*/, "").trim()
            if (raw) targetOpenid = extractOpenid(raw)
        }
        if (!targetOpenid) return this.reply("请 @要拉黑的用户 或 输入用户 openid")
        let targetUnionid = ""
        if (e.self_id) {
            const bot = Bot[e.self_id]
            const user = bot?.fl?.get(`${e.self_id}${this.sep}${targetOpenid}`) || bot?.fl?.get(targetOpenid) || bot?.users?.get(`${e.self_id}${this.sep}${targetOpenid}`)
            if (user?.unionid) targetUnionid = user.unionid
        }
        await blacklistUser(`${e.self_id}${this.sep}${targetOpenid}`, targetUnionid)
        this.reply(`已拉黑用户 openid=${targetOpenid}${targetUnionid ? ` unionid=${targetUnionid}` : ""}`)
    }

    async cmdUnblacklistUser(e) {
        if (e.adapter_id !== "QQBot") return
        let targetOpenid = ""
        if (e.at && e.at !== e.atBot && !e.msg.includes("@all")) {
            targetOpenid = extractOpenid(e.at)
        } else {
            const raw = e.msg.replace(/^#取消拉黑用户\s*/, "").trim()
            if (raw) targetOpenid = extractOpenid(raw)
        }
        if (!targetOpenid) return this.reply("请 @要取消拉黑的用户 或 输入用户 openid")
        let targetUnionid = ""
        if (e.self_id) {
            const bot = Bot[e.self_id]
            const user = bot?.fl?.get(`${e.self_id}${this.sep}${targetOpenid}`) || bot?.fl?.get(targetOpenid) || bot?.users?.get(`${e.self_id}${this.sep}${targetOpenid}`)
            if (user?.unionid) targetUnionid = user.unionid
        }
        await unblacklistUser(`${e.self_id}${this.sep}${targetOpenid}`, targetUnionid)
        this.reply(`已取消拉黑用户 openid=${targetOpenid}`)
    }

    async cmdBlacklistGroup(e) {
        if (e.adapter_id !== "QQBot") return
        const raw = e.msg.replace(/^#拉黑群聊\s*/, "").trim()
        let gid = raw || e.group_id
        if (!gid) return this.reply("请在群聊中使用，或输入群 group_id")
        if (e.self_id && !gid.startsWith(`${e.self_id}${this.sep}`)) {
            gid = `${e.self_id}${this.sep}${gid}`
        }
        await blacklistGroup(gid)
        this.reply(`已拉黑群聊 ${gid}`)
    }

    async cmdUnblacklistGroup(e) {
        if (e.adapter_id !== "QQBot") return
        const raw = e.msg.replace(/^#取消拉黑群聊\s*/, "").trim()
        let gid = raw || e.group_id
        if (!gid) return this.reply("请在群聊中使用，或输入群 group_id")
        if (e.self_id && !gid.startsWith(`${e.self_id}${this.sep}`)) {
            gid = `${e.self_id}${this.sep}${gid}`
        }
        await unblacklistGroup(gid)
        this.reply(`已取消拉黑群聊 ${gid}`)
    }
}
