/**
 * SQLite 消息数据库初始化
 * DB 文件: plugins/QQBot-Plugin/data/db/messages.db
 */
import { Sequelize } from 'sequelize'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbDir = path.join(__dirname, '..', 'data', 'db')
fs.mkdirSync(dbDir, { recursive: true })

const dbPath = path.join(dbDir, 'messages.db')
export const msgSequelize = new Sequelize({
  dialect: 'sqlite',
  storage: dbPath,
  logging: false,
})
