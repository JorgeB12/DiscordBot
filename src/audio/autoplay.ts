import { config } from "../config.js";
import type { Song } from "./musicPlayer.js";
import { ytDlpJson } from "./ytdlp.js";

/**
 * Autoplay: cuando la cola se vacía, seguimos con canciones parecidas a la
 * última. Usamos el "mix" que YouTube genera para cada vídeo (lista RD…),
 * que ya viene ordenado por afinidad y no necesita ninguna API de pago.
 */

type Entry = { id?: string; title?: string; url?: string; duration?: number; uploader?: string; channel?: string; thumbnails?: { url: string }[] };

export async function relatedSongs(seed: Song, exclude: Set<string>, limit = 5): Promise<Omit<Song, "requestedBy">[]> {
  const videoId = seed.id.match(/^[\w-]{11}$/)?.[0];
  if (!videoId) return [];
  const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
  let raw: unknown;
  try {
    raw = await ytDlpJson(mixUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      skipDownload: true,
      noWarnings: true,
      noCheckCertificates: true,
      playlistEnd: 25,
      ...(config.youtubeCookies ? { cookies: config.youtubeCookies } : {}),
    });
  } catch (error) {
    console.warn("[autoplay] no pude leer el mix de YouTube:", error instanceof Error ? error.message : error);
    return [];
  }
  const body = raw as { entries?: Entry[] };
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const picks: Omit<Song, "requestedBy">[] = [];
  for (const entry of entries) {
    const id = entry.id ?? "";
    if (!id || id === videoId || exclude.has(id)) continue;
    const duration = (entry.duration ?? 0) * 1000;
    if (duration && (duration < 45_000 || duration > 15 * 60_000)) continue;
    picks.push({
      id,
      title: entry.title ?? id,
      url: `https://www.youtube.com/watch?v=${id}`,
      durationMs: duration,
      thumbnail: entry.thumbnails?.[0]?.url ?? null,
      author: entry.uploader ?? entry.channel ?? "YouTube",
    });
    if (picks.length >= limit) break;
  }
  return picks;
}
