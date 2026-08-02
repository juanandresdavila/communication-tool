import type { Messaging } from './types.js';
/**
 * La suite de conformidad del spec, §Suite de conformidad.
 *
 * Se exporta como DATOS, no como tests: una lista de casos que cada repo
 * engancha a su propio runner. Así el paquete no depende de Vitest, y
 * GymTracker puede correrla con el suyo sin alinear versiones.
 *
 *     import { CASOS_DE_CONFORMIDAD } from 'communication-tool/conformance'
 *     for (const caso of CASOS_DE_CONFORMIDAD) {
 *       it(caso.nombre, () => caso.ejecutar(contexto))
 *     }
 */
export interface ContextoDeConformidad {
    /** La implementación bajo prueba, ya armada con sus dobles. */
    messaging: Messaging;
    /** Un request de entrada válido, que corresponde a `esperado`. */
    requestValido(): Request | Promise<Request>;
    /** El mismo request pero con la firma o el secreto mal. */
    requestInvalido(): Request | Promise<Request>;
    /** Un request válido cuyo mensaje no trae texto. */
    requestSinTexto(): Request | Promise<Request>;
    /** Lo que `parseIncoming(requestValido())` tiene que devolver. */
    esperado: {
        userId: string;
        text: string;
        messageId: string;
    };
    /** Un userId que SÍ está vinculado, y uno que no. */
    userIdVinculado: string;
    userIdSinVincular: string;
}
export interface CasoDeConformidad {
    nombre: string;
    ejecutar(ctx: ContextoDeConformidad): Promise<void>;
}
export declare const CASOS_DE_CONFORMIDAD: CasoDeConformidad[];
