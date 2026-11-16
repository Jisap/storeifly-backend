import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createProduct, updateProduct, deleteProduct } from "../controllers/productController.js";

const productRouter = Router();

// Merchant manages products in their own store
productRouter.post("/", requireAuth, requireRole(["merchant"]), createProduct);
productRouter.put("/:id", requireAuth, requireRole(["merchant"]), updateProduct);
productRouter.delete("/:id", requireAuth, requireRole(["merchant"]), deleteProduct);

export default productRouter;