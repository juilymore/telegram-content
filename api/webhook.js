const bot = require('../src/bot');

// Vercel serverless function — this is what Telegram calls once the webhook
// is registered (see scripts/webhook.js). Telegraf's webhookCallback reads
// `req.body` (which Vercel already parses as JSON) and handles the update.
module.exports = bot.webhookCallback('/api/webhook');
