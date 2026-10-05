/**
 * HU-90, CA-05. Unico `reasonCode` de Account que dispara la cancelacion
 * automatica de subastas. Se declara aqui solo el contrato externo que
 * Auction necesita: el modelo de sanciones sigue perteneciendo a Account.
 */
export const AUCTION_TERMS_VIOLATION_REASON_CODE = 'AUCTION_TERMS_VIOLATION' as const

/** Tipos de sancion que Account devuelve como restriccion activa. */
export type ActiveSanctionType = 'PERMANENT_BAN' | 'TEMPORARY_SUSPENSION'

export interface ActiveSanction {
  readonly id: string
  readonly type: ActiveSanctionType
  /** Texto libre a proposito: un codigo que Auction no conoce no dispara nada. */
  readonly reasonCode: string
  /** Fin de una suspension temporal; `null` en un veto permanente. */
  readonly expiresAt: Date | null
}

export interface ActiveSanctionStatus {
  readonly hasActiveSanctions: boolean
  /**
   * Orden autoritativo de Account (la mas reciente primero). Puede venir
   * vacia aunque `hasActiveSanctions` sea cierto (cuenta BANNED legada).
   */
  readonly sanctions: readonly ActiveSanction[]
}

/** HU-62. Lo unico que necesita la publicacion: si el vendedor esta bloqueado. */
export interface SellerSanctionPort {
  hasActiveSanctions(sellerId: string): Promise<boolean>
}

/**
 * HU-90, CA-05. Puerto aparte de `SellerSanctionPort` para que la publicacion
 * siga dependiendo solo del booleano; el mismo cliente de Account implementa
 * los dos sobre el mismo endpoint.
 */
export interface SellerActiveSanctionsPort {
  /**
   * Detalle de las sanciones activas del sujeto. A diferencia de
   * `hasActiveSanctions`, un sujeto que Account no reconoce (404) NO se trata
   * como sancionado: lanza `ExternalResourceNotFoundError`, porque no poder
   * confirmar una sancion nunca debe cancelar una subasta.
   */
  getActiveSanctions(subject: string): Promise<ActiveSanctionStatus>
}

/**
 * Primera sancion activa con AUCTION_TERMS_VIOLATION en el orden que devolvio
 * Account, o `null`. Es el disparador determinista de CA-05: aunque haya
 * varias, una subasta se cancela una sola vez.
 */
export const findAuctionTermsViolation = (status: ActiveSanctionStatus): ActiveSanction | null =>
  status.sanctions.find(
    (sanction) => sanction.reasonCode === AUCTION_TERMS_VIOLATION_REASON_CODE,
  ) ?? null

export const SELLER_SANCTIONS = Symbol('SellerSanctionPort')
