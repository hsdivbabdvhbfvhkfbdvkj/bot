import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { findOpenTicket, findTicket, getGuildSettings, listTickets, saveTicket } from "./store.js";

const commands = [
  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Publica el panel para que los miembros abran tickets.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];
const pendingTicketOpens = new Set();
const ticketOpenCooldowns = new Map();

export function createBot(config) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Bot conectado como ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === "ticket-panel") {
        await postTicketPanel(interaction, getGuildSettings(interaction.guildId));
        return;
      }

      if (interaction.isButton()) {
        if (interaction.customId === "ticket:open") {
          await openTicket(interaction, getGuildSettings(interaction.guildId));
        } else if (interaction.customId === "ticket:close") {
          await closeFromInteraction(interaction, client, getGuildSettings(interaction.guildId));
        } else if (interaction.customId === "ticket:claim") {
          await claimFromInteraction(interaction, getGuildSettings(interaction.guildId));
        } else if (interaction.customId === "ticket:unclaim") {
          await unclaimFromInteraction(interaction, getGuildSettings(interaction.guildId));
        } else if (interaction.customId === "ticket:reopen") {
          await reopenFromInteraction(interaction, getGuildSettings(interaction.guildId));
        }
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket:close:reason:")) {
        await closeWithReasonModal(interaction, client, getGuildSettings(interaction.guildId));
      }
    } catch (error) {
      console.error("No se pudo completar la interacción de Discord:", error);
      const message = "No se pudo completar la acción. Revisa los permisos y vuelve a intentarlo.";
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, ephemeral: true }).catch((replyError) => {
          console.error("No se pudo informar el error en Discord:", replyError);
        });
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch((replyError) => {
          console.error("No se pudo informar el error en Discord:", replyError);
        });
      }
    }
  });

  return client;
}

export async function startBot(client, config) {
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  await rest.put(Routes.applicationCommands(config.clientId), {
    body: commands,
  });
  await client.login(config.botToken);
}

export async function closeTicketById(client, channelId, actor, config, reason = "") {
  const ticket = findTicket(channelId);
  if (!ticket || ticket.status !== "open") {
    throw new Error("El ticket ya está cerrado o no existe.");
  }

  const guild = await client.guilds.fetch(ticket.guildId);
  const channel = await guild.channels.fetch(ticket.channelId);
  if (!channel || !channel.isTextBased() || channel.type !== ChannelType.GuildText) {
    throw new Error("No se encontró el canal de este ticket.");
  }

  const transcript = await createTranscript(channel);
  if (config.logChannelId) {
    const logChannel = await guild.channels.fetch(config.logChannelId);
    if (!logChannel?.isTextBased() || !("send" in logChannel)) {
      throw new Error("El canal configurado para transcripciones no es válido.");
    }
    await logChannel.send({
      content: `Transcripción del ticket de <@${ticket.userId}>. Cerrado por ${actor}.${reason ? ` Motivo: ${reason}` : ""}`,
      files: [new AttachmentBuilder(Buffer.from(transcript, "utf8"), {
        name: `ticket-${ticket.channelId}.txt`,
      })],
    });
  }

  await channel.permissionOverwrites.edit(ticket.userId, {
    SendMessages: false,
    ViewChannel: false,
  });
  await channel.setName(`cerrado-${channel.name}`.slice(0, 100));
  await channel.send({
    content: `Ticket cerrado por ${actor}.${reason ? ` Motivo: ${reason}` : ""} El personal puede reabrirlo desde aquí.`,
    components: [reopenComponents()],
  });
  if (config.dmUserOnClose) {
    const user = await client.users.fetch(ticket.userId);
    await user.send(
      `Tu ticket en ${guild.name} fue cerrado.${reason ? ` Motivo: ${reason}` : ""} Si necesitas más ayuda, puedes abrir otro ticket.`,
    ).catch((error) => {
      if (error.code !== 50007) {
        throw error;
      }
    });
  }
  await saveTicket({
    ...ticket,
    status: "closed",
    closedAt: new Date().toISOString(),
    closedBy: actor,
  });
  return ticket;
}

