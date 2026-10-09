// pick 方法 / 构造消息对象 / 群管方法
import { config, configSave, blacklist } from "./context.js"

// Bot 在各群的角色缓存（官方bot_state接口），key: `${self_id}:${group_openid}`
// 群管命令的 group.is_admin/is_owner 判断依赖它，TTL 内复用，避免每条命令打一次API
const botRoleCache = new Map()
const BOT_ROLE_TTL = 10 * 60 * 1000

// 强制刷新角色缓存（忽略TTL），返回最新角色；失败时保留旧值
async function fetchBotRole(self_id, group_id) {
    try {
        const info = await Bot[self_id].sdk.getGroupBotInfo(group_id)
        const role = info?.member_role || "member"
        botRoleCache.set(`${self_id}:${group_id}`, { role, time: Date.now() })
        return role
    } catch (err) {
        Bot.makeLog("debug", ["获取Bot群内角色失败", err], self_id)
        return undefined
    }
}

// 带TTL的角色查询：命中直接返回，过期则后台刷新并先返回旧值
function getCachedBotRole(self_id, group_id) {
    const key = `${self_id}:${group_id}`
    const cached = botRoleCache.get(key)
    if (!cached || Date.now() - cached.time > BOT_ROLE_TTL)
        fetchBotRole(self_id, group_id).catch(() => {})
    return cached?.role
}

