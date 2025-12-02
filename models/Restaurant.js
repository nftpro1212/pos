import mongoose from "mongoose";

const restaurantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, unique: true, sparse: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    contactPhone: { type: String },
    address: { type: String },
    timezone: { type: String },
    settings: { type: Object, default: {} },
  },
  { timestamps: true }
);

export default mongoose.model("Restaurant", restaurantSchema);
