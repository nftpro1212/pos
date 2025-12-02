import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { resetPosDataLocal } from "./systemMaintenance.js";
import {
  buildSalesReport,
  resolveDateRange,
  createSalesReportWorkbook,
  formatDateShort,
  formatDateTime,
} from "./reportService.js";

let usingApiData = false;
let backendApiUrl = "";
let apiClient = null;

const refreshApiConfig = () => {
  const mode = (process.env.TELEGRAM_BOT_DATA_MODE || "direct").toLowerCase();
  usingApiData = mode === "api";
  backendApiUrl = process.env.BACKEND_API_URL ? process.env.BACKEND_API_URL.replace(/\/$/, "") : "";
  apiClient = usingApiData && backendApiUrl
    ? axios.create({ baseURL: backendApiUrl, timeout: 20000 })
    : null;

  if (usingApiData && !backendApiUrl) {
    console.warn("[TelegramBot] BACKEND_API_URL sozlanmagan, API rejimi ishlamasligi mumkin.");
  } else if (usingApiData) {
    console.info(`[TelegramBot] API rejimi yoqilgan. Backend URL: ${backendApiUrl}`);
  }
};

refreshApiConfig();

const SESSIONS = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 soat
const CALLBACK_DEDUP_WINDOW_MS = 1000 * 10; // Callback so'rovlari uchun 10 soniyalik oynada dedup

const presets = {
  today: { label: "Bugun", range: () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    return { from: day, to: day };
  } },
  bugun: { label: "Bugun", range: () => presets.today.range() },
  yesterday: { label: "Kecha", range: () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const day = d.toISOString().slice(0, 10);
    return { from: day, to: day };
  } },
  kecha: { label: "Kecha", range: () => presets.yesterday.range() },
  week: { label: "Oxirgi 7 kun", range: () => {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 6);
    return {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
    };
  } },
  hafta: { label: "Oxirgi 7 kun", range: () => presets.week.range() },
  month: { label: "Oxirgi 30 kun", range: () => {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 29);
    return {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
    };
  } },
  oy: { label: "Oxirgi 30 kun", range: () => presets.month.range() },
};

const validateDateToken = (value) => /\d{4}-\d{2}-\d{2}/.test(value);

const isConflictError = (error) =>
  Boolean(error && error.code === "ETELEGRAM" && error.response?.body?.error_code === 409);

const IN_MEMORY_DEDUP_TTL_MS = 1000 * 60;
const inMemoryDedupCache = new Map();

const cleanupLocalDedup = () => {
  if (!inMemoryDedupCache.size) {
    return;
  }
  const now = Date.now();
  for (const [key, expiresAt] of inMemoryDedupCache.entries()) {
    if (!expiresAt || expiresAt <= now) {
      inMemoryDedupCache.delete(key);
    }
  }
};

const isMongoReady = () => mongoose.connection?.readyState === 1;

const processedUpdateSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },
    createdAt: { type: Date, default: Date.now, expires: 60 },
  },
  { versionKey: false }
);

const ProcessedUpdate = mongoose.models.ProcessedUpdate ||
  mongoose.model("ProcessedUpdate", processedUpdateSchema);

let pollingConflictLogged = false;
let pollingSuppressed = false;

const logPollingConflictOnce = () => {
  pollingSuppressed = true;
};

const registerProcessedKey = async (key) => {
  if (!key) {
    return true;
  }
  if (!isMongoReady()) {
    cleanupLocalDedup();
    const existingExpiry = inMemoryDedupCache.get(key);
    const now = Date.now();
    if (existingExpiry && existingExpiry > now) {
      return false;
    }
    inMemoryDedupCache.set(key, now + IN_MEMORY_DEDUP_TTL_MS);
    return true;
  }
  try {
    const existing = await ProcessedUpdate.findOneAndUpdate(
      { key },
      { key, createdAt: new Date() },
      { upsert: true, new: false, setDefaultsOnInsert: true }
    );
    return !existing;
  } catch (error) {
    if (error.code === 11000) {
      return false;
    }
    console.warn("[TelegramBot] Processed update registratsiyasida xatolik", error.message);
    return false;
  }
};

const makeCommandKey = (msg) => `cmd:${msg.chat?.id}:${msg.message_id}:${msg.date}`;
const makeTextKey = (msg) => `txt:${msg.chat?.id}:${msg.message_id}:${msg.date}`;
const makeCallbackKeys = (query) => {
  const keys = [];
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;
  const data = query?.data;
  const bucket = Math.floor(Date.now() / CALLBACK_DEDUP_WINDOW_MS);

  if (chatId != null && messageId != null && data) {
    keys.push(`cb:req:${chatId}:${messageId}:${data}:${bucket}`);
  }
  if (query?.id) {
    keys.push(`cb:id:${query.id}`);
  }
  return keys;
};

const shouldHandleCommandMessage = (msg) => registerProcessedKey(makeCommandKey(msg));
const shouldHandleTextMessage = (msg) => registerProcessedKey(makeTextKey(msg));
const shouldHandleCallbackQuery = async (query) => {
  const keys = makeCallbackKeys(query);
  if (!keys.length) {
    return true;
  }
  for (const key of keys) {
    const accepted = await registerProcessedKey(key);
    if (!accepted) {
      return false;
    }
  }
  return true;
};

