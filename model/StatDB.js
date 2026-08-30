/**
 * SQLite 统计数据库初始化
 * DB 文件: plugins/QQBot-Plugin/data/db/stat.db
 *
 * 所有表均以 bot（机器人QQ）+ date（YYYY-MM-DD）为主键前缀，天然按 botQQ 隔离。
 * 数据访问一律走模型静态方法（Sequelize API），不在业务层写裸 SQL。
 */
import { Sequelize, DataTypes, Model, Op, fn, col } from 'sequelize'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbDir = path.join(__dirname, '..', 'data', 'db')
fs.mkdirSync(dbDir, { recursive: true })

const dbPath = path.join(dbDir, 'stat.db')
export const statSequelize = new Sequelize({
  dialect: 'sqlite',
  storage: dbPath,
  logging: false,
})

/** 每日使用者：一个用户一行，msg_count 为当日消息数（用于「使用最多的人」排名） */
export class StatUser extends Model {
  /** 记录一条消息：已存在则 msg_count+1，否则创建 */
  static async incrMsg(bot, date, user_id, name) {
    const [row, created] = await StatUser.findOrCreate({
      where: { bot, date, user_id },
      defaults: { name: name || '', msg_count: 1 },
    })
    if (!created) await row.increment('msg_count')
  }

  /** 当日使用人数 */
  static async countByDate(bot, date) {
    return StatUser.count({ where: { bot, date } })
  }

  /** 当日消息总数 */
  static async sumMsgByDate(bot, date) {
    return (await StatUser.sum('msg_count', { where: { bot, date } })) || 0
  }

  /** 当日使用最多的人（Top N） */
  static async topByDate(bot, date, limit = 10) {
    const rows = await StatUser.findAll({
      where: { bot, date },
      order: [['msg_count', 'DESC']],
      limit,
    })
    return rows.map(r => ({ id: r.user_id, name: r.name || '', count: Number(r.msg_count) || 0 }))
  }

  /** 存留用户数：当日与 prev 日都出现过的用户 */
  static async countKeep(bot, date, prev) {
    const [cur, prevRows] = await Promise.all([
      StatUser.findAll({ where: { bot, date }, attributes: ['user_id'], raw: true }),
      StatUser.findAll({ where: { bot, date: prev }, attributes: ['user_id'], raw: true }),
    ])
    const set = new Set(prevRows.map(r => r.user_id))
    return cur.reduce((n, r) => (set.has(r.user_id) ? n + 1 : n), 0)
  }

  /** 按日期聚合：Map<date, { users, messages }> */
  static async dailyAgg(bot, start, end) {
    const rows = await StatUser.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['date', 'msg_count'],
      raw: true,
    })
    const map = new Map()
    for (const r of rows) {
      const e = map.get(r.date) || { users: 0, messages: 0 }
      e.users += 1
      e.messages += Number(r.msg_count) || 0
      map.set(r.date, e)
    }
    return map
  }

  /** 区间内去重使用人数（用于整月统计） */
  static async countDistinctRange(bot, start, end) {
    return StatUser.count({
      where: { bot, date: { [Op.between]: [start, end] } },
      distinct: true,
      col: 'user_id',
    })
  }

  /** 区间内消息总数 */
  static async sumMsgRange(bot, start, end) {
    return (await StatUser.sum('msg_count', {
      where: { bot, date: { [Op.between]: [start, end] } },
    })) || 0
  }

  /** 区间内去重使用者 id（用于与上一周期对比算存留） */
  static async idsRange(bot, start, end) {
    const rows = await StatUser.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['user_id'],
      group: ['user_id'],
      raw: true,
    })
    return rows.map(r => r.user_id)
  }

  /** 区间内使用最多的人（按消息数汇总排序） */
  static async topRange(bot, start, end, limit = 10) {
    const rows = await StatUser.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['user_id', 'name', [fn('SUM', col('msg_count')), 'total']],
      group: ['user_id', 'name'],
      order: [[fn('SUM', col('msg_count')), 'DESC']],
      limit,
      raw: true,
    })
    return rows.map(r => ({ id: r.user_id, name: r.name || '', count: Number(r.total) || 0 }))
  }

  static async cleanExpired(cutoff) {
    return StatUser.destroy({ where: { date: { [Op.lt]: cutoff } } })
  }

  static async clearByBot(bot) {
    return StatUser.destroy({ where: { bot } })
  }
}

