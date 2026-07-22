import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../../../generated/prisma/enums';

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus, example: 'SUBMITTED' })
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}
