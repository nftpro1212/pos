import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { addTip, getTips } from "../controllers/tipController.js";
const router = express.Router();

router.post("/", protect, addTip);
router.get("/", protect, getTips);

export default router;
