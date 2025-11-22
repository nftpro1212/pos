// src/backend/routes/warehouseRoutes.js
import express from "express";
import {
  listWarehouses,
  createWarehouse,
  updateWarehouse,
  setDefaultWarehouse,
  archiveWarehouse,
} from "../controllers/warehouseController.js";
import { protect, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", allowRoles("admin", "omborchi"), listWarehouses);
router.post("/", allowRoles("admin"), createWarehouse);
router.put("/:id", allowRoles("admin"), updateWarehouse);
router.patch("/:id/default", allowRoles("admin"), setDefaultWarehouse);
router.delete("/:id", allowRoles("admin"), archiveWarehouse);

export default router;
