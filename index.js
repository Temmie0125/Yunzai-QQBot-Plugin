logger.info(logger.yellow("- 正在加载 QQBot 适配器插件"))

import makeConfig from "../../lib/plugins/config.js"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from 'node:crypto'
import YAML from "yaml"
import QRCode from "qrcode"
import { initGroupInfoMap, fetchGroupInfo } from "./lib/groupInfo.js"
import { ulid } from "ulid"
import imageSize from "image-size"
import urlRegexSafe from "url-regex-safe"
import { encode as encodeSilk, isSilk } from "silk-wasm"
import { Bot as QQBot } from "@windtrace/qq-group-bot"
import { fileURLToPath } from 'url'
const { config, configSave } = await makeConfig("QQBot", {
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
    rawButton: {},
    markdown: {
        template: {},
    },
    bot: {
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
    ],
})

let sharp
if (config.imageLength) try {
    sharp = (await import("sharp")).default
} catch (err) {
    Bot.makeLog("error", ["sharp 导入错误，图片压缩关闭", err], "QQBot-Plugin")
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await fs.readFile(__dirname + '/package.json'))
import { cleanupMediaFiles, compressImage } from './lib/media.js'
import { saveMessage, saveSentMessage } from './lib/message.js'
import { saveNotice } from './lib/notice.js'
import { loadBlacklist, isGroupBlacklisted, isUserBlacklisted, blacklistGroup, unblacklistGroup, blacklistUser, unblacklistUser, extractOpenid } from './lib/blacklist.js'
import { msgSequelize } from './model/init.js'
import MessageDB from './model/MessageDB.js'
import MsgIdxDB from './model/MsgIdxDB.js'
import ActiveListDB from './model/ActiveListDB.js'

await msgSequelize.sync()

// SQLite 手动补齐新增列（sync() 不会 ALTER 已有表）
try {
  await msgSequelize.query("ALTER TABLE messages ADD COLUMN bot_nickname TEXT DEFAULT ''")
} catch (e) {
  // 列已存在时忽略
  if (!e.message?.includes('duplicate column')) logger.debug('[QQBot] bot_nickname 列已存在')
}

await loadBlacklist()

