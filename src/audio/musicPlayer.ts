import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";
import prism from "prism-media";
import { YouTube, type Video } from "youtube-sr";
import { candidateFromVideo, pickBestAudioTracks, type AudioCandidate } from "./audioPick.js";
import { config } from "../config.js";
import { ensureFfmpegOnPath, ytdlpPath } from "./ffmpeg.js";
import { ytDlpJson, type YtDlpFlags } from "./ytdlp.js";

export type Requester = {
  id: string;
  name: string;
  avatarUrl?: string;
};

export type Song = {
  id: string;
  title: string;
  url: string;
  durationMs: number;
  thumbnail: string | null;
  author: string;
  requestedBy: Requester;
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

export async function resolveTracks(
  query: string,
  requestedBy: Requester,
): Promise<{ songs: Song[]; playlistTitle?: string }> {
  const trimmed = query.trim();
  const url = extractYoutubeUrl(trimmed);
  const rest = url ? trimmed.replace(url, "").trim() : trimmed;

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

export function createTrackStream(song: Song, volume: number): TrackStream {
  ensureFfmpegOnPath();
  const ytdlp = spawn(ytdlpPath(), ytdlpArgs(song.url), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (!ytdlp.stdout) {
    ytdlp.kill();
    throw new Error("No pude iniciar yt-dlp.");
  }

  const ffmpeg = new prism.FFmpeg({
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-analyzeduration",
      "0",
      "-i",
      "-",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
    ],
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
