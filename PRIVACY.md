# Política de privacidad de Juan

*Última actualización: 4 de septiembre de 2026*

Juan es un bot de música para Discord. Esta política explica qué información trata y cómo.

## Qué información trata Juan

Juan **no tiene base de datos** y **no guarda información de forma permanente**. Mientras está en un canal de voz mantiene en memoria, solo durante la sesión:

- La cola de reproducción: título, enlace y duración de cada canción.
- Quién pidió cada canción: tu ID de usuario de Discord, tu nombre visible en el servidor y la URL de tu avatar, para mostrar "Pedida por" en el panel.
- El canal de voz y el canal de texto en los que está trabajando.

Toda esa información se borra cuando Juan sale del canal de voz, cuando se vacía la cola o cuando el bot se reinicia.

## Mensajes

Juan solo lee los mensajes necesarios para funcionar:

- Los slash commands (`/play`, `/skip`, etc.) y las pulsaciones de botones y menús.
- Los mensajes que lo mencionan (`@Juan pon ...`) o que empiezan por su palabra de activación, únicamente para interpretar la orden.

No almacena el contenido de los mensajes, no los analiza con fines distintos a ejecutar la orden y no lee mensajes privados.

## Registros técnicos

El servidor donde corre Juan guarda registros técnicos (logs) para diagnosticar errores. Pueden incluir el título de la canción pedida y el ID del servidor. No incluyen el contenido de conversaciones. Estos registros se rotan automáticamente y no se comparten con nadie.

## Servicios de terceros

Para reproducir música, Juan consulta **YouTube** y descarga el audio de la canción pedida. En esa consulta YouTube recibe la búsqueda o el enlace, pero **no recibe ningún dato tuyo de Discord**. El uso de YouTube está sujeto a sus propias condiciones y política de privacidad.

Juan no usa servicios de analítica, publicidad ni seguimiento.

## Con quién se comparte

Con nadie. Juan no vende, cede ni comparte información con terceros.

## Tus derechos

Como Juan no conserva datos, no hay nada que solicitar ni borrar: al salir del canal de voz o expulsar al bot del servidor, la información en memoria desaparece. Si tienes dudas, contacta con el responsable del bot en el servidor de soporte indicado en `/ayuda`.

## Cambios

Si esta política cambia, se actualizará la fecha de este documento y se anunciará en el servidor de soporte.
