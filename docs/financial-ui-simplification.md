# Simplificación de facturación y pagos

La interfaz financiera usa divulgación progresiva sin cambiar la lógica de negocio.

- La tarjeta de Facturación muestra primero `Cargar factura` y un historial plegado.
- La tarjeta de Pagos muestra primero `Informar pago` y un menú con transferencia, efectivo, eCheq y otro.
- Los formularios existentes se reutilizan y conservan sus IDs, validaciones y endpoints.
- eCheq se integra al flujo de pagos y su tarjeta separada queda absorbida.
- Si el feature flag de eCheq está apagado, su opción y su historial no se muestran.