const parseReportArguments = (rawArgs) => {
  const text = (rawArgs || "").trim();
  if (!text) {
    const { range } = presets.week;
    const { from, to } = range();
    return { from, to, label: presets.week.label };
  }

  const lower = text.toLowerCase();
  if (presets[lower]) {
    const { from, to } = presets[lower].range();
    return { from, to, label: presets[lower].label };
  }

  const fromMatch = lower.match(/from=([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  const toMatch = lower.match(/to=([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  if (fromMatch || toMatch) {
    const from = fromMatch ? fromMatch[1] : undefined;
    const to = toMatch ? toMatch[1] : undefined;
    if (from && !validateDateToken(from)) {
      throw new Error("FROM sanasi noto'g'ri formatda. YYYY-MM-DD ko'rinishida yuboring.");
    }
    if (to && !validateDateToken(to)) {
      throw new Error("TO sanasi noto'g'ri formatda. YYYY-MM-DD ko'rinishida yuboring.");
    }
    return {
      from,
      to,
      label: from && to ? `${from} — ${to}` : "Tanlangan davr",
    };
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && validateDateToken(tokens[0]) && validateDateToken(tokens[1])) {
    return {
      from: tokens[0],
      to: tokens[1],
      label: `${tokens[0]} — ${tokens[1]}`,
    };
  }

  throw new Error(
    "Sanani aniqlab bo'lmadi. Masalan: /report 2025-01-01 2025-01-07 yoki /report from=2025-01-01 to=2025-01-15"
  );
};

const getSession = (chatId) => {
  const session = SESSIONS.get(chatId);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) {
    SESSIONS.delete(chatId);
    return null;
  }
  return session;
};

const updateSession = (chatId, updates) => {
  const current = getSession(chatId) || { chatId };
  const next = {
    ...current,
    ...updates,
    chatId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined) {
      delete next[key];
    }
  });
  SESSIONS.set(chatId, next);
  return next;
};

const destroySession = (chatId) => {
  SESSIONS.delete(chatId);
};

const LOGIN_KEYBOARD = {
  inline_keyboard: [[{ text: "🔐 Tizimga kirish", callback_data: "login:start" }]],
};

const buildMainMenuKeyboard = () => ({
  inline_keyboard: [
    [
      { text: "📊 Bugun", callback_data: "report:today" },
      { text: "📈 Kecha", callback_data: "report:yesterday" },
    ],
    [
      { text: "📅 7 kun", callback_data: "report:week" },
      { text: "📆 30 kun", callback_data: "report:month" },
    ],
    [
      { text: "🗓️ Custom davr", callback_data: "report:custom" },
    ],
    [
      { text: "➕ Yangi egani qo'shish", callback_data: "owner:new" },
    ],
    [
      { text: "🚪 Chiqish", callback_data: "logout" },
    ],
  ],
});

const buildCancelMarkup = (scope) => ({
  inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: `cancel:${scope}` }]],
});

const deleteMessageSilently = async (bot, chatId, messageId) => {
  if (!messageId) {
    return false;
  }
  try {
    await bot.deleteMessage(chatId, messageId);
    return true;
  } catch (error) {
    const description = error?.response?.body?.description || error.message;
    const lower = description ? description.toLowerCase() : "";
    if (!lower.includes("message to delete not found") && !lower.includes("message can't be deleted")) {
      console.warn("[TelegramBot] Xabarni o'chirishning imkoni bo'lmadi.", description);
    }
    return false;
  }
};

const sendMainMenu = async (bot, chatId, name, options = {}) => {
  const baseGreeting = name ? `👋 ${name}, qaysi hisobot kerak?` : "📊 Hisobot menyusi";
  const text = options.text || baseGreeting;
  const replyMarkup = buildMainMenuKeyboard();
  const session = getSession(chatId);
  const existingId = session?.menuMessageId;
  let cleanupTarget = existingId || null;

  if (existingId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: existingId,
        reply_markup: replyMarkup,
      });
      updateSession(chatId, {
        menuMessageId: existingId,
        loginPromptMessageId: undefined,
        customPromptMessageId: undefined,
      });
      return { message_id: existingId };
    } catch (error) {
      const description = error?.response?.body?.description || error.message;
      const lower = description ? description.toLowerCase() : "";
      if (lower.includes("message is not modified")) {
        updateSession(chatId, {
          menuMessageId: existingId,
          loginPromptMessageId: undefined,
          customPromptMessageId: undefined,
        });
        return { message_id: existingId };
      }
      if (lower.includes("message to edit not found")) {
        cleanupTarget = null;
      } else {
        console.warn("[TelegramBot] Menu edit failed, yangi xabar yuboriladi.", description);
      }
    }
  }

  const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
  updateSession(chatId, {
    menuMessageId: sent.message_id,
    loginPromptMessageId: undefined,
    customPromptMessageId: undefined,
  });

  if (cleanupTarget) {
    await deleteMessageSilently(bot, chatId, cleanupTarget);
  }

  return sent;
};

const handleSuccessfulLogin = async (bot, chatId, user, options = {}) => {
  const previous = getSession(chatId);

  if (previous?.loginPromptMessageId) {
    await deleteMessageSilently(bot, chatId, previous.loginPromptMessageId);
  }
  if (previous?.customPromptMessageId) {
    await deleteMessageSilently(bot, chatId, previous.customPromptMessageId);
  }

  const rawUserId = user?._id || user?.id || user?.userId;
  const nextSession = {
    userId: rawUserId ? rawUserId.toString() : undefined,
    username: user?.username,
    name: user?.name,
    role: user?.role,
    state: "authenticated",
    apiToken: options.token,
    apiTokenIssuedAt: options.token ? Date.now() : undefined,
  };

  updateSession(chatId, nextSession);

  return sendMainMenu(bot, chatId, user.name, {
    text: `✅ Xush kelibsiz, ${user.name}!\nQuyidagi tugmalardan kerakli hisobotni tanlang.`,
  });
};

const OWNER_STATES = {
  NAME: "register_owner_name",
  USERNAME: "register_owner_username",
  PASSWORD: "register_owner_password",
  PIN: "register_owner_pin",
};

const generateStrongPassword = (length = 10) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
};

const sanitizeUsernameInput = (value = "") => value.trim().toLowerCase().replace(/\s+/g, "");

const generateUniqueUsernameLocal = async (name) => {
  let base = sanitizeUsernameInput(name).replace(/[^a-z0-9]/g, "");
  if (!base) {
    base = `user${Date.now()}`;
  }
  let candidate = base;
  let counter = 1;
  while (await User.findOne({ username: candidate })) {
    candidate = `${base}${counter}`;
    counter += 1;
  }
  return candidate;
};

const sendOwnerPrompt = async (bot, chatId, text) => {
  const session = getSession(chatId);
  const previous = session?.ownerPromptMessageId;
  if (previous) {
    await deleteMessageSilently(bot, chatId, previous);
  }
  const sent = await bot.sendMessage(chatId, text, {
    reply_markup: buildCancelMarkup("owner"),
  });
  updateSession(chatId, { ownerPromptMessageId: sent.message_id });
  return sent;
};

