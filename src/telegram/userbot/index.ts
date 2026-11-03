import { TelegramClient } from 'telegram';
import { errors } from 'telegram';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { loadUserbotSession } from './session';

let client: TelegramClient | null = null;
let isConnected = false;

let watchdogHandle: NodeJS.Timeout | null = null;
let reconnecting = false;
/** Bound so a permanently failing reconnect cannot spam the log. */
let consecutiveFailures = 0;

const WATCHDOG_INTERVAL_MS = 30_000;
/** After this many failures, wait this much longer before retrying. */
const FAILURES_BEFORE_BACKOFF = 5;
const BACKOFF_MULTIPLIER = 4;
/** Earliest timestamp of the next allowed reconnect attempt. */
let nextAttemptAt = 0;

/**
 * GramJS drops the connection silently (network blip, Telegram restart, PC
 * sleep) and `client.connected` just flips to false. Nothing else in the code
 * notices, so the userbot stays dead until the whole process restarts.
 * This watchdog detects that state and reconnects the same client in place —
 * reusing the client keeps the message handlers registered.
 */
async function reconnectIfDropped(): Promise<void> {
  if (!client || reconnecting) return;
  if (isConnected && client.connected) {
    consecutiveFailures = 0;
    return;
  }

  reconnecting = true;
  try {
    logger.warn('[Userbot] Connection dropped. Attempting automatic reconnection...');
    nextAttemptAt = 0;

    await client.connect();

    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      isConnected = false;
      logger.error('[Userbot] Session no longer authorized. Run `npm run login` to re-authenticate.');
      return;
    }

    const me = await client.getMe();
    isConnected = true;
    consecutiveFailures = 0;
    logger.info(
      `Userbot reconnected successfully as: @${(me as any).username || (me as any).firstName} (ID: ${(me as any).id})`
    );
  } catch (error: any) {
    consecutiveFailures++;
    isConnected = false;
    // Exponential-ish backoff so a hard outage does not hammer Telegram.
    const delay =
      WATCHDOG_INTERVAL_MS * Math.min(BACKOFF_MULTIPLIER, consecutiveFailures);
    nextAttemptAt = Date.now() + delay;

    if (error instanceof errors.FloodWaitError) {
      logger.error(`[Userbot] FloodWait during reconnect: wait ${error.seconds}s.`);
    } else {
      logger.error(
        `[Userbot] Reconnection attempt failed (${consecutiveFailures}/${FAILURES_BEFORE_BACKOFF}): ${error?.message || error}`
      );
    }
  } finally {
    reconnecting = false;
  }
}

/** Starts the connection watchdog. Safe to call more than once. */
export function startUserbotWatchdog(intervalMs: number = WATCHDOG_INTERVAL_MS): void {
  if (watchdogHandle) return;

  watchdogHandle = setInterval(async () => {
    // Honour the backoff window set by the previous failure.
    if (Date.now() < nextAttemptAt) return;
    await reconnectIfDropped();
  }, intervalMs);

  watchdogHandle.unref?.();
  logger.info(`[Userbot] Connection watchdog started (every ${intervalMs}ms).`);
}

/** Stops the connection watchdog. */
export function stopUserbotWatchdog(): void {
  if (watchdogHandle) {
    clearInterval(watchdogHandle);
    watchdogHandle = null;
    logger.info('[Userbot] Connection watchdog stopped.');
  }
}

export async function initUserbot(): Promise<TelegramClient | null> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH) {
    logger.warn('TELEGRAM_API_ID or TELEGRAM_API_HASH is not set. Userbot will not start.');
    return null;
  }

  try {
    const session = await loadUserbotSession();
    client = new TelegramClient(session, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
      connectionRetries: 5,
      useWSS: true,
    });

    await client.connect();

    const isAuthorized = await client.isUserAuthorized();
    if (!isAuthorized) {
      logger.warn('Userbot is not authorized yet. Please run `npm run login` to authenticate.');
      isConnected = false;
      startUserbotWatchdog();
      return client;
    }

    const me = await client.getMe();
    logger.info(`Userbot connected successfully as: @${(me as any).username || (me as any).firstName} (ID: ${(me as any).id})`);
    isConnected = true;
    startUserbotWatchdog();
    return client;
  } catch (error: any) {
    if (error instanceof errors.FloodWaitError) {
      logger.error(`Userbot FloodWait encountered: Need to wait ${error.seconds} seconds.`);
    } else {
      logger.error('Failed to initialize Userbot:', error);
    }
    isConnected = false;
    startUserbotWatchdog();
    return null;
  }
}

export function getUserbotClient(): TelegramClient | null {
  return client;
}

export function isUserbotConnected(): boolean {
  return isConnected && client !== null && Boolean(client.connected);
}

export async function disconnectUserbot(): Promise<void> {
  stopUserbotWatchdog();

  if (client) {
    try {
      await client.disconnect();
      logger.info('Userbot disconnected.');
    } catch (err) {
      logger.error('Error during userbot disconnect:', err);
    } finally {
      isConnected = false;
    }
  }
}
