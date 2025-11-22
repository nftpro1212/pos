// src/backend/models/InventoryStock.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const inventoryStockSchema = new Schema(
  {
    item: { type: Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    warehouse: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    quantity: { type: Number, default: 0, min: 0 },
    unit: { type: String, trim: true, default: "dona" },
    parLevel: { type: Number, default: 0, min: 0 },
    reorderPoint: { type: Number, default: 0, min: 0 },
    safetyStock: { type: Number, default: 0, min: 0 },
    lastCountDate: { type: Date, default: null },
    lastMovementAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

inventoryStockSchema.index({ item: 1, warehouse: 1 }, { unique: true });
inventoryStockSchema.index({ warehouse: 1 });
inventoryStockSchema.index({ quantity: 1 });

export default mongoose.model("InventoryStock", inventoryStockSchema);
