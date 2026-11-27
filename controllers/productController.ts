import { Response } from "express";
import { prisma } from "../config/prisma.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { parseId, isHttpsUrl } from "../utils/validation.js";

/**
 * Listas y límites usados para validar los datos de PRODUCTOS que llegan
 * del cliente.
 *
 * - VALID_STATUSES: estados posibles de un producto:
 *     "active"   → visible y a la venta.
 *     "draft"    → borrador, aún no publicado.
 *     "archived" → retirado sin borrarlo.
 *   Ojo: este `VALID_STATUSES` NO es el de `storeController` (que es
 *   ["active", "suspended"] y se refiere a tiendas). Son constantes
 *   independientes porque no se exportan; no las confundas ni las unifiques.
 * - MAX_IMAGES: máximo de imágenes por producto (10).
 * - MAX_VARIANTS: máximo de variantes por producto (50), por ejemplo
 *   combinaciones de talla y color.
 *
 * Los límites evitan abusos (cuerpos enormes, costes de almacenamiento).
 */
const VALID_STATUSES = ["active", "draft", "archived"];
const MAX_IMAGES = 10;
const MAX_VARIANTS = 50;

/**
 * Busca la tienda de un comerciante y devuelve solo su `id`.
 *
 * Es la base del control de acceso de este archivo: los controladores de
 * productos parten de la tienda del usuario autenticado (no de un id que
 * envíe el cliente), de modo que un comerciante solo pueda tocar los
 * productos de SU tienda.
 *
 * Nota: no es `async`, pero devuelve la promesa de Prisma, así que se usa
 * con `await getMerchantStore(...)`. Resuelve a `null` si el usuario aún no
 * tiene tienda; quien la llame debe comprobarlo (normalmente con un 404).
 *
 * @param merchantId - Id del usuario autenticado (`req.user.id`).
 * @returns Promesa con `{ id } | null`.
 */
const getMerchantStore = (merchantId: string) =>
  prisma.stores.findFirst({ where: { merchant_id: merchantId }, select: { id: true } });

/**
 * Valida y limpia los campos de un producto que un comerciante puede
 * establecer, a partir del body de una petición.
 *
 * Es el equivalente de `parseStoreInput`, con una diferencia: es `async`
 * porque, si viene `category_id`, consulta la BD para comprobar que la
 * categoría pertenece a la tienda del comerciante.
 *
 * Se usa al CREAR (`partial = false`) y al ACTUALIZAR (`partial = true`):
 *  - Creación: `name` y `price` son obligatorios.
 *  - Actualización: todo es opcional; solo se validan y devuelven los
 *    campos que vengan en el body.
 *
 * IMPORTANTE (lista blanca): solo se copian a `data` los campos revisados
 * aquí. Cualquier otro (`store_id`, `id`, `created_at`...) se IGNORA, así
 * el cliente no puede asignar un producto a otra tienda (mass assignment).
 * El `store_id` debe añadirlo el controlador, con el de `getMerchantStore`.
 *
 * Campos soportados:
 *  - name: string, obligatorio al crear, máx. 255 caracteres.
 *  - price: número >= 0, obligatorio al crear.
 *  - compare_at_price: número >= 0, o null / "" para quitarlo
 *    (precio "antes", para mostrar descuentos).
 *  - description: string, máx. 5000 caracteres.
 *  - sku: string de máx. 100 caracteres, o null; "" se guarda como null.
 *  - stock: entero >= 0.
 *  - images: array de hasta MAX_IMAGES URLs https.
 *  - variants: array de hasta MAX_VARIANTS objetos (máx. ~20 000 caracteres
 *    en total una vez serializado a JSON).
 *  - status: uno de VALID_STATUSES (active, draft, archived).
 *  - category_id: id de una categoría de TU tienda, o null / "" para quitarla.
 *
 * @param body    - Body de la petición (`req.body`), sin tipar (`any`).
 * @param storeId - Id de la tienda del comerciante (de `getMerchantStore`).
 * @param partial - `true` para actualizaciones, `false` para creación.
 * @returns `{ data }` con los datos validados y listos para Prisma, o
 *          `{ error }` con el mensaje del primer fallo. Se distinguen con
 *          `if ("error" in result)`.
 */
