import { Response } from "express";
import { prisma } from "../config/prisma.js";
import { AuthenticatedRequest } from "../middleware/auth.js";

const VALID_STATUSES = ["active", "draft", "archived"];
const MAX_IMAGES = 10;
const MAX_VARIANTS = 50;

const getMerchantStore = (merchantId: string) =>
    prisma.stores.findFirst({ where: { merchant_id: merchantId }, select: { id: true } });

const isHttpsUrl = (value: unknown) => {
    if (typeof value !== "string") return false;
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}