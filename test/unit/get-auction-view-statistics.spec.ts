import { GetMyAuctionViewStatistics } from '../../src/application/use-cases/GetMyAuctionViewStatistics'

describe('GetMyAuctionViewStatistics', () => {
  it('comunica ausencia de fuente autoritativa sin inventar contadores', () => {
    expect(new GetMyAuctionViewStatistics().execute()).toEqual({
      availability: 'UNAVAILABLE',
      reason: 'AUTHORITATIVE_SOURCE_NOT_CONFIGURED',
      metrics: [],
    })
  })
})
