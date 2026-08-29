// QR 扫码登录相关常量与核心函数（模块级，供 adapter.connect 与 apps 命令共用）
import crypto from "node:crypto"

const PORTAL_HOST = "q.qq.com"
const CREATE_PATH = "/lite/create_bind_task"
const POLL_PATH = "/lite/poll_bind_result"
export const QR_URL_TPL = "https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=windtrace"
const SHARE_INFO_URL = "https://qun.qq.com/cgi-bin/group_pro/robot/manager/share_info"
const BKN = 508459323
const QR_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "windtrace/1.0",
    "X-Source": "windtrace",
}

// QR 扫码登录核心函数（模块级，供 adapter 和 plugin class 共用）
export async function _qrCreateBindTask() {
    const key = crypto.randomBytes(32).toString("base64")
    const res = await fetch(`https://${PORTAL_HOST}${CREATE_PATH}`, {
        method: "POST",
        headers: QR_HEADERS,
        body: JSON.stringify({ key }),
    })
    const json = await res.json()
    if (json.retcode !== 0) throw new Error(json.msg || "创建绑定任务失败")
    return { taskId: json.data.task_id, key }
}

export async function _qrPollBindResult(taskId) {
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const res = await fetch(`https://${PORTAL_HOST}${POLL_PATH}`, {
            method: "POST",
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

export function _qrDecryptSecret(cipherBase64, keyBase64) {
    const buf = Buffer.from(cipherBase64, "base64")
    const key = Buffer.from(keyBase64, "base64")
    const nonce = buf.subarray(0, 12)
    const tag = buf.subarray(-16)
    const cipher = buf.subarray(12, -16)

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAuthTag(tag)
    return decipher.update(cipher, undefined, "utf8") + decipher.final("utf8")
}

export async function _qrGetRobotUin(appId) {
    try {
        const res = await fetch(`${SHARE_INFO_URL}?bkn=${BKN}&robot_appid=${appId}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36"
            },
        })
        const json = await res.json()
        return json?.data?.robot_data?.robot_uin
    } catch (err) {
        logger.error(`获取机器人 uin 失败: ${err.message}`)
        return null
    }
}
