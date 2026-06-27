import { DataTypes, Model, Op } from 'sequelize'
import { msgSequelize } from './init.js'

export default class ActiveListDB extends Model {
  static async updateEntry(key_type, self_id, target_id, timestamp) {
    return ActiveListDB.upsert({ key_type, self_id, target_id, timestamp: timestamp || 0 })
  }

  static async getList(key_type, self_id, limit = 500) {
    const rows = await ActiveListDB.findAll({
      where: { key_type, self_id },
      order: [['timestamp', 'DESC']],
      limit,
    })
    return rows.map(r => r.target_id)
  }

  static async cleanExpired(saveDays) {
    const cutoff = Math.floor(Date.now() / 1000) - saveDays * 86400
    return ActiveListDB.destroy({ where: { timestamp: { [Op.lt]: cutoff } } })
  }
}

ActiveListDB.init({
  key_type: { type: DataTypes.STRING, primaryKey: true },
  self_id: { type: DataTypes.STRING, primaryKey: true },
  target_id: { type: DataTypes.STRING, primaryKey: true },
  timestamp: { type: DataTypes.REAL, defaultValue: 0 },
}, {
  sequelize: msgSequelize,
  tableName: 'active_list',
  timestamps: false,
})
