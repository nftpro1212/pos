// src/backend/controllers/paymentController.js
import Payment from "../models/Payment.js";
import Order from "../models/Order.js";
import Table from "../models/Table.js";
import Settings from "../models/Settings.js";
import {
  DEFAULT_RECEIPT_TEMPLATE,
  mergeReceiptTemplate,
  generateEscPosReceipt,
  sendToNetworkPrinter,
} from "../utils/printer.js";
import { dispatchPrintJob, hasActivePrintAgent } from "../socket.js";
import { resolveTaxRate } from "../utils/tax.js";
import { ensureRestaurantId, resolveRestaurantId } from "../utils/tenant.js";

const buildSettingsFilter = (settings, restaurantId) => {
  if (settings?._id) {
    return { _id: settings._id };
  }
  if (settings?.restaurant) {
    return { restaurant: settings.restaurant };
  }
  if (restaurantId) {
    return { restaurant: restaurantId };
  }
  return null;
};

const resolveDispatchMode = (value, fallback = "direct") => {
  const allowed = new Set(["direct", "agent"]);
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (allowed.has(candidate)) return candidate;
  if (allowed.has(fallback)) return fallback;
  return "direct";
};

const resolveAgentChannel = (value, fallback = "default") => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return "default";
};

const shouldAutoprintForPayment = (printer = {}) => {
  if (printer.enabled === false) return false;
  if (printer.autoprint) return true;
  if (Array.isArray(printer.autoPrintTriggers)) {
    return printer.autoPrintTriggers.includes("payment");
  }
  return false;
};

const buildRestaurantInfo = (settings = {}) => {
  const taxRate = resolveTaxRate(
    [settings.taxSettings?.serviceCharge, settings.taxSettings?.taxRate],
    0,
  );

  return {
    name: settings.restaurantName || "ZarPOS Restoran",
    address: settings.restaurantAddress || "",
    phone: settings.restaurantPhone || "",
    email: settings.restaurantEmail || "",
    taxName: settings.taxSettings?.taxName || "",
    taxRate,
    taxPercent: Number((taxRate * 100).toFixed(2)),
  };
};

