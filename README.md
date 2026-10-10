# Latex Workbench

Aplicación de escritorio local para editar, compilar y exportar proyectos LaTeX generales. La interfaz sigue el flujo de tres paneles de Overleaf, pero trabaja directamente sobre carpetas y repositorios Git.

## Estado

La versión `0.1.0` es un MVP funcional. Incluye:

- detección de documentos raíz mediante `\\documentclass`;
- edición LaTeX con la gramática de CodeMirror basada en Overleaf;
- LuaLaTeX, XeLaTeX, pdfLaTeX, Latexmk y Tectonic cuando estén instalados;
- perfiles rápidos `Preview` y completos `Release`;
- caché BLAKE3 de compilaciones sin cambios;
- paneles redimensionables y árbol de archivos plegable con scroll;
- visor PDF propio de alta densidad con navegación, zoom que conserva la página, ajuste al ancho y ajuste al alto;
- previsualización de PNG, JPEG, GIF, WebP y SVG, e inserción sin recomprimir el archivo original;
- iconos por tipo de archivo, esquema de secciones navegable y miga de pan;
- terminal PTY integrada, abierta en la raíz del proyecto, para usar Git y otras herramientas;
- Git status, fetch, pull y push;
- exportación del PDF y del código fuente en ZIP, con Descargas como destino predeterminado;
- `shell-escape` desactivado por defecto.

## Desarrollo

Requisitos: Node.js, pnpm, Rust estable y al menos un compilador LaTeX.

```bash
pnpm install
pnpm tauri dev
```

Generar la aplicación:

```bash
pnpm tauri build
```

El producto no impone estructura a los proyectos del usuario. Una carpeta puede contener uno o varios documentos raíz y cualquier organización de archivos válida para LaTeX.

## Rendimiento

Los resultados se guardan en `.latex-workbench/preview` y `.latex-workbench/release` dentro del proyecto abierto. La huella de compilación incluye contenidos, motor, perfil y configuración de seguridad. Si nada cambió, el PDF se recupera sin iniciar TeX.

## Seguridad

`shell-escape` permite a documentos LaTeX ejecutar programas externos. Sólo debe activarse en repositorios de confianza. Una futura versión incorporará aislamiento adicional para documentos no confiables.

La carpeta `svg-inkscape` es un resultado temporal generado por el paquete `svg` cuando usa Inkscape para convertir un SVG a un formato que LaTeX pueda incluir. Latex Workbench la oculta del árbol y del ZIP de fuentes porque puede regenerarse; los SVG originales permanecen visibles y no se modifican.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
