import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  OWNER_TELEGRAM_ID: z.coerce.number().optional().default(0),

  // Telegram Userbot
  TELEGRAM_API_ID: z.coerce.number().optional().default(0),
  TELEGRAM_API_HASH: z.string().optional().default(''),
  TELEGRAM_SESSION: z.string().optional().default(''),
  SESSION_ENCRYPTION_KEY: z.string().default('default_secure_secret_key_32bytes!'),

  // Database & Queues
  MONGODB_URI: z.string().default('mongodb://localhost:27017/telegram_ai_bot'),
  REDIS_URL: z.string().optional().default('redis://localhost:6379'),

  // AI LLM Provider
  LLM_API_KEY: z.string().optional().default(''),
  LLM_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  LLM_MODEL: z.string().default('openai/gpt-4o-mini'),
  LLM_MAX_STEPS: z.coerce.number().default(10),

  // Groq (voice/video note -> matn)
  GROQ_API_KEY: z.string().optional().default(''),

  // Obsidian Integration
  OBSIDIAN_VAULT_PATH: z.string().default('C:\\Users\\user\\Documents\\Obsidian'),

  // Safety & Limits
  ENABLE_AUTOREPLY: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
  DEFAULT_AUTO_REPLY_MODE: z.enum(['draft', 'auto']).default('draft'),
  MAX_HISTORY_LIMIT: z.coerce.number().default(50),
  MAX_FLOOD_WAIT_SECONDS: z.coerce.number().default(60),
});

export type EnvConfig = z.infer<typeof envSchema>;

export const config: EnvConfig = envSchema.parse(process.env);
