// src/backend/controllers/paymentController.js
import Payment from "../models/Payment.js";
import Order from "../models/Order.js";
import Table from "../models/Table.js";
import Settings from "../models/Settings.js";
import { generateEscPosReceipt, sendToNetworkPrinter } from "../utils/printer.js";

const shouldAutoprintForPayment = (printer = {}) => {
  if (!printer.enabled || !printer.autoprint) return false;
  const triggers = Array.isArray(printer.autoPrintTriggers) ? printer.autoPrintTriggers : [];
  return triggers.includes("payment");
};

const buildRestaurantInfo = (settings) => ({
  name: settings?.restaurantName,
  address: settings?.restaurantAddress,
  phone: settings?.restaurantPhone,
  email: settings?.restaurantEmail,
});

const triggerAutomaticPrints = async ({ settings, order, payment }) => {
  if (!settings?.printerSettings?.enabled) return;

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
    });
  }

  if (!autoPrinters.length) return;

  const restaurantInfo = buildRestaurantInfo(settings);
  const orderPayload = order?.toObject ? order.toObject() : (order || {});
  const paymentPayload = payment?.toObject ? payment.toObject() : (payment || {});

  await Promise.allSettled(
    autoPrinters.map(async (printer) => {
      try {
        const buffer = generateEscPosReceipt({
          order: orderPayload,
          payment: paymentPayload,
          template: basePrinterSettings.receiptTemplate,
          printer,
          restaurant: restaurantInfo,
        });

        await sendToNetworkPrinter(
          { ipAddress: printer.ipAddress, port: Number(printer.port || 9100) },
          buffer,
          { timeout: printer.connectionTimeout || 7000 }
        );

        if (printer?._id) {
          await Settings.updateOne(
            { "printerSettings.printers._id": printer._id },
            {
              $set: {
                "printerSettings.printers.$.lastPrintDate": new Date(),
                "printerSettings.printers.$.connectionStatus": "connected",
                "printerSettings.printers.$.lastPrintError": "",
              },
            }
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
            }
          );
        }
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
            }
          );
        } else {
          await Settings.updateOne(
            {},
            {
              $set: {
                "printerSettings.connectionStatus": "disconnected",
                "printerSettings.lastPrintError": error.message,
              },
            }
          );
        }
      }
    })
  );
};

export const createPayment = async (req, res) => {
  try {
    const { orderId, amount, method, parts } = req.body;
    let paymentDoc = {
      order: orderId,
      txnId: req.body.txnId || "",
      createdAt: new Date(),
    };
    if (Array.isArray(parts) && parts.length > 0) {
      paymentDoc.parts = parts;
      paymentDoc.totalAmount = parts.reduce((sum, p) => sum + (p.amount || 0), 0);
    } else {
      paymentDoc.parts = [{ amount, method: method || "cash", txnId: req.body.txnId || "" }];
      paymentDoc.totalAmount = amount;
      paymentDoc.method = method;
      paymentDoc.amount = amount;
    }
    if (req.body.customer) paymentDoc.customer = req.body.customer;
    const payment = await Payment.create(paymentDoc);
    // update order status to closed if fully paid
    const order = await Order.findById(orderId);
    if (order) {
      order.status = "closed";
      await order.save();
      // Debug log: order and table
      console.log("[PAYMENT] Order:", order);
      if (order.table) {
        const tableUpdate = await Table.findByIdAndUpdate(order.table, { status: "free" });
        console.log("[PAYMENT] Table update result:", tableUpdate);
        // Stol bo'shaganda shu stoldagi barcha ochiq buyurtmalarni o'chirish
        await Order.deleteMany({ table: order.table, status: { $ne: "closed" } });
        console.log("[PAYMENT] Open orders for table deleted");
      } else {
        console.log("[PAYMENT] Order has no table field:", order);
      }

      const io = req.app.get("io");
      if (io) {
        io.to(order.restaurantId || "default").emit("order:updated", order);
      }
    } else {
      console.log("[PAYMENT] Order not found for orderId:", orderId);
    }
    
    // Printer sozlamalarini olish
    const settings = await Settings.findOne();

    if (settings) {
      await triggerAutomaticPrints({ settings, order, payment });
    }

    res.json({ 
      ...payment.toObject(),
      printSettings: settings?.printerSettings || {}
    });
  } catch (err) {
    console.error("[PAYMENT] Error in createPayment:", err);
    res.status(500).json({ message: err.message });
  }
};

export const listPayments = async (req, res) => {
  const payments = await Payment.find()
    .sort({ createdAt: -1 })
    .limit(200)
    .populate({ path: "order", select: "tableName table" })
    .populate({ path: "customer", select: "name" });
  res.json(payments);
};