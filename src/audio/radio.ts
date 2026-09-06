/**
 * Emisoras de radio: una lista seleccionada de streams estables y búsqueda en
 * el directorio comunitario Radio Browser (radio-browser.info), sin clave.
 */

export type Station = {
  name: string;
  url: string;
  genre: string;
  emoji: string;
  country?: string;
  favicon?: string | null;
};

export const CURATED_STATIONS: Station[] = [
  { name: "Groove Salad", url: "https://ice1.somafm.com/groovesalad-128-mp3", genre: "Chill · ambient", emoji: "🎧" },
  { name: "Fluid", url: "https://ice1.somafm.com/fluid-128-mp3", genre: "Lo-fi · hip hop instrumental", emoji: "🎵" },
  { name: "Beat Blender", url: "https://ice1.somafm.com/beatblender-128-mp3", genre: "Deep house · downtempo", emoji: "🪩" },
  { name: "Sonic Universe", url: "https://ice1.somafm.com/sonicuniverse-128-mp3", genre: "Jazz", emoji: "🎷" },
  { name: "Seven Inch Soul", url: "https://ice1.somafm.com/7soul-128-mp3", genre: "Soul · R&B clásico", emoji: "🎤" },
  { name: "Indie Pop Rocks", url: "https://ice1.somafm.com/indiepop-128-mp3", genre: "Indie · pop", emoji: "🎸" },
  { name: "Metal Detector", url: "https://ice1.somafm.com/metal-128-mp3", genre: "Metal", emoji: "🤘" },
  { name: "Boot Liquor", url: "https://ice1.somafm.com/bootliquor-128-mp3", genre: "Country · americana", emoji: "🤠" },
  { name: "Drone Zone", url: "https://ice1.somafm.com/dronezone-128-mp3", genre: "Ambiente para concentrarse", emoji: "🌌" },
  { name: "Secret Agent", url: "https://ice1.somafm.com/secretagent-128-mp3", genre: "Lounge · spy jazz", emoji: "🕶️" },
];

const RADIO_BROWSER = "https://de1.api.radio-browser.info/json";
const USER_AGENT = "Bemol-Discord-Bot/2.0 (+https://github.com/JorgeB12/DiscordBot)";

type RadioBrowserStation = {
  stationuuid: string;
  name: string;
  url_resolved: string;
  favicon: string;
  tags: string;
  country: string;
  codec: string;
  bitrate: number;
  votes: number;
  lastcheckok: number;
};

/** Busca emisoras por nombre o género (salsa, reggaeton, jazz, "radio nacional"...). */
export async function searchStations(query: string, limit = 8): Promise<Station[]> {
  const params = new URLSearchParams({
    name: query,
    limit: String(limit * 3),
    order: "votes",
    reverse: "true",
    hidebroken: "true",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let stations = await fetchStations(`${RADIO_BROWSER}/stations/search?${params}`, controller.signal);
    // Si por nombre no hay nada, probamos por etiqueta (género).
    if (!stations.length) {
      const byTag = new URLSearchParams({ tag: query, limit: String(limit * 3), order: "votes", reverse: "true", hidebroken: "true" });
      stations = await fetchStations(`${RADIO_BROWSER}/stations/search?${byTag}`, controller.signal);
    }
    const seen = new Set<string>();
    return stations
      .filter((station) => station.lastcheckok === 1 && /^https?:\/\//i.test(station.url_resolved))
      .filter((station) => {
        const key = station.name.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map((station) => ({
        name: station.name.trim().slice(0, 80),
        url: station.url_resolved,
        genre: station.tags
          .split(",")
          .filter(Boolean)
          .slice(0, 3)
          .join(" · ") || station.codec,
        emoji: "📻",
        country: station.country || undefined,
        favicon: station.favicon || null,
      }));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStations(url: string, signal: AbortSignal): Promise<RadioBrowserStation[]> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal });
  if (!response.ok) throw new Error(`Radio Browser respondió ${response.status}`);
  return (await response.json()) as RadioBrowserStation[];
}

export function findCurated(name: string): Station | null {
  const wanted = name.trim().toLowerCase();
  return CURATED_STATIONS.find((station) => station.name.toLowerCase() === wanted) ?? null;
}
