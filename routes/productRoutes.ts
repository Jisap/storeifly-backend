import { Router } from "express";
import { requireAuth, requireRole, optionalAuth } from "../middleware/auth.js";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  getProducts,
  getProductById,
} from "../controllers/productController.js";

const productRouter = Router();

// Public & Merchant product queries (optional auth lets merchants see draft/all products)
productRouter.get("/", optionalAuth, getProducts);
productRouter.get("/:id", optionalAuth, getProductById);

// Merchant manages products in their own store
productRouter.post("/", requireAuth, requireRole(["merchant"]), createProduct);
productRouter.put("/:id", requireAuth, requireRole(["merchant"]), updateProduct);
productRouter.delete("/:id", requireAuth, requireRole(["merchant"]), deleteProduct);

export default productRouter;