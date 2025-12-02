import Tip from "../models/Tip.js";
import { resolveRestaurantId } from "../utils/tenant.js";

export const addTip = async (req, res) => {
  const restaurantId = resolveRestaurantId(req, { allowBody: true });
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const payload = {
    user: req.user._id,
    amount: req.body.amount,
    order: req.body.orderId,
    restaurant: restaurantId,
  };

  const tip = await Tip.create(payload);
  res.json(tip);
};

export const getTips = async (req, res) => {
  const restaurantId = resolveRestaurantId(req, { allowQuery: true });
  if (!restaurantId) {
    return res.status(400).json({ message: "Restoran aniqlanmadi" });
  }

  const filter = { restaurant: restaurantId };
  if (!req.isSystemAdmin) {
    filter.user = req.user._id;
  } else if (req.query?.userId) {
    filter.user = req.query.userId;
  }

  const tips = await Tip.find(filter);
  res.json(tips);
};
