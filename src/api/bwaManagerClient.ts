export interface BwaRunSummary {
  run: {
    runIdHex: string;
    state: string;
    errorCode?: string | null;
  };
}

export interface BwaInstanceSummary {
  instanceIdHex: string;
  applicationId: string;
  workspaceIdHex: string;
  desiredState: "RUNNING" | "STOPPED";
  startupPolicy: "MANUAL" | "ON_OPEN" | "AUTOMATIC";
  displayName: string;
  environment: Array<{ name: string; value: string | null; sensitive: boolean }>;
  runs: BwaRunSummary[];
}

export interface BwaApplicationSummary {
  applicationId: string;
  installedDigest: string;
  previousDigest: string | null;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  imageVersion: string | null;
  enabled: boolean;
  instances: BwaInstanceSummary[];
}

export interface BwaWorkspaceOption {
  workspaceIdHex: string;
  name: string;
  revision: number;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class BwaManagerClient {
  async status() {
    return await this.request<{
      applications: BwaApplicationSummary[];
      workspaces: BwaWorkspaceOption[];
    }>("");
  }

  async install(reference: string) {
    return await this.request("/applications", { method: "POST", body: { reference } });
  }

  async update(applicationId: string, reference: string) {
    return await this.request("/applications/update", {
      method: "POST",
      body: { applicationId, reference },
    });
  }

  async rollback(applicationId: string) {
    return await this.request("/applications/rollback", {
      method: "POST",
      body: { applicationId },
    });
  }

  async uninstall(applicationId: string) {
    return await this.request(`/applications/${encodeURIComponent(applicationId)}`, {
      method: "DELETE",
    });
  }

  async createInstance(applicationId: string, name: string, sourceWorkspaceIdHex?: string) {
    return await this.request("/instances", {
      method: "POST",
      body: {
        applicationId,
        name,
        startupPolicy: "MANUAL",
        ...(sourceWorkspaceIdHex ? { sourceWorkspaceIdHex } : {}),
      },
    });
  }

  async deleteInstance(instanceIdHex: string) {
    return await this.request(`/instances/${instanceIdHex}`, { method: "DELETE" });
  }

  async action(instanceIdHex: string, action: "start" | "stop" | "save-restart") {
    return await this.request(`/instances/${instanceIdHex}/${action}`, { method: "POST" });
  }

  async open(instanceIdHex: string) {
    return await this.request<{ url: string; expiresAt: string }>(
      `/instances/${instanceIdHex}/open`,
      { method: "POST" },
    );
  }

  async waitUntilReady(instanceIdHex: string) {
    return await this.request<{ ready: true }>(`/instances/${instanceIdHex}/ready`, {
      method: "POST",
    });
  }

  async replaceEnvironment(
    instanceIdHex: string,
    ordinary: Record<string, string>,
    sensitive: Record<string, string>,
  ) {
    return await this.request(`/instances/${instanceIdHex}/environment`, {
      method: "PUT",
      body: { ordinary, sensitive },
    });
  }

  async requestRecovery(
    instanceIdHex: string,
    runIdHex: string,
    action: "publish" | "discard",
  ) {
    return await this.request(
      `/instances/${instanceIdHex}/runs/${runIdHex}/${action}`,
      { method: "POST" },
    );
  }

  private async request<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await fetch(`/api/v1/control/bwa${path}`, {
      method: options.method,
      cache: "no-store",
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const value = (await response.json()) as T & ErrorBody;
    if (!response.ok) {
      throw new Error(value.error?.message ?? `请求失败：HTTP ${response.status}`);
    }
    return value;
  }
}
