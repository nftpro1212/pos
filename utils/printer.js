// src/backend/utils/printer.js
// Printer utilitlari: ko'p printer, ESC/POS va shrift shablonlarini qo'llab-quvvatlash

import net from "net";

const ESC = "\x1B";
const GS = "\x1D";

const alignMap = { left: 0, center: 1, right: 2 };

const currencyFormatter = new Intl.NumberFormat("uz-UZ");
const dateFormatter = new Intl.DateTimeFormat("uz-UZ");
const timeFormatter = new Intl.DateTimeFormat("uz-UZ", {
  hour: "2-digit",
  minute: "2-digit",
});

export const DEFAULT_RECEIPT_TEMPLATE = {
  fontFamily: "monospace",
  fontSize: 13,
  headerAlign: "center",
  bodyAlign: "left",
  footerAlign: "center",
  accentSymbol: "-",
  dividerStyle: "dashed",
  boldTotals: true,
  showLogo: true,
  showTaxBreakdown: true,
  showDiscount: true,
  showQr: false,
  qrLabel: "",
  qrValue: "",
  lineHeight: 1.45,
  columnsLayout: "two-column",
  customMessage: "",
};

const DEFAULT_TEST_ITEMS = [
  { name: "Latte", qty: 1, price: 18000 },
  { name: "Qo'y shashlik", qty: 2, price: 35000 },
  { name: "Cheesecake", qty: 1, price: 22000 },
];

const sanitizePaperWidth = (paperWidth) => (paperWidth === "58mm" ? "58mm" : "80mm");
const computeLineWidth = (paperWidth) => (sanitizePaperWidth(paperWidth) === "58mm" ? 32 : 42);

const safeText = (value, fallback = "") =>
  value === null || value === undefined ? fallback : String(value);

const clampDividerChar = (value) => {
  if (!value) return "-";
  const char = safeText(value).trim();
  return char.length === 1 ? char : "-";
};

export const mergeReceiptTemplate = (
  globalTemplate = {},
  printerOverrides = {},
  runtimeOverrides = {}
) => ({
  ...DEFAULT_RECEIPT_TEMPLATE,
  ...globalTemplate,
  ...printerOverrides,
  ...runtimeOverrides,
});

const buildDivider = (template, width) => {
  const style = template.dividerStyle || "dashed";
  if (style === "double") return "=".repeat(width);
  if (style === "solid") return "-".repeat(width);
  if (style === "accent") return clampDividerChar(template.accentSymbol).repeat(width);
  return `${clampDividerChar(template.accentSymbol)} `.repeat(Math.ceil(width / 2)).slice(0, width);
};

const formatTwoColumn = (left, right, width) => {
  const rightText = safeText(right);
  const available = Math.max(0, width - rightText.length - 1);
  let leftText = safeText(left);
  if (leftText.length > available) {
    leftText = `${leftText.slice(0, Math.max(available - 1, 0))}…`;
  }
  if (available <= 0) {
    return `${leftText}\n${rightText}`;
  }
  return `${leftText.padEnd(width - rightText.length, " ")}${rightText}`;
};

const normaliseItems = (rawItems = [], fallbackItems = []) => {
  const source = Array.isArray(rawItems) && rawItems.length ? rawItems : fallbackItems;
  return source.map((item) => {
    const qty = Number(item.qty ?? item.quantity ?? 1) || 1;
    const price = Number(item.price ?? item.unitPrice ?? 0) || 0;
    const name = safeText(item.name || item.title || item.menuItem?.name || "Mahsulot");
    return {
      name,
      qty,
      price,
      total: qty * price,
    };
  });
};

