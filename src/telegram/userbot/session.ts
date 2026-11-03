import fs from 'fs';
import path from 'path';
import { StringSession } from 'telegram/sessions';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { decryptData, encryptData } from '../../utils/crypto';
import { UserbotSessionModel } from '../../database/models/UserbotSession';
import { isDbConnected } from '../../database';

const SESSION_FILE_PATH = path.resolve(process.cwd(), 'sessions', 'userbot.session');

/**
 * Loads the userbot session from env, database, or local file.
 * Automatically decrypts if encrypted.
 */
export async function loadUserbotSession(): Promise<StringSession> {
  let sessionRaw = '';

  // 1. Check process.env.TELEGRAM_SESSION
  if (config.TELEGRAM_SESSION && config.TELEGRAM_SESSION.trim().length > 0) {
    sessionRaw = config.TELEGRAM_SESSION.trim();
  } 
  // 2. Check Database
  else if (isDbConnected()) {
    try {
      const doc = await UserbotSessionModel.findOne({ key: 'active_userbot_session' });
      if (doc && doc.encryptedSession) {
        sessionRaw = doc.encryptedSession;
      }
    } catch (err) {
      logger.warn('Failed to load session from database:', err);
    }
  }

  // 3. Check local encrypted file
  if (!sessionRaw && fs.existsSync(SESSION_FILE_PATH)) {
    try {
      sessionRaw = fs.readFileSync(SESSION_FILE_PATH, 'utf8').trim();
    } catch (err) {
      logger.warn('Failed to read session file:', err);
    }
  }

  // Decrypt if encrypted
  let decryptedSession = '';
  if (sessionRaw) {
    try {
      decryptedSession = decryptData(sessionRaw);
    } catch {
      // If decryption fails, it might be raw unencrypted
      decryptedSession = sessionRaw;
    }
  }

  return new StringSession(decryptedSession || '');
}

/**
 * Encrypts and securely saves the userbot session to database and filesystem.
 */
export async function saveUserbotSession(sessionString: string, phoneNumber?: string, userId?: string): Promise<void> {
  if (!sessionString) return;

  const encrypted = encryptData(sessionString);

  // 1. Save to local file
  const sessionDir = path.dirname(SESSION_FILE_PATH);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  fs.writeFileSync(SESSION_FILE_PATH, encrypted, { encoding: 'utf8', mode: 0o600 });
  logger.info(`Encrypted session saved to ${SESSION_FILE_PATH}`);

  // 2. Save to Database if connected
  if (isDbConnected()) {
    try {
      await UserbotSessionModel.findOneAndUpdate(
        { key: 'active_userbot_session' },
        {
          encryptedSession: encrypted,
          phoneNumber,
          userId,
          updatedAt: new Date(),
        },
        { upsert: true, new: true }
      );
      logger.info('Encrypted session synchronized with MongoDB.');
    } catch (err) {
      logger.error('Failed to save session to MongoDB:', err);
    }
  }
}
