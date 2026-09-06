import { PermissionFlagsBits, type GuildMember, type VoiceBasedChannel } from "discord.js";
import { getGuildSettings, type GuildSettings } from "../db/guildSettings.js";

/**
 * Quién puede hacer qué.
 *
 * - "control": pausar, seguir, anterior, repetir, mezclar, pedir skip (con votación si toca).
 *   Cualquiera que esté en el canal de voz con el bot.
 * - "manage": parar, limpiar, quitar, volumen, saltar sin votar, ir a un punto, desconectar.
 *   Si el servidor configuró un rol DJ: DJ, administradores y quien esté solo con el bot.
 *   Sin rol DJ configurado: cualquiera en el canal.
 * - "config": administradores del servidor (Gestionar servidor).
 */
export type Action = "control" | "manage" | "config";

export function isAdmin(member: GuildMember): boolean {
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator);
}

export function isDj(member: GuildMember, settings = getGuildSettings(member.guild.id)): boolean {
  if (isAdmin(member)) return true;
  if (!settings.djRoleId) return true;
  return member.roles.cache.has(settings.djRoleId);
}

/** Personas (no bots) en el canal de voz. */
export function listeners(channel: VoiceBasedChannel | null | undefined): GuildMember[] {
  if (!channel) return [];
  return [...channel.members.filter((member) => !member.user.bot).values()];
}

export function can(member: GuildMember, action: Action, voiceChannel?: VoiceBasedChannel | null): boolean {
  if (action === "config") return isAdmin(member);
  const settings = getGuildSettings(member.guild.id);
  if (action === "control") return true;
  if (isDj(member, settings)) return true;
  // Si está solo con el bot, no molesta a nadie: puede gestionar.
  const others = listeners(voiceChannel).filter((listener) => listener.id !== member.id);
  return others.length === 0;
}

export function denialMessage(action: Action, settings: GuildSettings): string {
  if (action === "config") return "Solo quien pueda gestionar el servidor puede cambiar la configuración de Bemol.";
  const role = settings.djRoleId ? `<@&${settings.djRoleId}>` : "DJ";
  return `Eso lo puede hacer el rol ${role} (o quien esté solo conmigo en el canal). Para saltar, usa \`/skip\`: se abre una votación.`;
}
