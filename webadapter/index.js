// QQBot-Plugin 的 Web 操作模块（约定式）
// 由 QQBot-Web-Adapter 在扫描插件时自动发现并调用 init(ctx) 初始化，
// 插件主入口 index.js 只需把 config 暴露到 Bot.QQBotConfig 即可（已添加）。
//
// ctx 由 WebAdapter 提供：
//   - apiBase    : Web API 根路径，如 /web/api
//   - basePath   : Web 根前缀，如 web
//   - pluginName : 插件名
//   - pluginDir  : 插件目录绝对路径
//   - logger     : 日志对象
import path from "node:path"

// 不在页面展示的字段（含敏感信息或无需 Web 设置的）
const HIDDEN = new Set(["tips", "token", "keyboardid", "toQRCode", "toBotUpload"])

// boolean 类型字段（用胶囊开关），排除 HIDDEN 中的
// inBot: true 表示该字段位于 config.bot 子对象中（如 sandbox/newapi/internal）
const BOOLEAN_FIELDS = [
  { key: "toCallback", label: "全局回调按钮", desc: "自动发送按钮全局转换回调按钮" },
  { key: "hideGuildRecall", label: "隐藏频道撤回提示", desc: "撤回频道消息时不提示" },
  { key: "stream", label: "流式消息", desc: "私信全局使用流式消息" },
  { key: "smallbtn", label: "全局小按钮", desc: "全局使用小尺寸按钮样式" },
  { key: "fakemsg", label: "野收官发", desc: "野收官发全局开关，配合野收官发插件使用" },
  { key: "filter_bot_msg", label: "过滤机器人消息", desc: "忽略来自 bot 的消息" },
  { key: "filter_only_at_other_bot", label: "过滤纯艾特其他机器人", desc: "只艾特其他 bot 时过滤" },
  { key: "sandbox", label: "沙箱模式", desc: "开启 QQ 机器人沙箱环境", inBot: true },
  { key: "newapi", label: "使用新API", desc: "开启后使用新版 API 接入 QQBot（需重启后生效）", inBot: true },
  { key: "internal", label: "分片使用内网上传", desc: "开启后分片上传使用内网上传，可大幅提升文件发送速度，非腾讯云服务器不用开启此选项（需重启后生效）", inBot: true },
  { key: "stat", label: "使用统计", desc: "按机器人记录每日使用人数/群数、留存与增减，并在 Web 控制台展示（需重启后生效）" },
]

// 全局数字字段
// inBot: true 表示该字段位于 config.bot 子对象中（如 concurrency）
const NUMBER_FIELDS = [
  { key: "imageLength", label: "图片压缩阈值", desc: "超过此大小(MB)的图片将自动压缩", default: 3 },
  { key: "chunkSize", label: "流式分块大小", desc: "流式消息每块显示的字数", default: 2 },
  { key: "delay", label: "流式延迟", desc: "流式消息每块显示的间隔(毫秒)", default: 100 },
  { key: "concurrency", label: "并发数", desc: "分片上传并发数量，如未使用内网上传请将此选项调整到1，如果使用内网且成功配置最大可调制20（需重启后生效）", default: 1, inBot: true, integer: true, min: 1, max: 20 },
]

// config.bot 子对象中的下拉选择字段（基础设置中显示为下拉框，值为字符串）
const BOT_SELECT_FIELDS = [
  { key: "region", label: "腾讯云COS地域", desc: "腾讯云 cos 地域，用于分片内网上传，仅当分片使用内网上传选项开启后生效，可使分片内网上传加快文件发送速度，非腾讯云服务器不用关心此选项（需重启后生效）", default: "ap-guangzhou" },
]

// 多值映射字段（按 botQQ 索引），值在页面显示为列表
// valueType: bool=胶囊开关 / text=文本框 / list=参数列表
const MAP_FIELDS = {
  rawButton: { label: "开启原生按钮", valueType: "bool", desc: "每个机器人是否使用原生按钮" },
  bot_openid: { label: "bot自身openid（可在全量群艾特机器人自动获取，无需手动输入）", valueType: "text", desc: "机器人在群内的 member_openid" },
  markdown: { label: "机器人markdown模板id", valueType: "text", desc: "每个机器人的 markdown 模板 id，raw/legacy 为内置" },
  markdown_template: { label: "机器人markdown模板参数", valueType: "list", desc: "模板参数 key 列表，按顺序与模板占位符对应" },
}

function getCfg() {
  const c = Bot.QQBotConfig
  if (!c || !c.config) throw new Error("QQBot 配置尚未就绪")
  return c
}

function botQQList() {
  const u = Bot.uin
  const ids = Array.isArray(u) ? u.slice() : (u && typeof u === "object" ? Object.values(u) : [])
  // 只保留 QQBot 适配器的机器人，过滤沙盒（QQBotSandbox）
  return ids
    .map(String)
    .filter(id => {
      const aid = Bot[id]?.adapter?.id
      return !aid || aid === "QQBot"
    })
}

