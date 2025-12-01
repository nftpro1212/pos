// controllers/settingsController.js
import net from "net";
import Settings from "../models/Settings.js";
import {
  buildTestReceiptData,
  generateEscPosReceipt,
  mergeReceiptTemplate,
  sendToNetworkPrinter,
  DEFAULT_RECEIPT_TEMPLATE,
} from "../utils/printer.js";
import { testTaxIntegrationConnection } from "../utils/taxIntegrationService.js";
import { dispatchPrintJob, hasActivePrintAgent } from "../socket.js";

const resolveDispatchMode = (value) =>
  typeof value === "string" && value.toLowerCase() === "agent" ? "agent" : "direct";

const resolveAgentChannel = (value, fallback = "default") => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
};

const buildUpdatePaths = (prefix, fields = {}) => {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  const mapped = entries.map(([key, value]) => [`${prefix}.${key}`, value]);
  return Object.fromEntries(mapped);
};

const persistPrinterPatch = async (printer, fields = {}) => {
  if (!printer?._id) return;
  const update = buildUpdatePaths("printerSettings.printers.$", fields);
  if (!Object.keys(update).length) return;
  await Settings.updateOne({ "printerSettings.printers._id": printer._id }, { $set: update });
};

const persistBasePrinterPatch = async (fields = {}) => {
  const update = buildUpdatePaths("printerSettings", fields);
  if (!Object.keys(update).length) return;
  await Settings.updateOne({}, { $set: update });
};

const resolvePrinterConnectionConfig = (settings, printer, overrides = {}) => {
  const printerSettings = settings?.printerSettings || {};
  const dispatchMode = resolveDispatchMode(
    overrides.dispatchMode ?? printer?.dispatchMode ?? printerSettings.dispatchMode
  );

  const agentChannel = resolveAgentChannel(
    overrides.agentChannel,
    printer?.agentChannel || printerSettings.agentChannel || settings?._id?.toString() || "default"
  );

  const ipAddress =
    overrides.ipAddress ??
    printer?.ipAddress ??
    printerSettings.ipAddress ??
    "";

  const resolvedPort =
    overrides.port ??
    printer?.port ??
    printerSettings.port ??
    9100;

  const port = Number(resolvedPort) || 0;

  return {
    dispatchMode,
    agentChannel,
    ipAddress,
    port,
  };
};

const tcpPing = ({ ipAddress, port, timeoutMs = 5000 }) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (err) {
        // ignore cleanup errors
      }
      resolve(result);
    };

    socket.setTimeout(Number(timeoutMs) || 5000);

    socket.once("connect", () => finalize({ success: true }));
    socket.once("timeout", () => finalize({ success: false, message: "Ulanish vaqtidan oshdi" }));
    socket.once("error", (error) => finalize({ success: false, message: error?.message || "Ulanish xatosi" }));

    try {
      socket.connect(port, ipAddress);
    } catch (error) {
      finalize({ success: false, message: error?.message || "Soket ulanmadi" });
    }
  });

