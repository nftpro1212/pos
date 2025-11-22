// src/backend/routes/supplierRoutes.js
import express from "express";
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  archiveSupplier,
  getSupplierLedger,
  recordSupplierPurchase,
  recordSupplierReturn,
  recordSupplierPayment,
  attachSupplierInvoice,
} from "../controllers/supplierController.js";
import { protect, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", allowRoles("admin", "omborchi"), listSuppliers);
router.post("/", allowRoles("admin", "omborchi"), createSupplier);
router.get("/:id/ledger", allowRoles("admin", "omborchi"), getSupplierLedger);
router.post("/:id/purchase", allowRoles("admin", "omborchi"), recordSupplierPurchase);
router.post("/:id/return", allowRoles("admin", "omborchi"), recordSupplierReturn);
router.post("/:id/payment", allowRoles("admin", "omborchi"), recordSupplierPayment);
router.post("/:id/invoice", allowRoles("admin", "omborchi"), attachSupplierInvoice);
router.put("/:id", allowRoles("admin"), updateSupplier);
router.delete("/:id", allowRoles("admin"), archiveSupplier);

export default router;
