import { InlineKeyboard } from 'grammy';
import type { AdButton } from '../services/adService.js';

/**
 * 根据广告按钮构建内联键盘，相同行序号的按钮展示在同一行
 * @param buttons 有效广告按钮列表
 * @returns 内联键盘，无按钮时返回 undefined
 */
export function buildAdKeyboard(buttons: AdButton[]): InlineKeyboard | undefined {
    if (!buttons.length) return undefined;

    const keyboard = new InlineKeyboard();
    let lastRowIndex: number | null = null;

    for (const button of buttons) {
        if (lastRowIndex !== null && button.rowIndex !== lastRowIndex) {
            keyboard.row();
        }
        keyboard.url(button.text, button.url);
        lastRowIndex = button.rowIndex;
    }

    return keyboard;
}
