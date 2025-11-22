// src/backend/controllers/inventoryController.js
import mongoose from "mongoose";
import InventoryItem from "../models/InventoryItem.js";
import InventoryMovement from "../models/InventoryMovement.js";
import InventoryStock from "../models/InventoryStock.js";
import Warehouse from "../models/Warehouse.js";
import Supplier from "../models/Supplier.js";
import ActionLog from "../models/ActionLog.js";
import { ensureDefaultWarehouse } from "../utils/warehouse.js";
import {
  toNumber,
  toObjectId,
  resolveWarehouse,
  getOrCreateStock,
  recalcItemTotals,
} from "../utils/inventoryHelpers.js";

const { Types } = mongoose;

const DEFAULT_CATEGORIES = [
  "Go'sht va parranda",
  "Sabzavot va meva",
  "Sut mahsulotlari",
  "Non va konditer",
  "Ichimliklar",
  "Ziravorlar",
  "Quruq mahsulotlar",
  "Yarim tayyor",
  "Qadoqlash materiallari",
  "Tozalash vositalari",
  "Sovutish mahsulotlari",
];

const WAREHOUSE_FIELDS = "name code type isDefault";

const enrichItemsWithStock = async (items) => {
  if (!items?.length) return [];

  const itemIds = items.map((doc) => doc._id);
  const stocks = await InventoryStock.find({ item: { $in: itemIds } })
    .populate("warehouse", WAREHOUSE_FIELDS)
    .lean();

  const stockMap = stocks.reduce((acc, stock) => {
    const key = stock.item.toString();
    if (!acc[key]) acc[key] = [];
    acc[key].push(stock);
    return acc;
  }, {});

  return items.map((item) => {
    const plain = item.toObject ? item.toObject() : item;
    const stocksForItem = stockMap[item._id.toString()] || [];
    const total = stocksForItem.reduce((sum, stock) => sum + (stock.quantity || 0), 0);

    return {
      ...plain,
      currentStock: total,
      stockByWarehouse: stocksForItem.map((stock) => ({
        _id: stock._id,
        warehouse: stock.warehouse,
        quantity: stock.quantity,
        parLevel: stock.parLevel,
        reorderPoint: stock.reorderPoint,
        safetyStock: stock.safetyStock,
        lastCountDate: stock.lastCountDate,
        lastMovementAt: stock.lastMovementAt,
      })),
    };
  });
};

const buildSummary = async () => {
  const totalItems = await InventoryItem.countDocuments({ isActive: true });

  const [stockAggregates] = await InventoryStock.aggregate([
    {
      $lookup: {
        from: "inventoryitems",
        localField: "item",
        foreignField: "_id",
        as: "item",
      },
    },
    { $unwind: "$item" },
    { $match: { "item.isActive": true } },
    {
      $group: {
        _id: null,
        totalStockUnits: { $sum: "$quantity" },
        inventoryValue: {
          $sum: {
            $multiply: ["$quantity", { $ifNull: ["$item.cost", 0] }],
          },
        },
      },
    },
  ]);

  const lowStock = await InventoryItem.countDocuments({
    isActive: true,
    parLevel: { $gt: 0 },
    $expr: { $lte: ["$currentStock", "$parLevel"] },
  });

  return {
    totalItems,
    totalStockUnits: stockAggregates?.totalStockUnits || 0,
    inventoryValue: stockAggregates?.inventoryValue || 0,
    lowStock,
  };
};

export const getInventorySummary = async (req, res) => {
  try {
    const summary = await buildSummary();
    res.json(summary);
  } catch (err) {
    console.error("getInventorySummary error", err);
    res.status(500).json({ message: "Ombor statistik ma'lumotini olishda xatolik" });
  }
};