const buildOrderSnapshot = (order = {}, payment = {}, { restaurant = {}, isTest = false } = {}) => {
  const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
  const items = normaliseItems(order.items, isTest ? DEFAULT_TEST_ITEMS : []);
  const subtotal = typeof order.subtotal === "number" ? order.subtotal : items.reduce((acc, item) => acc + item.total, 0);
  const tax = typeof order.tax === "number" ? order.tax : Math.round(subtotal * 0.12);
  const discount = typeof order.discount === "number" ? order.discount : 0;
  const total = typeof order.total === "number" ? order.total : subtotal + tax - discount;

  const paymentParts = Array.isArray(payment?.parts) && payment.parts.length
    ? payment.parts.map((part) => ({
        method: safeText(part.method || part.type || "Naqd"),
        amount: Number(part.amount || 0) || 0,
      }))
    : payment?.method
    ? [
        {
          method: safeText(payment.method),
          amount: Number(payment.amount || total) || 0,
        },
      ]
    : [];

  return {
    items,
    subtotal,
    tax,
    discount,
    total,
    paymentParts,
    tableName: order.tableName || order.table?.name || (isTest ? "TEST STOLI" : ""),
    waiterName: order.waiterName || order.serverName || "",
    orderId: order._id ? safeText(order._id) : "",
    createdAt,
    restaurant: {
      name: restaurant.name || order.restaurantName || "ZarPOS Restoran",
      address: restaurant.address || "",
      phone: restaurant.phone || "",
      email: restaurant.email || "",
    },
  };
};

const writeEscPosLine = (commands, text = "", { align = "left", bold = false } = {}) => {
  const alignCode = alignMap[align] ?? 0;
  commands.push(ESC + "a" + String.fromCharCode(alignCode));
  commands.push(ESC + "E" + (bold ? "\x01" : "\x00"));
  commands.push(`${text}\n`);
};

const createEscPosSegment = (snapshot, template, printer, { copyIndex = 0, totalCopies = 1 } = {}) => {
  const width = computeLineWidth(printer?.paperWidth || template.paperWidth);
  const divider = buildDivider(template, width);
  const commands = [ESC + "@"];

  if (template.showLogo || printer?.headerText) {
    const title = safeText(printer?.headerText || snapshot.restaurant.name);
    writeEscPosLine(commands, title || "ZarPOS", { align: template.headerAlign, bold: true });
  }

  if (snapshot.restaurant.address) {
    writeEscPosLine(commands, snapshot.restaurant.address, { align: template.headerAlign });
  }
  if (snapshot.restaurant.phone) {
    writeEscPosLine(commands, `Tel: ${snapshot.restaurant.phone}`, { align: template.headerAlign });
  }

  writeEscPosLine(commands, divider, { align: template.bodyAlign });

  writeEscPosLine(commands, `Sana: ${dateFormatter.format(snapshot.createdAt)}`, { align: template.bodyAlign });
  writeEscPosLine(commands, `Vaqt: ${timeFormatter.format(snapshot.createdAt)}`, { align: template.bodyAlign });
  if (snapshot.tableName) {
    writeEscPosLine(commands, `Stol: ${snapshot.tableName}`, { align: template.bodyAlign });
  }
  if (snapshot.waiterName) {
    writeEscPosLine(commands, `Xizmatchi: ${snapshot.waiterName}`, { align: template.bodyAlign });
  }
  if (snapshot.orderId) {
    writeEscPosLine(commands, `Buyurtma: ${snapshot.orderId.slice(-6).toUpperCase()}`, { align: template.bodyAlign });
  }

  writeEscPosLine(commands, divider, { align: template.bodyAlign });

  snapshot.items.forEach((item) => {
    const line = template.columnsLayout === "simple"
      ? `${item.qty} x ${item.name}  ${currencyFormatter.format(item.total)} so'm`
      : formatTwoColumn(`${item.qty} x ${item.name}`, `${currencyFormatter.format(item.total)} so'm`, width);
    writeEscPosLine(commands, line, { align: template.bodyAlign });
  });

  writeEscPosLine(commands, divider, { align: template.bodyAlign });

  if (template.showTaxBreakdown) {
    writeEscPosLine(commands, formatTwoColumn("Subtotal", `${currencyFormatter.format(snapshot.subtotal)} so'm`, width), {
      align: template.bodyAlign,
    });
    writeEscPosLine(commands, formatTwoColumn("Soliq", `${currencyFormatter.format(snapshot.tax)} so'm`, width), {
      align: template.bodyAlign,
    });
  }

  if (template.showDiscount && snapshot.discount > 0) {
    writeEscPosLine(commands, formatTwoColumn("Chegirma", `-${currencyFormatter.format(snapshot.discount)} so'm`, width), {
      align: template.bodyAlign,
    });
  }

  writeEscPosLine(commands, divider, { align: template.bodyAlign });
  writeEscPosLine(commands, formatTwoColumn("JAMI", `${currencyFormatter.format(snapshot.total)} so'm`, width), {
    align: template.bodyAlign,
    bold: template.boldTotals,
  });

  if (snapshot.paymentParts.length) {
    writeEscPosLine(commands, divider, { align: template.bodyAlign });
    writeEscPosLine(commands, "To'lovlar:", { align: template.bodyAlign, bold: true });
    snapshot.paymentParts.forEach((part) => {
      writeEscPosLine(commands, formatTwoColumn(part.method, `${currencyFormatter.format(part.amount)} so'm`, width), {
        align: template.bodyAlign,
      });
    });
  }

  if (printer?.footerText || template.customMessage) {
    writeEscPosLine(commands, divider, { align: template.bodyAlign });
    if (printer?.footerText) {
      writeEscPosLine(commands, printer.footerText, { align: template.footerAlign });
    }
    if (template.customMessage) {
      writeEscPosLine(commands, template.customMessage, { align: template.footerAlign });
    }
  }

  if (totalCopies > 1) {
    writeEscPosLine(commands, `Nusxa ${copyIndex + 1}/${totalCopies}`, { align: "center" });
  }

  commands.push(ESC + "E" + "\x00");
  commands.push(ESC + "d" + "\x04");
  commands.push(GS + "V" + "\x41" + "\x03");

  return commands.join("");
};

