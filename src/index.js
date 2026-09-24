const bot = require('./bot');

// Telegraf's launch() promise only resolves once the bot is stopped (not
// once polling starts), so don't await it for the "running" message — this
// is the pattern Telegraf's own docs use.
bot.launch().catch((err) => {
  console.error('Bot crashed:', err);
  process.exit(1);
});

console.log('Meera content bot is running (long polling). Press Ctrl+C to stop.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
