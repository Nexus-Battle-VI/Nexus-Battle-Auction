import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Transform, Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
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

export const MARKETPLACE_PUBLISHER_TYPES = ['PLAYER', 'GAME_MASTER'] as const
export const MARKETPLACE_PRICE_KINDS = ['CREDITS', 'REAL_MONEY'] as const
export const MARKETPLACE_SORTS = [
  'closingSoon',
  'newest',
  'priceAsc',
  'priceDesc',
  'mostBids',
] as const

/**
 * Solo "true" y "false" literales. `@Type(() => Boolean)` convertiria
 * "false" en `true` (cualquier texto no vacio es verdadero); cualquier otro
 * valor se deja pasar tal cual para que `@IsBoolean` lo rechace con 400.
 */
const strictBooleanQuery = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value

/** Recorta solo textos; cualquier otro valor (p. ej. parametro repetido) llega tal cual a `@IsString`. */
const trimmedQuery = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

export class ListActiveAuctionsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ default: 16, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number

  @ApiPropertyOptional({ enum: MARKETPLACE_PUBLISHER_TYPES })
  @IsOptional()
  @IsIn(MARKETPLACE_PUBLISHER_TYPES)
  publisherType?: (typeof MARKETPLACE_PUBLISHER_TYPES)[number]

  @ApiPropertyOptional({ enum: MARKETPLACE_PRICE_KINDS })
  @IsOptional()
  @IsIn(MARKETPLACE_PRICE_KINDS)
  priceKind?: (typeof MARKETPLACE_PRICE_KINDS)[number]

  @ApiPropertyOptional({
    type: Boolean,
    description: 'true: con precio de compra inmediata configurado; false: sin el.',
  })
  @IsOptional()
  @Transform(strictBooleanQuery)
  @IsBoolean()
  hasBuyNow?: boolean

  @ApiPropertyOptional({
    enum: MARKETPLACE_SORTS,
    description:
      'Sin valor: GAME_MASTER primero y cierre ascendente. priceAsc/priceDesc exigen priceKind=CREDITS.',
  })
  @IsOptional()
  @IsIn(MARKETPLACE_SORTS)
  sort?: (typeof MARKETPLACE_SORTS)[number]

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 80,
    description:
      'Subcadena del nombre del producto (Catalog). Se recorta; vacio o solo espacios responde 400.',
  })
  @IsOptional()
  @Transform(trimmedQuery)
  @IsString()
  @Length(1, 80)
  search?: string
}

export class ActiveAuctionSummaryResponseDto {
  @ApiProperty()
  id!: string
  @ApiProperty()
  sellerId!: string
  @ApiProperty({ enum: ['PLAYER', 'GAME_MASTER'] })
  publisherType!: 'PLAYER' | 'GAME_MASTER'
  @ApiProperty()
  productId!: string
  @ApiProperty({ enum: ['CREDITS', 'REAL_MONEY'] })
  priceKind!: 'CREDITS' | 'REAL_MONEY'
  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  minimumBidCredits!: number | null
  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  buyNowCredits!: number | null
  @ApiPropertyOptional({ nullable: true, example: 'COP' })
  currency!: string | null
  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  minimumBidAmountMinor!: number | null
  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  buyNowAmountMinor!: number | null
  @ApiPropertyOptional({ nullable: true, enum: ['OFFICIAL', 'PREMIUM'] })
  officialMark!: 'OFFICIAL' | 'PREMIUM' | null
  @ApiProperty({ enum: ['ACTIVE'] })
  status!: 'ACTIVE'
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt!: Date
  @ApiProperty({ type: String, format: 'date-time' })
  closesAt!: Date
  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  currentBidAmount!: number | null
  @ApiProperty({ minimum: 0, description: 'Total de pujas persistidas de la subasta.' })
  bidCount!: number
}

export class ActiveAuctionPageResponseDto {
  @ApiProperty({ type: [ActiveAuctionSummaryResponseDto] })
  items!: ActiveAuctionSummaryResponseDto[]
  @ApiProperty({ minimum: 1 })
  page!: number
  @ApiProperty({ minimum: 1, maximum: 100 })
  pageSize!: number
  @ApiProperty({ minimum: 0 })
  total!: number
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
  @ApiProperty({ minimum: 0, description: 'Total de pujas persistidas de la subasta.' })
  bidCount!: number
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
