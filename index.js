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

let embedMessage = null;

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

const bytesToTB = (bytes, precision = 2) =>
  (bytes / 1024 ** 4).toFixed(precision);

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
      {
        headers: { Authorization: `Bearer ${HETZNER_API_TOKEN}` },
      },
    );
    return true;
  } catch (err) {
    console.error(`Failed to shut down server ${id}: ${err.message}`);
    return false;
  }
};

const buildEmbed = (servers, killed, allServers, statusOnly = false) => {
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
            `**${obfuscateServerName(s.name)}**: ${s.usagePercentage}% (${s.outgoingTB}/${s.limitTB} TB)`,
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
            `**${obfuscateServerName(s.name)}**: ${s.usagePercentage}% (${s.outgoingTB}/${s.limitTB} TB)`,
        )
        .join('\n'),
    });
  }

  const totalOutgoing = allData.reduce(
    (sum, s) => sum + parseFloat(s.outgoingTB),
    0,
  );
  const totalLimit = allData.reduce((sum, s) => sum + parseFloat(s.limitTB), 0);

  embed.addFields({
    name: '📊 Overall Usage',
    value: `${totalOutgoing.toFixed(2)} / ${totalLimit.toFixed(2)} TB used across ${allServers.length} servers`,
  });

  if (sendAlways && servers.length === 0 && killed.length === 0 && statusOnly) {
    embed.setDescription(
      `✅ All ${allServers.length} servers are within usage limits.`,
    );
  }

  return embed;
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
      outgoingTB: bytesToTB(outgoing),
      limitTB: bytesToTB(limit),
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

  const embed = buildEmbed(highUsage, killed, allData, true);

  if (!embedMessage) {
    const messageId = await loadMessageId();
    if (messageId) {
      try {
        embedMessage = await channel.messages.fetch(messageId);
        await embedMessage.edit({ embeds: [embed] });
      } catch {
        embedMessage = await channel.send({ embeds: [embed] });
        await saveMessageId(embedMessage.id);
      }
    } else {
      embedMessage = await channel.send({ embeds: [embed] });
      await saveMessageId(embedMessage.id);
    }
  } else {
    await embedMessage.edit({ embeds: [embed] });
  }
};

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const channel = await client.channels.fetch(CHANNEL_ID);
  await checkAndUpdate(channel);

  // Optional: auto-update every X minutes
  setInterval(
    () => checkAndUpdate(channel),
    REFRESH_TIME_IN_MINUTES * 60 * 1000,
  ); // every 10 minutes
});

client.login(DISCORD_TOKEN);
