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

/**
 * Valida la lista de productos de un pedido y la normaliza a un `Map`
 * `productId → cantidad`, fusionando los productos repetidos.
 *
 * Entrada esperada (`req.body.items`):
 *   [
 *     { productId: 5, quantity: 2 },
 *     { product_id: 8, quantity: 1 },   // también acepta snake_case
 *     { productId: 5, quantity: 3 }     // repetido: se suma al anterior
 *   ]
 *
 * Salida del ejemplo: Map { 5 → 5, 8 → 1 }
 *
 * Reglas:
 *  - Debe ser un array con entre 1 y MAX_LINE_ITEMS elementos (50).
 *  - Cada elemento necesita un id de producto válido (entero > 0) y una
 *    cantidad entera entre 1 y MAX_QUANTITY (100).
 *  - Si el mismo producto aparece varias veces, las cantidades se SUMAN, y
 *    el total no puede superar MAX_QUANTITY.
 *  - Cualquier fallo invalida TODO el pedido (devuelve `null`).
 *
 * Por qué un `Map`: evita que un cliente envíe el mismo producto en varias
 * líneas para saltarse el límite de cantidad o confundir la comprobación de
 * stock. Con un `Map`, cada producto aparece una sola vez.
 *
 * IMPORTANTE: el cliente solo envía ids y cantidades, NUNCA precios. Los
 * precios deben leerse de la BD dentro del checkout; si no, cualquiera
 * podría comprar a 0 €.
 *
 * @param value - Valor recibido del cliente (normalmente `req.body.items`).
 * @returns `Map<number, number>` con los productos y cantidades, o `null`
 *          si no es válido. Quien la llame debe comprobar el `null` y
 *          responder 400.
 */
const parseItems = (value: unknown): Map<number, number> | null => {
  // Debe ser un array no vacío y con un máximo de líneas.
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINE_ITEMS) return null;

  // Aquí se acumulan los productos ya fusionados.
  const items = new Map<number, number>();

  for (const item of value) {
    // Acepta `productId` o `product_id`. `item?.` evita un error si el
    // elemento es null/undefined (en ese caso `parseId` devuelve null).
    const productId = parseId(item?.productId ?? item?.product_id);

    // `Number()` acepta 2 y "2". Ojo: `Number(undefined)` es NaN y
    // `Number(null)` es 0; ambos se rechazan en la comprobación siguiente.
    const quantity = Number(item?.quantity);

    // Id inválido, cantidad no entera, menor que 1 o mayor que el máximo:
    // se rechaza el pedido entero.
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return null;

    // Si el producto ya estaba, se suma; si no, `?? 0` parte de cero.
    items.set(productId, (items.get(productId) ?? 0) + quantity);
  }

  // Segunda comprobación: tras fusionar duplicados, la suma puede superar
  // el máximo aunque cada línea individual fuera válida (ej. 60 + 60).
  for (const qty of items.values()) if (qty > MAX_QUANTITY) return null;

  return items;
}

/**
 * Controlador: crea un pedido (checkout).
 *
 * Reglas de negocio:
 *  - CUALQUIERA puede comprar, con o sin cuenta (compra como invitado).
 *    Si el usuario está logueado, el pedido se vincula a su cuenta
 *    (`customer_id`); si no, queda en `null`.
 *  - Los PRECIOS salen siempre de la base de datos, nunca de la petición. El
 *    cliente solo envía ids de producto y cantidades.
 *  - El stock se reserva (descuenta) dentro de la misma transacción que crea
 *    el pedido: o se hace todo, o no se hace nada.
 *
 * IMPORTANTE: usa `AuthenticatedRequest`, pero `req.user` es OPCIONAL aquí
 * (`req.user?.id`). La ruta NO debe usar `requireAuth` (rechazaría a los
 * invitados), sino un middleware de "autenticación opcional" que rellene
 * `req.user` si hay sesión y deje pasar si no la hay.
 *
 * Ruta esperada: POST con body JSON:
 *   {
 *     "storeId": 3,                         // o "store_id"
 *     "customerName": "Ana Pérez",
 *     "customerEmail": "ana@correo.com",
 *     "customerPhone": "+233...",           // opcional, máx. 50 caracteres
 *     "shippingAddress": "texto" | { ... }, // ver parseShippingAddress
 *     "items": [{ "productId": 5, "quantity": 2 }],
 *     "paymentMethod": "cash_on_delivery"   // opcional; o "payment_method"
 *   }
 *
 * Flujo:
 *  1. Lee y valida el body (todo en memoria, sin tocar la BD).
 *  2. Comprueba que la tienda existe, está activa y admite el método de pago.
 *  3. Transacción: carga los productos, calcula importes, reserva stock y
 *     crea el pedido.
 *
 * Respuestas:
 *  - 201: `{ success, message, order }`
 *  - 400: datos inválidos, método de pago no admitido, producto no disponible
 *         o sin stock suficiente (`CheckoutError`).
 *  - 404: la tienda no existe o no está activa.
 *  - 500: error inesperado.
 *
 * @param req - Petición de Express; `req.user` solo existe si hay sesión.
 * @param res - Respuesta de Express.
 */
