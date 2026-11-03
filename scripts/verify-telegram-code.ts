import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { encryptData } from '../src/utils/crypto';
import { connectDatabase, disconnectDatabase, isDbConnected } from '../src/database';
import { UserbotSessionModel } from '../src/database/models/UserbotSession';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function verify() {
  const code = process.argv[2]?.trim();
  const password = process.argv[3]?.trim();

  if (!code) {
    console.error('ERROR: Code is required. Usage: npx tsx scripts/verify-telegram-code.ts <code> [password]');
    process.exit(1);
  }

  const sessionDir = path.resolve(process.cwd(), 'sessions');
  const tempPath = path.join(sessionDir, 'auth-temp.json');
  if (!fs.existsSync(tempPath)) {
    console.error('ERROR: No pending authentication found in sessions/auth-temp.json. Please send code first.');
    process.exit(1);
  }

  const tempData = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  const { phoneNumber, phoneCodeHash, session: savedSession } = tempData;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';

  const session = new StringSession(savedSession);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: true,
  });

  await client.connect();

  console.log(`Verifying code for ${phoneNumber}...`);

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err: any) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      if (!password) {
        console.log('2FA_PASSWORD_REQUIRED');
        await client.disconnect();
        process.exit(2);
      }
      console.log('Submitting 2FA password...');
      await client.signInWithPassword(
        { apiId, apiHash },
        { password }
      );
    } else {
      throw err;
    }
  }

  const me = await client.getMe();
  console.log(`AUTH_SUCCESS:${(me as any).firstName}:${(me as any).username || ''}:${(me as any).id}`);

  const rawSessionString = client.session.save() as unknown as string;
  const encryptionKey = process.env.SESSION_ENCRYPTION_KEY || 'default_secure_secret_key_32bytes!';
  const encryptedSessionString = encryptData(rawSessionString, encryptionKey);

  // 1. Save to sessions/userbot.session
  const sessionFile = path.join(sessionDir, 'userbot.session');
  fs.writeFileSync(sessionFile, encryptedSessionString, { encoding: 'utf8', mode: 0o600 });
  console.log(`Saved encrypted session to: ${sessionFile}`);

  // 2. Update .env file
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('TELEGRAM_SESSION=')) {
      envContent = envContent.replace(
        /TELEGRAM_SESSION=.*/g,
        `TELEGRAM_SESSION=${encryptedSessionString}`
      );
    } else {
      envContent += `\nTELEGRAM_SESSION=${encryptedSessionString}\n`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('Updated .env with TELEGRAM_SESSION.');
  }

  // 3. Save to MongoDB if available
  try {
    const dbConnected = await connectDatabase();
    if (dbConnected && isDbConnected()) {
      await UserbotSessionModel.findOneAndUpdate(
        { key: 'active_userbot_session' },
        {
          encryptedSession: encryptedSessionString,
          phoneNumber: (me as any).phone,
          userId: (me as any).id.toString(),
          updatedAt: new Date(),
        },
        { upsert: true }
      );
      console.log('Saved encrypted session to MongoDB.');
    }
    await disconnectDatabase();
  } catch {
    // Non-critical if Mongo is offline
  }

  // Remove temporary auth file
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }

  await client.disconnect();
  console.log('LOGIN_FLOW_COMPLETE');
  process.exit(0);
}

verify().catch((err) => {
  console.error('VERIFY_ERROR:', err.errorMessage || err.message || err);
  process.exit(1);
});
