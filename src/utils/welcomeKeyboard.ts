import { InlineKeyboard } from 'grammy';
import type { WelcomeButton } from '../services/welcomeService.js';

/**
 * 根据按钮配置构建欢迎语内联键盘，相同行序号的按钮展示在同一行
 * @param buttons 按钮列表
 * @returns 内联键盘
 */
export function buildWelcomeKeyboard(buttons: WelcomeButton[]): InlineKeyboard {
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
