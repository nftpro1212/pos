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

const buildRestaurantInfo = (settings = {}) => ({
  name: settings.restaurantName || "ZarPOS Restoran",
  address: settings.restaurantAddress || "",
  phone: settings.restaurantPhone || "",
  email: settings.restaurantEmail || "",
  taxName: settings.taxSettings?.taxName || "",
  taxRate: settings.taxSettings?.taxRate || 0,
});

const triggerAutomaticPrints = async ({ settings, order, payment }) => {
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

  const autoPrinters = printers.filter((printer) => {
    if (printer.connectionType && printer.connectionType !== "network") {
      return false;
    }
    if (!printer.ipAddress || !printer.port) return false;
    return shouldAutoprintForPayment(printer);
  });

  if (!autoPrinters.length && basePrinterSettings.autoprint && basePrinterSettings.ipAddress) {
    autoPrinters.push({
      _id: null,
      name: basePrinterSettings.printerName || "Asosiy printer",
      connectionType: basePrinterSettings.connectionType || "network",
      ipAddress: basePrinterSettings.ipAddress,
      port: Number(basePrinterSettings.port || 9100),
      paperWidth: basePrinterSettings.paperWidth || "80mm",
      printerType: basePrinterSettings.printerType || "thermal",
      autoprint: true,
      enabled: true,
      autoPrintTriggers: ["payment"],
      headerText: basePrinterSettings.headerText,
      footerText: basePrinterSettings.footerText,
      copies: basePrinterSettings.printCopies || 1,
      templateOverrides: basePrinterSettings.templateOverrides || {},
      dispatchMode: resolveDispatchMode(basePrinterSettings.dispatchMode, "direct"),
      agentChannel: resolveAgentChannel(basePrinterSettings.agentChannel, "default"),
    });
  }

  if (!autoPrinters.length) {
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
    autoPrinters.map(async (printer) => {
      const dispatchMode = resolveDispatchMode(
        printer.dispatchMode,
        resolveDispatchMode(basePrinterSettings.dispatchMode, "direct"),
      );
      const agentChannel = resolveAgentChannel(
        printer.agentChannel,
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

        if (printer?._id) {
          await Settings.updateOne(
            { "printerSettings.printers._id": printer._id },
            {
              $set: {
                "printerSettings.printers.$.lastPrintDate": new Date(),
                "printerSettings.printers.$.connectionStatus": "connected",
                "printerSettings.printers.$.lastPrintError": "",
              },
            },
          );
        } else {
          await Settings.updateOne(
            {},
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

        if (printer?._id) {
          await Settings.updateOne(
            { "printerSettings.printers._id": printer._id },
            {
              $set: {
                "printerSettings.printers.$.connectionStatus": "disconnected",
                "printerSettings.printers.$.lastPrintError": error.message,
              },
            },
          );
        } else {
          await Settings.updateOne(
            {},
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

export const createPayment = async (req, res) => {
  try {
    const { orderId, amount, method, parts } = req.body;
    const paymentDoc = {
      order: orderId,
      txnId: req.body.txnId || "",
      createdAt: new Date(),
    };

    if (Array.isArray(parts) && parts.length > 0) {
      paymentDoc.parts = parts;
      paymentDoc.totalAmount = parts.reduce((sum, part) => sum + (Number(part.amount) || 0), 0);
    } else {
      paymentDoc.parts = [
        {
          amount: Number(amount) || 0,
          method: method || "cash",
          txnId: req.body.txnId || "",
        },
      ];
      paymentDoc.totalAmount = Number(amount) || 0;
      paymentDoc.method = method;
      paymentDoc.amount = Number(amount) || 0;
    }

    if (req.body.customer) paymentDoc.customer = req.body.customer;

    const payment = await Payment.create(paymentDoc);

    const order = await Order.findById(orderId);
    if (order) {
      order.status = "closed";
      await order.save();

      if (order.table) {
        await Table.findByIdAndUpdate(order.table, { status: "free" });
        await Order.deleteMany({ table: order.table, status: { $ne: "closed" } });
      }

      const io = req.app.get("io");
      if (io) io.to(order.restaurantId || "default").emit("order:updated", order);
    }

    await payment.populate([
      { path: "order", select: "table tableName restaurantId total items" },
      { path: "customer", select: "name phone" },
    ]);

    let printReport = {
      results: [],
      summary: { total: 0, success: 0, failed: 0 },
    };

    try {
      const settings = await Settings.findOne();
      if (settings) {
        printReport = await triggerAutomaticPrints({ settings, order, payment });
      }
    } catch (printError) {
      console.error("[AUTOPRINT] trigger error", printError);
    }

    const payload = {
      ...payment.toObject(),
      printReport,
    };

    res.json(payload);
  } catch (error) {
    console.error("[PAYMENT] create error", error);
    res.status(500).json({ message: error.message || "To'lovni bajarib bo'lmadi" });
  }
};

export const listPayments = async (req, res) => {
  try {
    const payments = await Payment.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .populate({ path: "order", select: "table tableName restaurantId total" })
      .populate({ path: "customer", select: "name phone" });

    res.json(payments);
  } catch (error) {
    console.error("[PAYMENT] list error", error);
    res.status(500).json({ message: "To'lovlar ro'yxatini olishda xato" });
  }
};
