import mongoose from "mongoose";
const shiftSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", index: true },
  start: Date,
  end: Date,
});
export default mongoose.model("Shift", shiftSchema);
