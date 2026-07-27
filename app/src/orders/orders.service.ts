import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus } from '../../generated/prisma/enums';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

const ORDER_STATUS_CHANGED_TOPIC = 'orders.status-changed';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private kafkaProducer: KafkaProducerService,
  ) { }

  async create(dto: CreateOrderDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) {
      throw new BadRequestException(`Customer ${dto.customerId} not found`);
    }
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products not found');
    }

    const priceMap = new Map(products.map((p) => [p.id, p.price]));

    const order = await this.prisma.order.create({
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

    await this.kafkaProducer.publish(ORDER_STATUS_CHANGED_TOPIC, {
      orderId: order.id,
      customerId: order.customerId,
      status: order.status,
      occurredAt: new Date().toISOString(),
    });

    return order;
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

  // Orders move through a one-way lifecycle: DRAFT -> SUBMITTED.
  // SUBMITTED is a fixed business event (see remove()/updateItems() below),
  // so no status may transition out of it.
  private static readonly ALLOWED_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.DRAFT]: [OrderStatus.SUBMITTED],
    [OrderStatus.SUBMITTED]: [],
  };

  async updateStatus(id: number, status: OrderStatus) {
    const order = await this.findOne(id);
    if (order.status === status) {
      throw new BadRequestException(`Order is already ${status}`);
    }
    const allowed = OrdersService.ALLOWED_STATUS_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(status)) {
      throw new ConflictException(
        `Cannot transition order ${id} from ${order.status} to ${status}`,
      );
    }
    const result = await this.prisma.$transaction([
      this.prisma.order.update({ where: { id }, data: { status } }),
      this.prisma.orderStatusHistory.create({ data: { orderId: id, status } }),
    ]);

    await this.kafkaProducer.publish(ORDER_STATUS_CHANGED_TOPIC, {
      orderId: id,
      customerId: order.customerId,
      status,
      occurredAt: new Date().toISOString(),
    });

    return result;
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
