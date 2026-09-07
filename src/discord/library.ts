import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getVoiceSession } from "../audio/registry.js";
import type { Song } from "../audio/musicPlayer.js";
import {
  LIMITS,
  addFavorite,
  addTracks,
  copyPlaylist,
  createPlaylist,
  deletePlaylist,
  findPlaylist,
  getPlaylist,
  isFavorite,
  listFavorites,
  listPlaylists,
  playlistTracks,
  removeFavorite,
  removeTrack,
  toLibrarySong,
  type LibrarySong,
  type Playlist,
} from "../db/library.js";
import { LIB_IDS } from "./controls.js";
import { BEMOL_COLOR, MUTED_COLOR, OK_COLOR } from "./embeds.js";
import { deliver, isGuildMember, playFor, playSongs, textChannelFrom } from "./playback.js";
import { formatDuration, formatDurationWords } from "../util/time.js";

/* ───────────── Canciones vistas recientemente (para los botones de guardar) ───────────── */

const recent = new Map<string, { song: LibrarySong; at: number }>();
const RECENT_TTL_MS = 6 * 60 * 60_000;

export function rememberSongs(songs: (Song | LibrarySong)[]): void {
  const now = Date.now();
  for (const song of songs) recent.set(song.id, { song: "requestedBy" in song ? toLibrarySong(song) : song, at: now });
  if (recent.size > 2000) {
    for (const [id, entry] of recent) if (now - entry.at > RECENT_TTL_MS) recent.delete(id);
  }
}

export function recallSong(id: string): LibrarySong | null {
  for (const [key, entry] of recent) if (key.startsWith(id)) return entry.song;
  return null;
}

/* ───────────── Guardado en curso: qué eligió guardar cada usuario ───────────── */

/** Marcador que usan los componentes cuando el conjunto va en `pendingSaves`. */
const PENDING = "@pending";
const SAVE_TTL_MS = 5 * 60_000;

type PendingSave = { songs: LibrarySong[]; label: string; timer: ReturnType<typeof setTimeout> };
const pendingSaves = new Map<string, PendingSave>();

const saveKey = (member: GuildMember) => `${member.guild.id}:${member.id}`;

function rememberSave(member: GuildMember, songs: LibrarySong[], label: string): void {
  const key = saveKey(member);
  const previous = pendingSaves.get(key);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => pendingSaves.delete(key), SAVE_TTL_MS);
  timer.unref();
  pendingSaves.set(key, { songs, label, timer });
}

/** Lo que toca guardar: el conjunto pendiente, o una canción suelta de la búsqueda. */
function songsToSave(member: GuildMember, token: string): { songs: LibrarySong[]; label: string } | null {
  if (token === PENDING) {
    const pending = pendingSaves.get(saveKey(member));
    return pending ? { songs: pending.songs, label: pending.label } : null;
  }
  const song = recallSong(token);
  return song ? { songs: [song], label: `**${song.title}**` } : null;
}

/** Canción actual más el resto de la cola, como foto del momento del clic. */
function queueSnapshot(member: GuildMember): LibrarySong[] {
  const session = getVoiceSession(member.guild.id);
  return [...(session?.current ? [session.current] : []), ...(session?.queue ?? [])].map(toLibrarySong);
}

/* ───────────────────────────── Comandos ───────────────────────────── */

const nameOption = (description: string) => (option: import("discord.js").SlashCommandStringOption) =>
  option.setName("nombre").setDescription(description).setRequired(true).setAutocomplete(true).setMaxLength(LIMITS.nameLength);

