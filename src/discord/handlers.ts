import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type VoiceState,
} from "discord.js";
import { getGuildSettings } from "../db/guildSettings.js";
import { deleteSession, loadSessions } from "../db/sessions.js";
import { configCommand, handleConfig } from "./configCommand.js";
import { can, denialMessage, type Action } from "./permissions.js";
import type { GuildPlayer } from "../audio/player.js";
import { allVoiceSessions, getVoiceSession } from "../audio/registry.js";
import { extractYoutubeUrl, searchTracks, type Song } from "../audio/musicPlayer.js";
import { config, matchesWakeWord, stripWakeWord } from "../config.js";
import { CONTROL_IDS, QUEUE_PAGE_PREFIX, addSongModal, queueControls, searchControls } from "./controls.js";
import {
  LIBRARY_COMMAND_NAMES,
  handleLibraryAutocomplete,
  handleLibraryComponent,
  handleLibrarySlash,
  libraryCommands,
  rememberSongs,
} from "./library.js";
import {
  deliver,
  isGuildMember,
  joinChannel,
  playFor,
  requesterOf,
  textChannelFrom,
  type MusicReply,
} from "./playback.js";
import {
  errorEmbed,
  helpEmbed,
  infoEmbed,
  okEmbed,
  playerPanel,
  queueEmbed,
  queuePage,
  queuePageCount,
  searchEmbed,
  searchResolvedEmbed,
  stalePanelEmbed,
} from "./embeds.js";
import { parseIntent } from "./intent.js";
import type { LoopMode } from "../audio/types.js";

const SEARCH_TTL_MS = 60_000;

type PendingSearch = {
  query: string;
  message: Message | null;
  timer: ReturnType<typeof setTimeout>;
};

