import { neon } from "@neondatabase/serverless";

/**
 * API pública de solo lectura de StoreiFly, pensada para ejecutarse como una
 * función serverless / edge (formato `export default { fetch }`, típico de
 * Cloudflare Workers, Vercel Edge, etc.), SEPARADA de tu servidor Express.
 *
 * Qué hace: sirve datos públicos del catálogo (tiendas destacadas, tienda por
 * slug, producto por id y listado de productos) leyendo directamente de Neon
 * con SQL, sin pasar por Express ni Prisma. Usa el driver `@neondatabase/serverless`
 * (HTTP), que no necesita conexiones persistentes.
 *
 * Rutas (el prefijo `/api` se ignora, ver `path` más abajo):
 *
 *  Método   Ruta                                          Devuelve
 *  GET      / o /health                                   estado del servicio
 *  GET      /stores/featured (o /stores/public/featured)  hasta 12 tiendas activas
 *  GET      /stores/slug/:slug                            una tienda
 *  GET      /products/:id                                 un producto
 *  GET      /products?storeSlug=|storeId=&categoryId=&status=&search=
 *                                                          listado de productos
 *
 * Códigos de respuesta: 200, 204 (OPTIONS), 400 (parámetros inválidos),
 * 403 (tienda suspendida), 404 (no encontrado), 405 (método no permitido),
 * 500 (error interno / sin configurar).
 *
 * IMPORTANTE: al ser SQL directo, esta API NO pasa por tus controladores ni
 * por Prisma: las reglas de visibilidad (qué es público) están escritas
 * aquí a mano y hay que mantenerlas coherentes con el resto (ver notas).
 */

/**
 * Crea una respuesta JSON con cabeceras CORS.
 *
 * `Response` es el objeto estándar de la Web Fetch API (no el de Express).
 * `Access-Control-Allow-Origin: *` permite que CUALQUIER web llame a esta API
 * desde el navegador; es aceptable porque solo expone datos públicos y de
 * lectura. No lo uses así si algún día añades datos privados o cookies.
 *
 * @param data   - Objeto a serializar como JSON.
 * @param status - Código HTTP (por defecto 200).
 */
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  },
});

