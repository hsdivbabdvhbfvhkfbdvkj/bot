const loginView = document.querySelector("#login-view");
const dashboardView = document.querySelector("#dashboard-view");
const loginButton = document.querySelector("#discord-login");
const loginError = document.querySelector("#login-error");
const dashboardError = document.querySelector("#dashboard-error");
const logoutButton = document.querySelector("#logout");
const guildPicker = document.querySelector("#guild-picker");
const serverNotice = document.querySelector("#server-notice");
const serverContent = document.querySelector("#server-content");
const inviteButton = document.querySelector("#invite-bot");
let csrfToken = "";
let guilds = [];

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "No se pudo completar la solicitud.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function showDashboard() {
  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
  showDashboardPage(location.hash.slice(1));
}

function showLogin() {
  dashboardView.classList.add("hidden");
  loginView.classList.remove("hidden");
  logoutButton.classList.add("hidden");
}

async function initialize() {
  try {
    const auth = await request("/api/auth-config");
    if (!auth.oauthReady) {
      loginButton.classList.add("hidden");
      loginError.textContent = "El administrador debe configurar el inicio de sesión de Discord y la URL HTTPS pública.";
    }
    const sessionInfo = await request("/api/me");
    csrfToken = sessionInfo.csrfToken;
    showDashboard();
    await loadGuilds(sessionInfo.selectedGuildId);
  } catch (error) {
    showLogin();
    if (error.status !== 401) loginError.textContent = error.message;
    if (new URLSearchParams(location.search).get("login") === "cancelled") {
      loginError.textContent = "Cancelaste el inicio de sesión de Discord.";
    }
  }
}

logoutButton.addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST" });
    location.assign("/");
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

guildPicker.addEventListener("change", () => selectGuild(guildPicker.value));
document.querySelector("#refresh").addEventListener("click", loadTickets);
document.querySelector("#settings-form").addEventListener("submit", saveDashboardSettings);
document.querySelector("#publish-panel").addEventListener("click", publishPanel);
document.querySelector("#panel-color").addEventListener("input", updatePanelColorLabel);
document.querySelectorAll(".side-link").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showDashboardPage(link.hash.slice(1));
    history.pushState(null, "", link.hash);
  });
});
window.addEventListener("hashchange", () => showDashboardPage(location.hash.slice(1)));
window.addEventListener("popstate", () => showDashboardPage(location.hash.slice(1)));

const settingsPages = {
  "settings-routing": {
    title: "Canales",
    description: "Elige las categorías y canales de este servidor para tickets, paneles y registros.",
  },
  "settings-panel": {
    title: "Diseño del panel",
    description: "Personaliza el texto, la imagen, el color y los botones del panel de soporte.",
  },
  "settings-identity": {
    title: "Identidad",
    description: "Configura cómo se presenta Hypersex Go en este servidor y en su panel.",
  },
  "settings-team": {
    title: "Equipo",
    description: "Define los roles de soporte y las notificaciones para atender los tickets.",
  },
  "settings-rules": {
    title: "Reglas",
    description: "Ajusta los límites de apertura, reclamos y condiciones de cierre.",
  },
};

