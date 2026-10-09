# Contribuir

1. Crea una rama corta desde `main`.
2. Mantén los cambios enfocados y añade pruebas cuando modifiques el compilador.
3. Ejecuta `pnpm check`, `pnpm build`, `cargo fmt`, `cargo clippy` y `cargo test`.
4. Abre un pull request explicando el problema, la solución y cómo se verificó.

Los cambios de arquitectura deben incluir un ADR en `docs/adr/`. No se aceptan motores o herramientas que requieran ejecutar documentos no confiables sin límites explícitos.
