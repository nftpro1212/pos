// src/backend/controllers/menuController.js
import MenuItem from "../models/MenuItem.js";
import { resolveRestaurantId } from "../utils/tenant.js";

const VALID_PRICING_MODES = new Set(["fixed", "weight", "portion"]);
const VALID_WEIGHT_UNITS = new Set(["kg", "g"]);

const normalizeWeightStep = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0.1;
  return Number(numeric.toFixed(3));
};

const slugifyKey = (value, fallback) => {
  const base = typeof value === "string" && value.trim().length
    ? value.trim().toLowerCase()
    : fallback.toLowerCase();
  return base
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/-{2,}/g, "-")
    .replace(/(^-|-$)/g, "");
};

const normalizePortionOptions = (options) => {
  if (!Array.isArray(options)) return [];

  const seen = new Set();
  let autoIndex = 1;

  return options
    .map((option) => {
      if (!option) return null;
      const label = typeof option.label === "string" ? option.label.trim() : "";
      if (!label) return null;

      const priceValue = Number(option.price);
      if (!Number.isFinite(priceValue) || priceValue <= 0) return null;

      let keyCandidate = typeof option.key === "string" ? option.key.trim() : "";
      if (!keyCandidate) {
        keyCandidate = slugifyKey(label, `portion-${autoIndex}`);
      } else {
        keyCandidate = slugifyKey(keyCandidate, keyCandidate || `portion-${autoIndex}`);
      }

      if (!keyCandidate) {
        keyCandidate = `portion-${autoIndex}`;
      }

      let uniqueKey = keyCandidate;
      while (seen.has(uniqueKey)) {
        uniqueKey = `${keyCandidate}-${autoIndex++}`;
      }
      seen.add(uniqueKey);
      autoIndex += 1;

      return {
        key: uniqueKey,
        label,
        price: Number(priceValue.toFixed(2)),
      };
    })
    .filter(Boolean);
};

export const listMenu = async (req, res) => {
  const restaurantId = resolveRestaurantId(req, { allowQuery: true });
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const q = req.query.q || "";
  const filter = {
    restaurant: restaurantId,
    ...(q ? { name: { $regex: q, $options: "i" } } : {}),
  };
  const items = await MenuItem.find(filter).sort({ createdAt: -1 });
  res.json(items);
};

export const createMenu = async (req, res) => {
  const restaurantId = resolveRestaurantId(req, { allowBody: true, allowQuery: true });
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const {
    name,
    description,
    price,
    category,
    imageUrl,
    productionPrinterIds = [],
    productionTags = [],
    pricingMode,
    weightUnit,
    weightStep,
    portionOptions,
  } = req.body;
  const printerIds = Array.isArray(productionPrinterIds)
    ? productionPrinterIds.map(String).filter(Boolean)
    : [];
  const tags = Array.isArray(productionTags)
    ? productionTags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean)
    : [];
  const normalizedPrice = Number(price);
  const safePrice = Number.isFinite(normalizedPrice) ? normalizedPrice : 0;
  const safePricingMode = VALID_PRICING_MODES.has(pricingMode) ? pricingMode : "fixed";
  const safeWeightUnit = VALID_WEIGHT_UNITS.has(weightUnit) ? weightUnit : "kg";
  const safeWeightStep = normalizeWeightStep(weightStep);
  const safePortions = safePricingMode === "portion" ? normalizePortionOptions(portionOptions) : [];
  const item = await MenuItem.create({
    name,
    description,
    price: safePrice,
    category,
    imageUrl,
    productionPrinterIds: printerIds,
    productionTags: tags,
    pricingMode: safePricingMode,
    weightUnit: safeWeightUnit,
    weightStep: safeWeightStep,
    portionOptions: safePortions,
    restaurant: restaurantId,
  });
  res.json(item);
};

export const updateMenu = async (req, res) => {
  const restaurantId = resolveRestaurantId(req, { allowBody: true });
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

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
  if (typeof payload.price !== "undefined") {
    const numericPrice = Number(payload.price);
    payload.price = Number.isFinite(numericPrice) ? numericPrice : 0;
  }
  if (typeof payload.pricingMode !== "undefined") {
    payload.pricingMode = VALID_PRICING_MODES.has(payload.pricingMode) ? payload.pricingMode : "fixed";
  }
  if (typeof payload.weightUnit !== "undefined") {
    payload.weightUnit = VALID_WEIGHT_UNITS.has(payload.weightUnit) ? payload.weightUnit : "kg";
  }
  if (typeof payload.weightStep !== "undefined") {
    payload.weightStep = normalizeWeightStep(payload.weightStep);
  }
  if (typeof payload.portionOptions !== "undefined") {
    const normalizedPortions = normalizePortionOptions(payload.portionOptions);
    if (payload.pricingMode && payload.pricingMode !== "portion") {
      payload.portionOptions = [];
    } else {
      payload.portionOptions = normalizedPortions;
    }
  } else if (payload.pricingMode && payload.pricingMode !== "portion") {
    payload.portionOptions = [];
  }
  delete payload.restaurant;
  delete payload.tenantId;

  const item = await MenuItem.findOneAndUpdate(
    { _id: id, restaurant: restaurantId },
    payload,
    { new: true }
  );

  if (!item) {
    return res.status(404).json({ message: "Menu topilmadi" });
  }
  res.json(item);
};

export const deleteMenu = async (req, res) => {
  const restaurantId = resolveRestaurantId(req, { allowQuery: true, allowBody: true });
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const id = req.params.id;
  const result = await MenuItem.findOneAndDelete({ _id: id, restaurant: restaurantId });
  if (!result) {
    return res.status(404).json({ message: "Menu topilmadi" });
  }
  res.json({ ok: true });
};