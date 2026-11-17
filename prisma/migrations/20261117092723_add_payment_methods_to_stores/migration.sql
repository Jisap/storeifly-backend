-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "address" TEXT,
ADD COLUMN     "payment_methods" TEXT[] DEFAULT ARRAY['mobile_money', 'cash_on_delivery', 'bank_transfer']::TEXT[];
