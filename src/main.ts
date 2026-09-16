import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

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

  app.useGlobalPipes(
    new ValidationPipe({
      // Se descartan las propiedades no declaradas y se rechaza la peticion si
      // llegan campos desconocidos: evita que un cliente fije datos que el
      // contrato no contempla, como un importe o un propietario.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  app.enableShutdownHooks()

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Nexus Battles VI — Auction')
        .setDescription('API del bounded context Auction.')
        .setVersion(config.version)
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
