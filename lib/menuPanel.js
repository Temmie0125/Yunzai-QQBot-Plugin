/**
 * QQ 机器人「自定义菜单与指令面板」服务端接口封装
 *
 * 底层调用 @windtrace/qq-group-bot 的 bot 实例方法（见依赖 lib/bot.js）：
 *   getMenu / changeMenu / getPanels / createPanels / getPanel /
 *   changePanel / deletePanel / changePanelTarget
 * 这些方法走 bot.request（自动附带 access_token 与 v2 API host），
 * 本模块负责：① 选取可用的 bot 实例；② 统一入参校验；③ 统一错误包裹。
 *
 * 所有导出函数均返回形如 { ok: true, data } 或 { ok: false, error } 的对象，
 * 便于 Web 接口直接 res.json 透传，前端无需关心底层异常。
 *
 */

/**
 * 获取一个可用的 QQBot 实例
 * @param {string} [selfId] 可选，指定 Bot 的 appid / selfId；不传则取第一个可用的
 * @returns {object|null} bot 实例（包含 getMenu 等方法），无可用实例时返回 null
 */
export function getBot(selfId) {
  if (typeof Bot === "undefined" || !Bot || !Array.isArray(Bot.uin)) return null
  if (selfId && Bot[selfId]?.sdk.getMenu) return Bot[selfId]
  for (const id of Bot.uin) {
    if (Bot[id]?.sdk.getMenu) return Bot[id]
  }
  return null
}

/** 包裹底层调用：自动选 bot + 捕获异常 */
async function call(fnName, selfId, ...args) {
  const bot = getBot(selfId)
  if (!bot) return { ok: false, error: "当前没有已连接的 QQBot 实例" }
  try {
    const data = await bot.sdk[fnName](...args)
    return { ok: true, data }
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || String(e)
    return { ok: false, error: msg }
  }
}

/* ====== 自定义菜单 ====== */

/**
 * 查询全局自定义菜单
 * @param {string} [selfId]
 */
export function getMenu(selfId) {
  return call("getMenu", selfId)
}

/**
 * 修改全局自定义菜单
 * @param {object} menu 菜单结构（按钮 / 子菜单等），透传给服务端
 * @param {string} [selfId]
 */
export function changeMenu(menu, selfId) {
  if (menu == null || typeof menu !== "object") {
    return { ok: false, error: "menu 参数必须是对象" }
  }
  return call("changeMenu", selfId, menu)
}

/* ====== 指令面板 ====== */

/**
 * 查询指令面板列表
 * @param {string} [scope='group'] 生效范围：c2c | group | channel | dm
 * @param {string} [selfId]
 */
export function getPanels(scope = "group", selfId) {
  if (!["c2c", "group", "channel", "dm"].includes(scope)) {
    return { ok: false, error: "scope 必须为 c2c | group | channel | dm" }
  }
  return call("getPanels", selfId, scope)
}

/**
 * 创建指令面板
 * @param {string} scope        生效范围：c2c | group | channel | dm
 * @param {string} target_type  关联对象类型：user_openid | group_openid
 * @param {string[]} [user_openids]    指定用户 openid 列表
 * @param {string[]} [group_openids]   指定群 openid 列表
 * @param {object} panel         面板内容（名称、动作等）
 * @param {string} [selfId]
 */
export function createPanels(scope, target_type, user_openids = [], group_openids = [], panel, selfId) {
  if (!["c2c", "group", "channel", "dm"].includes(scope)) {
    return { ok: false, error: "scope 必须为 c2c | group | channel | dm" }
  }
  if (target_type == null || target_type === "") target_type = "all"
  if (!["all", "specific"].includes(target_type)) {
    return { ok: false, error: "target_type 必须为 all | specific" }
  }
  // channel / dm 场景只支持 all
  if (["channel", "dm"].includes(scope) && target_type !== "all") {
    return { ok: false, error: "channel / dm 场景的 target_type 只能为 all" }
  }
  // all 时不传关联对象
  if (target_type === "all") {
    user_openids = []
    group_openids = []
  }
  if (panel == null || typeof panel !== "object") {
    return { ok: false, error: "panel 参数必须是对象" }
  }
  return call("createPanels", selfId, scope, target_type, user_openids, group_openids, panel)
}

/**
 * 查询指令面板详情
 * @param {string} panel_id
 * @param {string} [selfId]
 */
export function getPanel(panel_id, selfId) {
  if (!panel_id) return { ok: false, error: "panel_id 不能为空" }
  return call("getPanel", selfId, panel_id)
}

/**
 * 修改指令面板
 * @param {string} panel_id
 * @param {object} panel 面板内容
 * @param {string} [selfId]
 */
export function changePanel(panel_id, panel, selfId) {
  if (!panel_id) return { ok: false, error: "panel_id 不能为空" }
  if (panel == null || typeof panel !== "object") {
    return { ok: false, error: "panel 参数必须是对象" }
  }
  return call("changePanel", selfId, panel_id, panel)
}

/**
 * 删除指令面板
 * @param {string} panel_id
 * @param {string} [selfId]
 */
export function deletePanel(panel_id, selfId) {
  if (!panel_id) return { ok: false, error: "panel_id 不能为空" }
  return call("deletePanel", selfId, panel_id)
}

/**
 * 修改指令面板关联对象（新增 / 移除生效用户或群）
 * @param {string} panel_id
 * @param {string} op           操作：add | del
 * @param {string[]} [user_openids]
 * @param {string[]} [group_openids]
 * @param {string} [selfId]
 */
export function changePanelTarget(panel_id, op, user_openids = [], group_openids = [], selfId) {
  if (!panel_id) return { ok: false, error: "panel_id 不能为空" }
  if (!["add", "del"].includes(op)) {
    return { ok: false, error: "op 必须为 add | del" }
  }
  if (user_openids.length > 20 || group_openids.length > 20) {
    return { ok: false, error: "user_openids 和 group_openids 每项最多 20 个" }
  }
  return call("changePanelTarget", selfId, panel_id, op, user_openids, group_openids)
}
