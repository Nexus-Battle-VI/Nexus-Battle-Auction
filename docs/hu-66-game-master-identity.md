# Identidad del Maestro de Juego — HU-66.1

## Decisión

UPB-COMPANY se autoriza únicamente cuando el access token verificado cumple simultáneamente estas condiciones:

1. contiene el grupo `GAME_MASTER`;
2. su claim inmutable `sub` coincide con `GAME_MASTER_SUBJECT` configurado en Auction.

El correo, nombre mostrado y cualquier valor del cuerpo HTTP no participan en la autorización. `ADMINISTRATOR` y `SUPER_ADMINISTRATOR` no heredan `GAME_MASTER`, ni este último hereda permisos administrativos.

## Propiedad y aprovisionamiento

Account incorpora `GAME_MASTER` a su vocabulario y persistencia para continuar siendo la fuente de verdad de roles. El endpoint de gestión de roles lo rechaza deliberadamente: la identidad especial debe aprovisionarse mediante el procedimiento operativo controlado y reflejarse en el grupo homónimo de Cognito.

La cuenta exige segundo factor mediante aplicación autenticadora, igual que las identidades privilegiadas existentes. El rol y el `sub` deben configurarse antes de habilitar una ruta de publicación oficial.

## Denegación por defecto

- Sin `GAME_MASTER_SUBJECT`, una ruta que exija `GAME_MASTER` responde 403 incluso ante un token con ese grupo.
- Un token con el grupo correcto y otro `sub` responde 403.
- El `sub` correcto sin el grupo responde 403.
- Los grupos desconocidos se descartan durante la verificación del token.
- Producción continúa prohibiendo `AUTH_MODE=disabled`.

Esta doble condición limita el impacto de una asignación accidental del grupo y evita convertir un rol administrativo general en autoridad comercial.

## Despliegue

1. Aplicar la migración de Account `z20260921-hu66-game-master-role`.
2. Aprovisionar o identificar la cuenta canónica de UPB-COMPANY.
3. Persistir y reflejar `GAME_MASTER` mediante el procedimiento controlado.
4. Configurar en Auction `GAME_MASTER_SUBJECT` con el `sub` canónico.
5. Verificar MFA y emitir un token nuevo que contenga el grupo.

La publicación oficial, sus precios y su endpoint se implementan en Tasks posteriores; esta decisión solo establece la frontera de identidad y autorización.
