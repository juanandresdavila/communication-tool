import { firmaValida } from './signature.js';
export { firmaValida, headerDeFirma } from './signature.js';
function esObjeto(v) {
    return typeof v === 'object' && v !== null;
}
export function createCommToolMessaging(config) {
    const doFetch = config.fetchFn ?? fetch;
    const now = config.now ?? (() => new Date());
    return {
        async sendMessage(msg) {
            const res = await doFetch(`${config.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    userId: msg.userId,
                    text: msg.text,
                    kind: msg.kind,
                    ...(msg.replyToMessageId
                        ? { replyToMessageId: msg.replyToMessageId }
                        : {}),
                    ...(msg.template ? { template: msg.template } : {}),
                    ...(msg.idempotencyKey
                        ? { idempotencyKey: msg.idempotencyKey }
                        : {}),
                }),
            });
            const cuerpo = (await res
                .json()
                .catch(() => null));
            if (!res.ok || !cuerpo?.providerMessageId) {
                // Nunca se incluye la request ni la clave en el error: solo el código
                // que devolvió comm-tool.
                throw new Error(`comm-tool rechazó el envío: ${cuerpo?.code ?? res.status}`);
            }
            // El id DEL PROVEEDOR, no el de comm-tool. Es el que después matchea
            // contra el `replyToMessageId` de un entrante.
            return { messageId: cuerpo.providerMessageId };
        },
        async parseIncoming(req) {
            // El cuerpo se lee como texto porque la firma es sobre los bytes
            // exactos: volver a serializar el objeto parseado cambiaría el HMAC.
            const cuerpo = await req.text();
            const firma = req.headers.get('X-Comm-Signature') ?? '';
            if (!firmaValida(config.deliverySecret, cuerpo, firma, now().getTime())) {
                return null;
            }
            const datos = JSON.parse(cuerpo);
            if (!esObjeto(datos))
                return null;
            const { messageId, userId, channel, text, receivedAt } = datos;
            if (typeof messageId !== 'string' ||
                typeof userId !== 'string' ||
                typeof channel !== 'string' ||
                typeof text !== 'string' ||
                typeof receivedAt !== 'string') {
                return null;
            }
            const replyTo = datos['replyToMessageId'];
            return {
                userId,
                text,
                channel: channel,
                messageId,
                ...(typeof replyTo === 'string' ? { replyToMessageId: replyTo } : {}),
                receivedAt,
                raw: datos['raw'],
            };
        },
    };
}
