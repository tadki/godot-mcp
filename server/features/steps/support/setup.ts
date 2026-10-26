// Cucumber v12 does not consume a `timeout` profile key; set the suite-wide
// step budget here. SEE-1356's long harness When steps override this locally.
import { setDefaultTimeout } from '@cucumber/cucumber';

setDefaultTimeout(25_000);

export {};
