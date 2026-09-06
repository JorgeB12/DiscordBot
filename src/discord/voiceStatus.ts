import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "discord.js";
import type { Song } from "../audio/musicPlayer.js";

/**
 * Estado del canal de voz (la línea bajo el nombre del canal, como hace
 * Rythm): "<nota naranja> Janice STFU - Drake".
 *
 * Discord lo expone como `PUT /channels/{id}/voice-status`. El bot necesita el
 * permiso "Establecer estado del canal de voz" (o Gestionar canales).
 */

const EMOJI_NAME = "juan_nota";
const EMOJI_FILE = path.join(process.cwd(), "assets", "juan-nota.png");
const FALLBACK_EMOJI = "🎵";
const MAX_STATUS = 500;

let emojiPromise: Promise<string> | null = null;
const warnedChannels = new Set<string>();

/** Devuelve el emoji de música del bot como `<:nombre:id>`, creándolo como emoji de la aplicación si no existe. */
export function musicEmoji(client: Client): Promise<string> {
  if (!emojiPromise) {
    emojiPromise = ensureApplicationEmoji(client).catch((error) => {
      console.warn("[voice-status] no pude preparar el emoji de la app, uso 🎵:", errorMessage(error));
      return FALLBACK_EMOJI;
    });
  }
  return emojiPromise;
}

async function ensureApplicationEmoji(client: Client): Promise<string> {
  const appId = client.application?.id;
  if (!appId) return FALLBACK_EMOJI;

  const listed = (await client.rest.get(`/applications/${appId}/emojis`)) as { items?: { id: string; name: string }[] };
  const existing = listed.items?.find((emoji) => emoji.name === EMOJI_NAME);
  if (existing) return `<:${EMOJI_NAME}:${existing.id}>`;

  const image = `data:image/png;base64,${readFileSync(EMOJI_FILE).toString("base64")}`;
  const created = (await client.rest.post(`/applications/${appId}/emojis`, {
    body: { name: EMOJI_NAME, image },
  })) as { id: string };
  console.log(`[voice-status] emoji ${EMOJI_NAME} creado (${created.id})`);
  return `<:${EMOJI_NAME}:${created.id}>`;
}

/** Texto del estado: "Título - Artista", limpio de coletillas tipo "(Official Audio)". */
export function statusText(song: Song, paused: boolean): string {
  const prefix = paused ? "⏸" : "";
  return `${prefix} ${trackLabel(song)}`.trim().slice(0, MAX_STATUS);
}

export function trackLabel(song: Song): string {
  let title = song.title
    .replace(/[([【][^)\]】]*(official|oficial|audio|video|lyric|letra|visuali[sz]er|hd|hq|4k|remaster)[^)\]】]*[)\]】]/gi, "")
    .replace(/\s*\|\s*(official|oficial|audio|video|lyrics?|letra).*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const channel = song.author.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").trim();

  // "Artista - Canción" → "Canción - Artista" (como Rythm). Si no hay guion, añadimos el canal.
  const split = title.match(/^(.{1,60}?)\s+[-–—]\s+(.+)$/);
  if (split) {
    const [, left, right] = split;
    return `${right!.trim()} - ${left!.trim()}`;
  }
  return channel && !title.toLowerCase().includes(channel.toLowerCase()) ? `${title} - ${channel}` : title;
}

export async function setVoiceStatus(client: Client, channelId: string | null, status: string): Promise<void> {
  if (!channelId) return;
  try {
    await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status } });
  } catch (error) {
    const code = (error as { status?: number }).status;
    if (code === 403) {
      if (!warnedChannels.has(channelId)) {
        warnedChannels.add(channelId);
        console.warn(
          "[voice-status] sin permiso para cambiar el estado del canal de voz. Dale al bot el permiso «Establecer estado del canal de voz» (o Gestionar canales).",
        );
      }
      return;
    }
    console.warn("[voice-status] no pude actualizar el estado:", errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
