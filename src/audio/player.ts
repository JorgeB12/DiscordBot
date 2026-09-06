import {
  AudioPlayerStatus,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type VoiceBasedChannel,
} from "discord.js";
import { config } from "../config.js";
import { getMusicTextChannel } from "../discord/channels.js";
import { farewellEmbed, panelMovedEmbed, playerPanel } from "../discord/embeds.js";
import { musicEmoji, setVoiceStatus, statusText } from "../discord/voiceStatus.js";
import {
  createTrackStream,
  resolveTracks,
  type Requester,
  type Song,
  type TrackStream,
} from "./musicPlayer.js";
import type { LoopMode } from "./types.js";
import { waitForStatus } from "./waitForStatus.js";

type PlayerOptions = {
  channel: VoiceBasedChannel;
  textChannel: GuildTextBasedChannel | null;
  onDestroyed?: () => void;
};

export type PlayResult = {
  started: boolean;
  songs: Song[];
  playlistTitle?: string;
};

export type LeaveReason = "idle" | "empty" | "manual" | "moved" | "disconnected" | "shutdown";

const PANEL_REFRESH_MS = 12_000;
const ADOPTION_GRACE_MS = 10_000;

export class GuildPlayer {
  readonly guildId: string;
  private readonly guild: Guild;
  private connection: VoiceConnection;
  private player: AudioPlayer;
  private onDestroyed?: () => void;
  private destroyed = false;
  private stream: TrackStream | null = null;
  private skipRequested = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private panelTimer: ReturnType<typeof setInterval> | null = null;
  private panel: Message | null = null;
  /** Mientras está armado no publicamos panel: quien llamó a playQuery va a adoptar su respuesta como panel. */
  private adoptionPending: ReturnType<typeof setTimeout> | null = null;
  private textChannel: GuildTextBasedChannel | null;
  private volume = config.defaultVolume / 100;
  private loopMode: LoopMode = "off";

  current: Song | null = null;
  readonly queue: Song[] = [];
  readonly history: Song[] = [];

