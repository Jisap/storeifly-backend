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

const parseId = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Checks the product fields a merchant is allowed to set.
// Returns the cleaned data, or an error message.
// `partial` = true for updates (every field optional).
const parseProductInput = async (body: any, storeId: number, partial: boolean): Promise<{ data: Record<string, any> } | { error: string }> => {
  const data: Record<string, any> = {};
  const has = (key: string) => body?.[key] !== undefined;

  if (!partial || has("name")) {
    if (typeof body?.name !== "string" || !body.name.trim()) return { error: "Product name is required" };
    if (body.name.trim().length > 255) return { error: "Product name must be 255 characters or less" };
    data.name = body.name.trim();
  }
  if (!partial || has("price")) {
    const price = Number(body?.price);
    if (body?.price === undefined || body?.price === "" || !Number.isFinite(price) || price < 0) return { error: "Price must be a number of 0 or more" };
    data.price = price;
  }
  if (has("compare_at_price")) {
    if (body.compare_at_price === null || body.compare_at_price === "") {
      data.compare_at_price = null;
    } else {
      const n = Number(body.compare_at_price);
      if (!Number.isFinite(n) || n < 0) return { error: "compare_at_price must be a number of 0 or more" };
      data.compare_at_price = n;
    }
  }
  if (has("description")) {
    if (typeof body.description !== "string" || body.description.length > 5000) return { error: "Description must be text of 5000 characters or less" };
    data.description = body.description.trim();
  }
  if (has("sku")) {
    if (body.sku !== null && (typeof body.sku !== "string" || body.sku.length > 100)) return { error: "SKU must be text of 100 characters or less" };
    data.sku = body.sku?.trim() || null;
  }
  if (has("stock")) {
    const n = Number(body.stock);
    if (!Number.isInteger(n) || n < 0) return { error: "Stock must be a whole number of 0 or more" };
    data.stock = n;
  }
  if (has("images")) {
    if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES || !body.images.every(isHttpsUrl)) {
      return { error: `images must be a list of up to ${MAX_IMAGES} https URLs` };
    }
    data.images = body.images;
  }
  if (has("variants")) {
    if (!Array.isArray(body.variants) || body.variants.length > MAX_VARIANTS
      || !body.variants.every((v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v))
      || JSON.stringify(body.variants).length > 20000) {
      return { error: `variants must be a list of up to ${MAX_VARIANTS} objects` };
    }
    data.variants = body.variants;
  }
  if (has("status")) {
    if (!VALID_STATUSES.includes(body.status)) return { error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
    data.status = body.status;
  }
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
  return { data };
}