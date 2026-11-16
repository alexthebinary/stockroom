# Help model measurement — 2026-11-16 UTC

Keep `@cf/zai-org/glm-4.7-flash`. GPT-OSS-20b was faster, but returned **zero
structured tool calls across all eight questions**, including the explicit
Reports navigation request. It printed `go_to: receive` and similar text instead.
GLM returned five correct `go_to` calls and two `read_wiki` calls. The latter
required a second generation with `tool_choice: none`, as in the existing API.
The clarify model and `/v1/clarify` behavior remain unchanged.

One measured run per question/model, sequential, via `wrangler dev --remote` and
its real Workers AI binding, using the API's complete `helpSystem('/')`, tools,
1200 completion-token cap and temperature 0.2. Reports doubles as the explicit
navigation question, keeping the requested coverage to eight questions. Timings
are milliseconds from fetch start, including transport and model reasoning,
excluding preview startup. Credit/opening GLM rows add the two active turn times;
they exclude scheduling delay before the resumed turn. These are observations,
not statistically stable latency estimates. Raw questions, answers and timings:
[help-probe-results.json](help-probe-results.json).

| Question | GLM first text / total ms | Wiki correct | go_to | GPT-OSS first text / total ms | Wiki correct | go_to |
|---|---:|:---:|:---:|---:|:---:|:---:|
| Receive with barcode | 4918 / 6761 | Yes | Yes | 898 / 1490 | No | No |
| Receive without barcode | 4289 / 5156 | Yes | Yes | 1559 / 2488 | No | No |
| Partial bill payment | 4899 / 6467 | No | Yes | 2380 / 3126 | Yes | No |
| Return received units / credit variance | 3394 / 5934 | Yes | No | 1866 / 3377 | Yes | No |
| Opening stock / equity | 3129 / 4204 | No | No | 3286 / 3911 | Yes | No |
| Reports stock value + take me there | 1667 / 2072 | Yes | Yes | 976 / 1187 | Yes | No |
| Settings account assignment | 3097 / 4069 | Yes | Yes | 1482 / 2119 | Yes | No |
| Off-topic weather | 3241 / 3737 | Yes | N/A | 1140 / 1230 | Yes | N/A |

Manual correctness checks use the workflow and accounting facts in
`docs/help/{receive,bills-payables,vendor-credits,getting-started,reports,settings}.md`.
Navigation is scored separately and requires an actual structured function call,
not text that resembles one. Both models got 6/8 core answers correct under this
rubric. GLM payment added an unsupported overpayment instruction; GLM opening
incorrectly began with the unknown-answer marker despite having the equity fact.
GPT-OSS barcode skipped **Open scanner**, claiming the camera opens at **Start
scanning**; its no-barcode answer invented an item-search icon and implied counted
stock is posted automatically. Other answers can still include imprecise wording
or exceed the 80-word request: this small sample does not establish perfect help
quality. GLM's credit follow-up also printed a screen key; with tools disabled,
neither credit nor opening returned navigation. These existing model/prompt
limitations were left outside the streaming change.

Median first-text / total: GLM **3317.5 / 4680 ms**, GPT-OSS **1520.5 / 2303.5 ms**.
The eight first turns reported approximately **262.0731** and **702.553843 neurons**
respectively. SSE per-delta usage plus the final usage summary duplicate the same
usage; recorded figures account for that duplication. Follow-ups, two format
smokes and the consumer smoke are additional usage. No paid external inference
API or API key was used; an actual dollar charge was not exposed by this binding.

## Observed wire format and real consumer check

Both candidates emitted `data: {"choices":[{"delta":...}]}` with text fragments;
GLM emitted `reasoning_content`/`reasoning` separately, then one complete indexed
`tool_calls` delta. Both ended with a `{response:"",usage:...}` trailer and
`data: [DONE]`. GPT-OSS's smoke printed a JSON block instead of a structured call.
The Worker forwards only content/tool-call deltas and DONE, hiding reasoning and
usage. Legacy `{response,tool_calls}` events are also normalized in tests.

Real `/v1/help` through the changed Worker in a remote preview, then through
`createCloudHelpModel` and `chat`, produced **46 text deltas**:

```text
2026-11-16T04:19:58.545Z +3755ms "When"
2026-11-16T04:19:58.566Z +3776ms " scanning"
...
2026-11-16T04:20:00.648Z +5858ms "."
{"firstDelta":"2026-11-16T04:19:58.545Z","lastDelta":"2026-11-16T04:20:00.648Z","textDeltas":46,"totalMs":6163}
```

Final result included `navigate: {to:"/receive",label:"Receive"}` and
`unanswered:false`. The API route already forwards text as NDJSON and the drawer
appends each text event to its draft; neither required edits. No deployment or
production KV mutation was performed.

A subsequent run of the saved CLI delivered 53 deltas from
`2026-11-16T04:22:43.000Z` to `2026-11-16T04:22:44.333Z`, total 20263 ms,
but omitted navigation. Its initial smoke assertion required a link and exited
1; the smoke now checks incremental delivery and a completed answer, while
retaining the navigation result for inspection. The benchmark still scores
missing links as failures. Model navigation and first-text latency remain
variable even with streaming enabled.

## Reproduce without production secrets or KV

From `v2/clarify-worker`, after installing its dev dependencies and the `v2`
workspace dependencies:

```sh
npx wrangler dev --remote --config help-probe.wrangler.toml --port 8791
# In another terminal in the same directory:
../node_modules/.bin/tsx help-probe.ts
../node_modules/.bin/tsx help-probe.ts --stream http://127.0.0.1:8791
```

The probe-only entry point uses an in-memory counter and a public test secret
for `/v1/help`. It is for remote previews only: **never deploy the probe config**.
The benchmark overwrites `help-probe-results.json`; preserve the checked-in
measurement when comparing later runs.

## Verification

- Worker `npm test`: 21 passed, including JSON compatibility, cap/error JSON,
  fragmented SSE/tools, legacy fields, dropped reasoning, truncated streams and
  first-delta delivery before upstream closes.
- API `npm test -- test/help.test.ts`: 19 passed.
- API `npm run build`: exit 0 (Prisma generate, TypeScript and esbuild).
- Full API `npm test`: 243 passed, 1 failed across 43 files. The unchanged
  `test/ops-review.test.ts:221` expects `cloudflare/cloudflared:2026.9.3` while
  HEAD's `deploy/compose.yaml` pins `2026.10.4`. Both files are unchanged by this
  task; deployment files are explicitly outside scope. Full-suite acceptance
  therefore remains blocked by this baseline mismatch.