export const libraryCommands = [
  new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Tus playlists personales (funcionan en cualquier servidor)")
    .addSubcommand((sub) =>
      sub
        .setName("crear")
        .setDescription("Crea una playlist")
        .addStringOption((option) => option.setName("nombre").setDescription("Nombre").setRequired(true).setMaxLength(LIMITS.nameLength)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("añadir")
        .setDescription("Añade la canción que suena, o la que indiques, a una playlist")
        .addStringOption(nameOption("Playlist"))
        .addStringOption((option) => option.setName("cancion").setDescription("Nombre o enlace (si lo omites, la que suena)")),
    )
    .addSubcommand((sub) => sub.setName("ver").setDescription("Muestra una playlist").addStringOption(nameOption("Playlist")))
    .addSubcommand((sub) => sub.setName("lista").setDescription("Tus playlists"))
    .addSubcommand((sub) =>
      sub
        .setName("reproducir")
        .setDescription("Pone una playlist en la cola")
        .addStringOption(nameOption("Playlist"))
        .addBooleanOption((option) => option.setName("mezclar").setDescription("En orden aleatorio")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("quitar")
        .setDescription("Quita una canción de una playlist")
        .addStringOption(nameOption("Playlist"))
        .addIntegerOption((option) => option.setName("posicion").setDescription("Número en la playlist").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) => sub.setName("eliminar").setDescription("Borra una playlist").addStringOption(nameOption("Playlist")))
    .addSubcommand((sub) =>
      sub.setName("compartir").setDescription("Publica una playlist para que cualquiera la reproduzca o la copie").addStringOption(nameOption("Playlist")),
    ),
  new SlashCommandBuilder()
    .setName("favoritos")
    .setDescription("Tus canciones favoritas")
    .addSubcommand((sub) => sub.setName("ver").setDescription("Muestra tus favoritas"))
    .addSubcommand((sub) =>
      sub
        .setName("reproducir")
        .setDescription("Pone tus favoritas en la cola")
        .addBooleanOption((option) => option.setName("mezclar").setDescription("En orden aleatorio")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("quitar")
        .setDescription("Quita una canción de favoritas")
        .addIntegerOption((option) => option.setName("posicion").setDescription("Número en la lista").setRequired(true).setMinValue(1)),
    ),
  new SlashCommandBuilder().setName("like").setDescription("Guarda en favoritas la canción que suena"),
];

export const LIBRARY_COMMAND_NAMES = new Set(["playlist", "favoritos", "like"]);

export async function handleLibraryAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const names = listPlaylists(interaction.user.id)
    .map((playlist) => playlist.name)
    .filter((name) => name.toLowerCase().includes(typed))
    .slice(0, 25);
  await interaction.respond(names.map((name) => ({ name, value: name })));
}

export async function handleLibrarySlash(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !isGuildMember(interaction.member)) {
    await interaction.reply({ content: "Usa este comando en un servidor.", ephemeral: true });
    return;
  }
  const member = interaction.member;
  const name = interaction.commandName;

  if (name === "like") {
    const song = currentSong(member);
    if (!song) {
      await interaction.reply({ content: "No hay nada sonando que guardar.", ephemeral: true });
      return;
    }
    await interaction.reply({ content: toggleFavorite(member.id, song), ephemeral: true });
    return;
  }

  if (name === "favoritos") {
    await handleFavorites(interaction, member);
    return;
  }

  await handlePlaylist(interaction, member);
}

async function handleFavorites(interaction: ChatInputCommandInteraction, member: GuildMember): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const favorites = listFavorites(member.id);

  if (sub === "ver") {
    if (!favorites.length) {
      await interaction.reply({ content: "Aún no tienes favoritas. Usa `/like` o el botón ❤️ del panel mientras suena algo.", ephemeral: true });
      return;
    }
    await interaction.reply({ embeds: [favoritesEmbed(member, favorites, 1)], components: favoritesControls(1, pageCount(favorites.length)), ephemeral: true });
    return;
  }

  if (sub === "quitar") {
    const position = interaction.options.getInteger("posicion", true);
    const song = favorites[position - 1];
    if (!song) {
      await interaction.reply({ content: "Esa posición no existe en tus favoritas.", ephemeral: true });
      return;
    }
    removeFavorite(member.id, song.id);
    await interaction.reply({ content: `💔 Quité **${song.title}** de tus favoritas.`, ephemeral: true });
    return;
  }

  if (!favorites.length) {
    await interaction.reply({ content: "Aún no tienes favoritas.", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const reply = await playSongs(member, favorites, textChannelFrom(interaction), {
    label: `❤️ Favoritas de ${member.displayName}`,
    shuffle: interaction.options.getBoolean("mezclar") ?? false,
  });
  await deliver(reply, (payload) => interaction.editReply(payload));
}

async function handlePlaylist(interaction: ChatInputCommandInteraction, member: GuildMember): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const nameArg = interaction.options.getString("nombre");

  if (sub === "crear") {
    try {
      const playlist = createPlaylist(member.id, member.displayName, nameArg!);
      await interaction.reply({
        content: `✅ Playlist **${playlist.name}** creada. Añade canciones con \`/playlist añadir ${playlist.name}\` o con el botón 📋 del panel.`,
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : "No pude crear la playlist.", ephemeral: true });
    }
    return;
  }

  if (sub === "lista") {
    const playlists = listPlaylists(member.id);
    if (!playlists.length) {
      await interaction.reply({ content: "No tienes playlists. Crea una con `/playlist crear`.", ephemeral: true });
      return;
    }
    await interaction.reply({ embeds: [playlistsEmbed(member, playlists)], ephemeral: true });
    return;
  }

  const playlist = findPlaylist(member.id, nameArg ?? "");
  if (!playlist) {
    await interaction.reply({ content: `No tienes ninguna playlist llamada **${nameArg}**. Mira \`/playlist lista\`.`, ephemeral: true });
    return;
  }

  switch (sub) {
    case "añadir": {
      const query = interaction.options.getString("cancion");
      if (!query) {
        const song = currentSong(member);
        if (!song) {
          await interaction.reply({ content: "No hay nada sonando. Indica una canción o un enlace.", ephemeral: true });
          return;
        }
        const { added } = addTracks(playlist.id, [song]);
        await interaction.reply({
          content: added ? `✅ **${song.title}** añadida a **${playlist.name}**.` : `**${song.title}** ya estaba en **${playlist.name}**.`,
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const { resolveTracks } = await import("../audio/musicPlayer.js");
      try {
        const { songs } = await resolveTracks(query, { id: member.id, name: member.displayName });
        rememberSongs(songs);
        const { added, skipped } = addTracks(playlist.id, songs.map(toLibrarySong));
        const summary = songs.length === 1 ? `**${songs[0]!.title}**` : `${added} canciones`;
        await interaction.editReply(
          added
            ? `✅ ${summary} añadida${songs.length === 1 ? "" : "s"} a **${playlist.name}**.${skipped ? ` (${skipped} ya estaban o no cabían)` : ""}`
            : `Nada nuevo: ya estaba en **${playlist.name}** o la playlist está llena.`,
        );
      } catch (error) {
        await interaction.editReply(error instanceof Error ? error.message : "No encontré esa canción.");
      }
      return;
    }
    case "ver": {
      const tracks = playlistTracks(playlist.id);
      await interaction.reply({
        embeds: [playlistEmbed(playlist, tracks, 1)],
        components: playlistControls(playlist, 1, pageCount(tracks.length), true),
        ephemeral: true,
      });
      return;
    }
    case "reproducir": {
      const tracks = playlistTracks(playlist.id);
      if (!tracks.length) {
        await interaction.reply({ content: `**${playlist.name}** está vacía.`, ephemeral: true });
        return;
      }
      await interaction.deferReply();
      const reply = await playSongs(member, tracks, textChannelFrom(interaction), {
        label: `🎧 ${playlist.name}`,
        shuffle: interaction.options.getBoolean("mezclar") ?? false,
      });
      await deliver(reply, (payload) => interaction.editReply(payload));
      return;
    }
    case "quitar": {
      const position = interaction.options.getInteger("posicion", true);
      const removed = removeTrack(playlist.id, position);
      await interaction.reply({
        content: removed ? `🗑️ Quité **${removed.title}** de **${playlist.name}**.` : "Esa posición no existe en la playlist.",
        ephemeral: true,
      });
      return;
    }
    case "eliminar": {
      deletePlaylist(playlist.id);
      await interaction.reply({ content: `🗑️ Playlist **${playlist.name}** eliminada.`, ephemeral: true });
      return;
    }
    case "compartir": {
      const tracks = playlistTracks(playlist.id);
      if (!tracks.length) {
        await interaction.reply({ content: `**${playlist.name}** está vacía; añade canciones antes de compartirla.`, ephemeral: true });
        return;
      }
      await interaction.reply({
        embeds: [shareEmbed(playlist, tracks)],
        components: playlistControls(playlist, 1, 1, false),
      });
      return;
    }
    default:
      await interaction.reply({ content: "Subcomando desconocido.", ephemeral: true });
  }
}

/* ─────────────────────── Botones, menús y modales (lib:*) ─────────────────────── */

export async function handleLibraryComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith(LIB_IDS.prefix) && !id.startsWith(LIB_IDS.searchPlay)) return false;
  if (!interaction.guild || !isGuildMember(interaction.member)) return true;
  const member = interaction.member;

  // ▶ n en resultados de búsqueda
  if (id.startsWith(LIB_IDS.searchPlay) && interaction.isButton()) {
    const song = recallSong(id.slice(LIB_IDS.searchPlay.length));
    if (!song) {
      await interaction.reply({ content: "Esa búsqueda ya caducó. Vuelve a usar `/buscar`.", ephemeral: true });
      return true;
    }
    await interaction.deferReply();
    const reply = await playFor(member, song.url, textChannelFrom(interaction));
    await deliver(reply, (payload) => interaction.editReply(payload));
    return true;
  }

  // ❤️ en el panel
  if (id === LIB_IDS.favToggle && interaction.isButton()) {
    const song = currentSong(member);
    if (!song) {
      await interaction.reply({ content: "Ya no suena nada que guardar.", ephemeral: true });
      return true;
    }
    await interaction.reply({ content: toggleFavorite(member.id, song), ephemeral: true });
    return true;
  }

  // 💾 n en la búsqueda → una canción suelta
  if (id.startsWith(LIB_IDS.saveSong) && interaction.isButton()) {
    const song = recallSong(id.slice(LIB_IDS.saveSong.length));
    if (!song) {
      await interaction.reply({ content: "No encuentro esa canción; vuelve a buscarla o a ponerla.", ephemeral: true });
      return true;
    }
    rememberSongs([song]);
    await interaction.reply({
      content: `¿Dónde guardo **${song.title}**?`,
      components: [saveSelect(member.id, song.id)],
      ephemeral: true,
    });
    return true;
  }

  // 📋 en el panel: con cola, preguntamos si guardamos solo la que suena o todo
  if (id === LIB_IDS.savePanel && interaction.isButton()) {
    const queue = queueSnapshot(member);
    if (!queue.length) {
      await interaction.reply({ content: "No hay nada que guardar ahora mismo.", ephemeral: true });
      return true;
    }
    rememberSongs(queue);

    if (queue.length === 1) {
      const song = queue[0]!;
      await interaction.reply({
        content: `¿Dónde guardo **${song.title}**?`,
        components: [saveSelect(member.id, song.id)],
        ephemeral: true,
      });
      return true;
    }

    rememberSave(member, queue, `las ${queue.length} canciones de la cola`);
    const others = queue.length - 1;
    await interaction.reply({
      content: `Suena **${queue[0]!.title}** y ${others === 1 ? "hay 1 canción más" : `hay ${others} canciones más`} en la cola. ¿Qué guardo?`,
      components: [scopeButtons(queue.length)],
      ephemeral: true,
    });
    return true;
  }

  // Elección de alcance: solo la que suena o toda la cola
  if ((id === LIB_IDS.saveScopeSong || id === LIB_IDS.saveScopeQueue) && interaction.isButton()) {
    const pending = pendingSaves.get(saveKey(member));
    if (!pending) {
      await interaction.update({ content: "Esa elección ya caducó; vuelve a pulsar 📋.", components: [] });
      return true;
    }
    if (id === LIB_IDS.saveScopeSong) {
      const song = pending.songs[0]!;
      rememberSave(member, [song], `**${song.title}**`);
    }
    const target = pendingSaves.get(saveKey(member))!;
    await interaction.update({ content: `¿Dónde guardo ${target.label}?`, components: [saveSelect(member.id, PENDING)] });
    return true;
  }

  if (id.startsWith(LIB_IDS.saveSelect) && interaction.isStringSelectMenu()) {
    const target = songsToSave(member, id.slice(LIB_IDS.saveSelect.length));
    const choice = interaction.values[0] ?? "";
    if (!target) {
      await interaction.update({ content: "Esa elección ya caducó; vuelve a intentarlo.", components: [] });
      return true;
    }
    if (choice === "fav") {
      await interaction.update({ content: saveToFavorites(member.id, target.songs), components: [] });
      return true;
    }
    if (choice === "new") {
      rememberSave(member, target.songs, target.label);
      await interaction.showModal(newPlaylistModal());
      return true;
    }
    const playlist = getPlaylist(Number(choice.replace("pl:", "")));
    if (!playlist || playlist.ownerId !== member.id) {
      await interaction.update({ content: "Esa playlist ya no existe.", components: [] });
      return true;
    }
    const { added, skipped } = addTracks(playlist.id, target.songs);
    await interaction.update({ content: savedMessage(added, skipped, target, playlist.name), components: [] });
    return true;
  }

  // Modal "nueva playlist" desde el menú de guardar, o "guardar cola como playlist"
  if (interaction.isModalSubmit()) {
    const name = interaction.fields.getTextInputValue(LIB_IDS.queueSaveName).trim();
    let songs: LibrarySong[] = [];
    if (id === LIB_IDS.queueSaveModal) {
      const session = getVoiceSession(member.guild.id);
      songs = [...(session?.current ? [session.current] : []), ...(session?.queue ?? [])].map(toLibrarySong);
    } else if (id === LIB_IDS.newPlaylistModal) {
      songs = pendingSaves.get(saveKey(member))?.songs ?? [];
    } else if (id.startsWith("lib:newpl:")) {
      // Menús abiertos antes de una actualización del bot.
      const song = recallSong(id.slice("lib:newpl:".length));
      if (song) songs = [song];
    }
    if (!songs.length) {
      await interaction.reply({ content: "No hay canciones que guardar.", ephemeral: true });
      return true;
    }
    try {
      const playlist = createPlaylist(member.id, member.displayName, name);
      const { added } = addTracks(playlist.id, songs);
      await interaction.reply({ content: `✅ Playlist **${playlist.name}** creada con ${added} ${added === 1 ? "canción" : "canciones"}.`, ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : "No pude crear la playlist.", ephemeral: true });
    }
    return true;
  }

  if (id === LIB_IDS.queueSave && interaction.isButton()) {
    const session = getVoiceSession(member.guild.id);
    if (!session?.current && !session?.queue.length) {
      await interaction.reply({ content: "La cola está vacía.", ephemeral: true });
      return true;
    }
    await interaction.showModal(queueSaveModal());
    return true;
  }

  // Botones de playlist: reproducir, mezclar, copiar, paginar
  const match = id.match(/^lib:pl:(play|shuffle|copy|page):(\d+)(?::(\d+))?$/);
  if (match && interaction.isButton()) {
    const [, action, rawId, rawPage] = match;
    const playlist = getPlaylist(Number(rawId));
    if (!playlist) {
      await interaction.reply({ content: "Esa playlist ya no existe.", ephemeral: true });
      return true;
    }
    const tracks = playlistTracks(playlist.id);
    if (action === "page") {
      const page = Number(rawPage) || 1;
      await interaction.update({
        embeds: [playlistEmbed(playlist, tracks, page)],
        components: playlistControls(playlist, page, pageCount(tracks.length), playlist.ownerId === member.id),
      });
      return true;
    }
    if (action === "copy") {
      if (playlist.ownerId === member.id) {
        await interaction.reply({ content: `**${playlist.name}** ya es tuya: está en \`/playlist lista\`.`, ephemeral: true });
        return true;
      }
      if (findPlaylist(member.id, playlist.name)) {
        await interaction.reply({ content: `Ya tienes una playlist llamada **${playlist.name}**; no la copio otra vez.`, ephemeral: true });
        return true;
      }
      try {
        const copy = copyPlaylist(playlist.id, member.id, member.displayName);
        await interaction.reply({ content: `✅ Guardada como **${copy.name}** en tus playlists.`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: error instanceof Error ? error.message : "No pude copiarla.", ephemeral: true });
      }
      return true;
    }
    if (!tracks.length) {
      await interaction.reply({ content: "Esa playlist está vacía.", ephemeral: true });
      return true;
    }
    await interaction.deferReply();
    const reply = await playSongs(member, tracks, textChannelFrom(interaction), {
      label: `🎧 ${playlist.name}`,
      shuffle: action === "shuffle",
    });
    await deliver(reply, (payload) => interaction.followUp(payload));
    return true;
  }

  // Favoritos: paginar y reproducir
  const fav = id.match(/^lib:fav:(page|play|shuffle)(?::(\d+))?$/);
  if (fav && interaction.isButton()) {
    const favorites = listFavorites(member.id);
    if (fav[1] === "page") {
      const page = Number(fav[2]) || 1;
      await interaction.update({ embeds: [favoritesEmbed(member, favorites, page)], components: favoritesControls(page, pageCount(favorites.length)) });
      return true;
    }
    if (!favorites.length) {
      await interaction.reply({ content: "No tienes favoritas.", ephemeral: true });
      return true;
    }
    await interaction.deferReply();
    const reply = await playSongs(member, favorites, textChannelFrom(interaction), {
      label: `❤️ Favoritas de ${member.displayName}`,
      shuffle: fav[1] === "shuffle",
    });
    await deliver(reply, (payload) => interaction.followUp(payload));
    return true;
  }

  await interaction.reply({ content: "Ese botón ya no hace nada.", ephemeral: true }).catch(() => undefined);
  return true;
}

/* ───────────────────────────── Helpers ───────────────────────────── */

const PAGE = 10;
const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE));

function currentSong(member: GuildMember): LibrarySong | null {
  const session = getVoiceSession(member.guild.id);
  return session?.current ? toLibrarySong(session.current) : null;
}

function toggleFavorite(userId: string, song: LibrarySong, addOnly = false): string {
  if (isFavorite(userId, song.id)) {
    if (addOnly) return `**${song.title}** ya está en tus favoritas.`;
    removeFavorite(userId, song.id);
    return `💔 Quité **${song.title}** de tus favoritas.`;
  }
  try {
    addFavorite(userId, song);
    return `❤️ **${song.title}** guardada en tus favoritas. Ponlas con \`/favoritos reproducir\`.`;
  } catch (error) {
    return error instanceof Error ? error.message : "No pude guardarla.";
  }
}

function saveToFavorites(userId: string, songs: LibrarySong[]): string {
  if (songs.length === 1) return toggleFavorite(userId, songs[0]!, true);
  let added = 0;
  let skipped = 0;
  for (const song of songs) {
    try {
      if (addFavorite(userId, song)) added++;
      else skipped++;
    } catch (error) {
      const why = error instanceof Error ? error.message : "No pude guardarlas.";
      return added ? `❤️ Guardé ${added} en favoritas, pero paré: ${why}` : why;
    }
  }
  return added
    ? `❤️ ${added} ${added === 1 ? "canción guardada" : "canciones guardadas"} en tus favoritas.${skipped ? ` (${skipped} ya estaban)` : ""}`
    : "Todas esas canciones ya estaban en tus favoritas.";
}

function savedMessage(added: number, skipped: number, target: { songs: LibrarySong[]; label: string }, playlistName: string): string {
  if (!added) {
    return target.songs.length === 1
      ? `${target.label} ya estaba en **${playlistName}**.`
      : `Nada nuevo: ya estaban en **${playlistName}** o la playlist está llena.`;
  }
  const what = target.songs.length === 1 ? target.label : `${added} ${added === 1 ? "canción" : "canciones"}`;
  return `✅ ${what} ${added === 1 ? "guardada" : "guardadas"} en **${playlistName}**.${skipped ? ` (${skipped} ya estaban o no cabían)` : ""}`;
}

function scopeButtons(total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(LIB_IDS.saveScopeSong).setEmoji("🎵").setLabel("Solo la que suena").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(LIB_IDS.saveScopeQueue).setEmoji("📃").setLabel(`Toda la cola (${total})`).setStyle(ButtonStyle.Secondary),
  );
}

