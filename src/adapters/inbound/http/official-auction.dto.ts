import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

const ISO_4217_PATTERN = /^[A-Z]{3}$/u

export class PublishOfficialAuctionRequestDto {
  @ApiProperty({
    example: 'exclusive-product-123',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  productId!: string

  @ApiProperty({
    enum: [24, 48],
    example: 48,
  })
  @IsInt()
  @IsIn([24, 48])
  durationHours!: number

  @ApiProperty({
    example: 'COP',
    minLength: 3,
    maxLength: 3,
    description: 'Codigo ISO 4217 de tres letras mayusculas.',
  })
  @IsString()
  @Matches(ISO_4217_PATTERN)
  currency!: string

  @ApiProperty({
    example: 150_000,
    minimum: 1,
    description: 'Precio minimo, en la unidad menor de `currency`.',
  })
  @IsInt()
  @Min(1)
  minimumBidAmountMinor!: number

  @ApiPropertyOptional({
    example: 300_000,
    minimum: 1,
    nullable: true,
    description: 'Precio de compra inmediata, en la unidad menor de `currency`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  buyNowAmountMinor?: number | null
}

export class OfficialAuctionResponseDto {
  @ApiProperty()
  id!: string

  @ApiProperty()
  publisherId!: string

  @ApiProperty({ enum: ['GAME_MASTER'] })
  publisherType!: string

  @ApiProperty()
  productId!: string

  @ApiProperty({ enum: [24, 48] })
  durationHours!: number

  @ApiProperty({ enum: [0] })
  publicationFeeCredits!: number

  @ApiProperty()
  currency!: string

  @ApiProperty()
  minimumBidAmountMinor!: number

  @ApiPropertyOptional({ nullable: true })
  buyNowAmountMinor!: number | null

  @ApiProperty({ enum: ['OFFICIAL', 'PREMIUM'] })
  mark!: string

  @ApiProperty({ enum: ['ACTIVE'] })
  status!: string

  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt!: Date

  @ApiProperty({ type: String, format: 'date-time' })
  closesAt!: Date
}
