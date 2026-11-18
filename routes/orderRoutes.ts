import { Router } from "express";
import { requireAuth, requireRole, optionalAuth } from "../middleware/auth.js";
import { createOrder, getMerchantOrders, updateOrderStatus, getOrderReceipt, getCustomerOrders } from "../controllers/orderController.js";

const orderRouter = Router();

// Public checkout & receipts
// Guests can order; logged-in customers get the order linked to their account
orderRouter.post("/checkout", optionalAuth, createOrder);
orderRouter.get("/receipt/:orderNumber", getOrderReceipt);

// Customer order history
orderRouter.get("/customer/my-orders", requireAuth, getCustomerOrders);

// Merchant orders
orderRouter.get("/merchant", requireAuth, requireRole(["merchant"]), getMerchantOrders);
orderRouter.patch("/merchant/:id/status", requireAuth, requireRole(["merchant"]), updateOrderStatus);

export default orderRouter;