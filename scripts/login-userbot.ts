import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import input from 'input';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { encryptData } from '../src/utils/crypto';
import { connectDatabase, disconnectDatabase, isDbConnected } from '../src/database';
import { UserbotSessionModel } from '../src/database/models/UserbotSession';

dotenv.config();

async function main() {
  console.log('========================================================');
  console.log('  Telegram Userbot Authorization Setup');
  console.log('========================================================\n');

  let apiId = Number(process.env.TELEGRAM_API_ID);
  let apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';

  if (!apiId || isNaN(apiId)) {
    const enteredId = await input.text('Enter your Telegram API_ID (from https://my.telegram.org): ');
    apiId = Number(enteredId);
  }

  if (!apiHash) {
    apiHash = await input.text('Enter your Telegram API_HASH (from https://my.telegram.org): ');
  }

  if (!apiId || !apiHash) {
    console.error('Error: Telegram API_ID and API_HASH are required to proceed.');
    process.exit(1);
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log('\nConnecting to Telegram servers...');
  await client.start({
    phoneNumber: async () => await input.text('Enter your phone number (e.g. +998901234567): '),
    password: async () => await input.password('Enter your 2FA password (leave empty if not enabled): '),
    phoneCode: async () => await input.text('Enter the verification code sent to your Telegram: '),
    onError: (err) => console.error('Telegram Auth Error:', err.message),
  });

  console.log('\nAuthentication successful!');
  const me = await client.getMe();
  console.log(`Logged in as: ${(me as any).firstName} (@${(me as any).username || 'no_username'})`);

  const rawSessionString = client.session.save() as unknown as string;
  const encryptionKey = process.env.SESSION_ENCRYPTION_KEY || 'default_secure_secret_key_32bytes!';
  const encryptedSessionString = encryptData(rawSessionString, encryptionKey);

  // 1. Save to sessions/userbot.session
  const sessionDir = path.resolve(process.cwd(), 'sessions');
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  const sessionFile = path.join(sessionDir, 'userbot.session');
  fs.writeFileSync(sessionFile, encryptedSessionString, { encoding: 'utf8', mode: 0o600 });
  console.log(`Saved encrypted session file to: ${sessionFile}`);

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

    if (!process.env.TELEGRAM_API_ID || process.env.TELEGRAM_API_ID === '') {
      envContent = envContent.replace(/TELEGRAM_API_ID=.*/g, `TELEGRAM_API_ID=${apiId}`);
    }
    if (!process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_API_HASH === '') {
      envContent = envContent.replace(/TELEGRAM_API_HASH=.*/g, `TELEGRAM_API_HASH=${apiHash}`);
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('Updated .env with encrypted TELEGRAM_SESSION, API_ID, and API_HASH.');
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
  } catch (err) {
    // Non-critical if Mongo is not running locally during CLI login
  }

  // 4. Verify getting dialogs
  console.log('\nVerifying userbot permissions by fetching recent dialogs...');
  try {
    const dialogs = await client.getDialogs({ limit: 5 });
    console.log(`Verification succeeded! Retrieved ${dialogs.length} dialogs:`);
    for (const d of dialogs) {
      console.log(` - [${d.isChannel ? 'Channel' : d.isGroup ? 'Group' : 'User'}] ${d.title || d.name} (ID: ${d.id})`);
    }
  } catch (err: any) {
    console.warn('Warning: Could not fetch dialogs:', err.message);
  }

  console.log('\nAll done! You can now start the main application with: npm run dev');
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error during userbot setup:', err);
  process.exit(1);
});
