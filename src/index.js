import "dotenv/config";
import { createBot, startBot } from "./bot.js";
import { startDashboard } from "./dashboard.js";
import { initializeSettings, initializeStore } from "./store.js";

function required(name, minimumLength = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} es obligatorio y debe tener al menos ${minimumLength} caracteres.`);
  }
  return value;
}

async function main() {
  const legacyGuildId = process.env.GUILD_ID?.trim() || null;
  const config = {
    botToken: required("BOT_TOKEN"),
    clientId: required("CLIENT_ID"),
    guildId: legacyGuildId,
    oauthClientSecret: required("DISCORD_CLIENT_SECRET"),
    publicUrl: required("PUBLIC_URL"),
    sessionSecret: required("SESSION_SECRET", 32),
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || "127.0.0.1",
    ticketCategoryId: legacyGuildId ? process.env.TICKET_CATEGORY_ID?.trim() || null : null,
    ticketPanelChannelId: null,
    logChannelId: legacyGuildId ? process.env.LOG_CHANNEL_ID?.trim() || null : null,
    openedLogChannelId: null,
    staffRoleId: legacyGuildId ? process.env.STAFF_ROLE_ID?.trim() || null : null,
    botNickname: "",
    botAvatarUrl: "",
    supportRoleIds: [],
    blockedRoleIds: [],
    maxActiveTickets: 500,
    maxActiveTicketsPerUser: 1,
    closeRequiresSupportRole: false,
    closeRequiresReason: false,
    defaultCloseReason: "",
    dmUserOnClose: true,
    pingSupportRoles: false,
    pingAuthorOnClaim: false,
    claimMode: "enabled-private",
    panelTitle: "Soporte de Hypersex Go",
    panelDescription: "Pulsa el botón para abrir un canal privado con el equipo de soporte.",
    panelContent: "",
    panelImageUrl: "",
    panelButtonLabel: "Crear ticket",
    panelColor: "#1677ff",
    panelLinks: [],
    nodeEnv: process.env.NODE_ENV || "development",
    trustProxy: process.env.TRUST_PROXY === "1" ? 1 : false,
  };
  const publicUrl = new URL(config.publicUrl);
  if (publicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_URL debe ser una URL HTTPS pública para el inicio de sesión con Discord.");
  }
  config.publicUrl = publicUrl.origin;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("PORT debe ser un puerto válido entre 1 y 65535.");
  }

  await initializeStore();
  await initializeSettings(config);
  const client = createBot(config);
  await startBot(client, config);
  startDashboard(client, config);
}

main().catch((error) => {
  console.error("No se pudo iniciar Hypersex Go:", error);
  process.exitCode = 1;
});
