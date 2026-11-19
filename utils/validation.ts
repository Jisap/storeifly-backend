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
 * sin símbolos y con guiones en lugar de espacios).
 *
 * Ejemplo:
 *   "  Mi Tienda   Genial! " → "mi-tienda-genial"
 *
 * @param text - Texto de origen (por ejemplo, el nombre de una tienda o categoría).
 * @returns El slug generado (puede ser una cadena vacía si no contiene caracteres válidos).
 */
export const generateSlug = (text: string): string =>
    text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');