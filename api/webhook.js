const bot = require('../src/bot');

// Vercel serverless function — this is what Telegram calls once the webhook
// is registered (see scripts/webhook.js).
//
// Deliberately NOT using bot.webhookCallback() here: it can send its HTTP
// response before our async handler chain (Supabase writes, the actual
// reply) has finished, and once Vercel sees a response it's free to freeze
// or tear down the function — silently cutting off whatever background work
// hadn't completed yet. That produced exactly this symptom: a clean 200,
// no error logged anywhere, but the draft's status update never landed.
//
// Awaiting handleUpdate ourselves, before ever touching `res`, guarantees
// Vercel can't end the invocation until all of it — DB writes included —
// has actually completed.
module.exports = async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    console.error('handleUpdate failed:', err);
  }
  res.status(200).end();
};
