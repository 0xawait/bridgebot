import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import dbQuery, { withTransaction } from './mysqlService.js';

/** 欢迎语按钮最大行数 */
export const WELCOME_MAX_ROWS = 5;

/** 欢迎语按钮 */
export interface WelcomeButton {
    /** 按钮主键 */
    id: number;
    /** 按钮文字 */
    text: string;
    /** 跳转链接 */
    url: string;
    /** 所在行序号，相同行序号的按钮展示在同一行 */
    rowIndex: number;
}

/** 待写入的按钮信息 */
export interface WelcomeButtonInput {
    /** 按钮文字 */
    text: string;
    /** 跳转链接 */
    url: string;
}

/** 欢迎语配置（文字 + 按钮） */
export interface WelcomeConfig {
    /** 欢迎语文字，未配置时为空串 */
    content: string;
    /** 按钮列表，按行与行内顺序排列 */
    buttons: WelcomeButton[];
}

/** 按钮查询结果行 */
interface WelcomeButtonRow extends RowDataPacket {
    id: number;
    text: string;
    url: string;
    row_index: number;
}

/**
 * 查询欢迎语文字
 * @returns 欢迎语文字，未配置时返回空串
 */
export async function getWelcomeContent(): Promise<string> {
    const rows = await dbQuery<RowDataPacket[]>(
        'SELECT `content` FROM `sk_welcome_config` WHERE `id` = 1 LIMIT 1'
    );
    const content = rows[0]?.content;
    return typeof content === 'string' ? content : '';
}

/**
 * 保存欢迎语文字，配置不存在时自动新增
 * @param content 欢迎语文字，支持 HTML
 * @returns 保存完成后的 Promise
 */
export async function setWelcomeContent(content: string): Promise<void> {
    await dbQuery<ResultSetHeader>(
        'INSERT INTO `sk_welcome_config` (`id`, `content`) VALUES (1, ?) ON DUPLICATE KEY UPDATE `content` = ?',
        [content, content]
    );
}

/**
 * 查询欢迎语按钮列表
 * @returns 按行与行内顺序排列的按钮列表
 */
export async function getWelcomeButtons(): Promise<WelcomeButton[]> {
    const rows = await dbQuery<WelcomeButtonRow[]>(
        'SELECT `id`, `text`, `url`, `row_index` FROM `sk_welcome_button` ORDER BY `row_index` ASC, `sort_order` ASC, `id` ASC'
    );
    return rows.map((row) => ({ id: row.id, text: row.text, url: row.url, rowIndex: row.row_index }));
}

/**
 * 查询完整欢迎语配置
 * @returns 欢迎语文字与按钮列表
 */
export async function getWelcomeConfig(): Promise<WelcomeConfig> {
    const [content, buttons] = await Promise.all([getWelcomeContent(), getWelcomeButtons()]);
    return { content, buttons };
}

/**
 * 批量新增按钮，按二维数组分行写入，每行追加到现有行之后
 * @param rows 按钮行数据，外层为行，内层为同一行的按钮
 * @returns 新增完成后的 Promise
 */
export async function addWelcomeButtons(rows: WelcomeButtonInput[][]): Promise<void> {
    if (!rows.length) return;

    await withTransaction(async (conn) => {
        const [maxRows] = await conn.query<RowDataPacket[]>(
            'SELECT COALESCE(MAX(`row_index`), -1) AS `maxRow` FROM `sk_welcome_button`'
        );
        const startRow = Number(maxRows[0]?.maxRow ?? -1) + 1;

        for (let rowOffset = 0; rowOffset < rows.length; rowOffset += 1) {
            const row = rows[rowOffset] ?? [];
            for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
                const item = row[columnIndex];
                if (!item) continue;
                await conn.query<ResultSetHeader>(
                    'INSERT INTO `sk_welcome_button` (`text`, `url`, `row_index`, `sort_order`) VALUES (?, ?, ?, ?)',
                    [item.text, item.url, startRow + rowOffset, columnIndex]
                );
            }
        }
    });
}

/**
 * 删除指定欢迎语按钮
 * @param id 按钮主键
 * @returns 删除完成后的 Promise
 */
export async function removeWelcomeButton(id: number): Promise<void> {
    await dbQuery<ResultSetHeader>('DELETE FROM `sk_welcome_button` WHERE `id` = ?', [id]);
}

/**
 * 清空欢迎语配置（文字与按钮）
 * @returns 清空完成后的 Promise
 */
export async function clearWelcome(): Promise<void> {
    await dbQuery<ResultSetHeader>('DELETE FROM `sk_welcome_config` WHERE `id` = 1');
    await dbQuery<ResultSetHeader>('DELETE FROM `sk_welcome_button`');
}
