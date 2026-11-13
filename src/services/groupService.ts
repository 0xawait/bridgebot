import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import dbQuery from './mysqlService.js';
import logger from './loggerService.js';

/** 群组信息 */
export interface GroupInfo {
    /** 群组 ID */
    chatId: number;
    /** 群组标题 */
    title: string;
    /** 群组公开用户名，无公开用户名时为空串 */
    username: string;
    /** 群组类型 */
    type: 'group' | 'supergroup';
}

/** 群组查询结果行 */
interface GroupRow extends RowDataPacket {
    chat_id: number;
    title: string;
    username: string;
    type: 'group' | 'supergroup';
}

/** 内置关键词配置文件路径（项目根目录 config/builtinKeywords.json） */
const BUILTIN_KEYWORDS_FILE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../config/builtinKeywords.json'
);

/** 内置词库分类（关键词子串匹配 + 正则匹配） */
export interface BuiltinFilterCategory {
    /** 分类名称 */
    name: string;
    /** 分类下的关键词 */
    keywords: string[];
    /** 分类下的正则 */
    regexes: RegExp[];
}

/** 内置过滤配置（聚合后的关键词与正则） */
export interface BuiltinFilterConfig {
    /** 分类明细，用于面板展示 */
    categories: BuiltinFilterCategory[];
    /** 所有启用分类的关键词，按子串匹配（不区分大小写） */
    keywords: string[];
    /** 所有启用分类的正则，按行匹配（不区分大小写） */
    regexes: RegExp[];
}

/**
 * 将未知类型的配置项转换为去重后的非空字符串数组
 * @param value 配置项原始值
 * @returns 去重后的字符串数组，非数组时返回空数组
 */
function toUniqueStrings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const items = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);

    return [...new Set(items)];
}

/**
 * 解析正则配置项，支持纯 pattern 与 /pattern/flags 字面量两种写法
 * @param source 配置中的正则字符串
 * @returns 解析出的 pattern 与 flags
 */
function parseRegexSource(source: string): { pattern: string; flags: string } {
    if (!source.startsWith('/')) return { pattern: source, flags: '' };

    const end = source.lastIndexOf('/');
    if (end <= 0) return { pattern: source, flags: '' };

    const pattern = source.slice(1, end);
    const flags = source.slice(end + 1);
    if (!/^[dgimsuvy]*$/.test(flags)) return { pattern: source, flags: '' };

    return { pattern, flags };
}

/**
 * 编译正则规则，非法正则跳过并记录告警
 * 统一忽略大小写，并剔除有状态的 g/y 标记，避免 test() 的 lastIndex 影响后续匹配
 * @param sources 正则字符串列表
 * @returns 编译后的正则列表
 */
function compileRegexes(sources: string[]): RegExp[] {
    const regexes: RegExp[] = [];

    for (const source of sources) {
        const { pattern, flags } = parseRegexSource(source);
        const normalizedFlags = [...new Set(`${flags}i`)]
            .filter((flag) => flag !== 'g' && flag !== 'y')
            .join('');

        try {
            regexes.push(new RegExp(pattern, normalizedFlags));
        } catch (err) {
            logger.warn(`内置正则无效，已跳过: ${source}, ${err instanceof Error ? err.message : err}`);
        }
    }

    return regexes;
}

/**
 * 解析单个分类配置
 * @param raw 分类原始配置
 * @returns 分类配置，名称或内容为空时返回 null
 */
function parseCategory(raw: unknown): BuiltinFilterCategory | null {
    if (!raw || typeof raw !== 'object') return null;

    const item = raw as {
        name?: unknown;
        enabled?: unknown;
        keywords?: unknown;
        regexes?: unknown;
    };
    if (item.enabled === false) return null;

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const keywords = toUniqueStrings(item.keywords);
    const regexes = compileRegexes(toUniqueStrings(item.regexes));
    if (!name || (!keywords.length && !regexes.length)) return null;

    return { name, keywords, regexes };
}