export const listInventoryItems = async (req, res) => {
  try {
    const { search = "", category, status = "active", warehouseId } = req.query;

    await ensureDefaultWarehouse();

    const query = {};

    if (status === "archived") query.isActive = false;
    else if (status === "all") {
      // barcha holatlar
    } else query.isActive = true;

    if (search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      query.$or = [
        { name: regex },
        { sku: regex },
        { supplier: regex },
      ];
    }

    if (category && category !== "all") {
      query.category = category;
    }

    const items = await InventoryItem.find(query).sort({ name: 1 });
    const enrichedItems = await enrichItemsWithStock(items);

    const categoriesFromDb = await InventoryItem.distinct("category", {
      category: { $nin: [null, ""] },
      isActive: true,
    });

    const summary = await buildSummary();

    const categories = Array.from(
      new Set([
        ...DEFAULT_CATEGORIES,
        ...categoriesFromDb
          .map((value) => value?.toString?.() || "")
          .filter((value) => value.length > 0),
      ])
    ).sort((a, b) => a.localeCompare(b));

    const warehouses = await Warehouse.find({ isActive: true })
      .sort({ isDefault: -1, name: 1 })
      .lean();

    const selectedWarehouseId = Types.ObjectId.isValid(warehouseId) ? warehouseId : null;

    const payloadItems = enrichedItems.map((item) => {
      if (!selectedWarehouseId) return item;
      const stockEntry = item.stockByWarehouse?.find((stock) =>
        stock.warehouse?._id?.toString() === selectedWarehouseId
      );
      return {
        ...item,
        selectedWarehouseStock: stockEntry?.quantity ?? 0,
      };
    });

    res.json({
      items: payloadItems,
      summary,
      categories,
      warehouses,
    });
  } catch (err) {
    console.error("listInventoryItems error", err);
    res.status(500).json({ message: "Ombor ma'lumotlarini olishda xatolik" });
  }
};

export const createInventoryItem = async (req, res) => {
  try {
    const {
      name,
      sku,
      category,
      unit,
      parLevel,
      cost,
      supplier,
      notes,
      currentStock,
      defaultWarehouse,
      trackingMethod,
      consumptionUnit,
      conversionRate,
      storageConditions,
      shelfLifeDays,
      expiryTrackingEnabled,
      lowStockAlertEnabled,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: "Mahsulot nomi talab qilinadi" });
    }

    let assignedWarehouse;
    try {
      assignedWarehouse = await resolveWarehouse(defaultWarehouse);
    } catch (error) {
      return res.status(404).json({ message: error.message });
    }

    const payload = {
      name: name.trim(),
      sku: sku?.trim() || undefined,
      category: category?.trim() || "",
      unit: unit?.trim() || "dona",
      parLevel: Math.max(0, toNumber(parLevel, 0)),
      cost: Math.max(0, toNumber(cost, 0)),
      supplier: supplier?.trim() || "",
      notes: notes?.trim() || "",
      defaultWarehouse: assignedWarehouse?._id || null,
      trackingMethod: trackingMethod || "fifo",
      consumptionUnit: consumptionUnit?.trim() || "",
      conversionRate: Math.max(0, toNumber(conversionRate ?? 1, 1)) || 1,
      storageConditions: storageConditions?.trim() || "",
      shelfLifeDays: shelfLifeDays != null ? Math.max(0, toNumber(shelfLifeDays, null)) : null,
      expiryTrackingEnabled: Boolean(expiryTrackingEnabled),
      lowStockAlertEnabled: lowStockAlertEnabled !== undefined ? Boolean(lowStockAlertEnabled) : true,
    };

    const startingStock = Math.max(0, toNumber(currentStock, 0));
    if (startingStock > 0) {
      payload.currentStock = startingStock;
      payload.lastRestockDate = new Date();
    }

    const item = await InventoryItem.create(payload);

    const stockDoc = await getOrCreateStock(item, assignedWarehouse, {
      parLevel: payload.parLevel,
    });

    if (startingStock > 0) {
      stockDoc.quantity = (stockDoc.quantity || 0) + startingStock;
      stockDoc.lastMovementAt = new Date();
      await stockDoc.save();

      await InventoryMovement.create({
        item: item._id,
        type: "incoming",
        quantity: startingStock,
        delta: startingStock,
        balanceAfter: stockDoc.quantity,
        unit: item.unit,
        warehouse: assignedWarehouse._id,
        reason: "Boshlang'ich balans",
        createdBy: req.user?._id,
        unitCost: item.cost || 0,
        totalCost: startingStock * (item.cost || 0),
      });
    }

    item.currentStock = await recalcItemTotals(item._id);
    if (startingStock > 0) item.lastRestockDate = new Date();
    await item.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "inventory_create",
      details: `Yangi ombor elementi: ${item.name} (${assignedWarehouse.name})`,
      metadata: { itemId: item._id, warehouseId: assignedWarehouse._id },
    });

    const [responseItem] = await enrichItemsWithStock([item]);
    res.status(201).json(responseItem || item);
  } catch (err) {
    console.error("createInventoryItem error", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Bu SKU allaqachon mavjud" });
    }
    res.status(500).json({ message: "Mahsulot yaratishda xatolik" });
  }
};