export const generateEscPosReceipt = ({
  order = {},
  payment = {},
  template = {},
  printer = {},
  restaurant = {},
  isTest = false,
} = {}) => {
  const snapshot = buildOrderSnapshot(order, payment, { restaurant, isTest });
  const mergedTemplate = mergeReceiptTemplate(template, printer?.templateOverrides);
  const copies = Math.max(1, Number(printer?.copies || printer?.printCopies || 1));

  let payload = "";
  for (let i = 0; i < copies; i += 1) {
    payload += createEscPosSegment(snapshot, mergedTemplate, printer, {
      copyIndex: i,
      totalCopies: copies,
    });
  }

  return Buffer.from(payload, "utf8");
};

export const buildTestReceiptData = ({ restaurant = {} } = {}) => {
  const order = {
    tableName: "TEST",
    waiterName: "Admin",
    items: DEFAULT_TEST_ITEMS,
    subtotal: DEFAULT_TEST_ITEMS.reduce((sum, item) => sum + item.qty * item.price, 0),
    tax: 11200,
    discount: 0,
    total: DEFAULT_TEST_ITEMS.reduce((sum, item) => sum + item.qty * item.price, 0) + 11200,
  };
  const payment = {
    method: "Naqd",
    amount: order.total,
  };

  return { order, payment, restaurant };
};

export const sendToNetworkPrinter = ({ ipAddress, port }, buffer, { timeout = 5000 } = {}) =>
  new Promise((resolve, reject) => {
    if (!ipAddress || !port) {
      reject(new Error("Printer IP yoki port aniqlanmagan"));
      return;
    }

    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.once("connect", () => {
      socket.write(buffer, (err) => {
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          socket.end(() => resolve());
        }
      });
    });

    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Printer javob bermadi (timeout)"));
    });

    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });

    socket.connect(port, ipAddress);
  });

