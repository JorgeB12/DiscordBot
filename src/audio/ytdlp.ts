import { spawn } from "node:child_process";
import { ytdlpPath } from "./ffmpeg.js";

export type YtDlpFlags = {
  dumpSingleJson?: boolean;
  skipDownload?: boolean;
  noWarnings?: boolean;
  noCheckCertificates?: boolean;
  noPlaylist?: boolean;
  flatPlaylist?: boolean;
  playlistEnd?: number;
  cookies?: string;
};

function buildFlagArgs(flags: YtDlpFlags): string[] {
  const args: string[] = [];
  if (flags.dumpSingleJson) args.push("--dump-single-json");
  if (flags.skipDownload) args.push("--skip-download");
  if (flags.noWarnings) args.push("--no-warnings");
  if (flags.noCheckCertificates) args.push("--no-check-certificates");
  if (flags.noPlaylist) args.push("--no-playlist");
  if (flags.flatPlaylist) args.push("--flat-playlist");
  if (flags.playlistEnd !== undefined) args.push("--playlist-end", String(flags.playlistEnd));
  if (flags.cookies) args.push("--cookies", flags.cookies);
  return args;
}

export function ytDlpJson(url: string, flags: YtDlpFlags = {}): Promise<unknown> {
  // Node como motor JS para los retos de YouTube (ver ytdlpArgs en musicPlayer.ts).
  const args = [url, "--js-runtimes", "node", ...buildFlagArgs(flags)];

  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlpPath(), args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();

      if (out.startsWith("{") || out.startsWith("[")) {
        try {
          resolve(JSON.parse(out));
          return;
        } catch {
          // fall through
        }
      }

      if (code !== 0) {
        reject(new Error(err || out || `yt-dlp salió con código ${code}`));
        return;
      }

      resolve(out);
    });
  });
}
