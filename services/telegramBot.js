import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Restaurant from "../models/Restaurant.js";
import Settings from "../models/Settings.js";

const MODE_API = (process.env.TELEGRAM_BOT_DATA_MODE || "direct").toLowerCase() === "api";
const BACKEND_API_URL = (process.env.BACKEND_API_URL || "").replace(/\/$/, "");
const SESSIONS = new Map();

const OWNER_STATES = {
	NAME: "owner_name",
	USERNAME: "owner_username",
	PASSWORD: "owner_password",
	PIN: "owner_pin",
};

const MENU_KEYBOARD = {
	inline_keyboard: [[{ text: "➕ Restoran egasini qo'shish", callback_data: "owner:new" }], [{ text: "🚪 Chiqish", callback_data: "logout" }]],
};

const LOGIN_KEYBOARD = {
	inline_keyboard: [[{ text: "🔐 Tizimga kirish", callback_data: "login:start" }]],
};

const CANCEL_OWNER_KEYBOARD = {
	inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "owner:cancel" }]],
};

const CANCEL_LOGIN_KEYBOARD = {
	inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "login:cancel" }]],
};

const apiClient = MODE_API && BACKEND_API_URL
	? axios.create({ baseURL: BACKEND_API_URL, timeout: 20000 })
	: null;

const isMongoConnected = () => mongoose.connection?.readyState === 1;

const getSession = (chatId) => SESSIONS.get(chatId) || null;

const setSession = (chatId, updates) => {
	const current = getSession(chatId) || {};
	const next = { ...current, ...updates };
	Object.keys(next).forEach((key) => {
		if (next[key] === undefined) delete next[key];
	});
	if (Object.keys(next).length) {
		SESSIONS.set(chatId, next);
	} else {
		SESSIONS.delete(chatId);
	}
	return next;
};

const clearSession = (chatId) => {
	SESSIONS.delete(chatId);
};

const sanitizeUsername = (value = "") => value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

const slugify = (value = "") => value
	.toString()
	.trim()
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, "-")
	.replace(/^-+|-+$/g, "")
	|| `rest-${Date.now()}`;

const ensureUniqueRestaurantSlug = async (baseName) => {
	const base = slugify(baseName);
	let candidate = base;
	let counter = 2;
	while (await Restaurant.exists({ slug: candidate })) {
		candidate = `${base}-${counter}`;
		counter += 1;
	}
	return candidate;
};