Bot.MessageDB = MessageDB
Bot.MsgIdxDB = MsgIdxDB
Bot.ActiveListDB = ActiveListDB
const adapter = new class QQBotAdapter {
    constructor() {
        this.id = "QQBot"
        this.name = "QQBot"
        this.path = "data/QQBot/"
        this.version = `@windtrace/qq-group-bot v${pkg.dependencies['@windtrace/qq-group-bot']}`

        this.sep = ":"
        this.bind_user = {}
        this.appid = {}
        this.config = config
    }

    async makeRecord(file) {
        if (config.toBotUpload) {
            // 缓存第一个支持 uploadRecord 的 bot，避免每次遍历
            if (!this._uploadRecordBot) {
                for (const i of Bot.uin) {
                    if (Bot[i]?.uploadRecord) { this._uploadRecordBot = i; break }
                }
            }
            if (this._uploadRecordBot) {
                try {
                    const url = await Bot[this._uploadRecordBot].uploadRecord(file)
                    if (url) return url
                } catch (err) {
                    Bot.makeLog("error", ["Bot", this._uploadRecordBot, "语音上传错误", file, err])
                    this._uploadRecordBot = null // 失败后重新查找
                }
            }
        }
        const buffer = await Bot.Buffer(file)
        if (!Buffer.isBuffer(buffer)) return file
        if (isSilk(buffer)) return buffer

        const convFile = path.join("temp", ulid())
        try {
            await fs.writeFile(convFile, buffer)
            await Bot.exec(`ffmpeg -i "${convFile}" -f s16le -ar 48000 -ac 1 "${convFile}.pcm"`)
            file = Buffer.from((await encodeSilk(await fs.readFile(`${convFile}.pcm`), 48000)).data)
        } catch (err) {
            Bot.makeLog("error", ["silk 转码错误", file, err])
        }

        for (const i of [convFile, `${convFile}.pcm`])
            fs.unlink(i).catch(() => {})

        return file
    }

    async makeQRCode(data) {
        return (await QRCode.toDataURL(data)).replace("data:image/png;base64,", "base64://")
    }

    async makeRawMarkdownText(data, text, button) {
        return text//.replace(/@/g, "@​")
    }

    async makeBotImage(file) {
        if (config.toBotUpload) {
            if (!this._uploadImageBot) {
                for (const i of Bot.uin) {
                    if (Bot[i]?.uploadImage) { this._uploadImageBot = i; break }
                }
            }
            if (this._uploadImageBot) {
                try {
                    const image = await Bot[this._uploadImageBot].uploadImage(file)
                    if (image.url) return image
                } catch (err) {
                    Bot.makeLog("error", ["Bot", this._uploadImageBot, "图片上传错误", file, err])
                    this._uploadImageBot = null
                }
            }
        }
    }

    async makeMarkdownImage(data, _file) {
        const file = _file.url || _file.file
        const buffer = await Bot.Buffer(file)
        const image = await this.makeBotImage(buffer) ||
            { url: typeof Bot.imageToUrl === 'function' ? await Bot.imageToUrl(file) : await Bot.fileToUrl(file) }

        image.width = _file.width || null
        image.height = _file.height || null
        if (!image.width || !image.height) try {
            const size = imageSize(buffer)
            image.width = size.width
            image.height = size.height
        } catch (err) {
            Bot.makeLog("error", ["图片分辨率检测错误", file, err], data.self_id)
        }

        let summary = _file.summary || '图片'
        summary = /[<>\[\]()]/.test(summary) ? '图片' : summary
        return {
            des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
            url: `(${image.url})`,
        }
    }

    makeButton(data, button) {
        const msg = {
            id: ulid(),
            render_data: {
                label: button.text,
                visited_label: button.clicked_text,
                style: button.style || 1,
                ...button.QQBot?.render_data,
            }
        }

        if (button.input)
            msg.action = {
                type: 2,
                permission: { type: 2 },
                data: button.input,
                enter: button.send,
                reply: button.reply || false,
                ...button.QQBot?.action,
            }
        else if (button.callback) {
            if (config.toCallback || button.toCallback) {
                msg.action = {
                    type: 1,
                    permission: { type: 2 },
                    data: button.callback,
                    reply: button.reply || false,
                    ...button.QQBot?.action,
                }
                if (!Array.isArray(data._ret_id))
                    data._ret_id = []
            } else {
                msg.action = {
                    type: 2,
                    permission: { type: 2 },
                    data: button.callback,
                    enter: true,
                    reply: button.reply || false,
                    ...button.QQBot?.action,
                }
            }
        } else if (button.link)
            msg.action = {
                type: 0,
                permission: { type: 2 },
                data: button.link,
                ...button.QQBot?.action,
            }
        else return false

        if(button.content || button.confirm_text || button.cancel_text){
            msg.action.modal = {
                content: button.content || '是否确认操作?',
                confirm_text: button.confirm_text || '是',
                cancel_text: button.cancel_text || '否'
            }
        }

        if (button.permission) {
            if (button.permission === "admin") {
                msg.action.permission.type = 1
            } else {
                msg.action.permission.type = 0
                msg.action.permission.specify_user_ids = []
                if (!Array.isArray(button.permission))
                    button.permission = [button.permission]
                for (const id of button.permission)
                    msg.action.permission.specify_user_ids.push(id.replace(`${data.self_id}${this.sep}`, ""))
            }
        }
        return msg
    }

    makeButtons(data, button_square) {
        const msgs = []
        for (const button_row of button_square) {
            const buttons = []
            for (let button of button_row) {
                button = this.makeButton(data, button)
                if (button) buttons.push(button)
            }
            if (buttons.length)
                msgs.push({ type: "button", buttons })
        }
        return msgs
    }

    async btntocmd(btns) {
        return '\r***\r' + [btns]
            .filter(btn => btn)
            .flatMap(btn => btn.data)
            .map(line => '\r' + line.map(item =>
                item.link && item.link.startsWith('https://qun.qq.com/') ? `[🔗${item.text}](${item.link})` : `[${item.text}](mqqapi://aio/inlinecmd?command=${item.callback ? encodeURIComponent(item.callback) : item.input ? encodeURIComponent(item.input) : item.link ? item.link : '' }${item.send || item.callback ? '&enter=true' : '&enter=false'}&reply=${item.reply ? 'true' : 'false'})`//`<qqbot-cmd-input text="${item.input || item.link}" show="${item.text}" reference="false" />`
            ).join(' | '))
            .join('');
    }

    async makeRawMarkdownMsg(data, msg) {
        const messages = [], button = [], keyboard = []
        let content = "", reply

        const msgArray = Array.isArray(msg) ? msg : [msg]
        const imagePromises = []
        const imageIndices = []

        for (let idx = 0; idx < msgArray.length; idx++) {
            let i = msgArray[idx]
            if (typeof i === "object") i = { ...i }
            else i = { type: "text", text: Bot.String(i) }

            if (i.type === "image") {
                imageIndices.push(idx)
                imagePromises.push(this.makeMarkdownImage(data, i.file ? i : i.data))
            }
        }

        let imageResults = []
        if (imagePromises.length > 0) {
            try {
                imageResults = await Promise.all(imagePromises)
            } catch (error) {
                console.error('并行处理图片时出错:', error)
                for (let j = 0; j < imagePromises.length; j++) {
                try {
                    const result = await this.makeMarkdownImage(
                    data,
                    msgArray[imageIndices[j]].file ? msgArray[imageIndices[j]] : msgArray[imageIndices[j]].data
                    )
                    imageResults.push(result)
                } catch (err) {
                    console.error(`处理第${j+1}张图片失败:`, err)
                    imageResults.push({ des: `![图片加载失败]`, url: `()` })
                }
                }
            }
        }

        let imageIndex = 0
        for (let idx = 0; idx < msgArray.length; idx++) {
            let i = msgArray[idx]
            if (typeof i === "object") i = { ...i }
            else i = { type: "text", text: Bot.String(i) }

            if (i.type === "image" && imageResults[imageIndex]) {
                const { des, url } = imageResults[imageIndex]
                content += `${des}${url}`
                imageIndex++
                continue
            }

            switch (i.type) {
                case "voice":
                case "record":
                    i.type = "audio"
                    i.file = await this.makeRecord(i.file)
                case "video":
                case "face":
                case "ark":
                case "embed":
                case "file":
                    messages.push([i])
                    break
                case "at":
                    if (i.qq === "all")
                        content += "@everyone"
                    else
                        content += data.platform.startsWith('QQ') ? `<@${String(i.qq).split(this.sep)[1] || i.qq}>` : `<@${String(i.qq).split('_')[1] || i.qq}>`
                    break
                case "text":
                    content += await this.makeRawMarkdownText(data, i.text, button)
                    break
                /*case "image": {
                    const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
                    content += `${des}${url}`
                    break
                } */case "markdown":
                    if (typeof i.data === "object")
                        messages.push([{ type: "markdown", ...i.data }])
                    else
                        content += i.data
                    break
                case "button":
                    if(config.rawButton[data.self_id] !== 'false' && data.platform.startsWith('QQ')) button.push(...this.makeButtons(data, i.data))
                    else content += await this.btntocmd(i)
                    break
                case "reply":
                    if (i.id.startsWith("event_"))
                        reply = { type: "reply", event_id: i.id.replace(/^event_/, "") }
                    else
                        reply = i
                    continue
                case "node":
                    for (const { message } of i.data)
                        messages.push(...(await this.makeRawMarkdownMsg(data, message)))
                    continue
                case "raw":
                    messages.push(Array.isArray(i.data) ? i.data : [i.data])
                    break
                case "keyboard":
                    if (Array.isArray(i.data)) {
                        keyboard.push(...i.data.filter(Boolean))
                    } else {
                        keyboard.push(i);
                    }
                    break
                case "stream":
                    data.stream = true
                    data.chunkSize = i.data?.chunkSize ?? config.chunkSize
                    data.delay = i.data?.delay ?? config.delay
                    break
                case "small":
                    data.smallbtn = true
                    continue
                default:
                    content += await this.makeRawMarkdownText(data, Bot.String(i), button)
            }
        }

        if(config.smallbtn) data.smallbtn = true

        if (content)
            messages.unshift([{ type: "markdown", content }])

        if (keyboard.length){
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...keyboard)
            }
        }

        if (button.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...button.splice(0,5))
                if (!button.length) break
            }
            while (button.length)
                messages.push([
                    { type: "markdown", content: " " },
                    ...button.splice(0,5),
                ])
        }

        if (reply) for (const i in messages) {
            if (Array.isArray(messages[i]))
                messages[i].unshift(reply)
            else
                messages[i] = [reply, messages[i]]
        }
        return messages
    }

    makeMarkdownText_(data, text, button) {
        return text.replace(/\n/g, "\r")//.replace(/@/g, "@​")
    }

    makeMarkdownText(data, text, content, button) {
        const match = text.match(/!?\[.*?\]\s*\(\w+:\/\/.*?\)/g)
        if (match) {
            const temp = []
            let last = ""
            for (const i of match) {
                const match = i.match(/(!?\[.*?\])\s*(\(\w+:\/\/.*?\))/)
                text = text.split(i)
                temp.push([last+this.makeMarkdownText_(data, text.shift(), button), match[1]])
                text = text.join(i)
                last = match[2]
            }
            temp[0][0] = content + temp[0][0]
            return [last+this.makeMarkdownText_(data, text, button), temp]
        }
        return [this.makeMarkdownText_(data, text, button)]
    }

    makeMarkdownTemplate(data, templates) {
        const msgs = []
        for (const template of templates) {
            if (!template.length) continue

            const params = []
            for (const i in template)
                params.push({
                    key: config.markdown.template[data.self_id][i],
                    values: [template[i]],
                })

            msgs.push([{
                type: "markdown",
                custom_template_id: config.markdown[data.self_id],
                params,
            }])
        }
        return msgs
    }

    makeMarkdownTemplatePush(content, template, templates) {
        for (const i of content) {
            if (template.length === config.markdown.template[data.self_id].length-1) {
                template.push(i.shift())
                template = i
                templates.push(template)
            } else {
                template.push(i.join(""))
            }
        }
        return template
    }

    async makeMarkdownMsg(data, msg) {
        const messages = [], button = [], templates = [[]], keyboard = []
        let content = "", reply, template = templates[0]

        const msgArray = Array.isArray(msg) ? msg : [msg]
        const imagePromises = []
        const imageIndices = []

        for (let idx = 0; idx < msgArray.length; idx++) {
            let i = msgArray[idx]
            if (typeof i === "object") i = { ...i }
            else i = { type: "text", text: Bot.String(i) }

            if (i.type === "image") {
                imageIndices.push(idx)
                imagePromises.push(this.makeMarkdownImage(data, i.file ? i : i.data))
            }
        }

        let imageResults = []
        if (imagePromises.length > 0) {
            try {
                imageResults = await Promise.all(imagePromises)
            } catch (error) {
                console.error('并行处理图片时出错:', error)
                for (let j = 0; j < imagePromises.length; j++) {
                try {
                    const result = await this.makeMarkdownImage(
                    data,
                    msgArray[imageIndices[j]].file ? msgArray[imageIndices[j]] : msgArray[imageIndices[j]].data
                    )
                    imageResults.push(result)
                } catch (err) {
                    console.error(`处理第${j+1}张图片失败:`, err)
                    imageResults.push({ des: `![图片加载失败]`, url: `()` })
                }
                }
            }
        }

        let imageIndex = 0
        for (let idx = 0; idx < msgArray.length; idx++) {
            let i = msgArray[idx]
            if (typeof i === "object") i = { ...i }
            else i = { type: "text", text: Bot.String(i) }

            if (i.type === "image" && imageResults[imageIndex]) {
                const { des, url } = imageResults[imageIndex]
                content += `${des}${url}`
                imageIndex++
                continue
            }

            switch (i.type) {
                case "voice":
                case "record":
                    i.type = "audio"
                    i.file = await this.makeRecord(i.file)
                case "video":
                case "face":
                case "ark":
                case "embed":
                case "file":
                    messages.push([i])
                    break
                case "at":
                    if (i.qq === "all")
                        content += "@everyone"
                    else
                        content += data.platform.startsWith('QQ') ? `<@${String(i.qq).split(this.sep)[1] || i.qq}>` : `<@${String(i.qq).split('_')[1] || i.qq}>`
                    break
                case "text": {
                    const [text, temp] = this.makeMarkdownText(data, i.text, content, button)
                    if (Array.isArray(temp)) {
                        template = this.makeMarkdownTemplatePush(temp, template, templates)
                        content = text
                    } else {
                        content += text
                    }
                    break
                } case "image": {
                    const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
                    template = this.makeMarkdownTemplatePush([[content, des]], template, templates)
                    content = url
                    break
                } case "markdown":
                    if (typeof i.data === "object")
                        messages.push([{ type: "markdown", ...i.data }])
                    else
                        content += i.data
                    break
                case "button":
                    if(config.rawButton[data.self_id] !== 'false' && data.platform.startsWith('QQ')) button.push(...this.makeButtons(data, i.data))
                    else content += await this.btntocmd(i)
                    break
                case "reply":
                    if (i.id.startsWith("event_"))
                        reply = { type: "reply", event_id: i.id.replace(/^event_/, "") }
                    else
                        reply = i
                    continue
                case "node":
                    for (const { message } of i.data)
                        messages.push(...(await this.makeMarkdownMsg(data, message)))
                    continue
                case "raw":
                    messages.push(Array.isArray(i.data) ? i.data : [i.data])
                    break
                case "keyboard":
                    if (Array.isArray(i.data)) {
                        keyboard.push(...i.data.filter(Boolean))
                    } else {
                        keyboard.push(i);
                    }
                    break
                case "stream":
                    data.stream = true
                    data.chunkSize = i.data?.chunkSize ?? config.chunkSize
                    data.delay = i.data?.delay ?? config.delay
                    break
                case "small":
                    data.smallbtn = true
                    continue
                default: {
                    const [text, temp] = this.makeMarkdownText(data, Bot.String(i), content, button)
                    if (Array.isArray(temp)) {
                        template = this.makeMarkdownTemplatePush(temp, template, templates)
                        content = text
                    } else {
                        content += text
                    }
                }
            }
        }

        if(config.smallbtn) data.smallbtn = true

        if (content)
            template.push(content)
        messages.push(...this.makeMarkdownTemplate(data, templates))


        if (keyboard.length){
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...keyboard)
            }
        }

        if (button.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...button.splice(0,5))
                if (!button.length) break
            }
            while (button.length)
                messages.push([
                    ...this.makeMarkdownTemplate(data, [[" "]])[0],
                    ...button.splice(0,5),
                ])
        }

        if (reply) for (const i of messages)
            i.unshift(reply)
        return messages
    }

    async makeMsg(data, msg) {
        const messages = [], button = []
        let message = [], reply

        for (let i of Array.isArray(msg) ? msg : [msg]) {
            if (typeof i === "object")
                i = { ...i }
            else
                i = { type: "text", text: Bot.String(i) }

            switch (i.type) {
                case "at":
                    //i.user_id = i.qq?.replace?.(`${data.self_id}${this.sep}`, "")
                    continue
                case "text":
                    if (!i.text || !i.text.trim()) continue
                    break
                case "face":
                case "ark":
                case "embed":
                    break
                case "voice":
                case "record":
                    i.type = "audio"
                    i.file = await this.makeRecord(i.file)
                case "video":
                    if (message.length) {
                        messages.push(message)
                        message = []
                    }
                    break
                case "image":
                    if (sharp && i.file)
                        i.file = await compressImage(data, i.file, this.config, sharp)
                    break
                case "file":
                    messages.push([i])
                    break
                case "reply":
                    if (i.id.startsWith("event_"))
                        reply = { type: "reply", event_id: i.id.replace(/^event_/, "") }
                    else
                        reply = i
                    continue
                case "markdown":
                    if (typeof i.data === "object")
                        i = { type: "markdown", ...i.data }
                    else
                        i = { type: "markdown", content: i.data }
                    break
                case "button":
                    //button.push(...this.makeButtons(data, i.data))
                    continue
                case "node":
                    for (const { message } of i.data)
                        messages.push(...(await this.makeMsg(data, message)))
                    continue
                case "raw":
                    if (Array.isArray(i.data)) {
                        messages.push(i.data)
                        continue
                    }
                    i = i.data
                    break
                case "stream":
                    data.stream = true
                    data.chunkSize = i.data?.chunkSize ?? config.chunkSize
                    data.delay = i.data?.delay ?? config.delay
                    break
                default:
                    i = { type: "text", text: Bot.String(i) }
            }

            message.push(i)
        }

        if (message.length)
            messages.push(message)

        while (button.length)
            messages.push([{
                type: "keyboard",
                content: { rows: button.splice(0,5) },
            }])

        if (reply) for (const i of messages)
            i.unshift(reply)
        return messages
    }

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
                    if (Bot.autoRecordMessage === true) await saveSentMessage(data, segs, ret)
                } catch (err) {
                    Bot.makeLog("error", ["发送消息错误", segs, err], data.self_id)
                    rets.error.push(err)
                    return pending
                }
            }
            return []
        }

        let messages = Array.isArray(msg) ? msg : [msg]

        if(config.markdown[data.self_id] === 'legacy'){
            msgs = await this.makeMsg(data, msg)
        } else {
            msgs = data.legacy || (messages.length === 1 && messages[0].type === 'image' && data.event_id?.startsWith('INTERACTION_CREATE')) ? await this.makeMsg(data, msg) : await this.makeRawMarkdownMsg(data, msg)
        }

        let pending = await sendMsg(msgs)
        if (pending.length > 0) {
            // 第二次：只重试失败的消息
            pending = await sendMsg(pending)

            if (pending.length > 0) {
                // 第三次：切换格式，重建全部消息再发
                if (config.markdown[data.self_id] && config.markdown[data.self_id] !== 'legacy' && config.markdown[data.self_id] !== 'raw') {
                    msgs = typeof Bot.makeMarkdownMsg === 'function' ? await Bot.makeMarkdownMsg(data, msg) : await this.makeMarkdownMsg(data, msg)
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
    }

    sendFriendMsg(data, msg, event) {
        if(data.smallbtn) event.smallbtn = true
        return this.sendMsg(data, msg => {
            if(data.smallbtn) event.smallbtn = true
            return data.bot.sdk.sendPrivateMessage(data.user_id, msg, event,{ stream: config.stream || data.stream ? true : false, chunkSize: data.chunkSize || config.chunkSize, delay: data.delay || config.delay })
        }, msg)
    }

    sendGroupMsg(data, msg, event) {
        return this.sendMsg(data, msg => {
            if(data.smallbtn) event.smallbtn = true
            return data.bot.sdk.sendGroupMessage(data.group_id, msg, event)
        }, msg)
    }

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
    }

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
        }}

        if (config.markdown[data.self_id] === "raw")
            msgs = await this.makeRawMarkdownMsg(data, msg)
        else if (config.markdown[data.self_id] === "legacy" || !config.markdown[data.self_id])
            msgs = await this.makeMsg(data, msg)
        else
            msgs = typeof Bot.makeMarkdownMsg === 'function' ? await Bot.makeMarkdownMsg(data, msg) : await this.makeMarkdownMsg(data, msg)
        

        if (await sendMsg() === false) {
            msgs = await this.makeGuildMsg(data, msg)
            await sendMsg()
        }
        return rets
    }

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
    }

    sendGuildMsg(data, msg, event) {
        return this.sendGMsg(data, msg => data.bot.sdk.sendGuildMessage(data.channel_id, msg, event), msg)
    }

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
    }

    recallFriendMsg(data, message_id) {
        Bot.makeLog("info", `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallPrivateMessage(data.user_id, i), message_id)
    }

    recallGroupMsg(data, message_id) {
        Bot.makeLog("info", `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallGroupMessage(data.group_id, i), message_id)
    }

    recallDirectMsg(data, message_id, hide = config.hideGuildRecall) {
        Bot.makeLog("info", `撤回${hide?"并隐藏":""}频道私聊消息：[${data.guild_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide), message_id)
    }

    recallGuildMsg(data, message_id, hide = config.hideGuildRecall) {
        Bot.makeLog("info", `撤回${hide?"并隐藏":""}频道消息：[${data.channel_id}] ${message_id}`, data.self_id)
        return this.recallMsg(data, i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide), message_id)
    }

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
            platform: 'QQ-private'
        }
        return {
            ...i,
            sendMsg: msg => this.sendFriendMsg(i, msg),
            recallMsg: message_id => this.recallFriendMsg(i, message_id),
            getAvatarUrl: () => `https://q.qlogo.cn/qqapp/${i.bot.info.appid}/${i.user_id}/0`,
        }
    }

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
            platform: 'QQ-group-member'
        }
        return {
            ...this.pickFriend(id, user_id),
            ...i,
            getGroupMemberInfo: () => i.bot.sdk.getGroupMemberInfo(i.group_id, i.user_id)
        }
    }

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
            platform: 'QQ-group'
        }
        return {
            ...i,
            sendMsg: msg => this.sendGroupMsg(i, msg),
            recallMsg: message_id => this.recallGroupMsg(i, message_id),
            pickMember: user_id => this.pickMember(id, group_id, user_id),
            getMemberMap: () => i.bot.gml.get(group_id),
        }
    }

    pickGuildFriend(id, user_id) {
        const i = {
            ...Bot[id].fl.get(user_id),
            self_id: id,
            bot: Bot[id],
            user_id: user_id.replace(/^qg_/, ""),
            platform: 'guild-private'
        }
        return {
            ...i,
            sendMsg: msg => this.sendDirectMsg(i, msg),
            recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
        }
    }

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
            platform: 'guild-channel-member'
        }
        return {
            ...this.pickGuildFriend(id, user_id),
            ...i,
            sendMsg: msg => this.sendDirectMsg(i, msg),
            recallMsg: (message_id, hide) => this.recallDirectMsg(i, message_id, hide),
        }
    }

    pickGuild(id, group_id) {
        const guild_id = group_id.replace(/^qg_/, "").split("-")
        const i = {
            ...Bot[id].gl.get(group_id),
            self_id: id,
            bot: Bot[id],
            guild_id: guild_id[0],
            channel_id: guild_id[1],
            platform: 'guild-channel'
        }
        return {
            ...i,
            sendMsg: msg => this.sendGuildMsg(i, msg),
            recallMsg: (message_id, hide) => this.recallGuildMsg(i, message_id, hide),
            pickMember: user_id => this.pickGuildMember(id, group_id, user_id),
            getMemberMap: () => i.bot.gml.get(group_id),
        }
    }

    async makeFriendMessage(data, event) {
        let user = await data.bot.fl.get(`${data.self_id}${this.sep}${event.sender.user_id}`)
        data.sender = {
            user_id: `${data.self_id}${this.sep}${event.sender.user_id}`,
            bot: event.author?.bot,
            nickname: event.sender.user_name || user?.nickname || '',
            avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${event.sender.user_id}/0`,
            unionid: event.author?.union_openid || user?.unionid || '',
            openid: event.sender?.user_id || user?.openid || '',
        }
        Bot.makeLog("info", `好友消息：[U:${data.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

        for (const item of event.message_scene.ext){
            if (item.startsWith("ref_msg_idx=")) {
                data.ref_msg_idx = item.slice("ref_msg_idx=".length);
            } else if (item.startsWith("msg_idx=")) {
                data.msg_idx = item.slice("msg_idx=".length);
            }
        }

        data.msg_elements = event.msg_elements || []

        data.platform = 'QQ-private'

        data.reply = msg => this.sendFriendMsg({
            ...data, user_id: event.sender.user_id,
        }, msg, { id: data.message_id, event_id: data.event_id })

        data.getGenerateUrl = callback_data => data.bot.sdk.getGenerateUrl(callback_data)
        data.sendInputNotify = input_second => data.bot.sdk.sendFriendInputNotify(data.openid, 1, input_second || 30, data.message_id)

        await this.setFriendMap(data)
    }

    async makeGroupMessage(data, event) {
        data.sender = {
            user_id: `${data.self_id}${this.sep}${event.sender.user_id}`,
            bot: event.author?.bot,
            nickname: event.sender.user_name,
            avatar: `https://q.qlogo.cn/qqapp/${data.bot.info.appid}/${event.sender.user_id}/0`,
            unionid: event.author?.union_openid || '',
            openid: event.sender?.user_id || '',
            role: event.author?.member_role || 'member',
        }
        data.group_id = `${data.self_id}${this.sep}${event.group_id}`
        Bot.makeLog("info", `群消息：[G:${data.group_id}, U:${data.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

        for (const item of event.message_scene.ext){
            if (item.startsWith("ref_msg_idx=")) {
                data.ref_msg_idx = item.slice("ref_msg_idx=".length);
            } else if (item.startsWith("msg_idx=")) {
                data.msg_idx = item.slice("msg_idx=".length);
            }
        }

        data.msg_elements = event.msg_elements || []

        data.reply_user = event.msg_elements?.[0]?.author || {}

        data.mentions = event.mentions || [];

        const atUser = data.mentions.find(m => !m.bot) ?? data.mentions.at(-1) ?? null;

        data.at = atUser?.member_openid ? `${data.self_id}${this.sep}${atUser.member_openid}` : null;

        data.atall = data.mentions.some(m => m.scope === 'all')
        data.atme = !!atUser?.is_you
        data.atbot = !!atUser?.bot

        if (!config.bot_openid[data.self_id]) {
            let me = data.mentions.find(m => m.is_you)
            if(me?.member_openid){
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
                logger.error('当前未记录bot的openid，在全量群艾特机器人后会自动记录')
                return {}
            }

        data.platform = 'QQ-group'

        data.reply = msg => this.sendGroupMsg({
            ...data, group_id: event.group_id,
        }, msg, { id: data.message_id })
        
        if(data.raw_event?.t === 'GROUP_AT_MESSAGE_CREATE') data.message.unshift({ type: "at", qq: data.self_id })

        data.getGenerateUrl = callback_data => data.bot.sdk.getGenerateUrl(callback_data)

        await this.setGroupMap(data)
        let fldata = {
            bot: data.bot,
            user_id: data.user_id,
            sender: JSON.parse(JSON.stringify(data.sender))
        }
        delete fldata.sender.role
        await this.setFriendMap(fldata)
    }

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
            unionid: event.author?.union_openid || '',
            openid: event.sender?.user_id
        }
        Bot.makeLog("info", `频道私聊消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

        data.reply = msg => this.sendDirectMsg({
            ...data,
            user_id: event.user_id,
            guild_id: event.guild_id,
            channel_id: event.channel_id,
        }, msg, { id: data.message_id })
        await this.setFriendMap(data)
    }

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
            unionid: event.author?.union_openid || '',
            openid: event.sender?.user_id
        }
        data.group_id = `qg_${event.guild_id}-${event.channel_id}`
        Bot.makeLog("info", `频道消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
        data.reply = msg => this.sendGuildMsg({
            ...data,
            guild_id: event.guild_id,
            channel_id: event.channel_id,
        }, msg, { id: data.message_id })
        await this.setFriendMap(data)
        await this.setGroupMap(data)
    }

    async setFriendMap(data) {
        if (!data.user_id) return
        await data.bot.fl.set(data.user_id, {
            ...data.bot.fl.get(data.user_id),
            ...data.sender,
        })
    }

    async setGroupMap(data) {
        if (!data.group_id) return
        await data.bot.gl.set(data.group_id, {
            ...data.bot.gl.get(data.group_id),
            group_id: data.group_id,
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
    }

    async delGroupMember(data) {
        if (!data.group_id || !data.user_id) return;

        const gml = data.bot.gml.get(data.group_id);
        if (!gml) return;

        await gml.delete(data.user_id);
    }

    // ====== 黑名单辅助（在 Bot.em 前调用） ======
    _checkBlacklist(data) {
        if (data.group_id && isGroupBlacklisted(data.group_id)) return true
        const unionid = data.sender?.unionid || data.unionid || ''
        if (isUserBlacklisted(data.user_id, unionid)) return true
        return false
    }

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
                    i.qq = `${data.self_id}${this.sep}${i.user_id}`
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
        if(event.author?.bot && config.filter_bot_msg) {
            logger.debug(`过滤bot信息,event:${JSON.stringify(event,null,2)}`)
            return true
        }
        if(data.mentions && config.filter_only_at_other_bot){
            if (data.atbot && !data.atme) {
                logger.debug(`过滤纯艾特其他bot信息,event:${JSON.stringify(event,null,2)}`)
                return true
            }
        }

        // 黑名单拦截（在 Bot.em 下发事件前）
        if (this._checkBlacklist(data)) return

        Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
    }

    async makeCallback(id, event) {
        const reply = event.reply.bind(event)
        event.reply = async (...args) => { try {
            return await reply(...args)
        } catch (err) {
            Bot.makeLog("debug", ["回复按钮点击事件错误", err], data.self_id)
        }}

        if (event.data.type === 2002 || event.data.type === 2001) return

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
            set avatar(newAvatar) {this.sender.avatar=newAvatar},
            sender: { 
                user_id: `${id}${this.sep}${event.operator_id}`,
                bot: event.author?.bot || user?.bot || false,
                avatar: `https://q.qlogo.cn/qqapp/${Bot[id].info.appid}/${event.operator_id}/0`,
                unionid: event.union_openid || user?.unionid || '',
                openid: event.operator_id || user?.openid || '',
                nickname: event.user_name || user?.nickname || ''
            },
            message: [{ type: "text", text: event.data?.resolved?.button_data || '' }],
            raw_message: event.data?.resolved?.button_data || '',
            platform: `QQ-${event.notice_type === 'group' ? "group" : "private"}`,
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
                data.sender.role = event.author?.member_role || user?.role || 'member'
                //await redis.set(`wind-group-event_id:${data.self_id}${this.sep}${event.group_id}`,event.event_id,{ EX:300 })
                Bot.makeLog("info", [`群按钮点击事件：[G:${data.group_id}, U:${data.nickname}(${data.user_id})]`, data.raw_message], data.self_id)

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
    }

    async makeaudit(event){
        if (!event?.audit_id) return
        switch(event.raw.t){
            case 'MESSAGE_AUDIT_PASS':
                await redis.set(`wind-audit-message_id:${event.audit_id}`,JSON.stringify({success:true,id:event.message_id,raw_event:event.raw}),{EX:30*24*60*60})
                break
            case 'MESSAGE_AUDIT_REJECT':
                await redis.set(`wind-audit-message_id:${event.audit_id}`,JSON.stringify({success:false,raw_event:event.raw}),{EX:30*24*60*60})
                break
            default:
                break
        }
    }

    makeNotice(id, event) {
        let data = {
            user_id: event.user_id ? id + this.sep + event.user_id : id + this.sep + event.operator_id,
            openid: event.user_id ? event.user_id : event.operator_id,
            avatar: `https://q.qlogo.cn/qqapp/${Bot[id].info.appid}/${event.user_id ? event.user_id : event.operator_id}/0`,
            event_id: event.event_id,
            raw: event,
            raw_event: event.raw,
            bot: Bot[id],
            self_id: id,
            post_type: event.post_type,
            notice_type: event.notice_type,
            sub_type: event.sub_type,
            notice_id: event.notice_id,
            platform: 'QQ-notice',
            time: event.timestamp || Math.floor(Date.now() / 1000),
        }
        
        const userInfo = Bot[id].fl.get(data.user_id)
        data.nickname = userInfo?.nickname || data.openid || '未知'
        data.unionid = userInfo?.unionid || ''

        if(data.notice_type === 'friend') {
            data.reply = msg => this.sendFriendMsg({
            ...data, user_id: event.user_id,
            }, msg, { event_id: data.event_id })
        }
        if(data.notice_type === 'group') {
            data.group_id = data.self_id + this.sep + event.group_id
            data.reply = msg => this.sendGroupMsg({
            ...data, group_id: event.group_id,
            }, msg, { event_id: data.event_id })
        }
        if (data.notice_type === 'guild'){
            data.user_id = event.user_id ? 'qg_' + event.user_id : 'qg_' + event.operator_id
            data.platform = 'guild-notice'
        }

        switch (data.sub_type) {
            case "audit":
                return this.makeaudit(event)
            case "action":
                return this.makeCallback(id, event)
            case "increase":{
                if(data.notice_type !== 'guild') {
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
            case "decrease":{
                if(data.notice_type !== 'guild') {
                    this.delGroupMember(data)
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                }
                break
            }
            case "add":
            case "del":
                if(data.notice_type !== 'guild') {
                    if (Bot.autoRecordMessage === true) saveNotice(data)
                }
                break
            case "update":
            case "member.increase":
            case "member.decrease":
            case "member.update":
                break
            default:
                Bot.makeLog("warn", ["未知通知", event], id)
                return
        }

        // 黑名单拦截（在 Bot.em 下发事件前）
        if (this._checkBlacklist(data)) return
        Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
    }

    getFriendMap(id) {
        return Bot.getMap(`${this.path}${id}/Friend`)
    }

    getGroupMap(id) {
        return Bot.getMap(`${this.path}${id}/Group`)
    }

    getMemberMap(id) {
        return Bot.getMap(`${this.path}${id}/Member`)
    }

    async connect(token) {
        token = token.split(":")
        const id = token[0]
        const opts = {
            ...config.bot,
            appid: token[1],
            token: token[2],
            secret: token[3],
            intents: [
                "GUILDS",
                "GUILD_MEMBERS",
                "GUILD_MESSAGE_REACTIONS",
                "DIRECT_MESSAGE",
                "INTERACTION",
                "MESSAGE_AUDIT",
            ],
        }

        if (Number(token[4]))
            opts.intents.push("GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE", "GROUP_MEMBER")

        if (Number(token[5]))
            opts.intents.push("GUILD_MESSAGES")
        else
            opts.intents.push("PUBLIC_GUILD_MESSAGES")

        Bot[id] = {
            adapter: this,
            sdk: new QQBot(opts),
            login() { return new Promise(resolve => {
                this.sdk.sessionManager.once("READY", resolve)
                this.sdk.start()
            })},
            logout() { return new Promise(resolve => {
                this.sdk.ws.once("close", resolve)
                this.sdk.stop()
            })},

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
            stat: { start_time: Date.now()/1000 },

            pickFriend: user_id => this.pickFriend(id, user_id),
            get pickUser() { return this.pickFriend },
            getFriendMap() { return this.fl },
            fl: await this.getFriendMap(id),

            pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
            pickGroup: group_id => this.pickGroup(id, group_id),
            getGroupMap() { return this.gl },
            gl: await this.getGroupMap(id),
            gml: await this.getMemberMap(id),

            callback: {},
        }

        Bot[id].sdk.logger = {}
        for (const i of ["trace", "debug", "info", "mark", "warn", "error", "fatal"])
            Bot[id].sdk.logger[i] = (...args) => {
                if (args[0]?.startsWith?.("recv from")) return
                return Bot.makeLog(i, args, id)
            }

        try {
            if (token[4] === "2") {
                await Bot[id].sdk.sessionManager.getAccessToken()
                Bot[id].login = () => this.appid[opts.appid] = Bot[id]
                Bot[id].logout = () => delete this.appid[opts.appid]
            }

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
    }

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
    }

    makeWebHook(req) {
        const appid = req.headers["x-bot-appid"]
        if (!(appid in this.appid))
            return Bot.makeLog("warn", "找不到对应 QQBot", appid)
        if ("plain_token" in req.body?.d)
            return this.makeWebHookSign(this.appid[appid].uin, req, this.appid[appid].info.secret)
        if ("t" in req.body)
            this.appid[appid].sdk.dispatchEvent(req.body.t, req.body)
        req.res.sendStatus(200)
    }

    async load() {
        Bot.express.use(`/${this.name}`, this.makeWebHook.bind(this))
        Bot.express.quiet.push(`/${this.name}`)
        for (const token of config.token)
            await Bot.sleep(5000, this.connect(token))

        await initGroupInfoMap()

        // 无 token 时自动启动扫码登录
        if (!config.token.length) {
            this._autoQrLogin().catch(err => {
                logger.error(`[QQBot] 自动扫码登录失败: ${err.message}`)
            })
        }
    }

    async _autoQrLogin() {
        const { taskId, key } = await _qrCreateBindTask()
        const qrUrl = QR_URL_TPL.replace('{task_id}', taskId)
        const qrText = await QRCode.toString(qrUrl, { type: 'terminal', small: true })
        logger.mark(`\n======== QQBot 未配置任何账号，正在生成扫码登录二维码 ========\n${qrText}\n可使用手机 QQ 扫码登录 QQBot，或打开链接：\n${qrUrl}\n注意：此种方法登录会自动重置登录Bot的secret，请自行决定是否使用\n`)

        const bindData = await _qrPollBindResult(taskId)
        if (!bindData) {
            logger.warn('扫码登录超时，可稍后通过 #QQBot扫码登录 重新发起')
            return
        }

        const secret = _qrDecryptSecret(bindData.bot_encrypt_secret, key)
        const uin = await _qrGetRobotUin(bindData.bot_appid)
        if (!uin) {
            logger.error('获取机器人 uin 失败')
            return
        }

        const uinStr = String(uin)
        const newToken = `${uinStr}:${bindData.bot_appid}:default占位:${secret}:1:0`
        config.token.push(newToken)
        await configSave()

        await this.connect(newToken)
        logger.mark(`QQBot ${uinStr} 扫码登录并连接成功`)
    }
}

Bot.adapter.push(adapter)

// QR 扫码登录相关常量
const PORTAL_HOST = 'q.qq.com'
const CREATE_PATH = '/lite/create_bind_task'
const POLL_PATH = '/lite/poll_bind_result'
const QR_URL_TPL = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=windtrace'
const SHARE_INFO_URL = 'https://qun.qq.com/cgi-bin/group_pro/robot/manager/share_info'
const BKN = 508459323
const QR_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': 'windtrace/1.0',
    'X-Source': 'windtrace',
}

// QR 扫码登录核心函数（模块级，供 adapter 和 plugin class 共用）
async function _qrCreateBindTask() {
    const key = crypto.randomBytes(32).toString('base64')
    const res = await fetch(`https://${PORTAL_HOST}${CREATE_PATH}`, {
        method: 'POST',
        headers: QR_HEADERS,
        body: JSON.stringify({ key }),
    })
    const json = await res.json()
    if (json.retcode !== 0) throw new Error(json.msg || '创建绑定任务失败')
    return { taskId: json.data.task_id, key }
}

async function _qrPollBindResult(taskId) {
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const res = await fetch(`https://${PORTAL_HOST}${POLL_PATH}`, {
            method: 'POST',
            headers: QR_HEADERS,
            body: JSON.stringify({ task_id: taskId }),
        })
        const json = await res.json()
        if (json.retcode !== 0) continue
        if (json.data.status === 2) return json.data
        if (json.data.status === 3) return null
    }
    return null
}

function _qrDecryptSecret(cipherBase64, keyBase64) {
    const buf = Buffer.from(cipherBase64, 'base64')
    const key = Buffer.from(keyBase64, 'base64')
    const nonce = buf.subarray(0, 12)
    const tag = buf.subarray(-16)
    const cipher = buf.subarray(12, -16)

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return decipher.update(cipher, undefined, 'utf8') + decipher.final('utf8')
}

async function _qrGetRobotUin(appId) {
    const res = await fetch(`${SHARE_INFO_URL}?bkn=${BKN}&robot_appid=${appId}`)
    const json = await res.json()
    return json?.data?.robot_data?.robot_uin
}

export class QQBotAdapter extends plugin {
    constructor() {
        super({
            name: "QQBotAdapter",
            dsc: "QQBot 适配器设置",
            event: "message",
            task: { name: "QQBot媒体文件清理", cron: "0 3 * * *", fnc: () => cleanupMediaFiles() },
            rule: [
                {
                    reg: "^#[Qq]+[Bb]ot账号$",
                    fnc: "List",
                    permission: config.permission,
                },
                {
                    reg: "^#[Qq]+[Bb]ot设置[0-9]+:[0-9]+:.+:.+:([01]:[01]|2)$",
                    fnc: "Token",
                    permission: config.permission,
                },
                {
                    reg: "^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?\\d+:([^:]+(:.+)?)",
                    fnc: "Markdown",
                    permission: config.permission,
                },
                {
                    reg: "^#[Qq]+[Bb]ot绑定用户.+$",
                    fnc: "BindUser",
                },
                {
                    reg: "^#[Rr][Aa][Ww][Bb][Uu][Tt][Tt][Oo][Nn]\\d+(?::(true|false))?$",
                    fnc: "rawButton",
                    permission: config.permission,
                },
                {
                    reg: '^#(开启|关闭)野收官发$',
                    fnc: 'turn_fakemsg',
                    permission: config.permission,
                },
                {
                    reg: '^#(开启|关闭)([Bb][Oo][Tt]|机器人)(消息)?过滤$',
                    fnc: 'turn_filter_bot',
                    permission: config.permission,
                },
                {
                    reg: '^#(开启|关闭)纯(艾特|[Aa][Tt])其他([Bb][Oo][Tt]|机器人)过滤$',
                    fnc: 'turn_filter_onlyother_bot',
                    permission: config.permission,
                },
                {
                    reg: '^#拉黑用户',
                    fnc: 'cmdBlacklistUser',
                    permission: 'master',
                },
                {
                    reg: '^#取消拉黑用户',
                    fnc: 'cmdUnblacklistUser',
                    permission: 'master',
                },
                {
                    reg: '^#拉黑群聊',
                    fnc: 'cmdBlacklistGroup',
                    permission: 'master',
                },
                {
                    reg: '^#取消拉黑群聊',
                    fnc: 'cmdUnblacklistGroup',
                    permission: 'master',
                },
                {
                    reg: '^#群号绑定\\d+',
                    fnc: 'cmdBindGroupQQ',
                    permission: 'master',
                },
                {
                    reg: '^#取消群号绑定$',
                    fnc: 'cmdUnbindGroupQQ',
                    permission: 'master',
                },
                {
                    reg: '^#QQBot(扫码)?登录$',
                    fnc: 'qrlogin',
                    permission: 'master',
                },
            ]
        })
    }
    async turn_filter_onlyother_bot(e){
        if(e.msg.includes('开启')){
            config.filter_only_at_other_bot = true
            await configSave()
            return this.reply('开启纯艾特其他bot消息过滤成功')
        }
        if(e.msg.includes('关闭')){
            config.filter_only_at_other_bot = false
            await configSave()
            return this.reply('关闭纯艾特其他bot消息过滤成功')
        }
        return this.reply('修改失败')
    }
    async turn_filter_bot(e){
      if(e.msg.includes('开启')){
        config.filter_bot_msg = true
        await configSave()
        return this.reply('开启bot消息过滤成功')
      }
      if(e.msg.includes('关闭')){
        config.filter_bot_msg = false
        await configSave()
        return this.reply('关闭bot消息过滤成功')
      }
      return this.reply('修改失败')
    }

    async turn_fakemsg(e){
      if(e.msg.includes('开启')){
        config.fakemsg = true
        await configSave()
        return this.reply('开启野收官发成功')
      }
      if(e.msg.includes('关闭')){
        config.fakemsg = false
        await configSave()
        return this.reply('关闭野收官发成功')
      }
      return this.reply('修改失败')
    }

    async rawButton(){
        const token = this.e.msg.replace(/^#rawButton/, "").trim()
        const bot_id = token.split(':')[0]
        if (!bot_id) return this.reply('请输入正确的指令\r例#rawButton285888888:true,#rawButton285888888:false')
        if(token[1] && token[1] === 'false') {
            config.rawButton[bot_id] = false
            await configSave()
            return this.reply(`设置成功${bot_id}的rawButton为false`)
        }
        config.rawButton[bot_id] = true
        await configSave()
        return this.reply(`设置成功${bot_id}的rawButton为true`)
    }

    List() {
        this.reply(`共${config.token.length}个账号：\n${config.token.join("\n")}`, true)
    }

    async Token() {
        const token = this.e.msg.replace(/^#[Qq]+[Bb]ot设置/, "").trim()
        if (config.token.includes(token)) {
            config.token = config.token.filter(item => item !== token)
            this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
        } else {
            if (await adapter.connect(token)) {
                config.token.push(token)
                this.reply(`账号已连接，共${config.token.length}个账号`, true)
            } else {
                this.reply(`账号连接失败`, true)
                return false
            }
        }
        await configSave()
    }

    async Markdown() {
        let token = this.e.msg.replace(/^#[Qq]+[Bb]ot[Mm](ark)?[Dd](own)?/, "").trim().split(":")
        if(token.length < 2) return this.reply('添加错误,格式如下\r#QQBotMD机器人qq号:模板id(原生就填raw,普通就填legacy):模板参数内容(每个参数用,隔开)\r例:#QQBotMD285888888:1909831031_980983013:text0,text1,text2...,原生则为#QQBotMD285888888:raw,普通则为#QQBotMD285888888:legacy')
        const bot_id = token[0]
        const templateid = token[1]
        if(token.length !== 3 && templateid !== 'raw' && templateid !== 'legacy') return this.reply('添加错误,格式如下\r#QQBotMD机器人qq号:模板id(原生就填raw):模板参数内容(每个参数用,隔开)\r例:#QQBotMD285888888:1909831031_980983013:text0,text1,text2...,原生则为#QQBotMD285888888:raw,普通则为#QQBotMD285888888:legacy')
        let template = token[2] || ''
        template = template.replace(' ','').split(/[,，]/)
        this.reply(`Bot ${bot_id} Markdown 模板已设置为 ${templateid}\r内容为 [${template.join(',')}]`, true)
        config.markdown[bot_id] = templateid
        if(templateid !== 'raw' && templateid !== 'legacy') config.markdown.template[bot_id] = template
        await configSave()
    }

    BindUser() {
        const id = this.e.msg.replace(/^#[Qq]+[Bb]ot绑定用户(确认)?/, "").trim()
        if (id === this.e.user_id)
            return this.reply("请切换到对应Bot")

        adapter.bind_user[this.e.user_id] = id
        this.reply([
            `绑定 ${id} → ${this.e.user_id}`,
            segment.button([{
                text: "确认绑定",
                callback: `#QQBot绑定用户确认${this.e.user_id}`,
                permission: this.e.user_id,
            }])
        ])
    }

    // ====== 黑名单指令 ======
    async cmdBlacklistUser(e) {
        if (e.adapter_id !== 'QQBot') return
        let targetOpenid = ''
        if (e.at && e.at !== e.atBot && !e.msg.includes('@all')) {
            targetOpenid = extractOpenid(e.at)
        } else {
            const raw = e.msg.replace(/^#拉黑用户\s*/, '').trim()
            if (raw) targetOpenid = extractOpenid(raw)
        }
        if (!targetOpenid) return this.reply('请 @要拉黑的用户 或 输入用户 openid')
        let targetUnionid = ''
        if (e.self_id) {
            const bot = Bot[e.self_id]
            const user = bot?.fl?.get(`${e.self_id}${this.sep}${targetOpenid}`) || bot?.fl?.get(targetOpenid)
            if (user?.unionid) targetUnionid = user.unionid
        }
        await blacklistUser(`${e.self_id}${this.sep}${targetOpenid}`, targetUnionid)
        this.reply(`已拉黑用户 openid=${targetOpenid}${targetUnionid ? ` unionid=${targetUnionid}` : ''}`)
    }

    async cmdUnblacklistUser(e) {
        if (e.adapter_id !== 'QQBot') return
        let targetOpenid = ''
        if (e.at && e.at !== e.atBot && !e.msg.includes('@all')) {
            targetOpenid = extractOpenid(e.at)
        } else {
            const raw = e.msg.replace(/^#取消拉黑用户\s*/, '').trim()
            if (raw) targetOpenid = extractOpenid(raw)
        }
        if (!targetOpenid) return this.reply('请 @要取消拉黑的用户 或 输入用户 openid')
        let targetUnionid = ''
        if (e.self_id) {
            const bot = Bot[e.self_id]
            const user = bot?.fl?.get(`${e.self_id}${this.sep}${targetOpenid}`) || bot?.fl?.get(targetOpenid)
            if (user?.unionid) targetUnionid = user.unionid
        }
        await unblacklistUser(`${e.self_id}${this.sep}${targetOpenid}`, targetUnionid)
        this.reply(`已取消拉黑用户 openid=${targetOpenid}`)
    }

    async cmdBlacklistGroup(e) {
        if (e.adapter_id !== 'QQBot') return
        const raw = e.msg.replace(/^#拉黑群聊\s*/, '').trim()
        let gid = raw || e.group_id
        if (!gid) return this.reply('请在群聊中使用，或输入群 group_id')
        if (e.self_id && !gid.startsWith(`${e.self_id}${this.sep}`)) {
            gid = `${e.self_id}${this.sep}${gid}`
        }
        await blacklistGroup(gid)
        this.reply(`已拉黑群聊 ${gid}`)
    }

    async cmdUnblacklistGroup(e) {
        if (e.adapter_id !== 'QQBot') return
        const raw = e.msg.replace(/^#取消拉黑群聊\s*/, '').trim()
        let gid = raw || e.group_id
        if (!gid) return this.reply('请在群聊中使用，或输入群 group_id')
        if (e.self_id && !gid.startsWith(`${e.self_id}${this.sep}`)) {
            gid = `${e.self_id}${this.sep}${gid}`
        }
        await unblacklistGroup(gid)
        this.reply(`已取消拉黑群聊 ${gid}`)
    }

    async cmdBindGroupQQ(e) {
        if (e.adapter_id !== 'QQBot' || !e.isGroup) return
        const groupQQ = e.msg.replace(/^#群号绑定/, '').trim()
        if (!/^\d{5,12}$/.test(groupQQ)) {
            return this.reply('请输入正确的QQ群号（5-12位数字）\n示例：#群号绑定123456789')
        }
        const gid = e.group_id
        const existing = await redis.hGet('wind-group-bind', gid)
        if (existing) {
            return this.reply(`当前群已绑定QQ群号：${existing}\n如需更改请先 #取消群号绑定`)
        }
        // 检查是否已被其他群绑定
        const allBinds = await redis.hGetAll('wind-group-bind')
        const conflictGid = Object.entries(allBinds).find(([, qq]) => qq === groupQQ)?.[0]
        if (conflictGid && conflictGid !== gid) {
            return this.reply(`QQ群号 ${groupQQ} 已被其他群(${conflictGid.slice(0,11)}***)绑定，请检查群号是否正确`)
        }
        await redis.hSet('wind-group-bind', gid, groupQQ)
        // 异步拉取群信息并缓存
        fetchGroupInfo(groupQQ, adapter._napcatConfig).then(info => {
          if (info && Bot.groupInfoMap) {
            Bot.groupInfoMap.set(groupQQ, info)
            redis.set(`wind-group-info:${groupQQ}`, JSON.stringify(info))
          }
        }).catch(() => {})
        this.reply(`已绑定：当前群 ↔ QQ群 ${groupQQ}`)
    }

    async cmdUnbindGroupQQ(e) {
        if (e.adapter_id !== 'QQBot' || !e.isGroup) return
        const gid = e.group_id
        const existing = await redis.hGet('wind-group-bind', gid)
        if (!existing) return this.reply('当前群尚未绑定QQ群号')
        await redis.hDel('wind-group-bind', gid)
        // 检查是否还有其他群绑定此QQ群号，无则清除缓存
        const allBinds = await redis.hGetAll('wind-group-bind')
        if (!Object.values(allBinds).includes(existing)) {
          Bot.groupInfoMap?.delete(existing)
          await redis.del(`wind-group-info:${existing}`)
        }
        this.reply(`已取消绑定：当前群 ↔ QQ群 ${existing}`)
    }

    // ====== QR 扫码登录 ======
    async qrlogin(e) {
        if (this._qrLoginRunning) {
            return e.reply('已有扫码登录任务正在进行中，请等待完成后再试')
        }
        this._qrLoginRunning = true

        try {
            await e.reply('正在生成二维码，请稍候...')

            const { taskId, key } = await _qrCreateBindTask()
            const qrUrl = QR_URL_TPL.replace('{task_id}', taskId)

            await e.reply([
                '请使用手机 QQ 扫码或打开链接：\r',
                segment.image(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`),
                `\r链接：${qrUrl}\r>注意:使用此方法登录QQBot会自动刷新Secret，请自行留意。`,
            ])

            const bindData = await _qrPollBindResult(taskId)
            if (!bindData) {
                return e.reply('二维码已过期，请重新发起 #QQBot扫码登录')
            }

            const secret = _qrDecryptSecret(bindData.bot_encrypt_secret, key)
            const uin = await _qrGetRobotUin(bindData.bot_appid)
            if (!uin) {
                return e.reply('获取机器人 uin 失败，请检查 BKN 是否有效')
            }

            await this._saveAndConnectBot(uin, bindData.bot_appid, secret)

            return e.reply(
                [
                    '#QQBot 登录成功',
                    `UIN: ${uin}`,
                    `AppID: ${bindData.bot_appid}`,
                    `Secret: 详情见 QQBot 配置`,
                ].join('\n')
            )
        } finally {
            this._qrLoginRunning = false
        }
    }

    async _saveAndConnectBot(uin, appId, secret) {
        const uinStr = String(uin)
        const newToken = `${uinStr}:${appId}:default占位:${secret}:1:0`

        // 更新或新增 config.token
        const idx = config.token.findIndex(t => t.split(':')[0] === uinStr)
        if (idx >= 0) {
            config.token[idx] = newToken
        } else {
            config.token.push(newToken)
        }
        await configSave()

        // 热加载 Bot 实例
        if (Bot[uinStr] && Bot[uinStr].sdk?.config) {
            // 已有实例：停止旧连接，用新 secret 重新连接
            try { Bot[uinStr].sdk.stop() } catch {}
            await new Promise(r => setTimeout(r, 500))
            Bot[uinStr].sdk.config.secret = secret
            Bot[uinStr].info.secret = secret
            const sm = Bot[uinStr].sdk.sessionManager
            if (sm) {
                sm.tokenTask = null
                if (sm.tokenTimer) {
                    clearTimeout(sm.tokenTimer)
                    sm.tokenTimer = null
                }
                sm.wsUrl = null
                sm.access_token = null
                sm.fatalError = false
                sm.tokenExpired = false
                sm.userClose = false
                sm.retry = 0
                await sm.start()
            }
        } else {
            const tokenEntry = `${uinStr}:${appId}:default占位:${secret}:1:0`
            await adapter.connect(tokenEntry)
            await new Promise(r => setTimeout(r, 1000))
        }
    }
}

logger.info(logger.green("- QQBot 适配器插件 加载完成"))