const triggerAutomaticPrints = async (
  { settings, order, payment },
  {
    targetPrinterIds = [],
    includeNonAuto = false,
    overrideDispatchMode,
    overrideAgentChannel,
  } = {},
) => {
  if (!settings?.printerSettings?.enabled) {
    return {
      results: [],
      summary: { total: 0, success: 0, failed: 0 },
    };
  }

  const basePrinterSettings = settings.printerSettings || {};
  const printers = Array.isArray(basePrinterSettings.printers)
    ? basePrinterSettings.printers
    : [];

  const settingsFilter = buildSettingsFilter(
    settings,
    order?.restaurant || payment?.restaurant || order?.restaurantId || payment?.restaurantId,
  );

  const normalizedTargetIds = Array.isArray(targetPrinterIds)
    ? targetPrinterIds.filter(Boolean).map(String)
    : [];

  const fallbackPrinter = basePrinterSettings.ipAddress
    ? {
        _id: null,
        name: basePrinterSettings.printerName || "Asosiy printer",
        connectionType: basePrinterSettings.connectionType || "network",
        ipAddress: basePrinterSettings.ipAddress,
        port: Number(basePrinterSettings.port || 9100),
        paperWidth: basePrinterSettings.paperWidth || "80mm",
        printerType: basePrinterSettings.printerType || "thermal",
        autoprint: Boolean(basePrinterSettings.autoprint),
        enabled: true,
        autoPrintTriggers: ["payment"],
        headerText: basePrinterSettings.headerText,
        footerText: basePrinterSettings.footerText,
        copies: basePrinterSettings.printCopies || 1,
        templateOverrides: basePrinterSettings.templateOverrides || {},
        dispatchMode: resolveDispatchMode(basePrinterSettings.dispatchMode, "direct"),
        agentChannel: resolveAgentChannel(basePrinterSettings.agentChannel, "default"),
      }
    : null;

  const networkCapable = (printer) => {
    if (!printer) return false;
    if (printer.connectionType && printer.connectionType !== "network") {
      return false;
    }
    if (!printer.ipAddress || !printer.port) return false;
    return true;
  };

  let selectedPrinters = printers.filter((printer) => {
    if (!networkCapable(printer)) return false;
    if (normalizedTargetIds.length && !normalizedTargetIds.includes(String(printer._id))) {
      return false;
    }
    if (!includeNonAuto) {
      return shouldAutoprintForPayment(printer);
    }
    return printer.enabled !== false;
  });

  if (!selectedPrinters.length) {
    if (!includeNonAuto) {
      const eligible = printers.filter((printer) => networkCapable(printer) && shouldAutoprintForPayment(printer));
      selectedPrinters = eligible;
    }
  }

  if (!selectedPrinters.length) {
    if (includeNonAuto && fallbackPrinter) {
      selectedPrinters = [fallbackPrinter];
    } else if (!includeNonAuto && fallbackPrinter?.autoprint) {
      selectedPrinters = [fallbackPrinter];
    }
  }

  if (!selectedPrinters.length) {
    return {
      results: [],
      summary: { total: 0, success: 0, failed: 0 },
    };
  }

  const restaurantInfo = buildRestaurantInfo(settings);
  const orderPayload = order?.toObject ? order.toObject() : order || {};
  const paymentPayload = payment?.toObject ? payment.toObject() : payment || {};
  const baseTemplate = mergeReceiptTemplate(
    DEFAULT_RECEIPT_TEMPLATE,
    basePrinterSettings.receiptTemplate,
  );

  const results = await Promise.all(
    selectedPrinters.map(async (printer) => {
      const dispatchMode = resolveDispatchMode(
        overrideDispatchMode ?? printer.dispatchMode,
        resolveDispatchMode(basePrinterSettings.dispatchMode, "direct"),
      );
      const agentChannel = resolveAgentChannel(
        overrideAgentChannel ?? printer.agentChannel,
        resolveAgentChannel(basePrinterSettings.agentChannel, "default"),
      );

      const printerPayload = {
        id: printer._id ? String(printer._id) : null,
        name: printer.name || basePrinterSettings.printerName || "Asosiy printer",
        agentChannel,
        dispatchMode,
        ipAddress: printer.ipAddress,
        port: Number(printer.port || basePrinterSettings.port || 9100),
        paperWidth: printer.paperWidth || basePrinterSettings.paperWidth || "80mm",
        printerType: printer.printerType || basePrinterSettings.printerType || "thermal",
        copies: Number(printer.copies || basePrinterSettings.printCopies || 1),
        templateOverrides: printer.templateOverrides || {},
        headerText: printer.headerText || basePrinterSettings.headerText || "",
        footerText: printer.footerText || basePrinterSettings.footerText || "",
      };

      try {
        if (dispatchMode === "agent") {
          if (!hasActivePrintAgent(agentChannel)) {
            throw new Error("Lokal print agent ulangan emas");
          }

          const result = await dispatchPrintJob({
            restaurantId: agentChannel,
            job: {
              type: "payment-print",
              printer: printerPayload,
              template: baseTemplate,
              order: orderPayload,
              payment: paymentPayload,
              restaurant: restaurantInfo,
              options: {
                copies: printerPayload.copies,
              },
              connection: {
                ipAddress: printerPayload.ipAddress,
                port: printerPayload.port,
              },
            },
            timeoutMs: Number(printer.connectionTimeout || 12000),
          });

          if (result?.success === false) {
            throw new Error(result.message || "Agent xatosi");
          }
        } else {
          const buffer = generateEscPosReceipt({
            order: orderPayload,
            payment: paymentPayload,
            template: baseTemplate,
            printer: printerPayload,
            restaurant: restaurantInfo,
          });

          await sendToNetworkPrinter(
            { ipAddress: printerPayload.ipAddress, port: printerPayload.port },
            buffer,
            { timeout: printer.connectionTimeout || 7000 },
          );
        }

        if (printer?._id && settingsFilter) {
          await Settings.updateOne(
            { ...settingsFilter, "printerSettings.printers._id": printer._id },
            {
              $set: {
                "printerSettings.printers.$.lastPrintDate": new Date(),
                "printerSettings.printers.$.connectionStatus": "connected",
                "printerSettings.printers.$.lastPrintError": "",
              },
            },
          );
        } else if (settingsFilter) {
          await Settings.updateOne(
            settingsFilter,
            {
              $set: {
                "printerSettings.lastPrintDate": new Date(),
                "printerSettings.connectionStatus": "connected",
                "printerSettings.lastPrintError": "",
              },
            },
          );
        }

        return {
          success: true,
          printerId: printerPayload.id,
          printerName: printerPayload.name,
          dispatchMode,
          message: "Chek chop etildi",
        };
      } catch (error) {
        console.error("[AUTOPRINT] Error:", error);

        if (printer?._id && settingsFilter) {
          await Settings.updateOne(
            { ...settingsFilter, "printerSettings.printers._id": printer._id },
            {
              $set: {
                "printerSettings.printers.$.connectionStatus": "disconnected",
                "printerSettings.printers.$.lastPrintError": error.message,
              },
            },
          );
        } else if (settingsFilter) {
          await Settings.updateOne(
            settingsFilter,
            {
              $set: {
                "printerSettings.connectionStatus": "disconnected",
                "printerSettings.lastPrintError": error.message,
              },
            },
          );
        }

        return {
          success: false,
          printerId: printerPayload?.id || null,
          printerName: printerPayload?.name || printer?.name || null,
          dispatchMode,
          message: error.message,
        };
      }
    }),
  );

  return {
    results,
    summary: {
      total: results.length,
      success: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success).length,
    },
  };
};

