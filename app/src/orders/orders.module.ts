import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, KafkaProducerService],
})
export class OrdersModule {}
