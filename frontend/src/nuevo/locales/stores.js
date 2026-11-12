import { GROUPS } from '../resumen/ChannelsCard.jsx';

// The three stores, with their channel colors, in the report's order.
export const STORES = GROUPS.filter(g => ['lomas', 'belgrano', 'alcorta'].includes(g.id));
