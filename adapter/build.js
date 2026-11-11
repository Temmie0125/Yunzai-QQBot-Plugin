// 消息构造方法：按钮 / Markdown / 卡片 / 图片等
import { ulid } from "ulid"
import QRCode from "qrcode"
import imageSize from "image-size"
import { encode as encodeSilk, isSilk } from "silk-wasm"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path, { sep } from "node:path"
import puppeteer from "../../../lib/puppeteer/puppeteer.js"
import { config, sharp } from "./context.js"
import { compressImage } from "../lib/media.js"

const escHtml = s =>
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

async function segImgSrc(file) {
    try {
        if (Buffer.isBuffer(file))
            return `data:image/png;base64,${file.toString("base64")}`
        const s = String(file ?? "")
        if (/^https?:\/\//.test(s) || s.startsWith("data:"))
            return s
        if (s.startsWith("base64://"))
            return `data:image/png;base64,${s.slice(9)}`
        if (s && fsSync.existsSync(s))
            return "file:///" + s.replace(/\\/g, "/")
    } catch { }
    return ""
}

export const buildMethods = {
    isMp3(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 3) return false
        return (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || buf.slice(0, 3).toString() === 'ID3'
    },

    isWav(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 12) return false
        return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WAVE'
    },

    isOgg(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 4) return false
        return buf.slice(0, 4).toString() === 'OggS'
    },

    isAmr(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 6) return false
        return buf.slice(0, 6).toString() === '#!AMR'
    },

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
        if (isSilk(buffer) || this.isMp3(buffer) || this.isWav(buffer) || this.isOgg(buffer) || this.isAmr(buffer)) {
            return buffer
        }

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
    },

    async makeQRCode(data) {
        return (await QRCode.toDataURL(data)).replace("data:image/png;base64,", "base64://")
    },

    async makeRawMarkdownText(data, text, button) {
        return text//.replace(/@/g, "@​")
    },

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
    },

    async makeMarkdownImage(data, _file) {
        const file = _file.url || _file.file
        const buffer = await Bot.Buffer(file)
        const image = await this.makeBotImage(buffer) ||
            { url: typeof Bot.imageToUrl === "function" ? await Bot.imageToUrl(file) : await Bot.fileToUrl(file) }

        image.width = _file.width || null
        image.height = _file.height || null
        if (!image.width || !image.height) try {
            const size = imageSize(buffer)
            image.width = size.width
            image.height = size.height
        } catch (err) {
            Bot.makeLog("error", ["图片分辨率检测错误", file, err], data.self_id)
        }

        let summary = _file.summary || "图片"
        summary = /[<>\[\]()]/.test(summary) ? "图片" : summary
        return {
            des: `![${summary} ${_file.scheme ? `scheme="${_file.scheme}"` : ''} #${image.width || 0}px #${image.height || 0}px]`,
            url: `(${image.url})`,
        }
    },

    makeButton(data, button) {
        const msg = {
            id: ulid(),
            ...(button.group_id && { group_id: button.group_id }),
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

        if (button.content || button.confirm_text || button.cancel_text) {
            if (button.confirm_text.length > 4) {
                logger.error("confirm_text 长度过长，已自动使用默认文本")
                button.confirm_text = "是"
            }
            if (button.cancel_text.length > 4){
                logger.error("cancel_text 长度过长，已自动使用默认文本")
                button.cancel_text = "否"
            }
            msg.action.modal = {
                content: button.content || "是否确认操作?",
                confirm_text: button.confirm_text || "是",
                cancel_text: button.cancel_text || "否"
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
    },

    makeButtons(data, button_square, buble = false) {
        const msgs = []
        if (buble) {
            const buttons = button_square
                .flat()
                .map(button => this.makeButton(data, button))
                .filter(Boolean)
                .slice(0, 3)
            if (buttons.length)
                msgs.push({ type: "buble", buttons })
            return msgs
        }
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
    },

    async btntocmd(btns) {
        return "\r***\r" + [btns]
            .filter(btn => btn)
            .flatMap(btn => btn.data)
            .map(line => "\r" + line.map(item =>
                item.link && item.link.startsWith("https://qun.qq.com/") ? `[🔗${item.text}](${item.link})` : `[${item.text}](mqqapi://aio/inlinecmd?command=${item.callback ? encodeURIComponent(item.callback) : item.input ? encodeURIComponent(item.input) : item.link ? item.link : ""}${item.send || item.callback ? "&enter=true" : "&enter=false"}&reply=${item.reply ? "true" : "false"})`//`<qqbot-cmd-input text="${item.input || item.link}" show="${item.text}" reference="false" />`
            ).join(" | "))
            .join("")
    },

    async makeRawMarkdownMsg(data, msg) {
        const messages = [], button = [], keyboard = [], buble = [], action_button = []
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
                console.error("并行处理图片时出错:", error)
                for (let j = 0; j < imagePromises.length; j++) {
                    try {
                        const result = await this.makeMarkdownImage(
                            data,
                            msgArray[imageIndices[j]].file ? msgArray[imageIndices[j]] : msgArray[imageIndices[j]].data
                        )
                        imageResults.push(result)
                    } catch (err) {
                        console.error(`处理第${j + 1}张图片失败:`, err)
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
                        content += "<qqbot-at-everyone />"
                    else
                        content += data.platform.startsWith("QQ") ? `<@${String(i.qq).split(this.sep)[1] || i.qq}>` : `<@${String(i.qq).split("_")[1] || i.qq}>`
                    break
                case "text":
                    content += await this.makeRawMarkdownText(data, i.text, button)
                    break
                /*case "image": {
                    const { des, url } = await this.makeMarkdownImage(data, i.file, i.summary)
                    content += `${des}${url}`
                    break
                } */ case "markdown":
                    if (typeof i.data === "object")
                        messages.push([{ type: "markdown", ...i.data }])
                    else
                        content += i.data
                    break
                case "button":
                    if (config.rawButton[data.self_id] !== "false" && data.platform.startsWith("QQ")) button.push(...this.makeButtons(data, i.data))
                    else content += await this.btntocmd(i)
                    break
                case "buble":
                    buble.push(...this.makeButtons(data, i.data, true))
                    break
                case "reply":
                    if (i.id.startsWith("event_"))
                        reply = { type: "reply", event_id: i.id.replace(/^event_/, "") }
                    else
                        reply = i
                    continue
                case "node":
                    messages.push(...(await this.makeForwardMsg(data, i.data, "makeRawMarkdownMsg")))
                    continue
                case "raw":
                    messages.push(Array.isArray(i.data) ? i.data : [i.data])
                    break
                case "keyboard":
                    if (Array.isArray(i.data)) {
                        keyboard.push(...i.data.filter(Boolean))
                    } else {
                        keyboard.push(i)
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
                case "card":
                    let description = String(i.description ?? i.data?.description)
                    let pic_url = String(i.pic_url ?? i.data?.pic_url)
                    let title = String(i.title ?? i.data?.title)
                    let url = String(i.url ?? i.data?.url)
                    //url = url?.includes('?') ? `${url}&qq_aio_chat_type=3` : `${url}?qq_aio_chat_type=3`
                    if (!description || !pic_url || !title || !url){
                        throw new Error('description、pic_url、title、url均为必填值')
                    }
                    if (!url?.startsWith('https://')) {
                        throw new Error('url必须使用https协议')
                    }
                    if (!(pic_url.startsWith('https://') || pic_url.startsWith('http://'))){
                        throw new Error('pic_url无效')
                    }
                    /*if (url.length > 1024) {
                        throw new Error('url超出1024长度限制')
                    }
                    if (pic_url.length > 1024) {
                        throw new Error('pic_url超出1024长度限制')
                    }*/
                    messages.push({
                        type: "card",
                        data: {
                            type: "tuwen",
                            content: {
                                description: description.length <= 50 ? description : description.slice(0, 49) + '…',
                                pic_url: pic_url,
                                title: title.length <= 50 ? title : title.slice(0, 49) + '…',
                                url: url
                            }
                        }
                    })
                    break
                case "action_button":
                    action_button.push({
                        type: "action_button",
                        ...i.data
                    })
                    break
                default:
                    content += await this.makeRawMarkdownText(data, Bot.String(i), button)
            }
        }

        if (config.smallbtn) data.smallbtn = true

        if (content)
            messages.unshift([{ type: "markdown", content }])

        if (keyboard.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...keyboard)
            }
        }

        if (button.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...button.splice(0, 5))
                if (!button.length) break
            }
            while (button.length)
                messages.push([
                    { type: "markdown", content: " " },
                    ...button.splice(0, 5),
                ])
        }

        if (buble.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...buble)
            }
        }

        if (action_button.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...action_button)
            }
        }

        if (reply) for (const i in messages) {
            if (Array.isArray(messages[i]))
                messages[i].unshift(reply)
            else
                messages[i] = [reply, messages[i]]
        }
        return messages
    },

    makeMarkdownText_(data, text, button) {
        return text.replace(/\n/g, "\r")//.replace(/@/g, "@​")
    },

    makeMarkdownText(data, text, content, button) {
        const match = text.match(/!?\[.*?\]\s*\(\w+:\/\/.*?\)/g)
        if (match) {
            const temp = []
            let last = ""
            for (const i of match) {
                const match = i.match(/(!?\[.*?\])\s*(\(\w+:\/\/.*?\))/)
                text = text.split(i)
                temp.push([last + this.makeMarkdownText_(data, text.shift(), button), match[1]])
                text = text.join(i)
                last = match[2]
            }
            temp[0][0] = content + temp[0][0]
            return [last + this.makeMarkdownText_(data, text, button), temp]
        }
        return [this.makeMarkdownText_(data, text, button)]
    },

    makeMarkdownTemplate(data, templates) {
        const msgs = []
        for (const template of templates) {
            if (!template.length) continue

            const params = []
            for (const i in template)
                params.push({
                    key: config.template[data.self_id][i],
                    values: [template[i]],
                })

            msgs.push([{
                type: "markdown",
                custom_template_id: config.markdown[data.self_id],
                params,
            }])
        }
        return msgs
    },

    makeMarkdownTemplatePush(content, template, templates) {
        for (const i of content) {
            if (template.length === config.template[data.self_id].length - 1) {
                template.push(i.shift())
                template = i
                templates.push(template)
            } else {
                template.push(i.join(""))
            }
        }
        return template
    },

    async makeMarkdownMsg(data, msg) {
        const messages = [], button = [], templates = [[]], keyboard = [], action_button = [], buble = []
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
                console.error("并行处理图片时出错:", error)
                for (let j = 0; j < imagePromises.length; j++) {
                    try {
                        const result = await this.makeMarkdownImage(
                            data,
                            msgArray[imageIndices[j]].file ? msgArray[imageIndices[j]] : msgArray[imageIndices[j]].data
                        )
                        imageResults.push(result)
                    } catch (err) {
                        console.error(`处理第${j + 1}张图片失败:`, err)
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
                        content += "<qqbot-at-everyone />"
                    else
                        content += data.platform.startsWith("QQ") ? `<@${String(i.qq).split(this.sep)[1] || i.qq}>` : `<@${String(i.qq).split("_")[1] || i.qq}>`
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
                    if (config.rawButton[data.self_id] !== "false" && data.platform.startsWith("QQ")) button.push(...this.makeButtons(data, i.data))
                    else content += await this.btntocmd(i)
                    break
                case "buble":
                    buble.push(...this.makeButtons(data, i.data, true))
                    break
                case "reply":
                    if (i.id.startsWith("event_"))
                        reply = { type: "reply", event_id: i.id.replace(/^event_/, "") }
                    else
                        reply = i
                    continue
                case "node":
                    messages.push(...(await this.makeForwardMsg(data, i.data, "makeMarkdownMsg")))
                    continue
                case "raw":
                    messages.push(Array.isArray(i.data) ? i.data : [i.data])
                    break
                case "keyboard":
                    if (Array.isArray(i.data)) {
                        keyboard.push(...i.data.filter(Boolean))
                    } else {
                        keyboard.push(i)
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
                case "card":
                    let description = String(i.description ?? i.data?.description)
                    let pic_url = String(i.pic_url ?? i.data?.pic_url)
                    let title = String(i.title ?? i.data?.title)
                    let url = String(i.url ?? i.data?.url)
                    //url = url?.includes('?') ? `${url}&qq_aio_chat_type=3` : `${url}?qq_aio_chat_type=3`
                    if (!description || !pic_url || !title || !url){
                        throw new Error('description、pic_url、title、url均为必填值')
                    }
                    if (!url?.startsWith('https://')) {
                        throw new Error('url必须使用https协议')
                    }
                    if (!(pic_url.startsWith('https://') || pic_url.startsWith('http://'))){
                        throw new Error('pic_url无效')
                    }
                    /*if (url.length > 1024) {
                        throw new Error('url超出1024长度限制')
                    }
                    if (pic_url.length > 1024) {
                        throw new Error('pic_url超出1024长度限制')
                    }*/
                    messages.push({
                        type: "card",
                        data: {
                            type: "tuwen",
                            content: {
                                description: description.length <= 50 ? description : description.slice(0, 49) + '…',
                                pic_url: pic_url,
                                title: title.length <= 50 ? title : title.slice(0, 49) + '…',
                                url: url
                            }
                        }
                    })
                    break
                case "action_button":
                    action_button.push({
                        type: "action_button",
                        ...i.data
                    })
                    break
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

        if (config.smallbtn) data.smallbtn = true

        if (content)
            template.push(content)
        messages.push(...this.makeMarkdownTemplate(data, templates))

        if (keyboard.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...keyboard)
            }
        }

        if (button.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...button.splice(0, 5))
                if (!button.length) break
            }
            while (button.length)
                messages.push([
                    ...this.makeMarkdownTemplate(data, [[" "]])[0],
                    ...button.splice(0, 5),
                ])
        }
        
        if (buble.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...buble)
            }
        }

        if (action_button.length) {
            for (const i of messages) {
                if (i[0].type === "markdown")
                    i.push(...action_button)
            }
        }

        if (reply) for (const i of messages)
            i.unshift(reply)
        return messages
    },

    async makeForwardMsg(data, msgList, builder = "makeRawMarkdownMsg") {
        const method = config.forwardMethod
        if (method === "image") {
            try {
                const img = await this.forwardToImage(data, msgList, builder)
                if (img) return img
            } catch (err) {
                logger.warn(`[QQBot] 合并转发渲染图片失败，回退为合并发送: ${err.message}`)
            }
        }
        if (method === "image" || method === "merge") {
            try {
                const merged = await this.forwardToMerge(data, msgList, builder)
                if (merged) return merged
            } catch (err) {
                logger.warn(`[QQBot] 合并转发合并失败，回退为逐条发送: ${err.message}`)
            }
        }
        const messages = []
        for (const { message } of msgList)
            messages.push(...(await this[builder](data, message)))
    
        return messages
    },

    async forwardToMerge(data, msgList, builder) {
        const separator = { type: "text", text: "\n***\n" }
        const result = []
        for (const item of msgList) {
            const msg = item?.message
            const parts = Array.isArray(msg) ? msg.flat(Infinity) : (msg == null ? [] : [msg])
            if (!parts.length) continue
            result.push(...parts, separator)
        }
        if (result.length) result.pop()
        const message = await this[builder](data, result)
        return message.length ? message : null
    },

    async forwardToImage(data, msgList, builder) {
        const rows = [], buttons = [], files = []
        const MAX_NODE_DEPTH = 5

        const buildRows = async (list, depth = 0) => {
            if (depth > MAX_NODE_DEPTH) {
                logger.warn(`[QQBot] 合并转发嵌套超过 ${MAX_NODE_DEPTH} 层，已截断`)
                return
            }
            for (const item of list || []) {
                const message = item?.message
                if (!message) continue
                const nickname = item.nickname || item.user_id || data.bot?.nickname || ""
                let avatar = item.avatar
                    || (typeof item.user_id === "number" ? `https://q1.qlogo.cn/g?b=qq&nk=${item.user_id}&s=640` : "")
                    || data.pickFriend?.(item.user_id)?.avatar
                    || data.bot?.avatar
                    || ""
                avatar = escHtml(String(await segImgSrc(avatar)))
                const parts = []
                const flushRow = () => {
                    const content = parts.filter(Boolean).join("")
                    parts.length = 0
                    if (content.trim())
                        rows.push({ nickname: escHtml(String(nickname)), avatar, content })
                }
                for (const seg of Array.isArray(message) ? message : [message]) {
                    if (!seg) continue
                    switch (seg.type) {
                        case "text":
                            parts.push(escHtml(seg.text))
                            break
                        case "at":
                            let atUser = data.bot.fl.get(seg.qq || seg.user_id)
                            parts.push(`<span class="at">@${escHtml(String(atUser?.nickname || seg.qq || seg.user_id || ""))}</span>`)
                            break
                        case "face":
                            parts.push("[表情]")
                            break
                        case "image": {
                            const src = await segImgSrc(seg.file)
                            parts.push(src ? `<img class="img" src="${src}">` : "[图片]")
                            break
                        }
                        case "record":
                        case "audio":
                            files.push(seg)
                            parts.push(`[语音附件${files.length}]见后续消息`)
                            break
                        case "video":
                            files.push(seg)
                            parts.push(`[视频附件${files.length}]见后续消息`)
                            break
                        case "file":
                            files.push(seg)
                            parts.push(`[文件附件${files.length}]见后续消息`)
                            break
                        case "markdown":
                            parts.push(escHtml(Bot.String(seg.content)))
                            break
                        case "button":
                            buttons.push(seg)
                            break
                        case "node": {
                            flushRow()
                            await buildRows(seg.data, depth + 1)
                            break
                        }
                        default:
                            parts.push(escHtml(Bot.String(seg.text ?? seg)))
                    }
                }
                flushRow()
            }
        }

        await buildRows(msgList)
        if (!rows.length) return null

        const html = rows.map(r => `
            <div class="msg">
                ${r.avatar ? `<img class="avatar" src="${r.avatar}">` : ""}
                <div class="body">
                    <div class="nickname">${r.nickname}</div>
                    <div class="bubble">${r.content}</div>
                </div>
            </div>`).join("")

        const tplFile = path.join(process.cwd(), "plugins", "QQBot-Plugin", "resources", "html", "forward.html")
        const seg = await puppeteer.screenshot("QQBot-Plugin", {
            tplFile,
            html,
            saveId: `qqbot_forward_${Date.now()}`,
        })
        if (!seg) return null
        
        const file = seg.file ?? seg
        return await this[builder](data, [{ type: "image", file }, ...files, ...buttons])
    },

    async makeMsg(data, msg) {
        const messages = [], button = [], action_button = [], buble = []
        let message = [], reply

        for (let i of Array.isArray(msg) ? msg : [msg]) {
            if (typeof i === "object")
                i = { ...i }
            else
                i = { type: "text", text: Bot.String(i) }

            switch (i.type) {
                case "at":
                    if (i.qq === "all")
                        messages.push({ type: "text", text: "<qqbot-at-everyone />" })
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
                case "buble":
                    buble.push(...this.makeButtons(data, i.data, true))
                    break
                case "node":
                    messages.push(...(await this.makeForwardMsg(data, i.data, "makeMsg")))
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
                case "small":
                    data.smallbtn = true
                    continue
                case "card":
                    let description = String(i.description ?? i.data?.description)
                    let pic_url = String(i.pic_url ?? i.data?.pic_url)
                    let title = String(i.title ?? i.data?.title)
                    let url = String(i.url ?? i.data?.url)
                    //url = url?.includes('?') ? `${url}&qq_aio_chat_type=3` : `${url}?qq_aio_chat_type=3`
                    if (!description || !pic_url || !title || !url){
                        throw new Error('description、pic_url、title、url均为必填值')
                    }
                    if (!url?.startsWith('https://')) {
                        throw new Error('url必须使用https协议')
                    }
                    if (!(pic_url.startsWith('https://') || pic_url.startsWith('http://'))){
                        throw new Error('pic_url无效')
                    }
                    /*if (url.length > 1024) {
                        throw new Error('url超出1024长度限制')
                    }
                    if (pic_url.length > 1024) {
                        throw new Error('pic_url超出1024长度限制')
                    }*/
                    messages.push({
                        type: "card",
                        data: {
                            type: "tuwen",
                            content: {
                                description: description.length <= 50 ? description : description.slice(0, 49) + '…',
                                pic_url: pic_url,
                                title: title.length <= 50 ? title : title.slice(0, 49) + '…',
                                url: url
                            }
                        }
                    })
                    break
                case "action_button":
                    action_button.push({
                        type: "action_button",
                        ...i.data
                    })
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
                content: { rows: button.splice(0, 5) },
            }])
        
        
        if (buble.length) {
            for (const i of messages) {
                if (i[0].type === "markdown" || i[0].type === "text")
                    i.push(...buble)
            }
        }

        if (action_button.length) {
            for (const i of messages) {
                if (i[0].type === "markdown" || i[0].type === "text")
                    i.push(...action_button)
            }
        }

        if (reply) for (const i of messages)
            i.unshift(reply)
        return messages
    }
}
