# Disciplr Contracts

Soroban smart contracts for the Disciplr programmable vault protocol.

## Structure

```
contracts/
├── Cargo.toml          # workspace manifest
├── deny.toml           # cargo-deny policy
└── vault/              # time-locked capital vault contract
    ├── Cargo.toml
    └── src/lib.rs
```

## cargo-deny Policy

All Rust dependencies are validated on every CI run by
[cargo-deny](https://github.com/EmbarkStudios/cargo-deny). The policy lives in
[`deny.toml`](./deny.toml) and covers four areas:

### Advisories (`[advisories]`)

| Setting | Value | Reason |
|---|---|---|
| `vulnerability` | `deny` | Fail the build on any unpatched CVE. |
| `unmaintained` | `warn` | Surface unmaintained crates without blocking. Upgrade to `deny` when the supply chain matures. |
| `yanked` | `deny` | Yanked crates are unsafe to reproduce; always use a published version. |
| `severity-threshold` | `none` | All advisory severities are checked, including informational. |

### Licenses (`[licenses]`)

Allowed licenses are permissive OSI-approved or weak-copyleft licences that
are compatible with commercial use and Stellar ecosystem norms:

`MIT`, `Apache-2.0`, `Apache-2.0 WITH LLVM-exception`, `ISC`, `BSD-2-Clause`,
`BSD-3-Clause`, `0BSD`, `Unicode-3.0`, `Unicode-DFS-2016`, `CC0-1.0`, `Zlib`

Denied licenses are those that impose copyleft obligations incompatible with
closed-source or commercial use:

`GPL-2.0`, `GPL-3.0`, `LGPL-2.0`, `LGPL-2.1`, `LGPL-3.0`, `AGPL-3.0`,
`EUPL-1.1`, `EUPL-1.2`, `BUSL-1.1`

Setting `copyleft = "deny"` catches any other copyleft-family identifiers not
listed explicitly. `confidence-threshold = 0.8` ensures the licence detector is
reasonably sure before accepting a match.

### Bans (`[bans]`)

| Rule | Value | Reason |
|---|---|---|
| `multiple-versions` | `deny` | Duplicate versions inflate binary size and hide incompatibilities in a `no_std` / WASM environment. Resolve version conflicts in `Cargo.toml` using `[patch]` or unified dependency ranges. |
| `wildcards` | `deny` | Wildcard version requirements (`*`) are resolved non-deterministically and prevent reproducible builds. |
| `openssl` | denied | The `openssl` crate links a C library that cannot be compiled to WASM/Soroban. Use pure-Rust alternatives (e.g. `ring`, `rustls`). |
| `time < 0.3` | denied | `time` 0.1/0.2 is [unsound on Linux](https://rustsec.org/advisories/RUSTSEC-2020-0071). Use `time 0.3+`. |

### Sources (`[sources]`)

Only [crates.io](https://crates.io) is permitted as a crate registry. Git
sources and private registries are denied to keep builds reproducible and
auditable. To allow a specific git dependency (e.g. an unreleased Soroban
patch), add an entry to `allow-git` with a documented justification.

## Running Locally

```bash
# Install cargo-deny (once)
cargo install cargo-deny --locked

# Run all checks against this workspace
cargo deny --manifest-path contracts/Cargo.toml check

# Run a specific check
cargo deny --manifest-path contracts/Cargo.toml check licenses
cargo deny --manifest-path contracts/Cargo.toml check advisories
cargo deny --manifest-path contracts/Cargo.toml check bans
```

## CI

The `contracts-deny` job in `.github/workflows/ci.yml` runs
`EmbarkStudios/cargo-deny-action@v2` on every push and pull-request targeting
`main`. The job is independent of the Node.js test job and will fail fast if
any policy is violated, giving reviewers a clear signal before merge.

## Adding or Upgrading Dependencies

1. Add the dependency to the relevant `Cargo.toml`.
2. Run `cargo deny --manifest-path contracts/Cargo.toml check` locally.
3. If a new license appears, evaluate it against the allowed list above and
   update `deny.toml` if it is acceptable, or pick an alternative crate.
4. If a duplicate version appears, add a `[patch]` entry or align version
   requirements across crates.
5. Commit `Cargo.lock` alongside any dependency changes.
