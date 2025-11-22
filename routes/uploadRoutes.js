import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = express.Router();

// Create uploads dir if not exists
const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random()*1e6)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({ storage });

router.post("/", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  // Return relative url for frontend (no /api/ prefix)
  res.json({ url: `/uploads/${req.file.filename}` });
});

export default router;
