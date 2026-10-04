import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, MaxLength } from 'class-validator'

/**
 * Parametros comunes del contrato `hu-91.v1` (§4). Solo se valida que sean
 * texto: el formato ISO-8601 con zona, el orden y el maximo de dias los decide
 * `resolveMetricsPeriod`, para responder con los codigos del contrato
 * (`INVALID_PERIOD` / `INVALID_PARAMETER`) y no con el generico del pipe.
 */
export class AuctionMetricsPeriodQueryDto {
  @ApiPropertyOptional({
    description: 'Inicio inclusivo, ISO-8601 con zona. Defecto: to - 30 dias.',
    example: '2026-09-04T00:00:00.000Z',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  from?: string

  @ApiPropertyOptional({
    description: 'Fin exclusivo, ISO-8601 con zona. Defecto: ahora. Maximo 366 dias de periodo.',
    example: '2026-10-04T00:00:00.000Z',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  to?: string
}

export class ClosingTimeAndTrendsQueryDto extends AuctionMetricsPeriodQueryDto {
  @ApiPropertyOptional({
    enum: ['DAY', 'WEEK', 'MONTH'],
    default: 'DAY',
    description: 'Granularidad UTC de la serie. DAY admite como maximo 92 dias.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  granularity?: string
}
