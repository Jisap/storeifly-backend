/**
 * Utilidades de validación y formateo compartidas por los controladores.
 *
 * Antes estaban copiadas en varios archivos con pequeñas diferencias.
 * Si cambias una aquí, cambia en todos los sitios que la usan.
 */

/**
 * Type guard: comprueba que un valor desconocido es un string con una URL
 * que usa HTTPS.
 *
 * Con `value is string`, dentro de un `if` donde devuelva `true` TypeScript ya
 * trata la variable como `string`. También sirve como callback:
 * `array.every(isHttpsUrl)`.
 *
 * Solo valida el protocolo, NO el dominio. Para comprobar que la imagen es de
 * tu cuenta de Cloudinary usa además `isOwnCloudinaryUrl`.
 *
 * @param value - Valor a comprobar (cualquier tipo).
 * @returns `true` si es un string con URL válida y protocolo https.
 */
export const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Convierte un valor desconocido en un id numérico válido (entero > 0).
 *
 * Acepta números y textos numéricos ("5" → 5), que es lo que llega desde
 * `req.params`, `req.query` o el body.
 *
 * Ejemplos:
 *   parseId("5")   → 5
 *   parseId("abc") → null
 *   parseId(0)     → null
 *   parseId(null)  → null   (Number(null) es 0)
 *
 * @param value - Valor a convertir.
 * @returns El id como número, o `null` si no es un entero positivo.
 *          Quien la llame debe comprobar el `null`.
 */
export const parseId = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Type guard: comprueba que un valor es un string con formato de email.
 *
 * Es una validación de FORMATO básica (`algo@algo.algo`, sin espacios, máx.
 * 255 caracteres), no de existencia. La verificación real es el email de
 * confirmación.
 *
 * @param value - Valor a comprobar.
 * @returns `true` si parece un email válido.
 */
export const isEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * Convierte un texto en un "slug": una versión apta para URLs (minúsculas,
 * sin tildes ni símbolos y con guiones en lugar de espacios).
 *
 * Es la versión mejorada de la que había en `storeController`: añade el paso
 * de normalización para que las tildes y la ñ se transliteren en vez de
 * eliminarse.
 *
 * Ejemplos:
 *   "  Mi Tienda   Genial! " → "mi-tienda-genial"
 *   "Café Ñandú"             → "cafe-nandu"   (antes daba "caf-and")
 *   "Ropa  &  Calzado"       → "ropa-calzado"
 *   "!!!"                    → ""             (hay que comprobarlo, ver notas)
 *
 * Pasos (en orden):
 *  1. `toString()`: asegura que se trabaja con un string.
 *  2. `normalize("NFD")`: descompone cada letra acentuada en letra base +
 *     marca de acento ("é" → "e" + "´").
 *  3. `replace(/[\u0300-\u036f]/g, "")`: elimina esas marcas de acento.
 *  4. `toLowerCase()`: pasa todo a minúsculas.
 *  5. `trim()`: quita espacios al inicio y al final.
 *  6. `replace(/[^a-z0-9\s-]/g, "")`: elimina todo lo que no sea a-z, número,
 *     espacio o guion.
 *  7. `replace(/\s+/g, "-")`: convierte cada grupo de espacios en un guion.
 *  8. `replace(/-+/g, "-")`: colapsa guiones repetidos en uno solo.
 *  9. `replace(/^-|-$/g, "")`: quita guiones al principio y al final.
 *
 * @param text - Texto de origen (nombre de tienda, de categoría...).
 * @returns El slug generado. Puede ser una cadena vacía; quien la llame debe
 *          comprobarlo (como hacen `createStore` y `createCategory`).
 */
export const generateSlug = (text: string): string =>
  text
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');