import { EmbedBuilder, type APIEmbedField } from "discord.js";
import type { GuildPlayer, LeaveReason } from "../audio/player.js";
import { artworkUrl, type Song } from "../audio/musicPlayer.js";
import { config } from "../config.js";
import { LOOP_LABEL, idleControls, playerControls } from "./controls.js";
import { formatDuration, formatDurationWords, progressBar } from "../util/time.js";

export const BEMOL_COLOR = 0x8b5cf6; // violeta, a juego con el avatar
export const PAUSED_COLOR = 0xf5a623;
export const MUTED_COLOR = 0x6b7280;
export const ERROR_COLOR = 0xe53e3e;
export const OK_COLOR = 0x2ecc71;

const QUEUE_PAGE_SIZE = 10;

/* ────────────────────────── Panel de reproducción ────────────────────────── */

export function nowPlayingEmbed(player: GuildPlayer): EmbedBuilder {
  const song = player.current;
  if (!song) return idleEmbed(player);

  const position = player.playbackPositionMs;
  const next = player.queue[0];
  const paused = player.paused;

  // Todo va en la descripción, en líneas cortas: los campos en columnas se
  // amontonan en móvil o en ventanas estrechas.
  const lines = [
    song.author ? `*${escapeMd(song.author)}*` : null,
    "",
    progressBar(position, song.durationMs),
    "",
    `**Pedida por** ${mention(song.requestedBy)}`,
    sourceLine(song),
    `**En cola** ${queueSummary(player)}`,
    next ? `**Siguiente** [${escapeMd(next.title)}](${next.url}) \`${formatDuration(next.durationMs)}\`` : null,
  ].filter((line) => line !== null);

  const live = song.kind === "stream";
  const embed = new EmbedBuilder()
    .setColor(paused ? PAUSED_COLOR : BEMOL_COLOR)
    .setAuthor({ name: paused ? "⏸  En pausa" : live ? "📻  Radio en directo" : "▶  Sonando ahora" })
    .setTitle(song.title.slice(0, 256))
    .setURL(song.url)
    .setDescription(lines.join("\n"))
    .setFooter({
      text: statusLine(player, "Se actualiza cada 12 s"),
      iconURL: song.requestedBy.avatarUrl,
    });

  const art = artworkUrl(song);
  if (art) embed.setThumbnail(art);
  return embed;
}

export function idleEmbed(player?: GuildPlayer): EmbedBuilder {
  const minutes = Math.round(config.idleLeaveMs / 60_000);
  void player;
  return new EmbedBuilder()
    .setColor(MUTED_COLOR)
    .setAuthor({ name: "⏹  Se acabó la cola" })
    .setDescription(
      [
        "Pon otra canción con el botón **➕ Añadir**, con `/play` o diciendo",
        `\`${config.wakeWord} pon ...\` en el chat.`,
        "",
        `Si no suena nada en **${minutes} min**, me salgo del canal de voz.`,
      ].join("\n"),
    )
    .setFooter({ text: player ? statusLine(player) : "Bemol" });
}

export function farewellEmbed(channelName: string | null, reason: LeaveReason): EmbedBuilder {
  const why: Record<LeaveReason, string> = {
    idle: `Nadie puso nada en ${Math.round(config.idleLeaveMs / 60_000)} min.`,
    empty: "El canal de voz se quedó vacío.",
    manual: "Hasta la próxima.",
    moved: "Me cambié a otro canal de voz.",
    disconnected: "Perdí la conexión con el canal de voz.",
    shutdown: "Me están reiniciando. Vuelvo en un momento.",
  };
  return new EmbedBuilder()
    .setColor(MUTED_COLOR)
    .setAuthor({ name: "👋  Me salí del canal" })
    .setDescription(
      [channelName ? `Estaba en **${escapeMd(channelName)}**.` : null, why[reason], "", "Usa `/play` para volver a llamarme."]
        .filter((line) => line !== null)
        .join("\n"),
    );
}

export function stalePanelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(MUTED_COLOR)
    .setDescription("Este panel ya no está activo. El panel actual está más abajo; si no lo ves, usa `/sonando`.");
}

