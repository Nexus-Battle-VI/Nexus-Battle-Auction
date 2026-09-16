import { SystemClock } from '../../src/adapters/outbound/system/SystemClock'
import { DomainError } from '../../src/domain/errors/DomainError'
import { buildLiveness, buildReadiness, buildVersion } from '../../src/infrastructure/health/health'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import { createLogger } from '../../src/infrastructure/observability/logger'

describe('Sondas de salud', () => {
  it('liveness no consulta dependencias', () => {
    expect(buildLiveness()).toEqual({ status: 'ok', checks: {} })
  })

  it('readiness sin dependencias esta lista', async () => {
    await expect(buildReadiness([])).resolves.toEqual({ status: 'ok', checks: {} })
  })

  it('readiness espera las comprobaciones asincronas', async () => {
    const report = await buildReadiness([
      { name: 'sincrona', check: () => true },
      { name: 'asincrona', check: () => Promise.resolve(true) },
    ])

    expect(report).toEqual({ status: 'ok', checks: { sincrona: 'ok', asincrona: 'ok' } })
  })

  /**
   * Una comprobacion que lanza o rechaza cuenta como fallo, nunca como exito.
   * El control es la prueba anterior: con comprobaciones sanas si responde ok.
   */
  it.each([
    ['devuelve false', () => false],
    [
      'lanza',
      (): boolean => {
        throw new Error('motor caido')
      },
    ],
    ['rechaza', () => Promise.reject(new Error('motor caido'))],
  ])('readiness falla cuando una comprobacion %s', async (_caso, check) => {
    const report = await buildReadiness([
      { name: 'sana', check: () => true },
      { name: 'rota', check },
    ])

    expect(report).toEqual({ status: 'error', checks: { sana: 'ok', rota: 'error' } })
  })

  it('version expone solo servicio, version y entorno', () => {
    expect(
      buildVersion({ service: 'nexus-battle-auction', version: '0.1.0', nodeEnv: 'test' }),
    ).toEqual({ service: 'nexus-battle-auction', version: '0.1.0', nodeEnv: 'test' })
  })
})

describe('Registro estructurado', () => {
  const at = new Date('2026-09-16T12:00:00.000Z')

  it('escribe una linea JSON con el contexto', () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'info',
      service: 'nexus-battle-auction',
      version: '0.1.0',
      sink: (line) => lines.push(line),
      clock: () => at,
    })

    logger.info('evento', { clave: 'valor' })

    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: at.toISOString(),
      level: 'info',
      service: 'nexus-battle-auction',
      version: '0.1.0',
      message: 'evento',
      clave: 'valor',
    })
  })

  it('descarta los niveles por debajo del umbral', () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'warn',
      service: 's',
      version: 'v',
      sink: (line) => lines.push(line),
    })

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      'warn',
      'error',
    ])
  })

  it('usa la salida estandar cuando no se inyecta sumidero', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    createLogger({ level: 'info', service: 's', version: 'v' }).info('hola')

    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('describeError', () => {
  it.each([
    [new Error('fallo'), 'fallo'],
    [undefined, 'undefined'],
    [null, 'null'],
    [{ codigo: 1 }, '{"codigo":1}'],
  ])('describe %p', (value, expected) => {
    expect(describeError(value)).toBe(expected)
  })

  it('no revienta con valores no serializables', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(describeError(circular)).toBe('error no serializable')
  })
})

describe('Piezas basicas', () => {
  it('SystemClock devuelve la hora actual', () => {
    const before = Date.now()
    const now = new SystemClock().now().getTime()

    expect(now).toBeGreaterThanOrEqual(before)
  })

  it('DomainError conserva nombre y mensaje', () => {
    const error = new DomainError('regla incumplida')

    expect(error.name).toBe('DomainError')
    expect(error.message).toBe('regla incumplida')
  })
})
