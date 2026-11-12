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

/**
 * Controlador: aplica una transformación de IA de Cloudinary a una imagen
 * y devuelve la URL resultante.
 *
 * Ruta esperada: POST con body JSON (necesita `express.json()`):
 *   {
 *     "imageUrl": "https://...",        // obligatorio, debe ser https
 *     "action":   "recolor" | "bg-remove", // obligatorio
 *     "prompt":   "sofa",               // obligatorio solo en "recolor"
 *     "toColor":  "blue",               // opcional (por defecto "red")
 *     "multiple": true                  // opcional
 *   }
 *
 * Flujo:
 *  1. Valida los datos de entrada.
 *  2. Si la imagen NO está en tu Cloudinary, la copia allí primero
 *     (las transformaciones de IA solo funcionan con imágenes alojadas
 *     en Cloudinary).
 *  3. Construye la URL transformada con `applyCloudinaryTransformations`.
 *
 * Respuestas:
 *  - 200: `{ success: true, transformedUrl, originalUrl }`
 *         (`originalUrl` es la URL base en Cloudinary, sin transformar).
 *  - 400: datos de entrada inválidos.
 *  - 500: error inesperado (p. ej. falló la copia a Cloudinary).
 *
 * NOTA: Cloudinary no transforma la imagen cuando se llama a este
 * controlador, sino la primera vez que alguien abre `transformedUrl`.
 *
 * @param req - Petición de Express con el body descrito arriba.
 * @param res - Respuesta de Express.
 */
export const aiTransform = async (req: Request, res: Response) => {
  try {
    // `req.body ?? {}` evita un error si el body llega `undefined`
    // (por ejemplo, si falta el middleware `express.json()`).
    const { imageUrl, action, prompt, toColor, multiple } = req.body ?? {};

    // VALIDACIÓN 1: imageUrl debe ser un string con una URL https.
    // Gracias al type guard, a partir de aquí TypeScript sabe que
    // `imageUrl` es `string`.
    if (!isHttpsUrl(imageUrl)) {
      return res.status(400).json({ success: false, message: 'A valid https imageUrl is required' });
    }

    // VALIDACIÓN 2: solo se aceptan las dos acciones soportadas.
    // También estrecha el tipo de `action` a "recolor" | "bg-remove".
    if (action !== "recolor" && action !== "bg-remove") {
      return res.status(400).json({ success: false, message: 'action must be "recolor" or "bg-remove"' });
    }

    // VALIDACIÓN 3: para recolorear hace falta saber QUÉ objeto
    // recolorear, así que el prompt es obligatorio.
    if (action === "recolor" && !prompt) {
      return res.status(400).json({ success: false, message: 'prompt is required for recolor' });
    }

    // URL de la imagen ya alojada en Cloudinary. Empieza siendo la
    // que envió el cliente y se sustituye si hay que copiarla.
    let baseCloudinaryUrl = imageUrl;

    // Las transformaciones de IA requieren que la imagen esté en
    // Cloudinary. Si la URL es de otro sitio (otro dominio u otra
    // cuenta de Cloudinary), se le pide a Cloudinary que la descargue
    // y la guarde en la carpeta 'storeifly/products'.
    if (!isOwnCloudinaryUrl(imageUrl)) {
      const uploadResult = await cloudinary.uploader.upload(imageUrl, {
        folder: 'storeifly/products',
        resource_type: 'image',
      });
      // A partir de ahora se trabaja con la copia en nuestra cuenta.
      baseCloudinaryUrl = uploadResult.secure_url;
    }

    // Inserta la transformación en la URL. `applyCloudinaryTransformations`
    // sanea `prompt` y `toColor` internamente.
    // `Boolean(multiple)` convierte cualquier valor recibido a true/false.
    const transformedUrl = applyCloudinaryTransformations(baseCloudinaryUrl, action, {
      prompt, toColor, multiple: Boolean(multiple),
    });

    // Se devuelven ambas URLs para que el frontend pueda mostrar
    // el "antes y después" o guardar la que prefiera.
    return res.status(200).json({ success: true, transformedUrl, originalUrl: baseCloudinaryUrl });
  } catch (error) {
    // El detalle queda en el log del servidor; el cliente solo recibe
    // un mensaje genérico.
    console.error('Error transforming image:', error);
    return res.status(500).json({ success: false, message: 'Failed to transform image' });
  }
}

