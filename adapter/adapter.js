// QQBot 适配器主类：组合各方法模块，导出单例 adapter
import { config, pkg } from "./context.js"
import { buildMethods } from "./build.js"
import { sendMethods } from "./send.js"
import { pickMethods } from "./pick.js"
import { messageMethods } from "./message.js"
import { connectMethods } from "./connect.js"

class QQBotAdapter {
    constructor() {
        this.id = "QQBot"
        this.name = "QQBot"
        this.path = "data/QQBot/"
        this.version = `@windtrace/qq-group-bot v${pkg.dependencies["@windtrace/qq-group-bot"]}`

        this.sep = ":"
        this.bind_user = {}
        this.appid = {}
        this.config = config
    }
}

// 将各模块导出的方法集合注入到原型，等价于原本写在类体内的方法
Object.assign(
    QQBotAdapter.prototype,
    buildMethods,
    sendMethods,
    pickMethods,
    messageMethods,
    connectMethods,
)

export const adapter = new QQBotAdapter()

// 标准化头像获取全局入口：插件可直接 Bot.getAvatarUrl(self_id, user_id, size)。
// QQBot 平台用户无QQ号只有OpenID，走适配器的 qqapp 头像接口；其他平台回退 qlogo
if (typeof Bot.getAvatarUrl !== "function") {
    Bot.getAvatarUrl = (self_id, user_id, size = 100) => {
        if (Bot[self_id]?.adapter === adapter)
            return adapter.getAvatarUrl(self_id, user_id, size)
        user_id = String(user_id ?? "")
        const id = self_id ? user_id.replace(`${self_id}:`, "") : user_id
        return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=${size}`
    }
}
