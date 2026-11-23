import { OmpAdapterV2Driver } from "@t3tools/provider-omp/server";
import { describe } from "@effect/vitest";

import { makeRpcReplayHarness, OMP_RPC_REPLAY_PROTOCOL } from "../Adapters/PiAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

const harness = makeRpcReplayHarness(OmpAdapterV2Driver, OMP_RPC_REPLAY_PROTOCOL, "omp");

describe("omp replay fixtures", () => {
  itRunsReplayFixtures("omp", (input) => runReplayFixture({ ...input, harness }));
});
