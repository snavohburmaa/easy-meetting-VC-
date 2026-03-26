-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)
-- Creates the tables needed for meeting history.

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code TEXT NOT NULL,
  meeting_name TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  topics JSONB DEFAULT '[]'::jsonb,
  assignments JSONB DEFAULT '[]'::jsonb,
  key_decisions JSONB DEFAULT '[]'::jsonb,
  participant_summaries JSONB DEFAULT '[]'::jsonb,
  attention_stats JSONB DEFAULT '[]'::jsonb,
  raw_transcript TEXT DEFAULT '',
  duration_minutes INTEGER DEFAULT 0,
  attendees TEXT[] DEFAULT ARRAY[]::TEXT[],
  host_email TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  user_name TEXT DEFAULT '',
  is_host BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(meeting_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_mp_email ON meeting_participants(user_email);
CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings(created_at DESC);

-- Row Level Security (optional but recommended)
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;

-- Allow the anon/service key to read/write (since auth is handled by the Node server)
CREATE POLICY "Allow all for anon" ON meetings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON meeting_participants FOR ALL USING (true) WITH CHECK (true);
