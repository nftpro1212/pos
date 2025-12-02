import express from "express";
import { resetPosData } from "../controllers/systemController.js";
import { protect, adminOnly } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/reset", protect, adminOnly, resetPosData);

export default router;