const generateStrongPassword = (length = 10) => {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$";
	let result = "";
	for (let i = 0; i < length; i += 1) {
		result += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return result;
};

const generateUniqueUsername = async (name) => {
	let base = sanitizeUsername(name).replace(/[^a-z0-9]/g, "");
	if (!base) base = `user${Date.now()}`;
	let candidate = base;
	let counter = 1;
	while (await User.findOne({ username: candidate })) {
		candidate = `${base}${counter}`;
		counter += 1;
	}
	return candidate;
};

const createOwnerAccountLocal = async ({ name, username, password, pinCode }) => {
	if (!isMongoConnected()) {
		return { ok: false, message: "Ma'lumotlar bazasi ulanmagan." };
	}

	const desiredUsername = username ? sanitizeUsername(username) : "";
	let finalUsername = desiredUsername;

	if (finalUsername) {
		if (finalUsername.length < 3) {
			return { ok: false, message: "Login kamida 3 ta belgidan iborat bo'lsin." };
		}
		const exists = await User.findOne({ username: finalUsername });
		if (exists) {
			return { ok: false, message: "Bu login band.", code: "USERNAME_EXISTS" };
		}
	} else {
		finalUsername = await generateUniqueUsername(name);
	}

	let restaurantDoc = null;
	let settingsDoc = null;
	let userDoc = null;

	try {
		const passwordHash = await bcrypt.hash(password, 10);
		const pinHash = await bcrypt.hash(pinCode, 10);
		const trimmedName = (name || "Yangi Restoran").trim();
		const restaurantSlug = await ensureUniqueRestaurantSlug(trimmedName);

		restaurantDoc = await Restaurant.create({
			name: trimmedName,
			slug: restaurantSlug,
		});

		settingsDoc = await Settings.create({
			restaurant: restaurantDoc._id,
			restaurantName: trimmedName,
		});

		userDoc = await User.create({
			name,
			username: finalUsername,
			passwordHash,
			pinHash,
			role: "admin",
			restaurant: restaurantDoc._id,
		});

		await Restaurant.findByIdAndUpdate(
			restaurantDoc._id,
			{ owner: userDoc._id },
			{ new: true },
		);

		return {
			ok: true,
			username: userDoc.username,
			restaurantId: restaurantDoc._id.toString(),
		};
	} catch (error) {
		if (userDoc?._id) await User.deleteOne({ _id: userDoc._id }).catch(() => {});
		if (settingsDoc?._id) await Settings.deleteOne({ _id: settingsDoc._id }).catch(() => {});
		if (restaurantDoc?._id) await Restaurant.deleteOne({ _id: restaurantDoc._id }).catch(() => {});
		const message = error?.message || "Foydalanuvchini yaratib bo'lmadi.";
		const duplicate = message.toLowerCase().includes("duplicate") && message.toLowerCase().includes("username");
		return {
			ok: false,
			message: duplicate ? "Bu login band." : message,
			code: duplicate ? "USERNAME_EXISTS" : undefined,
		};
	}
};

const createOwnerAccount = async ({ name, username, password, pinCode, apiToken }) => {
	if (!name || !password || !pinCode) {
		return { ok: false, message: "Majburiy maydonlar to'liq emas." };
	}

	if (MODE_API) {
		if (!apiClient || !BACKEND_API_URL) {
			return { ok: false, message: "Backend API sozlanmagan." };
		}

		try {
			const payload = {
				name,
				role: "admin",
				password,
				pinCode,
				createRestaurant: true,
				restaurantName: name,
			};
			if (username) payload.username = username;

			const headers = apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined;
			const response = await apiClient.post("/api/auth/register", payload, { headers });
			const data = response.data || {};
			return { ok: true, username: data.username || username || "" };
		} catch (error) {
			const apiMessage = error?.response?.data?.message || error.message;
			const duplicate = (apiMessage || "").toLowerCase().includes("username") && (apiMessage || "").toLowerCase().includes("exist");
			return {
				ok: false,
				message: apiMessage,
				code: duplicate ? "USERNAME_EXISTS" : undefined,
			};
		}
	}

	return createOwnerAccountLocal({ name, username, password, pinCode });
};

const validateAdminCredentials = async (username, password) => {
	if (MODE_API) {
		if (!apiClient) {
			return { ok: false, message: "Backend API sozlanmagan." };
		}
		try {
			const response = await apiClient.post("/api/auth/login", { username, password });
			const { token, user } = response.data || {};
			if (!user || !token) {
				return { ok: false, message: "Backend javobida ma'lumot yetarli emas." };
			}
			if (user.role !== "admin") {
				return { ok: false, message: "Botdan faqat adminlar foydalanishi mumkin." };
			}
			return {
				ok: true,
				user: {
					id: user.id || user._id,
					name: user.name,
					username: user.username,
					role: user.role,
				},
				token,
			};
		} catch (error) {
			if (error?.response?.status === 401 || error?.response?.status === 400) {
				return { ok: false, message: "Login yoki parol noto'g'ri." };
			}
			const msg = error?.response?.data?.message || error.message;
			return { ok: false, message: msg };
		}
	}

	if (!isMongoConnected()) {
		return { ok: false, message: "Ma'lumotlar bazasi ulanmagan." };
	}

	const user = await User.findOne({ username });
	if (!user) {
		return { ok: false, message: "Foydalanuvchi topilmadi." };
	}
	if (user.role !== "admin") {
		return { ok: false, message: "Botdan faqat adminlar foydalanishi mumkin." };
	}
	const passwordOk = await user.comparePassword(password);
	if (!passwordOk) {
		return { ok: false, message: "Parol noto'g'ri." };
	}
	return {
		ok: true,
		user: {
			id: user._id.toString(),
			name: user.name,
			username: user.username,
			role: user.role,
		},
	};
};

const sendLoginIntro = async (bot, chatId, extraMessage) => {
	const lines = [
		"👋 Assalomu alaykum!",
		"",
		"Bu bot orqali faqat yangi restoran egalarini ro'yxatdan o'tkazamiz.",
		"Boshlash uchun \"Tizimga kirish\" tugmasini bosing yoki /login buyrug'idan foydalaning.",
	];
	if (extraMessage) lines.unshift(extraMessage);
	const sent = await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: LOGIN_KEYBOARD });
	setSession(chatId, { loginPromptId: sent.message_id, menuMessageId: undefined, state: undefined });
};

