import { DataTypes, Model, Op } from 'sequelize'
import { msgSequelize } from './init.js'

export default class MessageDB extends Model {
  static pack(msg) {
    return {
      message_id: msg.message_id || '',
      msg_idx: msg.msg_idx || '',
      ref_msg_idx: msg.ref_msg_idx || '',
      event_id: msg.event_id || '',
      self_id: msg.self_id || '',
      user_id: msg.user_id || '',
      openid: msg.openid || '',
      unionid: msg.unionid || '',
      nickname: msg.nickname || '',
      avatar: msg.avatar || '',
      group_id: msg.group_id || null,
      message_type: msg.message_type || 'group',
      me: msg.me ? 1 : 0,
      is_bot: msg.is_bot ? 1 : 0,
      recalled: msg.recalled ? 1 : 0,
      need_audit: msg.need_audit ? 1 : 0,
      audit_id: msg.audit_id || '',
      is_callback: msg.is_callback ? 1 : 0,
      is_notice: msg.is_notice ? 1 : 0,
      notice_type: msg.notice_type || '',
      sub_type: msg.sub_type || '',
      raw_message: msg.raw_message || '',
      message: JSON.stringify(msg.message || []),
      raw_event: msg.raw_event ? JSON.stringify(msg.raw_event) : null,
      sender: msg.sender ? JSON.stringify(msg.sender) : null,
      timestamp: msg.timestamp || 0,
    }
  }

  static unpack(row) {
    const r = row.dataValues || row
    return {
      message_id: r.message_id || '',
      msg_idx: r.msg_idx || '',
      ref_msg_idx: r.ref_msg_idx || '',
      event_id: r.event_id || '',
      self_id: r.self_id || '',
      user_id: r.user_id || '',
      openid: r.openid || '',
      unionid: r.unionid || '',
      nickname: r.nickname || '',
      avatar: r.avatar || '',
      group_id: r.group_id || undefined,
      message_type: r.message_type || 'group',
      me: !!r.me,
      is_bot: !!r.is_bot,
      recalled: !!r.recalled,
      need_audit: !!r.need_audit,
      audit_id: r.audit_id || '',
      is_callback: !!r.is_callback,
      is_notice: !!r.is_notice,
      notice_type: r.notice_type || '',
      sub_type: r.sub_type || '',
      raw_message: r.raw_message || '',
      message: (() => { try { return JSON.parse(r.message || '[]') } catch { return [] } })(),
      raw_event: (() => { if (!r.raw_event) return null; try { return JSON.parse(r.raw_event) } catch { return null } })(),
      sender: (() => { if (!r.sender) return null; try { return JSON.parse(r.sender) } catch { return null } })(),
      timestamp: r.timestamp || 0,
    }
  }

  static async put(msg) {
    return MessageDB.create(MessageDB.pack(msg))
  }

  /** 按群 ID 列表获取消息（用于兼容 Redis 的纯色/带前缀格式）
   *  @param {number|false} [before=0] 时间戳阈值（< before 的消息），传 0 或 false 表示不限制
   *  @param {number|false} [limit=20]  最大返回条数，传 0 或 false 表示不限制（慎用）
   *  @param {boolean} [desc=false]     是否按时间倒序（最新在前），用于首次加载最新消息
   */
  static async getByGroups(groupIds, before = 0, limit = 20, desc = false) {
    const where = { group_id: { [Op.in]: groupIds }, message_type: 'group' }
    if (before) where.timestamp = { [Op.lt]: before }
    const opts = { where, order: [['timestamp', desc ? 'DESC' : 'ASC']] }
    if (limit) opts.limit = limit
    const rows = await MessageDB.findAll(opts)
    return rows.map(r => MessageDB.unpack(r))
  }

  /** 按用户 ID 获取私聊消息
   *  @param {number|false} [before=0] 时间戳阈值
   *  @param {number|false} [limit=20]  最大返回条数
   *  @param {boolean} [desc=false]     是否按时间倒序
   */
  static async getByPrivate(userId, before = 0, limit = 20, desc = false) {
    const where = { user_id: userId, message_type: 'private' }
    if (before) where.timestamp = { [Op.lt]: before }
    const opts = { where, order: [['timestamp', desc ? 'DESC' : 'ASC']] }
    if (limit) opts.limit = limit
    const rows = await MessageDB.findAll(opts)
    return rows.map(r => MessageDB.unpack(r))
  }

  /** 按 msg_idx 查 raw_event */
  static async getRawEvent(msg_idx) {
    const row = await MessageDB.findOne({
      where: { msg_idx, raw_event: { [Op.ne]: null } },
      order: [['timestamp', 'DESC']],
    })
    if (row?.raw_event) {
      try { return JSON.parse(row.raw_event) } catch {}
    }
    return null
  }

  static async markRecalled(msg_idx) {
    return MessageDB.update({ recalled: 1 }, { where: { msg_idx } })
  }

  static async markRecalledByMessageId(message_id) {
    if (!message_id) return 0
    return MessageDB.update({ recalled: 1 }, { where: { message_id } })
  }

  static async cleanExpired(saveDays) {
    const cutoff = Math.floor(Date.now() / 1000) - saveDays * 86400
    return MessageDB.destroy({ where: { timestamp: { [Op.lt]: cutoff } } })
  }
}

MessageDB.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  message_id: DataTypes.STRING,
  msg_idx: DataTypes.STRING,
  ref_msg_idx: DataTypes.STRING,
  event_id: DataTypes.STRING,
  self_id: DataTypes.STRING,
  user_id: DataTypes.STRING,
  openid: DataTypes.STRING,
  unionid: DataTypes.STRING,
  nickname: DataTypes.STRING,
  avatar: DataTypes.STRING,
  group_id: { type: DataTypes.STRING, allowNull: true },
  message_type: DataTypes.STRING,
  me: DataTypes.INTEGER,
  is_bot: DataTypes.INTEGER,
  recalled: DataTypes.INTEGER,
  need_audit: DataTypes.INTEGER,
  audit_id: DataTypes.STRING,
  is_callback: DataTypes.INTEGER,
  is_notice: DataTypes.INTEGER,
  notice_type: DataTypes.STRING,
  sub_type: DataTypes.STRING,
  raw_message: DataTypes.TEXT,
  message: DataTypes.TEXT,
  raw_event: { type: DataTypes.TEXT, allowNull: true },
  sender: { type: DataTypes.TEXT, allowNull: true },
  timestamp: DataTypes.REAL,
}, {
  sequelize: msgSequelize,
  tableName: 'messages',
  timestamps: false,
  indexes: [
    { fields: ['msg_idx'] },
    { fields: ['group_id', 'timestamp'] },
    { fields: ['user_id', 'timestamp'] },
    { fields: ['message_type', 'timestamp'] },
  ],
})

// sync 统一在 index.js 中执行，确保所有模型都已定义
// await msgSequelize.sync()
