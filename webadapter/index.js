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
const BOOLEAN_FIELDS = [
  { key: "toCallback", label: "全局回调按钮", desc: "自动发送按钮全局转换回调按钮" },
  { key: "hideGuildRecall", label: "隐藏频道撤回提示", desc: "撤回频道消息时不提示" },
  { key: "stream", label: "流式消息", desc: "私信全局使用流式消息" },
  { key: "smallbtn", label: "全局小按钮", desc: "全局使用小尺寸按钮样式" },
  { key: "fakemsg", label: "野收官发", desc: "野收官发全局开关，配合野收官发插件使用" },
  { key: "filter_bot_msg", label: "过滤机器人消息", desc: "忽略来自 bot 的消息" },
  { key: "filter_only_at_other_bot", label: "过滤纯艾特其他机器人", desc: "只艾特其他 bot 时过滤" },
  { key: "sandbox", label: "沙箱模式", desc: "开启 QQ 机器人沙箱环境" },
]

// 全局数字字段
const NUMBER_FIELDS = [
  { key: "imageLength", label: "图片压缩阈值", desc: "超过此大小(MB)的图片将自动压缩", default: 3 },
  { key: "chunkSize", label: "流式分块大小", desc: "流式消息每块显示的字数", default: 2 },
  { key: "delay", label: "流式延迟", desc: "流式消息每块显示的间隔(毫秒)", default: 100 },
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
  if (Array.isArray(u)) return u.slice()
  if (u && typeof u === "object") return Object.values(u)
  return []
}

export function init(ctx) {
  // 注册页面（静态 html 由 WebAdapter 通过 web-page 接口投放）
  ctx.registerPage({
    id: "qqbot-setting",
    title: "QQBot 设置",
    icon: "⚙",
    src: "setting.html",
  })

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
          if (f.key === "sandbox") bools[f.key] = !!config.bot?.sandbox
          else bools[f.key] = !!config[f.key]
        }
        const numbers = {}
        for (const f of NUMBER_FIELDS) {
          numbers[f.key] = config[f.key] != null ? config[f.key] : f.default
        }
        const md = config.markdown || {}
        const maps = {}
        for (const k of Object.keys(MAP_FIELDS)) {
          if (k === "markdown_template") {
            maps[k] = md.template || {}
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
              if (f.key === "sandbox") {
                config.bot = config.bot || {}
                config.bot.sandbox = body.bools[f.key]
              } else {
                config[f.key] = body.bools[f.key]
              }
            }
          }
        }

        // 数字字段
        if (body.numbers) {
          for (const f of NUMBER_FIELDS) {
            if (body.numbers[f.key] != null) config[f.key] = Number(body.numbers[f.key])
          }
        }

        // 多值映射字段
        if (body.maps) {
          for (const k of Object.keys(MAP_FIELDS)) {
            if (!body.maps[k]) continue
            if (k === "markdown_template") {
              config.markdown = config.markdown || {}
              config.markdown.template = body.maps[k]
            } else if (k === "markdown") {
              config.markdown = config.markdown || {}
              const tpl = config.markdown.template
              config.markdown = Object.assign({}, body.maps[k])
              config.markdown.template = tpl
            } else {
              config[k] = body.maps[k]
            }
          }
        }

        if (typeof body.markdownBatchSize === "number") {
          config.markdown = config.markdown || {}
          config.markdown.batchSize = body.markdownBatchSize
        }

        configSave()
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
