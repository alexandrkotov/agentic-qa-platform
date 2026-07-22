export interface Customer {
  id: number;
  email: string;
  name: string;
  createdAt: string;
}

export interface Product {
  id: number;
  name: string;
  price: string; // Prisma Decimal serializes as string over JSON
  createdAt: string;
}

export type OrderStatus = 'DRAFT' | 'SUBMITTED';

export interface OrderItem {
  id: number;
  orderId: number;
  productId: number;
  quantity: number;
  unitPrice: string;
}

export interface Order {
  id: number;
  customerId: number;
  status: OrderStatus;
  items: OrderItem[];
  createdAt: string;
}