const parseProductInput = async (body: any, storeId: number, partial: boolean): Promise<{ data: Record<string, any> } | { error: string }> => {
  // Aquí se acumulan solo los campos válidos y limpios.
  const data: Record<string, any> = {};

  // Indica si el cliente envió la clave (aunque sea null o ""). Se compara
  // con `undefined` para que 0, "" y null cuenten como "enviado".
  const has = (key: string) => body?.[key] !== undefined;

  // NOMBRE: obligatorio al crear; al actualizar, solo si viene.
  if (!partial || has("name")) {
    if (typeof body?.name !== "string" || !body.name.trim()) return { error: "Product name is required" };
    if (body.name.trim().length > 255) return { error: "Product name must be 255 characters or less" };
    data.name = body.name.trim();
  }

  // PRECIO: obligatorio al crear. Se rechaza explícitamente `undefined` y
  // "" porque `Number("")` es 0 y `Number(undefined)` es NaN: sin esa
  // comprobación, un precio vacío se aceptaría como 0. `Number.isFinite`
  // descarta NaN e Infinity. Acepta 5 o "5".
  if (!partial || has("price")) {
    const price = Number(body?.price);
    if (body?.price === undefined || body?.price === "" || !Number.isFinite(price) || price < 0) return { error: "Price must be a number of 0 or more" };
    data.price = price;
  }

  // PRECIO DE COMPARACIÓN: opcional. null o "" lo borra (guarda null).
  if (has("compare_at_price")) {
    if (body.compare_at_price === null || body.compare_at_price === "") {
      data.compare_at_price = null;
    } else {
      const n = Number(body.compare_at_price);
      if (!Number.isFinite(n) || n < 0) return { error: "compare_at_price must be a number of 0 or more" };
      data.compare_at_price = n;
    }
  }

  // DESCRIPCIÓN: la longitud se comprueba ANTES de hacer trim().
  if (has("description")) {
    if (typeof body.description !== "string" || body.description.length > 5000) return { error: "Description must be text of 5000 characters or less" };
    data.description = body.description.trim();
  }

  // SKU (código interno del producto): puede ser null para borrarlo.
  // `body.sku?.trim() || null` convierte "" o solo espacios en null.
  if (has("sku")) {
    if (body.sku !== null && (typeof body.sku !== "string" || body.sku.length > 100)) return { error: "SKU must be text of 100 characters or less" };
    data.sku = body.sku?.trim() || null;
  }

  // STOCK: entero >= 0. Ojo: `Number(null)` y `Number("")` dan 0, así que
  // `stock: null` o `stock: ""` se guardan como 0 sin error.
  if (has("stock")) {
    const n = Number(body.stock);
    if (!Number.isInteger(n) || n < 0) return { error: "Stock must be a whole number of 0 or more" };
    data.stock = n;
  }

  // IMÁGENES: array de hasta MAX_IMAGES URLs https. `.every(isHttpsUrl)`
  // pasa cada elemento a la función (valida que sea string con https).
  // Un array vacío es válido (producto sin imágenes).
  if (has("images")) {
    if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES || !body.images.every(isHttpsUrl)) {
      return { error: `images must be a list of up to ${MAX_IMAGES} https URLs` };
    }
    data.images = body.images;
  }

  // VARIANTES: array de objetos (ej. { size: "M", color: "rojo" }). Se
  // comprueba que cada elemento sea un objeto "plano" (ni null ni array)
  // y que el JSON completo no supere 20 000 caracteres, para que nadie
  // guarde cantidades enormes de datos en la columna. NO se valida el
  // CONTENIDO de cada objeto: cualquier clave y valor se acepta.
  if (has("variants")) {
    if (!Array.isArray(body.variants) || body.variants.length > MAX_VARIANTS
      || !body.variants.every((v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v))
      || JSON.stringify(body.variants).length > 20000) {
      return { error: `variants must be a list of up to ${MAX_VARIANTS} objects` };
    }
    data.variants = body.variants;
  }

  // ESTADO del producto: debe estar en la lista blanca (active/draft/archived).
  if (has("status")) {
    if (!VALID_STATUSES.includes(body.status)) return { error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
    data.status = body.status;
  }

  // CATEGORÍA: null o "" la quita. Si viene un id, se busca la categoría
  // filtrando TAMBIÉN por `store_id`: así una categoría de otra tienda
  // aparece como "no encontrada" (no se revela que existe).
  if (has("category_id")) {
    if (body.category_id === null || body.category_id === "") {
      data.category_id = null;
    } else {
      const categoryId = parseId(body.category_id);
      // The category must belong to this merchant's store
      const category = categoryId
        ? await prisma.categories.findFirst({ where: { id: categoryId, store_id: storeId }, select: { id: true } })
        : null;
      if (!category) return { error: "Category not found in your store" };
      data.category_id = category.id;
    }
  }

  // Todo correcto: se devuelven los datos validados.
  return { data };
}

