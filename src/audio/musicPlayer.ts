import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";
import prism from "prism-media";
import { YouTube, type Video } from "youtube-sr";
import { candidateFromVideo, pickBestAudioTracks, type AudioCandidate } from "./audioPick.js";
import { config } from "../config.js";
import { externalKind, resolveExternal, type ExternalTrack } from "./external.js";
import { ensureFfmpegOnPath, networkFfmpegPath, ytdlpPath } from "./ffmpeg.js";
import { ytDlpJson, type YtDlpFlags } from "./ytdlp.js";

export type Requester = {
  id: string;
  name: string;
  avatarUrl?: string;
};

export type SongKind = "youtube" | "soundcloud" | "stream";

export type Song = {
  id: string;
  title: string;
  url: string;
  durationMs: number;
  thumbnail: string | null;
  author: string;
  requestedBy: Requester;
  /** De dónde sale el audio. Sin valor = YouTube. "stream" = radio o URL de audio directa. */
  kind?: SongKind;
  /** Plataforma desde la que se pidió, si el audio se buscó en YouTube (Spotify, Deezer…). */
  via?: string;
};

export type ResolvedTracks = {
  songs: Song[];
  playlistTitle?: string;
  /** Resto de una lista externa (Spotify, Deezer…) que se resuelve en segundo plano por lotes. */
  pending?: AsyncGenerator<Song[]>;
  pendingCount?: number;
};

export type TrackStream = {
  resource: AudioResource;
  destroy: () => void;
};

const GENERIC = /^(la\s+)?(musica|música|cancion|canción|tema|algo|playlist|lista)(\s+por\s+favor)?$/i;
const YOUTUBE_URL =
  /https?:\/\/(?:www\.|music\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s<>]+/i;
const MAX_PLAYLIST = 100;

export function extractYoutubeUrl(text: string): string | null {
  const match = text.match(YOUTUBE_URL);
  return match?.[0]?.replace(/[),.;]+$/, "") ?? null;
}

export function isPlaylistUrl(url: string): boolean {
  if (YouTube.isPlaylist(url)) return true;
  try {
    const parsed = new URL(url);
    const list = parsed.searchParams.get("list");
    return Boolean(list && /^(PL|OL|RD|UU|FL)/i.test(list));
  } catch {
    return false;
  }
}

const SOUNDCLOUD_URL = /https?:\/\/(?:www\.|m\.|on\.)?soundcloud\.com\/[^\s<>]+/i;
const ANY_URL = /https?:\/\/[^\s<>]+/i;
const STREAM_HINT = /\.(mp3|aac|ogg|opus|m4a|flac|wav|m3u8?|pls)(\?|$)|\/stream\b|icecast|shoutcast|radio|\/live\b|:8\d{3}\//i;

export async function resolveTracks(query: string, requestedBy: Requester): Promise<ResolvedTracks> {
  const trimmed = query.trim();
  const url = extractYoutubeUrl(trimmed);
  const rest = url ? trimmed.replace(url, "").trim() : trimmed;

  if (!url) {
    const other = trimmed.match(ANY_URL)?.[0]?.replace(/[),.;]+$/, "");
    if (other) return resolveOtherUrl(other, requestedBy);
  }

  if (!url && (!rest || GENERIC.test(rest))) {
    throw new Error("Dime el nombre de la canción, el artista o pega el enlace de YouTube.");
  }

  if (url && isPlaylistUrl(url)) {
    const { songs, title } = await loadPlaylist(url, requestedBy);
    if (!songs.length) {
      throw new Error("Esa playlist está vacía o no pude leerla.");
    }
    return { songs, playlistTitle: title };
  }

  if (url) {
    const song = await loadVideo(url, requestedBy);
    return { songs: [song] };
  }

  const songs = await searchTracks(rest, requestedBy, 1);
  if (!songs[0]) {
    throw new Error(`No encontré nada para "${rest}".`);
  }
  return { songs: [songs[0]] };
}

/* ───────────── Otras fuentes: Spotify/Deezer/Tidal, SoundCloud, streams ───────────── */

const IMPORT_FIRST = 3;
const IMPORT_BATCH = 5;

