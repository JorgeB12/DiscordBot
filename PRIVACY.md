# Política de privacidad de Bemol

*Última actualización: 6 de septiembre de 2026*

Bemol es un bot de música para Discord. Esta política explica qué información trata y cómo.

## Qué información trata Bemol

Mientras está en un canal de voz, Bemol mantiene en memoria, solo durante la sesión:

- La cola de reproducción: título, enlace y duración de cada canción.
- Quién pidió cada canción: tu ID de usuario de Discord, tu nombre visible en el servidor y la URL de tu avatar, para mostrar "Pedida por" en el panel.
- El canal de voz y el canal de texto en los que está trabajando.

Esa información se borra cuando Bemol sale del canal de voz o se vacía la cola. Para poder reanudar la música tras un reinicio, la cola y el canal se guardan temporalmente y se eliminan en cuanto se reanuda o se descarta.

Además, Bemol guarda de forma permanente, **solo lo que tú creas a propósito**:

- **Tus playlists y favoritos**: nombre de la playlist, las canciones (título, enlace, duración, canal de YouTube), tu ID de usuario y tu nombre visible en el momento de crearla. Se guardan para que puedas usarlos en cualquier servidor y hasta que los borres con `/playlist eliminar` o `/favoritos quitar`.
- **La configuración de cada servidor**: DJs (IDs de usuario), volumen inicial, modo 24/7, tiempos de auto-desconexión, votación para saltar y canal de música, elegidos por los administradores con `/config`.

No guarda historial de reproducción ni contenido de mensajes.

## Mensajes

Bemol solo lee los mensajes necesarios para funcionar:

- Los slash commands (`/play`, `/skip`, etc.) y las pulsaciones de botones y menús.
- Los mensajes que lo mencionan (`@Bemol pon ...`) o que empiezan por su palabra de activación, únicamente para interpretar la orden.

No almacena el contenido de los mensajes, no los analiza con fines distintos a ejecutar la orden y no lee mensajes privados.

## Registros técnicos

El servidor donde corre Bemol guarda registros técnicos (logs) para diagnosticar errores. Pueden incluir el título de la canción pedida y el ID del servidor. No incluyen el contenido de conversaciones. Estos registros se rotan automáticamente y no se comparten con nadie.

## Servicios de terceros

Para reproducir música, Bemol consulta **YouTube** y descarga el audio de la canción pedida. En esa consulta YouTube recibe la búsqueda o el enlace, pero **no recibe ningún dato tuyo de Discord**. El uso de YouTube está sujeto a sus propias condiciones y política de privacidad.

Bemol no usa servicios de analítica, publicidad ni seguimiento.

## Con quién se comparte

Con nadie. Bemol no vende, cede ni comparte información con terceros.

## Tus derechos

Puedes ver y borrar tus playlists y favoritos en cualquier momento desde el propio bot (`/playlist lista`, `/playlist eliminar`, `/favoritos ver`, `/favoritos quitar`). Los administradores pueden restablecer la configuración de su servidor con `/config reiniciar`. Si quieres que se elimine todo lo asociado a tu cuenta, contacta con el responsable del bot en el servidor de soporte indicado en `/ayuda`.

## Cambios

Si esta política cambia, se actualizará la fecha de este documento y se anunciará en el servidor de soporte.
