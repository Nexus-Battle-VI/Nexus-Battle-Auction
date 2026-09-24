import {
  AuctionPendingClaim,
  AuctionPendingClaimRuleCode,
  AuctionPendingClaimStatus,
  CLAIM_PERIOD_MS,
} from '../../src/domain/entities/AuctionPendingClaim'

const settledAt = new Date('2026-10-01T12:00:00.000Z')

const input = (overrides: Partial<Parameters<typeof AuctionPendingClaim.create>[0]> = {}) => ({
  auctionId: 'auction-1',
  winnerId: 'winner-1',
  productId: 'product-1',
  winningBidId: 'bid-1',
  finalAmountCredits: 30,
  settledAt,
  createdAt: new Date('2026-10-01T12:01:00.000Z'),
  ...overrides,
})

const at = (offsetMs: number): Date => new Date(settledAt.getTime() + offsetMs)

describe('AuctionPendingClaim', () => {
  it('crea un pendiente PENDING con el plazo exacto de siete dias', () => {
    const claim = AuctionPendingClaim.create(input())

    expect(claim.snapshot()).toMatchObject({
      claimStatus: AuctionPendingClaimStatus.Pending,
      claimedAt: null,
      claimDeadline: at(CLAIM_PERIOD_MS),
    })
  })

  it('permite reclamar durante el dia 1', () => {
    const claim = AuctionPendingClaim.create(input())

    expect(claim.claim(at(24 * 60 * 60 * 1000))).toMatchObject({
      claimStatus: AuctionPendingClaimStatus.Claimed,
      claimedAt: at(24 * 60 * 60 * 1000),
    })
  })

  it('permite reclamar exactamente en el limite del dia 7', () => {
    const claim = AuctionPendingClaim.create(input())

    expect(claim.claim(at(CLAIM_PERIOD_MS))).toMatchObject({
      claimStatus: AuctionPendingClaimStatus.Claimed,
      claimedAt: at(CLAIM_PERIOD_MS),
    })
  })

  it('permite reclamar un milisegundo antes del limite', () => {
    const claim = AuctionPendingClaim.create(input())

    expect(claim.claim(at(CLAIM_PERIOD_MS - 1))).toMatchObject({
      claimStatus: AuctionPendingClaimStatus.Claimed,
    })
  })

  it('rechaza reclamar un milisegundo despues del limite', () => {
    const claim = AuctionPendingClaim.create(input())

    expect(() => claim.claim(at(CLAIM_PERIOD_MS + 1))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.ClaimDeadlineExpired }),
    )
    expect(claim.snapshot().claimStatus).toBe(AuctionPendingClaimStatus.Pending)
  })

  it('impide un segundo reclamo despues de CLAIMED', () => {
    const claim = AuctionPendingClaim.create(input())
    claim.claim(at(1_000))

    expect(() => claim.claim(at(2_000))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.AlreadyClaimed }),
    )
  })

  it('impide reclamar un producto EXPIRED', () => {
    const claim = AuctionPendingClaim.create(input())
    claim.expire(at(CLAIM_PERIOD_MS + 1))

    expect(() => claim.claim(at(CLAIM_PERIOD_MS + 2))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.AlreadyExpired }),
    )
  })

  it('no permite expirar exactamente en el limite', () => {
    const claim = AuctionPendingClaim.create(input())

    expect(() => claim.expire(at(CLAIM_PERIOD_MS))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.ClaimPeriodStillOpen }),
    )
    expect(claim.snapshot().claimStatus).toBe(AuctionPendingClaimStatus.Pending)
  })

  it('transiciona PENDING a EXPIRED despues del limite', () => {
    const claim = AuctionPendingClaim.create(input())

    expect(claim.expire(at(CLAIM_PERIOD_MS + 1))).toMatchObject({
      claimStatus: AuctionPendingClaimStatus.Expired,
      claimedAt: null,
    })
  })

  it('impide reactivar un producto EXPIRED', () => {
    const claim = AuctionPendingClaim.create(input())
    claim.expire(at(CLAIM_PERIOD_MS + 1))

    expect(() => claim.expire(at(CLAIM_PERIOD_MS + 2))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.AlreadyExpired }),
    )
  })

  it.each([
    ['auctionId', { auctionId: ' ' }],
    ['winnerId', { winnerId: '' }],
    ['productId', { productId: '!' }],
    ['winningBidId', { winningBidId: ' ' }],
  ])('valida el identificador requerido %s', (_label, override) => {
    expect(() => AuctionPendingClaim.create(input(override))).toThrow()
  })

  it('valida fechas invalidas de creacion y transicion', () => {
    expect(() => AuctionPendingClaim.create(input({ settledAt: new Date('invalid') }))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.InvalidSettledAt }),
    )
    expect(() => AuctionPendingClaim.create(input({ createdAt: new Date('invalid') }))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.InvalidCreatedAt }),
    )

    const claim = AuctionPendingClaim.create(input())
    expect(() => claim.claim(new Date('invalid'))).toThrow(
      expect.objectContaining({ code: AuctionPendingClaimRuleCode.InvalidTransitionDate }),
    )
  })

  it('aplica copias defensivas a las fechas de entrada y del snapshot', () => {
    const createdAt = new Date('2026-10-01T12:01:00.000Z')
    const claim = AuctionPendingClaim.create(input({ createdAt }))
    const first = claim.snapshot()

    createdAt.setUTCFullYear(2030)
    first.settledAt.setUTCFullYear(2030)
    first.createdAt.setUTCFullYear(2030)
    first.claimDeadline.setUTCFullYear(2030)

    expect(claim.snapshot()).toMatchObject({
      settledAt,
      createdAt: new Date('2026-10-01T12:01:00.000Z'),
      claimDeadline: at(CLAIM_PERIOD_MS),
    })
  })

  it('mantiene un snapshot consistente y no contiene operaciones de creditos', () => {
    const claim = AuctionPendingClaim.create(input())
    const before = claim.snapshot()
    const after = claim.claim(at(CLAIM_PERIOD_MS))

    expect(before).toMatchObject({
      auctionId: 'auction-1',
      winnerId: 'winner-1',
      productId: 'product-1',
      winningBidId: 'bid-1',
      finalAmountCredits: 30,
      claimStatus: AuctionPendingClaimStatus.Pending,
    })
    expect(after).toMatchObject({ claimStatus: AuctionPendingClaimStatus.Claimed })
    expect(Object.keys(after)).not.toEqual(expect.arrayContaining(['creditOperationId']))
  })
})
