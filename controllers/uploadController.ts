import { Request, Response } from 'express';
import cloudinary from '../config/cloudinary.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

// Adds automatic format + quality to a Cloudinary delivery URL
export const optimizeDeliveryUrl = (url: string): string => {
  if (!url || url.includes("/upload/f_auto,q_auto/")) return url;
  return url.replace("/upload/", "/upload/f_auto,q_auto/");
}

// True only if the URL really is hosted on *your* Cloudinary account
const isOwnCloudinaryUrl = (url: string): boolean => {
  const cloudName = cloudinary.config().cloud_name;
  try {
    const u = new URL(url);
    return !!cloudName && u.protocol === "https:" && u.hostname === "res.cloudinary.com"
      && u.pathname.startsWith(`/${cloudName}/image/upload/`);
  } catch {
    return false;
  }
}

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}