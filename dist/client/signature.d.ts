/** Ventana anti-replay, en segundos, hacia adelante y hacia atrás. */
export declare const VENTANA_SEGUNDOS = 300;
/**
 * El timestamp entra en el material firmado, no solo en el header: si se
 * firmara únicamente el cuerpo, una firma capturada serviría para siempre
 * cambiándole el `t=`.
 */
export declare function headerDeFirma(secreto: string, cuerpo: string, timestampSegundos: number): string;
export declare function firmaValida(secreto: string, cuerpo: string, header: string, ahoraMs: number): boolean;
