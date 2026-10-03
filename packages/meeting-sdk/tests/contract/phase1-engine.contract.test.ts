import { createPhase1Harness } from "../support/harness.js";
import { describeMeetingEngineContract } from "./meetingEngineContract.js";

describeMeetingEngineContract("phase 1 engine", createPhase1Harness);
