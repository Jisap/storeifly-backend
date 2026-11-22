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
import { parseId, isEmail } from "../utils/validation.js";

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
const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];
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

/**
 * Controlador: lista los pedidos de la tienda del comerciante autenticado,
 * del más reciente al más antiguo, con filtro opcional por estado.
 *
 * Seguridad (propiedad del recurso): la tienda se obtiene de `req.user.id`,
 * no de un id enviado por el cliente, y los pedidos se filtran SIEMPRE por
 * `store_id`. Un comerciante nunca ve pedidos de otras tiendas.
 *
 * Ruta esperada: GET con query opcional: `?status=shipped`.
 * Requiere autenticación (y, según la ruta, rol "merchant").
 *
 * Respuestas:
 *  - 200: `{ success, orders }` (array, vacío si no hay pedidos).
 *  - 400: `status` no válido (o enviado más de una vez, ver notas).
 *  - 404: el usuario todavía no tiene tienda.
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada de Express (`req.query.status` opcional).
 * @param res - Respuesta de Express.
 */
export const getMerchantOrders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Tienda del usuario autenticado (`!` asume que `requireAuth` ya corrió).
    // Solo se selecciona `id`, que es lo único necesario.
    const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id }, select: { id: true } });
    if (!store) {
      res.status(404).json({ success: false, message: "You have not created a store yet" });
      return;
    }

    // Filtro opcional por estado. `req.query.status` puede ser string,
    // array (`?status=a&status=b`) u objeto (`?status[x]=1`), por eso se
    // comprueba `typeof status !== "string"` ANTES de buscarlo en la
    // lista blanca. Si no se envía (`undefined`), no se filtra.
    const { status } = req.query;
    if (status !== undefined && (typeof status !== "string" || !ORDER_STATUSES.includes(status))) {
      res.status(400).json({ success: false, message: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
      return;
    }

    const orders = await prisma.orders.findMany({
      where: {
        // Filtro de propiedad: imprescindible, no lo quites.
        store_id: store.id,
        // Spread condicional: añade `order_status` solo si hay filtro.
        // `status as string` es seguro tras la validación (TypeScript
        // no estrecha el tipo de `req.query` por sí solo).
        ...(status ? { order_status: status as string } : {}),
      },
      // Más recientes primero.
      orderBy: { created_at: "desc" },
    });
    res.status(200).json({ success: true, orders });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getMerchantOrders error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
}

/**
 * Controlador: cambia el estado de un pedido de la tienda del comerciante
 * autenticado. Si el nuevo estado es "cancelled", devuelve el stock de los
 * productos del pedido.
 *
 * Es la pieza que cierra el ciclo que dejó abierto `createOrder`: allí el
 * stock se descuenta al comprar; aquí se repone al cancelar.
 *
 * Seguridad (propiedad del recurso): el id del pedido llega por la URL, pero
 * solo se acepta si pertenece a la tienda del usuario (`id` + `store_id`).
 * Un pedido de otra tienda se trata como "no encontrado" (404).
 *
 * Reglas de negocio:
 *  - El nuevo estado debe estar en `ORDER_STATUSES`.
 *  - Un pedido CANCELADO es definitivo: no puede cambiar a ningún otro
 *    estado. Evita reponer el stock dos veces o "resucitar" un pedido cuyo
 *    stock ya se devolvió.
 *  - Cualquier otra transición se permite (por ejemplo, de "delivered" a
 *    "pending"); no hay una máquina de estados estricta (ver notas).
 *
 * Ruta esperada: PATCH/PUT `/:id/status` con body JSON `{ "status": "shipped" }`.
 * Requiere autenticación (y, según la ruta, rol "merchant").
 *
 * Respuestas:
 *  - 200: `{ success, message, order }` con el pedido actualizado.
 *  - 400: id inválido, `status` no válido o pedido ya cancelado.
 *  - 404: el usuario no tiene tienda, o el pedido no existe en su tienda.
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada de Express (`req.params.id` y `req.body.status`).
 * @param res - Respuesta de Express.
 */
export const updateOrderStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Id del pedido desde la URL (`parseId` devuelve null si no es un
    // entero positivo).
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, message: "Invalid order id" });
      return;
    }

    // Nuevo estado pedido: acepta tanto `status` como `order_status`.
    const status = req.body?.status ?? req.body?.order_status;
    const { tracking_number, payment_status } = req.body ?? {};

    if (!ORDER_STATUSES.includes(status)) {
      res.status(400).json({ success: false, message: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
      return;
    }

    if (payment_status !== undefined && !PAYMENT_STATUSES.includes(payment_status)) {
      res.status(400).json({ success: false, message: `payment_status must be one of: ${PAYMENT_STATUSES.join(", ")}` });
      return;
    }

    if (tracking_number !== undefined && (typeof tracking_number !== "string" || tracking_number.length > 100)) {
      res.status(400).json({ success: false, message: "tracking_number must be text of 100 characters or less" });
      return;
    }

    // Tienda del usuario autenticado (`!` asume que `requireAuth` ya corrió).
    const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id }, select: { id: true } });
    if (!store) {
      res.status(404).json({ success: false, message: "You have not created a store yet" });
      return;
    }

    // COMPROBACIÓN DE PROPIEDAD: se busca por `id` Y `store_id`. Se
    // seleccionan `order_status` (para la regla de cancelado) e `items`
    // (para saber qué stock devolver).
    const order = await prisma.orders.findFirst({ where: { id, store_id: store.id }, select: { id: true, order_status: true, items: true } });
    if (!order) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }

    // Un pedido cancelado no admite más cambios. Esta comprobación es la
    // que impide devolver el stock dos veces.
    if (order.order_status === "cancelled") {
      res.status(400).json({ success: false, message: "Cancelled orders can't be changed" });
      return;
    }

    // TRANSACCIÓN: reponer stock y cambiar el estado se confirman juntos o
    // se deshacen juntos. Así no puede quedar un pedido cancelado sin
    // stock devuelto, ni stock devuelto con el pedido sin cancelar.
    const updated = await prisma.$transaction(async (tx) => {
      if (status === "cancelled") {
        // `items` es JSON en la BD: se comprueba que sea array. El
        // `as any[]` es necesario porque Prisma lo tipa como JsonValue.
        const items = Array.isArray(order.items) ? (order.items as any[]) : [];
        for (const item of items) {
          // Cada línea es la "foto" guardada en `createOrder`
          // (`product_id`, `quantity`...). Se revalida por prudencia.
          const productId = parseId(item?.product_id);
          const quantity = Number(item?.quantity);
          if (productId && Number.isInteger(quantity) && quantity > 0) {
            // `updateMany` (y no `update`) a propósito: si el producto
            // se borró después de la compra, `update` lanzaría un error
            // y bloquearía la cancelación; `updateMany` simplemente no
            // afecta a ninguna fila. `increment` suma en la BD de forma
            // atómica, sin leer el stock antes.
            await tx.products.updateMany({ where: { id: productId }, data: { stock: { increment: quantity } } });
          }
        }
      }
      // Cambia el estado y, opcionalmente, tracking_number y payment_status. Si algo falló arriba, esto no llega a ejecutarse.
      return tx.orders.update({
        where: { id },
        data: {
          order_status: status,
          ...(payment_status !== undefined && { payment_status }),
          ...(tracking_number !== undefined && { tracking_number: tracking_number.trim() || null }),
        },
      });
    });

    res.status(200).json({ success: true, message: `Order is now ${status}`, order: updated });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("updateOrderStatus error:", error);
    res.status(500).json({ success: false, message: "Failed to update order status" });
  }
}

