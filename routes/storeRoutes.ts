import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createStore,
  onboardMerchant,
  getMyStore,
  updateMyStore,
  getAllStores,
  getAllMerchants,
  toggleStoreStatus
} from "../controllers/storeController.js";

const storeRouter = Router();

// Merchant routes
storeRouter.post("/", requireAuth, createStore);
storeRouter.post("/onboard-merchant", requireAuth, onboardMerchant);
storeRouter.get("/me", requireAuth, getMyStore);
storeRouter.put("/me", requireAuth, updateMyStore);

// Any logged-in user can become a merchant before creating a store
storeRouter.post("/onboard", requireAuth, onboardMerchant);

// Merchant manages their own store
storeRouter.get("/my-store", requireAuth, requireRole(["merchant"]), getMyStore);
storeRouter.put("/my-store", requireAuth, requireRole(["merchant"]), updateMyStore);

// Platform admin only
storeRouter.get("/admin/all", requireAuth, requireRole(["admin"]), getAllStores);
storeRouter.get("/admin/merchants", requireAuth, requireRole(["admin"]), getAllMerchants);
storeRouter.patch("/:id/toggle-status", requireAuth, requireRole(["admin"]), toggleStoreStatus);

export default storeRouter;