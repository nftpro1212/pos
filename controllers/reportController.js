// src/backend/controllers/reportController.js
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";
import User from "../models/User.js";

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const PAYMENT_LABELS = {
  cash: "Naqd",
  card: "Karta",
  qr: "QR",
  mixed: "Aralash",
  split: "Bo'lib to'lash",
  online: "Online",
  terminal: "Terminal",
  transfer: "Bank o'tkazma",
  other: "Boshqa",
};

const ORDER_STATUS_LABELS = {
  new: "Yangi",
  in_progress: "Jarayonda",
  ready: "Tayyor",
  closed: "Yopilgan",
  cancelled: "Bekor qilingan",
};

const ORDER_TYPE_LABELS = {
  table: "Zalda",
  delivery: "Dostavka",
  soboy: "Olib ketish",
};

const resolveDateRange = (from, to) => {
  const toDate = to ? endOfDay(new Date(to)) : endOfDay(new Date());
  const defaultFrom = new Date(toDate);
  defaultFrom.setDate(defaultFrom.getDate() - 6);
  const fromDate = from ? startOfDay(new Date(from)) : startOfDay(defaultFrom);
  return { fromDate, toDate };
};

const formatDateShort = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
};

const formatDateTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("uz-UZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const buildSalesReport = async (fromDate, toDate) => {
  const orderFilter = { createdAt: { $gte: fromDate, $lte: toDate } };

  const [orders, payments] = await Promise.all([
    Order.find(orderFilter).lean(),
    Payment.find({ createdAt: { $gte: fromDate, $lte: toDate } }).lean(),
  ]);

  const itemSummary = new Map();
  const waiterSummary = new Map();

  const totals = orders.reduce(
    (acc, order) => {
      const total = Number(order?.total ?? 0) || 0;
      const subtotal = Number(order?.subtotal ?? 0) || 0;
      const tax = Number(order?.tax ?? 0) || 0;
      const discount = Number(order?.discount ?? 0) || 0;
      const itemCount = Array.isArray(order?.items)
        ? order.items.reduce((s, item) => s + (Number(item?.qty ?? 0) || 0), 0)
        : 0;
      const orderId = order?._id ? order._id.toString() : null;
      const isCancelled = order?.status === "cancelled";

      acc.totalSales += total;
      acc.totalTax += tax;
      acc.totalDiscount += discount;
      acc.totalItems += itemCount;

      const statusKey = order?.status || "unknown";
      acc.byStatus[statusKey] = (acc.byStatus[statusKey] || 0) + 1;

      const typeKey = order?.type || "table";
      acc.byType[typeKey] = (acc.byType[typeKey] || 0) + 1;

      const dayKey = new Date(order.createdAt).toISOString().slice(0, 10);
      acc.revenueByDay[dayKey] = (acc.revenueByDay[dayKey] || 0) + total;

      if (!isCancelled && Array.isArray(order?.items)) {
        order.items.forEach((item) => {
          const qty = Number(item?.qty ?? 0) || 0;
          if (qty <= 0) return;
          const price = Number(item?.price ?? 0) || 0;
          const revenue = price * qty;
          const itemKey = item?.menuItem
            ? item.menuItem.toString()
            : `name:${(item?.name || "no-name").toLowerCase()}`;

          if (!itemSummary.has(itemKey)) {
            itemSummary.set(itemKey, {
              menuItemId: item?.menuItem ? item.menuItem.toString() : null,
              name: item?.name || "No name",
              quantity: 0,
              revenue: 0,
              lineCount: 0,
              orderIds: new Set(),
            });
          }

          const summary = itemSummary.get(itemKey);
          summary.quantity += qty;
          summary.revenue += revenue;
          summary.lineCount += 1;
          if (orderId) summary.orderIds.add(orderId);
        });
      }

      if (!isCancelled && order?.createdBy) {
        const waiterKey = order.createdBy.toString();
        if (!waiterSummary.has(waiterKey)) {
          waiterSummary.set(waiterKey, {
            userId: waiterKey,
            orderCount: 0,
            itemsSold: 0,
            revenue: 0,
            subtotal: 0,
            taxCollected: 0,
            discountGiven: 0,
            tables: new Set(),
          });
        }

        const waiter = waiterSummary.get(waiterKey);
        waiter.orderCount += 1;
        waiter.itemsSold += itemCount;
        waiter.revenue += total;
        waiter.subtotal += subtotal;
        waiter.taxCollected += tax;
        waiter.discountGiven += discount;

        if (order?.table) {
          waiter.tables.add(order.table.toString());
        } else if (order?.tableName) {
          waiter.tables.add(order.tableName);
        }
      }

      return acc;
    },
    {
      totalSales: 0,
      totalTax: 0,
      totalDiscount: 0,
      totalItems: 0,
      byStatus: {},
      byType: { table: 0, delivery: 0, soboy: 0 },
      revenueByDay: {},
    }
  );

  const paymentBreakdown = payments.reduce(
    (acc, payment) => {
      const parts =
        Array.isArray(payment?.parts) && payment.parts.length > 0
          ? payment.parts
          : [
              {
                method: payment?.method || "cash",
                amount: payment?.totalAmount || payment?.amount || 0,
              },
            ];

      parts.forEach((part) => {
        const method = part?.method || "other";
        const amount = Number(part?.amount ?? 0) || 0;
        acc.methods[method] = (acc.methods[method] || 0) + amount;
        acc.total += amount;
      });

      return acc;
    },
    { total: 0, methods: {} }
  );

  const ordersCount = orders.length;
  const avgOrderValue = ordersCount > 0 ? totals.totalSales / ordersCount : 0;
  const averageItemsPerOrder = ordersCount > 0 ? totals.totalItems / ordersCount : 0;

  const revenueTrend = Object.entries(totals.revenueByDay)
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([date, total]) => ({ date, total }));

  const itemBreakdown = Array.from(itemSummary.values())
    .map((item) => ({
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      revenue: item.revenue,
      averagePrice: item.quantity ? item.revenue / item.quantity : 0,
      orderCount: item.orderIds ? item.orderIds.size : item.lineCount,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const waiterIds = Array.from(waiterSummary.keys()).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const waiterDocs = waiterIds.length ? await User.find({ _id: { $in: waiterIds } }).select("name role") : [];
  const waiterLookup = new Map(waiterDocs.map((doc) => [doc._id.toString(), doc]));

  const waiterStats = Array.from(waiterSummary.values())
    .map((entry) => {
      const info = waiterLookup.get(entry.userId) || {};
      const tablesServed = entry.tables.size;
      return {
        userId: entry.userId,
        name: info.name || "Noma'lum",
        role: info.role || "unknown",
        orderCount: entry.orderCount,
        tablesServed,
        itemsSold: entry.itemsSold,
        grossSales: entry.subtotal + entry.taxCollected,
        netSales: entry.revenue,
        taxCollected: entry.taxCollected,
        discountGiven: entry.discountGiven,
        averageOrderValue: entry.orderCount ? entry.revenue / entry.orderCount : 0,
      };
    })
    .sort((a, b) => b.netSales - a.netSales);

  const topItems = itemBreakdown.slice(0, 6);

  const recentOrders = orders
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 12)
    .map((order) => ({
      _id: order._id,
      total: order.total,
      tax: order.tax,
      discount: order.discount,
      status: order.status,
      type: order.type,
      tableName: order.tableName,
      createdAt: order.createdAt,
    }));

  const report = {
    dateRange: { from: fromDate, to: toDate },
    generatedAt: new Date(),
    totals: {
      grossSales: totals.totalSales,
      netSales: totals.totalSales - totals.totalDiscount,
      taxCollected: totals.totalTax,
      discountGiven: totals.totalDiscount,
      ordersCount,
      paymentsCount: payments.length,
      avgOrderValue,
      averageItemsPerOrder,
    },
    distribution: {
      byStatus: totals.byStatus,
      byType: totals.byType,
      paymentMethods: paymentBreakdown.methods,
    },
    revenueTrend,
    topItems,
    detail: {
      menuItems: itemBreakdown,
      waiters: waiterStats,
    },
    recentOrders,
  };

  return { report, orders, payments };
};

export const salesReport = async (req, res) => {
  try {
    const { fromDate, toDate } = resolveDateRange(req.query.from, req.query.to);
    const { report } = await buildSalesReport(fromDate, toDate);
    res.json(report);
  } catch (error) {
    console.error("salesReport error", error);
    res.status(500).json({ message: "Hisobotni shakllantirishda xatolik yuz berdi" });
  }
};

export const salesReportExport = async (req, res) => {
  try {
    const { fromDate, toDate } = resolveDateRange(req.query.from, req.query.to);
    const { report, orders } = await buildSalesReport(fromDate, toDate);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "POS System";
    workbook.created = new Date();

    const numberFormatter = new Intl.NumberFormat("uz-UZ");
    const formatCurrency = (value) => `${numberFormatter.format(Math.round(Number(value) || 0))} so'm`;
    const formatNumber = (value) => numberFormatter.format(Math.round(Number(value) || 0));

    const fromLabel = formatDateShort(fromDate);
    const toLabel = formatDateShort(toDate);
    const dateLabel = `${fromLabel} — ${toLabel}`;

    const summarySheet = workbook.addWorksheet("Umumiy");
    summarySheet.columns = [
      { header: "Ko'rsatkich", key: "label", width: 36 },
      { header: "Qiymat", key: "value", width: 28 },
    ];
    summarySheet.addRows([
      { label: "Hisobot davri", value: dateLabel },
      { label: "Umumiy tushum", value: formatCurrency(report.totals.grossSales) },
      { label: "Sof tushum", value: formatCurrency(report.totals.netSales) },
      { label: "Servis yig'imi", value: formatCurrency(report.totals.taxCollected) },
      { label: "Chegirmalar", value: formatCurrency(report.totals.discountGiven) },
      { label: "Buyurtmalar soni", value: formatNumber(report.totals.ordersCount) },
      { label: "To'lovlar soni", value: formatNumber(report.totals.paymentsCount) },
      { label: "O'rtacha chek", value: formatCurrency(report.totals.avgOrderValue) },
      { label: "O'rtacha pozitsiya", value: Number(report.totals.averageItemsPerOrder || 0).toFixed(2) },
      { label: "Hisobot tuzilgan", value: formatDateTime(report.generatedAt) },
    ]);
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getColumn(1).font = { bold: true };

    const paymentSheet = workbook.addWorksheet("To'lov usullari");
    paymentSheet.columns = [
      { header: "Usul", key: "method", width: 24 },
      { header: "Summa", key: "amount", width: 18 },
      { header: "Ulash", key: "share", width: 12 },
    ];
    const paymentTotal = Object.values(report.distribution.paymentMethods || {}).reduce(
      (sum, amount) => sum + (Number(amount) || 0),
      0
    );
    const paymentEntries = Object.entries(report.distribution.paymentMethods || {}).map(([method, amount]) => ({
      method: PAYMENT_LABELS[method] || method,
      amount: Number(amount || 0),
      share: paymentTotal ? `${(((amount || 0) / paymentTotal) * 100).toFixed(2)}%` : "-",
    }));
    paymentSheet.addRows(paymentEntries.length ? paymentEntries : [{ method: "Ma'lumot mavjud emas", amount: 0, share: "-" }]);
    paymentSheet.getRow(1).font = { bold: true };
    paymentSheet.getColumn(2).numFmt = '#,##0" so\'m"';

    const trendSheet = workbook.addWorksheet("Kunlik tushum");
    trendSheet.columns = [
      { header: "Sana", key: "date", width: 16 },
      { header: "Tushum", key: "total", width: 20 },
    ];
    trendSheet.addRows(
      (report.revenueTrend || []).map((row) => ({
        date: row.date,
        total: Number(row.total || 0),
      }))
    );
    trendSheet.getRow(1).font = { bold: true };
    trendSheet.getColumn(2).numFmt = '#,##0" so\'m"';

    const menuSheet = workbook.addWorksheet("Taomlar");
    menuSheet.columns = [
      { header: "Taom nomi", key: "name", width: 34 },
      { header: "Buyurtma", key: "orderCount", width: 14 },
      { header: "Soni", key: "quantity", width: 14 },
      { header: "O'rtacha narx", key: "averagePrice", width: 18 },
      { header: "Tushum", key: "revenue", width: 18 },
    ];
    menuSheet.addRows(
      (report.detail.menuItems || []).map((item) => ({
        name: item.name,
        orderCount: Number(item.orderCount || 0),
        quantity: Number(item.quantity || 0),
        averagePrice: Number((item.averagePrice || 0).toFixed(2)),
        revenue: Number(item.revenue || 0),
      }))
    );
    menuSheet.getRow(1).font = { bold: true };
    menuSheet.getColumn(4).numFmt = '#,##0.00" so\'m"';
    menuSheet.getColumn(5).numFmt = '#,##0" so\'m"';

    const waiterSheet = workbook.addWorksheet("Ofitsiantlar");
    waiterSheet.columns = [
      { header: "Ofitsiant", key: "name", width: 26 },
      { header: "Roli", key: "role", width: 16 },
      { header: "Buyurtma", key: "orderCount", width: 14 },
      { header: "Stol", key: "tablesServed", width: 14 },
      { header: "Pozitsiya", key: "itemsSold", width: 14 },
      { header: "Net tushum", key: "netSales", width: 18 },
      { header: "Servis", key: "taxCollected", width: 16 },
      { header: "Chegirma", key: "discountGiven", width: 16 },
      { header: "O'rtacha chek", key: "averageOrderValue", width: 18 },
    ];
    waiterSheet.addRows(
      (report.detail.waiters || []).map((waiter) => ({
        name: waiter.name,
        role: waiter.role,
        orderCount: Number(waiter.orderCount || 0),
        tablesServed: Number(waiter.tablesServed || 0),
        itemsSold: Number(waiter.itemsSold || 0),
        netSales: Number(waiter.netSales || 0),
        taxCollected: Number(waiter.taxCollected || 0),
        discountGiven: Number(waiter.discountGiven || 0),
        averageOrderValue: Number((waiter.averageOrderValue || 0).toFixed(2)),
      }))
    );
    waiterSheet.getRow(1).font = { bold: true };
    [6, 7, 8, 9].forEach((col) => {
      waiterSheet.getColumn(col).numFmt = '#,##0.00" so\'m"';
    });

    const ordersSheet = workbook.addWorksheet("Buyurtmalar");
    ordersSheet.columns = [
      { header: "Buyurtma ID", key: "id", width: 26 },
      { header: "Sana", key: "createdAt", width: 22 },
      { header: "Turi", key: "type", width: 18 },
      { header: "Status", key: "status", width: 20 },
      { header: "Stol / Kanal", key: "tableName", width: 22 },
      { header: "Pozitsiya", key: "items", width: 14 },
      { header: "Chegirma", key: "discount", width: 16 },
      { header: "Servis", key: "tax", width: 16 },
      { header: "Jami", key: "total", width: 18 },
    ];
    ordersSheet.addRows(
      orders.map((order) => ({
        id: order._id?.toString(),
        createdAt: formatDateTime(order.createdAt),
        type: ORDER_TYPE_LABELS[order.type] || order.type || "-",
        status: ORDER_STATUS_LABELS[order.status] || order.status || "-",
        tableName: order.tableName || "-",
        items: Array.isArray(order.items)
          ? order.items.reduce((sum, item) => sum + (Number(item?.qty ?? 0) || 0), 0)
          : 0,
        discount: Number(order.discount || 0),
        tax: Number(order.tax || 0),
        total: Number(order.total || 0),
      }))
    );
    ordersSheet.getRow(1).font = { bold: true };
    [7, 8, 9].forEach((col) => {
      ordersSheet.getColumn(col).numFmt = '#,##0" so\'m"';
    });

    const filename = `hisobot-${fromLabel}-${toLabel}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("salesReportExport error", error);
    res.status(500).json({ message: "Excel faylini tayyorlashda xatolik yuz berdi" });
  }
};