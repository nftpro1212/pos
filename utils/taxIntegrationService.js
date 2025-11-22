import axios from "axios";

// Simple in-memory token cache for sandbox usage
let cachedToken = null;
let tokenExpiresAt = 0;

const buildFiscalPayload = (order, config, taxSettings) => {
  const vatRate = taxSettings?.taxRate ?? config?.defaultVatRate ?? 0.12;
  const vatPercent = Math.round((vatRate || 0) * 100);

  return {
    provider: config?.provider || "iiko",
    organizationId: config?.organizationId || "DEFAULT_ORG",
    orderId: order._id?.toString(),
    number: order.orderNumber || order._id?.toString(),
    total: order.total,
    subtotal: order.subtotal,
    discount: order.discount || 0,
    taxPercent: vatPercent,
    currency: taxSettings?.currency || "UZS",
    items: (order.items || []).map((item, idx) => ({
      line: idx + 1,
      name: item.name,
      qty: item.qty || 1,
      price: item.price || 0,
      total: (item.qty || 1) * (item.price || 0),
      vatPercent,
    })),
    customer: order.customer || null,
    timestamp: new Date().toISOString(),
  };
};

const shouldUseSandbox = (config) => !config?.apiKey || config?.mode === "sandbox";

const markOrderSuccess = async (order, payload, receiptId, message = "Sandbox fiscalization") => {
  order.fiscalStatus = "completed";
  order.fiscalReceiptId = receiptId;
  order.fiscalError = null;
  order.fiscalPayload = payload;
  order.fiscalSyncedAt = new Date();
  await order.save();

  return {
    success: true,
    message,
    receiptId,
  };
};

const markOrderFailure = async (order, payload, error) => {
  order.fiscalStatus = "failed";
  order.fiscalError = error?.message || "Fiscalization failed";
  order.fiscalPayload = payload;
  order.fiscalSyncedAt = new Date();
  await order.save();

  return {
    success: false,
    message: order.fiscalError,
  };
};

const ensureToken = async (config) => {
  if (shouldUseSandbox(config)) return "sandbox-token";
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/api/0/auth/access_token`;
  const body = { login: config.apiLogin, apiKey: config.apiKey };
  const { data } = await axios.post(url, body, { timeout: 5000 });
  cachedToken = data?.token;
  tokenExpiresAt = now + (data?.expires_in || 3600) * 1000 - 60000;
  return cachedToken;
};

export const testTaxIntegrationConnection = async (config) => {
  if (!config?.enabled) {
    return { success: false, message: "Integratsiya o'chirilgan" };
  }

  if (shouldUseSandbox(config)) {
    return { success: true, message: "Sandbox rejimida ishlamoqda" };
  }

  try {
    const token = await ensureToken(config);
    const url = `${config.apiBaseUrl.replace(/\/$/, "")}/api/1/licensing/settings`;
    await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });
    return { success: true, message: "iiko bilan ulanish muvaffaqiyatli" };
  } catch (error) {
    return { success: false, message: error.message || "Aloqa xatosi" };
  }
};

export const fiscalizeOrder = async (order, config, taxSettings) => {
  if (!config?.enabled) {
    order.fiscalStatus = "skipped";
    await order.save();
    return { success: false, message: "Integratsiya o'chirilgan" };
  }

  const payload = buildFiscalPayload(order, config, taxSettings);

  if (shouldUseSandbox(config)) {
    const receiptId = `SIM-${Date.now()}`;
    return markOrderSuccess(order, payload, receiptId, "Sandbox fiskalizatsiya");
  }

  try {
    const token = await ensureToken(config);
    const url = `${config.apiBaseUrl.replace(/\/$/, "")}/api/2/documents/receipts`;
    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 8000,
    });

    const receiptId = data?.id || data?.receiptNumber || `IIKO-${Date.now()}`;
    return markOrderSuccess(order, payload, receiptId, "iiko fiskalizatsiyasi");
  } catch (error) {
    return markOrderFailure(order, payload, error);
  }
};
