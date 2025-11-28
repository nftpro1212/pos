// src/backend/controllers/orderController.js
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Table from "../models/Table.js";
import Settings from "../models/Settings.js";
import MenuItem from "../models/MenuItem.js";
import Recipe from "../models/Recipe.js";
import InventoryItem from "../models/InventoryItem.js";
import InventoryMovement from "../models/InventoryMovement.js";
import ActionLog from "../models/ActionLog.js";
import { fiscalizeOrder } from "../utils/taxIntegrationService.js";
import {
  resolveWarehouse,
  getOrCreateStock,
  recalcItemTotals,
} from "../utils/inventoryHelpers.js";
import {
  mergeReceiptTemplate,
  DEFAULT_RECEIPT_TEMPLATE,
  generatePrepTicket,
  sendToNetworkPrinter,
  generateEscPosReceipt,
} from "../utils/printer.js";
import { dispatchPrintJob, hasActivePrintAgent } from "../socket.js";

const { Types } = mongoose;

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

const buildRestaurantInfo = (settings = {}) => ({
  name: settings.restaurantName || "ZarPOS Restoran",
  address: settings.restaurantAddress || "",
  phone: settings.restaurantPhone || "",
  email: settings.restaurantEmail || "",
});

const getActiveVersion = (recipe) => {
  if (!recipe?.versions?.length) return null;
  if (recipe.defaultVersion) {
    const active = recipe.versions.find((version) =>
      version._id.toString() === recipe.defaultVersion.toString()
    );
    if (active) return active;
  }
  return recipe.versions.find((version) => version.isDefault) || recipe.versions[0];
};

