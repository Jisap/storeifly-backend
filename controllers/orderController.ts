import { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { Prisma } from "../generated/prisma/client.js";

const { Decimal } = Prisma;
import { AuthenticatedRequest } from "../middleware/auth.js";
import { isNeonEmailVerified } from "../services/neonUser.js";

const ORDER_STATUSES = ["placed", "pending", "processing", "shipped", "delivered", "cancelled"];
const MAX_LINE_ITEMS = 50;
const MAX_QUANTITY = 100;

// Thrown inside the checkout transaction to roll it back with a 400 message
class CheckoutError extends Error { }

const parseId = (value: unknown) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

const isEmail = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// e.g. "ORD-7K2QX9MBT4WZ": random, so receipts can't be found by guessing
const generateOrderNumber = () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(12);
    return "ORD-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}