import { Redis } from 'ioredis';
import { REDIS_CONFIG } from '../config/index.js';

/**
 * Redis 客户端单例，全局复用
 * 连接参数统一由 src/config 提供，未配置密码时不注入 password 字段
 */
const redis: Redis = new Redis({
    host: REDIS_CONFIG.host,
    port: REDIS_CONFIG.port,
    db: REDIS_CONFIG.db,
    ...(REDIS_CONFIG.password ? { password: REDIS_CONFIG.password } : {}),
    enableAutoPipelining: true,
    noDelay: true,
    keepAlive: 10000,
    connectTimeout: 10000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number): number => Math.min(times * 200, 3000),
});

/**
 * 关闭 Redis 连接
 * @returns 关闭完成后的 Promise
 */
export async function closeRedis(): Promise<void> {
    if (redis.status === 'end') return;

    if (redis.status === 'ready') {
        await redis.quit();
        return;
    }

    redis.disconnect();
}

export default redis;