export const createOrder = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // `?? {}` evita un error si el body llega `undefined`.
    const body = req.body ?? {};

    // Se aceptan camelCase y snake_case para el id de la tienda.
    const storeId = parseId(body.storeId ?? body.store_id);

    // Nombre: si no es string queda "" y falla la validación de abajo.
    const customerName = typeof body.customerName === "string" ? body.customerName.trim() : "";

    // Email: se normaliza (recorta y pasa a minúsculas) ANTES de validar,
    // para guardar siempre el mismo formato y poder buscar pedidos por email.
    const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim().toLowerCase() : "";

    // Teléfono: opcional. `undefined` = no enviado (o no era texto).
    const customerPhone = typeof body.customerPhone === "string" ? body.customerPhone.trim() : undefined;

    // Ambos devuelven `null` si son inválidos (ver sus comentarios).
    const shippingAddress = parseShippingAddress(body.shippingAddress);
    const items = parseItems(body.items);

    // VALIDACIONES: todas ocurren antes de consultar la BD, así una
    // petición mal formada no cuesta ninguna consulta.
    if (!storeId) { res.status(400).json({ success: false, message: "A valid storeId is required" }); return; }
    if (!customerName || customerName.length > 255) { res.status(400).json({ success: false, message: "Customer name is required" }); return; }
    // `isEmail` es un type guard: a partir de aquí `customerEmail` es `string`.
    if (!isEmail(customerEmail)) { res.status(400).json({ success: false, message: "A valid customer email is required" }); return; }
    if (customerPhone !== undefined && customerPhone.length > 50) { res.status(400).json({ success: false, message: "Phone number is too long" }); return; }
    if (!shippingAddress) { res.status(400).json({ success: false, message: "A shipping address is required" }); return; }
    if (!items) { res.status(400).json({ success: false, message: `items must be a list of 1-${MAX_LINE_ITEMS} { productId, quantity } with quantity 1-${MAX_QUANTITY}` }); return; }

    // Carga la tienda con solo los campos necesarios para el checkout:
    // estado, costes de envío y métodos de pago aceptados.
    const store = await prisma.stores.findUnique({
      where: { id: storeId },
      select: { id: true, status: true, shipping_fee: true, free_shipping_threshold: true, payment_methods: true },
    });
    // Una tienda suspendida se trata igual que una inexistente (404), sin
    // revelar que existe. Es lo que impide comprar en tiendas suspendidas.
    if (!store || store.status !== "active") {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    // Método de pago: el enviado, o si no se envió, el primero que acepte
    // la tienda. Debe estar entre los aceptados por ESA tienda.
    const paymentMethod = body.paymentMethod ?? body.payment_method ?? store.payment_methods[0];
    if (!store.payment_methods.includes(paymentMethod)) {
      res.status(400).json({ success: false, message: `This store accepts: ${store.payment_methods.join(", ")}` });
      return;
    }

    // TRANSACCIÓN: todo lo de dentro se confirma junto o se deshace junto.
    // Cualquier error lanzado dentro (incluido `CheckoutError`) provoca el
    // ROLLBACK, y el stock descontado vuelve a su valor.
    const order = await prisma.$transaction(async (tx) => {
      // Productos pedidos. Filtros de seguridad en el `where`:
      //  - `store_id: store.id`: no se pueden mezclar productos de otra tienda.
      //  - `status: "active"`: borradores y archivados no se pueden comprar.
      const products = await tx.products.findMany({
        where: { id: { in: [...items.keys()] }, store_id: store.id, status: "active" },
        select: { id: true, name: true, price: true, images: true },
      });
      // Si falta alguno (no existe, otra tienda, no activo) se cancela todo.
      // Sirve porque `items` (Map) no tiene ids repetidos.
      if (products.length !== items.size) throw new CheckoutError("One or more products are unavailable");

      // Importes con `Decimal` (sin errores de redondeo de `number`).
      let subtotal = new Decimal(0);
      const lineItems = products.map((p) => {
        // `!` es seguro: `products` solo contiene ids que están en `items`.
        const quantity = items.get(p.id)!;
        // Precio REAL de la BD × cantidad.
        const lineTotal = p.price.mul(quantity);
        subtotal = subtotal.add(lineTotal);
        // `images` es JSON en la BD: se comprueba que sea array.
        const images = Array.isArray(p.images) ? p.images : [];
        // "Foto" del producto en el momento de la compra. Se guarda
        // nombre, precio e imagen DENTRO del pedido para que el
        // historial no cambie si luego se edita o borra el producto.
        // Los importes se guardan como string con 2 decimales.
        return {
          product_id: p.id,
          name: p.name,
          price: p.price.toFixed(2),
          quantity,
          line_total: lineTotal.toFixed(2),
          image: typeof images[0] === "string" ? images[0] : null,
        };
      });

      // RESERVA DE STOCK. El `updateMany` con `stock: { gte: quantity }`
      // comprueba y descuenta en UNA sola operación atómica de la BD. Si
      // dos compradores piden la última unidad a la vez, a uno le
      // devuelve `count === 0`. Leer el stock y luego restarlo en dos
      // pasos permitiría vender más de lo que hay.
      for (const [productId, quantity] of items) {
        const updated = await tx.products.updateMany({
          where: { id: productId, stock: { gte: quantity } },
          data: { stock: { decrement: quantity } },
        });
        if (updated.count === 0) {
          // El nombre sale de `products` (leído arriba) para un mensaje claro.
          const name = products.find((p) => p.id === productId)?.name ?? "A product";
          throw new CheckoutError(`${name} is out of stock or doesn't have enough left`);
        }
      }

      // ENVÍO. `?? new Decimal(0)` cubre campos nulos en la tienda.
      // `free_shipping_threshold` en 0 (o nulo) significa "sin envío
      // gratis". Si está definido y el subtotal lo alcanza, el envío es 0.
      const shippingFee = store.shipping_fee ?? new Decimal(0);
      const freeFrom = store.free_shipping_threshold ?? new Decimal(0);
      const shippingCost = freeFrom.gt(0) && subtotal.gte(freeFrom) ? new Decimal(0) : shippingFee;

      // Crea el pedido. Se devuelve el resultado de `create`, que pasa a
      // ser el valor de toda la transacción (`order`).
      return tx.orders.create({
        data: {
          // Número aleatorio no adivinable (ver `generateOrderNumber`).
          order_number: generateOrderNumber(),
          store_id: store.id,
          // Cuenta del comprador, o null si es invitado.
          customer_id: req.user?.id ?? null,
          customer_name: customerName,
          customer_email: customerEmail,
          customer_phone: customerPhone || null,
          shipping_address: shippingAddress,
          items: lineItems,
          subtotal,
          shipping_cost: shippingCost,
          // Aún no hay descuentos/cupones.
          discount: 0,
          total: subtotal.add(shippingCost),
          payment_method: paymentMethod,
          // `status` no se envía: lo fija el valor por defecto del esquema.
        },
      });
    });

    // Los `Decimal` se serializan como string en el JSON ("25.00").
    res.status(201).json({ success: true, message: "Order placed successfully", order });
  } catch (error) {
    // Errores "esperados" del checkout: se envía su mensaje al cliente.
    if (error instanceof CheckoutError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    // Cualquier otro: detalle en el log, mensaje genérico al cliente.
    console.error("createOrder error:", error);
    res.status(500).json({ success: false, message: "Failed to place order" });
  }
}

