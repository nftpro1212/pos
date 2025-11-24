import express from "express";
import Settings from "../models/Settings.js";

const router = express.Router();

const AUTH_HEADER_PREFIX = "Bearer ";

const authenticateAgent = (req, res, next) => {
  const configuredToken =
    process.env.AGENT_ACCESS_TOKEN ||
    process.env.PRINTER_AGENT_TOKEN ||
    process.env.POS_AGENT_TOKEN;

  if (!configuredToken) {
    return next();
  }

  const headerValue = req.headers.authorization || "";
  const provided = headerValue.startsWith(AUTH_HEADER_PREFIX)
    ? headerValue.slice(AUTH_HEADER_PREFIX.length).trim()
    : null;

  if (!provided || provided !== configuredToken) {
    return res.status(401).json({
      success: false,
      message: "Agent authentication failed",
    });
  }

  return next();
};

const normalisePrinters = (settings, channel) => {
  const printerSettings = settings.printerSettings || {};
  const globalChannel = printerSettings.agentChannel || "default";
  const globalDispatchMode = printerSettings.dispatchMode || "direct";
  const printerList = Array.isArray(printerSettings.printers)
    ? printerSettings.printers
    : [];

  const fallbackPrinter = printerList.length
    ? null
    : {
        _id: null,
        name: printerSettings.printerName || "Main Printer",
        ipAddress: printerSettings.ipAddress || "",
        port: printerSettings.port || 9100,
        printerType: printerSettings.printerType || "thermal",
        paperWidth: printerSettings.paperWidth || "80mm",
        copies: printerSettings.printCopies || 1,
        dispatchMode: printerSettings.dispatchMode || "direct",
        agentChannel: globalChannel,
      };

  const source = fallbackPrinter ? [fallbackPrinter] : printerList;

  return source
    .filter((printer) => printer && printer.enabled !== false)
    .filter((printer) => {
      if (!channel) return true;
      const resolvedChannel = printer.agentChannel || globalChannel;
      return resolvedChannel === channel;
    })
    .map((printer, index) => {
      const rawPrinter =
        typeof printer?.toObject === "function" ? printer.toObject() : printer;
      const resolvedChannel = printer.agentChannel || globalChannel;
      const resolvedDispatch = printer.dispatchMode || globalDispatchMode || "direct";

      const portCandidate = printer.port ?? printerSettings.port ?? 9100;
      const parsedPort = Number.parseInt(portCandidate, 10);
      const copiesCandidate = printer.copies ?? printerSettings.printCopies ?? 1;
      const parsedCopies = Number.parseInt(copiesCandidate, 10);

      return {
        id: printer._id ? String(printer._id) : `printer-${index + 1}`,
        name: printer.name || printerSettings.printerName || `Printer ${index + 1}`,
        description: printer.description || "",
        agentChannel: resolvedChannel,
        dispatchMode: resolvedDispatch,
        ipAddress: printer.ipAddress || printerSettings.ipAddress || "",
        port: Number.isFinite(parsedPort) ? parsedPort : 9100,
        printerType: printer.printerType || printerSettings.printerType || "thermal",
        paperWidth: printer.paperWidth || printerSettings.paperWidth || "80mm",
        copies: Number.isFinite(parsedCopies) ? parsedCopies : 1,
        templateOverrides: printer.templateOverrides || {},
        headerText: printer.headerText || printerSettings.headerText || "",
        footerText: printer.footerText || printerSettings.footerText || "",
        additionalConfig: printer.additionalConfig || {},
        raw: rawPrinter,
      };
    });
};

router.get("/printers", authenticateAgent, async (req, res) => {
  try {
    const { channel } = req.query;
    const settings = await Settings.findOne({});

    if (!settings) {
      return res.json({
        printers: [],
        printerSettings: {},
        template: {},
        restaurant: {},
      });
    }

    const printers = normalisePrinters(settings, channel);
    const printerSettings = settings.printerSettings || {};

    return res.json({
      printers,
      printerSettings: {
        agentChannel: printerSettings.agentChannel || "default",
        dispatchMode: printerSettings.dispatchMode || "direct",
        receiptTemplate: printerSettings.receiptTemplate || {},
        defaultCopies: printerSettings.printCopies || 1,
      },
      template: printerSettings.receiptTemplate || {},
      restaurant: {
        name: settings.restaurantName || "",
        address: settings.restaurantAddress || "",
        phone: settings.restaurantPhone || "",
        taxId: settings.restaurantTaxId || "",
        website: settings.restaurantWebsite || "",
      },
    });
  } catch (error) {
    console.error("Failed to fetch printers for agent", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load printer configuration",
      error: error.message,
    });
  }
});

export default router;
