// 事件解析 / 通知方法：将原始事件转为 Yunzai e 对象
import { config, blacklist } from "./context.js"
import { isGroupBlacklisted, isUserBlacklisted } from "../lib/blacklist.js"
import { saveMessage } from "../lib/message.js"
import { saveNotice } from "../lib/notice.js"
import { recordMessage, recordNotice } from "../lib/stat.js"

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

        // 使用统计（异步，不阻塞事件下发）
        recordMessage(data)

        Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
    },

    async makeCallback(id, event) {
        const reply = event.reply.bind(event)
        event.reply = async (...args) => { try {
            return await reply(...args)
        } catch (err) {
            Bot.makeLog("debug", ["回复按钮点击事件错误", err], data.self_id)
        } }

        let data = {
            event_id: event.event_id,
            raw: event,
            raw_event: event.raw,
            bot: Bot[id],
            self_id: id,
            post_type: event.post_type,
            message_id: event.message_id ? event.message_id : `event_${event.event_id}`,
            platform: `QQ-${event.notice_type === "group" ? "group" : "private"}`,
            time: event.timestamp
        }

        let user = {}
        if (event.user_id) { // 部分互动事件没有userid
            user = event.user_id ? await Bot[id].fl.get(`${id}${this.sep}${event.user_id}`) : {}
            Object.assign(data, {
                get openid() { return this.sender.openid },
                get unionid() { return this.sender.unionid },
                get user_id() { return this.sender.user_id },
                get nickname() { return this.sender.nickname },
                get avatar() { return this.sender.avatar },
                set avatar(newAvatar) { this.sender.avatar = newAvatar },
                sender: {
                    user_id: `${id}${this.sep}${event.user_id}`,
                    bot: event.author?.bot || user?.bot || false,
                    avatar: `https://q.qlogo.cn/qqapp/${Bot[id].info.appid}/${event.user_id}/0`,
                    unionid: event.union_openid || user?.unionid || "",
                    openid: event.user_id || user?.openid || "",
                    nickname: event.user_name || user?.nickname || ""
                },
            })
        }

        if (event.notice_type === "group") {
            data.group_id = `${id}${this.sep}${event.group_id}`
            let gml = data.bot.gml.get(data.group_id)
            if (gml && event.user_id) {
                user = gml.get(`${id}${this.sep}${event.user_id}`)
                data.sender.role = event.author?.member_role || user?.role || "member"
            }

            // 官Bot回调事件不带user_name：非好友点击时sender.nickname为空，插件侧只能显示复合ID。
            // 从gml/用户资料缓存回填，仍无则拉群成员API一次并回写users缓存
            //（下方的setGroupMap/setUserMap会把带昵称的sender落进gml与users，后续点击免API）
            if (data.sender && !data.sender.nickname) {
                const uid = `${id}${this.sep}${event.user_id}`
                const cached = await data.bot.users?.get(uid)
                data.sender.nickname = user?.nickname || user?.card || cached?.nickname || cached?.card || ""
                if (!data.sender.nickname) {
                    try {
                        const info = await data.bot.sdk.getGroupMemberInfo(event.group_id, event.user_id)
                        if (info?.nickname) {
                            data.sender.nickname = info.nickname
                            await data.bot.users?.set(uid, {
                                ...cached, nickname: info.nickname,
                                card: info.card || info.nickname, user_id: uid,
                            })
                        }
                    } catch (e) {
                        Bot.makeLog("debug", ["按钮回调获取群成员昵称失败", e], id)
                    }
                }
            }

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
        }

        switch(event.type){ // 暂时只下发消息按钮回调和菜单回调，其他的仅作初步处理及日志输出，不下发事件
            case 11:{
                Object.assign(data, {
                    post_type: "message",
                    sub_type: "callback",
                    message: [{ type: "text", text: event.data?.resolved?.button_data || "" }],
                    raw_message: event.data?.resolved?.button_data || "",
                    message_type: event.notice_type
                })
                event.reply(0)
                switch (data.message_type) {
                    case "friend":
                        data.message_type = "private"
                        Bot.makeLog("info", [`好友按钮点击事件：[U:${data.nickname}(${data.user_id})]`, data.raw_message], data.self_id)

                        data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                        await this.setFriendMap(data)
                        break
                    case "group":
                        //await redis.set(`wind-group-event_id:${data.self_id}${this.sep}${event.group_id}`,event.event_id,{ EX:300 })
                        Bot.makeLog("info", [`群按钮点击事件：[G:${data.group_name || ''}(${data.group_id}), U:${data.nickname}(${data.user_id})]`, data.raw_message], data.self_id)
                        data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                        await this.setGroupMap(data)
                        await this.setUserMap(data)
                        break
                    case "guild":
                        break
                    default:
                        Bot.makeLog("warn", ["未知按钮点击事件", event], data.self_id)
                }

                // 按钮点击也计为一次使用
                recordMessage(data)

                if (Bot.autoRecordMessage === true) saveMessage(data)

                break
            }
            case 12:{
                Object.assign(data, {
                    post_type: "message",
                    sub_type: "callback",
                    message: [{ type: "text", text: event.data?.resolved?.button_data || "" }],
                    raw_message: event.data?.resolved?.button_data || "",
                    message_type: event.notice_type
                })
                event.reply(0)

                data.message_type = "private"
                Bot.makeLog("info", [`好友快捷菜单点击事件：[U:${data.nickname}(${data.user_id})]`, data.raw_message], data.self_id)

                data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                await this.setFriendMap(data)

                // 按钮点击也计为一次使用
                recordMessage(data)

                break
            }
            case 13:{
                Object.assign(data, {
                    sub_type: "feedback",
                    notice_type: event.notice_type,
                    optText: event.optText,
                    checked: event.checked,
                    callback_data: event.data?.resolved?.button_data || ""
                })
                
                switch (data.notice_type) {
                    case "friend":
                        data.notice_type = "private"
                        Bot.makeLog("info", `[U:${data.nickname || ""}(${data.user_id})]${event.checked === 1 ? "" : "取消"}${event.optText}了消息${event.message_id ? `(${event.message_id})` : ''}`, data.self_id)

                        data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                        await this.setFriendMap(data)
                        break
                    case "group":
                        Bot.makeLog("info", `[G:${data.group_name || ''}(${data.group_id}), U:${data.nickname || ""}(${data.user_id})]${event.checked === 1 ? "" : "取消"}${event.optText}了消息${event.message_id ? `(${event.message_id})` : ''}`, data.self_id)
                        data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                        await this.setGroupMap(data)
                        break
                    case "guild":
                        break
                    default:
                        Bot.makeLog("warn", ["未知场景消息反馈事件", event], data.self_id)
                }
                break
            }
            case 14:{
                Object.assign(data, {
                    sub_type: "clearsession",
                    notice_type: event.notice_type
                })

                switch (data.notice_type) {
                    case "friend":
                        data.notice_type = "private"
                        data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                        await this.setFriendMap(data)
                        break
                    case "group":
                        data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                        await this.setGroupMap(data)
                        break
                    case "guild":
                        break
                    default:
                        Bot.makeLog("warn", ["未知场景清空会话事件", event], data.self_id)
                }
                Bot.makeLog("info", `[U:${data.nickname || ""}(${data.user_id})]清空智能体会话历史`, data.self_id)
                break
            }
            case 15:{
                Object.assign(data, {
                    sub_type: "inoutstory",
                    notice_type: event.notice_type
                })
                
                switch (data.notice_type) {
                    case "friend":
                        data.notice_type = "private"
                        data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                        await this.setFriendMap(data)
                        break
                    case "group":
                        data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                        await this.setGroupMap(data)
                        break
                    case "guild":
                        break
                    default:
                        Bot.makeLog("warn", ["未知用户进退故事集事件", event], data.self_id)
                }
                Bot.makeLog("info", `[U:${data.nickname || ""}(${data.user_id})]${event.action === 'ENTER_STORY' ? '进入' : '退出'}故事集`, data.self_id)
                break
            }
            case 16:{
                Object.assign(data, {
                    sub_type: "switchmodal",
                    notice_type: event.notice_type
                })
                
                switch (data.notice_type) {
                    case "friend":
                        data.notice_type = "private"
                        data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                        await this.setFriendMap(data)
                        break
                    case "group":
                        data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                        await this.setGroupMap(data)
                        break
                    case "guild":
                        break
                    default:
                        Bot.makeLog("warn", ["未知场景切换模型事件", event], data.self_id)
                }
                Bot.makeLog("info", `[U:${data.nickname || ""}(${data.user_id})]用户切换智能体模型${event.action}`, data.self_id)
                break
            }
            case 18:{
                Object.assign(data, {
                    sub_type: "userauthorize",
                    notice_type: event.notice_type
                })
                
                data.notice_type = "private"
                data.reply = msg => this.sendFriendMsg({ ...data, user_id: event.operator_id }, msg, { event_id: data.event_id })
                await this.setFriendMap(data)

                Bot.makeLog("info", `[U:${data.nickname || ""}(${data.user_id})]${event.switch ? "开启" : "关闭"}私信主动推送`, data.self_id)
                if (!Bot.disablePushUsers.get(data.self_id)) {
                    Bot.disablePushUsers.set(data.self_id, new Set())
                }
                if (event.switch) {
                    // 开启：从关闭列表中移除
                    Bot.disablePushUsers.get(data.self_id)?.delete(data.user_id)
                    await redis.sRem(`wind-disable-push-users:${data.self_id}`, data.user_id)
                } else {
                    // 关闭：记录进内存 Map 与 redis
                    Bot.disablePushUsers.get(data.self_id)?.add(data.user_id)
                    await redis.sAdd(`wind-disable-push-users:${data.self_id}`, data.user_id)
                }
                break
            }
            case 19:{
                Object.assign(data, {
                    sub_type: "groupauthorize",
                    notice_type: event.notice_type
                })

                data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                await this.setGroupMap(data)

                Bot.makeLog("info", `[G:${data.group_name || ''}(${event.group_id}),U:${data?.nickname || ""}(${data.user_id})]${event.switch ? "开启" : "关闭"}群聊主动推送`, data.self_id)
                break
            }
            case 20:{
                Object.assign(data, {
                    sub_type: "groupauthorizestatus",
                    notice_type: event.notice_type
                })

                data.reply = msg => this.sendGroupMsg({ ...data, group_id: event.group_id }, msg, { event_id: data.event_id })
                await this.setGroupMap(data)

                if (event.data.type === 2002 || event.data.type === 2001){
                    Bot.makeLog("info", '收到机器人管理页回调（目前无用）', data.self_id)
                    reply(0, {
                        data: {
                            claw_cfg: {
                                channel_type: "qqbot",
                                channel_ver: "9.9.9",
                                claw_type: "wind",
                                claw_ver: "6666.66.66",
                                require_mention: "always",
                                online_state: "online"
                            }
                        }
                    })
                }
                break
            }
            default:{
                logger.warn(`未知事件类型：type:${event.type}`)
                return
            }
        }
        // 黑名单拦截（在 Bot.em 下发事件前）
        if (this._checkBlacklist(data)) return

        Bot.em(`${data.post_type}.${data.message_type ?? data.notice_type}.${data.sub_type}`, data)
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
        // fl 只存真实好友：非好友事件（如群成员退群）从 users 资料缓存兜底，
        // 否则空昵称会在退群时的 setUserMap 快照里覆盖缓存中已有的资料
        const uid = `${id}${this.sep}${event.operator_id || event.user_id}`
        let user = await Bot[id].fl.get(uid) ?? await Bot[id].users?.get(uid)
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
            if (data.sub_type === "decrease")
                data.sender.is_friend = false
            else
                data.sender.is_friend = true
            data.reply = msg => this.sendFriendMsg({
                ...data, user_id: event.user_id,
            }, msg, { event_id: data.event_id })
            this.setFriendMap(data)
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
            
            if (data.sub_type === "del")
                data.group_data.in_group = false
            else
                data.group_data.in_group = true
            try{
                await this.setGroupMap(data)
            }catch(e){
                logger.warn('群信息记录失败')
            }

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
                if (data.notice_type === "friend") {
                    // 好友添加事件(FRIEND_ADD)：进好友表。官方Bot无好友列表API，好友表只能靠事件维护，
                    // friend标记保证"添加后从未发言"的好友不被启动清理误删
                    await this.setFriendMap(data)
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                } else if (data.notice_type !== "guild") {
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                }
                break
            }
            case "decrease": {
                if (data.notice_type !== "guild") {
                    if (data.notice_type !== "friend") {
                        // 成员退群：资料先转入users缓存保留（gml即将删除该成员），
                        // yenai退群提示等仍能取到昵称头像
                        await this.setUserMap(data)
                    }
                    // 好友删除不再移除好友表：上游makeNotice已对好友通知统一setFriendMap
                    // 并标记is_friend=false，保留资料仅改标记
                    this.delGroupMemberMap(data)
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                }
                break
            }
            case "add":
                if (data.notice_type === "group") {
                    // 缓存本群信息
                    data.bot.pickGroup(data.group_id).getBotStatus()
                }
            case "del":
                if (data.notice_type !== "guild") {
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                    // 官方机器人进/退群事件(GROUP_ADD_ROBOT/GROUP_DEL_ROBOT)补发 icqq 语义的群自增减通知
                    // (user_id 为 Bot 自身)，yenai-plugin 等插件靠 notice.group.increase/decrease 识别新增/减少群聊
                    const change = event.sub_type === "add" ? "increase" : "decrease"
                    Bot.em(`notice.group.${change}`, {
                        ...data,
                        post_type: "notice",
                        notice_type: "group",
                        sub_type: change,
                        user_id: id,
                        nickname: Bot[id].nickname,
                        operator_id: event.operator_id ? `${id}${this.sep}${event.operator_id}` : undefined,
                    })
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
                if (data.notice_type === "group") {
                    // 官方加群申请事件(GROUP_JOIN_REQUEST)补发 icqq 语义的 request 事件，
                    // yenai-plugin 等插件监听 Bot.on("request")，若只发 notice.group.request 永远收不到
                    const rawPayload = event.raw?.d || {}
                    const comment = event.verify_info?.verify_message
                        || event.verify_info?.review_qa_list?.map(qa => `${qa.question}：${qa.answer}`).join("\n")
                        || ""
                    const tips = [
                        rawPayload.risk_tips,
                        rawPayload.auto_approved ? "该申请已被自动审批通过，无需处理" : "",
                    ].filter(Boolean).join("；")
                    Bot.em("request.group.add", {
                        ...data,
                        post_type: "request",
                        request_type: "group",
                        sub_type: "add",
                        group_id: data.group_id,
                        user_id: `${id}${this.sep}${event.user_id}`,
                        nickname: event.user_name || data.nickname || "未知",
                        comment,
                        tips,
                        flag: event.join_request_id,
                        inviter_id: event.invited_by ? `${id}${this.sep}${event.invited_by}` : undefined,
                    })
                }
                break
            default:
                Bot.makeLog("warn", ["未知通知", event], id)
                return
        }

        // 黑名单拦截（在 Bot.em 下发事件前）
        if (this._checkBlacklist(data)) return

        // 统计入群 / 被踢 / 好友增减（内部按 notice_type + sub_type 过滤）
        recordNotice(data)

        Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
    }
}
