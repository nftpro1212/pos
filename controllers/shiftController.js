import Shift from "../models/Shift.js";
export const startShift = async (req, res) => {
  const shift = await Shift.create({ user: req.user._id, start: new Date() });
  res.json(shift);
};
export const endShift = async (req, res) => {
  const shift = await Shift.findOneAndUpdate(
    { user: req.user._id, end: null },
    { end: new Date() },
    { new: true }
  );
  res.json(shift);
};
export const getShifts = async (req, res) => {
  const shifts = await Shift.find({ user: req.user._id });
  res.json(shifts);
};
