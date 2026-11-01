-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "order_number" VARCHAR(100) NOT NULL,
    "store_id" INTEGER,
    "customer_id" UUID,
    "customer_name" VARCHAR(255) NOT NULL,
    "customer_email" VARCHAR(255) NOT NULL,
    "customer_phone" VARCHAR(50),
    "shipping_address" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(10,2) DEFAULT 0,
    "shipping_cost" DECIMAL(10,2) DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL,
    "coupon_code" VARCHAR(50),
    "payment_status" VARCHAR(50) DEFAULT 'pending',
    "payment_method" VARCHAR(50) DEFAULT 'cod',
    "order_status" VARCHAR(50) DEFAULT 'placed',
    "tracking_number" VARCHAR(100),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "store_id" INTEGER,
    "category_id" INTEGER,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "compare_at_price" DECIMAL(10,2),
    "sku" VARCHAR(100),
    "stock" INTEGER DEFAULT 0,
    "images" JSONB DEFAULT '[]',
    "variants" JSONB DEFAULT '[]',
    "status" VARCHAR(50) DEFAULT 'active',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" SERIAL NOT NULL,
    "merchant_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "logo_url" TEXT,
    "banner_url" TEXT,
    "description" TEXT,
    "currency" VARCHAR(10) DEFAULT 'USD',
    "status" VARCHAR(50) DEFAULT 'active',
    "shipping_fee" DECIMAL(10,2) DEFAULT 0,
    "free_shipping_threshold" DECIMAL(10,2) DEFAULT 0,
    "hero_style" VARCHAR(50) DEFAULT 'hero1',
    "accent_color" VARCHAR(50) DEFAULT '#059669',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "idx_orders_number" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "idx_orders_store" ON "orders"("store_id");

-- CreateIndex
CREATE INDEX "idx_products_store" ON "products"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_slug_key" ON "stores"("slug");

-- CreateIndex
CREATE INDEX "idx_stores_slug" ON "stores"("slug");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