const seenMessages = new Set<string>();
const pendingSearches = new Map<string, PendingSearch>();

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Reproduce o añade a la cola una canción o playlist de YouTube")
    .addStringOption((option) =>
      option.setName("cancion").setDescription("Nombre, artista o enlace de YouTube").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Añade una canción a la cola")
    .addStringOption((option) =>
      option.setName("cancion").setDescription("Nombre, artista o enlace de YouTube").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("buscar")
    .setDescription("Busca en YouTube y elige entre varios resultados")
    .addStringOption((option) =>
      option.setName("cancion").setDescription("Qué quieres buscar").setRequired(true),
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Salta la canción actual"),
  new SlashCommandBuilder().setName("next").setDescription("Pasa a la siguiente canción"),
  new SlashCommandBuilder().setName("stop").setDescription("Para la música y vacía la cola"),
  new SlashCommandBuilder().setName("pausa").setDescription("Pausa la canción"),
  new SlashCommandBuilder().setName("seguir").setDescription("Reanuda la canción"),
  new SlashCommandBuilder()
    .setName("cola")
    .setDescription("Muestra la cola (y deja quitar canciones desde el menú)")
    .addIntegerOption((option) =>
      option.setName("pagina").setDescription("Página de la cola").setMinValue(1),
    ),
  new SlashCommandBuilder().setName("sonando").setDescription("Muestra el panel de reproducción aquí"),
  new SlashCommandBuilder().setName("mezclar").setDescription("Mezcla la cola"),
  new SlashCommandBuilder()
    .setName("repetir")
    .setDescription("Cambia el modo de repetición")
    .addStringOption((option) =>
      option
        .setName("modo")
        .setDescription("No, canción o cola")
        .addChoices(
          { name: "No repetir", value: "off" },
          { name: "Repetir la canción", value: "track" },
          { name: "Repetir la cola", value: "queue" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("volumen")
    .setDescription("Cambia el volumen (0-150)")
    .addIntegerOption((option) =>
      option.setName("nivel").setDescription("Porcentaje").setRequired(true).setMinValue(0).setMaxValue(150),
    ),
  new SlashCommandBuilder()
    .setName("quitar")
    .setDescription("Quita una canción de la cola")
    .addIntegerOption((option) =>
      option.setName("posicion").setDescription("Número en la cola").setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder().setName("limpiar").setDescription("Vacía la cola y deja la canción actual"),
  new SlashCommandBuilder().setName("unirme").setDescription("Bemol se une a tu canal de voz"),
  new SlashCommandBuilder().setName("salir").setDescription("Bemol se sale del canal de voz"),
  new SlashCommandBuilder().setName("ayuda").setDescription("Cómo usar a Bemol"),
  configCommand,
  ...libraryCommands,
  // Clic derecho en un mensaje → Apps → "Añadir a Bemol"
  new ContextMenuCommandBuilder().setName("Añadir a Bemol").setType(ApplicationCommandType.Message),
].map((command) => command.toJSON());

export async function registerSlashCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
      body: slashCommands,
    });
    console.log(`[discord] slash commands registrados en el servidor ${config.discordGuildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), { body: slashCommands });
  console.log("[discord] slash commands globales registrados");
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isAutocomplete()) {
    if (LIBRARY_COMMAND_NAMES.has(interaction.commandName)) await handleLibraryAutocomplete(interaction);
    return;
  }
  if (interaction.isChatInputCommand()) {
    if (LIBRARY_COMMAND_NAMES.has(interaction.commandName)) await handleLibrarySlash(interaction);
    else await handleSlash(interaction);
    return;
  }
  if (interaction.isMessageContextMenuCommand()) {
    await handleAddFromMessage(interaction);
    return;
  }
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    if (await handleLibraryComponent(interaction)) return;
  }
  if (interaction.isButton()) {
    await handleButton(interaction);
    return;
  }
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === CONTROL_IDS.removeSelect) await handleRemoveSelect(interaction);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId === CONTROL_IDS.addModal) {
    await handleAddModal(interaction);
  }
}

/* ─────────────────────────────── Slash commands ─────────────────────────────── */

async function handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) {
    await interaction.reply({ content: "Usa este comando en un servidor.", ephemeral: true });
    return;
  }

  const member = interaction.member;
  const name = interaction.commandName;
  const textChannel = textChannelFrom(interaction);

  if (name === "ayuda") {
    await interaction.reply({ embeds: [helpEmbed(config.wakeWord)], ephemeral: true });
    return;
  }

  if (name === "config") {
    if (!can(member, "config")) {
      await interaction.reply({ content: denialMessage("config", interaction.guild.id), ephemeral: true });
      return;
    }
    await handleConfig(interaction);
    return;
  }

  if (name === "unirme") {
    const channel = member.voice.channel;
    if (!channel) {
      await interaction.reply({ content: "Métete a un canal de voz primero y vuelve a usar `/unirme`.", ephemeral: true });
      return;
    }
    await joinChannel(channel, textChannel);
    await interaction.reply({
      embeds: [okEmbed(`Estoy en **${channel.name}**. Pon algo con \`/play\` o con \`${config.wakeWord} pon ...\`.`)],
    });
    return;
  }

  if (name === "salir") {
    const session = getVoiceSession(interaction.guild.id);
    if (!session) {
      await interaction.reply({ content: "No estoy en ningún canal de voz.", ephemeral: true });
      return;
    }
    if (!can(member, "manage", session.voiceChannel)) {
      await interaction.reply({ content: denialMessage("manage", interaction.guild.id), ephemeral: true });
      return;
    }
    const channelName = session.channelName;
    await session.destroy("manual");
    await interaction.reply({ embeds: [okEmbed(channelName ? `Me salí de **${channelName}**.` : "Me salgo.")] });
    return;
  }

  if (name === "play" || name === "add") {
    await interaction.deferReply();
    const query = interaction.options.getString("cancion", true);
    const reply = await playFor(member, query, textChannel);
    await deliver(reply, (payload) => interaction.editReply(payload));
    return;
  }

  if (name === "buscar") {
    await interaction.deferReply();
    const query = interaction.options.getString("cancion", true);
    const reply = await searchFor(member, query);
    await deliver(reply, (payload) => interaction.editReply(payload));
    return;
  }

  const session = getVoiceSession(interaction.guild.id);
  if (name === "cola") {
    if (!session?.current && !session?.queue.length) {
      await interaction.reply({ content: "La cola está vacía. Pon algo con `/play`.", ephemeral: true });
      return;
    }
    const page = interaction.options.getInteger("pagina") ?? 1;
    await interaction.reply(queueView(session!, page));
    return;
  }

  if (name === "sonando") {
    if (!session?.current) {
      await interaction.reply({ content: "No hay nada sonando. Pon algo con `/play`.", ephemeral: true });
      return;
    }
    session.setTextChannel(textChannel);
    await interaction.reply(playerPanel(session));
    const sent = await interaction.fetchReply();
    await session.adoptPanel(sent);
    return;
  }

  const control = await runControl(member, textChannel, actionFor(name), (player) => {
    switch (name) {
      case "skip":
      case "next":
        return player.requestSkip(member);
      case "stop":
        return player.stop();
      case "pausa":
        return player.pause();
      case "seguir":
        return player.resume();
      case "mezclar":
        return player.shuffle();
      case "repetir": {
        const mode = interaction.options.getString("modo") as LoopMode | null;
        return mode ? player.setLoop(mode) : player.cycleLoop();
      }
      case "volumen":
        return player.setVolume(interaction.options.getInteger("nivel", true));
      case "quitar":
        return player.remove(interaction.options.getInteger("posicion", true));
      case "limpiar":
        return player.clear();
      default:
        return "Comando desconocido.";
    }
  });

  if ("error" in control) {
    await interaction.reply({ content: control.error, ephemeral: true });
    return;
  }
  if (typeof control.message === "string" && isNoop(control.message)) {
    await interaction.reply({ content: control.message, ephemeral: true });
    return;
  }
  const embed = typeof control.message === "string" ? okEmbed(control.message) : control.message;
  await interaction.reply({ embeds: [embed] });
}

