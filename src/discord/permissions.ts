import { PermissionFlagsBits, type GuildMember, type VoiceBasedChannel } from "discord.js";
import { getDjs, getGuildSettings } from "../db/guildSettings.js";

/**
 * Quién puede hacer qué.
 *
 * - "control": pausar, seguir, anterior, repetir, mezclar, pedir skip (con votación si toca).
 *   Cualquiera que esté en el canal de voz con el bot.
 * - "manage": parar, limpiar, quitar, volumen, saltar sin votar, desconectar.
 *   Si el servidor configuró DJs: los DJs, los administradores y quien esté solo con el bot.
 *   Sin DJs configurados: cualquiera en el canal.
 * - "config": administradores del servidor (Gestionar servidor).
 */
export type Action = "control" | "manage" | "config";

export function isAdmin(member: GuildMember): boolean {
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator);
}

export function isDj(member: GuildMember): boolean {
  if (isAdmin(member)) return true;
  const djs = getDjs(member.guild.id);
  return djs.length === 0 || djs.includes(member.id);
}

/** Personas (no bots) en el canal de voz. */
export function listeners(channel: VoiceBasedChannel | null | undefined): GuildMember[] {
  if (!channel) return [];
  return [...channel.members.filter((member) => !member.user.bot).values()];
}

export function can(member: GuildMember, action: Action, voiceChannel?: VoiceBasedChannel | null): boolean {
  if (action === "config") return isAdmin(member);
  if (action === "control") return true;
  if (isDj(member)) return true;
  // Si está solo con el bot, no molesta a nadie: puede gestionar.
  const others = listeners(voiceChannel).filter((listener) => listener.id !== member.id);
  return others.length === 0;
}

export function denialMessage(action: Action, guildId: string): string {
  if (action === "config") return "Solo quien pueda gestionar el servidor puede cambiar la configuración de Bemol.";
  const djs = getDjs(guildId);
  const who = djs.length ? `los DJ (${djs.map((id) => `<@${id}>`).join(", ")})` : "los DJ";
  const settings = getGuildSettings(guildId);
  const hint = settings.voteskip ? " Para saltar, usa `/skip`: se abre una votación." : "";
  return `Eso lo pueden hacer ${who}, los administradores o quien esté solo conmigo en el canal.${hint}`;
}
