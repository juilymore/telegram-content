const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./db');
const { extractAngle, rateNote, draftPost } = require('./llm');
const { searchNews } = require('./news');

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

const FEEDBACK_PREFIX = /^feedback on post draft:\s*(.*)$/is;
const POSTABLE_THRESHOLD = 7;

// Access control (automation brief, Check 5): every handler ignores anyone
// but Meera — either her own Telegram user ID (private chat, group messages,
// button taps) or her one allowed channel ID (channel posts, which have no
// sender identity at all).
function isAllowedUser(ctx) {
  const senderId = ctx.from && String(ctx.from.id);
  const ok = senderId === String(config.ALLOWED_TELEGRAM_USER_ID);
  if (!ok) {
    console.warn(`Ignored message from unauthorized sender id=${senderId} (expected ${config.ALLOWED_TELEGRAM_USER_ID})`);
  }
  return ok;
}

function isAllowedChannel(ctx) {
  const chatId = ctx.chat && String(ctx.chat.id);
  if (!config.ALLOWED_CHANNEL_ID) {
    console.warn(`Ignored channel post from chat id=${chatId} — set ALLOWED_CHANNEL_ID to this value to enable it.`);
    return false;
  }
  const ok = chatId === String(config.ALLOWED_CHANNEL_ID);
  if (!ok) {
    console.warn(`Ignored channel post from unauthorized chat id=${chatId} (expected ${config.ALLOWED_CHANNEL_ID})`);
  }
  return ok;
}

function draftKeyboard(draftId) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Approve', `approve:${draftId}`),
    Markup.button.callback('Discard', `discard:${draftId}`),
  ]);
}

function discardReasonKeyboard(draftId) {
  return Markup.inlineKeyboard([
    Markup.button.callback("Didn't like the draft", `discardreason:${draftId}:draft`),
    Markup.button.callback('Not relevant right now', `discardreason:${draftId}:relevance`),
  ]);
}

// Telegram hard-caps messages at 4096 characters — a drafted post plus its
// citation footer (Google News RSS URLs are long) can exceed that. Split on
// paragraph breaks and only attach `extra` (e.g. the Approve/Discard
// keyboard) to the last chunk.
const TELEGRAM_MAX_LEN = 4000;

function splitMessage(text, maxLen = TELEGRAM_MAX_LEN) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendChunked(ctx, text, extra) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await ctx.reply(chunks[i], isLast ? extra : undefined);
  }
}

