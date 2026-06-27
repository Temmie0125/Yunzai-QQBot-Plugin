import { cacheRemoteMedia, sanitizeSegments } from './media.js'

/** 获取保存天数（与适配器 saveDays getter 逻辑一致） */
function getSaveDays() {
  const t = Bot.saveTimes
  return (t >= 1 && t <= 7 && Number.isInteger(t)) ? t : 3
}

/**
 * 保存 Bot 自己发出的消息
 */
export async function saveBotMessage(data) {
  // 频道消息不存入
  if (String(data.user_id || '').startsWith('qg_') || String(data.group_id || '').startsWith('qg_')) return
  const saveDays = getSaveDays()
  cleanupSQLiteIfNeeded()
  cleanupRedisIfNeeded(data, saveDays)

  const msg = {
    me: true,
    recalled: false,
    need_audit: data.need_audit ?? false,
    message_id: data.message_id || '',
    audit_id: data.audit_id || '',
    msg_idx: data.msg_idx || '',
    ref_msg_idx: data.ref_msg_idx || '',
    self_id: data.self_id,
    // 群聊: user_id = self_id（群消息不以 user_id 索引）；私聊: user_id = data.user_id（与 getByPrivate 查询键一致）
    user_id: data.group_id ? data.self_id : (data.user_id || data.self_id),
    is_bot: true,
    nickname: data.nickname || '机器人',
    openid: data.openid || '',
    unionid: data.unionid || '',
    avatar: data.avatar,
    ...(data.group_id ? {group_id: data.group_id} : {}),
    message_type: data.group_id ? 'group' : 'private',
    raw_message: data.raw_message,
    message: data.message,
    timestamp: data.time
  }

  if (Bot.storageBackend === 'sqlite') {
    // SQLite 存储
    if (!Bot.MessageDB) return
    try {
      await Bot.MessageDB.put(msg)
      if (data.msg_idx && !data.need_audit) {
        await Bot.MsgIdxDB.put(data.msg_idx, data.message_id || '', data.self_id, msg.timestamp)
      }
      if (msg.message_type === 'group') {
        await Bot.ActiveListDB.updateEntry('active-group', data.self_id, data.group_id, msg.timestamp)
      } else if (msg.message_type === 'private') {
        await Bot.ActiveListDB.updateEntry('active-private', data.self_id, data.user_id, msg.timestamp)
      }
    } catch (err) {
      logger.debug('[QQBot] SQLite 写入 bot 消息失败:', err)
    }
  } else {
    // Redis 存储
    if (data.msg_idx && !data.need_audit) {
      await redis.set(
        `wind-msg-idx:${data.msg_idx}`,
        JSON.stringify({
          message_id: data.message_id || '',
          self_id: data.self_id,
          recall: false,
          timestamp: data.time
        }),
        { EX: saveDays * 86400 }
      )
    }

    const key = msg.message_type === 'group'
      ? `wind-bot-msg:group:${data.group_id}`
      : `wind-bot-msg:private:${data.user_id}`

    await redis.zAdd(key, {
      score: msg.timestamp,
      value: JSON.stringify(msg)
    })
    await redis.expire(key, saveDays * 86400)

    // 活跃列表
    switch(msg.message_type){
      case 'group': {
        await redis.zAdd(
          `wind-active-group:${data.self_id}`,
          { score: data.time, value: data.group_id }
        )
        await redis.zRemRangeByScore(
          `wind-active-group:${data.self_id}`,
          10000000000,
          99999999999999
        )
        await redis.zRemRangeByScore(
          `wind-active-group:${data.self_id}`,
          0,
          data.time - saveDays * 86400
        )
        break
      }
      case 'private': {
        await redis.zAdd(
          `wind-active-private:${data.self_id}`,
          { score: data.time, value: data.user_id }
        )
        await redis.zRemRangeByScore(
          `wind-active-private:${data.self_id}`,
          10000000000,
          99999999999999
        )
        await redis.zRemRangeByScore(
          `wind-active-private:${data.self_id}`,
          0,
          data.time - saveDays * 86400
        )
        break
      }
    }
  }
}

/**
 * 保存用户发送的消息
 */