/* ────────────────────────────────── Botones ────────────────────────────────── */

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) return;
  const member = interaction.member;
  const textChannel = textChannelFrom(interaction);
  const session = getVoiceSession(interaction.guild.id);

  if (interaction.customId === CONTROL_IDS.add) {
    if (!member.voice.channel) {
      await interaction.reply({ content: "Métete a un canal de voz y vuelve a pulsar **➕ Añadir**.", ephemeral: true });
      return;
    }
    if (session && !inBotChannel(member, session)) {
      await interaction.reply({
        content: `Estoy en **${session.channelName ?? "otro canal"}**. Métete ahí para añadir canciones.`,
        ephemeral: true,
      });
      return;
    }
    await interaction.showModal(addSongModal());
    return;
  }

  if (interaction.customId === CONTROL_IDS.queue) {
    if (!session) {
      await interaction.reply({ content: "No hay cola. Pon algo con `/play`.", ephemeral: true });
      return;
    }
    await interaction.reply({ ...queueView(session, 1), ephemeral: true });
    return;
  }

  if (interaction.customId.startsWith(QUEUE_PAGE_PREFIX) || interaction.customId.startsWith(CONTROL_IDS.queueRefresh)) {
    if (!session) {
      await interaction.update({ embeds: [infoEmbed("Ya no estoy en el canal de voz. Pon algo con `/play`.")], components: [] });
      return;
    }
    const raw = interaction.customId.startsWith(QUEUE_PAGE_PREFIX)
      ? interaction.customId.slice(QUEUE_PAGE_PREFIX.length)
      : interaction.customId.slice(CONTROL_IDS.queueRefresh.length + 1);
    const page = Number(raw) || 1;
    await interaction.update(queueView(session, page));
    return;
  }

  // Botones de control del panel.
  if (!session) {
    await interaction.reply({ content: "Ya no estoy reproduciendo nada. Pon algo con `/play`.", ephemeral: true });
    return;
  }
  if (!inBotChannel(member, session)) {
    await interaction.reply({
      content: `Estoy en **${session.channelName ?? "otro canal"}**. Métete ahí para controlar la música.`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === CONTROL_IDS.stop && !can(member, "manage", session.voiceChannel)) {
    await interaction.reply({ content: denialMessage("manage", interaction.guild.id), ephemeral: true });
    return;
  }

  // Confirmamos la pulsación antes de actuar: al saltar de canción el panel
  // puede reubicarse (borrarse y volver a publicarse) y el mensaje original
  // dejar de existir.
  await interaction.deferUpdate();
  session.setTextChannel(textChannel);

  const message = await (() => {
    switch (interaction.customId) {
      case CONTROL_IDS.previous:
        return session.previous();
      case CONTROL_IDS.pause:
        return session.paused ? session.resume() : session.pause();
      case CONTROL_IDS.skip:
        return session.requestSkip(member);
      case CONTROL_IDS.stop:
        return session.stop();
      case CONTROL_IDS.loop:
        return session.cycleLoop();
      case CONTROL_IDS.shuffle:
        return session.shuffle();
      default:
        return "Ese botón no hace nada.";
    }
  })();

  if (isNoop(message) || /^(Voto|Ya votaste)/.test(message)) {
    await interaction.followUp({ content: message, ephemeral: /^(No |Ya )/.test(message) });
  }

  // Refrescamos al instante el mensaje pulsado. Si es un panel antiguo que
  // sobrevivió, lo retiramos para que solo quede uno activo. Si el panel se
  // acaba de reubicar, el mensaje ya no existe y la edición falla sin más.
  const payload =
    session.panelMessageId === interaction.message.id
      ? playerPanel(session)
      : { embeds: [stalePanelEmbed()], components: [] };
  await interaction.editReply(payload).catch(() => undefined);
}

/* ─────────────────────────── Modal y menús desplegables ─────────────────────────── */

async function handleAddModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) return;
  const query = interaction.fields.getTextInputValue(CONTROL_IDS.addQuery).trim();
  if (!query) {
    await interaction.reply({ content: "Dime una canción o un enlace.", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const reply = await playFor(interaction.member, query, textChannelFrom(interaction));
  await deliver(reply, (payload) => interaction.editReply(payload));
}

async function handleRemoveSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) return;
  const session = getVoiceSession(interaction.guild.id);
  if (!session) {
    await interaction.update({ embeds: [infoEmbed("Ya no estoy en el canal de voz.")], components: [] });
    return;
  }
  if (!inBotChannel(interaction.member, session)) {
    await interaction.reply({ content: "Métete al canal de voz donde estoy para quitar canciones.", ephemeral: true });
    return;
  }
  if (!can(interaction.member, "manage", session.voiceChannel)) {
    await interaction.reply({ content: denialMessage("manage", interaction.guild.id), ephemeral: true });
    return;
  }

  const [rawPosition, songId] = (interaction.values[0] ?? "").split(/:(.*)/s);
  const hinted = Number(rawPosition);
  // La cola puede haber cambiado desde que se pintó el menú: buscamos por id,
  // empezando por la posición que mostraba el menú.
  // El valor del menú se recorta a 100 caracteres, así que comparamos por prefijo.
  const matches = (song: Song) => Boolean(songId) && song.id.startsWith(songId!);
  const hintedSong = session.queue[hinted - 1];
  const index = hintedSong && matches(hintedSong) ? hinted - 1 : session.queue.findIndex(matches);
  const page = Math.max(1, Math.ceil(Math.max(1, hinted) / 10));

  if (index < 0) {
    await interaction.reply({ content: "Esa canción ya no está en la cola.", ephemeral: true });
    return;
  }

  const message = session.remove(index + 1);
  await interaction.update(queueView(session, page));
  await interaction.followUp({ embeds: [okEmbed(message)], ephemeral: true });
}