const applyRecipeInventoryUsage = async (order, user) => {
  try {
    if (!order?.items?.length) return;

    const validMenuItems = order.items
      .map((item) => (Types.ObjectId.isValid(item.menuItem) ? item.menuItem : null))
      .filter(Boolean);

    if (!validMenuItems.length) return;

    const recipes = await Recipe.find({ menuItem: { $in: validMenuItems }, isActive: true })
      .lean();
    if (!recipes.length) return;

    const recipeMap = new Map();
    recipes.forEach((recipe) => {
      if (recipe.menuItem) {
        recipeMap.set(recipe.menuItem.toString(), recipe);
      }
    });

    const ingredientIdSet = new Set();
    recipes.forEach((recipe) => {
      const version = getActiveVersion(recipe);
      version?.ingredients?.forEach((ingredient) => {
        if (ingredient?.item) ingredientIdSet.add(ingredient.item.toString());
      });
    });

    if (!ingredientIdSet.size) return;

    const ingredientIds = Array.from(ingredientIdSet).map((id) => new Types.ObjectId(id));
    const inventoryItems = await InventoryItem.find({ _id: { $in: ingredientIds } })
      .select("_id name unit cost defaultWarehouse parLevel currentStock")
      .lean();
    if (!inventoryItems.length) return;

    const inventoryMap = new Map();
    inventoryItems.forEach((item) => inventoryMap.set(item._id.toString(), item));

    const usageMap = new Map();

    const usedRecipeIds = new Set();

    order.items.forEach((orderItem) => {
      if (!orderItem?.menuItem) return;
      const recipe = recipeMap.get(orderItem.menuItem.toString());
      if (!recipe) return;

      const version = getActiveVersion(recipe);
      if (!version || !version.ingredients?.length) return;

      usedRecipeIds.add(recipe._id.toString());

      const portionKey = orderItem.portionKey || "standard";
      const portion = version.portionSizes?.find((portionDoc) => portionDoc.key === portionKey)
        || version.portionSizes?.[0];
      const portionMultiplier = portion?.multiplier ?? 1;

      version.ingredients.forEach((ingredient) => {
        const inventoryItem = inventoryMap.get(ingredient.item?.toString());
        if (!inventoryItem) return;

        const baseQuantity = ingredient.quantity || 0;
        if (baseQuantity <= 0) return;

        const wasteMultiplier = 1 + (ingredient.wastePercent || 0) / 100;
        const totalQuantity = baseQuantity * portionMultiplier * (orderItem.qty || 1) * wasteMultiplier;

        const keyWarehouse = ingredient.warehouse
          ? ingredient.warehouse.toString()
          : inventoryItem.defaultWarehouse?.toString() || "default";
        const mapKey = `${ingredient.item}:${keyWarehouse}`;

        if (!usageMap.has(mapKey)) {
          usageMap.set(mapKey, {
            inventoryItemId: ingredient.item.toString(),
            warehouseId: ingredient.warehouse?.toString() || inventoryItem.defaultWarehouse?.toString() || null,
            totalQuantity: 0,
            menuItems: new Set(),
            portions: new Set(),
          });
        }

        const usageEntry = usageMap.get(mapKey);
        usageEntry.totalQuantity += totalQuantity;
        if (orderItem.name) usageEntry.menuItems.add(orderItem.name);
        if (portionKey) usageEntry.portions.add(portionKey);
      });
    });

    if (!usageMap.size) return;

    const aggregateByInventory = new Map();
    const now = new Date();

    for (const usageEntry of usageMap.values()) {
      const inventoryItem = inventoryMap.get(usageEntry.inventoryItemId);
      if (!inventoryItem) continue;

      let warehouse;
      try {
        warehouse = await resolveWarehouse(usageEntry.warehouseId || inventoryItem.defaultWarehouse);
      } catch (error) {
        console.error("[RECIPE] resolve warehouse error", error.message);
        continue;
      }

      const stockDoc = await getOrCreateStock(inventoryItem, warehouse, { parLevel: inventoryItem.parLevel });
      const previousQuantity = stockDoc.quantity || 0;
      const usageQuantity = usageEntry.totalQuantity;
      let newQuantity = previousQuantity - usageQuantity;
      let actualDelta = -usageQuantity;
      let shortage = 0;

      if (newQuantity < 0) {
        shortage = Math.abs(newQuantity);
        actualDelta = -previousQuantity;
        newQuantity = 0;
      }

      stockDoc.quantity = newQuantity;
      stockDoc.lastMovementAt = now;
      await stockDoc.save();

      const movementQuantity = Math.abs(actualDelta);
      if (movementQuantity > 0 || shortage > 0) {
        await InventoryMovement.create({
          item: inventoryItem._id,
          type: "usage",
          quantity: movementQuantity,
          delta: actualDelta,
          balanceAfter: newQuantity,
          unit: inventoryItem.unit || "dona",
          warehouse: warehouse._id,
          reason: `Buyurtma #${order._id.toString().slice(-6)} retsept sarfi`,
          reference: usageEntry.menuItems.size
            ? `Taomlar: ${Array.from(usageEntry.menuItems).join(", ")}`
            : "",
          metadata: {
            orderId: order._id,
            portions: Array.from(usageEntry.portions),
            shortage,
          },
          createdBy: user?._id || null,
          unitCost: inventoryItem.cost || 0,
          totalCost: movementQuantity * (inventoryItem.cost || 0),
        });
      }

      const aggregate = aggregateByInventory.get(inventoryItem._id.toString()) || {
        inventoryItemId: inventoryItem._id,
        totalUsage: 0,
      };
      aggregate.totalUsage += usageQuantity;
      aggregateByInventory.set(inventoryItem._id.toString(), aggregate);
    }

    for (const aggregate of aggregateByInventory.values()) {
      const total = await recalcItemTotals(aggregate.inventoryItemId);
      await InventoryItem.findByIdAndUpdate(aggregate.inventoryItemId, {
        currentStock: total,
      });
    }

    if (aggregateByInventory.size) {
      await ActionLog.create({
        user: user?._id || null,
        action: "inventory_usage_auto",
        details: `Buyurtma #${order._id.toString().slice(-6)} uchun avtomatik sarf`
          + ` (${aggregateByInventory.size} ta ingredient)` ,
        metadata: {
          orderId: order._id,
          ingredientCount: aggregateByInventory.size,
        },
      });
    }

    if (usedRecipeIds.size) {
      const recipeObjectIds = Array.from(usedRecipeIds).map((id) => new Types.ObjectId(id));
      await Recipe.updateMany(
        { _id: { $in: recipeObjectIds } },
        { $set: { lastUsedAt: new Date() } }
      );
    }
  } catch (error) {
    console.error("applyRecipeInventoryUsage error", error);
  }
};

