import { Request, Response, NextFunction } from "express";
import multer from "multer";

// Almacenamiento en memoria (Buffer): evita escribir en disco temporalmente,
// facilitando el procesamiento directo en memoria o la subida directa a servicios en la nube (S3, Cloudinary, etc.)
const storage = multer.memoryStorage();

const maxFileSize = 5 * 1024 * 1024; // 5MB por archivo
const maxFiles = 10; // Máximo de archivos por petición

// Lista blanca de tipos MIME permitidos.
// NOTA DE SEGURIDAD: SVG se excluye intencionadamente para prevenir ataques XSS (Cross-Site Scripting),
// ya que los archivos XML/SVG pueden contener scripts ejecutables.
const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

/**
 * Instancia de Multer configurada con límites de tamaño, cantidad y validación de tipos MIME.
 */
export const upload = multer({
	storage: storage,
	limits: { fileSize: maxFileSize, files: maxFiles },
	fileFilter: (_req, file, cb) => {
		if (allowedTypes.includes(file.mimetype)) {
			cb(null, true);
		} else {
			// Rechaza archivos con tipo MIME no autorizado emitiendo un error controlado de Multer
			cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
		}
	},
});

/**
 * Middleware centralizado de gestión de errores de carga de archivos.
 * 
 * Intercepta los errores nativos emitidos por Multer (tamaño excedido, demasiados archivos, formato no permitido)
 * y los traduce a respuestas HTTP 400 Bad Request claras para el cliente, evitando que deriven en errores 500 no controlados.
 * 
 * Debe registrarse en Express después de las rutas que manejen subidas:
 * @example app.use(handleUploadError)
 */
export const handleUploadError = (err: unknown, _req: Request, res: Response, next: NextFunction) => {
	if (err instanceof multer.MulterError) {
		const messages: Record<string, string> = {
			LIMIT_FILE_SIZE: "File is too large (max 5MB)",
			LIMIT_FILE_COUNT: `Too many files (max ${maxFiles})`,
			LIMIT_UNEXPECTED_FILE: "Only JPEG, PNG, WebP, GIF and AVIF images are allowed",
		};
		res.status(400).json({ success: false, message: messages[err.code] || err.message });
		return;
	}
	// Si no es un error de Multer, lo delega al siguiente middleware de error global
	next(err);
};
