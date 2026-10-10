/** Tokens de inyeccion del WebSocket de Subasta (EN-034). */
export const CONSUME_REALTIME_TICKET = Symbol('ConsumeRealtimeTicket')
export const ISSUE_REALTIME_TICKET = Symbol('IssueRealtimeTicket')
export const AUCTION_REALTIME_HUB = Symbol('AuctionRealtimeHub')
export const REALTIME_GATEWAY_LOGGER = Symbol('RealtimeGatewayLogger')
/** Opcional: sin proveedor se usan los valores del contrato (5 s de autenticacion, latido de 25 s). */
export const REALTIME_GATEWAY_OPTIONS = Symbol('AuctionRealtimeGatewayOptions')