/**
 * Controlador: crea un producto en la tienda del comerciante autenticado.
 *
 * La tienda se obtiene de `req.user.id` (con `getMerchantStore`), nunca de un
 * id enviado por el cliente. Así un comerciante solo puede añadir productos a
 * SU tienda.
 *
 * Ruta esperada: POST con body JSON. Requiere autenticación (y, según la ruta,
 * rol "merchant"). Campos: los de `parseProductInput`, con `name` y `price`
 * obligatorios.
 *
 * Flujo:
 *  1. Localiza la tienda del usuario (404 si aún no tiene).
 *  2. Valida y limpia el body (`parseProductInput(body, store.id, false)`).
 *  3. Crea el producto asignándole el `store_id` desde el servidor.
 *
 * Respuestas:
 *  - 201: `{ success, message, product }` con el producto creado.
 *  - 400: algún campo inválido (mensaje del primer error).
 *  - 404: el usuario todavía no tiene tienda.
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada de Express con el body descrito arriba.
 * @param res - Respuesta de Express.
 */
export const createProduct = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Tienda del usuario autenticado. `!` asume que `req.user` existe
    // (la ruta debe estar protegida por `requireAuth`). Devuelve `null`
    // si el usuario no ha creado su tienda.
    const store = await getMerchantStore(req.user!.id);
    if (!store) {
      res.status(404).json({ success: false, message: "You must create a store before adding products" });
      return;
    }

    // Valida el body en modo creación (`false`): `name` y `price` son
    // obligatorios. Se pasa `store.id` para que, si viene `category_id`,
    // se compruebe que la categoría es de esta tienda.
    // `"error" in parsed` distingue las dos formas del union type.
    const parsed = await parseProductInput(req.body, store.id, false);
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }

    const product = await prisma.products.create({
      data: {
        // Campos validados (solo los de la lista blanca).
        ...parsed.data,
        // Redundantes con el spread (ya vienen en `parsed.data`), pero
        // dejan claro qué campos son obligatorios y evitan errores de
        // tipos, ya que `data` es `Record<string, any>`.
        name: parsed.data.name,
        price: parsed.data.price,
        // Va AL FINAL a propósito: lo fija el servidor y el cliente no
        // puede sobrescribirlo (aunque `parseProductInput` ya lo ignora).
        store_id: store.id,
      },
    });

    // Se devuelve el registro completo del producto creado.
    res.status(201).json({ success: true, message: "Product created successfully", product });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("createProduct error:", error);
    res.status(500).json({ success: false, message: "Failed to create product" });
  }
}

/**
 * Controlador: actualiza un producto de la tienda del comerciante autenticado.
 *
 * Seguridad (propiedad del recurso): el id del producto llega por la URL,
 * pero el producto solo se acepta si pertenece a la tienda del usuario
 * (`where: { id, store_id: store.id }`). Un producto de otra tienda se
 * trata como "no encontrado" (404), sin revelar que existe.
 *
 * Es una actualización parcial: solo se modifican los campos que vengan en
 * el body. Los campos admitidos son los de `parseProductInput`. `store_id`,
 * `id` y similares se ignoran, así que un producto no puede cambiarse de tienda.
 *
 * Ruta esperada: PUT/PATCH `/:id` con body JSON. Requiere autenticación.
 *
 * Flujo:
 *  1. Valida el id de la URL.
 *  2. Localiza la tienda del usuario.
 *  3. Comprueba que el producto existe Y es de esa tienda.
 *  4. Valida el body en modo parcial.
 *  5. Actualiza y devuelve el producto.
 *
 * Respuestas:
 *  - 200: `{ success, message, product }` con el producto ya actualizado.
 *  - 400: id inválido, campo inválido o ningún campo válido que actualizar.
 *  - 404: el usuario no tiene tienda, o el producto no existe en su tienda.
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada de Express (`req.params.id` y body).
 * @param res - Respuesta de Express.
 */