/**
 * Controlador: devuelve el recibo de un pedido a partir de su número
 * (por ejemplo, "ORD-7K2QX9MBT4WZ"). Es PÚBLICO: no requiere sesión.
 *
 * Modelo de seguridad: el número de pedido funciona como un "enlace privado"
 * (capability URL). Como `generateOrderNumber` lo genera aleatorio con 32^12
 * combinaciones, nadie puede adivinar el de otra persona; solo accede quien
 * lo recibió (el comprador, por pantalla o por email). Por eso este endpoint
 * puede ser público, y por eso es CRUCIAL que los números NO sean
 * secuenciales ni predecibles.
 *
 * Usa `Request` normal (no `AuthenticatedRequest`): la ruta no debe llevar
 * `requireAuth`, porque los compradores invitados no tienen cuenta.
 *
 * Qué devuelve: el pedido completo (cliente, dirección, líneas, importes,
 * estado...) más los datos públicos de la tienda (`store`). Se OMITE
 * `customer_id` para no exponer el id interno de la cuenta del comprador.
 *
 * Ruta esperada: GET `/:orderNumber`, sin body.
 *
 * Respuestas:
 *  - 200: `{ success, order }` con `order.store` = `{ id, name, slug, logo_url, currency, accent_color }`.
 *  - 404: número inválido o pedido inexistente (mismo mensaje en ambos casos).
 *  - 500: error inesperado.
 *
 * @param req - Petición de Express (`req.params.orderNumber`).
 * @param res - Respuesta de Express.
 */
export const getOrderReceipt = async (req: Request, res: Response): Promise<void> => {
  try {
    // Número de pedido desde la URL. Se rechaza lo que no sea string o sea
    // demasiado largo (evita consultas con valores absurdos). Se responde
    // 404 (no 400) para no dar pistas sobre el formato esperado.
    const orderNumber = req.params.orderNumber;
    if (typeof orderNumber !== "string" || orderNumber.length > 100) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }

    // `findUnique` requiere que `order_number` sea `@unique` en el esquema
    // (si no lo fuera, TypeScript daría error). `include` trae la tienda,
    // pero con `select` SOLO los campos públicos necesarios para pintar el
    // recibo con la imagen de la tienda (logo, color, moneda).
    const order = await prisma.orders.findUnique({
      where: { order_number: orderNumber },
      include: { stores: { select: { id: true, name: true, slug: true, logo_url: true, currency: true, accent_color: true } } },
    });
    if (!order) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }

    // Desestructuración para REORGANIZAR la respuesta:
    //  - `stores` se separa para renombrarlo a `store` (singular).
    //  - `customer_id: _customerId` se extrae y se descarta (el guion bajo
    //    indica "variable no usada"), así NO viaja en `...rest`.
    //  - `rest` conserva todo lo demás.
    // Es una lista de exclusión: si añades al modelo `orders` un campo
    // interno nuevo, saldrá en la respuesta salvo que lo excluyas aquí.
    const { stores, customer_id: _customerId, ...rest } = order;
    res.status(200).json({ success: true, order: { ...rest, store: stores } });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getOrderReceipt error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch receipt" });
  }
}

