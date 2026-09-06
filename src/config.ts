import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Cookies de YouTube para yt-dlp. Si no se configura YOUTUBE_COOKIES pero hay
 * un `cookies.txt` en la carpeta del proyecto, se usa ese. Así el mismo
 * archivo sirve en local y en el servidor sin tocar el .env.
 */
function youtubeCookiesPath(): string {
  const configured = optional("YOUTUBE_COOKIES");
  if (configured) return configured;
  const local = path.join(process.cwd(), "cookies.txt");
  return existsSync(local) ? local : "";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Copia .env.example a .env y rellénala.`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: optional("DISCORD_GUILD_ID"),
  wakeWord: optional("WAKE_WORD", "Juan"),
  musicChannelId: optional("MUSIC_CHANNEL_ID"),
  youtubeCookies: youtubeCookiesPath(),
  /**
   * Message Content es un intent privilegiado: Discord solo lo concede a bots
   * verificados con justificación. Sin él, el bot sigue funcionando con slash
   * commands, botones y mensajes que empiecen mencionándolo (@Juan pon ...),
   * porque el contenido de los mensajes que mencionan al bot siempre llega.
   */
  messageContentIntent: flag("MESSAGE_CONTENT_INTENT", true),
  /** Ajustes del audio que se envía a Discord (ver .env.example). */
  opusBitrateKbps: Math.min(512, Math.max(32, integer("OPUS_BITRATE_KBPS", 96))),
  opusFec: flag("OPUS_FEC", false),
  daveEncryption: flag("DAVE_ENCRYPTION", true),
  /** Registra la negociación de voz y del cifrado DAVE en el log (solo para diagnosticar). */
  voiceDebug: flag("VOICE_DEBUG", false),
  /** Enlaces legales que Discord pide para verificar la app; salen en /ayuda. */
  privacyUrl: optional("PRIVACY_URL"),
  termsUrl: optional("TERMS_URL"),
  supportUrl: optional("SUPPORT_URL"),
  defaultVolume: Math.min(150, Math.max(1, integer("DEFAULT_VOLUME", 50))),
  idleLeaveMs: integer("IDLE_LEAVE_MS", 5 * 60_000),
  emptyLeaveMs: integer("EMPTY_LEAVE_MS", 30 * 60_000),
  maxQueue: integer("MAX_QUEUE", 250),
};

export function matchesWakeWord(text: string, wakeWord = config.wakeWord): boolean {
  const escaped = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\b)${escaped}\\b`, "i").test(text);
}

export function stripWakeWord(text: string, wakeWord = config.wakeWord): string {
  const escaped = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^[\\s.,!?]*${escaped}[\\s,.:;!?\\-]*`, "i"), "").trim();
}
