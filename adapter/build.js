// 消息构造方法：按钮 / Markdown / 卡片 / 图片等
import { ulid } from "ulid"
import QRCode from "qrcode"
import imageSize from "image-size"
import { encode as encodeSilk, isSilk } from "silk-wasm"
import fs from "node:fs/promises"
import path from "node:path"
import { config, sharp } from "./context.js"
import { compressImage } from "../lib/media.js"

export const buildMethods = {
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
            des: `![${summary} #${image.width || 0}px #${image.height || 0}px]`,
            url: `(${image.url})`,
        }
    },

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

        if (button.content || button.confirm_text || button.cancel_text) {
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
                        content += "@everyone"
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
                        content += "@everyone"
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

        if (reply) for (const i of messages)
            i.unshift(reply)
        return messages
    },

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
                case "small":
                    data.smallbtn = true
                    continue
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

            message.push(i)
        }

        if (message.length)
            messages.push(message)

        while (button.length)
            messages.push([{
                type: "keyboard",
                content: { rows: button.splice(0, 5) },
            }])

        if (reply) for (const i of messages)
            i.unshift(reply)
        return messages
    }
}
