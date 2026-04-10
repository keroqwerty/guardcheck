require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  ActivityType,
  Collection
} = require("discord.js");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");

/* =========================
   ENV CHECK
========================= */
if (!process.env.TOKEN) {
  throw new Error("TOKEN .env içinde yok.");
}

if (!process.env.OWNER_IDS) {
  console.warn("UYARI: OWNER_IDS boş. En az bir owner ID eklemen önerilir.");
}

/* =========================
   EXPRESS / UPTIMEROBOT
========================= */
const app = express();
const PORT = Number(process.env.PORT) || 3000;
let server = null;
let shuttingDown = false;

app.disable("x-powered-by");
app.get("/", (_, res) => res.status(200).send("Bot aktif"));
app.get("/health", (_, res) =>
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    wsStatus: client?.ws?.status ?? "unknown",
    ping: client?.ws?.ping ?? -1
  })
);
app.use((_, res) => res.status(200).send("Bot aktif"));

server = app.listen(PORT, () => {
  console.log(`Web server aktif: ${PORT}`);
});

server.on("error", (error) => {
  console.error("Web server hatası:", error);
});

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember
  ]
});

const PREFIX = process.env.PREFIX || ".";
const OWNER_IDS = new Set(
  (process.env.OWNER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

const AUTO_CHANNEL_JOIN = process.env.AUTO_CHANNEL_JOIN || null;

const SETTINGS = {
  channelLogName: process.env.CHANNEL_LOG_NAME || "kanal-log",
  roleLogName: process.env.ROLE_LOG_NAME || "rol-log",
  banLogName: process.env.BAN_LOG_NAME || "ban-log",
  voiceLogName: process.env.VOICE_LOG_NAME || "voice-log",
  messageLogName: process.env.MESSAGE_LOG_NAME || "message-log",
  timeoutLogName: process.env.TIMEOUT_LOG_NAME || "timeout-log"
};

const COLORS = {
  green: 0x57F287,
  red: 0xED4245,
  yellow: 0xFEE75C,
  orange: 0xFAA61A,
  blue: 0x5865F2,
  white: 0xFFFFFF
};

const SAFE_REPLY = {
  allowedMentions: { parse: [] }
};

const EMBED_DESCRIPTION_LIMIT = 4096;

/* =========================
   DATA / WHITELIST
========================= */
const dataDir = path.join(__dirname, "data");
const whitelistPath = path.join(dataDir, "whitelist.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(whitelistPath)) {
  fs.writeFileSync(whitelistPath, JSON.stringify([], null, 2));
}

let whitelistCache = new Set();

function loadWhitelist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));
    whitelistCache = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch (error) {
    console.error("Whitelist okunamadı:", error);
    whitelistCache = new Set();
  }
  return whitelistCache;
}

function saveWhitelist(list) {
  const unique = [...new Set(list.map(String))];
  try {
    fs.writeFileSync(whitelistPath, JSON.stringify(unique, null, 2));
    whitelistCache = new Set(unique);
  } catch (error) {
    console.error("Whitelist kaydedilemedi:", error);
  }
}

loadWhitelist();

function isOwner(userId) {
  return OWNER_IDS.has(String(userId));
}

function isWhitelisted(userId) {
  return whitelistCache.has(String(userId)) || isOwner(userId);
}

function isManager(member) {
  if (!member) return false;
  if (isWhitelisted(member.id)) return true;
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

function canUseBot(message) {
  return Boolean(message.guild && message.member && isManager(message.member));
}

/* =========================
   RUNTIME CACHES
========================= */
const messageCache = new Map();
const MESSAGE_CACHE_TTL = 1000 * 60 * 60;

const dedupeCache = new Map();
const DEDUPE_TTL = 1000 * 12;

const commandRateLimit = new Map();
const COMMAND_COOLDOWN_MS = 2500;

function makeDedupeKey(parts = []) {
  return parts.map((x) => String(x ?? "null")).join(":");
}

function wasRecentlyHandled(key, ttl = DEDUPE_TTL) {
  const now = Date.now();
  const expiresAt = dedupeCache.get(key) || 0;

  if (expiresAt > now) return true;

  dedupeCache.set(key, now + ttl);
  return false;
}

function cleanupDedupeCache() {
  const now = Date.now();
  for (const [key, expiresAt] of dedupeCache.entries()) {
    if (expiresAt <= now) dedupeCache.delete(key);
  }
}

function isRateLimited(userId) {
  const now = Date.now();
  const until = commandRateLimit.get(userId) || 0;
  if (until > now) return true;
  commandRateLimit.set(userId, now + COMMAND_COOLDOWN_MS);
  return false;
}

function cleanupRateLimit() {
  const now = Date.now();
  for (const [id, until] of commandRateLimit.entries()) {
    if (until <= now) commandRateLimit.delete(id);
  }
}

function cacheMessage(message) {
  if (!message || !message.id) return;

  messageCache.set(message.id, {
    id: message.id,
    guildId: message.guild?.id || null,
    channelId: message.channel?.id || null,
    channelName: message.channel?.name || null,
    authorId: message.author?.id || null,
    authorTag: message.author?.tag || "Bilinmiyor",
    content: message.content || "",
    attachments: [...message.attachments.values()].map((a) => a.url),
    createdTimestamp: message.createdTimestamp || Date.now()
  });
}

const cacheInterval = setInterval(() => {
  const now = Date.now();

  for (const [id, data] of messageCache.entries()) {
    if (now - (data.createdTimestamp || now) > MESSAGE_CACHE_TTL) {
      messageCache.delete(id);
    }
  }

  cleanupDedupeCache();
  cleanupRateLimit();
}, 5 * 60 * 1000);

if (typeof cacheInterval.unref === "function") {
  cacheInterval.unref();
}

/* =========================
   HELPERS
========================= */
function onAsync(eventName, handler) {
  client.on(eventName, (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      console.error(`[${eventName}] event hatası:`, error);
    });
  });
}

