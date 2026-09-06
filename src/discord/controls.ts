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
  search: "bemol:search",
  removeSelect: "bemol:remove",
  queueRefresh: "bemol:qrefresh",
} as const;

export const QUEUE_PAGE_PREFIX = "bemol:qpage:";

export const LOOP_LABEL: Record<LoopMode, string> = {
  off: "No",
  track: "Canción",
  queue: "Cola",
};

/**
 * Panel de reproducción: dos filas de cuatro botones, que caben en una línea
 * incluso en ventanas estrechas o en móvil.
 *
 *  ⏮ · ⏸ Pausa / ▶ Seguir · ⏭ Saltar · ⏹ Parar
 *  🔀 Mezclar · 🔁 Repetir · 📃 Cola · ➕ Añadir
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

  const loop = new ButtonBuilder()
    .setCustomId(CONTROL_IDS.loop)
    .setEmoji(options.loop === "track" ? "🔂" : "🔁")
    .setLabel(options.loop === "off" ? "Repetir" : options.loop === "track" ? "Repetir 1" : "Repetir todo")
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

  const extras = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.shuffle)
      .setEmoji("🔀")
      .setLabel("Mezclar")
      .setStyle(ButtonStyle.Secondary),
    loop,
    queueButton(),
    addButton(),
  );

  return [transport, extras];
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

  const buttons = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`${QUEUE_PAGE_PREFIX}${page - 1}`)
        .setEmoji("◀️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`${QUEUE_PAGE_PREFIX}0`)
        .setLabel(`Página ${page} / ${pages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${QUEUE_PAGE_PREFIX}${page + 1}`)
        .setEmoji("▶️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages),
    );
  }
  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONTROL_IDS.queueRefresh}:${page}`)
      .setEmoji("🔄")
      .setLabel("Actualizar")
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(buttons);

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

export function searchMenu(songs: Song[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(CONTROL_IDS.search)
    .setPlaceholder("🎵  Elige la canción que quieres poner")
    .addOptions(
      songs.slice(0, 10).map((song, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${index + 1}. ${song.title}`.slice(0, 100))
          .setDescription(`${song.author} · ${formatDuration(song.durationMs)}`.slice(0, 100))
          .setValue(song.id.slice(0, 100)),
      ),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}
