import { BadRequestException } from '@nestjs/common'
import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches, MaxLength, MinLength } from 'class-validator'
import { AuctionResponseDto } from './auction.dto'

/** Cuerpo cerrado; la identidad del jugador no forma parte de la solicitud. */
export class FollowAuctionRequestDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    pattern: '^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$',
    example: 'auction-1',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/)
  auctionId!: string
}

/** La misma restriccion de identidad se aplica a la ruta de retirada. */
export class WatchlistParamsDto extends FollowAuctionRequestDto {}

/** Fechas Date se serializan a ISO-8601 UTC en la respuesta JSON de NestJS. */
export class WatchlistResponseDto {
  @ApiProperty({ example: 'auction-1' })
  auctionId!: string
  @ApiProperty({ type: String, format: 'date-time' })
  followedAt!: Date
}

export class FollowedAuctionResponseDto extends WatchlistResponseDto {
  @ApiProperty({ type: AuctionResponseDto })
  auction!: AuctionResponseDto
}

export class FollowedAuctionsResponseDto {
  @ApiProperty({ type: [FollowedAuctionResponseDto] })
  items!: FollowedAuctionResponseDto[]
}

/** Rechaza selectores ocultos en query o cuerpos donde el contrato exige ausencia. */
export const assertEmptyWatchlistInput = (value: unknown): void => {
  if (value === undefined) return
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
    return
  throw new BadRequestException({
    statusCode: 400,
    code: 'INVALID_REQUEST',
    message: 'Esta operacion no admite esos parametros.',
  })
}
