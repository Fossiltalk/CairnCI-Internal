#!/usr/bin/env node
// Executable entry — kept separate from refresh.mjs so tests can import run()
// without side effects and so the ncc bundle has an unambiguous entrypoint.
import { main } from "./refresh.mjs";

main();
