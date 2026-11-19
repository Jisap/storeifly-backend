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

/**
 * Devuelve todos los usuarios de Neon Auth con rol "merchant", del más
 * reciente al más antiguo.
 *
 * Es la fuente de datos de `getAllMerchants`. Usa SQL crudo porque la tabla
 * `neon_auth."user"` no está en tus modelos de Prisma (igual que
 * `findNeonUserByIds` y `updateNeonUserRole`).
 *
 * Si falla la consulta, el error se propaga: quien la llame debe capturarlo
 * (try/catch) y decidir qué responder, normalmente un 500.
 *
 * @returns Array de `NeonUserRecord` (vacío si no hay comerciantes).
 *          Cada elemento incluye: id, name, email, role, createdAt,
 *          updatedAt, banned y banExpires.
 */
export const findNeonMerchants = async (): Promise<NeonUserRecord[]> => {
  // No lleva `await` ni `async` interno: `$queryRaw` ya devuelve una
  // promesa y, al retornarla directamente, la función `async` la
  // "desenvuelve". Es equivalente a `return await ...`, salvo un detalle:
  // sin `await`, un error de la consulta no se captura con un try/catch
  // DENTRO de esta función (aquí no hay ninguno, así que da igual).
  //
  // `<NeonUserRecord[]>` le indica a TypeScript la forma de las filas,
  // pero no la verifica: si cambias el SELECT, actualiza el tipo a mano.
  //
  // SQL:
  //  - `"user"`, `"createdAt"`, `"updatedAt"` y `"banExpires"` llevan comillas
  //    dobles porque Postgres, si no, los pasaría a minúsculas.
  //  - `WHERE role = 'merchant'` es un valor fijo escrito en la consulta (no
  //    viene del usuario), así que no hay riesgo de inyección SQL.
  //  - `ORDER BY "createdAt" DESC`: los comerciantes más recientes primero.
  return prisma.$queryRaw<NeonUserRecord[]>`
        SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE role = 'merchant'
        ORDER BY "createdAt" DESC`;
}

/**
 * Comprueba si un usuario ha confirmado que es dueño de su email.
 *
 * Lee la columna `"emailVerified"` de `neon_auth."user"`. Usa SQL crudo
 * porque esa tabla no está en tus modelos de Prisma (igual que
 * `updateNeonUserRole`, `findNeonUserByIds` y `findNeonMerchants`).
 *
 * Es una comprobación "segura por defecto": solo devuelve `true` si el
 * valor es exactamente `true`. Devuelve `false` en todos estos casos:
 *  - El usuario no existe (`rows[0]` es `undefined`).
 *  - `emailVerified` es `false`.
 *  - `emailVerified` es `NULL` (la columna admite nulos).
 *
 * Se usa en el flujo de pedidos para exigir un email verificado antes de
 * permitir una compra.
 *
 * Si la consulta falla (conexión, UUID inválido...), el error se propaga:
 * quien la llame debe capturarlo con try/catch y decidir qué responder
 * (normalmente un 500).
 *
 * @param userId - Id del usuario (UUID) en `neon_auth."user"`.
 * @returns `true` si el email está verificado; `false` en cualquier otro caso.
 */
export const isNeonEmailVerified = async (userId: string): Promise<boolean> => {
  // `$queryRaw` ejecuta SQL que devuelve filas. El tipo genérico indica la
  // forma de cada fila (`emailVerified` puede ser boolean o null), pero
  // TypeScript no lo verifica contra la BD.
  //
  // SEGURIDAD: al ser una "tagged template" (backticks), `${userId}` se
  // envía como parámetro preparado, sin riesgo de inyección SQL.
  //
  // SQL:
  //  - `"emailVerified"` y `"user"` van entre comillas dobles porque, si
  //    no, Postgres los pasaría a minúsculas / chocaría con palabra reservada.
  //  - `${userId}::uuid` convierte el texto a UUID; si el formato es
  //    inválido, Postgres lanza un error.
  //  - `LIMIT 1` es una precaución: el id es único, pero así la consulta
  //    nunca devuelve más de una fila.
  const rows = await prisma.$queryRaw<{ emailVerified: boolean | null }[]>`
        SELECT "emailVerified" FROM neon_auth."user" WHERE id = ${userId}::uuid LIMIT 1`;

  // `rows[0]?.` evita un error si no hay filas. La comparación estricta
  // `=== true` hace que `null` y `undefined` cuenten como no verificado.
  return rows[0]?.emailVerified === true;
}

/**
 * Cuenta cuántos usuarios de Neon Auth tienen el rol "merchant".
 *
 * Pensada para el panel de administración (por ejemplo, "N comerciantes
 * registrados"). Es la versión "solo número" de `findNeonMerchants`: si solo
 * necesitas la cifra, esta es mucho más barata, porque la BD cuenta y no
 * transfiere filas.
 *
 * Usa SQL crudo porque la tabla `neon_auth."user"` no está en tus modelos de
 * Prisma (igual que `updateNeonUserRole`, `findNeonUserByIds`,
 * `findNeonMerchants` e `isNeonEmailVerified`).
 *
 * DIFERENCIA IMPORTANTE con las otras funciones de este archivo: si la
 * consulta falla, NO lanza el error, sino que lo registra y devuelve `0`.
 * Quien la llame no puede distinguir "no hay comerciantes" de "falló la BD".
 *
 * @returns Número de usuarios con rol "merchant" (0 si no hay ninguno o si falla la consulta).
 */
export const countNeonMerchants = async (): Promise<number> => {
  try {
    // `COUNT(*)` en Postgres devuelve `bigint`, y Prisma lo entrega como
    // `BigInt` de JavaScript (no como `number`). Por eso el tipo es
    // `{ count: bigint }`. TypeScript no verifica ese tipo contra la BD.
    //
    // SQL:
    //  - `COUNT(*) as count`: la columna del resultado se llama `count`.
    //  - `neon_auth.user` va SIN comillas aquí. Funciona porque, tras el punto,
    //    Postgres admite palabras reservadas, pero las otras funciones usan
    //    `neon_auth."user"`. Conviene unificar (ver notas).
    //  - `role = 'merchant'` es un valor fijo escrito en la consulta (no viene
    //    del usuario), así que no hay riesgo de inyección SQL.
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count
        FROM neon_auth.user
        WHERE role = 'merchant'
        `;

    // `Number(...)` convierte el `BigInt` a número normal (necesario porque
    // `JSON.stringify` lanza error con BigInt). `rows[0]?.count || 0` cubre
    // que no haya fila; el `0n` (BigInt cero) también es falsy, y da 0 igual.
    // Para cifras de usuarios, `Number` no pierde precisión.
    return Number(rows[0]?.count || 0);
  } catch (e) {
    // El error queda en el log del servidor...
    console.error(e);
    // ...y se devuelve 0 en vez de propagarlo (ver notas).
    return 0;
  }
};
