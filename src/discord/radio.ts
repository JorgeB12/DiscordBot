import {
  MessageFlags,
  ActionRowBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getVoiceSession } from "../audio/registry.js";
import { streamSong } from "../audio/musicPlayer.js";
import { updateGuildSettings } from "../db/guildSettings.js";
import { can, denialMessage } from "./permissions.js";
import { CURATED_STATIONS, findCurated, searchStations, type Station } from "../audio/radio.js";
import { BEMOL_COLOR, errorEmbed, okEmbed } from "./embeds.js";
import { deliver, isGuildMember, playSongs, textChannelFrom } from "./playback.js";

/**
 * `/radio`: emisoras seleccionadas y búsqueda en Radio Browser. La emisora se
 * encola como una canción "en directo" (kind: stream) y ffmpeg la reproduce.
 */

export const RADIO_SELECT = "radio:pick:";

export const radioCommand = new SlashCommandBuilder()
  .setName("radio")
  .setDescription("Pone una emisora de radio en directo")
  .addSubcommand((sub) => sub.setName("lista").setDescription("Emisoras recomendadas"))
  .addSubcommand((sub) =>
    sub
      .setName("buscar")
      .setDescription("Busca emisoras por nombre o género (salsa, jazz, reggaeton, lofi…)")
      .addStringOption((option) => option.setName("texto").setDescription("Qué buscar").setRequired(true).setMaxLength(80)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("247")
      .setDescription("Emisora que suena sola cuando no hay cola (modo 24/7)")
      .addStringOption((option) =>
        option.setName("emisora").setDescription("Nombre o URL; déjalo vacío para quitar la emisora de fondo").setMaxLength(300),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("poner")
      .setDescription("Pone una emisora por nombre (de la lista) o por URL de stream")
      .addStringOption((option) => option.setName("emisora").setDescription("Nombre o URL").setRequired(true).setMaxLength(300)),
  );

const pendingStations = new Map<string, { stations: Station[]; timer: ReturnType<typeof setTimeout> }>();

export async function handleRadio(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) {
    await interaction.reply({ content: "Usa este comando en un servidor.", flags: MessageFlags.Ephemeral });
    return;
  }
  const member = interaction.member;
  const sub = interaction.options.getSubcommand();

  if (sub === "lista") {
    remember(interaction.guild.id, CURATED_STATIONS);
    await interaction.reply({ embeds: [stationsEmbed("📻  Emisoras recomendadas", CURATED_STATIONS)], components: [stationMenu(CURATED_STATIONS)] });
    return;
  }

  if (sub === "buscar") {
    const text = interaction.options.getString("texto", true);
    await interaction.deferReply();
    let stations: Station[] = [];
    try {
      stations = await searchStations(text);
    } catch (error) {
      await interaction.editReply({ embeds: [errorEmbed(`No pude consultar el directorio de radios: ${error instanceof Error ? error.message : error}`)] });
      return;
    }
    if (!stations.length) {
      await interaction.editReply({ embeds: [errorEmbed(`No encontré emisoras para **${text}**. Prueba con un género o un nombre más corto.`)] });
      return;
    }
    remember(interaction.guild.id, stations);
    await interaction.editReply({ embeds: [stationsEmbed(`📻  Emisoras para «${text}»`, stations)], components: [stationMenu(stations)] });
    return;
  }

  if (sub === "247") {
    if (!can(member, "config")) {
      await interaction.reply({ content: denialMessage("config", interaction.guild.id), flags: MessageFlags.Ephemeral });
      return;
    }
    const wanted = interaction.options.getString("emisora");
    if (!wanted) {
      updateGuildSettings(interaction.guild.id, { radio247Name: null, radio247Url: null });
      await interaction.reply({
        content: "✅ Quité la emisora de fondo. El modo 24/7 se sigue configurando con `/config 247`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    const station = await findStation(wanted);
    if (!station) {
      await interaction.editReply({ embeds: [errorEmbed(`No encontré la emisora **${wanted}**. Mira \`/radio lista\` o usa \`/radio buscar\`.`)] });
      return;
    }
    updateGuildSettings(interaction.guild.id, { stay247: true, radio247Name: station.name, radio247Url: station.url });
    const session = getVoiceSession(interaction.guild.id);
    const started = session && !session.current ? await session.playFallbackRadio() : false;
    await interaction.editReply({
      embeds: [
        okEmbed(
          `Modo 24/7 con **${station.name}** de fondo. ${started ? "Ya está sonando." : "Sonará cuando se acabe la cola."} ` +
            "En cuanto alguien pida una canción, la emisora se aparta.",
        ),
      ],
    });
    return;
  }

  const wanted = interaction.options.getString("emisora", true).trim();
  const station = await findStation(wanted);
  if (!station) {
    await interaction.reply({ content: `No encontré la emisora **${wanted}**. Mira \`/radio lista\` o usa \`/radio buscar\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  await deliver(await playStation(member, station, interaction), (payload) => interaction.editReply(payload));
}

/** Busca una emisora por nombre de la lista, URL de stream o en el directorio. */
async function findStation(wanted: string): Promise<Station | null> {
  const clean = wanted.trim();
  const curated = findCurated(clean);
  if (curated) return curated;
  if (/^https?:\/\//i.test(clean)) return { name: hostOf(clean), url: clean, genre: "Stream", emoji: "📻" };
  const found = await searchStations(clean, 1).catch(() => []);
  return found[0] ?? null;
}

export async function handleRadioSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) return;
  const index = Number(interaction.values[0]);
  const station = pendingStations.get(interaction.guild.id)?.stations[index];
  if (!station) {
    await interaction.reply({ content: "Esa lista caducó. Vuelve a usar `/radio`.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  await deliver(await playStation(interaction.member, station, interaction), (payload) => interaction.followUp(payload));
}

async function playStation(
  member: import("discord.js").GuildMember,
  station: Station,
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
) {
  const song = streamSong(station.url, { id: member.id, name: member.displayName }, station.name, {
    author: station.genre,
    thumbnail: station.favicon ?? null,
  });
  return playSongs(member, [song], textChannelFrom(interaction), { label: `📻 ${station.name}` });
}

function remember(guildId: string, stations: Station[]): void {
  const previous = pendingStations.get(guildId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => pendingStations.delete(guildId), 10 * 60_000);
  timer.unref();
  pendingStations.set(guildId, { stations, timer });
}

function stationsEmbed(title: string, stations: Station[]): EmbedBuilder {
  const lines = stations.map(
    (station, index) =>
      `\`${String(index + 1).padStart(2, " ")}.\` ${station.emoji} **${station.name}** · ${station.genre}${station.country ? ` · ${station.country}` : ""}`,
  );
  return new EmbedBuilder()
    .setColor(BEMOL_COLOR)
    .setAuthor({ name: title })
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Elige una en el menú · Las radios suenan hasta que pares o pongas otra cosa" });
}

function stationMenu(stations: Station[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${RADIO_SELECT}${Date.now()}`)
    .setPlaceholder("📻  Elige una emisora")
    .addOptions(
      stations.slice(0, 25).map((station, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${index + 1}. ${station.name}`.slice(0, 100))
          .setDescription((station.genre + (station.country ? ` · ${station.country}` : "")).slice(0, 100) || "Radio")
          .setEmoji(station.emoji)
          .setValue(String(index)),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
