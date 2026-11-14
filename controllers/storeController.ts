import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { updateNeonUserRole, findNeonUserByIds, findNeonMerchants } from "../services/neonUser.js";

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

/**
 * Comprueba si un error de Prisma corresponde a una violación de
 * restricción UNIQUE (código "P2002"), por ejemplo un `slug` ya usado.
 *
 * Se usa en los `catch` para responder 409 (conflicto) en lugar de 500.
 *
 * @param error - Error capturado (tipado `any` porque en un `catch` es `unknown`).
 * @returns `true` si es un error P2002.
 */
const isUniqueError = (error: any) => error?.code === "P2002";

/**
 * Controlador: crea la tienda del usuario autenticado.
 *
 * Reglas de negocio:
 *  - Cualquier usuario autenticado puede crear una tienda, EXCEPTO los
 *    administradores de la plataforma (role "admin").
 *  - Cada usuario puede tener UNA sola tienda.
 *  - Al crearla, el usuario pasa a tener el rol "merchant".
 *
 * Ruta esperada: POST con body JSON. Campos: los de `parseStoreInput`
 * (`name` obligatorio) y, opcionalmente, `slug` (la parte de la URL de la
 * tienda; si no se envía, se genera a partir del nombre).
 *
 * Flujo:
 *  1. Comprueba que el usuario no es admin.
 *  2. Comprueba que aún no tiene tienda.
 *  3. Valida y limpia el body (`parseStoreInput(body, false)`).
 *  4. Genera el slug y verifica que no esté vacío ni ocupado.
 *  5. Crea la tienda en la BD.
 *  6. Actualiza el rol del usuario a "merchant".
 *
 * Respuestas:
 *  - 201: `{ success, message, store }`
 *  - 400: ya tiene tienda, datos inválidos o slug vacío.
 *  - 403: el usuario es admin de plataforma.
 *  - 409: el slug ya está en uso.
 *  - 500: error inesperado.
 *
 * Nota: a diferencia de los controladores de Cloudinary, este NO devuelve
 * `return res...`; responde con `res...` + `return;` y declara
 * `Promise<void>`. Es equivalente, solo cambia el estilo.
 */
export const createStore = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Id del usuario autenticado. `!` asume que `req.user` existe
    // (la ruta debe estar protegida por el middleware de auth).
    const merchantId = req.user!.id;

    // Los admins de plataforma no pueden tener tienda.
    if (req.user!.role === "admin") {
      res.status(403).json({ success: false, message: "Platform admin accounts cannot create a store" });
      return;
    }

    // Limita a una tienda por usuario. Solo se selecciona `id` porque
    // únicamente interesa saber si existe.
    const existingStore = await prisma.stores.findFirst({ where: { merchant_id: merchantId }, select: { id: true } });
    if (existingStore) {
      res.status(400).json({ success: false, message: "You already have a store" });
      return;
    }

    // Valida el body (modo creación: `name` obligatorio).
    // `"error" in parsed` distingue las dos formas del union type
    // y estrecha el tipo: después del `if`, `parsed.data` es válido.
    const parsed = parseStoreInput(req.body, false);
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }

    // Origen del slug: el `slug` enviado por el cliente si es un string
    // no vacío; si no, el nombre de la tienda.
    const slugSource = typeof req.body?.slug === "string" && req.body.slug.trim() ? req.body.slug : parsed.data.name;
    // Se normaliza con `generateSlug` (también al slug enviado por el cliente).
    const finalSlug = generateSlug(slugSource);
    // Si tras limpiar no queda nada (ej. "!!!"), no es utilizable.
    if (!finalSlug) {
      res.status(400).json({ success: false, message: "Store name or slug must contain letters or numbers" });
      return;
    }

    // Comprobación previa de unicidad para dar un 409 claro.
    // No es 100 % fiable (ver notas), por eso el `catch` también gestiona P2002.
    const slugCheck = await prisma.stores.findUnique({ where: { slug: finalSlug }, select: { id: true } });
    if (slugCheck) {
      res.status(409).json({ success: false, message: "That store URL is already taken" });
      return;
    }

    const newStore = await prisma.stores.create({
      data: {
        // Moneda por defecto; `...parsed.data` va DESPUÉS y la
        // sobrescribe si el cliente envió `currency`.
        currency: "GHS",
        ...parsed.data,
        name: parsed.data.name,
        // Estos campos van al final a propósito: los controla el
        // servidor y no pueden ser sobrescritos por el cliente.
        merchant_id: merchantId,
        slug: finalSlug,
        status: "active", // el comerciante no elige su propio estado
      },
    });

    // Convierte al usuario en comerciante (según el comentario original,
    // nunca rebaja a un admin).
    await updateNeonUserRole(merchantId, "merchant");

    res.status(201).json({ success: true, message: "Store created successfully", store: newStore });
  } catch (error) {
    // Condición de carrera: dos peticiones con el mismo slug pasan la
    // comprobación previa a la vez; la BD rechaza la segunda con P2002.
    if (isUniqueError(error)) {
      res.status(409).json({ success: false, message: "That store URL is already taken" });
      return;
    }
    // Cualquier otro error: detalle en el log, mensaje genérico al cliente.
    console.error("createStore error:", error);
    res.status(500).json({ success: false, message: "Failed to create store" });
  }
};