const executePrinterConnectionTest = async ({
  settings,
  printer,
  config,
  timeoutMs,
}) => {
  const printerSettings = settings?.printerSettings || {};
  const printerId = printer?._id ? printer._id.toString() : null;
  const { dispatchMode, agentChannel, ipAddress, port } = config;
  const now = new Date();

  const basePatch = {
    connectionStatus: "disconnected",
    lastConnectionTest: now,
    dispatchMode,
    agentChannel,
  };

  const printerIdentity = {
    printerId,
    name: printer?.name || printerSettings.printerName || "Printer",
    role: printer?.role || "front",
  };

  if (dispatchMode === "agent") {
    if (!hasActivePrintAgent(agentChannel)) {
      await persistPrinterPatch(printer, {
        ...basePatch,
        lastPrintError: "Lokal print agent ulangan emas",
      });
      await persistBasePrinterPatch({
        connectionStatus: "disconnected",
        lastPrintError: "Lokal print agent ulangan emas",
        dispatchMode,
        agentChannel,
      });

      return {
        success: false,
        connectionStatus: "disconnected",
        via: "agent",
        message: "Lokal print agent ulangan emas",
        agentChannel,
        checkedAt: now,
        ...printerIdentity,
      };
    }

    try {
      const result = await dispatchPrintJob({
        restaurantId: agentChannel,
        job: {
          type: "ping",
          printer: buildPrinterPayload(settings, printer, {
            ipAddress: ipAddress || printerSettings.ipAddress,
            port: Number(port || printerSettings.port || 9100),
            dispatchMode: "agent",
            agentChannel,
          }),
          meta: {
            request: "test-printer-connection",
            initiatedAt: now.toISOString(),
          },
        },
        timeoutMs: Number(timeoutMs || 7000),
      });

      await persistPrinterPatch(printer, {
        ...basePatch,
        connectionStatus: "connected",
        lastPrintError: "",
      });
      await persistBasePrinterPatch({
        connectionStatus: "connected",
        lastPrintError: "",
        dispatchMode,
        agentChannel,
        lastTestPrintDate: now,
      });

      return {
        success: result?.success !== false,
        connectionStatus: "connected",
        via: "agent",
        message: result?.message || "🛰️ Lokal agent onlayn",
        agentChannel,
        jobId: result?.jobId || null,
        checkedAt: now,
        ...printerIdentity,
      };
    } catch (error) {
      const message = error?.message || "Lokal print agent javob bermadi";

      await persistPrinterPatch(printer, {
        ...basePatch,
        lastPrintError: message,
      });
      await persistBasePrinterPatch({
        connectionStatus: "disconnected",
        lastPrintError: message,
        dispatchMode,
        agentChannel,
      });

      return {
        success: false,
        connectionStatus: "disconnected",
        via: "agent",
        message,
        agentChannel,
        checkedAt: now,
        ...printerIdentity,
      };
    }
  }

  if (!ipAddress || !port) {
    return {
      success: false,
      connectionStatus: "disconnected",
      via: "direct",
      message: "IP address va portni kiriting",
      agentChannel,
      checkedAt: now,
      ...printerIdentity,
      errorCode: "missing-network-config",
    };
  }

  const pingResult = await tcpPing({ ipAddress, port, timeoutMs });

  if (pingResult.success) {
    await persistPrinterPatch(printer, {
      connectionStatus: "connected",
      lastConnectionTest: now,
      lastPrintError: "",
      dispatchMode,
      agentChannel,
      ipAddress,
      port,
    });

    await persistBasePrinterPatch({
      connectionStatus: "connected",
      lastTestPrintDate: now,
      ipAddress,
      port,
      dispatchMode,
      agentChannel,
      lastPrintError: "",
    });

    return {
      success: true,
      connectionStatus: "connected",
      via: "direct",
      message: "✅ Printer ulandi",
      agentChannel,
      ipAddress,
      port,
      checkedAt: now,
      ...printerIdentity,
    };
  }

  const errorMessage = pingResult.message || "Printer konnektsiya qilinmadi";

  await persistPrinterPatch(printer, {
    ...basePatch,
    lastPrintError: errorMessage,
    ipAddress,
    port,
  });
  await persistBasePrinterPatch({
    connectionStatus: "disconnected",
    lastPrintError: errorMessage,
    ipAddress,
    port,
    dispatchMode,
    agentChannel,
  });

  return {
    success: false,
    connectionStatus: "disconnected",
    via: "direct",
    message: errorMessage,
    agentChannel,
    ipAddress,
    port,
    checkedAt: now,
    ...printerIdentity,
  };
};