function saveSelect(userId: string, token: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const playlists = listPlaylists(userId).slice(0, 23);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${LIB_IDS.saveSelect}${token.slice(0, 60)}`)
    .setPlaceholder("Elige favoritas o una playlist")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Favoritas").setEmoji("❤️").setValue("fav"),
      ...playlists.map((playlist) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(playlist.name.slice(0, 100))
          .setDescription(`${playlist.trackCount} canciones`)
          .setEmoji("🎧")
          .setValue(`pl:${playlist.id}`),
      ),
      new StringSelectMenuOptionBuilder().setLabel("Nueva playlist…").setEmoji("➕").setValue("new"),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function newPlaylistModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(LIB_IDS.newPlaylistModal)
    .setTitle("Nueva playlist")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(LIB_IDS.queueSaveName)
          .setLabel("Nombre de la playlist")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Night Drive")
          .setRequired(true)
          .setMaxLength(LIMITS.nameLength),
      ),
    );
}

function queueSaveModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(LIB_IDS.queueSaveModal)
    .setTitle("Guardar la cola como playlist")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(LIB_IDS.queueSaveName)
          .setLabel("Nombre de la playlist")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Sesión de hoy")
          .setRequired(true)
          .setMaxLength(LIMITS.nameLength),
      ),
    );
}

function playlistControls(playlist: Playlist, page: number, pages: number, own: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lib:pl:play:${playlist.id}`).setEmoji("▶️").setLabel("Reproducir").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`lib:pl:shuffle:${playlist.id}`).setEmoji("🔀").setLabel("Mezclar").setStyle(ButtonStyle.Secondary),
  );
  if (!own) {
    actions.addComponents(
      new ButtonBuilder().setCustomId(`lib:pl:copy:${playlist.id}`).setEmoji("💾").setLabel("Guardar en mis playlists").setStyle(ButtonStyle.Secondary),
    );
  }
  const rows = [actions];
  if (pages > 1) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`lib:pl:page:${playlist.id}:${page - 1}`).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
        // Id propio: no puede coincidir con el de "anterior" en la página 1.
        new ButtonBuilder().setCustomId(`lib:pl:info:${playlist.id}`).setLabel(`Página ${page} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`lib:pl:page:${playlist.id}:${page + 1}`).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
      ),
    );
  }
  return rows;
}

function favoritesControls(page: number, pages: number): ActionRowBuilder<ButtonBuilder>[] {
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("lib:fav:play").setEmoji("▶️").setLabel("Reproducir").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("lib:fav:shuffle").setEmoji("🔀").setLabel("Mezclar").setStyle(ButtonStyle.Secondary),
    ),
  ];
  if (pages > 1) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`lib:fav:page:${page - 1}`).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
        new ButtonBuilder().setCustomId("lib:fav:info").setLabel(`Página ${page} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`lib:fav:page:${page + 1}`).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
      ),
    );
  }
  return rows;
}

