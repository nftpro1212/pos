// src/backend/controllers/recipeController.js
import mongoose from "mongoose";
import Recipe from "../models/Recipe.js";
import InventoryItem from "../models/InventoryItem.js";
import MenuItem from "../models/MenuItem.js";
import Warehouse from "../models/Warehouse.js";
import ActionLog from "../models/ActionLog.js";
import { ensureDefaultWarehouse } from "../utils/warehouse.js";
import { toNumber } from "../utils/inventoryHelpers.js";

const { Types } = mongoose;

const sanitizeStrings = (values = []) =>
  values
    .map((value) => value?.toString?.().trim())
    .filter((value) => value && value.length > 0);

const resolveMenuItem = async (menuItemId) => {
  if (!menuItemId) return null;
  if (!Types.ObjectId.isValid(menuItemId)) {
    throw new Error("Noto'g'ri menu ID");
  }
  const menuItem = await MenuItem.findById(menuItemId);
  if (!menuItem) {
    throw new Error("Menu elementi topilmadi");
  }
  return menuItem;
};

const ensureWarehousesExist = async (warehouseIds = []) => {
  const filtered = warehouseIds.filter((id) => Types.ObjectId.isValid(id));
  if (!filtered.length) return [];

  const warehouses = await Warehouse.find({ _id: { $in: filtered }, isActive: true })
    .select("_id isActive")
    .lean();

  const missing = filtered.filter(
    (id) => !warehouses.some((warehouse) => warehouse._id.toString() === id.toString())
  );

  if (missing.length) {
    throw new Error("Ba'zi omborlar topilmadi yoki faol emas");
  }

  return warehouses;
};

const prepareVersionPayload = async (payload = {}, userId) => {
  const {
    name = "",
    ingredients = [],
    portionSizes = [],
    notes = "",
    isDefault = false,
  } = payload;

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new Error("Retsept ingredientlari talab qilinadi");
  }

  const ingredientIds = sanitizeStrings(ingredients.map((ingredient) => ingredient?.item));
  if (!ingredientIds.length) {
    throw new Error("Ingredientlar noto'g'ri ko'rsatildi");
  }

  const inventoryItems = await InventoryItem.find({ _id: { $in: ingredientIds }, isActive: true })
    .select("_id name unit cost defaultWarehouse")
    .lean();

  if (inventoryItems.length !== ingredientIds.length) {
    throw new Error("Ba'zi ingredientlar topilmadi yoki faol emas");
  }

  const warehouseIds = sanitizeStrings(
    ingredients
      .map((ingredient) => ingredient?.warehouse)
      .filter((value) => value && Types.ObjectId.isValid(value))
  );
  if (warehouseIds.length) {
    await ensureWarehousesExist(warehouseIds);
  } else {
    await ensureDefaultWarehouse();
  }

  const ingredientDocs = [];
  let ingredientTotalCost = 0;

  for (const ingredient of ingredients) {
    const inventoryItem = inventoryItems.find(
      (doc) => doc._id.toString() === ingredient.item?.toString()
    );

    const quantity = Math.max(0, toNumber(ingredient.quantity, null));
    if (!quantity) {
      throw new Error("Ingredient miqdorini to'g'ri kiriting");
    }

    const wastePercent = Math.max(0, toNumber(ingredient.wastePercent ?? ingredient.waste, 0));

    const unitCost = inventoryItem?.cost || 0;
    const effectiveQuantity = quantity * (1 + wastePercent / 100);
    ingredientTotalCost += effectiveQuantity * unitCost;

    ingredientDocs.push({
      item: inventoryItem._id,
      quantity,
      unit: ingredient.unit?.toString?.().trim() || inventoryItem.unit || "dona",
      wastePercent,
      notes: ingredient.notes?.toString?.().trim() || "",
      warehouse: ingredient.warehouse && Types.ObjectId.isValid(ingredient.warehouse)
        ? ingredient.warehouse
        : inventoryItem.defaultWarehouse || null,
    });
  }

  const defaultPortions = portionSizes.length
    ? portionSizes.map((portion) => ({
        key: portion.key?.toString?.().trim() || "standard",
        label: portion.label?.toString?.().trim() || "",
        multiplier: Math.max(0, toNumber(portion.multiplier, 1)) || 1,
      }))
    : [
        {
          key: "standard",
          label: "Normal",
          multiplier: 1,
        },
      ];

  return {
    name: name?.toString?.().trim() || "",
    isDefault: Boolean(isDefault),
    ingredients: ingredientDocs,
    portionSizes: defaultPortions,
    notes: notes?.toString?.().trim() || "",
    ingredientTotalCost,
    createdBy: userId || null,
    createdAt: new Date(),
  };
};

