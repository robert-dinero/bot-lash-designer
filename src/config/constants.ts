/** Maca padrão usada por toda a v1 — schema multi-maca existe mas v1 opera com uma só. */
export const DEFAULT_CHAIR_ID = 1;

/** Nome físico da coluna de estado da sessão (legado: chamada cart_json desde o protótipo food-delivery). */
export const STATE_JSON_COLUMN = 'cart_json';

/** TTL em dias para limpeza automática da tabela processed_messages. */
export const PROCESSED_MESSAGES_TTL_DAYS = 7;
