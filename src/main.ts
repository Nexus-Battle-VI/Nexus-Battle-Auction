import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

import { createValidationPipe } from './adapters/inbound/http/validation.pipe'
import { AppModule } from './infrastructure/bootstrap/app.module'
import { loadConfig } from './infrastructure/config/env'
import { createLogger } from './infrastructure/observability/logger'

const bootstrap = async (): Promise<void> => {
  const config = loadConfig(process.env)
  const logger = createLogger({
    level: config.logLevel,
    service: config.serviceName,
    version: config.version,
  })

  const app = await NestFactory.create(AppModule, { logger: false })

  app.setGlobalPrefix(config.globalPrefix)

  // Rechaza campos desconocidos y devuelve un contrato de error estable.
  app.useGlobalPipes(createValidationPipe())

  app.enableShutdownHooks()

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Nexus Battles VI — Auction')
        .setDescription('API del bounded context Auction.')
        .setVersion(config.version)
        // Los contratos protegidos, incluida watchlist, referencian este esquema JWT.
        .addBearerAuth()
        .build(),
    )

    SwaggerModule.setup(`${config.globalPrefix}/docs`, app, document)
  }

  await app.listen(config.port)

  logger.info('service_started', {
    port: config.port,
    globalPrefix: config.globalPrefix,
    persistenceDriver: config.persistenceDriver,
    authMode: config.authMode,
    swagger: config.swaggerEnabled,
  })
}

void bootstrap()
