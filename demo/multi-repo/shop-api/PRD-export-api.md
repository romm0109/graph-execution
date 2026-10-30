# PRD: Export API

The backend serves the rows to export.

## Contract
- `GET /api/export` returns `{ "rows": [{ "id": number, "name": string }] }`.
- The backend listens on `$PORT`.
