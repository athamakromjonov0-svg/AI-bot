import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { PendingActionModel, IPendingAction } from '../../database/models/PendingAction';
import { UserbotService } from '../userbot/service';
import { isDbConnected } from '../../database';

let activeBotInstance: Bot | null = null;

export function setActiveBot(bot: Bot) {
  activeBotInstance = bot;
}

export async function notifyOwnerActionRequired(action: IPendingAction): Promise<void> {
  if (!activeBotInstance || !config.OWNER_TELEGRAM_ID) {
    logger.warn('Cannot send action approval message: bot or OWNER_TELEGRAM_ID not ready.');
    return;
  }

  const keyboard = new InlineKeyboard()
    .text('✅ Отправить (Send)', `approve:${action.actionId}`)
    .text('❌ Отклонить (Reject)', `reject:${action.actionId}`);

  const messageText = `📝 *Запрос на подтверждение отправки*
────────────────────────
🎯 *Получатель:* \`${action.targetChatId}\`
📌 *Тип:* \`${action.type}\`
🤖 *Инициатор:* \`${action.proposedBy}\`

💬 *Текст сообщения:*
> ${action.text.replace(/\n/g, '\n> ')}

Нажмите кнопку ниже для подтверждения или отклонения.`;

  try {
    await activeBotInstance.api.sendMessage(config.OWNER_TELEGRAM_ID, messageText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error('Failed to send approval notification to owner:', error);
  }
}

export function registerCallbacks(bot: Bot) {
  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const actionId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: 'Обработка...' });

    if (!isDbConnected()) {
      await ctx.editMessageText('❌ Ошибка: база данных недоступна.');
      return;
    }

    const action = await PendingActionModel.findOne({ actionId });
    if (!action) {
      await ctx.editMessageText('⚠️ Действие не найдено или истек срок действия.');
      return;
    }

    if (action.status !== 'pending') {
      await ctx.editMessageText(`ℹ️ Это действие уже было обработано со статусом: ${action.status}`);
      return;
    }

    // Send via Userbot
    const replyToMsgId = action.metadata?.replyToMsgId;
    const sendResult = await UserbotService.sendMessage(action.targetChatId, action.text, replyToMsgId, 'owner');

    if (sendResult.success) {
      action.status = 'approved';
      await action.save();

      await ctx.editMessageText(
        `✅ *Отправлено через Userbot*\n────────────────────────\n🎯 *Получатель:* \`${action.targetChatId}\`\n💬 *Текст:*\n> ${action.text.replace(/\n/g, '\n> ')}`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.editMessageText(`❌ Ошибка отправки: ${sendResult.error}`);
    }
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    const actionId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: 'Отклонено' });

    if (!isDbConnected()) {
      await ctx.editMessageText('❌ Ошибка: база данных недоступна.');
      return;
    }

    const action = await PendingActionModel.findOne({ actionId });
    if (action) {
      action.status = 'rejected';
      await action.save();
    }

    await ctx.editMessageText(`❌ Действие отклонено владельцем.`);
  });
}
