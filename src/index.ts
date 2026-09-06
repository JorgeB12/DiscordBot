import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateDependencyReport } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { ensureFfmpegOnPath } from "./audio/ffmpeg.js";
import { config } from "./config.js";
import { closeDb } from "./db/database.js";
import {
  handleInteraction,
  handleMessage,
  handleVoiceState,
  registerSlashCommands,
  restoreSessions,
  shutdownSessions,
} from "./discord/handlers.js";

const LOCK_FILE = path.join(process.cwd(), ".bemol.lock");

async function main(): Promise<void> {
  ensureFfmpegOnPath();
  claimInstance();
  console.log(generateDependencyReport());

  // Solo los intents imprescindibles. Message Content es privilegiado y se
  // puede desactivar (MESSAGE_CONTENT_INTENT=false) sin perder los slash
  // commands, los botones ni las órdenes que mencionan al bot.
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates];
  if (config.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);
  else console.log("[discord] Message Content desactivado: solo slash commands, botones y @menciones");

  const client = new Client({
    intents,
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Bemol listo como ${ready.user.tag}`);
    await registerSlashCommands();
    await restoreSessions(ready).catch((error) => console.error("[session] restore failed", error));
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (error) {
      console.error("[interaction] failed", error);
      const raw = (error as { rawError?: unknown }).rawError;
      if (raw) console.error("[interaction] detalle:", JSON.stringify(raw).slice(0, 1500));
      if (!interaction.isRepliable()) return;
      const reply = { content: "Falló el comando.", ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(reply).catch(() => undefined);
      } else {
        await interaction.reply(reply).catch(() => undefined);
      }
    }
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message).catch((error) => console.error("[message] failed", error));
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceState(oldState, newState);
  });

  const shutdown = async () => {
    await shutdownSessions();
    closeDb();
    client.destroy();
    releaseInstance();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("unhandledRejection", (reason) => {
    if (isAbortError(reason)) {
      console.warn("[abort] promesa cancelada");
      return;
    }
    console.error("[unhandledRejection]", reason);
  });
  process.on("uncaughtException", (error) => {
    if (isAbortError(error)) {
      console.warn("[abort] excepción ignorada");
      return;
    }
    console.error("[uncaughtException]", error);
    process.exit(1);
  });

  process.on("exit", releaseInstance);
  await client.login(config.discordToken);
}

function claimInstance(): void {
  if (existsSync(LOCK_FILE)) {
    const previous = Number(readFileSync(LOCK_FILE, "utf8").trim());
    if (previous && previous !== process.pid) {
      try {
        process.kill(previous);
        console.log(`[bemol] cerré la instancia anterior (pid ${previous})`);
      } catch {
        // already gone
      }
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid), "utf8");
}

function releaseInstance(): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const current = Number(readFileSync(LOCK_FILE, "utf8").trim());
    if (current === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: string }).name === "AbortError",
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