export function playerPanel(player: GuildPlayer) {
  return {
    embeds: [nowPlayingEmbed(player)],
    components: player.current
      ? playerControls({
          paused: player.paused,
          loop: player.loop,
          hasPrevious: player.history.length > 0,
        })
      : idleControls(),
  };
}

/* ────────────────────────────── Añadir a la cola ────────────────────────────── */

export function panelMovedEmbed(channelId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(MUTED_COLOR)
    .setDescription(`▶  La música sigue sonando. El panel para controlarla está en <#${channelId}>.`);
}

export function queuedEmbed(song: Song, position: number, player: GuildPlayer): EmbedBuilder {
  const etaMs =
    Math.max(0, (player.current?.durationMs ?? 0) - player.playbackPositionMs) +
    player.queue.slice(0, Math.max(0, position - 1)).reduce((sum, item) => sum + (item.durationMs || 0), 0);

  const embed = new EmbedBuilder()
    .setColor(OK_COLOR)
    .setAuthor({ name: "✅  Añadida a la cola" })
    .setTitle(song.title.slice(0, 256))
    .setURL(song.url)
    .setDescription(song.author ? `*${escapeMd(song.author)}*` : null)
    .addFields(
      field("Posición", `#${position}`, true),
      field("Duración", formatDuration(song.durationMs), true),
      field("Suena en", position === 1 && !player.current ? "ahora" : `~${formatDurationWords(etaMs)}`, true),
    )
    .setFooter({
      text: `Pedida por ${song.requestedBy.name}  ·  ${queueSummary(player)}`,
      iconURL: song.requestedBy.avatarUrl,
    });

  const art = artworkUrl(song);
  if (art) embed.setThumbnail(art);
  return embed;
}

export function playlistQueuedEmbed(
  title: string | undefined,
  songs: Song[],
  started: boolean,
  player: GuildPlayer,
  pendingCount = 0,
): EmbedBuilder {
  const first = songs[0];
  const total = songs.reduce((sum, song) => sum + (song.durationMs || 0), 0);
  const preview = songs
    .slice(0, 5)
    .map((song, index) => `\`${index + 1}.\` ${escapeMd(song.title)} \`${formatDuration(song.durationMs)}\``);
  if (songs.length > 5) preview.push(`*… y ${songs.length - 5} más*`);
  if (pendingCount > 0) preview.push(`⏳ *Importando ${pendingCount} canciones más en segundo plano; irán entrando en la cola.*`);

  const embed = new EmbedBuilder()
    .setColor(OK_COLOR)
    .setAuthor({ name: started ? "▶  Playlist en marcha" : "✅  Playlist añadida a la cola" })
    .setTitle((title || first?.title || "Playlist").slice(0, 256))
    .setDescription(preview.join("\n"))
    .addFields(
      field("Canciones", `${songs.length}`, true),
      field("Duración total", formatDuration(total), true),
      field("En cola ahora", queueSummary(player), true),
    );

  if (first?.url) embed.setURL(first.url);
  const art = first ? artworkUrl(first) : null;
  if (art) embed.setThumbnail(art);
  return embed;
}

/* ────────────────────────────────── Cola ────────────────────────────────── */

export function queuePage(player: GuildPlayer, page = 1): { position: number; song: Song }[] {
  const pages = queuePageCount(player);
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * QUEUE_PAGE_SIZE;
  return player.queue
    .slice(start, start + QUEUE_PAGE_SIZE)
    .map((song, index) => ({ position: start + index + 1, song }));
}

