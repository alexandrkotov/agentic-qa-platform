import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus } from '../../generated/prisma/enums';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products not found');
    }

    const priceMap = new Map(products.map((p) => [p.id, p.price]));

    return this.prisma.order.create({
      data: {
        customerId: dto.customerId,
        items: {
          create: dto.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: priceMap.get(item.productId)!,
          })),
        },
        history: {
          create: { status: OrderStatus.DRAFT },
        },
      },
      include: { items: true },
    });
  }

  findAll() {
    return this.prisma.order.findMany({ include: { items: true } });
  }

  async findOne(id: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, history: true },
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  async updateStatus(id: number, status: OrderStatus) {
    const order = await this.findOne(id);
    if (order.status === status) {
      throw new BadRequestException(`Order is already ${status}`);
    }
    return this.prisma.$transaction([
      this.prisma.order.update({ where: { id }, data: { status } }),
      this.prisma.orderStatusHistory.create({ data: { orderId: id, status } }),
    ]);
  }

  async remove(id: number) {
    const order = await this.findOne(id);
    if (order.status !== 'DRAFT') {
      throw new ConflictException(`Cannot delete order ${id}: only DRAFT orders can be deleted`);
    }
    return this.prisma.order.delete({ where: { id } });
  }

  async updateItems(id: number, items: { productId: number; quantity: number }[]) {
    const order = await this.findOne(id);
    if (order.status !== 'DRAFT') {
      throw new ConflictException(`Cannot edit order ${id}: only DRAFT orders can be edited`);
    }
    const productIds = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products not found');
    }
    const priceMap = new Map(products.map((p) => [p.id, p.price]));
    await this.prisma.orderItem.deleteMany({ where: { orderId: id } });
    return this.prisma.order.update({
      where: { id },
      data: {
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: priceMap.get(item.productId)!,
          })),
        },
      },
      include: { items: true },
    });
  }
}
