import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common'

export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        statusCode: 400,
        code: 'INVALID_REQUEST',
        message: 'La solicitud no cumple el contrato.',
        errors: errors.map((error) => ({
          field: error.property,
          rules: Object.keys(error.constraints ?? {}).sort(),
        })),
      }),
  })