export const updateInventoryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await InventoryItem.findById(id);
    if (!item) return res.status(404).json({ message: "Mahsulot topilmadi" });

    const {
      name,
      sku,
      category,
      unit,
      parLevel,
      cost,
      supplier,
      notes,
      isActive,
      defaultWarehouse,
      trackingMethod,
      consumptionUnit,
      conversionRate,
      storageConditions,
      shelfLifeDays,
      expiryTrackingEnabled,
      lowStockAlertEnabled,
      tags,
      allergens,
    } = req.body;

    if (name !== undefined) item.name = name.trim();
    if (sku !== undefined) item.sku = sku?.trim() || undefined;
    if (category !== undefined) item.category = category?.trim() || "";
    if (unit !== undefined) item.unit = unit?.trim() || "dona";
    if (parLevel !== undefined) item.parLevel = Math.max(0, toNumber(parLevel, 0));
    if (cost !== undefined) item.cost = Math.max(0, toNumber(cost, 0));
    if (supplier !== undefined) item.supplier = supplier?.trim() || "";
    if (notes !== undefined) item.notes = notes?.trim() || "";
    if (trackingMethod !== undefined) item.trackingMethod = trackingMethod;
    if (consumptionUnit !== undefined) item.consumptionUnit = consumptionUnit?.trim() || "";
    if (conversionRate !== undefined) item.conversionRate = Math.max(0, toNumber(conversionRate, 1)) || 1;
    if (storageConditions !== undefined) item.storageConditions = storageConditions?.trim() || "";
    if (shelfLifeDays !== undefined) {
      item.shelfLifeDays = shelfLifeDays != null ? Math.max(0, toNumber(shelfLifeDays, null)) : null;
    }
    if (expiryTrackingEnabled !== undefined) item.expiryTrackingEnabled = Boolean(expiryTrackingEnabled);
    if (lowStockAlertEnabled !== undefined) item.lowStockAlertEnabled = Boolean(lowStockAlertEnabled);
    if (Array.isArray(tags)) item.tags = tags;
    if (Array.isArray(allergens)) item.allergens = allergens;

    if (defaultWarehouse !== undefined) {
      if (defaultWarehouse === null || defaultWarehouse === "") {
        item.defaultWarehouse = null;
      } else if (Types.ObjectId.isValid(defaultWarehouse)) {
        const warehouse = await Warehouse.findById(defaultWarehouse);
        if (!warehouse || !warehouse.isActive) {
          return res.status(404).json({ message: "Tanlangan ombor topilmadi" });
        }
        item.defaultWarehouse = warehouse._id;
      } else {
        return res.status(400).json({ message: "Noto'g'ri ombor ID" });
      }
    }

    if (isActive !== undefined) {
      item.isActive = Boolean(isActive);
      item.archivedAt = item.isActive ? null : new Date();
    }

    await item.save();

    if (parLevel !== undefined) {
      await InventoryStock.updateMany(
        { item: item._id },
        {
          $set: {
            parLevel: item.parLevel,
            reorderPoint: item.parLevel,
          },
        }
      );
    }

    if (unit !== undefined) {
      await InventoryStock.updateMany(
        { item: item._id },
        {
          $set: {
            unit: item.unit,
          },
        }
      );
    }

    item.currentStock = await recalcItemTotals(item._id);
    await item.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "inventory_update",
      details: `Ombor elementi yangilandi: ${item.name}`,
      metadata: { itemId: item._id },
    });

    const [responseItem] = await enrichItemsWithStock([item]);
    res.json(responseItem || item);
  } catch (err) {
    console.error("updateInventoryItem error", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Bu SKU allaqachon mavjud" });
    }
    res.status(500).json({ message: "Mahsulotni yangilashda xatolik" });
  }
};

