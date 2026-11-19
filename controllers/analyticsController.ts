import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { countNeonMerchants, findNeonUsersByIds } from "../services/neonUser.js";

const getMerchantStore = (merchantId: string) => prisma.stores.findFirst({ where: { merchant_id: merchantId } })

export const getMerchantAnalytics = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const store = await getMerchantStore(req.user!.id);
    if (!store) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;

    }

    const sid = store.id;
    const [totalOrders, paidAgg, pendingOrders, deliveredOrders, totalProducts, lowStockCount, recentOrders] = await Promise.all([
      prisma.orders.count({ where: { store_id: sid } }),
      prisma.orders.aggregate({
        where: { store_id: sid, payment_status: "paid" }, _sum:
          { total: true }, _avg: { total: true }
      }),
      prisma.orders.count({ where: { store_id: sid, order_status: "placed" } }),
      prisma.orders.count({ where: { store_id: sid, order_status: "delivered" } }),
      prisma.products.count({ where: { store_id: sid } }),
      prisma.products.count({ where: { store_id: sid, stock: { lte: 5 } } }),
      prisma.orders.findMany({
        where: { store_id: sid },
        orderBy: { created_at: "desc" },
        select: {
          id: true, order_number: true, customer_name: true, customer_email: true, total: true, order_status: true, payment_status: true, created_at: true,
        }
      })
    ])

    const totalRevenue = Number(paidAgg._sum.total) || 0;
    const avgOrderValue = Number(paidAgg._avg.total) || 0;

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
    console.error("getMerchantAnalytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch merchant analytics" })
  }
}