const updateLoginPrompt = async (bot, chatId, notice) => {
	const message = notice
		? `${notice}\n\nAdmin login va parolni bir xabarda yuboring. Masalan: admin 1234`
		: "Admin login va parolni bir xabarda yuboring. Masalan: admin 1234";
	const session = setSession(chatId, {});
	if (session.loginPromptId) {
		try {
			await bot.editMessageText(message, {
				chat_id: chatId,
				message_id: session.loginPromptId,
				reply_markup: CANCEL_LOGIN_KEYBOARD,
			});
			return;
		} catch (error) {
			const lower = (error?.response?.body?.description || "").toLowerCase();
			if (!lower.includes("message to edit not found")) {
				console.warn("[TelegramBot] Login promptni yangilab bo'lmadi", error.message);
			}
		}
	}
	const sent = await bot.sendMessage(chatId, message, { reply_markup: CANCEL_LOGIN_KEYBOARD });
	setSession(chatId, { loginPromptId: sent.message_id });
};

const sendMenu = async (bot, chatId, name) => {
	const text = `👋 ${name || "Admin"}, yangi restoran egasini qo'shish uchun tugmadan foydalaning.`;
	const session = setSession(chatId, {});
	if (session.menuMessageId) {
		try {
			await bot.editMessageText(text, {
				chat_id: chatId,
				message_id: session.menuMessageId,
				reply_markup: MENU_KEYBOARD,
			});
			return;
		} catch (error) {
			const lower = (error?.response?.body?.description || "").toLowerCase();
			if (!lower.includes("message to edit not found")) {
				console.warn("[TelegramBot] Menyuni yangilab bo'lmadi", error.message);
			}
		}
	}
	const sent = await bot.sendMessage(chatId, text, { reply_markup: MENU_KEYBOARD });
	setSession(chatId, { menuMessageId: sent.message_id, loginPromptId: undefined });
};

const startOwnerFlow = async (bot, chatId) => {
	setSession(chatId, { state: OWNER_STATES.NAME, ownerDraft: {} });
	const message = "🆕 Yangi restoran egasini ro'yxatdan o'tkazamiz.\n\n1️⃣ To'liq ismni yuboring.";
	const sent = await bot.sendMessage(chatId, message, { reply_markup: CANCEL_OWNER_KEYBOARD });
	setSession(chatId, { ownerPromptId: sent.message_id });
};

const updateOwnerPrompt = async (bot, chatId, text) => {
	const session = getSession(chatId);
	if (session?.ownerPromptId) {
		try {
			await bot.editMessageText(text, {
				chat_id: chatId,
				message_id: session.ownerPromptId,
				reply_markup: CANCEL_OWNER_KEYBOARD,
			});
			return;
		} catch (error) {
			const lower = (error?.response?.body?.description || "").toLowerCase();
			if (!lower.includes("message to edit not found")) {
				console.warn("[TelegramBot] Owner prompt yangilanmadi", error.message);
			}
		}
	}
	const sent = await bot.sendMessage(chatId, text, { reply_markup: CANCEL_OWNER_KEYBOARD });
	setSession(chatId, { ownerPromptId: sent.message_id });
};

const summarizeOwner = ({ name, username, password, pinCode, passwordGenerated }) => {
	const lines = [
		"✅ Restoran egasi ro'yxatdan o'tkazildi!",
		"",
		`👤 Ism: ${name}`,
		`👥 Login: ${username}`,
		`🔑 Parol${passwordGenerated ? " (avtomatik)" : ""}: ${password}`,
		`📌 PIN-kod: ${pinCode}`,
		"",
		"⚠️ Ushbu ma'lumotlarni egasiga xavfsiz tarzda yetkazib bering.",
	];
	return lines.join("\n");
};