export const archiveInventoryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await InventoryItem.findById(id);
    if (!item) return res.status(404).json({ message: "Mahsulot topilmadi" });

    const [stockAgg] = await InventoryStock.aggregate([
      { $match: { item: item._id } },
      { $group: { _id: "$item", total: { $sum: "$quantity" } } },
    ]);

    const totalStock = stockAgg?.total || 0;
    if (totalStock > 0) {
      return res.status(400).json({ message: "Mahsulotni arxivlashdan oldin qoldiqni nolga tushiring" });
    }

    item.isActive = false;
    item.archivedAt = new Date();
    item.currentStock = 0;
    await item.save();

    await InventoryStock.updateMany({ item: item._id }, { $set: { quantity: 0, lastMovementAt: new Date() } });

    await ActionLog.create({
      user: req.user?._id,
      action: "inventory_archive",
      details: `Ombor elementi arxivlandi: ${item.name}`,
      metadata: { itemId: item._id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("archiveInventoryItem error", err);
    res.status(500).json({ message: "Mahsulotni arxivlashda xatolik" });
  }
};

export const adjustInventory = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      quantity,
      type = "adjustment",
      reason = "",
      reference = "",
      warehouseId,
      supplierId,
    } = req.body;

    let delta = toNumber(quantity, null);
    if (delta === null || delta === 0) {
      return res.status(400).json({ message: "O'zgarish miqdorini to'g'ri kiriting" });
    }

    const allowedTypes = ["incoming", "usage", "adjustment", "waste", "return"];
    const movementType = allowedTypes.includes(type) ? type : "adjustment";

    if (movementType === "incoming" && delta < 0) delta = Math.abs(delta);
    if ((movementType === "usage" || movementType === "waste" || movementType === "return") && delta > 0) {
      delta = -Math.abs(delta);
    }

    const item = await InventoryItem.findById(id);
    if (!item) return res.status(404).json({ message: "Mahsulot topilmadi" });

    let warehouse;
    try {
      warehouse = await resolveWarehouse(warehouseId || item.defaultWarehouse);
    } catch (error) {
      return res.status(404).json({ message: error.message });
    }

    const stockDoc = await getOrCreateStock(item, warehouse, { parLevel: item.parLevel });

    const newWarehouseStock = stockDoc.quantity + delta;
    if (newWarehouseStock < 0) {
      return res.status(400).json({ message: "Tanlangan omborda yetarli mahsulot yo'q" });
    }

    stockDoc.quantity = newWarehouseStock;
    stockDoc.lastMovementAt = new Date();
    await stockDoc.save();

    const totalQuantity = await recalcItemTotals(item._id);
    item.currentStock = totalQuantity;
    if (delta > 0) item.lastRestockDate = new Date();
    await item.save();

    let supplier = null;
    if (supplierId && Types.ObjectId.isValid(supplierId)) {
      supplier = await Supplier.findById(supplierId);
      if (!supplier || !supplier.isActive) {
        return res.status(404).json({ message: "Tanlangan yetkazib beruvchi topilmadi" });
      }
    }

    const movementPayload = {
      item: item._id,
      type: movementType,
      quantity: Math.abs(delta),
      delta,
      balanceAfter: newWarehouseStock,
      unit: item.unit,
      warehouse: warehouse._id,
      reason: reason?.trim() || "",
      reference: reference?.trim() || "",
      createdBy: req.user?._id,
      unitCost: item.cost || 0,
      totalCost: Math.abs(delta) * (item.cost || 0),
    };

    if (supplier) {
      movementPayload.supplier = supplier._id;
    }

    const movement = await InventoryMovement.create(movementPayload);

    await ActionLog.create({
      user: req.user?._id,
      action: "inventory_adjust",
      details: `${item.name} (${warehouse.name}) uchun ${delta > 0 ? "+" : ""}${delta} birlik o'zgarish (${movementType})`,
      metadata: {
        itemId: item._id,
        warehouseId: warehouse._id,
        delta,
        supplierId: supplier?._id,
      },
    });

    const [responseItem] = await enrichItemsWithStock([item]);

    res.json({
      item: responseItem || item,
      movement,
      stock: {
        warehouse: warehouse._id,
        quantity: newWarehouseStock,
      },
    });
  } catch (err) {
    console.error("adjustInventory error", err);
    res.status(500).json({ message: "Ombor qoldig'ini o'zgartirishda xatolik" });
  }
};

