// src/backend/controllers/tableController.js
import Table from "../models/Table.js";

export const listTables = async (req, res) => {
  const tables = await Table.find().sort({ name: 1 });
  res.json(tables);
};

export const createTable = async (req, res) => {
  const { name } = req.body;
  const t = await Table.create({ name });
  res.json(t);
};

export const updateTable = async (req, res) => {
  const t = await Table.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(t);
};

export const deleteTable = async (req, res) => {
  await Table.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
};