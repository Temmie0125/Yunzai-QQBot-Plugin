// 连接 / WebHook / 加载方法
import QRCode from "qrcode"
import { config, configSave } from "./context.js"
import { Bot as QQBot } from "@windtrace/qq-group-bot"
import { QR_URL_TPL, _qrCreateBindTask, _qrPollBindResult, _qrDecryptSecret, _qrGetRobotUin } from "./qr.js"

export const connectMethods = {
    getFriendMap(id) {
        return Bot.getMap(`${this.path}${id}/Friend`)
    },

    getUserMap(id) {
        return Bot.getMap(`${this.path}${id}/User`)
    },

    getGroupMap(id) {
        return Bot.getMap(`${this.path}${id}/Group`)
    },

    getMemberMap(id) {
        return Bot.getMap(`${this.path}${id}/Member`)
    },

    async connect(bot) {
        const id = String(bot.QQ)
        const opts = {
            ...config.bot,
            appid: String(bot.appid),
            secret: bot.secret,
            intents: [
                "GUILDS",
                "GUILD_MEMBERS",
                "GUILD_MESSAGE_REACTIONS",
                "DIRECT_MESSAGE",
                "INTERACTION",
                "MESSAGE_AUDIT",
            ],
        }

        if (bot.group)
            opts.intents.push("GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE", "GROUP_MEMBER")

        if (bot.private)
            opts.intents.push("GUILD_MESSAGES")
        else
            opts.intents.push("PUBLIC_GUILD_MESSAGES")

        Bot[id] = {
            adapter: this,
            sdk: new QQBot(opts),
            login() { return new Promise(resolve => {
                this.sdk.sessionManager.once("READY", resolve)
                this.sdk.start()
            }) },
            logout() { return new Promise(resolve => {
                this.sdk.ws.once("close", resolve)
                this.sdk.stop()
            }) },

            uin: id,
            info: {
                id, ...opts,
                avatar: `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`,
            },
            get nickname() { return this.info.username },
            get avatar() { return this.info.avatar },

            version: {
                id: this.id,
                name: this.name,
                version: this.version,
            },
            stat: { start_time: Date.now() / 1000 },

            pickFriend: user_id => this.pickFriend(id, user_id),
            get pickUser() { return this.pickFriend },
            getFriendMap() { return this.fl },
            fl: await this.getFriendMap(id),

            // 用户资料缓存（非好友表）：群成员/退群成员资料兜底，见 pick.js setUserMap
            users: await this.getUserMap(id),

            pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
            pickGroup: group_id => this.pickGroup(id, group_id),
            getGroupMap() { return this.gl },
            gl: await this.getGroupMap(id),
            gml: await this.getMemberMap(id),

            // 系统消息（icqq兼容）：官方Bot无好友申请审批，遍历各群返回待审批的入群申请，
            // 每项携带 approve(yes) 走官方审批接口，供 yenai-plugin 等插件的申请处理流程使用
            getSystemMsg: async () => {
                const systemMsg = []
                for (const group_id of Bot[id].gl.keys()) {
                    const gid = String(group_id).replace(`${id}${this.sep}`, "")
                    try {
                        const list = await Bot[id].sdk.getGroupRequestList(gid)
                        for (const req of list) {
                            systemMsg.push({
                                request_type: "group",
                                sub_type: "add",
                                group_id: String(group_id),
                                user_id: `${id}${this.sep}${req.member_openid}`,
                                nickname: req.username || req.nickname || "未知",
                                comment: req.verify_info?.verify_message
                                    || req.verify_info?.review_qa_list?.map(qa => `${qa.question}：${qa.answer}`).join("\n")
                                    || "",
                                flag: req.join_request_id,
                                tips: req.risk_tips || "",
                                time: req.apply_at ? Math.floor(new Date(req.apply_at).getTime() / 1000) : undefined,
                                approve: (yes = true, reject_reason = "", add_to_member_blacklist = false) =>
                                    Bot[id].sdk.approvalGroupRequest(gid, req.member_openid, yes ? "approve" : "decline", req.join_request_id, reject_reason, add_to_member_blacklist),
                            })
                        }
                    } catch (err) {
                        Bot.makeLog("debug", ["获取入群申请列表失败", err], id)
                    }
                }
                return systemMsg
            },

            callback: {},
        }

        Bot[id].sdk.logger = {}
        for (const i of ["trace", "debug", "info", "mark", "warn", "error", "fatal"])
            Bot[id].sdk.logger[i] = (...args) => {
                if (args[0]?.startsWith?.("recv from")) return
                return Bot.makeLog(i, args, id)
            }

        // 用 secret 自动获取 access_token（弃用旧的静态 token 字段）
        try {
            await Bot[id].sdk.sessionManager.getAccessToken()
        } catch (err) {
            Bot.makeLog("warn", [`${this.name}(${this.id}) ${this.version} 预获取 token 失败，连接时自动重试`, err], id)
        }

        if (bot.webhook) {
            Bot[id].login = () => this.appid[opts.appid] = Bot[id]
            Bot[id].logout = () => delete this.appid[opts.appid]
        }

        try {
            await Bot[id].login()
            Object.assign(Bot[id].info, await Bot[id].sdk.getSelfInfo())
        } catch (err) {
            Bot.makeLog("error", [`${this.name}(${this.id}) ${this.version} 连接失败`, err], id)
            return false
        }

        Bot[id].sdk.on("message", event => this.makeMessage(id, event))
        Bot[id].sdk.on("notice", event => this.makeNotice(id, event))

        Bot.makeLog("mark", `${this.name}(${this.id}) ${this.version} ${Bot[id].nickname} 已连接`, id)
        Bot.em(`connect.${id}`, { self_id: id })

        // 历史版本把所有@过机器人的群成员写进了好友表，启动时清理一次（幂等）
        this.cleanFriendMap(id).catch(err => Bot.makeLog("warn", ["好友表清理失败", err], id))
        return true
    },

    // 好友表清理：官方Bot没有好友列表API，fl全靠事件积累，历史版本把所有触发过命令的
    // 群成员都写进了fl，导致好友数虚高。真实好友的证据：fl条目带friend标记（好友事件写入）
    // 或存在C2C私聊记录（消息存储/活跃列表/推送开关）。无证据条目将资料合并进users缓存后
    // 从fl移除，不丢资料；若确是"添加后从未发言"的好友，收到任意推送(C2C发送成功)或发来
    // 消息时会自动回到好友表
    async cleanFriendMap(id) {
        const bot = Bot[id]
        if (!bot?.fl?.size) return
        let kept = 0, moved = 0
        for (const [key, info] of [...bot.fl]) {
            // 仅清理群Bot复合ID条目；qg_频道等其它键保持原语义
            if (!String(key).startsWith(`${id}${this.sep}`)) continue
            if (info?.friend || await this.hasC2CEvidence(id, key)) {
                kept++
                continue
            }
            if (info && bot.users)
                await bot.users.set(key, { ...bot.users.get(key), ...info, user_id: key })
            await bot.fl.delete(key)
            moved++
            Bot.makeLog("info", [`好友表清理：移除非好友条目 [${info?.nickname || ""}(${key})]（历史群成员误记，资料已转入用户缓存）`], id)
        }
        if (moved)
            Bot.makeLog("mark", logger.green(`好友表清理完成：移除 ${moved} 个非好友条目，保留 ${kept} 个好友`), id)
        else
            Bot.makeLog("debug", [`好友表无需清理：${kept} 个好友`], id)
    },

    // 是否存在该用户的C2C私聊记录（受消息保存天数限制，仅作历史脏数据的判据之一）
    async hasC2CEvidence(id, key) {
        try {
            if (Bot.storageBackend === "sqlite") {
                if (Bot.MessageDB) {
                    const rows = await Bot.MessageDB.getByPrivate(key, 0, 1)
                    if (rows?.length) return true
                }
                return false
            }
            const [recv, sent, active, push] = await Promise.all([
                redis.exists(`wind-msg:private:${key}`),
                redis.exists(`wind-bot-msg:private:${key}`),
                redis.zScore(`wind-active-private:${id}`, key),
                redis.sIsMember(`wind-disable-push-users:${id}`, key),
            ])
            return !!(recv || sent || active || push)
        } catch (err) {
            Bot.makeLog("warn", ["好友表清理证据检查失败，保守保留", key, err], id)
            return true
        }
    },

    async makeWebHookSign(id, req, secret) {
        const { sign } = (await import("tweetnacl")).default
        const { plain_token, event_ts } = req.body.d
        while (secret.length < 32)
            secret = secret.repeat(2).slice(0, 32)
        const signature = Buffer.from(sign.detached(
            Buffer.from(`${event_ts}${plain_token}`),
            sign.keyPair.fromSeed(Buffer.from(secret)).secretKey,
        )).toString("hex")
        Bot.makeLog("debug", ["QQBot 签名生成", { plain_token, signature }], id)
        req.res.send({ plain_token, signature })
    },

    makeWebHook(req) {
        const appid = req.headers["x-bot-appid"]
        if (!(appid in this.appid))
            return Bot.makeLog("warn", "找不到对应 QQBot", appid)
        if (req.body?.d && "plain_token" in req.body.d)
            return this.makeWebHookSign(this.appid[appid].uin, req, this.appid[appid].info.secret)
        if (req.body?.t && "t" in req.body)
            this.appid[appid].sdk.dispatchEvent(req.body.t, req.body)
        req.res.sendStatus(200)
    },

    async initDisablePushUsers() {
        if (Bot.disablePushUsers) return
        Bot.disablePushUsers = Bot.disablePushUsers || new Map()
        try {
            const cachedKeys = await redis.keys("wind-disable-push-users:*")
            for (const key of cachedKeys) {
                const qq = key.split(":")[1]
                const users = await redis.sMembers(key)
                if (users.length) {
                    try { Bot.disablePushUsers.set(qq, new Set(users)) } catch {}
                }
            }
            if (Bot.disablePushUsers.size) {
                logger.info(logger.green(`已从 Redis 加载 ${Bot.disablePushUsers.size} 个关闭推送的用户缓存信息`))
            }
        } catch {}
    },

    async load() {
        Bot.express.use(`/${this.name}`, this.makeWebHook.bind(this))
        Bot.express.quiet.push(`/${this.name}`)
        for (const bot of config.token)
            await Bot.sleep(5000, this.connect(bot))

        await this.initDisablePushUsers()

        // 无 token 时自动启动扫码登录
        if (!config.token.length) {
            this._autoQrLogin().catch(err => {
                logger.error(`[QQBot] 自动扫码登录失败: ${err.message}`)
            })
        }
    },

    async _autoQrLogin() {
        const { taskId, key } = await _qrCreateBindTask()
        const qrUrl = QR_URL_TPL.replace("{task_id}", taskId)
        const qrText = await QRCode.toString(qrUrl, { type: "terminal", small: true })
        logger.mark(`\n======== QQBot 未配置任何账号，正在生成扫码登录二维码 ========\n${qrText}\n可使用手机 QQ 扫码登录 QQBot，或打开链接：\n${qrUrl}\n注意：此种方法登录会自动重置登录Bot的secret，请自行决定是否使用\n`)

        const bindData = await _qrPollBindResult(taskId)
        if (!bindData) {
            logger.warn("扫码登录超时，可稍后通过 #QQBot扫码登录 重新发起")
            return
        }

        const secret = _qrDecryptSecret(bindData.bot_encrypt_secret, key)
        const uin = await _qrGetRobotUin(bindData.bot_appid)
        if (!uin) {
            logger.error("获取机器人 uin 失败")
            return
        }

        const uinStr = String(uin)
        const botObj = { QQ: uin, appid: bindData.bot_appid, secret, webhook: false, private: false, group: true }
        config.token.push(botObj)
        await configSave()

        await this.connect(botObj)
        logger.mark(`QQBot ${uinStr} 扫码登录并连接成功`)
    }
}
