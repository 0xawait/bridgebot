import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import dbQuery from './mysqlService.js';

/**
 * 查询已配置的群组 ID
 * @returns 群组 ID，未配置时返回 null
 */
export async function getGroupChatId(): Promise<number | null> {
    const rows = await dbQuery<RowDataPacket[]>(
        'SELECT `chat_id` FROM `sk_group_config` WHERE `id` = 1 LIMIT 1'
    );
    const chatId = rows[0]?.chat_id;
    return typeof chatId === 'number' ? chatId : null;
}

/**
 * 保存群组 ID，配置不存在时自动新增
 * @param chatId 群组 ID
 * @returns 保存完成后的 Promise
 */
export async function setGroupChatId(chatId: number): Promise<void> {
    await dbQuery<ResultSetHeader>(
        'INSERT INTO `sk_group_config` (`id`, `chat_id`) VALUES (1, ?) ON DUPLICATE KEY UPDATE `chat_id` = ?',
        [chatId, chatId]
    );
}