function onceAsync(eventName, handler) {
  client.once(eventName, (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      console.error(`[${eventName}] once event hatası:`, error);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUser(user) {
  return user ? `${user.tag || user.username || "Bilinmiyor"} (${user.id})` : "Bilinmiyor";
}

function formatMember(member) {
  return member?.user ? `${member.user.tag} (${member.id})` : "Bilinmiyor";
}

function getAvatar(entity) {
  if (!entity) return null;

  if (typeof entity.displayAvatarURL === "function") {
    return entity.displayAvatarURL({
      size: 512,
      extension: "png",
      forceStatic: true
    });
  }

  if (entity.user && typeof entity.user.displayAvatarURL === "function") {
    return entity.user.displayAvatarURL({
      size: 512,
      extension: "png",
      forceStatic: true
    });
  }

  return null;
}

function sanitizeText(text = "") {
  return String(text)
    .replace(/@everyone/g, "@ everyone")
    .replace(/@here/g, "@ here")
    .replace(/<@&(\d+)>/g, "@rol")
    .replace(/<@!?(\d+)>/g, "@uye");
}

function escapeCodeBlock(text = "") {
  return String(text).replace(/```/g, "'''");
}

function truncate(text, max = 1000) {
  const clean = escapeCodeBlock(sanitizeText(text || ""));
  if (!clean) return "İçerik alınamadı.";
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function clampEmbedDescription(text = "") {
  const clean = String(text || "");
  if (clean.length <= EMBED_DESCRIPTION_LIMIT) return clean;
  return `${clean.slice(0, EMBED_DESCRIPTION_LIMIT - 3)}...`;
}

function safeEmbed(embed) {
  const data = embed.toJSON();
  if (typeof data.description === "string") {
    embed.setDescription(clampEmbedDescription(data.description));
  }
  return embed;
}

function canSendInChannel(channel) {
  if (!channel) return false;
  if (typeof channel.send !== "function") return false;
  if (typeof channel.isTextBased === "function" && !channel.isTextBased()) return false;
  return true;
}

async function getLogChannel(guild, name) {
  if (!guild || !name) return null;

  try {
    let channel =
      guild.channels.cache.find(
        (c) => c.name === name && canSendInChannel(c)
      ) || null;

    if (channel) return channel;

    await guild.channels.fetch().catch(() => null);

    channel =
      guild.channels.cache.find(
        (c) => c.name === name && canSendInChannel(c)
      ) || null;

    return channel;
  } catch (error) {
    console.error(`[getLogChannel:${name}]`, error);
    return null;
  }
}

async function sendLog(guild, logName, embed) {
  try {
    const channel = await getLogChannel(guild, logName);

    if (!channel) {
      console.error(`[sendLog:${logName}] Log kanalı bulunamadı.`);
      return false;
    }

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      console.error(`[sendLog:${logName}] Bot member bilgisi alınamadı.`);
      return false;
    }

    const perms = channel.permissionsFor(me);
    if (
      !perms ||
      !perms.has(PermissionsBitField.Flags.ViewChannel) ||
      !perms.has(PermissionsBitField.Flags.SendMessages) ||
      !perms.has(PermissionsBitField.Flags.EmbedLinks)
    ) {
      console.error(
        `[sendLog:${logName}] Yetki yok. Gerekli izinler: ViewChannel, SendMessages, EmbedLinks`
      );
      return false;
    }

    await channel.send({
      embeds: [safeEmbed(embed)],
      allowedMentions: { parse: [] }
    });

    return true;
  } catch (error) {
    console.error(`[sendLog:${logName}]`, error);
    return false;
  }
}

function extractChangedRoleIds(changes = []) {
  const ids = new Set();

  for (const change of changes) {
    if (!change) continue;

    if (change.key === "$add" || change.key === "$remove") {
      const roles = Array.isArray(change.new)
        ? change.new
        : Array.isArray(change.old)
          ? change.old
          : [];

      for (const role of roles) {
        if (role?.id) ids.add(String(role.id));
      }
    }
  }

  return [...ids];
}

async function fetchAuditEntry(guild, type, targetId, options = {}) {
  const {
    limit = 20,
    maxAgeMs = 30000,
    retries = 8,
    retryDelay = 1200,
    matcher = null
  } = options;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(retryDelay);

    try {
      const logs = await guild.fetchAuditLogs({ type, limit });
      const now = Date.now();

      const entry = logs.entries.find((entry) => {
        const entryTargetId = entry.target?.id || entry.targetId;
        const recent = now - entry.createdTimestamp < maxAgeMs;
        const sameTarget =
          targetId == null ? true : String(entryTargetId) === String(targetId);

        if (!recent || !sameTarget) return false;
        if (typeof matcher === "function" && !matcher(entry)) return false;

        return true;
      });

      if (entry) return entry;
    } catch (error) {
      if (attempt === retries - 1) {
        console.error("Audit log çekme hatası:", error);
      }
    }
  }

  return null;
}

async function fetchRoleUpdateAuditEntry(guild, memberId, changedRoleIds = []) {
  return fetchAuditEntry(guild, AuditLogEvent.MemberRoleUpdate, memberId, {
    limit: 20,
    maxAgeMs: 45000,
    retries: 10,
    retryDelay: 1300,
    matcher: (entry) => {
      if (!changedRoleIds.length) return true;
      const changedInEntry = extractChangedRoleIds(entry.changes || []);
      return changedRoleIds.some((id) => changedInEntry.includes(String(id)));
    }
  });
}

async function fetchMemberUpdateAuditEntry(guild, memberId) {
  return fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, memberId, {
    limit: 20,
    maxAgeMs: 45000,
    retries: 10,
    retryDelay: 1500,
    matcher: (entry) => {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      return changes.some((c) =>
        ["communication_disabled_until", "communicationDisabledUntil"].includes(c.key)
      );
    }
  });
}

async function fetchMessageDeleteAudit(guild, message) {
  try {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MessageDelete,
      limit: 10
    });

    const now = Date.now();

    const entry = logs.entries.find((entry) => {
      const sameTarget =
        String(entry.target?.id || "") === String(message.author?.id || "");
      const sameChannel =
        String(entry.extra?.channel?.id || "") ===
        String(message.channel?.id || "");
      const recent = now - entry.createdTimestamp < 15000;

      return sameTarget && sameChannel && recent;
    });

    return entry || null;
  } catch (error) {
    console.error("Mesaj silme audit hatası:", error);
    return null;
  }
}

async function banMemberSafe(guild, userId, reason) {
  try {
    await guild.members.ban(userId, { reason });
    return true;
  } catch (error) {
    console.error(`Ban atılamadı (${userId}):`, error);
    return false;
  }
}

function permissionDiff(oldPerms, newPerms) {
  const changed = [];
  const oldArr = [...oldPerms.toArray()];
  const newArr = [...newPerms.toArray()];

  const added = newArr.filter((perm) => !oldArr.includes(perm));
  const removed = oldArr.filter((perm) => !newArr.includes(perm));

  if (added.length) changed.push(`Eklenen izinler: ${added.join(", ")}`);
  if (removed.length) changed.push(`Kaldırılan izinler: ${removed.join(", ")}`);

  return changed;
}

function overwriteTypeName(type) {
  if (type === 0) return "Rol";
  if (type === 1) return "Üye";
  return "Bilinmiyor";
}

function serializeOverwrites(channel) {
  return channel.permissionOverwrites.cache.map((ow) => ({
    id: ow.id,
    type: ow.type,
    allow: ow.allow.bitfield.toString(),
    deny: ow.deny.bitfield.toString()
  }));
}

async function restoreOverwrites(channel, serialized = []) {
  try {
    await channel.permissionOverwrites.set(
      serialized.map((ow) => ({
        id: ow.id,
        type: ow.type,
        allow: BigInt(ow.allow),
        deny: BigInt(ow.deny)
      })),
      "Whitelist dışı kanal izni geri alındı"
    );
  } catch (error) {
    console.error("Kanal izinleri geri yüklenemedi:", error);
  }
}

function channelChanges(oldChannel, newChannel) {
  const changes = [];

  if (oldChannel.name !== newChannel.name) {
    changes.push(`İsim: **${oldChannel.name}** → **${newChannel.name}**`);
  }

  if ((oldChannel.topic || "") !== (newChannel.topic || "")) {
    changes.push(`Konu: **${oldChannel.topic || "Yok"}** → **${newChannel.topic || "Yok"}**`);
  }

  if ((oldChannel.nsfw ?? false) !== (newChannel.nsfw ?? false)) {
    changes.push(
      `NSFW: **${oldChannel.nsfw ? "Açık" : "Kapalı"}** → **${newChannel.nsfw ? "Açık" : "Kapalı"}**`
    );
  }

  if ((oldChannel.rateLimitPerUser || 0) !== (newChannel.rateLimitPerUser || 0)) {
    changes.push(
      `Yavaş mod: **${oldChannel.rateLimitPerUser || 0}s** → **${newChannel.rateLimitPerUser || 0}s**`
    );
  }

  if ((oldChannel.bitrate || 0) !== (newChannel.bitrate || 0)) {
    changes.push(`Bitrate: **${oldChannel.bitrate || 0}** → **${newChannel.bitrate || 0}**`);
  }

  if ((oldChannel.userLimit || 0) !== (newChannel.userLimit || 0)) {
    changes.push(
      `Kullanıcı limiti: **${oldChannel.userLimit || 0}** → **${newChannel.userLimit || 0}**`
    );
  }

  if ((oldChannel.parentId || "Yok") !== (newChannel.parentId || "Yok")) {
    changes.push(
      `Kategori: **${oldChannel.parent?.name || "Yok"}** → **${newChannel.parent?.name || "Yok"}**`
    );
  }

  if ((oldChannel.position ?? 0) !== (newChannel.position ?? 0)) {
    changes.push(`Pozisyon: **${oldChannel.position ?? 0}** → **${newChannel.position ?? 0}**`);
  }

  try {
    const oldOverwrites = oldChannel.permissionOverwrites?.cache || new Collection();
    const newOverwrites = newChannel.permissionOverwrites?.cache || new Collection();

    for (const [id, newOverwrite] of newOverwrites) {
      const oldOverwrite = oldOverwrites.get(id);

      if (!oldOverwrite) {
        changes.push(
          `İzin eklendi: **${overwriteTypeName(newOverwrite.type)} ${id}** için kanal izni oluşturuldu.`
        );
        continue;
      }

      const permChanges = permissionDiff(oldOverwrite.allow, newOverwrite.allow);
      const denyChanges = permissionDiff(oldOverwrite.deny, newOverwrite.deny);

      for (const item of permChanges) changes.push(`İzin güncellendi (${id}): ${item}`);
      for (const item of denyChanges) changes.push(`Engel güncellendi (${id}): ${item}`);
    }

    for (const [id, oldOverwrite] of oldOverwrites) {
      if (!newOverwrites.has(id)) {
        changes.push(
          `İzin silindi: **${overwriteTypeName(oldOverwrite.type)} ${id}** için kanal izni kaldırıldı.`
        );
      }
    }
  } catch (error) {
    console.error("channelChanges overwrite karşılaştırma hatası:", error);
  }

  return changes.length ? changes : ["Kanal ayarlarında değişiklik yapıldı."];
}

function roleChanges(oldRole, newRole) {
  const changes = [];

  if (oldRole.name !== newRole.name) {
    changes.push(`İsim: **${oldRole.name}** → **${newRole.name}**`);
  }

  if (oldRole.color !== newRole.color) {
    changes.push(`Renk: **${oldRole.hexColor}** → **${newRole.hexColor}**`);
  }

  if (oldRole.hoist !== newRole.hoist) {
    changes.push(
      `Ayrı gösterim: **${oldRole.hoist ? "Açık" : "Kapalı"}** → **${newRole.hoist ? "Açık" : "Kapalı"}**`
    );
  }

  if (oldRole.mentionable !== newRole.mentionable) {
    changes.push(
      `Etiketlenebilirlik: **${oldRole.mentionable ? "Açık" : "Kapalı"}** → **${newRole.mentionable ? "Açık" : "Kapalı"}**`
    );
  }

  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
    changes.push(...permissionDiff(oldRole.permissions, newRole.permissions));
  }

  if ((oldRole.position ?? 0) !== (newRole.position ?? 0)) {
    changes.push(`Pozisyon: **${oldRole.position}** → **${newRole.position}**`);
  }

  return changes.length ? changes : ["Rol ayarlarında değişiklik yapıldı."];
}

async function resolveMember(guild, input) {
  if (!input) return null;
  const id = input.replace(/[^0-9]/g, "");
  if (!id) return null;

  try {
    return await guild.members.fetch(id);
  } catch {
    return null;
  }
}

function parseDuration(input) {
  if (!input) return null;

  const match = input.toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return value * multipliers[unit];
}

function humanizeDuration(ms) {
  if (ms <= 0) return "0 saniye";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days) return `${days} gün`;
  if (hours) return `${hours} saat`;
  if (minutes) return `${minutes} dakika`;
  return `${seconds} saniye`;
}

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle("Yardım Menüsü")
    .setDescription(
      [
        `**Prefix:** \`${PREFIX}\``,
        "",
        `**Moderasyon Komutları**`,
        `\`${PREFIX}ban @kişi sebep\``,
        `\`${PREFIX}unban ID sebep\``,
        `\`${PREFIX}kick @kişi sebep\``,
        `\`${PREFIX}timeout @kişi 1h sebep\``,
        `\`${PREFIX}sil 50\``,
        "",
        `**Ses Komutları**`,
        `\`${PREFIX}join\``,
        `\`${PREFIX}leave\``,
        "",
        `**Whitelist Komutları**`,
        `\`${PREFIX}wl-ekle @kişi\``,
        `\`${PREFIX}wl-sil @kişi\``,
        `\`${PREFIX}wl-liste\``,
        "",
        `**Bilgi**`,
        `\`${PREFIX}yardım\``
      ].join("\n")
    )
    .setTimestamp();
}

async function recreateDeletedRole(guild, role) {
  try {
    return await guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions,
      mentionable: role.mentionable,
      position: role.position,
      reason: "Whitelist dışı rol silme - rol geri oluşturuldu"
    });
  } catch (error) {
    console.error("Rol geri oluşturulamadı:", error);
    return null;
  }
}

