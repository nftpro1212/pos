// src/backend/models/Recipe.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const portionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, trim: true, default: "" },
    multiplier: { type: Number, default: 1, min: 0 },
  },
  { _id: false }
);

const ingredientSchema = new Schema(
  {
    item: { type: Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, default: "dona" },
    wastePercent: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, default: "" },
    warehouse: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
  },
  { _id: false }
);

const recipeVersionSchema = new Schema(
  {
    versionNumber: { type: Number, required: true },
    name: { type: String, trim: true, default: "" },
    isDefault: { type: Boolean, default: false },
    ingredientTotalCost: { type: Number, default: 0, min: 0 },
    ingredients: { type: [ingredientSchema], default: [] },
    portionSizes: {
      type: [portionSchema],
      default: () => [
        {
          key: "standard",
          label: "Normal",
          multiplier: 1,
        },
      ],
    },
    notes: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const recipeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    restaurant: { type: Schema.Types.ObjectId, ref: "Restaurant", index: true },
    menuItem: { type: Schema.Types.ObjectId, ref: "MenuItem", index: true },
    code: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    category: { type: String, trim: true, default: "" },
    tags: [{ type: String, trim: true }],
    defaultVersion: { type: Schema.Types.ObjectId },
    versions: { type: [recipeVersionSchema], default: [] },
    lastUsedAt: { type: Date, default: null },
    estimatedCost: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    archivedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

recipeSchema.index({ restaurant: 1, name: 1 }, { unique: true });
recipeSchema.index({ isActive: 1, name: 1 });
recipeSchema.index({ menuItem: 1, isActive: 1 });

export default mongoose.model("Recipe", recipeSchema);
