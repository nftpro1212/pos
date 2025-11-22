// src/backend/controllers/orderController.js
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Table from "../models/Table.js";
import Settings from "../models/Settings.js";
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

const { Types } = mongoose;

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

export const createOrder = async (req, res) => {
  try {
    const payload = req.body;
    const systemSettings = (await Settings.findOne()) || {};
    const taxSettings = systemSettings.taxSettings || {};
    const taxIntegration = systemSettings.taxIntegration || {};
    const taxRate = typeof taxSettings.taxRate === "number" ? taxSettings.taxRate : 0.12;
    const discountValue = payload.discount || 0;
    const subtotal = payload.items.reduce((s, it) => s + (it.price || 0) * (it.qty || 1), 0);
    const tax = +(subtotal * taxRate).toFixed(2);
    const total = +(subtotal + tax - discountValue).toFixed(2);
    const initialFiscalStatus = taxIntegration?.enabled ? "pending" : "skipped";

    const order = await Order.create({
      table: payload.tableId,
      tableName: payload.tableName,
      items: payload.items,
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
    if (payload.tableId) await Table.findByIdAndUpdate(payload.tableId, { status: "occupied" });

    if (taxIntegration?.enabled && taxIntegration.autoFiscalize !== false) {
      fiscalizeOrder(order, taxIntegration, { ...taxSettings, currency: systemSettings.currency })
        .catch(err => console.error("[TAX] Fiscalization error:", err.message));
    }

    await applyRecipeInventoryUsage(order, req.user);

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