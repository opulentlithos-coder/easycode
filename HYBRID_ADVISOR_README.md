# Hybrid Advisor: Local LLM + Big LLM setup guide

Is feature me do model saath kaam karte hain:

| Role | Model | Kaam |
|---|---|---|
| **Local (karigar)** | Tumhara apna ~30B model (Ollama / vLLM / LM Studio) | Session ka main model. Saare tools (shell, read, edit...) yahi chalata hai |
| **Big (ustaad / expert)** | Claude / Gemini / OpenAI | Sirf salah deta hai. Local `ask_expert` tool se steps aur commands poochta hai, phir khud chalata hai |

Jo steps sach me chal jaate hain (verified), woh **learned skill** ban kar save hote hain. Agli baar local model wahi skill
use karta hai aur big model se nahi poochta. Dheere-dheere big model par dependency kam hoti hai.

> Branch: `hybrid-advisor`. Feature flag `hybrid_advisor` ke peeche hai (default **off**). Design aur roadmap ke liye
> `HYBRID_LLM_PLAN.md` dekho.

---

## 1. Kya chahiye

- Ye repo, `hybrid-advisor` branch par, aur **Bun 1.4+**
- Local model chalane ke liye GPU/RAM. 30B model Q4 me ~18–20 GB VRAM, ya 32 GB+ unified memory (Mac)
- Big model ki API key (Anthropic / OpenAI / Google), ya un providers ka koi aur login

```bash
git checkout hybrid-advisor
bun install
```

---

## 2. Local LLM setup (secondary / karigar)

### Option A: Ollama (sabse aasaan)

```bash
# 1. Ollama install karo: https://ollama.com/download
# 2. Model pull karo (coding ke liye recommended)
ollama pull qwen3-coder:30b
# 3. Check karo ki server chal raha hai
ollama list
```

**Context window badhao.** Ollama ka default chhota hota hai, aur agent ko 32k–64k chahiye. Ek Modelfile banao:

```
FROM qwen3-coder:30b
PARAMETER num_ctx 65536
```

```bash
ollama create qwen3-coder-64k -f Modelfile
```

Memory bachane ke liye (optional) Ollama start karne se pehle ye env set karo:

```bash
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
```

OpenCode Ollama ko `http://127.0.0.1:11434` par **apne-aap dhoondh leta hai**. Sirf tab config chahiye jab Ollama kisi aur
machine ya port par ho:

```jsonc
{
  "providers": {
    "ollama": { "settings": { "baseURL": "http://192.168.1.50:11434/v1" } }
  }
}
```

Tool calling zaroori hai: model ki capabilities me `tools` hona chahiye. Qwen3-Coder me hai.

### Option B: vLLM / LM Studio

Dono ke provider pehle se bane hain (provider id `vllm` aur `lmstudio`). Server chalao, aur alag URL ho to upar jaisa
`providers.<id>.settings.baseURL` set karo.

### Check karo

```bash
bun dev models | grep -i ollama     # Windows PowerShell: bun dev models | Select-String ollama
```

Model ka naam `ollama/<model>` format me dikhna chahiye, jaise `ollama/qwen3-coder-64k`. Config me yahi naam likhoge.

---

## 3. Big LLM setup (primary / expert)

API key ek baar login karke save kar do (key config file me likhne ki zaroorat nahi):

```bash
bun dev auth login anthropic      # ya: openai, google
bun dev auth list                 # check: login dikh raha hai?
```

Ya provider ka env variable set karo (jaise `ANTHROPIC_API_KEY`). Expert model ka naam bhi `provider/model` format me hota
hai, jaise `anthropic/claude-sonnet-5-5`. Exact naam `bun dev models` se dekh lo.

---

## 4. Config file: dono models ko jodna

Config file kahan rakhein:
- **Sab projects ke liye:** `~/.config/opencode/opencode.jsonc`
- **Sirf ek project ke liye:** us project me `opencode.jsonc` ya `.opencode/opencode.jsonc`

