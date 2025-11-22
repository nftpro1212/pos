import Tip from "../models/Tip.js";
export const addTip = async (req, res) => {
  const tip = await Tip.create({ user: req.user._id, amount: req.body.amount, order: req.body.orderId });
  res.json(tip);
};
export const getTips = async (req, res) => {
  const tips = await Tip.find({ user: req.user._id });
  res.json(tips);
};
