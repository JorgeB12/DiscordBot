import {
  ActionRowBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { streamSong } from "../audio/musicPlayer.js";
import { CURATED_STATIONS, findCurated, searchStations, type Station } from "../audio/radio.js";
import { BEMOL_COLOR, errorEmbed } from "./embeds.js";
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
      .setName("poner")
      .setDescription("Pone una emisora por nombre (de la lista) o por URL de stream")
      .addStringOption((option) => option.setName("emisora").setDescription("Nombre o URL").setRequired(true).setMaxLength(300)),
  );

const pendingStations = new Map<string, { stations: Station[]; timer: ReturnType<typeof setTimeout> }>();

export async function handleRadio(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) {
    await interaction.reply({ content: "Usa este comando en un servidor.", ephemeral: true });
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

  const wanted = interaction.options.getString("emisora", true).trim();
  let station: Station | null = findCurated(wanted);
  if (!station && /^https?:\/\//i.test(wanted)) station = { name: hostOf(wanted), url: wanted, genre: "Stream", emoji: "📻" };
  if (!station) {
    const found = await searchStations(wanted, 1).catch(() => []);
    station = found[0] ?? null;
  }
  if (!station) {
    await interaction.reply({ content: `No encontré la emisora **${wanted}**. Mira \`/radio lista\` o usa \`/radio buscar\`.`, ephemeral: true });
    return;
  }
  await interaction.deferReply();
  await deliver(await playStation(member, station, interaction), (payload) => interaction.editReply(payload));
}

export async function handleRadioSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) return;
  const index = Number(interaction.values[0]);
  const station = pendingStations.get(interaction.guild.id)?.stations[index];
  if (!station) {
    await interaction.reply({ content: "Esa lista caducó. Vuelve a usar `/radio`.", ephemeral: true });
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
