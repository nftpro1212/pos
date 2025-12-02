import Shift from "../models/Shift.js";
import { resolveRestaurantId } from "../utils/tenant.js";

export const startShift = async (req, res) => {
  const restaurantId = resolveRestaurantId(req);
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const shift = await Shift.create({
    user: req.user._id,
    restaurant: restaurantId,
    start: new Date(),
  });
  res.json(shift);
};

export const endShift = async (req, res) => {
  const restaurantId = resolveRestaurantId(req);
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const shift = await Shift.findOneAndUpdate(
    { user: req.user._id, restaurant: restaurantId, end: null },
    { end: new Date() },
    { new: true }
  );
  res.json(shift);
};

export const getShifts = async (req, res) => {
  const restaurantId = resolveRestaurantId(req, { allowQuery: true });
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const filter = { user: req.user._id, restaurant: restaurantId };
  const shifts = await Shift.find(filter);
  res.json(shifts);
};
