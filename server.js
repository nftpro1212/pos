// src/backend/server.js
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import dotenv from "dotenv";
import morgan from "morgan";
import cors from "cors";
import connectDB from "./config/db.js";
import authRoutes from "./routes/authRoutes.js";
import menuRoutes from "./routes/menuRoutes.js";
import tableRoutes from "./routes/tableRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import warehouseRoutes from "./routes/warehouseRoutes.js";
import supplierRoutes from "./routes/supplierRoutes.js";
import recipeRoutes from "./routes/recipeRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import shiftRoutes from "./routes/shiftRoutes.js";
import tipRoutes from "./routes/tipRoutes.js";
import path from "path";
import { initSocket } from "./socket.js";

// Import models to register schemas
import User from "./models/User.js";
import MenuItem from "./models/MenuItem.js";
import Order from "./models/Order.js";
import Table from "./models/Table.js";
import Payment from "./models/Payment.js";
import Customer from "./models/Customer.js";
import Notification from "./models/Notification.js";
import Shift from "./models/Shift.js";
import Tip from "./models/Tip.js";
import ActionLog from "./models/ActionLog.js";
import Settings from "./models/Settings.js";
import Report from "./models/Report.js";
import InventoryItem from "./models/InventoryItem.js";
import InventoryMovement from "./models/InventoryMovement.js";
import InventoryStock from "./models/InventoryStock.js";
import Warehouse from "./models/Warehouse.js";
import Supplier from "./models/Supplier.js";
import Recipe from "./models/Recipe.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

connectDB();

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/warehouses", warehouseRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/recipes", recipeRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/shifts", shiftRoutes);
app.use("/api/tips", tipRoutes);
app.use("/api/uploads", express.static(path.resolve("uploads")));

// Simple index
app.get("/", (req, res) => res.json({ ok: true }));

// init socket and pass io
initSocket(io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Backend running on port ${PORT}`));