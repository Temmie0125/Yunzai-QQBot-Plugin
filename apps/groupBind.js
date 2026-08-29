// QQBot 群号绑定命令
export class QQBotGroupBind extends plugin {
    constructor() {
        super({
            name: "QQBot群号绑定",
            dsc: "QQBot 当前群 ↔ QQ群号 绑定 / 解绑",
            event: "message",
            rule: [
                {
                    reg: "^#群号绑定\\d+",
                    fnc: "cmdBindGroupQQ",
                    permission: "master",
                },
                {
                    reg: "^#取消群号绑定$",
                    fnc: "cmdUnbindGroupQQ",
                    permission: "master",
                }
            ]
        })
    }

    async cmdBindGroupQQ(e) {
        if (e.adapter_id !== "QQBot" || !e.isGroup) return
        const groupQQ = e.msg.replace(/^#群号绑定/, "").trim()
        if (!/^\d{5,12}$/.test(groupQQ)) {
            return this.reply("请输入正确的QQ群号（5-12位数字）\n示例：#群号绑定123456789")
        }
        const gid = e.group_id
        const existing = await redis.hGet("wind-group-bind", gid)
        if (existing) {
            return this.reply(`当前群已绑定QQ群号：${existing}\n如需更改请先 #取消群号绑定`)
        }
        // 检查是否已被其他群绑定
        const allBinds = await redis.hGetAll("wind-group-bind")
        const conflictGid = Object.entries(allBinds).find(([, qq]) => qq === groupQQ)?.[0]
        if (conflictGid && conflictGid !== gid) {
            return this.reply(`QQ群号 ${groupQQ} 已被其他群(${conflictGid.slice(0, 11)}***)绑定，请检查群号是否正确`)
        }
        await redis.hSet("wind-group-bind", gid, groupQQ)
        this.reply(`已绑定：当前群 ↔ QQ群 ${groupQQ}`)
    }

    async cmdUnbindGroupQQ(e) {
        if (e.adapter_id !== "QQBot" || !e.isGroup) return
        const gid = e.group_id
        const existing = await redis.hGet("wind-group-bind", gid)
        if (!existing) return this.reply("当前群尚未绑定QQ群号")
        await redis.hDel("wind-group-bind", gid)
        this.reply(`已取消绑定：当前群 ↔ QQ群 ${existing}`)
    }
}
