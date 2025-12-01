// routes/settingsRoutes.js
import express from "express";
import {
	getSettings,
	updateSettings,
	testPrinterConnection,
	testPrintCheck,
	testTaxIntegration,
	refreshPrintersStatus,
} from "../controllers/settingsController.js";
import { protect, adminOnly } from "../middleware/authMiddleware.js";
const router = express.Router();

router.get("/", protect, getSettings);
router.put("/", protect, adminOnly, updateSettings);

// Printer test routes
router.post("/test-printer-connection", protect, adminOnly, testPrinterConnection);
router.post("/test-print-check", protect, adminOnly, testPrintCheck);
router.post("/test-tax-integration", protect, adminOnly, testTaxIntegration);
router.post("/refresh-printers", protect, refreshPrintersStatus);

export default router;