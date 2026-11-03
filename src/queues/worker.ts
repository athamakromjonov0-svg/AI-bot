import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import crypto from 'crypto';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { AgentJobData, isRedisQueueActive, inMemoryQueue } from './queue';
import { AgentService } from '../ai/agent';
import { UserbotService } from '../telegram/userbot/service';
import { PendingActionModel } from '../database/models/PendingAction';
import { notifyOwnerActionRequired } from '../telegram/bot/callbacks';
import { isDbConnected } from '../database';

export let bullWorker: Worker<AgentJobData> | null = null;

async function processAgentJob(data: AgentJobData): Promise<void> {
  logger.info(`Processing background job: type=${data.type}, chat=${data.chatId}`);

  switch (data.type) {
    case 'auto_reply': {
      if (!data.chatId || !data.text) return;

      const ruleMode = data.metadata?.ruleMode || config.DEFAULT_AUTO_REPLY_MODE;
      const customPrompt = data.metadata?.customPrompt || 'Generate a helpful, polite, and concise reply.';

      // Generate suggested reply using AI
      const prompt = `[Auto-Responder Triggered]
Message received in chat "${data.chatId}": "${data.text}"
Instruction: ${customPrompt}
Generate ONLY the exact text of the reply to send to this person.`;

      const aiReply = await AgentService.processMessage(
        `auto-reply:${data.chatId}`,
        0,
        prompt,
        data.chatId
      );

      if (!aiReply || aiReply.startsWith('⚠️')) {
        logger.warn('AI reply generation failed or returned error:', aiReply);
        return;
      }

      // If draft mode: require owner approval via inline buttons
      if (ruleMode === 'draft' && isDbConnected()) {
        const actionId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const pendingAction = await PendingActionModel.create({
          actionId,
          type: 'reply',
          targetChatId: data.chatId,
          text: aiReply,
          proposedBy: 'userbot',
          status: 'pending',
          expiresAt,
          metadata: {
            replyToMsgId: data.messageId,
            originalText: data.text,
            ruleName: data.metadata?.ruleName,
          },
        });

        await notifyOwnerActionRequired(pendingAction);
        logger.info(`Draft auto-reply created and sent to owner for approval (actionId: ${actionId})`);
      } 
      // If direct auto mode: send directly via userbot
      else {
        await UserbotService.sendMessage(data.chatId, aiReply, data.messageId, 'userbot_auto');
        logger.info(`Direct auto-reply sent to chat ${data.chatId}`);
      }
      break;
    }

    default:
      logger.warn(`Unknown job type: ${data.type}`);
  }
}

export function setupWorker(): void {
  // 1. If Redis is active, start BullMQ worker
  if (isRedisQueueActive && config.REDIS_URL) {
    try {
      const redisConnection = new IORedis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
      });

      bullWorker = new Worker<AgentJobData>(
        'agent_tasks',
        async (job: Job<AgentJobData>) => {
          await processAgentJob(job.data);
        },
        {
          connection: redisConnection,
          concurrency: 5,
        }
      );

      bullWorker.on('completed', (job) => {
        logger.debug(`BullMQ Job ${job.id} completed.`);
      });

      bullWorker.on('failed', (job, err) => {
        logger.error(`BullMQ Job ${job?.id} failed:`, err);
      });

      logger.info('BullMQ Worker started.');
      return;
    } catch (err) {
      logger.warn('Failed to start BullMQ worker, falling back to in-memory handler:', err);
    }
  }

  // 2. In-memory queue handler fallback
  if (inMemoryQueue) {
    inMemoryQueue.registerHandler(async (job) => {
      await processAgentJob(job.data);
    });
    logger.info('InMemory Worker registered.');
  }
}