const startOwnerRegistrationFlow = async (bot, chatId) => {
  updateSession(chatId, {
    state: OWNER_STATES.NAME,
    newOwnerDraft: {},
  });

  const introText = "🆕 Restoran egasini ro'yxatdan o'tkazamiz.\n\n1️⃣ Iltimos, egasi yoki bosh adminning to'liq ismini yuboring.\n\nBekor qilish uchun /cancel yoki \"Bekor qilish\" tugmasini bosing.";
  await sendOwnerPrompt(bot, chatId, introText);
};

const createOwnerAccount = async ({ name, username, password, pinCode, apiToken }) => {
  if (!name || !password || !pinCode) {
    return { ok: false, message: "Majburiy maydonlar to'liq emas." };
  }

  if (usingApiData) {
    if (!apiClient || !backendApiUrl) {
      return { ok: false, message: "Backend API sozlanmagan." };
    }

    try {
      const payload = { name, role: "admin", pinCode, password };
      if (username) {
        payload.username = username;
      }
      const headers = apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined;
      const response = await apiClient.post("/api/auth/register", payload, { headers });
      const data = response.data || {};
      return {
        ok: true,
        username: data.username || username,
        id: data.id,
        role: data.role || "admin",
      };
    } catch (error) {
      const statusMessage = error?.response?.data?.message || error.message;
      const lower = statusMessage ? statusMessage.toLowerCase() : "";
      const duplicate = lower.includes("username") && lower.includes("exist");
      return {
        ok: false,
        message: statusMessage,
        code: duplicate ? "USERNAME_EXISTS" : undefined,
      };
    }
  }

  if (!isMongoReady()) {
    return { ok: false, message: "Ma'lumotlar bazasi ulanmagan." };
  }

  let finalUsername = username;
  if (finalUsername) {
    const exists = await User.findOne({ username: finalUsername });
    if (exists) {
      return { ok: false, message: "Bu login band.", code: "USERNAME_EXISTS" };
    }
  } else {
    finalUsername = await generateUniqueUsernameLocal(name);
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const pinHash = await bcrypt.hash(pinCode, 10);
    const user = await User.create({
      name,
      username: finalUsername,
      passwordHash,
      pinHash,
      role: "admin",
    });
    return { ok: true, username: user.username, id: user._id ? user._id.toString() : undefined, role: user.role };
  } catch (error) {
    const message = error?.message || "Foydalanuvchini yaratib bo'lmadi.";
    const lower = message.toLowerCase();
    const duplicate = lower.includes("duplicate key") || (lower.includes("duplicate") && lower.includes("username"));
    return {
      ok: false,
      message: duplicate ? "Bu login band." : message,
      code: duplicate ? "USERNAME_EXISTS" : undefined,
    };
  }
};

const buildOwnerSummaryMessage = ({
  name,
  username,
  password,
  pinCode,
  passwordGenerated,
  resetSucceeded,
  resetMessage,
}) => {
  const lines = [
    "✅ Restoran egasi muvaffaqiyatli qo'shildi!",
    "",
    `👤 Ism: ${name}`,
    `👥 Login: ${username}`,
    `🔑 Parol${passwordGenerated ? " (avtomatik)" : ""}: ${password}`,
    `📌 PIN-kod: ${pinCode}`,
    "",
    resetSucceeded
      ? "🧹 Barcha eski POS ma'lumotlari tozalandi."
      : `⚠️ Ma'lumotlarni tozalashda muammo: ${resetMessage || "noma'lum xato"}`,
    "⚠️ Ushbu ma'lumotlarni egasiga xavfsiz tarzda yetkazib bering.",
  ];

  return lines.join("\n");
};

const requestSystemResetRemote = async ({ keepUserId, apiToken }) => {
  if (!apiClient || !backendApiUrl) {
    return { ok: false, message: "Backend API sozlanmagan." };
  }
  if (!apiToken) {
    return { ok: false, message: "API token mavjud emas." };
  }

  try {
    const headers = { Authorization: `Bearer ${apiToken}` };
    await apiClient.post("/api/system/reset", { keepUserId }, { headers });
    return { ok: true };
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    return { ok: false, message };
  }
};

const performSystemReset = async ({ keepUserId, apiToken }) => {
  if (usingApiData) {
    return requestSystemResetRemote({ keepUserId, apiToken });
  }

  if (!isMongoReady()) {
    return { ok: false, message: "Ma'lumotlar bazasi ulanmagan." };
  }

  return resetPosDataLocal({ keepUserId });
};

