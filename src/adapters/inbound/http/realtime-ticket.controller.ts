import { Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger'

import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import type { IssueRealtimeTicket } from '../../../application/use-cases/RealtimeTickets'
import { ISSUE_REALTIME_TICKET } from '../ws/realtime.tokens'
import { CurrentIdentity, Roles } from './auth/decorators'

class RealtimeTicketResponse {
  @ApiProperty({
    description: 'Ticket opaco de un solo uso. Se envia como primer mensaje del WebSocket.',
  })
  readonly ticket!: string

  @ApiProperty({ example: 30 })
  readonly expiresInSeconds!: number
}

/**
 * Ticket de un solo uso para abrir el WebSocket de Subasta (EN-034, ADR-024).
 *
 * Un navegador no puede fijar `Authorization` al abrir un WebSocket y poner el JWT en la URL lo
 * dejaria en los registros del proxy. Aqui se verifica el testimonio como en cualquier ruta
 * (guard global), se exige el mismo rol que las lecturas de Subasta y se devuelve un ticket
 * opaco, ligado al `sub`, de un solo uso y con caducidad de 30 segundos. No acepta cuerpo:
 * nadie puede pedir un ticket para otro jugador.
 *
 * Solo se registra cuando `AUCTION_REALTIME_ENABLED=true`.
 */
@ApiTags('realtime')
@ApiBearerAuth()
@Controller('v1/auctions/realtime')
export class RealtimeTicketController {
  constructor(@Inject(ISSUE_REALTIME_TICKET) private readonly issueTicket: IssueRealtimeTicket) {}

  @Post('tickets')
  @Roles(Role.Player, Role.GameMaster)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emite un ticket de un solo uso para el WebSocket (ADR-024)' })
  @ApiResponse({ status: 201, type: RealtimeTicketResponse })
  @ApiResponse({ status: 401, description: 'Falta el testimonio o no es valido' })
  @ApiResponse({ status: 403, description: 'La identidad no posee el rol requerido' })
  issue(@CurrentIdentity() identity: VerifiedIdentity): {
    readonly ticket: string
    readonly expiresInSeconds: number
  } {
    return this.issueTicket.execute(identity.subject)
  }
}
