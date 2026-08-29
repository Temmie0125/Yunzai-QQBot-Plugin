// 事件解析 / 通知方法：将原始事件转为 Yunzai e 对象
import { config, blacklist } from "./context.js"
import { isGroupBlacklisted, isUserBlacklisted } from "../lib/blacklist.js"
import { saveMessage } from "../lib/message.js"
import { saveNotice } from "../lib/notice.js"

export const messageMethods = {
    // ====== 黑名单辅助（在 Bot.em 前调用） ======
    _checkBlacklist(data) {
        if (data.group_id && isGroupBlacklisted(data.group_id)) return true
        const unionid = data.sender?.unionid || data.unionid || ""
        if (isUserBlacklisted(data.user_id, unionid)) return true
        return false
    },

    async makeMessage(id, event) {
        const data = {
            event_id: event.event_id,
            raw: event,
            raw_event: event.raw,
            bot: Bot[id],
            self_id: id,
            post_type: event.post_type,
            message_type: event.message_type,
            sub_type: event.sub_type,
            message_id: event.message_id,
            get unionid() { return this.sender.unionid },
            get openid() { return this.sender.openid },
            get user_id() { return this.sender.user_id },
            get nickname() { return this.sender.nickname },
            get avatar() { return this.sender.avatar },
            set avatar(newAvatar) { this.sender.avatar = newAvatar },
            message: event.message,
            raw_message: event.raw_message,
            time: event.timestamp
        }

        for (const i of data.message) switch (i.type) {
            case "at":
                if (data.message_type === "group")
                    if (i.is_you) i.qq = id
                    else i.qq = `${data.self_id}${this.sep}${i.user_id}`
                else
                    i.qq = `qg_${i.user_id}`
                break
        }

        switch (data.message_type) {
            case "private":
                if (data.sub_type === "friend") {
                    await data.bot.sdk.sendFriendInputNotify(event.sender?.user_id, 1, 30, data.message_id)
                    await this.makeFriendMessage(data, event)
                } else
                    await this.makeDirectMessage(data, event)
                break
            case "group":
                await this.makeGroupMessage(data, event)
                break
            case "guild":
                await this.makeGuildMessage(data, event)
                break
            default:
                Bot.makeLog("warn", ["未知消息", event], id)
                return
        }

        if (Bot.autoRecordMessage === true) saveMessage(data)
        if (data.mentions) {
            if (data.atall) {
                logger.debug(`过滤纯艾特全体成员的信息,event:${JSON.stringify(event, null, 2)}`)
                return true
            }
            if (data.atBot && !data.atme && config.filter_only_at_other_bot) {
                logger.debug(`过滤纯艾特其他bot信息,event:${JSON.stringify(event, null, 2)}`)
                return true
            }
        }
        if (event.author?.bot && config.filter_bot_msg) {
            logger.debug(`过滤bot信息,event:${JSON.stringify(event, null, 2)}`)
            return true
        }

        // 黑名单拦截（在 Bot.em 下发事件前）
        if (this._checkBlacklist(data)) return

        Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
    },

    async makeCallback(id, event) {
        const reply = event.reply.bind(event)
        event.reply = async (...args) => { try {
            return await reply(...args)
        } catch (err) {
            Bot.makeLog("debug", ["回复按钮点击事件错误", err], data.self_id)
        } }

        if (event.data.type === 2002 || event.data.type === 2001) return

        // 私信主动推送
        if (event.data?.resolved?.authorize_data?.opt_scene === "setting" && event.data?.resolved?.authorize_data?.scope === "c2c_push") {
            const user_id = `${id}${this.sep}${event.operator_id}`
            let user = await Bot[id].fl.get(user_id)
            const enabled = !!event.data?.resolved?.authorize_data?.switch
            logger.info(`[U:${user?.nickname || ""}(${user_id})]${enabled ? "开启" : "关闭"}私信主动推送`)
            if (!Bot.disablePushUsers.get(id)) {
                Bot.disablePushUsers.set(id, new Set())
            }
            if (enabled) {
                // 开启：从关闭列表中移除
                Bot.disablePushUsers.get(id)?.delete(user_id)
                await redis.sRem(`wind-disable-push-users:${id}`, user_id)
            } else {
                // 关闭：记录进内存 Map 与 redis
                Bot.disablePushUsers.get(id)?.add(user_id)
                await redis.sAdd(`wind-disable-push-users:${id}`, user_id)
            }
            return
        }

        let user = await Bot[id].fl.get(`${id}${this.sep}${event.operator_id}`)

        const data = {
            event_id: event.event_id,
            raw: event,
            raw_event: event.raw,
            bot: Bot[id],
            self_id: id,
            post_type: "message",
            message_id: event.event_id ? `event_${event.event_id}` : event.notice_id,
            message_type: event.notice_type,
            sub_type: "callback",
            get openid() { return this.sender.openid },
            get unionid() { return this.sender.unionid },
            get user_id() { return this.sender.user_id },
            get nickname() { return this.sender.nickname },
            get avatar() { return this.sender.avatar },
            set avatar(newAvatar) { this.sender.avatar = newAvatar },
            sender: {
                user_id: `${id}${this.sep}${event.operator_id}`,
                bot: event.author?.bot || user?.bot || false,
                avatar: `https://q.qlogo.cn/qqapp/${Bot[id].info.appid}/${event.operator_id}/0`,
                unionid: event.union_openid || user?.unionid || "",
                openid: event.operator_id || user?.openid || "",
                nickname: event.user_name || user?.nickname || ""
            },
            message: [{ type: "text", text: event.data?.resolved?.button_data || "" }],
            raw_message: event.data?.resolved?.button_data || "",
            platform: `QQ-${event.notice_type === "group" ? "group" : "private"}`,
            time: event.timestamp
        }

        event.reply(0)

        switch (data.message_type) {
            case "friend":
                data.message_type = "private"
                Bot.makeLog("info", [`好友按钮点击事件：[U:${data.nickname}(${data.user_id})]`, data.raw_message], data.self_id)

                data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                await this.setFriendMap(data)
                break
            case "group":
                data.group_id = `${id}${this.sep}${event.group_id}`
                let gml = data.bot.gml.get(data.group_id)
                if (gml) {
                    user = gml.get(`${id}${this.sep}${event.operator_id}`)
                }
                data.sender.role = event.author?.member_role || user?.role || "member"

                let group_data = await data.bot.gl.get(data.group_id)
                if (!group_data || !group_data?.group_name) {
                    try {
                        group_data = await data.bot.sdk.getGroupInfo(event.group_id)
                    } catch (e) {
                        group_data = null
                        Bot.makeLog("warn", ["获取群信息失败", e], data.self_id)
                    }
                }

                data.group_data = group_data || {}
                data.group_name = group_data?.group_name || ""

                //await redis.set(`wind-group-event_id:${data.self_id}${this.sep}${event.group_id}`,event.event_id,{ EX:300 })
                Bot.makeLog("info", [`群按钮点击事件：[G:${data.group_name}(${data.group_id}), U:${data.nickname}(${data.user_id})]`, data.raw_message], data.self_id)

                data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                await this.setGroupMap(data)
                break
            case "guild":
                break
            default:
                Bot.makeLog("warn", ["未知按钮点击事件", event], data.self_id)
        }

        if (Bot.autoRecordMessage === true) saveMessage(data)
        // 黑名单拦截（在 Bot.em 下发事件前）
        if (this._checkBlacklist(data)) return

        Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
    },

    async makeaudit(event) {
        if (!event?.audit_id) return
        switch (event.raw.t) {
            case "MESSAGE_AUDIT_PASS":
                await redis.set(`wind-audit-message_id:${event.audit_id}`, JSON.stringify({ success: true, id: event.message_id, raw_event: event.raw }), { EX: 30 * 24 * 60 * 60 })
                break
            case "MESSAGE_AUDIT_REJECT":
                await redis.set(`wind-audit-message_id:${event.audit_id}`, JSON.stringify({ success: false, raw_event: event.raw }), { EX: 30 * 24 * 60 * 60 })
                break
            default:
                break
        }
    },

    async makeNotice(id, event) {
        let user = await Bot[id].fl.get(`${id}${this.sep}${event.operator_id || event.user_id}`)
        let data = {
            openid: event.user_id ? event.user_id : event.operator_id,
            avatar: `https://q.qlogo.cn/qqapp/${Bot[id].info.appid}/${event.user_id ? event.user_id : event.operator_id}/0`,
            event_id: event.event_id,
            raw: event,
            raw_event: event.raw,
            bot: Bot[id],
            self_id: id,
            get openid() { return this.sender.openid },
            get unionid() { return this.sender.unionid },
            get user_id() { return this.sender.user_id },
            set user_id(newUserId) { this.sender.user_id = newUserId },
            get nickname() { return this.sender.nickname },
            get avatar() { return this.sender.avatar },
            set avatar(newAvatar) { this.sender.avatar = newAvatar },
            sender: {
                user_id: `${id}${this.sep}${event.operator_id || event.user_id}`,
                bot: event.author?.bot || user?.bot || false,
                avatar: `https://q.qlogo.cn/qqapp/${Bot[id].info.appid}/${event.operator_id || event.user_id}/0` || user.avatar || "",
                unionid: event.union_openid || user?.unionid || "",
                openid: event.operator_id || event.user_id || user?.openid || "",
                nickname: event.user_name || user?.nickname || ""
            },
            post_type: event.post_type,
            notice_type: event.notice_type,
            sub_type: event.sub_type,
            notice_id: event.notice_id,
            platform: "QQ-notice",
            time: event.timestamp || Math.floor(Date.now() / 1000),
        }

        if (data.notice_type === "friend") {
            data.reply = msg => this.sendFriendMsg({
                ...data, user_id: event.user_id,
            }, msg, { event_id: data.event_id })
        }
        if (data.notice_type === "group") {
            data.group_id = data.self_id + this.sep + event.group_id
            let group_data = await data.bot.gl.get(data.group_id)
            if (!group_data || !group_data?.group_name) {
                try {
                    group_data = await data.bot.sdk.getGroupInfo(event.group_id)
                } catch (e) {
                    group_data = null
                    Bot.makeLog("warn", ["获取群信息失败", e], data.self_id)
                }
            }

            data.group_data = group_data || {}
            data.group_name = group_data?.group_name || ""
            data.reply = msg => this.sendGroupMsg({
                ...data, group_id: event.group_id,
            }, msg, { event_id: data.event_id })
        }
        if (data.notice_type === "guild") {
            data.user_id = event.user_id ? "qg_" + event.user_id : "qg_" + event.operator_id
            data.platform = "guild-notice"
        }

        switch (data.sub_type) {
            case "audit":
                return this.makeaudit(event)
            case "action":
                return this.makeCallback(id, event)
            case "increase": {
                if (data.notice_type !== "guild") {
                    data.sender = {
                        user_id: data.user_id,
                        openid: data.openid,
                        unionid: data.unionid,
                        nickname: data.nickname,
                        avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${data.openid}/0`
                    }
                    this.setGroupMap(data)
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                }
                break
            }
            case "decrease": {
                if (data.notice_type !== "guild") {
                    this.delGroupMember(data)
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                }
                break
            }
            case "add":
            case "del":
                if (data.notice_type !== "guild") {
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                }
                break
            case "update":
            case "member.increase":
            case "member.decrease":
            case "member.update":
                break
            case "request":
                data.apply_source = event.apply_source
                data.invited_by = event.invited_by
                data.verify_info = event.verify_info
                data.join_request_id = event.join_request_id
                break
            default:
                Bot.makeLog("warn", ["未知通知", event], id)
                return
        }

        // 黑名单拦截（在 Bot.em 下发事件前）
        if (this._checkBlacklist(data)) return
        Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
    }
}
