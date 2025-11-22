// src/backend/middleware/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import dotenv from "dotenv";
dotenv.config();

export const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: "Not authorized" });
    const token = header.split(" ")[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(payload.id).select("-passwordHash");
    next();
  } catch (err) {
    console.error(err);
    res.status(401).json({ message: "Token invalid or expired" });
  }
};

export const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === "admin") return next();
  return res.status(403).json({ message: "Admin only" });
};

export const allowRoles = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not authorized" });
  }

  if (!roles.length || roles.includes(req.user.role)) {
    return next();
  }

  return res.status(403).json({ message: "Ushbu amal uchun ruxsat mavjud emas" });
};