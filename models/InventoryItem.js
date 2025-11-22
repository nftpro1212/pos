// src/backend/models/InventoryItem.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const inventoryItemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    category: { type: String, trim: true, default: "" },
    unit: { type: String, trim: true, default: "dona" },
    currentStock: { type: Number, default: 0, min: 0 },
    parLevel: { type: Number, default: 0, min: 0 },
    cost: { type: Number, default: 0, min: 0 },
    supplier: { type: String, trim: true, default: "" },
    defaultWarehouse: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    trackingMethod: {
      type: String,
      enum: ["fifo", "lifo", "fefo", "average"],
      default: "fifo",
    },
    consumptionUnit: { type: String, trim: true, default: "" },
    conversionRate: { type: Number, default: 1, min: 0 },
    storageConditions: { type: String, trim: true, default: "" },
    shelfLifeDays: { type: Number, default: null, min: 0 },
    expiryTrackingEnabled: { type: Boolean, default: false },
    lowStockAlertEnabled: { type: Boolean, default: true },
    tags: [{ type: String, trim: true }],
    allergens: [{ type: String, trim: true }],
    lastRestockDate: { type: Date, default: null },
    notes: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

inventoryItemSchema.index({ name: 1 });
inventoryItemSchema.index({ category: 1 });
inventoryItemSchema.index({ isActive: 1, currentStock: 1 });
inventoryItemSchema.index({ defaultWarehouse: 1 });

export default mongoose.model("InventoryItem", inventoryItemSchema);
