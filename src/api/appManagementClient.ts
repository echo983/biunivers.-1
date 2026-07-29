export type ConfigurationDefinition =
  | {
      key: string;
      label: string;
      description?: string;
      type: "string";
      required: boolean;
      default?: string;
    }
  | {
      key: string;
      label: string;
      description?: string;
      type: "boolean";
      required: boolean;
      default?: boolean;
    }
  | {
      key: string;
      label: string;
      description?: string;
      type: "integer" | "number";
      required: boolean;
      default?: number;
      minimum?: number;
      maximum?: number;
    }
  | {
      key: string;
      label: string;
      description?: string;
      type: "select";
      required: boolean;
      default?: string;
      options: string[];
    };

export interface InspectionResult {
  inspectionId: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
  operation: "install" | "update";
  expiresAt: string;
  manifest: {
    appId: string;
    version: string;
    name: string;
    description?: string;
    license: string;
    icon: string;
    window: {
      defaultWidth: number;
      defaultHeight: number;
      minWidth?: number;
      minHeight?: number;
      desktop?: boolean;
      pinned?: boolean;
    };
    configuration: ConfigurationDefinition[];
  };
  openResource?: {
    protocol: "biunivers.open-resource/1";
    handlers: Array<{
      id: string;
      actions: Array<"open" | "edit">;
      extensions: string[];
      mediaTypes?: string[];
      access: "read" | "read-write";
    }>;
  };
}

export interface InstalledApp {
  appId: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
  version: string;
  status: "active" | "disabled";
  configuration: Record<string, string | number | boolean>;
  manifest: {
    name: string;
    description?: string;
    configuration: ConfigurationDefinition[];
  };
}

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
    details?: Array<{ path?: string; message?: string }>;
  };
}

type ErrorDetails = NonNullable<ErrorResponse["error"]>["details"];

export class AppManagementError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & ErrorResponse;
  if (!response.ok) {
    throw new AppManagementError(
      value.error?.message ?? `请求失败：HTTP ${response.status}`,
      value.error?.code,
      value.error?.details,
    );
  }
  return value;
}

export class AppManagementClient {
  constructor(private readonly token: string) {}

  private request(path: string, init?: RequestInit) {
    return fetch(path, {
      ...init,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  }

  async list() {
    const response = await this.request("/api/v1/admin/apps");
    const value = await readResponse<{
      schemaVersion: 1;
      apps: InstalledApp[];
    }>(response);
    return value.apps;
  }

  async inspect(repository: string, ref: string) {
    return readResponse<InspectionResult>(
      await this.request("/api/v1/admin/inspections", {
        method: "POST",
        body: JSON.stringify({ repository, ref }),
      }),
    );
  }

  async install(
    inspectionId: string,
    configuration: Record<string, string | number | boolean>,
  ) {
    return readResponse<InstalledApp>(
      await this.request("/api/v1/admin/apps", {
        method: "POST",
        body: JSON.stringify({ inspectionId, configuration }),
      }),
    );
  }

  async update(
    appId: string,
    inspectionId: string,
    configuration: Record<string, string | number | boolean>,
  ) {
    return readResponse<InstalledApp>(
      await this.request(
        `/api/v1/admin/apps/${encodeURIComponent(appId)}/version`,
        {
          method: "PUT",
          body: JSON.stringify({ inspectionId, configuration }),
        },
      ),
    );
  }

  async patch(
    appId: string,
    patch: {
      configuration?: Record<string, string | number | boolean>;
      status?: "active" | "disabled";
    },
  ) {
    return readResponse<InstalledApp>(
      await this.request(`/api/v1/admin/apps/${encodeURIComponent(appId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    );
  }

  async uninstall(appId: string) {
    const response = await this.request(
      `/api/v1/admin/apps/${encodeURIComponent(appId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      await readResponse(response);
    }
  }
}