const handleOwnerFlowMessage = async (bot, chatId, session, text) => {
  const trimmed = text.trim();
  const draft = session.newOwnerDraft || {};

  if (session.state === OWNER_STATES.NAME) {
    if (trimmed.length < 3) {
      await bot.sendMessage(chatId, "❗️ Ism juda qisqa. Iltimos, to'liq ismini yuboring.");
      await sendOwnerPrompt(bot, chatId, "👤 Restoran egasining to'liq ismini kiriting.");
      return;
    }
    const nextDraft = { ...draft, name: trimmed };
    updateSession(chatId, { newOwnerDraft: nextDraft, state: OWNER_STATES.USERNAME });
    await sendOwnerPrompt(
      bot,
      chatId,
      "✍️ Endi login kiriting.\n• Masalan: restoranjon\n• Avtomatik yaratish uchun \"auto\" deb yozing."
    );
    return;
  }

  if (session.state === OWNER_STATES.USERNAME) {
    if (!trimmed) {
      await bot.sendMessage(chatId, "❗️ Login bo'sh bo'lishi mumkin emas.");
      await sendOwnerPrompt(
        bot,
        chatId,
        "✍️ Login kiriting yoki \"auto\" deb yozing (bo'sh joylarsiz, faqat lotin harflari)."
      );
      return;
    }

    const lower = trimmed.toLowerCase();
    const nextDraft = { ...draft };
    if (lower === "auto" || trimmed === "-") {
      nextDraft.username = null;
      nextDraft.usernameAuto = true;
    } else {
      const sanitized = sanitizeUsernameInput(trimmed).replace(/[^a-z0-9._-]/g, "");
      if (sanitized.length < 3) {
        await bot.sendMessage(chatId, "❗️ Login kamida 3 ta lotin harfidan iborat bo'lsin.");
        await sendOwnerPrompt(
          bot,
          chatId,
          "✍️ Login kiriting (faqat lotin harflari, raqam va _ . - belgilariga ruxsat beriladi) yoki \"auto\" deb yozing."
        );
        return;
      }
      if (/[A-Z]/.test(trimmed)) {
        await bot.sendMessage(chatId, `ℹ️ Login kichik harflarga o'zgartirildi: ${sanitized}`);
      }
      nextDraft.username = sanitized;
      nextDraft.usernameAuto = false;
    }

    updateSession(chatId, { newOwnerDraft: nextDraft, state: OWNER_STATES.PASSWORD });
    await sendOwnerPrompt(
      bot,
      chatId,
      "🔑 Parolni kiriting (kamida 6 belgi).\n• Xavfsiz parol yaratish uchun \"auto\" deb yozing."
    );
    return;
  }

  if (session.state === OWNER_STATES.PASSWORD) {
    let password = trimmed;
    let generated = false;
    if (!password || password.toLowerCase() === "auto" || password === "-") {
      password = generateStrongPassword();
      generated = true;
      await bot.sendMessage(chatId, `🔐 Avtomatik yaratilgan parol: ${password}`);
    } else {
      if (password.length < 6) {
        await bot.sendMessage(chatId, "❗️ Parol kamida 6 belgi bo'lishi kerak.");
        await sendOwnerPrompt(
          bot,
          chatId,
          "🔑 Yangi parol kiriting (kamida 6 belgi) yoki \"auto\" deb yozing."
        );
        return;
      }
      if (/\s/.test(password)) {
        await bot.sendMessage(chatId, "❗️ Parolda bo'sh joy bo'lmasligi kerak.");
        await sendOwnerPrompt(
          bot,
          chatId,
          "🔑 Yangi parol kiriting (bo'sh joysiz) yoki \"auto\" deb yozing."
        );
        return;
      }
    }

    const nextDraft = { ...draft, password, passwordGenerated: generated };
    updateSession(chatId, { newOwnerDraft: nextDraft, state: OWNER_STATES.PIN });
    await sendOwnerPrompt(
      bot,
      chatId,
      "📌 Endi 4 xonali PIN-kodni yuboring (faqat raqam)."
    );
    return;
  }

  if (session.state === OWNER_STATES.PIN) {
    const pinCode = trimmed.replace(/\s+/g, "");
    if (!/^\d{4}$/.test(pinCode)) {
      await bot.sendMessage(chatId, "❗️ PIN 4 ta raqamdan iborat bo'lishi kerak.");
      await sendOwnerPrompt(bot, chatId, "📌 4 xonali PIN-kodni qaytadan yuboring.");
      return;
    }

    const registrationDraft = { ...draft, pinCode };
    const loading = await bot.sendMessage(chatId, "⏳ Yangi foydalanuvchi ro'yxatdan o'tkazilmoqda, iltimos kuting...");

    const result = await createOwnerAccount({
      name: registrationDraft.name,
      username: registrationDraft.username,
      password: registrationDraft.password,
      pinCode,
      apiToken: session?.apiToken,
    });

    if (loading?.message_id) {
      await deleteMessageSilently(bot, chatId, loading.message_id);
    }

    if (!result.ok) {
      const errorMessage = result.message || "Foydalanuvchini yaratib bo'lmadi.";
      await bot.sendMessage(chatId, `❌ ${errorMessage}`);

      if (result.code === "USERNAME_EXISTS") {
        const nextDraft = { ...draft, username: undefined };
        updateSession(chatId, { newOwnerDraft: nextDraft, state: OWNER_STATES.USERNAME });
        await sendOwnerPrompt(
          bot,
          chatId,
          "🔁 Bu login band. Boshqa login kiriting yoki \"auto\" deb yozing."
        );
      } else {
        updateSession(chatId, { newOwnerDraft: { ...draft }, state: OWNER_STATES.PIN });
        await sendOwnerPrompt(bot, chatId, "📌 Iltimos, PIN-kodni qaytadan yuboring.");
      }
      return;
    }

    const resetResult = result.id
      ? await performSystemReset({
          keepUserId: result.id,
          apiToken: session?.apiToken,
        })
      : { ok: false, message: "Yangi foydalanuvchi identifikatori aniqlanmadi." };

    const sessionBeforeCleanup = getSession(chatId);
    if (sessionBeforeCleanup?.ownerPromptMessageId) {
      await deleteMessageSilently(bot, chatId, sessionBeforeCleanup.ownerPromptMessageId);
    }

    const finalUsername = result.username || registrationDraft.username;
    const summary = buildOwnerSummaryMessage({
      name: registrationDraft.name,
      username: finalUsername,
      password: registrationDraft.password,
      pinCode,
      passwordGenerated: Boolean(registrationDraft.passwordGenerated),
      resetSucceeded: Boolean(resetResult?.ok),
      resetMessage: resetResult?.message,
    });

    await bot.sendMessage(chatId, summary);

    destroySession(chatId);
    await showLoginIntro(bot, chatId, {
      message: "🔄 Barcha eski ma'lumotlar tozalandi. Yangi login va parol bilan tizimga qayta kiring.",
    });
  }
};

const validateAdminCredentials = async (username, password) => {
  if (usingApiData) {
    if (!apiClient || !backendApiUrl) {
      return {
        ok: false,
        message: "⚠️ BACKEND_API_URL sozlanmagan. Iltimos, .env faylini tekshiring.",
      };
    }
    try {
      const response = await apiClient.post("/api/auth/login", { username, password });
      const { token, user } = response.data || {};
      if (!user || !token) {
        return {
          ok: false,
          message: "❌ Backend javobida foydalanuvchi yoki token topilmadi.",
        };
      }
      if (user.role !== "admin") {
        return { ok: false, message: "🚫 Faqat admin foydalanuvchilar botdan foydalanishi mumkin." };
      }

      const normalizedUser = {
        _id: user.id || user._id,
        id: user.id || user._id,
        username: user.username,
        name: user.name,
        role: user.role,
      };

      return { ok: true, user: normalizedUser, token };
    } catch (error) {
      const status = error?.response?.status;
      const apiMessage = error?.response?.data?.message;
      if (status === 400 || status === 401) {
        return { ok: false, message: "❌ Login yoki parol noto'g'ri." };
      }
      return {
        ok: false,
        message: apiMessage ? `❌ ${apiMessage}` : "❌ Kirishda xatolik yuz berdi.",
      };
    }
  }

  const user = await User.findOne({ username });
  if (!user) {
    return { ok: false, message: "❌ Foydalanuvchi topilmadi." };
  }
  if (user.role !== "admin") {
    return { ok: false, message: "🚫 Faqat admin foydalanuvchilar botdan foydalanishi mumkin." };
  }

  const passwordOk = await user.comparePassword(password);
  if (!passwordOk) {
    return { ok: false, message: "❌ Parol noto'g'ri." };
  }

  return { ok: true, user };
};

