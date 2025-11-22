// src/backend/controllers/supplierController.js
import mongoose from "mongoose";
import Supplier from "../models/Supplier.js";
import InventoryItem from "../models/InventoryItem.js";
import InventoryMovement from "../models/InventoryMovement.js";
import ActionLog from "../models/ActionLog.js";
import {
  toNumber,
  resolveWarehouse,
  getOrCreateStock,
  recalcItemTotals,
} from "../utils/inventoryHelpers.js";

const { Types } = mongoose;

const sanitizeSupplierPayload = (payload = {}) => {
  const cleaned = {};

  if (payload.name !== undefined) cleaned.name = payload.name?.toString?.().trim();
  if (payload.code !== undefined) cleaned.code = payload.code?.toString?.().trim().toUpperCase() || undefined;
  if (payload.companyName !== undefined) cleaned.companyName = payload.companyName?.toString?.().trim() || "";
  if (payload.taxId !== undefined) cleaned.taxId = payload.taxId?.toString?.().trim() || "";
  if (payload.categories !== undefined && Array.isArray(payload.categories)) {
    cleaned.categories = payload.categories.map((value) => value?.toString?.().trim()).filter(Boolean);
  }

  if (payload.contact !== undefined) {
    const contact = payload.contact || {};
    cleaned.contact = {
      person: contact.person?.toString?.().trim() || "",
      phone: contact.phone?.toString?.().trim() || "",
      email: contact.email?.toString?.().trim() || "",
      whatsapp: contact.whatsapp?.toString?.().trim() || "",
      telegram: contact.telegram?.toString?.().trim() || "",
    };
  }

  if (payload.address !== undefined) {
    const address = payload.address || {};
    cleaned.address = {
      street: address.street?.toString?.().trim() || "",
      city: address.city?.toString?.().trim() || "",
      state: address.state?.toString?.().trim() || "",
      country: address.country?.toString?.().trim() || "",
      postalCode: address.postalCode?.toString?.().trim() || "",
    };
  }

  if (payload.currency !== undefined) cleaned.currency = payload.currency?.toString?.().trim() || "UZS";
  if (payload.paymentTerms !== undefined) cleaned.paymentTerms = payload.paymentTerms?.toString?.().trim() || "";
  if (payload.notes !== undefined) cleaned.notes = payload.notes?.toString?.().trim() || "";
  if (payload.metadata !== undefined) cleaned.metadata = payload.metadata;

  if (payload.isActive !== undefined) cleaned.isActive = Boolean(payload.isActive);

  return cleaned;
};


export const listSuppliers = async (req, res) => {
  try {
    const { search = "", status = "active" } = req.query;
    const query = {};

    if (status === "inactive") query.isActive = false;
    else if (status === "all") {
      // barcha holatlar
    } else query.isActive = true;

    if (search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      query.$or = [
        { name: regex },
        { companyName: regex },
        { "contact.person": regex },
        { "contact.phone": regex },
      ];
    }

    const suppliers = await Supplier.find(query)
      .sort({ isActive: -1, balance: -1, name: 1 })
      .lean();

    const totals = suppliers.reduce(
      (acc, supplier) => {
        acc.count += 1;
        acc.active += supplier.isActive ? 1 : 0;
        acc.totalBalance += supplier.balance || 0;
        return acc;
      },
      { count: 0, active: 0, totalBalance: 0 }
    );

    res.json({ suppliers, totals });
  } catch (err) {
    console.error("listSuppliers error", err);
    res.status(500).json({ message: "Yetkazib beruvchilar ro'yxatini olishda xatolik" });
  }
};

export const createSupplier = async (req, res) => {
  try {
    const payload = sanitizeSupplierPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({ message: "Yetkazib beruvchi nomi talab qilinadi" });
    }

    const supplier = await Supplier.create(payload);

    await ActionLog.create({
      user: req.user?._id,
      action: "supplier_create",
      details: `Yangi yetkazib beruvchi: ${supplier.name}`,
      metadata: { supplierId: supplier._id },
    });

    res.status(201).json(supplier);
  } catch (err) {
    console.error("createSupplier error", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Bu nom yoki koddagi yetkazib beruvchi mavjud" });
    }
    res.status(500).json({ message: "Yetkazib beruvchini yaratishda xatolik" });
  }
};

