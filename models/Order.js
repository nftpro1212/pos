// src/backend/models/Order.js
import mongoose from "mongoose";

const modifierSchema = new mongoose.Schema({
  name: String,
  price: Number
}, { _id: false });

const orderItemSchema = new mongoose.Schema({
  menuItem: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem" },
  name: String,
  qty: { type: Number, default: 1 },
  price: Number,
  notes: String,
  portionKey: { type: String, trim: true, default: "standard" },
  portionLabel: { type: String, trim: true, default: "" },
  pricingMode: {
    type: String,
    enum: ["fixed", "weight", "portion"],
    default: "fixed",
  },
  weightUnit: { type: String, trim: true, default: "" },
  displayQty: { type: String, trim: true, default: "" },
  modifiers: [modifierSchema],
  isBlocked: { type: Boolean, default: false },
  productionPrinterIds: { type: [String], default: [] },
  productionTags: { type: [String], default: [] }
});

const orderSchema = new mongoose.Schema({
  table: { type: mongoose.Schema.Types.ObjectId, ref: "Table" },
  tableName: String,
  items: [orderItemSchema],
  subtotal: Number,
  tax: Number,
  discount: { type: Number, default: 0 },
  total: Number,
  status: { type: String, enum: ["new", "in_progress", "ready", "closed", "cancelled"], default: "new" },
  fiscalStatus: { type: String, enum: ["pending", "completed", "failed", "skipped"], default: "pending" },
  fiscalReceiptId: { type: String, default: null },
  fiscalError: { type: String, default: null },
  fiscalPayload: { type: mongoose.Schema.Types.Mixed, default: null },
  fiscalSyncedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  restaurantId: { type: String, default: "default" },
  deliveryCourier: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
  isDelivery: { type: Boolean, default: false },
  type: { type: String, enum: ["table", "delivery", "soboy"], default: "table" },
  actionLogs: [{ type: mongoose.Schema.Types.ObjectId, ref: "ActionLog" }],
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Order", orderSchema);