const startLoginFlow = async (bot, chatId, options = {}) => {
  const session = updateSession(chatId, { state: "awaiting_login" });
  const baseText = "🔐 Admin login va parolni bir xil xabarda yuboring. Masalan: admin 1234";
  const notice = options.notice;
  const text = notice ? `${notice}\n\n${baseText}` : baseText;
  const replyMarkup = buildCancelMarkup("login");
  const existingId = session?.loginPromptMessageId;
  let cleanupTarget = existingId || null;

  if (existingId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: existingId,
        reply_markup: replyMarkup,
      });
      updateSession(chatId, { loginPromptMessageId: existingId, customPromptMessageId: undefined, menuMessageId: undefined });
      return { message_id: existingId };
    } catch (error) {
      const description = error?.response?.body?.description || error.message;
      if (description?.toLowerCase().includes("message is not modified")) {
        return { message_id: existingId };
      }
      if (description?.toLowerCase().includes("message to edit not found")) {
        cleanupTarget = null;
      }
      updateSession(chatId, { customPromptMessageId: undefined, menuMessageId: undefined });
    }
  }

  const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
  updateSession(chatId, { loginPromptMessageId: sent.message_id, customPromptMessageId: undefined, menuMessageId: undefined });

  if (cleanupTarget) {
    await deleteMessageSilently(bot, chatId, cleanupTarget);
  }
  return sent;
};

const startCustomRangeFlow = async (bot, chatId) => {
  const session = updateSession(chatId, { state: "awaiting_custom_range" });
  const text = "🗓️ Iltimos, sanalarni yuboring. Masalan: 2025-01-01 2025-01-07 yoki from=2025-01-01 to=2025-01-15";
  const replyMarkup = buildCancelMarkup("custom");
  const existingId = session?.customPromptMessageId;
  let cleanupTarget = existingId || null;

  if (existingId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: existingId,
        reply_markup: replyMarkup,
      });
      updateSession(chatId, { customPromptMessageId: existingId });
      return { message_id: existingId };
    } catch (error) {
      const description = error?.response?.body?.description || error.message;
      if (description?.toLowerCase().includes("message is not modified")) {
        return { message_id: existingId };
      }
      if (description?.toLowerCase().includes("message to edit not found")) {
        cleanupTarget = null;
      }
      updateSession(chatId, { loginPromptMessageId: undefined });
    }
  }

  const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
  updateSession(chatId, { customPromptMessageId: sent.message_id });

  if (cleanupTarget) {
    await deleteMessageSilently(bot, chatId, cleanupTarget);
  }
  return sent;
};

const showLoginIntro = async (bot, chatId, options = {}) => {
  const baseText = "👋 Assalomu alaykum!\n\nBu bot orqali restoran hisobotlarini tezda yuklab olishingiz mumkin." +
    '\nBoshlash uchun "Tizimga kirish" tugmasini bosing va admin login/parolingizni yuboring.';
  const notice = options.message;
  const text = notice ? `${notice}\n\n${baseText}` : baseText;
  const session = updateSession(chatId, { state: undefined });
  const existingId = session?.loginPromptMessageId;
  let cleanupTarget = existingId || null;

  if (existingId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: existingId,
        reply_markup: LOGIN_KEYBOARD,
      });
      updateSession(chatId, {
        loginPromptMessageId: existingId,
        menuMessageId: undefined,
        customPromptMessageId: undefined,
      });
      return { message_id: existingId };
    } catch (error) {
      const description = error?.response?.body?.description || error.message;
      const lower = description ? description.toLowerCase() : "";
      if (lower.includes("message is not modified")) {
        return { message_id: existingId };
      }
      if (lower.includes("message to edit not found")) {
        cleanupTarget = null;
      }
      updateSession(chatId, { loginPromptMessageId: undefined, menuMessageId: undefined });
    }
  }

  const sent = await bot.sendMessage(chatId, text, { reply_markup: LOGIN_KEYBOARD });
  updateSession(chatId, {
    loginPromptMessageId: sent.message_id,
    menuMessageId: undefined,
    customPromptMessageId: undefined,
  });

  if (cleanupTarget) {
    await deleteMessageSilently(bot, chatId, cleanupTarget);
  }

  return sent;
};

const resetFlowState = async (bot, chatId) => {
  const session = getSession(chatId);
  if (!session) {
    return;
  }

  if (session.loginPromptMessageId) {
    await deleteMessageSilently(bot, chatId, session.loginPromptMessageId);
  }
  if (session.customPromptMessageId) {
    await deleteMessageSilently(bot, chatId, session.customPromptMessageId);
  }
  if (session.ownerPromptMessageId) {
    await deleteMessageSilently(bot, chatId, session.ownerPromptMessageId);
  }

  if (session.userId) {
    updateSession(chatId, {
      state: "authenticated",
      loginPromptMessageId: undefined,
      customPromptMessageId: undefined,
      ownerPromptMessageId: undefined,
      newOwnerDraft: undefined,
    });
  } else {
    destroySession(chatId);
  }
};

const sendUnauthorized = async (bot, chatId) => {
  await showLoginIntro(bot, chatId, {
    message: "🔐 Ushbu amaliyot uchun tizimga kirish kerak."
      + '\n\n"Tizimga kirish" tugmasini bosing yoki /login <foydalanuvchi> <parol> yuboring.',
  });
};

const introduceBot = async (bot, chatId) => {
  const session = getSession(chatId);
  if (session?.userId) {
    await sendMainMenu(bot, chatId, session.name || session.username);
    return;
  }

  await showLoginIntro(bot, chatId);
};

const formatSummary = (report, rangeLabel) => {
  const totals = report?.totals || {};
  return (
    "📊 Hisobot tayyor: " +
    (rangeLabel || "Tanlangan davr") +
    "\n• Umumiy tushum: " + (totals.grossSales?.toLocaleString("uz-UZ") || 0) +
    " so'm\n• Sof tushum: " + (totals.netSales?.toLocaleString("uz-UZ") || 0) +
    " so'm\n• Buyurtmalar: " + (totals.ordersCount || 0) +
    " ta\n• Chegirmalar: " + (totals.discountGiven?.toLocaleString("uz-UZ") || 0) +
    " so'm\n• Servis: " + (totals.taxCollected?.toLocaleString("uz-UZ") || 0) +
    " so'm"
  );
};