/**
 * Controlador: lista los pedidos del cliente autenticado, del más reciente
 * al más antiguo. Aquí es donde se usa `isNeonEmailVerified` (la duda que
 * dejé en la nota de `createOrder`).
 *
 * Un pedido se considera "del cliente" si cumple UNA de estas condiciones:
 *  1. Está vinculado a su cuenta (`customer_id` = su id). Son los pedidos
 *     hechos con sesión iniciada.
 *  2. Se hizo como INVITADO con el mismo email de su cuenta, pero SOLO si
 *     ese email está verificado. Así, si compró como invitado y luego se
 *     registra, sigue viendo sus compras antiguas.
 *
 * Seguridad (la razón de la verificación): cualquiera puede registrarse con
 * el email de otra persona. Sin verificar, un atacante crearía una cuenta
 * con `victima@correo.com` y vería los pedidos (nombre, teléfono, dirección)
 * de la víctima. Con la verificación, solo quien controla el buzón accede.
 *
 * Ruta esperada: GET con query opcional: `?storeSlug=mi-tienda` o
 * `?storeId=3` para ver solo los pedidos de una tienda.
 * Requiere autenticación (`requireAuth`).
 *
 * Respuestas:
 *  - 200: `{ success, orders }` (cada pedido incluye `stores: { id, name, slug }`).
 *  - 404: se pidió una tienda concreta y no existe.
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada de Express (`req.user` y `req.query`).
 * @param res - Respuesta de Express.
 */
export const getCustomerOrders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Id y email del usuario autenticado (de la sesión). `!` asume que
    // `requireAuth` ya corrió.
    const { id: userId, email: userEmail } = req.user!;
    const { storeSlug, storeId } = req.query;

    // Filtro opcional por tienda. Empieza vacío (= todas las tiendas) y,
    // si se pide una, pasa a `{ store_id: n }`. Se esparce luego en el `where`.
    let storeFilter: { store_id: number } | {} = {};

    // Si se envía cualquiera de los dos parámetros, el usuario QUIERE
    // filtrar: si la tienda no se encuentra, es 404 y NO se devuelven
    // pedidos de todas las tiendas.
    if (storeSlug !== undefined || storeId !== undefined) {
      // `parseId` devuelve null si no es un entero positivo (también si
      // `storeId` es array u objeto, porque `Number([..])` da NaN).
      const id = parseId(storeId);

      // Prioridad: el slug (si es un string no vacío); si no, el id.
      // Si ninguno es válido, `store` es null.
      const store = typeof storeSlug === "string" && storeSlug
        ? await prisma.stores.findUnique({ where: { slug: storeSlug }, select: { id: true } })
        : id ? await prisma.stores.findUnique({ where: { id }, select: { id: true } }) : null;
      if (!store) {
        res.status(404).json({ success: false, message: "Store not found" });
        return;
      }
      storeFilter = { store_id: store.id };
    }

    // ¿Se puede confiar en el email? Solo si la cuenta tiene email Y está
    // verificado. Se consulta la BD en vivo (no la sesión), así que tras
    // verificar el email los pedidos de invitado aparecen al instante.
    // Resultado: `matchEmail` es falsy ("" / null / undefined / false) o `true`.
    const matchEmail = userEmail && await isNeonEmailVerified(userId);

    const orders = await prisma.orders.findMany({
      where: {
        // Filtro de tienda (vacío si no se pidió).
        ...storeFilter,
        // OR: basta con que se cumpla una condición.
        OR: [
          // Siempre: pedidos vinculados a su cuenta.
          { customer_id: userId },
          // Solo con email verificado: pedidos de invitado con su email.
          // `mode: "insensitive"` ignora mayúsculas/minúsculas.
          // `as const` fija el literal "insensitive" para que TypeScript
          // lo acepte como tipo de `mode` (si no, lo ensancha a `string`).
          ...(matchEmail ? [{ customer_email: { equals: userEmail, mode: "insensitive" as const } }] : []),
        ],
      },
      orderBy: { created_at: "desc" },
      // Datos mínimos de la tienda para mostrar en la lista.
      include: { stores: { select: { id: true, name: true, slug: true } } },
    });
    res.status(200).json({ success: true, orders });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getCustomerOrders error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch your orders" });
  }
}