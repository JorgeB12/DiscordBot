import { config } from "../config.js";

/**
 * Resolución de enlaces de otras plataformas (Spotify, Deezer, Tidal…).
 * Ninguna de ellas entrega audio: solo sacamos título, artista y duración, y
 * luego buscamos esa canción en YouTube.
 */

export type ExternalTrack = {
  title: string;
  artist: string;
  durationMs: number;
  /** Enlace directo a YouTube si la plataforma lo conoce. */
  youtubeUrl?: string;
};

export type ExternalList = {
  title: string;
  source: string;
  tracks: ExternalTrack[];
};

export type ExternalKind = "spotify" | "deezer" | "tidal" | "other";

const FETCH_TIMEOUT_MS = 12_000;

export function externalKind(url: string): ExternalKind | null {
  if (/(open\.)?spotify\.(com|link)\//i.test(url)) return "spotify";
  if (/deezer\.(com|page\.link)\//i.test(url)) return "deezer";
  if (/(listen\.)?tidal\.com\//i.test(url)) return "tidal";
  return null;
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} en ${new URL(url).host}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Sigue redirecciones de enlaces cortos (spotify.link, deezer.page.link). */
async function expandShortLink(url: string): Promise<string> {
  if (!/spotify\.link|deezer\.page\.link/i.test(url)) return url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    return response.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────────── Spotify ───────────────────────────── */

let spotifyToken: { value: string; expiresAt: number } | null = null;

async function spotifyAccessToken(): Promise<string | null> {
  if (!config.spotifyClientId || !config.spotifyClientSecret) return null;
  if (spotifyToken && spotifyToken.expiresAt > Date.now() + 30_000) return spotifyToken.value;
  const basic = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString("base64");
  const data = await getJson<{ access_token: string; expires_in: number }>("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  spotifyToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return spotifyToken.value;
}

type SpotifyTrack = { name: string; artists: { name: string }[]; duration_ms: number; is_local?: boolean } | null;

function spotifyTrack(track: SpotifyTrack): ExternalTrack | null {
  if (!track || track.is_local || !track.name) return null;
  return { title: track.name, artist: track.artists.map((artist) => artist.name).join(", "), durationMs: track.duration_ms };
}

async function resolveSpotify(url: string): Promise<ExternalList> {
  const expanded = await expandShortLink(url);
  const match = expanded.match(/spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i);
  if (!match) throw new Error("No reconozco ese enlace de Spotify (vale un track, un álbum o una playlist).");
  const [, type, id] = match;

  const kind = type as "track" | "album" | "playlist";

  // Con credenciales usamos la API oficial, que trae las listas completas. Si
  // falla (la Web API exige que la cuenta dueña de la app tenga Premium, y
  // puede caducar o cambiar), seguimos con la página pública.
  let token: string | null = null;
  try {
    token = await spotifyAccessToken();
  } catch (error) {
    console.warn("[spotify] no pude pedir el token:", error instanceof Error ? error.message : error);
  }
  if (token) {
    try {
      return await resolveSpotifyApi(kind, id!, token);
    } catch (error) {
      console.warn("[spotify] la API falló, uso la página pública:", error instanceof Error ? error.message : error);
    }
  }
  return resolveSpotifyEmbed(kind, id!);
}

async function resolveSpotifyApi(type: "track" | "album" | "playlist", id: string, token: string): Promise<ExternalList> {
  const headers = { Authorization: `Bearer ${token}` };
  const api = "https://api.spotify.com/v1";

  if (type === "track") {
    const data = await getJson<NonNullable<SpotifyTrack>>(`${api}/tracks/${id}`, { headers });
    const track = spotifyTrack(data);
    if (!track) throw new Error("Esa canción de Spotify no está disponible.");
    return { title: track.title, source: "Spotify", tracks: [track] };
  }

  if (type === "album") {
    const album = await getJson<{ name: string; tracks: { items: NonNullable<SpotifyTrack>[]; next: string | null } }>(
      `${api}/albums/${id}?market=US`,
      { headers },
    );
    const items = [...album.tracks.items];
    let next = album.tracks.next;
    while (next && items.length < config.maxQueue) {
      const page = await getJson<{ items: NonNullable<SpotifyTrack>[]; next: string | null }>(next, { headers });
      items.push(...page.items);
      next = page.next;
    }
    return { title: album.name, source: "Spotify", tracks: items.map(spotifyTrack).filter((t): t is ExternalTrack => t !== null) };
  }

  const playlist = await getJson<{ name: string }>(`${api}/playlists/${id}?fields=name`, { headers });
  const tracks: ExternalTrack[] = [];
  let next: string | null = `${api}/playlists/${id}/tracks?limit=100&fields=next,items(track(name,artists(name),duration_ms,is_local))`;
  while (next && tracks.length < config.maxQueue) {
    const page: { items: { track: SpotifyTrack }[]; next: string | null } = await getJson(next, { headers });
    for (const item of page.items) {
      const track = spotifyTrack(item.track);
      if (track) tracks.push(track);
    }
    next = page.next;
  }
  return { title: playlist.name, source: "Spotify", tracks };
}

/**
 * Sin credenciales de la API: la página pública "embed" de Spotify lleva un
 * JSON con la canción, o con las primeras ~50 de un álbum o playlist. Es la
 * misma información que ve cualquiera en el navegador.
 */
async function resolveSpotifyEmbed(type: "track" | "album" | "playlist", id: string): Promise<ExternalList> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const response = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "es,en;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Spotify respondió ${response.status}`);
    html = await response.text();
  } finally {
    clearTimeout(timer);
  }

  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!json) throw new Error("No pude leer ese enlace de Spotify.");
  const data = JSON.parse(json) as unknown;

  type EmbedEntity = {
    type?: string;
    name?: string;
    title?: string;
    duration?: number;
    artists?: { name: string }[];
    subtitle?: string;
    trackList?: { title?: string; subtitle?: string; duration?: number }[];
  };
  const entity = findObject(data, (value): value is EmbedEntity => {
    const candidate = value as EmbedEntity;
    return typeof candidate.title === "string" && (Array.isArray(candidate.trackList) || Array.isArray(candidate.artists));
  });
  if (!entity) throw new Error("No pude leer ese enlace de Spotify.");

  if (type === "track") {
    const track: ExternalTrack = {
      title: entity.title ?? entity.name ?? "",
      artist: entity.artists?.map((artist) => artist.name).join(", ") ?? entity.subtitle ?? "",
      durationMs: entity.duration ?? 0,
    };
    if (!track.title) throw new Error("Esa canción de Spotify no está disponible.");
    return { title: track.title, source: "Spotify", tracks: [track] };
  }

  const tracks: ExternalTrack[] = (entity.trackList ?? [])
    .filter((item) => item.title)
    .map((item) => ({ title: item.title!, artist: item.subtitle ?? "", durationMs: item.duration ?? 0 }));
  return { title: entity.title ?? entity.name ?? "Spotify", source: "Spotify", tracks };
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Busca en profundidad el primer objeto que cumpla el predicado. */
function findObject<T>(value: unknown, predicate: (value: unknown) => value is T, depth = 0): T | null {
  if (depth > 12 || value === null || typeof value !== "object") return null;
  if (predicate(value)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    const found = findObject(child, predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

/* ───────────────────────────── Deezer ───────────────────────────── */

type DeezerTrack = { title: string; artist: { name: string }; duration: number; readable?: boolean };

const deezerTrack = (track: DeezerTrack): ExternalTrack => ({
  title: track.title,
  artist: track.artist?.name ?? "",
  durationMs: (track.duration ?? 0) * 1000,
});

async function resolveDeezer(url: string): Promise<ExternalList> {
  const expanded = await expandShortLink(url);
  const match = expanded.match(/deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/i);
  if (!match) throw new Error("No reconozco ese enlace de Deezer (vale un track, un álbum o una playlist).");
  const [, type, id] = match;
  const api = "https://api.deezer.com";

  if (type === "track") {
    const data = await getJson<DeezerTrack & { error?: unknown }>(`${api}/track/${id}`);
    if (data.error || !data.title) throw new Error("Esa canción de Deezer no está disponible.");
    const track = deezerTrack(data);
    return { title: track.title, source: "Deezer", tracks: [track] };
  }

  const data = await getJson<{ title: string; tracks: { data: DeezerTrack[]; next?: string }; error?: unknown }>(`${api}/${type}/${id}`);
  if (data.error || !data.tracks) throw new Error("No pude leer ese enlace de Deezer.");
  const items = [...data.tracks.data];
  let next = data.tracks.next;
  while (next && items.length < config.maxQueue) {
    const page = await getJson<{ data: DeezerTrack[]; next?: string }>(next);
    items.push(...page.data);
    next = page.next;
  }
  return { title: data.title, source: "Deezer", tracks: items.map(deezerTrack) };
}

/* ───────────────────────────── Punto de entrada ───────────────────────────── */

export async function resolveExternal(url: string): Promise<ExternalList> {
  const kind = externalKind(url);
  if (kind === "spotify") return resolveSpotify(url);
  if (kind === "deezer") return resolveDeezer(url);
  if (kind === "tidal") {
    throw new Error("Los enlaces de Tidal no están disponibles por ahora. Pega el nombre de la canción o un enlace de Spotify, Deezer o YouTube.");
  }
  throw new Error("No reconozco esa plataforma.");
}
