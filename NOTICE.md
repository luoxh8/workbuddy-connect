# Attribution

This project is derived from **corrinehu/dsh-workbuddy-connect** (MIT):
https://github.com/corrinehu/dsh-workbuddy-connect

Source baseline: `d84e8e8de517710f5392969fc71abb925eee5c05` (retrieved 2026-09-11).

Copyright (c) 2026 Corrine Hu. The original MIT license is preserved in `LICENSE`.

The upstream WorkBuddy protocol implementation in `src/upstream.ts`, probe helpers in `src/probe.ts`, and loopback checks in `src/loopback.ts` originate from that project. The upstream project credits **Sliverkiss/workbuddy2api** (MIT) as its protocol reference:
https://github.com/Sliverkiss/workbuddy2api

This derivative targets **ZCode** instead of DSH/OpenCodex: it keeps the local bridge, the
region-isolated desktop authentication with its refresh cache, regional model discovery and the
Windows launchers, and replaces the OpenCodex registration with ZCode personal provider
registration (`src/zcode.ts`) plus a self-contained ZCode plugin (manifest, skill and command).

It also adds `src/wbaes.ts`: an in-memory unwrap of WorkBuddy 5.6.2+ AES-GCM credential
envelopes. That path is read-only — it spawns the installed WorkBuddy Electron runtime with
`ELECTRON_RUN_AS_NODE=1` to read the app's own at-rest key, decrypts in memory, and never
persists or logs a token.

The packaged plugin includes a generated copy of the runtime source and these notices. No rights
in third-party names or trademarks are implied. This is a community compatibility project,
without official affiliation or endorsement.
