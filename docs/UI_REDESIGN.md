# Dashboard and navigation redesign

A frontend-only redesign aimed at people with no banking or KYC knowledge. Business rules, the database and all existing API
behaviour are unchanged. Every number and chart on the Overview comes from the backend when the page loads.

* **Overview** (`pages/DashboardPage.jsx`): Action required (real alerts, with why it matters and what to do, plus an Open button),
  Your customers (type donut, growth, risk bars), Document health (every document counted once, plus "Documents requiring attention"),
  Customer risk level (green/orange/red with plain explanations and a separate manual-review list), Company ownership (progress bars),
  Review cases (Open → In progress → Pending customer → Escalated → Resolved, overdue highlighted).
* **Sidebar** (`components/Layout.jsx`): six groups (Customers, Documents, Risk Management, Operations, Monitoring, Reporting) with icons,
  active highlighting and a plain-language tooltip on each item. Original technical names are kept as labels or in tooltips.
* **Explanations**: the "i" next to key numbers (`InfoTip`) says how the number is calculated and names the technical term.
* **Shared pieces**: `components/charts.jsx` (donut, bars, growth chart, "Show data" tables), `components/dashboardUi.jsx` (icons, tiles, progress rows, alert wording).
* **Analytics page** uses the same charts and gains an ownership validation chart. Page subtitles across the app were reworded in plain language.
* **Small read-only backend additions** so nothing is hardcoded: `documents.health` (non-overlapping document groups),
  `ownership.validationStatusDistribution`, `risks.manualReviewCustomers` in `/api/analytics/*`, and `awaitingApprovalCases` in `/api/review-dashboard/summary`.
* The old KPI card components (`RiskCards`, `ReviewCards`, `AlertCards`) are no longer shown on the Overview; their pages and links are still reachable from the new sections and the sidebar.

---

# Overview redesign (dashboard layout, second pass)

The Overview (`pages/DashboardPage.jsx`) was rebuilt as a modern operations dashboard. Only the Overview page changed; the sidebar,
routes and every other page keep working. Components live in `client/src/components/overview/`.

* **Top bar**: global search (customers, documents, review cases, using each list's existing `search`), a date-range select, a bell with the
  number of new alerts, and the acting person with their role (a menu switches person: there is still no login).
* **Welcome banner**: time-of-day greeting, one-line summary, preset and custom date range, "+ Add New Customer", a decorative illustration.
* **Six customer KPI cards** (total with "vs previous period", individual, company, low, medium, high risk), each a link to the filtered customer list.
* **Charts**: customer type donut, risk donut, onboarding trend (daily for ranges up to 45 days, otherwise monthly); document verification
  donut (documents counted once; *missing mandatory documents* is shown beside it, not inside it, because those are documents we do not hold),
  KYC completeness donut (per customer, from mandatory requirements and verified, still-valid documents), ownership donut. Legend rows link to the filtered lists.
* **Review Cases** (six metric boxes), **Recent Alerts - Action Required** (real alerts with a View button to the record), **Recent Activities** (from the audit records).
* The date filter lives in the URL (`?range=7d|30d|90d|month|all` or `?from=&to=`). It changes the in-period figures; cards tagged "Now" describe the current state.
* Loading skeletons, per-card error messages with "Try again", and empty states are built into `overview/Panel.jsx`.
* Colours follow the brief (sidebar `#064C4B`, teal `#087F78`, page `#F3F7FB`, green/orange/red/blue/purple status colours). Icons are the app's existing inline SVG set (`lucide-react` is not installed and was not added).

Backend additions (read-only): `GET /api/activity/recent?limit=` (latest business actions from the audit records, no values, reasons or IP
addresses, open to every role) and `dailyOnboarding` in `/api/analytics/customers` and `/overview` for ranges of 45 days or less (`null` otherwise).
