-- Transporte interactivo: un entrante puede ser el TOQUE de un botón y no un
-- mensaje, y un saliente puede llevar botones.
--
-- Aditiva: el código anterior no ve las columnas nuevas y los defaults cubren
-- sus inserts, así que se aplica ANTES de levantar el código nuevo y el
-- rollback de la imagen no necesita revertirla.

ALTER TABLE inbound_messages
  ADD COLUMN kind text NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'callback')),
  -- Opaco para comm-tool: lo que Telegram mande, tal cual. Puede no ser el de
  -- ningún botón nuestro (la doc de CallbackQuery.data lo avisa).
  ADD COLUMN callback_data text,
  -- El id DEL PROVEEDOR del mensaje del bot que tenía el botón.
  ADD COLUMN callback_message_id text;

-- Un toque sin data o sin mensaje no se puede entregar: que la base no lo
-- acepte en vez de descubrirlo al armar la entrega.
ALTER TABLE inbound_messages
  ADD CONSTRAINT inbound_callback_completo
    CHECK (kind = 'message'
           OR (callback_data IS NOT NULL AND callback_message_id IS NOT NULL));

-- Nullable y con SQL NULL de verdad: un saliente sin botones no tiene teclado.
-- Hace falta en la FILA porque enviarSaliente manda lo que dice la fila y no
-- lo que dice el pedido: sin la columna, un reintento idempotente reenviaría
-- el mensaje sin botones.
ALTER TABLE outbound_messages
  ADD COLUMN buttons jsonb;