/* ───────────────────────────── Embeds ───────────────────────────── */

function trackLines(tracks: LibrarySong[], page: number): string[] {
  const start = (Math.max(1, page) - 1) * PAGE;
  return tracks.slice(start, start + PAGE).map((song, index) => {
    const n = String(start + index + 1).padStart(2, " ");
    return `\`${n}.\` [${escapeMd(song.title)}](${song.url}) \`${formatDuration(song.durationMs)}\``;
  });
}

function playlistEmbed(playlist: Playlist, tracks: LibrarySong[], page: number): EmbedBuilder {
  const pages = pageCount(tracks.length);
  const current = Math.min(Math.max(1, page), pages);
  const lines = trackLines(tracks, current);
  return new EmbedBuilder()
    .setColor(BEMOL_COLOR)
    .setAuthor({ name: "🎧  Playlist" })
    .setTitle(playlist.name)
    .setDescription(lines.length ? lines.join("\n") : "*Vacía. Añade canciones con `/playlist añadir` o con el botón 📋 del panel.*")
    .setFooter({
      text: [
        `${tracks.length} ${tracks.length === 1 ? "canción" : "canciones"}`,
        formatDurationWords(playlist.durationMs),
        `Creada por ${playlist.ownerName}`,
        pages > 1 ? `Página ${current}/${pages}` : null,
      ]
        .filter((part) => part !== null)
        .join("  ·  "),
    });
}