### Minimum config

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // Local model = session ka main model (karigar)
  "model": "ollama/qwen3-coder-64k",

  "experimental": {
    // Feature on karo (opt-in flag)
    "hybrid_advisor": true,

    "hybrid": {
      // Big model = expert (ustaad)
      "expert": "anthropic/claude-sonnet-5-5"
    }
  }
}
```

Flag config ki jagah env se bhi on kar sakte ho: `OPENCODE_FLAGS=hybrid_advisor`.

### Poora config (saare options)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3-coder-64k",

  "experimental": {
    "hybrid_advisor": true,
    "hybrid": {
      "expert": "anthropic/claude-sonnet-5-5",
      "delegate_agent": "expert-worker",   // local na kar paaye to kaam is agent ko jaata hai (section 5)
      "max_consults_per_turn": 3,          // ek user message par expert se kitni baar pooch sakta hai
      "max_consults_per_session": 10,      // poore session me kitni baar
      "escalate_after": 2,                 // same step itni baar fail → "expert se poochho / delegate karo" reminder
      "learn": true,                       // verified steps ko skill banao
      "skills_directory": "~/my-learned-skills", // default: <data>/hybrid/skills
      "review": "consulted",               // expert kaam ko review kare: off | consulted | always
      "human_feedback": "learned",         // user se rating: off | manual | learned | always
      "trace": "basic",                    // default trace level: off | basic | full
      "trace_retention_days": 30           // purani trace files itne din baad delete
    }
  },

  // Shuru me har shell command par permission maango, kyunki expert ke commands bhi chalenge
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }]
}
```

| Option | Default | Matlab |
|---|---|---|
| `expert` | — (zaroori) | Big model `provider/model`. Iske bina `ask_expert` tool error deta hai |
| `delegate_agent` | — | L2: local steps ke baad bhi fail ho to is subagent ko kaam do |
| `max_consults_per_turn` | 3 | Ek turn ka expert budget |
| `max_consults_per_session` | 10 | Session ka expert budget |
| `escalate_after` | 2 | Kitni failures ke baad reminder |
| `learn` | true | Skills save karo |
| `skills_directory` | `<data>/hybrid/skills` | Learned skills ka folder |
| `review` | consulted | Turn ke baad expert asli tool output dekh ke verdict aur lessons deta hai (section 6.1) |
| `human_feedback` | manual | User rating kaise li jaye (section 6.2) |
| `trace` | off | Default tracing level |
| `trace_retention_days` | 30 | Trace files kitne din rakhein |

---

## 5. (Optional) Jo local na kar paaye, woh big model khud kare

Ek subagent banao jo big model par chale aur normal tools use kare:

```jsonc
{
  "agents": {
    "expert-worker": {
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-5-5",
      "description": "Finishes a task the local model could not, using normal tools. Give it the goal, the plan so far and the failing output.",
      "steps": 30
    }
  },
  "experimental": {
    "hybrid_advisor": true,
    "hybrid": { "expert": "anthropic/claude-sonnet-5-5", "delegate_agent": "expert-worker" }
  }
}
```

Expert ke corrected steps ke baad bhi local fail hota rahe, to plugin use reminder deta hai ki `subagent` tool se
`expert-worker` ko kaam de. Expert-worker jo commands chalata hai, unse bhi skill banti hai, taaki agli baar local khud kar sake.

---

## 6. Chalana

```bash
bun dev                                   # TUI, current folder me
bun dev /path/to/project                  # kisi project me
bun dev run "python install karo"         # bina TUI, ek prompt
```

(Installed `opencode` binary me ye branch aane ke baad `bun dev` ki jagah `opencode` likhoge.)

### Kya hota hai (example: "python install karo")

1. Plugin learned skills me dhoondhta hai. Pehli baar kuch nahi milta.
2. Local model `ask_expert` call karta hai. Plugin machine ki details (OS, shell, folder) apne-aap jodta hai aur secrets hata deta hai.
3. Expert JSON plan deta hai: steps, exact commands, verify commands.
4. Local har step **khud** shell tool se chalata hai aur verify karta hai.
5. Koi step 2 baar fail ho → reminder: "ask_expert ko plan_id + failed_step ke saath dobara poochho".
6. Turn khatam: expert poora kaam review karta hai (6.1). Phir jo steps pass hue, unse skill banti hai, jaise `python-install-win32`, aur review ke lessons usme jud jaate hain.
7. Config ho to user se poocha jaata hai ki kaam kaisa raha (6.2).
8. Agli baar same kaam: skill inject hoti hai, local seedha karta hai, **expert ko 0 calls**.

### 6.1 Expert ka feedback (review)

