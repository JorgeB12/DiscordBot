import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Song } from "../audio/musicPlayer.js";
import type { LoopMode } from "../audio/types.js";
import { formatDuration } from "../util/time.js";

export const CONTROL_IDS = {
  previous: "bemol:prev",
  pause: "bemol:pause",
  skip: "bemol:skip",
  stop: "bemol:stop",
  loop: "bemol:loop",
  shuffle: "bemol:shuffle",
  queue: "bemol:queue",
  add: "bemol:add",
  addModal: "bemol:addmodal",
  addQuery: "bemol:addquery",
  removeSelect: "bemol:remove",
  queueRefresh: "bemol:qrefresh",
} as const;

export const QUEUE_PAGE_PREFIX = "bemol:qpage:";

/** Ids de los componentes de la biblioteca (playlists y favoritos). Los gestiona library.ts. */
export const LIB_IDS = {
  prefix: "lib:",
  favToggle: "lib:fav:toggle",
  savePanel: "lib:save:panel",
  /** + id de canción */
  saveSong: "lib:save:song:",
  /** + id de canción */
  searchPlay: "search:play:",
  /** Elección de alcance al guardar desde el panel: la que suena o toda la cola. */
  saveScopeSong: "lib:save:scope:song",
  saveScopeQueue: "lib:save:scope:queue",
  /** Modal de "nueva playlist" para el conjunto que el usuario tiene pendiente de guardar. */
  newPlaylistModal: "lib:newpl",
  queueSave: "lib:queue:save",
  queueSaveModal: "lib:queue:savemodal",
  queueSaveName: "lib:queue:savename",
  /** + id de canción */
  saveSelect: "lib:save:select:",
} as const;

export const LOOP_LABEL: Record<LoopMode, string> = {
  off: "No",
  track: "Canción",
  queue: "Cola",
};

/**
 * Panel de reproducción, en tres filas que caben en una línea cada una incluso
 * en ventanas estrechas o en móvil. Las etiquetas se mantienen cortas y de
 * longitud fija: si crecen, Discord parte la fila y algún botón queda huérfano.
 *
 *  ⏮ · ⏸ Pausa / ▶ Seguir · ⏭ Saltar · ⏹ Parar
 *  🔀 Mezclar · 🔁 Repetir · 📃 Cola
 *  ➕ Añadir · ❤️ Me gusta · 📋 Playlist
 */
export function playerControls(options: {
  paused: boolean;
  loop: LoopMode;
  hasPrevious: boolean;
}): ActionRowBuilder<ButtonBuilder>[] {
  const pause = new ButtonBuilder()
    .setCustomId(CONTROL_IDS.pause)
    .setEmoji(options.paused ? "▶️" : "⏸️")
    .setLabel(options.paused ? "Seguir" : "Pausa")
    .setStyle(options.paused ? ButtonStyle.Success : ButtonStyle.Primary);

  // El modo de repetición se ve en el emoji y el color; el texto no cambia para
  // que el botón no cambie de ancho al pulsarlo (el pie del panel lo detalla).
  const loop = new ButtonBuilder()
    .setCustomId(CONTROL_IDS.loop)
    .setEmoji(options.loop === "track" ? "🔂" : "🔁")
    .setLabel("Repetir")
    .setStyle(options.loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary);

  const transport = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.previous)
      .setEmoji("⏮️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!options.hasPrevious),
    pause,
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.skip)
      .setEmoji("⏭️")
      .setLabel("Saltar")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.stop)
      .setEmoji("⏹️")
      .setLabel("Parar")
      .setStyle(ButtonStyle.Danger),
  );

  const queueRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.shuffle)
      .setEmoji("🔀")
      .setLabel("Mezclar")
      .setStyle(ButtonStyle.Secondary),
    loop,
    queueButton(),
  );

  // Añadir y guardar: la biblioteca va ligada a quien pulsa.
  const library = new ActionRowBuilder<ButtonBuilder>().addComponents(
    addButton(),
    new ButtonBuilder().setCustomId(LIB_IDS.favToggle).setEmoji("❤️").setLabel("Me gusta").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(LIB_IDS.savePanel).setEmoji("📋").setLabel("Playlist").setStyle(ButtonStyle.Secondary),
  );

  return [transport, queueRow, library];
}

