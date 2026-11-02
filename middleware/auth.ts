import { Request, Response, NextFunction } from 'express';
import { jwtVerify, createRemoteJWKSet, JWTPayload } from 'jose';
import { findNeonUser } from '../services/neonUser.js';
import { prisma } from '../config/prisma.js';

// Estructura normalizada del usuario autenticado expuesta en req.user
export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'merchant' | 'customer' | null;
  name: string | null;
  store_id?: number | null;
}

// Extensión de la interfaz Request de Express para incluir el usuario autenticado
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

const NEON_AUTH_JWKS_URL = process.env.NEON_AUTH_JWKS_URL;
const NEON_AUTH_BASE_URL = process.env.NEON_AUTH_BASE_URL;

// Conjunto de claves públicas remotas (JWKS) e issuer para validar tokens emitidos por Neon Auth
let neonJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let neonIssuer = "";

try {
  if (NEON_AUTH_JWKS_URL) {
    // Descarga y gestiona en caché las claves públicas para comprobar firmas criptográficas
    neonJWKS = createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL));
  }
  if (NEON_AUTH_BASE_URL) {
    // Origen esperado del token (claim 'iss')
    neonIssuer = new URL(NEON_AUTH_BASE_URL).origin;
  }
} catch (error) {
  console.error('Invalid NEON_AUTH_BASE_URL or JWKS URL:', error);
}

/**
 * Valida el JWT contra Neon Auth y resuelve el estado actual del usuario en la base de datos.
 * 
 * Flujo:
 * 1. Comprueba firma, expiración e 'iss' con jose (JWKS).
 * 2. Verifica en la base de datos que el usuario exista y no tenga baneo activo.
 * 3. Determina el rol real y la tienda asociada directamente desde la BD (evita confiar ciegamente en claims del token).
 * 
 * @returns AuthUser si el token y usuario son válidos; null si es inválido, expirado, baneado o inexistente.
 */
export const verifyAuthToken = async (token: string | undefined):
  Promise<AuthUser | null> => {
  if (!token || !neonIssuer || !neonJWKS) return null;

  let payload: JWTPayload;
  try {
    // 1. Verificación criptográfica del token
    ({ payload } = await jwtVerify(token, neonJWKS, { issuer: neonIssuer }));
  } catch {
    return null;
  }
  if (!payload.sub && !payload.email) return null;

  const userEmail = String(payload.email || "").toLowerCase();
  const userId = String(payload.sub || payload.id || "");

  // 2. Comprobación del usuario en base de datos
  const u = await findNeonUser({
    ...(userId ? { id: userId } : {}),
    ...(userEmail ? { email: userEmail } : {}),
  });

  // Usuario eliminado tras la emisión del token
  if (!u) return null;

  // Usuario suspendido o baneado (permanente o vigente según banExpires)
  if (u.banned && (!u.banExpires || u.banExpires > new Date())) return null;

  // 3. Resolución de tienda y rol desde la base de datos
  const store = await prisma.stores.findFirst({ where: { merchant_id: u.id } });

  let role: 'admin' | 'merchant' | 'customer' = 'customer';
  if (u.role === 'admin') {
    role = 'admin';
  } else if (store || u.role === 'merchant') {
    role = 'merchant';
  }

  return {
    id: u.id,
    email: u.email,
    name: u.name || u.email.split("@")[0],
    role,
    store_id: role === 'admin' ? null : store?.id ?? null,
  };
};

/**
 * Middleware de autenticación obligatoria:
 * Requiere el header 'Authorization: Bearer <token>'. Si falta, expira, es inválido
 * o el usuario está inactivo/baneado, responde 401 Unauthorized.
 */
export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const user = await verifyAuthToken(token);
  if (!user) {
    res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired token' });
    return;
  }

  req.user = user;
  next();
};

/**
 * Middleware de autenticación opcional:
 * Si se envía un token válido, puebla `req.user`. Si no se envía o falla,
 * continúa la ejecución normalmente sin bloquear la petición.
 */
export const optionalAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const user = await verifyAuthToken(token);
    if (user) {
      req.user = user;
    }
  }
  next();
};

/**
 * Middleware para autorización basada en roles (RBAC):
 * Se usa después de `requireAuth`. Bloquea con 403 Forbidden si el rol del usuario no está en la lista permitida.
 * 
 * @example router.post('/products', requireAuth, requireRole(['merchant', 'admin']), createProduct)
 */
export const requireRole = (roles: Array<'admin' | 'merchant' | 'customer'>) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.user.role || !roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: 'Forbidden: Access denied' });
      return;
    }
    next();
  };
};
