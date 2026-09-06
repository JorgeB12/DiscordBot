# Juan — bot de música para Discord

Juan se une a tu canal de voz y reproduce canciones y playlists de YouTube. Está pensado para servidores en español: comandos en español, panel de reproducción con botones, y órdenes en lenguaje natural (`Juan pon ...`).

## Características

- **Panel de reproducción** que se actualiza solo: carátula, barra de progreso, quién pidió la canción, cola y siguiente tema, con botones para pausar, saltar, mezclar, repetir, ver la cola y añadir canciones.
- **Estado del canal de voz** con la canción que suena, al estilo de los bots grandes, con un emoji propio.
- **Audio oficial**: al pedir una canción por nombre, prioriza los canales "Artista - Topic" y los vídeos *Official Audio*, y descarta remixes, *sped up*, covers, karaokes, directos, videoclips y loops de una hora. Si pides una variante a propósito (`pon X remix`, `pon X en vivo`), la respeta.
- **Tres formas de usarlo**: slash commands, mención (`@Juan pon ...`) o palabra de activación en el chat (`Juan pon ...`).
- Cola con paginación y menú para quitar canciones, playlists de YouTube, repetición de canción o cola, mezclar, volumen.
- Se sale solo cuando el canal se queda vacío o no suena nada durante un rato, y avisa del motivo.
- No guarda datos: todo vive en memoria y se borra al salir del canal. Ver [PRIVACY.md](PRIVACY.md) y [TERMS.md](TERMS.md).

## Requisitos

