import {
  FileCapabilityError,
  type FileCapabilityRegistry,
} from "../files/fileCapabilityRegistry.js";
import type {
  WormholeRuntime,
  WormholeStatus,
} from "./wormholeRuntime.js";

const WORMHOLE_APP_ID = "system.wormhole";

export class WormholeControlService {
  constructor(
    private readonly capabilities: FileCapabilityRegistry,
    private readonly runtime: WormholeRuntime,
  ) {}

  status(instanceToken: string): WormholeStatus {
    this.#authorize(instanceToken);
    return this.runtime.status();
  }

  enable(instanceToken: string): WormholeStatus {
    this.#authorize(instanceToken);
    return this.runtime.enable();
  }

  rotate(instanceToken: string): WormholeStatus {
    this.#authorize(instanceToken);
    return this.runtime.rotate();
  }

  disable(instanceToken: string): WormholeStatus {
    this.#authorize(instanceToken);
    return this.runtime.disable();
  }

  #authorize(instanceToken: string): void {
    const identity = this.capabilities.authorizeInstance(instanceToken);
    if (identity.appId !== WORMHOLE_APP_ID) {
      throw new FileCapabilityError(
        "PERMISSION_DENIED",
        "This operation is restricted to Wormhole.",
      );
    }
  }
}
