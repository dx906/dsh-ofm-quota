[中文](./README.md) | **English**

# dsh-ofm-quota

**See how much is left. Switch automatically when it runs out.**

Adds **endpoint quota management** to [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model) on [DSH (DeepSeek Harness)](https://github.com/deepseek-ai): it reports, in real time, which endpoint each conversation actually lands on and how many tokens it spends; when an endpoint runs dry it switches to **another endpoint serving the same model**; and when every third-party endpoint is exhausted it falls back to **official DeepSeek models** — the conversation never stops. A card in the right sidebar lays out how much is left.

[![test](https://github.com/dx906/dsh-ofm-quota/actions/workflows/test.yml/badge.svg)](https://github.com/dx906/dsh-ofm-quota/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](./package.json)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-6f42c1.svg)](#installation)
[![platform](https://img.shields.io/badge/platform-web%20%7C%20desktop-0a7ea4.svg)](#installation)

---

## The problem it solves

Our Free Model aggregates a dozen-odd free and co-paid channels into a single provider. One login, everything usable — but it brings three annoyances:

1. **You can't see what's left.** Each channel has its own credit pool. TRAE is at 382, Qoder at 400, ZCode at 0 — and those numbers live in each vendor's console, invisible from the aggregated panel.
2. **You find out only when it's gone.** The tripwire is an HTTP 429 or `QUOTA_EXHAUSTED`, fired mid-conversation. All you can do is open the model picker and hunt for the next one by hand.
3. **Cumulative spend is guesswork.** How many tokens you burned today, and which channel ate most of them, doesn't add up anywhere.

This plugin fills exactly those three gaps. It is not a replacement for OFM — it is a **dashboard and an automatic transmission bolted onto its side**.

## Features

### 1. Usage tracking

It listens in on the kernel's `llm/stream` watermark and records the `provider/model` each request is actually dispatched to, plus the token usage the adapter reports back (input / output / thinking / cache reads).

Two data sources cross-check each other:

| Source | What it is | Trust |
|---|---|---|
| **Our listener** on `llm/stream` | Every real dispatch inside this process | Live, but only covers this process |
| **The channel pack's authoritative ledger** `token-ledger.json` | Accumulated by the channel pack itself per `direct\|provider\|accountId\|model` per day | Covers all history; the authoritative value |

The UI shows both: **Model usage detail** displays comparisons like "773 dispatches observed / 1628 authoritative", where the gap means some requests happened before the plugin was installed.

### 2. Automatic failover on quota exhaustion

When quota runs out it **switches to another endpoint of the same model**, and falls back to official DeepSeek models when no third-party endpoint is left.

```
endpoint quota exhausted (QUOTA_EXHAUSTED / 429 / credential revoked)
      ↓
look along the "same-name family" for a backup endpoint that still has quota
      ↓
found     → switch over, rerun this step, conversation uninterrupted
not found → fall back to official DeepSeek models
```

### 3. Sidebar card

A new **Endpoint quotas** card in DSH's native right sidebar, showing each channel's **remaining credits** and live consumption.

**Balance is a property of the channel account, not of the model.** The dozens of models under one channel share a single credit pool, so the card draws one row per channel (expandable to per-account detail) instead of repeating the same number for every model — which would only produce a wall of "quota unknown". Model-level usage is folded away in the secondary **Model usage detail** section, collapsed by default.

## The UI

Right sidebar → **Endpoint quotas**:

```
┌─ Endpoint quotas ──────────────────────┐
│ iFlytek Loomy        4320 credits left │
│ Qoder CN              400 credits left │
│ Youdao LobsterAI      400 credits left │
│ TRAE (ByteDance)    19.67 credits left │
│ ZCode (Zhipu)           0 credits left │
│ Cline                  balance unknown │
│                                        │
│ ▸ Model usage detail (12)              │
└────────────────────────────────────────┘
```

`balance unknown` is **an honest report, not a failure**: when Cline has no credentials configured, the plugin does not fabricate a 0 — that would read as "your credits are gone".

## Requirements

- **DSH** (DeepSeek Harness), providing the profile / bundle / cordis plugin machinery.
- **[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)**, providing the channels being managed. This plugin depends on its on-disk files and its `channel-pack` RPC.
- **Node.js** `^22.19.0 || >=24.0.0`.

**Zero runtime dependencies.** Only Node builtins (`node:crypto` / `fs` / `os` / `path` / `url`) — `client.js` has no imports at all. The bytes you install are bytes you can finish reading; no surprises hiding in `node_modules`.

> This plugin only *reads* OFM's on-disk files. It does not modify OFM and does not replace it. The two can be upgraded independently.

## Installation

This package is **not published to npm** (`private: true`). Build a tarball from source and install it into your profile, so the bytes that land on disk are the bytes you reviewed.

```sh
# 0. Get the source
git clone https://github.com/dx906/dsh-ofm-quota.git
cd dsh-ofm-quota

# 1. Pack a local tarball into the profile's vendor/
mkdir -p "$DSH_HOME/profiles/desktop/vendor"
pnpm pack --pack-destination "$DSH_HOME/profiles/desktop/vendor"

# 2. Add a line to the profile's package.json dependencies:
#    "dsh-ofm-quota": "file:./vendor/dsh-ofm-quota-0.1.0.tgz"

# 3. Append to the end of dsh.profile.bundles in the profile's package.json:
#    "dsh-ofm-quota"

# 4. Resolve dependencies in the profile directory
cd "$DSH_HOME/profiles/desktop"
pnpm install --frozen-lockfile --offline --ignore-scripts
```

> **After changing the tarball you must update that package's `integrity` (sha512-base64) in `pnpm-lock.yaml`**, or `--frozen-lockfile` fails. With the same version number, pnpm will also consider itself `Already up to date`; `rm -rf node_modules/dsh-ofm-quota` first, then `--force`.

Then **quit DSH from the tray and start it again**.

> ⚠️ **Not restarting means not installed.** The running host is still the old code — a trap that fooled us once during development: the fix was on disk, the behaviour was still broken. On startup the plugin logs `[ofm-quota] loaded build=<hash>`; use that line to confirm the version.

**Web and desktop share the same profile, so one install covers both.**

### One desktop-specific snag

The desktop `desktop` profile is owned exclusively by the Electron app, so a CLI `dsh plugin add` reports:

```
profile "desktop" is managed exclusively by the Electron application
```

Hence the manual steps above are the proper route on desktop. (The in-app plugin manager works too, but this package recommends the manual path — see above.)

## Quick start

1. Restart DSH and open **Endpoint quotas** in the right sidebar.
2. Click **Sync** — the plugin reads the endpoint list and historical usage from on-disk files.

| Data source | Path | What it provides |
|---|---|---|
| Our Free Model catalog | `$DSH_HOME/our-free-model/catalog.json` | The endpoint lists for the free / EAC / Kilo lanes (`entries` / `sealIds` / `kiloRows`) |
| Channel-pack accounts | `$DSH_HOME/channel-pack/state.json` | Logged-in channel accounts (trae / qodercn / loomy / zcode …) |
| Channel-pack usage | `$DSH_HOME/channel-pack/token-ledger.json` | **Authoritative token usage**, accumulated per `direct\|provider\|accountId\|model` per day |

3. Click **Refresh balances** — this fetches each channel's real remaining credits.
4. Use DSH normally. When an endpoint runs out, it switches by itself.

> **Why not go through their HTTP APIs?** `/api/our-free-model/*` is fenced by the kernel connection's `dsh-auth-*` cookie (no launch token → 401), and `/api/channel-pack` is an exact Fetch route (non-owner peer → 403). Reading files in the same process is a supported path, and the only one that reliably works.

## How it works

### 1. Balances: why the detour

The channel pack registers its balance RPC as an **exact Fetch route** on the connection (`/api/channel-pack`), and exact routes return **403 to any non-owner Peer** (`dsh-client-connection/lib/index.js:830`). That is precisely why Our Free Model's own host half cannot read balances either and has to delegate to its browser half.

This plugin creates an **in-process owner Peer** inside the host half and dispatches through it:

```js
const peer = connection.createPeer({ principal: { kind: 'owner' } })
const handler = connection.createSharedFetchHandler('/api')
await handler.fetch(new Request('http://127.0.0.1/api/channel-pack', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'client-request', rpcId: '...', method: 'channel-pack',
    payload: { method: 'credits.balances', payload: { provider: 'trae', force: true } },
  }),
}), peer)
```

Balances obtained this way land in the endpoint row's `quotaRemaining`, so failover can move **ahead of time** instead of waiting for a 429.

When the host has no `createSharedFetchHandler`, the plugin degrades gracefully (it returns `no-connection`) and never throws.

> **`balance: null` plus an `error` must never be read as 0.** The channel pack has itself recorded this bug report (already fixed): showing a failed query as 0 makes users think their credits are gone. This plugin only sets `quotaKnown` when it has a real number, and returns `ok:false` with a reason when no account can be queried.

### 2. Failover: two native kernel watermarks

We don't touch `ctx.llm` (it has no middleware). We use the kernel's own waterfalls:

```
agent/request-error  → failed and code is a trigger → pick target → record pending → return {kind:'retry'}
agent/request        → loop reruns this step        → read pending → rewrite provider/model → drop reasoningEffort
```

Three details that have to be right:

1. **Trigger codes must cover two naming systems.** The kernel's `normalizeLlmFailure` **passes through** the `code` thrown by the adapter itself (`ownErrorCode` at `dsh-llm/lib/index.js:402-410`) and does not map it to a kernel code. So both families have to be listed:

   - Kernel codes: `QUOTA` / `ACCOUNT_QUOTA` / `RATE_LIMIT` / `INVALID_CREDENTIAL` / `CONTEXT_WINDOW_EXCEEDED`
   - OFM ecosystem codes (`src/http.js:29-51`; channel-pack uses the same set): `QUOTA_EXHAUSTED` (**the critical one**) / `PERMISSION_DENIED` / `AUTHORIZATION_REQUIRED` / `LANE_LOCKED`

   `QUOTA` and `ACCOUNT_QUOTA` must **both** be present: `dsh-llm-deepseek-account` promotes the former into the latter (`lib/index.js:455-460`), so listing only one halves the trigger rate.

2. **Switching routes must drop the source route's `reasoningEffort`.** That is the previous route's own thinking level, and the target adapter may not recognise the id. Fields unrelated to routing (`maxTokens` and friends) are carried over untouched.

3. **Never return retry when `signal` is already aborted**, or the loop will rerun a step that was cancelled.

Other behaviours:

- **Same-name matching** is done on a normalized family name (stripping `-free` / `-preview` / `-latest` / `-stable`). In practice `trae/deepseek-v4.1-flash` and `our-free-model/deepseek-v4.1-flash-free` serve as each other's backup.
- **The official route is never used as a "same-name backup"** — it can only be the fallback, otherwise the fallback would never be reachable.
- **`CONTEXT_WINDOW_EXCEEDED` is a request-level failure**: switch endpoint but don't cool the source down, so that a 1M-window endpoint isn't written off by a few long conversations.
- **Failed endpoints enter cooldown** (15 minutes by default) and are not preferred during it.
- **Switches per step are capped** (3 by default) to keep chains from amplifying latency.
- **Bundle ordering works out naturally**: this plugin sits at the end of `dsh.profile.bundles`, so it registers after `llm-retry` in `dsh-base` — llm-retry gets its attempt first, and only once it gives up does endpoint switching come into play.

### 3. The route carries its own trust fence

The plugin's HTTP route lives at `/api/ofm-quota`, which is longer than the kernel's `/api` and therefore **matches first** — so the admission check has to be its own; it cannot lean on the kernel.

When `connection` is available, its `admit` decides; otherwise the plugin reproduces the same rules structurally for loopback + same-origin. **It compares `url.host` including the port, not the hostname** (comparing hostnames alone would let a page on any local port cross the boundary). Fail-closed.

## Configuration

`$DSH_HOME/ofm-quota/settings.json`, or via the card / HTTP:

```json
{
  "enabled": true,
  "autoSwitch": true,
  "maxSwitchesPerStep": 3,
  "cooldownMs": 900000,
  "windowHours": 24,
  "officialFallback": { "provider": "deepseek-official", "model": "deepseek-flash" },
  "syncCatalog": true,
  "manualQuota": {}
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `autoSwitch` | `true` | Automatic failover switch |
| `triggerCodes` | 9 codes (below) | Failure codes that trigger a switch. **Must cover both naming systems** |
| `maxSwitchesPerStep` | `3` | Maximum switches per step (prevents chains) |
| `cooldownMs` | `900000` | Cooldown for a failed endpoint (15 minutes) |
| `windowHours` | `24` | Usage statistics window |
| `officialFallback` | Official DeepSeek | Fallback route when all third parties are unavailable |
| `syncCatalog` | `true` | Sync the endpoint catalog from the OFM catalog at startup |
| `manualQuota` | `{}` | Hand-entered quota (real reads win; manual is only a fallback) |

The default `triggerCodes`:

```js
// kernel codes
'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
// Our Free Model / channel-pack adapter codes
'QUOTA_EXHAUSTED', 'PERMISSION_DENIED', 'AUTHORIZATION_REQUIRED', 'LANE_LOCKED',
```

**Settings migration is union-based**: upgrading the plugin fills in newly added default trigger codes, but **never deletes codes you added yourself**, and it is idempotent.

There are two more ways to enter quota by hand:

- `POST /api/ofm-quota/quota` `{provider, model, remaining, total}` — for a single endpoint
- `POST /api/ofm-quota/provider-quota` `{provider, remaining, total}` — for a whole channel

## HTTP API

All under `/api/ofm-quota` (same-origin, sharing the host's `/api` trust fence):

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | What the card uses: endpoint rows, per-lane totals, quota availability, recent switches/failures |
| GET | `/endpoints` | Endpoint rows only |
| POST | `/sync` | Sync the endpoint list and usage from on-disk files |
| POST | `/balances` | **Read real channel credits** (`credits.balances`); may take just `{provider}` |
| POST | `/settings` | Change switches (validated against a field allowlist) |
| POST | `/quota` | Hand-enter quota for one endpoint |
| POST | `/provider-quota` | Hand-enter quota for a whole channel |
| POST | `/unblock` | Manually lift a cooldown |
| POST | `/reset` | Clear usage and switch history |

`/balances` accepts only **known providers** (the static 12-channel table plus anything logged in or synced), so it can't be used as a probe against arbitrary upstreams.

## Quota availability (measured, not a disclaimer)

**The channel pack's twelve channels expose real remaining credits.** Click **Refresh balances** on the card: it goes through the pack's own `credits.balances` RPC and returns the same number shown on Our Free Model's card (for example, TRAE's "382 credits left" corresponds to `balance.total` in the response).

| Lane | Quota readable | Basis |
|---|---|---|
| channel (trae / qoder / qodercn / codearts / loomy / raccoon / minimax / zcode / cline / gemini / lobsterai / opencode) | ✅ real credits | channel pack `credits.balances` RPC, `balance.total` |
| free (anonymous, no-credential lane) | ❌ | Only `429` + `retry-after`; no quota endpoint |
| EAC (co-paid) | ❌ per-user quota | Only GitHub authorization state and pool-level capacity |
| Kilo | ❌ | No concept of quota |
| aggregate (bring-your-own-key providers) | ❌ | Would require a bespoke balance query per provider |

Lanes with no readable quota don't fake it: they trigger failover from **failure feedback**.

## Self-test

```sh
pnpm test                  # run both suites
pnpm run test:host         # host half only
pnpm run test:client       # browser half only
pnpm run deadcode          # dead-code scan
```

`scripts/selftest.mjs` (host half, **17 groups**) covers: the real payload shapes and return contracts of all three hooks, same-name backup resolution, the official fallback, on-disk sync (three id shapes in the catalog / channel accounts / token-ledger), the channel balance RPC (owner Peer versus a 403 for non-owners), **positive and negative cases for the route admission fence**, **bounded memory** (512 turn/step entries, 256 agent entries), **quota source precedence (a real read beats a manual entry)**, the HTTP routes, and the **four dead-code audit cases** (account accumulation / cooldown release / failure write-back / reset).

`scripts/client-test.mjs` covers: the ModuleLoader entry contract, the tab type and the two keyed slot registrations, the component not throwing under minimal props, and **route URLs never carrying a leading slash** (which 404s or crosses origins behind a reverse-proxy prefix or inside a `dsh-app://` shell).

Everything runs offline; no host is started. CI runs the same suite on Node 22.19 and 24 (`.github/workflows/test.yml`) — and because there are zero dependencies, CI needs no install step at all.

> **Testing philosophy: every critical assertion gets an adversarial control.** Revert the fix back to the broken code and confirm the test actually goes red. Reality taught us this rule — we once wrote an assertion that **could never execute** (`requested` inside `if (requested.length > 0)` was always an empty array), so "this defect is locked down" fooled us for an entire round.

## FAQ

**Q: I installed it and nothing happens?**
A: You almost certainly didn't restart. The host process is running the old code. Check the log for `[ofm-quota] loaded build=`.

**Q: Every balance says "unknown"?**
A: Click **Refresh balances** first. If they're still unknown, the `connection` service is unavailable — a real degradation; the plugin will not invent numbers. Channels without credentials, such as Cline, will always show unknown, and that is correct.

**Q: Why doesn't the card show quota per model?**
A: Balance simply isn't at model granularity. The dozens of models under one channel share one credit pool, so drawing it per model would only produce a wall of "quota unknown".

**Q: Failover never triggered?**
A: It only triggers when quota is genuinely exhausted. If `switches: 0` and `failures: 0`, you simply haven't hit the quota wall yet.

**Q: Does it phone home behind my back?**
A: It does go online, but not surreptitiously. Three seconds after startup it makes one upstream call to read balances (`bootstrap()`). `settings.syncCatalog` only disables catalog sync, not this bootstrap. Truly zero automatic egress would need another switch.

**Q: Does it conflict with OFM's auto-update?**
A: If you installed this plugin with a package manager (pnpm), it is an independent package, so the two update independently.

## Known limits

- Only the channel lane can read balances **ahead of time**; free / per-user EAC / Kilo / aggregate have no quota endpoint and can only trigger failover from failure feedback.
- Balances are shown per **channel account**, not per model.
- A real read always beats a user-entered value; manual entries only fill the gap when nothing can be read.
- The `/api/ofm-quota` route carries its own trust fence, because it is longer than the kernel's `/api` and therefore matches first.

## Compatibility

| Component | Version |
|---|---|
| DSH | tested against kernel `0.2.1-rc.2` |
| dsh-our-free-model | tested against `2.5.8` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

DSH's plugin API is still evolving quickly (`0.1.x` and `0.2.x` coexist). Every kernel contract this plugin relies on is documented in its comments with the source file and line number, so check those anchors when upgrading the kernel.

## Disclaimer

This plugin is an independent third-party work, unaffiliated with DeepSeek, Our Free Model, or any channel provider. It only reads on-disk files on your machine and calls RPCs inside the local DSH process; it uploads no data to third-party servers.

Free quota on each channel is provided by that channel, and its terms and availability are the channel's to decide.

## License

[MIT](./LICENSE)

## Credits

- **[Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)** — the channel aggregation layer this plugin manages, and the reason this project exists.
- **dsh-better-sidebar** — the shape reference for the right-sidebar card.
- **dsh-my-guardian** — the reference implementation for native sidebarRightTabs + slots.
