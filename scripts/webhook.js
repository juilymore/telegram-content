// The Telegram <-> Vercel "handshake": tells Telegram where to POST updates.
// Usage:
//   node scripts/webhook.js set https://your-app.vercel.app/api/webhook
//   node scripts/webhook.js info
//   node scripts/webhook.js delete   (switch back to local long-polling)
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set (check your .env).');
  process.exit(1);
}

const [, , cmd, arg] = process.argv;
const base = `https://api.telegram.org/bot${token}`;

async function main() {
  if (cmd === 'set') {
    if (!arg) {
      console.error('Usage: node scripts/webhook.js set https://your-app.vercel.app/api/webhook');
      process.exit(1);
    }
    const res = await fetch(`${base}/setWebhook?url=${encodeURIComponent(arg)}`);
    console.log(await res.json());
  } else if (cmd === 'delete') {
    const res = await fetch(`${base}/deleteWebhook`);
    console.log(await res.json());
  } else if (cmd === 'info') {
    const res = await fetch(`${base}/getWebhookInfo`);
    console.log(await res.json());
  } else {
    console.log('Usage: node scripts/webhook.js <set <url> | delete | info>');
  }
}

main();
