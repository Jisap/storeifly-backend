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