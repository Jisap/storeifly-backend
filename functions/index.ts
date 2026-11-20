import { neon } from "@neondatabase/serverless";

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
  async fetch(request: Request, env?: { DATABASE_URL?: string }): Promise<Response> {
    const { method, url } = request;

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

    if (method !== "GET" && method !== "HEAD") {
      return json({ success: false, message: "Method not allowed" }, 405);
    }

    const databaseUrl = env?.DATABASE_URL || process.env.DATABASE_URL;

    if (!databaseUrl) {
      return json({ success: false, message: "DATABASE_URL is not configured" }, 500);
    }

    const sql = neon(databaseUrl);
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";

    try {
      // Health check
      if (path === "/" || path === "/health") {
        return json({
          success: true,
          service: "StoreiFly Neon Public API",
          timestamp: new Date().toISOString(),
        });
      }

      // Featured stores
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

      // Store by slug
      const storeSlugMatch = path.match(/^\/stores\/slug\/([^/]+)$/);

      if (storeSlugMatch) {
        const slug = decodeURIComponent(storeSlugMatch[1]);

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

        if (store.status === "suspended") {
          return json({
            success: false,
            message: "This store is currently suspended by platform administration.",
          }, 403);
        }

        return json({ success: true, store });
      }

      // Product by ID
      const productMatch = path.match(/^\/products\/(\d+)$/);

      if (productMatch) {
        const productId = Number(productMatch[1]);

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

        if (product.store_status === "suspended") {
          return json({
            success: false,
            message: "This store is currently suspended by platform administration.",
          }, 403);
        }

        return json({ success: true, product });
      }

      // Product list
      if (path === "/products") {
        const storeSlug = searchParams.get("storeSlug");
        const storeIdParam = searchParams.get("storeId");
        const categoryIdParam = searchParams.get("categoryId");
        const status = searchParams.get("status") || null;
        const search = searchParams.get("search")?.trim() || null;

        let targetStoreId = storeIdParam ? Number(storeIdParam) : null;

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

        if (!targetStoreId || !Number.isInteger(targetStoreId) || targetStoreId < 1) {
          return json({
            success: false,
            message: "A valid storeId or storeSlug is required",
          }, 400);
        }

        const categoryId = categoryIdParam ? Number(categoryIdParam) : null;

        if (categoryIdParam && (!Number.isInteger(categoryId) || categoryId! < 1)) {
          return json({ success: false, message: "Invalid categoryId" }, 400);
        }

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

      return json({
        success: false,
        message: "Route not found in Neon Public API",
      }, 404);

    } catch (error) {
      console.error("Database API error:", error);

      return json({
        success: false,
        message: "Internal server error",
      }, 500);
    }
  },
};