/* ──────────────────────────── Mensajes de texto (Bemol ...) ──────────────────────────── */

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild() || !message.member) return;
  if (!message.channel.isTextBased() || message.channel.isDMBased()) return;
  if (seenMessages.has(message.id)) return;
  seenMessages.add(message.id);
  setTimeout(() => seenMessages.delete(message.id), 60_000).unref();

  const utterance = commandText(message);
  if (utterance === null) return;

  const textChannel = message.channel;
  const intent = parseIntent(utterance || "ayuda");

  if (!utterance || intent.type === "help") {
    await message.reply({ embeds: [helpEmbed(config.wakeWord)] });
    return;
  }

  if (intent.type === "join") {
    const channel = message.member.voice.channel;
    if (!channel) {
      await message.reply("Métete a un canal de voz y te uno.");
      return;
    }
    await joinChannel(channel, textChannel);
    await message.reply({ embeds: [okEmbed(`Estoy en **${channel.name}**. Dime \`${config.wakeWord} pon ...\`.`)] });
    return;
  }

  const reply = await dispatchIntent(message.member, intent, textChannel);
  if (typeof reply === "string") {
    await message.reply(reply);
  } else if (reply) {
    await deliver(reply, (payload) => message.reply(payload));
  }
}

export function handleVoiceState(oldState: VoiceState, newState: VoiceState): void {
  const session = getVoiceSession(newState.guild.id);
  if (!session) return;

  const botId = newState.guild.client.user?.id;
  if (botId && newState.id === botId && !newState.channelId && oldState.channelId) {
    void session.destroy("disconnected");
    return;
  }

  const channelId = session.channelId;
  if (!channelId) return;
  if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

  const channel = newState.guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) return;
  const humans = channel.members.filter((member) => !member.user.bot);
  if (humans.size === 0) session.onChannelEmpty();
  else session.onChannelOccupied();
}

export async function shutdownSessions(): Promise<void> {
  await Promise.all(allVoiceSessions().map((session) => session.destroy("shutdown")));
}

/* ───────────────────────────────── Internos ───────────────────────────────── */

