import express from "express";
import { register, login, loginByPin, listStaff, updateStaff, deleteStaff } from "../controllers/authController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/login-pin", loginByPin);
router.get("/staff", protect, listStaff);
router.put("/staff/:id", protect, updateStaff);
router.delete("/staff/:id", protect, deleteStaff);

export default router;
