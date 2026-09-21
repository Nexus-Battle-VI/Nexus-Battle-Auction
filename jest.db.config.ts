import type { Config } from 'jest'

/**
 * Pruebas que necesitan una base de datos real, en su propia configuracion.
 *
 * Levantan PostgreSQL en un contenedor con Testcontainers. Meterlas en la suite
 * por defecto obligaria a tener Docker a cualquiera que ejecute `npm test`, y
 * quien trabaja en el dominio o en los casos de uso no deberia necesitarlo.
 *
 * El CI ejecuta ambas: `npm test` y `npm run test:db`.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'db',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Patron portable: Jest mezcla separadores en Windows cuando `rootDir`
  // contiene un junction, por lo que anclarlo a `<rootDir>` oculta la suite.
  testMatch: ['**/test/db/**/*.spec.ts'],
  // Descargar y arrancar la imagen la primera vez supera el limite por defecto.
  testTimeout: 120_000,

  // Esta suite mide SU propia superficie: los adaptadores de PostgreSQL y la
  // infraestructura de persistencia, que la suite por defecto no puede ver.
  collectCoverageFrom: [
    'src/adapters/outbound/persistence/Postgres*.ts',
    'src/infrastructure/persistence/**/*.ts',
    '!src/infrastructure/persistence/migrate.ts',
  ],
  coverageDirectory: 'coverage-db',
  coverageReporters: ['text-summary'],
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
}

export default config
