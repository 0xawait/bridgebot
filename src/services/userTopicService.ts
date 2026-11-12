import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import dbQuery from './mysqlService.js';

/** 用户与客服话题映射 */
export interface UserTopic {
    /** Telegram 用户 ID */
    userId: number;
    /** 话题所在群组 ID */
    chatId: number;
    /** 话题（Topic）ID */
    messageThreadId: number;
    /** 用户用户名，无用户名时为空串 */
    username: string;
    /** 用户昵称 */
    nickname: string;
}

/** 用户与话题映射查询结果行 */
interface UserTopicRow extends RowDataPacket {
    user_id: number;
    chat_id: number;
    message_thread_id: number;
    username: string;
    nickname: string;
}

/** 查询字段，避免使用 SELECT * */
const SELECT_FIELDS = '`user_id`, `chat_id`, `message_thread_id`, `username`, `nickname`';

/**
 * 将查询结果行转换为映射对象
 * @param row 数据库查询结果行
 * @returns 用户与话题映射
 */
function mapRow(row: UserTopicRow): UserTopic {
    return {
        userId: Number(row.user_id),
        chatId: Number(row.chat_id),
        messageThreadId: Number(row.message_thread_id),
        username: row.username ?? '',
        nickname: row.nickname ?? '',
    };
}

/**
 * 按用户 ID 查询已建立的话题映射
 * @param userId Telegram 用户 ID
 * @returns 话题映射，不存在时返回 null
 */
export async function findUserTopicByUserId(userId: number): Promise<UserTopic | null> {
    const rows = await dbQuery<UserTopicRow[]>(
        `SELECT ${SELECT_FIELDS} FROM \`sk_user_topic\` WHERE \`user_id\` = ? LIMIT 1`,
        [userId]
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
}

/**
 * 按群组与话题 ID 查询话题映射
 * @param chatId 群组 ID
 * @param messageThreadId 话题 ID
 * @returns 话题映射，不存在时返回 null
 */
export async function findUserTopicByThread(
    chatId: number,
    messageThreadId: number
): Promise<UserTopic | null> {
    const rows = await dbQuery<UserTopicRow[]>(
        `SELECT ${SELECT_FIELDS} FROM \`sk_user_topic\` WHERE \`chat_id\` = ? AND \`message_thread_id\` = ? LIMIT 1`,
        [chatId, messageThreadId]
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
}

/**
 * 删除用户话题映射，用户下次 /start 可重新创建话题
 * @param userId Telegram 用户 ID
 * @returns 删除完成后的 Promise
 */
export async function deleteUserTopic(userId: number): Promise<void> {
    await dbQuery<ResultSetHeader>('DELETE FROM `sk_user_topic` WHERE `user_id` = ?', [userId]);
}

/**
 * 保存用户话题映射，同一用户已存在时覆盖为最新话题
 * @param topic 话题映射
 * @returns 保存完成后的 Promise
 */
export async function saveUserTopic(topic: UserTopic): Promise<void> {
    const values = [topic.userId, topic.chatId, topic.messageThreadId, topic.username, topic.nickname];
    await dbQuery<ResultSetHeader>(
        'INSERT INTO `sk_user_topic` (`user_id`, `chat_id`, `message_thread_id`, `username`, `nickname`) VALUES (?, ?, ?, ?, ?)' +
            ' ON DUPLICATE KEY UPDATE `chat_id` = ?, `message_thread_id` = ?, `username` = ?, `nickname` = ?',
        [...values, ...values.slice(1)]
    );
}