export async function closeOpenTicketById(client, channelId, actor, reason = "") {
  const ticket = findTicket(channelId);
  if (!ticket) {
    throw new Error("No se encontró el ticket.");
  }
  return closeTicketById(client, channelId, actor, getGuildSettings(ticket.guildId), reason);
}

function panelComponents(config) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId("ticket:open")
      .setLabel(config.panelButtonLabel)
      .setStyle(ButtonStyle.Primary),
    ...config.panelLinks.map((link) =>
      new ButtonBuilder().setLabel(link.label).setStyle(ButtonStyle.Link).setURL(link.url),
    ),
  ];
  return [new ActionRowBuilder().addComponents(buttons)];
}

async function postTicketPanel(interaction, config) {
  await publishTicketPanel(interaction.channel, config);
  await interaction.reply({ content: "Panel de tickets publicado.", ephemeral: true });
}

export async function publishTicketPanel(channel, config) {
  const embed = new EmbedBuilder().setColor(config.panelColor);
  if (config.panelTitle) embed.setTitle(config.panelTitle);
  if (config.panelDescription) embed.setDescription(config.panelDescription);
  if (config.panelImageUrl) embed.setImage(config.panelImageUrl);
  const hasEmbed = Boolean(config.panelTitle || config.panelDescription || config.panelImageUrl);

  return channel.send({
    content: config.panelContent || undefined,
    ...(hasEmbed ? { embeds: [embed] } : {}),
    components: panelComponents(config),
    allowedMentions: { parse: [] },
  });
}

