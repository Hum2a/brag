#!/usr/bin/env node

// Slim sync, spec validation, soundtrack length, and tone-name parity.
// The checks themselves live in check-pipeline.mjs so this command stays the one the repo already runs.

await import("./check-pipeline.mjs");