/**
 * Garantiza que una imagen esté alojada en TU cuenta de Cloudinary y
 * devuelve su URL.
 *
 * - Si la URL ya es de tu cuenta (`isOwnCloudinaryUrl`), se devuelve tal
 *   cual, sin subir nada (evita duplicados).
 * - Si es de otro sitio, le pide a Cloudinary que la descargue y la
 *   guarde en `folder`, y devuelve la URL de la copia.
 *
 * Es la versión reutilizable del bloque "Ensure Image is hosted on
 * Cloudinary" de `aiTransform`, pensada para funciones que necesitan
 * trabajar siempre con imágenes alojadas en tu cuenta (aquí, por el
 * nombre de la carpeta por defecto, el probador virtual / "try-on").
 *
 * @param url    - URL de la imagen (se espera https; validar antes con `isHttpsUrl`).
 * @param folder - Carpeta de Cloudinary para la copia.
 *                 Por defecto: 'storeifly/tryon'.
 * @returns La URL https de la imagen en tu cuenta de Cloudinary.
 * @throws Error('Failed to upload image to Cloudinary') si la subida falla.
 */
const ensureCloudinaryUrl = async (url: string, folder = 'storeifly/tryon'): Promise<string> => {
  // Atajo: si la imagen ya es nuestra no hace falta subirla otra vez.
  if (isOwnCloudinaryUrl(url)) {
    return url;
  }

  // Cloudinary descarga la imagen desde `url` y la guarda en nuestra cuenta.
  // `.catch()` se encadena directamente a la promesa de `upload` para
  // interceptar el error en este punto.
  const res = await cloudinary.uploader.upload(url, {
    folder,
    resource_type: 'image',
  }).catch((error) => {
    // El detalle real (URL inaccesible, formato no válido, credenciales...)
    // se queda en el log del servidor.
    console.error('Error uploading to Cloudinary:', error);
    // Se lanza un error genérico: quien llame a la función no recibe
    // detalles internos de Cloudinary. Al ser `async`, este `throw`
    // se convierte en un rechazo de la promesa.
    throw new Error('Failed to upload image to Cloudinary');
  });

  // `secure_url` es la URL https de la copia ya alojada en tu cuenta.
  return res.secure_url;
}

/**
 * Parámetros de entrada para generar una imagen "on model": una imagen
 * en la que el producto aparece puesto sobre una modelo (probador virtual).
 */
export interface GenerateOnModelImageParams {
  /** Instrucción de texto que describe la imagen a generar. */
  prompt: string;
  /** URL de la imagen del producto (ej. una prenda). */
  productImageUrl: string;
  /** URL de la imagen de la modelo sobre la que se coloca el producto. */
  modelImage: string;
  /** `public_id` con el que se guardará el resultado en tu Cloudinary. */
  targetPublicId: string;
  /** Opcional: preferencia de modelo de IA. Si se omite, Cloudinary decide. */
  preference?: string;
}

/**
 * Resultado de la generación.
 */
export interface GenerateOnModelResult {
  /** URL https de la imagen generada (ya optimizada con f_auto,q_auto). */
  secureUrl: string;
  /** `public_id` de la imagen generada en Cloudinary. */
  publicId: string;
  /** Opcional: modelo de IA que se usó realmente. */
  model?: string;
  /** Opcional: información de límites/cuota devuelta por la API
   *  (tipado como `any` porque su forma no está definida aquí). */
  limits?: any;
}

/**
 * Genera una imagen del producto puesto sobre una modelo llamando a la
 * API de generación con IA de Cloudinary (endpoint `image_to_image`).
 *
 * Flujo:
 *  1. Comprueba que las credenciales de Cloudinary están configuradas.
 *  2. Construye el payload (prompt + imágenes de referencia + destino).
 *  3. Hace una petición POST autenticada con Basic auth.
 *  4. Valida la respuesta y extrae la URL de la imagen generada.
 *  5. Devuelve la URL optimizada, el public_id y metadatos.
 *
 * Las URLs de entrada deben ser accesibles por Cloudinary. Conviene
 * pasarlas antes por `isHttpsUrl` y `ensureCloudinaryUrl`.
 *
 * @param params - Ver `GenerateOnModelImageParams`.
 * @returns Promesa con `GenerateOnModelResult`.
 * @throws Error si faltan credenciales, si la API responde con error
 *         (el error incluye `status` y `details`) o si la respuesta no
 *         contiene ninguna URL de imagen.
 */