async function resolveOtherUrl(url: string, requestedBy: Requester): Promise<ResolvedTracks> {
  if (externalKind(url)) {
    const list = await resolveExternal(url);
    if (!list.tracks.length) throw new Error(`Esa lista de ${list.source} está vacía.`);
    const first = await matchMany(list.tracks.slice(0, IMPORT_FIRST), requestedBy, list.source);
    if (!first.length) throw new Error(`No encontré en YouTube ninguna canción de esa lista de ${list.source}.`);
    const remaining = list.tracks.slice(IMPORT_FIRST);
    const title = list.tracks.length > 1 ? `${list.title} (${list.source})` : undefined;
    return {
      songs: first,
      playlistTitle: title,
      pending: remaining.length ? importInBatches(remaining, requestedBy, list.source) : undefined,
      pendingCount: remaining.length,
    };
  }

  if (SOUNDCLOUD_URL.test(url)) {
    const raw = await ytDlpJson(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noCheckCertificates: true,
      flatPlaylist: true,
      playlistEnd: MAX_PLAYLIST,
    });
    const body = raw as { title?: string; entries?: YtDlpEntry[] } & YtDlpEntry;
    const entries = Array.isArray(body.entries) ? body.entries : [body];
    const songs = entries
      .map((entry) => songFromYtDlp(entry, requestedBy))
      .filter((song): song is Song => song !== null)
      .map((song) => ({ ...song, kind: "soundcloud" as const }));
    if (!songs.length) throw new Error("No pude leer ese enlace de SoundCloud.");
    return { songs, playlistTitle: entries.length > 1 ? body.title : undefined };
  }

  if (STREAM_HINT.test(url)) return { songs: [streamSong(url, requestedBy)] };

  // Página desconocida: probamos con yt-dlp (Bandcamp, Vimeo, etc.); si no, la tratamos como audio directo.
  try {
    const raw = await ytDlpJson(url, { dumpSingleJson: true, skipDownload: true, noWarnings: true, noCheckCertificates: true, noPlaylist: true });
    const song = songFromYtDlp(raw as YtDlpEntry, requestedBy, url);
    if (song) return { songs: [{ ...song, kind: "soundcloud" }] };
  } catch {
    // seguimos con el stream directo
  }
  return { songs: [streamSong(url, requestedBy)] };
}

export function streamSong(url: string, requestedBy: Requester, name?: string, extra: Partial<Song> = {}): Song {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // URL rara: dejamos el texto tal cual
  }
  return {
    id: `stream:${url}`,
    title: name ?? host,
    url,
    durationMs: 0,
    thumbnail: null,
    author: name ? host : "En directo",
    requestedBy,
    kind: "stream",
    ...extra,
  };
}

export async function* importInBatches(tracks: ExternalTrack[], requestedBy: Requester, via: string): AsyncGenerator<Song[]> {
  for (let i = 0; i < tracks.length; i += IMPORT_BATCH) {
    const batch = await matchMany(tracks.slice(i, i + IMPORT_BATCH), requestedBy, via);
    if (batch.length) yield batch;
  }
}

async function matchMany(tracks: ExternalTrack[], requestedBy: Requester, via: string): Promise<Song[]> {
  const results = await Promise.all(tracks.map((track) => matchOnYoutube(track, requestedBy).catch(() => null)));
  return results.filter((song): song is Song => song !== null).map((song) => ({ ...song, via }));
}

/** Encuentra en YouTube la versión de audio de una canción descrita por título y artista. */
export async function matchOnYoutube(track: ExternalTrack, requestedBy: Requester): Promise<Song | null> {
  if (track.youtubeUrl) {
    try {
      return await loadVideo(track.youtubeUrl, requestedBy);
    } catch {
      // seguimos por búsqueda
    }
  }
  const query = `${track.artist} ${track.title}`.trim();
  const videos = await YouTube.search(`${query} audio`, { limit: 8, type: "video" }).catch(() => [] as Video[]);
  let candidates = videos.map(candidateFromVideo).filter((item): item is AudioCandidate => item !== null);
  if (track.durationMs > 0) {
    const close = candidates.filter((item) => !item.durationMs || Math.abs(item.durationMs - track.durationMs) < Math.max(15_000, track.durationMs * 0.12));
    if (close.length) candidates = close;
  }
  const best = pickBestAudioTracks(candidates, 1, `${track.title} ${track.artist}`)[0];
  return best ? songFromCandidate(best, requestedBy) : null;
}