/**
 * Controlador: convierte al usuario autenticado en comerciante ("merchant")
 * SIN crearle todavía una tienda.
 *
 * Sirve como paso previo del onboarding: el usuario obtiene el rol y,
 * después, puede crear su tienda con `createStore`. También es útil para
 * que el frontend sepa en qué punto está el usuario: si la respuesta trae
 * `store: null`, aún le falta crearla.
 *
 * Es idempotente: llamarlo varias veces da el mismo resultado (si ya es
 * merchant, `updateNeonUserRole` no modifica nada y simplemente se
 * devuelve su tienda).
 *
 * Ruta esperada: POST sin body. Requiere autenticación.
 *
 * Flujo:
 *  1. Rechaza a los administradores de plataforma.
 *  2. Asigna el rol "merchant" (si procede).
 *  3. Busca la tienda del usuario, si ya tiene una.
 *
 * Respuestas:
 *  - 200: `{ success: true, role: "merchant", store }` (`store` es `null`
 *         si todavía no tiene tienda).
 *  - 403: el usuario es admin de plataforma.
 *  - 500: error inesperado (BD, fallo al actualizar el rol...).
 *
 * @param req - Petición autenticada de Express (`req.user` lo rellena el middleware de auth).
 * @param res - Respuesta de Express.
 */
export const onboardMerchant = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Id del usuario autenticado. `!` asume que `req.user` existe
    // (la ruta debe estar protegida por el middleware de auth).
    const userId = req.user!.id;

    // Los admins de plataforma no pueden ser comerciantes. Se comprueba
    // aquí además de en el SQL de `updateNeonUserRole` para devolver un
    // 403 claro en vez de fallar o ignorar la petición en silencio.
    if (req.user!.role === "admin") {
      res.status(403).json({ success: false, message: "Platform admin accounts cannot become merchants" });
      return;
    }

    // Asigna el rol "merchant". Si el usuario ya lo es, la consulta no
    // actualiza ninguna fila y no se lanza error.
    await updateNeonUserRole(userId, "merchant");

    // Busca la tienda del usuario (puede no existir). Aquí se devuelve el
    // registro completo, no solo el `id` como en `createStore`.
    const store = await prisma.stores.findFirst({ where: { merchant_id: userId } });

    // `role` se devuelve fijo como "merchant". `store ?? null` convierte
    // `undefined` en `null`, para que el JSON siempre incluya la clave
    // `store` (JSON.stringify omitiría una clave con valor `undefined`).
    res.status(200).json({ success: true, role: "merchant", store: store ?? null });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("onboardMerchant error:", error);
    res.status(500).json({ success: false, message: "Failed to onboard merchant" });
  }
};

/**
 * Controlador: devuelve la tienda del usuario autenticado.
 *
 * Es la operación de lectura "mi tienda": el comerciante no pasa ningún id,
 * la tienda se localiza a partir de su propio `req.user.id`. Así nadie puede
 * consultar la tienda privada de otro usuario cambiando un parámetro.
 *
 * Ruta esperada: GET sin body ni parámetros. Requiere autenticación.
 *
 * Respuestas:
 *  - 200: `{ success: true, store }`
 *  - 404: el usuario todavía no ha creado su tienda.
 *  - 500: error inesperado (BD, etc.).
 *
 * Diferencia con `onboardMerchant`: aquí "no tener tienda" es un 404, mientras
 * que `onboardMerchant` responde 200 con `store: null`. El frontend debe
 * tratar ese 404 como "mostrar el formulario de creación", no como un fallo.
 *
 * @param req - Petición autenticada de Express (`req.user` lo rellena el middleware de auth).
 * @param res - Respuesta de Express.
 */
export const getMyStore = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Busca la tienda cuyo `merchant_id` coincide con el usuario autenticado.
    // `!` asume que `req.user` existe (la ruta debe estar protegida por el
    // middleware de auth). Devuelve `null` si no hay ninguna.
    const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id } });

    // Sin tienda: 404 con un mensaje que el frontend puede usar para
    // redirigir al usuario al flujo de creación.
    if (!store) {
      res.status(404).json({ success: false, message: "You have not created a store yet" });
      return;
    }

    // Se devuelve el registro completo de la tienda.
    res.status(200).json({ success: true, store });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getMyStore error:", error);
    res.status(500).json({ success: false, message: "Failed to get store" });
  }
};