StatUser.init({
  bot: { type: DataTypes.STRING, primaryKey: true },
  date: { type: DataTypes.STRING, primaryKey: true },
  user_id: { type: DataTypes.STRING, primaryKey: true },
  name: DataTypes.STRING,
  msg_count: { type: DataTypes.INTEGER, defaultValue: 1 },
}, {
  sequelize: statSequelize,
  tableName: 'stat_user',
  timestamps: false,
  indexes: [{ fields: ['bot', 'date', 'msg_count'] }],
})

/** 每日使用群：msg_count 为该群当日消息数 */
export class StatGroup extends Model {
  /** 记录一条群消息：已存在则 msg_count+1，否则创建 */
  static async incrMsg(bot, date, group_id, name) {
    const [row, created] = await StatGroup.findOrCreate({
      where: { bot, date, group_id },
      defaults: { name: name || '', msg_count: 1 },
    })
    if (!created) await row.increment('msg_count')
  }

  /** 当日使用群数 */
  static async countByDate(bot, date) {
    return StatGroup.count({ where: { bot, date } })
  }

  /** 当日群列表（含群名与消息数） */
  static async listByDate(bot, date) {
    const rows = await StatGroup.findAll({ where: { bot, date } })
    return rows.map(r => ({
      id: r.group_id,
      name: r.name || '',
      messages: Number(r.msg_count) || 0,
    }))
  }

  /** 存留群数：当日与 prev 日都出现过的群 */
  static async countKeep(bot, date, prev) {
    const [cur, prevRows] = await Promise.all([
      StatGroup.findAll({ where: { bot, date }, attributes: ['group_id'], raw: true }),
      StatGroup.findAll({ where: { bot, date: prev }, attributes: ['group_id'], raw: true }),
    ])
    const set = new Set(prevRows.map(r => r.group_id))
    return cur.reduce((n, r) => (set.has(r.group_id) ? n + 1 : n), 0)
  }

  /** 按日期聚合：Map<date, groups> */
  static async dailyAgg(bot, start, end) {
    const rows = await StatGroup.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['date'],
      raw: true,
    })
    const map = new Map()
    for (const r of rows) map.set(r.date, (map.get(r.date) || 0) + 1)
    return map
  }

  /** 区间内去重使用群数 */
  static async countDistinctRange(bot, start, end) {
    return StatGroup.count({
      where: { bot, date: { [Op.between]: [start, end] } },
      distinct: true,
      col: 'group_id',
    })
  }

  /** 区间内去重使用群 id */
  static async idsRange(bot, start, end) {
    const rows = await StatGroup.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['group_id'],
      group: ['group_id'],
      raw: true,
    })
    return rows.map(r => r.group_id)
  }

  /** 区间内群列表（消息数汇总） */
  static async listRange(bot, start, end) {
    const rows = await StatGroup.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['group_id', [fn('SUM', col('msg_count')), 'total']],
      group: ['group_id'],
      raw: true,
    })
    const names = await StatGroup.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['group_id', 'name'],
      raw: true,
    })
    const nameMap = new Map()
    for (const n of names) if (n.name) nameMap.set(n.group_id, n.name)
    return rows.map(r => ({
      id: r.group_id,
      name: nameMap.get(r.group_id) || '',
      messages: Number(r.total) || 0,
    }))
  }

  static async cleanExpired(cutoff) {
    return StatGroup.destroy({ where: { date: { [Op.lt]: cutoff } } })
  }

  static async clearByBot(bot) {
    return StatGroup.destroy({ where: { bot } })
  }
}

StatGroup.init({
  bot: { type: DataTypes.STRING, primaryKey: true },
  date: { type: DataTypes.STRING, primaryKey: true },
  group_id: { type: DataTypes.STRING, primaryKey: true },
  name: DataTypes.STRING,
  msg_count: { type: DataTypes.INTEGER, defaultValue: 1 },
}, {
  sequelize: statSequelize,
  tableName: 'stat_group',
  timestamps: false,
  indexes: [{ fields: ['bot', 'date', 'msg_count'] }],
})

