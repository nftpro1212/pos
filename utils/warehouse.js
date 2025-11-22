// src/backend/utils/warehouse.js
import Warehouse from "../models/Warehouse.js";

export const ensureDefaultWarehouse = async () => {
  let defaultWarehouse = await Warehouse.findOne({ isDefault: true, isActive: true });
  if (defaultWarehouse) return defaultWarehouse;

  const existingMain = await Warehouse.findOne({ code: "MAIN" });
  if (existingMain) {
    existingMain.isDefault = true;
    existingMain.isActive = true;
    await existingMain.save();
    return existingMain;
  }

  const created = await Warehouse.create({
    name: "Asosiy ombor",
    code: "MAIN",
    type: "main",
    isDefault: true,
    isActive: true,
  });

  return created;
};

export const setDefaultWarehouseById = async (warehouseId) => {
  if (!warehouseId) {
    throw new Error("Warehouse ID talab qilinadi");
  }

  await Warehouse.updateMany(
    { _id: { $ne: warehouseId } },
    { $set: { isDefault: false } }
  );

  const updated = await Warehouse.findByIdAndUpdate(
    warehouseId,
    { $set: { isDefault: true, isActive: true } },
    { new: true }
  );

  if (!updated) {
    throw new Error("Warehouse topilmadi");
  }

  return updated;
};