/**
 * Controlador: actualiza los ajustes de la tienda del usuario autenticado.
 *
 * Igual que `getMyStore`, la tienda se localiza a partir de `req.user.id`, no
 * de un id enviado por el cliente. Así un comerciante solo puede modificar
 * SU tienda.
 *
 * Es una actualización parcial: solo se modifican los campos que vengan en
 * el body. Los campos admitidos son los de `parseStoreInput` (name,
 * description, address, logo_url, banner_url, currency, shipping_fee,
 * free_shipping_threshold, payment_methods, hero_style, accent_color).
 *
 * NO se pueden cambiar aquí:
 *  - `slug`: la URL pública de la tienda queda fija tras crearla.
 *  - `status`: lo gestiona la plataforma (ver VALID_STATUSES).
 *  Ambos se ignoran en silencio, porque `parseStoreInput` solo copia los
 *  campos de su lista blanca.
 *
 * Ruta esperada: PUT/PATCH con body JSON. Requiere autenticación.
 *
 * Respuestas:
 *  - 200: `{ success, message, store }` con la tienda ya actualizada.
 *  - 400: algún campo inválido, o no hay ningún campo válido que actualizar.
 *  - 404: el usuario todavía no tiene tienda.
 *  - 500: error inesperado.
 *
 * @param req - Petición autenticada de Express con el body descrito arriba.
 * @param res - Respuesta de Express.
 */
export const updateMyStore = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Localiza la tienda del usuario. Solo se selecciona `id`, que es lo
    // único necesario para el `update` posterior. `!` asume que `req.user`
    // existe (la ruta debe estar protegida por el middleware de auth).
    const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id }, select: { id: true } });
    if (!store) {
      res.status(404).json({ success: false, message: "You have not created a store yet" });
      return;
    }

    // Valida el body en modo parcial (`true`): todos los campos son
    // opcionales y solo se validan los que se hayan enviado.
    // `"error" in parsed` distingue las dos formas del union type.
    const parsed = parseStoreInput(req.body, true);
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }

    // Si el body no traía ningún campo reconocido (vacío, o solo con
    // campos ignorados como `slug` o `status`), no hay nada que hacer.
    // Se responde 400 en vez de ejecutar un `update` vacío.
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ success: false, message: "No valid fields to update" });
      return;
    }

    // Actualiza usando el `id` de la tienda ya verificada como del usuario
    // (no uno del cliente). `parsed.data` contiene solo campos validados.
    // Prisma devuelve el registro completo ya actualizado.
    const updated = await prisma.stores.update({ where: { id: store.id }, data: parsed.data });
    res.status(200).json({ success: true, message: "Store updated successfully", store: updated });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("updateMyStore error:", error);
    res.status(500).json({ success: false, message: "Failed to update store" });
  }
};

/**
 * Controlador (solo administradores de plataforma): lista TODAS las tiendas
 * con sus estadísticas básicas y los datos del comerciante propietario.
 *
 * Para cada tienda devuelve todos sus campos, más:
 *  - `_count`: número de productos, pedidos y categorías.
 *  - `merchant`: `{ id, name, email }` del dueño, o `null` si no se encontró.
 *
 * IMPORTANTE: este controlador NO comprueba por sí mismo que el usuario sea
 * admin. Esa restricción debe aplicarla un middleware en la ruta (por
 * ejemplo, `requireAdmin`). Sin él, cualquier usuario autenticado vería los
 * datos de todas las tiendas y los emails de sus comerciantes.
 *
 * Ruta esperada: GET sin body ni parámetros.
 *
 * Respuestas:
 *  - 200: `{ success: true, stores: [...] }`
 *  - 500: error inesperado (BD, fallo al consultar Neon Auth...).
 *
 * @param _req - Petición (el guion bajo indica que no se usa en la función).
 * @param res  - Respuesta de Express.
 */
export const getAllStores = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Obtiene todas las tiendas, de la más reciente a la más antigua.
    // `include._count` hace que Prisma calcule el número de registros
    // relacionados (productos, pedidos, categorías) sin cargarlos
    // enteros; llegan en `store._count.products`, etc.
    const stores = await prisma.stores.findMany({
      orderBy: { created_at: "desc" },
      include: { _count: { select: { products: true, orders: true, categories: true } } },
    });

    // Los comerciantes no están en las tablas de Prisma sino en Neon Auth,
    // así que no se pueden traer con `include`. Se consultan aparte, en UNA
    // sola llamada con todos los ids (evita el problema de "N+1 consultas").
    // `.filter((id): id is string => !!id)` descarta los `merchant_id`
    // nulos/vacíos, y el type guard hace que TypeScript sepa que el
    // resultado es `string[]`.
    const users = await findNeonUserByIds(stores.map((s) => s.merchant_id).filter((id): id is string => !!id));

    res.status(200).json({
      success: true,
      // Une cada tienda con los datos de su comerciante.
      stores: stores.map((s) => {
        // `users` funciona como diccionario indexado por id de usuario.
        // Si la tienda no tiene `merchant_id`, no se busca nada.
        const m = s.merchant_id ? users[s.merchant_id] : undefined;
        // Se devuelve la tienda completa + solo los campos públicos del
        // comerciante (id, nombre, email), nunca el objeto de usuario entero.
        // Si no se encuentra (usuario borrado, etc.), `merchant: null`.
        return { ...s, merchant: m ? { id: m.id, name: m.name, email: m.email } : null };
      }),
    });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getAllStores error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch stores" });
  }
};

