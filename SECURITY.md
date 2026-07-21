# Security policy

## Supported version

Security fixes target the latest commit on `main`. This project does not currently publish versioned releases or operate a hosted service.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, leaked credential, session cookie, access token, refresh token, or Cloudflare secret.

Use [GitHub private vulnerability reporting](https://github.com/BradenHartsell/login-with-chatgpt-for-cloudflare/security/advisories/new). Include:

- the affected commit
- a minimal reproduction
- expected and actual behavior
- the security impact
- any suggested mitigation

Do not include real user credentials or production secrets. Use synthetic fixtures.

## Deployment responsibilities

Each deployer is responsible for:

- generating and protecting a unique high-entropy `SESSION_SECRET`
- limiting Cloudflare account and deployment access
- configuring only trusted browser origins
- keeping Wrangler and Workers runtime dependencies current
- monitoring usage, errors, rate limits, and unexpected authorization activity
- providing appropriate user disclosures and a disconnect path
- rotating exposed secrets and treating existing sessions as invalid after rotation

The public Worker must never return or log OAuth access or refresh tokens. Reports that show a path around that boundary are high priority.
