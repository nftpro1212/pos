// src/backend/controllers/warehouseController.js
import mongoose from "mongoose";
import Warehouse from "../models/Warehouse.js";
import InventoryStock from "../models/InventoryStock.js";
import ActionLog from "../models/ActionLog.js";
import { ensureDefaultWarehouse, setDefaultWarehouseById } from "../utils/warehouse.js";

const WAREHOUSE_TYPES = ["main", "kitchen", "bar", "delivery", "storage", "custom"];

const sanitizeWarehousePayload = (payload = {}) => {
  const cleaned = {};
  if (payload.name !== undefined) cleaned.name = payload.name?.toString?.().trim();
  if (payload.code !== undefined) {
    const code = payload.code?.toString?.().trim().toUpperCase();
    cleaned.code = code || undefined;
  }
  if (payload.type && WAREHOUSE_TYPES.includes(payload.type)) {
    cleaned.type = payload.type;
  }
  if (payload.description !== undefined) {
    cleaned.description = payload.description?.toString?.().trim() || "";
  }

  const location = payload.location || {};
  cleaned.location = {
    address: location.address?.toString?.().trim() || "",
    city: location.city?.toString?.().trim() || "",
    state: location.state?.toString?.().trim() || "",
    country: location.country?.toString?.().trim() || "",
    postalCode: location.postalCode?.toString?.().trim() || "",
  };

  const contact = payload.contact || {};
  cleaned.contact = {
    name: contact.name?.toString?.().trim() || "",
    phone: contact.phone?.toString?.().trim() || "",
    email: contact.email?.toString?.().trim() || "",
  };

  if (payload.parentWarehouse) {
    if (mongoose.Types.ObjectId.isValid(payload.parentWarehouse)) {
      cleaned.parentWarehouse = payload.parentWarehouse;
    }
  } else if (payload.parentWarehouse === null) {
    cleaned.parentWarehouse = null;
  }

  if (payload.metadata !== undefined) {
    cleaned.metadata = payload.metadata;
  }

  if (payload.isActive !== undefined) {
    cleaned.isActive = Boolean(payload.isActive);
  }

  return cleaned;
};

export const listWarehouses = async (req, res) => {
  try {
    await ensureDefaultWarehouse();
    const { status = "active" } = req.query;
    const query = {};

    if (status === "inactive") query.isActive = false;
    else if (status === "all") {
      // no filter
    } else query.isActive = true;

    const warehouses = await Warehouse.find(query)
      .sort({ isDefault: -1, name: 1 })
      .lean();

    res.json({ warehouses });
  } catch (err) {
    console.error("[WAREHOUSE] list error", err);
    res.status(500).json({ message: "Omborlar ro'yxatini olishda xatolik" });
  }
};

export const createWarehouse = async (req, res) => {
  try {
    const shouldSetDefault = Boolean(req.body?.isDefault);
    const payload = sanitizeWarehousePayload(req.body);
    payload.isDefault = false; // default flag handled separately

    const warehouse = await Warehouse.create(payload);

    let responseDoc = warehouse;
    if (shouldSetDefault) {
      responseDoc = await setDefaultWarehouseById(warehouse._id);
    } else {
      await ensureDefaultWarehouse();
      responseDoc = await Warehouse.findById(warehouse._id);
    }

    await ActionLog.create({
      user: req.user?._id,
      action: "warehouse_create",
      details: `Yangi ombor yaratildi: ${responseDoc.name}`,
      metadata: { warehouseId: responseDoc._id },
    });

    res.status(201).json(responseDoc);
  } catch (err) {
    console.error("[WAREHOUSE] create error", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Ombor kodi yoki nomi allaqachon mavjud" });
    }
    res.status(500).json({ message: "Ombor yaratishda xatolik" });
  }
};

export const updateWarehouse = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri ombor ID" });
    }

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({ message: "Ombor topilmadi" });
    }

    const shouldSetDefault = Boolean(req.body?.isDefault);
    const payload = sanitizeWarehousePayload(req.body);

    Object.assign(warehouse, payload);
    await warehouse.save();

    let responseDoc = warehouse;
    if (shouldSetDefault) {
      responseDoc = await setDefaultWarehouseById(warehouse._id);
    } else if (!warehouse.isDefault) {
      await ensureDefaultWarehouse();
    }

    await ActionLog.create({
      user: req.user?._id,
      action: "warehouse_update",
      details: `Ombor yangilandi: ${responseDoc.name}`,
      metadata: { warehouseId: responseDoc._id },
    });

    res.json(responseDoc);
  } catch (err) {
    console.error("[WAREHOUSE] update error", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Ombor kodi yoki nomi allaqachon mavjud" });
    }
    res.status(500).json({ message: "Omborni yangilashda xatolik" });
  }
};

export const setDefaultWarehouse = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri ombor ID" });
    }

    const updated = await setDefaultWarehouseById(id);

    await ActionLog.create({
      user: req.user?._id,
      action: "warehouse_set_default",
      details: `Asosiy ombor o'zgartirildi: ${updated.name}`,
      metadata: { warehouseId: updated._id },
    });

    res.json(updated);
  } catch (err) {
    console.error("[WAREHOUSE] set default error", err);
    res.status(500).json({ message: err.message || "Asosiy omborni belgilashda xatolik" });
  }
};

export const archiveWarehouse = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri ombor ID" });
    }

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({ message: "Ombor topilmadi" });
    }

    if (warehouse.isDefault) {
      return res.status(400).json({ message: "Asosiy omborni o'chirib bo'lmaydi" });
    }

    const stockExists = await InventoryStock.aggregate([
      { $match: { warehouse: warehouse._id } },
      { $group: { _id: "$warehouse", total: { $sum: "$quantity" } } },
    ]);

    const totalQuantity = stockExists[0]?.total || 0;
    if (totalQuantity > 0) {
      return res.status(400).json({ message: "Omborda qolgan mahsulotlar mavjud. Avval ko'chiring yoki sarflang" });
    }

    warehouse.isActive = false;
    await warehouse.save();

    await InventoryStock.deleteMany({ warehouse: warehouse._id });

    await ActionLog.create({
      user: req.user?._id,
      action: "warehouse_archive",
      details: `Ombor arxivlandi: ${warehouse.name}`,
      metadata: { warehouseId: warehouse._id },
    });

    await ensureDefaultWarehouse();

    res.json({ success: true });
  } catch (err) {
    console.error("[WAREHOUSE] archive error", err);
    res.status(500).json({ message: "Omborni arxivlashda xatolik" });
  }
};