const triggerProductionPrints = async ({ order, settings }) => {
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

  const printerMap = new Map();
  printers.forEach((printer) => {
    if (!printer) return;
    const id = printer._id ? String(printer._id) : null;
    if (id) printerMap.set(id, printer);
  });

  const defaultPrinterId = basePrinterSettings.defaultPrinterId
    ? String(basePrinterSettings.defaultPrinterId)
    : null;
  const defaultPrinter = defaultPrinterId ? printerMap.get(defaultPrinterId) : null;

  const fallbackPrinter = defaultPrinter
    || (basePrinterSettings.autoprint && basePrinterSettings.ipAddress
      ? {
          _id: null,
          name: basePrinterSettings.printerName || "Asosiy printer",
          connectionType: basePrinterSettings.connectionType || "network",
          ipAddress: basePrinterSettings.ipAddress,
          port: Number(basePrinterSettings.port || 9100),
          paperWidth: basePrinterSettings.paperWidth || "80mm",
          printerType: basePrinterSettings.printerType || "thermal",
          dispatchMode: resolveDispatchMode(basePrinterSettings.dispatchMode, "direct"),
          agentChannel: resolveAgentChannel(basePrinterSettings.agentChannel, "default"),
          copies: basePrinterSettings.printCopies || 1,
          templateOverrides: basePrinterSettings.templateOverrides || {},
          headerText: basePrinterSettings.headerText,
          footerText: basePrinterSettings.footerText,
        }
      : null);

  const menuItemIds = Array.from(
    new Set(
      (order.items || [])
        .map((item) => (item?.menuItem ? item.menuItem.toString() : null))
        .filter(Boolean),
    ),
  );

  const menuDocs = menuItemIds.length
    ? await MenuItem.find({ _id: { $in: menuItemIds } })
        .select("_id productionPrinterIds productionTags category")
        .lean()
    : [];

  const menuMap = new Map(menuDocs.map((doc) => [doc._id.toString(), doc]));

  const assignments = new Map();

  (order.items || []).forEach((item) => {
    const menuDoc = item?.menuItem ? menuMap.get(item.menuItem.toString()) : null;
    const directIds = Array.isArray(item?.productionPrinterIds) ? item.productionPrinterIds : [];
    const menuIds = Array.isArray(menuDoc?.productionPrinterIds) ? menuDoc.productionPrinterIds : [];
    const combined = Array.from(new Set([...directIds, ...menuIds].map(String).filter(Boolean)));

    let targetPrinterIds = combined;

    if (!targetPrinterIds.length && fallbackPrinter) {
      const fallbackKey = fallbackPrinter._id ? String(fallbackPrinter._id) : "__fallback__";
      targetPrinterIds = [fallbackKey];
    }

    targetPrinterIds.forEach((printerId) => {
      const printer = printerId === "__fallback__"
        ? fallbackPrinter
        : printerMap.get(printerId);
      if (!printer || printer.enabled === false) return;

      const ipAddress = printer.ipAddress || basePrinterSettings.ipAddress;
      const port = Number(printer.port || basePrinterSettings.port || 9100);
      if (!ipAddress || !port) return;

      const key = printerId;
      if (!assignments.has(key)) {
        assignments.set(key, {
          printer,
          items: [],
        });
      }
      assignments.get(key).items.push({
        name: item.name,
        qty: item.qty,
        notes: item.notes,
        modifiers: item.modifiers,
      });
    });
  });

  if (!assignments.size) {
    return {
      results: [],
      summary: { total: 0, success: 0, failed: 0 },
    };
  }

  const restaurantInfo = buildRestaurantInfo(settings);
  const orderPayload = order?.toObject ? order.toObject() : order;
  const results = [];

  for (const [key, job] of assignments.entries()) {
    const printer = key === "__fallback__"
      ? fallbackPrinter
      : printerMap.get(key) || fallbackPrinter;

    if (!printer) {
      continue;
    }

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
      ipAddress: printer.ipAddress || basePrinterSettings.ipAddress,
      port: Number(printer.port || basePrinterSettings.port || 9100),
      paperWidth: printer.paperWidth || basePrinterSettings.paperWidth || "80mm",
      printerType: printer.printerType || basePrinterSettings.printerType || "thermal",
      copies: Number(printer.copies || basePrinterSettings.printCopies || 1),
      templateOverrides: printer.templateOverrides || {},
      headerText: printer.headerText || basePrinterSettings.headerText || "",
      footerText: printer.footerText || basePrinterSettings.footerText || "",
      connectionTimeout: printer.connectionTimeout,
    };

    try {
      const mergedTemplate = mergeReceiptTemplate(
        DEFAULT_RECEIPT_TEMPLATE,
        basePrinterSettings.receiptTemplate,
        printer.templateOverrides || {},
      );

      if (dispatchMode === "agent") {
        if (!hasActivePrintAgent(agentChannel)) {
          throw new Error("Lokal print agent ulangan emas");
        }

        const result = await dispatchPrintJob({
          restaurantId: agentChannel,
          job: {
            type: "kitchen-order",
            printer: printerPayload,
            template: mergedTemplate,
            order: {
              ...orderPayload,
              items: job.items,
            },
            restaurant: restaurantInfo,
            options: {
              copies: printerPayload.copies,
              heading: printer.role ? printer.role.toUpperCase() : "BUYURTMA",
            },
          },
          timeoutMs: Number(printer.connectionTimeout || 12000),
        });

        if (result?.success === false) {
          throw new Error(result.message || "Agent xatosi");
        }
      } else {
        const buffer = generatePrepTicket({
          order: orderPayload,
          items: job.items,
          printer: printerPayload,
          restaurant: restaurantInfo,
          heading: printer.role ? printer.role : "Buyurtma",
        });

        await sendToNetworkPrinter(
          { ipAddress: printerPayload.ipAddress, port: printerPayload.port },
          buffer,
          { timeout: printer.connectionTimeout || 7000 },
        );
      }

      const now = new Date();

      if (printer?._id) {
        await Settings.updateOne(
          { "printerSettings.printers._id": printer._id },
          {
            $set: {
              "printerSettings.printers.$.lastPrintDate": now,
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
              "printerSettings.lastPrintDate": now,
              "printerSettings.connectionStatus": "connected",
              "printerSettings.lastPrintError": "",
            },
          },
        );
      }

      results.push({
        success: true,
        printerId: printerPayload.id,
        printerName: printerPayload.name,
        dispatchMode,
      });
    } catch (error) {
      console.error("[ORDER PRINT] Error:", error);

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

      results.push({
        success: false,
        printerId: printerPayload?.id || null,
        printerName: printerPayload?.name || printer?.name || null,
        dispatchMode,
        message: error.message,
      });
    }
  }

  return {
    results,
    summary: {
      total: results.length,
      success: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success).length,
    },
  };
};