async function recreateDeletedChannel(channel) {
  try {
    if (!channel.guild) return null;

    const created = await channel.guild.channels.create({
      name: channel.name,
      type: channel.type,
      topic: "topic" in channel ? channel.topic ?? null : undefined,
      nsfw: "nsfw" in channel ? channel.nsfw ?? false : undefined,
      bitrate: "bitrate" in channel ? channel.bitrate : undefined,
      userLimit: "userLimit" in channel ? channel.userLimit : undefined,
      parent: channel.parentId ?? null,
      position: channel.position ?? undefined,
      rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser ?? 0 : undefined,
      rtcRegion: "rtcRegion" in channel ? channel.rtcRegion ?? null : undefined,
      videoQualityMode: "videoQualityMode" in channel ? channel.videoQualityMode : undefined,
      permissionOverwrites: serializeOverwrites(channel),
      reason: "Whitelist dışı kanal silme - kanal geri oluşturuldu"
    });

    if (channel.parentId) {
      await created.setParent(channel.parentId, { lockPermissions: false }).catch(() => null);
    }

    if (typeof channel.position === "number") {
      await created.setPosition(channel.position).catch(() => null);
    }

    return created;
  } catch (error) {
    console.error("Kanal geri oluşturulamadı:", error);
    return null;
  }
}

