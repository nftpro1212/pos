// src/backend/routes/orderRoutes.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { createOrder, listOrders, getOrder, updateOrder, deleteOrder } from "../controllers/orderController.js";

const router = express.Router();
router.get("/", protect, listOrders);
router.post("/", protect, createOrder);
router.get("/:id", protect, getOrder);
router.put("/:id", protect, updateOrder);
router.delete("/:id", protect, deleteOrder);

export default router;