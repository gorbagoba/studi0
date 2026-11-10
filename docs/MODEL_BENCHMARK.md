# studi0 — MODEL BENCHMARK

**Run date:** 2026-11-10 · **Gateway:** `https://soclaas-api.comp.nus.edu.sg/v1` (vLLM 0.32.0) · **Target:** personal-tutor chat agent (streaming agent loop, 7 tools incl. `search_material` / `write_lesson` / `save_quiz`) + lesson generation.

**Read this first**

- The gateway is a **shared GPU**. Several numbers here (llama 28 s, nemotron 55 s, qwen3-vl 70 s first token) look like queueing/contention, not model speed. Treat all timings as indicative, one sample each — not a benchmark you can quote.
- Probes were run **strictly sequentially**, one HTTP call at a time, 120 s timeout per call.
- The API key was read from the opencode config at runtime and never written to disk, logged, or included here.

## Method

| Probe | Shape |
|---|---|
| **L** — latency/stream | Real `studi0-teacher.md` system prompt (12 000 ch) + CLT question + 2 tool schemas (`search_material`, `write_lesson`), `stream: true`, `max_tokens: 500`. TTFT = first streamed token of any kind (content, reasoning, or tool delta). |
| **N** — thinking off | Repeat of **L** with `chat_template_kwargs: { enable_thinking: false }`. Run only where **L** showed reasoning. |
| **T** — tool correctness | Non-streaming, **`write_lesson` as the only tool**, `max_tokens: 900`: *"Write the lesson file lessons/0001-test.html about heaps."* Scored on: `finish_reason`, arguments parse as JSON, both `path` and `html` present, `path` matches `lessons/NNNN-*.html`. |
| **P** — pedagogy | No tools, short system prompt *"You are a tutor. Never hand over the answer; build intuition first."*, `max_tokens: 700`, same CLT question. Scored 1–5 on (i) builds intuition, (ii) correctness, (iii) concise/structured, (iv) difficulty fit. |

Two deliberate re-runs, both because the first pass measured the harness rather than the model:

1. **T** initially declared both tools; 10 of 14 models called `search_material` first (correct agent behaviour, useless as a schema test), so **T** was re-run with `write_lesson` alone.
2. **P** at 700 tokens returned **zero prose** from every reasoning model, so those models were re-run with `enable_thinking: false` (and, failing that, 2 500 tokens) to find out whether prose was reachable at all.