export async function saveMessage(data) {
  // 频道/频道私聊消息不存入
  if (String(data.user_id || '').startsWith('qg_') || String(data.group_id || '').startsWith('qg_')) return
  const saveDays = getSaveDays()
  cleanupSQLiteIfNeeded()
  cleanupRedisIfNeeded(data, saveDays)
  logger.debug('准备存储消息')

  // 根据全局开关决定是否下载远程媒体文件到本地缓存
  if (Bot.autoDownloadImgorVideo) {
    data.message = await cacheRemoteMedia(data.message)
  }

  const msg = {
    recalled: false,
    message_id: data.message_id || '',
    msg_idx: data.msg_idx || '',
    ref_msg_idx: data.ref_msg_idx || '',
    event_id: data.event_id || '',
    self_id: data.self_id,
    user_id: data.user_id,
    is_bot: data.raw_event?.d?.author?.bot || false,
    nickname: data.nickname || '未知',
    openid: data.openid,
    unionid: data.unionid || '',
    avatar: data.avatar,
    sender: data.sender,
    ...(data.group_id ? {group_id: data.group_id} : {}),
    message_type: data.message_type ? data.message_type : data.group_id ? 'group' : 'private',
    raw_message: data.raw_message,
    message: data.message,
    is_callback: data.sub_type === 'callback',
    timestamp: data.time || Math.floor(Date.now() / 1000),
    raw_event: data.raw_event || null
  }

  // 存储（在 Bot.em 之前，确保 WebSocket 推送时数据已持久化）
  if (Bot.storageBackend === 'sqlite') {
    if (!Bot.MessageDB) {
      // 模型未就绪，降级到不存储（Bot.em 仍会触发 WebSocket 推送）
    } else try {
      await Bot.MessageDB.put(msg)
      if (data.msg_idx) {
        await Bot.MsgIdxDB.put(data.msg_idx, data.message_id, data.user_id, msg.timestamp)
      }
      // 活跃列表更新
      if (msg.message_type === 'group') {
        await Bot.ActiveListDB.updateEntry('active-group', data.self_id, data.group_id, msg.timestamp)
      } else if (msg.message_type === 'private') {
        await Bot.ActiveListDB.updateEntry('active-private', data.self_id, data.user_id, msg.timestamp)
      }
    } catch (err) {
      logger.debug('[QQBot] SQLite 写入消息失败:', err)
    }
  } else {
    // Redis 存储
    if (data.msg_idx) {
      await redis.set(
        `wind-msg-idx:${data.msg_idx}`,
        JSON.stringify({
          message_id: data.message_id,
          self_id: data.user_id,
          recall: false,
          timestamp: data.time || Math.floor(Date.now() / 1000)
        }),
        { EX: saveDays * 86400 }
      )
    }

    const key = msg.message_type === 'group'
      ? `wind-msg:group:${data.group_id}`
      : `wind-msg:private:${data.user_id}`

    await redis.zAdd(key, {
      score: msg.timestamp,
      value: JSON.stringify(msg)
    })
    await redis.expire(key, saveDays * 86400)

    switch(msg.message_type){
      case 'group': {
        const groupTime = data.time || Math.floor(Date.now() / 1000)
        await redis.zAdd(
          `wind-active-group:${data.self_id}`,
          { score: groupTime, value: data.group_id }
        )
        await redis.zRemRangeByScore(
          `wind-active-group:${data.self_id}`,
          0,
          groupTime - saveDays * 86400
        )
        break
      }
      case 'private': {
        const privateTime = data.time || Math.floor(Date.now() / 1000)
        await redis.zAdd(
          `wind-active-private:${data.self_id}`,
          { score: privateTime, value: data.user_id }
        )
        await redis.zRemRangeByScore(
          `wind-active-private:${data.self_id}`,
          0,
          privateTime - saveDays * 86400
        )
        break
      }
    }
  }

  // Bot.em 放在存储之后，确保 WebSocket 推送时数据已就绪
  if (data.message_type === 'private') {
    Bot.em("qqbot_private_msg", data)
  } else {
    Bot.em("qqbot_msg", data)
  }
}

/**
 * 保存单条发送成功的消息。raw_message 从 segs 提取文本，与用户消息格式统一
 */
