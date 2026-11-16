// Preview harness only. Never deploy: its help route uses a public test secret
// and an in-memory cap, so no production secret or KV is needed for a probe.
import worker from './src/index.js';
const counters = new Map();
export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === '/v1/help') {
      return worker.fetch(req, { ...env, CLARIFY_SECRET: 'probe-only', KV: {
        get: async (key) => counters.get(key),
        put: async (key, value) => { counters.set(key, value); },
      } });
    }
    const { model, ...input } = await req.json();
    const result = await env.AI.run(model, input);
    return new Response(input.stream ? result : JSON.stringify(result), { headers: { 'content-type': input.stream ? 'text/event-stream' : 'application/json' } });
  }
};