const ensurePrinterDefaults = async (settingsDoc) => {
  if (!settingsDoc) return settingsDoc;

  const printerSettings = settingsDoc.printerSettings || (settingsDoc.printerSettings = {});
  let dirty = false;

  const resolvedDispatch = resolveDispatchMode(printerSettings.dispatchMode);
  if (printerSettings.dispatchMode !== resolvedDispatch) {
    printerSettings.dispatchMode = resolvedDispatch;
    dirty = true;
  }

  const resolvedChannel = resolveAgentChannel(printerSettings.agentChannel, "default");
  if (printerSettings.agentChannel !== resolvedChannel) {
    printerSettings.agentChannel = resolvedChannel;
    dirty = true;
  }

  const receiptTemplateObject =
    printerSettings.receiptTemplate && printerSettings.receiptTemplate.toObject
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
      dispatchMode: printerSettings.dispatchMode || "direct",
      agentChannel: printerSettings.agentChannel || "default",
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

    const printerDispatch = resolveDispatchMode(normalized.dispatchMode || printerSettings.dispatchMode);
    if (normalized.dispatchMode !== printerDispatch) {
      normalized.dispatchMode = printerDispatch;
      printerDirty = true;
    }

    const printerChannel = resolveAgentChannel(
      normalized.agentChannel,
      printerSettings.agentChannel || "default"
    );
    if (normalized.agentChannel !== printerChannel) {
      normalized.agentChannel = printerChannel;
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

const buildRestaurantInfo = (settings) => ({
  name: settings?.restaurantName,
  address: settings?.restaurantAddress,
  phone: settings?.restaurantPhone,
});

const buildPrinterPayload = (settings, printer, { ipAddress, port, dispatchMode, agentChannel }) => ({
  id: printer?._id?.toString() || null,
  name: printer?.name || settings.printerSettings?.printerName || "Asosiy printer",
  role: printer?.role || "front",
  connectionType: printer?.connectionType || settings.printerSettings?.connectionType || "network",
  ipAddress,
  port,
  paperWidth: printer?.paperWidth || settings.printerSettings?.paperWidth || "80mm",
  printerType: printer?.printerType || settings.printerSettings?.printerType || "thermal",
  copies: Math.max(1, Number(printer?.copies || settings.printerSettings?.printCopies || 1)),
  dispatchMode,
  agentChannel,
});

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

  if (payload.printerSettings) {
    payload.printerSettings.dispatchMode = resolveDispatchMode(payload.printerSettings.dispatchMode);
    payload.printerSettings.agentChannel = resolveAgentChannel(
      payload.printerSettings.agentChannel,
      "default"
    );
    if (Array.isArray(payload.printerSettings.printers)) {
      payload.printerSettings.printers = payload.printerSettings.printers.map((printer) => ({
        ...printer,
        dispatchMode: resolveDispatchMode(printer.dispatchMode || payload.printerSettings.dispatchMode),
        agentChannel: resolveAgentChannel(printer.agentChannel, payload.printerSettings.agentChannel),
      }));
    }
  }

  const settings = await Settings.findOneAndUpdate({}, payload, {
    new: true,
    upsert: true,
  });

  await ensurePrinterDefaults(settings);
  res.json(settings);
};

export const testPrinterConnection = async (req, res) => {
  try {
    const {
      ipAddress: bodyIp,
      port: bodyPort,
      printerId,
      dispatchMode: bodyDispatchMode,
      agentChannel: bodyAgentChannel,
      timeoutMs,
    } = req.body || {};

    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ success: false, message: "Sozlamalar topilmadi" });
    }

    await ensurePrinterDefaults(settings);

    const printer = printerId ? findPrinterById(settings, printerId) : null;
    if (printerId && !printer) {
      return res.status(404).json({ success: false, message: "Printer topilmadi" });
    }

    const config = resolvePrinterConnectionConfig(settings, printer, {
      ipAddress: bodyIp,
      port: bodyPort,
      dispatchMode: bodyDispatchMode,
      agentChannel: bodyAgentChannel,
    });

    if (config.dispatchMode !== "agent" && (!config.ipAddress || !config.port)) {
      return res.status(400).json({
        success: false,
        message: "IP address va portni kiriting",
        connectionStatus: "disconnected",
        via: config.dispatchMode,
      });
    }

    const result = await executePrinterConnectionTest({
      settings,
      printer,
      config,
      timeoutMs,
    });

    const statusCode = result.success
      ? 200
      : result.errorCode === "missing-network-config"
      ? 400
      : result.via === "direct"
      ? 400
      : 503;

    return res.status(statusCode).json({
      success: result.success,
      message: result.message,
      connectionStatus: result.connectionStatus,
      via: result.via,
      agentChannel: result.agentChannel,
      jobId: result.jobId ?? null,
      printerId: result.printerId ?? null,
      ipAddress: result.ipAddress ?? null,
      port: result.port ?? null,
      checkedAt: result.checkedAt,
    });
  } catch (err) {
    console.error("[PRINTER TEST] Error:", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Server xatosi",
      connectionStatus: "disconnected",
    });
  }
};

