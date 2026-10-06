// QQBot 适配器共享上下文：配置单例、字段黑名单、sharp、package 信息等
// 由各 adapter 子模块与 apps 命令模块共享，确保拿到的 config 是同一实例
import makeConfig from "../../../lib/plugins/config.js"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "url"

export const { config, configSave } = await makeConfig("QQBot", {
    tips: "",
    permission: "master",
    toQRCode: true,
    toCallback: true,
    toBotUpload: true,
    hideGuildRecall: false,
    imageLength: 3,
    stream: false,
    smallbtn: false,
    fakemsg: true,
    chunkSize: 2,
    delay: 100,
    filter_bot_msg: false,
    filter_only_at_other_bot: false,
    // 使用统计总开关：默认关闭，关闭时不记录数据、不注册展示页
    stat: false,
    rawButton: {},
    markdown: {},
    template: {},
    bot: {
        newapi: true,
        internal: false,
        region: "ap-guangzhou",
        concurrency: 1,
        sandbox: false,
        maxRetry: Infinity,
        timeout: 30000,
    },
    token: [],
    bot_openid: {}
}, {
    tips: [
        "欢迎使用 TRSS-Yunzai QQBot Plugin自用改版 ! 作者：windtrace",
        "参考：https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin",
        "bot中的newapi为新版api，internal为分片内网上传开关，region为腾讯云cos地域，concurrency为分片上传并发数量，sandbox为沙箱环境，maxRetry为最大重试次数，timeout为超时时间",
        "如果一直提示put超时可将concurrency调低，最低1，如果是腾讯云服务器可以将internal设置为true，并将region设置为服务器所在地域对应cos的region，然后将concurrency设置为20",
    ],
})

// ===== 旧配置自动迁移 =====
// 1) token：旧格式为 "QQ:appid:token:secret:isPrivate:isGroup" 字符串数组，
//    新版改为对象数组 { QQ, appid, secret, private, group, webhook? }
// 2) markdown.template 子键迁移到顶层 template，与 markdown 同级
{
    let dirty = false
    if (Array.isArray(config.token) && config.token.length && typeof config.token[0] === "string") {
        config.token = config.token.map(s => {
            // 旧格式：QQ:appid:token:secret:群权限:私域权限
            // 群权限位为 "2" 表示 webhook 模式（此时不写 private/group）
            const [QQ, appid, , secret, groupFlag, privateFlag] = s.split(":")
            const webhook = groupFlag === "2"
            const o = {
                QQ: Number(QQ),
                appid,
                secret,
                webhook,
            }
            // 仅非 webhook 模式保留群事件与频道私域权限字段
            if (!webhook) {
                o.group = Number(groupFlag) === 1
                o.private = Number(privateFlag) === 1
            }
            return o
        })
        dirty = true
    }
    if (config.markdown && typeof config.markdown.template === "object" && config.markdown.template !== null) {
        config.template = Object.assign({}, config.template, config.markdown.template)
        delete config.markdown.template
        dirty = true
    }
    if (dirty) await configSave()
}

// 字段黑名单：过滤事件 ext 中的危险字段（与用户/群黑名单无关）
export const blacklist = new Set([
    "event_id", "raw", "raw_event", "bot", "self_id",
    "post_type", "message_type", "sub_type", "message_id", "unionid",
    "openid", "user_id", "nickname", "avatar", "message", "raw_message",
    "time", "sender", "group_id", "group_data", "group_name",
    "msg_elements", "reply_user", "mentions", "at", "atall", "atme", "atBot",
    "bot_openid", "getBotInfo", "platform", "reply", "getGenerateUrl",
    "adapter_id", "adapter_name", "msg", "logText", "isGroup", "isPrivate", "recall",
    "isMaster", "only_reply_at", "runtime", "logFnc"
])

// sharp 动态导入（图片压缩，可选）
export let sharp
if (config.imageLength) try {
    sharp = (await import("sharp")).default
} catch (err) {
    Bot.makeLog("error", ["sharp 导入错误，图片压缩关闭", err], "QQBot-Plugin")
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const rootDir = path.resolve(__dirname, "..")
export const pkg = JSON.parse(await fs.readFile(rootDir + "/package.json"))

// 列表展示上限
export const MAX = 100

// 暴露配置给 webadapter 操作模块，使其可在 Web 控制台读写（与 master 配置同一实例）
Bot.QQBotConfig = { config, configSave }
