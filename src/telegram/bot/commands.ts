import { Bot, Context, InputFile } from 'grammy';
import crypto from 'crypto';
import { isDbConnected } from '../../database';
import { isUserbotConnected } from '../userbot';
import { UserbotService } from '../userbot/service';
import { MemoryModel } from '../../database/models/Memory';
import { AutoReplyRuleModel } from '../../database/models/AutoReplyRule';
import { PendingActionModel } from '../../database/models/PendingAction';
import { config } from '../../config/env';
import { isRedisQueueActive } from '../../queues/queue';
import { getPcStatusTool, takePcScreenshotTool, lockPcTool } from '../../ai/tools/systemTools';

export function registerCommands(bot: Bot) {
  // /start
  bot.command('start', async (ctx: Context) => {
    const welcome = `🤖 *Atham AI Assistant & Notebook Copilot*
────────────────────────
Assalomu alaykum! Shaxsiy AI yordamchingiz xizmatingizda.

🚀 *Imkoniyatlar:*
• 💻 Notebookni to'liq boshqarish (Batareya, RAM, Disk, Skrinshot)
• 🔒 Hech kimga avtomatik xabar yozmaydi (faqat siz "yoz" desangiz ishlaydi)
• 📸 Ekran rasmini Telegramga yuborish
• 📂 Fayllarni o'qish, yaratish va boshqarish
• 🖥️ Terminal buyruqlarini bajarish va dasturlarni ochish
• 💬 Savollarga javob berish va muloqot

Asosiy buyruqlar:
/pc - Notebook holati (Batareya, RAM, Disk, Uptime)
/screenshot - Notebook ekranidan rasm olish
/lock - Notebook ekranini bloklash
/status - Barcha tizimlar holati
/help - To'liq ma'lumot va namunalar

Ixtiyoriy matn yozing yoki buyruq bering!`;

    await ctx.reply(welcome, { parse_mode: 'Markdown' });
  });

  // /help
  bot.command('help', async (ctx: Context) => {
    const helpText = `💡 *Botdan foydalanish bo'yicha qo'llanma:*

Siz botga o'zbek, rus yoki ingliz tilida erkin murojaat qilishingiz mumkin.

*Notebookni boshqarish namunalari:*
• _"Notebook holatini ko'rsat"_
• _"Ekran rasmini olib yubor"_
• _"Chrome (yoki boshqa dastur)ni och"_
• _"C diskimda qancha joy bor?"_
• _"Notebookni blokla"_
• _"Terminalda ipconfig buyrug'ini bajar"_

*Xabarlar bo'yicha qoidalar:*
• Bot o'zicha *HECH KIMGA* xabar yozmaydi!
• Faqat siz botga: _"Falonchiga mana bunday deb yoz"_ deb shaxsan buyursangizgina xabar yuborishi mumkin.

*Tezkor buyruqlar:*
• /pc — Batareya, RAM, Disk va Uptime
• /screenshot — Ekran skrinshotini olish
• /lock — Ekranni bloklash (Lock screen)
• /status — Tizim holati
• /dialogs — Telegram chatlar ro'yxati (agar userbot ulangan bo'lsa)`;

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
  });

  // /status
  bot.command('status', async (ctx: Context) => {
    const dbStatus = isDbConnected() ? '🟢 Подключена' : '🔴 Отключена';
    const userbotStatus = isUserbotConnected() ? '🟢 Активен' : '🔴 Не авторизован (запустите npm run login)';
    const queueStatus = isRedisQueueActive ? '🟢 Redis / BullMQ' : '🟡 Внутренняя очередь (InMemory)';
    const memoryCount = isDbConnected() ? await MemoryModel.countDocuments() : 0;
    const pendingCount = isDbConnected() ? await PendingActionModel.countDocuments({ status: 'pending' }) : 0;

    const statusMessage = `📊 *Статус системы:*
────────────────────────
• *MongoDB:* ${dbStatus}
• *Userbot:* ${userbotStatus}
• *Очередь задач:* ${queueStatus}
• *LLM Модель:* \`${config.LLM_MODEL}\`
• *Режим по умолчанию:* \`${config.DEFAULT_AUTO_REPLY_MODE}\`
• *Записей в памяти:* ${memoryCount}
• *Ожидает подтверждения:* ${pendingCount}
• *Uptime:* ${Math.round(process.uptime())} сек.`;

    await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
  });

  // /pc - Notebook status
  bot.command('pc', async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    const result = await getPcStatusTool.handler({});
    if (result.success && result.status) {
      const s = result.status;
      const batteryText = s.Battery ? `${s.Battery.Percentage}% (${s.Battery.Status})` : 'N/A';
      const msg = `💻 *Notebook holati:*
────────────────────────
🔋 *Batareya:* ${batteryText}
🧠 *Operativ xotira (RAM):* ${s.RAM_Used_GB} GB / ${s.RAM_Total_GB} GB (Bo'sh: ${s.RAM_Free_GB} GB)
💾 *Disk C:* Bo'sh: ${s.Drive_C_Free_GB} GB / Jami: ${s.Drive_C_Total_GB} GB
⏱️ *Uptime:* ${s.Uptime_Hours} soat
👤 *Foydalanuvchi:* \`${s.User}\` (${s.ComputerName})`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`⚠️ Notebook ma'lumotlarini olishda xatolik: ${result.error || 'Nomaʼlum'}`);
    }
  });

  // /screenshot - Screen capture
  bot.command('screenshot', async (ctx: Context) => {
    await ctx.replyWithChatAction('upload_photo');
    const result = await takePcScreenshotTool.handler({}, { chatId: ctx.chat?.id });
    if (!result.success) {
      await ctx.reply(`⚠️ Skrinshot olishda xatolik: ${result.error || 'Nomaʼlum'}`);
    }
  });

  // /lock - Lock workstation
  bot.command('lock', async (ctx: Context) => {
    const result = await lockPcTool.handler({});
    await ctx.reply(result.message || 'Notebook ekrani bloklandi.');
  });

  // /dialogs
  bot.command('dialogs', async (ctx: Context) => {
    if (!isUserbotConnected()) {
      await ctx.reply('⚠️ Userbot не подключен. Пожалуйста, выполните `npm run login`.');
      return;
    }

    try {
      await ctx.reply('⏳ Загружаю недавние диалоги из Telegram...');
      const dialogs = await UserbotService.getDialogs(15);

      if (dialogs.length === 0) {
        await ctx.reply('Диалоги не найдены.');
        return;
      }

      let msg = `📋 *Недавние диалоги (Userbot):*\n────────────────────────\n`;
      dialogs.forEach((d, idx) => {
        const typeBadge = d.type === 'channel' ? '📢' : d.type === 'group' ? '👥' : '👤';
        const unread = d.unreadCount > 0 ? ` (${d.unreadCount} новых)` : '';
        const userTag = d.username ? ` (@${d.username})` : '';
        msg += `${idx + 1}. ${typeBadge} *${d.title}*${userTag}${unread}\n   ID: \`${d.id}\`\n`;
      });

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ Ошибка получения диалогов: ${err.message}`);
    }
  });

  // /memories
  bot.command('memories', async (ctx: Context) => {
    if (!isDbConnected()) {
      await ctx.reply('⚠️ База данных не подключена.');
      return;
    }

    const memories = await MemoryModel.find().sort({ updatedAt: -1 }).limit(10);
    if (memories.length === 0) {
      await ctx.reply('🧠 В памяти пока нет сохраненных фактов. Вы можете сказать агенту: "Запомни, что..."');
      return;
    }

    let msg = `🧠 *Сохраненные факты (Память агента):*\n────────────────────────\n`;
    memories.forEach((m, idx) => {
      msg += `${idx + 1}. [${m.category}] *${m.content}*\n   ID: \`${m._id}\` (Важность: ${m.importance}/5)\n\n`;
    });
    msg += `Для удаления: \`/delmemory <ID>\``;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // /delmemory <id>
  bot.command('delmemory', async (ctx: Context) => {
    const memoryId = ctx.match?.toString().trim();
    if (!memoryId) {
      await ctx.reply('Укажите ID: `/delmemory <ID>`', { parse_mode: 'Markdown' });
      return;
    }

    if (!isDbConnected()) {
      await ctx.reply('⚠️ База данных не подключена.');
      return;
    }

    const deleted = await MemoryModel.findByIdAndDelete(memoryId);
    if (deleted) {
      await ctx.reply(`✅ Воспоминание \`${memoryId}\` успешно удалено.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ Воспоминание с таким ID не найдено.');
    }
  });

  // /rules
  bot.command('rules', async (ctx: Context) => {
    if (!isDbConnected()) {
      await ctx.reply('⚠️ База данных не подключена.');
      return;
    }

    const rules = await AutoReplyRuleModel.find();
    if (rules.length === 0) {
      await ctx.reply(
        '📭 Правила автоответов пока не созданы.\nПример создания: `/addrule Support direct * draft`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let msg = `⚙️ *Правила автоответчика:*\n────────────────────────\n`;
    rules.forEach((r, idx) => {
      const status = r.enabled ? '🟢 Вкл' : '🔴 Выкл';
      msg += `${idx + 1}. *${r.name}* [${status}]\n   Тип: \`${r.targetType}\` | Режим: \`${r.mode}\`\n   Триггеры: \`${r.keywords.join(', ')}\`\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // /mode <draft|auto>
  bot.command('mode', async (ctx: Context) => {
    const arg = ctx.match?.toString().trim().toLowerCase();
    if (arg === 'draft' || arg === 'auto') {
      config.DEFAULT_AUTO_REPLY_MODE = arg;
      await ctx.reply(`✅ Режим отправки сообщений изменен на: *${arg.toUpperCase()}*`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(
        `Текущий режим: *${config.DEFAULT_AUTO_REPLY_MODE}*\nДля изменения используйте:\n\`/mode draft\` — безопасный режим с подтверждением\n\`/mode auto\` — прямая автоотправка`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // /addrule
  bot.command('addrule', async (ctx: Context) => {
    const raw = ctx.match?.toString().trim();
    if (!raw) {
      await ctx.reply(
        'Формат команды:\n`/addrule <Имя> <direct|group|all> <ключевые,слова> <draft|auto>`\n\nПример:\n`/addrule Заказы direct заказ,купить draft`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const parts = raw.split(' ');
    const name = parts[0];
    const targetType = (parts[1] || 'direct') as any;
    const keywords = (parts[2] || '*').split(',');
    const mode = (parts[3] === 'auto' ? 'auto' : 'draft') as any;

    if (!isDbConnected()) {
      await ctx.reply('⚠️ База данных не подключена.');
      return;
    }

    const rule = await AutoReplyRuleModel.create({
      ruleId: crypto.randomUUID(),
      name,
      targetType,
      keywords,
      mode,
      enabled: true,
      cooldownSeconds: 60,
    });

    await ctx.reply(`✅ Правило автоответа *"${rule.name}"* успешно создано!`, { parse_mode: 'Markdown' });
  });
}