Local ne expert ke steps chalaye, jaise tests likhe aur chalaye ya kuch install kiya. Turn khatam hone par plugin expert ko
dikhata hai: task kya tha, expert ne kya plan diya, local ne kaunse commands chalaye aur unka asli output (pass/fail).
Expert JSON me jawab deta hai:

- **verdict:** `success` (kaam hua aur verify hua) / `partial` (aadha hua, ya verify nahi hua) / `failed`
- **lessons:** agli baar ke liye 5 tak chhoti, pakki baatein, jaise "winget ke baad `py --version` se check karo"

Iska asar:
- Verdict hi decide karta hai ki turn safal tha ya nahi. Exit codes ka andaza sirf tab chalta hai jab review nahi hua.
- `failed` verdict par skill nahi banti. Jo skill use hui thi, uska loss count hota hai.
- Lessons skill ke `SKILL.md` me **## Lessons** section me jud jaate hain, to agli baar local model unhe padhta hai.

| `review` | Kab review hota hai | Kharcha |
|---|---|---|
| `off` | Kabhi nahi | 0 |
| `consulted` (default) | Jab turn me expert se poocha gaya ya kaam delegate hua | Har aise turn par 1 extra call |
| `always` | Har turn jisme tools chale, local ka khud ka kaam bhi | Har turn par 1 call |

Review ke dauran session idle hone se pehle expert ke jawab ka wait karta hai, isliye turn thoda der se khatam hota hai.

### 6.2 Insaan ka feedback (configurable)

User batata hai ki kaam kitna safal raha: **good / partial / bad**, chaho to ek note ke saath.

| `human_feedback` | Kya hota hai |
|---|---|
| `off` | Feedback band, `/hybrid-feedback` bhi kaam nahi karta |
| `manual` (default) | Sirf jab aap khud `/hybrid-feedback` likho |
| `learned` | Jis turn me skill bani, update hui ya use hui, uske baad model aapse question dialog me poochta hai: Worked / Partly / Failed |
| `always` | Har us turn ke baad poochta hai jisme expert, delegate ya skill ne madad ki |

Kabhi bhi khud rating do (session ke last turn par lagti hai):

```
/hybrid-feedback good
/hybrid-feedback partial tests pass hue par lint fail hai
/hybrid-feedback bad python 3.12 install hua, 3.13 chahiye tha
```

Rating ka skill par asar:
- `bad` jo `good` se zyada ho: skill **retired** ho jaati hai. Nayi skill (kabhi reuse nahi hui) ek hi `bad` se retire ho jaati hai.
- 2 `good` aur 0 `bad`: candidate skill **trusted** ban jaati hai.
- Retired skill ko baad me `good` zyada milein to woh wapas candidate ban jaati hai.
- Note: `good` ke saath likha note **Lessons** me jaata hai. `partial`/`bad` ka note **Pitfalls** me.

`bun dev run` (bina TUI) me question dialog nahi khulta, isliye wahan `manual` hi rakho.

---

## 7. Tracing aur dashboard (sab kuch dekhna)

### Tracing on karo, teen tareeke

```bash
# 1. Run parameter (sabse aasaan). Iske saath private server chalta hai taaki setting server tak pahunche
bun dev --hybrid-trace=full
bun dev run --hybrid-trace=full "python install karo"

# 2. Env variable (--standalone ke saath)
OPENCODE_HYBRID_TRACE=full bun dev --standalone
```

```
# 3. Chalte session me (TUI ke andar)
/hybrid-trace full        # ya basic / off
/hybrid-trace             # abhi ka level dikhata hai
```

| Level | Kya save hota hai |
|---|---|
| `off` | Kuch nahi (default) |
| `basic` | Saare events, timings, pass/fail, aur text ke sirf ~200 char preview |
| `full` | Poore sawal, expert ke jawab, command outputs (aakhri lines), skill diffs |

Dono levels me secrets (API keys, tokens, passwords, emails) aur home path save hone se **pehle** hata diye jaate hain.

### Dekho

```bash
bun dev hybrid report                  # latest turn ki timeline + KPIs, terminal me
bun dev hybrid report --turns 3        # last 3 turns
bun dev hybrid report -s <sessionID>   # koi khaas session

bun dev hybrid dashboard               # HTML dashboard bana ke browser me kholta hai
bun dev hybrid dashboard --no-open --out ./hybrid.html
```

