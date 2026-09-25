-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query)
-- before starting the bot for the first time.
--
-- Tables are prefixed meera_* so they won't collide with anything else in
-- the same Supabase project (e.g. other coursework).

create table if not exists meera_notes (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null,
  raw_text text not null,
  status text not null default 'processing', -- processing | backlog | drafted | error
  angle text,
  score int,                 -- final 1-10 rating (see rating_json for the breakdown)
  rating_json text,          -- {relevance, recency, context, content, checkability, score, tier, reasoning}
  created_at timestamptz not null default now()
);

create table if not exists meera_drafts (
  id bigint generated always as identity primary key,
  note_id bigint not null references meera_notes(id),
  version int not null,
  text text not null,
  citations_json text not null default '[]',
  status text not null default 'pending', -- pending | approved | discarded | superseded
  discard_reason text,       -- "Didn't like draft" | "Not relevant to post now" (set on discard)
  created_at timestamptz not null default now()
);

create index if not exists meera_drafts_status_created_at_idx on meera_drafts (status, created_at desc);

-- This bot talks to Supabase with the service role key (server-side only,
-- never shipped to a browser), so Row Level Security can stay off for these
-- two tables — there's no public/anon client accessing them.
