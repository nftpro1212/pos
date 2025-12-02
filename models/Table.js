// src/backend/models/Table.js
import mongoose from "mongoose";

const tableSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", index: true },
  category: { type: String, trim: true, default: "zal" },
  status: { type: String, enum: ["free", "occupied", "reserved"], default: "free" },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  assignedToName: { type: String, trim: true, default: "" },
  assignedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

tableSchema.index({ restaurant: 1, name: 1 }, { unique: true });
tableSchema.index({ restaurant: 1, category: 1, status: 1 });

export default mongoose.model("Table", tableSchema);