export function queueEmbed(player: GuildPlayer, page = 1): EmbedBuilder {
  const total = player.queue.length;
  const pages = queuePageCount(player);
  const current = Math.min(Math.max(1, page), pages);
  const slice = queuePage(player, current);

  const now = player.current
    ? `${player.paused ? "⏸" : "▶"}  **[${escapeMd(player.current.title)}](${player.current.url})** \`${formatDuration(player.playbackPositionMs)} / ${formatDuration(player.current.durationMs)}\` · ${mention(player.current.requestedBy)}`
    : "*No hay nada sonando.*";

  const upcoming = slice.map(({ position, song }) => {
    const n = String(position).padStart(2, " ");
    return `\`${n}.\` [${escapeMd(song.title)}](${song.url}) \`${formatDuration(song.durationMs)}\` · ${mention(song.requestedBy)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(BEMOL_COLOR)
    .setAuthor({ name: `📃  Cola de ${player.guildName}` })
    .setDescription(
      [
        "**Sonando ahora**",
        now,
        "",
        "**A continuación**",
        ...(upcoming.length ? upcoming : ["*La cola está vacía. Añade algo con **➕ Añadir** o `/play`.*"]),
      ].join("\n"),
    )
    .setFooter({
      text: [
        pages > 1 ? `Página ${current}/${pages}` : null,
        `${total} ${total === 1 ? "canción" : "canciones"} en cola`,
        total ? `${formatDurationWords(player.queueDurationMs)} restantes` : null,
        `Repetir: ${LOOP_LABEL[player.loop]}`,
        `Volumen: ${player.volumePercent}%`,
      ]
        .filter((part) => part !== null)
        .join("  ·  "),
    });

  if (player.current) {
    const art = artworkUrl(player.current);
    if (art) embed.setThumbnail(art);
  }
  return embed;
}

export function queuePageCount(player: GuildPlayer): number {
  return Math.max(1, Math.ceil(player.queue.length / QUEUE_PAGE_SIZE));
}

/* ──────────────────────────────── Búsqueda ──────────────────────────────── */

export function searchEmbed(songs: Song[], query: string): EmbedBuilder {
  const lines = songs.map((song, index) => {
    return `**${index + 1}.** [${escapeMd(song.title)}](${song.url}) \`${formatDuration(song.durationMs)}\`\n　　*${escapeMd(song.author)}*`;
  });
  const embed = new EmbedBuilder()
    .setColor(BEMOL_COLOR)
    .setAuthor({ name: "🔎  Resultados de búsqueda" })
    .setTitle(`«${query.slice(0, 80)}»`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Elige una canción en el menú de abajo · el menú caduca en 60 s" });
  const art = songs[0] ? artworkUrl(songs[0]) : null;
  if (art) embed.setThumbnail(art);
  return embed;
}

export function searchResolvedEmbed(query: string, chosen: Song | null): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(MUTED_COLOR)
    .setAuthor({ name: "🔎  Búsqueda" })
    .setTitle(`«${query.slice(0, 80)}»`)
    .setDescription(
      chosen
        ? `Elegiste **[${escapeMd(chosen.title)}](${chosen.url})**.`
        : "Esta búsqueda caducó. Vuelve a usar `/buscar` si quieres elegir otra.",
    );
}

/* ───────────────────────────────── Ayuda ───────────────────────────────── */