/**
 * 将分类明细聚合为全局关键词与正则，关键词按首次出现顺序去重
 * @param categories 分类明细
 * @returns 聚合后的关键词与正则
 */
function flattenCategories(categories: BuiltinFilterCategory[]): {
    keywords: string[];
    regexes: RegExp[];
} {
    const keywords: string[] = [];
    const regexes: RegExp[] = [];
    const seen = new Set<string>();

    for (const category of categories) {
        for (const keyword of category.keywords) {
            const key = keyword.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            keywords.push(keyword);
        }
        regexes.push(...category.regexes);
    }

    return { keywords, regexes };
}

/**
 * 解析内置过滤配置，兼容分类格式、对象格式与顶层字符串数组的旧格式
 * 文件不存在或格式异常时按空配置处理，不阻断机器人启动
 * @returns 内置词库配置
 */
function loadBuiltinFilterConfig(): BuiltinFilterConfig {
    const empty: BuiltinFilterConfig = { categories: [], keywords: [], regexes: [] };

    let raw: string;
    try {
        raw = readFileSync(BUILTIN_KEYWORDS_FILE, 'utf8');
    } catch (err) {
        logger.warn(
            `读取内置关键词配置文件失败: ${BUILTIN_KEYWORDS_FILE}, ${err instanceof Error ? err.message : err}`
        );
        return empty;
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        // 旧格式：顶层直接为字符串数组
        if (Array.isArray(parsed)) {
            const keywords = toUniqueStrings(parsed);
            return {
                categories: keywords.length
                    ? [{ name: '默认', keywords, regexes: [] }]
                    : [],
                keywords,
                regexes: [],
            };
        }
        if (!parsed || typeof parsed !== 'object') {
            logger.warn('内置关键词配置文件格式错误，应为对象或字符串数组');
            return empty;
        }

        const config = parsed as { categories?: unknown; keywords?: unknown; regexes?: unknown };

        // 分类格式：按分类维护关键词与正则，可按 enabled 关闭单个分类
        if (Array.isArray(config.categories)) {
            const categories = config.categories
                .map((item) => parseCategory(item))
                .filter((item): item is BuiltinFilterCategory => item !== null);

            return { categories, ...flattenCategories(categories) };
        }

        // 旧格式：顶层 keywords / regexes
        const keywords = toUniqueStrings(config.keywords);
        const regexes = compileRegexes(toUniqueStrings(config.regexes));
        return {
            categories: keywords.length || regexes.length
                ? [{ name: '默认', keywords, regexes }]
                : [],
            keywords,
            regexes,
        };
    } catch (err) {
        logger.warn(`解析内置关键词配置文件失败: ${err instanceof Error ? err.message : err}`);
        return empty;
    }
}

/** 内置过滤配置，启动时从 config/builtinKeywords.json 读取 */
const BUILTIN_FILTER_CONFIG: BuiltinFilterConfig = loadBuiltinFilterConfig();

/** 内置关键词，启动时从 config/builtinKeywords.json 读取 */
export const BUILTIN_GROUP_KEYWORDS: string[] = BUILTIN_FILTER_CONFIG.keywords;

/** 内置正则规则，启动时从 config/builtinKeywords.json 读取 */
export const BUILTIN_GROUP_REGEXES: RegExp[] = BUILTIN_FILTER_CONFIG.regexes;

/** 内置词库分类明细，用于面板展示 */
export const BUILTIN_KEYWORD_CATEGORIES: BuiltinFilterCategory[] = BUILTIN_FILTER_CONFIG.categories;

/** 群组自动删除规则标识 */
export type GroupRuleKey =
    | 'keyword'
    | 'link'
    | 'forward'
    | 'sticker'
    | 'photo'
    | 'video'
    | 'file'
    | 'inline'
    | 'reply_chat'
    | 'sender_chat'
    | 'contact'
    | 'long_text';

