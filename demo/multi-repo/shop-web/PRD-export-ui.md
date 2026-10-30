# PRD: Export UI

The frontend has an Export button that downloads the rows as CSV.

## Contract
- `GET /api/export` returns `{ "rows": [{ "id": number, "name": string }] }`.
- The backend URL comes from `$API_URL`.