export async function searchTracks(
  query: string,
  requestedBy: Requester,
  limit = 5,
): Promise<Song[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const candidates: AudioCandidate[] = [];

  try {
    const videos = await gatherYoutubeResults(trimmed);
    for (const video of videos) {
      const candidate = candidateFromVideo(video);
      if (candidate) candidates.push(candidate);
    }
  } catch (error) {
    console.warn("[music] youtube-sr search failed", error);
  }

  const ytdlpCandidates = await searchCandidatesWithYtDlp(trimmed, Math.max(limit * 3, 10));
  candidates.push(...ytdlpCandidates);

  const best = pickBestAudioTracks(candidates, limit, trimmed);
  if (best.length) {
    console.log(
      `[music] búsqueda "${trimmed}" → ${best
        .slice(0, 3)
        .map((item) => `${item.title} [${item.author}]`)
        .join(" | ")}`,
    );
    return best.map((item) => songFromCandidate(item, requestedBy));
  }

  return [];
}

async function loadVideo(url: string, requestedBy: Requester): Promise<Song> {
  const video = await YouTube.getVideo(url).catch(() => null);
  if (video?.url) return songFromVideo(video, requestedBy);

  const raw = await ytDlpJson(url, {
    dumpSingleJson: true,
    skipDownload: true,
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    ...cookieFlags(),
  });
  const payload = raw as YtDlpEntry;
  const song = songFromYtDlp(payload, requestedBy, url);
  if (!song) throw new Error("No pude leer esa canción de YouTube.");
  return song;
}

async function loadPlaylist(
  url: string,
  requestedBy: Requester,
): Promise<{ songs: Song[]; title?: string }> {
  try {
    const playlist = await YouTube.getPlaylist(url, { fetchAll: true, limit: MAX_PLAYLIST });
    await playlist.fetch(MAX_PLAYLIST);
    const songs = playlist.videos
      .filter((video) => Boolean(video.url) && !video.private && !video.live)
      .slice(0, MAX_PLAYLIST)
      .map((video) => songFromVideo(video, requestedBy));
    if (songs.length) return { songs, title: playlist.title };
  } catch (error) {
    console.warn("[music] youtube-sr playlist failed, trying yt-dlp", error);
  }

  return loadPlaylistWithYtDlp(url, requestedBy);
}

async function loadPlaylistWithYtDlp(
  url: string,
  requestedBy: Requester,
): Promise<{ songs: Song[]; title?: string }> {
  const raw = await ytDlpJson(url, {
    dumpSingleJson: true,
    flatPlaylist: true,
    skipDownload: true,
    noWarnings: true,
    noCheckCertificates: true,
    playlistEnd: MAX_PLAYLIST,
    ...cookieFlags(),
  });

  const body = raw as { title?: string; entries?: YtDlpEntry[] };
  const entries = Array.isArray(raw) ? raw : Array.isArray(body.entries) ? body.entries : [];

  const songs = entries
    .map((entry) => songFromYtDlp(entry, requestedBy))
    .filter((song): song is Song => song !== null)
    .slice(0, MAX_PLAYLIST);

  return { songs, title: body.title };
}

async function gatherYoutubeResults(query: string): Promise<Video[]> {
  const fetchLimit = 12;
  // Varias búsquedas en paralelo para que entre los candidatos haya siempre
  // versiones de audio (canal "Topic", "Official Audio", "Audio Oficial") y no
  // solo el videoclip que YouTube pone primero.
  const [main, audio, audioEs, topic] = await Promise.all([
    YouTube.search(query, { limit: fetchLimit, type: "video" }).catch(() => [] as Video[]),
    YouTube.search(`${query} official audio`, { limit: 8, type: "video" }).catch(() => [] as Video[]),
    YouTube.search(`${query} audio oficial`, { limit: 6, type: "video" }).catch(() => [] as Video[]),
    YouTube.search(`${query} topic`, { limit: 6, type: "video" }).catch(() => [] as Video[]),
  ]);

  const seen = new Set<string>();
  const merged: Video[] = [];
  for (const video of [...audio, ...audioEs, ...topic, ...main]) {
    const key = video.id ?? video.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(video);
  }
  return merged;
}

