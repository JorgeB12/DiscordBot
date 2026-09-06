import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  MessageContextMenuCommandInteraction,
  MessageCreateOptions,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  VoiceBasedChannel,
} from "discord.js";
import { GuildPlayer } from "../audio/player.js";
import { deleteVoiceSession, getVoiceSession, setVoiceSession } from "../audio/registry.js";
import type { Requester, Song } from "../audio/musicPlayer.js";
import type { LibrarySong } from "../db/library.js";
import { rememberSongs } from "./library.js";
import { errorEmbed, playerPanel, playlistQueuedEmbed, queuedEmbed } from "./embeds.js";

/**
 * Piezas compartidas para poner música desde cualquier sitio (slash, botones,
 * menú contextual, playlists…): unirse al canal, encolar y construir la respuesta.
 */

export type MusicReply = {
  embeds: EmbedBuilder[];
  components?: MessageCreateOptions["components"];
  /** Se llama con el mensaje ya publicado (para adoptarlo como panel, caducar menús, etc.). */
  onSent?: (message: Message) => void | Promise<void>;
};

type SendFn = (payload: { embeds: EmbedBuilder[]; components: MessageCreateOptions["components"] }) => Promise<Message>;

/** Envía la respuesta y ejecuta el gancho `onSent` con el mensaje resultante. */
export async function deliver(reply: MusicReply, send: SendFn): Promise<Message> {
  const sent = await send({ embeds: reply.embeds, components: reply.components ?? [] });
  await reply.onSent?.(sent);
  return sent;
}

const joinsInFlight = new Map<string, Promise<GuildPlayer>>();

export async function joinChannel(
  channel: VoiceBasedChannel,
  textChannel: GuildTextBasedChannel | null,
): Promise<GuildPlayer> {
  const pending = joinsInFlight.get(channel.guild.id);
  if (pending) return pending;

  const work = (async () => {
    const existing = getVoiceSession(channel.guild.id);
    if (existing?.isConnectedTo(channel.id)) {
      await existing.ready();
      existing.setTextChannel(textChannel);
      return existing;
    }
    if (existing) await existing.destroy("moved");

    const session = new GuildPlayer({
      channel,
      textChannel,
      onDestroyed: () => deleteVoiceSession(channel.guild.id),
    });
    await session.ready();
    setVoiceSession(channel.guild.id, session);
    return session;
  })();

  joinsInFlight.set(channel.guild.id, work);
  try {
    return await work;
  } finally {
    joinsInFlight.delete(channel.guild.id);
  }
}

/** Busca/resuelve `query` y lo pone o lo encola en el canal del usuario. */
export async function playFor(
  member: GuildMember,
  query: string,
  textChannel: GuildTextBasedChannel | null,
): Promise<MusicReply> {
  const channel = member.voice.channel;
  if (!channel) {
    return { embeds: [errorEmbed("Métete a un canal de voz y pongo la canción.")] };
  }

  let player: GuildPlayer | null = null;
  try {
    player = await joinChannel(channel, textChannel);
    player.setTextChannel(textChannel);
    const result = await player.playQuery(query, requesterOf(member), { adoptPanel: true });
    rememberSongs(result.songs);
    return replyFor(player, result.songs, result.started, result.playlistTitle);
  } catch (error) {
    console.error("[music] failed", error);
    void player?.publishPanel();
    const message = error instanceof Error ? error.message : "No pude poner esa canción.";
    return { embeds: [errorEmbed(message)] };
  }
}

/** Encola canciones ya resueltas (playlists guardadas, favoritos…). */
export async function playSongs(
  member: GuildMember,
  songs: LibrarySong[],
  textChannel: GuildTextBasedChannel | null,
  options: { label?: string; shuffle?: boolean } = {},
): Promise<MusicReply> {
  const channel = member.voice.channel;
  if (!channel) {
    return { embeds: [errorEmbed("Métete a un canal de voz y pongo la música.")] };
  }
  if (!songs.length) {
    return { embeds: [errorEmbed("No hay canciones que poner.")] };
  }

  const requester = requesterOf(member);
  const list = songs.map((song) => ({ ...song, requestedBy: requester }));
  if (options.shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
  }

  let player: GuildPlayer | null = null;
  try {
    player = await joinChannel(channel, textChannel);
    player.setTextChannel(textChannel);
    const result = await player.playSongs(list, { adoptPanel: true });
    return replyFor(player, result.songs, result.started, options.label);
  } catch (error) {
    console.error("[music] failed", error);
    void player?.publishPanel();
    const message = error instanceof Error ? error.message : "No pude poner la música.";
    return { embeds: [errorEmbed(message)] };
  }
}

function replyFor(player: GuildPlayer, songs: Song[], started: boolean, label?: string): MusicReply {
  if (songs.length > 1) {
    return {
      embeds: [playlistQueuedEmbed(label, songs, started, player)],
      // La playlist tiene su propio resumen; el panel se publica justo debajo.
      onSent: started ? () => player.publishPanel() : undefined,
    };
  }
  const song = songs[0]!;
  if (started) {
    // La propia respuesta se convierte en el panel: un solo mensaje, sin duplicados.
    return { ...playerPanel(player), onSent: (sent) => player.adoptPanel(sent) };
  }
  return { embeds: [queuedEmbed(song, player.queue.length, player)] };
}

export function requesterOf(member: GuildMember): Requester {
  return {
    id: member.id,
    name: member.displayName,
    avatarUrl: member.displayAvatarURL({ size: 64 }),
  };
}

export function isGuildMember(member: unknown): member is GuildMember {
  return Boolean(member && typeof member === "object" && "voice" in member);
}

export function textChannelFrom(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction
    | MessageContextMenuCommandInteraction,
): GuildTextBasedChannel | null {
  return interaction.channel && interaction.channel.isTextBased() && !interaction.channel.isDMBased()
    ? interaction.channel
    : null;
}
