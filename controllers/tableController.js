// src/backend/controllers/tableController.js
import Table from "../models/Table.js";
import { resolveRestaurantId } from "../utils/tenant.js";

const normalizeCategory = (category = "") => {
  if (typeof category !== "string") return "zal";
  const trimmed = category.trim();
  return trimmed ? trimmed.toLowerCase() : "zal";
};

export const listTables = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, { allowQuery: true });
    if (!restaurantId) {
      return res.status(400).json({ message: "Restoran aniqlanmadi" });
    }

    const tables = await Table.find({ restaurant: restaurantId })
      .sort({ name: 1 })
      .populate("assignedTo", "name role");
    res.json(tables);
  } catch (error) {
    res.status(500).json({ message: error.message || "Stollarni olishda xatolik" });
  }
};

export const createTable = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, { allowBody: true, allowQuery: true });
    if (!restaurantId) {
      return res.status(400).json({ message: "Restoran aniqlanmadi" });
    }

    const { name, category } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Stol nomi talab qilinadi" });
    }

    const payload = {
      name: name.trim(),
      category: normalizeCategory(category),
      restaurant: restaurantId,
    };

    const table = await Table.create(payload);
    res.json(table);
  } catch (error) {
    res.status(500).json({ message: error.message || "Stol yaratib bo'lmadi" });
  }
};

export const updateTable = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, { allowBody: true, allowQuery: true });
    if (!restaurantId) {
      return res.status(400).json({ message: "Restoran aniqlanmadi" });
    }

    const updates = { ...req.body };

    if (updates.name) {
      updates.name = updates.name.trim();
    }

    if (Object.prototype.hasOwnProperty.call(updates, "category")) {
      updates.category = normalizeCategory(updates.category);
    }

    if (updates.status === "free") {
      updates.assignedTo = null;
      updates.assignedToName = "";
      updates.assignedAt = null;
    }

    delete updates.restaurant;
    delete updates.tenantId;

    const table = await Table.findOneAndUpdate(
      { _id: req.params.id, restaurant: restaurantId },
      updates,
      { new: true }
    )
      .populate("assignedTo", "name role");

    if (!table) {
      return res.status(404).json({ message: "Stol topilmadi" });
    }

    res.json(table);
  } catch (error) {
    res.status(500).json({ message: error.message || "Stolni yangilab bo'lmadi" });
  }
};

export const deleteTable = async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req, { allowQuery: true, allowBody: true });
    if (!restaurantId) {
      return res.status(400).json({ message: "Restoran aniqlanmadi" });
    }

    const deleted = await Table.findOneAndDelete({ _id: req.params.id, restaurant: restaurantId });
    if (!deleted) {
      return res.status(404).json({ message: "Stol topilmadi" });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message || "Stolni o'chirib bo'lmadi" });
  }
};