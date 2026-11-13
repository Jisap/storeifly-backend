import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";

/**
 * Convierte un texto en un "slug": una versión apta para URLs (minúsculas,
 * sin símbolos y con guiones en lugar de espacios).
 *
 * Ejemplo:
 *   "  Mi Tienda   Genial! " → "mi-tienda-genial"
 *
 * Pasos (en orden):
 *  1. `toString()`: asegura que se trabaja con un string.
 *  2. `toLowerCase()`: pasa todo a minúsculas.
 *  3. `trim()`: quita espacios al inicio y al final.
 *  4. `replace(/[^a-z0-9\s-]/g, '')`: elimina todo lo que no sea letra
 *     a-z, número, espacio o guion.
 *  5. `replace(/\s+/g, '-')`: convierte cada grupo de espacios en un guion.
 *  6. `replace(/-+/g, '-')`: colapsa guiones repetidos en uno solo.
 *  7. `replace(/^-|-$/g, '')`: quita guiones al principio y al final.
 *
 * LIMITACIONES:
 *  - Los caracteres con tilde o la ñ se ELIMINAN (no se transliteran):
 *    "Café Ñandú" → "caf-and"(se pierden é, Ñ y ú).
 *  - Un texto sin caracteres válidos (ej. "!!!" o "日本") devuelve "" (vacío).
 *  - No garantiza unicidad: dos nombres distintos pueden dar el mismo slug.
 *
 * @param text - Texto de origen (por ejemplo, el nombre de la tienda).
 * @returns El slug generado (puede ser una cadena vacía).
 */
const generateSlug = (text: string) => text.toString().toLowerCase().trim()
  .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/**
 * Listas blancas (valores permitidos) para campos que llegan del cliente.
 * Se usan para validar que el valor recibido sea uno de los esperados
 * antes de guardarlo en la base de datos, por ejemplo:
 *   VALID_HEROES.includes(req.body.hero)
 *
 * - VALID_HEROES: plantillas de cabecera ("hero") disponibles para la tienda.
 * - VALID_PAYMENT_METHODS: métodos de pago admitidos (dinero móvil, pago
 *   contra entrega y transferencia bancaria).
 * - VALID_STATUSES: estados posibles de una tienda (activa o suspendida).
 *
 * Si añades una opción nueva (otro hero, otro método de pago...), debes
 * añadirla aquí; si no, la validación la rechazará.
 */
const VALID_HEROES = ["hero1", "hero2", "hero3", "hero4"];
const VALID_PAYMENT_METHODS = ["mobile_money", "cash_on_delivery", "bank_transfer"];
const VALID_STATUSES = ["active", "suspended"];

/**
 * Comprueba si un string es una URL válida que usa HTTPS.
 *
 * Es una versión simplificada de la `isHttpsUrl` del archivo de Cloudinary:
 * aquí el parámetro es `string`, no `unknown`, y NO es un type guard
 * (devuelve un `boolean` normal). Por tanto, si el valor viene de
 * `req.body`, hay que comprobar antes que sea un string.
 *
 * Solo valida el protocolo, no el dominio.
 *
 * @param value - Texto a comprobar.
 * @returns `true` si es una URL válida con protocolo https; `false` si no.
 */
const isHttpsUrl = (value: string) => {
  try {
    // `new URL()` lanza una excepción si el texto no es una URL válida.
    return new URL(value).protocol === "https:";
  } catch {
    // Texto con formato de URL incorrecto.
    return false;
  }
}

/**
 * Valida y limpia los campos de una tienda que un comerciante puede
 * establecer, a partir del body de una petición.
 *
 * Se usa tanto al CREAR una tienda (`partial = false`) como al
 * ACTUALIZARLA (`partial = true`):
 *  - Creación: `name` es obligatorio; el resto de campos son opcionales.
 *  - Actualización: todos los campos son opcionales, y solo se validan
 *    y devuelven los que vengan en el body.
 *
 * IMPORTANTE (lista blanca): solo se copian a `data` los campos que se
 * comprueban aquí. Cualquier otro campo del body (por ejemplo `status`,
 * `slug` o `owner_id`) se IGNORA, lo que evita que el cliente modifique
 * datos que no le corresponden (mass assignment).
 *
 * Campos soportados:
 *  - name: string, obligatorio al crear, máx. 255 caracteres.
 *  - description: string, máx. 2000 caracteres.
 *  - address: string, máx. 500 caracteres.
 *  - logo_url / banner_url: URL https, o "" / null para borrarla.
 *  - currency: código de 3 letras (ej. "ghs" → "GHS").
 *  - shipping_fee / free_shipping_threshold: número >= 0.
 *  - payment_methods: array no vacío con valores de VALID_PAYMENT_METHODS.
 *  - hero_style: uno de VALID_HEROES.
 *  - accent_color: color hex de 6 dígitos (ej. "#059669").
 *
 * @param body    - Body de la petición (`req.body`), sin tipar (`any`).
 * @param partial - `true` para actualizaciones (todo opcional), `false` para creación.
 * @returns Un objeto con UNA de estas dos formas (union type):
 *   - `{ data }`  → datos validados y limpios, listos para Prisma.
 *   - `{ error }` → mensaje del primer error encontrado.
 *   Para distinguirlos: `if ("error" in result) { ... }`.
 */
