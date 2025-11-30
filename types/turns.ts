export type ConversationTurnRow = {
  id: string
  session_id: string
  turn: number
  transcript: string
  assistant_reply: string | null
  provider: string | null
  manifest_url: string | null
  user_audio_url: string | null
  assistant_audio_url: string | null
  duration_ms: number | null
  assistant_duration_ms: number | null
  created_at: string
}

export type ConversationTurnInsert = Omit<ConversationTurnRow, 'id' | 'created_at'>