async function openTicket(interaction, config) {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (pendingTicketOpens.has(key)) {
    await interaction.reply({ content: "Ya estoy preparando tu ticket. Espera un momento.", ephemeral: true });
    return;
  }
  pendingTicketOpens.add(key);

  try {
    const now = Date.now();
    const lastOpenedAt = ticketOpenCooldowns.get(key) || 0;
    if (now - lastOpenedAt < 10_000) {
      await interaction.reply({ content: "Espera unos segundos antes de abrir otro ticket.", ephemeral: true });
      return;
    }

    const memberRoleIds = interaction.member?.roles?.cache;
    if (config.blockedRoleIds.some((roleId) => memberRoleIds?.has(roleId))) {
      await interaction.reply({ content: "No tienes permiso para abrir tickets en este servidor.", ephemeral: true });
      return;
    }

    const userOpenTickets = listTickets().filter(
      (ticket) => ticket.guildId === interaction.guildId && ticket.userId === interaction.user.id && ticket.status === "open",
    );
    if (userOpenTickets.length >= config.maxActiveTicketsPerUser) {
      await interaction.reply({
        content: `Llegaste al límite de tickets abiertos (${config.maxActiveTicketsPerUser}): ${userOpenTickets.map((ticket) => `<#${ticket.channelId}>`).join(", ")}`,
        ephemeral: true,
      });
      return;
    }
    const serverOpenTickets = listTickets().filter(
      (ticket) => ticket.guildId === interaction.guildId && ticket.status === "open",
    );
    if (serverOpenTickets.length >= config.maxActiveTickets) {
      await interaction.reply({ content: "El servidor llegó al límite de tickets abiertos. Inténtalo más tarde.", ephemeral: true });
      return;
    }

    const overwrites = [
      {
        id: interaction.guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: interaction.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ];
    const supportRoleIds = config.supportRoleIds.length
      ? config.supportRoleIds
      : config.staffRoleId
        ? [config.staffRoleId]
        : [];
    for (const supportRoleId of supportRoleIds) {
      overwrites.push({
        id: supportRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }

    const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
    const channel = await interaction.guild.channels.create({
      name: `ticket-${safeName || interaction.user.id}`,
      type: ChannelType.GuildText,
      parent: config.ticketCategoryId || undefined,
      permissionOverwrites: overwrites,
      topic: `Ticket de ${interaction.user.tag} (${interaction.user.id})`,
    });

    try {
      await saveTicket({
        channelId: channel.id,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.user.tag,
        status: "open",
        claimedBy: null,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      await channel.delete("No se pudo guardar el registro del ticket");
      throw error;
    }

    const ticketButtons = [];
    if (config.claimMode !== "disabled") {
      ticketButtons.push(new ButtonBuilder()
        .setCustomId("ticket:claim")
        .setLabel("Reclamar")
        .setStyle(ButtonStyle.Secondary));
    }
    ticketButtons.push(new ButtonBuilder()
        .setCustomId("ticket:close")
        .setLabel("Cerrar ticket")
        .setStyle(ButtonStyle.Danger));
    const row = new ActionRowBuilder().addComponents(ticketButtons);
    await channel.send({
      content: `${
        config.pingSupportRoles
          ? `${supportRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")} `
          : ""
      }<@${interaction.user.id}> El equipo de soporte te atenderá aquí.`,
      components: [row],
      allowedMentions: {
        users: [interaction.user.id],
        roles: config.pingSupportRoles ? supportRoleIds : [],
      },
    });
    ticketOpenCooldowns.set(key, now);
    if (config.openedLogChannelId) {
      const logChannel = await interaction.guild.channels.fetch(config.openedLogChannelId);
      if (logChannel?.isTextBased() && "send" in logChannel) {
        await logChannel.send({
          content: `Nuevo ticket de <@${interaction.user.id}>: ${channel}`,
          allowedMentions: { users: [interaction.user.id], roles: [] },
        });
      }
    }
    await interaction.reply({ content: `Tu ticket está listo: ${channel}`, ephemeral: true });
  } finally {
    pendingTicketOpens.delete(key);
  }
}

async function closeFromInteraction(interaction, client, config) {
  const ticket = findTicket(interaction.channelId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({ content: "Este ticket ya está cerrado.", ephemeral: true });
    return;
  }

  const isOwner = ticket.userId === interaction.user.id;
  const isStaff = hasStaffAccess(interaction, config);
  if ((!isOwner && !isStaff) || (config.closeRequiresSupportRole && !isStaff)) {
    await interaction.reply({ content: "Solo el equipo de soporte puede cerrar este ticket.", ephemeral: true });
    return;
  }

  if (config.closeRequiresReason) {
    await showCloseReasonModal(interaction, config.defaultCloseReason);
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await closeTicketById(client, interaction.channelId, interaction.user.tag, config, config.defaultCloseReason);
  await interaction.editReply("Ticket cerrado.");
}

async function showCloseReasonModal(interaction, defaultReason) {
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Motivo del cierre")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500);
  if (defaultReason) reason.setValue(defaultReason.slice(0, 500));
  const modal = new ModalBuilder()
    .setCustomId(`ticket:close:reason:${interaction.channelId}`)
    .setTitle("Cerrar ticket")
    .addComponents(new ActionRowBuilder().addComponents(reason));
  await interaction.showModal(modal);
}

async function closeWithReasonModal(interaction, client, config) {
  const ticket = findTicket(interaction.channelId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({ content: "Este ticket ya está cerrado.", ephemeral: true });
    return;
  }
  const isStaff = hasStaffAccess(interaction, config);
  const isOwner = ticket.userId === interaction.user.id;
  if ((!isStaff && !isOwner) || (config.closeRequiresSupportRole && !isStaff)) {
    await interaction.reply({ content: "Solo el equipo de soporte puede cerrar este ticket.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const reason = interaction.fields.getTextInputValue("reason").trim();
  await closeTicketById(client, interaction.channelId, interaction.user.tag, config, reason);
  await interaction.editReply("Ticket cerrado y motivo registrado.");
}

async function claimFromInteraction(interaction, config) {
  const ticket = findTicket(interaction.channelId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({ content: "Este ticket no está abierto.", ephemeral: true });
    return;
  }
  if (!hasStaffAccess(interaction, config)) {
    await interaction.reply({ content: "Solo el equipo de soporte puede reclamar tickets.", ephemeral: true });
    return;
  }
  if (config.claimMode === "disabled") {
    await interaction.reply({ content: "La opción de reclamar está desactivada.", ephemeral: true });
    return;
  }
  if (ticket.claimedBy) {
    await interaction.reply({ content: `Este ticket ya lo está atendiendo <@${ticket.claimedBy}>.`, ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  if (config.claimMode === "private" || config.claimMode === "read-only") {
    for (const roleId of configuredSupportRoleIds(config)) {
      await channel.permissionOverwrites.edit(
        roleId,
        config.claimMode === "private"
          ? { ViewChannel: false }
          : { ViewChannel: true, SendMessages: false },
      );
    }
    await channel.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  }
  await saveTicket({ ...ticket, claimedBy: interaction.user.id });
  await channel.send({
    content: `${config.pingAuthorOnClaim ? `<@${ticket.userId}> ` : ""}El ticket fue reclamado por <@${interaction.user.id}>.`,
    components: [claimedComponents()],
    allowedMentions: { users: config.pingAuthorOnClaim ? [ticket.userId] : [] },
  });
  await interaction.reply({ content: "Ticket reclamado.", ephemeral: true });
}

async function unclaimFromInteraction(interaction, config) {
  const ticket = findTicket(interaction.channelId);
  if (!ticket?.claimedBy) {
    await interaction.reply({ content: "Este ticket no tiene responsable asignado.", ephemeral: true });
    return;
  }
  if (!hasStaffAccess(interaction, config)) {
    await interaction.reply({ content: "Solo el equipo de soporte puede cambiar el responsable.", ephemeral: true });
    return;
  }
  const channel = interaction.channel;
  for (const roleId of configuredSupportRoleIds(config)) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  }
  await channel.permissionOverwrites.delete(ticket.claimedBy).catch((error) => {
    if (error.code !== 10003) throw error;
  });
  await saveTicket({ ...ticket, claimedBy: null });
  await channel.send({ content: `Ticket liberado por <@${interaction.user.id}>.`, components: [claimComponents()] });
  await interaction.reply({ content: "Responsable liberado.", ephemeral: true });
}

async function reopenFromInteraction(interaction, config) {
  const ticket = findTicket(interaction.channelId);
  if (!ticket || ticket.status !== "closed") {
    await interaction.reply({ content: "Este ticket no está cerrado.", ephemeral: true });
    return;
  }
  if (!hasStaffAccess(interaction, config)) {
    await interaction.reply({ content: "Solo el equipo de soporte puede reabrirlo.", ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  await channel.permissionOverwrites.edit(ticket.userId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
  });
  await channel.setName(channel.name.replace(/^cerrado-/, "").slice(0, 100));
  await saveTicket({ ...ticket, status: "open", closedAt: null, closedBy: null });
  await interaction.reply({ content: "Ticket reabierto.", ephemeral: true });
}

function hasStaffAccess(interaction, config) {
  const supportRoles = configuredSupportRoleIds(config);
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ||
    supportRoles.some((roleId) => interaction.member?.roles?.cache?.has(roleId))
  );
}

function configuredSupportRoleIds(config) {
  return config.supportRoleIds?.length
    ? config.supportRoleIds
    : config.staffRoleId
      ? [config.staffRoleId]
      : [];
}

function claimComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:claim")
      .setLabel("Reclamar")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Cerrar ticket")
      .setStyle(ButtonStyle.Danger),
  );
}

function claimedComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:unclaim")
      .setLabel("Liberar ticket")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Cerrar ticket")
      .setStyle(ButtonStyle.Danger),
  );
}

function reopenComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:reopen")
      .setLabel("Reabrir ticket")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function createTranscript(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const lines = [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => {
      const content = message.content || (message.attachments.size ? "[archivo adjunto]" : "[sin texto]");
      return `[${message.createdAt.toISOString()}] ${message.author.tag}: ${content}`;
    });
  return `${lines.join("\n")}\n`;
}

export function getTicketSummary(tickets = listTickets()) {
  return {
    total: tickets.length,
    open: tickets.filter((ticket) => ticket.status === "open").length,
    closed: tickets.filter((ticket) => ticket.status === "closed").length,
  };
}
