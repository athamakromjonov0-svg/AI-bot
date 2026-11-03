import crypto from 'crypto';
import { ToolDefinition } from '../llm';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { getBot } from '../../telegram/bot';
import { ReminderModel, IReminder } from '../../database/models/Reminder';
import { isDbConnected } from '../../database';

/**
 * In-memory fallback so reminders still fire when MongoDB is down.
 * The DB copy (if any) is the durable source of truth; this map only holds
 * what the poller must watch within this process lifetime.
 */
const pendingReminders = new Map<string, IReminder>();

let pollerHandle: NodeJS.Timeout | null = null;

/** Resolves which chat a reminder should be delivered to. Owner only. */
function resolveOwnerChatId(contextChatId?: string): string {
  if (config.OWNER_TELEGRAM_ID) return String(config.OWNER_TELEGRAM_ID);
  return contextChatId || '';
}

/**
 * Parses the scheduling input into an absolute Date.
 * Accepts an ISO string, an epoch millis number, or a relative "in N minutes/hours/days".
 */
export function resolveFireAt(args: {
  at?: string | number;
  inMinutes?: number;
  inHours?: number;
  inDays?: number;
}, now: Date = new Date()): { fireAt: Date } | { error: string } {
  if (args.at !== undefined && args.at !== null && args.at !== '') {
    const parsed = typeof args.at === 'number' ? new Date(args.at) : new Date(args.at);
    if (Number.isNaN(parsed.getTime())) {
      return { error: `Could not parse "at" value into a date: ${String(args.at)}` };
    }
    if (parsed.getTime() <= now.getTime()) {
      return { error: `Scheduled time is in the past: ${parsed.toISOString()}` };
    }
    return { fireAt: parsed };
  }

  const totalMinutes =
    (args.inMinutes || 0) + (args.inHours || 0) * 60 + (args.inDays || 0) * 1440;

  if (totalMinutes <= 0) {
    return { error: 'Provide either "at" (a future date/time) or a positive inMinutes/inHours/inDays.' };
  }

  return { fireAt: new Date(now.getTime() + totalMinutes * 60_000) };
}

/** Delivers a due reminder to the owner. Never targets anyone else. */
async function deliverReminder(reminder: IReminder): Promise<boolean> {
  const bot = getBot();
  if (!bot) {
    logger.warn(`[Scheduler] Bot not running; reminder ${reminder.reminderId} stays pending.`);
    return false;
  }

  const target = reminder.chatId;
  if (!target) {
    logger.warn(`[Scheduler] Reminder ${reminder.reminderId} has no target chat. Marking failed.`);
    return false;
  }

  // Defensive: this feature is owner-only by design.
  if (config.OWNER_TELEGRAM_ID && target !== String(config.OWNER_TELEGRAM_ID)) {
    logger.error(
      `[Scheduler] Refusing to send reminder ${reminder.reminderId} to non-owner chat ${target}.`
    );
    return false;
  }

  try {
    await bot.api.sendMessage(target, `⏰ Eslatma:\n\n${reminder.text}`);
    return true;
  } catch (err: any) {
    logger.error(`[Scheduler] Failed to deliver reminder ${reminder.reminderId}: ${err.message}`);
    return false;
  }
}

/** Marks a reminder as delivered (or repeating) and persists the change. */
async function markDelivered(reminder: IReminder): Promise<void> {
  if (reminder.repeatMinutes && reminder.repeatMinutes > 0) {
    reminder.fireAt = new Date(Date.now() + reminder.repeatMinutes * 60_000);
    reminder.sentAt = new Date();
    if (isDbConnected()) {
      await ReminderModel.updateOne(
        { reminderId: reminder.reminderId },
        { fireAt: reminder.fireAt, sentAt: reminder.sentAt }
      );
    }
    return;
  }

  reminder.status = 'sent';
  reminder.sentAt = new Date();
  pendingReminders.delete(reminder.reminderId);
  if (isDbConnected()) {
    await ReminderModel.updateOne(
      { reminderId: reminder.reminderId },
      { status: 'sent', sentAt: reminder.sentAt }
    );
  }
}

/** One poll cycle: find due reminders and deliver them. */
async function pollDueReminders(): Promise<void> {
  try {
    // Re-hydrate from DB so reminders survive a restart.
    if (isDbConnected()) {
      const due = await ReminderModel.find({
        status: 'scheduled',
        fireAt: { $lte: new Date() },
      }).limit(20);

      for (const doc of due) {
        pendingReminders.set(doc.reminderId, doc);
      }
    }

    if (pendingReminders.size === 0) return;

    const now = Date.now();
    for (const reminder of Array.from(pendingReminders.values())) {
      if (reminder.fireAt.getTime() > now) continue;

      const delivered = await deliverReminder(reminder);
      if (delivered) {
        logger.info(`[Scheduler] Reminder delivered: ${reminder.reminderId}`);
        await markDelivered(reminder);
      } else if (!isDbConnected()) {
        // No DB to retry from — drop it rather than spin forever.
        pendingReminders.delete(reminder.reminderId);
      }
    }
  } catch (err: any) {
    logger.error(`[Scheduler] Poll cycle failed: ${err.message}`);
  }
}

