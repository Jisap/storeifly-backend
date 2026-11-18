import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { uploadSingle, uploadMultiple, aiTransform, aiOnModel } from "../controllers/uploadController.js";

const uploadRouter = Router()

uploadRouter.post("/single", requireAuth, upload.single("image"), uploadSingle);
uploadRouter.post("/multiple", requireAuth, upload.array("images", 10), uploadMultiple);
uploadRouter.post("/ai-transform", requireAuth, requireRole(["merchant"]), aiTransform);
uploadRouter.post("/ai-on-model", requireAuth, requireRole(["merchant"]), aiOnModel);

export default uploadRouter;