Dashboard ke tabs:
- **Overview:** success rate, consults/turn, skill hit rate, delegate rate, aur din-wise "kisne handle kiya" (local / skill / expert-advice / delegate)
- **Turns:** har turn ki timeline: USER → PLUGIN → LOCAL → EXPERT → SKILL. Kisi bhi line par click karke poora data dekho
- **Expert Q&A:** local ne kya poocha, expert ne kya plan diya
- **Local performance:** kaunse steps fail hue, kahan atka (triggers), kya delegate hua
- **Feedback:** expert ke verdicts aur lessons, aur user ki ratings aur notes, har turn ke liye
- **Skills:** kaunsi skill kab bani, kis turn se, version history aur counters

---

## 8. Files kahan hain

`<data>` = OpenCode ka data folder, aam taur par `~/.local/share/opencode`. Exact path `bun dev debug paths` se dekh lo.

| Cheez | Path |
|---|---|
| Trace files (har session ki ek) | `<data>/hybrid/traces/<sessionID>.jsonl` |
| Learned skills | `<data>/hybrid/skills/<skill>/SKILL.md` (model ke liye) + `hybrid.json` (counters) |
| Dashboard | `<data>/hybrid/dashboard.html` |

**Learned skill ki lifecycle:**
- `candidate`: nayi bani hai
- `trusted`: 3+ baar local ne bina expert ke safal kiya (≥80%), ya user ne 2 baar `good` diya aur `bad` ek bhi nahi
- `retired`: baar-baar fail hui ya user ne `bad` diya (section 6.2), ab use nahi hoti
- `executor: expert`: local isse 2 baar delegate karne ke baad bhi nahi kar paaya, ab seedha delegate karne ka reminder milega

Kisi skill ko sudharna ho to uska `SKILL.md` edit karo. Hatana ho to uska folder delete kar do.

---

## 9. Problem aaye to

| Problem | Kya karo |
|---|---|
| `ask_expert` tool dikh hi nahi raha | `experimental.hybrid_advisor: true` (ya `OPENCODE_FLAGS=hybrid_advisor`) aur `experimental.hybrid.expert` dono set karo. Phir server restart karo (`bun dev service restart`, ya `--standalone` use karo) |
| "No expert model is configured" | `experimental.hybrid.expert` set nahi hai |
| "The expert model ... failed" | API key / login check karo (`bun dev auth list`), aur model ka naam `bun dev models` se match karo |
| Local model `ollama/...` list me nahi | `ollama list` chal raha hai? Alag host/port ho to `providers.ollama.settings.baseURL` set karo |
| Local tool calls galat karta hai | Tool-calling wala model lo (Qwen3-Coder), aur `num_ctx` badhao |
| Context bhar jaata hai | `num_ctx` 64k karo. (Chhote window ka poora handling plan ke section 9 me hai, abhi baaki hai) |
| `--hybrid-trace` ke baad bhi trace nahi | Background service env nahi padhta, isliye session ke andar `/hybrid-trace full` use karo. `--server` ke saath parameter kaam nahi karta |
| Dashboard khaali hai | Pehle tracing on karke ek-do turn chalao. Trace folder `bun dev hybrid report` ki pehli line me dikhta hai |
| Expert budget khatam | `max_consults_per_turn` / `max_consults_per_session` badhao |

---

## 10. Developers ke liye

```bash
# Tests (hamesha package folder se, root se nahi)
cd packages/core && bun run script/test.ts test/plugin/hybrid.test.ts test/flag.test.ts
cd packages/cli  && bun test --timeout 30000 test/hybrid.test.ts

# Typecheck
cd packages/core && bun typecheck
cd packages/cli  && bun typecheck
```

| Code | Kya hai |
|---|---|
| `packages/core/src/plugin/hybrid.ts` | Plugin: `ask_expert` tool, hooks (prompt / context / tool / idle), `/hybrid-trace` |
| `packages/core/src/plugin/hybrid/expert.ts` + `expert.txt` | Expert prompt, JSON plan parse, redaction |
| `packages/core/src/plugin/hybrid/local.txt` | Local model ke rules |
| `packages/core/src/plugin/hybrid/learned.ts` | Skill banana, merge, lifecycle, matching |
| `packages/core/src/plugin/hybrid/trace.ts` | JSONL trace writer |
| `packages/cli/src/hybrid/*` | `hybrid report` / `hybrid dashboard` |
| `packages/schema/src/config/{flag,experimental}.ts` | Flag + `experimental.hybrid` config |
