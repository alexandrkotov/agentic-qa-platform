import { IsString, MinLength, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'Wireless Mouse' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ example: 29.99 })
  @IsNumber()
  @Min(0)
  price!: number;
}
