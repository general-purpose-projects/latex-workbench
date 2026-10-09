# Seguridad

## Documentos no confiables

Los proyectos LaTeX pueden ejecutar herramientas externas cuando `shell-escape` está habilitado. Esta opción permanece desactivada por defecto. No la actives para repositorios que no controles.

## Reportes

No publiques vulnerabilidades explotables como issues. Usa el canal privado de reportes de seguridad de GitHub cuando el repositorio remoto esté configurado.

## Alcance del MVP

La versión 0.1 ejecuta compiladores con los permisos del usuario local. El aislamiento fuerte para compilación remota o multiusuario todavía no forma parte de esta versión.
