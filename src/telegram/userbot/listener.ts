import { NewMessage, NewMessageEvent } from 'telegram/events';
import { TelegramClient } from 'telegram';
import { logger } from '../../config/logger';
import { AutoReplyRuleModel } from '../../database/models/AutoReplyRule';
import { isDbConnected } from '../../database';
import { dispatchJob } from '../../queues/queue';
import { config } from '../../config/env';
import { getBot } from '../bot';
import { transcribeAudio } from '../../ai/transcribe';

// Track recently processed message IDs to prevent loops and duplicate processing
const processedMessages = new Set<string>();

// Separate dedup for the owner-notification relay so it never interferes with
// the auto-reply rule matching above.
const notifiedMessages = new Set<string>();

/** Simple flood guard: max notifications per rolling minute. */
const notifyTimestamps: number[] = [];
const NOTIFY_RATE_LIMIT = 30;

function canNotifyNow(): boolean {
  const now = Date.now();
  while (notifyTimestamps.length > 0 && now - notifyTimestamps[0] > 60_000) {
    notifyTimestamps.shift();
  }
  if (notifyTimestamps.length >= NOTIFY_RATE_LIMIT) return false;
  notifyTimestamps.push(now);
  return true;
}

/**
 * Incoming voice / round-video / audio -> text via Groq Whisper.
 * Returns '' when there is nothing usable (no key, download failure, empty
 * transcript) so the caller can fall back to the generic media label.
 */
async function transcribeIncomingVoice(
  message: NewMessageEvent['message']
): Promise<string> {
  try {
    if (!config.GROQ_API_KEY) {
      logger.warn('[NotifyRelay] GROQ_API_KEY missing — voice left untranscribed.');
      return '';
    }

    const downloaded = await message.downloadMedia();
    if (!Buffer.isBuffer(downloaded) || downloaded.length === 0) {
      logger.warn('[NotifyRelay] Voice media download returned no data.');
      return '';
    }

    const fileName = message.voice
      ? 'voice.ogg'
      : message.videoNote
        ? 'video_note.mp4'
        : 'audio.mp3';

    const text = (await transcribeAudio(downloaded, fileName)).trim();
    if (!text) {
      logger.info('[NotifyRelay] Transcription returned empty text.');
      return '';
    }

    logger.info(`[NotifyRelay] Voice transcribed: ${text.slice(0, 60)}`);
    return text;
  } catch (error) {
    logger.warn('Voice transcription failed for incoming message:', error);
    return '';
  }
}

/**
 * Owner notification relay: every NEW INCOMING PRIVATE message ("lichka") is
 * immediately forwarded to the owner's bot chat as plain text, so the owner
 * sees who wrote and what — without opening Telegram's main app.
 * Runs independently of ENABLE_AUTOREPLY — notifications are always on.
 * Deliberately plain text (no parse_mode): arbitrary user text with Markdown/
 * HTML symbols must never crash the notification with a 400 parse error.
 */
