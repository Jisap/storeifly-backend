import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";

// "Summer Sale!" -> "summer-sale"
const generateSlug = (text: string) => text.toString().toLowerCase().trim()
  .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const getStore = (merchantId: string) => prisma.stores.findFirst({ where: { merchant_id: merchantId } });

/**
 * Obtiene las categorías de una tienda junto con el conteo de productos asociados.
 * 
 * Flujo:
 * 1. Resuelve el ID de la tienda a partir de `storeSlug` (prioritario) o `store_id` recibidos por query param.
 * 2. Valida la existencia de la tienda o la validez del ID numérico.
 * 3. Consulta las categorías ordenadas alfabéticamente incluyendo la agregación del total de productos.
 * 4. Mapea la respuesta para exponer `product_count` de forma limpia.
 */
export const getCategories = async (req: Request, res: Response): Promise<void> => {
  try {
    const { store_id, storeSlug } = req.query;
    let targetStoreId: number | null = null;

    // 1. Resolución de la tienda: busca por slug si está presente, o valida el store_id numérico
    if (typeof storeSlug === 'string' && storeSlug) {
      const store = await prisma.stores.findUnique({ where: { slug: storeSlug }, select: { id: true } });
      if (!store) {
        res.status(404).json({ success: false, message: 'Store not found' });
        return;
      }
      targetStoreId = store.id;
    } else if (store_id) {
      const id = Number(store_id);
      if (Number.isInteger(id) && id > 0) targetStoreId = id;
    }

    if (!targetStoreId) {
      res.status(400).json({ success: false, message: 'Missing or invalid store_id or storeSlug query parameter' });
      return;
    }

    // 2. Consulta de categorías ordenadas alfabéticamente con el recuento de productos
    const list = await prisma.categories.findMany({
      where: { store_id: targetStoreId },
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' }
    });

    // 3. Normalización: transforma el objeto anidado `_count.products` en un campo plano `product_count`
    const categories = list.map(({ _count, ...rest }) => ({ ...rest, product_count: _count.products }));
    res.status(200).json({ success: true, data: categories });
  } catch (error) {
    console.error("getCategories error:", error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
};