/** 群组自动删除规则展示顺序 */
export const GROUP_RULE_KEYS: GroupRuleKey[] = [
    'keyword',
    'link',
    'forward',
    'sticker',
    'photo',
    'video',
    'file',
    'inline',
    'reply_chat',
    'sender_chat',
    'contact',
    'long_text',
];

/** 群组自动删除规则开关状态 */
export type GroupRuleConfig = Record<GroupRuleKey, boolean>;

/** 规则标识与数据库字段的映射 */
const RULE_COLUMN_MAP: Record<GroupRuleKey, string> = {
    keyword: 'del_keyword',
    link: 'del_link',
    forward: 'del_forward',
    sticker: 'del_sticker',
    photo: 'del_photo',
    video: 'del_video',
    file: 'del_file',
    inline: 'del_inline',
    reply_chat: 'del_reply_chat',
    sender_chat: 'del_sender_chat',
    contact: 'del_contact',
    long_text: 'del_long_text',
};

/** 规则查询结果行 */
interface GroupRuleRow extends RowDataPacket {
    del_keyword: 'enable' | 'disable';
    del_link: 'enable' | 'disable';
    del_forward: 'enable' | 'disable';
    del_sticker: 'enable' | 'disable';
    del_photo: 'enable' | 'disable';
    del_video: 'enable' | 'disable';
    del_file: 'enable' | 'disable';
    del_inline: 'enable' | 'disable';
    del_reply_chat: 'enable' | 'disable';
    del_sender_chat: 'enable' | 'disable';
    del_contact: 'enable' | 'disable';
    del_long_text: 'enable' | 'disable';
}

/**
 * 将查询结果行转换为群组信息
 * @param row 查询结果行
 * @returns 群组信息
 */
function mapGroupRow(row: GroupRow): GroupInfo {
    return {
        chatId: Number(row.chat_id),
        title: row.title,
        username: row.username,
        type: row.type,
    };
}

/**
 * 新增或更新群组记录，同时将状态置为 enable
 * @param info 群组信息
 * @returns 保存完成后的 Promise
 */
export async function saveGroup(info: GroupInfo): Promise<void> {
    await dbQuery<ResultSetHeader>(
        'INSERT INTO `sk_group` (`chat_id`, `title`, `username`, `type`, `status`) VALUES (?, ?, ?, ?, \'enable\') ' +
            'ON DUPLICATE KEY UPDATE `title` = ?, `username` = ?, `type` = ?, `status` = \'enable\'',
        [
            info.chatId,
            info.title.slice(0, 255),
            info.username.slice(0, 64),
            info.type,
            info.title.slice(0, 255),
            info.username.slice(0, 64),
            info.type,
        ]
    );
}

/**
 * 标记机器人已退出群组
 * @param chatId 群组 ID
 * @returns 更新完成后的 Promise
 */
export async function markGroupLeft(chatId: number): Promise<void> {
    await dbQuery<ResultSetHeader>('UPDATE `sk_group` SET `status` = \'disable\' WHERE `chat_id` = ?', [
        chatId,
    ]);
}

/**
 * 查询机器人当前已加入的群组列表
 * @returns 群组列表，按加入时间升序
 */
export async function listEnabledGroups(): Promise<GroupInfo[]> {
    const rows = await dbQuery<GroupRow[]>(
        'SELECT `chat_id`, `title`, `username`, `type` FROM `sk_group` WHERE `status` = \'enable\' ORDER BY `created_at` ASC, `id` ASC'
    );

    return rows.map(mapGroupRow);
}

/**
 * 按群组 ID 查询机器人当前仍在的群组
 * @param chatId 群组 ID
 * @returns 群组信息，不存在或机器人已退出时返回 null
 */
export async function findEnabledGroup(chatId: number): Promise<GroupInfo | null> {
    const rows = await dbQuery<GroupRow[]>(
        'SELECT `chat_id`, `title`, `username`, `type` FROM `sk_group` WHERE `chat_id` = ? AND `status` = \'enable\' LIMIT 1',
        [chatId]
    );

    return rows[0] ? mapGroupRow(rows[0]) : null;
}

