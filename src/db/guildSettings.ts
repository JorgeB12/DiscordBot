import { config } from "../config.js";
import { getDb } from "./database.js";

/** Configuración de Bemol para un servidor. Los `null` significan "usa el valor por defecto". */
export type GuildSettings = {
  guildId: string;
  /** Rol que puede parar, limpiar, quitar, cambiar volumen, saltar sin votación y desconectar. `null` = todo el mundo. */
  djRoleId: string | null;
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
};

type Row = {
  guild_id: string;
  dj_role_id: string | null;
  default_volume: number | null;
  stay_247: number;
  idle_leave_min: number | null;
  empty_leave_min: number | null;
  voteskip: number;
  voteskip_percent: number;
  voteskip_min_listeners: number;
  music_channel_id: string | null;
};

const cache = new Map<string, GuildSettings>();

export function defaultSettings(guildId: string): GuildSettings {
  return {
    guildId,
    djRoleId: null,
    defaultVolume: null,
    stay247: false,
    idleLeaveMin: null,
    emptyLeaveMin: null,
    voteskip: true,
    voteskipPercent: 50,
    voteskipMinListeners: 3,
    musicChannelId: null,
  };
}

export function getGuildSettings(guildId: string): GuildSettings {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const row = getDb().prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId) as Row | undefined;
  const settings: GuildSettings = row
    ? {
        guildId,
        djRoleId: row.dj_role_id,
        defaultVolume: row.default_volume,
        stay247: row.stay_247 === 1,
        idleLeaveMin: row.idle_leave_min,
        emptyLeaveMin: row.empty_leave_min,
        voteskip: row.voteskip === 1,
        voteskipPercent: row.voteskip_percent,
        voteskipMinListeners: row.voteskip_min_listeners,
        musicChannelId: row.music_channel_id,
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
         guild_id, dj_role_id, default_volume, stay_247, idle_leave_min, empty_leave_min,
         voteskip, voteskip_percent, voteskip_min_listeners, music_channel_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         dj_role_id = excluded.dj_role_id,
         default_volume = excluded.default_volume,
         stay_247 = excluded.stay_247,
         idle_leave_min = excluded.idle_leave_min,
         empty_leave_min = excluded.empty_leave_min,
         voteskip = excluded.voteskip,
         voteskip_percent = excluded.voteskip_percent,
         voteskip_min_listeners = excluded.voteskip_min_listeners,
         music_channel_id = excluded.music_channel_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      next.djRoleId,
      next.defaultVolume,
      next.stay247 ? 1 : 0,
      next.idleLeaveMin,
      next.emptyLeaveMin,
      next.voteskip ? 1 : 0,
      next.voteskipPercent,
      next.voteskipMinListeners,
      next.musicChannelId,
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
