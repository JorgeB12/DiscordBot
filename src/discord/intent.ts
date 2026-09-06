import { stripWakeWord } from "../config.js";
import { extractYoutubeUrl } from "../audio/musicPlayer.js";
import type { LoopMode } from "../audio/types.js";

export type Intent =
  | { type: "join" }
  | { type: "leave" }
  | { type: "play"; query: string }
  | { type: "search"; query: string }
  | { type: "skip"; count: number }
  | { type: "previous" }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "queue"; page: number }
  | { type: "nowplaying" }
  | { type: "shuffle" }
  | { type: "loop"; mode?: LoopMode }
  | { type: "volume"; level?: number }
  | { type: "remove"; position: number }
  | { type: "clear" }
  | { type: "help" }
  | { type: "unknown"; text: string };

export function parseIntent(utterance: string): Intent {
  const text = stripWakeWord(utterance.trim());
  if (!text) return { type: "unknown", text: "" };

  if (/^(ven|unete|únete|entra|join|metete|métete)\b/i.test(text)) {
    return { type: "join" };
  }
  if (
    /^(salte|sal\b|vete|leave|adios|adiós|desconecta(?:te|r)?|desconéctate|desconectar|fuera|disconnect)\b/i.test(
      text,
    )
  ) {
    return { type: "leave" };
  }

  if (/^(ayuda|help|comandos)\.?$/i.test(text)) {
    return { type: "help" };
  }

  if (
    /^(?:para(?:me)?|stop|det[eé]n(?:te)?|apaga)(?:\s+(?:la\s+)?(?:m[uú]sica|canci[oó]n|playlist|lista|tema))?\.?$/i.test(
      text,
    )
  ) {
    return { type: "stop" };
  }

  if (/^(pausa|pause|pausar)\.?$/i.test(text)) {
    return { type: "pause" };
  }

  if (/^(sigue|seguir|continua|continúa|continue|resume|unpause|despausa)\b/i.test(text)) {
    return { type: "resume" };
  }

  if (/^(anterior|previous|prev|atr[aá]s)\.?$/i.test(text)) {
    return { type: "previous" };
  }

  const folded = foldedCommand(text.replace(/\.$/, ""));

  const skipCount = folded.match(
    /^(?:skip|salta(?:r)?|siguiente|next|proxima(?:\s+cancion)?|proximo(?:\s+tema)?|pasa(?:\s+a\s+la\s+siguiente)?)(?:\s+(\d+))?$/,
  );
  if (skipCount) {
    return { type: "skip", count: skipCount[1] ? Number(skipCount[1]) : 1 };
  }

  if (/^(mezcla(?:r)?|shuffle)\.?$/i.test(text)) {
    return { type: "shuffle" };
  }

  if (/^(limpia(?:r)?|clear|vac[ií]a(?:r)?(?:\s+la\s+cola)?)\.?$/i.test(text)) {
    return { type: "clear" };
  }

  const loop = text.match(/^(repite|repetir|loop|repeat)(?:\s+(off|no|cancion|canción|tema|cola|queue|track))?\.?$/i);
  if (loop) {
    return { type: "loop", mode: parseLoopMode(loop[2]) };
  }

  const volume = text.match(/^(volumen|volume|vol)(?:\s+(\d{1,3}))?\.?$/i);
  if (volume) {
    return { type: "volume", level: volume[2] ? Number(volume[2]) : undefined };
  }

  const remove = text.match(/^(quita(?:r)?|remove|elimina(?:r)?)(?:\s+(\d+))?\.?$/i);
  if (remove?.[2]) {
    return { type: "remove", position: Number(remove[2]) };
  }

  if (/^(cola|queue|lista)(?:\s+(\d+))?\.?$/i.test(text)) {
    const page = text.match(/(\d+)/);
    return { type: "queue", page: page ? Number(page[1]) : 1 };
  }

  if (/^(np|sonando|nowplaying|qu[eé]\s+suena|qu[eé]\s+est[aá]\s+sonando)\.?$/i.test(text)) {
    return { type: "nowplaying" };
  }

  const search = text.match(/^(busca(?:r)?|search)[:\s]+(.+)$/i);
  if (search?.[2]) {
    return { type: "search", query: search[2].trim() };
  }

  const add = foldedCommand(text).match(
    /^(?:anade(?:me)?(?:\s+a\s+la\s+cola)?|agrega(?:me)?(?:\s+a\s+la\s+cola)?|encola(?:r)?|add)[:\s]+(.+)$/,
  );
  if (add) {
    const query = text.replace(/^\S+(?:\s+a\s+la\s+cola)?[:\s]+/i, "").trim();
    if (query) return { type: "play", query };
  }

  const queueAdd = text.match(/^(?:pon(?:me)?|mete(?:me)?)\s+(?:en\s+)?(?:la\s+)?cola[:\s]+(.+)$/i);
  if (queueAdd?.[1]) {
    return { type: "play", query: queueAdd[1].trim() };
  }

  const youtubeUrl = extractYoutubeUrl(text);
  if (youtubeUrl) {
    return { type: "play", query: youtubeUrl };
  }

  const music = text.match(
    /^(?:pon(?:me|er|e)?[:\s]*(?:la\s+)?(?:m[uú]sica|canci[oó]n|playlist|lista)?(?:\s+de)?|reproduce|play)[:\s]+(.+)$/i,
  );
  if (music?.[1]) {
    return { type: "play", query: music[1].trim() };
  }

  return { type: "unknown", text };
}

function parseLoopMode(raw: string | undefined): LoopMode | undefined {
  if (!raw) return undefined;
  const value = foldedCommand(raw);
  if (value === "off" || value === "no") return "off";
  if (value === "cola" || value === "queue") return "queue";
  if (value === "cancion" || value === "tema" || value === "track") return "track";
  return undefined;
}

function foldedCommand(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