function queueView(session: GuildPlayer, page: number) {
  const pages = queuePageCount(session);
  const current = Math.min(pages, Math.max(1, page));
  return {
    embeds: [queueEmbed(session, current)],
    components: queueControls(current, pages, queuePage(session, current)),
  };
}

/** Mensajes del reproductor que indican que no pasó nada (van en ephemeral). */
function isNoop(message: string): boolean {
  return /^(No |Ya |Esa |Ese |La cola ya)/.test(message);
}

async function dispatchIntent(
  member: GuildMember,
  intent: ReturnType<typeof parseIntent>,
  textChannel: GuildTextBasedChannel | null,
): Promise<string | MusicReply | null> {
  switch (intent.type) {
    case "play":
      return playFor(member, intent.query, textChannel);
    case "search":
      return searchFor(member, intent.query);
    case "leave": {
      const session = getVoiceSession(member.guild.id);
      if (!session) return "No estoy en ningún canal de voz.";
      if (!can(member, "manage", session.voiceChannel)) return denialMessage("manage", member.guild.id);
      const channelName = session.channelName;
      await session.destroy("manual");
      return { embeds: [okEmbed(channelName ? `Me salí de **${channelName}**.` : "Me salgo.")] };
    }
    case "help":
      return { embeds: [helpEmbed(config.wakeWord)] };
    case "nowplaying": {
      const session = getVoiceSession(member.guild.id);
      if (!session?.current) return { embeds: [infoEmbed("No hay nada sonando. Pon algo con `/play`.")] };
      session.setTextChannel(textChannel);
      return { ...playerPanel(session), onSent: (sent) => session.adoptPanel(sent) };
    }
    case "queue": {
      const session = getVoiceSession(member.guild.id);
      if (!session?.current && !session?.queue.length) {
        return { embeds: [infoEmbed("La cola está vacía. Pon algo con `/play`.")] };
      }
      session!.setTextChannel(textChannel);
      return queueView(session!, intent.page);
    }
    case "unknown":
      return {
        embeds: [
          infoEmbed(
            `No te entendí. Prueba \`${config.wakeWord} pon el nombre de la canción\`, o escribe \`${config.wakeWord} ayuda\` para ver todo lo que sé hacer.`,
          ),
        ],
      };
    default: {
      const manage = ["stop", "volume", "remove", "clear"].includes(intent.type) || (intent.type === "skip" && intent.count > 1);
      const control = await runControl(member, textChannel, manage ? "manage" : "control", (player) => {
        switch (intent.type) {
          case "skip":
            return intent.count > 1 ? player.skip(intent.count) : player.requestSkip(member);
          case "previous":
            return player.previous();
          case "stop":
            return player.stop();
          case "pause":
            return player.pause();
          case "resume":
            return player.resume();
          case "shuffle":
            return player.shuffle();
          case "loop":
            return intent.mode ? player.setLoop(intent.mode) : player.cycleLoop();
          case "volume":
            return intent.level === undefined
              ? `El volumen está en ${player.volumePercent}%.`
              : player.setVolume(intent.level);
          case "remove":
            return player.remove(intent.position);
          case "clear":
            return player.clear();
          default:
            return "No te entendí.";
        }
      });
      if ("error" in control) return control.error;
      if (typeof control.message !== "string") return { embeds: [control.message] };
      if (isNoop(control.message) || /^(El volumen|Voto|Ya votaste)/.test(control.message)) {
        return { embeds: [infoEmbed(control.message)] };
      }
      return { embeds: [okEmbed(control.message)] };
    }
  }
}

async function searchFor(member: GuildMember, query: string): Promise<MusicReply> {
  const guildId = member.guild.id;
  const songs = await searchTracks(query, requesterOf(member), 5);
  if (!songs.length) {
    return { embeds: [errorEmbed(`No encontré nada para **${query}**.`)] };
  }

  rememberSongs(songs);
  const previous = pendingSearches.get(guildId);
  if (previous) {
    clearTimeout(previous.timer);
    void previous.message?.edit({ embeds: [searchResolvedEmbed(previous.query, null)], components: [] }).catch(() => undefined);
  }

  const pending: PendingSearch = {
    query,
    message: null,
    timer: setTimeout(() => {
      pendingSearches.delete(guildId);
      void pending.message?.edit({ embeds: [searchResolvedEmbed(query, null)], components: [] }).catch(() => undefined);
    }, SEARCH_TTL_MS),
  };
  pending.timer.unref();
  pendingSearches.set(guildId, pending);

  return {
    embeds: [searchEmbed(songs, query)],
    components: searchControls(songs),
    onSent: (sent) => {
      pending.message = sent;
    },
  };
}

