# Hypersex Go

Bot de tickets de Discord con dashboard web multi-servidor. El dashboard usa Discord OAuth2 y solo muestra servidores donde la cuenta conectada tenga permiso para administrarlos. La configuración de tickets se guarda por servidor.

## Requisitos

- Node.js 20 o posterior.
- Una aplicación de Discord con bot habilitado en [Discord Developer Portal](https://discord.com/developers/applications).
- La opción **Public Bot** activada en el portal para que otros servidores puedan añadirlo.
- `cloudflared` para publicar el dashboard local mediante un túnel HTTPS.
- Permisos del bot: `Manage Channels`, `View Channels`, `Send Messages`, `Embed Links`, `Read Message History` y `Attach Files`.
- Activar **Message Content Intent** en el portal para incluir contenido en transcripciones.

## Configuración

1. Si el token del bot se compartió o guardó en un archivo de ejemplo, restablécelo en **Developer Portal → Bot → Reset Token** antes de iniciar. Guarda el token nuevo solo en `.env`.
2. Copia `.env.example` como `.env` y completa:
   - `BOT_TOKEN`: token actual del bot.
   - `CLIENT_ID`: Application ID.
   - `DISCORD_CLIENT_SECRET`: Client Secret de OAuth2.
   - `SESSION_SECRET`: valor aleatorio de al menos 32 caracteres. Puedes generarlo con `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
3. En una terminal, inicia un túnel temporal:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:3000
   ```

   Copia la URL HTTPS `trycloudflare.com` que muestra Cloudflare y ponla en `PUBLIC_URL`. Si la URL temporal cambia, actualízala también en `PUBLIC_URL` y en la URI de redirección OAuth de Discord.
4. En **Developer Portal → OAuth2**, agrega como Redirect URI:

   ```text
   https://TU-URL-PUBLICA/auth/discord/callback
   ```

5. Deja `HOST=127.0.0.1`, `NODE_ENV=production` y `TRUST_PROXY=1` cuando uses ese túnel.
6. Instala y ejecuta:

   ```powershell
   npm install
   npm start
   ```

Abre la URL HTTPS, inicia sesión con Discord, elige un servidor y, si falta el bot, pulsa **Añadir Hypersex Go**. Los comandos de aplicación se registran globalmente y Discord puede tardar un tiempo en propagarlos.

## Uso del dashboard

El dashboard organiza los ajustes en **Canales**, **Diseño del panel**, **Equipo**, **Reglas** y **Tickets**. Puedes elegir categorías y canales existentes, personalizar el contenido, color e imagen del panel, añadir hasta cuatro botones de enlace y publicar el panel. También configura roles de soporte/bloqueados, límites de apertura, reclamos, motivo y permisos de cierre, transcripciones y avisos. Estos ajustes se guardan por servidor.

La sección **Identidad** permite definir un apodo distinto para el bot en cada servidor (requiere el permiso Administrar apodos) y una imagen para el encabezado del panel de tickets. Discord no permite que un bot cambie su avatar de perfil por servidor mediante la API; el avatar global se modifica desde Developer Portal.

El bot crea canales privados, aplica los límites configurados, permite reclamar/cerrar/reabrir tickets y puede enviar transcripciones al canal elegido. El dashboard muestra estadísticas y tickets recientes. No todas las funciones avanzadas de Ticket King (por ejemplo, formularios multipregunta y varias clases de paneles) están implementadas todavía.

Los tickets y las configuraciones se guardan en `data/`. Las sesiones se guardan localmente y caducan después de un día; la sesión del navegador dura hasta ocho horas.

## Disponibilidad

El bot y el dashboard funcionan en el PC donde se ejecuta `npm start`; seguirán disponibles mientras el PC, Internet, el proceso del bot y el túnel estén activos. Si se detiene o reinicia Cloudflare Quick Tunnel, la URL temporal puede cambiar y habrá que actualizar `PUBLIC_URL` y la Redirect URI de Discord. Vercel no mantiene una conexión persistente de gateway para este montaje.

No expongas directamente el puerto 3000 a Internet. Mantén `.env` privado y no compartas capturas o archivos que muestren tokens o secretos.