const attachVersionMetadata = (recipe, version) => {
  if (!recipe || !version) return;
  recipe.estimatedCost = version.ingredientTotalCost;
  recipe.defaultVersion = version._id;
  recipe.versions = recipe.versions.map((existingVersion) => ({
    ...existingVersion,
    isDefault: existingVersion._id.toString() === version._id.toString(),
  }));
};

export const listRecipes = async (req, res) => {
  try {
    const { search = "", status = "active", category, menuItemId } = req.query;

    const query = {};

    if (status === "archived") query.isActive = false;
    else if (status === "all") {
      // show everything
    } else query.isActive = true;

    if (search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      query.$or = [{ name: regex }, { code: regex }, { tags: regex }];
    }

    if (category && category !== "all") {
      query.category = category;
    }

    if (menuItemId && Types.ObjectId.isValid(menuItemId)) {
      query.menuItem = menuItemId;
    }

    const recipes = await Recipe.find(query)
      .sort({ isActive: -1, name: 1 })
      .populate({ path: "menuItem", select: "name category price" })
      .lean();

    res.json({ recipes });
  } catch (err) {
    console.error("listRecipes error", err);
    res.status(500).json({ message: "Retseptlar ro'yxatini olishda xatolik" });
  }
};

export const getRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri retsept ID" });
    }

    const recipe = await Recipe.findById(id)
      .populate({ path: "menuItem", select: "name category price" })
      .populate({ path: "versions.ingredients.item", select: "name unit cost" })
      .populate({ path: "versions.ingredients.warehouse", select: "name code" })
      .lean();

    if (!recipe) {
      return res.status(404).json({ message: "Retsept topilmadi" });
    }

    res.json({ recipe });
  } catch (err) {
    console.error("getRecipe error", err);
    res.status(500).json({ message: "Retsept ma'lumotini olishda xatolik" });
  }
};

export const createRecipe = async (req, res) => {
  try {
    const {
      name,
      code,
      menuItem: menuItemId,
      category,
      tags = [],
      notes = "",
      version,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: "Retsept nomi talab qilinadi" });
    }

    let linkedMenuItem = null;
    if (menuItemId) {
      linkedMenuItem = await resolveMenuItem(menuItemId);
    }

    const recipe = await Recipe.create({
      name: name.trim(),
      code: code?.toString?.().trim().toUpperCase() || undefined,
      menuItem: linkedMenuItem?._id || null,
      category: category?.toString?.().trim() || "",
      tags: sanitizeStrings(tags),
      metadata: { notes: notes?.toString?.().trim() || "" },
    });

    if (version) {
      const preparedVersion = await prepareVersionPayload(version, req.user?._id);
      preparedVersion.versionNumber = 1;
      const versionDoc = recipe.versions.create(preparedVersion);
      recipe.versions.push(versionDoc);
      attachVersionMetadata(recipe, versionDoc);
    }

    await recipe.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "recipe_create",
      details: `Yangi retsept yaratildi: ${recipe.name}`,
      metadata: { recipeId: recipe._id, menuItemId: recipe.menuItem },
    });

    res.status(201).json({ recipe });
  } catch (err) {
    console.error("createRecipe error", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Bu nom yoki koddagi retsept mavjud" });
    }
    res.status(500).json({ message: err.message || "Retsept yaratishda xatolik" });
  }
};