/** 某群当日使用者（去重，用于统计「各群使用人数」） */
export class StatGroupUser extends Model {
  /** 确保该用户已记入该群（已存在则跳过） */
  static async ensure(bot, date, group_id, user_id) {
    await StatGroupUser.findOrCreate({ where: { bot, date, group_id, user_id } })
  }

  /** 当日各群使用人数：Map<group_id, 人数> */
  static async countByGroups(bot, date) {
    const rows = await StatGroupUser.findAll({
      where: { bot, date },
      attributes: ['group_id'],
      raw: true,
    })
    const map = new Map()
    for (const r of rows) map.set(r.group_id, (map.get(r.group_id) || 0) + 1)
    return map
  }

  /** 区间内各群去重使用人数：Map<group_id, 人数> */
  static async countByGroupsRange(bot, start, end) {
    const rows = await StatGroupUser.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      attributes: ['group_id', 'user_id'],
      group: ['group_id', 'user_id'],
      raw: true,
    })
    const map = new Map()
    for (const r of rows) map.set(r.group_id, (map.get(r.group_id) || 0) + 1)
    return map
  }

  static async cleanExpired(cutoff) {
    return StatGroupUser.destroy({ where: { date: { [Op.lt]: cutoff } } })
  }

  static async clearByBot(bot) {
    return StatGroupUser.destroy({ where: { bot } })
  }
}

StatGroupUser.init({
  bot: { type: DataTypes.STRING, primaryKey: true },
  date: { type: DataTypes.STRING, primaryKey: true },
  group_id: { type: DataTypes.STRING, primaryKey: true },
  user_id: { type: DataTypes.STRING, primaryKey: true },
}, {
  sequelize: statSequelize,
  tableName: 'stat_group_user',
  timestamps: false,
  indexes: [{ fields: ['bot', 'date', 'group_id'] }],
})

/** 每日事件计数（列名避开 join 等 SQL 关键字） */
export class StatEvent extends Model {
  /** 事件自增：field 取 group_join / group_kick / friend_add / friend_del */
  static async incr(bot, date, field) {
    const [row, created] = await StatEvent.findOrCreate({
      where: { bot, date },
      defaults: { [field]: 1 },
    })
    if (!created) await row.increment(field)
  }

  /** 取某日事件，统一对外键名 join / kick / fadd / fdel */
  static async get(bot, date) {
    const row = await StatEvent.findOne({ where: { bot, date } })
    return {
      join: Number(row?.group_join) || 0,
      kick: Number(row?.group_kick) || 0,
      fadd: Number(row?.friend_add) || 0,
      fdel: Number(row?.friend_del) || 0,
    }
  }

  /** 取日期范围内事件：Map<date, { join, kick, fadd, fdel }> */
  static async listRange(bot, start, end) {
    const rows = await StatEvent.findAll({ where: { bot, date: { [Op.between]: [start, end] } } })
    const map = new Map()
    for (const r of rows) {
      map.set(r.date, {
        join: Number(r.group_join) || 0,
        kick: Number(r.group_kick) || 0,
        fadd: Number(r.friend_add) || 0,
        fdel: Number(r.friend_del) || 0,
      })
    }
    return map
  }

  /** 区间内事件合计 */
  static async sumRange(bot, start, end) {
    const rows = await StatEvent.findAll({
      where: { bot, date: { [Op.between]: [start, end] } },
      raw: true,
    })
    const total = { join: 0, kick: 0, fadd: 0, fdel: 0 }
    for (const r of rows) {
      total.join += Number(r.group_join) || 0
      total.kick += Number(r.group_kick) || 0
      total.fadd += Number(r.friend_add) || 0
      total.fdel += Number(r.friend_del) || 0
    }
    return total
  }

  static async cleanExpired(cutoff) {
    return StatEvent.destroy({ where: { date: { [Op.lt]: cutoff } } })
  }

  static async clearByBot(bot) {
    return StatEvent.destroy({ where: { bot } })
  }
}

StatEvent.init({
  bot: { type: DataTypes.STRING, primaryKey: true },
  date: { type: DataTypes.STRING, primaryKey: true },
  group_join: { type: DataTypes.INTEGER, defaultValue: 0 },
  group_kick: { type: DataTypes.INTEGER, defaultValue: 0 },
  friend_add: { type: DataTypes.INTEGER, defaultValue: 0 },
  friend_del: { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
  sequelize: statSequelize,
  tableName: 'stat_event',
  timestamps: false,
})
