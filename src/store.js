import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDirectory = path.resolve("data");
const dataFile = path.join(dataDirectory, "tickets.json");
const settingsFile = path.join(dataDirectory, "settings.json");
let tickets = [];
let defaultSettings = {};
let settingsByGuild = new Map();
let writeQueue = Promise.resolve();
let settingsWriteQueue = Promise.resolve();

export async function initializeStore() {
  await mkdir(dataDirectory, { recursive: true });

  try {
    const contents = await readFile(dataFile, "utf8");
    const parsed = JSON.parse(contents);
    if (!Array.isArray(parsed)) {
      throw new Error("Ticket data must be a JSON array.");
    }
    tickets = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not load ticket data: ${error.message}`, { cause: error });
    }
    await persist();
  }
}

export async function initializeSettings(config) {
  defaultSettings = { ...config };
  try {
    const savedSettings = JSON.parse(await readFile(settingsFile, "utf8"));
    if (savedSettings.guilds && typeof savedSettings.guilds === "object") {
      settingsByGuild = new Map(Object.entries(savedSettings.guilds));
    } else {
      const { guildId, ...legacySettings } = savedSettings;
      settingsByGuild = new Map([[config.guildId, legacySettings]]);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not load dashboard settings: ${error.message}`, { cause: error });
    }
  }
}

export function getGuildSettings(guildId) {
  const defaults = { ...defaultSettings };
  if (defaultSettings.guildId && guildId !== defaultSettings.guildId) {
    defaults.ticketCategoryId = null;
    defaults.ticketPanelChannelId = null;
    defaults.logChannelId = null;
    defaults.openedLogChannelId = null;
    defaults.staffRoleId = null;
  }
  return { ...defaults, ...(settingsByGuild.get(guildId) || {}) };
}

export async function saveSettings(guildId, settings) {
  settingsByGuild.set(guildId, { ...settings });
  settingsWriteQueue = settingsWriteQueue.catch(() => {}).then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${settingsFile}.tmp`;
    const persistedSettings = { guilds: Object.fromEntries(settingsByGuild) };
    await writeFile(temporaryFile, `${JSON.stringify(persistedSettings, null, 2)}\n`, "utf8");
    await rename(temporaryFile, settingsFile);
  });
  return settingsWriteQueue;
}

export function listTickets() {
  return tickets
    .map((ticket) => ({ ...ticket }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findTicket(channelId) {
  const ticket = tickets.find((item) => item.channelId === channelId);
  return ticket ? { ...ticket } : undefined;
}

export function findOpenTicket(guildId, userId) {
  const ticket = tickets.find(
    (item) => item.guildId === guildId && item.userId === userId && item.status === "open",
  );
  return ticket ? { ...ticket } : undefined;
}

export async function saveTicket(ticket) {
  const existingIndex = tickets.findIndex((item) => item.channelId === ticket.channelId);
  if (existingIndex === -1) {
    tickets = [...tickets, { ...ticket }];
  } else {
    tickets = tickets.map((item, index) => (index === existingIndex ? { ...ticket } : item));
  }
  await enqueuePersist();
}

function enqueuePersist() {
  writeQueue = writeQueue.then(persist);
  return writeQueue;
}

async function persist() {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(tickets, null, 2)}\n`, "utf8");
  await rename(temporaryFile, dataFile);
}
