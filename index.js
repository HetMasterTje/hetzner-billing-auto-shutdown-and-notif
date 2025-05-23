import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  MESSAGE_ID,
  HETZNER_API_TOKEN,
  THRESHOLD_PERCENT_NOTIF = 50,
  THRESHOLD_PERCENT_KILL = 90,
  SEND_USAGE_NOTIF_ALWAYS = 'false',
  OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG = 'false',
  REFRESH_TIME_IN_MINUTES = 10,
} = process.env;

const DATA_FILE = './data.json';
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const obfuscate = OBFUSCATE_SERVER_NAMES_FROM_CONSOLE_LOG === 'true';
const sendAlways = SEND_USAGE_NOTIF_ALWAYS === 'true';

let embedMessages = {};  // Store embed messages in memory

const loadMessageId = async () => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return MESSAGE_ID;
  } catch {
    return null;
  }
};

const saveMessageId = async (id) => {
  await fs.writeFile(DATA_FILE, JSON.stringify({ messageId: id }, null, 2));
};

const obfuscateServerName = (name) => {
  if (!obfuscate || !name || name.length <= 2) return name;
  return `${name[0]}${'X'.repeat(name.length - 2)}${name[name.length - 1]}`;
};

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(3)} ${units[i]}`;
};

const calculatePercentage = (used, total) =>
  total ? ((used / total) * 100).toFixed(2) : '0.00';

const fetchServers = async () => {
  const res = await axios.get('https://api.hetzner.cloud/v1/servers', {
    headers: { Authorization: `Bearer ${HETZNER_API_TOKEN}` },
  });
  return res.data.servers;
};

const shutdownServer = async (id) => {
  try {
    await axios.post(
      `https://api.hetzner.cloud/v1/servers/${id}/actions/shutdown`,
      {},
      { headers: { Authorization: `Bearer ${HETZNER_API_TOKEN}` } },
    );
    return true;
  } catch (err) {
    console.error(`Failed to shut down server ${id}: ${err.message}`);
    return false;
  }
};

const buildEmbed = (servers, killed) => {
  const embed = new EmbedBuilder()
    .setTitle('🌐 Hetzner Server Usage Report')
    .setColor(
      killed.length > 0 ? 0xff0000 : servers.length > 0 ? 0xffa500 : 0x00ff00,
    )
    .setTimestamp();

  if (killed.length > 0) {
    embed.addFields({
      name: '🚨 Servers Killed',
      value: killed
        .map(
          (s) =>
            `**${obfuscateServerName(s.name)}**: ${s.usagePercentage}% (${formatBytes(s.outgoing)} / ${formatBytes(s.limit)})`,
        )
        .join('\n'),
    });
  }

  if (servers.length > 0) {
    embed.addFields({
      name:
        killed.length > 0
          ? '⚠️ High Usage Servers'
          : '⚠️ Servers Over Threshold',
      value: servers
        .map(
          (s) =>
            `**${obfuscateServerName(s.name)}**: ${s.usagePercentage}% (${formatBytes(s.outgoing)} / ${formatBytes(s.limit)})`,
        )
        .join('\n'),
    });
  }

  return embed;
};

const buildServerEmbeds = (servers) => {
  return servers.map((s) => {
    return new EmbedBuilder()
      .setTitle(`🖥️ ${obfuscateServerName(s.name)}`)
      .addFields(
        { name: 'Status', value: s.status, inline: true },
        { name: 'Usage', value: `${s.usagePercentage}%`, inline: true },
        {
          name: 'Traffic',
          value: `${formatBytes(s.outgoing)} / ${formatBytes(s.limit)}`,
          inline: true,
        },
      )
      .setColor(
        s.rawPercentage >= THRESHOLD_PERCENT_KILL / 100
          ? 0xff0000
          : s.rawPercentage >= THRESHOLD_PERCENT_NOTIF / 100
            ? 0xffa500
            : 0x00ff00,
      )
      .setTimestamp();
  });
};

const buildFinalStatusEmbed = (serverCount) => {
  return new EmbedBuilder()
    .setTitle('🌐 Hetzner Server Usage Report')
    .setDescription(`✅ All ${serverCount} servers are within usage limits.`)
    .setColor(0x00ff00)
    .setTimestamp();
};

const checkAndUpdate = async (channel) => {
  const servers = await fetchServers();
  const highUsage = [];
  const toKill = [];
  const killed = [];

  const allData = servers.map((s) => {
    const outgoing = s.outgoing_traffic || 0;
    const limit = s.included_traffic || 0;
    const percent = parseFloat(calculatePercentage(outgoing, limit));
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      outgoing,
      limit,
      usagePercentage: percent,
      rawPercentage: limit ? outgoing / limit : 0,
    };
  });

  for (const server of allData) {
    if (server.rawPercentage >= THRESHOLD_PERCENT_KILL / 100) {
      toKill.push(server);
    } else if (server.rawPercentage >= THRESHOLD_PERCENT_NOTIF / 100) {
      highUsage.push(server);
    }
  }

  for (const server of toKill) {
    const success = await shutdownServer(server.id);
    if (success) killed.push(server);
  }

  const embed = buildEmbed(highUsage, killed);
  const serverEmbeds = buildServerEmbeds(allData);

  // Send or update server embeds
  for (const e of serverEmbeds) {
    // Check if embed already exists in memory
    const existingMessage = embedMessages[e.data.title];  // Using the title as a key for simplicity
    if (existingMessage) {
      await existingMessage.edit({ embeds: [e] });
    } else {
      const message = await channel.send({ embeds: [e] });
      embedMessages[e.data.title] = message; // Store the message reference by title
    }
  }

  if (highUsage.length > 0 || killed.length > 0) {
    if (embedMessages['Server Usage Report']) {
      await embedMessages['Server Usage Report'].edit({ embeds: [embed] });
    } else {
      const message = await channel.send({ embeds: [embed] });
      embedMessages['Server Usage Report'] = message;
    }
  } else if (sendAlways) {
    const finalEmbed = buildFinalStatusEmbed(allData.length);
    if (embedMessages['Final Server Status']) {
      await embedMessages['Final Server Status'].edit({ embeds: [finalEmbed] });
    } else {
      const message = await channel.send({ embeds: [finalEmbed] });
      embedMessages['Final Server Status'] = message;
    }
  }
};

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const channel = await client.channels.fetch(CHANNEL_ID);

  // Delete all messages in channel to reset
  if (channel.isTextBased()) {
    let messages;
    do {
      messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size > 0) {
        await channel.bulkDelete(messages);
      }
    } while (messages.size >= 2);
  }

  await checkAndUpdate(channel);
  setInterval(
    () => checkAndUpdate(channel),
    REFRESH_TIME_IN_MINUTES * 60 * 1000,
  );
});

client.login(DISCORD_TOKEN);
