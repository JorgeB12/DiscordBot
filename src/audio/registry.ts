import type { GuildPlayer } from "./player.js";

const sessions = new Map<string, GuildPlayer>();

export function getVoiceSession(guildId: string): GuildPlayer | undefined {
  return sessions.get(guildId);
}

export function setVoiceSession(guildId: string, session: GuildPlayer): void {
  sessions.set(guildId, session);
}

export function deleteVoiceSession(guildId: string): void {
  sessions.delete(guildId);
}

export function allVoiceSessions(): GuildPlayer[] {
  return [...sessions.values()];
}
