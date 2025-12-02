// src/backend/models/Settings.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const receiptTemplateSchema = new Schema(
  {
    fontFamily: { type: String, default: "monospace" },
    fontSize: { type: Number, default: 13 },
    headerAlign: { type: String, enum: ["left", "center", "right"], default: "center" },
    bodyAlign: { type: String, enum: ["left", "center", "right"], default: "left" },
    footerAlign: { type: String, enum: ["left", "center", "right"], default: "center" },
    accentSymbol: { type: String, default: "─" },
    dividerStyle: { type: String, enum: ["dashed", "solid", "double", "accent"], default: "dashed" },
    boldTotals: { type: Boolean, default: true },
    showLogo: { type: Boolean, default: true },
    showTaxBreakdown: { type: Boolean, default: true },
    showDiscount: { type: Boolean, default: true },
    showQr: { type: Boolean, default: false },
    qrLabel: { type: String, default: "" },
    qrValue: { type: String, default: "" },
    lineHeight: { type: Number, default: 1.4 },
    columnsLayout: { type: String, enum: ["simple", "two-column"], default: "two-column" },
    customMessage: { type: String, default: "" },
  },
  { _id: false }
);

const printerDeviceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ["front", "kitchen", "bar", "delivery", "custom"],
      default: "front",
    },
    location: { type: String, trim: true, default: "" },
    connectionType: {
      type: String,
      enum: ["network", "usb", "bluetooth"],
      default: "network",
    },
    dispatchMode: {
      type: String,
      enum: ["direct", "agent"],
      default: "direct",
    },
    agentChannel: { type: String, trim: true, default: "" },
    ipAddress: { type: String, trim: true, default: "" },
    port: { type: Number, default: 9100 },
    paperWidth: { type: String, enum: ["58mm", "80mm"], default: "80mm" },
    printerType: {
      type: String,
      enum: ["thermal", "inkjet", "laser"],
      default: "thermal",
    },
    autoprint: { type: Boolean, default: false },
    autoPrintTriggers: {
      type: [String],
      default: () => ["payment"],
    },
    copies: { type: Number, default: 1, min: 1, max: 5 },
    headerText: { type: String, trim: true, default: "" },
    footerText: { type: String, trim: true, default: "" },
    logoUrl: { type: String, trim: true, default: "" },
    templateOverrides: { type: Schema.Types.Mixed, default: {} },
    enabled: { type: Boolean, default: true },
    connectionStatus: {
      type: String,
      enum: ["connected", "disconnected", "testing"],
      default: "disconnected",
    },
    lastTestPrintDate: { type: Date },
    lastConnectionTest: { type: Date },
    lastPrintDate: { type: Date },
    lastPrintError: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
  },
  { _id: true }
);

const printerSettingsSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    connectionType: {
      type: String,
      default: "network",
      enum: ["network", "usb", "bluetooth"],
    },
    dispatchMode: {
      type: String,
      enum: ["direct", "agent"],
      default: "direct",
    },
    printerName: { type: String, default: "Default Printer" },
    ipAddress: { type: String, default: "192.168.1.100" },
    port: { type: Number, default: 9100 },
    paperWidth: { type: String, default: "80mm", enum: ["58mm", "80mm"] },
    printerType: {
      type: String,
      default: "thermal",
      enum: ["thermal", "inkjet", "laser"],
    },
    autoprint: { type: Boolean, default: false },
    printCopies: { type: Number, default: 1 },
    printLogo: { type: Boolean, default: true },
    printRestaurantName: { type: Boolean, default: true },
    printTableNumber: { type: Boolean, default: true },
    printWaiterName: { type: Boolean, default: true },
    printTimestamp: { type: Boolean, default: true },
    printPaymentMethod: { type: Boolean, default: true },
    printQRCode: { type: Boolean, default: false },
    headerText: { type: String, default: "ZarPOS Restoran" },
    footerText: { type: String, default: "Raxmat, qayta ko'ring!" },
    lastTestPrintDate: { type: Date },
    lastPrintDate: { type: Date },
    lastPrintError: { type: String, default: "" },
    connectionStatus: {
      type: String,
      default: "disconnected",
      enum: ["connected", "disconnected", "testing"],
    },
    agentChannel: { type: String, default: "default" },
    printers: { type: [printerDeviceSchema], default: [] },
    defaultPrinterId: { type: Schema.Types.ObjectId, default: null },
    receiptTemplate: {
      type: receiptTemplateSchema,
      default: () => ({}),
    },
  },
  { _id: false }
);