export const transferInventory = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      quantity,
      sourceWarehouseId,
      targetWarehouseId,
      reason = "",
      reference = "",
    } = req.body;

    const transferQty = Math.abs(toNumber(quantity, null));
    if (!transferQty || transferQty <= 0) {
      return res.status(400).json({ message: "Ko'chirish miqdorini to'g'ri kiriting" });
    }

    if (!targetWarehouseId) {
      return res.status(400).json({ message: "Qabul qiluvchi omborni tanlang" });
    }

    const item = await InventoryItem.findById(id);
    if (!item) return res.status(404).json({ message: "Mahsulot topilmadi" });

    let sourceWarehouse;
    let targetWarehouse;
    try {
      sourceWarehouse = await resolveWarehouse(sourceWarehouseId || item.defaultWarehouse);
      targetWarehouse = await resolveWarehouse(targetWarehouseId);
    } catch (error) {
      return res.status(404).json({ message: error.message });
    }

    if (!sourceWarehouse || !targetWarehouse) {
      return res.status(400).json({ message: "Omborlarni to'g'ri tanlang" });
    }

    if (sourceWarehouse._id.equals(targetWarehouse._id)) {
      return res.status(400).json({ message: "Bir xil omborlar o'rtasida ko'chirish mumkin emas" });
    }

    const [sourceStock, targetStock] = await Promise.all([
      getOrCreateStock(item, sourceWarehouse, { parLevel: item.parLevel }),
      getOrCreateStock(item, targetWarehouse, { parLevel: item.parLevel }),
    ]);

    if (sourceStock.quantity < transferQty) {
      return res.status(400).json({ message: "Jo'natuvchi omborda yetarli mahsulot yo'q" });
    }

    const now = new Date();

    sourceStock.quantity -= transferQty;
    sourceStock.lastMovementAt = now;

    targetStock.quantity += transferQty;
    targetStock.lastMovementAt = now;

    await Promise.all([sourceStock.save(), targetStock.save()]);

    item.currentStock = await recalcItemTotals(item._id);
    await item.save();

    const [transferOut, transferIn] = await InventoryMovement.insertMany([
      {
        item: item._id,
        type: "transfer_out",
        quantity: transferQty,
        delta: -transferQty,
        balanceAfter: sourceStock.quantity,
        unit: item.unit,
        warehouse: sourceWarehouse._id,
        sourceWarehouse: sourceWarehouse._id,
        targetWarehouse: targetWarehouse._id,
        reason: reason?.trim() || "",
        reference: reference?.trim() || "",
        createdBy: req.user?._id,
        unitCost: item.cost || 0,
        totalCost: transferQty * (item.cost || 0),
        createdAt: now,
        updatedAt: now,
      },
      {
        item: item._id,
        type: "transfer_in",
        quantity: transferQty,
        delta: transferQty,
        balanceAfter: targetStock.quantity,
        unit: item.unit,
        warehouse: targetWarehouse._id,
        sourceWarehouse: sourceWarehouse._id,
        targetWarehouse: targetWarehouse._id,
        reason: reason?.trim() || "",
        reference: reference?.trim() || "",
        createdBy: req.user?._id,
        unitCost: item.cost || 0,
        totalCost: transferQty * (item.cost || 0),
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await ActionLog.create({
      user: req.user?._id,
      action: "inventory_transfer",
      details: `${item.name} ${sourceWarehouse.name} -> ${targetWarehouse.name} (${transferQty} ${item.unit})`,
      metadata: {
        itemId: item._id,
        sourceWarehouseId: sourceWarehouse._id,
        targetWarehouseId: targetWarehouse._id,
        quantity: transferQty,
      },
    });

    const [responseItem] = await enrichItemsWithStock([item]);

    res.json({
      item: responseItem || item,
      transfer: {
        quantity: transferQty,
        source: {
          warehouseId: sourceWarehouse._id,
          balanceAfter: sourceStock.quantity,
        },
        target: {
          warehouseId: targetWarehouse._id,
          balanceAfter: targetStock.quantity,
        },
      },
      movements: { out: transferOut, in: transferIn },
    });
  } catch (err) {
    console.error("transferInventory error", err);
    res.status(500).json({ message: "Omborlar orasida ko'chirishda xatolik" });
  }
};

export const listWarehouseStock = async (req, res) => {
  try {
    const { id } = req.params;

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri ombor ID" });
    }

    await ensureDefaultWarehouse();

    const warehouse = await Warehouse.findById(id).lean();
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ message: "Ombor topilmadi yoki faol emas" });
    }

    const warehouseObjectId = new Types.ObjectId(id);

    const stocks = await InventoryStock.aggregate([
      { $match: { warehouse: warehouseObjectId } },
      {
        $lookup: {
          from: "inventoryitems",
          localField: "item",
          foreignField: "_id",
          as: "item",
        },
      },
      { $unwind: "$item" },
      { $match: { "item.isActive": true } },
      {
        $project: {
          _id: 1,
          itemId: "$item._id",
          itemName: "$item.name",
          sku: "$item.sku",
          category: "$item.category",
          unit: "$item.unit",
          quantity: { $ifNull: ["$quantity", 0] },
          parLevel: {
            $ifNull: ["$parLevel", { $ifNull: ["$item.parLevel", 0] }],
          },
          reorderPoint: {
            $ifNull: ["$reorderPoint", { $ifNull: ["$item.parLevel", 0] }],
          },
          safetyStock: { $ifNull: ["$safetyStock", 0] },
          lastCountDate: 1,
          lastMovementAt: 1,
          cost: { $ifNull: ["$item.cost", 0] },
          supplier: { $ifNull: ["$item.supplier", ""] },
        },
      },
      { $sort: { itemName: 1 } },
    ]);

    const summary = stocks.reduce(
      (acc, stock) => {
        const value = (stock.quantity || 0) * (stock.cost || 0);
        acc.totalItems += 1;
        acc.totalQuantity += stock.quantity || 0;
        acc.inventoryValue += value;
        if (stock.parLevel > 0 && stock.quantity <= stock.parLevel) {
          acc.lowStock += 1;
        }
        return acc;
      },
      { totalItems: 0, totalQuantity: 0, inventoryValue: 0, lowStock: 0 }
    );

    const items = stocks.map((stock) => ({
      stockId: stock._id,
      itemId: stock.itemId,
      name: stock.itemName,
      sku: stock.sku,
      category: stock.category,
      unit: stock.unit,
      quantity: stock.quantity,
      parLevel: stock.parLevel,
      reorderPoint: stock.reorderPoint,
      safetyStock: stock.safetyStock,
      lowStock: stock.parLevel > 0 && stock.quantity <= stock.parLevel,
      lastCountDate: stock.lastCountDate,
      lastMovementAt: stock.lastMovementAt,
      cost: stock.cost,
      supplier: stock.supplier,
      inventoryValue: (stock.quantity || 0) * (stock.cost || 0),
    }));

    res.json({
      warehouse: {
        _id: warehouse._id,
        name: warehouse.name,
        code: warehouse.code,
        type: warehouse.type,
        isDefault: warehouse.isDefault,
      },
      summary,
      items,
    });
  } catch (err) {
    console.error("listWarehouseStock error", err);
    res.status(500).json({ message: "Ombordagi mahsulotlarni olishda xatolik" });
  }
};