export const refreshPrintersStatus = async (req, res) => {
  try {
    const { timeoutMs } = req.body || {};

    const settings = await Settings.findOne();
    if (!settings) {
      return res.status(404).json({ success: false, message: "Sozlamalar topilmadi" });
    }

    await ensurePrinterDefaults(settings);

    const printers = settings.printerSettings?.printers || [];
    if (!printers.length) {
      return res.json({
        success: true,
        printers: [],
        summary: {
          total: 0,
          connected: 0,
          disconnected: 0,
          failed: 0,
          lastCheckedAt: null,
        },
      });
    }

    const results = [];
    for (const printer of printers) {
      const config = resolvePrinterConnectionConfig(settings, printer, {});
      const outcome = await executePrinterConnectionTest({
        settings,
        printer,
        config,
        timeoutMs,
      });

      results.push({
        printerId: outcome.printerId ?? printer?._id?.toString() ?? null,
        name: printer?.name || outcome.name || "Printer",
        role: printer?.role || outcome.role || null,
        connectionStatus: outcome.connectionStatus,
        success: outcome.success,
        message: outcome.message,
        via: outcome.via,
        agentChannel: outcome.agentChannel,
        ipAddress: outcome.ipAddress ?? config.ipAddress ?? null,
        port: outcome.port ?? config.port ?? null,
        checkedAt: outcome.checkedAt,
        errorCode: outcome.errorCode ?? null,
      });
    }

    const summary = {
      total: results.length,
      connected: results.filter((item) => item.connectionStatus === "connected").length,
    };
    summary.disconnected = summary.total - summary.connected;
    summary.failed = results.filter((item) => item.success === false).length;
    summary.lastCheckedAt = results.reduce((latest, item) => {
      if (!item.checkedAt) return latest;
      const current = new Date(item.checkedAt).getTime();
      if (!latest) return item.checkedAt;
      return current > new Date(latest).getTime() ? item.checkedAt : latest;
    }, null);

    return res.json({ success: true, printers: results, summary });
  } catch (error) {
    console.error("[PRINTER REFRESH] Error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Printerlar holatini yangilashda xatolik",
    });
  }
};