// Telegraf aborts an update entirely after 90s with no way to recover a
// reply at that point. Bound every individual network call well below that,
// so a single stalled Supabase/Telegram request can't silently swallow a
// button-tap confirmation — it fails fast enough that the catch-all below
// still gets a chance to tell the user something broke.
const ACTION_STEP_TIMEOUT_MS = 12000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ACTION_STEP_TIMEOUT_MS}ms: ${label}`)), ACTION_STEP_TIMEOUT_MS)
    ),
  ]);
}

function formatRating(rating) {
  return (
    `Rating: ${rating.score}/10 (${rating.tier})\n` +
    `Relevance ${rating.relevance} · Recency ${rating.recency} · Context ${rating.context} · ` +
    `Content ${rating.content} · Checkability ${rating.checkability}\n` +
    `Why: ${rating.reasoning}`
  );
}

// "The Cut" (automation brief): any externally-sourced fact is always shown
// with its source, visibly marked unverified — approving a draft is never
// treated as the same event as fact-checking it.
function formatDraftMessage(text, citations) {
  if (!citations || citations.length === 0) return text;
  const lines = citations.map((c) => `${c.n}. ${c.title} — ${c.url}`).join('\n');
  return `${text}\n\n---\nSourced from (unverified — confirm before posting):\n${lines}`;
}

async function handleFeedback(ctx, feedbackText) {
  if (!feedbackText) {
    await ctx.reply('Tell me what to change, e.g. "feedback on post draft: shorten the opening paragraph."');
    return;
  }

  const pending = await db.getLatestPendingDraft();
  if (!pending) {
    await ctx.reply("No draft is currently pending approval, so there's nothing to revise.");
    return;
  }

  const note = await db.getNoteById(pending.note_id);
  const citations = JSON.parse(pending.citations_json || '[]');

  try {
    const { text: newText, citations: newCitations } = await draftPost({
      note: note.raw_text,
      angle: note.angle,
      searchResults: citations,
      feedback: feedbackText,
      priorDraft: pending.text,
    });

    await db.supersedeDraft(pending.id);
    const draft = await db.insertDraft({
      noteId: note.id,
      version: pending.version + 1,
      text: newText,
      citations: newCitations,
    });

    await sendChunked(ctx, formatDraftMessage(newText, newCitations), draftKeyboard(draft.id));
  } catch (err) {
    console.error('Revision failed:', err);
    await ctx.reply('Revision failed — the previous draft is still pending. Try sending your feedback again in a moment.');
  }
}

async function handleNewNote(ctx, text) {
  // ctx.from is absent for channel posts (they have no sender identity) —
  // fall back to the chat id so every note still records who/where it came from.
  const senderId = ctx.from ? ctx.from.id : ctx.chat.id;
  const note = await db.insertNote({ telegramUserId: senderId, rawText: text });

  let extracted;
  try {
    extracted = await extractAngle(text);
  } catch (err) {
    console.error('Angle extraction failed:', err);
    await db.updateNoteStatus(note.id, 'error');
    await ctx.reply("Something broke while reading that note. It's saved — resend it later to retry.");
    return;
  }

  let searchResults = [];
  try {
    searchResults = await searchNews(extracted.search_query);
  } catch (err) {
    console.error('News research failed — rating/drafting without it:', err);
  }

  let rating;
  try {
    rating = await rateNote({ note: text, angle: extracted.angle, searchResults });
  } catch (err) {
    console.error('Rating failed:', err);
    await db.updateNoteStatus(note.id, 'error');
    await ctx.reply("Something broke while rating that note. It's saved — resend it later to retry.");
    return;
  }

  await db.setNoteAngle(note.id, extracted.angle);
  await db.setNoteRating(note.id, rating);

  if (rating.score < POSTABLE_THRESHOLD) {
    await db.updateNoteStatus(note.id, 'backlog');
    await ctx.reply(
      `Noted. Good raw material, but can't make a post out of it yet (rated ${rating.score}/10) — can revisit later if needed.\n\n${formatRating(rating)}`
    );
    return;
  }

  try {
    const { text: draftText, citations } = await draftPost({
      note: text,
      angle: extracted.angle,
      searchResults,
    });
    await db.updateNoteStatus(note.id, 'drafted');
    const draft = await db.insertDraft({ noteId: note.id, version: 1, text: draftText, citations });
    await ctx.reply(formatRating(rating));
    await sendChunked(ctx, formatDraftMessage(draftText, citations), draftKeyboard(draft.id));
  } catch (err) {
    console.error('Draft generation failed:', err);
    await db.updateNoteStatus(note.id, 'error');
    await ctx.reply(`That note rated ${rating.score}/10, but draft generation failed. It's saved — resend it to retry.`);
  }
}

bot.on('text', async (ctx) => {
  if (!isAllowedUser(ctx)) return;

  const text = ctx.message.text.trim();
  const feedbackMatch = text.match(FEEDBACK_PREFIX);

  if (feedbackMatch) {
    await handleFeedback(ctx, feedbackMatch[1].trim());
    return;
  }

  await handleNewNote(ctx, text);
});

// A Telegram Channel is a different chat type from a Group — posts arrive as
// `channel_post`, not `message`, and carry no sender identity, so this is
// gated by channel id (see isAllowedChannel) rather than user id.
bot.on('channel_post', async (ctx) => {
  if (!isAllowedChannel(ctx)) return;

  const post = ctx.channelPost;
  if (!post.text) return; // ignore non-text channel posts (photos, etc.)

  const text = post.text.trim();
  const feedbackMatch = text.match(FEEDBACK_PREFIX);

  if (feedbackMatch) {
    await handleFeedback(ctx, feedbackMatch[1].trim());
    return;
  }

  await handleNewNote(ctx, text);
});

