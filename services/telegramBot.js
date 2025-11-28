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

const setSession = (chatId, payload) => {
  SESSIONS.set(chatId, {
    ...payload,
    chatId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
};

const destroySession = (chatId) => {
  SESSIONS.delete(chatId);
};

const sendUnauthorized = (bot, chatId) => {
  bot.sendMessage(
    chatId,
    "🔐 Ushbu amaliyot uchun tizimga kirish kerak. \n\n/login <foydalanuvchi> <parol> buyrug'idan foydalaning. faqat adminlar uchun ruxsat etiladi."
  );
};

const introduceBot = (bot, chatId) => {
  bot.sendMessage(
    chatId,
    "👋 Assalomu alaykum!\n\nBu bot orqali restoran hisobotlarini telegram orqali tezda yuklab olishingiz mumkin.\n\n" +
      "Boshlash uchun /login <foydalanuvchi> <parol> buyrug'ini yuboring (faqat admin uchun).\n" +
      "Hisobot olish uchun /report [davr] buyruqlaridan foydalaning. Masalan:\n" +
      "• /report — oxirgi 7 kun\n" +
      "• /report today — bugungi hisobot\n" +
      "• /report 2025-01-01 2025-01-07 — aniq sanalar\n" +
      "• /report from=2025-01-01 to=2025-01-31"
  );
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

export const initTelegramBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.info("[TelegramBot] TELEGRAM_BOT_TOKEN topilmadi. Bot ishga tushirilmadi.");
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  console.info("[TelegramBot] Bot ishga tushdi (polling).");

  bot.onText(/^\/start$/i, (msg) => {
    introduceBot(bot, msg.chat.id);
  });

  bot.onText(/^\/help$/i, (msg) => {
    introduceBot(bot, msg.chat.id);
  });

  bot.onText(/^\/logout$/i, (msg) => {
    destroySession(msg.chat.id);
    bot.sendMessage(msg.chat.id, "✅ Profilingizdan chiqdingiz. /login orqali yana tizimga kirishingiz mumkin.");
  });

  bot.onText(/^\/login\s+(.+)$/i, async (msg, match) => {
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
      const user = await User.findOne({ username });
      if (!user) {
        bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi." );
        return;
      }
      if (user.role !== "admin") {
        bot.sendMessage(chatId, "🚫 Faqat admin foydalanuvchilar botdan foydalanishi mumkin.");
        return;
      }

      const passwordOk = await user.comparePassword(password);
      if (!passwordOk) {
        bot.sendMessage(chatId, "❌ Parol noto'g'ri.");
        return;
      }

      setSession(chatId, {
        userId: user._id.toString(),
        username: user.username,
        name: user.name,
        role: user.role,
      });

      bot.sendMessage(
        chatId,
        `✅ Xush kelibsiz, ${user.name}!\n\nHisobot uchun /report buyrug'idan foydalaning. Masalan /report today yoki /report 2025-01-01 2025-01-07.`
      );
    } catch (error) {
      console.error("[TelegramBot] Login error", error);
      bot.sendMessage(chatId, "❌ Kirishda xatolik yuz berdi. Keyinroq urinib ko'ring.");
    }
  });

  bot.onText(/^\/report(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (!session) {
      sendUnauthorized(bot, chatId);
      return;
    }

    let range;
    try {
      range = parseReportArguments(match ? match[1] : "");
    } catch (error) {
      bot.sendMessage(chatId, `⚠️ ${error.message}`);
      return;
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
    } catch (error) {
      console.error("[TelegramBot] Report error", error);
      bot.editMessageText(
        "❌ Hisobotni tayyorlashda xatolik yuz berdi. Iltimos, keyinroq qayta urinib ko'ring.",
        {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
        }
      );
    }
  });

  bot.on("polling_error", (error) => {
    console.error("[TelegramBot] Polling error", error.message);
  });

  return bot;
};
