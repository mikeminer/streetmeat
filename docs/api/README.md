# MEAT circulating supply

Public endpoint for Jupiter:

https://streetmeatgame.com/api/circulating-supply.json

(The old address https://mikeminer.github.io/streetmeat/api/circulating-supply.json redirects here.)

It returns one JSON object with a numeric `circulatingSupply`, denominated in whole MEAT tokens (not base units).

## Calculation

The mint is `BTCxVi7u6DSKbRohALwMay2i4PDsiejKqoSmMDeWpump` on Solana mainnet, using Token-2022 with six decimal places. The script reads the mint at finalized commitment and checks its owner, initialized state, decimals, disabled mint/freeze authorities, and supply bound before publishing.

Circulating supply equals the current on-chain mint supply. The project operator confirmed on 24 October 2026 that there are no separate team, treasury, vesting, or other reserved allocations to exclude. Already distributed tokens voluntarily deposited by players for a Season Pass remain included. Tokens available in trading pools are also included. SPL token burns are reflected in the mint's supply and are not subtracted again. This methodology is a project disclosure, not a claim of approval by Jupiter.

Jupiter's own [February 2025 community audit](https://discuss.jup.ag/t/jup-community-audit-feb-2025/34764) distinguishes unreleased reserves from already distributed tokens voluntarily locked again. That distinction informs this endpoint; the audit is not a token-specific VRFD policy for MEAT.

If reserved allocations are introduced, this methodology and calculation must be updated before continuing to use the endpoint.

## Freshness and failure behaviour

[supply-details.json](./supply-details.json) provides the observation time, finalized slot, raw supply, and methodology. This is a static snapshot hosted by GitHub Pages, not an RPC server. The workflow refreshes it every hour, at minute 17 UTC, and on relevant pushes or manual dispatches. GitHub may delay scheduled jobs; schedules on inactive public repositories may be disabled after 60 days without repository activity.

Failed or invalid RPC responses fail the workflow and do not deploy a replacement value. The previously deployed snapshot remains available, so consumers should check the observation time in the details endpoint if freshness is critical. There is no fabricated zero or hard-coded one-billion fallback.

The workflow deploys only `docs/`, including the existing website, Privacy, and Terms pages. It uses public RPC reads, requires no API key, and does not sign or send transactions. Generated snapshots are deployment artifacts; hourly runs do not create commits.

Sources: [Solana getAccountInfo](https://solana.com/docs/rpc/http/getaccountinfo), [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