async function notifyOwnerOfIncoming(message: NewMessageEvent['message']): Promise<void> {
  try {
    const bot = getBot();
    if (!bot || !config.OWNER_TELEGRAM_ID) return;

    // Only private chats (a User entity has className 'User'); groups/channels
    // are excluded on purpose — "someone wrote to ME" means a direct message.
    const chat: any = await message.getChat();
    if (chat?.className !== 'User') return;

    const sender: any = await message.getSender();
    // Bots (OTP senders, services) and deleted accounts are noise, not people.
    if (sender?.bot || sender?.className === 'UserEmpty') return;

    const body = (message.text || '').trim();

    // Ovozli xabar (voice / aylana video / audio) — matnga o'girib egasiga yuboramiz
    const isAudioMessage = !!(message.voice || message.videoNote || message.audio);
    const transcript = isAudioMessage
      ? await transcribeIncomingVoice(message)
      : '';

    let media = '';
    if (!body && !transcript && message.media) {
      const kind = message.media.className || '';
      media = kind.includes('Photo')
        ? '📷 Rasm'
        : kind.includes('Document')
          ? isAudioMessage
            ? '🎙 Ovozli xabar (matn olinmadi)'
            : '📎 Fayl'
          : kind.includes('Webpage')
            ? '🔗 Link'
            : kind.includes('Sticker')
              ? '😀 Stiker'
              : kind.includes('Contact')
                ? '👤 Kontakt'
                : kind.includes('Geo')
                  ? '📍 Joy'
                  : '📎 Media';
    }
    const lines: string[] = [];
    if (body) lines.push(body);
    if (transcript) lines.push(`🎙 ${transcript}`);
    const content = lines.length > 0 ? lines.join('\n') : media;
    if (!content) return; // service messages (joined, pinned, ...)

    if (!canNotifyNow()) {
      logger.warn('[NotifyRelay] Rate limit reached — owner notification skipped.');
      return;
    }

    const name =
      [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || "Noma'lum";
    const username = sender?.username ? ` (@${sender.username})` : '';

    const notification =
      `📨 YANGI XABAR\n` +
      `Kim: ${name}${username}\n` +
      `ID: ${String(sender?.id ?? '')}\n` +
      `───────────\n` +
      content;

    // Telegram hard limit is 4096 chars — truncate safely.
    await bot.api.sendMessage(
      config.OWNER_TELEGRAM_ID,
      notification.slice(0, 4000)
    );
    logger.info(`[NotifyRelay] Incoming message from ${name} relayed to owner.`);
  } catch (error) {
    logger.error('Error relaying incoming message to owner:', error);
  }
}

export function registerUserbotListeners(client: TelegramClient) {
  // 1) Owner notification relay — ALWAYS on, registered FIRST so the owner
  //    learns about a new message the moment it arrives.
  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const message = event.message;
      if (!message) return;

      const key = `${message.chatId}:${message.id}`;
      if (notifiedMessages.has(key)) return;
      notifiedMessages.add(key);

      // Bound set size (same pattern as processedMessages below)
      if (notifiedMessages.size > 2000) {
        const toDelete = Array.from(notifiedMessages).slice(0, 500);
        toDelete.forEach((k) => notifiedMessages.delete(k));
      }

      await notifyOwnerOfIncoming(message);
    } catch (error) {
      logger.error('Error in Userbot notification listener:', error);
    }
  }, new NewMessage({ incoming: true }));

  // 2) Auto-reply rules (existing logic, gated by ENABLE_AUTOREPLY)
  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      // Hard Safety Switch: Never auto-reply if ENABLE_AUTOREPLY is not explicitly true
      if (!config.ENABLE_AUTOREPLY) {
        return;
      }

      const message = event.message;
      if (!message || !message.text) return;

      // 1. Filter: ignore outgoing messages (sent by self)
      if (message.out) return;

      // Deduplication check
      const messageKey = `${message.chatId}:${message.id}`;
      if (processedMessages.has(messageKey)) return;
      processedMessages.add(messageKey);

      // Bound set size
      if (processedMessages.size > 2000) {
        const toDelete = Array.from(processedMessages).slice(0, 500);
        toDelete.forEach((k) => processedMessages.delete(k));
      }

      const chatId = message.chatId?.toString() || '';
      const text = message.text.trim();
      const sender = await message.getSender();

      // Filter: ignore other bots
      if (sender && (sender as any).bot) {
        return;
      }

      // 2. Query AutoReplyRules from Database
      if (!isDbConnected()) {
        return;
      }

      const rules = await AutoReplyRuleModel.find({ enabled: true });
      if (!rules || rules.length === 0) return;

      for (const rule of rules) {
        // Check target chat
        if (rule.targetType === 'specific_chat' && rule.targetChatId !== chatId) {
          continue;
        }

        // Check exclude keywords
        const containsExcluded = rule.excludeKeywords.some((ex) =>
          text.toLowerCase().includes(ex.toLowerCase())
        );
        if (containsExcluded) continue;

        // Check trigger keywords
        const matchesKeyword =
          rule.keywords.includes('*') ||
          rule.keywords.some((kw) => text.toLowerCase().includes(kw.toLowerCase()));

        if (!matchesKeyword) continue;

        // Check cooldown
        if (rule.lastTriggeredAt && rule.cooldownSeconds > 0) {
          const diffSeconds = (Date.now() - rule.lastTriggeredAt.getTime()) / 1000;
          if (diffSeconds < rule.cooldownSeconds) {
            logger.debug(`Auto-reply skipped due to cooldown for chat: ${chatId}`);
            continue;
          }
        }

        // Update lastTriggeredAt
        rule.lastTriggeredAt = new Date();
        await rule.save();

        logger.info(`Auto-reply rule "${rule.name}" triggered by message in ${chatId}`);

        // Dispatch background job for AI generation and sending/drafting
        await dispatchJob(
          'auto_reply',
          {
            type: 'auto_reply',
            chatId,
            messageId: message.id,
            text,
            ruleId: rule.ruleId,
            metadata: {
              ruleName: rule.name,
              ruleMode: rule.mode || config.DEFAULT_AUTO_REPLY_MODE,
              customPrompt: rule.customPrompt,
            },
          },
          `auto-reply-${messageKey}`
        );

        break; // Match first eligible rule
      }
    } catch (error) {
      logger.error('Error in Userbot NewMessage listener:', error);
    }
  }, new NewMessage({}));

  logger.info('Userbot message listeners registered.');
}