const normalizePaymentParts = (parts = [], fallbackAmount = 0, fallbackMethod = "cash", fallbackTxnId = "") => {
  if (!Array.isArray(parts) || !parts.length) {
    return [
      {
        amount: Number(fallbackAmount) || 0,
        method: fallbackMethod || "cash",
        txnId: fallbackTxnId || "",
      },
    ];
  }

  return parts
    .map((part) => ({
      amount: Number(part?.amount) || 0,
      method: (part?.method || fallbackMethod || "cash").trim().toLowerCase(),
      txnId: part?.txnId || fallbackTxnId || "",
    }))
    .filter((part) => part.amount > 0);
};

export const createPayment = async (req, res) => {
  let restaurantId;
  try {
    restaurantId = ensureRestaurantId(req, { allowBody: true, allowQuery: true });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message });
  }

  try {
    const { orderId, amount, method, parts, txnId, customer } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ message: "Buyurtma aniqlanmadi" });
    }

    const order = await Order.findOne({ _id: orderId, restaurant: restaurantId });
    if (!order) {
      return res.status(404).json({ message: "Buyurtma topilmadi" });
    }

    const normalizedParts = normalizePaymentParts(parts, amount, method, txnId);
    const totalAmount = normalizedParts.reduce((sum, part) => sum + part.amount, 0);

    const paymentDoc = {
      order: order._id,
      restaurant: restaurantId,
      parts: normalizedParts,
      totalAmount,
      method: method || normalizedParts[0]?.method || "cash",
      txnId: txnId || "",
      createdAt: new Date(),
    };

    if (customer) {
      paymentDoc.customer = customer;
    }

    const payment = await Payment.create(paymentDoc);

    order.status = "closed";
    await order.save();

    if (order.table) {
      await Table.findOneAndUpdate(
        { _id: order.table, restaurant: restaurantId },
        {
          status: "free",
          assignedTo: null,
          assignedToName: "",
          assignedAt: null,
        },
      );

      await Order.deleteMany({
        table: order.table,
        restaurant: restaurantId,
        status: { $nin: ["closed", "cancelled"] },
        _id: { $ne: order._id },
      });
    }

    const io = req.app.get("io");
    if (io) {
      const room = restaurantId ? restaurantId.toString() : "default";
      io.to(room).emit("order:updated", order);
    }

    await payment.populate([
      { path: "order", select: "table tableName restaurant total items" },
      { path: "customer", select: "name phone" },
    ]);

    let printReport = {
      results: [],
      summary: { total: 0, success: 0, failed: 0 },
    };

    try {
      const settings = await Settings.findOne({ restaurant: restaurantId });
      if (settings) {
        printReport = await triggerAutomaticPrints({ settings, order, payment });
      }
    } catch (printError) {
      console.error("[AUTOPRINT] trigger error", printError);
    }

    res.json({ ...payment.toObject(), printReport });
  } catch (error) {
    console.error("[PAYMENT] create error", error);
    res.status(500).json({ message: error.message || "To'lovni bajarib bo'lmadi" });
  }
};