export const updateSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri yetkazib beruvchi ID" });
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      return res.status(404).json({ message: "Yetkazib beruvchi topilmadi" });
    }

    const payload = sanitizeSupplierPayload(req.body);
    Object.assign(supplier, payload);

    if (payload.isActive === true) supplier.archivedAt = null;
    if (payload.isActive === false) supplier.archivedAt = new Date();

    await supplier.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "supplier_update",
      details: `Yetkazib beruvchi yangilandi: ${supplier.name}`,
      metadata: { supplierId: supplier._id },
    });

    res.json(supplier);
  } catch (err) {
    console.error("updateSupplier error", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Bu nom yoki koddagi yetkazib beruvchi mavjud" });
    }
    res.status(500).json({ message: "Yetkazib beruvchini yangilashda xatolik" });
  }
};

export const archiveSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri yetkazib beruvchi ID" });
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      return res.status(404).json({ message: "Yetkazib beruvchi topilmadi" });
    }

    supplier.isActive = false;
    supplier.archivedAt = new Date();
    await supplier.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "supplier_archive",
      details: `Yetkazib beruvchi arxivlandi: ${supplier.name}`,
      metadata: { supplierId: supplier._id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("archiveSupplier error", err);
    res.status(500).json({ message: "Yetkazib beruvchini arxivlashda xatolik" });
  }
};

export const getSupplierLedger = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri yetkazib beruvchi ID" });
    }

    const supplier = await Supplier.findById(id)
      .select("name companyName balance currency totalPurchases totalPayments priceHistory payments invoices isActive")
      .populate({ path: "priceHistory.item", select: "name unit" })
      .populate({ path: "priceHistory.warehouse", select: "name code" })
      .populate({ path: "priceHistory.recordedBy", select: "name" })
      .populate({ path: "payments.recordedBy", select: "name" })
      .lean();

    if (!supplier) {
      return res.status(404).json({ message: "Yetkazib beruvchi topilmadi" });
    }

    const recentPriceHistory = (supplier.priceHistory || []).slice(-50).reverse();
    const recentPayments = (supplier.payments || []).slice(-50).reverse();

    res.json({
      supplier: {
        _id: supplier._id,
        name: supplier.name,
        companyName: supplier.companyName,
        balance: supplier.balance,
        currency: supplier.currency,
        totalPurchases: supplier.totalPurchases,
        totalPayments: supplier.totalPayments,
        isActive: supplier.isActive,
      },
      priceHistory: recentPriceHistory,
      payments: recentPayments,
      invoices: supplier.invoices || [],
    });
  } catch (err) {
    console.error("getSupplierLedger error", err);
    res.status(500).json({ message: "Yetkazib beruvchi bo'yicha hisob-kitobni olishda xatolik" });
  }
};

