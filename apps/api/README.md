# Planned: HTTP API and workers

This application will host the partner API and the order and simulation workers
described in the specification (build plan step S02 and later steps).

Planned local surface:

- `POST /v1/quotes`, `POST /v1/orders`, `GET /v1/orders/{id}`,
  `GET /v1/portfolios/{id}`
- scenario and comparison endpoints for the AI Policy Lab
- health endpoints separated for the user journey and the protocol

The deterministic domain logic lives in `packages/dealing`; this application
only performs transport, persistence, authority checks and evidence capture.
Implementation is tracked in GitHub issue S02.
