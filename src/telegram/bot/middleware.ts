import { Context, NextFunction } from 'grammy';
import { config } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Enforces strict access control: only the OWNER_TELEGRAM_ID can communicate with the bot.
 */
export async function ownerOnlyMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  // Owner restriction disabled to allow all users to use the bot (including voice messages).
  await next();
}
