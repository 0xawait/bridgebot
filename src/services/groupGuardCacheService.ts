import logger from './loggerService.js';
import redis from './redisService.js';
import {
    BUILTIN_GROUP_KEYWORDS,
    BUILTIN_GROUP_REGEXES,
    getGroupMaxTextLength,
    getGroupRules,
    listGroupKeywords,
    listGroupWhitelist,
    type GroupRuleConfig,
} from './groupService.js';

/** 群组守卫配置缓存 Key 前缀 */
const GROUP_GUARD_CACHE_PREFIX = 'group:guard:';

/** 已登记群组的缓存有效期（秒） */
const GROUP_GUARD_CACHE_TTL_SECONDS = 600;

/** 未登记群组的缓存有效期（秒），便于登记后快速生效 */
const GROUP_GUARD_EMPTY_CACHE_TTL_SECONDS = 60;

/** 未登记群组的缓存标记值 */
const EMPTY_CACHE_VALUE = '';

/** 长文本删除默认阈值（字符数） */
export const DEFAULT_MAX_TEXT_LENGTH = 500;

/** 群组守卫配置（规则开关 + 关键词 + 正则 + 白名单 + 长文本阈值） */
export interface GroupGuardConfig {
    /** 自动删除规则开关 */
    rules: GroupRuleConfig;
    /** 关键词列表（内置关键词 + 自定义关键词） */
    keywords: string[];
    /** 内置正则规则，随进程加载，不写入缓存 */
    regexes: RegExp[];
    /** 白名单用户 ID 列表 */
    whitelist: number[];
    /** 长文本删除阈值（字符数） */
    maxTextLength: number;
}

/**
 * 拼接群组守卫配置缓存 Key
 * @param chatId 群组 ID
 * @returns Redis Key
 */
function buildCacheKey(chatId: number): string {
    return `${GROUP_GUARD_CACHE_PREFIX}${chatId}`;
}

/**
 * 从数据库加载群组守卫配置
 * @param chatId 群组 ID
 * @returns 守卫配置，群组未登记或机器人已退出时返回 null
 */
async function loadGroupGuardConfig(chatId: number): Promise<GroupGuardConfig | null> {
    const rules = await getGroupRules(chatId);
    if (!rules) return null;

    const [customKeywords, whitelist, maxTextLength] = await Promise.all([
        rules.keyword ? listGroupKeywords(chatId) : Promise.resolve<string[]>([]),
        listGroupWhitelist(chatId),
        getGroupMaxTextLength(chatId),
    ]);

    return {
        rules,
        keywords: [...BUILTIN_GROUP_KEYWORDS, ...customKeywords],
        regexes: BUILTIN_GROUP_REGEXES,
        whitelist,
        maxTextLength: maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    };
}

/**
 * 解析缓存的守卫配置，字段缺失时视为未命中
 * 正则规则不入缓存，统一取进程内加载的内置正则
 * @param raw 缓存原始字符串
 * @returns 守卫配置，结构不合法时返回 null
 */
function parseCachedConfig(raw: string): GroupGuardConfig | null {
    const parsed = JSON.parse(raw) as Partial<GroupGuardConfig>;
    const valid =
        Boolean(parsed.rules) &&
        Array.isArray(parsed.keywords) &&
        Array.isArray(parsed.whitelist) &&
        typeof parsed.maxTextLength === 'number';

    if (!valid) return null;

    return {
        rules: parsed.rules as GroupRuleConfig,
        keywords: parsed.keywords as string[],
        regexes: BUILTIN_GROUP_REGEXES,
        whitelist: parsed.whitelist as number[],
        maxTextLength: parsed.maxTextLength as number,
    };
}

/**
 * 将群组守卫配置写入缓存
 * 正则规则为进程内对象，不参与序列化
 * @param chatId 群组 ID
 * @param config 守卫配置，未登记时为 null
 * @returns 写入完成后的 Promise
 */
async function writeCache(chatId: number, config: GroupGuardConfig | null): Promise<void> {
    const key = buildCacheKey(chatId);
    if (config) {
        const { rules, keywords, whitelist, maxTextLength } = config;
        const cacheValue = { rules, keywords, whitelist, maxTextLength };
        await redis.set(key, JSON.stringify(cacheValue), 'EX', GROUP_GUARD_CACHE_TTL_SECONDS);
        return;
    }
    await redis.set(key, EMPTY_CACHE_VALUE, 'EX', GROUP_GUARD_EMPTY_CACHE_TTL_SECONDS);
}

/**
 * 读取群组守卫配置，缓存未命中时回源数据库
 * @param chatId 群组 ID
 * @returns 守卫配置，群组未登记或机器人已退出时返回 null
 */
export async function getGroupGuardConfig(chatId: number): Promise<GroupGuardConfig | null> {
    const key = buildCacheKey(chatId);

    try {
        const raw = await redis.get(key);
        if (raw !== null) {
            if (raw === EMPTY_CACHE_VALUE) return null;

            const cached = parseCachedConfig(raw);
            if (cached) return cached;
        }
    } catch (err) {
        logger.warn(`读取群组守卫缓存失败，回源数据库: ${err instanceof Error ? err.message : err}`);
    }

    const config = await loadGroupGuardConfig(chatId);

    try {
        await writeCache(chatId, config);
    } catch (err) {
        logger.warn(`写入群组守卫缓存失败: chatId=${chatId}, ${err instanceof Error ? err.message : err}`);
    }

    return config;
}

/**
 * 重新加载并刷新群组守卫缓存，规则变更或群组登记后调用
 * @param chatId 群组 ID
 * @returns 刷新完成后的 Promise
 */
export async function refreshGroupGuardCache(chatId: number): Promise<void> {
    try {
        const config = await loadGroupGuardConfig(chatId);
        await writeCache(chatId, config);
    } catch (err) {
        logger.error(`刷新群组守卫缓存失败: chatId=${chatId}, ${err instanceof Error ? err.stack : err}`);
    }
}

/**
 * 清除群组守卫缓存，机器人退群时调用
 * @param chatId 群组 ID
 * @returns 清除完成后的 Promise
 */
export async function clearGroupGuardCache(chatId: number): Promise<void> {
    try {
        await redis.del(buildCacheKey(chatId));
    } catch (err) {
        logger.warn(`清除群组守卫缓存失败: chatId=${chatId}, ${err instanceof Error ? err.message : err}`);
    }
}
