import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
// ⚠️ Estos dos imports no se usan en este fragmento (ver notas).
import { countNeonMerchants, findNeonUserByIds } from "../services/neonUser.js";

/**
 * Busca la tienda de un comerciante y devuelve el registro COMPLETO.
 *
 * Es otra copia de `getMerchantStore`. La del controlador de productos usa
 * `select: { id: true }`; esta no tiene `select`, así que trae todos los
 * campos de la tienda. Aquí solo se usa `store.id`, por lo que el
 * `select` sería más eficiente.
 *
 * Resuelve a `null` si el usuario aún no tiene tienda.
 *
 * @param merchantId - Id del usuario autenticado (`req.user.id`).
 * @returns Promesa con la tienda o `null`.
 */
const getMerchantStore = (merchantId: string) => prisma.stores.findFirst({ where: { merchant_id: merchantId } })

/**
 * Controlador: devuelve las métricas (analytics) de la tienda del
 * comerciante autenticado, para su panel de control (dashboard).
 *
 * Seguridad (propiedad del recurso): la tienda se obtiene de `req.user.id`,
 * no de un id enviado por el cliente, y TODAS las consultas filtran por
 * `store_id`. Un comerciante solo ve datos de su tienda.
 *
 * Métricas devueltas (`analytics`):
 *  - totalRevenue:   suma de `total` de pedidos con `payment_status = "paid"`.
 *  - avgOrderValue:  media de `total` de esos mismos pedidos pagados.
 *  - totalOrders:    número de pedidos de la tienda, de cualquier estado.
 *  - pendingOrders:  pedidos con `order_status = "placed"`.
 *  - deliveredOrders: pedidos con `order_status = "delivered"`.
 *  - totalProducts:  número de productos de la tienda, de cualquier estado.
 *  - lowStockCount:  productos con stock <= 5 (incluye los de stock 0).
 *  - recentOrders:   lista de pedidos con campos básicos (ver notas: hoy
 *                    devuelve TODOS, no solo los recientes).
 *
 * Ruta esperada: GET sin body ni parámetros. Requiere autenticación (y,
 * según la ruta, rol "merchant").
 *
 * Respuestas:
 *  - 200: `{ success: true, analytics: {...} }`
 *  - 404: el usuario todavía no tiene tienda.
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada de Express.
 * @param res - Respuesta de Express.
 */
export const getMerchantAnalytics = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Tienda del usuario autenticado (`!` asume que `requireAuth` ya corrió).
    const store = await getMerchantStore(req.user!.id);
    if (!store) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    // Alias corto para no repetir `store.id` en cada consulta.
    const sid = store.id;

    // Las 7 consultas son independientes entre sí, así que se lanzan EN
    // PARALELO con `Promise.all` (más rápido que una tras otra). El
    // resultado llega en el MISMO ORDEN, y la desestructuración le da
    // nombre a cada uno: si cambias el orden de las consultas, cambia
    // también el de los nombres.
    // Si UNA falla, falla todo y se salta al `catch` (500).
    const [totalOrders, paidAgg, pendingOrders, deliveredOrders, totalProducts, lowStockCount, recentOrders] = await Promise.all([
      // 1. Total de pedidos de la tienda.
      prisma.orders.count({ where: { store_id: sid } }),

      // 2. Agregado de pedidos PAGADOS: suma y media del total en una
      //    sola consulta. Devuelve `{ _sum: { total }, _avg: { total } }`
      //    con valores `Decimal` o `null` (si no hay pedidos pagados).
      prisma.orders.aggregate({
        where: { store_id: sid, payment_status: "paid" }, _sum:
          { total: true }, _avg: { total: true }
      }),

      // 3. Pedidos pendientes de gestionar (estado "placed").
      prisma.orders.count({ where: { store_id: sid, order_status: "placed" } }),

      // 4. Pedidos entregados.
      prisma.orders.count({ where: { store_id: sid, order_status: "delivered" } }),

      // 5. Total de productos.
      prisma.products.count({ where: { store_id: sid } }),

      // 6. Productos con poco stock: `lte: 5` = menor o igual que 5.
      prisma.products.count({ where: { store_id: sid, stock: { lte: 5 } } }),

      // 7. Pedidos con solo los campos necesarios para la tabla del
      //    panel (sin items, dirección ni teléfono).
      prisma.orders.findMany({
        where: { store_id: sid },
        orderBy: { created_at: "desc" },
        select: {
          id: true, order_number: true, customer_name: true, customer_email: true, total: true, order_status: true, payment_status: true, created_at: true,
        }
      })
    ])

    // `_sum.total` y `_avg.total` son `Decimal | null`. `Number(...)` los
    // convierte a número y `|| 0` cubre `null` (Number(null) = 0) y NaN.
    // Se pierde la precisión exacta de `Decimal`, pero para un dashboard
    // es suficiente.
    const totalRevenue = Number(paidAgg._sum.total) || 0;
    const avgOrderValue = Number(paidAgg._avg.total) || 0;

    // `res.json` sin `.status()` responde 200 por defecto.
    res.json({
      success: true,
      analytics: {
        totalRevenue,
        totalOrders,
        avgOrderValue,
        pendingOrders,
        deliveredOrders,
        totalProducts,
        lowStockCount,
        recentOrders,
      }
    });
  } catch (error: any) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getMerchantAnalytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch merchant analytics" })
  }
}

