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

/**
 * Crea una nueva categoría asociada a la tienda del comerciante autenticado.
 * 
 * Flujo:
 * 1. Recupera la tienda asociada al comerciante actual (`req.user.id`).
 * 2. Valida la presencia, formato y longitud máxima del nombre.
 * 3. Genera el slug normalizado a partir del nombre ingresado.
 * 4. Comprueba que no exista una categoría previa con el mismo slug en esta tienda (409 Conflict).
 * 5. Registra la nueva categoría en la base de datos (201 Created).
 */
export const createCategory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // 1. Localiza la tienda perteneciente al comerciante autenticado
    const store = await getStore(req.user!.id);
    if (!store) {
      res.status(404).json({ success: false, message: 'Store not found' });
      return;
    }

    // 2. Validaciones de entrada sobre el nombre de la categoría
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: 'Category name is required' });
      return;
    }
    if (name.trim().length > 255) {
      res.status(400).json({ success: false, message: 'Category name must be 255 characters or less' });
      return;
    }

    // 3. Generación y comprobación de slug válido (requiere caracteres alfanuméricos)
    const slug = generateSlug(name);
    if (!slug) {
      res.status(400).json({ success: false, message: 'Category name must contain letters or numbers' });
      return;
    }

    // 4. Comprobación de unicidad de categoría por tienda para evitar duplicados
    const existing = await prisma.categories.findFirst({ where: { store_id: store.id, slug } });
    if (existing) {
      res.status(409).json({ success: false, message: 'A category with this name already exists' });
      return;
    }

    // 5. Creación de la categoría en base de datos
    const category = await prisma.categories.create({
      data: {
        store_id: store.id,
        name: name.trim(),
        slug,
      },
    });
    res.status(201).json({ success: true, data: category });
  } catch (error) {
    console.error("createCategory error:", error);
    res.status(500).json({ success: false, message: 'Failed to create category' });
  }
};
