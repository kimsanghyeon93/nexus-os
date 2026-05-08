# NEXUS OS — `market-package` integration

Production refactor of the NEXUS OS prototype, structured for a Vite + React + TypeScript repo.

## File layout

```
src/
  types/
    nexus.ts                  # Shared interfaces (NexusEntity, NexusEdge, ApiTelemetry, ...)
  hooks/
    useMarketData.ts          # Dataset + live telemetry (swap-in point for WebSocket)
  components/
    HUD/
      TopBar.tsx              # Brand · nav · API sparkline · SSO indicator · T+
    Graph/
      RadarCanvas.tsx         # <canvas> — force-directed sim + polar radar sweep
  App.tsx                     # Layout container
```

## Wiring real data

`useMarketData` is the single integration seam. Replace the body of `buildDataset()` with a `fetch('/api/ontology')` and replace the synthetic `setInterval` with a WebSocket subscription (`wss://market-package/stream`). The hook return shape (`{ dataset, telemetry, sso }`) is stable, so no component below it needs to change.

## Notes

- All physics tuning (member k=6.5, damp=0.82, 6s radar period, 4-hop cascading wave) is preserved verbatim from the prototype.
- Color semantics are strict — **lime is reserved for anomaly/danger only**. API health uses cyan.
- CSS variables (`--cyan`, `--lime`, `--amber`, `--purple`, etc.) and class names (`nx-*`) port directly from the prototype `dashboard.css`.
- `CommandCenter` and `PropertyHUD` are scoped out of this refactor pass per the spec — same pattern applies (extract types, accept data via props).
