// src/backend/models/Customer.js
import mongoose from "mongoose";

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", index: true },
  phone: String,
  isVIP: { type: Boolean, default: false },
  isLoan: { type: Boolean, default: false },
  balance: { type: Number, default: 0 }, // for loan customers
  notes: String,
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Customer", customerSchema);
