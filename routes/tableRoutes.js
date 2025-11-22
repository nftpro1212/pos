// src/backend/routes/tableRoutes.js
import express from "express";
import { listTables, createTable, updateTable, deleteTable } from "../controllers/tableController.js";
import { protect, adminOnly } from "../middleware/authMiddleware.js";

const router = express.Router();
router.get("/", protect, listTables);
router.post("/", protect, adminOnly, createTable);
router.put("/:id", protect, adminOnly, updateTable);
router.delete("/:id", protect, adminOnly, deleteTable);

export default router;