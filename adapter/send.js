// 发送 / 撤回消息方法
import { config, avatarCacheKey } from "./context.js"
import { saveSentMessage } from "../lib/message.js"
import { recordSendErrors } from "../lib/errorStore.js"

// 被动消息回复参数（官方规则：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html）
// 被动消息有效期60分钟（留1分钟余量）；每条消息回复上限官方默认5次，机器人开发者兼任目标群群主/管理员时为50次
const PASSIVE_WINDOW = 59 * 60000
const PASSIVE_POOL_SIZE = 5
const passiveReplyLimit = () => {
    const n = Number(config.passiveReplyLimit)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5
}
// 被动凭证过期/回复额度耗尽的官方错误码
const PASSIVE_EXHAUSTED_CODES = new Set(["304103", "40034005", "40034026"])

export const sendMethods = {
    // QQ官方Bot群聊默认无主动消息权限，媒体/文件消息必须携带被动回复凭证(msg_id/event_id)。
    // sendFile 等通道不经过事件对象，这里从事件池选取该群/用户窗口内、额度未耗尽的最新被动锚点
    // （被动消息有效期60分钟，留1分钟余量；官方新规每条消息可回复5次，配额耗尽由 rotatePassiveSource 轮换）
    fixPassiveSource(data, event, type, openid) {
        const key = `${type}:${openid}`
        const pool = data.bot?._passivePool?.[key]
        if (event?.id || event?.event_id) {
            // 事件自带被动凭证：关联事件池中的同源锚点，发送成功后据此回写额度计数
            const anchor = pool?.find(i => i.id === event.id)
            if (anchor) event._anchor = anchor
            event._anchorKey = key
            return event
        }
        const anchor = pool?.find(i => !i.exhausted && (i.count ?? 0) < passiveReplyLimit() && Date.now() - i.time < PASSIVE_WINDOW)
        if (anchor)
            return { ...event, id: anchor.id, event_id: anchor.event_id, _anchor: anchor, _anchorKey: key }
        return event
    },

    // 记录被动回复锚点（每群/好友保留最近数条构成事件池）：
    // sendFile/pickGroup/pickFriend 等不经过事件对象的发送通道由 fixPassiveSource 从池中回退选取
    recordPassiveAnchor(data, type, openid) {
        const bot = data.bot
        if (!bot || !data.message_id) return
        const key = `${type}:${openid}`
        const anchor = { id: data.message_id, event_id: data.event_id, time: Date.now(), count: 0 }
        const pool = (bot._passivePool ||= {})[key] ||= []
        const i = pool.findIndex(a => a.id === anchor.id)
        if (i > -1) pool.splice(i, 1)
        pool.unshift(anchor)
        if (pool.length > PASSIVE_POOL_SIZE) pool.splice(PASSIVE_POOL_SIZE)
        // 单槽别名与池首保持同引用，兼容旧读取方
        ;(bot._passiveAnchor ||= {})[key] = anchor
    },

    // 被动回复额度耗尽/凭证过期（304103/40034005/40034026）时轮换被动凭证：
    // 先把当前锚点标记耗尽，再优先换事件池内其它可用锚点；无锚点可换则去除凭证降级为主动消息重试一次
    rotatePassiveSource(data, event, err) {
        const code = String(err?.detail?.code ?? "")
        if (!PASSIVE_EXHAUSTED_CODES.has(code) && ![...PASSIVE_EXHAUSTED_CODES].some(i => String(err?.message || "").includes(i)))
            return false
        const current = event._anchor
        if (current) current.exhausted = true
        const fresh = i => Date.now() - i.time < PASSIVE_WINDOW
        const next = data.bot?._passivePool?.[event._anchorKey]?.find(i => i !== current && !i.exhausted && (i.count ?? 0) < passiveReplyLimit() && fresh(i))
        if (next) {
            Bot.makeLog("mark", [`被动回复额度耗尽或凭证过期(${code})，轮换备用锚点续发`], data.self_id)
            event.id = next.id
            event.event_id = next.event_id
            event._anchor = next
            return true
        }
        Bot.makeLog("mark", [`被动回复额度耗尽或凭证过期(${code})且无备用锚点，去除凭证降级为主动消息续发`], data.self_id)
        delete event.id
        delete event.event_id
        event._anchor = null
        return true
    },

    async sendMsg(data, send, msg) {
        const rets = { message_id: [], data: [], error: [] }
        let msgs

        // 逐条 shift 发送，失败时返回剩余未发的消息
        const sendMsg = async (msgList, attempt = 1) => {
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
                    rets.error.push({
                        ...err.detail,
                        err:err.message,
                        segs:segs,
                        timestamp: Date.now(),
                        msg: data?.msg,
                        self_id: data?.self_id,
                        nickname: data?.bot?.nickname || '未知',
                        attempt  
                    })
                    return pending
                }
            }
            return []
        }

        let messages = Array.isArray(msg) ? msg : [msg]

        const mdMode = config.markdown[data.self_id]
        const forcePlain = data.legacy || (messages.length === 1 && messages[0].type === "image" && data.event_id?.startsWith("INTERACTION_CREATE"))
        if (mdMode === "legacy" || forcePlain) {
            msgs = await this.makeMsg(data, msg)
        } else if (mdMode === "auto" && (this.isPlainMsg(data, msg) || this.isImageOnlyMsg(data, msg))) {
            // 智能判定：纯文本按原生消息发送，特殊字符不再被QQ当作markdown渲染；
            // 纯图片(含表情包的face id=0标记段)与其它富媒体一样直发媒体消息，不再构造Markdown图片外链；
            // 含@/文本+图片混排/按钮/显式segment.markdown等特殊内容时仍走markdown
            msgs = await this.makeMsg(data, msg)
        } else {
            msgs = await this.makeRawMarkdownMsg(data, msg)
        }

        let pending = await sendMsg(msgs, 1)
        if (pending.length > 0) {
            // 第二次：只重试失败的消息
            pending = await sendMsg(pending, 2)

            if (pending.length > 0) {
                // 第三次：切换格式，重建全部消息再发
                if (config.markdown[data.self_id] === "auto") {
                    // 智能判定模式：换markdown格式重试（纯文本可能超出msg_type 0长度上限等）
                    msgs = await this.makeRawMarkdownMsg(data, msg)
                } else if (config.markdown[data.self_id] && config.markdown[data.self_id] !== "legacy" && config.markdown[data.self_id] !== "raw") {
                    msgs = typeof Bot.makeMarkdownMsg === "function" ? await Bot.makeMarkdownMsg(data, msg) : await this.makeMarkdownMsg(data, msg)
                } else {
                    msgs = await this.makeMsg(data, msg)
                }
                pending = await sendMsg(msgs, 3)

                if (pending.length > 0) {
                    // 第四次：纯文本兜底
                    msgs = await this.makeMsg(data, msg)
                    await sendMsg(msgs, 4)
                }
            }
        }

        if (Array.isArray(data._ret_id))
            data._ret_id.push(...rets.message_id)

        if (rets.error.length > 0 && config.recordSendErrors)
            recordSendErrors(rets.error)

        return rets
    },

    sendFriendMsg(data, msg, event) {
        event = this.fixPassiveSource(data, event, "user", data.user_id)
        return this.sendMsg(data, async segs => {
            if (data.smallbtn) event ? event.smallbtn = true : event = { smallbtn: true }
            if (data.is_wakeup) event ? event.is_wakeup = true : event = { is_wakeup: true }
            const send = () => data.bot.sdk.sendPrivateMessage(data.user_id, segs, event, { stream: config.stream || data.stream ? true : false, chunkSize: data.chunkSize || config.chunkSize, delay: data.delay || config.delay })
            let ret
            try {
                ret = await send()
            } catch (err) {
                // 被动额度耗尽/凭证过期：轮换备用锚点或降级主动消息后重发一次
                if (!(event?._anchorKey && this.rotatePassiveSource(data, event, err))) throw err
                ret = await send()
            }
            // 被动回复成功：回写事件池锚点的已用额度（is_wakeup 唤醒消息被SDK剥掉凭证转主动，不计）
            if (event?._anchor && !event.is_wakeup) event._anchor.count++
            return ret
        }, msg).then(rets => {
            // C2C主动消息发送成功即确认好友关系（对非好友会发送失败）：
            // "添加后从未发言、无任何私聊记录"的好友在收到推送时自动回到好友表
            if (rets.data?.length && data.user_id) {
                const openid = String(data.user_id).replace(`${data.self_id}${this.sep}`, "")
                const user_id = `${data.self_id}${this.sep}${openid}`
                this.setFriendMap({
                    bot: data.bot,
                    user_id,
                    sender: {
                        ...data.sender,
                        user_id,
                        nickname: data.sender?.nickname || data.nickname || "",
                        avatar: data.sender?.avatar || data.avatar || `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${openid}/0?t=${avatarCacheKey()}`,
                        openid: data.sender?.openid || data.openid || openid,
                    },
                }).catch(() => {})
            }
            return rets
        })
    },

    sendGroupMsg(data, msg, event) {
        event = this.fixPassiveSource(data, event, "group", data.group_id)
        return this.sendMsg(data, async segs => {
            if (data.smallbtn) event ? event.smallbtn = true : event = { smallbtn: true }
            const send = () => data.bot.sdk.sendGroupMessage(data.group_id, segs, event)
            let ret
            try {
                ret = await send()
            } catch (err) {
                // 被动额度耗尽/凭证过期：轮换备用锚点或降级主动消息后重发一次
                if (!(event?._anchorKey && this.rotatePassiveSource(data, event, err))) throw err
                ret = await send()
            }
            // 被动回复成功：回写事件池锚点的已用额度
            if (event?._anchor) event._anchor.count++
            return ret
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
                    messages.push(...(await this.makeForwardMsg(data, i.data, "makeGuildMsg")))
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
            Bot.makeLog("warn", ["撤回消息错误", i, err], data.self_id)
            msgs.push(false)
        }
        return msgs
    },

    recallFriendMsg(data, message_id) {
        Bot.makeLog("info", `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
        if(Bot.storageBackend === 'sqlite') Bot.MsgIdxDB.markRecalledBymsgid(message_id).catch(err => logger.error(err))
        return this.recallMsg(data, i => data.bot.sdk.recallPrivateMessage(data.user_id, i), message_id)
    },

    recallGroupMsg(data, message_id) {
        Bot.makeLog("info", `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id)
        if(Bot.storageBackend === 'sqlite') Bot.MsgIdxDB.markRecalledBymsgid(message_id).catch(err => logger.error(err))
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
