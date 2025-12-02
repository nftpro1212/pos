import mongoose from "mongoose";
import { resetPosDataLocal } from "../services/systemMaintenance.js";

export const resetPosData = async (req, res) => {
  try {
    const { keepUserId } = req.body || {};
    const normalizedId = keepUserId && mongoose.Types.ObjectId.isValid(keepUserId)
      ? new mongoose.Types.ObjectId(keepUserId)
      : undefined;

    if (keepUserId && !normalizedId) {
      return res.status(400).json({ message: "keepUserId noto'g'ri formatda." });
    }

    const result = await resetPosDataLocal({ keepUserId: normalizedId });
    if (!result.ok) {
      return res.status(500).json({ message: result.message || "POS bazasini tozalashda xato yuz berdi." });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
