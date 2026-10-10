import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, MaxLength } from 'class-validator'

/**
 * Parametros del consolidado `GET /v1/admin/auction-metrics/summary` (contrato `hu-91.v1` §4.6).
 *
 * DTO PROPIO: no extiende ni toca los de los cinco endpoints existentes. Solo se valida que
 * sean texto; el formato ISO-8601, el orden, el rango de `limit` y `granularity` los decide el
 * caso de uso, para responder con los codigos del contrato (`INVALID_PERIOD` /
 * `INVALID_PARAMETER`) y no con el generico del pipe.
 */
export class MetricsSummaryQueryDto {
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

  @ApiPropertyOptional({
    default: 10,
    minimum: 1,
    maximum: 50,
    description: 'Filas de rankings y usuarios (1-50). Se valida en el caso de uso.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  limit?: string

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
