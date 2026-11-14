import { prisma } from "../config/prisma.js";



export interface NeonUserRecord {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  createdAt: Date;
  updatedAt: Date;
  banned: boolean | null;
  banExpires: Date | null;
}

export const findNeonUser = async (filter: { id?: string; email?: string }):
  Promise<NeonUserRecord | null> => {
  try {
    if (filter.id) {
      const rows = await prisma.$queryRaw<NeonUserRecord[]>
        `SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE id = ${filter.id}::uuid
        LIMIT 1`;
      return rows[0] ?? null;
    }
    if (filter.email) {
      const rows = await prisma.$queryRaw<NeonUserRecord[]>
        `SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE LOWER(email) = ${filter.email.trim().toLowerCase()}
        LIMIT 1`;
      return rows[0] ?? null;
    }
  } catch (err) {
    console.error(err);
  }

  return null;
}

/**
 * Actualiza el rol de un usuario en la tabla de autenticación de Neon
 * (`neon_auth."user"`), escribiendo directamente con SQL.
 *
 * Se usa SQL "crudo" (`$executeRaw`) porque esa tabla pertenece al esquema
 * `neon_auth`, gestionado por el servicio de autenticación y normalmente
 * fuera de tus modelos de Prisma.
 *
 * REGLA DE PROTECCIÓN: solo se modifica el usuario si su rol actual es
 * `NULL` o es distinto de "admin" y de "merchant". En la práctica:
 *  - Un admin NUNCA es rebajado (ni cambiado a ningún otro rol).
 *  - Un merchant no se modifica (ya lo es; evita escrituras innecesarias).
 *  - Un usuario sin rol o con otro rol (ej. "user") sí se actualiza.
 *
 * Consecuencia importante: la función es genérica en el nombre, pero en
 * la práctica solo sirve para ASCENDER a usuarios normales. Por ejemplo,
 * no puede convertir un merchant en admin ni un merchant en otro rol.
 *
 * Si la condición no se cumple (o el usuario no existe), la consulta no
 * actualiza ninguna fila y la función termina SIN error: no hay forma de
 * saber desde fuera si se actualizó algo.
 *
 * @param userId - Id del usuario (UUID) en `neon_auth."user"`.
 * @param role   - Nuevo rol a asignar (ej. "merchant").
 * @throws Error("Failed to update Neon user role: ...") si la consulta
 *         falla (conexión, UUID inválido, permisos...).
 */
export const updateNeonUserRole = async (userId: string, role: string): Promise<void> => {
  try {
    // `$executeRaw` ejecuta SQL que no devuelve filas (UPDATE/INSERT/DELETE)
    // y devuelve el número de filas afectadas (aquí se ignora).
    //
    // SEGURIDAD: al ser una "tagged template" (`$executeRaw` + backticks),
    // Prisma convierte `${role}` y `${userId}` en parámetros preparados, NO
    // los concatena en el texto. Por eso no hay riesgo de inyección SQL.
    // Ojo: esto solo funciona con la sintaxis de backticks; si construyes
    // el SQL con un string normal y `$executeRawUnsafe`, sí lo habría.
    await prisma.$executeRaw`
        UPDATE neon_auth."user" 
        SET role = ${role}, "updatedAt" = NOW()
        WHERE id = ${userId}::uuid AND (role IS NULL OR role != 'admin' AND role != 'merchant')`;
    // Detalles del SQL:
    //  - `"user"` y `"updatedAt"` van entre comillas dobles porque son
    //    palabra reservada / usan mayúsculas (Postgres, si no, los pasa a minúsculas).
    //  - `NOW()` guarda la fecha y hora actuales en `updatedAt`.
    //  - `${userId}::uuid` convierte el texto a tipo UUID; si no tiene
    //    formato de UUID, Postgres lanza un error (acaba en el `catch`).
    //  - Precedencia: AND se evalúa antes que OR, así que la condición es
    //    `role IS NULL OR (role != 'admin' AND role != 'merchant')`.
    //    Los paréntesis explícitos lo harían más legible.
    //  - `role IS NULL` va aparte porque `NULL != 'admin'` da NULL (no true)
    //    en SQL, y esas filas quedarían excluidas sin esta comprobación.
  } catch (error) {
    // El error original queda en el log del servidor...
    console.error(error);
    // ...y se relanza con un mensaje propio para que el llamador sepa qué
    // operación falló. Incluye el mensaje original, que puede contener
    // detalles internos de la BD: no lo envíes tal cual al cliente.
    throw new Error("Failed to update Neon user role: " + (error as Error).message);
  }
};

