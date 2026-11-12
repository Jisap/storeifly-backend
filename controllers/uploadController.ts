import { Request, Response } from 'express';
import cloudinary from '../config/cloudinary.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

/**
 * Optimiza una URL de entrega de Cloudinary añadiendo transformaciones
 * automáticas de formato y calidad.
 *
 * - `f_auto`: Cloudinary elige el mejor formato según el navegador
 *   (WebP, AVIF, etc.) en lugar de servir siempre el original.
 * - `q_auto`: Cloudinary ajusta la calidad para reducir el peso de la
 *   imagen sin que se note la pérdida visual.
 *
 * Ejemplo:
 *   Entrada: https://res.cloudinary.com/mi-cuenta/image/upload/v123/foto.jpg
 *   Salida:  https://res.cloudinary.com/mi-cuenta/image/upload/f_auto,q_auto/v123/foto.jpg
 *
 * @param url - URL original de Cloudinary.
 * @returns La URL con las transformaciones. Si la URL está vacía o ya
 *          las incluye, se devuelve tal cual (es idempotente).
 */
export const optimizeDeliveryUrl = (url: string): string => {
  // Si no hay URL, o ya contiene las transformaciones, no se modifica
  // (evita duplicar "f_auto,q_auto" si se llama varias veces).
  if (!url || url.includes("/upload/f_auto,q_auto/")) return url;

  // Cloudinary aplica transformaciones insertándolas justo después de "/upload/".
  return url.replace("/upload/", "/upload/f_auto,q_auto/");
}

/**
 * Comprueba que una URL pertenece realmente a TU cuenta de Cloudinary.
 *
 * Es una medida de seguridad: evita que un usuario envíe una URL de
 * otro dominio (o de otra cuenta de Cloudinary) y la aceptemos como
 * si fuera una imagen nuestra.
 *
 * Se deben cumplir TODAS estas condiciones:
 *  1. Que exista `cloud_name` en la configuración de Cloudinary.
 *  2. Que el protocolo sea HTTPS.
 *  3. Que el host sea exactamente `res.cloudinary.com`.
 *  4. Que la ruta empiece por `/<cloud_name>/image/upload/`, es decir,
 *     que sea una imagen subida a nuestra cuenta.
 *
 * @param url - URL a validar.
 * @returns `true` si es una URL de imagen de nuestra cuenta; `false` en
 *          cualquier otro caso (incluida una URL mal formada).
 */
const isOwnCloudinaryUrl = (url: string): boolean => {
  // Nombre de la cuenta de Cloudinary configurada en el servidor.
  const cloudName = cloudinary.config().cloud_name;
  try {
    // `new URL()` lanza una excepción si el texto no es una URL válida.
    const u = new URL(url);
    // `!!cloudName` convierte el valor a booleano y garantiza que no esté vacío.
    return !!cloudName && u.protocol === "https:" && u.hostname === "res.cloudinary.com"
      && u.pathname.startsWith(`/${cloudName}/image/upload/`);
  } catch {
    // URL mal formada → no es válida.
    return false;
  }
}

/**
 * Type guard: comprueba que un valor desconocido es un string con una
 * URL que usa HTTPS.
 *
 * Al declarar `value is string`, TypeScript sabe que, dentro de un `if`
 * donde esta función devuelva `true`, la variable ya es de tipo `string`.
 * Es útil para validar datos que llegan de `req.body` (tipo `unknown`).
 *
 * Nota: solo valida el protocolo, NO el dominio. Para comprobar que la
 * imagen es nuestra hay que usar además `isOwnCloudinaryUrl`.
 *
 * @param value - Valor a comprobar (puede ser de cualquier tipo).
 * @returns `true` si es un string con URL válida y protocolo HTTPS.
 */
const isHttpsUrl = (value: unknown): value is string => {
  // Si no es un string (número, objeto, undefined...) no puede ser una URL.
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    // El texto no tiene formato de URL.
    return false;
  }
}

export function applyCloudinaryTransformations(
  url: string,
  action: "recolor" | "bg-remove",
  options: { prompt?: string; toColor?: string; multiple?: boolean } = {},
): string {
  // Only letters, numbers and spaces may reach the URL, so users can't inject extra transformations
  const prompt = (options.prompt || "").replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 100);
  const toColor = (options.toColor || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || "red";

  const transform = action === "bg-remove"
    ? "e_background_removal/f_auto,q_auto"
    : `e_gen_recolor:prompt_${encodeURIComponent(prompt)};to-color_${toColor}${options.multiple ? ";multiple_true" : ""}/f_auto,q_auto`;

  return url.replace("/image/upload/", `/image/upload/${transform}/`);
}

export const uploadToCloudinary = (
  fileBuffer: Buffer,
  folder: string = 'storeifly',
): Promise<{ url: string; public_id: string }> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Failed to upload image'));
        } else {
          resolve({ url: optimizeDeliveryUrl(result.secure_url), public_id: result.public_id });
        }
      }
    );
    uploadStream.end(fileBuffer);
  });
}