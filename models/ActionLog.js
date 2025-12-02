// src/backend/models/ActionLog.js
import mongoose from "mongoose";

const actionLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", index: true },
  action: { type: String, required: true },
  details: String,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("ActionLog", actionLogSchema);