/** Qué nivel de permiso exige cada slash command de control. */
function actionFor(command: string): Action {
  return ["stop", "volumen", "quitar", "limpiar"].includes(command) ? "manage" : "control";
}

async function runControl(
  member: GuildMember,
  textChannel: GuildTextBasedChannel | null,
  required: Action,
  action: (player: GuildPlayer) => string | EmbedBuilder | Promise<string>,
): Promise<{ message: string | EmbedBuilder } | { error: string }> {
  const session = getVoiceSession(member.guild.id);
  if (!session) return { error: "No estoy reproduciendo nada. Pon algo con `/play`." };
  if (!inBotChannel(member, session)) {
    return { error: `Estoy en **${session.channelName ?? "otro canal"}**. Métete ahí para controlar la música.` };
  }
  if (!can(member, required, session.voiceChannel)) {
    return { error: denialMessage(required, member.guild.id) };
  }
  session.setTextChannel(textChannel);
  return { message: await action(session) };
}

/* ─────────────────── Menú contextual: clic derecho → Apps → Añadir a Bemol ─────────────────── */

async function handleAddFromMessage(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) {
    await interaction.reply({ content: "Solo funciona dentro de un servidor.", ephemeral: true });
    return;
  }
  const content = interaction.targetMessage.content?.trim() ?? "";
  const url = content.match(/https?:\/\/\S+/)?.[0] ?? extractYoutubeUrl(content);
  const query = url ?? content.replace(/<@!?\d+>/g, "").trim();
  if (!query) {
    await interaction.reply({ content: "Ese mensaje no tiene texto ni enlace que pueda poner.", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const reply = await playFor(interaction.member, query, textChannelFrom(interaction));
  await deliver(reply, (payload) => interaction.editReply(payload));
}

/* ──────────────── Sesiones guardadas: reanudar la música tras un reinicio ──────────────── */

export async function restoreSessions(client: Client<true>): Promise<void> {
  const snapshots = loadSessions();
  for (const snapshot of snapshots) {
    deleteSession(snapshot.guildId);
    try {
      const guild = await client.guilds.fetch(snapshot.guildId);
      const voice = await guild.channels.fetch(snapshot.voiceChannelId).catch(() => null);
      if (!voice?.isVoiceBased()) continue;
      // Sin nadie escuchando no tiene sentido volver a entrar.
      if (voice.members.filter((member) => !member.user.bot).size === 0) continue;
      const text = snapshot.textChannelId ? await guild.channels.fetch(snapshot.textChannelId).catch(() => null) : null;
      const textChannel = text?.isTextBased() && !text.isDMBased() ? text : null;

      const player = await joinChannel(voice, textChannel);
      await player.restore(snapshot);
      const title = snapshot.current?.title;
      console.log(`[session] reanudada en ${guild.name}: ${title ?? "cola"} (+${snapshot.queue.length})`);
      if (textChannel && title) {
        await textChannel
          .send({ embeds: [infoEmbed(`🔁 Vuelvo tras un reinicio. Sigo con **${title}** y ${snapshot.queue.length} en cola.`)] })
          .catch(() => undefined);
      }
    } catch (error) {
      console.warn(`[session] no pude reanudar ${snapshot.guildId}:`, error instanceof Error ? error.message : error);
    }
  }
}

function inBotChannel(member: GuildMember, session: GuildPlayer): boolean {
  return Boolean(member.voice.channelId && member.voice.channelId === session.channelId);
}

function commandText(message: Message): string | null {
  // "@Bemol pon ..." funciona siempre, incluso sin el intent Message Content:
  // Discord entrega el contenido de los mensajes que mencionan al bot.
  const botId = message.client.user?.id;
  if (botId) {
    const mention = new RegExp(`^\\s*<@!?${botId}>[\\s,.:;!?\\-]*`);
    if (mention.test(message.content)) return message.content.replace(mention, "").trim();
  }

  if (matchesWakeWord(message.content)) return stripWakeWord(message.content);

  const url = extractYoutubeUrl(message.content);
  if (url && message.content.replace(url, "").trim() === "") return url;

  const musicChannelId = getGuildSettings(message.guildId!).musicChannelId ?? config.musicChannelId;
  if (musicChannelId && message.channel.id === musicChannelId) {
    const intent = parseIntent(message.content);
    if (intent.type !== "unknown") return message.content;
  }

  return null;
}
