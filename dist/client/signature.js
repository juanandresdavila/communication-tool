import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
/** Ventana anti-replay, en segundos, hacia adelante y hacia atrás. */
export const VENTANA_SEGUNDOS = 300;
/**
 * El timestamp entra en el material firmado, no solo en el header: si se
 * firmara únicamente el cuerpo, una firma capturada serviría para siempre
 * cambiándole el `t=`.
 */
export function headerDeFirma(secreto, cuerpo, timestampSegundos) {
    const hmac = createHmac('sha256', secreto)
        .update(`${timestampSegundos}.${cuerpo}`)
        .digest('hex');
    return `t=${timestampSegundos},v1=${hmac}`;
}
function parsearHeader(header) {
    const partes = new Map(header.split(',').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }));
    const t = Number(partes.get('t'));
    const v1 = partes.get('v1');
    if (!Number.isFinite(t) || !v1)
        return null;
    return { t, v1 };
}
export function firmaValida(secreto, cuerpo, header, ahoraMs) {
    const parseado = parsearHeader(header);
    if (!parseado)
        return false;
    const deriva = Math.abs(Math.floor(ahoraMs / 1000) - parseado.t);
    if (deriva > VENTANA_SEGUNDOS)
        return false;
    const esperado = createHmac('sha256', secreto)
        .update(`${parseado.t}.${cuerpo}`)
        .digest('hex');
    const a = Buffer.from(esperado, 'utf8');
    const b = Buffer.from(parseado.v1, 'utf8');
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
