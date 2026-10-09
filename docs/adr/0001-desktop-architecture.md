# ADR 0001: arquitectura local de escritorio

## Estado

Aceptada.

## Decisión

La aplicación usa Tauri 2, React/TypeScript y un backend Rust. Los proyectos permanecen en el sistema de archivos del usuario. Los motores TeX se ejecutan mediante adaptadores y conservan los archivos intermedios para reducir trabajo repetido.

La aplicación no implementa un nuevo dialecto TeX. Optimiza la coordinación de motores compatibles y mantiene una salida reproducible por perfil.

## Consecuencias

- El MVP no requiere servidor, MongoDB, Redis ni Docker.
- La compatibilidad depende de los motores instalados.
- Los proyectos arbitrarios siguen funcionando sin adoptar un manifiesto propio.
- La colaboración en tiempo real queda fuera del MVP y podrá añadirse sin sustituir el núcleo de compilación.