/** Botones cuando la cola se ha acabado: solo lo que tiene sentido hacer. */
export function idleControls(): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(addButton())];
}

function addButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(CONTROL_IDS.add)
    .setEmoji("➕")
    .setLabel("Añadir")
    .setStyle(ButtonStyle.Success);
}

function queueButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(CONTROL_IDS.queue)
    .setEmoji("📃")
    .setLabel("Cola")
    .setStyle(ButtonStyle.Secondary);
}

export function addSongModal(): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(CONTROL_IDS.addQuery)
    .setLabel("Canción, artista o enlace de YouTube")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Ej: Bohemian Rhapsody · https://youtu.be/...")
    .setRequired(true)
    .setMaxLength(200);

  return new ModalBuilder()
    .setCustomId(CONTROL_IDS.addModal)
    .setTitle("Añadir a la cola")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

/**
 * Controles de la vista de cola: paginación, actualizar y un menú para
 * quitar canciones de la página actual sin tener que contar posiciones.
 */
export function queueControls(
  page: number,
  pages: number,
  pageSongs: { position: number; song: Song }[],
): (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] {
  const rows: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] = [];

  // Paginación en su propia fila: junto a las acciones no cabía y se partía.
  if (pages > 1) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${QUEUE_PAGE_PREFIX}${page - 1}`)
        .setEmoji("◀️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        // Id propio: dos componentes del mismo mensaje no pueden compartir custom_id
        // (en la página 1, "anterior" ya vale ...:0 y Discord rechazaría el mensaje).
        .setCustomId(`${QUEUE_PAGE_PREFIX}info`)
        .setLabel(`Página ${page} / ${pages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${QUEUE_PAGE_PREFIX}${page + 1}`)
        .setEmoji("▶️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONTROL_IDS.queueRefresh}:${page}`)
        .setEmoji("🔄")
        .setLabel("Actualizar")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(LIB_IDS.queueSave)
        .setEmoji("💾")
        .setLabel("Guardar cola")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  if (pageSongs.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(CONTROL_IDS.removeSelect)
      .setPlaceholder("🗑️  Quitar una canción de la cola…")
      .addOptions(
        pageSongs.slice(0, 25).map(({ position, song }) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`#${position} · ${song.title}`.slice(0, 100))
            .setDescription(`${formatDuration(song.durationMs)} · pedida por ${song.requestedBy.name}`.slice(0, 100))
            .setValue(`${position}:${song.id}`.slice(0, 100)),
        ),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  return rows;
}

/**
 * Resultados de búsqueda: una fila para poner cada resultado y otra para
 * guardarlo (favoritos o playlist) sin reproducirlo.
 */
export function searchControls(songs: Song[]): ActionRowBuilder<ButtonBuilder>[] {
  const shown = songs.slice(0, 5);
  const play = new ActionRowBuilder<ButtonBuilder>().addComponents(
    shown.map((song, index) =>
      new ButtonBuilder()
        .setCustomId(`${LIB_IDS.searchPlay}${song.id.slice(0, 60)}`)
        .setLabel(`▶ ${index + 1}`)
        .setStyle(ButtonStyle.Primary),
    ),
  );
  const save = new ActionRowBuilder<ButtonBuilder>().addComponents(
    shown.map((song, index) =>
      new ButtonBuilder()
        .setCustomId(`${LIB_IDS.saveSong}${song.id.slice(0, 60)}`)
        .setLabel(`💾 ${index + 1}`)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return [play, save];
}