function shareEmbed(playlist: Playlist, tracks: LibrarySong[]): EmbedBuilder {
  const preview = trackLines(tracks, 1).slice(0, 5);
  if (tracks.length > 5) preview.push(`*… y ${tracks.length - 5} más*`);
  return new EmbedBuilder()
    .setColor(OK_COLOR)
    .setAuthor({ name: `🎧  ${playlist.ownerName} comparte una playlist` })
    .setTitle(playlist.name)
    .setDescription(preview.join("\n"))
    .addFields(
      { name: "Canciones", value: `${tracks.length}`, inline: true },
      { name: "Duración", value: formatDurationWords(playlist.durationMs), inline: true },
      { name: "Creada por", value: `<@${playlist.ownerId}>`, inline: true },
    )
    .setFooter({ text: "Reproducir la pone en tu canal de voz · Guardar la copia a tus playlists" });
}

function playlistsEmbed(member: GuildMember, playlists: Playlist[]): EmbedBuilder {
  const lines = playlists.map(
    (playlist) => `🎧 **${escapeMd(playlist.name)}** · ${playlist.trackCount} ${playlist.trackCount === 1 ? "canción" : "canciones"} · ${formatDurationWords(playlist.durationMs)}`,
  );
  return new EmbedBuilder()
    .setColor(BEMOL_COLOR)
    .setAuthor({ name: `Playlists de ${member.displayName}`, iconURL: member.displayAvatarURL({ size: 64 }) })
    .setDescription(lines.join("\n"))
    .setFooter({ text: "/playlist ver · reproducir · añadir · compartir · eliminar" });
}

function favoritesEmbed(member: GuildMember, favorites: LibrarySong[], page: number): EmbedBuilder {
  const pages = pageCount(favorites.length);
  const current = Math.min(Math.max(1, page), pages);
  const total = favorites.reduce((sum, song) => sum + (song.durationMs || 0), 0);
  return new EmbedBuilder()
    .setColor(favorites.length ? BEMOL_COLOR : MUTED_COLOR)
    .setAuthor({ name: `❤️  Favoritas de ${member.displayName}`, iconURL: member.displayAvatarURL({ size: 64 }) })
    .setDescription(trackLines(favorites, current).join("\n") || "*Nada todavía.*")
    .setFooter({
      text: [`${favorites.length} canciones`, formatDurationWords(total), pages > 1 ? `Página ${current}/${pages}` : null]
        .filter((part) => part !== null)
        .join("  ·  "),
    });
}

function escapeMd(value: string): string {
  return value.replace(/\[/g, "(").replace(/\]/g, ")").replace(/([*_`~\\])/g, "\\$1").slice(0, 120);
}

