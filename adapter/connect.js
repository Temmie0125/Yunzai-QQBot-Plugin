// 连接 / WebHook / 加载方法
import crypto from "node:crypto"
import QRCode from "qrcode"
import { config, configSave } from "./context.js"
import { Bot as QQBot } from "@windtrace/qq-group-bot"
import { QR_URL_TPL, _qrCreateBindTask, _qrPollBindResult, _qrDecryptSecret, _qrGetRobotUin } from "./qr.js"


const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const ed25519KeyCache = new Map()

function getEd25519Keys(secret) {
    let keys = ed25519KeyCache.get(secret)
    if (!keys) {
        while (secret.length < 32)
            secret = secret.repeat(2).slice(0, 32)
        const signKey = crypto.createPrivateKey({
            key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secret.slice(0, 32))]),
            format: "der", type: "pkcs8",
        })
        keys = { signKey, verifyKey: crypto.createPublicKey(signKey) }
        ed25519KeyCache.set(secret, keys)
    }
    return keys
}

export const connectMethods = {
    getFriendMap(id) {
        return Bot.getMap(`${this.path}${id}/Friend`)
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
            getFriendList: () => Bot[id].sdk.getFriendList().then((list) => list.filter(f => f.user_id)),
            getFriendArray: () => Bot[id].sdk.getFriendList(),

            pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
            pickGroup: group_id => this.pickGroup(id, group_id),
            getGroupMap() { return this.gl },
            gl: await this.getGroupMap(id),
            gml: await this.getMemberMap(id),
            getGroupList: () => Bot[id].sdk.getGroupList().then((list) => list.filter(g => g.group_id)),
            getGroupArray: () => Bot[id].sdk.getGroupList(),
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
        return true
    },

    makeWebHookSign(id, req, secret) {
        const { plain_token, event_ts } = req.body.d
        const signature = crypto.sign(
            null,
            Buffer.from(`${event_ts}${plain_token}`),
            getEd25519Keys(secret).signKey,
        ).toString("hex")
        Bot.makeLog("debug", ["QQBot 签名生成", { plain_token, signature }], id)
        req.res.send({ plain_token, signature })
    },

    verifySignature(signature, timestamp, body, secret) {
        if (!signature || !timestamp)
            return false
        const sig = Buffer.from(signature, "hex")
        
        if (sig.length !== 64 || (sig[63] & 224) !== 0)
            return false
        try {
            const message = Buffer.from(`${timestamp}${JSON.stringify(body)}`)
            return crypto.verify(null, message, getEd25519Keys(secret).verifyKey, sig)
        } catch (err) {
            Bot.makeLog("warn", ["QQBot 签名验证异常", err], "QQBot-Plugin")
            return false
        }
    },

    makeWebHook(req) {
        if (req.method !== "POST"){
            logger.warn("请求方式非法")
            return req.res.sendStatus(405)
        }

        const appid = req.headers["x-bot-appid"]
        if (!(appid in this.appid))
            return Bot.makeLog("warn", "找不到对应 QQBot", appid)
        
        const bot = this.appid[appid]
        
        const body = req.body
        if (!body || typeof body !== "object" || Array.isArray(body) || !("op" in body)) {
            Bot.makeLog("warn", "webhook 请求体格式异常", appid)
            return req.res.sendStatus(400)
        }

        if (req.body?.d && "plain_token" in req.body.d)
            return this.makeWebHookSign(bot.uin, req, bot.info.secret)
        
        const signature = req.headers["x-signature-ed25519"]
        const timestamp = req.headers["x-signature-timestamp"]

        const ts = Number(timestamp)
        if (!Number.isSafeInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
            Bot.makeLog("warn", ["签名时间戳过期或非法", timestamp], appid)
            return req.res.sendStatus(401)
        }

        if (!this.verifySignature(signature, timestamp, req.body, bot.info.secret)) {
            Bot.makeLog("warn", "签名验证失败", appid)
            return req.res.sendStatus(401)
        }
        if (req.body?.t && "t" in req.body)
            bot.sdk.dispatchEvent(req.body.t, req.body)
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