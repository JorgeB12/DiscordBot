import type { Song } from "../audio/musicPlayer.js";
import type { LoopMode } from "../audio/types.js";
import { getDb } from "./database.js";

/** Foto de una sesión de reproducción, para reanudarla tras un reinicio del bot. */
export type SessionSnapshot = {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string | null;
  current: Song | null;
  queue: Song[];
  positionMs: number;
  volume: number;
  loop: LoopMode;
  paused: boolean;
  savedAt: number;
};

type Row = {
  guild_id: string;
  voice_channel_id: string;
  text_channel_id: string | null;
  current_json: string | null;
  queue_json: string;
  position_ms: number;
  volume: number;
  loop_mode: string;
  paused: number;
  saved_at: number;
};

export function saveSession(snapshot: SessionSnapshot): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (
         guild_id, voice_channel_id, text_channel_id, current_json, queue_json,
         position_ms, volume, loop_mode, paused, saved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         voice_channel_id = excluded.voice_channel_id,
         text_channel_id = excluded.text_channel_id,
         current_json = excluded.current_json,
         queue_json = excluded.queue_json,
         position_ms = excluded.position_ms,
         volume = excluded.volume,
         loop_mode = excluded.loop_mode,
         paused = excluded.paused,
         saved_at = excluded.saved_at`,
    )
    .run(
      snapshot.guildId,
      snapshot.voiceChannelId,
      snapshot.textChannelId,
      snapshot.current ? JSON.stringify(snapshot.current) : null,
      JSON.stringify(snapshot.queue),
      Math.round(snapshot.positionMs),
      snapshot.volume,
      snapshot.loop,
      snapshot.paused ? 1 : 0,
      snapshot.savedAt,
    );
}

export function deleteSession(guildId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE guild_id = ?").run(guildId);
}

export function loadSessions(): SessionSnapshot[] {
  const rows = getDb().prepare("SELECT * FROM sessions").all() as unknown as Row[];
  return rows.map((row) => ({
    guildId: row.guild_id,
    voiceChannelId: row.voice_channel_id,
    textChannelId: row.text_channel_id,
    current: row.current_json ? (JSON.parse(row.current_json) as Song) : null,
    queue: JSON.parse(row.queue_json) as Song[],
    positionMs: row.position_ms,
    volume: row.volume,
    loop: row.loop_mode as LoopMode,
    paused: row.paused === 1,
    savedAt: row.saved_at,
  }));
}