export const updateProduct = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Id del producto desde la URL. `parseId` devuelve null si no es un
    // entero positivo ("abc", 0, "1.5"...).
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, message: "Invalid product id" });
      return;
    }

    // Tienda del usuario autenticado (`!` asume que `requireAuth` ya corrió).
    const store = await getMerchantStore(req.user!.id);
    if (!store) {
      res.status(404).json({ success: false, message: "You have not created a store yet" });
      return;
    }

    // COMPROBACIÓN DE PROPIEDAD: se busca por `id` Y `store_id`. Si el
    // producto existe pero es de otra tienda, no se encuentra. Solo se
    // selecciona `id` porque únicamente interesa saber si existe.
    const existing = await prisma.products.findFirst({ where: { id, store_id: store.id }, select: { id: true } });
    if (!existing) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    // Valida el body en modo parcial (`true`): todo es opcional. Se pasa
    // `store.id` para validar `category_id` contra esta tienda.
    const parsed = await parseProductInput(req.body, store.id, true);
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }

    // Body sin ningún campo reconocido: no se ejecuta un `update` vacío.
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ success: false, message: "No valid fields to update" });
      return;
    }

    // Actualiza solo los campos validados. Aquí `where` usa solo `id`
    // porque la propiedad ya se verificó arriba (ver notas).
    const product = await prisma.products.update({ where: { id }, data: parsed.data });
    res.status(200).json({ success: true, message: "Product updated successfully", product });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("updateProduct error:", error);
    res.status(500).json({ success: false, message: "Failed to update product" });
  }
}

/**
 * Controlador: elimina un producto de la tienda del comerciante autenticado.
 *
 * Seguridad (propiedad del recurso): el id llega por la URL, pero el borrado
 * solo afecta a productos cuyo `store_id` es el de la tienda del usuario. Un
 * producto de otra tienda se trata como "no encontrado" (404), sin revelar
 * que existe.
 *
 * A diferencia de `updateProduct`, aquí la comprobación de propiedad y el
 * borrado se hacen en UNA sola operación atómica (`deleteMany` con
 * `id` + `store_id`), sin hueco entre comprobar y actuar.
 *
 * El borrado es DEFINITIVO (no hay "papelera"). Si prefieres conservar el
 * historial, existe el estado "archived" en `VALID_STATUSES`.
 *
 * Ruta esperada: DELETE `/:id`, sin body. Requiere autenticación.
 *
 * Respuestas:
 *  - 200: `{ success, message }`
 *  - 400: id inválido.
 *  - 404: el usuario no tiene tienda, o el producto no existe en su tienda.
 *  - 500: error inesperado (incluye fallos de integridad referencial, ver notas).
 *
 * @param req - Petición autenticada de Express (`req.params.id`).
 * @param res - Respuesta de Express.
 */
export const deleteProduct = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Id del producto desde la URL. `parseId` devuelve null si no es un
    // entero positivo ("abc", 0, "1.5"...).
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, message: "Invalid product id" });
      return;
    }

    // Tienda del usuario autenticado (`!` asume que `requireAuth` ya corrió).
    const store = await getMerchantStore(req.user!.id);
    if (!store) {
      res.status(404).json({ success: false, message: "You have not created a store yet" });
      return;
    }

    // Se usa `deleteMany` (y no `delete`) a propósito: `delete` solo admite
    // claves únicas en el `where` y lanzaría un error si no encuentra nada.
    // `deleteMany` permite filtrar por `id` Y `store_id` a la vez y devuelve
    // `{ count }` con las filas borradas, sin lanzar error si son 0.
    const result = await prisma.products.deleteMany({ where: { id, store_id: store.id } });

    // count === 0: el producto no existe o es de otra tienda. Ambos casos
    // dan el mismo 404, para no filtrar información.
    if (result.count === 0) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }
    res.status(200).json({ success: true, message: "Product deleted successfully" });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("deleteProduct error:", error);
    res.status(500).json({ success: false, message: "Failed to delete product" });
  }
};

/**
 * Controlador: lista productos con soporte de filtros.
 * Puede ser llamado por comerciantes (ven sus propios productos, incluidos borradores)
 * o por clientes de una tienda pública (solo productos activos de tiendas activas).
 */
