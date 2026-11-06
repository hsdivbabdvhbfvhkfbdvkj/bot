import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import rateLimit from "express-rate-limit";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import helmet from "helmet";
import path from "node:path";
import { closeOpenTicketById, getTicketSummary, publishTicketPanel } from "./bot.js";
import { getGuildSettings, listTickets, saveSettings } from "./store.js";

const BOT_PERMISSIONS = (117776n | PermissionFlagsBits.ManageNicknames).toString();

export function startDashboard(client, config) {
  const app = express();
  const FileStore = FileStoreFactory(session);
  const discordFetch = config.discordFetch || globalThis.fetch;
  const invalidatedSessions = new Map();
  const sessionStore = new FileStore({
    path: path.resolve("data", "sessions"),
    ttl: 60 * 60 * 24,
    retries: 0,
    reapInterval: 60 * 60,
  });

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(helmet());
  app.use(express.json({ limit: "10kb" }));
  app.use(
    session({
      name: "hypersex.sid",
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      unset: "destroy",
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.nodeEnv === "production",
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );
  app.use((req, _res, next) => {
    const expiresAt = invalidatedSessions.get(req.sessionID);
    if (expiresAt) {
      if (expiresAt > Date.now()) {
        req.sessionInvalidated = true;
      } else {
        invalidatedSessions.delete(req.sessionID);
      }
    }
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." },
  });

  app.get("/api/auth-config", (_req, res) => {
    res.json({ oauthReady: Boolean(config.oauthClientSecret && config.publicUrl) });
  });

  app.get("/auth/discord", loginLimiter, (req, res, next) => {
    if (!config.oauthClientSecret || !config.publicUrl) {
      res.status(503).send("Configura DISCORD_CLIENT_SECRET y PUBLIC_URL para activar el inicio de sesión con Discord.");
      return;
    }
    const state = randomBytes(32).toString("hex");
    req.session.oauthState = state;
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl(config));
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "identify guilds");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("prompt", "consent");
    req.session.save((error) => {
      if (error) {
        next(error);
        return;
      }
      res.redirect(authorize.toString());
    });
  });

  app.get("/auth/discord/callback", async (req, res, next) => {
    try {
      if (req.query.error) {
        res.redirect("/?login=cancelled");
        return;
      }
      if (
        typeof req.query.code !== "string" ||
        typeof req.query.state !== "string" ||
        !safeEqual(req.query.state, req.session.oauthState || "")
      ) {
        res.status(400).send("La validación de inicio de sesión falló. Vuelve al dashboard e inténtalo otra vez.");
        return;
      }
      delete req.session.oauthState;
      const tokenResponse = await discordFetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.oauthClientSecret,
          grant_type: "authorization_code",
          code: req.query.code,
          redirect_uri: callbackUrl(config),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenResponse.ok) {
        throw new Error(`Discord rechazó el inicio de sesión OAuth (${tokenResponse.status}).`);
      }
      const tokenData = await tokenResponse.json();
      if (typeof tokenData.access_token !== "string") {
        throw new Error("Discord no devolvió un token de acceso válido.");
      }
      const headers = { Authorization: `Bearer ${tokenData.access_token}` };
      const [userResponse, guildsResponse] = await Promise.all([
        discordFetch("https://discord.com/api/v10/users/@me", {
          headers,
          signal: AbortSignal.timeout(10_000),
        }),
        discordFetch("https://discord.com/api/v10/users/@me/guilds", {
          headers,
          signal: AbortSignal.timeout(10_000),
        }),
      ]);
      if (!userResponse.ok || !guildsResponse.ok) {
        throw new Error("No se pudieron leer los permisos de servidor de Discord.");
      }
      const user = await userResponse.json();
      const guilds = await guildsResponse.json();
      if (!user || typeof user.id !== "string" || !Array.isArray(guilds)) {
        throw new Error("Discord devolvió una respuesta no válida.");
      }

      await regenerateSession(req);
      req.session.discordUser = {
        id: user.id,
        username: user.global_name || user.username,
        avatar: user.avatar,
      };
      req.session.discordGuilds = guilds
        .filter(canManageGuild)
        .map(({ id, name, icon, owner, permissions }) => ({ id, name, icon, owner, permissions }));
      req.session.csrfToken = randomBytes(32).toString("hex");
      await saveSession(req);
      res.redirect("/");
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/me", (req, res) => {
    if (req.sessionInvalidated || !req.session.discordUser) {
      res.status(401).json({ error: "Inicia sesión con Discord para continuar." });
      return;
    }
    res.json({
      authenticated: true,
      csrfToken: req.session.csrfToken,
      user: req.session.discordUser,
      selectedGuildId: req.session.selectedGuildId || null,
    });
  });

  app.get("/api/guilds", requireAuth, (req, res) => {
    if (!client.isReady()) {
      res.status(503).json({ error: "El bot todavía se está conectando a Discord. Actualiza el panel en unos segundos." });
      return;
    }
    res.json({
      guilds: manageableGuilds(req).map((guild) => ({
        ...guild,
        botPresent: Boolean(client.guilds.cache.has(guild.id)),
        inviteUrl: botInviteUrl(config, guild.id),
      })),
    });
  });

  app.post("/api/select-guild", requireAuth, requireCsrf, (req, res, next) => {
    const guild = manageableGuilds(req).find((item) => item.id === req.body?.guildId);
    if (!guild) {
      res.status(403).json({ error: "No tienes permiso para administrar ese servidor." });
      return;
    }
    req.session.selectedGuildId = guild.id;
    req.session.save((error) => {
      if (error) {
        next(error);
        return;
      }
      res.json({ ok: true, guildId: guild.id, botPresent: client.guilds.cache.has(guild.id) });
    });
  });

  app.get("/api/tickets", requireAuth, (req, res) => {
    const guildId = requireSelectedGuild(req, client, res);
    if (!guildId) return;
    const tickets = listTickets().filter((ticket) => ticket.guildId === guildId);
    res.json({ summary: getTicketSummary(tickets), tickets });
  });

  app.get("/api/settings/options", requireAuth, async (req, res, next) => {
    try {
      if (!client.isReady()) {
        res.status(503).json({ error: "El bot todavía se está conectando a Discord." });
        return;
      }
      const guildId = requireSelectedGuild(req, client, res);
      if (!guildId) return;
      const guild = await getConfiguredGuild(client, guildId);
      const [channels, roles] = await Promise.all([getGuildChannels(guild), getGuildRoles(guild)]);
      res.json({
        guildName: guild.name,
        settings: settingsFrom(getGuildSettings(guildId)),
        categories: [...channels.values()]
          .filter((channel) => channel.type === ChannelType.GuildCategory)
          .map(({ id, name }) => ({ id, name }))
          .sort(byName),
        textChannels: [...channels.values()]
          .filter((channel) => channel.type === ChannelType.GuildText)
          .map(({ id, name }) => ({ id, name }))
          .sort(byName),
        roles: [...roles.values()]
          .filter((role) => role.id !== guild.id && !role.managed)
          .map(({ id, name }) => ({ id, name }))
          .sort(byName),
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/settings", requireAuth, requireCsrf, async (req, res, next) => {
    try {
      if (!client.isReady()) {
        res.status(503).json({ error: "El bot todavía se está conectando a Discord." });
        return;
      }
      const guildId = requireSelectedGuild(req, client, res);
      if (!guildId) return;
      const currentSettings = getGuildSettings(guildId);
      const settings = normalizeSettings(req.body, currentSettings);
      const guild = await getConfiguredGuild(client, guildId);
      const [channels, roles] = await Promise.all([getGuildChannels(guild), getGuildRoles(guild)]);

      if (settings.ticketCategoryId && channels.get(settings.ticketCategoryId)?.type !== ChannelType.GuildCategory) {
        res.status(400).json({ error: "La categoría seleccionada no pertenece a este servidor." });
        return;
      }
      for (const [field, label] of [
        ["ticketPanelChannelId", "El canal del panel"],
        ["logChannelId", "El canal de transcripciones"],
        ["openedLogChannelId", "El canal de avisos de apertura"],
      ]) {
        const channelId = settings[field];
        if (!channelId) continue;
        const channel = channels.get(channelId);
        if (channel?.type !== ChannelType.GuildText) {
          res.status(400).json({ error: `${label} debe ser un canal de texto de este servidor.` });
          return;
        }
        if (!canSendMessages(channel, guild)) {
          res.status(400).json({ error: `El bot necesita permiso para enviar mensajes en ${label.toLowerCase()}.` });
          return;
        }
        if (field === "ticketPanelChannelId" && !canEmbedLinks(channel, guild)) {
          res.status(400).json({ error: "El bot necesita permiso para insertar enlaces en el canal del panel." });
          return;
        }
      }
      if (
        (settings.staffRoleId && !roles.has(settings.staffRoleId)) ||
        [...settings.supportRoleIds, ...settings.blockedRoleIds].some((roleId) => !roles.has(roleId))
      ) {
        res.status(400).json({ error: "El rol seleccionado no pertenece a este servidor." });
        return;
      }

      if (settings.botNickname !== (currentSettings.botNickname || "")) {
        const botMember = guild.members.me;
        if (!botMember?.permissions?.has(PermissionFlagsBits.ManageNicknames)) {
          res.status(400).json({
            error: "El bot necesita el permiso Administrar apodos. Actívalo para su rol en Ajustes del servidor > Roles y vuelve a intentarlo.",
          });
          return;
        }
        await botMember.setNickname(settings.botNickname || null);
      }

      await saveSettings(guildId, settings);
      res.json({ ok: true, settings });
    } catch (error) {
      if (error.status === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post("/api/settings/publish-panel", requireAuth, requireCsrf, async (req, res, next) => {
    try {
      if (!client.isReady()) {
        res.status(503).json({ error: "El bot todavía se está conectando a Discord." });
        return;
      }
      const guildId = requireSelectedGuild(req, client, res);
      if (!guildId) return;
      const settings = getGuildSettings(guildId);
      if (!settings.ticketPanelChannelId) {
        res.status(400).json({ error: "Primero selecciona y guarda el canal donde irá el panel." });
        return;
      }
      const guild = await getConfiguredGuild(client, guildId);
      const channel = await guild.channels.fetch(settings.ticketPanelChannelId);
      if (
        channel?.type !== ChannelType.GuildText ||
        !canSendMessages(channel, guild) ||
        !canEmbedLinks(channel, guild)
      ) {
        res.status(400).json({ error: "El canal configurado no es válido o el bot no puede enviar mensajes allí." });
        return;
      }
      await publishTicketPanel(channel, settings);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tickets/:channelId/close", requireAuth, requireCsrf, async (req, res, next) => {
    try {
      if (!client.isReady()) {
        res.status(503).json({ error: "El bot todavía se está conectando a Discord." });
        return;
      }
      const guildId = requireSelectedGuild(req, client, res);
      if (!guildId) return;
      const ticket = listTickets().find(
        (item) => item.channelId === req.params.channelId && item.guildId === guildId && item.status === "open",
      );
      if (!ticket) {
        res.status(404).json({ error: "No se encontró un ticket abierto en este servidor." });
        return;
      }
      await closeOpenTicketById(client, ticket.channelId, "dashboard");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/logout", requireAuth, requireCsrf, (req, res, next) => {
    const sessionId = req.sessionID;
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    invalidatedSessions.set(sessionId, expiresAt);
    const cleanupTimer = setTimeout(() => {
      if (invalidatedSessions.get(sessionId) === expiresAt) {
        invalidatedSessions.delete(sessionId);
      }
    }, 8 * 60 * 60 * 1000);
    cleanupTimer.unref();
    req.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      res.clearCookie("hypersex.sid");
      res.json({ ok: true });
    });
  });

  app.use(express.static(path.resolve("public"), { index: false }));
  app.get("/", (_req, res) => res.sendFile(path.resolve("public/index.html")));
  app.use((error, req, res, next) => {
    console.error("Error en el dashboard:", error);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({ error: "Ocurrió un error interno. Revisa los registros del bot." });
  });

  const server = app.listen(config.port, config.host, () => {
    console.log(`Dashboard disponible en http://${config.host}:${config.port}`);
  });
  server.on("error", (error) => {
    console.error("No se pudo iniciar el dashboard:", error);
    client.destroy();
    process.exitCode = 1;
  });
  return server;
}

function requireAuth(req, res, next) {
  if (req.sessionInvalidated || !req.session.discordUser) {
    res.status(401).json({ error: "Inicia sesión con Discord para continuar." });
    return;
  }
  next();
}

function requireSelectedGuild(req, client, res) {
  const guildId = req.session.selectedGuildId;
  if (!guildId || !manageableGuilds(req).some((guild) => guild.id === guildId)) {
    res.status(409).json({ error: "Selecciona un servidor que puedas administrar." });
    return null;
  }
  if (!client.guilds.cache.has(guildId)) {
    res.status(409).json({ error: "Añade primero Hypersex Go a este servidor." });
    return null;
  }
  return guildId;
}

function settingsFrom(settings) {
  return {
    ticketCategoryId: settings.ticketCategoryId,
    ticketPanelChannelId: settings.ticketPanelChannelId,
    logChannelId: settings.logChannelId,
    openedLogChannelId: settings.openedLogChannelId,
    staffRoleId: settings.staffRoleId,
    botNickname: settings.botNickname || "",
    botAvatarUrl: settings.botAvatarUrl || "",
    supportRoleIds: settings.supportRoleIds,
    blockedRoleIds: settings.blockedRoleIds,
    maxActiveTickets: settings.maxActiveTickets,
    maxActiveTicketsPerUser: settings.maxActiveTicketsPerUser,
    closeRequiresSupportRole: settings.closeRequiresSupportRole,
    closeRequiresReason: settings.closeRequiresReason,
    defaultCloseReason: settings.defaultCloseReason,
    dmUserOnClose: settings.dmUserOnClose,
    pingSupportRoles: settings.pingSupportRoles,
    pingAuthorOnClaim: settings.pingAuthorOnClaim,
    claimMode: settings.claimMode,
    panelTitle: settings.panelTitle,
    panelDescription: settings.panelDescription,
    panelContent: settings.panelContent,
    panelImageUrl: settings.panelImageUrl,
    panelButtonLabel: settings.panelButtonLabel,
    panelColor: settings.panelColor,
    panelLinks: settings.panelLinks,
  };
}

export function normalizeSettings(body, currentSettings = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("La configuración enviada no es válida."), { status: 400 });
  }
  const settings = {};
  for (const field of ["ticketCategoryId", "ticketPanelChannelId", "logChannelId", "openedLogChannelId", "staffRoleId"]) {
    const value = body[field] ?? currentSettings[field] ?? null;
    if (value === "" || value === null) {
      settings[field] = null;
    } else if (typeof value === "string" && /^\d{17,20}$/.test(value)) {
      settings[field] = value;
    } else {
      throw Object.assign(new Error("Revisa las opciones seleccionadas e inténtalo de nuevo."), { status: 400 });
    }
  }
  for (const field of ["supportRoleIds", "blockedRoleIds"]) {
    const value = body[field] ?? currentSettings[field] ?? [];
    if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id))) {
      throw Object.assign(new Error("La selección de roles no es válida."), { status: 400 });
    }
    settings[field] = [...new Set(value)];
  }
  settings.maxActiveTickets = boundedInteger(
    body.maxActiveTickets ?? currentSettings.maxActiveTickets ?? 500,
    "El límite de tickets del servidor",
    1,
    500,
  );
  settings.maxActiveTicketsPerUser = boundedInteger(
    body.maxActiveTicketsPerUser ?? currentSettings.maxActiveTicketsPerUser ?? 1,
    "El límite de tickets por persona",
    1,
    10,
  );
  for (const field of [
    "closeRequiresSupportRole",
    "closeRequiresReason",
    "dmUserOnClose",
    "pingSupportRoles",
    "pingAuthorOnClaim",
  ]) {
    const value = body[field] ?? currentSettings[field] ?? false;
    if (typeof value !== "boolean") {
      throw Object.assign(new Error("Revisa las opciones activadas o desactivadas."), { status: 400 });
    }
    settings[field] = value;
  }
  settings.defaultCloseReason = optionalText(
    body.defaultCloseReason ?? currentSettings.defaultCloseReason ?? "",
    "El motivo predeterminado",
    500,
  );
  settings.claimMode = body.claimMode ?? currentSettings.claimMode ?? "enabled-private";
  if (!["disabled", "enabled-private", "private", "read-only"].includes(settings.claimMode)) {
    throw Object.assign(new Error("El modo de reclamo seleccionado no es válido."), { status: 400 });
  }
  settings.botNickname = optionalText(body.botNickname ?? currentSettings.botNickname ?? "", "El nombre del bot en este servidor", 32);
  settings.botAvatarUrl = optionalUrl(body.botAvatarUrl ?? currentSettings.botAvatarUrl ?? "", "La imagen del bot para el panel", true, 2048);
  settings.panelTitle = textSetting(body.panelTitle ?? currentSettings.panelTitle, "El título", 256);
  settings.panelDescription = optionalText(body.panelDescription ?? currentSettings.panelDescription ?? "", "La descripción", 4000);
  settings.panelContent = optionalText(body.panelContent ?? currentSettings.panelContent ?? "", "El texto del mensaje", 2000);
  settings.panelImageUrl = optionalUrl(body.panelImageUrl ?? currentSettings.panelImageUrl ?? "", "La imagen", true, 2048);
  settings.panelButtonLabel = textSetting(body.panelButtonLabel ?? currentSettings.panelButtonLabel, "El texto del botón", 80);

  const panelColor = body.panelColor ?? currentSettings.panelColor;
  if (typeof panelColor !== "string" || !/^#[\da-f]{6}$/i.test(panelColor)) {
    throw Object.assign(new Error("El color debe ser un código hexadecimal como #8f6acb."), { status: 400 });
  }
  settings.panelColor = panelColor.toLowerCase();
  const panelLinks = body.panelLinks ?? currentSettings.panelLinks ?? [];
  if (!Array.isArray(panelLinks) || panelLinks.length > 4) {
    throw Object.assign(new Error("Puedes configurar hasta cuatro botones con enlace."), { status: 400 });
  }
  settings.panelLinks = panelLinks.map((link, index) => {
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      throw Object.assign(new Error(`Revisa el botón con enlace ${index + 1}.`), { status: 400 });
    }
    return {
      label: textSetting(link.label, `El texto del botón con enlace ${index + 1}`, 80),
      url: optionalUrl(link.url, `El enlace del botón ${index + 1}`, false, 512),
    };
  });
  return settings;
}

function boundedInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${label} debe ser un número entre ${min} y ${max}.`), { status: 400 });
  }
  return parsed;
}

function textSetting(value, label, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw Object.assign(new Error(`${label} es obligatorio y debe tener como máximo ${maxLength} caracteres.`), {
      status: 400,
    });
  }
  return value.trim();
}

function optionalText(value, label, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw Object.assign(new Error(`${label} no puede superar ${maxLength} caracteres.`), { status: 400 });
  }
  return value.trim();
}

function optionalUrl(value, label, optional = true, maxLength = 2048) {
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${label} debe ser una URL HTTP o HTTPS válida.`), { status: 400 });
  }
  const trimmed = value.trim();
  if (!trimmed && optional) return "";
  if (trimmed.length > maxLength) {
    throw Object.assign(new Error(`${label} supera la longitud máxima permitida.`), { status: 400 });
  }
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Unsupported URL");
    }
    return url.toString();
  } catch {
    throw Object.assign(new Error(`${label} debe ser una URL HTTP o HTTPS válida.`), { status: 400 });
  }
}

