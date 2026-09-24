const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./db');
const { extractAngle, rateNote, draftPost } = require('./llm');
const { searchNews } = require('./news');

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

const FEEDBACK_PREFIX = /^feedback on post draft:\s*(.*)$/is;
const POSTABLE_THRESHOLD = 7;

// Access control (automation brief, Check 5): this is Meera's personal
// channel — every handler ignores anyone but this one Telegram user ID.
function isAllowed(ctx) {
  const senderId = ctx.from && String(ctx.from.id);
  const ok = senderId === String(config.ALLOWED_TELEGRAM_USER_ID);
  if (!ok) {
    console.warn(`Ignored message from unauthorized sender id=${senderId} (expected ${config.ALLOWED_TELEGRAM_USER_ID})`);
  }
  return ok;
}

function draftKeyboard(draftId) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Approve', `approve:${draftId}`),
    Markup.button.callback('Discard', `discard:${draftId}`),
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

    await ctx.reply(formatDraftMessage(newText, newCitations), draftKeyboard(draft.id));
  } catch (err) {
    console.error('Revision failed:', err);
    await ctx.reply('Revision failed — the previous draft is still pending. Try sending your feedback again in a moment.');
  }
}

async function handleNewNote(ctx, text) {
  const note = await db.insertNote({ telegramUserId: ctx.from.id, rawText: text });

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
    await ctx.reply(`Note logged to backlog (needs ${POSTABLE_THRESHOLD}+ to be postable).\n\n${formatRating(rating)}`);
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
    await ctx.reply(`${formatRating(rating)}\n\n${formatDraftMessage(draftText, citations)}`, draftKeyboard(draft.id));
  } catch (err) {
    console.error('Draft generation failed:', err);
    await db.updateNoteStatus(note.id, 'error');
    await ctx.reply(`That note rated ${rating.score}/10, but draft generation failed. It's saved — resend it to retry.`);
  }
}

bot.on('text', async (ctx) => {
  if (!isAllowed(ctx)) return;

  const text = ctx.message.text.trim();
  const feedbackMatch = text.match(FEEDBACK_PREFIX);

  if (feedbackMatch) {
    await handleFeedback(ctx, feedbackMatch[1].trim());
    return;
  }

  await handleNewNote(ctx, text);
});

bot.action(/^approve:(\d+)$/, async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await db.setDraftStatus(id, 'approved');
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch {
    // message may already be edited/too old — non-fatal
  }
  await ctx.answerCbQuery('Marked approved');
  await ctx.reply('Approved in the tracker. This does not post to LinkedIn for you — verify every cited fact yourself, then publish it.');
});

bot.action(/^discard:(\d+)$/, async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await db.setDraftStatus(id, 'discarded');
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch {
    // non-fatal
  }
  await ctx.answerCbQuery('Discarded');
  await ctx.reply('Archived.');
});

module.exports = bot;
