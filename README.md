# Auralis Iris · BETA

Escáner de documentos de la familia [Auralis](https://github.com/OscarD0823/auralis). Toma fotos con el celular o el PC, corrige el papel y reúne las páginas en un PDF liviano.

- [Abrir en el navegador](https://oscard0823.github.io/auralis-iris/)
- [Descargar la beta para Android](https://github.com/OscarD0823/auralis-iris/releases/tag/v0.1.0-beta.5)
- [Descargar la beta portable para Windows x64](https://github.com/OscarD0823/auralis-iris/releases/tag/v0.1.0-beta.4)

La APK requiere Android 8 o posterior y Android System WebView actualizado. Incluye el escáner y una biblioteca propia que puedes usar sin conexión. El botón **Descargar** abre el selector de archivos de Android. **Compartir archivo** abre el menú de compartir del sistema.

## Escanear y volver a usar un documento

1. Abre Iris y elige **Tomar foto** o **Importar fotos**. Al identificar las cuatro esquinas, Iris recorta la hoja y corrige la perspectiva para la miniatura y las descargas. La biblioteca guarda la foto completa para que puedas ajustar el recorte.
2. Pulsa una página para girarla, mover sus esquinas o elegir su acabado. **Detectar bordes** repite la búsqueda y **Marco completo** recupera todo el encuadre. Para hojas de texto impreso, **Blanco y negro** separa la tinta del papel y guarda la imagen con un bit por píxel.
3. Ordena las páginas y elige **Ligero**, **Equilibrado** o **Nítido**. **Generar PDF** muestra el avance y el tamaño final. Puedes cancelar la exportación y conservar el documento editable.
4. Abre el documento desde **Biblioteca** para agregar páginas, cambiar los ajustes o volver a descargar el PDF. Si cambias el documento, la biblioteca conserva el PDF anterior hasta que lo actualices.

La optimización ajusta la resolución y la compresión de cada foto antes de incluirla en el PDF. Las páginas conservan sus proporciones y se colocan en A4 vertical u horizontal. Se admiten hasta 60 páginas por documento y hasta 40 MB por archivo importado o enviado. La compresión se aplica a los PDF creados a partir de fotos.

## Usar el celular como cámara del PC

### Windows portable con un QR

1. Extrae el ZIP y abre `Auralis-Iris.exe`. El escáner se abre en tu navegador predeterminado. Deja abierta la ventana del programa mientras lo usas.
2. Conecta el PC y el celular a la misma red. En el PC, elige **Conectar celular → Mostrar QR de la red local**.
3. Escanea el QR con la cámara del celular y pulsa **Aceptar y vincular**. Al usar **Tomar foto y enviar**, Iris guarda una copia en el celular y agrega la página al documento abierto en el PC.
4. Para enviar el PDF en cualquier dirección, ábrelo en su biblioteca y pulsa **Enviar al otro dispositivo**.

En la APK, abre **Conectar dispositivos → Leer QR de vinculación** o pega el enlace que muestra el PC. Las páginas recibidas o tomadas desde la APK quedan en la biblioteca de Iris para Android.

La edición portable usa HTTP en la red local. Úsala en una red de confianza. Si Windows pregunta por el acceso del programa a la red, habilita la red privada. El celular debe poder llegar al PC por IPv4 en el puerto 53129. Algunas redes de invitados aíslan los equipos conectados.

### Solo con navegador o PWA

1. En el equipo que recibe, elige **Conectar celular → Crear enlace web**.
2. Abre el QR en el celular y acepta la vinculación. El celular mostrará el código de respuesta.
3. En el equipo que recibe, usa **Leer respuesta con cámara** o pega el código y pulsa **Vincular**.

Esta modalidad usa un canal WebRTC cifrado y directo, sin servidor de archivos. Ambos dispositivos deben poder comunicarse por la red local y el navegador debe permitir candidatos ICE locales. En **Instalar** están las opciones de instalación en Windows, Android, iPhone y iPad. Tras la primera carga, puedes abrir la PWA y escanear sin conexión.

### Bluetooth

**Compartir archivo** abre el menú del sistema cuando el navegador admite compartir PDF. Selecciona Bluetooth si aparece. En Windows también puedes descargar el PDF y usar el [asistente de transferencia Bluetooth](https://support.microsoft.com/en-au/windows/hardware/bluetooth/send-and-receive-files-over-bluetooth-in-windows). La cámara vinculada y la recepción automática en la biblioteca funcionan por red local.

## Biblioteca local

Cada navegador guarda sus propias páginas editables y PDF en IndexedDB. La web y el programa portable usan bibliotecas separadas.

Usa **JPG** debajo de una página para descargar esa imagen con su recorte, giro y acabado. El botón **Descargar JPG** descarga la imagen directamente en un documento de una sola página. Para varias páginas, **Descargar JPG (ZIP)** las reúne como JPG numerados. Extrae el ZIP para abrir las imágenes en tu visor de fotos o volver a agregarlas con **Importar fotos**.

GitHub aloja el código, la aplicación y las descargas del programa.

## Desarrollo

Los archivos web están en `app/` y pueden servirse directamente. La edición portable los incluye en el ejecutable y añade la vinculación por QR en la red local. Usa Go 1.24 o posterior para el servidor y PowerShell para empaquetar la descarga de Windows.

```powershell
go run . --no-browser
pwsh -File scripts/build-windows.ps1
```

El servidor local abre `http://127.0.0.1:53129/`. GitHub Actions publica `app/` en GitHub Pages al cambiar `main`.

Para compilar la APK en Windows, usa el JDK 17, la plataforma Android 36 y las Android SDK Build Tools 36. El almacén de claves debe incluir el alias `auralis-iris`. Proporciona su contraseña mediante la variable de entorno `IRIS_ANDROID_SIGNING_PASSWORD`.

```powershell
.\scripts\build-android.ps1 -JdkHome $jdk -AndroidJar $androidJar -BuildTools $buildTools -KeyStore $keyStore
```

Ejecuta `node --test` para comprobar la detección de bordes, las descargas JPG, el orden de las páginas en el ZIP y el empaquetado de imágenes en blanco y negro.

El código de Auralis Iris se publica bajo AGPL-3.0-or-later, como el resto de Auralis. Las bibliotecas incluidas conservan [sus propias licencias](THIRD-PARTY.md).
