import { Router } from "express";
import { getCategories, createCategory, deleteCategory } from "../controllers/categoryController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";


const categoryRouter = Router();

//public customer puede ver las categorias
categoryRouter.get("/", getCategories);

// Merchant puede crear y borrar categorias
categoryRouter.post("/", requireAuth, requireRole(['merchant']), createCategory)
categoryRouter.delete("/:id", requireAuth, requireRole(['merchant']), deleteCategory)


export default categoryRouter;