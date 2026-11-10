import { getStore } from '@netlify/blobs';
import { makeHandler } from '../lib/handler.mjs';

export default async (req) => {
  const store = getStore({ name: 'mel-v-russ', consistency: 'strong' });
  return makeHandler(store)(req);
};

export const config = { path: '/api/game' };
