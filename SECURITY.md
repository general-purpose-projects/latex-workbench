# Seguridad

## Compilación de proyectos

Los documentos LaTeX y sus dependencias pueden contener instrucciones que ejecuten programas externos. `shell-escape` está desactivado de forma predeterminada y solo debe habilitarse para proyectos de confianza. La compilación se ejecuta con aislamiento local: Linux requiere `bubblewrap` y macOS usa `sandbox-exec`; el proyecto se monta como solo lectura, la caché de compilación es escribible, se bloquea la red y se elimina del proceso de compilación el resto de las variables heredadas del entorno. Si el aislamiento no está disponible, la compilación falla de forma cerrada. En Windows la compilación permanece bloqueada hasta que exista un sandbox compatible.

El aislamiento reduce el acceso del proceso, pero no sustituye las actualizaciones del sistema operativo ni protege frente a fallos del kernel o del propio sandbox. El terminal integrado y las acciones Git son procesos locales iniciados por el usuario y no usan el sandbox de compilación. No abras proyectos no confiables en la terminal ni habilites `shell-escape` para ellos.

## Reportar vulnerabilidades

No publiques vulnerabilidades explotables como issues. Usa el canal privado de reportes de seguridad de GitHub para este repositorio.
