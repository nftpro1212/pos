import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import MenuItem from "../models/MenuItem.js";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";
import Table from "../models/Table.js";
import Customer from "../models/Customer.js";
import Shift from "../models/Shift.js";
import Tip from "../models/Tip.js";
import Notification from "../models/Notification.js";
import ActionLog from "../models/ActionLog.js";
import Settings from "../models/Settings.js";
import Report from "../models/Report.js";
import InventoryItem from "../models/InventoryItem.js";
import InventoryMovement from "../models/InventoryMovement.js";
import InventoryStock from "../models/InventoryStock.js";
import Warehouse from "../models/Warehouse.js";
import Supplier from "../models/Supplier.js";
import Recipe from "../models/Recipe.js";
import User from "../models/User.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(__dirname, "../uploads");

const clearUploadsDirectory = async () => {
  try {
    const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.resolve(uploadsDir, entry.name);
        if (entry.name.startsWith(".")) {
          return;
        }
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath).catch(() => {});
        }
      })
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

export const resetPosDataLocal = async ({ keepUserId } = {}) => {
  try {
    await Promise.all([
      MenuItem.deleteMany({}),
      Order.deleteMany({}),
      Payment.deleteMany({}),
      Table.deleteMany({}),
      Customer.deleteMany({}),
      Shift.deleteMany({}),
      Tip.deleteMany({}),
      Notification.deleteMany({}),
      ActionLog.deleteMany({}),
      Settings.deleteMany({}),
      Report.deleteMany({}),
      InventoryItem.deleteMany({}),
      InventoryMovement.deleteMany({}),
      InventoryStock.deleteMany({}),
      Warehouse.deleteMany({}),
      Supplier.deleteMany({}),
      Recipe.deleteMany({}),
    ]);

    if (keepUserId) {
      await User.deleteMany({ _id: { $ne: keepUserId } });
    } else {
      await User.deleteMany({});
    }

    await clearUploadsDirectory();

    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
};
