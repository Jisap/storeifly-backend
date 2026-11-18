import "dotenv/config";
import express, { Request, Response } from 'express';
import cors from "cors";
import categoryRouter from "./routes/categoryRoutes.js";
import storeRouter from "./routes/storeRoutes.js";
import productRouter from "./routes/productRoutes.js";
import uploadRouter from "./routes/uploadRouter.js";
import orderRouter from "./routes/orderRoutes.js";
import { handleUploadError } from "./middleware/upload.js";

const app = express();

// Middleware
app.use(cors())
app.use(express.json());
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const port = process.env.PORT || 3000;

app.get('/', (req: Request, res: Response) => {
    res.send('Server is Live!');
});

// API Routes
app.use("/api/categories", categoryRouter)
app.use("/api/upload", uploadRouter);
app.use("/api/stores", storeRouter);
app.use("/api/products", productRouter);
app.use("/api/orders", orderRouter);

// Must come after the routes: turns multer errors into 400s
app.use(handleUploadError);

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});