const handleOwnerFlowMessage = async (bot, chatId, text) => {
	const session = getSession(chatId);
	if (!session || session.state?.startsWith("owner") !== true) {
		return;
	}

	const trimmed = text.trim();
	const draft = session.ownerDraft || {};

	if (session.state === OWNER_STATES.NAME) {
		if (trimmed.length < 3) {
			await bot.sendMessage(chatId, "Ism juda qisqa. Iltimos, to'liq ism yuboring.");
			return;
		}
		const next = { ...draft, name: trimmed };
		setSession(chatId, { ownerDraft: next, state: OWNER_STATES.USERNAME });
		await updateOwnerPrompt(bot, chatId, "✍️ Admin login kiriting yoki 'auto' deb yozing.");
		return;
	}

	if (session.state === OWNER_STATES.USERNAME) {
		if (!trimmed) {
			await bot.sendMessage(chatId, "Login bo'sh bo'lishi mumkin emas. 'auto' deb yozing yoki boshqa login tanlang.");
			return;
		}

		const lowered = trimmed.toLowerCase();
		const next = { ...draft };
		if (lowered === "auto" || trimmed === "-") {
			next.username = null;
			next.usernameAuto = true;
		} else {
			const sanitized = sanitizeUsername(trimmed);
			if (sanitized.length < 3) {
				await bot.sendMessage(chatId, "Login kamida 3 ta harfdan iborat bo'lsin.");
				return;
			}
			if (/[A-Z]/.test(trimmed)) {
				await bot.sendMessage(chatId, `Login kichik harflarga o'zgartirildi: ${sanitized}`);
			}
			next.username = sanitized;
			next.usernameAuto = false;
		}

		setSession(chatId, { ownerDraft: next, state: OWNER_STATES.PASSWORD });
		await updateOwnerPrompt(bot, chatId, "🔑 Parol kiriting yoki 'auto' deb yozing.");
		return;
	}

	if (session.state === OWNER_STATES.PASSWORD) {
		let password = trimmed;
		let generated = false;

		if (!password || password.toLowerCase() === "auto" || password === "-") {
			password = generateStrongPassword();
			generated = true;
			await bot.sendMessage(chatId, `Avtomatik yaratilgan parol: ${password}`);
		} else if (password.length < 6 || /\s/.test(password)) {
			await bot.sendMessage(chatId, "Parol kamida 6 belgi bo'lishi va bo'sh joy bo'lmasligi kerak.");
			return;
		}

		const next = { ...draft, password, passwordGenerated: generated };
		setSession(chatId, { ownerDraft: next, state: OWNER_STATES.PIN });
		await updateOwnerPrompt(bot, chatId, "📌 4 xonali PIN-kodni yuboring.");
		return;
	}

	if (session.state === OWNER_STATES.PIN) {
		const pinCode = trimmed.replace(/\s+/g, "");
		if (!/^\d{4}$/.test(pinCode)) {
			await bot.sendMessage(chatId, "PIN 4 ta raqamdan iborat bo'lsin.");
			return;
		}

		const data = { ...draft, pinCode };
		const waiting = await bot.sendMessage(chatId, "⏳ Ro'yxatdan o'tkazilmoqda, iltimos kuting...");

		const result = await createOwnerAccount({
			name: data.name,
			username: data.username,
			password: data.password,
			pinCode,
			apiToken: session.apiToken,
		});

		if (waiting?.message_id) {
			await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
		}

		if (!result.ok) {
			await bot.sendMessage(chatId, `❌ ${result.message || "Ro'yxatdan o'tkazib bo'lmadi."}`);
			if (result.code === "USERNAME_EXISTS") {
				setSession(chatId, { ownerDraft: { ...draft, username: null }, state: OWNER_STATES.USERNAME });
				await updateOwnerPrompt(bot, chatId, "Ushbu login band. Yangi login kiriting yoki 'auto' deb yozing.");
			}
			return;
		}

		const summary = summarizeOwner({
			name: data.name,
			username: result.username || data.username || "",
			password: data.password,
			pinCode,
			passwordGenerated: Boolean(data.passwordGenerated),
		});

		await bot.sendMessage(chatId, summary);

		clearSession(chatId);
		await sendLoginIntro(bot, chatId, "🔄 Jarayon yakunlandi. Zarurat bo'lsa qayta tizimga kiring.");
	}
};

const handleLoginText = async (bot, chatId, text) => {
	const [username, ...rest] = text.trim().split(/\s+/);
	if (!username || rest.length === 0) {
		await bot.sendMessage(chatId, "Login va parolni birga yuboring. Masalan: admin 1234");
		return;
	}
	const password = rest.join(" ");

	const result = await validateAdminCredentials(username, password);
	if (!result.ok) {
		await bot.sendMessage(chatId, `❌ ${result.message || "Kirish muvaffaqiyatsiz."}`);
		return;
	}

	const session = getSession(chatId);
	if (session?.loginPromptId) {
		await bot.deleteMessage(chatId, session.loginPromptId).catch(() => {});
	}
	if (session?.ownerPromptId) {
		await bot.deleteMessage(chatId, session.ownerPromptId).catch(() => {});
	}

	setSession(chatId, {
		state: "authenticated",
		userId: result.user.id,
		username: result.user.username,
		name: result.user.name,
		role: result.user.role,
		apiToken: result.token,
		ownerDraft: undefined,
		ownerPromptId: undefined,
	});

	await sendMenu(bot, chatId, result.user.name);
};