export const printPaymentReceipt = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const {
      printerId,
      printerIds,
      dispatchMode: overrideDispatchMode,
      agentChannel: overrideAgentChannel,
    } = req.body || {};

    let restaurantId;
    try {
      restaurantId = ensureRestaurantId(req, { allowBody: true, allowQuery: true });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message });
    }

    const payment = await Payment.findOne({ _id: paymentId, restaurant: restaurantId })
      .populate({ path: "order", select: "table tableName restaurant total items" })
      .populate({ path: "customer", select: "name phone" });

    if (!payment) {
      return res.status(404).json({ message: "To'lov topilmadi" });
    }

    let orderDoc = payment.order || null;
    if (!orderDoc) {
      orderDoc = await Order.findById(payment.order);
    }
    if (orderDoc && typeof orderDoc.toObject !== "function") {
      const lookupId = orderDoc?._id || orderDoc;
      orderDoc = await Order.findById(lookupId);
    }
    if (!orderDoc) {
      return res.status(404).json({ message: "Buyurtma topilmadi" });
    }

    const settings = await Settings.findOne({ restaurant: restaurantId });
    if (!settings?.printerSettings?.enabled) {
      return res.status(400).json({ message: "Printer sozlamalari faol emas" });
    }

    const targets = [];
    if (printerId) targets.push(String(printerId));
    if (Array.isArray(printerIds)) {
      printerIds.filter(Boolean).forEach((id) => targets.push(String(id)));
    }

    const printReport = await triggerAutomaticPrints(
      { settings, order: orderDoc, payment },
      {
        includeNonAuto: true,
        targetPrinterIds: targets.length ? targets : undefined,
        overrideDispatchMode,
        overrideAgentChannel,
      },
    );

    const summary = printReport?.summary || { total: 0, success: 0, failed: 0 };
    const success = (summary.success || 0) > 0;
    const message = success
      ? summary.failed
        ? `Chek ${summary.success} printerga yuborildi, ${summary.failed} xatolik`
        : "Chek printerga yuborildi"
      : "Chekni chop qilib bo'lmadi";

    res.json({ success, message, printReport });
  } catch (error) {
    console.error("[PAYMENT] manual print error", error);
    res.status(500).json({ message: error.message || "Chekni chop qilib bo'lmadi" });
  }
};

export const listPayments = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, { allowQuery: true });
    if (!restaurantId) {
      return res.status(400).json({ message: "Restoran aniqlanmadi" });
    }

    const payments = await Payment.find({ restaurant: restaurantId })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate({ path: "order", select: "table tableName restaurant total" })
      .populate({ path: "customer", select: "name phone" });

    res.json(payments);
  } catch (error) {
    console.error("[PAYMENT] list error", error);
    res.status(500).json({ message: "To'lovlar ro'yxatini olishda xato" });
  }
};
