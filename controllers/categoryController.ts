import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";


// "Summer Sale!" -> "summer-sale"
const generateSlug = (text: string) => text.toString().toLowerCase().trim()
  .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const getStore = (merchantId: string) => prisma.stores.findFirst({ where: { merchant_id: merchantId } });

export const getCategories = async (req: Request, res: Response): Promise<void> => {
  try {
    const { store_id, storeSlug } = req.query;
    let targetStoreId: number | null = null;

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

    const list = await prisma.categories.findMany({
      where: { store_id: targetStoreId },
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' }
    });

    const categories = list.map(({ _count, ...rest }) => ({ ...rest, product_count: _count.products }));
    res.status(200).json({ success: true, data: categories });
  } catch (error) {
    console.error("getCategories error:", error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
}