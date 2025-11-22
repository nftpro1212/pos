// controllers/settingsController.js
import Settings from "../models/Settings.js";
import net from "net";
import {
  buildTestReceiptData,
  generateEscPosReceipt,
  mergeReceiptTemplate,
  sendToNetworkPrinter,
  DEFAULT_RECEIPT_TEMPLATE,
} from "../utils/printer.js";
import { testTaxIntegrationConnection } from "../utils/taxIntegrationService.js";

const ensurePrinterDefaults = async (settingsDoc) => {
  if (!settingsDoc) return settingsDoc;
  const printerSettings = settingsDoc.printerSettings || (settingsDoc.printerSettings = {});
  let dirty = false;

  const receiptTemplateObject = printerSettings.receiptTemplate && printerSettings.receiptTemplate.toObject
    ? printerSettings.receiptTemplate.toObject()
    : printerSettings.receiptTemplate || {};
  const mergedTemplate = {
    ...DEFAULT_RECEIPT_TEMPLATE,
    ...receiptTemplateObject,
  };
  if (JSON.stringify(mergedTemplate) !== JSON.stringify(receiptTemplateObject)) {
    printerSettings.receiptTemplate = mergedTemplate;
    dirty = true;
  }

  if (!Array.isArray(printerSettings.printers)) {
    printerSettings.printers = [];
    dirty = true;
  }

  if (printerSettings.printers.length === 0) {
    printerSettings.printers.push({
      name: printerSettings.printerName || "Asosiy printer",
      role: "front",
      connectionType: printerSettings.connectionType || "network",
      ipAddress: printerSettings.ipAddress || "",
      port: printerSettings.port || 9100,
      paperWidth: printerSettings.paperWidth || "80mm",
      printerType: printerSettings.printerType || "thermal",
      autoprint: Boolean(printerSettings.autoprint),
      autoPrintTriggers: ["payment"],
      copies: printerSettings.printCopies || 1,
      headerText: printerSettings.headerText || "",
      footerText: printerSettings.footerText || "",
      enabled: true,
      connectionStatus: "disconnected",
    });
    dirty = true;
  }

  printerSettings.printers.forEach((printer, index) => {
    const normalized = printer?.toObject ? printer.toObject() : { ...printer };
    let printerDirty = false;

    if (!Array.isArray(normalized.autoPrintTriggers) || !normalized.autoPrintTriggers.length) {
      normalized.autoPrintTriggers = ["payment"];
      printerDirty = true;
    }

    if (!normalized.templateOverrides) {
      normalized.templateOverrides = {};
      printerDirty = true;
    }

    if (printerDirty) {
      if (printer?.set) {
        printer.set(normalized);
      } else {
        printerSettings.printers[index] = normalized;
      }
      dirty = true;
    }
  });

  if (!printerSettings.defaultPrinterId && printerSettings.printers[0]?._id) {
    printerSettings.defaultPrinterId = printerSettings.printers[0]._id;
    dirty = true;
  }

  if (dirty) {
    if (typeof settingsDoc.markModified === "function") {
      settingsDoc.markModified("printerSettings");
    }

    if (typeof settingsDoc.save === "function") {
      await settingsDoc.save();
    }
  }

  return settingsDoc;
};

const findPrinterById = (settingsDoc, printerId) =>
  settingsDoc?.printerSettings?.printers?.find((printer) => printer?._id?.toString() === printerId);

export const getSettings = async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({ restaurantName: "My Restaurant" });
  }

  await ensurePrinterDefaults(settings);
  res.json(settings);
};

export const updateSettings = async (req, res) => {
  const payload = { ...req.body };
  if (payload.printerSettings?.receiptTemplate) {
    payload.printerSettings.receiptTemplate = {
      ...DEFAULT_RECEIPT_TEMPLATE,
      ...payload.printerSettings.receiptTemplate,
    };
  }

  const settings = await Settings.findOneAndUpdate({}, payload, {
    new: true,
    upsert: true,
  });

  await ensurePrinterDefaults(settings);
  res.json(settings);
};

