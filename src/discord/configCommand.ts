import {
  ChannelType,
  InteractionContextType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { config } from "../config.js";
import { getGuildSettings, updateGuildSettings, type GuildSettings } from "../db/guildSettings.js";
import { BEMOL_COLOR } from "./embeds.js";

/**
 * `/config`: configuración de Bemol por servidor. Solo para quien pueda
 * gestionar el servidor (Discord lo impone con el permiso por defecto del
 * comando; además lo comprobamos nosotros).
 */
export const configCommand = new SlashCommandBuilder()
  .setName("config")
  .setDescription("Configura Bemol en este servidor")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName("ver").setDescription("Muestra la configuración actual"))
  .addSubcommand((sub) =>
    sub
      .setName("dj")
      .setDescription("Rol DJ: quién puede parar, limpiar, quitar, cambiar volumen y saltar sin votar")
      .addRoleOption((option) => option.setName("rol").setDescription("Sin rol = todo el mundo puede")),
  )
  .addSubcommand((sub) =>
    sub
      .setName("volumen")
      .setDescription("Volumen con el que arranca Bemol en este servidor")
      .addIntegerOption((option) =>
        option.setName("nivel").setDescription("0-150").setRequired(true).setMinValue(0).setMaxValue(150),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("247")
      .setDescription("Quedarse en el canal de voz aunque no suene nada ni haya nadie")
      .addBooleanOption((option) => option.setName("activar").setDescription("Sí o no").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("autodc")
      .setDescription("Minutos antes de salir del canal (0 = nunca)")
      .addIntegerOption((option) =>
        option.setName("sin_musica").setDescription("Minutos sin música").setMinValue(0).setMaxValue(720),
      )
      .addIntegerOption((option) =>
        option.setName("sin_gente").setDescription("Minutos con el canal vacío").setMinValue(0).setMaxValue(720),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("voteskip")
      .setDescription("Votación para saltar canciones cuando hay varios oyentes")
      .addBooleanOption((option) => option.setName("activar").setDescription("Sí o no").setRequired(true))
      .addIntegerOption((option) =>
        option.setName("porcentaje").setDescription("Porcentaje de oyentes necesario (por defecto 50)").setMinValue(1).setMaxValue(100),
      )
      .addIntegerOption((option) =>
        option.setName("minimo").setDescription("A partir de cuántos oyentes se vota (por defecto 3)").setMinValue(2).setMaxValue(50),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("canal")
      .setDescription("Canal de texto donde publicar el panel si no hay otro")
      .addChannelOption((option) =>
        option.setName("canal").setDescription("Sin canal = el chat desde el que se pide la música").addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) => sub.setName("reiniciar").setDescription("Vuelve a los valores por defecto"));

export async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const sub = interaction.options.getSubcommand();

  if (sub === "ver") {
    await interaction.reply({ embeds: [configEmbed(getGuildSettings(guild.id))], ephemeral: true });
    return;
  }

  let note = "";
  switch (sub) {
    case "dj": {
      const role = interaction.options.getRole("rol");
      updateGuildSettings(guild.id, { djRoleId: role?.id ?? null });
      note = role ? `Rol DJ: <@&${role.id}>.` : "Sin rol DJ: cualquiera en el canal puede gestionar la música.";
      break;
    }
    case "volumen": {
      const level = interaction.options.getInteger("nivel", true);
      updateGuildSettings(guild.id, { defaultVolume: level });
      note = `Volumen inicial: ${level}%. Se aplica la próxima vez que entre al canal.`;
      break;
    }
    case "247": {
      const on = interaction.options.getBoolean("activar", true);
      updateGuildSettings(guild.id, { stay247: on });
      note = on ? "Modo 24/7 activado: me quedo en el canal aunque no suene nada." : "Modo 24/7 desactivado.";
      break;
    }
    case "autodc": {
      const idle = interaction.options.getInteger("sin_musica");
      const empty = interaction.options.getInteger("sin_gente");
      if (idle === null && empty === null) {
        await interaction.reply({ content: "Indica `sin_musica`, `sin_gente` o los dos.", ephemeral: true });
        return;
      }
      updateGuildSettings(guild.id, {
        ...(idle !== null ? { idleLeaveMin: idle } : {}),
        ...(empty !== null ? { emptyLeaveMin: empty } : {}),
      });
      note = "Auto-desconexión actualizada.";
      break;
    }
    case "voteskip": {
      const on = interaction.options.getBoolean("activar", true);
      const percent = interaction.options.getInteger("porcentaje");
      const min = interaction.options.getInteger("minimo");
      updateGuildSettings(guild.id, {
        voteskip: on,
        ...(percent !== null ? { voteskipPercent: percent } : {}),
        ...(min !== null ? { voteskipMinListeners: min } : {}),
      });
      note = on ? "Votación para saltar activada." : "Votación para saltar desactivada: cualquiera salta al instante.";
      break;
    }
    case "canal": {
      const channel = interaction.options.getChannel("canal");
      updateGuildSettings(guild.id, { musicChannelId: channel?.id ?? null });
      note = channel ? `Canal de música: <#${channel.id}>.` : "Sin canal fijo: el panel va al chat desde el que se pide la música.";
      break;
    }
    case "reiniciar": {
      updateGuildSettings(guild.id, {
        djRoleId: null,
        defaultVolume: null,
        stay247: false,
        idleLeaveMin: null,
        emptyLeaveMin: null,
        voteskip: true,
        voteskipPercent: 50,
        voteskipMinListeners: 3,
        musicChannelId: null,
      });
      note = "Configuración restablecida.";
      break;
    }
    default:
      await interaction.reply({ content: "Subcomando desconocido.", ephemeral: true });
      return;
  }

  await interaction.reply({ content: `✅ ${note}`, embeds: [configEmbed(getGuildSettings(guild.id))], ephemeral: true });
}

export function configEmbed(settings: GuildSettings): EmbedBuilder {
  const minutes = (value: number | null, fallbackMs: number) => {
    const effective = value === null ? Math.round(fallbackMs / 60_000) : value;
    return effective <= 0 ? "nunca" : `${effective} min${value === null ? " (por defecto)" : ""}`;
  };
  return new EmbedBuilder()
    .setColor(BEMOL_COLOR)
    .setAuthor({ name: "⚙️  Configuración de Bemol" })
    .addFields(
      { name: "👑 Rol DJ", value: settings.djRoleId ? `<@&${settings.djRoleId}>` : "Ninguno: todos pueden gestionar", inline: true },
      { name: "🔊 Volumen inicial", value: `${settings.defaultVolume ?? config.defaultVolume}%${settings.defaultVolume === null ? " (por defecto)" : ""}`, inline: true },
      { name: "💤 24/7", value: settings.stay247 ? "Activado" : "Desactivado", inline: true },
      { name: "⏱️ Salir sin música", value: settings.stay247 ? "—" : minutes(settings.idleLeaveMin, config.idleLeaveMs), inline: true },
      { name: "👥 Salir sin gente", value: settings.stay247 ? "—" : minutes(settings.emptyLeaveMin, config.emptyLeaveMs), inline: true },
      {
        name: "🗳️ Voteskip",
        value: settings.voteskip ? `${settings.voteskipPercent}% a partir de ${settings.voteskipMinListeners} oyentes` : "Desactivado",
        inline: true,
      },
      { name: "💬 Canal de música", value: settings.musicChannelId ? `<#${settings.musicChannelId}>` : "El chat desde el que se pide", inline: true },
    )
    .setFooter({ text: "Cambia valores con /config dj · volumen · 247 · autodc · voteskip · canal · reiniciar" });
}
