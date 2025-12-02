import mongoose from "mongoose";
const tipSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", index: true },
  amount: Number,
  createdAt: { type: Date, default: Date.now }
});
export default mongoose.model("Tip", tipSchema);