function areRoleCollectionsEqual(oldRoles, newRoles) {
  const oldIds = [...oldRoles.keys()].sort();
  const newIds = [...newRoles.keys()].sort();

  if (oldIds.length !== newIds.length) return false;
  return oldIds.every((id, index) => id === newIds[index]);
}

function buildRoleChangeSummary(addedRoles, removedRoles) {
  const lines = [];

  if (addedRoles.size) {
    lines.push(`**Verilen roller:** ${addedRoles.map((role) => role.name).join(", ")}`);
  }

  if (removedRoles.size) {
    lines.push(`**Alınan roller:** ${removedRoles.map((role) => role.name).join(", ")}`);
  }

  return lines;
}

async function fetchDisconnectAuditEntry(guild, memberId, channelId) {
  return fetchAuditEntry(guild, AuditLogEvent.MemberDisconnect, memberId, {
    limit: 12,
    maxAgeMs: 20000,
    retries: 8,
    retryDelay: 1000,
    matcher: (entry) => {
      const extraChannelId =
        entry.extra?.channel?.id ||
        entry.extra?.channelId ||
        entry.options?.channel?.id ||
        entry.options?.channel_id ||
        null;

      if (!channelId) return true;
      if (!extraChannelId) return true;

      return String(extraChannelId) === String(channelId);
    }
  });
}