export const addRecipeVersion = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri retsept ID" });
    }

    const recipe = await Recipe.findById(id);
    if (!recipe) {
      return res.status(404).json({ message: "Retsept topilmadi" });
    }

    const preparedVersion = await prepareVersionPayload(req.body, req.user?._id);
    const highestVersionNumber = recipe.versions.reduce(
      (max, version) => Math.max(max, version.versionNumber || 0),
      0
    );

    preparedVersion.versionNumber = highestVersionNumber + 1;

    const versionDoc = recipe.versions.create(preparedVersion);
    recipe.versions.push(versionDoc);

    if (preparedVersion.isDefault || !recipe.defaultVersion) {
      attachVersionMetadata(recipe, versionDoc);
    }

    await recipe.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "recipe_add_version",
      details: `${recipe.name} uchun ${versionDoc.versionNumber}-versiya qo'shildi`,
      metadata: { recipeId: recipe._id, versionId: versionDoc._id },
    });

    res.status(201).json({ recipe });
  } catch (err) {
    console.error("addRecipeVersion error", err);
    res.status(500).json({ message: err.message || "Retsept versiyasini qo'shishda xatolik" });
  }
};

export const setDefaultRecipeVersion = async (req, res) => {
  try {
    const { id } = req.params;
    const { versionId } = req.body;

    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(versionId)) {
      return res.status(400).json({ message: "Noto'g'ri ID" });
    }

    const recipe = await Recipe.findById(id);
    if (!recipe) {
      return res.status(404).json({ message: "Retsept topilmadi" });
    }

    const version = recipe.versions.id(versionId);
    if (!version) {
      return res.status(404).json({ message: "Versiya topilmadi" });
    }

    attachVersionMetadata(recipe, version);
    await recipe.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "recipe_set_default",
      details: `${recipe.name} uchun ${version.versionNumber}-versiya default qilindi`,
      metadata: { recipeId: recipe._id, versionId: version._id },
    });

    res.json({ recipe });
  } catch (err) {
    console.error("setDefaultRecipeVersion error", err);
    res.status(500).json({ message: err.message || "Standart versiyani o'rnatishda xatolik" });
  }
};

export const updateRecipeMeta = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri retsept ID" });
    }

    const recipe = await Recipe.findById(id);
    if (!recipe) {
      return res.status(404).json({ message: "Retsept topilmadi" });
    }

    const { name, code, category, tags, menuItem: menuItemId, isActive } = req.body;

    if (name !== undefined) recipe.name = name?.toString?.().trim() || recipe.name;
    if (code !== undefined) recipe.code = code?.toString?.().trim().toUpperCase() || undefined;
    if (category !== undefined) recipe.category = category?.toString?.().trim() || "";
    if (tags !== undefined && Array.isArray(tags)) recipe.tags = sanitizeStrings(tags);
    if (menuItemId !== undefined) {
      recipe.menuItem = menuItemId ? (await resolveMenuItem(menuItemId))._id : null;
    }
    if (isActive !== undefined) {
      recipe.isActive = Boolean(isActive);
      recipe.archivedAt = recipe.isActive ? null : new Date();
    }

    await recipe.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "recipe_update",
      details: `${recipe.name} metama'lumotlari yangilandi`,
      metadata: { recipeId: recipe._id },
    });

    res.json({ recipe });
  } catch (err) {
    console.error("updateRecipeMeta error", err);
    res.status(500).json({ message: err.message || "Retsept ma'lumotlarini yangilashda xatolik" });
  }
};

export const archiveRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri retsept ID" });
    }

    const recipe = await Recipe.findById(id);
    if (!recipe) {
      return res.status(404).json({ message: "Retsept topilmadi" });
    }

    recipe.isActive = false;
    recipe.archivedAt = new Date();
    await recipe.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "recipe_archive",
      details: `${recipe.name} arxivlandi`,
      metadata: { recipeId: recipe._id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("archiveRecipe error", err);
    res.status(500).json({ message: "Retseptni arxivlashda xatolik" });
  }
};