export function init(ctx) {
  // 注册页面（静态 html 由 WebAdapter 通过 web-page 接口投放）
  ctx.registerPage({
    id: "qqbot-setting",
    title: "QQBot 设置",
    icon: "⚙",
    src: "setting.html",
  })

  // 使用统计页：仅在统计开关开启时注册（关闭时不初始化展示页，需重启生效）
  try {
    if (getCfg().config.stat === true) {
      ctx.registerPage({
        id: "qqbot-stat",
        title: "使用统计",
        icon: "📊",
        src: "stat.html",
      })
    }
  } catch (e) {
    ctx.logger?.warn?.(`[QQBot] 使用统计页未注册: ${e.message}`)
  }

  let apiReady = false
  function registerApi() {
    if (apiReady || !Bot.express) return
    const P = "/qqbot-config"

    // 读取当前可见配置 + 可选 botQQ 列表
    ctx.registerApi("get", P, (_req, res) => {
      try {
        const { config } = getCfg()
        const bools = {}
        for (const f of BOOLEAN_FIELDS) {
          bools[f.key] = f.inBot ? !!config.bot?.[f.key] : !!config[f.key]
        }
        const numbers = {}
        for (const f of NUMBER_FIELDS) {
          numbers[f.key] = f.inBot
            ? (config.bot?.[f.key] != null ? config.bot[f.key] : f.default)
            : (config[f.key] != null ? config[f.key] : f.default)
        }
        const texts = {}
        for (const f of BOT_SELECT_FIELDS) {
          texts[f.key] = config.bot?.[f.key] != null ? config.bot[f.key] : f.default
        }
        const md = config.markdown || {}
        const maps = {}
        for (const k of Object.keys(MAP_FIELDS)) {
          if (k === "markdown_template") {
            maps[k] = config.template || {}
          } else if (k === "markdown") {
            // 去掉 template / batchSize 子键，只暴露 botQQ -> 模板 id
            const o = {}
            for (const kk of Object.keys(md)) if (kk !== "template" && kk !== "batchSize") o[kk] = md[kk]
            maps[k] = o
          } else {
            maps[k] = config[k] || {}
          }
        }
        res.json({
          ok: true,
          bools,
          maps,
          numbers,
          texts,
          sandboxOn: !!config.bot?.sandbox,
          markdownBatchSize: typeof md.batchSize === "number" ? md.batchSize : 5,
          botQQList: botQQList(),
        })
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message })
      }
    })

    // 保存：body 仅含可见字段，后端做定向 merge 后持久化
    ctx.registerApi("post", P, (req, res) => {
      try {
        const { config, configSave } = getCfg()
        const body = req.body || {}

        // boolean 字段
        if (body.bools) {
          for (const f of BOOLEAN_FIELDS) {
            if (typeof body.bools[f.key] === "boolean") {
              if (f.inBot) {
                config.bot = config.bot || {}
                config.bot[f.key] = body.bools[f.key]
              } else {
                config[f.key] = body.bools[f.key]
              }
            }
          }
        }

        // 数字字段
        if (body.numbers) {
          for (const f of NUMBER_FIELDS) {
            if (body.numbers[f.key] != null) {
              let v = Number(body.numbers[f.key])
              if (f.integer) v = Math.round(v)
              if (f.min != null) v = Math.max(f.min, v)
              if (f.max != null) v = Math.min(f.max, v)
              if (f.inBot) {
                config.bot = config.bot || {}
                config.bot[f.key] = v
              } else {
                config[f.key] = v
              }
            }
          }
        }

        // 多值映射字段
        if (body.maps) {
          for (const k of Object.keys(MAP_FIELDS)) {
            if (!body.maps[k]) continue
            if (k === "markdown_template") {
              config.template = body.maps[k]
            } else if (k === "markdown") {
              config.markdown = Object.assign({}, body.maps[k])
            } else {
              config[k] = body.maps[k]
            }
          }
        }

        if (typeof body.markdownBatchSize === "number") {
          config.markdown = config.markdown || {}
          config.markdown.batchSize = body.markdownBatchSize
        }

        // bot 子对象文本字段
        if (body.texts) {
          config.bot = config.bot || {}
          for (const f of BOT_SELECT_FIELDS) {
            if (body.texts[f.key] != null) config.bot[f.key] = String(body.texts[f.key])
          }
        }

        configSave()
        res.json({ ok: true })
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message })
      }
    })

    // 使用统计：某机器人某日数据 + 趋势（开关关闭时不可用）
    ctx.registerApi("get", "/qqbot-stat", async (req, res) => {
      try {
        const { config } = getCfg()
        if (!config.stat) return res.status(403).json({ ok: false, error: "使用统计未开启" })
        const S = Bot.QQBotStat
        if (!S) return res.status(500).json({ ok: false, error: "统计模块未就绪" })

        const list = botQQList()
        const bot = String(req.query.bot || list[0] || "")
        // mode: day=按日（默认） / month=整月
        const mode = req.query.mode === "month" ? "month" : "day"
        const date = req.query.date
          ? String(req.query.date)
          : (mode === "month" ? S.dateStr().slice(0, 7) : S.dateStr())
        const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31)
        const topN = Math.min(Math.max(Number(req.query.topN) || 10, 1), 50)
        if (!bot) return res.json({ ok: true, empty: true, botQQList: list })

        const data = await S.getSummary(bot, date, days, topN, mode)
        res.json({ ok: true, ...data, botQQList: list })
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message })
      }
    })

    // 清空某机器人的统计数据
    ctx.registerApi("post", "/qqbot-stat/clear", async (req, res) => {
      try {
        const { config } = getCfg()
        if (!config.stat) return res.status(403).json({ ok: false, error: "使用统计未开启" })
        const bot = String((req.body || {}).bot || req.query.bot || "")
        if (!bot) return res.status(400).json({ ok: false, error: "缺少 bot" })
        const cleared = await Bot.QQBotStat.clearStat(bot)
        res.json({ ok: true, cleared })
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message })
      }
    })

    // 重启 Bot
    ctx.registerApi("post", "/qqbot-restart", (_req, res) => {
      try {
        if (typeof Bot.restart !== "function") throw new Error("当前环境不支持重启")
        // 延迟一点再重启，确保响应先返回前端
        setTimeout(() => { Bot.restart() }, 300)
        res.json({ ok: true })
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message })
      }
    })

    apiReady = true
  }

  if (!registerApi() && typeof Bot.on === "function") {
    Bot.on("plugins/loaded", registerApi)
  }
}
