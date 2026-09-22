import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator'

export class PublishAuctionRequestDto {
  @ApiProperty({
    example: 'inventory-product-123',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  productId!: string

  @ApiProperty({
    enum: [24, 48],
    example: 24,
  })
  @IsInt()
  @IsIn([24, 48])
  durationHours!: number

  @ApiProperty({
    example: 10,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  minimumBidCredits!: number

  @ApiPropertyOptional({
    example: 25,
    minimum: 1,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  buyNowCredits?: number | null
}

export class AuctionResponseDto {
  @ApiProperty()
  id!: string

  @ApiProperty()
  sellerId!: string

  @ApiProperty()
  productId!: string

  @ApiProperty({
    enum: [24, 48],
  })
  durationHours!: number

  @ApiProperty()
  publicationFeeCredits!: number

  @ApiProperty()
  minimumBidCredits!: number

  @ApiPropertyOptional({
    nullable: true,
  })
  buyNowCredits!: number | null

  @ApiProperty({
    enum: ['ACTIVE'],
  })
  status!: string

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  publishedAt!: Date

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  closesAt!: Date
}

export class RegisterBidRequestDto {
  @ApiProperty({
    example: 25,
    minimum: 1,
    description: 'Monto de la puja expresado en creditos.',
  })
  @IsInt()
  @Min(1)
  amountCredits!: number
}

export class BidResponseDto {
  @ApiProperty({
    example: 'bid-123',
  })
  id!: string

  @ApiProperty({
    example: 'auction-123',
  })
  auctionId!: string

  @ApiProperty({
    example: 'player-123',
  })
  bidderId!: string

  @ApiProperty({
    example: 25,
    minimum: 1,
  })
  amountCredits!: number

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  placedAt!: Date
}

/**
 * Respuesta utilizada por la Web para HU-63.6.
 *
 * La oferta lider puede ser null cuando aun nadie
 * ha realizado una puja.
 */
export class AuctionDetailResponseDto extends AuctionResponseDto {
  @ApiPropertyOptional({
    type: BidResponseDto,
    nullable: true,
  })
  currentBid!: BidResponseDto | null
}

export const assertIdempotencyKey = (value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0 || value.length > 128) {
    throw new Error('INVALID_IDEMPOTENCY_KEY')
  }

  return value
}
