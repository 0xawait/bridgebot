/**
 * 转义 HTML 特殊字符，避免用户输入破坏 Telegram HTML 消息格式
 * @param input 原始文本
 * @returns 转义后的文本
 */
export function escapeHtml(input: string): string {
    return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
