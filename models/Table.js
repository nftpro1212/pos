// src/backend/models/Table.js
import mongoose from "mongoose";

const tableSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, trim: true, default: "zal" },
  status: { type: String, enum: ["free", "occupied", "reserved"], default: "free" },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Table", tableSchema);