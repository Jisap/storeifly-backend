import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createStore,
  onboardMerchant,
  getMyStore,
  updateMyStore,
  getAllStores,
  getAllMerchants,
  toggleStoreStatus
} from "../controllers/storeController.js";

/**
 * Router de tiendas. Define las rutas HTTP y qué middlewares y controlador
 * atiende cada una. Aquí se aplica la protección que los controladores
 * NO hacen por sí mismos (autenticación y roles).
 *
 * Se espera montado con un prefijo en la app principal, por ejemplo:
 *   app.use("/api/stores", storeRouter);
 * Todas las rutas de abajo son relativas a ese prefijo.
 *
 * Middlewares usados:
 *  - `requireAuth`: exige sesión válida y rellena `req.user`. Es lo que
 *    hace seguro el `req.user!` de los controladores.
 *  - `requireRole([...])`: exige que `req.user.role` esté en la lista.
 *    Se ejecuta DESPUÉS de `requireAuth`; el orden importa.
 *
 * Tabla resumen:
 *
 *  Método  Ruta                      Acceso      Controlador
 *  POST    /                         logueado    createStore
 *  POST    /onboard-merchant         logueado    onboardMerchant
 *  POST    /onboard                  logueado    onboardMerchant (alias)
 *  GET     /me                       logueado    getMyStore
 *  PUT     /me                       logueado    updateMyStore
 *  GET     /my-store                 merchant    getMyStore
 *  PUT     /my-store                 merchant    updateMyStore
 *  GET     /admin/all                admin       getAllStores
 *  GET     /admin/merchants          admin       getAllMerchants
 *  PATCH   /:id/toggle-status        admin       toggleStoreStatus
 */
const storeRouter = Router();

// ---- Rutas de comerciante ----

// Crear la tienda. Cualquier usuario logueado puede (los admins los rechaza
// el propio controlador con un 403). Al crearla pasa a ser "merchant".
storeRouter.post("/", requireAuth, createStore);

// Convertirse en comerciante sin crear aún la tienda.
storeRouter.post("/onboard-merchant", requireAuth, onboardMerchant);

// Ver y editar la propia tienda. Solo exigen estar logueado (sin rol): un
// usuario sin tienda recibe 404 desde el controlador.
storeRouter.get("/me", requireAuth, getMyStore);
storeRouter.put("/me", requireAuth, updateMyStore);

// Alias de "/onboard-merchant": mismo controlador, otra URL. Cualquier
// usuario logueado puede hacerse comerciante antes de crear la tienda.
storeRouter.post("/onboard", requireAuth, onboardMerchant);

// Mismas operaciones que "/me", pero exigiendo además el rol "merchant".
// Ojo: el rol sale de la sesión, así que un usuario recién convertido en
// merchant puede recibir 403 aquí hasta que se refresque su sesión.
storeRouter.get("/my-store", requireAuth, requireRole(["merchant"]), getMyStore);
storeRouter.put("/my-store", requireAuth, requireRole(["merchant"]), updateMyStore);

// ---- Rutas solo para administradores de plataforma ----

// Listado de todas las tiendas, con estadísticas y datos del comerciante.
storeRouter.get("/admin/all", requireAuth, requireRole(["admin"]), getAllStores);

// Listado de todos los comerciantes, con los datos de su tienda (si existe).
storeRouter.get("/admin/merchants", requireAuth, requireRole(["admin"]), getAllMerchants);

// Activar/suspender una tienda. `:id` es el id numérico de la tienda y se
// lee en el controlador con `req.params.id`.
storeRouter.patch("/:id/toggle-status", requireAuth, requireRole(["admin"]), toggleStoreStatus);

export default storeRouter;