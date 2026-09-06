import type { Song } from "../audio/musicPlayer.js";
import { getDb } from "./database.js";

/**
 * Biblioteca personal: playlists y favoritos. Van ligados al usuario, no al
 * servidor, así que funcionan en cualquier servidor donde esté Bemol.
 */

/** Canción guardada: igual que `Song` pero sin quién la pidió (eso se decide al reproducir). */
export type LibrarySong = Omit<Song, "requestedBy">;

export type Playlist = {
  id: number;
  ownerId: string;
  ownerName: string;
  name: string;
  trackCount: number;
  durationMs: number;
  createdAt: number;
  updatedAt: number;
};

export const LIMITS = {
  playlistsPerUser: 50,
  tracksPerPlaylist: 250,
  favorites: 500,
  nameLength: 60,
};

export function migrateLibrary(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS playlists_owner_name ON playlists (owner_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      song_json TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS playlist_tracks_playlist ON playlist_tracks (playlist_id, position);

    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      song_json TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, song_id)
    );
  `);
  getDb().exec("PRAGMA foreign_keys = ON");
}

export function toLibrarySong(song: Song): LibrarySong {
  const { requestedBy: _requestedBy, ...rest } = song;
  return rest;
}

/* ───────────────────────────── Playlists ───────────────────────────── */

type PlaylistRow = {
  id: number;
  owner_id: string;
  owner_name: string;
  name: string;
  created_at: number;
  updated_at: number;
  track_count: number;
  duration_ms: number | null;
};

const PLAYLIST_SELECT = `
  SELECT p.*,
         (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS track_count,
         (SELECT SUM(json_extract(t.song_json, '$.durationMs')) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS duration_ms
  FROM playlists p`;

function rowToPlaylist(row: PlaylistRow): Playlist {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    name: row.name,
    trackCount: row.track_count,
    durationMs: row.duration_ms ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPlaylists(ownerId: string): Playlist[] {
  const rows = getDb().prepare(`${PLAYLIST_SELECT} WHERE p.owner_id = ? ORDER BY p.updated_at DESC`).all(ownerId) as unknown as PlaylistRow[];
  return rows.map(rowToPlaylist);
}

export function findPlaylist(ownerId: string, name: string): Playlist | null {
  const row = getDb()
    .prepare(`${PLAYLIST_SELECT} WHERE p.owner_id = ? AND p.name = ? COLLATE NOCASE`)
    .get(ownerId, name.trim()) as PlaylistRow | undefined;
  return row ? rowToPlaylist(row) : null;
}

export function getPlaylist(id: number): Playlist | null {
  const row = getDb().prepare(`${PLAYLIST_SELECT} WHERE p.id = ?`).get(id) as PlaylistRow | undefined;
  return row ? rowToPlaylist(row) : null;
}

export function createPlaylist(ownerId: string, ownerName: string, name: string): Playlist {
  const clean = name.trim().slice(0, LIMITS.nameLength);
  if (!clean) throw new Error("La playlist necesita un nombre.");
  if (findPlaylist(ownerId, clean)) throw new Error(`Ya tienes una playlist llamada **${clean}**.`);
  if (listPlaylists(ownerId).length >= LIMITS.playlistsPerUser) {
    throw new Error(`Has llegado al máximo de ${LIMITS.playlistsPerUser} playlists.`);
  }
  const now = Date.now();
  const result = getDb()
    .prepare("INSERT INTO playlists (owner_id, owner_name, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(ownerId, ownerName, clean, now, now);
  return getPlaylist(Number(result.lastInsertRowid))!;
}

export function deletePlaylist(id: number): void {
  getDb().prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").run(id);
  getDb().prepare("DELETE FROM playlists WHERE id = ?").run(id);
}

export function playlistTracks(id: number): LibrarySong[] {
  const rows = getDb()
    .prepare("SELECT song_json FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id")
    .all(id) as unknown as { song_json: string }[];
  return rows.map((row) => JSON.parse(row.song_json) as LibrarySong);
}

/** Añade canciones al final; devuelve cuántas entraron (respeta el límite y evita duplicados). */
export function addTracks(id: number, songs: LibrarySong[]): { added: number; skipped: number } {
  const db = getDb();
  const existing = new Set(playlistTracks(id).map((song) => song.id));
  let position = existing.size;
  let added = 0;
  let skipped = 0;
  const insert = db.prepare("INSERT INTO playlist_tracks (playlist_id, position, song_json, added_at) VALUES (?, ?, ?, ?)");
  for (const song of songs) {
    if (existing.has(song.id) || position >= LIMITS.tracksPerPlaylist) {
      skipped++;
      continue;
    }
    insert.run(id, position++, JSON.stringify(song), Date.now());
    existing.add(song.id);
    added++;
  }
  db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  return { added, skipped };
}

export function removeTrack(id: number, position: number): LibrarySong | null {
  const tracks = playlistTracks(id);
  const song = tracks[position - 1];
  if (!song) return null;
  const db = getDb();
  db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").run(id);
  const insert = db.prepare("INSERT INTO playlist_tracks (playlist_id, position, song_json, added_at) VALUES (?, ?, ?, ?)");
  tracks
    .filter((_, index) => index !== position - 1)
    .forEach((track, index) => insert.run(id, index, JSON.stringify(track), Date.now()));
  db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  return song;
}

/** Copia una playlist a otro usuario (para "guardar" una compartida). */
export function copyPlaylist(id: number, ownerId: string, ownerName: string): Playlist {
  const source = getPlaylist(id);
  if (!source) throw new Error("Esa playlist ya no existe.");
  let name = source.name;
  if (findPlaylist(ownerId, name)) name = `${source.name} (de ${source.ownerName})`.slice(0, LIMITS.nameLength);
  const copy = createPlaylist(ownerId, ownerName, name);
  addTracks(copy.id, playlistTracks(id));
  return getPlaylist(copy.id)!;
}

/* ───────────────────────────── Favoritos ───────────────────────────── */

export function isFavorite(userId: string, songId: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM favorites WHERE user_id = ? AND song_id = ?").get(userId, songId));
}

export function addFavorite(userId: string, song: LibrarySong): boolean {
  if (isFavorite(userId, song.id)) return false;
  const count = (getDb().prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= LIMITS.favorites) throw new Error(`Has llegado al máximo de ${LIMITS.favorites} favoritas.`);
  getDb()
    .prepare("INSERT INTO favorites (user_id, song_id, song_json, added_at) VALUES (?, ?, ?, ?)")
    .run(userId, song.id, JSON.stringify(song), Date.now());
  return true;
}

export function removeFavorite(userId: string, songId: string): boolean {
  const result = getDb().prepare("DELETE FROM favorites WHERE user_id = ? AND song_id = ?").run(userId, songId);
  return Number(result.changes) > 0;
}

export function listFavorites(userId: string): LibrarySong[] {
  const rows = getDb()
    .prepare("SELECT song_json FROM favorites WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId) as unknown as { song_json: string }[];
  return rows.map((row) => JSON.parse(row.song_json) as LibrarySong);
}