export const exportWarehouseStock = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri ombor ID" });
    }

    const warehouse = await Warehouse.findById(id).lean();
    if (!warehouse) {
      return res.status(404).json({ message: "Ombor topilmadi" });
    }

    const stockData = await InventoryStock.aggregate([
      { $match: { warehouse: warehouse._id } },
      {
        $lookup: {
          from: "inventoryitems",
          localField: "item",
          foreignField: "_id",
          as: "item",
        },
      },
      { $unwind: "$item" },
      {
        $project: {
          name: "$item.name",
          sku: "$item.sku",
          unit: "$item.unit",
          quantity: "$quantity",
          parLevel: {
            $ifNull: ["$parLevel", { $ifNull: ["$item.parLevel", 0] }],
          },
        },
      },
      { $sort: { name: 1 } },
    ]);

    const header = ["Mahsulot nomi", "SKU", "Miqdor", "O'lchov", "Par Level"];
    const rows = stockData.map((row) => [
      row.name || "",
      row.sku || "",
      row.quantity ?? 0,
      row.unit || "",
      row.parLevel ?? 0,
    ]);

    const csvLines = [header.join(",")];
    rows.forEach((columns) => {
      csvLines.push(columns.map((value) => {
        if (typeof value === "string" && value.includes(",")) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value ?? "";
      }).join(","));
    });

    const csv = csvLines.join("\n");
    const filename = `${warehouse.code || "warehouse"}-stock-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

    res.json({ filename, csv });
  } catch (err) {
    console.error("exportWarehouseStock error", err);
    res.status(500).json({ message: "Ombor ma'lumotlarini eksport qilishda xatolik" });
  }
};

export const importWarehouseStock = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri ombor ID" });
    }

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({ message: "Ombor topilmadi" });
    }

    const { rows = [], csv } = req.body || {};
    let parsedRows = rows;

    if ((!parsedRows || !parsedRows.length) && typeof csv === "string") {
      const [headerLine, ...restLines] = csv.split(/\r?\n/).filter(Boolean);
      if (!headerLine) {
        return res.status(400).json({ message: "CSV fayl bo'sh" });
      }
      const headers = headerLine.split(",").map((value) => value.trim().toLowerCase());
      parsedRows = restLines.map((line) => {
        const columns = line.split(",");
        const record = {};
        headers.forEach((header, index) => {
          record[header] = columns[index];
        });
        return record;
      });
    }

    if (!parsedRows || !parsedRows.length) {
      return res.status(400).json({ message: "Import uchun qatorlar topilmadi" });
    }

    const toProcess = [];

    for (const row of parsedRows) {
      const itemId = row.itemId || row.item_id;
      const sku = row.sku || row.SKU;
      const quantityValue = row.quantity ?? row.miqdor ?? row.qty;
      const qty = Math.max(0, toNumber(quantityValue, null));
      if (!qty && qty !== 0) continue;

      let inventoryItem = null;
      if (itemId && Types.ObjectId.isValid(itemId)) {
        inventoryItem = await InventoryItem.findById(itemId);
      } else if (sku) {
        inventoryItem = await InventoryItem.findOne({ sku: sku?.toString?.().trim().toUpperCase() });
      }

      if (!inventoryItem) continue;
      toProcess.push({ inventoryItem, quantity: qty });
    }

    if (!toProcess.length) {
      return res.status(400).json({ message: "Import uchun mos mahsulot topilmadi" });
    }

    const now = new Date();
    const results = [];

    for (const entry of toProcess) {
      const stockDoc = await getOrCreateStock(entry.inventoryItem, warehouse, {
        parLevel: entry.inventoryItem.parLevel,
      });
      const delta = entry.quantity - (stockDoc.quantity || 0);
      stockDoc.quantity = entry.quantity;
      stockDoc.lastCountDate = now;
      stockDoc.lastMovementAt = now;
      await stockDoc.save();

      entry.inventoryItem.currentStock = await recalcItemTotals(entry.inventoryItem._id);
      await entry.inventoryItem.save();

      if (delta !== 0) {
        await InventoryMovement.create({
          item: entry.inventoryItem._id,
          type: "count_adjustment",
          quantity: Math.abs(delta),
          delta,
          balanceAfter: entry.quantity,
          unit: entry.inventoryItem.unit,
          warehouse: warehouse._id,
          reason: "Excel import asosida inventarizatsiya",
          metadata: {
            import: true,
            source: "excel",
          },
          createdBy: req.user?._id,
          unitCost: entry.inventoryItem.cost || 0,
          totalCost: Math.abs(delta) * (entry.inventoryItem.cost || 0),
        });
      }

      results.push({
        itemId: entry.inventoryItem._id,
        name: entry.inventoryItem.name,
        newQuantity: entry.quantity,
        delta,
      });
    }

    res.json({
      warehouse: {
        _id: warehouse._id,
        name: warehouse.name,
      },
      updated: results.length,
      results,
    });
  } catch (err) {
    console.error("importWarehouseStock error", err);
    res.status(500).json({ message: "Ombor ma'lumotlarini import qilishda xatolik" });
  }
};
export const performCycleCount = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      warehouseId,
      countQuantity,
      countedQuantity,
      quantity,
      reason = "",
      reference = "",
    } = req.body;

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri mahsulot ID" });
    }

    if (!warehouseId || !Types.ObjectId.isValid(warehouseId)) {
      return res.status(400).json({ message: "Inventarizatsiya uchun omborni tanlang" });
    }

    const requestedQuantity =
      toNumber(countQuantity, null) ?? toNumber(countedQuantity, null) ?? toNumber(quantity, null);

    if (requestedQuantity === null || requestedQuantity < 0) {
      return res.status(400).json({ message: "Sanog' miqdorini to'g'ri kiriting" });
    }

    const item = await InventoryItem.findById(id);
    if (!item) return res.status(404).json({ message: "Mahsulot topilmadi" });

    let warehouse;
    try {
      warehouse = await resolveWarehouse(warehouseId);
    } catch (error) {
      return res.status(404).json({ message: error.message });
    }

    const stockDoc = await getOrCreateStock(item, warehouse, { parLevel: item.parLevel });

    const delta = requestedQuantity - (stockDoc.quantity || 0);
    const now = new Date();

    stockDoc.quantity = requestedQuantity;
    stockDoc.lastCountDate = now;
    stockDoc.lastMovementAt = now;
    await stockDoc.save();

    item.currentStock = await recalcItemTotals(item._id);
    await item.save();

    let movement = null;
    if (delta !== 0) {
      movement = await InventoryMovement.create({
        item: item._id,
        type: "count_adjustment",
        quantity: Math.abs(delta),
        delta,
        balanceAfter: requestedQuantity,
        unit: item.unit,
        warehouse: warehouse._id,
        reason: reason?.trim() || "Inventarizatsiya sanog'i",
        reference: reference?.trim() || "",
        createdBy: req.user?._id,
        unitCost: item.cost || 0,
        totalCost: Math.abs(delta) * (item.cost || 0),
      });
    }

    await ActionLog.create({
      user: req.user?._id,
      action: "inventory_cycle_count",
      details: `${item.name} (${warehouse.name}) inventarizatsiya sanog'i: ${requestedQuantity} ${item.unit}`,
      metadata: {
        itemId: item._id,
        warehouseId: warehouse._id,
        countedQuantity: requestedQuantity,
        delta,
      },
    });

    const [responseItem] = await enrichItemsWithStock([item]);

    res.json({
      item: responseItem || item,
      stock: {
        warehouseId: warehouse._id,
        quantity: requestedQuantity,
        lastCountDate: stockDoc.lastCountDate,
      },
      delta,
      movement,
    });
  } catch (err) {
    console.error("performCycleCount error", err);
    res.status(500).json({ message: "Inventarizatsiya sanog'ini yozishda xatolik" });
  }
};