export const recordSupplierPurchase = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri yetkazib beruvchi ID" });
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      return res.status(404).json({ message: "Yetkazib beruvchi topilmadi" });
    }
    if (!supplier.isActive) {
      return res.status(400).json({ message: "Arxivlangan yetkazib beruvchi bilan kirim kiritib bo'lmaydi" });
    }

    const {
      itemId,
      warehouseId,
      quantity,
      unitCost,
      currency = supplier.currency || "UZS",
      note = "",
      reference = "",
      invoiceNumber = "",
      invoiceDate,
      dueDate,
    } = req.body;

    if (!Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ message: "Noto'g'ri mahsulot ID" });
    }

    const numericQty = Math.max(0, toNumber(quantity, null));
    if (!numericQty || numericQty <= 0) {
      return res.status(400).json({ message: "Kirim miqdorini to'g'ri kiriting" });
    }

    const numericCost = Math.max(0, toNumber(unitCost, null));
    if (!numericCost || numericCost <= 0) {
      return res.status(400).json({ message: "Mahsulot birligi narxini kiriting" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) {
      return res.status(404).json({ message: "Mahsulot topilmadi" });
    }

    let warehouse;
    try {
      warehouse = await resolveWarehouse(warehouseId || item.defaultWarehouse);
    } catch (error) {
      return res.status(404).json({ message: error.message });
    }

    const stockDoc = await getOrCreateStock(item, warehouse, { parLevel: item.parLevel });

    const now = new Date();
    const totalCost = numericQty * numericCost;

    stockDoc.quantity = (stockDoc.quantity || 0) + numericQty;
    stockDoc.lastMovementAt = now;
    await stockDoc.save();

    const currentStockBefore = item.currentStock || 0;
    const newTotalQuantity = currentStockBefore + numericQty;
    if (newTotalQuantity > 0) {
      const currentValuation = currentStockBefore * (item.cost || 0);
      const newValuation = numericQty * numericCost;
      item.cost = (currentValuation + newValuation) / newTotalQuantity;
    } else {
      item.cost = numericCost;
    }

    item.currentStock = await recalcItemTotals(item._id);
    item.lastRestockDate = now;
    await item.save();

    const movement = await InventoryMovement.create({
      item: item._id,
      type: "incoming",
      quantity: numericQty,
      delta: numericQty,
      balanceAfter: stockDoc.quantity,
      unit: item.unit,
      warehouse: warehouse._id,
      supplier: supplier._id,
      reason: note?.toString?.().trim() || "",
      reference: reference?.toString?.().trim() || "",
      createdBy: req.user?._id,
      unitCost: numericCost,
      totalCost,
    });

    supplier.priceHistory.push({
      item: item._id,
      itemName: item.name,
      unit: item.unit,
      unitCost: numericCost,
      quantity: numericQty,
      totalCost,
      currency,
      warehouse: warehouse._id,
      recordedBy: req.user?._id,
      note: note?.toString?.().trim() || "",
      reference: reference?.toString?.().trim() || "",
      invoiceNumber: invoiceNumber?.toString?.().trim() || "",
      invoiceDate: invoiceDate ? new Date(invoiceDate) : null,
      dueDate: dueDate ? new Date(dueDate) : null,
    });

    if (supplier.priceHistory.length > 200) {
      supplier.priceHistory = supplier.priceHistory.slice(-200);
    }

    supplier.balance = (supplier.balance || 0) + totalCost;
    supplier.totalPurchases = (supplier.totalPurchases || 0) + totalCost;
    supplier.lastPurchaseDate = now;
    await supplier.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "supplier_purchase",
      details: `${supplier.name} → ${item.name} (${numericQty} ${item.unit})`,
      metadata: {
        supplierId: supplier._id,
        itemId: item._id,
        warehouseId: warehouse._id,
        quantity: numericQty,
        unitCost: numericCost,
        totalCost,
      },
    });

    res.status(201).json({
      supplier,
      item,
      movement,
      stock: {
        warehouseId: warehouse._id,
        quantity: stockDoc.quantity,
      },
    });
  } catch (err) {
    console.error("recordSupplierPurchase error", err);
    res.status(500).json({ message: "Yetkazib beruvchi bo'yicha kirimni qayd etishda xatolik" });
  }
};

export const recordSupplierPayment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri yetkazib beruvchi ID" });
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      return res.status(404).json({ message: "Yetkazib beruvchi topilmadi" });
    }

    const { amount, method = "cash", reference = "", note = "", paidAt } = req.body;
    const numericAmount = Math.max(0, toNumber(amount, null));
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ message: "To'lov summasini to'g'ri kiriting" });
    }

    const paymentRecord = {
      amount: numericAmount,
      method: method?.toString?.().trim() || "cash",
      reference: reference?.toString?.().trim() || "",
      note: note?.toString?.().trim() || "",
      recordedBy: req.user?._id,
      paidAt: paidAt ? new Date(paidAt) : new Date(),
    };

    supplier.payments.push(paymentRecord);
    if (supplier.payments.length > 200) {
      supplier.payments = supplier.payments.slice(-200);
    }

    supplier.balance = Math.max(0, (supplier.balance || 0) - numericAmount);
    supplier.totalPayments = (supplier.totalPayments || 0) + numericAmount;
    await supplier.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "supplier_payment",
      details: `${supplier.name} uchun ${numericAmount} ${supplier.currency} to'lov qayd etildi`,
      metadata: { supplierId: supplier._id, amount: numericAmount, method: paymentRecord.method },
    });

    res.status(201).json({ supplier, payment: paymentRecord });
  } catch (err) {
    console.error("recordSupplierPayment error", err);
    res.status(500).json({ message: "Yetkazib beruvchi to'lovini qayd etishda xatolik" });
  }
};

