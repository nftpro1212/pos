// src/backend/models/InventoryMovement.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const inventoryMovementSchema = new Schema(
  {
    item: { type: Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    type: {
      type: String,
      enum: [
        "incoming",
        "usage",
        "adjustment",
        "waste",
        "transfer_in",
        "transfer_out",
        "return",
        "count_adjustment",
      ],
      default: "adjustment",
    },
    quantity: { type: Number, required: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, default: 0 },
    unit: { type: String, default: "dona" },
    warehouse: { type: Schema.Types.ObjectId, ref: "Warehouse" },
    sourceWarehouse: { type: Schema.Types.ObjectId, ref: "Warehouse" },
    targetWarehouse: { type: Schema.Types.ObjectId, ref: "Warehouse" },
    unitCost: { type: Number, default: 0, min: 0 },
    totalCost: { type: Number, default: 0, min: 0 },
    reason: { type: String, trim: true, default: "" },
    reference: { type: String, trim: true, default: "" },
    metadata: { type: Schema.Types.Mixed },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    supplier: { type: Schema.Types.ObjectId, ref: "Supplier" },
  },
  { timestamps: true }
);

inventoryMovementSchema.index({ item: 1, createdAt: -1 });
inventoryMovementSchema.index({ warehouse: 1, createdAt: -1 });
inventoryMovementSchema.index({ supplier: 1, createdAt: -1 });

export default mongoose.model("InventoryMovement", inventoryMovementSchema);