const resetToMenuOrIntro = async (bot, chatId) => {
	const session = getSession(chatId);
	if (session?.userId) {
		await sendMenu(bot, chatId, session.name || session.username);
	} else {
		clearSession(chatId);
		await sendLoginIntro(bot, chatId);
	}
};

const handleCallback = async (bot, query) => {
	const chatId = query.message?.chat?.id;
	if (!chatId || !query.data) {
		await bot.answerCallbackQuery(query.id).catch(() => {});
		return;
	}

	const session = getSession(chatId);
	const data = query.data;

	if (data === "login:start") {
		await bot.answerCallbackQuery(query.id).catch(() => {});
		setSession(chatId, { state: "awaiting_login" });
		await updateLoginPrompt(bot, chatId);
		return;
	}

	if (data === "login:cancel") {
		await bot.answerCallbackQuery(query.id, { text: "Bekor qilindi." }).catch(() => {});
		setSession(chatId, { state: undefined });
		await resetToMenuOrIntro(bot, chatId);
		return;
	}

	if (data === "owner:cancel") {
		await bot.answerCallbackQuery(query.id, { text: "Bekor qilindi." }).catch(() => {});
		setSession(chatId, { ownerDraft: undefined, state: "authenticated", ownerPromptId: undefined });
		await resetToMenuOrIntro(bot, chatId);
		return;
	}

	if (data === "logout") {
		await bot.answerCallbackQuery(query.id).catch(() => {});
		clearSession(chatId);
		await sendLoginIntro(bot, chatId, "🚪 Profilingizdan chiqdingiz.");
		return;
	}

	if (data === "owner:new") {
		await bot.answerCallbackQuery(query.id).catch(() => {});
		if (!session?.userId || session.role !== "admin") {
			await bot.sendMessage(chatId, "Avval admin sifatida tizimga kiring.");
			return;
		}
		if (session.menuMessageId) {
			await bot.deleteMessage(chatId, session.menuMessageId).catch(() => {});
			setSession(chatId, { menuMessageId: undefined });
		}
		await startOwnerFlow(bot, chatId);
		return;
	}

	await bot.answerCallbackQuery(query.id).catch(() => {});
};

const handleMessage = async (bot, msg) => {
	if (!msg.text || msg.from?.is_bot) return;
	const chatId = msg.chat.id;
	const text = msg.text.trim();

	if (text.startsWith("/")) return;

	const session = getSession(chatId);
	if (!session) {
		await sendLoginIntro(bot, chatId, "ℹ️ Avval tizimga kiring.");
		return;
	}

	if (text.toLowerCase() === "cancel" || text.toLowerCase() === "bekor") {
		await resetToMenuOrIntro(bot, chatId);
		return;
	}

	if (session.state === "awaiting_login") {
		await handleLoginText(bot, chatId, text);
		return;
	}

	if (session.state && session.state.startsWith("owner")) {
		await handleOwnerFlowMessage(bot, chatId, text);
		return;
	}

	if (session.state === "authenticated") {
		await sendMenu(bot, chatId, session.name || session.username);
		return;
	}

	await sendLoginIntro(bot, chatId, "ℹ️ Avval tizimga kiring.");
};

