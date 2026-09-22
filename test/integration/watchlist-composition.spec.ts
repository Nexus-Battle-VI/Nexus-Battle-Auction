import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { AppModule, DATABASE } from '../../src/infrastructure/bootstrap/app.module'
import { WATCHLIST_REPOSITORY } from '../../src/application/ports/WatchlistRepositoryPort'
import { InMemoryWatchlistRepository } from '../../src/adapters/outbound/persistence/InMemoryWatchlistRepository'
import { PostgresWatchlistRepository } from '../../src/adapters/outbound/persistence/PostgresWatchlistRepository'
import { createDatabase } from '../../src/infrastructure/persistence/database'

/** Comprueba la seleccion del adaptador sin duplicar la raiz de composicion. */
describe('Composicion watchlist', () => {
  it('registra memoria cuando DATABASE es null', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(null)
      .compile()
    try {
      expect(module.get(WATCHLIST_REPOSITORY)).toBeInstanceOf(InMemoryWatchlistRepository)
    } finally {
      await module.close()
    }
  })
  it('registra PostgreSQL cuando existe DATABASE', async () => {
    const db = createDatabase({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile()
    try {
      expect(module.get(WATCHLIST_REPOSITORY)).toBeInstanceOf(PostgresWatchlistRepository)
    } finally {
      await module.close()
    }
  })
})
