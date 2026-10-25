# ⚡ Kestrel — System-1 Jev CLM Email Classifier & Continual Tag Learner for Thunderbird

A high-throughput, privacy-first Thunderbird MailExtension (compatible with Thunderbird 115 Supernova, 128 Nebula ESR, and newer) that classifies and tags emails using **Jev-style System-1 Classification Language Models (CLMs)** (`tev1:0.8b`, `tev1:4b`, `nimble`, `jev`) on [Ollama's `/v1/systemone` endpoint](https://ollama.com) combined with **continual online learning** from your manual Thunderbird tags.

Engineered to scale smoothly from **1,000 to 100,000+ email folders**.

---

## ✨ Key Features

- **True Jev-Style System-1 CLM Engine (`/v1/systemone` — Zero Output Tokens)**:
  - Uses Ollama's dedicated `POST /v1/systemone` decision model endpoint with open-weight System-1 CLMs like **`tev1:0.8b`** (812 MB), **`tev1:4b`** (4.5 GB), and **`nimble`** (9.5 GB).
  - Instead of autoregressive text generation, `/v1/systemone` evaluates email state against structured choice criteria in a **single forward pass with zero output tokens**, returning calibrated probabilities across all categories simultaneously.
- **🎓 Continual Online Learning from Non-`k1:` User Tags**:
  - **Real-Time Learning (`messenger.messages.onUpdated`)**: Whenever you manually apply any Thunderbird tag **not prefixed by `k1:`** (e.g., `tax_2026`, `client_acme`, `Important`), Kestrel automatically learns its sender patterns, domains, and discriminative subject/body tokens in `< 1ms`.
  - **3-Example Warm-up Threshold**: Learned non-`k1:` user tags stay in warm-up until you have tagged at least **3 examples** (`minLearnedSamplesToApply = 3`, configurable in Options) so one-off manual tags never cause false positives.
  - **Negative Feedback on Tag Removal**: Removing a tag from an email automatically penalizes that sender/topic and invalidates memoized cache entries so the mistake isn't repeated.
  - **Folder Harvesting (`🎓 Learn Tags`)**: Scan any existing folder (at thousands of headers/sec, zero model calls) to learn from all existing non-`k1:` tags you have previously applied.
  - **Hybrid CLM + Statistical NB/BM25 Scoring**: Dynamically synthesizes `/v1/systemone` choice criteria for every active learned user tag and blends the CLM's calibrated probabilities with a built-in local Naive-Bayes/BM25 statistical CLM (which also works offline or before `tev1:0.8b` is pulled).
- **Sensible Default `k1:` Tag Set + Custom Tag Studio**:
  - Ships with 8 color-coded default tags: `k1:action` (`k1: Action`), `k1:finance` (`k1: Finance`), `k1:work` (`k1: Work`), `k1:calendar` (`k1: Events`), `k1:shipping` (`k1: Orders`), `k1:security` (`k1: Security`), `k1:newsletter` (`k1: Newsletter`), and `k1:promo` (`k1: Promos`).
  - Manage both `k1:` tags and **🎓 Learned User Tags** in the **Kestrel Studio** options page.
- **Safe Force Re-apply Mode**:
  - Re-evaluates already tagged emails when you refine your tag descriptions or switch CLM models.
  - **Preserves Manual User Tags**: Only replaces `k1:*` tags while leaving your manual non-`k1:` Thunderbird tags untouched (and using them as ground-truth training examples!).
- **100,000+ Email Folder Architecture**:
  - **Streaming Paginated Cursor**: Iterates through `messenger.messages.list` / `continueList` one page at a time—never loads 100k messages into RAM.
  - **Zero-I/O Header Pre-Filtering & Two-Tier Memoization**: Evaluates scope filters (`Unread`, `Recent Days`, `Skip Junk`, `Already Tagged`) and **Thread + Automated Sender Memoization** directly on message headers (`0.001ms`) before reading MIME bodies.
  - **Pause / Resume / Stop Controls** with live throughput (`msg/s`), learned sample counter, cache hit counter, and ETA.

---

## 🚀 Installing in Thunderbird

### Option A: Install Packaged `.xpi`
1. Open Thunderbird and go to **Tools → Add-ons and Themes** (`Ctrl+Shift+A`).
2. Click the gear icon ⚙️ in the top-right → **Install Add-on From File...**
3. Select [`kestrel.xpi`](./kestrel.xpi) from this project folder.

### Option B: Load Unpacked for Development
1. Open Thunderbird → **Tools → Developer Tools → Debug Add-ons**.
2. Click **Load Temporary Add-on...**
3. Select [`dist/manifest.json`](./dist/manifest.json).

---

## 🛠️ Building, Local Dev Harness & Testing

Requires **Node.js 20+**. All build, packaging, and test scripts are 100% cross-platform (Linux, macOS, and Windows) with zero OS-specific dependencies:

```bash
# Install dependencies:
npm install

# 1. Build unpacked dist/ AND valid ZIP-packaged kestrel.xpi:
npm run build

# 2. Launch Interactive Browser Dev Harness (http://localhost:4173/dev/harness.html) + Watch Mode:
#    Simulates Thunderbird Inbox (30), Work Archive (1,000), and Mega Archive (100,000)
#    with interactive user-tag training (1/3 -> 2/3 -> 3/3), negative feedback, and live Popup/Studio!
npm run dev

# 3. Watch mode only (auto-rebuilds dist/ and kestrel.xpi on file save):
npm run watch

# 4. Run strict TypeScript typecheck & unit test suite (14 tests):
npm run typecheck
npm test
```

---

## 📦 Automated GitHub Actions & Thunderbird Marketplace Publishing

This repository includes two GitHub Actions workflows running on **`ubuntu-24.04`** with **Node.js 24**:
1. **[`.github/workflows/ci.yml`](.github/workflows/ci.yml) (Pull Requests → Pre-release)**:
   - Runs `npm run typecheck`, `npm test`, and `npm run build` on a single portable `ubuntu-24.04` runner.
   - Automatically stamps a Mozilla-valid 4-part numeric pre-release version in `manifest.json` (via [`scripts/resolve-version.mjs`](scripts/resolve-version.mjs)), cuts a **GitHub Pre-release** (`vX.Y.Z-pr.<PR>.<run>`), and pushes the pre-release `.xpi` (`channel=unlisted` by default) to **Thunderbird's Add-ons Marketplace (`addons.thunderbird.net`)**.
2. **[`.github/workflows/release.yml`](.github/workflows/release.yml) (Merge to `main` / Tag / Manual Dispatch → Release)**:
   - Triggers automatically whenever a PR is merged (pushed) to `main`/`master`, on `v*.*.*` tags, or manually via **Actions → Release** (with an option for `prerelease: true/false`).
   - Automatically resolves the next release version (`vX.Y.Z`), creates a **GitHub Release** with `kestrel.xpi`, and publishes the release (`channel=listed` by default) to the **Thunderbird Add-ons Marketplace (`addons.thunderbird.net`)** via [`scripts/publish-addons.mjs`](scripts/publish-addons.mjs).

### Required Repository Secrets for Marketplace Publishing
In your GitHub repository (**Settings → Secrets and variables → Actions**), add your API credentials from [Thunderbird Add-on Developer Hub](https://addons.thunderbird.net/en-US/developers/addon/api/key/):
- `AMO_JWT_ISSUER` (or `ATN_API_KEY`): Your JWT Issuer (`user:...`)
- `AMO_JWT_SECRET` (or `ATN_API_SECRET`): Your JWT Secret (`...`)
- *(Optional Repository Variables)*:
  - `ADDONS_SERVER_URL`: Defaults to `https://addons.thunderbird.net` (set to `https://addons.mozilla.org` if targeting AMO).
  - `AMO_CHANNEL`: Release channel for `main` merges (defaults to `listed`).
  - `AMO_PRERELEASE_CHANNEL`: Pre-release channel for PR builds (defaults to `unlisted`).

---

## 📄 License

Released under the [MIT License](LICENSE).
