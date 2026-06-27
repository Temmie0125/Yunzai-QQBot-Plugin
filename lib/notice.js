import { cleanupSQLiteIfNeeded, cleanupRedisIfNeeded } from './message.js'

/** 获取保存天数（与适配器 saveDays getter 逻辑一致） */
function getSaveDays() {
  const t = Bot.saveTimes
  return (t >= 1 && t <= 7 && Number.isInteger(t)) ? t : 3
}

/**
 * 保存群通知事件
 */
export async function saveNotice(data) {
  if (data.notice_type !== 'group' || !data.group_id) return

  const isBotEvent = data.sub_type === 'add' || data.sub_type === 'del'
  const saveDays = getSaveDays()
  cleanupSQLiteIfNeeded()
  cleanupRedisIfNeeded(data, saveDays)

  // 机器人昵称（仅 add/del 需要）
  let botNickname = ''
  if (isBotEvent) {
    botNickname = data.bot.nickname || data.bot.info?.username || '机器人'
  }

  const ts = data.time
    ? Math.floor(data.time)
    : Math.floor(Date.now() / 1000)

  const notice = {
    self_id: data.self_id,
    user_id: data.user_id,
    openid: data.openid,
    group_id: data.group_id,
    nickname: data.nickname || '未知',
    unionid: data.unionid || '',
    bot_nickname: botNickname,
    avatar: data.avatar,
    is_notice: true,
    notice_type: data.notice_type,
    sub_type: data.sub_type,
    timestamp: ts,
    event_id: data.event_id,
    raw_event: data.raw_event || null,
    message_id: '',
    msg_idx: '',
  }

  try {
    // 存储（在 Bot.em 之前）
    if (Bot.storageBackend === 'sqlite') {
      if (Bot.MessageDB) {
        await Bot.MessageDB.put(notice)
        await Bot.ActiveListDB.updateEntry('active-group', data.self_id, data.group_id, ts)
      }
    } else {
      // Redis 存储
      const key = `wind-msg:group:${data.group_id}`
      const groupTimeKey = `wind-active-group:${data.self_id}`
      await redis.zAdd(key, {
        score: ts,
        value: JSON.stringify(notice),
      })
      await redis.expire(key, saveDays * 86400)

      // 更新活跃群
      await redis.zAdd(groupTimeKey, {
        score: ts,
        value: data.group_id,
      })
      await redis.zRemRangeByScore(
        groupTimeKey,
        0,
        ts - saveDays * 86400,
      )
    }

    // 推送 WebSocket 实时刷新（存储已就绪）
    Bot.em('qqbot_notice', notice)
  } catch (err) {
    logger.debug('[QQBot] 保存通知事件失败:', err)
  }
}