export const generateOnModelImage = async (params: GenerateOnModelImageParams):
  Promise<GenerateOnModelResult> => {
  // Lee la configuración de Cloudinary del servidor. Esta llamada va
  // directa a la API REST (no usa el SDK), así que necesita las TRES
  // credenciales: cloud_name, api_key y api_secret.
  const { cloud_name, api_key, api_secret } = cloudinary.config();

  // Si falta alguna, se corta aquí con un mensaje claro en vez de
  // fallar más tarde con un error de autenticación poco descriptivo.
  if (!cloud_name || !api_key || !api_secret) {
    throw new Error("Cloudinary instance credentials are not configured");
  }

  // Cuerpo de la petición que se enviará a la API.
  const payload = {
    // Texto con las instrucciones de generación.
    prompt: params.prompt,

    // Imágenes de referencia que la IA usa como base. El ORDEN importa
    // y debe ser coherente con tu prompt: primero la modelo, después
    // el producto. `source_type: "url"` indica que se pasan por URL.
    reference_images: [
      { source_type: "url", url: params.modelImage },
      { source_type: "url", url: params.productImageUrl },
    ],

    // Selección del modelo de IA. `mode: "auto"` deja que Cloudinary
    // elija. Si se pasó `preference`, se añade con un spread condicional:
    // `...(cond ? {a} : {})` añade la propiedad solo cuando existe.
    model: { mode: "auto", ...(params.preference ? { preference: params.preference } : {}) },

    // Dónde guardar el resultado: como un asset gestionado por
    // Cloudinary bajo el `public_id` indicado.
    target: { target_type: "managed_asset", public_id: params.targetPublicId },
  };

  // Petición a la API de generación. El cloud_name va en la propia ruta.
  // Se usa `fetch` nativo (disponible en Node 18+).
  const response = await fetch(`https://api.cloudinary.com/v2/generate/${cloud_name}/image_to_image`, {
    method: "POST",
    headers: {
      // Basic auth: "api_key:api_secret" codificado en base64.
      // Estas credenciales nunca deben enviarse al cliente ni escribirse en logs.
      Authorization: `Basic ${Buffer.from(`${api_key}:${api_secret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // Lee el cuerpo como JSON. Si la respuesta no es JSON válido (ej. una
  // página de error HTML), `.catch` devuelve `null` en vez de lanzar,
  // y el control de errores de abajo lo gestiona.
  const data: any = await response.json().catch(() => null);

  // Error si el HTTP no es 2xx o si no hubo cuerpo interpretable.
  if (!response.ok || !data) {
    // Mensaje: el de la API si existe; si no, uno genérico con el código HTTP.
    const err: any = new Error(data?.error?.message || data?.message || `Cloudinary API error (${response.status})`);
    // Se adjuntan `status` y `details` al error para que quien lo capture
    // (ej. un controlador) pueda responder con el código adecuado
    // (400, 401, 429...) y registrar los detalles.
    err.status = response.status;
    err.details = data?.error;
    throw err;
  }

  // La API puede devolver los assets en rutas distintas según la versión
  // o el tipo de respuesta, por eso se prueban dos ubicaciones con `?.`
  // (optional chaining), que evita errores si algún nivel no existe.
  const asset = data?.data?.assets?.[0] || data?.data?.result?.assets?.[0];

  // Se busca la URL de la imagen en varios sitios posibles, por orden de
  // preferencia: asset.storage.secure_url → asset.secure_url → raíz.
  const rawUrl = asset?.storage?.secure_url || asset?.secure_url || data?.secure_url;

  // Si la API respondió bien pero sin URL, se trata como error.
  if (!rawUrl) throw new Error("No image URL returned from Cloudinary generation");

  return {
    // URL con `f_auto,q_auto` añadido (formato y calidad automáticos).
    secureUrl: optimizeDeliveryUrl(rawUrl),
    // Se prefiere el public_id que devuelve la API; si no viene, se usa
    // el que se pidió en `targetPublicId`.
    publicId: asset?.storage?.public_id || params.targetPublicId,
    // Modelo de IA usado realmente (si la API lo informa).
    model: asset?.model,
    // Datos de cuota/límites (si la API los informa).
    limits: data?.limits,
  };
}

/**
 * Controlador: genera una imagen "on model" (fotografía de catálogo /
 * probador virtual) con IA a partir de la imagen de un producto y la de
 * una modelo.
 *
 * Requiere usuario autenticado (`AuthenticatedRequest`): el middleware de
 * auth debe haber rellenado `req.user` antes de llegar aquí.
 *
 * Ruta esperada: POST con body JSON (necesita `express.json()`):
 *   {
 *     "productImageUrl": "https://...",  // obligatorio, https
 *     "modelImage":      "https://...",  // obligatorio, https
 *     "customPrompt":    "texto",        // opcional, máx. 1000 caracteres
 *     "preference":      "..."           // opcional, preferencia de modelo de IA
 *   }
 *
 * Flujo:
 *  1. Valida los datos de entrada.
 *  2. Se asegura de que ambas imágenes estén en tu Cloudinary
 *     (`ensureCloudinaryUrl`), subiendo una copia si hace falta.
 *  3. Construye el prompt que se enviará a la IA.
 *  4. Genera un `public_id` de destino controlado por el servidor.
 *  5. Llama a `generateOnModelImage` y devuelve el resultado.
 *
 * Respuestas:
 *  - 200: `{ success, url, public_id, model, prompt, modelUrl, productUrl, limits }`
 *  - 400: datos de entrada inválidos.
 *  - 500: cualquier error inesperado (subida, API de IA, etc.).
 *
 * @param req - Petición autenticada de Express con el body descrito arriba.
 * @param res - Respuesta de Express.
 */
export const aiOnModel = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // `req.body ?? {}` evita un error si el body llega `undefined`
    // (por ejemplo, si falta el middleware `express.json()`).
    const { productImageUrl, modelImage, customPrompt, preference } = req.body ?? {};

    // VALIDACIÓN 1: ambas imágenes deben ser strings con URL https.
    // Gracias al type guard, TypeScript sabe que ambas son `string`
    // a partir de aquí.
    if (!isHttpsUrl(productImageUrl) || !isHttpsUrl(modelImage)) {
      return res.status(400).json({ success: false, message: 'Both productImageUrl and modelImage (https URLs) are required' });
    }

    // VALIDACIÓN 2: `customPrompt` es opcional, pero si viene debe ser
    // un string de como máximo 1000 caracteres (limita abusos y coste).
    if (customPrompt !== undefined && (typeof customPrompt !== "string" || customPrompt.length > 1000)) {
      return res.status(400).json({ success: false, message: 'customPrompt must be text of 1000 characters or less' });
    }

    // Garantiza que las dos imágenes estén alojadas en TU Cloudinary.
    // Se procesan en paralelo (`Promise.all`) y el resultado llega en el
    // mismo orden: [modelo, producto]. Cada una va a su propia carpeta.
    // Si alguna subida falla, `ensureCloudinaryUrl` lanza un error y se
    // salta al `catch` (responde 500).
    const [modelUrl, productUrl] = await Promise.all([
      ensureCloudinaryUrl(modelImage, 'storeifly/models'),
      ensureCloudinaryUrl(productImageUrl, 'storeifly/products'),
    ]);

    // CONSTRUCCIÓN DEL PROMPT. Hay tres casos:
    //  1. `customPrompt` con marcadores "[1]" y "[2]": se sustituyen por
    //     las URLs. [1] → producto, [2] → modelo.
    //     Ej.: "Pon la prenda [1] sobre la modelo [2]"
    //     (`replace` con string solo cambia la PRIMERA aparición de cada marcador).
    //  2. `customPrompt` sin marcadores: se le añaden las URLs al final
    //     (producto primero, modelo después).
    //  3. Sin `customPrompt` (o solo espacios): se usa un prompt por defecto.
    const prompt = customPrompt?.trim()
      ? customPrompt.includes("[1]") && customPrompt.includes("[2]")
        ? customPrompt.replace("[1]", productUrl).replace("[2]", modelUrl)
        : `${customPrompt} ${productUrl} ${modelUrl}`
      : `A high-quality image of a model wearing the product. Product image: ${productUrl}. Model image: ${modelUrl}.`;

    // SEGURIDAD: el `public_id` de destino lo genera el servidor, nunca
    // el cliente, para que nadie pueda sobrescribir assets ajenos de tu
    // cuenta. Formato: storeifly/tryon/<id de usuario>/<timestamp en ms>.
    // `req.user!` (el "!" afirma que no es undefined) es seguro SOLO si
    // la ruta está protegida por el middleware de autenticación.
    const targetPublicId = `storeifly/tryon/${req.user!.id}/${Date.now()}`;

    // Llama a la API de IA de Cloudinary (ver `generateOnModelImage`).
    const result = await generateOnModelImage({
      prompt,
      modelImage: modelUrl,
      productImageUrl: productUrl,
      targetPublicId,
      // Solo se pasa `preference` si es un string; cualquier otro tipo se ignora.
      preference: typeof preference === "string" ? preference : undefined,
    });

    // Se devuelve la imagen generada y también los datos intermedios
    // (prompt final y URLs en tu Cloudinary), útiles para mostrarlos,
    // depurar o regenerar con el mismo prompt.
    return res.status(200).json({
      success: true,
      url: result.secureUrl,
      public_id: result.publicId,
      model: result.model,
      prompt,
      modelUrl,
      productUrl,
      limits: result.limits,
    });
  } catch (error) {
    // El detalle queda en el log del servidor; el cliente solo recibe
    // un mensaje genérico.
    console.error('Error in on-model photography:', error);
    return res.status(500).json({ success: false, message: 'Failed to process on-model photography' });
  }
}