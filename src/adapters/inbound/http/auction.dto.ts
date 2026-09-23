import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

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

export class ConfigureAutoBidRequestDto {
  @ApiProperty({
    example: 100,
    minimum: 1,
    description: 'Limite maximo en creditos que el jugador autoriza a pujar automaticamente.',
  })
  @IsInt()
  @Min(1)
  maxAmountCredits!: number
}

export class AutoBidConfigResponseDto {
  @ApiProperty({
    example: 'auction-123',
  })
  auctionId!: string

  @ApiProperty({
    example: 'player-123',
  })
  bidderId!: string

  @ApiProperty({
    example: 100,
    minimum: 1,
  })
  maxAmountCredits!: number

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  configuredAt!: Date

  @ApiProperty()
  isActive!: boolean
}

/**
 * Respuesta utilizada por la Web para HU-69.2.
 *
 * remainingClaimDays expresa CA-03 (reclamo valido hasta e incluyendo el
 * dia 7 desde settledAt) como un entero listo para mostrar, derivado del
 * mismo claimDeadline calculado por el agregado en HU-69.1.
 */
export class PendingClaimResponseDto {
  @ApiProperty({
    example: 'auction-123',
  })
  auctionId!: string

  @ApiProperty({
    example: 'inventory-product-123',
  })
  productId!: string

  @ApiProperty({
    example: 'bid-123',
  })
  winningBidId!: string

  @ApiProperty({
    example: 30,
  })
  finalAmountCredits!: number

  @ApiProperty({
    type: String,
    format: 'date-time',
  })
  settledAt!: Date

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Instante limite (inclusive) para reclamar el producto: settledAt + 7 dias.',
  })
  claimDeadline!: Date

  @ApiProperty({
    enum: ['PENDING', 'CLAIMED', 'EXPIRED'],
  })
  claimStatus!: string

  @ApiProperty({
    example: 5,
    minimum: 0,
    description: 'Dias completos restantes hasta claimDeadline, redondeados hacia arriba.',
  })
  remainingClaimDays!: number

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Instante en que se confirmo el reclamo (HU-69.3). Null mientras esta PENDING.',
  })
  claimedAt!: Date | null
}

/**
 * Request de HU-69.4.
 *
 * claimAll=true ignora auctionIds y reclama todos los pending-claims PENDING
 * del titular autenticado. Sin claimAll, auctionIds es la lista explicita
 * (puede llegar vacia: la respuesta es 200 con results: []).
 */
export class ClaimPendingProductsBatchRequestDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['auction-123', 'auction-456'],
    description:
      'Subastas a reclamar. Se ignora si claimAll es true. Una lista vacia u omitida sin claimAll produce results: [].',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(128, { each: true })
  auctionIds?: string[]

  @ApiPropertyOptional({
    example: false,
    description:
      'Si es true, reclama todos los pending-claims PENDING del titular autenticado e ignora auctionIds.',
  })
  @IsOptional()
  @IsBoolean()
  claimAll?: boolean
}

export class ClaimPendingProductsBatchItemResponseDto {
  @ApiProperty({
    example: 'auction-123',
  })
  auctionId!: string

  @ApiProperty({
    enum: [
      'CLAIMED',
      'ALREADY_CLAIMED',
      'NOT_OWNED',
      'NOT_FOUND',
      'EXPIRED',
      'INVENTORY_UNAVAILABLE',
      'ERROR',
    ],
  })
  status!: string

  @ApiPropertyOptional({
    type: PendingClaimResponseDto,
    nullable: true,
    description: 'Presente cuando status es CLAIMED o ALREADY_CLAIMED.',
  })
  claim!: PendingClaimResponseDto | null

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Detalle legible cuando status representa un fallo.',
  })
  message!: string | null
}

export class ClaimPendingProductsBatchResponseDto {
  @ApiProperty({
    type: ClaimPendingProductsBatchItemResponseDto,
    isArray: true,
  })
  results!: ClaimPendingProductsBatchItemResponseDto[]
}

export const assertIdempotencyKey = (value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0 || value.length > 128) {
    throw new Error('INVALID_IDEMPOTENCY_KEY')
  }

  return value
}
