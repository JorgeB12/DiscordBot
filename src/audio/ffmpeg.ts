import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

let ffmpegReady = false;

export function ensureFfmpegOnPath(): string | null {
  const ffmpegPath = require("ffmpeg-static") as string | null;
  if (!ffmpegPath) return null;
  if (!ffmpegReady) {
    process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.FFMPEG_PATH = ffmpegPath;
    ffmpegReady = true;
  }
  return ffmpegPath;
}

export function ytdlpPath(): string {
  const { YOUTUBE_DL_PATH } = require("youtube-dl-exec/src/constants.js") as {
    YOUTUBE_DL_PATH: string;
  };
  return YOUTUBE_DL_PATH;
}

/**
 * ffmpeg para leer URLs por red (radios, streams). Las builds estáticas de
 * `ffmpeg-static` en Linux no resuelven nombres de dominio, así que si hay un
 * ffmpeg instalado en el sistema (apt) preferimos ese; si no, el estático.
 */
export function networkFfmpegPath(): string {
  for (const candidate of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]) {
    if (existsSync(candidate)) return candidate;
  }
  return ensureFfmpegOnPath() ?? "ffmpeg";
}
