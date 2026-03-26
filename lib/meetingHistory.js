/**
 * Persists meeting summaries to Supabase so users can view past meetings.
 */
import { getSupabase } from "./supabase.js";

/**
 * Save a completed meeting summary to Supabase.
 * @param {object} summaryData - The full summary object from meetingSummary.js
 * @param {string} hostEmail - Email of the meeting host
 * @param {Array<{email:string, name:string}>} participants - All participants
 */
export async function saveMeeting(summaryData, hostEmail, participants) {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data: meeting, error } = await sb
      .from("meetings")
      .insert({
        room_code: summaryData.roomCode,
        meeting_name: summaryData.meetingName || "",
        summary: summaryData.summary || "",
        topics: summaryData.topics || [],
        assignments: summaryData.assignments || [],
        key_decisions: summaryData.keyDecisions || [],
        participant_summaries: summaryData.participantSummaries || [],
        attention_stats: summaryData.attentionStats || [],
        raw_transcript: summaryData.rawTranscript || "",
        duration_minutes: summaryData.durationMinutes || 0,
        attendees: summaryData.attendees || [],
        host_email: hostEmail || "",
      })
      .select("id")
      .single();

    if (error) {
      console.error("[meeting-history] insert meeting error:", error.message);
      return null;
    }

    // Insert participant rows so each user can query their own meetings
    const participantRows = (participants || []).map((p) => ({
      meeting_id: meeting.id,
      user_email: p.email,
      user_name: p.name || "",
      is_host: p.email === hostEmail,
    }));

    if (participantRows.length > 0) {
      const { error: pErr } = await sb
        .from("meeting_participants")
        .upsert(participantRows, { onConflict: "meeting_id,user_email" });
      if (pErr) console.error("[meeting-history] insert participants error:", pErr.message);
    }

    return meeting.id;
  } catch (err) {
    console.error("[meeting-history] saveMeeting error:", err.message || err);
    return null;
  }
}

/**
 * Update the meeting name by ID.
 */
export async function updateMeetingName(meetingId, name) {
  const sb = getSupabase();
  if (!sb || !meetingId) return;
  const { error } = await sb.from("meetings").update({ meeting_name: name }).eq("id", meetingId);
  if (error) console.error("[meeting-history] updateMeetingName error:", error.message);
}

/**
 * Update the meeting name by room code (used right after meeting ends,
 * when the Supabase ID isn't known client-side yet).
 */
export async function updateMeetingNameByRoomCode(roomCode, name) {
  const sb = getSupabase();
  if (!sb || !roomCode) return;
  const { data } = await sb
    .from("meetings")
    .select("id")
    .eq("room_code", roomCode)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data) {
    const { error } = await sb.from("meetings").update({ meeting_name: name }).eq("id", data.id);
    if (error) console.error("[meeting-history] updateMeetingNameByRoomCode error:", error.message);
  }
}

/**
 * Delete a meeting and its participants by ID.
 */
export async function deleteMeeting(meetingId) {
  const sb = getSupabase();
  if (!sb || !meetingId) return false;
  const { error } = await sb.from("meetings").delete().eq("id", meetingId);
  if (error) {
    console.error("[meeting-history] deleteMeeting error:", error.message);
    return false;
  }
  return true;
}

/**
 * Fetch recent meetings for a user (as participant or host).
 * @param {string} email
 * @param {number} [limit=20]
 */
export async function getRecentMeetings(email, limit = 20) {
  const sb = getSupabase();
  if (!sb || !email) return [];

  try {
    // Get meeting IDs this user participated in
    const { data: rows, error } = await sb
      .from("meeting_participants")
      .select("meeting_id, is_host")
      .eq("user_email", email)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !rows || rows.length === 0) return [];

    const ids = rows.map((r) => r.meeting_id);
    const hostMap = new Map(rows.map((r) => [r.meeting_id, r.is_host]));

    const { data: meetings, error: mErr } = await sb
      .from("meetings")
      .select("id, room_code, meeting_name, summary, duration_minutes, attendees, created_at")
      .in("id", ids)
      .order("created_at", { ascending: false });

    if (mErr || !meetings) return [];

    return meetings.map((m) => ({
      id: m.id,
      roomCode: m.room_code,
      meetingName: m.meeting_name,
      summary: m.summary,
      durationMinutes: m.duration_minutes,
      attendees: m.attendees || [],
      createdAt: m.created_at,
      isHost: !!hostMap.get(m.id),
    }));
  } catch (err) {
    console.error("[meeting-history] getRecentMeetings error:", err.message || err);
    return [];
  }
}

/**
 * Fetch full meeting details by ID (for viewing past summary + AI Q&A).
 * @param {string} meetingId
 */
export async function getMeetingById(meetingId) {
  const sb = getSupabase();
  if (!sb || !meetingId) return null;

  try {
    const { data, error } = await sb
      .from("meetings")
      .select("*")
      .eq("id", meetingId)
      .single();

    if (error || !data) return null;

    return {
      id: data.id,
      roomCode: data.room_code,
      meetingName: data.meeting_name,
      summary: data.summary,
      topics: data.topics || [],
      assignments: data.assignments || [],
      keyDecisions: data.key_decisions || [],
      participantSummaries: data.participant_summaries || [],
      attentionStats: data.attention_stats || [],
      rawTranscript: data.raw_transcript || "",
      durationMinutes: data.duration_minutes,
      attendees: data.attendees || [],
      hostEmail: data.host_email,
      createdAt: data.created_at,
    };
  } catch (err) {
    console.error("[meeting-history] getMeetingById error:", err.message || err);
    return null;
  }
}

/**
 * Check if a user was a participant in a meeting.
 */
export async function isParticipant(meetingId, email) {
  const sb = getSupabase();
  if (!sb || !meetingId || !email) return false;

  const { data, error } = await sb
    .from("meeting_participants")
    .select("id")
    .eq("meeting_id", meetingId)
    .eq("user_email", email)
    .limit(1);
  if (error) {
    console.error("[meeting-history] isParticipant error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