/**
 * Controlador (solo administradores de plataforma): lista TODOS los
 * comerciantes (usuarios con rol "merchant") junto con los datos básicos
 * de su tienda, si la tienen.
 *
 * Es la vista inversa de `getAllStores`: allí se parte de las tiendas y se
 * busca al comerciante; aquí se parte de los comerciantes y se busca su tienda.
 * Por eso aparecen comerciantes SIN tienda (los que pasaron por
 * `onboardMerchant` pero no han llamado a `createStore`), con los campos
 * `store_*` a `null`.
 *
 * Para cada comerciante devuelve todos los campos que entregue
 * `findNeonMerchants`, más:
 *  - `store_id`, `store_name`, `store_slug`, `store_status`
 *    (`null` si todavía no tiene tienda).
 *
 * IMPORTANTE: este controlador NO comprueba por sí mismo que el usuario sea
 * admin. Esa restricción debe aplicarla un middleware en la ruta.
 *
 * Ruta esperada: GET sin body ni parámetros.
 *
 * Respuestas:
 *  - 200: `{ success: true, merchants: [...] }`
 *  - 500: error inesperado (BD, fallo al consultar Neon Auth...).
 *
 * @param _req - Petición (el guion bajo indica que no se usa).
 * @param res  - Respuesta de Express.
 */
export const getAllMerchants = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Obtiene los usuarios con rol merchant desde Neon Auth (no están en
    // los modelos de Prisma, igual que en `findNeonUserByIds`).
    const merchants = await findNeonMerchants();

    // Busca las tiendas de esos comerciantes en UNA sola consulta
    // (`in: [...]`), evitando una consulta por comerciante (N+1).
    // Si no hay comerciantes se salta la consulta: `in: []` no daría
    // error, pero sería trabajo inútil. Solo se seleccionan los campos
    // necesarios (no la tienda completa).
    const stores = merchants.length
      ? await prisma.stores.findMany({
        where: { merchant_id: { in: merchants.map((m) => m.id) } },
        select: { id: true, name: true, slug: true, status: true, merchant_id: true },
      })
      : [];

    // Diccionario merchant_id → tienda para acceso directo.
    // Usa `Map` (no objeto) porque `merchant_id` puede ser `string | null`
    // según el esquema. Si un comerciante tuviera varias tiendas, solo
    // se conservaría la ÚLTIMA (las anteriores se sobrescriben).
    const byMerchant = new Map(stores.map((s) => [s.merchant_id, s]));

    res.status(200).json({
      success: true,
      // Une cada comerciante con los datos de su tienda.
      merchants: merchants.map((m) => {
        const store = byMerchant.get(m.id);
        return {
          // Todos los campos del comerciante (ver nota sobre qué incluye).
          ...m,
          // Se "aplanan" los datos de la tienda con prefijo `store_`.
          // `?? null` garantiza que la clave exista en el JSON aunque
          // no haya tienda (con `undefined` se omitiría).
          store_id: store?.id ?? null,
          store_name: store?.name ?? null,
          store_slug: store?.slug ?? null,
          store_status: store?.status ?? null,
        };
      }),
    });
  } catch (error) {
    // Detalle en el log del servidor; mensaje genérico al cliente.
    console.error("getAllMerchants error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch merchants" });
  }
};

// Platform Admin: Toggle store status (active / suspended).
// Send { status } to set it directly, or nothing to flip it.
export const toggleStoreStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: "Invalid store id" });
      return;
    }

    const requested = req.body?.status;
    if (requested !== undefined && !VALID_STATUSES.includes(requested)) {
      res.status(400).json({ success: false, message: 'status must be "active" or "suspended"' });
      return;
    }

    const store = await prisma.stores.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!store) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    const status = requested ?? (store.status === "active" ? "suspended" : "active");
    const updated = await prisma.stores.update({ where: { id }, data: { status } });
    res.status(200).json({ success: true, message: `Store has been ${status === "active" ? "activated" : "suspended"}`, store: updated });
  } catch (error) {
    console.error("toggleStoreStatus error:", error);
    res.status(500).json({ success: false, message: "Failed to update store status" });
  }
};
