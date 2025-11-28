// src/backend/controllers/reportController.js
import {
  buildSalesReport,
  resolveDateRange,
  createSalesReportWorkbook,
  formatDateShort,
} from "../services/reportService.js";

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

    const buffer = await createSalesReportWorkbook({ report, orders, fromDate, toDate });
    const filename = `hisobot-${formatDateShort(fromDate)}-${formatDateShort(toDate)}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("salesReportExport error", error);
    res.status(500).json({ message: "Excel faylini tayyorlashda xatolik yuz berdi" });
  }
};