export default {
  /**
   * Punto de entrada: se ejecuta en cada petición HTTP.
   *
   * @param request - Petición estándar (Web Fetch API).
   * @param env     - Variables de entorno inyectadas por la plataforma
   *                  (en Cloudflare Workers llegan aquí, no en `process.env`).
   */
  async fetch(request: Request, env?: { DATABASE_URL?: string }): Promise<Response> {
    const { method, url } = request;

    // PREFLIGHT CORS: el navegador envía OPTIONS antes de ciertas
    // peticiones cross-origin para preguntar si están permitidas. Se
    // responde 204 (sin cuerpo) con las cabeceras CORS.
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Solo lectura: cualquier otro método (POST, PUT, DELETE...) se rechaza.
    if (method !== "GET" && method !== "HEAD") {
      return json({ success: false, message: "Method not allowed" }, 405);
    }

    // Cadena de conexión a Neon: primero la del entorno de la plataforma
    // (`env`), y si no, `process.env` (Node/Vercel). Si no hay ninguna,
    // se responde 500 con un mensaje claro.
    const databaseUrl = env?.DATABASE_URL || process.env.DATABASE_URL;

    if (!databaseUrl) {
      return json({ success: false, message: "DATABASE_URL is not configured" }, 500);
    }

    // Cliente SQL de Neon. Se crea en cada petición (es barato: usa HTTP,
    // no abre una conexión). `sql` es una "tagged template": los `${...}`
    // se envían como PARÁMETROS preparados, no concatenados, así que no hay
    // inyección SQL mientras uses siempre la sintaxis de backticks.
    const sql = neon(databaseUrl);

    // Normalización de la ruta: quita el prefijo "/api" y las barras
    // finales; si queda vacía, "/". Ej.: "/api/products/" → "/products".
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";

    try {
      // ---- HEALTH CHECK ----
      // Sirve para comprobar que el servicio responde (no toca la BD).
      if (path === "/" || path === "/health") {
        return json({
          success: true,
          service: "StoreiFly Neon Public API",
          timestamp: new Date().toISOString(),
        });
      }

      // ---- TIENDAS DESTACADAS ----
      // Las 12 tiendas activas más recientes. Hay dos rutas (alias).
      // Solo selecciona campos públicos (sin `merchant_id`).
      if (path === "/stores/public/featured" || path === "/stores/featured") {
        const stores = await sql`
                    SELECT id, name, slug, logo_url, banner_url, description, currency, created_at
                    FROM stores
                    WHERE status = 'active'
                    ORDER BY created_at DESC
                    LIMIT 12
                `;

        return json({ success: true, stores });
      }

      // ---- TIENDA POR SLUG ----
      // La regex captura el segmento tras "/stores/slug/" (sin barras).
      const storeSlugMatch = path.match(/^\/stores\/slug\/([^/]+)$/);

      if (storeSlugMatch) {
        // `decodeURIComponent` deshace el %20, %C3%A9, etc. Lanza un
        // error si la secuencia es inválida (ej. "%E0%A4%A"), y ese
        // error caería en el `catch` final como 500 (ver notas).
        const slug = decodeURIComponent(storeSlugMatch[1]);

        // `const [store] = await ...` toma solo la primera fila.
        const [store] = await sql`
                    SELECT id, merchant_id, name, slug, logo_url, banner_url, description,
                           currency, status, shipping_fee, free_shipping_threshold,
                           hero_style, accent_color, created_at
                    FROM stores
                    WHERE slug = ${slug}
                    LIMIT 1
                `;

        if (!store) {
          return json({ success: false, message: "Store not found" }, 404);
        }

        // Una tienda suspendida no se muestra: 403 con mensaje claro.
        if (store.status === "suspended") {
          return json({
            success: false,
            message: "This store is currently suspended by platform administration.",
          }, 403);
        }

        return json({ success: true, store });
      }

      // ---- PRODUCTO POR ID ----
      // `\d+` garantiza que el id sea numérico, así `Number()` es seguro.
      const productMatch = path.match(/^\/products\/(\d+)$/);

      if (productMatch) {
        const productId = Number(productMatch[1]);

        // Une el producto con su categoría y su tienda (LEFT JOIN: si no
        // tiene categoría, `category_name` será null).
        const [product] = await sql`
                    SELECT p.id, p.store_id, p.category_id, p.name, p.description, p.price,
                           p.compare_at_price, p.sku, p.stock, p.images, p.variants, p.status, p.created_at,
                           c.name AS category_name, c.slug AS category_slug,
                           s.name AS store_name, s.slug AS store_slug, s.status AS store_status
                    FROM products p
                    LEFT JOIN categories c ON p.category_id = c.id
                    LEFT JOIN stores s ON p.store_id = s.id
                    WHERE p.id = ${productId}
                    LIMIT 1
                `;

        if (!product) {
          return json({ success: false, message: "Product not found" }, 404);
        }

        // Producto de tienda suspendida: se oculta con 403.
        if (product.store_status === "suspended") {
          return json({
            success: false,
            message: "This store is currently suspended by platform administration.",
          }, 403);
        }

        return json({ success: true, product });
      }

      // ---- LISTADO DE PRODUCTOS ----
      // Exige indicar la tienda (por slug o por id): no hay listado global.
      if (path === "/products") {
        const storeSlug = searchParams.get("storeSlug");
        const storeIdParam = searchParams.get("storeId");
        const categoryIdParam = searchParams.get("categoryId");
        // Filtros opcionales; `null` significa "sin filtro" (el SQL de
        // abajo lo interpreta con `IS NULL`). `search` se recorta y un
        // texto vacío también pasa a `null`.
        const status = searchParams.get("status") || null;
        const search = searchParams.get("search")?.trim() || null;

        // Si llega `storeId`, se convierte a número (se valida más abajo).
        let targetStoreId = storeIdParam ? Number(storeIdParam) : null;

        // Si llega `storeSlug`, TIENE PRIORIDAD sobre `storeId`: se busca
        // la tienda y se usa su id real.
        if (storeSlug) {
          const [store] = await sql`
                        SELECT id, status
                        FROM stores
                        WHERE slug = ${storeSlug}
                        LIMIT 1
                    `;

          if (!store) {
            return json({ success: false, message: "Store not found" }, 404);
          }

          if (store.status === "suspended") {
            return json({
              success: false,
              message: "This store is currently suspended by platform administration.",
            }, 403);
          }

          targetStoreId = Number(store.id);
        }

        // Validación del id final: entero >= 1 (rechaza null, NaN, 0,
        // decimales y negativos).
        if (!targetStoreId || !Number.isInteger(targetStoreId) || targetStoreId < 1) {
          return json({
            success: false,
            message: "A valid storeId or storeSlug is required",
          }, 400);
        }

        // `categoryId` opcional: si se envía debe ser un entero >= 1.
        // El `!` afirma que no es null (seguro aquí, porque `&&` solo
        // evalúa esa parte si `categoryIdParam` existe).
        const categoryId = categoryIdParam ? Number(categoryIdParam) : null;

        if (categoryIdParam && (!Number.isInteger(categoryId) || categoryId! < 1)) {
          return json({ success: false, message: "Invalid categoryId" }, 400);
        }

        // Patrón "filtro opcional en SQL": `(${x}::text IS NULL OR col = ${x})`
        // → si `x` es null, la condición se cumple siempre (no filtra); si
        // no, filtra. Los `::text` / `::int` son necesarios para que
        // Postgres sepa el tipo del parámetro cuando es null.
        // `ILIKE '%' || ${search} || '%'` busca el texto en nombre,
        // descripción o SKU, ignorando mayúsculas.
        // `s.status = 'active'` es la barrera final: nunca devuelve
        // productos de tiendas suspendidas.
        const products = await sql`
                    SELECT p.id, p.store_id, p.category_id, p.name, p.description,
                           p.price, p.compare_at_price, p.sku, p.stock, p.images,
                           p.variants, p.status, p.created_at,
                           c.name AS category_name, c.slug AS category_slug
                    FROM products p
                    LEFT JOIN categories c ON p.category_id = c.id
                    LEFT JOIN stores s ON p.store_id = s.id
                    WHERE p.store_id = ${targetStoreId}
                        AND s.status = 'active'
                        AND (${status}::text IS NULL OR p.status = ${status})
                        AND (${categoryId}::int IS NULL OR p.category_id = ${categoryId})
                        AND (${search}::text IS NULL OR (
                            p.name ILIKE '%' || ${search} || '%'
                            OR p.description ILIKE '%' || ${search} || '%'
                            OR p.sku ILIKE '%' || ${search} || '%'
                        ))
                    ORDER BY p.created_at DESC
                `;

        return json({ success: true, products });
      }

      // Ninguna ruta coincidió.
      return json({
        success: false,
        message: "Route not found in Neon Public API",
      }, 404);

    } catch (error) {
      // Detalle en el log; mensaje genérico al cliente.
      console.error("Database API error:", error);

      return json({
        success: false,
        message: "Internal server error",
      }, 500);
    }
  },
};