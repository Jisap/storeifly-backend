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

/**
 * Controlador: sube UNA imagen a Cloudinary.
 *
 * Ruta esperada: POST con `multipart/form-data`. El archivo debe llegar
 * ya procesado por multer (ej. `upload.single('image')`) con
 * `memoryStorage`, de modo que `req.file.buffer` contenga la imagen.
 * Sin ese middleware, `req.file` será `undefined`.
 *
 * Respuestas:
 *  - 200: `{ success: true, url, public_id }`
 *  - 400: no se envió ningún archivo.
 *  - 500: falló la subida a Cloudinary (o error inesperado).
 *
 * @param req - Petición de Express; `req.file` lo rellena multer.
 * @param res - Respuesta de Express.
 */
export const uploadSingle = async (req: Request, res: Response) => {
  try {
    // Si multer no encontró archivo (campo vacío o nombre de campo
    // incorrecto), se responde con 400 (error del cliente).
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Sube el buffer a la carpeta 'storeifly'. Devuelve la URL ya
    // optimizada (f_auto,q_auto) y el public_id de Cloudinary.
    const { url, public_id } = await uploadToCloudinary(req.file.buffer, 'storeifly');

    // Devuelve ambos datos. Guarda `public_id` si más adelante quieres
    // poder borrar o gestionar la imagen.
    return res.status(200).json({ success: true, url, public_id });
  } catch (error) {
    // El detalle del error se queda en el log del servidor; al cliente
    // solo se le envía un mensaje genérico para no exponer información interna.
    console.error('Error uploading to Cloudinary:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload image' });
  }
}

/**
 * Controlador: sube VARIAS imágenes a Cloudinary en paralelo.
 *
 * Ruta esperada: POST con `multipart/form-data`, procesado por multer con
 * `upload.array('images')` o similar y `memoryStorage`. Los archivos
 * llegan en `req.files` como un array.
 *
 * Respuestas:
 *  - 200: `{ success: true, urls: string[], images: { url, public_id }[] }`
 *         (`urls` es un atajo con solo las URLs; `images` incluye también
 *         los `public_id`).
 *  - 400: no se enviaron archivos.
 *  - 500: falló alguna subida (o error inesperado).
 *
 * ATENCIÓN: si UNA sola subida falla, `Promise.all` rechaza todo y se
 * responde 500, aunque las demás ya se hayan subido. Esas imágenes
 * quedan en Cloudinary sin que el cliente reciba su `public_id`.
 *
 * @param req - Petición de Express; `req.files` lo rellena multer.
 * @param res - Respuesta de Express.
 */
export const uploadMultiple = async (req: Request, res: Response) => {
  try {
    // `req.files` no está tipado con precisión en Express, por eso se
    // fuerza (cast) a un array de archivos de multer. Puede ser
    // `undefined` si multer no encontró ningún archivo.
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    // Lanza todas las subidas a la vez (en paralelo) en lugar de una por
    // una, lo que es mucho más rápido. `Promise.all` espera a que
    // terminen todas y devuelve los resultados en el MISMO ORDEN que `files`.
    const images = await Promise.all(
      files.map((file) => uploadToCloudinary(file.buffer, 'storeifly'))
    );

    // `urls` facilita el uso directo en el frontend; `images` conserva
    // el `public_id` de cada una.
    return res.status(200).json({ success: true, urls: images.map((i) => i.url), images });
  } catch (error) {
    console.error('Error uploading to Cloudinary:', error);
    return res.status(500).json({ success: false, message: 'Failed to upload images' });
  }
}

// AI Transformation of images to cloudinary
export const aiTransform = async (req: Request, res: Response) => {
  try {
    const { imageUrl, action, prompt, toColor, multiple } = req.body ?? {};
    if (!isHttpsUrl(imageUrl)) {
      return res.status(400).json({ success: false, message: 'A valid https imageUrl is required' });
    }
    if (action !== "recolor" && action !== "bg-remove") {
      return res.status(400).json({ success: false, message: 'action must be "recolor" or "bg-remove"' });
    }
    if (action === "recolor" && !prompt) {
      return res.status(400).json({ success: false, message: 'prompt is required for recolor' });
    }

    let baseCloudinaryUrl = imageUrl;

    // Ensure Image is hosted on Cloudinary
    if (!isOwnCloudinaryUrl(imageUrl)) {
      const uploadResult = await cloudinary.uploader.upload(imageUrl, {
        folder: 'storeifly/products',
        resource_type: 'image',
      });
      baseCloudinaryUrl = uploadResult.secure_url;
    }

    const transformedUrl = applyCloudinaryTransformations(baseCloudinaryUrl, action, {
      prompt, toColor, multiple: Boolean(multiple),
    });

    return res.status(200).json({ success: true, transformedUrl, originalUrl: baseCloudinaryUrl });
  } catch (error) {
    console.error('Error transforming image:', error);
    return res.status(500).json({ success: false, message: 'Failed to transform image' });
  }
}