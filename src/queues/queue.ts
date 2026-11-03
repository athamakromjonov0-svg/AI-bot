import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../config/logger';

export interface AgentJobData {
  type: 'auto_reply' | 'summarize_chat' | 'extract_memory' | 'send_scheduled_message';
  chatId?: string;
  messageId?: number;
  text?: string;
  userId?: number;
  ruleId?: string;
  metadata?: Record<string, any>;
}

// In-memory fallback queue if Redis is not available
class InMemoryQueue {
  private handlers: Array<(job: { id: string; data: AgentJobData }) => Promise<void>> = [];
  private processedIds: Set<string> = new Set();
  private isProcessing = false;
  private queue: Array<{ id: string; data: AgentJobData; attempts: number }> = [];

  constructor() {
    logger.info('InMemoryQueue initialized as fallback.');
  }

  public registerHandler(handler: (job: { id: string; data: AgentJobData }) => Promise<void>) {
    this.handlers.push(handler);
  }

  public async add(name: string, data: AgentJobData, opts?: { jobId?: string; attempts?: number }) {
    const id = opts?.jobId || `${name}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Deduplication check
    if (this.processedIds.has(id)) {
      logger.warn(`[InMemoryQueue] Duplicate job skipped: ${id}`);
      return { id };
    }

    this.queue.push({ id, data, attempts: opts?.attempts || 3 });
    this.processedIds.add(id);

    // Keep set bounded to avoid memory leak
    if (this.processedIds.size > 5000) {
      const first = Array.from(this.processedIds).slice(0, 1000);
      first.forEach((x) => this.processedIds.delete(x));
    }

    this.processNext();
    return { id };
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const job = this.queue.shift();
    if (job) {
      for (const handler of this.handlers) {
        let attemptsLeft = job.attempts;
        let success = false;
        while (attemptsLeft > 0 && !success) {
          try {
            await handler({ id: job.id, data: job.data });
            success = true;
          } catch (err) {
            attemptsLeft--;
            logger.error(`[InMemoryQueue] Job ${job.id} failed, attempts left: ${attemptsLeft}`, err);
            if (attemptsLeft > 0) {
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }
      }
    }

    this.isProcessing = false;
    if (this.queue.length > 0) {
      setImmediate(() => this.processNext());
    }
  }
}

export let agentQueue: Queue<AgentJobData> | null = null;
export let inMemoryQueue: InMemoryQueue | null = null;
export let isRedisQueueActive = false;

export async function setupQueue(): Promise<void> {
  if (config.REDIS_URL) {
    try {
      const redisConnection = new IORedis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
        connectTimeout: 4000,
        retryStrategy: (times) => {
          if (times > 3) {
            logger.warn('Redis reconnection failed after 3 attempts. Switching to in-memory fallback.');
            return null; // Stop reconnecting and let fallback handle
          }
          return Math.min(times * 1000, 3000);
        },
      });

      redisConnection.on('error', (err) => {
        logger.warn(`Redis connection warning: ${err.message}`);
      });

      await new Promise<void>((resolve, reject) => {
        redisConnection.once('ready', () => {
          logger.info('Connected to Redis for BullMQ successfully.');
          isRedisQueueActive = true;
          resolve();
        });
        redisConnection.once('error', (err) => {
          reject(err);
        });
        setTimeout(() => reject(new Error('Redis connection timeout')), 3000);
      });

      agentQueue = new Queue<AgentJobData>('agent_tasks', {
        connection: redisConnection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      });

      return;
    } catch (error: any) {
      logger.warn(`Could not connect to Redis (${error.message}). BullMQ will use in-memory queue fallback.`);
    }
  }

  // Fallback
  inMemoryQueue = new InMemoryQueue();
}

/**
 * Dispatches a background job, deduplicating by jobId
 */
export async function dispatchJob(
  name: string,
  data: AgentJobData,
  jobId?: string
): Promise<{ id: string }> {
  if (isRedisQueueActive && agentQueue) {
    const job = await agentQueue.add(name, data, {
      jobId,
    });
    return { id: job.id || name };
  } else if (inMemoryQueue) {
    return await inMemoryQueue.add(name, data, { jobId });
  }

  logger.warn('No queue system active. Job dropped:', { name, data });
  return { id: 'dropped' };
}