/** Starts the background reminder poller. Safe to call more than once. */
export function startReminderScheduler(intervalMs = 30_000): void {
  if (pollerHandle) return;
  pollerHandle = setInterval(pollDueReminders, intervalMs);
  // Never keep the process alive just for the poller.
  pollerHandle.unref?.();
  logger.info(`[Scheduler] Reminder poller started (every ${intervalMs}ms).`);
}

/** Stops the background reminder poller. */
export function stopReminderScheduler(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
    logger.info('[Scheduler] Reminder poller stopped.');
  }
}

/** Exposed for tests — runs exactly one poll cycle. */
export async function runSchedulerOnceForTest(): Promise<void> {
  await pollDueReminders();
}

export const scheduleReminderTool: ToolDefinition = {
  name: 'schedule_reminder',
  description:
    'Schedule a reminder for the future. The owner receives it in Telegram at the chosen time. Use for any task that must happen later (calls, follow-ups, deadlines, recurring habits).',
  parameters: {
    type: 'object',
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        description: 'The reminder message to show the owner.',
      },
      at: {
        type: 'string',
        description:
          'Absolute fire time as ISO 8601 (e.g. "2026-10-30T09:00:00") or epoch milliseconds. Mutually exclusive with inMinutes/inHours/inDays.',
      },
      inMinutes: {
        type: 'number',
        description: 'Fire in N minutes from now.',
      },
      inHours: {
        type: 'number',
        description: 'Fire in N hours from now.',
      },
      inDays: {
        type: 'number',
        description: 'Fire in N days from now.',
      },
      repeatMinutes: {
        type: 'number',
        description: 'Optional: repeat every N minutes after each delivery. Omit for one-shot.',
      },
    },
  },
  handler: async (args: any, context?: any) => {
    try {
      const resolved = resolveFireAt(args);
      if ('error' in resolved) return { success: false, error: resolved.error };

      const chatId = resolveOwnerChatId(context?.chatId);
      if (!chatId) {
        return {
          success: false,
          error: 'No owner chat available to deliver the reminder to.',
        };
      }

      if (args.repeatMinutes !== undefined && (!Number.isFinite(args.repeatMinutes) || args.repeatMinutes < 1)) {
        return { success: false, error: 'repeatMinutes must be a positive number of minutes.' };
      }

      const reminderId = crypto.randomUUID();
      const record: Partial<IReminder> = {
        reminderId,
        chatId,
        text: String(args.text),
        fireAt: resolved.fireAt,
        status: 'scheduled',
        repeatMinutes: args.repeatMinutes,
        createdBy: config.OWNER_TELEGRAM_ID || context?.userId || 0,
      };

      if (isDbConnected()) {
        const doc = await ReminderModel.create(record);
        pendingReminders.set(reminderId, doc);
      } else {
        // Fallback: keep it in memory only, clearly flagged to the caller.
        pendingReminders.set(reminderId, record as IReminder);
        logger.warn('[Scheduler] MongoDB offline — reminder held in memory only (lost on restart).');
      }

      return {
        success: true,
        reminderId,
        fireAt: resolved.fireAt.toISOString(),
        repeatMinutes: args.repeatMinutes || null,
        persistent: isDbConnected(),
        message: `✅ Eslatma o'rnatildi: ${resolved.fireAt.toLocaleString()}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const listRemindersTool: ToolDefinition = {
  name: 'list_reminders',
  description: 'List all scheduled reminders with their IDs and fire times.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    try {
      let items: IReminder[] = Array.from(pendingReminders.values());

      if (isDbConnected()) {
        items = await ReminderModel.find({ status: 'scheduled' }).sort({ fireAt: 1 }).limit(50);
      }

      if (items.length === 0) return { success: true, count: 0, reminders: [] };

      return {
        success: true,
        count: items.length,
        reminders: items.map((r) => ({
          id: r.reminderId,
          fireAt: r.fireAt.toISOString(),
          text: r.text,
          repeatMinutes: r.repeatMinutes || null,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const cancelReminderTool: ToolDefinition = {
  name: 'cancel_reminder',
  description: 'Cancel a scheduled reminder by its ID. Use list_reminders first to find the ID.',
  parameters: {
    type: 'object',
    required: ['reminderId'],
    properties: {
      reminderId: {
        type: 'string',
        description: 'The ID of the reminder to cancel.',
      },
    },
  },
  handler: async (args: { reminderId: string }) => {
    try {
      const id = args.reminderId;
      const existed = pendingReminders.delete(id);

      if (isDbConnected()) {
        const res = await ReminderModel.updateOne(
          { reminderId: id, status: 'scheduled' },
          { status: 'cancelled' }
        );
        if (res.modifiedCount > 0) {
          return { success: true, message: `Cancelled reminder ${id}.` };
        }
      }

      if (existed) return { success: true, message: `Cancelled reminder ${id}.` };
      return { success: false, error: `No scheduled reminder found with id ${id}.` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};