/**
 * 查询群组自动删除规则开关
 * @param chatId 群组 ID
 * @returns 规则开关，群组不存在或机器人已退出时返回 null
 */
export async function getGroupRules(chatId: number): Promise<GroupRuleConfig | null> {
    const rows = await dbQuery<GroupRuleRow[]>(
        'SELECT `del_keyword`, `del_link`, `del_forward`, `del_sticker`, `del_photo`, `del_video`, `del_file`, ' +
            '`del_inline`, `del_reply_chat`, `del_sender_chat`, `del_contact`, `del_long_text` ' +
            'FROM `sk_group` WHERE `chat_id` = ? AND `status` = \'enable\' LIMIT 1',
        [chatId]
    );
    const row = rows[0];
    if (!row) return null;

    return {
        keyword: row.del_keyword === 'enable',
        link: row.del_link === 'enable',
        forward: row.del_forward === 'enable',
        sticker: row.del_sticker === 'enable',
        photo: row.del_photo === 'enable',
        video: row.del_video === 'enable',
        file: row.del_file === 'enable',
        inline: row.del_inline === 'enable',
        reply_chat: row.del_reply_chat === 'enable',
        sender_chat: row.del_sender_chat === 'enable',
        contact: row.del_contact === 'enable',
        long_text: row.del_long_text === 'enable',
    };
}

/**
 * 设置群组自动删除规则开关
 * @param chatId 群组 ID
 * @param rule 规则标识
 * @param enabled 是否开启
 * @returns 更新完成后的 Promise
 */
export async function setGroupRule(
    chatId: number,
    rule: GroupRuleKey,
    enabled: boolean
): Promise<void> {
    // 列名来自固定映射表，不接受外部任意输入
    const column = RULE_COLUMN_MAP[rule];
    await dbQuery<ResultSetHeader>(
        `UPDATE \`sk_group\` SET \`${column}\` = ? WHERE \`chat_id\` = ? AND \`status\` = 'enable'`,
        [enabled ? 'enable' : 'disable', chatId]
    );
}

/** 关键词查询结果行 */
interface GroupKeywordRow extends RowDataPacket {
    id: number;
    keyword: string;
}

/** 群组自定义关键词 */
export interface GroupKeyword {
    /** 关键词记录 ID */
    id: number;
    /** 关键词内容 */
    keyword: string;
}

/**
 * 查询群组配置的关键词列表
 * @param chatId 群组 ID
 * @returns 关键词列表，按添加顺序
 */
export async function listGroupKeywords(chatId: number): Promise<string[]> {
    const rows = await listGroupKeywordRows(chatId);
    return rows.map((row) => row.keyword);
}

/**
 * 查询群组自定义关键词（含记录 ID，供管理面板使用）
 * @param chatId 群组 ID
 * @returns 关键词列表，按添加顺序
 */
export async function listGroupKeywordRows(chatId: number): Promise<GroupKeyword[]> {
    const rows = await dbQuery<GroupKeywordRow[]>(
        'SELECT `id`, `keyword` FROM `sk_group_keyword` WHERE `chat_id` = ? ORDER BY `id` ASC',
        [chatId]
    );

    return rows.map((row) => ({ id: Number(row.id), keyword: row.keyword }));
}

/**
 * 批量新增群组关键词，重复关键词自动忽略
 * @param chatId 群组 ID
 * @param keywords 关键词列表
 * @returns 新增完成后的 Promise
 */
export async function addGroupKeywords(chatId: number, keywords: string[]): Promise<void> {
    if (!keywords.length) return;

    const values: unknown[] = [];
    const placeholders = keywords
        .map((keyword) => {
            values.push(chatId, keyword);
            return '(?, ?)';
        })
        .join(', ');

    await dbQuery<ResultSetHeader>(
        `INSERT IGNORE INTO \`sk_group_keyword\` (\`chat_id\`, \`keyword\`) VALUES ${placeholders}`,
        values
    );
}