export const getProducts = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const storeSlug = req.query.storeSlug as string | undefined;
    const storeIdParam = req.query.storeId as string | undefined;
    const categoryIdParam = req.query.categoryId as string | undefined;
    const statusParam = req.query.status as string | undefined;
    const searchParam = req.query.search as string | undefined;

    let targetStoreId: number | null = null;
    let targetStore: { id: number; status: string | null; merchant_id: string | null } | null = null;

    if (storeSlug) {
      targetStore = await prisma.stores.findUnique({
        where: { slug: storeSlug },
        select: { id: true, status: true, merchant_id: true },
      });
      if (!targetStore) {
        res.status(404).json({ success: false, message: "Store not found" });
        return;
      }
      targetStoreId = targetStore.id;
    } else if (storeIdParam) {
      const parsedStoreId = parseId(storeIdParam);
      if (!parsedStoreId) {
        res.status(400).json({ success: false, message: "Invalid storeId" });
        return;
      }
      targetStore = await prisma.stores.findUnique({
        where: { id: parsedStoreId },
        select: { id: true, status: true, merchant_id: true },
      });
      if (!targetStore) {
        res.status(404).json({ success: false, message: "Store not found" });
        return;
      }
      targetStoreId = targetStore.id;
    } else if (req.user?.id) {
      // Si el comerciante está autenticado y no pasa storeId/storeSlug, busca su tienda
      targetStore = await prisma.stores.findFirst({
        where: { merchant_id: req.user.id },
        select: { id: true, status: true, merchant_id: true },
      });
      if (targetStore) {
        targetStoreId = targetStore.id;
      }
    }

    if (!targetStoreId) {
      res.status(400).json({ success: false, message: "A valid storeId, storeSlug, or merchant session is required" });
      return;
    }

    // Comprobamos si quien consulta es el dueño de la tienda o un admin
    const isOwnerOrAdmin = Boolean(
      req.user &&
      (req.user.role === "admin" || (targetStore?.merchant_id && req.user.id === targetStore.merchant_id))
    );

    // Si la tienda está suspendida y quien consulta no es dueño ni admin, denegar
    if (targetStore?.status === "suspended" && !isOwnerOrAdmin) {
      res.status(403).json({ success: false, message: "This store is currently suspended by platform administration." });
      return;
    }

    // Construcción del filtro WHERE
    const where: any = { store_id: targetStoreId };

    if (statusParam) {
      where.status = statusParam;
    } else if (!isOwnerOrAdmin) {
      // Público solo ve productos activos
      where.status = "active";
    }

    if (categoryIdParam) {
      const parsedCatId = parseId(categoryIdParam);
      if (parsedCatId) {
        where.category_id = parsedCatId;
      }
    }

    if (searchParam && searchParam.trim()) {
      const s = searchParam.trim();
      where.OR = [
        { name: { contains: s, mode: "insensitive" } },
        { description: { contains: s, mode: "insensitive" } },
        { sku: { contains: s, mode: "insensitive" } },
      ];
    }

    const items = await prisma.products.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: {
        categories: { select: { name: true, slug: true } },
      },
    });

    const products = items.map((p) => ({
      ...p,
      category_name: p.categories?.name ?? null,
      category_slug: p.categories?.slug ?? null,
      categories: undefined,
    }));

    res.status(200).json({ success: true, products });
  } catch (error) {
    console.error("getProducts error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch products" });
  }
};

/**
 * Controlador: obtiene un producto por ID con su tienda y categoría.
 */
export const getProductById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, message: "Invalid product id" });
      return;
    }

    const item = await prisma.products.findUnique({
      where: { id },
      include: {
        categories: { select: { name: true, slug: true } },
        stores: { select: { id: true, name: true, slug: true, status: true, merchant_id: true } },
      },
    });

    if (!item) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    const isOwnerOrAdmin = Boolean(
      req.user &&
      (req.user.role === "admin" || (item.stores?.merchant_id && req.user.id === item.stores.merchant_id))
    );

    if (item.stores?.status === "suspended" && !isOwnerOrAdmin) {
      res.status(403).json({ success: false, message: "This store is currently suspended by platform administration." });
      return;
    }

    const product = {
      ...item,
      category_name: item.categories?.name ?? null,
      category_slug: item.categories?.slug ?? null,
      store_name: item.stores?.name ?? null,
      store_slug: item.stores?.slug ?? null,
      store_status: item.stores?.status ?? null,
      categories: undefined,
      stores: undefined,
    };

    res.status(200).json({ success: true, product });
  } catch (error) {
    console.error("getProductById error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch product" });
  }
};