const buildMovementFilters = ({
  warehouseId,
  type,
  createdBy,
  supplierId,
  dateFrom,
  dateTo,
}) => {
  const filter = {};

  if (warehouseId && Types.ObjectId.isValid(warehouseId)) {
    filter.warehouse = warehouseId;
  }

  if (type && typeof type === "string") {
    filter.type = type;
  }

  if (createdBy && Types.ObjectId.isValid(createdBy)) {
    filter.createdBy = createdBy;
  }

  if (supplierId && Types.ObjectId.isValid(supplierId)) {
    filter.supplier = supplierId;
  }

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }

  return filter;
};

export const listMovementsForItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 30, page = 1, warehouseId, type, createdBy, dateFrom, dateTo, supplierId } = req.query;
    const numericLimit = Math.min(100, Math.max(1, Number(limit)));
    const skip = (Math.max(1, Number(page)) - 1) * numericLimit;

    const filter = buildMovementFilters({ warehouseId, type, createdBy, supplierId, dateFrom, dateTo });
    filter.item = id;

    const movements = await InventoryMovement.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(numericLimit)
      .populate({ path: "createdBy", select: "name role" })
      .populate({ path: "warehouse", select: WAREHOUSE_FIELDS })
      .populate({ path: "supplier", select: "name companyName" })
      .lean();

    res.json({ movements });
  } catch (err) {
    console.error("listMovementsForItem error", err);
    res.status(500).json({ message: "Harakatlar tarixini olishda xatolik" });
  }
};

export const listMovements = async (req, res) => {
  try {
    const { limit = 50, page = 1, warehouseId, type, createdBy, supplierId, dateFrom, dateTo, itemId } =
      req.query;
    const numericLimit = Math.min(200, Math.max(1, Number(limit)));
    const skip = (Math.max(1, Number(page)) - 1) * numericLimit;

    const filter = buildMovementFilters({ warehouseId, type, createdBy, supplierId, dateFrom, dateTo });
    if (itemId && Types.ObjectId.isValid(itemId)) {
      filter.item = itemId;
    }

    const movements = await InventoryMovement.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(numericLimit)
      .populate({ path: "item", select: "name unit" })
      .populate({ path: "createdBy", select: "name role" })
      .populate({ path: "warehouse", select: WAREHOUSE_FIELDS })
      .populate({ path: "supplier", select: "name companyName" })
      .lean();

    const total = await InventoryMovement.countDocuments(filter);

    res.json({
      movements,
      pagination: {
        total,
        page: Number(page) || 1,
        pages: Math.ceil(total / numericLimit),
      },
    });
  } catch (err) {
    console.error("listMovements error", err);
    res.status(500).json({ message: "Harakatlar tarixini olishda xatolik" });
  }
};