const settingsSchema = new mongoose.Schema({
  // Umumiy sozlamalar
  restaurant: { type: Schema.Types.ObjectId, ref: "Restaurant", index: true },
  restaurantName: { type: String, default: "ZarPOS Restoran" },
  restaurantAddress: { type: String, default: "" },
  restaurantPhone: { type: String, default: "" },
  restaurantEmail: { type: String, default: "" },
  logo: { type: String, default: "" },
  
  // Valyuta va til
  currency: { type: String, default: "UZS", enum: ["UZS", "USD", "EUR", "RUB"] },
  language: { type: String, default: "uz", enum: ["uz", "ru", "en"] },
  timezone: { type: String, default: "Asia/Tashkent" },
  
  // Soliq sozlamalari
  taxSettings: {
    enabled: { type: Boolean, default: true },
    taxRate: { type: Number, default: 0.12 }, // 12%
    taxName: { type: String, default: "QQS" },
    includeInPrice: { type: Boolean, default: false }, // Narxga kiritilgan yoki alohida
    serviceCharge: { type: Number, default: 0 }, // Xizmat haq (%)
    serviceChargeEnabled: { type: Boolean, default: false },
    showOnReceipt: { type: Boolean, default: true }
  },

  // Soliq integratsiyasi (iiko yoki boshqa tizim)
  taxIntegration: {
    enabled: { type: Boolean, default: false },
    provider: { type: String, default: "iiko" },
    mode: { type: String, enum: ["sandbox", "production"], default: "sandbox" },
    apiBaseUrl: { type: String, default: "https://api.iiko.services" },
    apiLogin: { type: String, default: "demo-pos" },
    apiKey: { type: String, default: "" },
    organizationId: { type: String, default: "DEFAULT_ORG" },
    defaultVatRate: { type: Number, default: 12 },
    autoFiscalize: { type: Boolean, default: true },
    lastSyncStatus: { type: String, default: "never" },
    lastSyncedAt: { type: Date, default: null }
  },
  
  // Chegirma sozlamalari
  discountSettings: {
    maxDiscountPercent: { type: Number, default: 50 },
    requireManagerApproval: { type: Boolean, default: true }, // Katta chegirmalar uchun ruxsat
    allowCouponCodes: { type: Boolean, default: true }
  },
  
  // Printer sozlamalar
  printerSettings: { type: printerSettingsSchema, default: () => ({}) },
  
  // To'lov sozlamalari
  paymentSettings: {
    acceptCash: { type: Boolean, default: true },
    acceptCard: { type: Boolean, default: true },
    acceptQR: { type: Boolean, default: true },
    acceptCrypto: { type: Boolean, default: false },
    allowSplitPayment: { type: Boolean, default: true },
    allowPartialPayment: { type: Boolean, default: false },
    roundingEnabled: { type: Boolean, default: true },
    roundingAmount: { type: Number, default: 100 }, // 100 so'mga yaxlitlash
    tipEnabled: { type: Boolean, default: true },
    suggestedTipPercents: [{ type: Number }], // [5, 10, 15, 20]
  },
  
  // Buyurtma sozlamalari
  orderSettings: {
    allowTableOrdering: { type: Boolean, default: true },
    allowDelivery: { type: Boolean, default: true },
    allowTakeaway: { type: Boolean, default: true },
    autoAcceptOrders: { type: Boolean, default: false },
    orderTimeout: { type: Number, default: 30 }, // daqiqa
    minOrderAmount: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 5000 },
    freeDeliveryThreshold: { type: Number, default: 50000 }
  },
  
  // Stol sozlamalari
  tableSettings: {
    autoAssignTable: { type: Boolean, default: false },
    tableSessionTimeout: { type: Number, default: 180 }, // daqiqa
    allowTableMerge: { type: Boolean, default: true },
    allowTableTransfer: { type: Boolean, default: true }
  },
  
  // Xodim sozlamalari
  staffSettings: {
    requirePinLogin: { type: Boolean, default: true },
    pinLength: { type: Number, default: 4 },
    sessionTimeout: { type: Number, default: 60 }, // daqiqa
    trackWorkingHours: { type: Boolean, default: true },
    allowMultipleLogins: { type: Boolean, default: false }
  },
  
  // Xavfsizlik sozlamalari
  securitySettings: {
    requireManagerApproval: {
      forDiscounts: { type: Boolean, default: true },
      forVoids: { type: Boolean, default: true },
      forRefunds: { type: Boolean, default: true },
      forPriceChanges: { type: Boolean, default: true }
    },
    enableAuditLog: { type: Boolean, default: true },
    backupFrequency: { type: String, default: "daily", enum: ["hourly", "daily", "weekly"] },
    dataRetentionDays: { type: Number, default: 365 }
  },
  
  // Hisobot sozlamalari
  reportSettings: {
    autoGenerateReports: { type: Boolean, default: true },
    reportFrequency: { type: String, default: "daily", enum: ["daily", "weekly", "monthly"] },
    emailReports: { type: Boolean, default: false },
    reportEmail: { type: String, default: "" },
    includeDetailedSales: { type: Boolean, default: true },
    includeInventory: { type: Boolean, default: true }
  },
  
  // Bildirishnoma sozlamalari
  notificationSettings: {
    enableNotifications: { type: Boolean, default: true },
    soundEnabled: { type: Boolean, default: true },
    newOrderAlert: { type: Boolean, default: true },
    lowInventoryAlert: { type: Boolean, default: true },
    endOfDayAlert: { type: Boolean, default: true },
    emailNotifications: { type: Boolean, default: false },
    smsNotifications: { type: Boolean, default: false }
  },
  
  // Loyxat sozlamalari
  loyaltySettings: {
    enabled: { type: Boolean, default: false },
    pointsPerCurrency: { type: Number, default: 1 }, // 1000 so'm = 1 ball
    rewardThreshold: { type: Number, default: 100 }, // 100 ball = mukofot
    pointsExpireDays: { type: Number, default: 365 }
  },
  
  // Oshxona ekrani sozlamalari
  kitchenSettings: {
    enableKitchenDisplay: { type: Boolean, default: true },
    autoAcceptOrders: { type: Boolean, default: false },
    printToKitchen: { type: Boolean, default: true },
    soundAlert: { type: Boolean, default: true },
    priorityOrders: { type: Boolean, default: true }
  },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update timestamp
settingsSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model("Settings", settingsSchema);