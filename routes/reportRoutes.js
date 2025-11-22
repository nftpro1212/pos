// src/backend/routes/reportRoutes.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { salesReport } from "../controllers/reportController.js";
const router = express.Router();

router.get("/sales", protect, salesReport);

export default router;