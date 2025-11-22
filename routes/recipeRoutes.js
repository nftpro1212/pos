// src/backend/routes/recipeRoutes.js
import express from "express";
import {
  listRecipes,
  getRecipe,
  createRecipe,
  addRecipeVersion,
  setDefaultRecipeVersion,
  updateRecipeMeta,
  archiveRecipe,
} from "../controllers/recipeController.js";
import { protect, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", allowRoles("admin", "omborchi", "oshpaz"), listRecipes);
router.post("/", allowRoles("admin", "omborchi", "oshpaz"), createRecipe);
router.get("/:id", allowRoles("admin", "omborchi", "oshpaz"), getRecipe);
router.post("/:id/versions", allowRoles("admin", "omborchi", "oshpaz"), addRecipeVersion);
router.patch("/:id/default-version", allowRoles("admin", "omborchi"), setDefaultRecipeVersion);
router.put("/:id", allowRoles("admin", "omborchi"), updateRecipeMeta);
router.delete("/:id", allowRoles("admin"), archiveRecipe);

export default router;