export function helpEmbed(wakeWord: string): EmbedBuilder {
  const w = wakeWord;
  const embed = new EmbedBuilder()
    .setColor(BEMOL_COLOR)
    .setAuthor({ name: "🎵  Bemol · bot de música" })
    .setDescription(
      [
        `Pongo música de YouTube en tu canal de voz. Puedes usar **slash commands**, hablarme en el chat empezando por **${w}** o mencionándome (**@${w} pon ...**), o usar los **botones del panel** que aparece al reproducir.`,
        "",
        "**Para empezar:** métete a un canal de voz y escribe `/play` con una canción, un artista o un enlace.",
      ].join("\n"),
    )
    .addFields(
      {
        name: "▶  Poner música",
        value: [
          "`/play canción o enlace` · `/add` — YouTube, Spotify, Deezer, SoundCloud, Tidal o URL de audio",
          "`/buscar salsa` — busca y elige entre varios resultados",
          `\`${w} pon ...\` · \`${w} añade ...\` · \`${w} busca ...\``,
          "Pegar un enlace también funciona, incluidas playlists y álbumes de Spotify o Deezer",
          "`/radio lista` · `/radio buscar salsa` · `/radio poner Groove Salad` — emisoras en directo",
          "`/radio 247 emisora:...` — deja una emisora de fondo cuando no hay cola",
        ].join("\n"),
      },
      {
        name: "⏯  Controlar",
        value: [
          "`/skip` `/pausa` `/seguir` `/stop` `/mezclar`",
          "`/repetir` (no · canción · cola) · `/volumen 80`",
          `\`${w} skip\` · \`${w} pausa\` · \`${w} sigue\` · \`${w} para\` · \`${w} volumen 50\``,
        ].join("\n"),
      },
      {
        name: "📃  Cola",
        value: [
          "`/cola` — ver la cola y quitar canciones desde el menú",
          "`/sonando` — vuelve a mostrar el panel",
          "`/quitar 3` · `/limpiar`",
          `\`${w} cola\` · \`${w} qué suena\` · \`${w} quita 3\` · \`${w} limpia\``,
        ].join("\n"),
      },
      {
        name: "🔊  Canal de voz",
        value: `\`/unirme\` · \`/salir\` · \`${w} ven\` · \`${w} salte\``,
      },
      {
        name: "🎧  Tu biblioteca (en cualquier servidor)",
        value: [
          "`/playlist crear` · `añadir` · `ver` · `reproducir` · `quitar` · `eliminar` · `compartir` · `lista`",
          "`/like` y el botón **❤️ Me gusta** del panel guardan en favoritas · `/favoritos ver` · `reproducir`",
          "Botón **📋 A playlist** del panel: guarda la que suena o toda la cola (un álbum entero, por ejemplo)",
          "También **💾** en `/buscar` y **Guardar como playlist** en la vista de cola",
        ].join("\n"),
      },
      {
        name: "⚙️  Servidor",
        value: [
          "`/config` — DJs, volumen inicial, 24/7, auto-desconexión, votación para saltar, autoplay, canal de música",
          "Clic derecho en un mensaje → **Apps → Añadir a Bemol** para poner lo que contenga",
          "Con varios oyentes, `/skip` abre una votación; los DJ saltan al instante",
        ].join("\n"),
      },
    );

  const legal = [
    config.privacyUrl ? `[Política de privacidad](${config.privacyUrl})` : null,
    config.termsUrl ? `[Términos de uso](${config.termsUrl})` : null,
    config.supportUrl ? `[Soporte](${config.supportUrl})` : null,
  ].filter((link) => link !== null);
  if (legal.length) {
    embed.addFields({ name: "ℹ️  Acerca de Bemol", value: `${legal.join(" · ")}\nSolo guardo lo que creas a propósito (playlists, favoritos y la configuración del servidor); puedes borrarlo cuando quieras.` });
  }

  return embed.setFooter({
      text: config.musicChannelId
        ? "En el canal de música puedes escribir pon / skip / cola sin decir mi nombre."
        : "Escribe solo mi nombre y te enseño esta ayuda.",
    });
}

/* ────────────────────────────── Mensajes cortos ────────────────────────────── */

export function infoEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setColor(BEMOL_COLOR).setDescription(text);
}

export function okEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setColor(OK_COLOR).setDescription(`✅  ${text}`);
}

export function errorEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`⚠️  ${text}`);
}

/* ──────────────────────────────── Helpers ──────────────────────────────── */

/**
 * De dónde sale el audio, solo cuando no es lo evidente: SoundCloud, o una
 * canción que se pidió desde otra plataforma y se encontró en YouTube.
 */
function sourceLine(song: Song): string | null {
  if (song.kind === "stream") return null;
  if (song.kind === "soundcloud") return "**Fuente** SoundCloud";
  return song.via ? `**Fuente** YouTube · vía ${escapeMd(song.via)}` : null;
}

function queueSummary(player: GuildPlayer): string {
  const n = player.queue.length;
  if (n === 0) return "nada más";
  const label = n === 1 ? "canción" : "canciones";
  return `${n} ${label} · ${formatDurationWords(player.queueDurationMs)}`;
}

function statusLine(player: GuildPlayer, extra?: string): string {
  return [`Repetir: ${LOOP_LABEL[player.loop]}`, `Volumen: ${player.volumePercent}%`, extra ?? null]
    .filter((part) => part !== null)
    .join("  ·  ");
}

function mention(user: { id: string; name: string }): string {
  return user.id ? `<@${user.id}>` : user.name;
}

/**
 * Prepara un título para ir dentro de markdown (incluido el texto de un
 * enlace). Los corchetes se cambian por paréntesis porque, escapados, Discord
 * muestra la barra invertida dentro de los enlaces.
 */
function escapeMd(value: string): string {
  return value
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/([*_`~\\])/g, "\\$1")
    .slice(0, 200);
}

function field(name: string, value: string, inline = false): APIEmbedField {
  return { name, value: value.slice(0, 1024) || "-", inline };
}
