import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { startShift, endShift, getShifts } from "../controllers/shiftController.js";
const router = express.Router();

router.post("/start", protect, startShift);
router.post("/end", protect, endShift);
router.get("/", protect, getShifts);

export default router;
