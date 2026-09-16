<!--
Título del Pull Request (convención obligatoria):
  feat(auction): [HU-NN] descripcion en infinitivo
  fix(auction): [BUG-NN] descripcion en infinitivo

Tipos permitidos: feat, fix, docs, test, refactor, chore, ci, build
Destino: `develop`. A `main` solo llega la promoción completa de `develop`.
-->

## Trazabilidad

Management Issue:

```text
Refs Nexus-Battle-VI/Nexus-Battle-Management#NUMERO
```

- **Tipo:** HU / EN / BUG / CHORE
- **Team:** Team Alfa / Team Beta / Team Gama
- **Bounded context:** Auction

> Se utiliza siempre el nombre completo del repositorio. Desde otro repositorio no se usa `#NUMERO`, porque apuntaría a una Issue local inexistente o equivocada.
>
> `Closes` solo se emplea cuando el Pull Request completa totalmente una Task, un Bug o una Task subordinada de un Enabler. **Un Pull Request no cierra la User Story padre.**

## Resumen

<!-- Qué se entrega, en una o dos frases. -->

## Contexto y alcance

<!-- Problema que se resuelve, decisiones tomadas y qué queda expresamente fuera. -->

## Criterios de aceptación cubiertos

- [ ]

## Pruebas

- [ ] Pruebas unitarias
- [ ] Pruebas de integración HTTP
- [ ] Pruebas contra PostgreSQL real (`npm run test:db`)
- [ ] Cada afirmación importante tiene un control: un caso que fallaría si fuera falsa

## Contratos

- [ ] No cambia ningún contrato público ni interno
- [ ] Cambia un contrato y está actualizado en `Nexus-Battle-Infrastructure/docs/contracts`
