import { config } from "../config.js";
import { getDb } from "./database.js";

/** Configuración de Bemol para un servidor. Los `null` significan "usa el valor por defecto". */
export type GuildSettings = {
  guildId: string;
  defaultVolume: number | null;
  /** Quedarse en el canal aunque no suene nada ni haya nadie. */
  stay247: boolean;
  /** Minutos sin música antes de salir. 0 = nunca. */
  idleLeaveMin: number | null;
  /** Minutos con el canal vacío antes de salir. 0 = nunca. */
  emptyLeaveMin: number | null;
  voteskip: boolean;
  voteskipPercent: number;
  voteskipMinListeners: number;
  /** Canal de texto preferido para el panel cuando no hay otro. */
  musicChannelId: string | null;
  /** Al acabarse la cola, seguir con canciones parecidas. */
  autoplay: boolean;
  /** Emisora que suena de fondo en modo 24/7 cuando la cola se vacía. */
  radio247Name: string | null;
  radio247Url: string | null;
};

type Row = {
  guild_id: string;
  default_volume: number | null;
  stay_247: number;
  idle_leave_min: number | null;
  empty_leave_min: number | null;
  voteskip: number;
  voteskip_percent: number;
  voteskip_min_listeners: number;
  music_channel_id: string | null;
  autoplay: number;
  radio_247_name: string | null;
  radio_247_url: string | null;
};

const cache = new Map<string, GuildSettings>();

export function defaultSettings(guildId: string): GuildSettings {
  return {
    guildId,
    defaultVolume: null,
    stay247: false,
    idleLeaveMin: null,
    emptyLeaveMin: null,
    voteskip: true,
    voteskipPercent: 50,
    voteskipMinListeners: 3,
    musicChannelId: null,
    autoplay: false,
    radio247Name: null,
    radio247Url: null,
  };
}

export function getGuildSettings(guildId: string): GuildSettings {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const row = getDb().prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId) as Row | undefined;
  const settings: GuildSettings = row
    ? {
        guildId,
        defaultVolume: row.default_volume,
        stay247: row.stay_247 === 1,
        idleLeaveMin: row.idle_leave_min,
        emptyLeaveMin: row.empty_leave_min,
        voteskip: row.voteskip === 1,
        voteskipPercent: row.voteskip_percent,
        voteskipMinListeners: row.voteskip_min_listeners,
        musicChannelId: row.music_channel_id,
        autoplay: row.autoplay === 1,
        radio247Name: row.radio_247_name,
        radio247Url: row.radio_247_url,
      }
    : defaultSettings(guildId);
  cache.set(guildId, settings);
  return settings;
}

export function updateGuildSettings(guildId: string, patch: Partial<Omit<GuildSettings, "guildId">>): GuildSettings {
  const next: GuildSettings = { ...getGuildSettings(guildId), ...patch, guildId };
  getDb()
    .prepare(
      `INSERT INTO guild_settings (
         guild_id, default_volume, stay_247, idle_leave_min, empty_leave_min,
         voteskip, voteskip_percent, voteskip_min_listeners, music_channel_id, autoplay,
         radio_247_name, radio_247_url, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         default_volume = excluded.default_volume,
         stay_247 = excluded.stay_247,
         idle_leave_min = excluded.idle_leave_min,
         empty_leave_min = excluded.empty_leave_min,
         voteskip = excluded.voteskip,
         voteskip_percent = excluded.voteskip_percent,
         voteskip_min_listeners = excluded.voteskip_min_listeners,
         music_channel_id = excluded.music_channel_id,
         autoplay = excluded.autoplay,
         radio_247_name = excluded.radio_247_name,
         radio_247_url = excluded.radio_247_url,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      next.defaultVolume,
      next.stay247 ? 1 : 0,
      next.idleLeaveMin,
      next.emptyLeaveMin,
      next.voteskip ? 1 : 0,
      next.voteskipPercent,
      next.voteskipMinListeners,
      next.musicChannelId,
      next.autoplay ? 1 : 0,
      next.radio247Name,
      next.radio247Url,
      Date.now(),
    );
  cache.set(guildId, next);
  return next;
}

/* Valores efectivos (configuración del servidor o, si no hay, la global del .env). */

export function effectiveVolume(settings: GuildSettings): number {
  return settings.defaultVolume ?? config.defaultVolume;
}

export function effectiveIdleLeaveMs(settings: GuildSettings): number {
  return settings.idleLeaveMin === null ? config.idleLeaveMs : settings.idleLeaveMin * 60_000;
}

export function effectiveEmptyLeaveMs(settings: GuildSettings): number {
  return settings.emptyLeaveMin === null ? config.emptyLeaveMs : settings.emptyLeaveMin * 60_000;
}

/* ───────────── DJs: usuarios que pueden gestionar la música ───────────── */

const djCache = new Map<string, string[]>();

export function getDjs(guildId: string): string[] {
  const cached = djCache.get(guildId);
  if (cached) return cached;
  const rows = getDb().prepare("SELECT user_id FROM guild_djs WHERE guild_id = ? ORDER BY added_at").all(guildId) as unknown as {
    user_id: string;
  }[];
  const ids = rows.map((row) => row.user_id);
  djCache.set(guildId, ids);
  return ids;
}

export function addDj(guildId: string, userId: string): boolean {
  if (getDjs(guildId).includes(userId)) return false;
  getDb().prepare("INSERT OR IGNORE INTO guild_djs (guild_id, user_id, added_at) VALUES (?, ?, ?)").run(guildId, userId, Date.now());
  djCache.delete(guildId);
  return true;
}

export function removeDj(guildId: string, userId: string): boolean {
  if (!getDjs(guildId).includes(userId)) return false;
  getDb().prepare("DELETE FROM guild_djs WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
  djCache.delete(guildId);
  return true;
}

export function clearDjs(guildId: string): void {
  getDb().prepare("DELETE FROM guild_djs WHERE guild_id = ?").run(guildId);
  djCache.delete(guildId);
}
