import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from './env';

const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Regex list to mask sensitive data
const maskPatterns = [
  /(bot\d+:[\w-]+)/gi, // Telegram bot token
  /(api_hash=[\w-]+)/gi,
  /(session=[\w+/=]+)/gi,
  /(key=[\w-]+)/gi,
  /(Bearer\s+[\w.-]+)/gi,
];

const sanitizeFormat = winston.format((info) => {
  let message = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
  
  if (config.TELEGRAM_BOT_TOKEN) {
    message = message.replace(config.TELEGRAM_BOT_TOKEN, '[MASKED_BOT_TOKEN]');
  }
  if (config.TELEGRAM_API_HASH) {
    message = message.replace(config.TELEGRAM_API_HASH, '[MASKED_API_HASH]');
  }
  if (config.LLM_API_KEY) {
    message = message.replace(config.LLM_API_KEY, '[MASKED_LLM_KEY]');
  }

  for (const pattern of maskPatterns) {
    message = message.replace(pattern, '[MASKED_SECRET]');
  }

  info.message = message;
  return info;
});

export const logger = winston.createLogger({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    sanitizeFormat(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'telegram-ai-userbot' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        sanitizeFormat(),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `[${timestamp}] [${level}]: ${message}${metaStr}`;
        })
      ),
    }),
  ],
});
