import { Router } from "express";
import { getCategories, createCategory, deleteCategory } from "../controllers/categoryController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

/**
 * Router de categorías. Define las rutas HTTP y qué middlewares y
 * controlador atiende cada una.
 *
 * Se espera montado con un prefijo en la app principal, por ejemplo:
 *   app.use("/api/categories", categoryRouter);
 * Todas las rutas de abajo son relativas a ese prefijo, y encajan con las
 * llamadas de `CategoriesPage` (`/api/categories`).
 *
 * Tabla resumen:
 *
 *  Método  Ruta     Acceso    Controlador
 *  GET     /        público   getCategories   (?storeSlug= o ?store_id=)
 *  POST    /        merchant  createCategory  (body: { name })
 *  DELETE  /:id     merchant  deleteCategory
 *
 * Nota: no hay `PUT`/`PATCH`, así que una categoría no se puede renombrar.
 */
const categoryRouter = Router();

// Público: los clientes ven las categorías de una tienda (para filtrar el
// catálogo). Sin `requireAuth`. Exige indicar la tienda por slug o por id.
categoryRouter.get("/", getCategories);

// Solo comerciantes: crear y borrar. `requireAuth` va antes que `requireRole`
// (el orden importa). El controlador además filtra por la tienda del usuario,
// así que un merchant solo toca SUS categorías.
categoryRouter.post("/", requireAuth, requireRole(['merchant']), createCategory)
categoryRouter.delete("/:id", requireAuth, requireRole(['merchant']), deleteCategory)

export default categoryRouter;