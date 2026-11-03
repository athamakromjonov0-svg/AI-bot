import crypto from 'crypto';
import { ToolDefinition } from '../llm';
import { UserbotService } from '../../telegram/userbot/service';
import { PendingActionModel } from '../../database/models/PendingAction';
import { isDbConnected } from '../../database';
import { config } from '../../config/env';
import { notifyOwnerActionRequired } from '../../telegram/bot/callbacks';

export const getAccountStatusTool: ToolDefinition = {
  name: 'get_account_status',
  description: 'Check if the Telegram Userbot is currently connected and authenticated, and return account details (name, username, ID).',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const status = await UserbotService.getAccountStatus();
      if (!status.connected) {
        return {
          connected: false,
          message: status.error || 'Userbot is not connected. Please run `npm run login` in terminal.',
        };
      }
      return {
        connected: true,
        user: status.user,
        message: `✅ Akkaunt faol: ${status.user?.firstName || ''} (@${status.user?.username || 'no_username'}) id=${status.user?.id}`,
      };
    } catch (err: any) {
      return { connected: false, error: err.message };
    }
  },
};

export const findRecipientTool: ToolDefinition = {
  name: 'find_recipient',
  description: 'Search for a person, group, or channel by title/name/username to find their chat ID.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Name, title, or username to search for',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default: 15)',
      },
    },
  },
  handler: async (args: { query: string; limit?: number }) => {
    try {
      const results = await UserbotService.findRecipient(args.query, args.limit || 15);
      return {
        success: true,
        count: results.length,
        results: results.map((r) => `${r.title} (@${r.username || 'no_user'}) | ${r.type} | id=${r.id}`),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const getDialogsTool: ToolDefinition = {
  name: 'get_dialogs',
  description: 'Get a list of recent Telegram dialogs (direct chats, groups, and channels) with their titles, types, and IDs.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of dialogs to fetch (default: 20, max: 50)',
      },
    },
  },
  handler: async (args: { limit?: number }) => {
    try {
      const dialogs = await UserbotService.getDialogs(args.limit || 20);
      return { success: true, count: dialogs.length, dialogs };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const getChatHistoryTool: ToolDefinition = {
  name: 'get_chat_history',
  description: 'Retrieve message history from a specific Telegram chat by its chat ID or username.',
  parameters: {
    type: 'object',
    required: ['chatId'],
    properties: {
      chatId: {
        type: 'string',
        description: 'The target chat ID, username, or phone number',
      },
      limit: {
        type: 'number',
        description: 'Number of messages to retrieve (default: 20, max: 50)',
      },
      offsetId: {
        type: 'number',
        description: 'Message ID to start reading backwards from (pagination)',
      },
    },
  },
  handler: async (args: { chatId: string; limit?: number; offsetId?: number }) => {
    try {
      const messages = await UserbotService.getChatHistory(args.chatId, args.limit || 20, args.offsetId || 0);
      return { success: true, count: messages.length, messages };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const searchMessagesTool: ToolDefinition = {
  name: 'search_messages',
  description: 'Search for Telegram messages containing specific keywords in a chat or globally.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'The keyword or phrase to search for',
      },
      chatId: {
        type: 'string',
        description: 'Optional chat ID to narrow search to a specific chat',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 20)',
      },
    },
  },
  handler: async (args: { query: string; chatId?: string; limit?: number }) => {
    try {
      const results = await UserbotService.searchMessages(args.query, args.chatId, args.limit || 20);
      return { success: true, count: results.length, messages: results };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const sendMessageTool: ToolDefinition = {
  name: 'send_message',
  description: 'Send a message to a Telegram chat, user, or group. SECURITY: confirm MUST be set to true by user. If confirm=false or omitted, returns a preview only without sending anything.',
  parameters: {
    type: 'object',
    required: ['chatId', 'text'],
    properties: {
      chatId: {
        type: 'string',
        description: 'Target chat ID, username, or phone number',
      },
      text: {
        type: 'string',
        description: 'The exact text message content to send',
      },
      confirm: {
        type: 'boolean',
        description: 'Explicit user confirmation. Must be true to send. If false/omitted, only preview is returned.',
      },
      replyToMsgId: {
        type: 'number',
        description: 'Optional ID of the message to reply to',
      },
      forceDirectSend: {
        type: 'boolean',
        description: 'If true and confirm is true, bypasses draft mode (use only when explicitly permitted by owner)',
      },
    },
  },
  handler: async (args: { chatId: string; text: string; confirm?: boolean; replyToMsgId?: number; forceDirectSend?: boolean }) => {
    if (!args.chatId || !args.text) {
      return { success: false, error: 'chatId and text are required.' };
    }

    // STRICT USER CONSENT GUARD: Never send message without explicit confirm=true
    if (!args.confirm) {
      return {
        success: false,
        previewOnly: true,
        message: `⚠️ PREVYU — XABAR YUBORILMADI!\nKimga: ${args.chatId}\nMatn: "${args.text}"\n\n🔒 Xavfsizlik: Xabarni yuborish uchun foydalanuvchi tasdiqlashi va confirm=true parametri bilan chaqirishi shart.`,
      };
    }

    const requiresApproval = !args.forceDirectSend && config.DEFAULT_AUTO_REPLY_MODE === 'draft';

    // If draft mode is active and DB is connected, store as pending action and notify owner
    if (requiresApproval && isDbConnected()) {
      const actionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      const pendingAction = await PendingActionModel.create({
        actionId,
        type: 'send_message',
        targetChatId: args.chatId,
        text: args.text,
        proposedBy: 'agent',
        status: 'pending',
        expiresAt,
        metadata: {
          replyToMsgId: args.replyToMsgId,
        },
      });

      // Send inline buttons to owner's Telegram bot
      await notifyOwnerActionRequired(pendingAction);

      return {
        success: true,
        status: 'pending_approval',
        actionId,
        message: `Xabar egasiga (Telegram Botga) tasdiqlash uchun yuborildi. Inline tugma orqali tasdiqlangach jo'natiladi.`,
      };
    }

    // Direct send via Userbot
    const result = await UserbotService.sendMessage(args.chatId, args.text, args.replyToMsgId, 'ai_agent');
    return result;
  },
};