Nothing was retried more than once. `GET /v1/models` now succeeds (it 401'd previously) and lists the same 14 ids plus `bge-m3`, `whisper-large-v3`, `coder`, `coding`, `default`, `ornith1.0:35b`, `qwen3.6:27b` — the extra chat ids were not benchmarked.

## Summary

| Model | Ctx | TTFT (any tok) | L total | L reasoning | L content | L finish | N (thinking off) | T: write_lesson | P: prose @700 | P score /20 |
|---|---|---|---|---|---|---|---|---|---|---|
| **x-test-2** DeepSeek V4.1 Flash | **983 040** | **293 ms** | 7.3 s | 2331 ch | 0 | length | reasoning 0, content 116 ch, **tool_calls** | no output (all 900 tok = reasoning) | 0 → **859 ch @ 6.8 s** (nothink) | **19** |
| **qwen3.8:27b** | 245 760 | 899 ms | 13.4 s | 2181 ch | 0 | length | reasoning 0, tool_calls | **PASS** (`lessons/0001-test.html`, 123 ch html) | 0 → **2617 ch @ 12.1 s** (nothink) | **17** |
| **qwen3.6:35b** | 245 760 | **291 ms** | 6.1 s | 0 | 2158 ch | length | n/a (never reasons) | **FAIL** — `{"arguments":"{\"name\":\"MISSION.md\"}"}` | **1789 ch @ 4.7 s**, `stop` | **17** |
| **x-test-3** Qwen 3.8 Flash Next | 245 760 | 419 ms | 2.0 s | 236 ch | 68 ch | tool_calls | reasoning 0, tool_calls | no output (all 900 tok = reasoning) | 0 → **2778 ch @ 16.1 s** (nothink) | **17** |
| **qwen3-coder-next** | 245 760 | 303 ms | 0.66 s | 0 | 176 ch | tool_calls | n/a | **FAIL** — invented a grep call: `{"pattern":"heap","path":"material","-i":"True"}` | **2873 ch @ 4.0 s** | **16** |
| **nemotron3.5:30b** Lightning | 245 760 | **54 867 ms** | 54.9 s | 0 | 0 | tool_calls | n/a | **FAIL** — `path` only, `html` dropped at 900 tok (`finish=length`) | **2964 ch @ 1.9 s** | **17** |
| **coding** | — | 780 ms | 9.6 s | 2336 ch | 0 | length | reasoning 0, 92.7 s to first token | **FAIL** — `{"path":"/tmp/probe.txt","html":"probe"}` | 0 → **2592 ch @ 13.2 s** (nothink) | **17** |
| **x-test-1** GLM 5.3 Flash | **983 040** | 454 ms | 8.8 s | 2369 ch | 0 | length | **no effect** (reasoning 2341 ch) | **PASS** — best HTML (1042 ch) + correct path | **0 ch even at 2500 tok** (reasoning 11 462 ch) | n/a |
| **x-test-4** MiniMax M3.1 Flash | 983 040 | 366 ms | 1.3 s | 0 | 448 ch | tool_calls | n/a (no reasoning in L) | **FAIL** — empty arguments `{}` | 0 → 0 even at 2500 tok (reasoning 10 954 ch) | n/a |
| **qwen3-vl:32b** | 75 000 | 70 401 ms | 81.6 s | 0 | 1860 ch | length | n/a | **FAIL** — 120 s timeout | **2675 ch @ 83.4 s** | **18** |
| **ornith1.5:35b** | 245 760 | 217 ms | 2.6 s | 2220 ch | 0 | length | reasoning 0, 86 ch content | **FAIL** — `path: "MISSION.md"`, no `html` | **195 ch**, truncated | **12** |
| **qwen3.5:9b** | 61 440 | 2036 ms | 3.7 s | 430 ch | 0 | tool_calls | **no effect** (reasoning 690 ch, *more*) | **FAIL** — 0 output, 900 tok = reasoning | **1359 ch @ 11.1 s**, truncated | **14** |
| **llama3.1:8b** | 61 440 | 28 536 ms | 28.6 s | 0 | 0 | tool_calls | n/a | **PASS** (`lessons/0001-test.html`, 92 ch) | **909 ch @ 5.4 s**, `stop` | **10** |
| **gemma4:26b** | 122 880 | — | 142 ms | — | — | **HTTP 503** | — | **HTTP 503** | **HTTP 503** | n/a |

`P: prose @700` = pass 1 with reasoning on; where it is 0, the parenthesised run is the retry that produced prose. `L content = 0` with `finish=tool_calls` is **not** a failure: the model correctly opened the turn with `search_material`.

## Per-model detail

### x-test-2 — Test DeepSeek V4.1 Flash (983 040 ctx, long-transcript capable)

| Measure | Result |
|---|---|
| L | TTFT 293 ms · 7.3 s · reasoning 2331 ch · content 0 · `length` (hit 500 cap mid-thought) |
| N (`enable_thinking:false`) | TTFT 3.1 s · 4.0 s · **reasoning 0** · content 116 ch · `tool_calls` → flag works |
| T | `finish=length`, `tool_calls` empty — all 900 tokens spent reasoning (flag not set in this probe) |
| P | 0 ch @ 17.3 s (reasoning 3453 ch) → **859 ch @ 6.8 s, `finish=stop`** with the flag |
| Rubric | i 5 · ii 4 · iii 5 · iv 5 = **19/20** |
| Note | Only model that **withholds the answer and asks the learner to enumerate cases** ("values 0,0,0,0,100 … how do the possible averages distribute?"). Exactly the tutor brief. Plain text, no markdown leakage, English. |

### qwen3.8:27b

| Measure | Result |
|---|---|
| L | TTFT 899 ms · 13.4 s · reasoning 2181 ch · content 0 · `length` |
| N | TTFT 1.4 s · 1.9 s · reasoning 0 · `tool_calls` |
| T | **PASS** — `finish=tool_calls`, valid JSON, `{"path":"lessons/0001-test.html","html":"<!DOCTYPE html>…”}` (123 ch) |
| P | 0 ch (reasoning 3386 ch) → **2617 ch @ 12.1 s** with flag, `finish=length` (cut at 700) |
| Rubric | i 5 · ii 5 · iii 3 · iv 4 = **17/20** (biased-die + random-walk analogy; correct dilution argument; too long for a chat bubble) |
| Note | Clearest "no tricks" model: passes the tool schema **without** needing the flag, and reasons only modestly. |

### qwen3.6:35b

| Measure | Result |
|---|---|
| L | TTFT **291 ms** · 6.1 s · reasoning **0** · content 2158 ch · `length` (500 cap) |
| N | n/a — never emitted reasoning |
| T | **FAIL** — returned `{"arguments":"{\"name\":\"MISSION.md\"}"}`, no `path`/`html` |
| P | **1789 ch @ 4.7 s, `finish=stop`** — the only model that finished a complete answer at 700 tokens without the flag |
| Rubric | i 4 · ii 5 · iii 4 · iv 4 = **17/20** (skewed wait-times analogy, ends by offering two next steps) |
| Note | Best latency profile of anything measured, zero reasoning tax, ~1800 ch answers. **The earlier "tool_calls fine" note is not reproduced** — schema adherence is its weak spot. Verify in-app before promoting. |

### x-test-3 — Test Qwen 3.8 Flash Next

| Measure | Result |
|---|---|
| L | TTFT 419 ms · 2.0 s · reasoning 236 ch · content 68 ch · `tool_calls` |
| N | TTFT 626 ms · 1.1 s · reasoning 0 · `tool_calls` → flag works |
| T | `finish=length`, no output (900 tok = reasoning) |
| P | 0 ch → **2778 ch @ 16.1 s** with flag, `length` (cut at 700) |
| Rubric | i 5 · ii 5 · iii 3 · iv 4 = **17/20** (stadium-heights analogy, extremes cancel; very long) |
| Note | Fast, but needs the flag to answer at all and overruns short budgets. |

### qwen3-coder-next

| Measure | Result |
|---|---|
| L | TTFT 303 ms · **0.66 s** · content 176 ch · `tool_calls` |
| T | **FAIL** — hallucinated a shell/grep tool: `{"pattern":"heap","path":"material","-i":"True"}` |
| P | **2873 ch @ 4.0 s**, `length` |
| Rubric | i 5 · ii 5 · iii 2 · iv 4 = **16/20** (die-rolling, correct; emoji-heavy, very long) |
| Note | Fastest prose generator measured, but it is a coding model: wrong tool, wrong argument shape, heavy emoji/markdown that the plain-text chat bubble will show raw. |

### nemotron3.5:30b — Lightning

| Measure | Result |
|---|---|
| L | TTFT **54.9 s** · 54.9 s · tool_calls |
| T | **FAIL** — `{"path": "lessons/0001-test.html"}` only, `html` dropped at 900 tok (`finish=length`) |
| P | **2964 ch @ 1.9 s** (~1560 tok/s — implausibly fast, probably contention/cache artefact) |
| Rubric | i 5 · ii 5 · iii 3 · iv 4 = **17/20** (chaotic crowd → averaging; strong, but truncated mid-question) |
| Note | Good prose, unusable first-token latency, and it drops the `html` payload. |

### coding

| Measure | Result |
|---|---|
| L | TTFT 780 ms · 9.6 s · reasoning 2336 ch · content 0 · `length` |
| N | reasoning **0** but first token took **92.7 s** |
| T | **FAIL** — `{"path":"/tmp/probe.txt","html":"probe"}`: ignores the required path shape and the content |
| P | 0 ch @ 77.8 s → **2592 ch @ 13.2 s** with flag |
| Rubric | i 5 · ii 5 · iii 3 · iv 4 = **17/20** (watermelon "denoising"; correct) |
| Note | Answer quality is fine; tool discipline is not. 78 s to nothing at 700 tokens. |

### x-test-1 — Test GLM 5.3 Flash (983 040 ctx)

| Measure | Result |
|---|---|
| L | TTFT 454 ms · 8.8 s · reasoning 2369 ch · content 0 · `length` |
| N | **no effect** — reasoning 2341 ch, still 0 content |
| T | **PASS, best of the run** — correct path + 1042 ch of real HTML (`<!DOCTYPE html>`, `<title>Heaps</title>`, `<style>`) |
| P | 0 ch @ 14.5 s → 0 ch at 2500 tok (reasoning **11 462 ch**, 83.7 s) |
| Rubric | n/a — no prose to score |
| Note | **The 52 s TTFT baseline reproduces for prose** (51.8 s nothink, 83.7 s roomy), but its first token is 0.3–0.9 s when it opens with a tool call, which is why it feels fast in an agent loop. Never reaches an answer in 2 500 tokens. |

### x-test-4 — Test MiniMax M3.1 Flash (983 040 ctx)

| Measure | Result |
|---|---|
| L | TTFT 366 ms · 1.3 s · content 448 ch · `tool_calls` |
| T | **FAIL** — empty arguments `{}` |
| P | 0 ch → 0 ch at 2500 tok (reasoning 10 954 ch) |
| Rubric | n/a |
| Note | Fast and chatty under the teacher prompt, but cannot answer under the short tutor prompt at any budget tried, and emits structurally empty tool calls. |

### qwen3-vl:32b

| Measure | Result |
|---|---|
| L | TTFT **70.4 s** · 81.6 s · content 1860 ch |
| T | **120 s timeout** |
| P | **2675 ch @ 83.4 s** |
| Rubric | i 5 · ii 5 · iii 3 · iv **5** = **18/20** — the best-scoring explanation (dice enumeration with correct counts: 2 ways to average 3.5, 5 ways to average 3.0, then 100 dice) |
| Note | Best teaching content, worst latency; unusable in a chat loop. |

### ornith1.5:35b

| Measure | Result |
|---|---|
| L | TTFT 217 ms · 2.6 s · reasoning 2220 ch · content 0 |
| N | reasoning 0, 86 ch, tool_calls → flag works |
| T | **FAIL** — `path: "MISSION.md"` (a file from its own coder prompt, not the requested lesson), no `html` |
| P | **195 ch**, truncated at 700 tok |
| Rubric | i 4 · ii 3 · iii 2 · iv 3 = **12/20** — right opening line, nothing after it |
| Note | Fast first token, but it leaks an unrelated agent persona (`MISSION.md`) into tool paths. |

### qwen3.5:9b

| Measure | Result |
|---|---|
| L | TTFT 2.0 s · 3.7 s · reasoning 430 ch · content 0 |
| N | **no effect** — reasoning grew to 690 ch, still 0 content (matches the earlier finding) |
| T | **FAIL** — 900 tok, 0 output, `finish=length` |
| P | **1359 ch @ 11.1 s**, truncated |
| Rubric | i 4 · ii 4 · iii 3 · iv 3 = **14/20** |
| Note | Cheap and quick when it does answer, but it burns small budgets on reasoning and the flag does not stop it. |

### llama3.1:8b

| Measure | Result |
|---|---|
| L | TTFT **28.5 s** · 28.6 s · tool_calls |
| T | **PASS** — `lessons/0001-test.html`, 92 ch html |
| P | **909 ch @ 5.4 s, `finish=stop`** |
| Rubric | i 3 · ii **2** · iii 2 · iv 3 = **10/20** — explains the CLT by "samples overlap / nearby samples have similar centres", which is not the mechanism; rambling, no structure |
| Note | Passes the tool schema, but the teaching answer is misleading — the worst outcome for a tutor. |

### gemma4:26b

| Measure | Result |
|---|---|
| All probes | **HTTP 503** `{"error":"no healthy provider backends for backend group \"79\""}` — 6 attempts over two passes, ~20 min apart |

## Ranked recommendation

**1. Best overall — `x-test-2` (DeepSeek V4.1 Flash), 983 040 ctx**
Lowest first token of any model that also teaches well (293 ms), and the only model whose pedagogy matches the brief exactly: it refuses to hand over the CLT and makes the learner enumerate cases (19/20). 983 K context is the reason to pick it for long transcripts. **Condition:** send `chat_template_kwargs: { enable_thinking: false }` — with reasoning on it spends 900 tokens thinking and emits no message at all. Before promoting, re-run the `write_lesson` probe with the flag set (the one gap: **T** was not re-run with the flag, and without it the model produced no arguments, while **N** did emit tool calls).

**2. Best drop-in / fallback — `qwen3.8:27b`, 245 760 ctx**
The safest default: the only model that **both** passes the `write_lesson` schema (correct path, valid HTML) and produces strong prose (17/20), and it still works acceptably without the flag (13.4 s with tools). Costs ~0.9 s to first token and reasons ~2 200 ch per turn; give it `enable_thinking: false` for chat turns and it answers in 1.9 s.

**3. Best quality-per-latency — `qwen3.6:35b`, 245 760 ctx**
291 ms TTFT, 6.1 s for a 2 158 ch answer, **zero** reasoning tokens, 17/20 prose, and it is the only model that finished a complete answer at 700 tokens. Its weakness is tool discipline: `write_lesson` arguments came back wrapped in a bogus `arguments` object. Ideal for lesson *drafting* and plain Q&A; risky as the agent-loop driver until its tool calls are confirmed in-app.

**Narrow uses**
- **Lesson file generation only:** `x-test-1` produced the best HTML (1 042 ch, correct `lessons/0001-test.html`) — but only in the tool-call path; it never emits prose under 2 500 tokens (51–84 s, 11 462 reasoning ch). Fine for a background job, fatal for chat.
- **Prose quality with time to spare:** `qwen3-vl:32b` (18/20) and `nemotron3.5:30b` (17/20, 2 964 ch in 1.9 s) — both lose on the tool path (timeout, dropped `html`).

**Do not use for this app:** `qwen3.5:9b` (burns every budget on reasoning, flag ignored), `ornith1.5:35b` (writes `MISSION.md` instead of the lesson, truncates), `llama3.1:8b` (passes tools, teaches the CLT wrongly), `qwen3-coder-next` (invents grep args, emoji/markdown leakage), `x-test-4` (empty `{}` tool args, no prose at any budget), `gemma4:26b` (503, backend down).

**Formatting caveat for all of them:** the chat bubble renders assistant text as **plain text** (`apps/web/src/chat/ChatPanel.tsx` has no markdown renderer), so `###` headings, `**bold**` and emoji show up raw. Every model except `x-test-2` and `llama3.1:8b` used markdown or emoji in the pedagogy probe. The teacher prompt needs to keep forbidding markdown, and `x-test-2` is the only model that obeyed it unprompted.

## Corrections to the pre-existing notes

| Claim | Status |
|---|---|
| `x-test-1` TTFT ~52 s with a small prompt | **Reproduced for prose** (51.8 s nothink / 83.7 s at 2 500 tok). But first token is 0.3–0.9 s when it opens with a tool call — the 52 s is the *answer* path, not the agent turn. |
| `qwen3.6:35b` TTFT 174 ms, tool_calls fine | TTFT **291 ms** here (same order). **`tool_calls fine` not reproduced** — malformed nested arguments on `write_lesson`. |
| `qwen3.5:9b` burns max_tokens on reasoning, no content | **Reproduced** (0 content at 500, 700 and 900 tok; `enable_thinking: false` did not help). |
| `x-test-1` returns tool_calls correctly | **Reproduced**, and it produced the best lesson HTML of the run. |

*Scratch probe scripts were deleted after the run. No repository source files were modified.*
