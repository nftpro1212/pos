// src/backend/routes/menuRoutes.js
import express from "express";
import { listMenu, createMenu, updateMenu, deleteMenu } from "../controllers/menuController.js";
import { protect, adminOnly } from "../middleware/authMiddleware.js";
const router = express.Router();

router.get("/", protect, listMenu);
router.post("/", protect, adminOnly, createMenu);
router.put("/:id", protect, adminOnly, updateMenu);
router.delete("/:id", protect, adminOnly, deleteMenu);

export default router;