const ORDER_RECEIPT_TRIGGERS = new Set(["order", "new-order", "order-created", "precheck", "kassa"]);

const normalizeTriggerKey = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const shouldAutoprintForOrder = (printer = {}) => {
  if (!printer || printer.enabled === false) return false;
  const triggers = Array.isArray(printer.autoPrintTriggers)
    ? printer.autoPrintTriggers.map(normalizeTriggerKey).filter(Boolean)
    : [];

  if (triggers.some((trigger) => ORDER_RECEIPT_TRIGGERS.has(trigger))) {
    return true;
  }

  return Boolean(printer.autoprint);
};

const triggerFrontReceiptPrint = async ({ order, settings }) => {
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

  const networkCapable = (printer) => {
    if (!printer) return false;
    if (printer.connectionType && printer.connectionType !== "network") {
      return false;
    }
    if (!printer.ipAddress || !printer.port) {
      return false;
    }
    return true;
  };

  const fallbackPrinter = basePrinterSettings.ipAddress
    ? {
        _id: null,
        name: basePrinterSettings.printerName || "Asosiy printer",
        connectionType: basePrinterSettings.connectionType || "network",
        dispatchMode: resolveDispatchMode(basePrinterSettings.dispatchMode, "direct"),
        agentChannel: resolveAgentChannel(basePrinterSettings.agentChannel, "default"),
        ipAddress: basePrinterSettings.ipAddress,
        port: Number(basePrinterSettings.port || 9100),
        paperWidth: basePrinterSettings.paperWidth || "80mm",
        printerType: basePrinterSettings.printerType || "thermal",
        autoprint: Boolean(basePrinterSettings.autoprint),
        autoPrintTriggers: ["order", "payment"],
        copies: Number(basePrinterSettings.printCopies || 1),
        headerText: basePrinterSettings.headerText || "",
        footerText: basePrinterSettings.footerText || "",
        templateOverrides: basePrinterSettings.templateOverrides || {},
        connectionTimeout: basePrinterSettings.connectionTimeout,
      }
    : null;

  let selectedPrinters = printers.filter(
    (printer) => networkCapable(printer) && shouldAutoprintForOrder(printer),
  );

  if (
    !selectedPrinters.length
    && fallbackPrinter
    && networkCapable(fallbackPrinter)
    && shouldAutoprintForOrder(fallbackPrinter)
  ) {
    selectedPrinters = [fallbackPrinter];
  }

  if (!selectedPrinters.length) {
    return {
      results: [],
      summary: { total: 0, success: 0, failed: 0 },
    };
  }

  const restaurantInfo = buildRestaurantInfo(settings);
  const orderPayload = order?.toObject ? order.toObject() : order || {};
  const baseTemplate = mergeReceiptTemplate(
    DEFAULT_RECEIPT_TEMPLATE,
    basePrinterSettings.receiptTemplate,
  );

  const results = await Promise.all(
    selectedPrinters.map(async (printer) => {
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
        connectionTimeout: printer.connectionTimeout,
      };

      const templateForPrinter = {
        ...baseTemplate,
        customMessage: baseTemplate.customMessage || "To‘lov hali qilinmagan",
      };

      try {
        if (dispatchMode === "agent") {
          if (!hasActivePrintAgent(agentChannel)) {
            throw new Error("Lokal print agent ulangan emas");
          }

          const result = await dispatchPrintJob({
            restaurantId: agentChannel,
            job: {
              type: "order-receipt",
              printer: printerPayload,
              template: templateForPrinter,
              order: orderPayload,
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
            template: templateForPrinter,
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
          message: "Buyurtma cheki chop etildi",
        };
      } catch (error) {
        console.error("[ORDER RECEIPT PRINT] Error:", error);

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

export const createOrder = async (req, res) => {
  try {
    const payload = req.body;
    let targetTable = null;

    if (payload.tableId) {
      targetTable = await Table.findById(payload.tableId).select("assignedTo status");

      if (!targetTable) {
        return res.status(404).json({ message: "Stol topilmadi" });
      }

      const assignedId = targetTable.assignedTo ? String(targetTable.assignedTo) : null;
      const requesterId = req.user?._id ? String(req.user._id) : null;

      if (
        req.user?.role === "ofitsiant" &&
        assignedId &&
        assignedId !== requesterId
      ) {
        return res.status(403).json({ message: "Bu stol boshqa ofitsiantga biriktirilgan" });
      }
    }

    const systemSettings = (await Settings.findOne()) || {};
    const taxSettings = systemSettings.taxSettings || {};
    const taxIntegration = systemSettings.taxIntegration || {};
    const taxRate = typeof taxSettings.taxRate === "number" ? taxSettings.taxRate : 0.12;
    const discountValue = payload.discount || 0;
    const incomingItems = Array.isArray(payload.items) ? payload.items : [];
    const menuItemIds = Array.from(
      new Set(
        incomingItems
          .map((item) => (item?.menuItem && Types.ObjectId.isValid(item.menuItem) ? new Types.ObjectId(item.menuItem) : null))
          .filter(Boolean),
      ),
    );

    const menuDocs = menuItemIds.length
      ? await MenuItem.find({ _id: { $in: menuItemIds } })
          .select("_id name price productionPrinterIds productionTags category")
          .lean()
      : [];

    const menuMap = new Map(menuDocs.map((doc) => [doc._id.toString(), doc]));

    const items = incomingItems.map((item) => {
      const menuDoc = item?.menuItem ? menuMap.get(item.menuItem.toString()) : null;
      const qty = Number(item?.qty || 1) || 1;
      const price = Number(item?.price != null ? item.price : menuDoc?.price || 0) || 0;
      const directPrinterIds = Array.isArray(item?.productionPrinterIds) ? item.productionPrinterIds : [];
      const menuPrinterIds = Array.isArray(menuDoc?.productionPrinterIds) ? menuDoc.productionPrinterIds : [];
      const productionPrinterIds = Array.from(new Set([...directPrinterIds, ...menuPrinterIds].map(String).filter(Boolean)));

      return {
        menuItem: item.menuItem,
        name: item.name || menuDoc?.name || "Pozitsiya",
        qty,
        price,
        notes: item.notes || "",
        portionKey: item.portionKey || "standard",
        portionLabel: item.portionLabel || "",
        modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
        isBlocked: Boolean(item.isBlocked),
        productionPrinterIds,
        productionTags: Array.isArray(menuDoc?.productionTags) ? menuDoc.productionTags : [],
      };
    });

    const subtotal = items.reduce((s, it) => s + (it.price || 0) * (it.qty || 1), 0);
    const tax = +(subtotal * taxRate).toFixed(2);
    const total = +(subtotal + tax - discountValue).toFixed(2);
    const initialFiscalStatus = taxIntegration?.enabled ? "pending" : "skipped";

    const order = await Order.create({
      table: payload.tableId,
      tableName: payload.tableName,
      items,
      subtotal,
      tax,
      discount: discountValue,
      total,
      fiscalStatus: initialFiscalStatus,
      createdBy: req.user._id,
      restaurantId: payload.restaurantId || "default",
      isDelivery: payload.isDelivery || false,
      deliveryCourier: payload.deliveryCourier || null,
      customer: payload.customer || null
    });

    // update table status
    if (payload.tableId) {
      const tableUpdate = { status: "occupied" };
      if (req.user?.role === "ofitsiant") {
        const waiterName = (req.user?.name || req.user?.fullName || req.user?.username || "").trim();
        tableUpdate.assignedTo = req.user._id;
        tableUpdate.assignedToName = waiterName;
        tableUpdate.assignedAt = new Date();
      }

      await Table.findByIdAndUpdate(payload.tableId, tableUpdate);
    }

    if (taxIntegration?.enabled && taxIntegration.autoFiscalize !== false) {
      fiscalizeOrder(order, taxIntegration, { ...taxSettings, currency: systemSettings.currency })
        .catch(err => console.error("[TAX] Fiscalization error:", err.message));
    }

    await applyRecipeInventoryUsage(order, req.user);

    try {
      if (systemSettings?.printerSettings?.enabled) {
        const productionPrintReport = await triggerProductionPrints({ order, settings: systemSettings });
        order.set("productionPrintReport", productionPrintReport, { strict: false });
      }
    } catch (error) {
      console.error("[ORDER PRINT] trigger error", error);
    }

    try {
      if (systemSettings?.printerSettings?.enabled) {
        const frontReceiptPrintReport = await triggerFrontReceiptPrint({ order, settings: systemSettings });
        order.set("frontReceiptPrintReport", frontReceiptPrintReport, { strict: false });
      }
    } catch (error) {
      console.error("[ORDER RECEIPT PRINT] trigger error", error);
    }

    // emit to socket (if any)
    if (req.app.get("io")) req.app.get("io").to(order.restaurantId).emit("order:new", order);

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const listOrders = async (req, res) => {
  const filter = {};
  
  // Dostavka va soboy buyurtmalarini filterlash
  if (req.query.deliveryOnly === "true") {
    filter.$or = [{ isDelivery: true }, { type: "soboy" }];
  } else if (req.query.isDelivery !== undefined) {
    filter.isDelivery = req.query.isDelivery === "true";
  }
  
  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .populate("items.menuItem")
    .populate("customer")
    .populate("createdBy", "name role")
    .limit(200);
  res.json(orders);
};

export const getOrder = async (req, res) => {
  const order = await Order.findById(req.params.id).populate("items.menuItem");
  res.json(order);
};

export const updateOrder = async (req, res) => {
  const order = await Order.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (req.app.get("io")) req.app.get("io").to(order.restaurantId).emit("order:updated", order);
  res.json(order);
};

export const deleteOrder = async (req, res) => {
  await Order.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
};