export const generateCheckHTML = (
  order,
  payment,
  printerSettings = {},
  templateOverrides = {},
  restaurant = {}
) => {
  const template = mergeReceiptTemplate(
    printerSettings.receiptTemplate,
    printerSettings.templateOverrides,
    templateOverrides
  );
  const snapshot = buildOrderSnapshot(order, payment, { restaurant });
  const paperWidth = sanitizePaperWidth(printerSettings.paperWidth || "80mm");
  const maxWidth = paperWidth === "58mm" ? "240px" : "320px";
  const divider = buildDivider(template, 40);

  const itemsHtml = snapshot.items
    .map(
      (item) => `
        <div class="receipt-line">
          <span>${item.qty} × ${item.name}</span>
          <span>${currencyFormatter.format(item.total)} so'm</span>
        </div>
      `
    )
    .join("");

  const paymentsHtml = snapshot.paymentParts
    .map(
      (part) => `
        <div class="receipt-line">
          <span>${part.method}</span>
          <span>${currencyFormatter.format(part.amount)} so'm</span>
        </div>
      `
    )
    .join("");

  return `
    <!DOCTYPE html>
    <html lang="uz">
      <head>
        <meta charset="UTF-8" />
        <title>Chek</title>
        <style>
          body {
            font-family: ${template.fontFamily};
            font-size: ${template.fontSize}px;
            line-height: ${template.lineHeight};
            max-width: ${maxWidth};
            margin: 0 auto;
            padding: 16px;
            background: #ffffff;
            color: #111827;
          }
          .header,
          .footer {
            text-align: ${template.headerAlign};
            margin-bottom: 10px;
          }
          .footer {
            text-align: ${template.footerAlign};
            margin-top: 18px;
            font-size: ${Math.max(template.fontSize - 1, 10)}px;
            color: #6b7280;
          }
          .divider {
            border-bottom: 1px dashed #d1d5db;
            margin: 10px 0;
          }
          .receipt-line {
            display: flex;
            justify-content: space-between;
            font-size: ${template.fontSize - 1}px;
            margin: 4px 0;
          }
          .totals {
            font-size: ${template.fontSize + 3}px;
            font-weight: ${template.boldTotals ? 700 : 600};
            display: flex;
            justify-content: space-between;
            margin-top: 6px;
          }
          .meta {
            font-size: ${template.fontSize - 2}px;
            color: #4b5563;
            margin: 2px 0;
            display: flex;
            justify-content: space-between;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <strong>${safeText(printerSettings.headerText || snapshot.restaurant.name)}</strong><br/>
          ${snapshot.restaurant.address ? `<span>${snapshot.restaurant.address}</span><br/>` : ""}
          ${snapshot.restaurant.phone ? `<span>Tel: ${snapshot.restaurant.phone}</span>` : ""}
        </div>

        <div class="meta">
          <span>Sana: ${dateFormatter.format(snapshot.createdAt)}</span>
          <span>Vaqt: ${timeFormatter.format(snapshot.createdAt)}</span>
        </div>
        ${snapshot.tableName ? `<div class="meta"><span>Stol:</span><span>${snapshot.tableName}</span></div>` : ""}
        ${snapshot.waiterName ? `<div class="meta"><span>Xizmatchi:</span><span>${snapshot.waiterName}</span></div>` : ""}
        ${snapshot.orderId ? `<div class="meta"><span>Buyurtma ID:</span><span>${snapshot.orderId.slice(-6).toUpperCase()}</span></div>` : ""}

        <div class="divider"></div>
        ${itemsHtml || '<div class="meta">Mahsulotlar mavjud emas</div>'}
        <div class="divider"></div>

        ${template.showTaxBreakdown
          ? `
            <div class="meta"><span>Subtotal</span><span>${currencyFormatter.format(snapshot.subtotal)} so'm</span></div>
            <div class="meta"><span>Soliq</span><span>${currencyFormatter.format(snapshot.tax)} so'm</span></div>
          `
          : ""}
        ${template.showDiscount && snapshot.discount > 0
          ? `<div class="meta"><span>Chegirma</span><span>- ${currencyFormatter.format(snapshot.discount)} so'm</span></div>`
          : ""}

        <div class="totals">
          <span>JAMI</span>
          <span>${currencyFormatter.format(snapshot.total)} so'm</span>
        </div>

        ${snapshot.paymentParts.length
          ? `
            <div class="divider"></div>
            <div class="meta" style="font-weight:600;">To'lov usullari</div>
            ${paymentsHtml}
          `
          : ""}

        <div class="divider"></div>
        <div class="footer">
          ${safeText(printerSettings.footerText || template.customMessage || "Raxmat! Qayta kutamiz")}
        </div>
      </body>
    </html>
  `;
};
