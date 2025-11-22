import mongoose from "mongoose";
const shiftSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  start: Date,
  end: Date,
});
export default mongoose.model("Shift", shiftSchema);