async function safeReply(message, contentOrOptions) {
  if (!message?.channel) return null;

  try {
    if (typeof contentOrOptions === "string") {
      return await message.reply({ content: contentOrOptions, ...SAFE_REPLY });
    }

    return await message.reply({ ...contentOrOptions, ...SAFE_REPLY });
  } catch {
    try {
      if (typeof contentOrOptions === "string") {
        return await message.channel.send({ content: contentOrOptions, ...SAFE_REPLY });
      }

      return await message.channel.send({ ...contentOrOptions, ...SAFE_REPLY });
    } catch {
      return null;
    }
  }
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} alındı, kapatılıyor...`);

  try {
    const connectionIds = [...client.guilds.cache.keys()];
    for (const guildId of connectionIds) {
      try {
        const connection = getVoiceConnection(guildId);
        if (connection) connection.destroy();
      } catch {}
    }
  } catch {}

  try {
    await client.destroy();
  } catch {}

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  } catch {}

  process.exit(0);
}

/* =========================
   READY
========================= */
onceAsync("ready", async () => {
  console.log(`${client.user.tag} aktif oldu.`);

  client.user.setPresence({
    activities: [{ name: "Guard Sistemi Aktif", type: ActivityType.Watching }],
    status: "dnd"
  });

  if (AUTO_CHANNEL_JOIN) {
    try {
      const channel = await client.channels.fetch(AUTO_CHANNEL_JOIN).catch(() => null);

      if (!channel) {
        return console.log("AUTO_CHANNEL_JOIN kanal ID bulunamadı.");
      }

      if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
      ) {
        return console.log("AUTO_CHANNEL_JOIN bir ses kanalı değil.");
      }

      const existing = getVoiceConnection(channel.guild.id);
      if (!existing) {
        joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false
        });
      }

      console.log(`Otomatik ses kanalına bağlandı: ${channel.name}`);
    } catch (error) {
      console.error("Otomatik ses kanalına bağlanırken hata:", error);
    }
  }
});

/* =========================
   MESSAGE CACHE EVENTS
========================= */
onAsync("messageCreate", async (message) => {
  if (!message.guild || message.author?.bot || message.webhookId || message.system) return;
  cacheMessage(message);
});

onAsync("messageUpdate", async (_, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || newMessage.webhookId || newMessage.system) return;
  cacheMessage(newMessage);
});

/* =========================
   COMMANDS
========================= */
onAsync("messageCreate", async (message) => {
  if (!message.guild || message.author.bot || message.webhookId || message.system) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  if (!canUseBot(message)) return;
  if (isRateLimited(message.author.id)) return;

  if (command === "yardım" || command === "yardim" || command === "help") {
    return safeReply(message, { embeds: [helpEmbed()] });
  }

  if (command === "wl-ekle") {
    if (!isOwner(message.author.id)) {
      return safeReply(message, "Bu komutu sadece bot sahibi kullanabilir.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return safeReply(message, "Kullanıcı bulunamadı.");

    const list = [...whitelistCache];
    if (list.includes(target.id)) {
      return safeReply(message, "Bu kullanıcı zaten whitelistte.");
    }

    list.push(target.id);
    saveWhitelist(list);

    return safeReply(message, `Whitelist eklendi: **${target.user.tag}** (${target.id})`);
  }

  if (command === "wl-sil") {
    if (!isOwner(message.author.id)) {
      return safeReply(message, "Bu komutu sadece bot sahibi kullanabilir.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return safeReply(message, "Kullanıcı bulunamadı.");

    const list = [...whitelistCache].filter((id) => id !== target.id);
    saveWhitelist(list);

    return safeReply(message, `Whitelistten çıkarıldı: **${target.user.tag}** (${target.id})`);
  }

  if (command === "wl-liste") {
    if (!isOwner(message.author.id)) {
      return safeReply(message, "Bu komutu sadece bot sahibi kullanabilir.");
    }

    const list = [...whitelistCache];
    if (!list.length) return safeReply(message, "Whitelist boş.");

    const lines = await Promise.all(
      list.map(async (id, i) => {
        try {
          const user = await client.users.fetch(id);
          return `${i + 1}. ${user.tag} (${id})`;
        } catch {
          return `${i + 1}. Bilinmeyen Kullanıcı (${id})`;
        }
      })
    );

    return safeReply(message, `**Whitelist Listesi**\n${lines.join("\n")}`);
  }

  if (command === "ban") {
    if (!isWhitelisted(message.author.id)) {
      return safeReply(message, "Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return safeReply(message, "Ban yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return safeReply(message, "Banlanacak kullanıcı bulunamadı.");
    if (target.id === message.author.id) return safeReply(message, "Kendini banlayamazsın.");
    if (isOwner(target.id)) return safeReply(message, "Owner banlanamaz.");
    if (!target.bannable) {
      return safeReply(message, "Bu kullanıcıyı banlayamıyorum. Rol sırası veya yetkiyi kontrol et.");
    }

    const reason = sanitizeText(args.slice(1).join(" ") || "Sebep belirtilmedi.");
    await target.ban({ reason: `${reason} | Komutu kullanan: ${message.author.tag}` });

    return safeReply(message, `**${target.user.tag}** banlandı. Sebep: **${reason}**`);
  }

  if (command === "unban") {
    if (!isWhitelisted(message.author.id)) {
      return safeReply(message, "Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return safeReply(message, "Ban kaldırma yetkin yok.");
    }

    const userId = args[0]?.replace(/[^0-9]/g, "");
    if (!userId) {
      return safeReply(message, "Kullanıcı ID girmelisin. Örnek: `.unban 123456789012345678 sebep`");
    }

    let bannedUser;
    try {
      bannedUser = await message.guild.bans.fetch(userId);
    } catch {
      return safeReply(message, "Bu kullanıcı banlı görünmüyor.");
    }

    const reason = sanitizeText(args.slice(1).join(" ") || "Sebep belirtilmedi.");
    await message.guild.members.unban(
      userId,
      `${reason} | Komutu kullanan: ${message.author.tag}`
    );

    const embed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle("Kullanıcının Banı Kaldırıldı")
      .setDescription(
        [
          `**Banı kaldırılan kişi:** ${formatUser(bannedUser.user || bannedUser)}`,
          `**Banı kaldıran kişi:** ${formatUser(message.author)}`,
          `**Sebep:** ${reason}`
        ].join("\n")
      )
      .setThumbnail(getAvatar(bannedUser.user || bannedUser))
      .setTimestamp();

    await sendLog(message.guild, SETTINGS.banLogName, embed);

    return safeReply(message, `**${userId}** ID'li kullanıcının banı kaldırıldı. Sebep: **${reason}**`);
  }

  if (command === "kick") {
    if (!isWhitelisted(message.author.id)) {
      return safeReply(message, "Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return safeReply(message, "Kick yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return safeReply(message, "Atılacak kullanıcı bulunamadı.");
    if (target.id === message.author.id) return safeReply(message, "Kendini kickleyemezsin.");
    if (isOwner(target.id)) return safeReply(message, "Owner kicklenemez.");
    if (!target.kickable) {
      return safeReply(message, "Bu kullanıcıyı kickleyemiyorum. Rol sırası veya yetkiyi kontrol et.");
    }

    const reason = sanitizeText(args.slice(1).join(" ") || "Sebep belirtilmedi.");
    await target.kick(`${reason} | Komutu kullanan: ${message.author.tag}`);

    return safeReply(message, `**${target.user.tag}** kicklendi. Sebep: **${reason}**`);
  }

  if (command === "timeout") {
    if (!isWhitelisted(message.author.id)) {
      return safeReply(message, "Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return safeReply(message, "Timeout yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    const durationMs = parseDuration(args[1]);

    if (!target) return safeReply(message, "Timeout atılacak kullanıcı bulunamadı.");
    if (!durationMs) {
      return safeReply(message, "Süre formatı yanlış. Örnek: `.timeout @kullanıcı 1h sebep`");
    }
    if (target.id === message.author.id) return safeReply(message, "Kendine timeout atamazsın.");
    if (isOwner(target.id)) return safeReply(message, "Owner'a timeout atılamaz.");
    if (!target.moderatable) {
      return safeReply(message, "Bu kullanıcıya timeout atamıyorum.");
    }

    const reason = sanitizeText(args.slice(2).join(" ") || "Sebep belirtilmedi.");
    await target.timeout(durationMs, `${reason} | Komutu kullanan: ${message.author.tag}`);

    return safeReply(
      message,
      `**${target.user.tag}** kullanıcısına **${humanizeDuration(durationMs)}** timeout atıldı. Sebep: **${reason}**`
    );
  }

  if (command === "sil") {
    if (!isWhitelisted(message.author.id)) {
      return safeReply(message, "Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return safeReply(message, "Mesaj silme yetkin yok.");
    }

    const amount = Number(args[0]);
    if (!amount || amount < 1 || amount > 100) {
      return safeReply(message, "1 ile 100 arasında sayı girmelisin.");
    }

    const deleted = await message.channel.bulkDelete(amount, true).catch(() => null);
    if (!deleted) return safeReply(message, "Mesajlar silinemedi.");

    const info = await message.channel
      .send({
        content: `#${message.channel.name} kanalından **${deleted.size}** adet mesaj sildim.`,
        allowedMentions: { parse: [] }
      })
      .catch(() => null);

    if (info) setTimeout(() => info.delete().catch(() => null), 5000);
    return;
  }

  if (command === "join") {
    if (!isWhitelisted(message.author.id)) {
      return safeReply(message, "Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.voice.channel) {
      return safeReply(message, "Önce bir ses kanalına girmen gerekiyor.");
    }

    const existing = getVoiceConnection(message.guild.id);
    if (!existing) {
      joinVoiceChannel({
        channelId: message.member.voice.channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });
    }

    return safeReply(message, `Ses kanalına girdim: **${message.member.voice.channel.name}**`);
  }

  if (command === "leave") {
    if (!isWhitelisted(message.author.id)) {
      return safeReply(message, "Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    const connection = getVoiceConnection(message.guild.id);
    if (!connection) return safeReply(message, "Zaten bir ses kanalında değilim.");

    connection.destroy();
    return safeReply(message, "Ses kanalından çıktım.");
  }
});

/* =========================
   CHANNEL GUARD + LOG
========================= */
onAsync("channelCreate", async (channel) => {
  if (!channel.guild) return;

  const key = makeDedupeKey(["channelCreate", channel.guild.id, channel.id]);
  if (wasRecentlyHandled(key)) return;

  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.green)
    .setTitle("Kanal Oluşturuldu")
    .setDescription(
      [
        `**Kanal:** ${sanitizeText(channel.name)}`,
        `**Tür:** ${ChannelType[channel.type] || channel.type}`,
        `**Oluşturan kişi:** ${formatUser(executor)}`,
        unauthorized ? `**Durum:** Yetkisiz kanal oluşturma algılandı` : `**Durum:** Kanal oluşturuldu`
      ].join("\n")
    )
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(channel.guild, SETTINGS.channelLogName, embed);

  if (unauthorized) {
    await channel.delete("Whitelist dışı kanal oluşturma").catch(() => null);
    await banMemberSafe(channel.guild, executor.id, "Whitelist dışı kanal oluşturma");
  }
});

onAsync("channelDelete", async (channel) => {
  if (!channel.guild) return;

  const key = makeDedupeKey(["channelDelete", channel.guild.id, channel.id]);
  if (wasRecentlyHandled(key)) return;

  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.orange)
    .setTitle("Kanal Silindi")
    .setDescription(
      [
        `**Kanal:** ${sanitizeText(channel.name)}`,
        `**Tür:** ${ChannelType[channel.type] || channel.type}`,
        `**Silen kişi:** ${formatUser(executor)}`,
        unauthorized ? `**Durum:** Yetkisiz kanal silme algılandı` : `**Durum:** Kanal silindi`
      ].join("\n")
    )
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(channel.guild, SETTINGS.channelLogName, embed);

  if (unauthorized) {
    await recreateDeletedChannel(channel);
    await banMemberSafe(channel.guild, executor.id, "Whitelist dışı kanal silme");
  }
});

onAsync("channelUpdate", async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;

  const changes = channelChanges(oldChannel, newChannel);
  if (changes.length === 1 && changes[0] === "Kanal ayarlarında değişiklik yapıldı.") return;

  const key = makeDedupeKey(["channelUpdate", newChannel.guild.id, newChannel.id, changes.join("|")]);
  if (wasRecentlyHandled(key)) return;

  const entry = await fetchAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id, {
    limit: 20,
    maxAgeMs: 30000,
    retries: 8,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);
  const oldOverwriteState = serializeOverwrites(oldChannel);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.yellow)
    .setTitle("Kanal Düzenlendi")
    .setDescription(
      [
        `**Kanal:** ${sanitizeText(newChannel.name)}`,
        `**Düzenleyen kişi:** ${formatUser(executor)}`,
        `**Yapılan değişiklikler:**`,
        changes.map((x) => `• ${sanitizeText(x)}`).join("\n")
      ].join("\n")
    )
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(newChannel.guild, SETTINGS.channelLogName, embed);

  if (unauthorized) {
    try {
      await newChannel.edit(
        {
          name: oldChannel.name,
          topic: "topic" in oldChannel ? oldChannel.topic ?? null : undefined,
          nsfw: "nsfw" in oldChannel ? oldChannel.nsfw ?? false : undefined,
          rateLimitPerUser: "rateLimitPerUser" in oldChannel ? oldChannel.rateLimitPerUser ?? 0 : undefined,
          bitrate: "bitrate" in oldChannel ? oldChannel.bitrate : undefined,
          userLimit: "userLimit" in oldChannel ? oldChannel.userLimit : undefined,
          parent: oldChannel.parentId ?? null,
          rtcRegion: "rtcRegion" in oldChannel ? oldChannel.rtcRegion ?? null : undefined,
          videoQualityMode: "videoQualityMode" in oldChannel ? oldChannel.videoQualityMode : undefined,
          defaultAutoArchiveDuration: "defaultAutoArchiveDuration" in oldChannel
            ? oldChannel.defaultAutoArchiveDuration
            : undefined
        },
        "Whitelist dışı kanal düzenleme geri alındı"
      ).catch(() => null);

      await restoreOverwrites(newChannel, oldOverwriteState);
      if (typeof oldChannel.position === "number") {
        await newChannel.setPosition(oldChannel.position).catch(() => null);
      }
    } catch (error) {
      console.error("Yetkisiz kanal düzenleme geri alınamadı:", error);
    }

    await banMemberSafe(newChannel.guild, executor.id, "Whitelist dışı kanal düzenleme");
  }
});

/* =========================
   ROLE GUARD + LOG
========================= */
onAsync("roleCreate", async (role) => {
  const key = makeDedupeKey(["roleCreate", role.guild.id, role.id]);
  if (wasRecentlyHandled(key)) return;

  const entry = await fetchAuditEntry(role.guild, AuditLogEvent.RoleCreate, role.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.green)
    .setTitle("Rol Oluşturuldu")
    .setDescription(
      [
        `**Rol:** ${sanitizeText(role.name)}`,
        `**Oluşturan kişi:** ${formatUser(executor)}`,
        unauthorized ? `**Durum:** Yetkisiz rol oluşturma algılandı` : `**Durum:** Rol oluşturuldu`
      ].join("\n")
    )
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(role.guild, SETTINGS.roleLogName, embed);

  if (unauthorized) {
    await role.delete("Whitelist dışı rol oluşturma").catch(() => null);
    await banMemberSafe(role.guild, executor.id, "Whitelist dışı rol oluşturma");
  }
});

onAsync("roleDelete", async (role) => {
  const key = makeDedupeKey(["roleDelete", role.guild.id, role.id]);
  if (wasRecentlyHandled(key)) return;

  const entry = await fetchAuditEntry(role.guild, AuditLogEvent.RoleDelete, role.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.orange)
    .setTitle("Rol Silindi")
    .setDescription(
      [
        `**Rol:** ${sanitizeText(role.name)}`,
        `**Silen kişi:** ${formatUser(executor)}`,
        unauthorized ? `**Durum:** Yetkisiz rol silme algılandı` : `**Durum:** Rol silindi`
      ].join("\n")
    )
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(role.guild, SETTINGS.roleLogName, embed);

  if (unauthorized) {
    await recreateDeletedRole(role.guild, role);
    await banMemberSafe(role.guild, executor.id, "Whitelist dışı rol silme");
  }
});

onAsync("roleUpdate", async (oldRole, newRole) => {
  const changes = roleChanges(oldRole, newRole);
  const key = makeDedupeKey(["roleUpdate", newRole.guild.id, newRole.id, changes.join("|")]);
  if (wasRecentlyHandled(key)) return;

  const entry = await fetchAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const unauthorized = executor && !executor.bot && !isWhitelisted(executor.id);

  const embed = new EmbedBuilder()
    .setColor(unauthorized ? COLORS.red : COLORS.yellow)
    .setTitle("Rol Düzenlendi")
    .setDescription(
      [
        `**Rol:** ${sanitizeText(newRole.name)}`,
        `**Düzenleyen kişi:** ${formatUser(executor)}`,
        `**Yapılan değişiklikler:**`,
        changes.map((x) => `• ${sanitizeText(x)}`).join("\n")
      ].join("\n")
    )
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(newRole.guild, SETTINGS.roleLogName, embed);

  if (unauthorized) {
    try {
      await newRole.edit(
        {
          name: oldRole.name,
          color: oldRole.color,
          hoist: oldRole.hoist,
          permissions: oldRole.permissions,
          mentionable: oldRole.mentionable
        },
        "Whitelist dışı rol düzenleme geri alındı"
      );
      await newRole.setPosition(oldRole.position).catch(() => null);
    } catch (error) {
      console.error("Yetkisiz rol düzenleme geri alınamadı:", error);
    }

    await banMemberSafe(newRole.guild, executor.id, "Whitelist dışı rol düzenleme");
  }
});

/* =========================
   MEMBER ROLE LOG + TIMEOUT LOG
========================= */
onAsync("guildMemberUpdate", async (oldMember, newMember) => {
  const oldRoles = oldMember.roles.cache;
  const newRoles = newMember.roles.cache;

  if (!areRoleCollectionsEqual(oldRoles, newRoles)) {
    const addedRoles = newRoles.filter(
      (role) => !oldRoles.has(role.id) && role.id !== newMember.guild.id
    );
    const removedRoles = oldRoles.filter(
      (role) => !newRoles.has(role.id) && role.id !== newMember.guild.id
    );

    if (addedRoles.size || removedRoles.size) {
      const changedRoleIds = [
        ...addedRoles.map((role) => role.id),
        ...removedRoles.map((role) => role.id)
      ];

      const dedupeKey = makeDedupeKey([
        "memberRoleUpdate",
        newMember.guild.id,
        newMember.id,
        [...changedRoleIds].sort().join(","),
        addedRoles.map((r) => r.id).sort().join(","),
        removedRoles.map((r) => r.id).sort().join(",")
      ]);

      if (!wasRecentlyHandled(dedupeKey, 15000)) {
        const entry = await fetchRoleUpdateAuditEntry(newMember.guild, newMember.id, changedRoleIds);
        const executor = entry?.executor || null;

        const embed = new EmbedBuilder()
          .setColor(
            addedRoles.size && removedRoles.size
              ? COLORS.yellow
              : addedRoles.size
                ? COLORS.green
                : COLORS.red
          )
          .setTitle("Üye Rolleri Güncellendi")
          .setDescription(
            [
              `**Kullanıcı:** ${formatMember(newMember)}`,
              `**İşlemi yapan kişi:** ${formatUser(executor)}`,
              ...buildRoleChangeSummary(addedRoles, removedRoles)
            ].join("\n")
          )
          .setThumbnail(getAvatar(newMember))
          .setTimestamp();

        await sendLog(newMember.guild, SETTINGS.roleLogName, embed);

        if (executor && !executor.bot && !isWhitelisted(executor.id)) {
          for (const role of addedRoles.values()) {
            if (role.managed) continue;
            await newMember.roles.remove(role.id, "Whitelist dışı rol verme geri alındı").catch(() => null);
          }

          for (const role of removedRoles.values()) {
            if (role.managed) continue;
            await newMember.roles.add(role.id, "Whitelist dışı rol alma geri alındı").catch(() => null);
          }

          await banMemberSafe(newMember.guild, executor.id, "Whitelist dışı rol işlemi");
        }
      }
    }
  }

  const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
  const newTimeout = newMember.communicationDisabledUntilTimestamp || null;

  if (oldTimeout !== newTimeout) {
    const timeoutDedupeKey = makeDedupeKey([
      "timeoutUpdate",
      newMember.guild.id,
      newMember.id,
      String(oldTimeout),
      String(newTimeout)
    ]);

    if (!wasRecentlyHandled(timeoutDedupeKey, 15000)) {
      const entry = await fetchMemberUpdateAuditEntry(newMember.guild, newMember.id);
      const executor = entry?.executor || null;

      const isTimeoutAdded = Boolean(newTimeout && (!oldTimeout || newTimeout > oldTimeout));
      const remainingMs = newTimeout ? Math.max(0, newTimeout - Date.now()) : 0;

      const desc = [
        `**Kullanıcı:** ${formatMember(newMember)}`,
        `**İşlemi yapan kişi:** ${formatUser(executor)}`
      ];

      if (isTimeoutAdded) {
        desc.push(`**Bitiş:** <t:${Math.floor(newTimeout / 1000)}:F>`);
        desc.push(`**Kalan süre:** ${humanizeDuration(remainingMs)}`);
      } else {
        desc.push(`**Durum:** Timeout kaldırıldı`);
      }

      const embed = new EmbedBuilder()
        .setColor(isTimeoutAdded ? COLORS.yellow : COLORS.green)
        .setTitle(isTimeoutAdded ? "Zaman Aşımı Uygulandı" : "Zaman Aşımı Kaldırıldı")
        .setDescription(desc.join("\n"))
        .setThumbnail(getAvatar(newMember))
        .setTimestamp();

      await sendLog(newMember.guild, SETTINGS.timeoutLogName, embed);

      if (isTimeoutAdded && executor && !executor.bot && !isWhitelisted(executor.id)) {
        await newMember.timeout(null, "Whitelist dışı timeout geri alındı").catch(() => null);
        await banMemberSafe(newMember.guild, executor.id, "Whitelist dışı timeout işlemi");
      }
    }
  }
});

/* =========================
   BAN / KICK GUARD + LOG
========================= */
onAsync("guildBanAdd", async (ban) => {
  const key = makeDedupeKey(["guildBanAdd", ban.guild.id, ban.user.id]);
  if (wasRecentlyHandled(key, 15000)) return;

  const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, {
    limit: 10,
    maxAgeMs: 30000,
    retries: 6,
    retryDelay: 1500
  });

  const executor = entry?.executor || null;
  const reason = sanitizeText(entry?.reason || "Sebep belirtilmedi.");

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await ban.guild.members.unban(ban.user.id, "Whitelist dışı ban geri alındı").catch(() => null);
    await banMemberSafe(ban.guild, executor.id, "Whitelist dışı sağ tık ban");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle("Kullanıcı Banlandı")
    .setDescription(
      [
        `**Banlanan kişi:** ${formatUser(ban.user)}`,
        `**Banlayan kişi:** ${formatUser(executor)}`,
        `**Sebep:** ${reason}`
      ].join("\n")
    )
    .setThumbnail(getAvatar(ban.user))
    .setTimestamp();

  await sendLog(ban.guild, SETTINGS.banLogName, embed);
});

onAsync("guildMemberRemove", async (member) => {
  const key = makeDedupeKey(["guildMemberRemove", member.guild.id, member.id]);
  if (wasRecentlyHandled(key, 10000)) return;

  const entry = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id, {
    limit: 10,
    maxAgeMs: 20000,
    retries: 5,
    retryDelay: 1200
  });

  if (!entry) return;

  const executor = entry.executor || null;
  const reason = sanitizeText(entry.reason || "Sebep belirtilmedi.");

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await banMemberSafe(member.guild, executor.id, "Whitelist dışı sağ tık kick");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.orange)
    .setTitle("Kullanıcı Kicklendi")
    .setDescription(
      [
        `**Kicklenen kişi:** ${formatMember(member)}`,
        `**Kickleyen kişi:** ${formatUser(executor)}`,
        `**Sebep:** ${reason}`
      ].join("\n")
    )
    .setThumbnail(getAvatar(member))
    .setTimestamp();

  await sendLog(member.guild, SETTINGS.banLogName, embed);
});