function canSendMessages(channel, guild) {
  return Boolean(guild.members.me && channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages));
}

function canEmbedLinks(channel, guild) {
  return Boolean(guild.members.me && channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.EmbedLinks));
}

async function getConfiguredGuild(client, guildId) {
  return client.guilds.cache.get(guildId) || client.guilds.fetch(guildId);
}

async function getGuildChannels(guild) {
  return guild.channels.cache || guild.channels.fetch();
}

async function getGuildRoles(guild) {
  return guild.roles.cache || guild.roles.fetch();
}

function callbackUrl(config) {
  return new URL("/auth/discord/callback", config.publicUrl).toString();
}

function botInviteUrl(config, guildId) {
  const invite = new URL("https://discord.com/oauth2/authorize");
  invite.searchParams.set("client_id", config.clientId);
  invite.searchParams.set("permissions", BOT_PERMISSIONS);
  invite.searchParams.set("scope", "bot applications.commands");
  invite.searchParams.set("guild_id", guildId);
  invite.searchParams.set("disable_guild_select", "true");
  return invite.toString();
}

function manageableGuilds(req) {
  return Array.isArray(req.session.discordGuilds) ? req.session.discordGuilds : [];
}

function canManageGuild(guild) {
  if (guild.owner) return true;
  try {
    const permissions = BigInt(guild.permissions);
    return (
      (permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator ||
      (permissions & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild
    );
  } catch {
    return false;
  }
}

function byName(a, b) {
  return a.name.localeCompare(b.name, "es");
}

function requireCsrf(req, res, next) {
  if (!validCsrf(req)) {
    res.status(403).json({ error: "La sesión expiró o la solicitud no es válida." });
    return;
  }
  next();
}

function validCsrf(req) {
  const supplied = Buffer.from(req.get("x-csrf-token") || "");
  const expected = Buffer.from(req.session.csrfToken || "");
  return supplied.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}