/**
 * 批量删除群组关键词
 * @param chatId 群组 ID
 * @param keywords 关键词列表
 * @returns 实际删除的条数
 */
export async function removeGroupKeywords(chatId: number, keywords: string[]): Promise<number> {
    if (!keywords.length) return 0;

    const placeholders = keywords.map(() => '?').join(', ');
    const result = await dbQuery<ResultSetHeader>(
        `DELETE FROM \`sk_group_keyword\` WHERE \`chat_id\` = ? AND \`keyword\` IN (${placeholders})`,
        [chatId, ...keywords]
    );

    return result.affectedRows;
}

/** 白名单查询结果行 */
interface GroupWhitelistRow extends RowDataPacket {
    user_id: number;
}

/**
 * 查询群组白名单用户 ID 列表
 * @param chatId 群组 ID
 * @returns 白名单用户 ID 列表，按添加顺序
 */
export async function listGroupWhitelist(chatId: number): Promise<number[]> {
    const rows = await dbQuery<GroupWhitelistRow[]>(
        'SELECT `user_id` FROM `sk_group_whitelist` WHERE `chat_id` = ? ORDER BY `id` ASC',
        [chatId]
    );

    return rows.map((row) => Number(row.user_id));
}

/**
 * 批量新增群组白名单用户，重复添加自动忽略
 * @param chatId 群组 ID
 * @param userIds 用户 ID 列表
 * @returns 新增完成后的 Promise
 */
export async function addGroupWhitelistUsers(chatId: number, userIds: number[]): Promise<void> {
    if (!userIds.length) return;

    const values: unknown[] = [];
    const placeholders = userIds
        .map((userId) => {
            values.push(chatId, userId);
            return '(?, ?)';
        })
        .join(', ');

    await dbQuery<ResultSetHeader>(
        `INSERT IGNORE INTO \`sk_group_whitelist\` (\`chat_id\`, \`user_id\`) VALUES ${placeholders}`,
        values
    );
}

/**
 * 批量移除群组白名单用户
 * @param chatId 群组 ID
 * @param userIds 用户 ID 列表
 * @returns 实际移除的条数
 */
export async function removeGroupWhitelistUsers(
    chatId: number,
    userIds: number[]
): Promise<number> {
    if (!userIds.length) return 0;

    const placeholders = userIds.map(() => '?').join(', ');
    const result = await dbQuery<ResultSetHeader>(
        `DELETE FROM \`sk_group_whitelist\` WHERE \`chat_id\` = ? AND \`user_id\` IN (${placeholders})`,
        [chatId, ...userIds]
    );

    return result.affectedRows;
}

/** 群组长文本删除阈值查询结果行 */
interface GroupMaxTextLengthRow extends RowDataPacket {
    max_text_length: number;
}

/**
 * 查询群组长文本删除阈值
 * @param chatId 群组 ID
 * @returns 阈值（字符数），群组不存在或机器人已退出时返回 null
 */
export async function getGroupMaxTextLength(chatId: number): Promise<number | null> {
    const rows = await dbQuery<GroupMaxTextLengthRow[]>(
        'SELECT `max_text_length` FROM `sk_group` WHERE `chat_id` = ? AND `status` = \'enable\' LIMIT 1',
        [chatId]
    );
    const value = rows[0]?.max_text_length;
    return typeof value === 'number' ? Number(value) : null;
}

/**
 * 设置群组长文本删除阈值
 * @param chatId 群组 ID
 * @param maxTextLength 阈值（字符数）
 * @returns 更新完成后的 Promise
 */
export async function setGroupMaxTextLength(chatId: number, maxTextLength: number): Promise<void> {
    await dbQuery<ResultSetHeader>(
        'UPDATE `sk_group` SET `max_text_length` = ? WHERE `chat_id` = ? AND `status` = \'enable\'',
        [maxTextLength, chatId]
    );
}
