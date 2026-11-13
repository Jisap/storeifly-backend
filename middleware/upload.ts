import { Request, Response, NextFunction } from "express";
import multer from "multer";

const storage = multer.memoryStorage();

const maxFileSize = 5 * 1024 * 1024; // 5MB
const maxFiles = 10;

// SVG is left out on purpose: SVG files can contain scripts
const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

export const upload = multer({
	storage: storage,
	limits: { fileSize: maxFileSize, files: maxFiles },
	fileFilter: (_req, file, cb) => {
		if (allowedTypes.includes(file.mimetype)) {
			cb(null, true);
		} else {
			cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
		}
	},
});

// Turns multer errors (too big, too many, wrong type) into 400s instead of 500s.
// Register after the routes: app.use(handleUploadError)
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
	next(err);
};