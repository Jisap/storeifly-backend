import { Router } from "express";
import { requireAuth, requireRole, optionalAuth } from "../middleware/auth.js";
import { createOrder, getMerchantOrders, updateOrderStatus, getOrderReceipt, getCustomerOrders } from "../controllers/orderController.js";

/**
 * Router de pedidos. Define las rutas HTTP y qué middlewares y controlador
 * atiende cada una.
 *
 * Se espera montado con un prefijo en la app principal, por ejemplo:
 *   app.use("/api/orders", orderRouter);
 * Todas las rutas de abajo son relativas a ese prefijo.
 *
 * Middlewares usados:
 *  - `optionalAuth`: si hay sesión válida rellena `req.user`; si no la hay,
 *    deja pasar la petición SIN error. Es el middleware que echaba en falta
 *    en las notas de `createOrder` (compra como invitado).
 *  - `requireAuth`: exige sesión válida y rellena `req.user`; sin sesión
 *    responde 401.
 *  - `requireRole([...])`: exige que `req.user.role` esté en la lista. Va
 *    DESPUÉS de `requireAuth`; el orden importa.
 *
 * Tabla resumen:
 *
 *  Método  Ruta                        Acceso            Controlador
 *  POST    /checkout                   público (opcional) createOrder
 *  GET     /receipt/:orderNumber       público           getOrderReceipt
 *  GET     /customer/my-orders         logueado          getCustomerOrders
 *  GET     /merchant                   merchant          getMerchantOrders
 *  PATCH   /merchant/:id/status        merchant          updateOrderStatus
 */
const orderRouter = Router();

// ---- Rutas públicas ----

// Checkout. Los invitados pueden comprar; si hay sesión, el pedido se
// vincula a la cuenta (`customer_id`). Con `requireAuth` los invitados
// recibirían 401, por eso aquí va `optionalAuth`.
orderRouter.post("/checkout", optionalAuth, createOrder);

// Recibo por número de pedido. Sin autenticación: el número aleatorio
// funciona como enlace privado (ver `getOrderReceipt`).
orderRouter.get("/receipt/:orderNumber", getOrderReceipt);

// ---- Rutas de cliente ----

// Historial de pedidos del usuario logueado (acepta ?storeSlug= o ?storeId=).
orderRouter.get("/customer/my-orders", requireAuth, getCustomerOrders);

// ---- Rutas de comerciante ----

// Pedidos de su tienda (acepta ?status=).
orderRouter.get("/merchant", requireAuth, requireRole(["merchant"]), getMerchantOrders);

// Cambiar el estado de un pedido. `:id` es el id numérico del pedido y se
// lee en el controlador con `req.params.id`.
orderRouter.patch("/merchant/:id/status", requireAuth, requireRole(["merchant"]), updateOrderStatus);

export default orderRouter;