/* =========================
   MESSAGE LOG
========================= */
onAsync("messageDelete", async (message) => {
  if (!message.guild) return;

  let fetched = message;
  const cachedData = messageCache.get(message.id) || null;

  if (fetched.partial) {
    try {
      fetched = await fetched.fetch();
    } catch {}
  }

  const author =
    fetched.author ||
    (cachedData ? { tag: cachedData.authorTag, id: cachedData.authorId } : null);

  if (author?.bot) return;

  const deleteDedupeKey = makeDedupeKey(["messageDelete", message.guild.id, message.id, author?.id]);
  if (wasRecentlyHandled(deleteDedupeKey, 10000)) return;

  const deleterEntry = author
    ? await fetchMessageDeleteAudit(message.guild, {
        author,
        channel: fetched.channel || message.channel
      })
    : null;

  const deleter = deleterEntry?.executor || null;

  const content = fetched.content || cachedData?.content || "İçerik alınamadı.";
  const attachments = [
    ...(fetched.attachments ? [...fetched.attachments.values()].map((a) => a.url) : []),
    ...(cachedData?.attachments || [])
  ];
  const uniqueAttachments = [...new Set(attachments)];

  const desc = [
    `**Mesaj atan:** ${author ? `${author.tag} (${author.id})` : "Bilinmiyor"}`,
    `**Mesajı silen:** ${formatUser(deleter)}`,
    `**Kanal:** ${fetched.channel || message.channel}`,
    `**Silinen mesaj:**`,
    `\`\`\`\n${truncate(content, 900)}\n\`\`\``
  ];

  if (uniqueAttachments.length) {
    desc.push("");
    desc.push(`**Ekler:**`);
    desc.push(uniqueAttachments.slice(0, 5).join("\n"));
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle("Mesaj Silindi")
    .setDescription(desc.join("\n"))
    .setThumbnail(getAvatar(fetched.author || null))
    .setTimestamp();

  await sendLog(message.guild, SETTINGS.messageLogName, embed);
  messageCache.delete(message.id);
});

onAsync("messageDeleteBulk", async (messages) => {
  const first = messages.first();
  if (!first?.guild) return;

  const key = makeDedupeKey(["messageDeleteBulk", first.guild.id, first.channel.id, messages.size]);
  if (wasRecentlyHandled(key, 10000)) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.orange)
    .setTitle("Toplu Mesaj Silme")
    .setDescription(
      [
        `**Kanal:** ${first.channel}`,
        `**Silinen adet:** ${messages.size}`
      ].join("\n")
    )
    .setTimestamp();

  await sendLog(first.guild, SETTINGS.messageLogName, embed);

  for (const msg of messages.values()) {
    messageCache.delete(msg.id);
  }
});