async function searchCandidatesWithYtDlp(query: string, limit: number): Promise<AudioCandidate[]> {
  try {
    const raw = await ytDlpJson(`ytsearch${limit}:${query}`, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noCheckCertificates: true,
      flatPlaylist: true,
      ...cookieFlags(),
    });
    const body = raw as { entries?: YtDlpEntry[] };
    const entries = Array.isArray(body.entries) ? body.entries : [raw as YtDlpEntry];
    return entries
      .map((entry) => candidateFromYtDlp(entry))
      .filter((item): item is AudioCandidate => item !== null);
  } catch (error) {
    console.warn("[music] yt-dlp search failed", error);
    return [];
  }
}

/** Filtros de audio de ffmpeg: normalización de sonoridad entre canciones y fuentes. */
function audioFilters(song: Song): string[] {
  if (!config.audioNormalize) return [];
  // loudnorm en una pasada actúa como normalizador dinámico; -14 LUFS es el
  // objetivo habitual de las plataformas de streaming. En radios lo aplicamos igual.
  void song;
  return ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"];
}

const PCM_OUT = ["-f", "s16le", "-ar", "48000", "-ac", "2"];

export function createTrackStream(song: Song, volume: number): TrackStream {
  ensureFfmpegOnPath();
  if (song.kind === "stream") return createDirectStream(song, volume);

  const ytdlp = spawn(ytdlpPath(), ytdlpArgs(song.url), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (!ytdlp.stdout) {
    ytdlp.kill();
    throw new Error("No pude iniciar yt-dlp.");
  }

  const ffmpeg = new prism.FFmpeg({
    args: ["-hide_banner", "-loglevel", "error", "-analyzeduration", "0", "-i", "-", ...audioFilters(song), ...PCM_OUT],
  });

  ytdlp.stdout.pipe(ffmpeg);

  // En máquinas de un solo núcleo, que el envío de paquetes de voz (este
  // proceso) tenga prioridad sobre la descarga y la decodificación.
  lowerPriority(ytdlp.pid);
  lowerPriority(ffmpeg.process?.pid);

  ytdlp.on("exit", (code) => {
    if (code && code !== 0) {
      try {
        ffmpeg.destroy();
      } catch {
        // already gone
      }
    }
  });
  ytdlp.stdout.on("error", (error) => {
    if (!isBenignPipeError(error)) console.error("[music] ytdlp stdout", error);
  });
  ffmpeg.on("error", (error) => {
    if (!isBenignPipeError(error)) console.error("[music] ffmpeg", error);
  });
  ytdlp.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.warn("[yt-dlp]", text.slice(0, 400));
  });

  const resource = createAudioResource(ffmpeg, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: song,
  });
  resource.volume?.setVolume(Math.min(1.5, Math.max(0, volume)));

  // Calidad de salida: por defecto el codificador Opus queda en bitrate
  // automático (~64 kbps). Subimos a 128 kbps, que es lo que emiten los bots
  // de música habituales, y activamos FEC para que cortes pequeños de red no
  // se noten.
  resource.encoder?.setBitrate(config.opusBitrateKbps * 1000);
  resource.encoder?.setFEC(config.opusFec);
  resource.encoder?.setPLP(config.opusFec ? 0.05 : 0);

  return {
    resource,
    destroy: () => killStream(ytdlp, ffmpeg),
  };
}

/** Radios y URLs de audio directas: ffmpeg lee la URL él mismo, con reconexión automática. */
function createDirectStream(song: Song, volume: number): TrackStream {
  const ffmpeg = spawn(
    networkFfmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-user_agent",
      "Bemol-Discord-Bot/2.0",
      "-i",
      song.url,
      ...audioFilters(song),
      ...PCM_OUT,
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  if (!ffmpeg.stdout) {
    ffmpeg.kill();
    throw new Error("No pude iniciar ffmpeg para el stream.");
  }
  lowerPriority(ffmpeg.pid);
  ffmpeg.on("error", (error) => {
    if (!isBenignPipeError(error)) console.error("[music] ffmpeg (stream)", error);
  });
  ffmpeg.stdout.on("error", (error) => {
    if (!isBenignPipeError(error)) console.error("[music] ffmpeg stdout", error);
  });
  ffmpeg.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.warn("[ffmpeg]", text.slice(0, 300));
  });

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: song });
  resource.volume?.setVolume(Math.min(1.5, Math.max(0, volume)));
  resource.encoder?.setBitrate(config.opusBitrateKbps * 1000);
  resource.encoder?.setFEC(config.opusFec);
  resource.encoder?.setPLP(config.opusFec ? 0.05 : 0);

  return {
    resource,
    destroy: () => {
      if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
    },
  };
}