function showDashboardPage(requestedPage) {
  const isSettingsPage = Object.hasOwn(settingsPages, requestedPage);
  const isTicketsPage = requestedPage === "tickets";
  const isOverviewPage = !isSettingsPage && !isTicketsPage;
  const activeSettingsPage = isSettingsPage ? requestedPage : "settings-routing";

  document.querySelector("#overview-page").classList.toggle("hidden", !isOverviewPage);
  document.querySelector("#settings").classList.toggle("hidden", !isSettingsPage);
  document.querySelector("#tickets").classList.toggle("hidden", !isTicketsPage);
  for (const [pageId, page] of Object.entries(settingsPages)) {
    const section = document.querySelector(`#${pageId}`);
    const isActive = isSettingsPage && pageId === activeSettingsPage;
    section.classList.toggle("hidden", !isActive);
    section.classList.toggle("is-active", isActive);
  }

  const settingsPage = settingsPages[activeSettingsPage];
  if (isSettingsPage) {
    document.querySelector("#settings-heading").textContent = settingsPage.title;
    document.querySelector("#settings-help").textContent = settingsPage.description;
    document.querySelector("#publish-panel").classList.toggle("hidden", activeSettingsPage !== "settings-panel");
  }
  for (const link of document.querySelectorAll(".side-link")) {
    const isActive = link.hash.slice(1) === (isSettingsPage ? activeSettingsPage : isTicketsPage ? "tickets" : "overview");
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function loadGuilds(preferredGuildId) {
  try {
    const result = await request("/api/guilds");
    guilds = result.guilds;
    guildPicker.replaceChildren(new Option("Selecciona un servidor", ""));
    for (const guild of guilds) {
      guildPicker.add(new Option(`${guild.name}${guild.botPresent ? "" : " · falta añadir el bot"}`, guild.id));
    }
    if (guilds.length === 0) {
      serverNotice.textContent = "No encontramos servidores que puedas administrar en esta cuenta de Discord.";
      guildPicker.disabled = true;
      return;
    }
    guildPicker.disabled = false;
    const initialGuild =
      guilds.find((guild) => guild.id === preferredGuildId) ||
      guilds.find((guild) => guild.botPresent) ||
      guilds[0];
    guildPicker.value = initialGuild.id;
    await selectGuild(initialGuild.id);
  } catch (error) {
    serverNotice.textContent = error.message;
  }
}

async function selectGuild(guildId) {
  if (!guildId) {
    serverContent.classList.add("hidden");
    inviteButton.classList.add("hidden");
    serverNotice.textContent = "Selecciona un servidor para continuar.";
    return;
  }
  guildPicker.disabled = true;
  serverNotice.textContent = "Cargando servidor…";
  dashboardError.textContent = "";
  try {
    const selection = await request("/api/select-guild", {
      method: "POST",
      body: JSON.stringify({ guildId }),
    });
    const guild = guilds.find((item) => item.id === guildId);
    if (!selection.botPresent) {
      serverContent.classList.add("hidden");
      inviteButton.href = guild.inviteUrl;
      inviteButton.classList.remove("hidden");
      serverNotice.textContent = `Hypersex Go aún no está en ${guild.name}. Añádelo para configurar sus tickets.`;
      return;
    }
    inviteButton.classList.add("hidden");
    serverNotice.textContent = `Administrando ${guild.name}.`;
    serverContent.classList.remove("hidden");
    await Promise.all([loadTickets(), loadSettings()]);
  } catch (error) {
    serverContent.classList.add("hidden");
    serverNotice.textContent = error.message;
  } finally {
    guildPicker.disabled = false;
  }
}

async function loadTickets() {
  dashboardError.textContent = "";
  try {
    const data = await request("/api/tickets");
    document.querySelector("#total-count").textContent = data.summary.total;
    document.querySelector("#open-count").textContent = data.summary.open;
    document.querySelector("#closed-count").textContent = data.summary.closed;
    document.querySelector("#updated-at").textContent = `Actualizado ${new Date().toLocaleTimeString("es")}`;
    renderTickets(data.tickets);
  } catch (error) {
    dashboardError.textContent = error.message;
  }
}

async function loadSettings() {
  const status = document.querySelector("#settings-status");
  status.textContent = "";
  try {
    const data = await request("/api/settings/options");
    document.querySelector("#settings-guild").textContent = data.guildName;
    document.querySelector("#sidebar-guild").textContent = data.guildName;
    fillSelect("ticket-category", data.categories, data.settings.ticketCategoryId, "Sin categoría");
    fillSelect("panel-channel", data.textChannels, data.settings.ticketPanelChannelId, "Selecciona un canal");
    fillSelect("log-channel", data.textChannels, data.settings.logChannelId, "No guardar transcripciones");
    fillSelect("opened-log-channel", data.textChannels, data.settings.openedLogChannelId, "No avisar");
    fillSelect("staff-role", data.roles, data.settings.staffRoleId, "Sin rol de soporte");
    setFieldValue("bot-nickname", data.settings.botNickname);
    setFieldValue("bot-avatar-url", data.settings.botAvatarUrl);
    fillRoleChecks("support-roles", data.roles, data.settings.supportRoleIds);
    fillRoleChecks("blocked-roles", data.roles, data.settings.blockedRoleIds);
    setFieldValue("maxActiveTickets", data.settings.maxActiveTickets);
    setFieldValue("maxActiveTicketsPerUser", data.settings.maxActiveTicketsPerUser);
    setFieldValue("claimMode", data.settings.claimMode);
    setFieldValue("defaultCloseReason", data.settings.defaultCloseReason);
    for (const field of [
      "closeRequiresSupportRole",
      "closeRequiresReason",
      "dmUserOnClose",
      "pingSupportRoles",
      "pingAuthorOnClaim",
    ]) {
      document.querySelector(`[name="${field}"]`).checked = Boolean(data.settings[field]);
    }
    setFieldValue("panel-title", data.settings.panelTitle);
    setFieldValue("panel-description", data.settings.panelDescription);
    setFieldValue("panel-content", data.settings.panelContent);
    setFieldValue("panel-image", data.settings.panelImageUrl);
    setFieldValue("panel-button-label", data.settings.panelButtonLabel);
    setFieldValue("panel-color", data.settings.panelColor);
    updatePanelColorLabel();
    for (let index = 0; index < 4; index += 1) {
      const link = data.settings.panelLinks[index] || { label: "", url: "" };
      setFieldValue(`panelLinkLabel${index + 1}`, link.label);
      setFieldValue(`panelLinkUrl${index + 1}`, link.url);
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

function fillSelect(id, items, selectedId, emptyLabel) {
  const select = document.querySelector(`#${id}`);
  const options = [new Option(emptyLabel, "")];
  for (const item of items) options.push(new Option(item.name, item.id));
  select.replaceChildren(...options);
  select.value = selectedId || "";
}

function fillRoleChecks(containerId, roles, selectedIds = []) {
  const container = document.querySelector(`#${containerId}`);
  container.replaceChildren();
  for (const role of roles) {
    const label = document.createElement("label");
    label.className = "role-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = containerId === "support-roles" ? "supportRoleIds" : "blockedRoleIds";
    checkbox.value = role.id;
    checkbox.checked = selectedIds.includes(role.id);
    const name = document.createElement("span");
    name.textContent = role.name;
    label.append(checkbox, name);
    container.append(label);
  }
  if (!roles.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "Este servidor no tiene roles disponibles.";
    container.append(empty);
  }
}

function setFieldValue(id, value) {
  const field = document.querySelector(`#${id}, [name="${id}"]`);
  if (field) field.value = value || "";
}

function updatePanelColorLabel() {
  document.querySelector("#panel-color-value").textContent = document.querySelector("#panel-color").value;
}

async function saveDashboardSettings(event) {
  event.preventDefault();
  const status = document.querySelector("#settings-status");
  const submitButton = event.submitter;
  status.textContent = "Guardando…";
  submitButton.disabled = true;
  const settings = Object.fromEntries(new FormData(event.currentTarget).entries());
  for (const field of [
    "closeRequiresSupportRole",
    "closeRequiresReason",
    "dmUserOnClose",
    "pingSupportRoles",
    "pingAuthorOnClaim",
  ]) {
    settings[field] = event.currentTarget.elements.namedItem(field).checked;
  }
  settings.supportRoleIds = new FormData(event.currentTarget).getAll("supportRoleIds");
  settings.blockedRoleIds = new FormData(event.currentTarget).getAll("blockedRoleIds");
  settings.maxActiveTickets = Number(settings.maxActiveTickets);
  settings.maxActiveTicketsPerUser = Number(settings.maxActiveTicketsPerUser);
  settings.panelLinks = Array.from({ length: 4 }, (_, index) => ({
    label: settings[`panelLinkLabel${index + 1}`],
    url: settings[`panelLinkUrl${index + 1}`],
  })).filter((link) => link.label || link.url);
  for (let index = 0; index < 4; index += 1) {
    delete settings[`panelLinkLabel${index + 1}`];
    delete settings[`panelLinkUrl${index + 1}`];
  }
  try {
    await request("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
    status.textContent = "Configuración guardada.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

async function publishPanel() {
  const button = document.querySelector("#publish-panel");
  const status = document.querySelector("#settings-status");
  button.disabled = true;
  status.textContent = "Publicando panel…";
  try {
    await request("/api/settings/publish-panel", { method: "POST" });
    status.textContent = "Panel publicado en Discord.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderTickets(tickets) {
  const body = document.querySelector("#tickets-body");
  document.querySelector("#empty-state").classList.toggle("hidden", tickets.length > 0);
  body.replaceChildren();
  for (const ticket of tickets) {
    const row = document.createElement("tr");
    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${ticket.status === "open" ? "badge-open" : "badge-closed"}`;
    badge.textContent = ticket.status === "open" ? "Abierto" : "Cerrado";
    status.append(badge);
    const action = document.createElement("td");
    if (ticket.status === "open") {
      const button = document.createElement("button");
      button.className = "button button-danger button-small";
      button.type = "button";
      button.textContent = "Cerrar";
      button.addEventListener("click", () => closeTicket(ticket.channelId, button));
      action.append(button);
    }
    row.append(
      cell(ticket.username || ticket.userId),
      cell(`#${ticket.channelId}`),
      status,
      cell(new Date(ticket.createdAt).toLocaleString("es")),
      action,
    );
    body.append(row);
  }
}

function cell(value) {
  const element = document.createElement("td");
  element.textContent = value;
  return element;
}

async function closeTicket(channelId, button) {
  button.disabled = true;
  dashboardError.textContent = "";
  try {
    await request(`/api/tickets/${encodeURIComponent(channelId)}/close`, { method: "POST" });
    await loadTickets();
  } catch (error) {
    dashboardError.textContent = error.message;
    button.disabled = false;
  }
}

initialize();
