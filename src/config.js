require('dotenv').config();
const path = require('path');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var: ${name}. Set it in .env locally, or in Vercel → Project Settings → Environment Variables in production.`
    );
  }
  return value;
}

module.exports = {
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  ALLOWED_TELEGRAM_USER_ID: required('ALLOWED_TELEGRAM_USER_ID'),

  // Optional: if set, the bot also accepts posts from this one Telegram
  // channel (the bot must be an admin there). Channel posts have no sender
  // identity, so this is gated by chat id instead of user id. Leave unset to
  // only use the private 1:1 chat.
  ALLOWED_CHANNEL_ID: process.env.ALLOWED_CHANNEL_ID || '',

  // One Gemini key powers everything: the gatekeeper check, drafting/revision,
  // and the Google Search grounding used for news enrichment.
  GEMINI_API_KEY: required('GEMINI_API_KEY'),
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.6-flash',

  // Supabase persistence — required so state survives Vercel's ephemeral,
  // per-invocation filesystem (a local SQLite file would not).
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),

  VOICE_FILE_PATH: process.env.VOICE_FILE_PATH || path.join(__dirname, 'meera_voice.txt'),
};
