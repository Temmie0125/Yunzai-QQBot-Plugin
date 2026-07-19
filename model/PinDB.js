import { DataTypes, Model } from 'sequelize'
import { msgSequelize } from './init.js'

export default class PinDB extends Model {
  static async getByKey(key) {
    const row = await PinDB.findByPk(key)
    return row ? JSON.parse(row.value) : null
  }

  static async setByKey(key, value) {
    const str = JSON.stringify(value)
    await PinDB.upsert({ key, value: str })
  }

  static async getAllPinKeys() {
    const rows = await PinDB.findAll({ attributes: ['key'] })
    return rows.map(r => r.key)
  }
}

PinDB.init({
  key: { type: DataTypes.STRING, primaryKey: true },
  value: { type: DataTypes.TEXT },
}, {
  sequelize: msgSequelize,
  tableName: 'pin_store',
  timestamps: false,
  freezeTableName: true,
})