/* =========================
   VOICE LOG
========================= */
onAsync("voiceStateUpdate", async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  if (oldState.channelId && !newState.channelId && oldState.member?.id !== client.user?.id) {
    const disconnectEntry = await fetchDisconnectAuditEntry(guild, oldState.id, oldState.channelId);
    const wasForcedDisconnect = Boolean(disconnectEntry?.executor);

    const voiceDedupeKey = makeDedupeKey([
      "voiceLeaveOrDisconnect",
      guild.id,
      oldState.id,
      oldState.channelId,
      wasForcedDisconnect ? disconnectEntry.executor.id : "self"
    ]);

    if (wasRecentlyHandled(voiceDedupeKey, 10000)) return;

    if (wasForcedDisconnect) {
      const executor = disconnectEntry.executor;

      const embed = new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle("Ses Bağlantısı Kesildi")
        .setDescription(
          [
            `**Bağlantısı kesilen kişi:** ${formatMember(oldState.member)}`,
            `**Bağlantıyı kesen kişi:** ${formatUser(executor)}`,
            `**Eski kanal:** ${sanitizeText(oldState.channel?.name || "Bilinmiyor")}`
          ].join("\n")
        )
        .setThumbnail(getAvatar(oldState.member))
        .setTimestamp();

      await sendLog(guild, SETTINGS.voiceLogName, embed);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.orange)
      .setTitle("Ses Kanalından Ayrıldı")
      .setDescription(
        [
          `**Kullanıcı:** ${formatMember(oldState.member)}`,
          `**Kanal:** ${sanitizeText(oldState.channel?.name || "Bilinmiyor")}`
        ].join("\n")
      )
      .setThumbnail(getAvatar(oldState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
    return;
  }

  if (!oldState.channelId && newState.channelId) {
    const key = makeDedupeKey(["voiceJoin", guild.id, newState.id, newState.channelId]);
    if (wasRecentlyHandled(key, 8000)) return;

    const embed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle("Ses Kanalına Giriş")
      .setDescription(
        [
          `**Kullanıcı:** ${formatMember(newState.member)}`,
          `**Kanal:** ${sanitizeText(newState.channel?.name || "Bilinmiyor")}`
        ].join("\n")
      )
      .setThumbnail(getAvatar(newState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
    return;
  }

  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    const key = makeDedupeKey([
      "voiceMove",
      guild.id,
      newState.id,
      oldState.channelId,
      newState.channelId
    ]);
    if (wasRecentlyHandled(key, 8000)) return;

    const embed = new EmbedBuilder()
      .setColor(COLORS.blue)
      .setTitle("Ses Kanalı Değişti")
      .setDescription(
        [
          `**Kullanıcı:** ${formatMember(newState.member)}`,
          `**Eski kanal:** ${sanitizeText(oldState.channel?.name || "Bilinmiyor")}`,
          `**Yeni kanal:** ${sanitizeText(newState.channel?.name || "Bilinmiyor")}`
        ].join("\n")
      )
      .setThumbnail(getAvatar(newState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
  }
});

/* =========================
   CLIENT / PROCESS SAFETY
========================= */
client.on("error", (error) => {
  console.error("Client error:", error);
});

client.on("warn", (info) => {
  console.warn("Client warn:", info);
});

client.on("shardError", (error, shardId) => {
  console.error(`Shard error [${shardId}]:`, error);
});

client.on("invalidated", () => {
  console.error("Client session invalidated.");
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("multipleResolves", (type, promise, value) => {
  console.warn("Multiple Resolves:", type, value);
});

process.on("warning", (warning) => {
  console.warn("Process warning:", warning);
});

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM");
});

/* =========================
   LOGIN
========================= */
client.login(process.env.TOKEN).catch((error) => {
  console.error("Discord login başarısız:", error);
});
