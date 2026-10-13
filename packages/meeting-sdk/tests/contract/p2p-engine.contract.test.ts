import { createP2PHarness } from "../support/harness.js";
import { describeMeetingEngineContract } from "./meetingEngineContract.js";

describeMeetingEngineContract("direct media engine", createP2PHarness);