export const initTelegramBot = ({ app } = {}) => {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.info("[TelegramBot] TELEGRAM_BOT_TOKEN topilmadi. Bot ishga tushirilmadi.");
		return null;
	}

	const globalKey = Symbol.for("pos/telegram-bot");
	if (globalThis[globalKey]) {
		return globalThis[globalKey];
	}

	const bot = new TelegramBot(token, { polling: false });

	(async () => {
		try {
			await bot.setMyCommands([
				{ command: "start", description: "Botni ishga tushirish" },
				{ command: "login", description: "Admin login (masalan: /login admin 1234)" },
				{ command: "owner", description: "Yangi restoran egasini qo'shish" },
				{ command: "logout", description: "Botdan chiqish" },
				{ command: "cancel", description: "Joriy jarayonni to'xtatish" },
				{ command: "help", description: "Yordam" },
			]);
		} catch (error) {
			console.warn("[TelegramBot] Komandalar ro'yxatini sozlab bo'lmadi", error.message);
		}
	})();

	const webhookUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
	const webhookSecret = process.env.TELEGRAM_BOT_WEBHOOK_SECRET;
	let webhookPath = process.env.TELEGRAM_BOT_WEBHOOK_PATH || "/api/telegram/webhook";
	if (!webhookPath.startsWith("/")) webhookPath = `/${webhookPath}`;

	const wantsWebhook = Boolean(webhookUrl);
	const canUseWebhook = wantsWebhook && Boolean(app);

	const startPolling = async () => {
		try {
			await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});
			await bot.startPolling();
			console.info("[TelegramBot] Ishga tushdi (polling). Faoliyat: faqat registratsiya.");
		} catch (error) {
			console.error("[TelegramBot] Pollingni ishga tushirib bo'lmadi", error.message);
		}
	};

	if (canUseWebhook) {
		app.post(webhookPath, (req, res) => {
			if (webhookSecret) {
				const header = req.get("X-Telegram-Bot-Api-Secret-Token");
				if (header !== webhookSecret) {
					return res.sendStatus(401);
				}
			}
			bot.processUpdate(req.body);
			res.sendStatus(200);
		});

		(async () => {
			try {
				await bot.setWebHook(webhookUrl, {
					secret_token: webhookSecret || undefined,
					allowed_updates: ["message", "callback_query"],
				});
				console.info(`[TelegramBot] Webhook rejimi yoqildi. Path: ${webhookPath}`);
			} catch (error) {
				console.error("[TelegramBot] Webhook sozlanmadi, pollingga o'tamiz", error.message);
				await startPolling();
			}
		})();
	} else {
		if (wantsWebhook && !app) {
			console.warn("[TelegramBot] Webhook URL berilgan, lekin Express app yo'q. Polling ishlatiladi.");
		}
		startPolling();
	}

	bot.onText(/^\/start$/i, async (msg) => {
		const chatId = msg.chat.id;
		const session = getSession(chatId);
		if (session?.userId) {
			await sendMenu(bot, chatId, session.name || session.username);
		} else {
			await sendLoginIntro(bot, chatId);
		}
	});

	bot.onText(/^\/help$/i, async (msg) => {
		await bot.sendMessage(msg.chat.id, "Bot faqat yangi restoran egalarini qo'shish uchun ishlaydi. Avval admin login/parol bilan tizimga kiring.");
	});

	bot.onText(/^\/logout$/i, async (msg) => {
		const chatId = msg.chat.id;
		clearSession(chatId);
		await sendLoginIntro(bot, chatId, "🚪 Profilingizdan chiqdingiz.");
	});

	bot.onText(/^\/login\s+(.+)$/i, async (msg, match) => {
		const chatId = msg.chat.id;
		const args = (match && match[1]) || "";
		const [username, ...rest] = args.trim().split(/\s+/);
		if (!username || rest.length === 0) {
			await bot.sendMessage(chatId, "Foydalanish: /login <foydalanuvchi> <parol>");
			return;
		}
		setSession(chatId, { state: "awaiting_login" });
		await handleLoginText(bot, chatId, `${username} ${rest.join(" ")}`);
	});

	bot.onText(/^\/(owner|newowner|registerowner)$/i, async (msg) => {
		const chatId = msg.chat.id;
		const session = getSession(chatId);
		if (!session?.userId || session.role !== "admin") {
			await sendLoginIntro(bot, chatId, "Avval admin sifatida tizimga kiring.");
			return;
		}
		if (session.menuMessageId) {
			await bot.deleteMessage(chatId, session.menuMessageId).catch(() => {});
			setSession(chatId, { menuMessageId: undefined });
		}
		await startOwnerFlow(bot, chatId);
	});

	bot.onText(/^\/cancel$/i, async (msg) => {
		await resetToMenuOrIntro(bot, msg.chat.id);
	});

	bot.on("callback_query", async (query) => {
		await handleCallback(bot, query);
	});

	bot.on("message", async (msg) => {
		await handleMessage(bot, msg);
	});

	bot.on("polling_error", (error) => {
		console.error("[TelegramBot] Polling error", error.message);
	});

	globalThis[globalKey] = bot;
	return bot;
};
