import { Response } from "express";
import { prisma } from "../config/prisma.js";
import { AuthenticatedRequest } from "../middleware/auth.js";

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
 * Comprueba si un valor desconocido es un string con una URL https.
 *
 * Aquí el parámetro es `unknown`, como en el archivo de Cloudinary, pero a
 * diferencia de aquella NO es un type guard: devuelve un `boolean` normal
 * (sin `value is string`). Consecuencia: tras `if (isHttpsUrl(x))`,
 * TypeScript sigue considerando `x` como `unknown` y tendrás que hacer un
 * cast o comprobar `typeof x === "string"` para usarlo como texto.
 *
 * Solo valida el protocolo, no el dominio.
 *
 * @param value - Valor a comprobar (cualquier tipo).
 * @returns `true` si es un string con URL válida y protocolo https.
 */
const isHttpsUrl = (value: unknown) => {
  // Si no es un string (número, objeto, undefined...) no puede ser una URL.
  if (typeof value !== "string") return false;
  try {
    // `new URL()` lanza una excepción si el texto no es una URL válida.
    return new URL(value).protocol === "https:";
  } catch {
    // Texto con formato de URL incorrecto.
    return false;
  }
}

/**
 * Convierte un valor desconocido en un id numérico válido.
 *
 * Los ids de tienda, categoría y producto son enteros positivos. Acepta
 * tanto números como textos numéricos ("5" → 5), que es lo que llega desde
 * la URL (`req.params`) o el body.
 *
 * Ejemplos:
 *   parseId("5")   → 5
 *   parseId(7)     → 7
 *   parseId("abc") → null
 *   parseId(0)     → null   (no positivo)
 *   parseId("1.5") → null   (no entero)
 *   parseId(null)  → null   (Number(null) es 0)
 *
 * @param value - Valor a convertir (cualquier tipo).
 * @returns El id como número, o `null` si no es un entero positivo.
 *          Quien la llame debe comprobar el `null`.
 */
const parseId = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

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

// Update a product (only if it belongs to the merchant's store)
export const updateProduct = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, message: "Invalid product id" });
      return;
    }

    const store = await getMerchantStore(req.user!.id);
    if (!store) {
      res.status(404).json({ success: false, message: "You have not created a store yet" });
      return;
    }

    const existing = await prisma.products.findFirst({ where: { id, store_id: store.id }, select: { id: true } });
    if (!existing) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    const parsed = await parseProductInput(req.body, store.id, true);
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ success: false, message: "No valid fields to update" });
      return;
    }

    const product = await prisma.products.update({ where: { id }, data: parsed.data });
    res.status(200).json({ success: true, message: "Product updated successfully", product });
  } catch (error) {
    console.error("updateProduct error:", error);
    res.status(500).json({ success: false, message: "Failed to update product" });
  }
}
