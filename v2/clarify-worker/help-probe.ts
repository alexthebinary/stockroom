// Run: ../node_modules/.bin/tsx help-probe.ts [raw-preview-url]
// Raw Workers AI preview setup: MODEL-CHOICE.md. No production KV or secrets.
import { writeFileSync } from 'node:fs';
import { chat, createCloudHelpModel, helpSystem, readWiki } from '../apps/api/src/ai/help.ts';
if (process.argv[2] === '--stream') {
  const started = Date.now();
  let first: string | null = null, last: string | null = null, count = 0;
  const result = await chat(createCloudHelpModel(`${process.argv[3] ?? 'http://127.0.0.1:8791'}/v1/clarify`, 'probe-only'), {
    messages: [{ role: 'user', content: 'How do I receive an item with no barcode?' }], route: '/',
  }, (event) => {
    if (event.type !== 'text') return;
    const timestamp = new Date().toISOString();
    first ??= timestamp; last = timestamp; count++;
    console.log(timestamp, `+${Date.now() - started}ms`, JSON.stringify(event.text));
  });
  console.log(JSON.stringify({ firstDelta: first, lastDelta: last, textDeltas: count, totalMs: Date.now() - started, result }));
  // This smoke checks incremental delivery; navigation reliability is measured
  // separately in the eight-question benchmark and retained in the output.
  process.exit(count > 1 && !result.unanswered ? 0 : 1);
}
const endpoint = process.argv[2] ?? 'http://127.0.0.1:8791';
let tools: unknown;
await createCloudHelpModel('http://unused', '', (async (_url, init) => {
  tools = JSON.parse(String(init?.body)).tools;
  throw new Error('capture tools only');
}) as typeof fetch)([]).catch(() => {});
const questions = [
 ['barcode', 'How do I receive a delivery using the barcode camera?', 'receive'],
 ['no-barcode', 'How do I receive an item with no barcode?', 'receive'],
 ['payment', 'How do I record a partial payment on a vendor bill?', 'payables'],
 ['credit', 'How do I return received units using a vendor credit, and where does a credit difference post?', 'bills'],
 ['opening', 'How is opening stock entered during setup, and what is the other side of the entry?', 'setup'],
 ['reports-go_to', 'Take me to Reports and tell me where I can check stock value.', 'reports'],
 ['settings', 'How do I change account assignments? Will this change existing entries?', 'settings'],
 ['off-topic', 'What is the weather in Paris tomorrow?', null],
] as const;
const results: unknown[] = [];
for (const model of ['@cf/zai-org/glm-4.7-flash', '@cf/openai/gpt-oss-20b']) {
 for (const [id, question, expectedScreen] of questions) {
  const started = Date.now();
  let first: number | null = null, last: number | null = null, content = '', buffer = '', doneEvent = false, neurons = 0;
  const decoder = new TextDecoder();
  const calls = new Map<number, {name: string; arguments: string}>();
  try {
   const response = await fetch(endpoint, { method:'POST', body:JSON.stringify({ model, messages:[{role:'system',content:helpSystem('/')},{role:'user',content:question}], tools, tool_choice:'auto', stream:true, max_completion_tokens:1200, temperature:0.2 }), signal:AbortSignal.timeout(60000) });
   if(!response.ok) throw new Error(`HTTP ${response.status}`);
   for await(const bytes of response.body!) {
    buffer += decoder.decode(bytes, {stream:true});
    let end: number;
    while((end=buffer.indexOf('\n'))>=0) {
     const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
     if(!line.startsWith('data:')) continue;
     const data=line.slice(5).trim();if(data==='[DONE]'){doneEvent=true;continue;}
     if(!data)continue;
     const event=JSON.parse(data), delta=event.choices?.[0]?.delta;
     if (event.response !== undefined) neurons = event.usage?.neurons ?? neurons;
     const text=delta?.content??event.response;
     if(text){first??=Date.now()-started;last=Date.now()-started;content+=text;}
     for(const [i,call] of (delta?.tool_calls??event.tool_calls??[]).entries()) {
      const index=call.index??i, fn=call.function??call, previous=calls.get(index)??{name:'',arguments:''};
      previous.name+=fn.name??'';previous.arguments+=typeof fn.arguments==='string'?fn.arguments:JSON.stringify(fn.arguments??{});calls.set(index,previous);
     }
    }
   }
   const row={model,id,question,expectedScreen,firstTextMs:first,lastTextMs:last,totalMs:Date.now()-started,done:doneEvent,calls:[...calls.values()],content,neurons};
   results.push(row);console.log(JSON.stringify(row));
  } catch(error) { const row={model,id,error:String(error),totalMs:Date.now()-started};results.push(row);console.log(JSON.stringify(row)); }
  writeFileSync(new URL('./help-probe-results.json',import.meta.url), JSON.stringify(results,null,2));
 }
}

// Resume tool-only first turns without repeating the initial generation. Timings
// add active inference durations; scheduling delay between turns is excluded.
for (const row of results as { model: string; question: string; calls: {name: string; arguments: string}[]; content: string; totalMs: number; firstTextMs: number | null; lastTextMs: number | null }[]) {
  if (row.content || !row.calls?.some((call) => call.name === "read_wiki")) continue;
  const started = Date.now();
  let first: number | null = null, last: number | null = null;
  const model = createCloudHelpModel("http://probe/v1/clarify", "", (async (_url, init) => fetch(endpoint, {
    ...init, body: JSON.stringify({ ...JSON.parse(String(init?.body)), model: row.model }),
  })) as typeof fetch);
  const toolCalls = row.calls.map((call, i) => ({ id: `call_${i}`, type: "function" as const, function: call }));
  const message = await model([
    { role: "system", content: helpSystem("/") }, { role: "user", content: row.question },
    { role: "assistant", content: "", tool_calls: toolCalls },
    ...toolCalls.map((call) => {
      const page = JSON.parse(call.function.arguments).page as string;
      return { role: "tool" as const, tool_call_id: call.id, content: JSON.stringify({ page, text: readWiki(page) }) };
    }),
  ], () => { first ??= Date.now() - started; last = Date.now() - started; });
  Object.assign(row, { firstTurnMs: row.totalMs, followupToolChoice: "none" });
  row.firstTextMs = first === null ? null : row.totalMs + first;
  row.lastTextMs = last === null ? null : row.totalMs + last;
  row.totalMs += Date.now() - started;
  row.content = message.content ?? "";
  console.log(JSON.stringify(row));
  writeFileSync(new URL('./help-probe-results.json', import.meta.url), JSON.stringify(results, null, 2));
}