const parseStoreInput = (body: any, partial: boolean): { data: Record<string, any> } | { error: string } => {
  // Aquí se acumulan solo los campos válidos y limpios.
  const data: Record<string, any> = {};

  // Indica si el cliente envió la clave (aunque sea null o ""). Se compara
  // con `undefined` (no con "falsy") para que 0, "" y null cuenten como
  // "enviado". El `?.` evita errores si `body` es null/undefined.
  const has = (key: string) => body?.[key] !== undefined;

  // NOMBRE: obligatorio al crear; al actualizar, solo se valida si viene.
  if (!partial || has("name")) {
    // Debe ser un string y no estar vacío (ni solo espacios).
    if (typeof body?.name !== "string" || !body.name.trim()) return { error: "Store name is required" };
    if (body.name.trim().length > 255) return { error: "Store name must be 255 characters or less" };
    data.name = body.name.trim();
  }

  // DESCRIPCIÓN: opcional. Se comprueba la longitud ANTES de hacer trim().
  if (has("description")) {
    if (typeof body.description !== "string" || body.description.length > 2000) return { error: "Description must be text of 2000 characters or less" };
    data.description = body.description.trim();
  }

  // DIRECCIÓN: opcional, misma lógica que la descripción.
  if (has("address")) {
    if (typeof body.address !== "string" || body.address.length > 500) return { error: "Address must be text of 500 characters or less" };
    data.address = body.address.trim();
  }

  // LOGO Y BANNER: se validan con el mismo código, recorriendo ambas claves.
  for (const key of ["logo_url", "banner_url"]) {
    if (has(key)) {
      // "" o null significan "quitar la imagen": se guarda null en la BD.
      // `continue` salta a la siguiente clave del bucle.
      if (body[key] === "" || body[key] === null) { data[key] = null; continue; }
      // Si no, debe ser un string con URL https.
      if (typeof body[key] !== "string" || !isHttpsUrl(body[key])) return { error: `${key} must be an https URL` };
      data[key] = body[key];
    }
  }

  // MONEDA: exactamente 3 letras (código ISO 4217, ej. GHS, EUR, USD).
  // Se normaliza a mayúsculas. No comprueba que el código exista realmente.
  if (has("currency")) {
    if (typeof body.currency !== "string" || !/^[A-Za-z]{3}$/.test(body.currency)) return { error: "Currency must be a 3-letter code, e.g. GHS" };
    data.currency = body.currency.toUpperCase();
  }

  // ENVÍO: coste de envío y umbral de envío gratis. Se convierten con
  // `Number()`, así que acepta tanto 5 como "5". `Number.isFinite`
  // rechaza NaN e Infinity; además no se permiten negativos.
  for (const key of ["shipping_fee", "free_shipping_threshold"]) {
    if (has(key)) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0) return { error: `${key} must be a number of 0 or more` };
      data[key] = n;
    }
  }

  // MÉTODOS DE PAGO: array no vacío donde TODOS los valores estén en la
  // lista blanca VALID_PAYMENT_METHODS.
  if (has("payment_methods")) {
    const pm = body.payment_methods;
    if (!Array.isArray(pm) || pm.length === 0 || !pm.every((m) => VALID_PAYMENT_METHODS.includes(m))) {
      return { error: `payment_methods must be a list using: ${VALID_PAYMENT_METHODS.join(", ")}` };
    }
    // `new Set` elimina duplicados; el spread lo convierte otra vez en array.
    data.payment_methods = [...new Set(pm)];
  }

  // ESTILO DE CABECERA: debe ser uno de los valores permitidos.
  if (has("hero_style")) {
    if (!VALID_HEROES.includes(body.hero_style)) return { error: `hero_style must be one of: ${VALID_HEROES.join(", ")}` };
    data.hero_style = body.hero_style;
  }

  // COLOR DE ACENTO: formato "#RRGGBB" (exactamente 6 dígitos hex).
  // No admite el formato corto "#fff". El regex se aplica sobre el
  // valor ya sin espacios (trim).
  if (has("accent_color")) {
    if (typeof body.accent_color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.accent_color.trim())) return { error: "accent_color must be a hex colour, e.g. #059669" };
    data.accent_color = body.accent_color.trim();
  }

  // Todo correcto: se devuelven los datos validados.
  return { data };
}