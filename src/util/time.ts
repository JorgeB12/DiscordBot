export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Duración "humana" para textos: 1 h 05 min, 4 min, 45 s. */
export function formatDurationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/**
 * Barra de progreso compacta en monoespaciado: `██████░░░░░░ 2:04 / 3:56`.
 * Cabe en una sola línea incluso con miniatura y en ventanas estrechas.
 */
export function progressBar(positionMs: number, durationMs: number, size = 12): string {
  if (durationMs <= 0) return `\`${"░".repeat(size)}\` 🔴 En directo`;
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs));
  const filled = Math.round(ratio * size);
  return `\`${"█".repeat(filled)}${"░".repeat(size - filled)} ${formatDuration(positionMs)} / ${formatDuration(durationMs)}\``;
}
