import redis from './redisService.js';

/** 屏蔽状态缓存 Key 前缀 */
const MUTE_KEY_PREFIX = 'bridge:mute:';

/**
 * 生成屏蔽状态缓存 Key
 * @param userId Telegram 用户 ID
 * @returns Redis Key
 */
function buildMuteKey(userId: number): string {
    return `${MUTE_KEY_PREFIX}${userId}`;
}

/**
 * 屏蔽用户会话，到期后自动解除
 * @param userId Telegram 用户 ID
 * @param ttlSeconds 屏蔽时长（秒）
 * @returns 写入完成后的 Promise
 */
export async function muteUserSession(userId: number, ttlSeconds: number): Promise<void> {
    await redis.set(buildMuteKey(userId), '1', 'EX', ttlSeconds);
}

/**
 * 解除用户会话屏蔽
 * @param userId Telegram 用户 ID
 * @returns 解除完成后的 Promise
 */
export async function unmuteUserSession(userId: number): Promise<void> {
    await redis.del(buildMuteKey(userId));
}

/**
 * 查询用户会话剩余屏蔽时长
 * @param userId Telegram 用户 ID
 * @returns 剩余秒数，未屏蔽时返回 0
 */
export async function getUserMuteRemainingSeconds(userId: number): Promise<number> {
    const ttl = await redis.ttl(buildMuteKey(userId));
    return ttl > 0 ? ttl : 0;
}

/**
 * 判断用户会话是否处于屏蔽状态
 * @param userId Telegram 用户 ID
 * @returns 是否被屏蔽
 */
export async function isUserSessionMuted(userId: number): Promise<boolean> {
    const count = await redis.exists(buildMuteKey(userId));
    return count === 1;
}
