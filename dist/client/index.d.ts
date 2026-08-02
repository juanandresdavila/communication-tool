import type { Channel, IncomingMessage, Messaging, OutgoingMessage } from './types.js';
export type { Channel, IncomingMessage, Messaging, OutgoingMessage };
export { firmaValida, headerDeFirma } from './signature.js';
export interface CommToolConfig {
    /** Sin barra final, por ejemplo `https://communication-tool-beta.vercel.app`. */
    baseUrl: string;
    /** La API key de la app. Va en el header, nunca en la URL. */
    apiKey: string;
    /** El secreto con el que comm-tool firma las entregas hacia esta app. */
    deliverySecret: string;
    /** Inyectable para que los tests no toquen la red. */
    fetchFn?: typeof fetch;
    now?: () => Date;
}
export declare function createCommToolMessaging(config: CommToolConfig): Messaging;