export const testPrintCheck = async (req, res) => {
  try {
    const {
      printerId,
      templateOverrides = {},
      ipAddress: bodyIp,
      port: bodyPort,
      dispatchMode: bodyDispatchMode,
      agentChannel: bodyAgentChannel,
      timeoutMs,
    } = req.body || {};

    const settings = await Settings.findOne();
    if (!settings?.printerSettings?.enabled) {
      return res.status(400).json({ success: false, message: "Printer faol emas" });
    }

    await ensurePrinterDefaults(settings);

    let printer = printerId ? findPrinterById(settings, printerId) : null;
    if (printerId && !printer) {
      return res.status(404).json({ success: false, message: "Printer topilmadi" });
    }

    if (!printer) {
      const defaultId = settings.printerSettings?.defaultPrinterId?.toString();
      printer = defaultId
        ? findPrinterById(settings, defaultId)
        : settings.printerSettings?.printers?.[0] || null;
    }

    const dispatchMode = resolveDispatchMode(
      bodyDispatchMode ?? printer?.dispatchMode ?? settings.printerSettings?.dispatchMode
    );

    const agentChannel = resolveAgentChannel(
      bodyAgentChannel,
      printer?.agentChannel || settings.printerSettings?.agentChannel || settings._id?.toString() || "default"
    );

    const ipAddress = bodyIp || printer?.ipAddress || settings.printerSettings?.ipAddress;
    const port = Number(bodyPort || printer?.port || settings.printerSettings?.port || 9100);

    const template = mergeReceiptTemplate(
      settings.printerSettings?.receiptTemplate,
      printer?.templateOverrides,
      templateOverrides
    );

    const { order, payment } = buildTestReceiptData({
      restaurant: buildRestaurantInfo(settings),
    });

    const printerPayload = buildPrinterPayload(settings, printer, {
      ipAddress,
      port,
      dispatchMode,
      agentChannel,
    });

    if (dispatchMode === "agent") {
      if (!hasActivePrintAgent(agentChannel)) {
        return res.status(503).json({ success: false, message: "Lokal print agent ulangan emas" });
      }

      try {
        const result = await dispatchPrintJob({
          restaurantId: agentChannel,
          job: {
            type: "test-print",
            printer: printerPayload,
            template,
            order,
            payment,
            restaurant: buildRestaurantInfo(settings),
            options: {
              isTest: true,
              copies: printerPayload.copies,
            },
            connection: {
              ipAddress,
              port,
            },
          },
          timeoutMs: Number(timeoutMs || 12000),
        });

        const now = new Date();

        if (printer?._id) {
          await Settings.updateOne(
            { "printerSettings.printers._id": printer._id },
            {
              $set: {
                "printerSettings.printers.$.lastTestPrintDate": now,
                "printerSettings.printers.$.connectionStatus": "connected",
                "printerSettings.printers.$.lastPrintError": "",
                "printerSettings.printers.$.dispatchMode": "agent",
                "printerSettings.printers.$.agentChannel": agentChannel,
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
              "printerSettings.lastPrintError": "",
              "printerSettings.dispatchMode": "agent",
              "printerSettings.agentChannel": agentChannel,
            },
          }
        );

        return res.json({
          success: result?.success !== false,
          message: result?.message || "✅ Test chek agentga yuborildi",
          via: "agent",
          jobId: result?.jobId || null,
        });
      } catch (err) {
        const errorMessage = err?.message || "Lokal agent javob bermadi";

        if (printer?._id) {
          await Settings.updateOne(
            { "printerSettings.printers._id": printer._id },
            {
              $set: {
                "printerSettings.printers.$.connectionStatus": "disconnected",
                "printerSettings.printers.$.lastPrintError": errorMessage,
                "printerSettings.printers.$.dispatchMode": "agent",
                "printerSettings.printers.$.agentChannel": agentChannel,
              },
            }
          );
        }

        await Settings.updateOne(
          {},
          {
            $set: {
              "printerSettings.connectionStatus": "disconnected",
              "printerSettings.lastPrintError": errorMessage,
              "printerSettings.dispatchMode": "agent",
              "printerSettings.agentChannel": agentChannel,
            },
          }
        );

        return res.status(500).json({ success: false, message: errorMessage });
      }
    }

    if (!ipAddress || !port) {
      return res.status(400).json({ success: false, message: "Printer IP va portni kiriting" });
    }

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
      restaurant: buildRestaurantInfo(settings),
      isTest: true,
    });

    await sendToNetworkPrinter({ ipAddress, port }, buffer, { timeout: Number(timeoutMs || 7000) });

    const now = new Date();

    if (printer?._id) {
      await Settings.updateOne(
        { "printerSettings.printers._id": printer._id },
        {
          $set: {
            "printerSettings.printers.$.lastTestPrintDate": now,
            "printerSettings.printers.$.connectionStatus": "connected",
            "printerSettings.printers.$.lastPrintError": "",
            "printerSettings.printers.$.dispatchMode": dispatchMode,
            "printerSettings.printers.$.agentChannel": agentChannel,
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
          "printerSettings.lastPrintError": "",
          "printerSettings.dispatchMode": dispatchMode,
          "printerSettings.agentChannel": agentChannel,
        },
      }
    );

    res.json({ success: true, message: "✅ Test chek printerga yuborildi", via: dispatchMode });
  } catch (err) {
    console.error("[TEST PRINT] Error:", err);
    res.status(500).json({ success: false, message: err?.message || "Server xatosi" });
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