function lowerPriority(pid: number | undefined): void {
  if (!pid) return;
  try {
    os.setPriority(pid, 10);
  } catch {
    // Sin permisos o proceso ya terminado: no es grave.
  }
}

function ytdlpArgs(url: string): string[] {
  const args = [
    url,
    "-o",
    "-",
    "-f",
    "bestaudio[ext=webm][acodec=opus]/bestaudio/best",
    "-q",
    "--no-warnings",
    "--no-playlist",
    "--no-check-certificates",
    "--prefer-free-formats",
    "--add-header",
    "referer:youtube.com",
    // YouTube exige resolver retos en JavaScript (firma y parámetro "n").
    // yt-dlp solo busca Deno por defecto; le decimos que use Node, que ya tenemos.
    "--js-runtimes",
    "node",
  ];
  if (config.youtubeCookies) {
    args.push("--cookies", config.youtubeCookies);
  }
  return args;
}

export function artworkUrl(song: Song): string | null {
  if (song.kind && song.kind !== "youtube") return song.thumbnail;
  const id = song.id.match(/[\w-]{11}/)?.[0];
  if (id && !id.includes("http")) {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  return song.thumbnail;
}

function cookieFlags(): Pick<YtDlpFlags, "cookies"> {
  return config.youtubeCookies ? { cookies: config.youtubeCookies } : {};
}

function songFromVideo(video: Video, requestedBy: Requester): Song {
  const candidate = candidateFromVideo(video);
  if (!candidate) throw new Error("Video inválido.");
  return songFromCandidate(candidate, requestedBy);
}

function songFromCandidate(candidate: AudioCandidate, requestedBy: Requester): Song {
  return {
    id: candidate.id,
    title: candidate.title,
    url: candidate.url,
    durationMs: candidate.durationMs,
    thumbnail: candidate.thumbnail,
    author: candidate.author,
    requestedBy,
  };
}

function candidateFromYtDlp(entry: YtDlpEntry): AudioCandidate | null {
  const url =
    entry.url && /^https?:/i.test(entry.url)
      ? entry.url
      : entry.webpage_url && /^https?:/i.test(entry.webpage_url)
        ? entry.webpage_url
        : entry.id
          ? `https://www.youtube.com/watch?v=${entry.id}`
          : null;
  if (!url) return null;

  const duration = Number(entry.duration ?? 0);
  return {
    id: String(entry.id || url),
    title: entry.title || url,
    url,
    durationMs: duration > 0 && duration < 100_000 ? duration * 1000 : duration,
    thumbnail: entry.thumbnail ?? null,
    author: entry.channel || entry.uploader || "YouTube",
  };
}

function songFromYtDlp(
  entry: YtDlpEntry | undefined,
  requestedBy: Requester,
  fallbackUrl?: string,
): Song | null {
  const candidate = entry ? candidateFromYtDlp(entry) : null;
  if (!candidate && fallbackUrl) {
    return {
      id: fallbackUrl,
      title: fallbackUrl,
      url: fallbackUrl,
      durationMs: 0,
      thumbnail: null,
      author: "YouTube",
      requestedBy,
    };
  }
  if (!candidate) return null;
  return songFromCandidate(candidate, requestedBy);
}

function killStream(ytdlp: ChildProcess, ffmpeg: InstanceType<typeof prism.FFmpeg>): void {
  try {
    ytdlp.stdout?.unpipe(ffmpeg);
  } catch {
    // already closed
  }
  try {
    if (!ytdlp.killed) ytdlp.kill("SIGKILL");
  } catch {
    // already gone
  }
  try {
    ffmpeg.destroy();
  } catch {
    // already gone
  }
}

function isBenignPipeError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE";
}

type YtDlpEntry = {
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  duration?: number;
  thumbnail?: string;
  channel?: string;
  uploader?: string;
};