/**
 * Busca varios usuarios de Neon Auth a la vez, con UNA sola consulta SQL.
 *
 * Devuelve un diccionario indexado por id de usuario, no un array:
 *   { "uuid-1": { id, name, email, ... }, "uuid-2": { ... } }
 * Así quien la llama puede acceder directamente con `users[id]` (es lo que
 * hace `getAllStores`, lo que confirma que mi suposición de las notas
 * anteriores era correcta).
 *
 * Los ids que no existan en la tabla simplemente no aparecen en el
 * resultado; no se lanza ningún error por ello.
 *
 * Si falla la consulta (conexión, UUID con formato inválido...), el error
 * se propaga: el llamador debe capturarlo (try/catch) y decidir qué
 * responder, normalmente un 500.
 *
 * @param ids - Lista de ids de usuario (UUID). Admite duplicados y valores vacíos.
 * @returns Diccionario `{ [id]: NeonUserRecord }`. Vacío si no hay ids válidos.
 */
export const findNeonUserByIds = async (ids: string[]): Promise<Record<string, NeonUserRecord>> => {
  // Limpia la entrada:
  //  - `ids ?? []`: si llega null/undefined, se usa un array vacío.
  //  - `.filter(Boolean)`: descarta valores vacíos ("" , null, undefined).
  //  - `new Set(...)`: elimina duplicados.
  //  - `Array.from(...)`: convierte el Set de nuevo en array.
  const uniqueIds = Array.from(new Set((ids ?? []).filter(Boolean)));

  // Atajo: sin ids no se consulta la BD (ahorra una consulta inútil).
  if (uniqueIds.length === 0) return {};

  // Consulta SQL cruda (la tabla `neon_auth."user"` no está en tus modelos
  // de Prisma). `<NeonUserRecord[]>` le dice a TypeScript la forma de las
  // filas, pero es solo una promesa: TypeScript NO verifica que las
  // columnas devueltas coincidan realmente con ese tipo.
  //
  // SEGURIDAD: es una "tagged template", así que `${uniqueIds}` se envía
  // como parámetro preparado, no concatenado (sin riesgo de inyección SQL).
  //
  // `= ANY(${uniqueIds}::uuid[])`: Postgres compara el id con cualquier
  // elemento del array, y es el equivalente a `IN (...)` con una lista de
  // tamaño variable. `::uuid[]` convierte el array de textos a array de UUID.
  // Los nombres con mayúsculas ("createdAt", "banExpires") van entre comillas
  // dobles porque, si no, Postgres los pasaría a minúsculas.
  const rows = await prisma.$queryRaw<NeonUserRecord[]>`
        SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE id = ANY(${uniqueIds}::uuid[])`;

  // Convierte el array de filas en un diccionario id → usuario para que
  // el acceso posterior sea directo, sin buscar en el array cada vez.
  const map: Record<string, NeonUserRecord> = {};
  for (const row of rows) {
    map[row.id] = row;
  }
  return map;
}

// All Neon Auth users with the merchant role, newest first.
// Database errors are thrown so callers can return a 500.
export const findNeonMerchants = async (): Promise<NeonUserRecord[]> => {
  return prisma.$queryRaw<NeonUserRecord[]>`
        SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE role = 'merchant'
        ORDER BY "createdAt" DESC`;
}