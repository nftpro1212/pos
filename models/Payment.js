// src/backend/models/Payment.js
import mongoose from "mongoose";

const paymentPartSchema = new mongoose.Schema({
  amount: Number,
  method: { type: String, enum: ["cash", "card", "online", "qr"], default: "cash" },
  txnId: String
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  parts: [paymentPartSchema], // split/mixed payments
  totalAmount: Number,
  discount: { type: Number, default: 0 },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Payment", paymentSchema);