const requestReport = async (bot, chatId, session, rawArgs) => {
  if (!session || !session.userId) {
    await sendUnauthorized(bot, chatId);
    return false;
  }

  if (usingApiData && !session.apiToken) {
    destroySession(chatId);
    await sendUnauthorized(bot, chatId);
    return false;
  }

  let range;
  try {
    range = parseReportArguments(rawArgs || "");
  } catch (error) {
    await bot.sendMessage(chatId, `⚠️ ${error.message}`);
    return false;
  }

  const loadingMessage = await bot.sendMessage(chatId, "⏳ Hisobot tayyorlanmoqda, iltimos kuting...");

  try {
    const { fromDate, toDate } = resolveDateRange(range.from, range.to);
    let report;
    let buffer;

    if (usingApiData) {
      if (!apiClient) {
        throw new Error("BACKEND_API_URL sozlanmagan");
      }
      const params = {};
      if (range.from) params.from = range.from;
      if (range.to) params.to = range.to;
      const headers = { Authorization: `Bearer ${session.apiToken}` };

      const [summaryResponse, exportResponse] = await Promise.all([
        apiClient.get("/api/reports/sales", { params, headers }),
        apiClient.get("/api/reports/sales/export", {
          params,
          headers,
          responseType: "arraybuffer",
        }),
      ]);

      report = summaryResponse.data;
      buffer = exportResponse.data;
      if (!report || typeof report !== "object") {
        throw new Error("Backend hisobot ma'lumotini qaytarmadi.");
      }
      if (!buffer) {
        throw new Error("Backend hisobot faylini qaytarmadi.");
      }
    } else {
      const data = await buildSalesReport(fromDate, toDate);
      report = data.report;
      const workbookBuffer = await createSalesReportWorkbook({
        report,
        orders: data.orders,
        fromDate,
        toDate,
      });
      buffer = workbookBuffer;
    }

    const filename = `hisobot-${formatDateShort(fromDate)}-${formatDateShort(toDate)}.xlsx`;

    await bot.sendDocument(
      chatId,
      Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      {
        caption: formatSummary(report, range.label),
      },
      {
        filename,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }
    );

    await bot.editMessageText(
      `✅ Hisobot tayyor (${range.label || "Tanlangan davr"}). \nYaratilgan: ${formatDateTime(report.generatedAt)}.`,
      {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
      }
    );

    if (session?.customPromptMessageId) {
      await deleteMessageSilently(bot, chatId, session.customPromptMessageId);
    }

    updateSession(chatId, { state: "authenticated", customPromptMessageId: undefined });
    return true;
  } catch (error) {
    console.error("[TelegramBot] Report error", error);
    const status = error?.response?.status;
    if (usingApiData && status === 401) {
      await bot.editMessageText(
        "🔐 Sessiya tugadi. Iltimos qayta login qiling.",
        {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
        }
      ).catch(() => {});
      destroySession(chatId);
      await showLoginIntro(bot, chatId, {
        message: "🔐 Sessiya tugadi. Qayta login qilish kerak.",
      });
      return false;
    }
    await bot.editMessageText(
      "❌ Hisobotni tayyorlashda xatolik yuz berdi. Iltimos, keyinroq qayta urinib ko'ring.",
      {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
      }
    );
    return false;
  }
};