/**
 * Controlador (solo administradores de plataforma): devuelve las métricas
 * globales de la plataforma para el dashboard de admin.
 *
 * Es el equivalente "global" de `getMerchantAnalytics`: allí todo se filtra
 * por una tienda; aquí se cuentan todas. Aquí es donde se usa
 * `countNeonMerchants` (la duda que dejé en la nota anterior).
 *
 * Métricas devueltas (`analytics`):
 *  - totalStores / activeStores / suspendedStores: tiendas por estado.
 *  - totalMerchants: usuarios con rol "merchant" (de Neon Auth; incluye
 *    comerciantes que aún no han creado tienda).
 *  - totalOrders: pedidos de toda la plataforma, de cualquier estado.
 *  - totalRevenue: suma de `total` de pedidos con `payment_status = "paid"`.
 *  - topStores: las 5 tiendas con más ingresos (id, nombre, slug, estado,
 *    nombre del comerciante, nº de pedidos e ingresos).
 *
 * IMPORTANTE: este controlador NO comprueba por sí mismo que el usuario sea
 * admin. La ruta debe llevar `requireAuth` + `requireRole(["admin"])`. Sin
 * ello, cualquier usuario autenticado vería los ingresos de toda la plataforma.
 *
 * Ruta esperada: GET sin body ni parámetros.
 *
 * Respuestas:
 *  - 200: `{ success: true, analytics: {...} }`
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada (no se usa; ver notas).
 * @param res - Respuesta de Express.
 */
export const getPlatformAnalytics = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // 7 consultas independientes, lanzadas EN PARALELO. El resultado llega en
    // el MISMO ORDEN que las consultas; si cambias el orden de una, cambia
    // también el nombre correspondiente en la desestructuración.
    // Si UNA falla, falla todo y se salta al `catch` (500).
    const [totalStores, activeStores, suspendedStores, totalMerchants, totalOrders, paidAgg, storesWithStats] = await Promise.all([
      // 1-3. Tiendas: total, activas y suspendidas.
      prisma.stores.count(),
      prisma.stores.count({ where: { status: "active" } }),
      prisma.stores.count({ where: { status: "suspended" } }),

      // 4. Comerciantes (SQL crudo sobre Neon Auth). Si falla, esta función
      //    devuelve 0 en vez de lanzar (ver nota anterior).
      countNeonMerchants(),

      // 5. Total de pedidos de la plataforma.
      prisma.orders.count(),

      // 6. Ingresos totales: suma de pedidos pagados.
      prisma.orders.aggregate({ where: { payment_status: "paid" }, _sum: { total: true } }),

      // 7. TODAS las tiendas, cada una con la lista de `total` de sus pedidos
      //    pagados y el contador de pedidos. Sirve para calcular el ranking
      //    en memoria (ver notas: es la parte costosa).
      prisma.stores.findMany({
        include: {
          orders: { where: { payment_status: "paid" }, select: { total: true } },
          _count: { select: { orders: true } },
        }
      })
    ])

    // Ids de los comerciantes de todas las tiendas. `.filter(Boolean)` quita
    // los nulos y `as string[]` le dice a TypeScript que ya no hay nulos (no lo
    // infiere solo; un type guard `(id): id is string => !!id` sería más seguro).
    const merchantIds = storesWithStats.map((s) => s.merchant_id).filter(Boolean) as
      string[];

    // Una sola consulta para obtener los usuarios (id → usuario), evitando N+1.
    const userMap = await findNeonUserByIds(merchantIds);

    // RANKING: se calculan los ingresos de cada tienda en memoria, se ordena
    // de mayor a menor y se quedan las 5 primeras.
    const topStores = storesWithStats.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      status: s.status,
      // Si no hay merchant_id o el usuario ya no existe: "Unknown".
      merchant_name: (s.merchant_id && userMap[s.merchant_id]?.name) || "Unknown",
      // Pedidos de la tienda, de cualquier estado.
      order_count: s._count.orders,
      // Suma de pedidos PAGADOS. `Number(o.total)` convierte el `Decimal`
      // a número (pierde precisión exacta, aceptable para un dashboard).
      revenue: s.orders.reduce((sum, o) => sum + Number(o.total), 0),
    })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // `res.json` sin `.status()` responde 200 por defecto.
    res.json({
      success: true,
      analytics: {
        totalStores,
        activeStores,
        suspendedStores,
        totalMerchants,
        totalOrders,
        // `Number(...) || 0` cubre `null` (sin pedidos pagados) y NaN.
        totalRevenue: Number(paidAgg._sum.total) || 0,
        topStores,
      },
    });
  } catch (error: any) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getPlatformAnalytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch platform analytics" })
  }
}