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

/**
 * Aplica una transformación de IA de Cloudinary a una URL de imagen ya
 * subida, insertándola en la propia URL (Cloudinary transforma "al vuelo"
 * al servir la imagen; el original no se modifica).
 *
 * Acciones disponibles:
 *  - `"bg-remove"`: elimina el fondo de la imagen (`e_background_removal`).
 *  - `"recolor"`: cambia el color de un objeto descrito con texto
 *    (`e_gen_recolor`). Ejemplo: prompt "sofa" + toColor "blue" → el sofá
 *    de la imagen se vuelve azul.
 *
 * Ejemplo (recolor):
 *   Entrada: https://res.cloudinary.com/mi-cuenta/image/upload/v123/foto.jpg
 *   Salida:  https://res.cloudinary.com/mi-cuenta/image/upload/
 *            e_gen_recolor:prompt_sofa;to-color_blue/f_auto,q_auto/v123/foto.jpg
 *
 * IMPORTANTE: esta función NO valida que la URL sea de tu cuenta. Antes de
 * llamarla, comprueba la URL con `isOwnCloudinaryUrl`.
 *
 * @param url     - URL de la imagen en Cloudinary (debe contener "/image/upload/").
 * @param action  - Transformación a aplicar: "recolor" o "bg-remove".
 * @param options - Opciones, solo usadas en "recolor":
 *   - `prompt`:  texto que describe QUÉ objeto recolorear (ej. "sofa").
 *   - `toColor`: color destino (ej. "blue"). Por defecto "red".
 *   - `multiple`: si es true, recolorea TODAS las instancias del objeto
 *                 y no solo la más prominente.
 * @returns La URL con la transformación insertada.
 */
export function applyCloudinaryTransformations(
  url: string,
  action: "recolor" | "bg-remove",
  options: { prompt?: string; toColor?: string; multiple?: boolean } = {},
): string {
  // SEGURIDAD: estos valores vienen del usuario y acaban dentro de la URL.
  // Si no se limpian, alguien podría colar "/" , ";" o "," y añadir
  // transformaciones extra. Por eso solo se permiten letras, números y espacios.
  // - `.replace(/[^a-zA-Z0-9 ]/g, "")` elimina cualquier otro carácter.
  //   (Ojo: también elimina tildes y ñ, así que "sofá" pasaría a "sof".)
  // - `.trim()` quita espacios sobrantes en los extremos.
  // - `.slice(0, 100)` limita la longitud a 100 caracteres.
  const prompt = (options.prompt || "").replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 100);

  // Igual para el color, pero sin espacios, máximo 20 caracteres.
  // Si queda vacío (no se envió o todo era inválido), se usa "red" por defecto.
  // Ojo: un color en hex con "#" (ej. "#ff0000") perdería el "#" → "ff0000".
  const toColor = (options.toColor || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || "red";

  // Se construye el segmento de transformación que irá en la URL.
  const transform = action === "bg-remove"
    // Quitar fondo + formato y calidad automáticos.
    ? "e_background_removal/f_auto,q_auto"
    // Recolorear. Sintaxis de Cloudinary:
    //   e_gen_recolor:prompt_<objeto>;to-color_<color>[;multiple_true]
    // `encodeURIComponent` convierte los espacios en %20 para que la URL sea válida.
    // `;multiple_true` solo se añade si options.multiple es true.
    : `e_gen_recolor:prompt_${encodeURIComponent(prompt)};to-color_${toColor}${options.multiple ? ";multiple_true" : ""}/f_auto,q_auto`;

  // Cloudinary lee las transformaciones justo después de "/image/upload/".
  // Si la URL no contiene ese fragmento, `replace` no hace nada y se
  // devuelve la URL sin cambios.
  return url.replace("/image/upload/", `/image/upload/${transform}/`);
}

/**
 * Sube una imagen (en memoria) a Cloudinary mediante un stream.
 *
 * Recibe un `Buffer`, por lo que encaja con archivos recibidos con
 * multer usando `memoryStorage` (el archivo no se guarda en disco).
 *
 * @param fileBuffer - Contenido binario de la imagen.
 * @param folder     - Carpeta de Cloudinary donde se guardará.
 *                     Por defecto: 'storeifly'.
 * @returns Promesa con:
 *   - `url`: URL HTTPS de la imagen, ya optimizada con f_auto,q_auto.
 *   - `public_id`: identificador en Cloudinary. Guárdalo: lo necesitarás
 *     para borrar o referenciar la imagen más adelante.
 * @throws Rechaza la promesa si Cloudinary devuelve un error o no devuelve resultado.
 */
export const uploadToCloudinary = (
  fileBuffer: Buffer,
  folder: string = 'storeifly',
): Promise<{ url: string; public_id: string }> => {
  // `upload_stream` trabaja con callbacks, no con promesas. Se envuelve
  // en una `Promise` para poder usarlo con async/await.
  return new Promise((resolve, reject) => {
    // Crea un stream de escritura hacia Cloudinary.
    // `resource_type: "image"` indica que el archivo es una imagen.
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      // Callback: se ejecuta cuando termina la subida (con éxito o error).
      (error, result) => {
        if (error || !result) {
          // Si no hay `error` pero tampoco `result`, se crea un error genérico.
          reject(error || new Error('Failed to upload image'));
        } else {
          // `secure_url` es la URL https; se le añade f_auto,q_auto.
          resolve({ url: optimizeDeliveryUrl(result.secure_url), public_id: result.public_id });
        }
      }
    );
    // Escribe el buffer en el stream y lo cierra, lo que dispara la subida.
    // Debe ir DESPUÉS de crear el stream; sin `.end()` la subida nunca termina.
    uploadStream.end(fileBuffer);
  });
}

// Upload single image to cloudinary
export const uploadSingle = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const { url, public_id } = await uploadToCloudinary(req.file.buffer, 'storeifly');
    return res.status(200).json({ success: true, url, public_id });
  } catch (error) {
    console.error('Error uploading to Cloudinary:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload image' });
  }
}

// upload multiple images to cloudinary in parallel
export const uploadMultiple = async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    const images = await Promise.all(
      files.map((file) => uploadToCloudinary(file.buffer, 'storeifly'))
    );
    return res.status(200).json({ success: true, urls: images.map((i) => i.url), images });
  } catch (error) {
    console.error('Error uploading to Cloudinary:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload images' });
  }
}