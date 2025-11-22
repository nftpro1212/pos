// src/backend/controllers/inventoryAnalyticsController.js
import mongoose from "mongoose";
import InventoryItem from "../models/InventoryItem.js";
import InventoryMovement from "../models/InventoryMovement.js";
import InventoryStock from "../models/InventoryStock.js";
import Recipe from "../models/Recipe.js";
import MenuItem from "../models/MenuItem.js";

const { Types } = mongoose;

const movementTypesUsage = ["usage", "waste", "transfer_out", "return"];

export const getInventoryOverview = async (req, res) => {
  try {
    const [totalsAgg] = await InventoryStock.aggregate([
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

    const totalItems = await InventoryItem.countDocuments({ isActive: true });
    const lowStockItems = await InventoryItem.find({
      isActive: true,
      lowStockAlertEnabled: true,
      parLevel: { $gt: 0 },
      $expr: { $lte: ["$currentStock", "$parLevel"] },
    })
      .select("name currentStock parLevel unit")
      .limit(10)
      .lean();

    const now = new Date();
    const expiryChecks = await InventoryItem.find({
      isActive: true,
      expiryTrackingEnabled: true,
      shelfLifeDays: { $gt: 0 },
      lastRestockDate: { $ne: null },
    })
      .select("name lastRestockDate shelfLifeDays unit currentStock")
      .lean();

    const expiringSoon = expiryChecks
      .map((item) => {
        const expiryDate = new Date(
          item.lastRestockDate.getTime() + item.shelfLifeDays * 24 * 60 * 60 * 1000
        );
        const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return {
          _id: item._id,
          name: item.name,
          unit: item.unit,
          currentStock: item.currentStock,
          expiryDate,
          daysLeft,
        };
      })
      .filter((item) => item.daysLeft <= 5)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 10);

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fastMovingAgg = await InventoryMovement.aggregate([
      {
        $match: {
          type: { $in: movementTypesUsage },
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: "$item",
          totalUsage: { $sum: "$quantity" },
        },
      },
      { $sort: { totalUsage: -1 } },
      { $limit: 10 },
    ]);

    const fastMovingIds = fastMovingAgg.map((doc) => doc._id).filter(Boolean);
    const fastMovingItems = fastMovingIds.length
      ? await InventoryItem.find({ _id: { $in: fastMovingIds } })
          .select("name unit currentStock parLevel")
          .lean()
      : [];

    const fastMoving = fastMovingAgg.map((doc) => {
      const item = fastMovingItems.find((candidate) => candidate._id.toString() === doc._id.toString());
      return {
        _id: doc._id,
        name: item?.name || "Noma'lum",
        unit: item?.unit,
        currentStock: item?.currentStock,
        parLevel: item?.parLevel,
        totalUsage: doc.totalUsage,
      };
    });

    res.json({
      totals: {
        totalItems,
        totalStockUnits: totalsAgg?.totalStockUnits || 0,
        inventoryValue: totalsAgg?.inventoryValue || 0,
        lowStockCount: lowStockItems.length,
        expiringSoonCount: expiringSoon.length,
        valuation: {
          averageCost: totalsAgg?.inventoryValue || 0,
          fifo: totalsAgg?.inventoryValue || 0,
          lifo: totalsAgg?.inventoryValue || 0,
        },
      },
      lowStockItems,
      expiringSoon,
      fastMoving,
    });
  } catch (err) {
    console.error("getInventoryOverview error", err);
    res.status(500).json({ message: "Inventar statistikani olishda xatolik" });
  }
};

export const getUsageTrends = async (req, res) => {
  try {
    const now = new Date();
    const days = Number(req.query.days) || 30;
    const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const usage = await InventoryMovement.aggregate([
      {
        $match: {
          type: { $in: movementTypesUsage },
          createdAt: { $gte: fromDate },
        },
      },
      {
        $project: {
          item: 1,
          type: 1,
          quantity: 1,
          createdAt: 1,
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        },
      },
      {
        $group: {
          _id: { day: "$day", type: "$type" },
          total: { $sum: "$quantity" },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]);

    res.json({ usage });
  } catch (err) {
    console.error("getUsageTrends error", err);
    res.status(500).json({ message: "Sarf dinamikasini hisoblashda xatolik" });
  }
};

export const getFoodCostReport = async (req, res) => {
  try {
    const recipes = await Recipe.find({ isActive: true, defaultVersion: { $ne: null } })
      .populate({ path: "menuItem", select: "name price category" })
      .lean();

    const report = recipes
      .filter((recipe) => recipe.menuItem)
      .map((recipe) => {
        const version = recipe.versions.find((ver) =>
          ver._id.toString() === recipe.defaultVersion.toString()
        );
        const ingredientCost = version?.ingredientTotalCost || 0;
        const price = recipe.menuItem.price || 0;
        const foodCostPct = price > 0 ? (ingredientCost / price) * 100 : 0;
        return {
          recipeId: recipe._id,
          menuItemId: recipe.menuItem._id,
          menuItemName: recipe.menuItem.name,
          category: recipe.menuItem.category,
          price,
          ingredientCost,
          foodCostPct: Number(foodCostPct.toFixed(2)),
        };
      });

    res.json({ report });
  } catch (err) {
    console.error("getFoodCostReport error", err);
    res.status(500).json({ message: "Food cost hisoblashda xatolik" });
  }
};

export const getInventoryAlerts = async (req, res) => {
  try {
    const lowStock = await InventoryItem.find({
      isActive: true,
      lowStockAlertEnabled: true,
      parLevel: { $gt: 0 },
      $expr: { $lte: ["$currentStock", "$parLevel"] },
    })
      .select("name currentStock parLevel unit")
      .lean();

    const now = new Date();
    const expiring = await InventoryItem.find({
      isActive: true,
      expiryTrackingEnabled: true,
      shelfLifeDays: { $gt: 0 },
      lastRestockDate: { $ne: null },
    })
      .select("name lastRestockDate shelfLifeDays unit currentStock")
      .lean();

    const expiringSoon = expiring
      .map((item) => {
        const expiryDate = new Date(
          item.lastRestockDate.getTime() + item.shelfLifeDays * 24 * 60 * 60 * 1000
        );
        const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return {
          _id: item._id,
          name: item.name,
          unit: item.unit,
          currentStock: item.currentStock,
          expiryDate,
          daysLeft,
        };
      })
      .filter((item) => item.daysLeft <= 3)
      .sort((a, b) => a.daysLeft - b.daysLeft);

    const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const usageByDay = await InventoryMovement.aggregate([
      {
        $match: {
          type: { $in: ["usage", "waste"] },
          createdAt: { $gte: windowStart },
        },
      },
      {
        $project: {
          item: 1,
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          quantity: 1,
        },
      },
      {
        $group: {
          _id: { item: "$item", day: "$day" },
          total: { $sum: "$quantity" },
        },
      },
    ]);

    const anomalyMap = new Map();
    usageByDay.forEach((entry) => {
      const itemId = entry._id.item.toString();
      if (!anomalyMap.has(itemId)) {
        anomalyMap.set(itemId, { daily: [] });
      }
      anomalyMap.get(itemId).daily.push({ day: entry._id.day, total: entry.total });
    });

    const anomalyCandidates = [];
    const todayKey = new Date().toISOString().slice(0, 10);

    for (const [itemId, data] of anomalyMap.entries()) {
      const totals = data.daily;
      const todayUsage = totals.find((entry) => entry.day === todayKey)?.total || 0;
      const pastDays = totals.filter((entry) => entry.day !== todayKey);
      const average = pastDays.length
        ? pastDays.reduce((sum, entry) => sum + entry.total, 0) / pastDays.length
        : 0;

      if (average > 0 && todayUsage > average * 1.5) {
        anomalyCandidates.push({ itemId, todayUsage, average });
      }
    }

    const anomalyIds = anomalyCandidates.map((candidate) => new Types.ObjectId(candidate.itemId));
    const anomalyItems = anomalyIds.length
      ? await InventoryItem.find({ _id: { $in: anomalyIds } }).select("name unit").lean()
      : [];

    const anomalies = anomalyCandidates.map((candidate) => {
      const item = anomalyItems.find((doc) => doc._id.toString() === candidate.itemId);
      return {
        _id: candidate.itemId,
        name: item?.name || "Noma'lum",
        unit: item?.unit,
        todayUsage: candidate.todayUsage,
        averageUsage: Number(candidate.average.toFixed(2)),
      };
    });

    res.json({
      lowStock,
      expiringSoon,
      anomalies,
    });
  } catch (err) {
    console.error("getInventoryAlerts error", err);
    res.status(500).json({ message: "Ombor ogohlantirishlarini hisoblashda xatolik" });
  }
};
