// src/backend/controllers/menuController.js
import MenuItem from "../models/MenuItem.js";

export const listMenu = async (req, res) => {
  const q = req.query.q || "";
  const items = await MenuItem.find({ name: { $regex: q, $options: "i" } }).sort({ createdAt: -1 });
  res.json(items);
};

export const createMenu = async (req, res) => {
  const {
    name,
    description,
    price,
    category,
    imageUrl,
    productionPrinterIds = [],
    productionTags = [],
  } = req.body;
  const printerIds = Array.isArray(productionPrinterIds)
    ? productionPrinterIds.map(String).filter(Boolean)
    : [];
  const tags = Array.isArray(productionTags)
    ? productionTags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean)
    : [];
  const item = await MenuItem.create({
    name,
    description,
    price,
    category,
    imageUrl,
    productionPrinterIds: printerIds,
    productionTags: tags,
  });
  res.json(item);
};

export const updateMenu = async (req, res) => {
  const id = req.params.id;
  const payload = { ...req.body };
  if (payload.productionPrinterIds && !Array.isArray(payload.productionPrinterIds)) {
    payload.productionPrinterIds = [payload.productionPrinterIds].filter(Boolean);
  }
  if (payload.productionTags && !Array.isArray(payload.productionTags)) {
    payload.productionTags = [payload.productionTags].filter(Boolean);
  }
  if (Array.isArray(payload.productionPrinterIds)) {
    payload.productionPrinterIds = payload.productionPrinterIds.map(String).filter(Boolean);
  }
  if (Array.isArray(payload.productionTags)) {
    payload.productionTags = payload.productionTags
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter(Boolean);
  }
  const item = await MenuItem.findByIdAndUpdate(id, payload, { new: true });
  res.json(item);
};

export const deleteMenu = async (req, res) => {
  const id = req.params.id;
  await MenuItem.findByIdAndDelete(id);
  res.json({ ok: true });
};