// Printer connection test
export const testPrinterConnection = async (req, res) => {
  try {
    const { ipAddress: bodyIp, port: bodyPort, printerId } = req.body || {};
    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ success: false, message: "Sozlamalar topilmadi" });
    }

    const printer = printerId ? findPrinterById(settings, printerId) : null;
    if (printerId && !printer) {
      return res.status(404).json({ success: false, message: "Printer topilmadi" });
    }

    const ipAddress = bodyIp || printer?.ipAddress || settings.printerSettings?.ipAddress;
    const port = Number(bodyPort || printer?.port || settings.printerSettings?.port || 9100);

    if (!ipAddress || !port) {
      return res.status(400).json({
        success: false,
        message: "IP address va portni kiriting",
        connectionStatus: "disconnected",
      });
    }

    const socket = new net.Socket();
    let connected = false;

    socket.setTimeout(5000);

    socket.on("connect", async () => {
      connected = true;
      socket.destroy();
      const now = new Date();

      if (printer) {
        await Settings.updateOne(
          { "printerSettings.printers._id": printer._id },
          {
            $set: {
              "printerSettings.printers.$.connectionStatus": "connected",
              "printerSettings.printers.$.lastConnectionTest": now,
              "printerSettings.printers.$.ipAddress": ipAddress,
              "printerSettings.printers.$.port": port,
            },
          }
        );
      }

      await Settings.updateOne(
        {},
        {
          $set: {
            "printerSettings.connectionStatus": "connected",
            "printerSettings.lastTestPrintDate": now,
            "printerSettings.ipAddress": ipAddress,
            "printerSettings.port": port,
          },
        }
      );

      res.json({
        success: true,
        message: "✅ Printer ulandi",
        connectionStatus: "connected",
      });
    });

    socket.on("timeout", async () => {
      socket.destroy();
      if (printer) {
        await Settings.updateOne(
          { "printerSettings.printers._id": printer._id },
          {
            $set: {
              "printerSettings.printers.$.connectionStatus": "disconnected",
              "printerSettings.printers.$.lastConnectionTest": new Date(),
            },
          }
        );
      }

      res.status(400).json({
        success: false,
        message: "⏱️ Ulanish vaqti tugadi. IP addressni tekshiring",
        connectionStatus: "disconnected",
      });
    });

    socket.on("error", async (err) => {
      socket.destroy();
      console.error("[PRINTER] Connection error:", err.message);
      if (printer) {
        await Settings.updateOne(
          { "printerSettings.printers._id": printer._id },
          {
            $set: {
              "printerSettings.printers.$.connectionStatus": "disconnected",
              "printerSettings.printers.$.lastConnectionTest": new Date(),
            },
          }
        );
      }

      res.status(400).json({
        success: false,
        message: `❌ Ulanib bo'lmadi: ${err.message}`,
        connectionStatus: "disconnected",
      });
    });

    socket.connect(port, ipAddress);
  } catch (err) {
    console.error("[PRINTER TEST] Error:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message,
      connectionStatus: "disconnected"
    });
  }
};

// Test print - printer'ga test chap yuborish
export const testPrintCheck = async (req, res) => {
  try {
    const { printerId, templateOverrides = {}, ipAddress: bodyIp, port: bodyPort } = req.body || {};
    const settings = await Settings.findOne();
    if (!settings?.printerSettings?.enabled) {
      return res.status(400).json({ success: false, message: "Printer faol emas" });
    }

    await ensurePrinterDefaults(settings);

    let printer = printerId
      ? findPrinterById(settings, printerId)
      : null;

    if (printerId && !printer) {
      return res.status(404).json({ success: false, message: "Printer topilmadi" });
    }

    if (!printer) {
      const defaultId = settings.printerSettings?.defaultPrinterId?.toString();
      printer = defaultId
        ? findPrinterById(settings, defaultId)
        : settings.printerSettings?.printers?.[0] || null;
    }

    const ipAddress = bodyIp || printer?.ipAddress || settings.printerSettings?.ipAddress;
    const port = Number(bodyPort || printer?.port || settings.printerSettings?.port || 9100);

    if (!ipAddress || !port) {
      return res.status(400).json({
        success: false,
        message: "Printer IP va portni kiriting",
      });
    }

    const template = mergeReceiptTemplate(
      settings.printerSettings?.receiptTemplate,
      printer?.templateOverrides,
      templateOverrides
    );

    const { order, payment } = buildTestReceiptData({
      restaurant: {
        name: settings.restaurantName,
        address: settings.restaurantAddress,
        phone: settings.restaurantPhone,
      },
    });

    const buffer = generateEscPosReceipt({
      order,
      payment,
      template,
      printer: {
        ...settings.printerSettings,
        ...printer,
        ipAddress,
        port,
      },
      restaurant: {
        name: settings.restaurantName,
        address: settings.restaurantAddress,
        phone: settings.restaurantPhone,
      },
      isTest: true,
    });

    await sendToNetworkPrinter({ ipAddress, port }, buffer, { timeout: 7000 });

    const now = new Date();

    if (printer?._id) {
      await Settings.updateOne(
        { "printerSettings.printers._id": printer._id },
        {
          $set: {
            "printerSettings.printers.$.lastTestPrintDate": now,
            "printerSettings.printers.$.connectionStatus": "connected",
          },
        }
      );
    }

    await Settings.updateOne(
      {},
      {
        $set: {
          "printerSettings.lastTestPrintDate": now,
          "printerSettings.connectionStatus": "connected",
        },
      }
    );

    res.json({ success: true, message: "✅ Test chek printerga yuborildi" });
  } catch (err) {
    console.error("[TEST PRINT] Error:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

export const testTaxIntegration = async (req, res) => {
  try {
    const currentSettings = await Settings.findOne();
    const configOverride = req.body?.taxIntegration || req.body;
    const config = {
      ...(currentSettings?.taxIntegration || {}),
      ...(typeof configOverride === "object" ? configOverride : {}),
    };

    const result = await testTaxIntegrationConnection(config);
    if (result.success) {
      return res.json({ success: true, message: result.message });
    }
    return res.status(400).json({ success: false, message: result.message });
  } catch (error) {
    console.error("[TAX TEST]", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};