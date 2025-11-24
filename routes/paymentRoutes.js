// src/backend/routes/paymentRoutes.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { createPayment, listPayments, printPaymentReceipt } from "../controllers/paymentController.js";
const router = express.Router();

router.get("/", protect, listPayments);
router.post("/", protect, createPayment);
router.post("/:paymentId/print", protect, printPaymentReceipt);

export default router;