bot.action(/^approve:(\d+)$/, async (ctx) => {
  if (!isAllowedUser(ctx)) return ctx.answerCbQuery();
  const id = Number(ctx.match[1]);

  // Answer the tap immediately — Telegram's own loading spinner shouldn't
  // wait on any of our downstream calls.
  try {
    await withTimeout(ctx.answerCbQuery('Marked approved'), 'answerCbQuery (approve)');
  } catch (err) {
    console.error('answerCbQuery failed (approve):', err);
  }

  try {
    await withTimeout(db.setDraftStatus(id, 'approved'), 'setDraftStatus (approved)');

    try {
      await withTimeout(ctx.editMessageReplyMarkup(undefined), 'editMessageReplyMarkup (approve)');
    } catch (err) {
      console.error('editMessageReplyMarkup failed (approve, non-fatal):', err);
    }

    // Keeps "the Cut" from the automation brief (verify cited facts before
    // publishing) but in Meera's own encouraging, direct tone rather than a
    // compliance-style warning. Re-shows the actual links here so she doesn't
    // have to scroll back up to the original draft message to find them.
    const draft = await withTimeout(db.getDraftById(id), 'getDraftById (approve)');
    const citations = JSON.parse(draft?.citations_json || '[]');
    let confirmation = 'Great — you can go ahead and post this on LinkedIn!';
    if (citations.length > 0) {
      const lines = citations.map((c) => `${c.n}. ${c.title} — ${c.url}`).join('\n');
      confirmation += ` Just double-check these cited facts first:\n\n${lines}`;
    } else {
      confirmation += ' No external sources were cited in this one, so nothing to double-check there.';
    }
    await withTimeout(sendChunked(ctx, confirmation), 'sendChunked (approve)');
  } catch (err) {
    console.error('Approve handling failed:', err);
    try {
      await ctx.reply('Marked approved, but something broke sending this confirmation. Check the tracker directly if unsure.');
    } catch (replyErr) {
      console.error('Fallback reply also failed (approve):', replyErr);
    }
  }
});

bot.action(/^discard:(\d+)$/, async (ctx) => {
  if (!isAllowedUser(ctx)) return ctx.answerCbQuery();
  const id = Number(ctx.match[1]);

  try {
    await withTimeout(ctx.answerCbQuery('Discarded'), 'answerCbQuery (discard)');
  } catch (err) {
    console.error('answerCbQuery failed (discard):', err);
  }

  try {
    await withTimeout(db.setDraftStatus(id, 'discarded'), 'setDraftStatus (discarded)');

    try {
      await withTimeout(ctx.editMessageReplyMarkup(undefined), 'editMessageReplyMarkup (discard)');
    } catch (err) {
      console.error('editMessageReplyMarkup failed (discard, non-fatal):', err);
    }

    await withTimeout(
      ctx.reply("Noted! Can you tell me why this wasn't post-worthy?", discardReasonKeyboard(id)),
      'reply (discard)'
    );
  } catch (err) {
    console.error('Discard handling failed:', err);
    try {
      await ctx.reply('Marked discarded, but something broke asking why. No worries either way.');
    } catch (replyErr) {
      console.error('Fallback reply also failed (discard):', replyErr);
    }
  }
});

bot.action(/^discardreason:(\d+):(draft|relevance)$/, async (ctx) => {
  if (!isAllowedUser(ctx)) return ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const reason = ctx.match[2] === 'draft' ? "Didn't like draft" : 'Not relevant to post now';

  try {
    await withTimeout(ctx.answerCbQuery('Thanks'), 'answerCbQuery (discardreason)');
  } catch (err) {
    console.error('answerCbQuery failed (discardreason):', err);
  }

  try {
    await withTimeout(db.setDraftDiscardReason(id, reason), 'setDraftDiscardReason');

    try {
      await withTimeout(ctx.editMessageReplyMarkup(undefined), 'editMessageReplyMarkup (discardreason)');
    } catch (err) {
      console.error('editMessageReplyMarkup failed (discardreason, non-fatal):', err);
    }

    await withTimeout(ctx.reply('Thanks, noted.'), 'reply (discardreason)');
  } catch (err) {
    console.error('Discard-reason handling failed:', err);
    try {
      await ctx.reply('Got it, though something broke saving the reason.');
    } catch (replyErr) {
      console.error('Fallback reply also failed (discardreason):', replyErr);
    }
  }
});

module.exports = bot;
