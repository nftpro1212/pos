// src/backend/models/Warehouse.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const locationSchema = new Schema(
  {
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    postalCode: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const contactSchema = new Schema(
  {
    name: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const WAREHOUSE_TYPES = ["main", "kitchen", "bar", "delivery", "storage", "custom"];

const warehouseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    type: { type: String, enum: WAREHOUSE_TYPES, default: "main" },
    description: { type: String, trim: true, default: "" },
    location: { type: locationSchema, default: () => ({}) },
    contact: { type: contactSchema, default: () => ({}) },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    parentWarehouse: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

warehouseSchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });
warehouseSchema.index({ name: 1, isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
warehouseSchema.index({ type: 1, isActive: 1 });

export default mongoose.model("Warehouse", warehouseSchema);
