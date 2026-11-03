import { Bot } from 'grammy';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { ownerOnlyMiddleware } from './middleware';
import { registerCommands } from './commands';
import { registerCallbacks, setActiveBot } from './callbacks';
import { AgentService } from '../../ai/agent';
import { transcribeAudio, TranscriptionError } from '../../ai/transcribe';

let botInstance: Bot | null = null;
let isBotRunningFlag = false;

export function getBot(): Bot | null {
  return botInstance;
}

export function isBotRunning(): boolean {
  return isBotRunningFlag;
}

export async function initBot(): Promise<Bot | null> {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set. Telegram Bot will not start.');
    return null;
  }

  try {
    botInstance = new Bot(config.TELEGRAM_BOT_TOKEN);
    setActiveBot(botInstance);

    // Apply owner security isolation middleware
    botInstance.use(ownerOnlyMiddleware);

    // Register commands and inline callbacks
    registerCommands(botInstance);
    registerCallbacks(botInstance);

    // Handle incoming natural language text messages with AI Agent
    botInstance.on('message:text', async (ctx) => {
      const userId = ctx.from.id;
      const text = ctx.message.text;

      // Send typing status indicator
      await ctx.replyWithChatAction('typing');

      try {
        const response = await AgentService.processMessage(
          `telegram-bot:${userId}`,
          userId,
          text,
          ctx.chat.id.toString()
        );

        // Telegram messages have a 4096 character limit
        if (response.length > 4000) {
          for (let i = 0; i < response.length; i += 4000) {
            await ctx.reply(response.substring(i, i + 4000));
          }
        } else {
          await ctx.reply(response);
        }
      } catch (error: any) {
        logger.error('Error handling message in bot:', error);
        await ctx.reply(`⚠️ Произошла ошибка при обработке: ${error.message || 'Unknown error'}`);
      }
    });

    // Handle voice notes / round videos -> transcribe to text (Groq Whisper)
    botInstance.on(['message:voice', 'message:video_note', 'message:audio', 'message:document'], async (ctx) => {
      const isVoice = !!ctx.message.voice;
      const icon = isVoice ? '🎙' : '⭕️';

      // Documents are only transcribed if they are actually audio/video files —
      // otherwise any PDF/image/zip would be sent to Whisper and come back as
      // hallucinated garbage text.
      if (ctx.message.document) {
        const mime = ctx.message.document.mime_type || '';
        if (!/^(audio|video)\//.test(mime)) {
          await ctx.reply("⚠️ Bu audio fayl emas — transkripsiya bekor qilindi. Ovoz xabar (voice) yuboring yoki audio/video faylni tanlang.");
          return;
        }
      }
      const duration = ctx.message.voice?.duration ?? ctx.message.video_note?.duration ?? 0;

      try {
        const file = await ctx.getFile();
        if (!file.file_path) {
          await ctx.reply('⚠️ Faylni olish imkon bo\'lmadi. Qaytadan urinib ko\'ring.');
          return;
        }
        if (file.file_size && file.file_size > 25 * 1024 * 1024) {
          await ctx.reply('⚠️ Audio juda katta (25 MB dan ortiq) — Groq buni o\'qiy olmaydi.');
          return;
        }

        await ctx.replyWithChatAction('typing');

        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) {
          throw new Error(`Telegram file download failed (${fileResponse.status})`);
        }
        const buffer = Buffer.from(await fileResponse.arrayBuffer());

        const text = await transcribeAudio(buffer, isVoice ? 'voice.ogg' : 'video_note.mp4');
        if (!text) {
          await ctx.reply(`${icon} Nutq topilmadi.`);
          return;
        }

        const message = `${icon} ${text}`;
        if (message.length > 4000) {
          for (let i = 0; i < message.length; i += 4000) {
            await ctx.reply(message.substring(i, i + 4000));
          }
        } else {
          await ctx.reply(message);
        }

        logger.info(`Transcribed ${isVoice ? 'voice' : 'video note'} (${duration}s, ${buffer.length} bytes): ${text.slice(0, 60)}`);
      } catch (error: any) {
        logger.error('Error transcribing voice/video note:', error);
        if (error instanceof TranscriptionError) {
          await ctx.reply(`⚠️ Transkripsiya xatosi: ${error.message}`);
        } else {
          await ctx.reply(`⚠️ Ошибка при обработке аудио: ${error.message || 'Unknown error'}`);
        }
      }
    });

    // Start bot polling
    botInstance.start({
      onStart: (botInfo) => {
        logger.info(`Telegram Bot started successfully as @${botInfo.username} (ID: ${botInfo.id})`);
        isBotRunningFlag = true;
      },
    });

    return botInstance;
  } catch (error) {
    logger.error('Failed to initialize Telegram Bot:', error);
    isBotRunningFlag = false;
    return null;
  }
}

export async function stopBot(): Promise<void> {
  if (botInstance && isBotRunningFlag) {
    await botInstance.stop();
    isBotRunningFlag = false;
    logger.info('Telegram Bot stopped.');
  }
}