export const attachSupplierInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri yetkazib beruvchi ID" });
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      return res.status(404).json({ message: "Yetkazib beruvchi topilmadi" });
    }

    const {
      number = "",
      amount,
      currency = supplier.currency || "UZS",
      issuedDate,
      dueDate,
      fileName = "",
      filePath = "",
      fileUrl = "",
      note = "",
      status = "pending",
    } = req.body;

    const numericAmount = Math.max(0, toNumber(amount, 0));

    const invoiceRecord = {
      number: number?.toString?.().trim() || "",
      amount: numericAmount,
      currency: currency?.toString?.().trim() || supplier.currency || "UZS",
      issuedDate: issuedDate ? new Date(issuedDate) : null,
      dueDate: dueDate ? new Date(dueDate) : null,
      fileName: fileName?.toString?.().trim() || "",
      filePath: filePath?.toString?.().trim() || "",
      fileUrl: fileUrl?.toString?.().trim() || "",
      note: note?.toString?.().trim() || "",
      uploadedBy: req.user?._id,
      status,
      uploadedAt: new Date(),
    };

    supplier.invoices.push(invoiceRecord);
    if (supplier.invoices.length > 200) {
      supplier.invoices = supplier.invoices.slice(-200);
    }

    await supplier.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "supplier_invoice_attach",
      details: `${supplier.name} uchun invoice qo'shildi (${invoiceRecord.number || "raqamsiz"})`,
      metadata: { supplierId: supplier._id, invoiceNumber: invoiceRecord.number },
    });

    res.status(201).json({ supplier, invoice: invoiceRecord });
  } catch (err) {
    console.error("attachSupplierInvoice error", err);
    res.status(500).json({ message: "Invoice ma'lumotini qo'shishda xatolik" });
  }
};

export const recordSupplierReturn = async (req, res) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Noto'g'ri yetkazib beruvchi ID" });
    }

    const supplier = await Supplier.findById(id);
    if (!supplier) {
      return res.status(404).json({ message: "Yetkazib beruvchi topilmadi" });
    }

    const { itemId, warehouseId, quantity, unitCost, currency = supplier.currency || "UZS", note = "", reference = "" } =
      req.body;

    if (!Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ message: "Noto'g'ri mahsulot ID" });
    }

    const numericQty = Math.max(0, toNumber(quantity, null));
    if (!numericQty || numericQty <= 0) {
      return res.status(400).json({ message: "Qaytariluvchi miqdorni kiriting" });
    }

    const numericCost = Math.max(0, toNumber(unitCost, supplier.priceHistory?.slice(-1)[0]?.unitCost || 0));
    const item = await InventoryItem.findById(itemId);
    if (!item) {
      return res.status(404).json({ message: "Mahsulot topilmadi" });
    }

    let warehouse;
    try {
      warehouse = await resolveWarehouse(warehouseId || item.defaultWarehouse);
    } catch (error) {
      return res.status(404).json({ message: error.message });
    }

    const stockDoc = await getOrCreateStock(item, warehouse, { parLevel: item.parLevel });
    const availableQuantity = stockDoc.quantity || 0;
    const deduction = Math.min(availableQuantity, numericQty);
    const totalCost = deduction * numericCost;

    stockDoc.quantity = Math.max(0, availableQuantity - deduction);
    stockDoc.lastMovementAt = new Date();
    await stockDoc.save();

    item.currentStock = await recalcItemTotals(item._id);
    await item.save();

    const movement = await InventoryMovement.create({
      item: item._id,
      type: "return",
      quantity: deduction,
      delta: -deduction,
      balanceAfter: stockDoc.quantity,
      unit: item.unit,
      warehouse: warehouse._id,
      supplier: supplier._id,
      reason: note?.toString?.().trim() || "Yetkazib beruvchiga qaytarish",
      reference: reference?.toString?.().trim() || "",
      createdBy: req.user?._id,
      unitCost: numericCost,
      totalCost,
      metadata: {
        requestedQuantity: numericQty,
        deductedQuantity: deduction,
      },
    });

    supplier.balance = Math.max(0, (supplier.balance || 0) - totalCost);
    supplier.totalPurchases = Math.max(0, (supplier.totalPurchases || 0) - totalCost);
    supplier.priceHistory.push({
      item: item._id,
      itemName: item.name,
      unit: item.unit,
      unitCost: -numericCost,
      quantity: deduction,
      totalCost: -totalCost,
      currency,
      warehouse: warehouse._id,
      recordedBy: req.user?._id,
      note: `Return: ${note?.toString?.().trim() || ""}`.trim(),
      reference: reference?.toString?.().trim() || "",
    });
    if (supplier.priceHistory.length > 200) {
      supplier.priceHistory = supplier.priceHistory.slice(-200);
    }
    await supplier.save();

    await ActionLog.create({
      user: req.user?._id,
      action: "supplier_return",
      details: `${supplier.name} ga ${item.name} (${deduction} ${item.unit}) qaytarildi`,
      metadata: {
        supplierId: supplier._id,
        itemId: item._id,
        quantity: deduction,
        totalCost,
      },
    });

    res.status(201).json({ supplier, item, movement });
  } catch (err) {
    console.error("recordSupplierReturn error", err);
    res.status(500).json({ message: "Qaytarish jarayonida xatolik" });
  }
};