export async function saveSentMessage(data, segs, ret) {
  const msg_id = ret.id
  const idx = ret.ext_info?.ref_idx
  const time = (new Date(ret.timestamp).getTime() || Date.now()) / 1000
  const need_audit = !(idx && msg_id && time)
  const sep = ':'

  let ref_msg_idx = ''
  const rawText = segs.map(s => {
    if (s.type === 'reply' && s.id) ref_msg_idx = s.id
    if (s.type === 'text') return s.text || ''
    if (s.type === 'image') return '[图片]'
    if (s.type === 'markdown') return (s.data?.content || s.content || '')
    if (s.type === 'at') return (s.qq === 'all') ? '@everyone' : `@${s.nickname || s.qq || ''}`
    return s.text || ''
  }).join('')

  // Buffer → 存本地文件，段内放相对路径（Bot 媒体不受开关控制）
  const safeSegs = await sanitizeSegments(segs)

  return saveBotMessage({
    message_id: need_audit ? null : (msg_id || ''),
    audit_id: need_audit ? (msg_id || '') : '',
    msg_idx: idx || '',
    need_audit,
    ref_msg_idx,
    self_id: data.self_id,
    user_id: data.user_id?.includes(':') ? data.user_id : data.self_id + sep + data.user_id || data.self_id,
    nickname: data.bot?.info?.username || data.bot?.info?.nickname || '机器人',
    avatar: data.bot?.info?.avatar || '',
    openid: data.bot?.info?.union_openid || '',
    unionid: data.bot?.info?.union_openid || '',
    group_id: data.group_id || null,
    raw_message: rawText,
    message: [safeSegs],
    time
  })
}

/** SQLite 过期数据清理（每次写消息时顺便检查，最多每 10 分钟执行一次） */
let _lastSqCleanup = 0
async function cleanupSQLiteIfNeeded() {
  if (!Bot.MessageDB) return
  const now = Date.now()
  if (now - _lastSqCleanup < 10 * 60 * 1000) return
  _lastSqCleanup = now
  const saveDays = getSaveDays()
  try {
    await Promise.all([
      Bot.MessageDB.cleanExpired(saveDays),
      Bot.MsgIdxDB.cleanExpired(saveDays),
      Bot.ActiveListDB.cleanExpired(saveDays),
    ])
  } catch (err) {
    logger.debug('[QQBot] SQLite 清理过期数据失败:', err)
  }
}

/** Redis 过期数据清理（与 SQLite 解耦，每次写消息时顺便清理相关 key，最多每 10 分钟执行一次） */
let _lastRdCleanup = 0
async function cleanupRedisIfNeeded(data, saveDays) {
  const now = Date.now()
  if (now - _lastRdCleanup < 10 * 60 * 1000) return
  _lastRdCleanup = now
  const cutoff = Math.floor(now / 1000) - saveDays * 86400
  const selfId = data.self_id
  try {
    const cmds = []
    // 清理消息 ZSET 中的过期条目
    if (data.group_id) {
      const pureId = (data.group_id || '').includes(':') ? data.group_id.split(':').pop() : data.group_id
      const keys = [data.group_id, pureId].filter(Boolean)
      for (const gid of new Set(keys)) {
        cmds.push(
          redis.zRemRangeByScore(`wind-msg:group:${gid}`, 0, cutoff),
          redis.zRemRangeByScore(`wind-bot-msg:group:${gid}`, 0, cutoff),
        )
      }
      // 活跃群列表
      cmds.push(redis.zRemRangeByScore(`wind-active-group:${selfId}`, 0, cutoff))
    }
    if (data.user_id) {
      cmds.push(
        redis.zRemRangeByScore(`wind-msg:private:${data.user_id}`, 0, cutoff),
        redis.zRemRangeByScore(`wind-bot-msg:private:${data.user_id}`, 0, cutoff),
      )
      // 活跃私聊列表
      cmds.push(redis.zRemRangeByScore(`wind-active-private:${selfId}`, 0, cutoff))
    }
    if (cmds.length) await Promise.all(cmds)
  } catch (err) {
    logger.debug('[QQBot] Redis 清理过期数据失败:', err)
  }
}

export { cleanupSQLiteIfNeeded, cleanupRedisIfNeeded }
