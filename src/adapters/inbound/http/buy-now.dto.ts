import { ApiProperty } from '@nestjs/swagger'
import { IsBoolean } from 'class-validator'

export class BuyNowRequestDto {
  @ApiProperty({
    description: 'Casilla "Confirmo la compra inmediata" (CA-04). Debe llegar en `true`.',
    example: true,
  })
  @IsBoolean()
  confirmed!: boolean
}

export class BuyNowResponseDto {
  @ApiProperty()
  transactionId!: string

  @ApiProperty()
  auctionId!: string

  @ApiProperty()
  buyerId!: string

  @ApiProperty()
  sellerId!: string

  @ApiProperty()
  productId!: string

  @ApiProperty()
  debitedCredits!: number

  @ApiProperty()
  remainingCredits!: number

  @ApiProperty({ type: String, format: 'date-time' })
  closedAt!: Date

  @ApiProperty({ description: 'true si esta respuesta proviene de un reintento idempotente.' })
  replayed!: boolean
}
