# SRLA Sales Rotation — Claude Code Context

## Project Overview
- **Live URL:** https://srlasales.netlify.app
- **Photos URL:** https://srlasales.netlify.app/photos
- **GitHub:** https://github.com/nelsonsrla/srla-sales-rotation
- **Netlify Site ID:** 0c3e0bc7-d71b-4f72-a93e-20ce0e37a710
- **Firebase:** https://sales-rotation-44d0d-default-rtdb.firebaseio.com
- **Project folder:** /Users/nelsonjohnson/Desktop/SRLA Sales/Lead-Rotation-app/
- **Shopify store:** showroomla.myshopify.com
- **Shopify admin URL format:** https://admin.shopify.com/store/showroomla/orders/[orderId]

## Deploy Workflow
```bash
git add . && git commit -m "description of change" && git push
```
This auto-deploys via GitHub → Netlify. No manual deploy command needed.

## Firebase Paths
- `rotation/` — main state (reps, store, subs)
- `rotation/history/` — notification history
- `rotation/attempts/` — webhook attempt log
- `rotation/last_attempt.json` — last webhook attempt
- `rotation/last_run.json` — last successful run
- `rotation/notified_orders/` — order dedup
- `rotation/notified_customers/` — customer dedup
- `rotation/notified_customers_highvalue/` — high value records
- `config/shopify_token` — Shopify API token

## shopify-order.js — v16 Qualifying Criteria
1. Allowed sources: web, facebook, instagram, shop_app, shop, 3890849, 580111, android, ios
2. Payment must be paid or authorized
3. Orders count 1-2 (Shopify API lookup if null, notified_customers fallback)
4. No prior paid+fulfilled orders from non-online channels (POS, draft, invoice)
5. $1,000+ OR 7+ items
6. High-value returning customer: 3+ orders but first order over $1k threshold
7. Not already notified (order + customer dedup)

## index.html Features
- Sales rep rotation card
- Notification history with search, date filter, annotation (3-dot menu)
- Monitor card: Last Webhook Attempt, Last Successful Run, Recent Webhook Attempts with filters
- Photos link in header → /photos
- Admin-only Commission button in header (hidden by default; long-press the "Lead Rotation" title → PIN modal → PIN 2847 reveals a pill linking to https://srlacommission.netlify.app; session-only, resets on refresh, no persistence)
- Settings drawer: rep management, push notifications, rotation control
- Firebase SSE real-time sync

## photos/index.html Features
- Full product catalog from Shopify + Consignr (~4,300 items)
- Search bar (multi-word AND logic)
- Filter by brand, size, price, source, sale
- Column toggle (1/2/4 columns)
- iOS share sheet for photos
- Rotation link in header → /
- Location View: "Locations" button → drawer of Consignr physical locations → pick one (e.g. "Summer League 2K26") to browse ONLY the items at that location, with photos. Banner shows count + Exit. Backed by netlify/functions/photos-consignr-locations.js.

## Consignr Location Data (photos Location View)
- The main photos catalog uses Consignr `/products?instoreOnly=true` (~390 curated products) — these do NOT carry location.
- Physical location lives on Consignr `/items` (item.location.id + embedded product w/ images). There are 8 locations via `/locations`; Summer League 2K26 = location_aQE2EH1wONCFHSws61Zo0.
- `/items` ignores a server-side location filter, so photos-consignr-locations.js fetches ALL active items (status=ACTIVE&limit=100&page=N, ~7.5k items / ~7s, MAX_PAGES cap) and groups by location.id client-side.
- Endpoint actions: `?action=locations` (fast list) and `?action=products&locationId=XXX` (catalog-shaped product cards for that location, so the existing grid/share reuse works).
- NOTE: catalog products (instoreOnly) barely overlap the location map — the Location View is intentionally sourced from /items, not the 390-product catalog.

## Standing Rules for All Builds
- All folder names must be lowercase (Netlify Linux is case-sensitive)
- Never chain API calls without confirming combined latency fits 26s limit
- Always push to GitHub after every change
- Never modify Firebase data without explicit confirmation from Nelson
- Always update CLAUDE.md when new features are added or files change

## Automation Hooks
- `.claude/settings.json` + `.claude/hooks/check-git-sync.sh` — SessionStart hook (committed, syncs across devices). At the start of every session it runs `git fetch` (read-only, never pulls) and warns if the local branch is behind/diverged from origin, so we always edit against the latest pushed files (Rule 22). Review or disable via `/hooks`. Personal settings live in gitignored `.claude/settings.local.json`.

## Master Ruleset (Rules 1-22)
- Rule 1: Never rewrite any file without explicit permission. Always ask first.
- Rule 2: Audit all work before presenting. No files until audit passes.
- Rule 3: Always provide the most recent updated file.
- Rule 4: Always present downloadable file at bottom of every response.
- Rule 5: Before ANY edit explain: (1) what's changing, (2) what it looks like after, (3) what's NOT changing. Wait for explicit approval.
- Rule 6: Confirm no saved data will be altered before any deploy or Firebase change.
- Rule 7: Double-check code for errors before presenting.
- Rule 8: Show exactly where fixes were made.
- Rule 9: Before presenting ask: what would cause this to NOT work?
- Rule 10: Before presenting ask: are there new problems this could introduce?
- Rule 11: Verify every insertion point, never present partial file.
- Rule 12: Syntax check AND scope check after every edit.
- Rule 13: Never skip rules.
- Rule 14: Scale across locations/managers/employees.
- Rule 15: All failsafes — try/catch on every function, Firebase fallbacks, null/undefined guards.
- Rule 16: Edge case awareness — identify all reasonable edge cases before presenting.
- Rule 17: Success definition — confirm success criteria before starting work.
- Rule 18: Guardrails check — review guardrails before starting any task.
- Rule 19: Netlify Function Timeout — estimate execution time, flag timeout risk, ensure netlify.toml is correct.
- Rule 20: Error-First Debugging — surface raw error from source system before attempting any fix.
- Rule 21: Context Handoff — end EVERY response with a concise, copy-pasteable "Context handoff" code block capturing current state (branch, what shipped/in-flight, what's blocked/on the user, key facts) plus the active task/next prompt, so work can move to a new thread by pasting that block.
- Rule 22: Single Source of Truth / Cross-Device Sync — this project CLAUDE.md (committed to git) is the canonical cross-device memory. Every rule, decision, feature change, and durable piece of context MUST be written here and pushed to GitHub immediately, so a `project device refresh` on ANY device pulls the most up-to-date version. Do NOT rely on the machine-local global CLAUDE.md (~/.claude/CLAUDE.md) or local memory files for anything that must travel across devices — those do NOT sync. If it matters, it goes in this file and gets pushed.

## Session Prompt
You are working on the SRLA Sales Rotation app for Nelson Johnson (GM/COO-track at Showroom LA). Read CLAUDE.md in the project root before doing anything. Apply all 22 rules from the Master Ruleset on every response. Never rewrite files without explicit permission. Always audit before presenting. Always confirm no saved data is altered before any Firebase or deploy change. The deploy workflow is: git add . && git commit -m "description" && git push which auto-deploys via GitHub to Netlify. All folder names must be lowercase. Surface raw errors before attempting any fix.
