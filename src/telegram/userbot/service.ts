import { Api } from 'telegram';
import { getUserbotClient, isUserbotConnected } from './index';
import { logger } from '../../config/logger';
import { AuditLogModel } from '../../database/models/AuditLog';
import { isDbConnected } from '../../database';
import { config } from '../../config/env';

export interface ChatInfo {
  id: string;
  title: string;
  type: 'user' | 'group' | 'channel';
  username?: string;
  unreadCount: number;
}

export interface MessageItem {
  id: number;
  chatId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  date: Date;
  replyToMsgId?: number;
}

export class UserbotService {
  /**
   * Checks current userbot account status and returns info about the logged-in user.
   */
  public static async getAccountStatus(): Promise<{ connected: boolean; user?: any; error?: string }> {
    const client = getUserbotClient();
    if (!client || !isUserbotConnected()) {
      return { connected: false, error: 'Telegram Userbot ulanmagan. Iltimos, terminalda `npm run login` buyrug`ini ishga tushiring.' };
    }
    try {
      const me = await client.getMe();
      return {
        connected: true,
        user: {
          id: (me as any).id?.toString(),
          firstName: (me as any).firstName,
          lastName: (me as any).lastName,
          username: (me as any).username,
          phone: (me as any).phone,
        },
      };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * Finds recipient chat/user/channel by query name or username.
   */
  public static async findRecipient(query: string, limit: number = 15): Promise<ChatInfo[]> {
    const dialogs = await this.getDialogs(100);
    const q = query.toLowerCase().trim();
    return dialogs
      .filter((d) => (d.title && d.title.toLowerCase().includes(q)) || (d.username && d.username.toLowerCase().includes(q)) || d.id === q)
      .slice(0, limit);
  }

  /**
   * Retrieves a list of recent dialogs (chats, channels, groups).
   */
  public static async getDialogs(limit: number = 30): Promise<ChatInfo[]> {
    const client = getUserbotClient();
    if (!client || !isUserbotConnected()) {
      throw new Error('Telegram Userbot is not connected.');
    }

    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const dialogs = await client.getDialogs({ limit: safeLimit });

    const result: ChatInfo[] = [];
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      let type: 'user' | 'group' | 'channel' = 'user';
      if (dialog.isChannel) type = 'channel';
      else if (dialog.isGroup) type = 'group';

      result.push({
        id: dialog.id?.toString() || '',
        title: dialog.title || dialog.name || 'Unknown',
        type,
        username: (entity as any)?.username,
        unreadCount: dialog.unreadCount || 0,
      });
    }

    return result;
  }

  /**
   * Retrieves message history from a specific chat with pagination.
   */
  public static async getChatHistory(
    chatId: string | number,
    limit: number = 20,
    offsetId: number = 0
  ): Promise<MessageItem[]> {
    const client = getUserbotClient();
    if (!client || !isUserbotConnected()) {
      throw new Error('Telegram Userbot is not connected.');
    }

    const safeLimit = Math.min(Math.max(limit, 1), config.MAX_HISTORY_LIMIT);
    const entity = await client.getInputEntity(chatId);

    const messages = await client.getMessages(entity, {
      limit: safeLimit,
      offsetId: offsetId > 0 ? offsetId : undefined,
    });

    const items: MessageItem[] = [];
    for (const msg of messages) {
      if (!msg || !msg.message) continue;

      let senderName = '';
      if (msg.sender) {
        senderName = (msg.sender as any).firstName
          ? `${(msg.sender as any).firstName} ${(msg.sender as any).lastName || ''}`.trim()
          : (msg.sender as any).title || (msg.sender as any).username || '';
      }

      items.push({
        id: msg.id,
        chatId: chatId.toString(),
        senderId: msg.senderId?.toString(),
        senderName,
        text: msg.message,
        date: new Date(msg.date * 1000),
        replyToMsgId: msg.replyToMsgId || undefined,
      });
    }

    return items;
  }

  /**
   * Searches for messages containing specific text.
   */
  public static async searchMessages(
    query: string,
    chatId?: string | number,
    limit: number = 20
  ): Promise<MessageItem[]> {
    const client = getUserbotClient();
    if (!client || !isUserbotConnected()) {
      throw new Error('Telegram Userbot is not connected.');
    }

    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const entity = chatId ? await client.getInputEntity(chatId) : undefined;

    const messages = await client.getMessages(entity, {
      search: query,
      limit: safeLimit,
    });

    const items: MessageItem[] = [];
    for (const msg of messages) {
      if (!msg || !msg.message) continue;
      items.push({
        id: msg.id,
        chatId: chatId ? chatId.toString() : msg.chatId?.toString() || '',
        senderId: msg.senderId?.toString(),
        text: msg.message,
        date: new Date(msg.date * 1000),
      });
    }

    return items;
  }

  /**
   * Sends a message via the Userbot account with validation and audit logging.
   */
  public static async sendMessage(
    chatId: string | number,
    text: string,
    replyToMsgId?: number,
    actor: 'owner' | 'ai_agent' | 'userbot_auto' = 'ai_agent'
  ): Promise<{ success: boolean; messageId?: number; error?: string }> {
    const client = getUserbotClient();
    if (!client || !isUserbotConnected()) {
      const err = 'Telegram Userbot is not connected.';
      await this.recordAudit('send_message', actor, chatId.toString(), 'failed', { text }, err);
      return { success: false, error: err };
    }

    if (!text || text.trim().length === 0) {
      return { success: false, error: 'Cannot send empty message.' };
    }

    try {
      const entity = await client.getInputEntity(chatId);
      const sentMessage = await client.sendMessage(entity, {
        message: text,
        replyTo: replyToMsgId,
      });

      const messageId = sentMessage.id;
      logger.info(`Message sent via Userbot to ${chatId} (ID: ${messageId})`);

      await this.recordAudit('send_message', actor, chatId.toString(), 'success', {
        messageId,
        text,
        replyToMsgId,
      });

      return { success: true, messageId };
    } catch (error: any) {
      logger.error(`Failed to send message via Userbot to ${chatId}:`, error);

      await this.recordAudit('send_message', actor, chatId.toString(), 'failed', {
        text,
        replyToMsgId,
      }, error.message);

      return { success: false, error: error.message };
    }
  }

  private static async recordAudit(
    action: string,
    actor: 'owner' | 'ai_agent' | 'userbot_auto',
    targetChatId: string,
    status: 'success' | 'failed',
    details?: any,
    errorMessage?: string
  ) {
    if (isDbConnected()) {
      try {
        await AuditLogModel.create({
          action,
          actor,
          targetChatId,
          status,
          details,
          errorMessage,
        });
      } catch (err) {
        logger.warn('Failed to save audit log:', err);
      }
    }
  }
}
