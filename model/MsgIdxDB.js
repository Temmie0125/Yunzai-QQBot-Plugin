import { DataTypes, Model, Op } from 'sequelize'
import { msgSequelize } from './init.js'

export default class MsgIdxDB extends Model {
  static async put(msg_idx, message_id, self_id, timestamp) {
    return MsgIdxDB.upsert({ msg_idx, message_id: message_id || '', self_id: self_id || '', recall: 0, timestamp: timestamp || 0 })
  }

  static async findByMsgIdx(msg_idx) {
    return MsgIdxDB.findOne({ where: { msg_idx } })
  }

  static async markRecalled(msg_idx) {
    return MsgIdxDB.update({ recall: 1 }, { where: { msg_idx } })
  }

  static async cleanExpired(saveDays) {
    const cutoff = Math.floor(Date.now() / 1000) - saveDays * 86400
    return MsgIdxDB.destroy({ where: { timestamp: { [Op.lt]: cutoff } } })
  }
}

MsgIdxDB.init({
  msg_idx: { type: DataTypes.STRING, primaryKey: true },
  message_id: { type: DataTypes.STRING, defaultValue: '' },
  self_id: { type: DataTypes.STRING, defaultValue: '' },
  recall: { type: DataTypes.INTEGER, defaultValue: 0 },
  timestamp: { type: DataTypes.REAL, defaultValue: 0 },
}, {
  sequelize: msgSequelize,
  tableName: 'msg_idx_map',
  timestamps: false,
})
