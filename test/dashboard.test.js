import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import path from "node:path";
import { normalizeSettings, startDashboard } from "../src/dashboard.js";
import { initializeSettings } from "../src/store.js";

let server;
let baseUrl;
let cookie;
let csrfToken;
let guilds;
const ids = {
  guild: "90000000000000001",
  otherGuild: "90000000000000002",
  privateGuild: "90000000000000003",
  category: "11111111111111111",
  panel: "22222222222222222",
  logs: "33333333333333333",
  role: "44444444444444444",
};
let panelMessageCount;
let lastPanelPayload;

before(async () => {
  panelMessageCount = 0;
  lastPanelPayload = null;
  const channels = new Map([
    [ids.category, { id: ids.category, name: "Tickets", type: ChannelType.GuildCategory }],
    [ids.panel, makeTextChannel(ids.panel, "soporte")],
    [ids.logs, makeTextChannel(ids.logs, "transcripciones")],
  ]);
  const roles = new Map([[ids.role, { id: ids.role, name: "Soporte", managed: false }]]);
  const guild = makeGuild(ids.guild, "Servidor de prueba", channels, roles);
  guilds = new Map([[ids.guild, guild]]);
  const client = {
    isReady: () => true,
    guilds: {
      cache: guilds,
      fetch: async (id) => guilds.get(id),
    },
  };
  const config = {
    sessionSecret: "a-session-secret-with-more-than-32-characters",
    oauthClientSecret: "test-oauth-secret",
    publicUrl: "https://dashboard.example.test",
    clientId: "55555555555555555",
    port: 0,
    host: "127.0.0.1",
    trustProxy: false,
    nodeEnv: "test",
    guildId: null,
    ticketCategoryId: ids.category,
    ticketPanelChannelId: ids.panel,
    logChannelId: ids.logs,
    staffRoleId: ids.role,
    panelTitle: "Ayuda de la comunidad",
    panelDescription: "Cuéntanos qué necesitas.",
    panelContent: "Estamos para ayudar.",
    panelImageUrl: "https://example.com/support.png",
    panelButtonLabel: "Abrir un caso",
    panelColor: "#ab78de",
    panelLinks: [{ label: "Reglas", url: "https://example.com/rules" }],
    discordFetch: async (url) => {
      if (url.endsWith("/oauth2/token")) return jsonResponse({ access_token: "mock-access-token" });
      if (url.endsWith("/users/@me")) {
        return jsonResponse({ id: "77777777777777777", username: "admin", global_name: "Admin" });
      }
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([
          { id: ids.guild, name: "Servidor de prueba", owner: false, permissions: `${PermissionFlagsBits.ManageGuild}` },
          { id: ids.otherGuild, name: "Bot no instalado", owner: true, permissions: "0" },
          { id: ids.privateGuild, name: "Sin permisos", owner: false, permissions: "0" },
        ]);
      }
      throw new Error("Unexpected Discord API request.");
    },
  };
  await initializeSettings(config);
  server = startDashboard(client, config);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("ticket settings validate limits, booleans, and server role selections", () => {
  const settings = normalizeSettings({
    ticketCategoryId: ids.category,
    ticketPanelChannelId: ids.panel,
    logChannelId: ids.logs,
    openedLogChannelId: "",
    staffRoleId: ids.role,
    supportRoleIds: [ids.role, ids.role],
    blockedRoleIds: [],
    maxActiveTickets: 25,
    maxActiveTicketsPerUser: 3,
    closeRequiresSupportRole: true,
    closeRequiresReason: true,
    defaultCloseReason: "Resuelto",
    dmUserOnClose: false,
    pingSupportRoles: true,
    pingAuthorOnClaim: true,
    claimMode: "private",
    panelTitle: "Ayuda",
    panelDescription: "",
    panelContent: "",
    panelImageUrl: "",
    panelButtonLabel: "Abrir ticket",
    panelColor: "#1677ff",
    panelLinks: [],
  });
  assert.equal(settings.maxActiveTickets, 25);
  assert.deepEqual(settings.supportRoleIds, [ids.role]);
  assert.equal(settings.claimMode, "private");
  assert.throws(
    () => normalizeSettings({ maxActiveTickets: 501 }),
    (error) => error.status === 400,
    "server ticket limits must remain within the supported range",
  );
  assert.throws(
    () => normalizeSettings({ supportRoleIds: ["not-a-discord-role-id"] }),
    (error) => error.status === 400,
    "role selections must be Discord snowflakes",
  );
});

test("Discord OAuth scopes dashboard access to manageable, installed guilds", async () => {
  let response = await fetch(`${baseUrl}/api/tickets`);
  assert.equal(response.status, 401);

  response = await fetch(`${baseUrl}/auth/discord`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const authorizationUrl = new URL(response.headers.get("location"));
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://dashboard.example.test/auth/discord/callback");
  assert.equal(authorizationUrl.searchParams.get("scope"), "identify guilds");
  cookie = sessionCookie(response);
  assert.match(response.headers.get("set-cookie"), /SameSite=Lax/i);

  response = await fetch(
    `${baseUrl}/auth/discord/callback?code=mock-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}`,
    { headers: { cookie }, redirect: "manual" },
  );
  assert.equal(response.status, 302);
  cookie = sessionCookie(response);

  response = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const me = await response.json();
  csrfToken = me.csrfToken;
  assert.equal(me.user.username, "Admin");

  response = await fetch(`${baseUrl}/api/guilds`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const availableGuilds = (await response.json()).guilds;
  assert.equal(availableGuilds.length, 2, "servers without management permission must be hidden");
  assert.equal(availableGuilds.find((guild) => guild.id === ids.guild).botPresent, true);
  const inviteUrl = new URL(availableGuilds.find((guild) => guild.id === ids.otherGuild).inviteUrl);
  assert.equal(inviteUrl.searchParams.get("guild_id"), ids.otherGuild);
  assert.equal(inviteUrl.searchParams.get("scope"), "bot applications.commands");

  response = await post("/api/select-guild", { guildId: ids.otherGuild });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/tickets`, { headers: { cookie } });
  assert.equal(response.status, 409);

  const installedInviteUrl = new URL(availableGuilds.find((guild) => guild.id === ids.guild).inviteUrl);
  assert.equal(installedInviteUrl.searchParams.get("guild_id"), ids.guild);
  assert.equal(installedInviteUrl.searchParams.get("scope"), "bot applications.commands");

  response = await post("/api/select-guild", { guildId: ids.privateGuild });
  assert.equal(response.status, 403);
  response = await post("/api/select-guild", { guildId: ids.guild });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
  assert.equal((await response.json()).selectedGuildId, ids.guild);

  response = await fetch(`${baseUrl}/api/tickets`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).summary, { total: 0, open: 0, closed: 0 });

  response = await fetch(`${baseUrl}/api/settings/options`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const options = await response.json();
  assert.equal(options.guildName, "Servidor de prueba");
  assert.equal(options.settings.panelTitle, "Ayuda de la comunidad");
  assert.deepEqual(options.categories, [{ id: ids.category, name: "Tickets" }]);
  assert.deepEqual(options.textChannels.map((channel) => channel.id), [ids.panel, ids.logs]);
  assert.deepEqual(options.roles, [{ id: ids.role, name: "Soporte" }]);

  response = await put("/api/settings", {
    ticketCategoryId: ids.panel,
    ticketPanelChannelId: ids.panel,
    logChannelId: ids.logs,
    staffRoleId: ids.role,
    panelTitle: "Ayuda",
    panelDescription: "",
    panelContent: "",
    panelImageUrl: "",
    panelButtonLabel: "Abrir ticket",
    panelColor: "#8f6acb",
    panelLinks: [],
  });
  assert.equal(response.status, 400, "a text channel must not be accepted as a ticket category");

  response = await put("/api/settings", {
    ticketCategoryId: ids.category,
    ticketPanelChannelId: ids.panel,
    logChannelId: ids.logs,
    staffRoleId: ids.role,
    panelTitle: "Ayuda",
    panelDescription: "",
    panelContent: "",
    panelImageUrl: "",
    panelButtonLabel: "Abrir ticket",
    panelColor: "#8f6acb",
    panelLinks: [{ label: "Reglas", url: "javascript:alert(1)" }],
  });
  assert.equal(response.status, 400, "only safe HTTP or HTTPS button links are accepted");

  response = await fetch(`${baseUrl}/api/settings/publish-panel`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrfToken },
  });
  assert.equal(response.status, 200);
  assert.equal(panelMessageCount, 1);
  assert.equal(lastPanelPayload.content, "Estamos para ayudar.");
  assert.equal(lastPanelPayload.embeds[0].data.title, "Ayuda de la comunidad");
  assert.equal(lastPanelPayload.embeds[0].data.description, "Cuéntanos qué necesitas.");
  assert.equal(lastPanelPayload.embeds[0].data.image.url, "https://example.com/support.png");
  assert.deepEqual(
    lastPanelPayload.components[0].components.map((button) => button.data.label),
    ["Abrir un caso", "Reglas"],
  );

  const sessionId = decodeURIComponent(cookie.split("=")[1]).slice(2).split(".")[0];
  const sessionFile = path.resolve("data", "sessions", `${sessionId}.json`);
  assert.equal(await fileExists(sessionFile), true);
  assert.equal(JSON.parse(await readFile(sessionFile, "utf8")).discordUser.id, "77777777777777777");
  response = await post("/api/logout");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Expires=/i);
  assert.equal(await fileExists(sessionFile), false);
  response = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
  assert.equal(response.status, 401, "the old session cookie must no longer authenticate");
  response = await fetch(`${baseUrl}/api/tickets`);
  assert.equal(response.status, 401);
});

function makeGuild(id, name, channels, roles) {
  return {
    id,
    name,
    channels: { cache: channels, fetch: async (channelId) => (channelId ? channels.get(channelId) : channels) },
    roles: { cache: roles, fetch: async () => roles },
    members: { me: {} },
  };
}

function makeTextChannel(id, name) {
  return {
    id,
    name,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      panelMessageCount += 1;
      lastPanelPayload = payload;
    },
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function sessionCookie(response) {
  const value = response.headers.getSetCookie().find((header) => header.startsWith("hypersex.sid="));
  assert.ok(value, "expected the dashboard to set a session cookie");
  return value.split(";")[0];
}

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function put(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
    body: JSON.stringify(body),
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
