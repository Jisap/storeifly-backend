import { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { Prisma } from "../generated/prisma/client.js";

/**
 * Clase `Decimal` de Prisma, extraída del namespace `Prisma`.
 *
 * Sirve para hacer cálculos con dinero SIN los errores de redondeo de los
 * `number` de JavaScript (0.1 + 0.2 = 0.30000000000000004). Se usará para
 * sumar precios, envío y totales del pedido.
 *
 * Nota: esta línea está entre dos imports. Funciona (los imports se
 * "elevan" y se ejecutan primero), pero por orden conviene ponerla después
 * de todos ellos.
 */
const { Decimal } = Prisma;
import { AuthenticatedRequest } from "../middleware/auth.js";
import { isNeonEmailVerified } from "../services/neonUser.js";

/**
 * Listas y límites para validar los datos de PEDIDOS que llegan del cliente.
 *
 * - ORDER_STATUSES: ciclo de vida de un pedido:
 *     "placed"     → recién hecho.
 *     "pending"    → pendiente (por ejemplo, de pago o confirmación).
 *     "processing" → el comerciante lo está preparando.
 *     "shipped"    → enviado.
 *     "delivered"  → entregado.
 *     "cancelled"  → cancelado.
 *   Ojo: "placed" y "pending" parecen solapados. Cuando veas el resto del
 *   código, anota qué diferencia hay entre ambos y quién usa cada uno.
 * - MAX_LINE_ITEMS: máximo de líneas (productos distintos) por pedido (50).
 * - MAX_QUANTITY: máximo de unidades por línea (100).
 *
 * Los límites evitan pedidos absurdos o abusivos (cuerpos enormes, bucles
 * largos dentro de la transacción).
 */
const ORDER_STATUSES = ["placed", "pending", "processing", "shipped", "delivered", "cancelled"];
const MAX_LINE_ITEMS = 50;
const MAX_QUANTITY = 100;

/**
 * Error propio del proceso de compra (checkout).
 *
 * Se lanza DENTRO de la transacción de Prisma para dos cosas a la vez:
 *  1. Provocar el ROLLBACK: si algo falla a mitad (por ejemplo, no hay
 *     stock), se deshacen todos los cambios ya hechos en esa transacción.
 *  2. Distinguir los errores "esperados" del cliente (stock insuficiente,
 *     producto no disponible...) de los inesperados. En el `catch` del
 *     controlador se hará algo como:
 *       if (error instanceof CheckoutError) → responder 400 con su mensaje
 *       else → responder 500 genérico
 *
 * El cuerpo vacío está bien: `extends Error` ya aporta `message` y `stack`;
 * la clase solo existe como "etiqueta" para `instanceof`.
 *
 * IMPORTANTE: el `message` de un `CheckoutError` se enviará al cliente, así
 * que nunca incluyas en él datos internos.
 */
class CheckoutError extends Error { }

/**
 * Convierte un valor desconocido en un id numérico válido (entero > 0).
 *
 * Es la misma función que en el controlador de productos (copia idéntica).
 * Acepta números y textos numéricos ("5" → 5).
 *
 * Ejemplos:
 *   parseId("5")   → 5
 *   parseId("abc") → null
 *   parseId(0)     → null
 *   parseId(null)  → null   (Number(null) es 0)
 *
 * @param value - Valor a convertir.
 * @returns El id como número, o `null` si no es un entero positivo.
 */
const parseId = (value: unknown) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Type guard: comprueba que un valor es un string con formato de email.
 *
 * Reglas:
 *  - Debe ser un string de como máximo 255 caracteres.
 *  - Debe cumplir `algo@algo.algo`: sin espacios, con una sola `@` y al
 *    menos un punto en el dominio.
 *
 * Es una validación de FORMATO básica, no de existencia: "a@b.c" pasa.
 * Con `value is string`, dentro de un `if` TypeScript ya trata el valor como
 * `string`.
 *
 * @param value - Valor a comprobar.
 * @returns `true` si parece un email válido.
 */
const isEmail = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * Genera un número de pedido aleatorio, por ejemplo "ORD-7K2QX9MBT4WZ".
 *
 * Formato: "ORD-" + 12 caracteres tomados de un alfabeto de 32 símbolos.
 *
 * Decisiones de diseño:
 *  - ALEATORIO (no secuencial): con "ORD-1001", "ORD-1002"... cualquiera
 *    podría adivinar números de pedidos ajenos y consultarlos. Con 32^12
 *    combinaciones, adivinarlos es inviable.
 *  - Alfabeto sin caracteres confusos: se omiten I, O, 0 y 1, que se
 *    confunden al leerlos o dictarlos (I/1, O/0).
 *  - `randomBytes` (módulo `crypto`) es criptográficamente seguro, a
 *    diferencia de `Math.random()`, que es predecible.
 *
 * Detalle técnico: el alfabeto tiene 32 caracteres y un byte va de 0 a 255
 * (256 valores, múltiplo exacto de 32), así que `b % 32` reparte las letras
 * de forma uniforme, sin sesgo. Si cambias la longitud del alfabeto, ese
 * reparto dejaría de ser uniforme.
 *
 * No garantiza unicidad absoluta: la colisión es prácticamente imposible,
 * pero el esquema debería tener `@unique` en el número de pedido.
 *
 * @returns Una cadena como "ORD-XXXXXXXXXXXX".
 */
const generateOrderNumber = () => {
    // 32 caracteres: A-Z sin I ni O (24 letras) + dígitos 2-9 (8 dígitos).
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    // 12 bytes aleatorios seguros, uno por cada carácter del código.
    const bytes = randomBytes(12);
    // `Array.from(bytes, fn)` recorre los bytes y convierte cada uno en una
    // letra del alfabeto; `join("")` las une en un solo string.
    return "ORD-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Valida y normaliza la dirección de envío de un pedido.
 *
 * Acepta DOS formatos, y devuelve el mismo tipo que recibe:
 *  1. Una sola línea de texto:
 *       "Calle Mayor 5, 29001 Málaga"
 *  2. Un objeto con campos de texto (hasta 10), por ejemplo:
 *       { street: "Calle Mayor 5", city: "Málaga", zip: "29001" }
 *
 * Reglas:
 *  - String: no vacío (ni solo espacios) y máx. 500 caracteres. Se
 *    devuelve ya sin espacios en los extremos.
 *  - Objeto: entre 1 y 10 campos; TODOS los valores deben ser strings de
 *    máx. 200 caracteres. Los valores se recortan con `trim()` y las
 *    claves se truncan a 50 caracteres.
 *  - Cualquier otra cosa (null, número, array, objeto vacío...) → `null`.
 *
 * Por qué hay límites: la dirección llega del cliente y se guardará
 * (probablemente en una columna JSON o de texto). Los máximos evitan que
 * alguien guarde cantidades enormes de datos en cada pedido.
 *
 * @param value - Valor recibido del cliente (normalmente `req.body.shipping_address`).
 * @returns El string o el objeto limpio, o `null` si no es válido. Quien la
 *          llame debe comprobar el `null` y responder 400.
 */
const parseShippingAddress = (value: unknown): string | Record<string, string> | null => {
    // CASO 1: texto. `value.trim() && ...` es falsy si queda vacío tras
    // recortar. La longitud se comprueba sobre el valor SIN recortar, así
    // que un texto de 500 caracteres + espacios finales se rechaza.
    if (typeof value === "string") {
        return value.trim() && value.length <= 500 ? value.trim() : null;
    }

    // CASO 2: objeto "plano". `value &&` descarta null (typeof null === "object")
    // y `!Array.isArray` descarta arrays, que también son objetos en JS.
    if (value && typeof value === "object" && !Array.isArray(value)) {
        // Convierte el objeto en pares [clave, valor] para validarlos.
        const entries = Object.entries(value);

        // Sin campos, o demasiados: se rechaza.
        if (entries.length === 0 || entries.length > 10) return null;

        // TODOS los valores deben ser strings cortos. Un solo valor inválido
        // (número, objeto anidado, texto largo...) invalida la dirección entera.
        if (!entries.every(([, v]) => typeof v === "string" && v.length <= 200)) return null;

        // Reconstruye el objeto limpio: claves truncadas a 50 caracteres y
        // valores recortados. `(v as string)` es seguro porque el `every`
        // anterior ya comprobó que son strings; TypeScript no lo infiere.
        return Object.fromEntries(entries.map(([k, v]) => [k.slice(0, 50), (v as string).trim()]));
    }

    // Cualquier otro tipo (número, boolean, null, undefined, array...).
    return null;
}

// Combines duplicate products and checks quantities: [{ productId, quantity }]
const parseItems = (value: unknown): Map<number, number> | null => {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINE_ITEMS) return null;
    const items = new Map<number, number>();
    for (const item of value) {
        const productId = parseId(item?.productId ?? item?.product_id);
        const quantity = Number(item?.quantity);
        if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return null;
        items.set(productId, (items.get(productId) ?? 0) + quantity);
    }
    for (const qty of items.values()) if (qty > MAX_QUANTITY) return null;
    return items;
}
