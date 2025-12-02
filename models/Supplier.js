// src/backend/models/Supplier.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const contactSchema = new Schema(
  {
    person: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    whatsapp: { type: String, trim: true, default: "" },
    telegram: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const addressSchema = new Schema(
  {
    street: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    postalCode: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const priceHistorySchema = new Schema(
  {
    item: { type: Schema.Types.ObjectId, ref: "InventoryItem" },
    itemName: { type: String, trim: true },
    unit: { type: String, trim: true },
    unitCost: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, default: 0, min: 0 },
    totalCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, trim: true, default: "UZS" },
    warehouse: { type: Schema.Types.ObjectId, ref: "Warehouse" },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
    note: { type: String, trim: true, default: "" },
    reference: { type: String, trim: true, default: "" },
    invoiceNumber: { type: String, trim: true, default: "" },
    invoiceDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

const paymentSchema = new Schema(
  {
    amount: { type: Number, default: 0, min: 0 },
    method: { type: String, trim: true, default: "cash" },
    reference: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
    paidAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const invoiceSchema = new Schema(
  {
    number: { type: String, trim: true, default: "" },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, trim: true, default: "UZS" },
    issuedDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    fileName: { type: String, trim: true, default: "" },
    filePath: { type: String, trim: true, default: "" },
    fileUrl: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: ["pending", "partial", "paid", "overdue"],
      default: "pending",
    },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    restaurant: { type: Schema.Types.ObjectId, ref: "Restaurant", index: true },
    code: { type: String, trim: true, uppercase: true, sparse: true },
    companyName: { type: String, trim: true, default: "" },
    taxId: { type: String, trim: true, default: "" },
    categories: [{ type: String, trim: true }],
    contact: { type: contactSchema, default: () => ({}) },
    address: { type: addressSchema, default: () => ({}) },
    currency: { type: String, trim: true, default: "UZS" },
    paymentTerms: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    balance: { type: Number, default: 0 },
    totalPurchases: { type: Number, default: 0 },
    totalPayments: { type: Number, default: 0 },
    lastPurchaseDate: { type: Date, default: null },
    priceHistory: { type: [priceHistorySchema], default: [] },
    payments: { type: [paymentSchema], default: [] },
    invoices: { type: [invoiceSchema], default: [] },
    isActive: { type: Boolean, default: true },
    archivedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

supplierSchema.index({ restaurant: 1, name: 1 }, { unique: true });
supplierSchema.index({ restaurant: 1, code: 1 }, { unique: true, sparse: true });
supplierSchema.index({ isActive: 1, name: 1 });
supplierSchema.index({ "priceHistory.item": 1, isActive: 1 });
supplierSchema.index({ "invoices.dueDate": 1 });
supplierSchema.index({ balance: -1 });

export default mongoose.model("Supplier", supplierSchema);
