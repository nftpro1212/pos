// src/backend/models/MenuItem.js
import mongoose from "mongoose";

const menuItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true },
  category: String,
  isAvailable: { type: Boolean, default: true },
  isBlocked: { type: Boolean, default: false },
  inventory: { type: Number, default: 100 }, // inventory tracking
  imageUrl: String,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("MenuItem", menuItemSchema);