import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';
  
  let phoneNumber = process.argv[2] || '936200662';
  phoneNumber = phoneNumber.replace(/\s+/g, '');
  if (!phoneNumber.startsWith('+')) {
    if (phoneNumber.startsWith('998')) {
      phoneNumber = '+' + phoneNumber;
    } else {
      phoneNumber = '+998' + phoneNumber;
    }
  }

  console.log(`Connecting to Telegram and requesting code for: ${phoneNumber}...`);

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: true,
  });

  await client.connect();

  const result = await client.sendCode(
    {
      apiId,
      apiHash,
    },
    phoneNumber
  );

  const sessionDir = path.resolve(process.cwd(), 'sessions');
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const tempAuth = {
    phoneNumber,
    phoneCodeHash: result.phoneCodeHash,
    session: client.session.save(),
  };

  fs.writeFileSync(path.join(sessionDir, 'auth-temp.json'), JSON.stringify(tempAuth, null, 2), 'utf8');

  console.log(`CODE_SENT_SUCCESS:${phoneNumber}:${result.phoneCodeHash}`);
  await client.disconnect();
}

run().catch((err) => {
  console.error('ERROR_SENDING_CODE:', err.message || err);
  process.exit(1);
});
