// src/backend/models/Report.js
import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  type: { type: String, enum: ["sales", "inventory", "staff"], default: "sales" },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", index: true },
  data: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Report", reportSchema);
