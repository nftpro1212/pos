// src/backend/models/MenuItem.js
import mongoose from "mongoose";

const portionOptionSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true },
    label: { type: String, trim: true },
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

const menuItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", index: true },
  description: String,
  price: { type: Number, required: true },
  category: String,
  isAvailable: { type: Boolean, default: true },
  isBlocked: { type: Boolean, default: false },
  inventory: { type: Number, default: 100 }, // inventory tracking
  imageUrl: String,
  productionPrinterIds: { type: [String], default: [] },
  productionTags: { type: [String], default: [] },
  pricingMode: {
    type: String,
    enum: ["fixed", "weight", "portion"],
    default: "fixed",
  },
  weightUnit: {
    type: String,
    enum: ["kg", "g"],
    default: "kg",
  },
  weightStep: {
    type: Number,
    default: 0.1,
  },
  portionOptions: {
    type: [portionOptionSchema],
    default: [],
  },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("MenuItem", menuItemSchema);