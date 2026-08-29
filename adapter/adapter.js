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