  constructor(options: PlayerOptions) {
    this.guild = options.channel.guild;
    this.guildId = this.guild.id;
    this.textChannel = options.textChannel;
    this.onDestroyed = options.onDestroyed;
    this.player = createAudioPlayer();
    this.connection = joinVoiceChannel({
      channelId: options.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
      daveEncryption: config.daveEncryption,
      debug: config.voiceDebug,
    });
    if (config.voiceDebug) {
      this.connection.on("debug", (message) => console.log(`[voice:debug] ${message.slice(0, 300)}`));
      this.player.on("debug", (message) => console.log(`[player:debug] ${message.slice(0, 300)}`));
    }
    console.log(
      `[voice] audio: ${config.opusBitrateKbps} kbps · FEC ${config.opusFec ? "sí" : "no"} · DAVE ${config.daveEncryption ? "sí" : "no"}`,
    );

    this.connection.subscribe(this.player);
    this.connection.on("error", (error) => console.error("[voice] connection", error));
    this.connection.on("stateChange", (oldState, newState) => {
      if (oldState.status === newState.status) return;
      console.log(`[voice] ${oldState.status} -> ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Ready) {
        // Útil para diagnosticar latencia/pérdida hacia el servidor de voz de Discord.
        const net = newState.networking.state as { connectionOptions?: { endpoint?: string } };
        console.log(`[voice] servidor de voz: ${net.connectionOptions?.endpoint ?? "desconocido"}`);
      }
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        void this.handleDisconnect(newState.reason, "closeCode" in newState ? newState.closeCode : undefined);
      }
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        void this.destroy("disconnected");
      }
    });
    this.player.on("error", (error) => console.error("[voice] player", error));
    this.player.on("stateChange", (oldState, newState) => {
      if (oldState.status === newState.status) return;
      if (newState.status === AudioPlayerStatus.Buffering || newState.status === AudioPlayerStatus.AutoPaused) {
        console.warn(`[audio] reproductor en ${newState.status} (${oldState.status} -> ${newState.status})`);
      }
      if (oldState.status !== AudioPlayerStatus.Idle && newState.status === AudioPlayerStatus.Idle) {
        void this.onTrackEnd();
      }
    });
  }

  /**
   * Estado del canal de voz (línea bajo el nombre del canal): la canción que
   * suena, con el emoji violeta de Bemol; vacío cuando no suena nada.
   */
  private async syncVoiceStatus(): Promise<void> {
    const channelId = this.channelId;
    if (!channelId) return;
    const song = this.current;
    if (!song || this.destroyed) {
      await setVoiceStatus(this.guild.client, channelId, "");
      return;
    }
    const emoji = this.paused ? "" : await musicEmoji(this.guild.client);
    await setVoiceStatus(this.guild.client, channelId, `${emoji} ${statusText(song, this.paused)}`.trim());
  }

  /* ───────── Monitor de calidad: tramas enviadas frente al reloj y retraso del bucle ───────── */

  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private lagProbe: ReturnType<typeof setInterval> | null = null;
  private lagProbeLast = 0;
  private maxLagMs = 0;
  private trackStartedAt = 0;

  private startMonitor(): void {
    this.trackStartedAt = Date.now();
    this.maxLagMs = 0;
    if (this.lagProbe) return;
    this.lagProbeLast = performance.now();
    this.lagProbe = setInterval(() => {
      const now = performance.now();
      const lag = now - this.lagProbeLast - 20;
      this.lagProbeLast = now;
      if (lag > this.maxLagMs) this.maxLagMs = lag;
    }, 20);
    this.monitorTimer = setInterval(() => this.reportHealth(), 10_000);
  }

  private stopMonitor(): void {
    if (this.lagProbe) clearInterval(this.lagProbe);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.lagProbe = null;
    this.monitorTimer = null;
  }

  private reportHealth(): void {
    if (this.player.state.status === AudioPlayerStatus.Idle || !this.current) return;
    const sentMs = this.player.state.resource.playbackDuration;
    const wallMs = Date.now() - this.trackStartedAt;
    const lostPct = wallMs > 0 ? Math.max(0, ((wallMs - sentMs) / wallMs) * 100) : 0;
    const paused = this.paused ? " (en pausa)" : "";
    console.log(
      `[audio] ${(sentMs / 1000).toFixed(1)}s enviados en ${(wallMs / 1000).toFixed(1)}s de reloj · ` +
        `déficit ${lostPct.toFixed(1)}% · lag máx ${this.maxLagMs.toFixed(0)} ms · ` +
        `estado ${this.player.state.status}${paused}`,
    );
    this.maxLagMs = 0;
  }

  get channelId(): string | null {
    return this.connection.joinConfig.channelId ?? null;
  }

  get channelName(): string | null {
    const id = this.channelId;
    const channel = id ? this.guild.channels.cache.get(id) : null;
    return channel?.name ?? null;
  }

  get panelMessageId(): string | null {
    return this.panel?.id ?? null;
  }

  get guildName(): string {
    return this.guild.name;
  }

  get loop(): LoopMode {
    return this.loopMode;
  }

  get volumePercent(): number {
    return Math.round(this.volume * 100);
  }

  get paused(): boolean {
    return (
      this.player.state.status === AudioPlayerStatus.Paused ||
      this.player.state.status === AudioPlayerStatus.AutoPaused
    );
  }

  get playing(): boolean {
    return this.player.state.status !== AudioPlayerStatus.Idle;
  }

  get playbackPositionMs(): number {
    if (this.player.state.status === AudioPlayerStatus.Idle) return 0;
    return this.player.state.resource.playbackDuration;
  }

  get queueDurationMs(): number {
    return this.queue.reduce((sum, song) => sum + (song.durationMs || 0), 0);
  }

  async ready(): Promise<void> {
    if (this.connection.state.status === VoiceConnectionStatus.Ready) return;
    await waitForStatus(this.connection, VoiceConnectionStatus.Ready, 45_000);
  }

  isConnectedTo(channelId: string): boolean {
    return (
      !this.destroyed &&
      this.connection.joinConfig.channelId === channelId &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    );
  }

  setTextChannel(channel: GuildTextBasedChannel | null): void {
    if (channel) this.textChannel = channel;
  }

  /**
   * Resuelve y encola. Con `adoptPanel`, si la reproducción arranca con esta
   * petición no se publica un panel aparte: quien llama debe pasar su mensaje
   * de respuesta a `adoptPanel()` para que ese mensaje sea el panel.
   */
  async playQuery(
    query: string,
    requestedBy: Requester,
    options: { adoptPanel?: boolean } = {},
  ): Promise<PlayResult> {
    const { songs, playlistTitle } = await resolveTracks(query, requestedBy);
    const willStart = !this.current && !this.playing;
    if (options.adoptPanel && willStart) this.expectAdoption();
    try {
      return await this.enqueue(songs, playlistTitle);
    } catch (error) {
      this.cancelAdoption();
      throw error;
    }
  }

  /** Convierte el mensaje dado en el panel de reproducción y lo mantiene actualizado. */
  async adoptPanel(message: Message): Promise<void> {
    this.cancelAdoption();
    if (this.destroyed) return;
    const previous = this.panel;
    this.panel = message;
    if (previous && previous.id !== message.id) {
      await previous.delete().catch(() => undefined);
    }
    await this.refreshPanel();
  }

  /** Cancela una adopción pendiente y publica el panel de forma normal. */
  async publishPanel(): Promise<void> {
    this.cancelAdoption();
    await this.refreshPanel();
  }

  async enqueue(songs: Song[], playlistTitle?: string): Promise<PlayResult> {
    if (!songs.length) {
      throw new Error("No encontré canciones para poner.");
    }

    const room = config.maxQueue - this.queue.length - (this.current ? 1 : 0);
    if (room <= 0) {
      throw new Error(`La cola está llena (${config.maxQueue} canciones).`);
    }

    const accepted = songs.slice(0, room);
    const alreadyActive = Boolean(this.current) || this.playing;
    this.queue.push(...accepted);
    this.clearIdle();

    if (!alreadyActive) {
      await this.playNext();
    } else {
      await this.refreshPanel();
    }

    return { started: !alreadyActive, songs: accepted, playlistTitle };
  }

  async skip(count = 1): Promise<string> {
    if (!this.current && this.queue.length === 0) return "No hay nada que saltar.";
    const skipped = this.current?.title;
    const extra = Math.min(Math.max(0, count - 1), this.queue.length);
    if (extra) this.queue.splice(0, extra);
    this.skipRequested = true;
    this.player.stop(true);
    if (extra) return `Salté ${extra + 1} canciones.`;
    return skipped ? `Salté **${skipped}**.` : "Siguiente.";
  }

  async previous(): Promise<string> {
    const last = this.history.pop();
    if (!last) return "No hay canción anterior.";
    if (this.current) this.queue.unshift(this.current);
    this.queue.unshift(last);
    this.current = null;
    this.skipRequested = true;
    this.player.stop(true);
    return `Vuelvo a **${last.title}**.`;
  }

  stop(): string {
    if (!this.current && this.queue.length === 0) return "No hay música sonando.";
    this.queue.length = 0;
    this.current = null;
    this.skipRequested = true;
    this.player.stop(true);
    this.stopPanelLoop();
    this.armIdle();
    void this.syncVoiceStatus();
    void this.refreshPanel();
    return "Paré la música y vacié la cola.";
  }

  pause(): string {
    if (!this.playing) return "No hay música sonando.";
    if (this.paused) return "Ya está en pausa.";
    this.player.pause(true);
    void this.syncVoiceStatus();
    void this.refreshPanel();
    return "Pausa.";
  }

  resume(): string {
    if (!this.playing) return "No hay música sonando.";
    if (!this.paused) return "Ya está sonando.";
    this.player.unpause();
    void this.syncVoiceStatus();
    void this.refreshPanel();
    return "Sigo.";
  }

  shuffle(): string {
    if (this.queue.length < 2) return "No hay suficiente cola para mezclar.";
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
    }
    void this.refreshPanel();
    return `Mezclé ${this.queue.length} canciones.`;
  }

  cycleLoop(): string {
    const next: LoopMode = this.loopMode === "off" ? "track" : this.loopMode === "track" ? "queue" : "off";
    return this.setLoop(next);
  }

  setLoop(mode: LoopMode): string {
    this.loopMode = mode;
    void this.refreshPanel();
    return this.loopMode === "off"
      ? "Repetición desactivada."
      : this.loopMode === "track"
        ? "Repito esta canción."
        : "Repito la cola.";
  }

  setVolume(percent: number): string {
    const clamped = Math.min(150, Math.max(0, Math.round(percent)));
    this.volume = clamped / 100;
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.state.resource.volume?.setVolume(this.volume);
    }
    void this.refreshPanel();
    return `Volumen al ${clamped}%.`;
  }

  remove(position: number): string {
    const index = position - 1;
    const song = this.queue[index];
    if (!song) return "Esa posición no existe en la cola.";
    this.queue.splice(index, 1);
    void this.refreshPanel();
    return `Quité **${song.title}**.`;
  }

  clear(): string {
    if (!this.queue.length) return "La cola ya está vacía.";
    const count = this.queue.length;
    this.queue.length = 0;
    void this.refreshPanel();
    return `Limpié ${count} canciones de la cola.`;
  }

  onChannelEmpty(): void {
    if (this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      void this.destroy("empty");
    }, config.emptyLeaveMs);
  }

  onChannelOccupied(): void {
    if (!this.emptyTimer) return;
    clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  async destroy(reason: LeaveReason = "manual"): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdle();
    this.cancelAdoption();
    this.stopPanelLoop();
    this.onChannelOccupied();
    const farewell = farewellEmbed(this.channelName, reason);
    const leavingChannelId = this.channelId;
    void setVoiceStatus(this.guild.client, leavingChannelId, "");
    this.stream?.destroy();
    this.stream = null;
    this.queue.length = 0;
    this.current = null;
    this.player.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.onDestroyed?.();

    const panel = this.panel;
    this.panel = null;
    if (panel) {
      await panel.edit({ embeds: [farewell], components: [] }).catch(() => undefined);
    }
  }

  private async handleDisconnect(reason?: VoiceConnectionDisconnectReason, closeCode?: number): Promise<void> {
    if (this.destroyed) return;
    if (reason === VoiceConnectionDisconnectReason.WebSocketClose && closeCode === 4014) {
      await this.destroy("disconnected");
      return;
    }
    try {
      await waitForStatus(this.connection, VoiceConnectionStatus.Connecting, 5_000);
      await waitForStatus(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      await this.destroy("disconnected");
    }
  }

  private async onTrackEnd(): Promise<void> {
    if (this.destroyed) return;

    const finished = this.current;
    this.stream?.destroy();
    this.stream = null;

    const wasSkip = this.skipRequested;
    this.skipRequested = false;

    if (finished && !wasSkip && this.loopMode === "track") {
      this.queue.unshift(finished);
    } else if (finished) {
      this.history.push(finished);
      if (this.history.length > 25) this.history.shift();
      if (!wasSkip && this.loopMode === "queue") {
        this.queue.push(finished);
      }
    }

    this.current = null;
    await this.playNext();
  }

  private async playNext(): Promise<void> {
    while (!this.destroyed && this.queue.length) {
      const song = this.queue.shift()!;
      try {
        this.stream?.destroy();
        this.stream = createTrackStream(song, this.volume);
        this.current = song;
        this.player.play(this.stream.resource);
        this.clearIdle();
        this.startPanelLoop();
        console.log(`[music] playing ${song.title}`);
        void this.syncVoiceStatus();
        await this.refreshPanel({ bump: true });
        return;
      } catch (error) {
        console.error("[music] skip unplayable", song.title, error);
        this.stream?.destroy();
        this.stream = null;
      }
    }

    this.current = null;
    this.stopPanelLoop();
    this.armIdle();
    void this.syncVoiceStatus();
    await this.refreshPanel();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.destroy("idle");
    }, config.idleLeaveMs);
  }

  private clearIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private expectAdoption(): void {
    this.cancelAdoption();
    this.adoptionPending = setTimeout(() => {
      this.adoptionPending = null;
      void this.refreshPanel();
    }, ADOPTION_GRACE_MS);
    this.adoptionPending.unref();
  }

  private cancelAdoption(): void {
    if (!this.adoptionPending) return;
    clearTimeout(this.adoptionPending);
    this.adoptionPending = null;
  }

  private startPanelLoop(): void {
    this.startMonitor();
    if (this.panelTimer) return;
    this.panelTimer = setInterval(() => {
      void this.refreshPanel();
    }, PANEL_REFRESH_MS);
  }

  private stopPanelLoop(): void {
    this.stopMonitor();
    if (!this.panelTimer) return;
    clearInterval(this.panelTimer);
    this.panelTimer = null;
  }

  /**
   * Publica o actualiza el panel. Con `bump`, si el panel ya no es el último
   * mensaje del canal se vuelve a publicar abajo del todo para que no se
   * pierda entre la conversación (solo se hace al empezar una canción).
   */
  async refreshPanel(options: { bump?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    const channel = await getMusicTextChannel(this.guild, this.textChannel);
    if (!channel?.isTextBased()) return;

    const payload = playerPanel(this);

    if (this.panel && this.panel.channelId !== channel.id) {
      // El panel vive en otro canal de texto (por ejemplo, la respuesta a un
      // /play hecho fuera del canal de música). Lo dejamos como aviso y
      // publicamos el panel donde toca.
      const old = this.panel;
      this.panel = null;
      await old.edit({ embeds: [panelMovedEmbed(channel.id)], components: [] }).catch(() => undefined);
    } else if (this.panel) {
      const buried = Boolean(options.bump && channel.lastMessageId && channel.lastMessageId !== this.panel.id);
      if (!buried) {
        try {
          await this.panel.edit(payload);
          return;
        } catch {
          this.panel = null;
        }
      } else {
        const old = this.panel;
        this.panel = null;
        await old.delete().catch(() => undefined);
      }
    }

    if (!this.current || this.adoptionPending) return;
    this.panel = await channel.send(payload).catch(() => null);
  }
}
