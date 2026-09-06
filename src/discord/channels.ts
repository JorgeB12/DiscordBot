import { ChannelType, type Guild, type GuildTextBasedChannel, type VoiceBasedChannel } from "discord.js";
import { config } from "../config.js";
import { getGuildSettings } from "../db/guildSettings.js";

/**
 * Canal de texto donde publicar el panel y los avisos.
 *
 * Prioridad: el chat desde el que se pidió la música (para que el panel
 * aparezca donde la gente está hablando), después el canal de música
 * configurado y, por último, un canal que parezca de música o el chat del
 * canal de voz.
 */
export async function getMusicTextChannel(
  guild: Guild,
  requestedFrom: GuildTextBasedChannel | null,
  voiceChannel?: VoiceBasedChannel | null,
): Promise<GuildTextBasedChannel | null> {
  if (requestedFrom) return requestedFrom;

  const configured = getGuildSettings(guild.id).musicChannelId ?? config.musicChannelId;
  if (configured) {
    const channel = await guild.channels.fetch(configured).catch(() => null);
    if (channel?.isTextBased() && !channel.isDMBased()) return channel;
  }

  const named = guild.channels.cache.find(
    (channel) => channel.isTextBased() && /musica|música|music|general|chat/i.test(channel.name),
  );
  if (named?.isTextBased() && !named.isDMBased()) return named;

  if (voiceChannel?.parent) {
    const sibling = voiceChannel.parent.children.cache.find(
      (channel) => channel.type === ChannelType.GuildText,
    );
    if (sibling?.isTextBased()) return sibling;
  }

  return guild.systemChannel;
}
