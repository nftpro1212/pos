import TelegramBot from "node-telegram-bot-api";
import User from "../models/User.js";
import {
  buildSalesReport,
  resolveDateRange,
  createSalesReportWorkbook,
  formatDateShort,
  formatDateTime,
} from "./reportService.js";

const SESSIONS = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 soat

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

const processedKeys = new Map();
const processedQueue = [];
const PROCESSED_LIMIT = 3000;

const registerProcessedKey = (key) => {
  if (!key) {
    return true;
  }
  if (processedKeys.has(key)) {
    return false;
  }
  processedKeys.set(key, Date.now());
  processedQueue.push(key);
  if (processedQueue.length > PROCESSED_LIMIT) {
    const oldestKey = processedQueue.shift();
    if (oldestKey) {
      processedKeys.delete(oldestKey);
    }
  }
  return true;
};

const shouldHandleCommandMessage = (msg) =>
  registerProcessedKey(`cmd:${msg.chat?.id}:${msg.message_id}`);

const shouldHandleTextMessage = (msg) =>
  registerProcessedKey(`txt:${msg.chat?.id}:${msg.message_id}`);

const shouldHandleCallbackQuery = (callbackId) =>
  registerProcessedKey(`cb:${callbackId}`);

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

const handleSuccessfulLogin = async (bot, chatId, user) => {
  const previous = getSession(chatId);

  if (previous?.loginPromptMessageId) {
    await deleteMessageSilently(bot, chatId, previous.loginPromptMessageId);
  }
  if (previous?.customPromptMessageId) {
    await deleteMessageSilently(bot, chatId, previous.customPromptMessageId);
  }

  updateSession(chatId, {
    userId: user._id.toString(),
    username: user.username,
    name: user.name,
    role: user.role,
    state: "authenticated",
  });

  return sendMainMenu(bot, chatId, user.name, {
    text: `✅ Xush kelibsiz, ${user.name}!\nQuyidagi tugmalardan kerakli hisobotni tanlang.`,
  });
};

const validateAdminCredentials = async (username, password) => {
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

  if (session.userId) {
    updateSession(chatId, { state: "authenticated", loginPromptMessageId: undefined, customPromptMessageId: undefined });
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
    const { report, orders } = await buildSalesReport(fromDate, toDate);
    const buffer = await createSalesReportWorkbook({ report, orders, fromDate, toDate });
    const filename = `hisobot-${formatDateShort(fromDate)}-${formatDateShort(toDate)}.xlsx`;

    await bot.sendDocument(
      chatId,
      Buffer.from(buffer),
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
  let requestPollingRestart = null;

  const enablePolling = () => {
    let restartTimer = null;

    async function startPolling() {
      try {
        await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});
        await bot.startPolling();
        console.info("[TelegramBot] Bot ishga tushdi (polling).");
      } catch (error) {
        if (isConflictError(error)) {
          scheduleRestart();
          return;
        }
        console.error("[TelegramBot] Pollingni ishga tushirishda xatolik", error);
      }
    }

    function scheduleRestart() {
      if (restartTimer) {
        return;
      }
      console.warn("[TelegramBot] Boshqa instance polling qilmoqda. 5 soniyadan keyin qayta uriniladi.");
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startPolling();
      }, 5000);
    }

    requestPollingRestart = scheduleRestart;
    startPolling();
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

  bot.onText(/^\/start$/i, (msg) => {
    if (!shouldHandleCommandMessage(msg)) {
      return;
    }
    introduceBot(bot, msg.chat.id);
  });

  bot.onText(/^\/help$/i, (msg) => {
    if (!shouldHandleCommandMessage(msg)) {
      return;
    }
    introduceBot(bot, msg.chat.id);
  });

  bot.onText(/^\/logout$/i, async (msg) => {
    if (!shouldHandleCommandMessage(msg)) {
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

    destroySession(chatId);
    await showLoginIntro(bot, chatId, {
      message: "🚪 Profilingizdan chiqdingiz. Qayta kirish uchun \"Tizimga kirish\" tugmasidan foydalaning.",
    });
  });

  bot.onText(/^\/login\s+(.+)$/i, async (msg, match) => {
    if (!shouldHandleCommandMessage(msg)) {
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

      await handleSuccessfulLogin(bot, chatId, result.user);
    } catch (error) {
      console.error("[TelegramBot] Login error", error);
      bot.sendMessage(chatId, "❌ Kirishda xatolik yuz berdi. Keyinroq urinib ko'ring.");
    }
  });

  bot.onText(/^\/menu$/i, async (msg) => {
    if (!shouldHandleCommandMessage(msg)) {
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

  bot.onText(/^\/cancel$/i, async (msg) => {
    if (!shouldHandleCommandMessage(msg)) {
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
    if (!shouldHandleCommandMessage(msg)) {
      return;
    }
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    const rawArgs = match ? match[1] : "";
    await requestReport(bot, chatId, session, rawArgs);
  });

  bot.on("callback_query", async (query) => {
    const { data, message, id } = query;

    if (!shouldHandleCallbackQuery(id)) {
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
      destroySession(chatId);
      await showLoginIntro(bot, chatId, {
        message: "🚪 Profilingizdan chiqdingiz. Qayta kirish uchun \"Tizimga kirish\" tugmasidan foydalaning.",
      });
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

    if (!shouldHandleTextMessage(msg)) {
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

        await handleSuccessfulLogin(bot, chatId, result.user);
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
    }
  });

  bot.on("polling_error", (error) => {
    if (isConflictError(error) && requestPollingRestart) {
      requestPollingRestart();
      return;
    }
    console.error("[TelegramBot] Polling error", error.message);
  });

  globalThis[globalKey] = bot;
  return bot;
};
