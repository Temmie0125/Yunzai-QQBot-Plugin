// 发送 / 撤回消息方法
import { config } from "./context.js"
import { saveSentMessage } from "../lib/message.js"

export const sendMethods = {
    // QQ官方Bot群聊默认无主动消息权限，媒体/文件消息必须携带被动回复凭证(msg_id/event_id)。
    // sendFile 等通道不经过事件对象，这里回退使用该群/用户最近一条收到的消息作为被动回复锚点
    // （被动回复有效期5分钟，留30秒余量）
    fixPassiveSource(data, event, type, openid) {
        if (event?.id || event?.event_id) return event
        const anchor = data.bot?._passiveAnchor?.[`${type}:${openid}`]
        if (anchor?.id && Date.now() - anchor.time < 270000)
            return { ...event, id: anchor.id, event_id: anchor.event_id }
        return event
    },

    async sendMsg(data, send, msg) {
        const rets = { message_id: [], data: [], error: [] }
        let msgs

        // 逐条 shift 发送，失败时返回剩余未发的消息
        const sendMsg = async (msgList) => {
            const pending = [...msgList]
            while (pending.length > 0) {
                const segs = pending.shift()
                try {
                    Bot.makeLog("debug", ["发送消息", segs], data.self_id)
                    const ret = await send(segs)
                    Bot.makeLog("debug", ["发送消息返回", ret], data.self_id)

                    rets.data.push(ret)
                    if (ret.id) rets.message_id.push(ret.id)
                    if (Bot.autoRecordMessage === true) saveSentMessage(data, segs, ret)
                } catch (err) {
                    Bot.makeLog("error", ["发送消息错误", segs, err], data.self_id)
                    rets.error.push(err)
                    return pending
                }
            }
            return []
        }

        let messages = Array.isArray(msg) ? msg : [msg]

        if (config.markdown[data.self_id] === "legacy") {
            msgs = await this.makeMsg(data, msg)
        } else {
            msgs = data.legacy || (messages.length === 1 && messages[0].type === "image" && data.event_id?.startsWith("INTERACTION_CREATE")) ? await this.makeMsg(data, msg) : await this.makeRawMarkdownMsg(data, msg)
        }

        let pending = await sendMsg(msgs)
        if (pending.length > 0) {
            // 第二次：只重试失败的消息
            pending = await sendMsg(pending)

            if (pending.length > 0) {
                // 第三次：切换格式，重建全部消息再发
                if (config.markdown[data.self_id] && config.markdown[data.self_id] !== "legacy" && config.markdown[data.self_id] !== "raw") {
                    msgs = typeof Bot.makeMarkdownMsg === "function" ? await Bot.makeMarkdownMsg(data, msg) : await this.makeMarkdownMsg(data, msg)
                } else {
                    msgs = await this.makeMsg(data, msg)
                }
                pending = await sendMsg(msgs)

                if (pending.length > 0) {
                    // 第四次：纯文本兜底
                    msgs = await this.makeMsg(data, msg)
                    await sendMsg(msgs)
                }
            }
        }

        if (Array.isArray(data._ret_id))
            data._ret_id.push(...rets.message_id)

        return rets
    },

    sendFriendMsg(data, msg, event) {
        event = this.fixPassiveSource(data, event, "user", data.user_id)
        return this.sendMsg(data, msg => {
            if (data.smallbtn) event ? event.smallbtn = true : event = { smallbtn: true }
            return data.bot.sdk.sendPrivateMessage(data.user_id, msg, event, { stream: config.stream || data.stream ? true : false, chunkSize: data.chunkSize || config.chunkSize, delay: data.delay || config.delay })
        }, msg)
    },

    sendGroupMsg(data, msg, event) {
        event = this.fixPassiveSource(data, event, "group", data.group_id)
        return this.sendMsg(data, msg => {
            if (data.smallbtn) event ? event.smallbtn = true : event = { smallbtn: true }
            return data.bot.sdk.sendGroupMessage(data.group_id, msg, event)
        }, msg)
    },

    async makeGuildMsg(data, msg) {
        const messages = []
        let message = [], reply
        for (let i of Array.isArray(msg) ? msg : [msg]) {
            if (typeof i === "object")
                i = { ...i }
            else
                i = { type: "text", text: Bot.String(i) }

            switch (i.type) {
                case "at":
                    i.user_id = i.qq?.replace?.(/^qg_/, "")
                case "text":
                case "face":
                case "ark":
                case "embed":
                    break
                case "image":
                    message.push(i)
                    messages.push(message)
                    message = []
                    continue
                case "record":
                case "video":
                case "file":
                    if (i.file) i.file = await Bot.fileToUrl(i.file, i)
                    i = { type: "text", text: `文件：${i.file}` }
                    break
                case "reply":
                    reply = i
                    continue
                case "markdown":
                    if (typeof i.data === "object")
                        i = { type: "markdown", ...i.data }
                    else
                        i = { type: "markdown", content: i.data }
                    break
                case "button":
                    continue
                case "node":
                    for (const { message } of i.data)
                        messages.push(...(await this.makeGuildMsg(data, message)))
                    continue
                case "raw":
                    if (Array.isArray(i.data)) {
                        messages.push(i.data)
                        continue
                    }
                    i = i.data
                    break
                case "card":
                    messages.push({
                        type: "card",
                        data: {
                            type: "tuwen",
                            content: {
                                description: i.description || i.data?.description,
                                pic_url: i.pic_url || i.data?.pic_url,
                                title: i.title || i.data?.title,
                                url: i.url || i.data?.title
                            }
                        }
                    })
                    break
                default:
                    i = { type: "text", text: Bot.String(i) }
            }

            if (i.type === "text" && i.text) {
                const match = i.text.match(this.toQRCodeRegExp)
                if (match) for (const url of match) {
                    const msg = segment.image(await this.makeQRCode(url))
                    message.push(msg)
                    messages.push(message)
                    message = []
                    i.text = i.text.replace(url, "[链接(请扫码查看)]")
                }
            }

            message.push(i)
        }

        if (message.length)
            messages.push(message)
        if (reply) for (const i of messages)
            i.unshift(reply)
        return messages
    },

    async sendGMsg(data, send, msg) {
        const rets = { message_id: [], data: [], error: [] }
        let msgs

        const sendMsg = async () => { for (const i of msgs) try {
            Bot.makeLog("debug", ["发送消息", i], data.self_id)
            const ret = await send(i)
            Bot.makeLog("debug", ["发送消息返回", ret], data.self_id)

            rets.data.push(ret)
            if (ret.id)
                rets.message_id.push(ret.id)
        } catch (err) {
            Bot.makeLog("error", ["发送消息错误", i, err], data.self_id)
            rets.error.push(err)
            return false
        } }

        if (config.markdown[data.self_id] === "raw")
            msgs = await this.makeRawMarkdownMsg(data, msg)
        else if (config.markdown[data.self_id] === "legacy" || !config.markdown[data.self_id])
            msgs = await this.makeMsg(data, msg)
        else
            msgs = typeof Bot.makeMarkdownMsg === "function" ? await Bot.makeMarkdownMsg(data, msg) : await this.makeMarkdownMsg(data, msg)


        if (await sendMsg() === false) {
            msgs = await this.makeGuildMsg(data, msg)
            await sendMsg()
        }
        return rets
    },

    async sendDirectMsg(data, msg, event) {
        if (!data.guild_id) {
            if (!data.src_guild_id) {
                Bot.makeLog("error", [`发送频道私聊消息失败：[${data.user_id}] 不存在来源频道信息`, msg], data.self_id)
                return false
            }
            const dms = await data.bot.sdk.createDirectSession(data.src_guild_id, data.user_id)
            data.guild_id = dms.guild_id
            data.channel_id = dms.channel_id
            data.bot.fl.set(`qg_${data.user_id}`, {
                ...data.bot.fl.get(`qg_${data.user_id}`),
                ...dms,
            })
        }
        return this.sendGMsg(data, msg => data.bot.sdk.sendDirectMessage(data.guild_id, msg, event), msg)
    },

    sendGuildMsg(data, msg, event) {
        return this.sendGMsg(data, msg => data.bot.sdk.sendGuildMessage(data.channel_id, msg, event), msg)
    },

    async recallMsg(data, recall, message_id) {
        if (!Array.isArray(message_id))
            message_id = [message_id]
        const msgs = []
        for (const i of message_id) try {
            msgs.push(await recall(i))
        } catch (err) {
            Bot.makeLog("debug", ["撤回消息错误", i, err], data.self_id)
            msgs.push(false)
        }
        return msgs
    },

    recallFriendMsg(data, message_id) {
        Bot.makeLog("info", `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallPrivateMessage(data.user_id, i), message_id)
    },

    recallGroupMsg(data, message_id) {
        Bot.makeLog("info", `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallGroupMessage(data.group_id, i), message_id)
    },

    recallDirectMsg(data, message_id, hide = config.hideGuildRecall) {
        Bot.makeLog("info", `撤回${hide ? "并隐藏" : ""}频道私聊消息：[${data.guild_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide), message_id)
    },

    recallGuildMsg(data, message_id, hide = config.hideGuildRecall) {
        Bot.makeLog("info", `撤回${hide ? "并隐藏" : ""}频道消息：[${data.channel_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide), message_id)
    }
}
