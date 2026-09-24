const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

// Supabase (Postgres over REST) instead of a local file — this needs to
// survive Vercel serverless cold starts, which local SQLite cannot.
// Table names are prefixed (meera_*) so this can share a Supabase project
// with other coursework without colliding.
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

async function insertNote({ telegramUserId, rawText }) {
  const { data, error } = await supabase
    .from('meera_notes')
    .insert({ telegram_user_id: telegramUserId, raw_text: rawText })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getNoteById(id) {
  const { data, error } = await supabase.from('meera_notes').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function updateNoteStatus(id, status) {
  const { error } = await supabase.from('meera_notes').update({ status }).eq('id', id);
  if (error) throw error;
}

async function setNoteAngle(id, angle) {
  const { error } = await supabase.from('meera_notes').update({ angle }).eq('id', id);
  if (error) throw error;
}

async function setNoteRating(id, rating) {
  const { error } = await supabase
    .from('meera_notes')
    .update({ score: rating.score, rating_json: JSON.stringify(rating) })
    .eq('id', id);
  if (error) throw error;
}

async function insertDraft({ noteId, version, text, citations }) {
  const { data, error } = await supabase
    .from('meera_drafts')
    .insert({
      note_id: noteId,
      version,
      text,
      citations_json: JSON.stringify(citations || []),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getDraftById(id) {
  const { data, error } = await supabase.from('meera_drafts').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function getLatestPendingDraft() {
  const { data, error } = await supabase
    .from('meera_drafts')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function setDraftStatus(id, status) {
  const { error } = await supabase.from('meera_drafts').update({ status }).eq('id', id);
  if (error) throw error;
}

async function supersedeDraft(id) {
  await setDraftStatus(id, 'superseded');
}

module.exports = {
  insertNote,
  getNoteById,
  updateNoteStatus,
  setNoteAngle,
  setNoteRating,
  insertDraft,
  getDraftById,
  getLatestPendingDraft,
  setDraftStatus,
  supersedeDraft,
};
