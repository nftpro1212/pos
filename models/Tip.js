import mongoose from "mongoose";
const tipSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  amount: Number,
  createdAt: { type: Date, default: Date.now }
});
export default mongoose.model("Tip", tipSchema);
