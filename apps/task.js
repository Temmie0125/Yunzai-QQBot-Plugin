import { cleanupErrStore } from "../lib/errorStore.js"
import { cleanupMediaFiles } from "../lib/media.js"
import { cleanForwardFiles } from "../adapter/forward.js"
export class QQBotTask extends plugin {
  constructor() {
    super({
      name: 'QQBot定时任务',
      dsc: '定时清理',
      event: 'message',
      priority: 6000,
      rule: [],
      task: [
        { 
            name: "QQBot媒体文件清理", 
            cron: "0 3 * * *", 
            fnc: () => cleanupMediaFiles() 
        },
        {
            name: 'error记录及文件清理',
            cron: '0 3 * * *',
            fnc: () => cleanupErrStore()
        },
        {
            name: '合并转发落盘文件清理',
            cron: '0 3 * * *',
            fnc: () => cleanForwardFiles()
        }
      ],
    })
  }
}
