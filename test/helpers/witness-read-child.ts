// Test child, bundled by test/helpers/bundle-cli.ts: reads the witness state of <home> the way a read surface does and prints it.
// A FIFO at witness.json blocks a plain read for good, so the case runs in a child with a deadline.
import { readScopeWitness, WITNESS_READ_AS_GIVEN } from '../../src/memory/witness-store.js';
process.stdout.write(JSON.stringify(readScopeWitness(process.argv[2]!, '@global', WITNESS_READ_AS_GIVEN)) + '\n');
