import { Bot } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { BOT_CONFIG } from "./config/index.js";
import { notifySuperAdmin } from "./botHandler/notifySuperAdmin.js";
import { registerStartHandler } from "./botHandler/startHandler.js";
import { registerConfigHandler } from "./botHandler/configHandler.js";
import { registerIdHandler } from "./botHandler/idHandler.js";
import { registerGroupHandler } from "./botHandler/groupHandler.js";
import { registerGroupGuardHandler } from "./botHandler/groupGuardHandler.js";
import { registerBridgeHandler } from "./botHandler/bridgeHandler.js";
import { registerAdHandler } from "./botHandler/adHandler.js";
import logger from "./services/loggerService.js";
import { closePool } from "./services/mysqlService.js";
import { closeRedis } from "./services/redisService.js";
import { startAdScheduler, stopAdScheduler } from "./services/adSchedulerService.js";

const bot = new Bot(BOT_CONFIG.token, {
    client: {
        apiRoot: BOT_CONFIG.apiRoot,
    },
});

// DEBUG
bot.use(async (ctx, next) => {
    logger.info(`收到更新 ${JSON.stringify(ctx.update)}`);
    await next();
});

// 注册 start 回调查询命令
registerStartHandler(bot);

// 注册 config 欢迎语配置命令
registerConfigHandler(bot);

// 注册 id 群组 ID 查询命令
registerIdHandler(bot);

// 注册群组管理（入群事件同步 + 群组管理面板）
registerGroupHandler(bot);

// 注册群消息守卫
registerGroupGuardHandler(bot);

// 注册双向消息桥接管道
registerBridgeHandler(bot);

// 注册广告推送配置命令
registerAdHandler(bot);

const runner: RunnerHandle = run(bot);

// 启动广告定时推送任务
startAdScheduler(bot);

void notifySuperAdmin(bot);

let shuttingDown = false;

/**
 * 优雅退出
 * @param signal 触发退出的信号名称
 * @returns 退出完成后的 Promise
 */
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal} 信号，开始退出`);

    try {
        await runner.stop();
        logger.info('机器人已停止接收更新');

        await stopAdScheduler();

        await closePool();
        await closeRedis();

        logger.info('资源释放完成，进程退出');
        process.exit(0);
    } catch (err) {
        logger.error(`退出失败: ${err instanceof Error ? err.stack : err}`);
        process.exit(1);
    }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));