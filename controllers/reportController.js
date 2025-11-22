// src/backend/controllers/reportController.js
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";

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

export const salesReport = async (req, res) => {
  try {
    const { from, to } = req.query;

    const toDate = to ? endOfDay(new Date(to)) : endOfDay(new Date());
    const defaultFrom = new Date(toDate);
    defaultFrom.setDate(defaultFrom.getDate() - 6);
    const fromDate = from ? startOfDay(new Date(from)) : startOfDay(defaultFrom);

    const orderFilter = { createdAt: { $gte: fromDate, $lte: toDate } };

    const [orders, payments] = await Promise.all([
      Order.find(orderFilter).lean(),
      Payment.find({ createdAt: { $gte: fromDate, $lte: toDate } }).lean(),
    ]);

    const totals = orders.reduce(
      (acc, order) => {
        const total = Number(order?.total ?? 0) || 0;
        const tax = Number(order?.tax ?? 0) || 0;
        const discount = Number(order?.discount ?? 0) || 0;
        const itemCount = Array.isArray(order?.items) ? order.items.reduce((s, item) => s + (Number(item?.qty ?? 0) || 0), 0) : 0;

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

        if (Array.isArray(order?.items)) {
          order.items.forEach((item) => {
            const name = item?.name || "No name";
            const qty = Number(item?.qty ?? 0) || 0;
            const price = Number(item?.price ?? 0) || 0;
            const revenue = price * qty;
            if (!acc.topItems[name]) {
              acc.topItems[name] = { name, quantity: 0, revenue: 0 };
            }
            acc.topItems[name].quantity += qty;
            acc.topItems[name].revenue += revenue;
          });
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
        topItems: {},
      }
    );

    const paymentBreakdown = payments.reduce(
      (acc, payment) => {
        const parts = Array.isArray(payment?.parts) && payment.parts.length > 0
          ? payment.parts
          : [{ method: payment?.method || "cash", amount: payment?.totalAmount || payment?.amount || 0 }];

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

    const topItems = Object.values(totals.topItems)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6);

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

    res.json({
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
      recentOrders,
    });
  } catch (error) {
    console.error("salesReport error", error);
    res.status(500).json({ message: "Hisobotni shakllantirishda xatolik yuz berdi" });
  }
};