- Node.js **20 o superior** (22 recomendado)
- Una aplicación de bot en el [Discord Developer Portal](https://discord.com/developers/applications)
- FFmpeg y yt-dlp se instalan solos con `npm install` (`ffmpeg-static`, `youtube-dl-exec`)

## Puesta en marcha

### 1. Crear el bot en Discord

1. **New Application → Bot → Reset Token**. Copia el token.
2. En **Bot → Privileged Gateway Intents**, activa *Message Content* solo si quieres usar `Juan pon ...` sin mención (ver [Intents](#intents-y-permisos)).
3. **OAuth2 → URL Generator**: scopes `bot` y `applications.commands`; permisos *Connect*, *Speak*, *Send Messages*, *Embed Links*, *Read Message History* y *Set Voice Channel Status*.
4. Abre la URL generada e invita el bot a tu servidor.
5. Copia el **Application ID** (General Information).

### 2. Configurar

```bash
cp .env.example .env
```

Rellena al menos `DISCORD_TOKEN` y `DISCORD_CLIENT_ID`. El resto es opcional:

| Variable | Para qué |
| --- | --- |
| `DISCORD_GUILD_ID` | Registra los slash commands solo en ese servidor (al instante; útil en desarrollo) |
| `WAKE_WORD` | Palabra de activación en el chat. Por defecto `Juan` |
| `MUSIC_CHANNEL_ID` | Canal de texto donde se pueden escribir `pon`, `skip`, `cola` sin prefijo |
| `DEFAULT_VOLUME` | Volumen inicial, 0-150. Por defecto 50 |
| `YOUTUBE_COOKIES` | Ruta a un `cookies.txt` de YouTube. Si dejas `cookies.txt` en la carpeta del proyecto se usa solo |
| `MESSAGE_CONTENT_INTENT` | `false` para arrancar sin el intent privilegiado *Message Content* |
| `OPUS_BITRATE_KBPS`, `OPUS_FEC` | Ajustes del codificador de audio. Por defecto 96 kbps sin FEC |
| `PRIVACY_URL`, `TERMS_URL`, `SUPPORT_URL` | Enlaces que se muestran en `/ayuda` |
| `IDLE_LEAVE_MS`, `EMPTY_LEAVE_MS`, `MAX_QUEUE` | Tiempo sin música o sin gente antes de salir, y tamaño máximo de la cola |

### 3. Arrancar

```bash
npm install
npm start
```

En desarrollo, con recarga automática: `npm run dev`.

## Cómo se usa

Métete a un canal de voz y pide una canción. Juan responde con el panel de reproducción:

```
▶ Sonando ahora                       ┌────────┐
Tití Me Preguntó                      │ carátula│
Bad Bunny - Topic                     └────────┘
██████░░░░░░ 1:12 / 4:03

Pedida por @usuario
En cola 3 canciones · 12 min
Siguiente Moscow Mule 4:05
Repetir: No · Volumen: 50% · Se actualiza cada 12 s

[⏮] [⏸ Pausa] [⏭ Saltar] [⏹ Parar]
[🔀 Mezclar] [🔁 Repetir] [📃 Cola] [➕ Añadir]
```

- El panel aparece en el chat desde el que pediste la música y se mueve al final del canal cuando empieza una canción, para que no se pierda entre la conversación.
- **📃 Cola** abre la lista con paginación y un menú para quitar canciones sin contar posiciones.
- `/sonando` vuelve a traer el panel al canal donde lo escribas.

### Comandos

| Slash | En el chat |
| --- | --- |
| `/play`, `/add` canción o enlace | `Juan pon ...` · `Juan añade ...` · pegar un enlace de YouTube |
| `/buscar salsa` | `Juan busca salsa` y elegir en el menú |
| `/skip`, `/next`, `/pausa`, `/seguir`, `/stop` | `Juan skip` · `Juan pausa` · `Juan sigue` · `Juan para` |
| `/cola`, `/sonando` | `Juan cola` · `Juan qué suena` |
| `/mezclar`, `/repetir`, `/volumen 80` | `Juan mezcla` · `Juan repite cola` · `Juan volumen 80` |
| `/quitar 3`, `/limpiar` | `Juan quita 3` · `Juan limpia` |
| `/unirme`, `/salir` | `Juan ven` · `Juan salte` |
| `/ayuda` | `Juan ayuda` o solo `Juan` |

Todo lo que funciona con `Juan ...` funciona también mencionando al bot: `@Juan pon ...`.

## Intents y permisos

- **Message Content** es un intent privilegiado. Solo hace falta para `Juan pon ...` sin mención y para los comandos sin prefijo en `MUSIC_CHANNEL_ID`. Con `MESSAGE_CONTENT_INTENT=false` el bot funciona igual con slash commands, botones y `@Juan ...`, y no hay que justificarlo al verificar la app.
- **Set Voice Channel Status** permite escribir la canción bajo el nombre del canal de voz. Sin él, el bot lo avisa una vez en el log y sigue funcionando.
- No usa los intents *Presence* ni *Server Members*.

## Si YouTube pide "confirmar que no eres un bot"

Ocurre sobre todo al ejecutar el bot en un servidor (IP de centro de datos). Exporta las cookies de una sesión de YouTube en formato Netscape (por ejemplo con la extensión *Get cookies.txt LOCALLY*, preferiblemente desde una cuenta secundaria) y guárdalas como `cookies.txt` en la carpeta del proyecto. El bot las detecta solo. El archivo está en `.gitignore`: nunca lo subas.

## Desplegar en un servidor Linux

En `deploy/` hay lo necesario para dejarlo corriendo 24/7 en cualquier VM Ubuntu (por ejemplo, una instancia *Always Free* de Oracle Cloud) como servicio systemd que se reinicia solo:

- `deploy/setup.sh`: instala Node, ffmpeg y dependencias, compila y registra el servicio `juan`.
- `deploy/juan.service`: unidad de systemd.
- `deploy/upload.ps1`: desde Windows, compila, sube el proyecto por SSH y reinicia el servicio.

```powershell
# Primera vez: sube e instala
.\deploy\upload.ps1 -VmHost <ip-de-la-vm> -Setup

# Siguientes despliegues
.\deploy\upload.ps1 -VmHost <ip-de-la-vm>
```

Logs en vivo en la VM: `journalctl -u juan -f`.

## Verificación de Discord

Discord exige verificar las apps que superan 100 servidores. El bot cumple la parte técnica: funciona sin intents privilegiados, responde a las interacciones en menos de 3 segundos, no guarda datos y tiene [política de privacidad](PRIVACY.md) y [términos](TERMS.md). Lo demás se hace en el Developer Portal: descripción, enlaces legales, permisos mínimos, verificación en dos pasos y verificación de identidad cuando el bot llega a 75 servidores.

Ten en cuenta que reproducir audio de YouTube está fuera de sus condiciones de servicio. Para un bot personal no suele ser un problema, pero es un riesgo si crece mucho.

## Estructura del proyecto

```
src/
  index.ts              arranque, cliente de Discord, señales
  config.ts             variables de entorno
  audio/
    player.ts           cola, reproducción, panel, estado del canal de voz
    musicPlayer.ts      búsqueda y stream (yt-dlp + ffmpeg + opus)
    audioPick.ts        ranking para elegir el audio oficial
  discord/
    handlers.ts         slash commands, botones, menús, mensajes
    embeds.ts           todos los embeds
    controls.ts         botones y menús
    intent.ts           interpretación de "Juan pon ..."
    voiceStatus.ts      estado del canal de voz y emoji de la app
deploy/                 scripts para servidor Linux
assets/                 emoji de la app
```
