// src/backend/routes/reportRoutes.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { salesReport, salesReportExport } from "../controllers/reportController.js";
const router = express.Router();

router.get("/sales", protect, salesReport);
router.get("/sales/export", protect, salesReportExport);

export default router;