// 极简 multipart/form-data 解析（无需三方依赖）
// 解析 req（Buffer 流）为 { fields: {}, files: [{ name, filename, contentType, buffer }] }
import zlib from "node:zlib"

export async function parseMultipart(req, limitBytes = 300 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error("上传体积超限")
    chunks.push(chunk)
  }
  const buf = Buffer.concat(chunks)
  const ct = req.headers["content-type"] || ""
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!m) throw new Error("无效的 multipart 请求")
  const boundary = `--${(m[1] || m[2]).trim()}`
  const parts = splitParts(buf, boundary)
  const fields = {}
  const files = []
  for (const part of parts) {
    const { headers, body } = parsePart(part)
    const cd = headers["content-disposition"] || ""
    const name = (cd.match(/name="([^"]*)"/i) || [])[1]
    const filename = (cd.match(/filename="([^"]*)"/i) || [])[1]
    if (filename !== undefined) {
      files.push({
        name,
        filename: decodeHeader(filename),
        contentType: headers["content-type"] || "application/octet-stream",
        buffer: body,
      })
    } else if (name) {
      fields[name] = body.toString("utf8")
    }
  }
  return { fields, files }
}

function splitParts(buf, boundary) {
  const parts = []
  let start = buf.indexOf(boundary)
  if (start === -1) return parts
  start += boundary.length
  while (true) {
    // 找到下一个 boundary
    const next = buf.indexOf(boundary, start)
    if (next === -1) break
    let partBuf = buf.subarray(start, next)
    // 去掉前导 \r\n 和尾部 \r\n
    if (partBuf[0] === 0x0d && partBuf[1] === 0x0a) partBuf = partBuf.subarray(2)
    if (partBuf.length >= 2 && partBuf[partBuf.length - 2] === 0x0d && partBuf[partBuf.length - 1] === 0x0a) {
      partBuf = partBuf.subarray(0, partBuf.length - 2)
    }
    parts.push(partBuf)
    start = next + boundary.length
    // 边界后可能是 "--" 表示结束
    if (buf[next + boundary.length] === 0x2d && buf[next + boundary.length + 1] === 0x2d) break
  }
  return parts
}

function parsePart(buf) {
  const sepIdx = buf.indexOf("\r\n\r\n")
  const headerStr = buf.subarray(0, sepIdx).toString("utf8")
  const body = buf.subarray(sepIdx + 4)
  const headers = {}
  for (const line of headerStr.split("\r\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  return { headers, body }
}

function decodeHeader(s) {
  try {
    // 处理 filename*=UTF-8'' 形式（若需要），此处直接返回
    return s
  } catch {
    return s
  }
}

// 极简 zip 解压（支持 store(0) / deflate(8)，无加密，兼容 data descriptor 与 zip64 提示）
// 采用中央目录(EOCD)定位条目，避免逐本地头推进在 data descriptor 场景下漏解或越界
export function extractZipImagesFromBuffer(buffer, imageRe = /\.(png|jpe?g|gif|webp|bmp|svg)$/i) {
  const out = []
  try {
    const eocd = findEocd(buffer)
    if (!eocd) return out // 非标准 zip（无中央目录结尾），放弃
    const { cdOffset, cdCount } = eocd
    let p = cdOffset
    for (let i = 0; i < cdCount; i++) {
      if (p + 46 > buffer.length) break
      if (buffer.readUInt32LE(p) !== 0x02014b50) break // 中央目录头签名 PK\1\2
      const method = buffer.readUInt16LE(p + 10)
      const compSize = buffer.readUInt32LE(p + 20)
      const uncompSize = buffer.readUInt32LE(p + 24)
      const nameLen = buffer.readUInt16LE(p + 28)
      const extraLen = buffer.readUInt16LE(p + 30)
      const commentLen = buffer.readUInt16LE(p + 32)
      const lho = buffer.readUInt32LE(p + 42) // 本地头偏移
      const name = buffer.toString("utf8", p + 46, p + 46 + nameLen)
      p += 46 + nameLen + extraLen + commentLen
      // 目录项跳过
      if (name.endsWith("/")) continue
      if (!imageRe.test(name)) continue
      // 从本地头读取 name/extra 长度，确定压缩数据起点（数据长度以中央目录 compSize 为准，兼容 data descriptor）
      if (lho + 30 > buffer.length) continue
      const lhNameLen = buffer.readUInt16LE(lho + 26)
      const lhExtraLen = buffer.readUInt16LE(lho + 28)
      const dataStart = lho + 30 + lhNameLen + lhExtraLen
      if (dataStart + compSize > buffer.length) continue
      const compData = buffer.subarray(dataStart, dataStart + compSize)
      let data
      try {
        if (method === 0) data = compData
        else if (method === 8) {
          try { data = zlib.inflateSync(compData) }
          catch { data = zlib.inflateRawSync(compData) }
        } else continue
      } catch {
        continue // 解压失败的条目跳过，避免中断整个流程
      }
      // 若中央目录大小不可信，用解压后大小兜底校验
      if (uncompSize && data.length !== uncompSize) continue
      out.push({ buffer: data, originalname: name.split("/").pop() })
    }
  } catch {
    // 任何异常都不抛出，保证上传流程不 500
  }
  return out
}

// 查找 EOCD 记录（兼容带注释的 zip），返回 { cdOffset, cdCount } 或 null
function findEocd(buffer) {
  // EOCD 签名 0x06054b50，可能位于注释前；从尾部向前搜索
  const minPos = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= minPos; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      const cdCount = buffer.readUInt16LE(i + 10)
      const cdSize = buffer.readUInt32LE(i + 12)
      const cdOffset = buffer.readUInt32LE(i + 16)
      // 基本合法性校验：中央目录应落在 buffer 内
      if (cdOffset >= 0 && cdOffset + cdSize <= buffer.length) {
        return { cdOffset, cdCount }
      }
      // 部分工具 cdOffset 为 0 或异常，尝试用 cdSize 反推失败则退回扫描
      if (cdOffset >= 0 && cdOffset < buffer.length) {
        return { cdOffset, cdCount }
      }
    }
  }
  return null
}