export const pickMethods = {
    rfc3339CN(seconds = 0) {
        const d = new Date(Date.now() + seconds * 1000);

        const pad = n => n.toString().padStart(2, "0");

        const utc = d.getTime();
        const cst = new Date(utc + 8 * 60 * 60 * 1000);

        return (
            `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())}` +
            `T${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())}` +
            `+08:00`
        );
    },

    // 标准化用户头像获取：官方Bot平台用户只有OpenID（32位十六进制），没有QQ号，
    // 需走 qqapp 头像接口 https://q.qlogo.cn/qqapp/{appid}/{openid}/{size}（size 支持 0/100/640，0 为原图）。
    // 真实QQ号（非OpenID格式）回退标准 qlogo 接口。user_id 支持裸ID或 "self_id:ID" 复合格式
    getAvatarUrl(self_id, user_id, size = 100) {
        user_id = String(user_id ?? "")
        const id = self_id ? user_id.replace(`${self_id}${this.sep}`, "") : user_id
        if (/^[0-9A-F]{32}$/i.test(id)) {
            const appid = Bot[self_id]?.info?.appid
            if (appid) return `https://q.qlogo.cn/qqapp/${appid}/${id}/${size}`
        }
        return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=${size}`
    },

    // 查询Bot在群内的角色（owner/admin/member），供外部（如群消息事件）预热缓存
    getBotRole(self_id, group_id) {
        return getCachedBotRole(self_id, group_id) ?? fetchBotRole(self_id, group_id)
    },

    // 通过 ref_msg_idx 从本地消息索引换取被引用消息的真实message_id
    // （官方事件不直接下发被引用消息ID，引用撤回/回复等依赖此换算）
    async getRefMessageId(ref_msg_idx) {
        if (!ref_msg_idx) return ""
        try {
            const stored = await redis.get(`wind-msg-idx:${ref_msg_idx}`)
            return stored ? JSON.parse(stored)?.message_id || "" : ""
        } catch {
            return ""
        }
    },

    // 从本地消息存储按message_id查回完整消息（引用撤回、获取引用内容等）
    // 成员消息存 wind-msg；Bot自身消息存 wind-bot-msg，且群聊以裸群openid为键，与成员存储的复合键不同
    async getStoredMsg(type, key, message_id) {
        if (!message_id) return null
        const keys = [key]
        if (String(key).includes(this.sep))
            keys.push(String(key).slice(String(key).indexOf(this.sep) + 1))
        for (const prefix of ["wind-msg", "wind-bot-msg"]) {
            for (const k of keys) {
                try {
                    const items = await redis.zRange(`${prefix}:${type}:${k}`, 0, -1)
                    for (let i = items.length - 1; i >= 0; i--) {
                        let m = items[i]
                        if (typeof m === "string") {
                            try { m = JSON.parse(m) } catch { continue }
                        }
                        if (m?.message_id === message_id) {
                            // 兼容历史数据：sendSentMessage 曾把段数组双重嵌套为 [[seg,...]]
                            if (Array.isArray(m.message) && m.message.length === 1 && Array.isArray(m.message[0]))
                                m.message = m.message[0]
                            return m
                        }
                    }
                } catch (err) {
                    Bot.makeLog("debug", ["查询本地消息失败", err], String(k))
                }
            }
        }
        return null
    },

    // 按内容从新到旧匹配本地存储消息（引用换算兜底）：
    // 成员消息的ref_msg_idx与其自身msg_idx是不同密文无法按键索引，
    // 但引用元素(type 103)携带被引用消息的content，据此匹配最近一条相同内容的通知。
    // bot自身消息在 wind-bot-msg（群聊用裸群openid键），引用bot消息时同样需要覆盖；
    // 图片等无文本引用（content为空或占位符）无法按内容匹配，退化为取该会话最近一条带图消息
    async findStoredMsgIdByContent(type, key, content) {
        try {
            const keys = [key]
            if (String(key).includes(this.sep))
                keys.push(String(key).slice(String(key).indexOf(this.sep) + 1))
            const placeholders = new Set(["", "[图片]", "[image]", "[动画表情]", "[文件]"])
            const byContent = content && !placeholders.has(content)
            for (const prefix of ["wind-msg", "wind-bot-msg"]) {
                for (const k of keys) {
                    let items
                    try {
                        items = await redis.zRange(`${prefix}:${type}:${k}`, -200, -1)
                    } catch (err) {
                        continue
                    }
                    let imageFallback = ""
                    for (let i = items.length - 1; i >= 0; i--) {
                        let m = items[i]
                        if (typeof m === "string") {
                            try { m = JSON.parse(m) } catch { continue }
                        }
                        if (!m?.message_id || m.recalled) continue
                        if (byContent) {
                            const rm = String(m.raw_message || "").trim()
                            if (rm === content) return m.message_id
                        } else if (!imageFallback && Array.isArray(m.message)) {
                            const segs = m.message.length === 1 && Array.isArray(m.message[0]) ? m.message[0] : m.message
                            if (segs.some?.(s => s?.type === "image")) imageFallback = m.message_id
                        }
                    }
                    if (!byContent && imageFallback) return imageFallback
                }
            }
        } catch (err) {
            Bot.makeLog("debug", ["按内容匹配引用消息失败", err], String(key))
        }
        return ""
    },

    // 为收到的引用消息注入reply段与source，使 e.reply_id / e.getReply 生效（icqq语义）
    async resolveRefMessage(data) {
        try {
            let refId = await this.getRefMessageId(data.ref_msg_idx)
            const quoteEl = Array.isArray(data.msg_elements)
                && data.msg_elements.find(e => e?.message_type === 103 && typeof e.content === "string")
            if (!refId && (data.ref_msg_idx || quoteEl)) {
                // 键索引未命中：用引用元素携带的被引用内容做兜底匹配
                if (quoteEl) {
                    const key = data.group_id || data.user_id
                    const msgType = data.group_id ? "group" : "private"
                    refId = await this.findStoredMsgIdByContent(msgType, key, quoteEl.content.trim())
                }
            }
            if (!refId) {
                if (data.ref_msg_idx) data.reply_unresolved = true
                return
            }
            if (Array.isArray(data.message))
                data.message.unshift({ type: "reply", id: refId })
            data.source ||= { message_id: refId }
        } catch (err) {
            Bot.makeLog("debug", ["解析引用消息失败", err], data.self_id)
        }
    },

    pickFriend(id, user_id) {
        if (typeof user_id !== "string")
            user_id = String(user_id)
        else if (user_id.startsWith("qg_"))
            return this.pickGuildFriend(id, user_id)
        const i = {
            ...Bot[id].fl.get(user_id),
            self_id: id,
            bot: Bot[id],
            user_id: user_id.replace(`${id}${this.sep}`, ""),
            platform: "QQ-private"
        }
        return {
            ...i,
            sendMsg: msg => this.sendFriendMsg(i, msg),
            recallMsg: message_id => this.recallFriendMsg(i, message_id),
            // 从本地消息存储查回消息（引用撤回等依赖）
            getMsg: async message_id => this.getStoredMsg("private", `${id}${this.sep}${i.user_id}`, message_id),
            getInfo: () =>{ // 兼容
                let data = i.bot.fl.get(i.group_id)?.get(i.user_id)
                return data
            },
            getAvatarUrl: size => this.getAvatarUrl(id, i.user_id, size ?? 0),
        }
    },

    pickMember(id, group_id, user_id) {
        if (typeof group_id !== "string")
            group_id = String(group_id)
        if (typeof user_id !== "string")
            user_id = String(user_id)
        else if (user_id.startsWith("qg_"))
            return this.pickGuildMember(id, group_id, user_id)
        const i = {
            ...Bot[id].fl.get(user_id),
            ...Bot[id].gml.get(group_id)?.get(user_id),
            self_id: id,
            bot: Bot[id],
            user_id: user_id.replace(`${id}${this.sep}`, ""),
            group_id: group_id.replace(`${id}${this.sep}`, ""),
            platform: "QQ-group-member"
        }
        return {
            ...this.pickFriend(id, user_id),
            ...i,
            // 成员权限判断（icqq兼容）：读gml缓存的role，成员发言事件会持续更新
            get is_owner() { return i.role === "owner" },
            get is_admin() { return ["admin", "owner"].includes(i.role) },
            getInfo: (force = false) =>{ // 兼容
                if (!force){
                    let data = i.bot.fl.get(i.group_id)?.get(i.user_id)
                    if (data && data.nickname) return data
                }
                return i.bot.sdk.getGroupMemberInfo(i.group_id, i.user_id)
            },
            getGroupMemberInfo: () => i.bot.sdk.getGroupMemberInfo(i.group_id, i.user_id),
            kickGroupMember: (add_to_member_blacklist = false) => i.bot.sdk.kickGroupMembers(i.group_id, [i.user_id], add_to_member_blacklist),
            getAvatarUrl: size => this.getAvatarUrl(id, i.user_id, size ?? 0),
            muteGroupMember: (seconds) => {
                Bot.makeLog(
                    "info",
                    `禁言群成员：${seconds}秒`,
                    `${i.self_id} => ${i.group_id}, ${i.user_id}`,
                    true,
                )
                // 0秒=解禁，走del操作
                if (seconds !== undefined && seconds <= 0)
                    return i.bot.sdk.muteGroupMember(i.group_id, "del", [i.user_id]);
                if (seconds === undefined) {
                    seconds = 120;
                }
                let end_time = this.rfc3339CN(seconds)
                return i.bot.sdk.muteGroupMember(i.group_id, "update", [i.user_id], end_time);
            },
            unmuteGroupMember: () => {
                Bot.makeLog(
                    "info",
                    `解除群成员禁言：`,
                    `${i.self_id} => ${i.group_id}, ${i.user_id}`,
                    true,
                )
                return i.bot.sdk.muteGroupMember(i.group_id, "del", [i.user_id]);
            },
            mute: (seconds) => {
                Bot.makeLog(
                    "info",
                    `禁言群成员：${seconds}秒`,
                    `${i.self_id} => ${i.group_id}, ${i.user_id}`,
                    true,
                )
                // 0秒=解禁，走del操作
                if (seconds !== undefined && seconds <= 0)
                    return i.bot.sdk.muteGroupMember(i.group_id, "del", [i.user_id]);
                if (seconds === undefined) {
                    seconds = 120;
                }
                let end_time = this.rfc3339CN(seconds)
                return i.bot.sdk.muteGroupMember(i.group_id, "update", [i.user_id], end_time);
            }, // 同步野鸡方法
            unmute: () => {
                Bot.makeLog(
                    "info",
                    `解除群成员禁言：`,
                    `${i.self_id} => ${i.group_id}, ${i.user_id}`,
                    true,
                )
                return i.bot.sdk.muteGroupMember(i.group_id, "del", [i.user_id]);
            }, // 同步野鸡方法
            approveRequest: (join_request_id) => {
                Bot.makeLog(
                    "info",
                    `同意入群申请：`,
                    `${i.self_id} => ${i.group_id}, ${i.user_id}`,
                    true,
                )
                return i.bot.sdk.approvalGroupRequest(i.group_id, i.user_id, "approve", join_request_id)
            },
            declineRequest: (join_request_id, reject_reason = "", add_to_member_blacklist = false) => {
                Bot.makeLog(
                    "info",
                    `拒绝入群申请：`,
                    `${i.self_id} => ${i.group_id}, ${i.user_id}`,
                    true,
                )
                return i.bot.sdk.approvalGroupRequest(i.group_id, i.user_id, "decline", join_request_id, reject_reason, add_to_member_blacklist)
            }
        }
    },

    pickGroup(id, group_id) {
        if (typeof group_id !== "string")
            group_id = String(group_id)
        else if (group_id.startsWith("qg_"))
            return this.pickGuild(id, group_id)
        const i = {
            ...Bot[id].gl.get(group_id),
            self_id: id,
            bot: Bot[id],
            group_id: group_id.replace(`${id}${this.sep}`, ""),
            platform: "QQ-group"
        }
        return {
            ...i,
            // Bot权限判断（icqq兼容）：官方群管API服务端会校验真实权限，这里读缓存用于前置判断，
            // 过期/未预热时后台刷新，本次用旧值，最坏首条命令误判、第二条恢复
            get is_owner() { return getCachedBotRole(id, i.group_id) === "owner" },
            get is_admin() { return ["admin", "owner"].includes(getCachedBotRole(id, i.group_id)) },
            sendMsg: msg => this.sendGroupMsg(i, msg),
            recallMsg: message_id => this.recallGroupMsg(i, message_id),
            getInfo: (force = false) => {
                if (!force){
                    let data = i.bot.gl.get(i.group_id)
                    if (data && data.group_name) return data
                }
                return i.bot.sdk.getGroupInfo(i.group_id)
            },
            getAvatarUrl: () => `https://q.qlogo.cn/g?b=qq&nk=1&s=100`, // 暂时占位
            pickMember: user_id => this.pickMember(id, group_id, user_id),
            getMemberMap: () => i.bot.gml.get(group_id),
            // 从本地消息存储查回消息（引用撤回等依赖）
            getMsg: async message_id => this.getStoredMsg("group", group_id, message_id),
            getGroupMemberList: (cursor = undefined) => {
                i.bot.sdk.getGroupMemberList(i.group_id, cursor)
            },
            getMemberList: (cursor = undefined) => {
                i.bot.sdk.getGroupMemberList(i.group_id, cursor)
            }, // 兼容野鸡
            getGroupMemberInfo: user_id => i.bot.sdk.getGroupMemberInfo(i.group_id, user_id),
            getGroupInfo: () => i.bot.sdk.getGroupInfo(i.group_id),
            //getInfo: () => i.bot.sdk.getGroupInfo(i.group_id), // 同步野鸡方法
            getBotStatus: () => i.bot.sdk.getGroupBotInfo(i.group_id),
            kickGroupMembers: (user_ids, add_to_member_blacklist = false) => {
                if (typeof user_ids === 'string') user_ids = [user_ids]
                i.bot.sdk.kickGroupMembers(i.group_id, user_ids.map(item => item.replace(`${id}${this.sep}`, "")), add_to_member_blacklist)
            },
            // icqq 兼容：group.kickMember(qq, 拉黑)
            kickMember: (user_id, add_to_member_blacklist = false) => {
                Bot.makeLog(
                    "info",
                    `踢出群成员：`,
                    `${i.self_id} => ${i.group_id}, ${user_id}${add_to_member_blacklist ? "（同时拉黑）" : ""}`,
                    true,
                )
                return i.bot.sdk.kickGroupMembers(i.group_id, [user_id.replace(`${id}${this.sep}`, "")], add_to_member_blacklist)
            },
            muteGroupMember: (user_id, seconds) => {
                Bot.makeLog(
                    "info",
                    `禁言群成员：${seconds}秒`,
                    `${i.self_id} => ${i.group_id}, ${user_id}`,
                    true,
                )
                // 0秒=解禁，走del操作（icqq语义：muteMember(qq, 0)为解除禁言）
                if (seconds !== undefined && seconds <= 0)
                    return i.bot.sdk.muteGroupMember(i.group_id, "del", [user_id.replace(`${id}${this.sep}`, "")]);
                if (seconds === undefined) {
                    seconds = 120;
                }
                let end_time = this.rfc3339CN(seconds)
                return i.bot.sdk.muteGroupMember(i.group_id, "update", [user_id.replace(`${id}${this.sep}`, "")], end_time);
            },
            unmuteGroupMember: (user_id) => {
                Bot.makeLog(
                    "info",
                    `解除群成员禁言：`,
                    `${i.self_id} => ${i.group_id}, ${user_id}`,
                    true,
                )
                return i.bot.sdk.muteGroupMember(i.group_id, "del", [user_id.replace(`${id}${this.sep}`, "")]);
            },
            muteMember: (user_id, seconds) => {
                Bot.makeLog(
                    "info",
                    `禁言群成员：${seconds}秒`,
                    `${i.self_id} => ${i.group_id}, ${user_id}`,
                    true,
                )
                // 0秒=解禁，走del操作（icqq语义：muteMember(qq, 0)为解除禁言）
                if (seconds !== undefined && seconds <= 0)
                    return i.bot.sdk.muteGroupMember(i.group_id, "del", [user_id.replace(`${id}${this.sep}`, "")]);
                if (seconds === undefined) {
                    seconds = 120;
                }
                let end_time = this.rfc3339CN(seconds)
                return i.bot.sdk.muteGroupMember(i.group_id, "update", [user_id.replace(`${id}${this.sep}`, "")], end_time);
            }, // 同步野鸡方法
            unmuteMember: (user_id) => {
                Bot.makeLog(
                    "info",
                    `解除群成员禁言：`,
                    `${i.self_id} => ${i.group_id}, ${user_id}`,
                    true,
                )
                return i.bot.sdk.muteGroupMember(i.group_id, "del", [user_id.replace(`${id}${this.sep}`, "")]);
            }, // 同步野鸡方法
            muteGroupMembers: (userlist, seconds) => {
                Bot.makeLog(
                    "info",
                    `禁言群成员：${seconds}秒`,
                    `${i.self_id} => ${i.group_id}, ${userlist.join("、")}`,
                    true,
                )
                // 0秒=解禁，走del操作
                if (seconds !== undefined && seconds <= 0)
                    return i.bot.sdk.muteGroupMember(i.group_id, "del", userlist.map(item => item.replace(`${id}${this.sep}`, "")));
                if (seconds === undefined) {
                    seconds = 120;
                }
                let end_time = this.rfc3339CN(seconds)
                return i.bot.sdk.muteGroupMember(i.group_id, "update", userlist.map(item => item.replace(`${id}${this.sep}`, "")), end_time);
            },
            unmuteGroupMembers: (userlist) => {
                Bot.makeLog(
                    "info",
                    `解除群成员禁言：`,
                    `${i.self_id} => ${i.group_id}, ${userlist.join("、")}`,
                    true,
                )
                return i.bot.sdk.muteGroupMember(i.group_id, "del", userlist.map(item => item.replace(`${id}${this.sep}`, "")));
            },
            getGroupmuteState: () => {
                return i.bot.sdk.getGroupmuteState(i.group_id);
            },
            approveRequest: (user_id, join_request_id) => {
                Bot.makeLog(
                    "info",
                    `同意入群申请：`,
                    `${i.self_id} => ${i.group_id}, ${user_id}`,
                    true,
                )
                return i.bot.sdk.approvalGroupRequest(i.group_id, user_id.replace(`${id}${this.sep}`, ""), "approve", join_request_id)
            },
            declineRequest: (user_id, join_request_id, reject_reason = "", add_to_member_blacklist = false) => {
                Bot.makeLog(
                    "info",
                    `拒绝入群申请：`,
                    `${i.self_id} => ${i.group_id}, ${user_id}`,
                    true,
                )
                return i.bot.sdk.approvalGroupRequest(i.group_id, user_id.replace(`${id}${this.sep}`, ""), "decline", join_request_id, reject_reason, add_to_member_blacklist)
            },
            getGroupRequestList: () => {
                return i.bot.sdk.getGroupRequestList(i.group_id)
            },
            getGroupMemberBlackList: () => i.bot.sdk.getGroupMemberBlackList(i.group_id),
            addGroupMemberBlackList: (member_openids) => {
                if (typeof member_openids === 'string') member_openids = [member_openids]
                return i.bot.sdk.changeGroupMemberBlackList(i.group_id, 'add', member_openids.map(item => item.replace(`${id}${this.sep}`, "")))
            },
            delGroupMemberBlackList: (member_openids) => {
                if (typeof member_openids === 'string') member_openids = [member_openids]
                return i.bot.sdk.changeGroupMemberBlackList(i.group_id, 'del', member_openids.map(item => item.replace(`${id}${this.sep}`, "")))
            }
        }
    },

    pickGuildFriend(id, user_id) {
        const i = {
            ...Bot[id].fl.get(user_id),
            self_id: id,
            bot: Bot[id],
            user_id: user_id.replace(/^qg_/, ""),
            platform: "guild-private"
        }
        return {
            ...i,
            sendMsg: msg => this.sendDirectMsg(i, msg),
            recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
        }
    },

    pickGuildMember(id, group_id, user_id) {
        const guild_id = group_id.replace(/^qg_/, "").split("-")
        const i = {
            ...Bot[id].fl.get(user_id),
            ...Bot[id].gml.get(group_id)?.get(user_id),
            self_id: id,
            bot: Bot[id],
            src_guild_id: guild_id[0],
            src_channel_id: guild_id[1],
            user_id: user_id.replace(/^qg_/, ""),
            platform: "guild-channel-member"
        }
        return {
            ...this.pickGuildFriend(id, user_id),
            ...i,
            sendMsg: msg => this.sendDirectMsg(i, msg),
            recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
        }
    },

    pickGuild(id, group_id) {
        const guild_id = group_id.replace(/^qg_/, "").split("-")
        const i = {
            ...Bot[id].gl.get(group_id),
            self_id: id,
            bot: Bot[id],
            guild_id: guild_id[0],
            channel_id: guild_id[1],
            platform: "guild-channel"
        }
        return {
            ...i,
            sendMsg: msg => this.sendGuildMsg(i, msg),
            getInfo: () => {
                return i.bot.sdk.getGuildInfo(i.guild_id)
            },
            getChannelList: () => {
                return i.bot.sdk.getChannelList(i.guild_id)
            },
            getMemberList: () => {
                return i.bot.sdk.getGuildMemberList(i.guild_id)
            },
            recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
            pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
            getMemberMap: () => i.bot.gml.get(group_id),
        }
    },

    async makeFriendMessage(data, event) {
        let user = await data.bot.fl.get(`${data.self_id}${this.sep}${event.sender.user_id}`)
        data.sender = {
            user_id: `${data.self_id}${this.sep}${event.sender.user_id}`,
            bot: event.author?.bot,
            nickname: event.sender.user_name || user?.nickname || "",
            avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${event.sender.user_id}/0`,
            unionid: event.author?.union_openid || user?.unionid || "",
            openid: event.sender?.user_id || user?.openid || "",
        }
        Bot.makeLog("info", `好友消息：[U:${data.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

        for (const item of event.message_scene.ext) {
            const eqIndex = item.indexOf("=")
            if (eqIndex === -1) {
                logger.info(`${item} 非kv标准跳过`)
                continue
            }

            const key = item.slice(0, eqIndex)
            const value = item.slice(eqIndex + 1)
            if (blacklist.has(key)) {
                logger.info(`${item} 由于 ${key} 有风险被过滤`)
            } else {
                data[key] = value;
            }
        }

        data.msg_elements = event.msg_elements || []

        data.platform = "QQ-private"

        // 引用消息：换算被引用消息ID并注入reply段
        await this.resolveRefMessage(data)

        // 记录被动回复锚点：sendFile 等不经过事件对象的发送通道由 fixPassiveSource 回退使用
        ;(data.bot._passiveAnchor ||= {})[`user:${event.sender.user_id}`] = {
            id: data.message_id,
            event_id: data.event_id,
            time: Date.now(),
        }

        data.reply = msg => this.sendFriendMsg({
            ...data, user_id: event.sender.user_id,
        }, msg, { id: data.message_id, event_id: data.event_id })

        data.getGenerateUrl = callback_data => data.bot.sdk.getGenerateUrl(callback_data)
        data.sendInputNotify = input_second => data.bot.sdk.sendFriendInputNotify(data.openid, 1, input_second || 30, data.message_id)

        await this.setFriendMap(data)
        // 好友资料同步进用户缓存，好友删除后仍可查昵称头像
        await this.setUserMap(data)
    },

    async makeGroupMessage(data, event) {
        data.sender = {
            user_id: `${data.self_id}${this.sep}${event.sender.user_id}`,
            bot: event.author?.bot,
            nickname: event.sender.user_name,
            avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${event.sender.user_id}/0`,
            unionid: event.author?.union_openid || "",
            openid: event.sender?.user_id || "",
            role: event.author?.member_role || "member",
        }
        data.group_id = `${data.self_id}${this.sep}${event.group_id}`

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

        // 预热Bot群内角色缓存（TTL内仅一次API调用），供群管命令的 group.is_admin/is_owner 前置判断
        this.getBotRole(data.self_id, event.group_id)?.catch?.(() => {})

        Bot.makeLog("info", `群消息：[G:${data.group_name}(${data.group_id}), U:${data.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

        for (const item of event.message_scene.ext) {
            const eqIndex = item.indexOf("=")
            if (eqIndex === -1) {
                logger.info(`${item} 非kv标准跳过`)
                continue
            }

            const key = item.slice(0, eqIndex)
            const value = item.slice(eqIndex + 1)
            if (blacklist.has(key)) {
                logger.info(`${item} 由于 ${key} 有风险被过滤`)
            } else {
                data[key] = value;
            }
        }

        data.msg_elements = event.msg_elements || []

        data.reply_user = event.msg_elements?.[0]?.author || {}

        data.mentions = event.mentions || []

        // 引用消息：换算被引用消息ID并注入reply段
        await this.resolveRefMessage(data)

        const atUser = data.mentions.find(m => !m.bot) ?? data.mentions.at(-1) ?? null;

        data.at = atUser?.member_openid && !atUser?.is_you ? `${data.self_id}${this.sep}${atUser.member_openid}` : null;

        data.atall = data.mentions.some(m => m.scope === "all")
        data.atme = !!atUser?.is_you
        data.atBot = !!atUser?.bot

        if (!config.bot_openid[data.self_id]) {
            let me = data.mentions.find(m => m.is_you)
            if (me?.member_openid) {
                config.bot_openid[data.self_id] = me.member_openid
                await configSave()
            }
        }

        if (config.bot_openid[data.self_id]) {
            data.bot_openid = config.bot_openid[data.self_id]
        }
        data.getBotInfo = config.bot_openid[data.self_id]
            ? async () => {
                return await data.bot.sdk.getGroupMemberInfo(data.group_id.split(this.sep)[1], config.bot_openid[data.self_id])
            }
            : async () => {
                logger.error("当前未记录bot的openid，在全量群艾特机器人后会自动记录")
                return {}
            }

        data.platform = "QQ-group"

        // 记录被动回复锚点：sendFile 等不经过事件对象的发送通道由 fixPassiveSource 回退使用
        ;(data.bot._passiveAnchor ||= {})[`group:${event.group_id}`] = {
            id: data.message_id,
            event_id: data.event_id,
            time: Date.now(),
        }

        data.reply = msg => this.sendGroupMsg({
            ...data, group_id: event.group_id,
        }, msg, { id: data.message_id })

        if (data.raw_event?.t === "GROUP_AT_MESSAGE_CREATE") data.message.unshift({ type: "at", qq: data.self_id })

        data.getGenerateUrl = callback_data => data.bot.sdk.getGenerateUrl(callback_data)

        await this.setGroupMap(data)
        // 群消息发送者不是好友：官方Bot只有用户主动添加(C2C)才算好友，没有临时会话机制。
        // 写入fl会让yenai/状态面板把所有@过机器人的成员都算成好友（好友数虚高），
        // 这里只更新用户资料缓存users（退群后gml被删，仍可查昵称头像）
        await this.setUserMap({ bot: data.bot, user_id: data.user_id, sender: data.sender })
    },

    async makeDirectMessage(data, event) {
        data.sender = {
            ...data.bot.fl.get(`qg_${event.sender.user_id}`),
            ...event.sender,
            user_id: `qg_${event.sender.user_id}`,
            bot: event.author?.bot,
            nickname: event.sender.user_name,
            avatar: event.author.avatar,
            guild_id: event.guild_id,
            channel_id: event.channel_id,
            src_guild_id: event.src_guild_id,
            unionid: event.author?.union_openid || "",
            openid: event.sender?.user_id
        }
        Bot.makeLog("info", `频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

        data.platform = "guild-private"

        data.reply = msg => this.sendDirectMsg({
            ...data,
            user_id: event.user_id,
            guild_id: event.guild_id,
            channel_id: event.channel_id,
        }, msg, { id: data.message_id })
        await this.setFriendMap(data)
    },

    async makeGuildMessage(data, event) {
        data.message_type = "group"
        data.sender = {
            ...data.bot.fl.get(`qg_${event.sender.user_id}`),
            ...event.sender,
            user_id: `qg_${event.sender.user_id}`,
            bot: event.author?.bot,
            nickname: event.sender.user_name,
            card: event.member.nick,
            avatar: event.author.avatar,
            src_guild_id: event.guild_id,
            src_channel_id: event.channel_id,
            unionid: event.author?.union_openid || "",
            openid: event.sender?.user_id
        }
        data.group_id = `qg_${event.guild_id}-${event.channel_id}`

        data.platform = "guild-channel"

        Bot.makeLog("info", `频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
        data.reply = msg => this.sendGuildMsg({
            ...data,
            guild_id: event.guild_id,
            channel_id: event.channel_id,
        }, msg, { id: data.message_id })
        await this.setFriendMap(data)
        await this.setGroupMap(data)
    },

    async setFriendMap(data) {
        if (!data.user_id) return
        await data.bot.fl.set(data.user_id, {
            ...data.bot.fl.get(data.user_id),
            ...data.sender,
            // 好友标记：所有进好友表的路径都是真实好友事件（C2C消息/好友按钮/FRIEND_ADD/C2C发送成功），
            // 启动清理时凭此保留，避免"添加后从未发言"的好友被当作群成员误清
            friend: true,
        })
    },

    // 用户资料缓存：记录所有交互过用户的资料（含退群成员与历史群成员），
    // 供退群提示、面板昵称头像等兜底查询；与fl(真实好友)分离，不影响好友计数
    async setUserMap(data) {
        if (!data.user_id) return
        await data.bot.users?.set(data.user_id, {
            ...data.bot.users?.get(data.user_id),
            ...data.sender,
            user_id: data.user_id,
        })
    },

    async setGroupMap(data) {
        if (!data.group_id) return
        await data.bot.gl.set(data.group_id, {
            ...data.bot.gl.get(data.group_id),
            ...data.group_data,
            group_id: data.group_id,
            group_name: data.group_name || "",
        })
        let gml = data.bot.gml.get(data.group_id)
        if (!gml) {
            gml = new Map
            await data.bot.gml.set(data.group_id, gml)
        }
        await gml.set(data.user_id, {
            ...gml.get(data.user_id),
            ...data.sender,
        })
    },

    async delGroupMember(data) {
        if (!data.group_id || !data.user_id) return;

        const gml = data.bot.gml.get(data.group_id);
        if (!gml) return;

        await gml.delete(data.user_id);
    }
}
