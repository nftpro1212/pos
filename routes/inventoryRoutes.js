// src/backend/routes/inventoryRoutes.js
import express from "express";
import {
  getInventorySummary,
  listInventoryItems,
  createInventoryItem,
  updateInventoryItem,
  archiveInventoryItem,
  adjustInventory,
  transferInventory,
  listWarehouseStock,
  exportWarehouseStock,
  importWarehouseStock,
  performCycleCount,
  listMovements,
  listMovementsForItem,
} from "../controllers/inventoryController.js";
import {
  getInventoryOverview,
  getUsageTrends,
  getFoodCostReport,
  getInventoryAlerts,
} from "../controllers/inventoryAnalyticsController.js";
import { protect, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/summary", allowRoles("admin", "omborchi", "oshpaz"), getInventorySummary);
router.get("/items", allowRoles("admin", "omborchi", "oshpaz"), listInventoryItems);
router.post("/items", allowRoles("admin", "omborchi"), createInventoryItem);
router.put("/items/:id", allowRoles("admin", "omborchi"), updateInventoryItem);
router.delete("/items/:id", allowRoles("admin"), archiveInventoryItem);
router.post("/items/:id/adjust", allowRoles("admin", "omborchi", "oshpaz"), adjustInventory);
router.post("/items/:id/transfer", allowRoles("admin", "omborchi"), transferInventory);
router.post("/items/:id/count", allowRoles("admin", "omborchi"), performCycleCount);
router.get("/items/:id/movements", allowRoles("admin", "omborchi", "oshpaz"), listMovementsForItem);
router.get("/warehouses/:id/stocks", allowRoles("admin", "omborchi", "oshpaz"), listWarehouseStock);
router.get("/warehouses/:id/export", allowRoles("admin", "omborchi"), exportWarehouseStock);
router.post("/warehouses/:id/import", allowRoles("admin", "omborchi"), importWarehouseStock);
router.get("/movements", allowRoles("admin", "omborchi", "oshpaz"), listMovements);
router.get(
  "/analytics/overview",
  allowRoles("admin", "omborchi", "oshpaz"),
  getInventoryOverview
);
router.get("/analytics/usage", allowRoles("admin", "omborchi", "oshpaz"), getUsageTrends);
router.get("/analytics/food-cost", allowRoles("admin", "omborchi", "oshpaz"), getFoodCostReport);
router.get("/alerts", allowRoles("admin", "omborchi", "oshpaz"), getInventoryAlerts);

export default router;