export const initTelegramBot = (options = {}) => {
  const { app } = options;
  refreshApiConfig();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.info("[TelegramBot] TELEGRAM_BOT_TOKEN topilmadi. Bot ishga tushirilmadi.");
    return null;
  }

  const globalKey = Symbol.for("pos/telegram-bot");
  const existing = globalThis[globalKey];
  if (existing) {
    console.info("[TelegramBot] Bot avval ishga tushirilgan, mavjud instance ishlatilmoqda.");
    return existing;
  }

  const bot = new TelegramBot(token, { polling: false });
  const webhookUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
  const webhookSecret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
  let webhookPath = process.env.TELEGRAM_BOT_WEBHOOK_PATH;
  const wantsWebhook = Boolean(webhookUrl);
  const canUseWebhook = wantsWebhook && Boolean(app);

  (async () => {
    try {
      await bot.setMyCommands([
        { command: "start", description: "Boshlash va menyuni ko'rish" },
        { command: "login", description: "Admin login (masalan: /login admin 1234)" },
        { command: "menu", description: "Hisobot menyusini ochish" },
        { command: "report", description: "Hisobot buyurtma qilish" },
        { command: "logout", description: "Botdan chiqish" },
        { command: "cancel", description: "Jarayonni bekor qilish" },
        { command: "help", description: "Yordam va ko'rsatmalar" },
      ]);
    } catch (error) {
      console.warn("[TelegramBot] setMyCommands bajarilmadi", error.message);
    }
  })();

  const enablePolling = () => {
    if (pollingSuppressed) {
      return;
    }
    let startLogged = false;

    async function startPolling() {
      // Removed redundant check for polling suppression
      try {
        await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});
        await bot.startPolling();
        if (!startLogged) {
          console.info("[TelegramBot] Bot ishga tushdi (polling).");
          startLogged = true;
        }
        pollingConflictLogged = false;
      } catch (error) {
        if (isConflictError(error)) {
          logPollingConflictOnce();
          return;
        }
        console.error("[TelegramBot] Pollingni ishga tushirishda xatolik", error);
      }
    }
    if (!pollingSuppressed) {
      startPolling();
    }
  };

  if (canUseWebhook) {
    if (!webhookPath) {
      try {
        const parsed = new URL(webhookUrl);
        webhookPath = parsed.pathname || "/api/telegram/webhook";
      } catch (error) {
        console.warn("[TelegramBot] TELEGRAM_BOT_WEBHOOK_URL noto'g'ri formatda. Default path ishlatiladi.", error.message);
        webhookPath = "/api/telegram/webhook";
      }
    }
    if (!webhookPath.startsWith("/")) {
      webhookPath = `/${webhookPath}`;
    }

    const routeFlagKey = Symbol.for("pos/telegram-webhook-route");
    if (!app.locals[routeFlagKey]) {
      app.post(webhookPath, (req, res) => {
        if (webhookSecret) {
          const tokenHeader = req.get("X-Telegram-Bot-Api-Secret-Token");
          if (tokenHeader !== webhookSecret) {
            return res.sendStatus(401);
          }
        }
        bot.processUpdate(req.body);
        res.sendStatus(200);
      });
      app.locals[routeFlagKey] = { path: webhookPath };
      console.info(`[TelegramBot] Webhook marshruti ro'yxatga olindi: ${webhookPath}`);
    }

    (async () => {
      try {
        await bot.setWebHook(webhookUrl, {
          secret_token: webhookSecret || undefined,
          allowed_updates: ["message", "callback_query"],
        });
        console.info(`[TelegramBot] Webhook rejimi yoqildi. URL: ${webhookUrl}`);
      } catch (error) {
        console.error("[TelegramBot] Webhookni sozlashda xatolik. Polling rejimga o'tiladi.", error);
        enablePolling();
      }
    })();
  } else {
    if (wantsWebhook && !app) {
      console.warn("[TelegramBot] Express app o'tkazilmagani uchun webhook ishlatilmayapti. Polling rejim ishlatiladi.");
    }
    enablePolling();
  }

  bot.onText(/^\/start$/i, async (msg) => {
    if (await shouldHandleCommandMessage(msg)) {
      introduceBot(bot, msg.chat.id);
    }
  });

  bot.onText(/^\/help$/i, async (msg) => {
    if (await shouldHandleCommandMessage(msg)) {
      introduceBot(bot, msg.chat.id);
    }
  });

  bot.onText(/^\/logout$/i, async (msg) => {
    if (!(await shouldHandleCommandMessage(msg))) {
      return;
    }
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (session?.menuMessageId) {
      await deleteMessageSilently(bot, chatId, session.menuMessageId);
    }
    if (session?.loginPromptMessageId) {
      await deleteMessageSilently(bot, chatId, session.loginPromptMessageId);
    }
    if (session?.customPromptMessageId) {
      await deleteMessageSilently(bot, chatId, session.customPromptMessageId);
    }
    if (session?.ownerPromptMessageId) {
      await deleteMessageSilently(bot, chatId, session.ownerPromptMessageId);
    }

    destroySession(chatId);
    await showLoginIntro(bot, chatId, {
      message: "🚪 Profilingizdan chiqdingiz. Qayta kirish uchun \"Tizimga kirish\" tugmasidan foydalaning.",
    });
  });

  bot.onText(/^\/login\s+(.+)$/i, async (msg, match) => {
    if (!(await shouldHandleCommandMessage(msg))) {
      return;
    }
    const chatId = msg.chat.id;
    const args = (match && match[1]) || "";
    const [usernameRaw, ...passwordParts] = args.trim().split(/\s+/);
    if (!usernameRaw || passwordParts.length === 0) {
      bot.sendMessage(chatId, "Foydalanish: /login <foydalanuvchi> <parol>");
      return;
    }
    const username = usernameRaw.trim();
    const password = passwordParts.join(" ");

    try {
      const result = await validateAdminCredentials(username, password);
      if (!result.ok) {
        bot.sendMessage(chatId, result.message);
        return;
      }

      await handleSuccessfulLogin(bot, chatId, result.user, { token: result.token });
    } catch (error) {
      console.error("[TelegramBot] Login error", error);
      bot.sendMessage(chatId, "❌ Kirishda xatolik yuz berdi. Keyinroq urinib ko'ring.");
    }
  });

  bot.onText(/^\/menu$/i, async (msg) => {
    if (!(await shouldHandleCommandMessage(msg))) {
      return;
    }
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (session?.userId) {
      await sendMainMenu(bot, chatId, session.name || session.username);
    } else {
      await introduceBot(bot, chatId);
    }
  });

  bot.onText(/^\/(owner|newowner|registerowner)$/i, async (msg) => {
    if (!(await shouldHandleCommandMessage(msg))) {
      return;
    }
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (!session?.userId) {
      await sendUnauthorized(bot, chatId);
      return;
    }
    if (session.role !== "admin") {
      await bot.sendMessage(chatId, "🚫 Ushbu amal faqat admin foydalanuvchilar uchun mavjud.");
      return;
    }

    if (session.menuMessageId) {
      await deleteMessageSilently(bot, chatId, session.menuMessageId);
      updateSession(chatId, { menuMessageId: undefined });
    }

    await startOwnerRegistrationFlow(bot, chatId);
  });

  bot.onText(/^\/cancel$/i, async (msg) => {
    if (!(await shouldHandleCommandMessage(msg))) {
      return;
    }
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (!session || !session.state || session.state === "authenticated") {
      bot.sendMessage(chatId, "❗️ Bekor qilinadigan jarayon yo'q.");
      return;
    }

    await resetFlowState(bot, chatId);

    if (session.userId) {
      bot.sendMessage(chatId, "❌ Amal bekor qilindi.");
      await sendMainMenu(bot, chatId, session.name || session.username);
    } else {
      await showLoginIntro(bot, chatId, { message: "❌ Amal bekor qilindi." });
    }
  });


  bot.onText(/^\/report(?:\s+(.+))?$/i, async (msg, match) => {
    if (!(await shouldHandleCommandMessage(msg))) {
      return;
    }
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    const rawArgs = match ? match[1] : "";
    await requestReport(bot, chatId, session, rawArgs);
  });

  bot.on("callback_query", async (query) => {
    const { data, message, id } = query;

    if (!(await shouldHandleCallbackQuery(query))) {
      await bot.answerCallbackQuery(id).catch(() => {});
      return;
    }
    const chatId = message?.chat.id;
    if (!data || !chatId) {
      await bot.answerCallbackQuery(id).catch(() => {});
      return;
    }

    const session = getSession(chatId);

    if (data === "login:start") {
      if (session?.userId) {
        await bot.answerCallbackQuery(id, { text: "Siz allaqachon tizimdasiz." }).catch(() => {});
        await sendMainMenu(bot, chatId, session.name || session.username);
      } else {
        await bot.answerCallbackQuery(id).catch(() => {});
        await startLoginFlow(bot, chatId);
      }
      return;
    }

    if (data === "cancel:login") {
      await bot.answerCallbackQuery(id, { text: "Bekor qilindi." }).catch(() => {});
      await resetFlowState(bot, chatId);
      if (session?.userId) {
        await sendMainMenu(bot, chatId, session.name || session.username);
      } else {
        await showLoginIntro(bot, chatId, { message: "❌ Tizimga kirish bekor qilindi." });
      }
      return;
    }

    if (data === "cancel:custom") {
      await bot.answerCallbackQuery(id, { text: "Bekor qilindi." }).catch(() => {});
      await resetFlowState(bot, chatId);
      if (session?.userId) {
        await sendMainMenu(bot, chatId, session.name || session.username);
      }
      return;
    }

    if (data === "cancel:owner") {
      await bot.answerCallbackQuery(id, { text: "Bekor qilindi." }).catch(() => {});
      await resetFlowState(bot, chatId);
      const refreshed = getSession(chatId);
      if (refreshed?.userId) {
        await sendMainMenu(bot, chatId, refreshed.name || refreshed.username);
      } else {
        await showLoginIntro(bot, chatId, { message: "❌ Amal bekor qilindi." });
      }
      return;
    }

    if (data === "logout") {
      await bot.answerCallbackQuery(id, { text: "Chiqdingiz." }).catch(() => {});
      const sessionForLogout = getSession(chatId);
      if (sessionForLogout?.menuMessageId) {
        await deleteMessageSilently(bot, chatId, sessionForLogout.menuMessageId);
      }
      if (sessionForLogout?.loginPromptMessageId) {
        await deleteMessageSilently(bot, chatId, sessionForLogout.loginPromptMessageId);
      }
      if (sessionForLogout?.customPromptMessageId) {
        await deleteMessageSilently(bot, chatId, sessionForLogout.customPromptMessageId);
      }
      if (sessionForLogout?.ownerPromptMessageId) {
        await deleteMessageSilently(bot, chatId, sessionForLogout.ownerPromptMessageId);
      }
      destroySession(chatId);
      await showLoginIntro(bot, chatId, {
        message: "🚪 Profilingizdan chiqdingiz. Qayta kirish uchun \"Tizimga kirish\" tugmasidan foydalaning.",
      });
      return;
    }

    if (data === "owner:new") {
      if (!session?.userId) {
        await bot.answerCallbackQuery(id, {
          text: "Avval tizimga kiring.",
          show_alert: true,
        }).catch(() => {});
        return;
      }
      if (session.role !== "admin") {
        await bot.answerCallbackQuery(id, {
          text: "Ushbu amal faqat adminlar uchun.",
          show_alert: true,
        }).catch(() => {});
        return;
      }

      await bot.answerCallbackQuery(id).catch(() => {});
      if (session.menuMessageId) {
        await deleteMessageSilently(bot, chatId, session.menuMessageId);
        updateSession(chatId, { menuMessageId: undefined });
      }
      await startOwnerRegistrationFlow(bot, chatId);
      return;
    }

    if (data.startsWith("report:")) {
      if (!session?.userId) {
        await bot.answerCallbackQuery(id, {
          text: "Avval tizimga kiring.",
          show_alert: true,
        }).catch(() => {});
        return;
      }

      const rangeKey = data.split(":")[1];
      if (rangeKey === "custom") {
        await bot.answerCallbackQuery(id).catch(() => {});
        await startCustomRangeFlow(bot, chatId);
        return;
      }

      await bot.answerCallbackQuery(id).catch(() => {});
      await requestReport(bot, chatId, session, rangeKey);
      return;
    }

    await bot.answerCallbackQuery(id).catch(() => {});
  });

  bot.on("message", async (msg) => {
    if (!msg.text) {
      return;
    }
    if (msg.from?.is_bot) {
      return;
    }

    const text = msg.text.trim();
    if (!text || text.startsWith("/")) {
      return;
    }

    if (!(await shouldHandleTextMessage(msg))) {
      return;
    }

    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (!session || !session.state) {
      return;
    }

    const lower = text.toLowerCase();
    if (lower === "cancel" || lower === "bekor" || lower === "stop") {
      await resetFlowState(bot, chatId);
      if (session.userId) {
        bot.sendMessage(chatId, "❌ Amal bekor qilindi.");
        await sendMainMenu(bot, chatId, session.name || session.username);
      } else {
        await showLoginIntro(bot, chatId, { message: "❌ Amal bekor qilindi." });
      }
      return;
    }

    if (session.state && session.state.startsWith("register_owner")) {
      await handleOwnerFlowMessage(bot, chatId, session, text);
      return;
    }

    if (session.state === "awaiting_login") {
      const [usernameRaw, ...passwordParts] = text.split(/\s+/);
      if (!usernameRaw || passwordParts.length === 0) {
        bot.sendMessage(chatId, "Iltimos login va parolni probel bilan ajratib yuboring. Masalan: admin 1234");
        return;
      }

      const username = usernameRaw.trim();
      const password = passwordParts.join(" ");

      try {
        const result = await validateAdminCredentials(username, password);
        if (!result.ok) {
          bot.sendMessage(chatId, result.message);
          return;
        }

        await handleSuccessfulLogin(bot, chatId, result.user, { token: result.token });
      } catch (error) {
        console.error("[TelegramBot] Login flow error", error);
        bot.sendMessage(chatId, "❌ Kirishda xatolik yuz berdi. Keyinroq urinib ko'ring.");
      }
      return;
    }

    if (session.state === "awaiting_custom_range") {
      const success = await requestReport(bot, chatId, session, text);
      if (success) {
        const refreshed = getSession(chatId);
        const displayName = refreshed?.name || refreshed?.username;
        await sendMainMenu(bot, chatId, displayName, {
          text: "🔁 Yana bir hisobot tanlang.",
        });
      }
      return;
    }

    if (session.state === "authenticated") {
      if (lower === "hisobot" || lower === "hisobotlar" || lower === "report") {
        await sendMainMenu(bot, chatId, session.name || session.username, {
          text: "📊 Qaysi hisobot kerak? Quyidagi tugmalardan birini tanlang.",
        });
        return;
      }
    }
  });

  bot.on("polling_error", (error) => {
    if (isConflictError(error)) {
      logPollingConflictOnce();
      return;
    }
    console.error("[TelegramBot] Polling error", error.message);
  });

  globalThis[globalKey] = bot;
  return bot;
};
