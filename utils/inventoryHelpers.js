// src/backend/utils/inventoryHelpers.js
import mongoose from "mongoose";
import InventoryStock from "../models/InventoryStock.js";
import Warehouse from "../models/Warehouse.js";
import { ensureDefaultWarehouse } from "./warehouse.js";

const { Types } = mongoose;

export const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
};

export const toObjectId = (value) => (Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null);

export const resolveWarehouse = async (warehouseId) => {
  if (warehouseId && Types.ObjectId.isValid(warehouseId)) {
    const warehouse = await Warehouse.findById(warehouseId);
    if (!warehouse || !warehouse.isActive) {
      throw new Error("Tanlangan ombor faol emas yoki topilmadi");
    }
    return warehouse;
  }
  return ensureDefaultWarehouse();
};

export const getOrCreateStock = async (item, warehouse, { parLevel } = {}) => {
  const normalizedPar = parLevel ?? item.parLevel ?? 0;
  const stock = await InventoryStock.findOneAndUpdate(
    { item: item._id, warehouse: warehouse._id },
    {
      $setOnInsert: {
        quantity: 0,
        unit: item.unit || "dona",
        parLevel: normalizedPar,
        reorderPoint: normalizedPar,
        safetyStock: Math.max(0, Math.floor(normalizedPar / 2)),
      },
    },
    { new: true, upsert: true }
  );

  return stock;
};

export const recalcItemTotals = async (itemId) => {
  const objectId = toObjectId(itemId);
  if (!objectId) return 0;

  const [aggregated] = await InventoryStock.aggregate([
    { $match: { item: objectId } },
    { $group: { _id: "$item", total: { $sum: "$quantity" } } },
  ]);

  return aggregated?.total || 0;
};
